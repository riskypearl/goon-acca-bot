// pick-verifier.js
// Attempts to auto-verify common acca picks using football-data.org
// Returns: { verified: true/false, result: 'win'|'loss'|null, reason: string }

const API_URL = 'https://api.football-data.org/v4';
const API_KEY  = process.env.FOOTBALL_API_KEY;

async function apiFetch(path) {
  const res = await fetch(`${API_URL}${path}`, { headers: { 'X-Auth-Token': API_KEY } });
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}

// ── Search for a finished match by team names ──────────────────

async function findMatch(homeTeam, awayTeam) {
  // Try PL first, then other competitions
  const competitions = ['PL', 'WC', 'CL', 'EL', 'EC'];
  for (const comp of competitions) {
    try {
      const data = await apiFetch(`/competitions/${comp}/matches?status=FINISHED&limit=20`);
      const match = (data.matches || []).find(m => {
        const h = m.homeTeam.name.toLowerCase();
        const a = m.awayTeam.name.toLowerCase();
        const ht = homeTeam.toLowerCase();
        const at = awayTeam.toLowerCase();
        return (h.includes(ht) || ht.includes(h)) && (a.includes(at) || at.includes(a));
      });
      if (match) return match;
    } catch {}
  }
  return null;
}

// ── Parse a pick description into a verifiable bet ────────────

function parsePick(description) {
  const d = description.toLowerCase();

  // Extract team names — look for "X vs Y" or "X v Y" or "X to ... vs Y"
  const vsMatch = d.match(/(.+?)\s+(?:vs?\.?\s+)(.+?)(?:\s+-\s+|\s+to\s+|\s*$)/);

  // Detect bet type
  const isBTTS = d.includes('btts') || d.includes('both teams to score');
  const isOver = d.match(/over\s*([\d.]+)\s*goals?/);
  const isUnder = d.match(/under\s*([\d.]+)\s*goals?/);
  const isHWin = d.includes('home win') || d.includes('to win') && !d.includes('away');
  const isAWin = d.includes('away win');
  const isDraw = d.includes('draw');
  const isHTWin = d.match(/(?:ht|half.?time)\s+(?:home\s+)?win/) || d.includes('winning at half time') || d.includes('to win at ht');
  const isHTDraw = d.match(/(?:ht|half.?time)\s+draw/);
  const isHTAWin = d.match(/(?:ht|half.?time)\s+away\s+win/);
  const isToWin = d.match(/(.+?)\s+to\s+win/);
  const isCleanSheet = d.includes('clean sheet');
  const isOver15 = d.match(/over\s*1\.5/) || d.includes('over 1.5');
  const isOver25 = d.match(/over\s*2\.5/) || d.includes('over 2.5');
  const isOver35 = d.match(/over\s*3\.5/) || d.includes('over 3.5');

  return {
    raw: d,
    isBTTS, isOver, isUnder, isHWin, isAWin, isDraw,
    isHTWin, isHTDraw, isHTAWin, isToWin, isCleanSheet,
    isOver15, isOver25, isOver35, vsMatch,
  };
}

// ── Extract team from "X to win" pattern ──────────────────────

function extractTeamToWin(description) {
  const d = description.toLowerCase();
  const m = d.match(/^(.+?)\s+to\s+win/);
  return m ? m[1].trim() : null;
}

// ── Main verifier ──────────────────────────────────────────────

async function verifyPick(description) {
  const parsed = parsePick(description);
  const d = description.toLowerCase();

  try {
    // Try to find "Team to win" style picks
    if (parsed.isToWin) {
      const teamName = extractTeamToWin(description);
      if (!teamName) return { verified: false, result: null, reason: 'Could not parse team name' };

      // Search recent matches for this team
      const competitions = ['PL', 'CL', 'EL'];
      for (const comp of competitions) {
        const data = await apiFetch(`/competitions/${comp}/matches?status=FINISHED&limit=30`);
        const match = (data.matches || []).find(m => {
          const h = m.homeTeam.name.toLowerCase();
          const a = m.awayTeam.name.toLowerCase();
          return h.includes(teamName) || teamName.includes(h.split(' ')[0]) ||
                 a.includes(teamName) || teamName.includes(a.split(' ')[0]);
        });

        if (match) {
          const { home, away } = match.score.fullTime;
          const isHome = match.homeTeam.name.toLowerCase().includes(teamName) ||
                         teamName.includes(match.homeTeam.name.toLowerCase().split(' ')[0]);
          const won = isHome ? home > away : away > home;

          return {
            verified: true,
            result: won ? 'win' : 'loss',
            reason: `${match.homeTeam.name} ${home}-${away} ${match.awayTeam.name}`,
            match,
          };
        }
      }
    }

    // Try "X vs Y" style — more specific
    if (parsed.vsMatch) {
      const homeTeam = parsed.vsMatch[1].trim().replace(/\s+to\s+.+/, '');
      const awayTeam = parsed.vsMatch[2].trim();
      const match = await findMatch(homeTeam, awayTeam);

      if (!match) return { verified: false, result: null, reason: 'Match not found in API' };
      if (match.score.fullTime.home === null) return { verified: false, result: null, reason: 'Match not finished yet' };

      const home = match.score.fullTime.home;
      const away = match.score.fullTime.away;
      const htHome = match.score.halfTime?.home ?? null;
      const htAway = match.score.halfTime?.away ?? null;
      const totalGoals = home + away;

      // BTTS
      if (parsed.isBTTS) {
        const hit = home > 0 && away > 0;
        return { verified: true, result: hit ? 'win' : 'loss', reason: `${home}-${away} — BTTS: ${hit ? 'Yes' : 'No'}`, match };
      }

      // Over/Under
      if (parsed.isOver35) {
        return { verified: true, result: totalGoals > 3.5 ? 'win' : 'loss', reason: `${home}-${away} — ${totalGoals} goals`, match };
      }
      if (parsed.isOver25) {
        return { verified: true, result: totalGoals > 2.5 ? 'win' : 'loss', reason: `${home}-${away} — ${totalGoals} goals`, match };
      }
      if (parsed.isOver15) {
        return { verified: true, result: totalGoals > 1.5 ? 'win' : 'loss', reason: `${home}-${away} — ${totalGoals} goals`, match };
      }
      if (parsed.isOver) {
        const threshold = parseFloat(parsed.isOver[1]);
        return { verified: true, result: totalGoals > threshold ? 'win' : 'loss', reason: `${home}-${away} — ${totalGoals} goals vs ${threshold}`, match };
      }
      if (parsed.isUnder) {
        const threshold = parseFloat(parsed.isUnder[1]);
        return { verified: true, result: totalGoals < threshold ? 'win' : 'loss', reason: `${home}-${away} — ${totalGoals} goals vs ${threshold}`, match };
      }

      // HT result
      if (htHome !== null) {
        if (parsed.isHTWin) {
          const homeWinHT = htHome > htAway;
          return { verified: true, result: homeWinHT ? 'win' : 'loss', reason: `HT: ${htHome}-${htAway}`, match };
        }
        if (parsed.isHTDraw) {
          return { verified: true, result: htHome === htAway ? 'win' : 'loss', reason: `HT: ${htHome}-${htAway}`, match };
        }
        if (parsed.isHTAWin) {
          return { verified: true, result: htAway > htHome ? 'win' : 'loss', reason: `HT: ${htHome}-${htAway}`, match };
        }
      }

      // Match result
      if (parsed.isHWin) {
        return { verified: true, result: home > away ? 'win' : 'loss', reason: `${home}-${away}`, match };
      }
      if (parsed.isAWin) {
        return { verified: true, result: away > home ? 'win' : 'loss', reason: `${home}-${away}`, match };
      }
      if (parsed.isDraw) {
        return { verified: true, result: home === away ? 'win' : 'loss', reason: `${home}-${away}`, match };
      }

      // Clean sheet
      if (parsed.isCleanSheet) {
        const isHomeTeam = d.includes(match.homeTeam.name.toLowerCase().split(' ')[0]);
        const kept = isHomeTeam ? away === 0 : home === 0;
        return { verified: true, result: kept ? 'win' : 'loss', reason: `${home}-${away}`, match };
      }

      return { verified: false, result: null, reason: 'Could not determine bet type from description' };
    }

    // Fallback: just "team to win" without vs
    return { verified: false, result: null, reason: 'Could not parse pick — needs manual verification' };

  } catch (err) {
    return { verified: false, result: null, reason: `API error: ${err.message}` };
  }
}

module.exports = { verifyPick };
