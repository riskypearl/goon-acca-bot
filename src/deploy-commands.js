require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  // ── User commands ──────────────────────────────────────────

  new SlashCommandBuilder()
    .setName('pick')
    .setDescription('Submit your acca pick for this cycle')
    .addStringOption(o => o.setName('description').setDescription('Your pick (e.g. "Man City to win vs Arsenal")').setRequired(true))
    .addNumberOption(o => o.setName('odds').setDescription('Odds (1.5 to 2.0)').setRequired(true).setMinValue(1.01).setMaxValue(10)),

  new SlashCommandBuilder()
    .setName('mypick')
    .setDescription('View your current cycle pick'),

  new SlashCommandBuilder()
    .setName('picks')
    .setDescription('View all picks for the current cycle'),

  new SlashCommandBuilder()
    .setName('standings')
    .setDescription('View the standings')
    .addStringOption(o => o.setName('type').setDescription('Which standings').addChoices(
      { name: 'Elite & Bench (current)', value: 'current' },
      { name: 'Copa del Goon (monthly)', value: 'monthly' },
      { name: 'Season (Golden Goon)', value: 'season' },
    )),

  new SlashCommandBuilder()
    .setName('rules')
    .setDescription('Show the Goon Acca rules'),

  new SlashCommandBuilder()
    .setName('sellacca')
    .setDescription('Sell your acca (WARNING: instant relegation!)'),

  // ── Admin commands ─────────────────────────────────────────

  new SlashCommandBuilder()
    .setName('verify')
    .setDescription('[ADMIN] Try to auto-verify a player\'s pick using the football API')
    .addUserOption(o => o.setName('user').setDescription('The player').setRequired(true)),

  new SlashCommandBuilder()
    .setName('verifyall')
    .setDescription('[ADMIN] Try to auto-verify all pending picks this cycle'),

  new SlashCommandBuilder()
    .setName('result')
    .setDescription('[ADMIN] Set the result of a player\'s pick')
    .addUserOption(o => o.setName('user').setDescription('The player').setRequired(true))
    .addStringOption(o => o.setName('result').setDescription('Win or loss').setRequired(true).addChoices(
      { name: '✅ Win', value: 'win' },
      { name: '❌ Loss', value: 'loss' },
    )),

  new SlashCommandBuilder()
    .setName('endcycle')
    .setDescription('[ADMIN] End the current cycle (every 5 picks) — triggers promotion/relegation'),

  new SlashCommandBuilder()
    .setName('resetmonth')
    .setDescription('[ADMIN] Reset monthly points for Copa del Goon'),

  new SlashCommandBuilder()
    .setName('addplayer')
    .setDescription('[ADMIN] Add a player to the league')
    .addUserOption(o => o.setName('user').setDescription('Player to add').setRequired(true))
    .addStringOption(o => o.setName('tier').setDescription('Starting tier').setRequired(true).addChoices(
      { name: 'Elite', value: 'elite' },
      { name: 'Bench', value: 'bench' },
    )),

  new SlashCommandBuilder()
    .setName('setchannel')
    .setDescription('[ADMIN] Set the announcements channel')
    .addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true)),

].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('Registering slash commands...');
    await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
    console.log('✅ Slash commands registered!');
  } catch (err) {
    console.error('❌ Failed:', err);
  }
})();
