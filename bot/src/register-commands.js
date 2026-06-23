// Registers @Garvis slash commands to your guild. Run once (and after changes):
//   node src/register-commands.js
// Needs DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, and the application id (DISCORD_APP_ID).
import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

const { DISCORD_BOT_TOKEN, DISCORD_APP_ID, DISCORD_GUILD_ID } = process.env;
if (!DISCORD_BOT_TOKEN || !DISCORD_APP_ID || !DISCORD_GUILD_ID) {
  console.error('Missing DISCORD_BOT_TOKEN / DISCORD_APP_ID / DISCORD_GUILD_ID in env.');
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder()
    .setName('requestmod')
    .setDescription('Request a mod be added to the server (opens a PR for owner approval).')
    .addStringOption((o) =>
      o.setName('slug').setDescription('Modrinth project slug, e.g. "create"').setRequired(true))
    .addStringOption((o) =>
      o.setName('reason').setDescription('Why you want it (optional)').setRequired(false))
    .toJSON(),
  new SlashCommandBuilder()
    .setName('installhelp')
    .setDescription('Get step-by-step help installing the modded client on Windows.')
    .toJSON(),
];

const rest = new REST({ version: '10' }).setToken(DISCORD_BOT_TOKEN);
await rest.put(Routes.applicationGuildCommands(DISCORD_APP_ID, DISCORD_GUILD_ID), { body: commands });
console.log(`Registered ${commands.length} guild command(s).`);
