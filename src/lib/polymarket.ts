// VIGIL — Polymarket Prediction Market Adapter + Calibration Scoring
// The PROPRIETARY layer: calibration scoring measures genuine predictive
// skill vs. speed arb vs. luck. Nobody else computes this.
//
// Data sources:
//   data-api.polymarket.com  — trades, positions, activity per wallet
//   basescan (etherscan v2)  — on-chain verification layer

import { getWalletProvenance, isBasescanConfigured, CHAINS, type WalletProvenance } from './basescan.js';
import { query } from './db.js';

const USER_AGENT = 'VIGIL-Trust/1.18.0 (vigil.trust; prediction-market-scoring)';
const DATA_BASE = 'https://data-api.polymarket.com';

// ============================================================
//  TYPES
// ============================================================

export interface PolymarketTrade {
  proxyWallet: string;
  side: 'BUY' | 'SELL';
  asset: string;
  conditionId: string;
  size: number;         // shares
  price: number;        // 0-1 implied probability
  usdcSize?: number;
  timestamp: number;
  title: string;
  slug: string;
  outcome: string;
  outcomeIndex: number;
  name?: string;
  pseudonym?: string;
  transactionHash: string;
}

export interface PolymarketPosition {
  proxyWallet: string;
  asset: string;
  conditionId: string;
  size: number;
  avgPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  realizedPnl: number;
  percentRealizedPnl: number;
  curPrice: number;
  redeemable: boolean;
  title: string;
  slug: string;
  outcome: string;
  outcomeIndex: number;
  endDate: string;
}

/** A single calibration bucket (e.g. bets in the 0.60-0.70 range) */
export interface CalibrationBucket {
  range: string;           // "0.60-0.70"
  midpoint: number;        // 0.65
  totalBets: number;
  correctBets: number;
  actualRate: number;       // correctBets / totalBets
  expectedRate: number;     // midpoint
  error: number;            // |actualRate - expectedRate|
}

/** Full calibration analysis — the proprietary scoring layer */
export interface CalibrationReport {
  buckets: CalibrationBucket[];
  brierScore: number;         // lower is better (0 = perfect)
  calibrationError: number;   // mean absolute calibration error
  resolvedBets: number;       // total bets on resolved markets
  overconfidenceBias: number; // positive = overconfident
  skillDecomposition: {
    skill: number;            // calibration-weighted returns (0-100)
    luck: number;             // variance residual (0-100)
    edge: number;             // net alpha after removing luck
  };
  // === v1.16.0 UPGRADES — academic-grade metrics ===
  brierDecomposition: {
    calibration: number;      // Murphy (1973): lower is better — how far from perfect calibration
    resolution: number;       // higher is better — how far forecasts differ from base rate
    uncertainty: number;      // base rate uncertainty (constant for given dataset)
  };
  brierSkillScore: number;    // BSS = 1 - (BS / BS_climatology). 0 = no skill, 1 = perfect. Negative = worse than naive
  logLoss: number;            // logarithmic scoring rule — penalizes overconfidence on rare events more than Brier
  logLossSkill: number;       // 1 - (logLoss / naive_logLoss). Positive = better than naive
  timeliness: {
    avgDaysBeforeResolution: number;  // mean days between entry and market resolution
    earlyMoverPct: number;            // % of bets placed in first half of market lifetime
    timelinessScore: number;          // 0-100 score
  };
}

/** VIGIL trust report for a Polymarket trader */
export interface PolymarketRiskReport {
  // Identity
  wallet: string;
  displayName: string;
  pseudonym: string;

  // Raw numbers
  raw: {
    totalTrades: number;
    totalVolume: number;
    totalPnl: number;
    realizedPnl: number;
    unrealizedPnl: number;
    winRate: number;
    openPositions: number;
    resolvedBets: number;
    uniqueMarkets: number;
  };

  // VIGIL dimensions (0-100)
  calibration: number;      // PROPRIETARY: how well-calibrated (25%)
  profitability: number;    // risk-adjusted PnL (15%)
  consistency: number;      // return stability (15%)
  discipline: number;       // sizing + diversification (10%)
  sampleSize: number;       // resolved bet count (10%)
  liveEdge: number;         // unrealized position performance (25%)

  // Composite score
  trustScore: number;
  trustGrade: 'A' | 'B' | 'C' | 'D' | 'F';
  trustTier: 'SHARP' | 'SOLID' | 'DEVELOPING' | 'RISKY' | 'DANGER' | 'UNPROVEN';

  // Confidence intervals
  confidence: {
    level: 'high' | 'medium' | 'low' | 'very_low';
    margin: number;        // ± points
    resolvedBets: number;  // how many resolved bets the score is based on
    description: string;   // human-readable, e.g. "D/41 ± 3 (high confidence)"
  };

  // Calibration deep-dive (the secret sauce)
  calibrationReport: CalibrationReport;

  // Signals
  reasoning: string[];
  flags: string[];
  greenFlags: string[];

  // On-chain verification (from Basescan — null if API key not configured)
  onChain: {
    verified: boolean;
    provenance: WalletProvenance | null;
    pnlDivergence: number | null;   // difference between API-reported and on-chain PnL
    pnlVerified: boolean;
  } | null;

  // Meta
  scoredAt: string;
  dataSource: 'polymarket-v1';
  disclaimer: string;
}

// ============================================================
//  FETCHERS
// ============================================================

async function fetchJson<T>(url: string, timeoutMs = 12000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch all trades for a wallet. Paginates automatically.
 * Caps at 2000 trades to stay reasonable.
 */
export async function fetchTrades(wallet: string, maxTrades = 2000): Promise<PolymarketTrade[]> {
  const all: PolymarketTrade[] = [];
  let offset = 0;
  const limit = 100;

  while (all.length < maxTrades) {
    const batch = await fetchJson<PolymarketTrade[]>(
      `${DATA_BASE}/trades?user=${wallet}&limit=${limit}&offset=${offset}`,
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < limit) break;
    offset += limit;
  }

  return all.slice(0, maxTrades);
}

/**
 * Fetch current (open) positions for a wallet.
 */
export async function fetchPositions(wallet: string): Promise<PolymarketPosition[]> {
  const data = await fetchJson<PolymarketPosition[]>(
    `${DATA_BASE}/positions?user=${wallet}&limit=200`,
  );
  return Array.isArray(data) ? data : [];
}

/**
 * Fetch ALL positions (open + redeemed) for calibration.
 * Positions with curPrice > 0.95 or < 0.05 are effectively resolved.
 * This is far more reliable than cross-referencing the gamma API,
 * because it directly reflects the trader's actual bets and outcomes.
 */
export async function fetchAllPositions(wallet: string): Promise<PolymarketPosition[]> {
  const all: PolymarketPosition[] = [];

  for (const redeemed of ['true', 'false']) {
    let offset = 0;
    while (offset < 500) {
      const batch = await fetchJson<PolymarketPosition[]>(
        `${DATA_BASE}/positions?user=${wallet}&limit=100&offset=${offset}&redeemed=${redeemed}`,
      );
      if (!Array.isArray(batch) || batch.length === 0) break;
      all.push(...batch);
      if (batch.length < 100) break;
      offset += 100;
    }
  }

  return all;
}

// ============================================================
//  TRADE RESOLUTION ENGINE — reconstruct resolved bets from trades
//  When positions get purged from the API, trades remain. We look up
//  each market's resolution via the CLOB API to recover calibration data.
// ============================================================

const CLOB_BASE = 'https://clob.polymarket.com';

interface MarketResolution {
  conditionId: string;
  resolved: boolean;
  winningOutcome: string | null; // 'Yes' or 'No'
}

// Cache market resolutions — they never change once resolved
const marketResolutionCache = new Map<string, MarketResolution>();
const CACHE_MAX_SIZE = 5000;

async function fetchMarketResolution(conditionId: string): Promise<MarketResolution | null> {
  if (marketResolutionCache.has(conditionId)) return marketResolutionCache.get(conditionId)!;

  try {
    const data = await fetchJson<any>(`${CLOB_BASE}/markets/${conditionId}`, 5000);
    if (!data || !data.tokens) return null;

    const tokens = Array.isArray(data.tokens) ? data.tokens : [];
    const winner = tokens.find((t: any) => t.winner === true);
    const resolved = data.closed === true && winner != null;

    const result: MarketResolution = {
      conditionId,
      resolved,
      winningOutcome: resolved ? (winner.outcome || null) : null,
    };

    if (resolved) {
      // Enforce cache size limit — delete oldest entries if exceeding max
      if (marketResolutionCache.size >= CACHE_MAX_SIZE) {
        const firstKey = marketResolutionCache.keys().next().value;
        if (firstKey) marketResolutionCache.delete(firstKey);
      }
      marketResolutionCache.set(conditionId, result);
    }
    return result;
  } catch {
    return null;
  }
}

/**
 * Reconstruct resolved bets from trade history by looking up market outcomes.
 * For each unique conditionId in the trader's trades, check if the market resolved.
 * If it did, aggregate the trader's position and determine if they were correct.
 *
 * Caps at 100 market lookups to stay within rate limits.
 */
async function resolveTradesViaClob(trades: PolymarketTrade[]): Promise<ResolvedBet[]> {
  // Group trades by conditionId
  const tradesByMarket = new Map<string, PolymarketTrade[]>();
  for (const t of trades) {
    if (!t.conditionId) continue;
    const existing = tradesByMarket.get(t.conditionId) || [];
    existing.push(t);
    tradesByMarket.set(t.conditionId, existing);
  }

  // Look up resolution for each market (cap at 250 for depth vs rate limits)
  const conditionIds = [...tradesByMarket.keys()].slice(0, 250);
  const resolutions = await Promise.allSettled(
    conditionIds.map(id => fetchMarketResolution(id))
  );

  const resolvedBets: ResolvedBet[] = [];

  for (let i = 0; i < conditionIds.length; i++) {
    const res = resolutions[i];
    if (res.status !== 'fulfilled' || !res.value || !res.value.resolved) continue;

    const market = res.value;
    const marketTrades = tradesByMarket.get(conditionIds[i])!;

    // Track BUY and SELL separately per side (Yes/No)
    // BUY = opening/adding to position, SELL = closing/reducing position
    let yesBought = 0;   // total YES shares bought
    let yesSold = 0;      // total YES shares sold
    let yesBuyCost = 0;   // total USDC spent buying YES
    let noBought = 0;
    let noSold = 0;
    let noBuyCost = 0;

    for (const t of marketTrades) {
      const shares = t.size || 0;
      const cost = t.usdcSize || (shares * t.price);
      if (t.side === 'BUY') {
        if (t.outcome === 'Yes') { yesBought += shares; yesBuyCost += cost; }
        else { noBought += shares; noBuyCost += cost; }
      } else {
        if (t.outcome === 'Yes') { yesSold += shares; }
        else { noSold += shares; }
      }
    }

    // Net shares still held at resolution
    const yesNet = yesBought - yesSold;
    const noNet = noBought - noSold;

    // Skip if trader fully exited BOTH sides before resolution
    // They traded but didn't hold through — no calibration signal
    if (yesNet <= 0.01 && noNet <= 0.01) continue;

    // Determine which side they held
    // If they held both (hedged), use the larger side
    let traderSide: 'Yes' | 'No';
    let netShares: number;
    let avgEntryPrice: number;

    if (yesNet > noNet) {
      // Skip if no YES buys were made
      if (yesBought === 0) continue;
      traderSide = 'Yes';
      netShares = yesNet;
      // Average entry price = total buy cost / total bought (not net)
      // This represents their average conviction level
      avgEntryPrice = yesBuyCost / yesBought;
    } else {
      // Skip if no NO buys were made
      if (noBought === 0) continue;
      traderSide = 'No';
      netShares = noNet;
      avgEntryPrice = noBuyCost / noBought;
    }

    // FIX (v1.16.0): Implied probability must be corrected for NO bets.
    // A NO buyer paying $0.30 is expressing 70% confidence the event does NOT happen,
    // which equals 30% confidence that it DOES happen. For calibration we always
    // express probability in terms of the trader's chosen side winning.
    // YES buyer at $0.70 → impliedProb = 0.70 (they think YES wins 70%)
    // NO buyer at $0.30  → impliedProb = 0.70 (they think NO wins 70%, i.e. YES loses)
    const impliedProb = traderSide === 'Yes'
      ? Math.max(0.01, Math.min(0.99, avgEntryPrice))
      : Math.max(0.01, Math.min(0.99, 1 - avgEntryPrice));

    const correct = market.winningOutcome === traderSide;

    // Capture earliest trade timestamp for timeliness scoring
    const entryTimestamp = Math.min(...marketTrades.map(t => t.timestamp));

    // PnL: if correct, gained (1 - avgPrice) per share; if wrong, lost avgPrice
    const pnl = correct
      ? netShares * (1 - avgEntryPrice)
      : -netShares * avgEntryPrice;

    const side: 'BUY' | 'SELL' = 'BUY';

    resolvedBets.push({
      impliedProb,
      correct,
      pnl,
      size: netShares,
      side,
      entryTimestamp,
    });
  }

  return resolvedBets;
}

// ============================================================
//  CALIBRATION ENGINE — THE PROPRIETARY LAYER
//
//  When a trader buys YES at $0.70, they're implying a 70%
//  probability. If that event resolves YES, the bet was correct.
//  A perfectly calibrated trader's 70% bets resolve YES exactly
//  70% of the time. This measures genuine predictive intelligence
//  vs. speed arb vs. luck. Nobody else computes this.
// ============================================================

interface ResolvedBet {
  impliedProb: number;   // price they paid (their belief) — corrected for NO side
  correct: boolean;       // did the market resolve in their favor?
  pnl: number;           // what they made/lost
  size: number;           // position size in shares
  side: 'BUY' | 'SELL';   // whether this was a buy or sell position
  entryTimestamp?: number; // when they entered (earliest trade in this market)
  resolutionTimestamp?: number; // when market resolved (if known)
  marketCreatedAt?: number;    // when market was created (if known)
}

/**
 * Extract resolved bets from positions data.
 * A position is "resolved" when curPrice > 0.95 (outcome won) or < 0.05 (outcome lost).
 * avgPrice is the trader's implied probability — what they actually believed.
 * This is the PROPRIETARY insight: no gamma API cross-reference needed.
 */
function extractResolvedBetsFromPositions(
  allPositions: PolymarketPosition[],
): ResolvedBet[] {
  const bets: ResolvedBet[] = [];

  for (const p of allPositions) {
    const cur = p.curPrice ?? 0.5;

    // Only count clearly resolved positions
    if (cur <= 0.95 && cur >= 0.05) continue;

    const correct = cur > 0.95; // price near 1 = this outcome won
    const rawPrice = p.avgPrice;  // what they paid
    const size = p.size;

    // FIX (v1.16.0): Implied probability = confidence that THIS SIDE wins.
    // For outcome='Yes' at $0.70 → impliedProb = 0.70 (70% YES wins)
    // For outcome='No' at $0.30 → impliedProb = 0.70 (70% NO wins)
    // outcomeIndex: 0 = Yes, 1 = No (Polymarket standard)
    const isNoSide = p.outcomeIndex === 1 || p.outcome === 'No';
    const impliedProb = isNoSide
      ? Math.max(0.01, Math.min(0.99, 1 - rawPrice))
      : Math.max(0.01, Math.min(0.99, rawPrice));

    const side: 'BUY' | 'SELL' = rawPrice < 0.5 ? 'BUY' : 'SELL';

    const pnl = correct
      ? size * (1 - rawPrice)
      : size * (-rawPrice);

    bets.push({ impliedProb, correct, pnl, size, side });
  }

  return bets;
}

function computeCalibration(bets: ResolvedBet[]): CalibrationReport {
  const emptyTimeliness = { avgDaysBeforeResolution: 0, earlyMoverPct: 0, timelinessScore: 0 };
  const emptyDecomp = { calibration: 0, resolution: 0, uncertainty: 0 };

  if (bets.length === 0) {
    return {
      buckets: [],
      brierScore: 1,
      calibrationError: 1,
      resolvedBets: 0,
      overconfidenceBias: 0,
      skillDecomposition: { skill: 0, luck: 0, edge: 0 },
      brierDecomposition: emptyDecomp,
      brierSkillScore: -1,
      logLoss: 10,
      logLossSkill: -1,
      timeliness: emptyTimeliness,
    };
  }

  const N = bets.length;

  // ================================================================
  //  BRIER SCORE — Mean squared error (forecast vs outcome)
  // ================================================================
  let brierSum = 0;
  for (const b of bets) {
    const outcome = b.correct ? 1 : 0;
    brierSum += (b.impliedProb - outcome) ** 2;
  }
  const brierScore = brierSum / N;

  // ================================================================
  //  LOG LOSS — Logarithmic scoring rule (penalizes rare-event overconfidence)
  //  logLoss = -(1/N) * Σ [outcome * ln(p) + (1-outcome) * ln(1-p)]
  // ================================================================
  let logLossSum = 0;
  const LOG_CLAMP = 0.001; // prevent log(0)
  for (const b of bets) {
    const outcome = b.correct ? 1 : 0;
    const p = Math.max(LOG_CLAMP, Math.min(1 - LOG_CLAMP, b.impliedProb));
    logLossSum += outcome * Math.log(p) + (1 - outcome) * Math.log(1 - p);
  }
  const logLoss = -logLossSum / N;

  // ================================================================
  //  CALIBRATION BUCKETS — FIX: use mean forecast, not midpoint
  // ================================================================
  const bucketDefs = [
    { lo: 0.0, hi: 0.1, label: '0.00-0.10' },
    { lo: 0.1, hi: 0.2, label: '0.10-0.20' },
    { lo: 0.2, hi: 0.3, label: '0.20-0.30' },
    { lo: 0.3, hi: 0.4, label: '0.30-0.40' },
    { lo: 0.4, hi: 0.5, label: '0.40-0.50' },
    { lo: 0.5, hi: 0.6, label: '0.50-0.60' },
    { lo: 0.6, hi: 0.7, label: '0.60-0.70' },
    { lo: 0.7, hi: 0.8, label: '0.70-0.80' },
    { lo: 0.8, hi: 0.9, label: '0.80-0.90' },
    { lo: 0.9, hi: 1.01, label: '0.90-1.00' },
  ];

  const buckets: CalibrationBucket[] = [];
  let calErrorSum = 0;
  let calErrorCount = 0;
  let overconfidenceSum = 0;

  for (const def of bucketDefs) {
    const inBucket = bets.filter(b => b.impliedProb >= def.lo && b.impliedProb < def.hi);
    if (inBucket.length === 0) continue;

    const correctCount = inBucket.filter(b => b.correct).length;
    const actualRate = correctCount / inBucket.length;
    // FIX (v1.16.0): Use mean of actual forecast probabilities in this bucket,
    // not the bucket midpoint. This is the correct method per Gneiting et al.
    const meanForecast = inBucket.reduce((s, b) => s + b.impliedProb, 0) / inBucket.length;
    const error = Math.abs(actualRate - meanForecast);

    buckets.push({
      range: def.label,
      midpoint: meanForecast,  // now stores mean forecast, not midpoint
      totalBets: inBucket.length,
      correctBets: correctCount,
      actualRate,
      expectedRate: meanForecast,
      error,
    });

    calErrorSum += error * inBucket.length;
    calErrorCount += inBucket.length;
    overconfidenceSum += (meanForecast - actualRate) * inBucket.length;
  }

  const calibrationError = calErrorCount > 0 ? calErrorSum / calErrorCount : 1;
  const overconfidenceBias = calErrorCount > 0 ? overconfidenceSum / calErrorCount : 0;

  // ================================================================
  //  BRIER SCORE DECOMPOSITION — Murphy (1973)
  //  BS = Calibration - Resolution + Uncertainty
  //
  //  Calibration (REL): how far bucket outcomes deviate from bucket forecasts
  //  Resolution (RES): how far bucket outcomes deviate from the overall base rate
  //  Uncertainty (UNC): overall outcome variance = baseRate * (1 - baseRate)
  // ================================================================
  const baseRate = bets.filter(b => b.correct).length / N;
  const uncertainty = baseRate * (1 - baseRate);

  let calComponent = 0; // Reliability — lower is better
  let resComponent = 0; // Resolution — higher is better

  for (const bucket of buckets) {
    const nk = bucket.totalBets;
    const ok = bucket.actualRate;    // observed frequency in bucket
    const fk = bucket.expectedRate;  // mean forecast in bucket

    calComponent += (nk / N) * (fk - ok) ** 2;
    resComponent += (nk / N) * (ok - baseRate) ** 2;
  }

  // ================================================================
  //  BRIER SKILL SCORE — performance vs naive (always-predict-baseRate)
  //  BSS = 1 - BS / BS_climatology
  //  BS_climatology = baseRate * (1 - baseRate) = uncertainty
  // ================================================================
  const bs_climatology = uncertainty > 0 ? uncertainty : 0.25; // fallback if all same outcome
  const brierSkillScore = 1 - (brierScore / bs_climatology);

  // ================================================================
  //  LOG LOSS SKILL — performance vs naive log loss
  //  Naive log loss = -[baseRate * ln(baseRate) + (1-baseRate) * ln(1-baseRate)]
  // ================================================================
  const clampedBase = Math.max(LOG_CLAMP, Math.min(1 - LOG_CLAMP, baseRate));
  const naiveLogLoss = -(clampedBase * Math.log(clampedBase) + (1 - clampedBase) * Math.log(1 - clampedBase));
  const logLossSkill = naiveLogLoss > 0 ? 1 - (logLoss / naiveLogLoss) : 0;

  // ================================================================
  //  TIMELINESS — early mover scoring
  //  Measures how early traders enter relative to market resolution.
  //  Traders who forecast early demonstrate genuine foresight, not reactionary copying.
  // ================================================================
  const betsWithTimestamps = bets.filter(b => b.entryTimestamp && b.entryTimestamp > 0);
  let timeliness = emptyTimeliness;

  if (betsWithTimestamps.length >= 5) {
    // Approximate: use entry timestamps and current time as proxy for resolution
    // In production this would use actual market resolution timestamps
    const now = Date.now();
    const daysBefore: number[] = [];
    let earlyCount = 0;

    for (const b of betsWithTimestamps) {
      const entryMs = b.entryTimestamp! * (b.entryTimestamp! < 1e12 ? 1000 : 1); // handle s vs ms
      const resMs = b.resolutionTimestamp ? b.resolutionTimestamp * (b.resolutionTimestamp < 1e12 ? 1000 : 1) : now;
      const daysBeforeRes = Math.max(0, (resMs - entryMs) / 86_400_000);
      daysBefore.push(daysBeforeRes);

      // "Early mover" = entered in the first half of the market's lifetime
      if (b.marketCreatedAt) {
        const createdMs = b.marketCreatedAt * (b.marketCreatedAt < 1e12 ? 1000 : 1);
        const marketLifetime = resMs - createdMs;
        if (marketLifetime > 0 && (entryMs - createdMs) < marketLifetime * 0.5) {
          earlyCount++;
        }
      } else {
        // Without market creation time, consider >14 days before resolution as "early"
        if (daysBeforeRes > 14) earlyCount++;
      }
    }

    const avgDays = daysBefore.reduce((s, v) => s + v, 0) / daysBefore.length;
    const earlyPct = earlyCount / betsWithTimestamps.length;

    // Timeliness score: reward early entry. 30+ days avg = 100, 0 days = 0
    const timeScore = Math.max(0, Math.min(100,
      (Math.min(avgDays, 60) / 60) * 60 +  // 60% from avg days (capped at 60 days)
      earlyPct * 40                          // 40% from early mover percentage
    ));

    timeliness = {
      avgDaysBeforeResolution: Math.round(avgDays * 10) / 10,
      earlyMoverPct: Math.round(earlyPct * 1000) / 1000,
      timelinessScore: Math.round(timeScore),
    };
  }

  // ================================================================
  //  SKILL DECOMPOSITION — improved with Resolution data
  // ================================================================
  const totalPnl = bets.reduce((s, b) => s + b.pnl, 0);
  const totalStaked = bets.reduce((s, b) => {
    if (b.side === 'BUY') return s + b.size * b.impliedProb;
    return s + b.size * (1 - b.impliedProb);
  }, 0);
  const roi = totalStaked > 0 ? totalPnl / totalStaked : 0;

  // Skill: combines calibration quality + resolution (discrimination)
  // Resolution measures how much the trader deviates from base rate — i.e. do they
  // actually have opinions, or do they always bet ~50%?
  // Perfect calibration (error=0) + high resolution = genuine superforecaster
  const calSkill = Math.max(0, Math.min(100, (1 - calibrationError * 2) * 100));
  const resSkill = Math.max(0, Math.min(100, resComponent * 400)); // resolution scaled up
  const skill = calSkill * 0.6 + resSkill * 0.4; // 60% calibration, 40% resolution

  // Luck: coefficient of variation of per-bet returns
  const pnlValues = bets.map(b => b.pnl);
  const pnlMean = pnlValues.reduce((s, v) => s + v, 0) / pnlValues.length;
  const pnlVariance = pnlValues.reduce((s, v) => s + (v - pnlMean) ** 2, 0) / pnlValues.length;
  const pnlStdDev = Math.sqrt(pnlVariance);
  const luckRatio = pnlMean !== 0 ? Math.abs(pnlStdDev / pnlMean) : 10;
  const luck = Math.max(0, Math.min(100, luckRatio * 20));

  const edge = roi * 100;

  return {
    buckets,
    brierScore: Math.round(brierScore * 10000) / 10000,
    calibrationError: Math.round(calibrationError * 10000) / 10000,
    resolvedBets: bets.length,
    overconfidenceBias: Math.round(overconfidenceBias * 10000) / 10000,
    skillDecomposition: {
      skill: Math.round(skill * 10) / 10,
      luck: Math.round(luck * 10) / 10,
      edge: Math.round(edge * 100) / 100,
    },
    brierDecomposition: {
      calibration: Math.round(calComponent * 10000) / 10000,
      resolution: Math.round(resComponent * 10000) / 10000,
      uncertainty: Math.round(uncertainty * 10000) / 10000,
    },
    brierSkillScore: Math.round(brierSkillScore * 10000) / 10000,
    logLoss: Math.round(logLoss * 10000) / 10000,
    logLossSkill: Math.round(logLossSkill * 10000) / 10000,
    timeliness,
  };
}

// ============================================================
//  TRUST SCORING
// ============================================================

const WEIGHTS = {
  calibration: 0.25,
  profitability: 0.15,
  consistency: 0.15,
  discipline: 0.10,
  sampleSize: 0.10,
  liveEdge: 0.25,       // NEW: unrealized performance on open positions
};

function gradeFromScore(score: number): 'A' | 'B' | 'C' | 'D' | 'F' {
  if (score >= 80) return 'A';
  if (score >= 65) return 'B';
  if (score >= 50) return 'C';
  if (score >= 35) return 'D';
  return 'F';
}

function tierFromGrade(grade: string): 'SHARP' | 'SOLID' | 'DEVELOPING' | 'RISKY' | 'DANGER' | 'UNPROVEN' {
  switch (grade) {
    case 'A': return 'SHARP';
    case 'B': return 'SOLID';
    case 'C': return 'DEVELOPING';
    case 'D': return 'RISKY';
    default: return 'DANGER';
  }
}

export async function scorePolymarketTrader(wallet: string): Promise<PolymarketRiskReport | null> {
  // Fetch trades, positions, AND on-chain data in parallel
  // Polymarket runs on Polygon (chain 137), not Base
  const onChainPromise = isBasescanConfigured()
    ? getWalletProvenance(wallet, CHAINS.POLYGON.id).catch(() => null)
    : Promise.resolve(null);

  const [trades, allPositions, provenance] = await Promise.all([
    fetchTrades(wallet),
    fetchAllPositions(wallet),
    onChainPromise,
  ]);

  if (trades.length === 0 && allPositions.length === 0) return null;

  // --- Extract resolved bets for calibration ---
  // Step 1: Try positions (curPrice > 0.95 or < 0.05)
  let resolvedBets = extractResolvedBetsFromPositions(allPositions);

  // Step 2: If positions gave us thin data but we have lots of trades,
  // reconstruct resolved bets by looking up market outcomes via CLOB API.
  // This recovers data from positions that Polymarket's API has purged.
  const uniqueMarketCount = new Set(trades.map(t => t.conditionId)).size;
  if (resolvedBets.length < 20 && trades.length >= 50 && uniqueMarketCount >= 10) {
    try {
      const clobResolved = await resolveTradesViaClob(trades);
      if (clobResolved.length > 0) {
        // Merge: deduplicate by conditionId and union both sets
        // Build a map of conditionId -> ResolvedBet from position-based bets
        const positionBetsMap = new Map<string, ResolvedBet>();
        const tradesByConditionId = new Map<string, PolymarketTrade[]>();
        for (const trade of trades) {
          if (!tradesByConditionId.has(trade.conditionId)) {
            tradesByConditionId.set(trade.conditionId, []);
          }
          tradesByConditionId.get(trade.conditionId)!.push(trade);
        }
        for (const bet of resolvedBets) {
          const conditionIds = Array.from(tradesByConditionId.keys());
          // Find the conditionId for this bet by matching with trades
          for (const cId of conditionIds) {
            const tradesForCondition = tradesByConditionId.get(cId) || [];
            // Simple heuristic: match by impliedProb proximity to trade prices
            if (tradesForCondition.some(t => Math.abs(t.price - bet.impliedProb) < 0.01)) {
              positionBetsMap.set(cId, bet);
              break;
            }
          }
        }

        // Create a map of conditionId -> ResolvedBet from CLOB bets
        const clobBetsMap = new Map<string, ResolvedBet>();
        for (const bet of clobResolved) {
          const conditionIds = Array.from(tradesByConditionId.keys());
          for (const cId of conditionIds) {
            const tradesForCondition = tradesByConditionId.get(cId) || [];
            if (tradesForCondition.some(t => Math.abs(t.price - bet.impliedProb) < 0.01)) {
              clobBetsMap.set(cId, bet);
              break;
            }
          }
        }

        // Union: all conditionIds from both sources
        const allConditionIds = new Set([...positionBetsMap.keys(), ...clobBetsMap.keys()]);
        resolvedBets = Array.from(allConditionIds).map(cId =>
          positionBetsMap.get(cId) || clobBetsMap.get(cId)!
        );
      }
    } catch {
      // CLOB lookup failed — continue with position-based data
    }
  }

  const calibrationReport = computeCalibration(resolvedBets);

  // Separate open positions for portfolio analysis
  const positions = allPositions.filter(p => {
    const cur = p.curPrice ?? 0.5;
    return cur > 0.05 && cur < 0.95; // still open / unresolved
  });

  // --- Compute raw metrics ---
  const buyTrades = trades.filter(t => t.side === 'BUY');
  const uniqueMarkets = new Set(trades.map(t => t.conditionId)).size;
  const totalVolume = trades.reduce((s, t) => s + (t.usdcSize || t.size * t.price), 0);

  // PnL from ALL positions (open + resolved)
  const realizedPnl = allPositions.reduce((s, p) => s + (p.realizedPnl || 0), 0);
  const unrealizedPnl = allPositions.reduce((s, p) => s + (p.cashPnl || 0), 0);
  const totalPnl = realizedPnl + unrealizedPnl;

  // Win rate from resolved bets (not positions)
  const wins = resolvedBets.filter(b => b.correct).length;
  const winRate = resolvedBets.length > 0 ? wins / resolvedBets.length : 0;

  // --- DIMENSION 1: CALIBRATION (25%) ---
  // v1.17.0: Combine calibration error (60%) with resolution (40%)
  // Resolution rewards wallets that make genuine forecasts diverging from base rate.
  // A wallet with perfect calibration but no resolution is just predicting the average.
  let calibrationDim: number;
  if (resolvedBets.length < 5) {
    calibrationDim = 0; // can't assess calibration on thin data
  } else {
    // calibrationError ranges 0 (perfect) to ~0.5 (worst)
    const calScore = Math.max(0, Math.min(100, (1 - calibrationReport.calibrationError * 2.5) * 100));
    // Resolution ranges 0 (no discrimination) to ~0.25 (strong). Map to 0-100.
    const resScore = Math.max(0, Math.min(100, calibrationReport.brierDecomposition.resolution * 400));
    calibrationDim = calScore * 0.6 + resScore * 0.4;
  }

  // --- DIMENSION 2: PROFITABILITY (15%) ---
  const roi = totalVolume > 0 ? totalPnl / totalVolume : 0;
  // ROI from -100% to +100% mapped to 0-100
  const profitabilityDim = Math.max(0, Math.min(100, (roi + 0.5) * 100));

  // --- DIMENSION 3: CONSISTENCY (15%) ---
  // How stable are the per-bet returns?
  let consistencyDim: number;
  if (resolvedBets.length >= 5) {
    const betReturns = resolvedBets.map(b => b.pnl / (b.size * b.impliedProb || 1));
    const mean = betReturns.reduce((s, v) => s + v, 0) / betReturns.length;
    const variance = betReturns.reduce((s, v) => s + (v - mean) ** 2, 0) / betReturns.length;
    const cv = mean !== 0 ? Math.sqrt(variance) / Math.abs(mean) : 2;
    // Lower CV = more consistent. CV of 0 = 100, CV of 3+ = 0
    // Use cv=2 for break-even traders (mean=0)
    consistencyDim = Math.max(0, Math.min(100, (1 - cv / 3) * 100));
  } else {
    consistencyDim = 10; // thin data penalty
  }

  // --- DIMENSION 4: DISCIPLINE (10%) ---
  // Diversification across markets + reasonable position sizing
  const marketDiv = Math.min(100, uniqueMarkets * 3); // 33+ markets = full marks
  // Check for concentration: largest position as % of total
  const positionSizes = positions.map(p => Math.abs(p.initialValue));
  const totalValue = positionSizes.reduce((s, v) => s + v, 0);
  const maxPosition = positionSizes.length > 0 ? Math.max(...positionSizes) : 0;
  const concentration = totalValue > 0 ? maxPosition / totalValue : 1;
  const concentrationScore = Math.max(0, Math.min(100, (1 - concentration) * 100));
  const disciplineDim = (marketDiv * 0.5) + (concentrationScore * 0.5);

  // --- DIMENSION 5: SAMPLE SIZE (10%) ---
  // Use the BEST available signal: resolved bets > open positions > trade count
  // A wallet with 2000 trades and 440 markets has proven activity even if
  // Polymarket's API purged its old positions.
  let sampleSizeDim: number;
  const n = resolvedBets.length;
  const tradeSignal = Math.min(100, trades.length / 10); // 1000 trades = 100
  const marketSignal = Math.min(100, uniqueMarkets * 2);  // 50 markets = 100
  const activityScore = Math.max(tradeSignal, marketSignal);

  if (n >= 250) sampleSizeDim = 100;
  else if (n >= 100) sampleSizeDim = 88;
  else if (n >= 50) sampleSizeDim = 75;
  else if (n >= 25) sampleSizeDim = 60;
  else if (n >= 10) sampleSizeDim = 40;
  else if (n >= 5) sampleSizeDim = 20;
  else {
    // Few or zero resolved bets — fall back to activity score but capped
    // Can't fully trust scoring without resolved bets, but activity proves the wallet is real
    sampleSizeDim = Math.min(50, Math.max(5, activityScore * 0.5));
  }

  // --- DIMENSION 6: LIVE EDGE (25%) ---
  // How are the trader's OPEN positions performing right now?
  // For each open position: edge = (curPrice - avgPrice) / avgPrice
  // A trader whose open bets have moved in their favor has real live alpha.
  let liveEdgeDim = 50; // default neutral if no open positions
  if (positions.length >= 3) {
    // Weighted by position size — bigger bets count more
    let totalWeight = 0;
    let weightedEdge = 0;
    let winningPositions = 0;
    for (const p of positions) {
      const weight = Math.abs(p.initialValue) || 1;
      // For YES positions: curPrice > avgPrice = winning
      // Edge capped at [-1, +1] to prevent outlier distortion
      const rawEdge = p.avgPrice > 0 ? (p.curPrice - p.avgPrice) / p.avgPrice : 0;
      const edge = Math.max(-1, Math.min(1, rawEdge));
      weightedEdge += edge * weight;
      totalWeight += weight;
      if (p.curPrice > p.avgPrice) winningPositions++;
    }
    const avgEdge = totalWeight > 0 ? weightedEdge / totalWeight : 0;
    const winPct = winningPositions / positions.length;

    // Combine: 60% weighted edge magnitude, 40% win percentage
    // avgEdge ranges roughly -1 to +1, map to 0-100
    const edgeScore = Math.max(0, Math.min(100, (avgEdge + 0.5) * 100));
    const winPctScore = winPct * 100;
    liveEdgeDim = edgeScore * 0.6 + winPctScore * 0.4;
  } else if (positions.length > 0) {
    // 1-2 open positions: weak signal, slight weight
    const avgEdge = positions.reduce((s, p) => {
      return s + (p.avgPrice > 0 ? (p.curPrice - p.avgPrice) / p.avgPrice : 0);
    }, 0) / positions.length;
    liveEdgeDim = Math.max(0, Math.min(100, (avgEdge + 0.5) * 100));
  }

  // --- PENALTY 1: PENNY-LOTTERY DETECTION ---
  // If 80%+ of resolved bets are sub-$0.10, this is a lottery strategy,
  // not predictive skill. Low-price bets that hit 1-2 times inflate PnL
  // while appearing "well-calibrated" because expected = 5%, actual = 0.4%.
  // v1.17.0 FIX: Skip penalty if BSS > 0 — if the strategy actually beats
  // naive baseline, the penny bets are working, not farming.
  const pennyBets = resolvedBets.filter(b => b.impliedProb < 0.10).length;
  const pennyRatio = resolvedBets.length > 0 ? pennyBets / resolvedBets.length : 0;
  let pennyPenalty = 0;
  const bssPositive = calibrationReport.brierSkillScore > 0;
  if (!bssPositive) {
    if (pennyRatio >= 0.8 && resolvedBets.length >= 10) {
      pennyPenalty = 30; // heavy penalty — lottery farming with no skill (reduced from 40)
    } else if (pennyRatio >= 0.5 && resolvedBets.length >= 10) {
      pennyPenalty = 15; // moderate penalty — heavily skewed toward penny bets (reduced from 20)
    }
  }

  // --- PENALTY 2: RECEIVE-ONLY WALLET ---
  // A wallet that has never sent a transaction is likely a proxy/settlement
  // address, not a real trader. Flag it but don't crush the score — many
  // legitimate Polymarket wallets are proxy/settlement addresses that only
  // receive funds from a parent wallet.
  // v1.17.0 FIX: Reduced from 15pts to 5pts. Proxy wallets are common in
  // Polymarket's architecture and shouldn't be penalized as heavily.
  let receiveOnlyPenalty = 0;
  if (provenance && provenance.outboundTxCount === 0 && provenance.inboundTxCount > 0) {
    receiveOnlyPenalty = 5; // light flag — note it but don't crush
  }

  // --- PENALTY 3: PnL DIVERGENCE ---
  // If API-reported PnL diverges massively from on-chain USDC flows,
  // either the data is unreliable or something is being misrepresented.
  // v1.17.0 FIX: Subtract unrealized gains before comparing — open positions
  // naturally create divergence between API PnL (includes unrealized) and
  // on-chain USDC flows (only settled). Only flag truly anomalous gaps.
  let pnlDivPenalty = 0;
  if (provenance && provenance.usdcTransfers > 0) {
    const onChainNetUsdc = provenance.totalUsdcIn - provenance.totalUsdcOut;
    // Compare against REALIZED PnL only, not total (which includes unrealized)
    const comparablePnl = realizedPnl;
    const divergence = Math.abs(comparablePnl - onChainNetUsdc);
    if (divergence > totalVolume * 0.5 && totalVolume > 0) {
      pnlDivPenalty = 15; // massive divergence — data can't be trusted (reduced from 25)
    } else if (divergence > totalVolume * 0.2 && totalVolume > 0) {
      pnlDivPenalty = 5; // moderate divergence — flag it (reduced from 10)
    }
  }

  // --- COMPOSITE SCORE ---
  const rawTrustScore = Math.round(
    calibrationDim * WEIGHTS.calibration +
    profitabilityDim * WEIGHTS.profitability +
    consistencyDim * WEIGHTS.consistency +
    disciplineDim * WEIGHTS.discipline +
    sampleSizeDim * WEIGHTS.sampleSize +
    liveEdgeDim * WEIGHTS.liveEdge
  );

  // Sum penalties (applied after gating to prevent double-punishment)
  const totalPenalty = pennyPenalty + receiveOnlyPenalty + pnlDivPenalty;

  // Sample-size gate — considers resolved bets, open positions, AND trade activity
  // v1.17.0 FIX: Gates only apply to the RAW score (pre-penalty) to prevent
  // double-punishment. Penalties are then applied AFTER gating.
  const totalDataPoints = resolvedBets.length + positions.length;
  const hasProvenActivity = trades.length >= 100 && uniqueMarkets >= 20;
  let gatedRaw: number;
  if (resolvedBets.length >= 10) {
    gatedRaw = rawTrustScore; // enough resolved data, no gate
  } else if (resolvedBets.length >= 5) {
    gatedRaw = Math.min(rawTrustScore, 65);
  } else if (hasProvenActivity) {
    // Few resolved bets but massive trade history — the wallet is real,
    // positions just got purged from the API. Cap at C+ range.
    gatedRaw = Math.min(rawTrustScore, 70);
  } else if (totalDataPoints >= 20) {
    gatedRaw = Math.min(rawTrustScore, 60);
  } else if (totalDataPoints >= 5) {
    gatedRaw = Math.min(rawTrustScore, 45);
  } else {
    gatedRaw = Math.min(rawTrustScore, 30); // almost no data at all
  }

  // Apply penalties AFTER gating (prevents double-punishment)
  let gatedScore = Math.max(0, gatedRaw - totalPenalty);

  // Hard cap: penny-lottery + receive-only wallets cannot exceed C grade
  if (pennyRatio >= 0.8 && receiveOnlyPenalty > 0) {
    gatedScore = Math.min(gatedScore, 49); // cap at D
  }

  const trustGrade = gradeFromScore(gatedScore);
  const trustTier = (totalDataPoints < 5 && !hasProvenActivity) ? 'UNPROVEN' : tierFromGrade(trustGrade);

  // --- SIGNALS ---
  const reasoning: string[] = [];
  const flags: string[] = [];
  const greenFlags: string[] = [];

  if (resolvedBets.length >= 10) {
    if (calibrationReport.brierScore < 0.2) greenFlags.push(`Strong Brier score: ${calibrationReport.brierScore}`);
    if (calibrationReport.brierScore > 0.35) flags.push(`Weak Brier score: ${calibrationReport.brierScore}`);
    if (calibrationReport.overconfidenceBias > 0.1) flags.push(`Overconfidence bias: ${calibrationReport.overconfidenceBias.toFixed(3)}`);
    if (calibrationReport.overconfidenceBias < -0.05) greenFlags.push(`Conservative (underconfident) bias`);
    if (calibrationReport.skillDecomposition.skill > 60) greenFlags.push(`Genuine predictive skill detected (${calibrationReport.skillDecomposition.skill.toFixed(0)}/100)`);
    if (calibrationReport.skillDecomposition.luck > 70) flags.push(`High luck component: ${calibrationReport.skillDecomposition.luck.toFixed(0)}/100 — returns may not persist`);

    // v1.16.0: New academic-grade signals
    if (calibrationReport.brierSkillScore > 0.15) greenFlags.push(`Brier Skill Score: ${(calibrationReport.brierSkillScore * 100).toFixed(1)}% better than naive baseline`);
    if (calibrationReport.brierSkillScore < -0.1) flags.push(`Brier Skill Score: ${(calibrationReport.brierSkillScore * 100).toFixed(1)}% — performing worse than naive baseline`);
    if (calibrationReport.brierDecomposition.resolution > 0.05) greenFlags.push(`Strong resolution/discrimination: forecasts meaningfully diverge from base rate`);
    if (calibrationReport.brierDecomposition.resolution < 0.01 && resolvedBets.length >= 20) flags.push(`Low resolution: forecasts cluster near base rate — no genuine opinions`);
    if (calibrationReport.logLossSkill > 0.1) greenFlags.push(`Log loss skill: ${(calibrationReport.logLossSkill * 100).toFixed(1)}% better than naive (rare-event sensitive)`);
    if (calibrationReport.logLossSkill < -0.2) flags.push(`Log loss penalty: severe overconfidence on wrong bets detected`);
    if (calibrationReport.timeliness.timelinessScore >= 60) greenFlags.push(`Early mover: avg ${calibrationReport.timeliness.avgDaysBeforeResolution.toFixed(0)} days before resolution`);
  }

  // Penalty flags
  if (pennyPenalty > 0) flags.push(`Penny-lottery strategy: ${(pennyRatio * 100).toFixed(0)}% of bets at sub-$0.10 — score penalized by ${pennyPenalty} pts`);
  if (receiveOnlyPenalty > 0) flags.push(`Receive-only wallet: zero outbound transactions — possible proxy/settlement address`);
  if (pnlDivPenalty > 0) flags.push(`PnL integrity warning: massive divergence between API-reported and on-chain USDC flows — score penalized by ${pnlDivPenalty} pts`);

  // Live edge signals
  if (positions.length >= 3 && liveEdgeDim >= 70) greenFlags.push(`Strong live edge: ${positions.length} open positions trending profitable`);
  if (positions.length >= 3 && liveEdgeDim < 30) flags.push(`Weak live edge: open positions mostly underwater`);
  if (positions.length === 0 && resolvedBets.length === 0) flags.push(`No position data: nothing to score`);

  if (totalPnl > 0) greenFlags.push(`Net profitable: +$${Math.round(totalPnl)} total PnL`);
  if (totalPnl < -100) flags.push(`Net loss: -$${Math.round(Math.abs(totalPnl))} total PnL`);
  if (winRate > 0.6 && resolvedBets.length >= 10) greenFlags.push(`Strong win rate: ${(winRate * 100).toFixed(0)}%`);
  if (winRate < 0.4 && resolvedBets.length >= 10) flags.push(`Low win rate: ${(winRate * 100).toFixed(0)}%`);
  if (concentration > 0.5) flags.push(`Concentrated portfolio: ${(concentration * 100).toFixed(0)}% in single market`);
  if (uniqueMarkets >= 20) greenFlags.push(`Well-diversified: ${uniqueMarkets} unique markets`);
  if (resolvedBets.length < 10 && hasProvenActivity) {
    flags.push(`Limited resolved data (${resolvedBets.length} resolved) despite ${trades.length} trades across ${uniqueMarkets} markets — older positions may have been purged from API`);
  } else if (resolvedBets.length < 10) {
    flags.push(`Thin resolved data: only ${resolvedBets.length} resolved bets`);
  }

  // --- ON-CHAIN VERIFICATION SIGNALS ---
  let onChainBlock: PolymarketRiskReport['onChain'] = null;
  let pnlDivergence: number | null = null;

  if (provenance) {
    onChainBlock = {
      verified: true,
      provenance,
      pnlDivergence: null,
      pnlVerified: false,
    };

    // Cross-check PnL: compare API-reported PnL against on-chain USDC net flow
    const onChainNetUsdc = provenance.totalUsdcIn - provenance.totalUsdcOut;
    if (provenance.usdcTransfers > 0 && Math.abs(totalPnl) > 0) {
      pnlDivergence = Math.abs(totalPnl - onChainNetUsdc);
      onChainBlock.pnlDivergence = Math.round(pnlDivergence * 100) / 100;
      // PnL is "verified" if divergence is less than 20% of total volume
      onChainBlock.pnlVerified = pnlDivergence < totalVolume * 0.2;
    }

    // Inject on-chain signals into flags
    const chainLabel = provenance.chainId === 137 ? 'Polygon' : 'Base';
    if (provenance.walletAgeDays < 7) flags.push(`On-chain: wallet only ${provenance.walletAgeDays} days old on ${chainLabel}`);
    if (provenance.totalTransactions < 5) flags.push(`On-chain: only ${provenance.totalTransactions} transactions on ${chainLabel}`);
    if (provenance.walletAgeDays >= 180) greenFlags.push(`On-chain: ${provenance.walletAgeDays}-day wallet history on ${chainLabel}`);
    if (provenance.protocolsUsed.length >= 3) greenFlags.push(`On-chain: multi-protocol user (${provenance.protocolsUsed.join(', ')})`);
    if (pnlDivergence !== null && !onChainBlock.pnlVerified) {
      flags.push(`PnL divergence: $${Math.round(pnlDivergence)} gap between API and on-chain USDC flows`);
    }

    // v1.17.0: Bot and wash trading signals from enhanced Basescan analysis
    if (provenance.botScore >= 60) flags.push(`On-chain: bot-like trading patterns detected (bot score: ${provenance.botScore})`);
    else if (provenance.botScore >= 30) flags.push(`On-chain: possible automated trading (bot score: ${provenance.botScore})`);
    if (provenance.washTradingScore >= 60) flags.push(`On-chain: wash trading signal — ${(provenance.topCounterpartyConcentration * 100).toFixed(0)}% of txs with single counterparty`);
    if (provenance.botScore < 15 && provenance.totalTransactions >= 20) greenFlags.push(`On-chain: human-like trading patterns`);
    if (provenance.washTradingScore < 20 && provenance.uniqueCounterparties >= 10) greenFlags.push(`On-chain: diverse counterparty network`);

    reasoning.push(
      `On-chain verification: wallet age ${provenance.walletAgeDays} days, ${provenance.totalTransactions} txs, provenance grade ${provenance.provenanceGrade}. Bot score: ${provenance.botScore}/100, wash trading score: ${provenance.washTradingScore}/100.`,
    );
  }

  reasoning.push(
    `${trades.length} total trades across ${uniqueMarkets} markets.`,
    `${resolvedBets.length} bets on resolved markets available for calibration scoring.`,
    calibrationReport.resolvedBets >= 10
      ? `Calibration error: ${(calibrationReport.calibrationError * 100).toFixed(1)}% — ${calibrationReport.calibrationError < 0.1 ? 'excellent' : calibrationReport.calibrationError < 0.2 ? 'good' : 'needs improvement'}.`
      : `Insufficient resolved bets for calibration analysis.`,
    `Skill decomposition: ${calibrationReport.skillDecomposition.skill.toFixed(0)}% skill, ${calibrationReport.skillDecomposition.luck.toFixed(0)}% luck.`,
  );
  // v1.16.0: Academic-grade metrics in reasoning
  if (calibrationReport.resolvedBets >= 10) {
    reasoning.push(
      `Brier Skill Score: ${(calibrationReport.brierSkillScore * 100).toFixed(1)}% vs naive baseline (>0% = better than always predicting base rate).`,
      `Brier decomposition: REL=${calibrationReport.brierDecomposition.calibration.toFixed(4)} RES=${calibrationReport.brierDecomposition.resolution.toFixed(4)} UNC=${calibrationReport.brierDecomposition.uncertainty.toFixed(4)}.`,
      `Log loss: ${calibrationReport.logLoss.toFixed(4)} (skill: ${(calibrationReport.logLossSkill * 100).toFixed(1)}% vs naive). Lower log loss = better calibration on rare events.`,
    );
    if (calibrationReport.timeliness.timelinessScore > 0) {
      reasoning.push(
        `Timeliness: avg entry ${calibrationReport.timeliness.avgDaysBeforeResolution.toFixed(1)} days before resolution, ${(calibrationReport.timeliness.earlyMoverPct * 100).toFixed(0)}% early mover.`,
      );
    }
  }

  // --- CONFIDENCE INTERVALS ---
  let confidenceLevel: 'high' | 'medium' | 'low' | 'very_low';
  let confidenceMargin: number;

  if (resolvedBets.length >= 200) {
    confidenceLevel = 'high';
    confidenceMargin = 3;
  } else if (resolvedBets.length >= 50) {
    confidenceLevel = 'medium';
    confidenceMargin = 8;
  } else if (resolvedBets.length >= 20) {
    confidenceLevel = 'low';
    confidenceMargin = 15;
  } else {
    confidenceLevel = 'very_low';
    confidenceMargin = 25;
  }

  const confidenceDescription = `${trustGrade}/${gatedScore} ± ${confidenceMargin} (${confidenceLevel} confidence, ${resolvedBets.length} resolved bets)`;

  // Identity
  const firstName = trades[0]?.name || trades[0]?.pseudonym || '';
  const pseudonym = trades[0]?.pseudonym || '';

  return {
    wallet,
    displayName: firstName || `Trader ${wallet.slice(0, 8)}...`,
    pseudonym,
    raw: {
      totalTrades: trades.length,
      totalVolume: Math.round(totalVolume * 100) / 100,
      totalPnl: Math.round(totalPnl * 100) / 100,
      realizedPnl: Math.round(realizedPnl * 100) / 100,
      unrealizedPnl: Math.round(unrealizedPnl * 100) / 100,
      winRate: Math.round(winRate * 1000) / 1000,
      openPositions: positions.length,
      resolvedBets: resolvedBets.length,
      uniqueMarkets,
    },
    calibration: Math.round(calibrationDim),
    profitability: Math.round(profitabilityDim),
    consistency: Math.round(consistencyDim),
    discipline: Math.round(disciplineDim),
    sampleSize: Math.round(sampleSizeDim),
    liveEdge: Math.round(liveEdgeDim),
    trustScore: gatedScore,
    trustGrade,
    trustTier,
    confidence: {
      level: confidenceLevel,
      margin: confidenceMargin,
      resolvedBets: resolvedBets.length,
      description: confidenceDescription,
    },
    calibrationReport,
    onChain: onChainBlock,
    reasoning,
    flags,
    greenFlags,
    scoredAt: new Date().toISOString(),
    dataSource: 'polymarket-v1',
    disclaimer: 'VIGIL Trust Score is informational only — not investment advice. Calibration scoring requires resolved markets and may not reflect recent performance.',
  };
}


// ============================================================
//  WALLET DISCOVERY CRAWLER — Find skilled traders across all
//  resolved Polymarket markets. Scans high-volume resolved markets,
//  collects unique wallet addresses, and identifies A/B grade wallets.
// ============================================================

const GAMMA_BASE = 'https://gamma-api.polymarket.com';

/** Summary of a discovered wallet before full scoring */
export interface DiscoveredWallet {
  wallet: string;
  marketsTraded: number;    // how many resolved markets we saw them in
  firstSeen: string;        // ISO date of first discovery
}

/** A scored wallet in the skill leaderboard */
export interface LeaderboardEntry {
  wallet: string;
  displayName: string;
  trustScore: number;
  trustGrade: string;
  brierSkillScore: number;
  calibrationError: number;
  resolvedBets: number;
  winRate: number;
  realizedPnl: number;
  scoredAt: string;
}

// In-memory leaderboard store (persists across requests, rebuilt by cron)
let skillLeaderboard: LeaderboardEntry[] = [];
let discoveredWallets: Map<string, DiscoveredWallet> = new Map();
let lastCrawlTime: string | null = null;
let crawlInProgress = false;

/** Get current skill leaderboard */
export function getSkillLeaderboard(): LeaderboardEntry[] {
  return skillLeaderboard;
}

/** Get crawler status */
export function getCrawlerStatus() {
  return {
    discoveredWallets: discoveredWallets.size,
    leaderboardSize: skillLeaderboard.length,
    lastCrawl: lastCrawlTime,
    crawlInProgress,
  };
}

/**
 * Phase 1: Crawl resolved markets from Gamma API and collect unique wallet addresses.
 * Scans the top N resolved markets by volume, pulls trades from each, deduplicates wallets.
 *
 * @param maxMarkets - how many resolved markets to scan (default 100)
 * @param minVolume - minimum market volume to consider (filters noise)
 */
export async function crawlResolvedMarkets(
  maxMarkets = 100,
  minVolume = 50000,
): Promise<Map<string, DiscoveredWallet>> {
  console.log(`[VIGIL Crawler] Starting crawl — scanning up to ${maxMarkets} resolved markets...`);

  // Fetch resolved markets ordered by volume (biggest = most traders)
  const markets: any[] = [];
  let offset = 0;
  const limit = 50; // Gamma API page size

  while (markets.length < maxMarkets) {
    try {
      const batch = await fetchJson<any[]>(
        `${GAMMA_BASE}/markets?closed=true&limit=${limit}&offset=${offset}&order=volumeNum&ascending=false`,
        15000,
      );
      if (!Array.isArray(batch) || batch.length === 0) break;

      // Filter by minimum volume
      const filtered = batch.filter((m: any) => (m.volumeNum || 0) >= minVolume);
      markets.push(...filtered);

      if (batch.length < limit) break; // last page
      offset += limit;
    } catch (err) {
      console.error(`[VIGIL Crawler] Error fetching markets at offset ${offset}:`, err);
      break;
    }
  }

  const resolvedMarkets = markets.slice(0, maxMarkets);
  console.log(`[VIGIL Crawler] Found ${resolvedMarkets.length} resolved markets above $${minVolume.toLocaleString()} volume`);

  // For each market, fetch trades and collect unique wallets
  const wallets = new Map<string, DiscoveredWallet>(discoveredWallets);
  let marketsScanned = 0;

  for (const market of resolvedMarkets) {
    try {
      const conditionId = market.conditionId;
      if (!conditionId) continue;

      // Fetch up to 500 trades per market to get diverse wallet set
      const trades = await fetchJson<any[]>(
        `${DATA_BASE}/trades?conditionId=${conditionId}&limit=500`,
        10000,
      );

      if (!Array.isArray(trades)) continue;

      for (const trade of trades) {
        const w = trade.proxyWallet;
        if (!w) continue;

        if (wallets.has(w)) {
          const existing = wallets.get(w)!;
          existing.marketsTraded++;
        } else {
          wallets.set(w, {
            wallet: w,
            marketsTraded: 1,
            firstSeen: new Date().toISOString(),
          });
        }
      }

      marketsScanned++;

      // Rate limit: small delay every 10 markets to be kind to the API
      if (marketsScanned % 10 === 0) {
        console.log(`[VIGIL Crawler] Scanned ${marketsScanned}/${resolvedMarkets.length} markets, ${wallets.size} unique wallets found`);
        await new Promise(r => setTimeout(r, 500));
      }
    } catch (err) {
      console.error(`[VIGIL Crawler] Error scanning market ${market.id}:`, err);
      continue;
    }
  }

  console.log(`[VIGIL Crawler] Crawl complete: ${marketsScanned} markets → ${wallets.size} unique wallets`);
  discoveredWallets = wallets;
  return wallets;
}

/**
 * Phase 2: Score discovered wallets and build the skill leaderboard.
 * Only scores wallets seen in 3+ resolved markets (likely to have enough data).
 * Filters for positive BSS and decent calibration to surface genuinely skilled traders.
 *
 * @param maxToScore - how many wallets to attempt scoring (default 200)
 * @param minMarketsTraded - minimum resolved markets a wallet must appear in (default 3)
 */
export async function buildSkillLeaderboard(
  maxToScore = 200,
  minMarketsTraded = 3,
): Promise<LeaderboardEntry[]> {
  console.log(`[VIGIL Crawler] Building skill leaderboard from ${discoveredWallets.size} discovered wallets...`);

  // Sort by marketsTraded descending — wallets in more markets likely have more resolved data
  const candidates = [...discoveredWallets.values()]
    .filter(w => w.marketsTraded >= minMarketsTraded)
    .sort((a, b) => b.marketsTraded - a.marketsTraded)
    .slice(0, maxToScore);

  console.log(`[VIGIL Crawler] ${candidates.length} candidates with ${minMarketsTraded}+ markets traded`);

  const entries: LeaderboardEntry[] = [];
  let scored = 0;
  let errors = 0;

  for (const candidate of candidates) {
    try {
      const report = await scorePolymarketTrader(candidate.wallet);
      if (!report) { scored++; errors++; continue; }

      // Only include wallets with meaningful data
      if (report.raw.resolvedBets < 10) {
        scored++;
        continue;
      }

      entries.push({
        wallet: report.wallet,
        displayName: report.displayName,
        trustScore: report.trustScore,
        trustGrade: report.trustGrade,
        brierSkillScore: report.calibrationReport.brierSkillScore,
        calibrationError: report.calibrationReport.calibrationError,
        resolvedBets: report.raw.resolvedBets,
        winRate: report.raw.winRate,
        realizedPnl: report.raw.realizedPnl,
        scoredAt: report.scoredAt,
      });

      // Alert on A or B grade discoveries — log to DB
      if (report.trustGrade === 'A' || report.trustGrade === 'B') {
        console.log(`[VIGIL ALERT] 🎯 ${report.trustGrade}-grade wallet discovered: ${report.displayName} (${report.trustGrade}/${report.trustScore})`);
        try {
          await query(
            'INSERT INTO discovery_alerts (wallet, display_name, trust_grade, trust_score, brier_skill, resolved_bets) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING',
            [report.wallet, report.displayName, report.trustGrade, report.trustScore, report.calibrationReport.brierSkillScore, report.raw.resolvedBets],
          );
        } catch (err) {
          console.error('[VIGIL ALERT] Failed to save alert:', err);
        }
      }

      scored++;

      // Log progress every 25 wallets
      if (scored % 25 === 0) {
        console.log(`[VIGIL Crawler] Scored ${scored}/${candidates.length} wallets, ${entries.length} qualified so far`);
      }

      // Rate limit — avoid hammering APIs
      if (scored % 5 === 0) {
        await new Promise(r => setTimeout(r, 300));
      }
    } catch (err) {
      errors++;
      scored++;
      continue;
    }
  }

  // Sort by trustScore descending — best wallets first
  entries.sort((a, b) => b.trustScore - a.trustScore);

  skillLeaderboard = entries;
  lastCrawlTime = new Date().toISOString();
  console.log(`[VIGIL Crawler] Leaderboard built: ${entries.length} qualified wallets (${errors} errors)`);

  // Log the top performers
  const topGrades = entries.slice(0, 10).map(e => `${e.displayName}: ${e.trustGrade}/${e.trustScore}`);
  if (topGrades.length > 0) {
    console.log(`[VIGIL Crawler] Top 10: ${topGrades.join(', ')}`);
  }

  // Log grade distribution
  const gradeCounts: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, F: 0 };
  for (const e of entries) gradeCounts[e.trustGrade] = (gradeCounts[e.trustGrade] || 0) + 1;
  console.log(`[VIGIL Crawler] Grade distribution: A=${gradeCounts.A} B=${gradeCounts.B} C=${gradeCounts.C} D=${gradeCounts.D} F=${gradeCounts.F}`);

  return entries;
}

/**
 * Full crawl pipeline: discover wallets → score → build leaderboard.
 * Designed to run as a background job (cron or manual trigger).
 */
export async function runDiscoveryCrawl(
  options: {
    maxMarkets?: number;
    minVolume?: number;
    maxToScore?: number;
    minMarketsTraded?: number;
  } = {},
): Promise<{ status: string; discovered: number; scored: number; topGrade: string | null }> {
  if (crawlInProgress) {
    return { status: 'already_running', discovered: discoveredWallets.size, scored: skillLeaderboard.length, topGrade: null };
  }

  crawlInProgress = true;
  try {
    const {
      maxMarkets = 100,
      minVolume = 50000,
      maxToScore = 200,
      minMarketsTraded = 3,
    } = options;

    await crawlResolvedMarkets(maxMarkets, minVolume);
    const entries = await buildSkillLeaderboard(maxToScore, minMarketsTraded);

    const topGrade = entries.length > 0 ? `${entries[0].trustGrade}/${entries[0].trustScore}` : null;

    return {
      status: 'complete',
      discovered: discoveredWallets.size,
      scored: entries.length,
      topGrade,
    };
  } finally {
    crawlInProgress = false;
  }
}
