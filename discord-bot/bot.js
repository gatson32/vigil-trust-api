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
    .setFooter({ text: 'VIGIL — Trust Infrastructure for AI Agents' })
    .setTimestamp();

  if (description) {
    embed.setDescription(description);
  }

  return embed;
}

// Error embed — differentiates user errors from system errors
function createErrorEmbed(title, message, isSystemError = false) {
  return new EmbedBuilder()
    .setColor(isSystemError ? '#ff3333' : '#ffaa00')
    .setTitle(`🛡️ ${title}`)
    .setDescription(isSystemError
      ? `⚠️ ${message}\n\n_The VIGIL API may be temporarily unavailable. Try again in a moment._`
      : message)
    .setFooter({ text: 'VIGIL — Trust Infrastructure for AI Agents' })
    .setTimestamp();
}

// API error handler with better error classification
async function handleApiCall(url, errorContext = 'API Error') {
  try {
    const response = await axios.get(url, {
      timeout: 15000,
      headers: { 'Content-Type': 'application/json' }
    });
    return { success: true, data: response.data };
  } catch (error) {
    console.error(`${errorContext}:`, error.message, error.response?.status || 'NO_STATUS');

    if (error.response?.status === 404) {
      return { success: false, error: 'Agent or resource not found.', isSystemError: false };
    } else if (error.response?.status === 400) {
      return { success: false, error: error.response.data?.message || 'Invalid request.', isSystemError: false };
    } else if (error.response?.status === 429) {
      return { success: false, error: 'Rate limit reached. Please wait a moment and try again.', isSystemError: false };
    } else if (error.response?.status >= 500) {
      return { success: false, error: 'VIGIL API is currently unavailable.', isSystemError: true };
    } else if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      return { success: false, error: 'Request timed out. The API may be waking up — try again in 30 seconds.', isSystemError: true };
    } else if (error.code === 'ECONNREFUSED') {
      return { success: false, error: 'Cannot reach VIGIL API.', isSystemError: true };
    }

    return { success: false, error: 'Unable to fetch data from VIGIL API.', isSystemError: true };
  }
}

// Tier emoji mapping
function tierEmoji(tier) {
  const map = {
    'ELITE': '◆',
    'TRUSTED': '◇',
    'ESTABLISHED': '○',
    'EMERGING': '△',
    'NEW': '·',
    'INACTIVE': '✕',
    'HIGH_RISK': '⚠️'
  };
  return map[tier] || '·';
}

// Format large numbers
function formatNum(n) {
  if (n === null || n === undefined) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

// Command: /score — adapted to actual API response format
async function handleScore(interaction) {
  await interaction.deferReply();

  const identifier = interaction.options.getString('wallet_or_name');

  // If input looks like a name, use search endpoint first
  let result;
  if (!identifier.startsWith('0x')) {
    result = await handleApiCall(`${API_BASE_URL}/v1/search?q=${encodeURIComponent(identifier)}`, 'Score Lookup (Search)');
    if (result.success && result.data?.data?.length > 0) {
      const agent = result.data.data[0];
      return sendScoreEmbed(interaction, agent);
    }
  }

  // Direct lookup by wallet or documentId
  result = await handleApiCall(`${API_BASE_URL}/v1/score/${encodeURIComponent(identifier)}`, 'Score Lookup');

  if (!result.success) {
    return interaction.editReply({
      embeds: [createErrorEmbed('Score Lookup Failed', result.error, result.isSystemError)]
    });
  }

  const agent = result.data?.data || result.data;
  return sendScoreEmbed(interaction, agent);
}

function sendScoreEmbed(interaction, agent) {
  const embed = createVigilEmbed('Agent Trust Score')
    .addFields(
      { name: '🤖 Agent', value: `**${agent.name || 'Unknown'}**\n${agent.symbol ? `$${agent.symbol}` : ''} ${tierEmoji(agent.trustTier)} ${agent.tierLabel || agent.trustTier}`, inline: false },
      { name: '📊 Trust Score', value: `\`${agent.trustScore ?? 'N/A'}\` / 100`, inline: true },
      { name: '🏆 Tier', value: `\`${agent.tierLabel || agent.trustTier || 'Unknown'}\``, inline: true },
      { name: '⚡ Status', value: agent.isOnline ? '🟢 Online' : '🔴 Offline', inline: true },
      { name: '📈 Reliability', value: `\`${agent.scoreBreakdown?.reliability?.score ?? 'N/A'}\``, inline: true },
      { name: '🔄 Activity', value: `\`${agent.scoreBreakdown?.activity?.score ?? 'N/A'}\``, inline: true },
      { name: '💰 Economic', value: `\`${agent.scoreBreakdown?.economic?.score ?? 'N/A'}\``, inline: true },
      { name: '👥 Reputation', value: `\`${agent.scoreBreakdown?.reputation?.score ?? 'N/A'}\``, inline: true },
      { name: '⏳ Longevity', value: `\`${agent.scoreBreakdown?.longevity?.score ?? 'N/A'}\``, inline: true },
      { name: '✅ Success Rate', value: `\`${(agent.metrics?.successRate ?? 0).toFixed(1)}%\``, inline: true }
    );

  if (agent.riskFlags && agent.riskFlags.length > 0) {
    embed.addFields({
      name: '⚠️ Risk Flags',
      value: agent.riskFlags.map(f => `\`${f}\``).join(', '),
      inline: false
    });
  }

  if (agent.walletAddress) {
    embed.addFields({
      name: '🔗 Wallet',
      value: `\`${agent.walletAddress.slice(0, 6)}...${agent.walletAddress.slice(-4)}\``,
      inline: true
    });
  }

  return interaction.editReply({ embeds: [embed] });
}

// Command: /leaderboard — adapted to actual API response format
async function handleLeaderboard(interaction) {
  await interaction.deferReply();

  const result = await handleApiCall(`${API_BASE_URL}/v1/leaderboard?pageSize=10`, 'Leaderboard Fetch');

  if (!result.success) {
    return interaction.editReply({
      embeds: [createErrorEmbed('Leaderboard Failed', result.error, result.isSystemError)]
    });
  }

  const agents = result.data?.data || result.data?.agents || [];
  if (agents.length === 0) {
    return interaction.editReply({
      embeds: [createErrorEmbed('Leaderboard', 'No agents found on the leaderboard.')]
    });
  }

  let leaderboardText = '';
  agents.slice(0, 10).forEach((agent, index) => {
    const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `**${index + 1}.**`;
    leaderboardText += `${medal} **${agent.name || 'Unknown'}**\n`;
    leaderboardText += `    Score: \`${agent.trustScore ?? 'N/A'}\` | ${tierEmoji(agent.trustTier)} \`${agent.tierLabel || agent.trustTier}\` | Jobs: \`${formatNum(agent.metrics?.successfulJobCount)}\`\n`;
  });

  const embed = createVigilEmbed('Top 10 Agents by Trust Score', leaderboardText)
    .setColor(VIGIL_ACCENT);

  return interaction.editReply({ embeds: [embed] });
}

// Command: /ecosystem — adapted to actual API response format
async function handleEcosystem(interaction) {
  await interaction.deferReply();

  const result = await handleApiCall(`${API_BASE_URL}/v1/ecosystem/health`, 'Ecosystem Health');

  if (!result.success) {
    return interaction.editReply({
      embeds: [createErrorEmbed('Ecosystem Failed', result.error, result.isSystemError)]
    });
  }

  const data = result.data?.data || result.data;

  // Tier distribution text
  let tierText = '';
  if (data.tierDistribution) {
    const td = data.tierDistribution;
    tierText = `◆ Elite: \`${td.ELITE || 0}\` | ◇ Trusted: \`${td.TRUSTED || 0}\` | ○ Established: \`${td.ESTABLISHED || 0}\`\n△ Emerging: \`${td.EMERGING || 0}\` | · New: \`${td.NEW || 0}\` | ✕ Inactive: \`${td.INACTIVE || 0}\``;
  }

  const embed = createVigilEmbed('Ecosystem Health', 'VIGIL Network Status — Top 100 Agents')
    .addFields(
      { name: '👥 Total Agents Tracked', value: `\`${formatNum(data.totalAgents || 0)}\``, inline: true },
      { name: '📊 Sample Size', value: `\`${data.sampleSize || 0}\``, inline: true },
      { name: '📈 Avg Trust Score', value: `\`${data.avgTrustScore || 0}\``, inline: true },
      { name: '✅ Avg Success Rate', value: `\`${data.avgSuccessRate || 0}%\``, inline: true },
      { name: '🟢 Online Now', value: `\`${data.onlineCount || 0}\``, inline: true },
      { name: '🎓 Graduated', value: `\`${data.graduatedCount || 0}\``, inline: true },
      { name: '💼 Total Jobs', value: `\`${formatNum(data.totalJobs || 0)}\``, inline: true },
      { name: '💰 Total aGDP', value: `\`$${formatNum(data.totalAgdp || 0)}\``, inline: true },
      { name: '💵 Total Revenue', value: `\`$${formatNum(data.totalRevenue || 0)}\``, inline: true }
    );

  if (tierText) {
    embed.addFields({ name: '🏆 Tier Distribution', value: tierText, inline: false });
  }

  if (data.riskSummary) {
    embed.addFields({
      name: '⚠️ Risk Summary',
      value: `\`${data.riskSummary.flaggedCount || 0}\` agents flagged`,
      inline: false
    });
  }

  embed.setColor(VIGIL_ACCENT);
  return interaction.editReply({ embeds: [embed] });
}

// Command: /alerts — FIXED: uses correct endpoint /v1/alerts (not /v1/alerts/recent)
async function handleAlerts(interaction) {
  await interaction.deferReply();

  const result = await handleApiCall(`${API_BASE_URL}/v1/alerts`, 'Alerts Fetch');

  if (!result.success) {
    return interaction.editReply({
      embeds: [createErrorEmbed('Alerts Failed', result.error, result.isSystemError)]
    });
  }

  const alerts = result.data?.data || result.data?.alerts || [];

  if (alerts.length === 0) {
    const embed = createVigilEmbed('Risk Alerts', '✅ No agents with active risk flags.')
      .setColor(VIGIL_ACCENT);
    return interaction.editReply({ embeds: [embed] });
  }

  // Show top 5 highest risk agents
  const top5 = alerts.slice(0, 5);

  const embed = createVigilEmbed('Risk Alerts', `Showing ${Math.min(5, alerts.length)} of ${alerts.length} flagged agents`);

  top5.forEach((agent, index) => {
    const flags = (agent.riskFlags || []).map(f => `\`${f}\``).join(', ');
    const agentText = `Score: \`${agent.trustScore ?? 'N/A'}\` | Tier: \`${agent.trustTier || 'Unknown'}\`\nFlags: ${flags || 'None'}\nLast Active: \`${agent.daysSinceActive ?? '?'}d ago\``;
    embed.addFields({
      name: `${index + 1}. ${agent.name || 'Unknown Agent'}`,
      value: agentText,
      inline: false
    });
  });

  embed.setColor('#ff6b6b');
  return interaction.editReply({ embeds: [embed] });
}

// Command: /compare — adapted to actual API response format
async function handleCompare(interaction) {
  await interaction.deferReply();

  const wallet1 = interaction.options.getString('wallet1');
  const wallet2 = interaction.options.getString('wallet2');

  const result = await handleApiCall(
    `${API_BASE_URL}/v1/compare?ids=${encodeURIComponent(wallet1)},${encodeURIComponent(wallet2)}`,
    'Compare Agents'
  );

  if (!result.success) {
    return interaction.editReply({
      embeds: [createErrorEmbed('Comparison Failed', result.error, result.isSystemError)]
    });
  }

  const agents = result.data?.data || [];
  const fulfilled = agents.filter(a => a.status === 'fulfilled' && a.data);

  if (fulfilled.length < 2) {
    const notFound = agents.filter(a => a.status === 'rejected').map(a => a.identifier).join(', ');
    return interaction.editReply({
      embeds: [createErrorEmbed('Comparison Failed', `Could not find agents: ${notFound || 'unknown'}. Check the wallet addresses or IDs.`)]
    });
  }

  const a1 = fulfilled[0].data;
  const a2 = fulfilled[1].data;

  const embed = createVigilEmbed('Agent Comparison', 'Side-by-Side Trust Metrics');

  embed.addFields(
    { name: '🛡️ Agent 1', value: `**${a1.name}**\n${tierEmoji(a1.trustTier)} ${a1.tierLabel}`, inline: true },
    { name: '🛡️ Agent 2', value: `**${a2.name}**\n${tierEmoji(a2.trustTier)} ${a2.tierLabel}`, inline: true },
    { name: '\u200B', value: '\u200B', inline: false },
    { name: 'Trust Score', value: `\`${a1.trustScore}\``, inline: true },
    { name: 'Trust Score', value: `\`${a2.trustScore}\``, inline: true },
    { name: '\u200B', value: '\u200B', inline: false },
    { name: 'Reliability', value: `\`${a1.scoreBreakdown?.reliability?.score ?? 'N/A'}\``, inline: true },
    { name: 'Reliability', value: `\`${a2.scoreBreakdown?.reliability?.score ?? 'N/A'}\``, inline: true },
    { name: '\u200B', value: '\u200B', inline: false },
    { name: 'Success Rate', value: `\`${(a1.metrics?.successRate ?? 0).toFixed(1)}%\``, inline: true },
    { name: 'Success Rate', value: `\`${(a2.metrics?.successRate ?? 0).toFixed(1)}%\``, inline: true },
    { name: '\u200B', value: '\u200B', inline: false },
    { name: 'Jobs', value: `\`${formatNum(a1.metrics?.successfulJobCount)}\``, inline: true },
    { name: 'Jobs', value: `\`${formatNum(a2.metrics?.successfulJobCount)}\``, inline: true }
  );

  embed.setColor(VIGIL_ACCENT);
  return interaction.editReply({ embeds: [embed] });
}

// Handle interactions
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    const command = interaction.commandName;
    console.log(`[CMD] /${command} by ${interaction.user.tag} in ${interaction.guild?.name || 'DM'}`);

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
    console.error('Command error:', error.message, error.stack);
    try {
      const errorEmbed = createErrorEmbed('Unexpected Error', 'Something went wrong processing your command.', true);
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ embeds: [errorEmbed] });
      } else {
        await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
      }
    } catch (replyError) {
      console.error('Failed to send error response:', replyError.message);
    }
  }
});

// Ready event
client.on('ready', () => {
  console.log(`✅ VIGIL Discord Bot is online as ${client.user.tag}`);
  console.log(`   Serving ${client.guilds.cache.size} guild(s)`);
  client.user.setActivity('Trust Scores | /score', { type: 3 }); // WATCHING
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  client.destroy();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down...');
  client.destroy();
  process.exit(0);
});

// Login
client.login(process.env.DISCORD_TOKEN);

module.exports = client;
