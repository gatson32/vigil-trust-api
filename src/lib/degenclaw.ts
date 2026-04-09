/**
 * VIGIL × DegenClaw — Risk Scoring Adapter
 *
 * Pulls live data from the DegenClaw Arena leaderboard and trader API,
 * computes a VIGIL-native risk score for each agent trading Hyperliquid
 * perps, and exposes it as both HTTP JSON and a public score card.
 *
 * Angle: DegenClaw's own AI Council ranks agents by expected return
 * (composite score). VIGIL ranks them by downside risk — "will this
 * agent blow up?" Different product, different buyer (backers vs. grants).
 *
 * Data sources:
 *   - https://degen.virtuals.io/api/leaderboard   (public, no auth)
 *   - https://dgclaw-trader.virtuals.io/users/:w  (public, no auth)
 *   - https://acpx.virtuals.io/api/agents/:id     (public, no auth)
 */

import { TTLCache } from './cache.js';

// ============================================================
//  CONSTANTS
// ============================================================

const LEADERBOARD_URL = 'https://degen.virtuals.io/api/leaderboard';
const TRADER_BASE = 'https://dgclaw-trader.virtuals.io';
const ACP_BASE = 'https://acpx.virtuals.io/api/agents';
const USER_AGENT = 'VIGIL-Trust-Score/1.7 (+https://vigil.trust)';

// Cache the whole leaderboard for 60s — we're ok being up to 1 min stale
const leaderboardCache = new TTLCache<DegenClawAgent[]>(60);
const LEADERBOARD_CACHE_KEY = 'degenclaw_leaderboard_v1';

// ============================================================
//  TYPES
// ============================================================

export interface DegenClawAgent {
  id: string;
  name: string;
  tokenSymbol: string | null;
  agentAddress: string; // Hyperliquid trading wallet (EVM)
  subscriptionPrice?: number;
  performance: {
    totalRealizedPnl: number;
    perpRealizedPnl: number;
    spotRealizedPnl: number;
    avgRoe: number;
    winRate: number;       // 0-1
    profitFactor: number;
    sortinoRatio: number;
    compositeScore: number;
    rank: number;
    totalTradeCount: number;
    winCount: number;
    lossCount: number;
    totalTradeVolume: number;
    closedPositionCount: number;
    qualified?: boolean;
  };
  acpAgent?: {
    walletAddress: string;
    id?: string | number;
  };
}

export interface DegenClawAccount {
  balance: number;
  withdrawable: number;
  marginUsed: number;
}

export interface DegenClawPosition {
  asset: string;
  size: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  leverage: number;
  liquidationPrice: number | null;
  side: 'LONG' | 'SHORT';
}

export interface DegenClawTrade {
  timestamp: number;
  asset: string;
  side: 'BUY' | 'SELL';
  size: number;
  price: number;
  fee: number;
  closedPnl: number | null;
  leverage: number | null;
}

// ============================================================
//  VIGIL RISK SCORE OUTPUT
// ============================================================

export interface DegenClawRiskReport {
  // Identity
  agentId: string;
  agentName: string;
  tokenSymbol: string | null;
  wallet: string;
  leaderboardRank: number;

  // Raw numbers (for transparency)
  raw: {
    totalRealizedPnl: number;
    avgRoe: number;
    winRate: number;
    profitFactor: number;
    sortinoRatio: number;
    totalTradeCount: number;
    totalTradeVolume: number;
  };

  // Computed VIGIL dimensions (each 0-100)
  profitability: number;  // raw PnL + ROE performance
  consistency: number;    // how stable the returns are
  discipline: number;     // win rate + profit factor health
  capitalRisk: number;    // 100 = safe, 0 = likely to blow up
  sampleSize: number;     // 100 = long track record, 0 = barely traded

  // Composite score — VIGIL's headline number
  trustScore: number;  // 0-100
  trustGrade: 'A' | 'B' | 'C' | 'D' | 'F';
  trustTier: 'SHARP' | 'SOLID' | 'DEVELOPING' | 'RISKY' | 'DANGER' | 'UNPROVEN';

  // Human-readable reasoning
  reasoning: string[];
  flags: string[];
  greenFlags: string[];

  // Meta
  scoredAt: string;
  dataSource: 'degenclaw-leaderboard-v1';
  disclaimer: string;
}

// ============================================================
//  FETCHERS
// ============================================================

async function fetchJson<T>(url: string, timeoutMs = 8000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ${url}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch the full DegenClaw leaderboard (top 1000). Cached 60s.
 */
export async function fetchLeaderboard(): Promise<DegenClawAgent[]> {
  const cached = leaderboardCache.get(LEADERBOARD_CACHE_KEY);
  if (cached) return cached;

  const res = await fetchJson<{ data: DegenClawAgent[] }>(
    `${LEADERBOARD_URL}?limit=1000`,
  );
  const agents = Array.isArray(res?.data) ? res.data : [];
  leaderboardCache.set(LEADERBOARD_CACHE_KEY, agents);
  return agents;
}

/**
 * Find a DegenClaw agent by name (case-insensitive), id, or wallet address.
 */
export async function findAgent(query: string): Promise<DegenClawAgent | null> {
  if (!query) return null;
  const agents = await fetchLeaderboard();
  const q = query.trim().toLowerCase();

  // Exact match on wallet address
  if (q.startsWith('0x') && q.length === 42) {
    const byWallet = agents.find(
      (a) => (a.agentAddress || '').toLowerCase() === q,
    );
    if (byWallet) return byWallet;
  }

  // Exact id match
  const byId = agents.find((a) => String(a.id) === q);
  if (byId) return byId;

  // Case-insensitive name match
  const byName = agents.find((a) => (a.name || '').toLowerCase() === q);
  if (byName) return byName;

  // Prefix match on name (helpful for partial URL pastes)
  const byPrefix = agents.find((a) => (a.name || '').toLowerCase().startsWith(q));
  if (byPrefix) return byPrefix;

  return null;
}

/**
 * Fetch live account state for a DegenClaw wallet.
 * Used for deeper scoring / open position analysis.
 */
export async function fetchAccount(wallet: string): Promise<DegenClawAccount | null> {
  try {
    const raw = await fetchJson<Record<string, unknown>>(
      `${TRADER_BASE}/users/${wallet}/account`,
    );
    return {
      balance: Number(raw?.balance ?? 0),
      withdrawable: Number(raw?.withdrawable ?? 0),
      marginUsed: Number(raw?.marginUsed ?? 0),
    };
  } catch {
    return null;
  }
}

/**
 * Fetch open positions for a DegenClaw wallet.
 */
export async function fetchPositions(wallet: string): Promise<DegenClawPosition[]> {
  try {
    const raw = await fetchJson<{ data?: DegenClawPosition[] }>(
      `${TRADER_BASE}/users/${wallet}/positions`,
    );
    return Array.isArray(raw?.data) ? raw.data : [];
  } catch {
    return [];
  }
}

// ============================================================
//  SCORING
// ============================================================

/** Clamp to 0..100 integer */
function clamp100(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Compute a VIGIL risk score for a DegenClaw agent from leaderboard data.
 *
 * Dimensions (each 0-100, higher = better):
 *   - profitability    : raw PnL + ROE. Rewards winners.
 *   - consistency      : Sortino ratio + stability of returns.
 *   - discipline       : win rate + profit factor. Rewards process.
 *   - capitalRisk      : 100 = safe, 0 = likely to blow up.
 *                         Based on loss chain exposure, ROE tail, trade frequency.
 *   - sampleSize       : 100 = long track record, 0 = barely traded.
 *
 * Trust score = weighted blend with a STRONG penalty for low sample size.
 * We refuse to issue a confident grade on fewer than 10 closed trades.
 */
export function scoreDegenClawAgent(agent: DegenClawAgent): DegenClawRiskReport {
  const perf = agent.performance || ({} as DegenClawAgent['performance']);
  const totalPnl = Number(perf.totalRealizedPnl ?? 0);
  const avgRoe = Number(perf.avgRoe ?? 0);
  const winRate = Number(perf.winRate ?? 0);
  const profitFactor = Number(perf.profitFactor ?? 0);
  // Clamp Sortino — DegenClaw's upstream sometimes returns pathological
  // values (e.g. 11M) when downside deviation approaches zero on very
  // small samples. Cap at +/-8 for scoring math; also keep the raw value.
  const rawSortino = Number(perf.sortinoRatio ?? 0);
  const sortino = !Number.isFinite(rawSortino) ? 0 : Math.max(-8, Math.min(8, rawSortino));
  const totalTrades = Number(perf.totalTradeCount ?? perf.closedPositionCount ?? 0);
  const volume = Number(perf.totalTradeVolume ?? 0);
  const wins = Number(perf.winCount ?? 0);
  const losses = Number(perf.lossCount ?? 0);
  const qualified = perf.qualified !== false; // default true if missing

  const reasoning: string[] = [];
  const flags: string[] = [];
  const greenFlags: string[] = [];

  // --- 1. Profitability (0-100) ---
  // Tanh-flavored mapping: $0 PnL ~= 40, heavy winners 80+, losers 0-30
  // ROE bonus: +20 if avgRoe > 0.5, penalty if avgRoe < -0.3
  let profitability = 50;
  if (totalPnl > 0) {
    profitability += Math.min(40, Math.log10(1 + totalPnl) * 15);
  } else if (totalPnl < 0) {
    profitability -= Math.min(45, Math.log10(1 + Math.abs(totalPnl)) * 15);
  }
  if (avgRoe > 0.5) profitability += 15;
  else if (avgRoe > 0.2) profitability += 8;
  else if (avgRoe < -0.3) profitability -= 20;
  else if (avgRoe < 0) profitability -= 10;
  profitability = clamp100(profitability);

  if (totalPnl > 1000) greenFlags.push(`Net profitable: +$${totalPnl.toFixed(0)} realized`);
  else if (totalPnl < -500) flags.push(`Net loss: -$${Math.abs(totalPnl).toFixed(0)} realized`);

  // --- 2. Consistency (Sortino-driven, 0-100) ---
  // Sortino > 2 = excellent, 1-2 = good, 0-1 = mediocre, <0 = bad
  let consistency = 50;
  if (sortino >= 2) { consistency = 92; greenFlags.push(`Strong Sortino: ${sortino.toFixed(2)}`); }
  else if (sortino >= 1) consistency = 78;
  else if (sortino >= 0.3) consistency = 60;
  else if (sortino >= 0) consistency = 42;
  else if (sortino >= -0.5) { consistency = 25; flags.push(`Negative Sortino: ${sortino.toFixed(2)}`); }
  else { consistency = 10; flags.push(`Severe downside: Sortino ${sortino.toFixed(2)}`); }

  // --- 3. Discipline (win rate + profit factor) ---
  let discipline = 0;
  discipline += Math.min(50, winRate * 100 * 0.6); // win rate contributes up to ~50
  if (profitFactor >= 2) { discipline += 50; greenFlags.push(`Profit factor ${profitFactor.toFixed(2)}`); }
  else if (profitFactor >= 1.5) discipline += 38;
  else if (profitFactor >= 1.2) discipline += 28;
  else if (profitFactor >= 1) discipline += 18;
  else if (profitFactor > 0) discipline += 5;
  discipline = clamp100(discipline);

  if (winRate < 0.3 && totalTrades >= 10) flags.push(`Low win rate: ${(winRate * 100).toFixed(0)}%`);
  if (profitFactor > 0 && profitFactor < 1 && totalTrades >= 10) flags.push(`Profit factor below 1.0 (losing more than winning)`);

  // --- 4. Capital risk (100 = safe, 0 = danger) ---
  // Heuristics (no live tape yet — v1 works from leaderboard stats only):
  //   - Negative Sortino + negative PnL = big red flag
  //   - Very low trade count + big PnL swings = luck, not skill
  //   - Loss streak implied by (losses >> wins) + negative ROE
  let capitalRisk = 65;
  if (sortino < 0 && totalPnl < 0) { capitalRisk -= 30; flags.push('Consistent losses with negative risk-adjusted returns'); }
  if (avgRoe < -0.5) { capitalRisk -= 25; flags.push(`Severe ROE decay: ${(avgRoe * 100).toFixed(0)}%`); }
  if (losses > wins * 3 && totalTrades >= 15) { capitalRisk -= 15; flags.push(`Loss ratio: ${losses} losses vs ${wins} wins`); }
  if (sortino > 1.5 && avgRoe > 0.1) { capitalRisk += 20; greenFlags.push('Positive risk-adjusted returns'); }
  if (profitFactor > 1.5) capitalRisk += 10;
  capitalRisk = clamp100(capitalRisk);

  // --- 5. Sample size ---
  // <10 trades = unproven, 10-50 = developing, 50-200 = meaningful, 200+ = robust
  let sampleSize = 0;
  if (totalTrades >= 200) sampleSize = 100;
  else if (totalTrades >= 100) sampleSize = 92;
  else if (totalTrades >= 50) sampleSize = 80;
  else if (totalTrades >= 20) sampleSize = 65;
  else if (totalTrades >= 10) sampleSize = 45;
  else if (totalTrades >= 5) sampleSize = 20;
  else sampleSize = 5;

  if (totalTrades < 10) flags.push(`Unproven: only ${totalTrades} closed trades`);
  if (totalTrades >= 100) greenFlags.push(`Robust sample: ${totalTrades} closed trades`);

  // --- Composite trust score ---
  // Low sample size gates the max score — an agent with 3 trades can't
  // be rated as SHARP no matter how good its numbers look.
  const rawScore =
    profitability * 0.22 +
    consistency * 0.25 +
    discipline * 0.18 +
    capitalRisk * 0.25 +
    sampleSize * 0.10;

  // Sample-size gate: softer than v1. 45 sample → 0.75 gate, 100 → 1.0
  const sampleGate = Math.min(1, (sampleSize + 30) / 100);
  let trustScore = clamp100(rawScore * sampleGate + 20 * (1 - sampleGate));

  // UNPROVEN agents (<10 trades) get a ceiling — at most "RISKY"
  if (totalTrades < 10) trustScore = Math.min(trustScore, 50);
  // Very thin samples (<5) get capped at UNPROVEN
  if (totalTrades < 5) trustScore = Math.min(trustScore, 35);

  // Grade + tier
  let trustGrade: DegenClawRiskReport['trustGrade'];
  let trustTier: DegenClawRiskReport['trustTier'];
  if (totalTrades < 5) { trustGrade = 'F'; trustTier = 'UNPROVEN'; }
  else if (trustScore >= 85) { trustGrade = 'A'; trustTier = 'SHARP'; }
  else if (trustScore >= 72) { trustGrade = 'B'; trustTier = 'SOLID'; }
  else if (trustScore >= 58) { trustGrade = 'C'; trustTier = 'DEVELOPING'; }
  else if (trustScore >= 42) { trustGrade = 'D'; trustTier = 'RISKY'; }
  else { trustGrade = 'F'; trustTier = 'DANGER'; }

  // Headline reasoning
  reasoning.push(
    `${agent.name} sits at rank #${perf.rank ?? '?'} with $${totalPnl.toFixed(0)} realized PnL across ${totalTrades} closed trades.`,
  );
  reasoning.push(
    `Win rate ${(winRate * 100).toFixed(0)}%, profit factor ${profitFactor.toFixed(2)}, Sortino ${sortino.toFixed(2)}, avg ROE ${(avgRoe * 100).toFixed(0)}%.`,
  );
  if (trustTier === 'SHARP') {
    reasoning.push(`VIGIL rates this agent as SHARP — strong risk-adjusted returns on a robust sample.`);
  } else if (trustTier === 'SOLID') {
    reasoning.push(`VIGIL rates this agent as SOLID — the process is working.`);
  } else if (trustTier === 'DEVELOPING') {
    reasoning.push(`VIGIL rates this agent as DEVELOPING — mixed signals, more data needed.`);
  } else if (trustTier === 'RISKY') {
    reasoning.push(`VIGIL rates this agent as RISKY — capital at elevated risk given current metrics.`);
  } else if (trustTier === 'DANGER') {
    reasoning.push(`VIGIL rates this agent as DANGER — metrics suggest a high probability of further losses.`);
  } else if (trustTier === 'UNPROVEN') {
    reasoning.push(`VIGIL cannot rate this agent — fewer than 5 closed trades. Check back after more history accumulates.`);
  }

  return {
    agentId: String(agent.id),
    agentName: agent.name,
    tokenSymbol: agent.tokenSymbol ?? null,
    wallet: agent.agentAddress,
    leaderboardRank: Number(perf.rank ?? 0),
    raw: {
      totalRealizedPnl: totalPnl,
      avgRoe,
      winRate,
      profitFactor,
      // Raw (unclamped) Sortino for transparency. Scoring math uses a clamped version.
      sortinoRatio: Number.isFinite(rawSortino) ? rawSortino : 0,
      totalTradeCount: totalTrades,
      totalTradeVolume: volume,
    },
    profitability,
    consistency,
    discipline,
    capitalRisk,
    sampleSize,
    trustScore,
    trustGrade,
    trustTier,
    reasoning,
    flags,
    greenFlags,
    scoredAt: new Date().toISOString(),
    dataSource: 'degenclaw-leaderboard-v1',
    disclaimer:
      'VIGIL Trust Score is informational only — not investment advice, ' +
      'not a recommendation to subscribe, not a guarantee of future performance. ' +
      'Computed from public DegenClaw leaderboard data. See vigil.trust/methodology.',
  };
}

/**
 * One-shot: resolve query → agent → score. Used by the HTTP endpoint.
 */
export async function scoreByQuery(query: string): Promise<DegenClawRiskReport | null> {
  const agent = await findAgent(query);
  if (!agent) return null;
  return scoreDegenClawAgent(agent);
}

/**
 * Score every agent on the leaderboard. Used by the bulk endpoint
 * and by launch tweet generation.
 */
export async function scoreAllAgents(): Promise<DegenClawRiskReport[]> {
  const agents = await fetchLeaderboard();
  return agents.map(scoreDegenClawAgent);
}
