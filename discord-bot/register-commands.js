const { REST, Routes, SlashCommandBuilder } = require('discord.js');
require('dotenv').config();

const commands = [
  new SlashCommandBuilder()
    .setName('score')
    .setDescription('Look up an agent\'s trust score')
    .addStringOption(option =>
      option
        .setName('wallet_or_name')
        .setDescription('Agent wallet address or name')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Show top 10 agents by trust score'),

  new SlashCommandBuilder()
    .setName('ecosystem')
    .setDescription('Show ecosystem health stats'),

  new SlashCommandBuilder()
    .setName('alerts')
    .setDescription('Show recent risk alerts'),

  new SlashCommandBuilder()
    .setName('compare')
    .setDescription('Compare two agents\' trust metrics')
    .addStringOption(option =>
      option
        .setName('wallet1')
        .setDescription('First agent wallet address or name')
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName('wallet2')
        .setDescription('Second agent wallet address or name')
        .setRequired(true)
    ),
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log(`Started refreshing ${commands.length} application (/) commands.`);

    const data = await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: commands },
    );

    console.log(`Successfully reloaded ${data.length} application (/) commands.`);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
})();
