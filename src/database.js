const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'goon.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    user_id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    tier TEXT NOT NULL DEFAULT 'bench',
    elite_cups INTEGER DEFAULT 0,
    total_points INTEGER DEFAULT 0,
    monthly_points INTEGER DEFAULT 0,
    season_points INTEGER DEFAULT 0,
    picks_this_cycle INTEGER DEFAULT 0,
    sold_acca INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS picks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    description TEXT NOT NULL,
    odds REAL NOT NULL,
    points_possible INTEGER NOT NULL,
    result TEXT DEFAULT NULL,
    points_awarded INTEGER DEFAULT 0,
    cycle INTEGER NOT NULL,
    month INTEGER NOT NULL,
    year INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(user_id) REFERENCES players(user_id)
  );

  CREATE TABLE IF NOT EXISTS cycles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cycle_number INTEGER NOT NULL,
    completed INTEGER DEFAULT 0,
    elite_winner TEXT DEFAULT NULL,
    relegated TEXT DEFAULT NULL,
    promoted TEXT DEFAULT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// ── Points calculation ─────────────────────────────────────────

function oddsToPoints(odds) {
  if (odds < 1.5) return null; // below minimum
  if (odds > 2.0) return 20;  // capped at 20
  return Math.round(odds * 10);
}

// ── Player helpers ─────────────────────────────────────────────

function getOrCreatePlayer(userId, username) {
  let player = db.prepare('SELECT * FROM players WHERE user_id = ?').get(userId);
  if (!player) {
    // Auto-assign to bench if under 5, elite if under 5 elite spots
    const eliteCount = db.prepare("SELECT COUNT(*) as c FROM players WHERE tier = 'elite'").get().c;
    const tier = eliteCount < 5 ? 'elite' : 'bench';
    db.prepare(`INSERT INTO players (user_id, username, tier) VALUES (?, ?, ?)`).run(userId, username, tier);
    player = db.prepare('SELECT * FROM players WHERE user_id = ?').get(userId);
  }
  return player;
}

function getAllPlayers() {
  return db.prepare('SELECT * FROM players ORDER BY tier DESC, total_points DESC').all();
}

function getElite() {
  return db.prepare("SELECT * FROM players WHERE tier = 'elite' ORDER BY total_points DESC").all();
}

function getBench() {
  return db.prepare("SELECT * FROM players WHERE tier = 'bench' ORDER BY total_points DESC").all();
}

function getCurrentCycle() {
  const row = db.prepare('SELECT MAX(cycle_number) as c FROM picks').get();
  return row.c || 1;
}

// ── Pick helpers ───────────────────────────────────────────────

function submitPick(userId, username, description, odds, cycle, month, year) {
  const points = oddsToPoints(odds);
  if (!points) return null;
  return db.prepare(`
    INSERT INTO picks (user_id, username, description, odds, points_possible, cycle, month, year)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, username, description, odds, points, cycle, month, year);
}

function getPlayerPick(userId, cycle) {
  return db.prepare('SELECT * FROM picks WHERE user_id = ? AND cycle = ?').get(userId, cycle);
}

function getCyclePicks(cycle) {
  return db.prepare('SELECT * FROM picks WHERE cycle = ? ORDER BY username ASC').all(cycle);
}

function setPickResult(pickId, result) {
  const pick = db.prepare('SELECT * FROM picks WHERE id = ?').get(pickId);
  if (!pick) return null;

  const pointsAwarded = result === 'win' ? pick.points_possible : 0;
  db.prepare('UPDATE picks SET result = ?, points_awarded = ? WHERE id = ?').run(result, pointsAwarded, pickId);

  if (result === 'win') {
    db.prepare(`
      UPDATE players SET
        total_points = total_points + ?,
        monthly_points = monthly_points + ?,
        season_points = season_points + ?
      WHERE user_id = ?
    `).run(pointsAwarded, pointsAwarded, pointsAwarded, pick.user_id);
  }

  db.prepare('UPDATE players SET picks_this_cycle = picks_this_cycle + 1 WHERE user_id = ?').run(pick.user_id);

  return { pick, pointsAwarded };
}

function sellAcca(userId) {
  db.prepare("UPDATE players SET sold_acca = 1, tier = 'bench' WHERE user_id = ?").run(userId);
}

// ── Cycle end: promotion/relegation ───────────────────────────

function endCycle(cycleNumber) {
  const elite = getElite();
  const bench = getBench();

  if (elite.length === 0) return null;

  // Elite winner (most points this cycle)
  const cyclePicks = getCyclePicks(cycleNumber).filter(p => p.result !== null);
  const eliteIds = elite.map(p => p.user_id);

  const cyclePoints = {};
  for (const pick of cyclePicks) {
    if (!cyclePoints[pick.user_id]) cyclePoints[pick.user_id] = 0;
    cyclePoints[pick.user_id] += pick.points_awarded;
  }

  const eliteScores = elite.map(p => ({ ...p, cyclePoints: cyclePoints[p.user_id] || 0 }))
    .sort((a, b) => b.cyclePoints - a.cyclePoints);
  const benchScores = bench.map(p => ({ ...p, cyclePoints: cyclePoints[p.user_id] || 0 }))
    .sort((a, b) => b.cyclePoints - a.cyclePoints);

  const winner = eliteScores[0];
  const lastElite = eliteScores[eliteScores.length - 1];
  const firstBench = benchScores[0];

  // Award elite cup
  if (winner) {
    db.prepare('UPDATE players SET elite_cups = elite_cups + 1 WHERE user_id = ?').run(winner.user_id);
  }

  // Standard relegation/promotion
  if (lastElite) db.prepare("UPDATE players SET tier = 'bench' WHERE user_id = ?").run(lastElite.user_id);
  if (firstBench) db.prepare("UPDATE players SET tier = 'elite' WHERE user_id = ?").run(firstBench.user_id);

  // Double relegation check
  let doubleRelegate = null;
  if (eliteScores.length >= 4 && benchScores.length >= 2) {
    const fourth = eliteScores[3];
    const secondBench = benchScores[1];
    if (fourth && secondBench && fourth.cyclePoints < secondBench.cyclePoints / 2) {
      if (fourth.user_id !== lastElite.user_id) {
        db.prepare("UPDATE players SET tier = 'bench' WHERE user_id = ?").run(fourth.user_id);
        doubleRelegate = fourth;
      }
    }
  }

  // Reset cycle picks count and sold_acca flag
  db.prepare('UPDATE players SET picks_this_cycle = 0, sold_acca = 0').run();

  db.prepare(`
    INSERT INTO cycles (cycle_number, completed, elite_winner, relegated, promoted)
    VALUES (?, 1, ?, ?, ?)
  `).run(cycleNumber, winner?.username || null, lastElite?.username || null, firstBench?.username || null);

  return { winner, lastElite, firstBench, doubleRelegate };
}

// ── Leaderboards ───────────────────────────────────────────────

function getMonthlyLeaderboard() {
  return db.prepare('SELECT * FROM players ORDER BY monthly_points DESC').all();
}

function getSeasonLeaderboard() {
  return db.prepare('SELECT * FROM players ORDER BY season_points DESC').all();
}

function resetMonthlyPoints() {
  db.prepare('UPDATE players SET monthly_points = 0').run();
}

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

module.exports = {
  db, oddsToPoints, getOrCreatePlayer, getAllPlayers, getElite, getBench,
  getCurrentCycle, submitPick, getPlayerPick, getCyclePicks, setPickResult,
  sellAcca, endCycle, getMonthlyLeaderboard, getSeasonLeaderboard,
  resetMonthlyPoints, getSetting, setSetting,
};
