// VIGIL — Skill-Weighted Consensus
//
// For a given Polymarket market, aggregate the positions of every A/B/C/D
// wallet in the skill leaderboard and produce a *grade-weighted* implied
// probability. The result is the "what does the calibrated money think"
// signal that complements (and often diverges from) the market price.
//
// Math:
//   weight_i     = grade_weight × stake_weight × time_decay
//   P_consensus  = Σ(weight_i × impliedP_i) / Σ(weight_i)
//
//   grade_weight: A=1.0, B=0.6, C=0.25, D=0.05, F=0
//   stake_weight: sqrt(initialValue_i)     — dampens whale over-influence
//   time_decay  : exp(-days_since_entry/30) — 30-day half-life
//
// CI95 via 1000-resample bootstrap of (wallet_i, position_i) pairs.
// 5-min TTL cache keyed by conditionId.

import { fetchAllPositions, getSkillLeaderboard, type LeaderboardEntry, type PolymarketPosition } from './polymarket.js';
import { TTLCache } from './cache.js';

// ─── Weighting constants ───────────────────────────────────────────

/** Grade weights — multiplier on each wallet's contribution. */
export const GRADE_WEIGHTS: Record<string, number> = {
  A: 1.0,
  B: 0.6,
  C: 0.25,
  D: 0.05,
  F: 0.0,
};

const DECAY_HALF_LIFE_DAYS = 30;

/** Minimum effective sample size (sum of grade weights) to surface consensus. */
const MIN_EFFECTIVE_SAMPLE = 1.0;

/** Minimum number of distinct contributing wallets. */
const MIN_WALLETS = 5;

// ─── Types ─────────────────────────────────────────────────────────

export interface ConsensusContributor {
  wallet: string;
  displayName: string;
  grade: string;
  trustScore: number;
  outcome: 'Yes' | 'No';
  size: number;            // shares held
  avgPrice: number;        // 0-1 on their side
  initialValue: number;    // USDC put in
  daysSinceEntry: number;  // estimate from position.endDate is not entry, so we use a heuristic
  impliedPYes: number;     // their revealed P(Yes)
  weight: number;          // grade × stake × decay
}

export interface SkillConsensus {
  marketId: string;
  marketTitle: string;
  marketSlug: string;
  impliedMarketP: number | null;      // current market price (Yes)
  consensusP: number;                 // weighted P(Yes)
  divergence: number;                 // consensusP - impliedMarketP (null-safe: 0 if market price missing)
  divergenceDirection: 'market_overpriced' | 'market_underpriced' | 'aligned' | 'unknown';
  contributingWallets: {
    total: number;
    A: number;
    B: number;
    C: number;
    D: number;
    F: number;
  };
  gradeWeights: typeof GRADE_WEIGHTS;
  effectiveSampleSize: number;        // Σ(weight_i) — weighted-equivalent wallets
  ci95: { low: number; high: number };
  totalSkillStake: number;            // total USDC across contributing wallets
  topContributors: ConsensusContributor[];  // top 10 by weight, for UI
  asOf: string;
  notes: string[];
  dataQuality: 'strong' | 'moderate' | 'weak' | 'insufficient';
}

export interface ConsensusError {
  error: 'INSUFFICIENT_DATA' | 'MARKET_NOT_FOUND' | 'UPSTREAM_ERROR';
  message: string;
  contributingWallets?: number;
  effectiveSampleSize?: number;
}

// ─── Cache ─────────────────────────────────────────────────────────

const consensusCache = new TTLCache<SkillConsensus>(300); // 5 min
const positionByWalletCache = new TTLCache<PolymarketPosition[]>(300); // 5 min, per wallet

// ─── Helpers ───────────────────────────────────────────────────────

/**
 * Derive a per-wallet implied P(Yes) from a position.
 *   - A Yes holder bought at avgPrice → revealed P(Yes) ≈ avgPrice
 *   - A No holder bought No at avgPrice → revealed P(Yes) ≈ 1 - avgPrice
 * avgPrice already reflects the trader's entry belief in their chosen side.
 */
function impliedPYesFromPosition(p: PolymarketPosition): number {
  if (p.outcomeIndex === 0) return clamp(p.avgPrice, 0.001, 0.999);       // Yes side
  return clamp(1 - p.avgPrice, 0.001, 0.999);                             // No side
}

function clamp(x: number, lo: number, hi: number): number {
  if (!Number.isFinite(x)) return (lo + hi) / 2;
  return Math.max(lo, Math.min(hi, x));
}

/**
 * Heuristic days-since-entry. Polymarket position objects don't expose entry
 * timestamp, so we derive from endDate (market close) minus a reasonable
 * holding period. For open markets this understates the decay; for resolved
 * markets it's tighter. Acceptable for weighting — not a load-bearing number.
 *
 * TODO v1.22: cross-reference trades list to compute true first-entry date.
 */
function daysSinceEntryHeuristic(p: PolymarketPosition): number {
  // If we can't parse, assume mid-term (14 days)
  const endMs = Date.parse(p.endDate || '');
  if (!Number.isFinite(endMs)) return 14;
  const daysToClose = (endMs - Date.now()) / 86_400_000;
  // Assume trader entered 2 weeks ago if market still has >2 weeks left;
  // otherwise, entered at roughly the halfway point.
  if (daysToClose > 14) return 14;
  if (daysToClose < 0) return Math.min(90, 14 + Math.abs(daysToClose));
  return Math.max(1, 14 - daysToClose);
}

/** Exponential decay with 30-day half-life. */
function timeDecay(daysSinceEntry: number): number {
  return Math.pow(0.5, daysSinceEntry / DECAY_HALF_LIFE_DAYS);
}

/** Weighted mean. */
function weightedMean(values: number[], weights: number[]): number {
  let num = 0, den = 0;
  for (let i = 0; i < values.length; i++) {
    num += values[i] * weights[i];
    den += weights[i];
  }
  return den > 0 ? num / den : 0;
}

/** Bootstrap 95% CI on the weighted mean. */
function bootstrapCI95(values: number[], weights: number[], iterations = 1000): { low: number; high: number } {
  if (values.length === 0) return { low: 0, high: 0 };
  const n = values.length;
  const samples: number[] = new Array(iterations);
  for (let it = 0; it < iterations; it++) {
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(Math.random() * n);
      num += values[idx] * weights[idx];
      den += weights[idx];
    }
    samples[it] = den > 0 ? num / den : 0;
  }
  samples.sort((a, b) => a - b);
  return {
    low: samples[Math.floor(iterations * 0.025)],
    high: samples[Math.floor(iterations * 0.975)],
  };
}

// ─── Market metadata ───────────────────────────────────────────────

const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const CLOB_BASE = 'https://clob.polymarket.com';
const DATA_BASE = 'https://data-api.polymarket.com';
const USER_AGENT = 'VIGIL-Trust/1.21.0 (vigilscore.xyz; skill-consensus)';

interface MarketMeta {
  conditionId: string;
  question: string;
  slug: string;
  closed: boolean;
  lastTradePriceYes: number | null;
}

async function fetchMarketMeta(conditionId: string): Promise<MarketMeta | null> {
  // Try Gamma first — richer metadata (title, slug, outcomePrices)
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(`${GAMMA_BASE}/markets?condition_ids=${conditionId}`, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (res.ok) {
      const arr = await res.json();
      const m = Array.isArray(arr) && arr.length > 0 ? arr[0] : null;
      if (m) {
        // outcomePrices is a stringified array like "[\"0.62\",\"0.38\"]"
        let yesPrice: number | null = null;
        try {
          const op = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices;
          if (Array.isArray(op) && op.length > 0) yesPrice = Number(op[0]);
        } catch {
          yesPrice = null;
        }
        return {
          conditionId,
          question: m.question || m.title || '',
          slug: m.slug || '',
          closed: m.closed === true,
          lastTradePriceYes: Number.isFinite(yesPrice as number) ? (yesPrice as number) : null,
        };
      }
    }
  } catch {
    // fall through to CLOB
  }

  // CLOB fallback — strips price info but gives question/slug
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(`${CLOB_BASE}/markets/${conditionId}`, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const m = await res.json();
    const tokens = Array.isArray(m?.tokens) ? m.tokens : [];
    const yesToken = tokens.find((t: any) => String(t.outcome).toLowerCase() === 'yes');
    const yesPrice = yesToken && Number.isFinite(Number(yesToken.price)) ? Number(yesToken.price) : null;
    return {
      conditionId,
      question: m?.question || '',
      slug: m?.market_slug || '',
      closed: m?.closed === true,
      lastTradePriceYes: yesPrice,
    };
  } catch {
    return null;
  }
}

// ─── Position fetching (per wallet, cached 5 min) ──────────────────

async function fetchPositionsForWalletCached(wallet: string): Promise<PolymarketPosition[]> {
  const key = wallet.toLowerCase();
  const cached = positionByWalletCache.get(key);
  if (cached) return cached;
  try {
    const positions = await fetchAllPositions(wallet);
    positionByWalletCache.set(key, positions);
    return positions;
  } catch {
    // Swallow per-wallet errors — one bad wallet shouldn't kill the whole computation
    return [];
  }
}

/**
 * Run a bounded-concurrency map. Keeps at most `limit` promises in flight.
 */
async function pMap<T, R>(items: T[], fn: (item: T, idx: number) => Promise<R>, limit = 20): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ─── Main computation ─────────────────────────────────────────────

export async function computeSkillConsensus(conditionId: string): Promise<SkillConsensus | ConsensusError> {
  const cached = consensusCache.get(conditionId);
  if (cached) return cached;

  const leaderboard = getSkillLeaderboard();
  if (leaderboard.length === 0) {
    return {
      error: 'INSUFFICIENT_DATA',
      message: 'Skill leaderboard is empty. Run /v1/polymarket/discover/crawl first.',
    };
  }

  // Kick off metadata + positions in parallel
  const [meta, walletPositions] = await Promise.all([
    fetchMarketMeta(conditionId),
    pMap(leaderboard, async (entry: LeaderboardEntry) => {
      const positions = await fetchPositionsForWalletCached(entry.wallet);
      const onMarket = positions.find(p => p.conditionId === conditionId);
      return { entry, position: onMarket };
    }, 20),
  ]);

  if (!meta) {
    return {
      error: 'MARKET_NOT_FOUND',
      message: `No Polymarket market found with conditionId ${conditionId}.`,
    };
  }

  // Filter to wallets with a position on this market and non-zero grade weight
  const contributors: ConsensusContributor[] = [];
  for (const { entry, position } of walletPositions) {
    if (!position || position.size <= 0) continue;
    const gradeWeight = GRADE_WEIGHTS[entry.trustGrade] ?? 0;
    if (gradeWeight <= 0) continue;

    const daysSinceEntry = daysSinceEntryHeuristic(position);
    const stakeWeight = Math.sqrt(Math.max(1, position.initialValue || 0));
    const decay = timeDecay(daysSinceEntry);
    const weight = gradeWeight * stakeWeight * decay;
    const impliedPYes = impliedPYesFromPosition(position);
    const outcome: 'Yes' | 'No' = position.outcomeIndex === 0 ? 'Yes' : 'No';

    contributors.push({
      wallet: entry.wallet,
      displayName: entry.displayName,
      grade: entry.trustGrade,
      trustScore: entry.trustScore,
      outcome,
      size: position.size,
      avgPrice: position.avgPrice,
      initialValue: position.initialValue,
      daysSinceEntry,
      impliedPYes,
      weight,
    });
  }

  const effectiveSampleSize = contributors.reduce((a, c) => a + c.weight / Math.max(1, Math.sqrt(c.initialValue || 1)), 0);
  // ESS in "effective wallets" — strip stake weight, keep grade × decay
  const gradeDecayWeights = contributors.map(c => GRADE_WEIGHTS[c.grade] * timeDecay(c.daysSinceEntry));
  const effectiveWalletCount = gradeDecayWeights.reduce((a, b) => a + b, 0);

  if (contributors.length < MIN_WALLETS || effectiveWalletCount < MIN_EFFECTIVE_SAMPLE) {
    return {
      error: 'INSUFFICIENT_DATA',
      message: `Only ${contributors.length} graded wallet(s) hold positions in this market (effective weight ${effectiveWalletCount.toFixed(2)}). Need ≥${MIN_WALLETS} wallets and effective weight ≥${MIN_EFFECTIVE_SAMPLE}.`,
      contributingWallets: contributors.length,
      effectiveSampleSize: effectiveWalletCount,
    };
  }

  const values = contributors.map(c => c.impliedPYes);
  const weights = contributors.map(c => c.weight);
  const consensusP = weightedMean(values, weights);
  const ci95 = bootstrapCI95(values, weights, 1000);

  const impliedMarketP = meta.lastTradePriceYes;
  const divergence = impliedMarketP != null ? consensusP - impliedMarketP : 0;
  const divergenceDirection: SkillConsensus['divergenceDirection'] =
    impliedMarketP == null
      ? 'unknown'
      : Math.abs(divergence) < 0.03
      ? 'aligned'
      : divergence > 0
      ? 'market_underpriced' // consensus > market ⇒ skilled money thinks Yes is more likely than market says
      : 'market_overpriced';

  const contribBuckets = { total: contributors.length, A: 0, B: 0, C: 0, D: 0, F: 0 };
  for (const c of contributors) {
    contribBuckets[c.grade as keyof typeof contribBuckets] = (contribBuckets[c.grade as keyof typeof contribBuckets] ?? 0) + 1;
  }

  const topContributors = [...contributors].sort((a, b) => b.weight - a.weight).slice(0, 10);
  const totalSkillStake = contributors.reduce((a, c) => a + (c.initialValue || 0), 0);

  // Data-quality tier based on effective wallet count
  let dataQuality: SkillConsensus['dataQuality'] = 'insufficient';
  if (effectiveWalletCount >= 10) dataQuality = 'strong';
  else if (effectiveWalletCount >= 5) dataQuality = 'moderate';
  else if (effectiveWalletCount >= MIN_EFFECTIVE_SAMPLE) dataQuality = 'weak';

  const notes: string[] = [];
  if (meta.closed) notes.push('Market is closed — consensus reflects positions at/before close.');
  if (contribBuckets.A + contribBuckets.B === 0) notes.push('No A or B grade wallets in this market — consensus driven by C/D grades.');
  if (contributors.some(c => c.initialValue > 50_000)) notes.push('Whale positions present — stake weight uses sqrt(USDC) to dampen over-influence.');

  const result: SkillConsensus = {
    marketId: conditionId,
    marketTitle: meta.question,
    marketSlug: meta.slug,
    impliedMarketP,
    consensusP,
    divergence,
    divergenceDirection,
    contributingWallets: contribBuckets,
    gradeWeights: GRADE_WEIGHTS,
    effectiveSampleSize: effectiveWalletCount,
    ci95,
    totalSkillStake,
    topContributors,
    asOf: new Date().toISOString(),
    notes,
    dataQuality,
  };

  consensusCache.set(conditionId, result);
  return result;
}

// ─── Pre-warm (optional cron) ─────────────────────────────────────

/**
 * Resolve a market slug → conditionId via Gamma. Used by landing page
 * to accept human-readable URLs in addition to raw conditionIds.
 */
export async function resolveMarketSlug(slug: string): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(`${GAMMA_BASE}/markets?slug=${encodeURIComponent(slug)}`, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const arr = await res.json();
    if (Array.isArray(arr) && arr.length > 0 && arr[0].conditionId) return arr[0].conditionId as string;
    return null;
  } catch {
    return null;
  }
}

// Expose cache stats so /healthz can report warm vs cold
export function getConsensusCacheStats() {
  return {
    consensusEntries: consensusCache.size,
    walletPositionEntries: positionByWalletCache.size,
  };
}
