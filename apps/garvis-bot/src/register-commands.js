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
    .setName('installhelp')
    .setDescription('Ask Garvis for tailored help installing the modded client (any OS).')
    .addStringOption((o) =>
      o.setName('question')
        .setDescription('Describe your setup + what you need, e.g. "Ubuntu aarch64, account but nothing installed"')
        .setRequired(true))
    .toJSON(),
  new SlashCommandBuilder()
    .setName('debug')
    .setDescription('Open a thread where Garvis helps you debug, remembering the conversation.')
    .addStringOption((o) =>
      o.setName('topic')
        .setDescription('What broke? e.g. "NeoForge installer fails on Ubuntu aarch64 with error X"')
        .setRequired(true))
    .toJSON(),
  new SlashCommandBuilder()
    .setName('whitelist')
    .setDescription('Whitelist a Minecraft (Java) username so they can join — yourself or a friend.')
    .addStringOption((o) =>
      o.setName('username')
        .setDescription('Minecraft Java username (3–16 chars: letters, numbers, _)')
        .setRequired(true))
    .toJSON(),
];

const rest = new REST({ version: '10' }).setToken(DISCORD_BOT_TOKEN);
await rest.put(Routes.applicationGuildCommands(DISCORD_APP_ID, DISCORD_GUILD_ID), { body: commands });
console.log(`Registered ${commands.length} guild command(s).`);
