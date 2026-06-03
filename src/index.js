require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const db = require('./database');
const { verifyPick } = require('./pick-verifier');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', () => {
  console.log(`✅ Goon Acca Bot logged in as ${client.user.tag}`);
  client.user.setActivity('🎰 Goon Acca', { type: 3 });
});

function isAdmin(interaction) {
  return interaction.member?.permissions.has('ManageGuild');
}

async function getAnnouncementChannel() {
  const channelId = db.getSetting('announcement_channel');
  if (!channelId) return null;
  try { return await client.channels.fetch(channelId); } catch { return null; }
}

// ── Colours & helpers ──────────────────────────────────────────

const ELITE_COLOR = 0x1a7a3c;
const BENCH_COLOR = 0xcc2200;
const GOLD_COLOR  = 0xffd700;

function errorEmbed(msg) {
  return new EmbedBuilder().setColor(0xed4245).setDescription(`❌ ${msg}`);
}
function successEmbed(msg) {
  return new EmbedBuilder().setColor(0x57f287).setDescription(`✅ ${msg}`);
}

function tierEmoji(tier) { return tier === 'elite' ? '🟢' : '🔥'; }

// ── Command router ─────────────────────────────────────────────

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  try {
    switch (interaction.commandName) {
      case 'pick':        return await handlePick(interaction);
      case 'mypick':      return await handleMyPick(interaction);
      case 'picks':       return await handlePicks(interaction);
      case 'standings':   return await handleStandings(interaction);
      case 'rules':       return await handleRules(interaction);
      case 'sellacca':    return await handleSellAcca(interaction);
      case 'verify':      return await handleVerify(interaction);
      case 'verifyall':   return await handleVerifyAll(interaction);
      case 'result':      return await handleResult(interaction);
      case 'endcycle':    return await handleEndCycle(interaction);
      case 'resetmonth':  return await handleResetMonth(interaction);
      case 'addplayer':   return await handleAddPlayer(interaction);
      case 'setchannel':  return await handleSetChannel(interaction);
    }
  } catch (err) {
    console.error(`Error in /${interaction.commandName}:`, err);
    const embed = errorEmbed('Something went wrong. Please try again.');
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ embeds: [embed], ephemeral: true });
    } else {
      await interaction.reply({ embeds: [embed], ephemeral: true });
    }
  }
});

// ── /pick ──────────────────────────────────────────────────────

async function handlePick(interaction) {
  const description = interaction.options.getString('description');
  const odds        = interaction.options.getNumber('odds');
  const userId      = interaction.user.id;
  const username    = interaction.user.username;

  const player = db.getOrCreatePlayer(userId, username);

  if (player.sold_acca) {
    return interaction.reply({ embeds: [errorEmbed('You sold your acca this cycle — you\'re relegated and cannot pick!')], ephemeral: true });
  }

  const cycle = db.getCurrentCycle();
  const existing = db.getPlayerPick(userId, cycle);
  if (existing) {
    return interaction.reply({ embeds: [errorEmbed(`You already submitted a pick this cycle: **${existing.description}** @ ${existing.odds}. Only one pick per cycle!`)], ephemeral: true });
  }

  if (odds < 1.5) {
    return interaction.reply({ embeds: [errorEmbed('Minimum odds are **1.5**!')], ephemeral: true });
  }

  const now = new Date();
  const points = db.oddsToPoints(odds);
  const result = db.submitPick(userId, username, description, odds, cycle, now.getMonth() + 1, now.getFullYear());

  if (!result) {
    return interaction.reply({ embeds: [errorEmbed('Something went wrong submitting your pick.')], ephemeral: true });
  }

  const capNote = odds > 2.0 ? '\n⚠️ Odds above 2.0 — points capped at **20**' : '';
  const embed = new EmbedBuilder()
    .setColor(player.tier === 'elite' ? ELITE_COLOR : BENCH_COLOR)
    .setTitle(`${tierEmoji(player.tier)} Pick Submitted!`)
    .setDescription(`**${description}**\nOdds: **${odds}** → **${points} pts** if it lands${capNote}`)
    .setFooter({ text: `Cycle ${cycle} · ${player.tier === 'elite' ? 'Goon Elite' : 'Goon Bench'}` });

  await interaction.reply({ embeds: [embed] });

  // Announce in channel
  const channel = await getAnnouncementChannel();
  if (channel) {
    await channel.send({ embeds: [
      new EmbedBuilder()
        .setColor(player.tier === 'elite' ? ELITE_COLOR : BENCH_COLOR)
        .setDescription(`${tierEmoji(player.tier)} **${username}** has submitted their pick for cycle ${cycle}!`)
    ]});
  }
}

// ── /mypick ────────────────────────────────────────────────────

async function handleMyPick(interaction) {
  const cycle = db.getCurrentCycle();
  const pick = db.getPlayerPick(interaction.user.id, cycle);

  if (!pick) {
    return interaction.reply({ embeds: [errorEmbed('You haven\'t submitted a pick this cycle yet! Use `/pick`.')], ephemeral: true });
  }

  const resultText = pick.result === 'win' ? `✅ WON — **+${pick.points_awarded}pts**`
    : pick.result === 'loss' ? '❌ LOST — 0pts'
    : '⏳ Pending';

  const embed = new EmbedBuilder()
    .setColor(GOLD_COLOR)
    .setTitle(`🎰 Your Pick — Cycle ${cycle}`)
    .addFields(
      { name: 'Pick', value: pick.description },
      { name: 'Odds', value: String(pick.odds), inline: true },
      { name: 'Possible Points', value: String(pick.points_possible), inline: true },
      { name: 'Result', value: resultText, inline: true },
    );

  return interaction.reply({ embeds: [embed], ephemeral: true });
}

// ── /picks ─────────────────────────────────────────────────────

async function handlePicks(interaction) {
  const cycle = db.getCurrentCycle();
  const picks = db.getCyclePicks(cycle);

  if (picks.length === 0) {
    return interaction.reply({ embeds: [errorEmbed('No picks submitted yet this cycle!')] });
  }

  const lines = picks.map(p => {
    const status = p.result === 'win' ? `✅ +${p.points_awarded}pts`
      : p.result === 'loss' ? '❌ Loss'
      : '⏳ Pending';
    return `**${p.username}** — ${p.description} @ **${p.odds}** (${p.points_possible}pts) — ${status}`;
  });

  const embed = new EmbedBuilder()
    .setColor(GOLD_COLOR)
    .setTitle(`🎰 Cycle ${cycle} Picks`)
    .setDescription(lines.join('\n'));

  return interaction.reply({ embeds: [embed] });
}

// ── /standings ─────────────────────────────────────────────────

async function handleStandings(interaction) {
  const type = interaction.options.getString('type') || 'current';

  if (type === 'current') {
    const elite = db.getElite();
    const bench = db.getBench();

    const eliteLines = elite.length > 0
      ? elite.map((p, i) => `**${i + 1}.** ${p.username} — ${p.total_points}pts 🏆${p.elite_cups}`)
      : ['No players yet'];

    const benchLines = bench.length > 0
      ? bench.map((p, i) => `**${i + 1}.** ${p.username} — ${p.total_points}pts`)
      : ['No players yet'];

    const embed = new EmbedBuilder()
      .setColor(ELITE_COLOR)
      .setTitle('⚽ Goon Acca Standings')
      .addFields(
        { name: '🟢 GOON ELITE', value: eliteLines.join('\n') },
        { name: '🔥 GOON BENCH', value: benchLines.join('\n') },
      )
      .setFooter({ text: 'Every 5 picks: last in Elite relegated, first on Bench promoted' });

    return interaction.reply({ embeds: [embed] });
  }

  if (type === 'monthly') {
    const rows = db.getMonthlyLeaderboard();
    const lines = rows.map((p, i) => `**${i + 1}.** ${tierEmoji(p.tier)} ${p.username} — ${p.monthly_points}pts`);
    const embed = new EmbedBuilder()
      .setColor(0xc8aa5a)
      .setTitle('🏆 Copa del Goon — Monthly Standings')
      .setDescription(lines.join('\n') || 'No data yet');
    return interaction.reply({ embeds: [embed] });
  }

  if (type === 'season') {
    const rows = db.getSeasonLeaderboard();
    const lines = rows.map((p, i) => {
      const medals = ['🥇', '🥈', '🥉'];
      const pos = medals[i] || `**${i + 1}.**`;
      return `${pos} ${tierEmoji(p.tier)} ${p.username} — ${p.season_points}pts 🏆${p.elite_cups}`;
    });
    const embed = new EmbedBuilder()
      .setColor(GOLD_COLOR)
      .setTitle('🌟 Golden Goon — Season Standings')
      .setDescription(lines.join('\n') || 'No data yet');
    return interaction.reply({ embeds: [embed] });
  }
}

// ── /rules ─────────────────────────────────────────────────────

async function handleRules(interaction) {
  const embed = new EmbedBuilder()
    .setColor(GOLD_COLOR)
    .setTitle('📋 Goon Acca Rules')
    .addFields(
      { name: '🎰 Picks', value: 'One pick per cycle. Minimum odds **1.5**, maximum points at **2.0** (20pts).' },
      { name: '📊 Points', value: '1.5 odds = 15pts\n1.6 = 16pts\n1.7 = 17pts\n1.8 = 18pts\n1.9 = 19pts\n2.0+ = 20pts (capped)' },
      { name: '🔄 Every 5 Picks (Elite Cup)', value: '• Winner of Elite gets an Elite Cup 🏆\n• Last in Elite is **relegated** to Bench\n• First on Bench is **promoted** to Elite\n• Selling your acca = **instant relegation**' },
      { name: '⚠️ Double Relegation', value: 'If 4th in Elite has less than HALF of 2nd on Bench\'s points, they are also relegated.' },
      { name: '📅 Monthly (Copa del Goon)', value: 'Every pick counts toward the monthly standings. Winner gets crowned at month end.' },
      { name: '🌟 Season (Golden Goon)', value: 'Overall season standings across all picks.' },
    );
  return interaction.reply({ embeds: [embed] });
}

// ── /sellacca ──────────────────────────────────────────────────

async function handleSellAcca(interaction) {
  const player = db.getOrCreatePlayer(interaction.user.id, interaction.user.username);

  if (player.sold_acca) {
    return interaction.reply({ embeds: [errorEmbed('You\'ve already sold your acca this cycle!')], ephemeral: true });
  }

  db.sellAcca(interaction.user.id);

  const embed = new EmbedBuilder()
    .setColor(BENCH_COLOR)
    .setTitle('💸 Acca Sold — Instant Relegation!')
    .setDescription(`**${interaction.user.username}** has sold their acca and is immediately relegated to the Goon Bench! 😬`);

  await interaction.reply({ embeds: [embed] });

  const channel = await getAnnouncementChannel();
  if (channel) await channel.send({ embeds: [embed] });
}

// ── /verify (admin) ───────────────────────────────────────────

async function handleVerify(interaction) {
  if (!isAdmin(interaction)) return interaction.reply({ embeds: [errorEmbed('No permission.')], ephemeral: true });
  await interaction.deferReply();

  const target = interaction.options.getUser('user');
  const cycle  = db.getCurrentCycle();
  const pick   = db.getPlayerPick(target.id, cycle);

  if (!pick) return interaction.editReply({ embeds: [errorEmbed(`${target.username} hasn't submitted a pick this cycle!`)] });
  if (pick.result) return interaction.editReply({ embeds: [errorEmbed(`${target.username}'s pick already has a result: **${pick.result}**`)] });

  const verification = await verifyPick(pick.description);

  if (!verification.verified) {
    return interaction.editReply({ embeds: [
      new EmbedBuilder().setColor(0xfee75c)
        .setTitle(`⚠️ Could not auto-verify — ${target.username}`)
        .setDescription(`**Pick:** ${pick.description}
**Reason:** ${verification.reason}

Use \`/result\` to set manually.`)
    ]});
  }

  // Auto set result
  const { pointsAwarded } = db.setPickResult(pick.id, verification.result);
  const icon = verification.result === 'win' ? '✅' : '❌';
  const pts  = verification.result === 'win' ? `+${pointsAwarded}pts` : '0pts';

  const embed = new EmbedBuilder()
    .setColor(verification.result === 'win' ? 0x57f287 : 0xed4245)
    .setTitle(`${icon} Auto-Verified — ${target.username}`)
    .setDescription(`**${pick.description}** @ ${pick.odds}\n**Result:** ${verification.result.toUpperCase()} (${pts})\n**Source:** ${verification.reason}`);

  await interaction.editReply({ embeds: [embed] });

  try { await target.send(`${icon} Your pick **${pick.description}** @ ${pick.odds} — **${verification.result.toUpperCase()}**! ${pts}`); } catch {}

  const channel = await getAnnouncementChannel();
  if (channel) await channel.send({ embeds: [embed] });
}

// ── /verifyall (admin) ────────────────────────────────────────

async function handleVerifyAll(interaction) {
  if (!isAdmin(interaction)) return interaction.reply({ embeds: [errorEmbed('No permission.')], ephemeral: true });
  await interaction.deferReply();

  const cycle = db.getCurrentCycle();
  const picks = db.getCyclePicks(cycle).filter(p => !p.result);

  if (picks.length === 0) return interaction.editReply({ embeds: [successEmbed('No pending picks to verify!')] });

  const results = [];
  for (const pick of picks) {
    const verification = await verifyPick(pick.description);
    if (verification.verified) {
      const { pointsAwarded } = db.setPickResult(pick.id, verification.result);
      const icon = verification.result === 'win' ? '✅' : '❌';
      results.push(`${icon} **${pick.username}** — ${pick.description} (${verification.reason})`);
      try {
        const user = await client.users.fetch(pick.user_id);
        const pts = verification.result === 'win' ? `+${pointsAwarded}pts` : '0pts';
        await user.send(`${icon} Your pick **${pick.description}** @ ${pick.odds} — **${verification.result.toUpperCase()}**! ${pts}`);
      } catch {}
    } else {
      results.push(`⚠️ **${pick.username}** — ${pick.description} (needs manual: ${verification.reason})`);
    }
  }

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`🔄 Verify All — Cycle ${cycle}`)
    .setDescription(results.join('\n'));

  await interaction.editReply({ embeds: [embed] });
  const channel = await getAnnouncementChannel();
  if (channel) await channel.send({ embeds: [embed] });
}

// ── /result (admin) ────────────────────────────────────────────

async function handleResult(interaction) {
  if (!isAdmin(interaction)) return interaction.reply({ embeds: [errorEmbed('No permission.')], ephemeral: true });

  const target = interaction.options.getUser('user');
  const result = interaction.options.getString('result');
  const cycle  = db.getCurrentCycle();
  const pick   = db.getPlayerPick(target.id, cycle);

  if (!pick) {
    return interaction.reply({ embeds: [errorEmbed(`${target.username} hasn't submitted a pick this cycle!`)], ephemeral: true });
  }

  if (pick.result) {
    return interaction.reply({ embeds: [errorEmbed(`${target.username}'s pick already has a result: **${pick.result}**`)], ephemeral: true });
  }

  const { pointsAwarded } = db.setPickResult(pick.id, result);

  const icon = result === 'win' ? '✅' : '❌';
  const pts  = result === 'win' ? `+${pointsAwarded}pts` : '0pts';

  const embed = new EmbedBuilder()
    .setColor(result === 'win' ? 0x57f287 : 0xed4245)
    .setTitle(`${icon} Result Set`)
    .setDescription(`**${target.username}**'s pick **${pick.description}** @ ${pick.odds} — **${result.toUpperCase()}** (${pts})`);

  await interaction.reply({ embeds: [embed] });

  // DM the user
  try {
    await target.send(`${icon} Your pick **${pick.description}** @ ${pick.odds} — **${result.toUpperCase()}**! ${pts}`);
  } catch {}

  const channel = await getAnnouncementChannel();
  if (channel) await channel.send({ embeds: [embed] });
}

// ── /endcycle (admin) ──────────────────────────────────────────

async function handleEndCycle(interaction) {
  if (!isAdmin(interaction)) return interaction.reply({ embeds: [errorEmbed('No permission.')], ephemeral: true });

  const cycle = db.getCurrentCycle();
  const result = db.endCycle(cycle);

  if (!result) {
    return interaction.reply({ embeds: [errorEmbed('No players found to process cycle end.')] });
  }

  const { winner, lastElite, firstBench, doubleRelegate } = result;

  const lines = [
    winner    ? `🏆 **Elite Cup winner: ${winner.username}**` : '',
    lastElite ? `⬇️ Relegated: **${lastElite.username}**` : '',
    firstBench ? `⬆️ Promoted: **${firstBench.username}**` : '',
    doubleRelegate ? `⚠️ Double relegated: **${doubleRelegate.username}**` : '',
  ].filter(Boolean);

  const embed = new EmbedBuilder()
    .setColor(GOLD_COLOR)
    .setTitle(`🔄 Cycle ${cycle} Complete!`)
    .setDescription(lines.join('\n'))
    .setFooter({ text: `Cycle ${cycle + 1} begins now` });

  await interaction.reply({ embeds: [embed] });

  const channel = await getAnnouncementChannel();
  if (channel) await channel.send({ embeds: [embed] });
}

// ── /resetmonth (admin) ────────────────────────────────────────

async function handleResetMonth(interaction) {
  if (!isAdmin(interaction)) return interaction.reply({ embeds: [errorEmbed('No permission.')], ephemeral: true });

  // Announce winner before reset
  const monthly = db.getMonthlyLeaderboard();
  const channel = await getAnnouncementChannel();

  if (monthly.length > 0 && channel) {
    const winner = monthly[0];
    await channel.send({ embeds: [
      new EmbedBuilder()
        .setColor(GOLD_COLOR)
        .setTitle('🏆 Copa del Goon — Monthly Winner!')
        .setDescription(`Congratulations to **${winner.username}** with **${winner.monthly_points}pts**! 🎉`)
    ]});
  }

  db.resetMonthlyPoints();
  return interaction.reply({ embeds: [successEmbed('Monthly points reset! Copa del Goon standings cleared.')] });
}

// ── /addplayer (admin) ─────────────────────────────────────────

async function handleAddPlayer(interaction) {
  if (!isAdmin(interaction)) return interaction.reply({ embeds: [errorEmbed('No permission.')], ephemeral: true });

  const target = interaction.options.getUser('user');
  const tier   = interaction.options.getString('tier');

  db.db.prepare(`
    INSERT INTO players (user_id, username, tier) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET tier = excluded.tier
  `).run(target.id, target.username, tier);

  return interaction.reply({ embeds: [successEmbed(`**${target.username}** added to **${tier === 'elite' ? 'Goon Elite' : 'Goon Bench'}**!`)] });
}

// ── /setchannel (admin) ────────────────────────────────────────

async function handleSetChannel(interaction) {
  if (!isAdmin(interaction)) return interaction.reply({ embeds: [errorEmbed('No permission.')], ephemeral: true });
  const channel = interaction.options.getChannel('channel');
  db.setSetting('announcement_channel', channel.id);
  return interaction.reply({ embeds: [successEmbed(`Announcements will post to ${channel}`)] });
}

client.login(process.env.DISCORD_TOKEN);
