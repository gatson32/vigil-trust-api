/**
 * VIGIL Telegram Bot
 * Commands:
 *   /score <wallet|username>  — Get VIGIL trust score
 *   /compare <wallet1> <wallet2> — Compare two wallets
 *   /top — Show leaderboard
 *   /start — Welcome message
 *   /help — Command list
 *
 * Env: TELEGRAM_BOT_TOKEN, VIGIL_API_URL (defaults to https://vigil-trust-api.onrender.com)
 */

const VIGIL_API = process.env.VIGIL_API_URL || 'https://vigil-trust-api.onrender.com';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!BOT_TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN not set');
  process.exit(1);
}

const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ── Telegram API helpers ────────────────────────────────────────────

async function sendMessage(chatId: number, text: string, parseMode = 'HTML') {
  await fetch(`${TG_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: parseMode,
      disable_web_page_preview: true,
    }),
  });
}

async function setWebhook(url: string) {
  const res = await fetch(`${TG_API}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  return res.json();
}

async function deleteWebhook() {
  const res = await fetch(`${TG_API}/deleteWebhook`, { method: 'POST' });
  return res.json();
}

// ── Grade emoji mapping ─────────────────────────────────────────────

function gradeEmoji(grade: string): string {
  const map: Record<string, string> = {
    A: '🟢', B: '🔵', C: '🟡', D: '🟠', F: '🔴',
  };
  return map[grade] || '⚪';
}

function pnlStr(pnl: number): string {
  if (pnl >= 0) return `+$${Math.round(pnl).toLocaleString()}`;
  return `-$${Math.round(Math.abs(pnl)).toLocaleString()}`;
}

// ── VIGIL API calls ─────────────────────────────────────────────────

async function fetchScore(wallet: string): Promise<any> {
  const res = await fetch(`${VIGIL_API}/v1/polymarket/${encodeURIComponent(wallet)}`);
  if (!res.ok) return null;
  return res.json();
}

// ── Command handlers ────────────────────────────────────────────────

async function handleStart(chatId: number) {
  await sendMessage(chatId, `
<b>VIGIL Trust Score Bot</b>

Score any Polymarket wallet's forecasting skill across 6 dimensions.

<b>Commands:</b>
/score &lt;wallet or username&gt; — Get trust score
/compare &lt;wallet1&gt; &lt;wallet2&gt; — Head-to-head comparison
/top — Polymarket top 10 leaderboard
/help — Show this message

<b>Example:</b>
<code>/score 0x492442eab586f242b53bda933fd5de859c8a3782</code>
<code>/score swisstony</code>

Powered by <a href="${VIGIL_API}">VIGIL</a>
  `.trim());
}

async function handleScore(chatId: number, args: string) {
  if (!args.trim()) {
    await sendMessage(chatId, '⚠️ Usage: <code>/score &lt;wallet address or username&gt;</code>');
    return;
  }

  const wallet = args.trim().split(/\s+/)[0];
  await sendMessage(chatId, `⏳ Scoring <code>${wallet.length > 20 ? wallet.slice(0, 8) + '...' + wallet.slice(-4) : wallet}</code>...`);

  const d = await fetchScore(wallet);
  if (!d || d.error) {
    await sendMessage(chatId, `❌ ${d?.message || 'Wallet not found or no trading data.'}`);
    return;
  }

  const emoji = gradeEmoji(d.trustGrade);
  const pnl = d.raw?.totalPnl || 0;
  const name = d.displayName && !d.displayName.startsWith('0x')
    ? d.displayName.split('-')[0]
    : d.wallet.slice(0, 8) + '...' + d.wallet.slice(-4);

  const flags = (d.flags || []).slice(0, 3).map((f: string) => `  ⚠️ ${f}`).join('\n');
  const greens = (d.greenFlags || []).slice(0, 2).map((f: string) => `  ✅ ${f}`).join('\n');

  const msg = `
${emoji} <b>VIGIL Trust Score: ${d.trustGrade} / ${d.trustScore}</b>
<b>${name}</b> — ${d.trustTier}

📊 <b>Dimensions:</b>
  Calibration: ${d.calibration ?? '-'}/100
  Live Edge: ${d.liveEdge ?? '-'}/100
  Profitability: ${d.profitability ?? '-'}/100
  Consistency: ${d.consistency ?? '-'}/100
  Discipline: ${d.discipline ?? '-'}/100
  Sample Size: ${d.sampleSize ?? '-'}/100

💰 PnL: <b>${pnlStr(pnl)}</b>
📈 Trades: ${d.raw?.totalTrades || 0} across ${d.raw?.uniqueMarkets || 0} markets
✅ Resolved: ${d.raw?.resolvedBets || 0}
${flags ? `\n🚩 <b>Flags:</b>\n${flags}` : ''}${greens ? `\n🟢 <b>Strengths:</b>\n${greens}` : ''}

🔗 <a href="${VIGIL_API}/polymarket/${d.wallet}">Full Scorecard</a>
  `.trim();

  await sendMessage(chatId, msg);
}

async function handleCompare(chatId: number, args: string) {
  const parts = args.trim().split(/\s+/);
  if (parts.length < 2) {
    await sendMessage(chatId, '⚠️ Usage: <code>/compare &lt;wallet1&gt; &lt;wallet2&gt;</code>');
    return;
  }

  await sendMessage(chatId, '⏳ Comparing wallets...');

  const [d1, d2] = await Promise.all([fetchScore(parts[0]), fetchScore(parts[1])]);

  if (!d1 || d1.error) {
    await sendMessage(chatId, `❌ Wallet 1 not found: ${d1?.message || 'No data'}`);
    return;
  }
  if (!d2 || d2.error) {
    await sendMessage(chatId, `❌ Wallet 2 not found: ${d2?.message || 'No data'}`);
    return;
  }

  const name1 = d1.displayName?.split('-')[0] || d1.wallet.slice(0, 10);
  const name2 = d2.displayName?.split('-')[0] || d2.wallet.slice(0, 10);

  const dims = ['calibration', 'liveEdge', 'profitability', 'consistency', 'discipline', 'sampleSize'];
  const dimLabels: Record<string, string> = {
    calibration: 'Calibration', liveEdge: 'Live Edge', profitability: 'Profitability',
    consistency: 'Consistency', discipline: 'Discipline', sampleSize: 'Sample Size',
  };

  let comparison = '';
  for (const dim of dims) {
    const v1 = d1[dim] ?? '-';
    const v2 = d2[dim] ?? '-';
    const winner = typeof v1 === 'number' && typeof v2 === 'number'
      ? (v1 > v2 ? '◀' : v1 < v2 ? '▶' : '=')
      : ' ';
    comparison += `  ${dimLabels[dim]}: ${v1} ${winner} ${v2}\n`;
  }

  const msg = `
⚔️ <b>VIGIL Head-to-Head</b>

${gradeEmoji(d1.trustGrade)} <b>${name1}</b>: ${d1.trustGrade}/${d1.trustScore} — ${d1.trustTier}
${gradeEmoji(d2.trustGrade)} <b>${name2}</b>: ${d2.trustGrade}/${d2.trustScore} — ${d2.trustTier}

📊 <b>Dimension Comparison:</b>
<pre>${comparison}</pre>
💰 PnL: ${pnlStr(d1.raw?.totalPnl || 0)} vs ${pnlStr(d2.raw?.totalPnl || 0)}

🔗 <a href="${VIGIL_API}/polymarket/compare?w1=${d1.wallet}&w2=${d2.wallet}">Full Comparison</a>
  `.trim();

  await sendMessage(chatId, msg);
}

async function handleTop(chatId: number) {
  const res = await fetch(`${VIGIL_API}`);
  // Just link to the homepage since the leaderboard is there
  await sendMessage(chatId, `
🏆 <b>Polymarket Top 10 by PnL — VIGIL Scored</b>

7 of the top 10 most profitable Polymarket wallets score F on VIGIL.

PnL ≠ Skill. These leaderboards reward leverage and luck, not forecasting ability.

🔗 <a href="${VIGIL_API}">View Full Leaderboard</a>

💡 Score any wallet: <code>/score &lt;wallet&gt;</code>
  `.trim());
}

// ── Webhook handler (for Express integration) ───────────────────────

interface TelegramUpdate {
  message?: {
    chat: { id: number };
    text?: string;
  };
}

export async function handleWebhook(update: TelegramUpdate) {
  const msg = update.message;
  if (!msg?.text) return;

  const chatId = msg.chat.id;
  const text = msg.text.trim();

  if (text.startsWith('/start') || text.startsWith('/help')) {
    await handleStart(chatId);
  } else if (text.startsWith('/score')) {
    await handleScore(chatId, text.replace(/^\/score\s*/, ''));
  } else if (text.startsWith('/compare')) {
    await handleCompare(chatId, text.replace(/^\/compare\s*/, ''));
  } else if (text.startsWith('/top') || text.startsWith('/leaderboard')) {
    await handleTop(chatId);
  }
}

// ── Polling mode (for local dev without webhook) ────────────────────

async function pollUpdates() {
  console.log('[VIGIL Bot] Starting in polling mode...');
  let offset = 0;

  while (true) {
    try {
      const res = await fetch(`${TG_API}/getUpdates?offset=${offset}&timeout=30`);
      const data: any = await res.json();

      if (data.ok && data.result.length > 0) {
        for (const update of data.result) {
          offset = update.update_id + 1;
          await handleWebhook(update);
        }
      }
    } catch (e: any) {
      console.error('[VIGIL Bot] Poll error:', e.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────

export { setWebhook, deleteWebhook };

// If run directly, use polling mode
if (require.main === module) {
  deleteWebhook().then(() => pollUpdates());
}
