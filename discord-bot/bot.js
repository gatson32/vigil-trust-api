const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const axios = require('axios');
require('dotenv').config();

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages] });

const API_BASE_URL = 'https://vigil-trust-api.onrender.com';
const VIGIL_COLOR = '#1a1a2e';
const VIGIL_ACCENT = '#00ff88';

// Utility function to create embeds with VIGIL branding
function createVigilEmbed(title, description = '') {
  const embed = new EmbedBuilder()
    .setColor(VIGIL_COLOR)
    .setTitle(`🛡️ ${title}`)
    .setFooter({ text: 'VIGIL — Trust Infrastructure for AI Agents' });

  if (description) {
    embed.setDescription(description);
  }

  return embed;
}

// Error embed
function createErrorEmbed(title, message) {
  return new EmbedBuilder()
    .setColor('#ff3333')
    .setTitle(`🛡️ ${title}`)
    .setDescription(message)
    .setFooter({ text: 'VIGIL — Trust Infrastructure for AI Agents' });
}

// API error handler
async function handleApiCall(url, errorContext = 'API Error') {
  try {
    const response = await axios.get(url, {
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' }
    });
    return { success: true, data: response.data };
  } catch (error) {
    console.error(`${errorContext}:`, error.message);

    let errorMessage = 'Unable to fetch data from VIGIL API.';
    if (error.response?.status === 404) {
      errorMessage = 'Agent or resource not found.';
    } else if (error.response?.status === 500) {
      errorMessage = 'VIGIL API is currently unavailable.';
    } else if (error.code === 'ECONNABORTED') {
      errorMessage = 'Request timeout. Please try again.';
    }

    return { success: false, error: errorMessage };
  }
}

// Command: /score
async function handleScore(interaction) {
  await interaction.deferReply();

  const identifier = interaction.options.getString('wallet_or_name');
  const result = await handleApiCall(`${API_BASE_URL}/v1/score/${encodeURIComponent(identifier)}`, 'Score Lookup');

  if (!result.success) {
    return interaction.editReply({ embeds: [createErrorEmbed('Score Lookup Failed', result.error)] });
  }

  const data = result.data;
  const embed = createVigilEmbed('Agent Trust Score', `**Agent:** ${data.name || identifier}`)
    .addFields(
      { name: '📊 Trust Score', value: `\`${data.score?.toFixed(2) || 'N/A'}\``, inline: true },
      { name: '🏆 Tier', value: `\`${data.tier || 'Unknown'}\``, inline: true },
      { name: '⚠️ Risk Level', value: `\`${data.risk_level || 'Unknown'}\``, inline: true },
      { name: 'Total Transactions', value: `\`${data.metrics?.total_transactions || 0}\``, inline: true },
      { name: 'Success Rate', value: `\`${(data.metrics?.success_rate * 100 || 0).toFixed(2)}%\``, inline: true },
      { name: 'Average Value', value: `\`$${(data.metrics?.average_value || 0).toFixed(2)}\``, inline: true }
    );

  if (data.metrics?.days_active) {
    embed.addFields({ name: 'Days Active', value: `\`${data.metrics.days_active}\``, inline: true });
  }

  return interaction.editReply({ embeds: [embed] });
}

// Command: /leaderboard
async function handleLeaderboard(interaction) {
  await interaction.deferReply();

  const result = await handleApiCall(`${API_BASE_URL}/v1/leaderboard?top_n=10`, 'Leaderboard Fetch');

  if (!result.success) {
    return interaction.editReply({ embeds: [createErrorEmbed('Leaderboard Failed', result.error)] });
  }

  const agents = result.data.agents || result.data || [];
  if (agents.length === 0) {
    return interaction.editReply({ embeds: [createErrorEmbed('Leaderboard', 'No agents found on the leaderboard.')] });
  }

  let leaderboardText = '';
  agents.slice(0, 10).forEach((agent, index) => {
    leaderboardText += `**${index + 1}.** ${agent.name || agent.wallet || 'Unknown'}\n`;
    leaderboardText += `    Score: \`${agent.score?.toFixed(2) || 'N/A'}\` | Tier: \`${agent.tier || 'N/A'}\`\n`;
  });

  const embed = createVigilEmbed('Top 10 Agents by Trust Score', leaderboardText)
    .setColor(VIGIL_ACCENT);

  return interaction.editReply({ embeds: [embed] });
}

// Command: /ecosystem
async function handleEcosystem(interaction) {
  await interaction.deferReply();

  const result = await handleApiCall(`${API_BASE_URL}/v1/ecosystem/health`, 'Ecosystem Health');

  if (!result.success) {
    return interaction.editReply({ embeds: [createErrorEmbed('Ecosystem Failed', result.error)] });
  }

  const data = result.data;
  const embed = createVigilEmbed('Ecosystem Health', 'VIGIL Network Status')
    .addFields(
      { name: '👥 Total Agents', value: `\`${data.total_agents || 0}\``, inline: true },
      { name: '📈 Average Score', value: `\`${(data.average_score || 0).toFixed(2)}\``, inline: true },
      { name: '🔄 Active Transactions (24h)', value: `\`${data.active_transactions_24h || 0}\``, inline: true }
    );

  if (data.risk_distribution) {
    const riskDist = data.risk_distribution;
    let riskText = '';
    riskText += `Low: \`${riskDist.low || 0}\`\n`;
    riskText += `Medium: \`${riskDist.medium || 0}\`\n`;
    riskText += `High: \`${riskDist.high || 0}\``;
    embed.addFields({ name: '⚠️ Risk Distribution', value: riskText, inline: false });
  }

  if (data.tvl) {
    embed.addFields({ name: '💰 Total Value Locked', value: `\`$${data.tvl.toFixed(2)}\``, inline: true });
  }

  embed.setColor(VIGIL_ACCENT);
  return interaction.editReply({ embeds: [embed] });
}

// Command: /alerts
async function handleAlerts(interaction) {
  await interaction.deferReply();

  const result = await handleApiCall(`${API_BASE_URL}/v1/alerts/recent?limit=5`, 'Alerts Fetch');

  if (!result.success) {
    return interaction.editReply({ embeds: [createErrorEmbed('Alerts Failed', result.error)] });
  }

  const alerts = result.data.alerts || result.data || [];

  if (alerts.length === 0) {
    return interaction.editReply({ embeds: [createErrorEmbed('Recent Alerts', 'No recent alerts found.')] });
  }

  const embed = createVigilEmbed('Recent Risk Alerts', `Showing ${Math.min(5, alerts.length)} recent alerts`);

  alerts.slice(0, 5).forEach((alert, index) => {
    const severityEmoji = {
      'critical': '🔴',
      'high': '🟠',
      'medium': '🟡',
      'low': '🟢'
    }[alert.severity?.toLowerCase()] || '⚪';

    const alertText = `${severityEmoji} **${alert.severity || 'Unknown'}**\n${alert.message || 'No details'}\n_${alert.timestamp || 'N/A'}_`;
    embed.addFields({
      name: `Alert ${index + 1}: ${alert.agent_name || alert.agent || 'Unknown Agent'}`,
      value: alertText,
      inline: false
    });
  });

  embed.setColor('#ff6b6b');
  return interaction.editReply({ embeds: [embed] });
}

// Command: /compare
async function handleCompare(interaction) {
  await interaction.deferReply();

  const wallet1 = interaction.options.getString('wallet1');
  const wallet2 = interaction.options.getString('wallet2');

  const result = await handleApiCall(
    `${API_BASE_URL}/v1/compare?agents=${encodeURIComponent(wallet1)},${encodeURIComponent(wallet2)}`,
    'Compare Agents'
  );

  if (!result.success) {
    return interaction.editReply({ embeds: [createErrorEmbed('Comparison Failed', result.error)] });
  }

  const data = result.data;

  if (!data.agent1 || !data.agent2) {
    return interaction.editReply({ embeds: [createErrorEmbed('Comparison Failed', 'One or both agents not found.')] });
  }

  const agent1 = data.agent1;
  const agent2 = data.agent2;

  const embed = createVigilEmbed('Agent Comparison', 'Side-by-Side Trust Metrics');

  embed.addFields(
    { name: '🛡️ Agent 1', value: agent1.name || wallet1, inline: true },
    { name: '🛡️ Agent 2', value: agent2.name || wallet2, inline: true },
    { name: '\u200B', value: '\u200B', inline: false },
    { name: 'Trust Score', value: `${agent1.score?.toFixed(2) || 'N/A'}`, inline: true },
    { name: 'Trust Score', value: `${agent2.score?.toFixed(2) || 'N/A'}`, inline: true },
    { name: '\u200B', value: '\u200B', inline: false },
    { name: 'Tier', value: agent1.tier || 'N/A', inline: true },
    { name: 'Tier', value: agent2.tier || 'N/A', inline: true },
    { name: '\u200B', value: '\u200B', inline: false },
    { name: 'Risk Level', value: agent1.risk_level || 'N/A', inline: true },
    { name: 'Risk Level', value: agent2.risk_level || 'N/A', inline: true },
    { name: '\u200B', value: '\u200B', inline: false }
  );

  if (agent1.metrics && agent2.metrics) {
    embed.addFields(
      { name: 'Success Rate', value: `${(agent1.metrics.success_rate * 100 || 0).toFixed(2)}%`, inline: true },
      { name: 'Success Rate', value: `${(agent2.metrics.success_rate * 100 || 0).toFixed(2)}%`, inline: true }
    );
  }

  embed.setColor(VIGIL_ACCENT);
  return interaction.editReply({ embeds: [embed] });
}

// Handle interactions
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    const command = interaction.commandName;

    switch (command) {
      case 'score':
        await handleScore(interaction);
        break;
      case 'leaderboard':
        await handleLeaderboard(interaction);
        break;
      case 'ecosystem':
        await handleEcosystem(interaction);
        break;
      case 'alerts':
        await handleAlerts(interaction);
        break;
      case 'compare':
        await handleCompare(interaction);
        break;
      default:
        await interaction.reply({ content: 'Unknown command.', ephemeral: true });
    }
  } catch (error) {
    console.error('Command error:', error);
    if (!interaction.replied) {
      await interaction.reply({ embeds: [createErrorEmbed('Error', 'An unexpected error occurred.')], ephemeral: true });
    }
  }
});

// Ready event
client.on('ready', () => {
  console.log(`✅ VIGIL Discord Bot is online as ${client.user.tag}`);
  client.user.setActivity('👁️ VIGIL Trust Network', { type: 'WATCHING' });
});

// Login
client.login(process.env.DISCORD_TOKEN);

module.exports = client;
