// VIGIL — Polymarket Prediction Market Adapter + Calibration Scoring
// The PROPRIETARY layer: calibration scoring measures genuine predictive
// skill vs. speed arb vs. luck. Nobody else computes this.
//
// Data sources:
//   data-api.polymarket.com  — trades, positions, activity per wallet
//   basescan (etherscan v2)  — on-chain verification layer

import { getWalletProvenance, isBasescanConfigured, CHAINS, type WalletProvenance } from './basescan.js';

const USER_AGENT = 'VIGIL-Trust/1.11.0 (vigil.trust; prediction-market-scoring)';
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
//  CALIBRATION ENGINE — THE PROPRIETARY LAYER
//
//  When a trader buys YES at $0.70, they're implying a 70%
//  probability. If that event resolves YES, the bet was correct.
//  A perfectly calibrated trader's 70% bets resolve YES exactly
//  70% of the time. This measures genuine predictive intelligence
//  vs. speed arb vs. luck. Nobody else computes this.
// ============================================================

interface ResolvedBet {
  impliedProb: number;   // price they paid (their belief)
  correct: boolean;       // did the market resolve in their favor?
  pnl: number;           // what they made/lost
  size: number;           // position size in shares
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
    const impliedProb = p.avgPrice;  // what they paid = their belief
    const size = p.size;

    // PnL: if correct, gained (1 - avgPrice) per share; if wrong, lost avgPrice per share
    const pnl = correct
      ? size * (1 - impliedProb)
      : size * (-impliedProb);

    bets.push({ impliedProb, correct, pnl, size });
  }

  return bets;
}

function computeCalibration(bets: ResolvedBet[]): CalibrationReport {
  if (bets.length === 0) {
    return {
      buckets: [],
      brierScore: 1,
      calibrationError: 1,
      resolvedBets: 0,
      overconfidenceBias: 0,
      skillDecomposition: { skill: 0, luck: 0, edge: 0 },
    };
  }

  // --- Brier Score ---
  // Mean squared error between implied probability and actual outcome (0 or 1)
  let brierSum = 0;
  for (const b of bets) {
    const outcome = b.correct ? 1 : 0;
    brierSum += (b.impliedProb - outcome) ** 2;
  }
  const brierScore = brierSum / bets.length;

  // --- Calibration Buckets ---
  // Group bets by implied probability range (deciles)
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
    const midpoint = (def.lo + def.hi) / 2;
    const error = Math.abs(actualRate - midpoint);

    buckets.push({
      range: def.label,
      midpoint,
      totalBets: inBucket.length,
      correctBets: correctCount,
      actualRate,
      expectedRate: midpoint,
      error,
    });

    calErrorSum += error * inBucket.length;
    calErrorCount += inBucket.length;
    overconfidenceSum += (midpoint - actualRate) * inBucket.length;
  }

  const calibrationError = calErrorCount > 0 ? calErrorSum / calErrorCount : 1;
  const overconfidenceBias = calErrorCount > 0 ? overconfidenceSum / calErrorCount : 0;

  // --- Skill Decomposition ---
  // Skill = how much of the PnL came from calibration (genuine alpha)
  // Luck = variance residual
  const totalPnl = bets.reduce((s, b) => s + b.pnl, 0);
  const totalStaked = bets.reduce((s, b) => s + b.size * b.impliedProb, 0);
  const roi = totalStaked > 0 ? totalPnl / totalStaked : 0;

  // Skill metric: inverse of calibration error, scaled 0-100
  // Perfect calibration (error=0) = skill 100
  // Worst calibration (error=0.5) = skill 0
  const skill = Math.max(0, Math.min(100, (1 - calibrationError * 2) * 100));

  // Luck: higher variance in outcomes relative to sample = more luck-driven
  const pnlValues = bets.map(b => b.pnl);
  const pnlMean = pnlValues.reduce((s, v) => s + v, 0) / pnlValues.length;
  const pnlVariance = pnlValues.reduce((s, v) => s + (v - pnlMean) ** 2, 0) / pnlValues.length;
  const pnlStdDev = Math.sqrt(pnlVariance);
  // Higher variance relative to mean = more luck-driven
  const luckRatio = pnlMean !== 0 ? Math.abs(pnlStdDev / pnlMean) : 10;
  const luck = Math.max(0, Math.min(100, luckRatio * 20));

  // Edge: net alpha — positive = genuine skill beyond luck
  const edge = roi * 100; // scale for readability

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

  // --- Extract resolved bets from positions for calibration ---
  // Positions with curPrice > 0.95 or < 0.05 are effectively resolved.
  // avgPrice = what the trader paid = their implied probability belief.
  const resolvedBets = extractResolvedBetsFromPositions(allPositions);
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

  // --- DIMENSION 1: CALIBRATION (30%) ---
  // Inverse of calibration error. Perfect = 100, worst = 0.
  let calibrationDim: number;
  if (resolvedBets.length < 5) {
    calibrationDim = 0; // can't assess calibration on thin data
  } else {
    // calibrationError ranges 0 (perfect) to ~0.5 (worst)
    calibrationDim = Math.max(0, Math.min(100, (1 - calibrationReport.calibrationError * 2.5) * 100));
  }

  // --- DIMENSION 2: PROFITABILITY (20%) ---
  const roi = totalVolume > 0 ? totalPnl / totalVolume : 0;
  // ROI from -100% to +100% mapped to 0-100
  const profitabilityDim = Math.max(0, Math.min(100, (roi + 0.5) * 100));

  // --- DIMENSION 3: CONSISTENCY (20%) ---
  // How stable are the per-bet returns?
  if (resolvedBets.length >= 5) {
    const betReturns = resolvedBets.map(b => b.pnl / (b.size * b.impliedProb || 1));
    const mean = betReturns.reduce((s, v) => s + v, 0) / betReturns.length;
    const variance = betReturns.reduce((s, v) => s + (v - mean) ** 2, 0) / betReturns.length;
    const cv = mean !== 0 ? Math.sqrt(variance) / Math.abs(mean) : 10;
    // Lower CV = more consistent. CV of 0 = 100, CV of 3+ = 0
    var consistencyDim = Math.max(0, Math.min(100, (1 - cv / 3) * 100));
  } else {
    var consistencyDim = 10; // thin data penalty
  }

  // --- DIMENSION 4: DISCIPLINE (15%) ---
  // Diversification across markets + reasonable position sizing
  const marketDiv = Math.min(100, uniqueMarkets * 3); // 33+ markets = full marks
  // Check for concentration: largest position as % of total
  const positionSizes = positions.map(p => Math.abs(p.initialValue));
  const totalValue = positionSizes.reduce((s, v) => s + v, 0);
  const maxPosition = Math.max(...positionSizes, 0);
  const concentration = totalValue > 0 ? maxPosition / totalValue : 1;
  const concentrationScore = Math.max(0, Math.min(100, (1 - concentration) * 100));
  const disciplineDim = (marketDiv * 0.5) + (concentrationScore * 0.5);

  // --- DIMENSION 5: SAMPLE SIZE (15%) ---
  let sampleSizeDim: number;
  const n = resolvedBets.length;
  if (n < 5) sampleSizeDim = 5;
  else if (n < 10) sampleSizeDim = 20;
  else if (n < 25) sampleSizeDim = 40;
  else if (n < 50) sampleSizeDim = 60;
  else if (n < 100) sampleSizeDim = 75;
  else if (n < 250) sampleSizeDim = 88;
  else sampleSizeDim = 100;

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
  const pennyBets = resolvedBets.filter(b => b.impliedProb < 0.10).length;
  const pennyRatio = resolvedBets.length > 0 ? pennyBets / resolvedBets.length : 0;
  let pennyPenalty = 0;
  if (pennyRatio >= 0.8 && resolvedBets.length >= 10) {
    pennyPenalty = 40; // massive penalty — this is lottery farming, not skill
  } else if (pennyRatio >= 0.5 && resolvedBets.length >= 10) {
    pennyPenalty = 20; // significant penalty — heavily skewed toward penny bets
  }

  // --- PENALTY 2: RECEIVE-ONLY WALLET ---
  // A wallet that has never sent a transaction is likely a proxy/settlement
  // address, not a real trader. Penalize heavily.
  let receiveOnlyPenalty = 0;
  if (provenance && provenance.outboundTxCount === 0 && provenance.inboundTxCount > 0) {
    receiveOnlyPenalty = 15; // cap reduction — can't fully trust a one-way wallet
  }

  // --- PENALTY 3: PnL DIVERGENCE ---
  // If API-reported PnL diverges massively from on-chain USDC flows,
  // either the data is unreliable or something is being misrepresented.
  let pnlDivPenalty = 0;
  if (provenance && provenance.usdcTransfers > 0) {
    const onChainNetUsdc = provenance.totalUsdcIn - provenance.totalUsdcOut;
    const divergence = Math.abs(totalPnl - onChainNetUsdc);
    if (divergence > totalVolume * 0.5 && totalVolume > 0) {
      pnlDivPenalty = 25; // massive divergence — data can't be trusted
    } else if (divergence > totalVolume * 0.2 && totalVolume > 0) {
      pnlDivPenalty = 10; // moderate divergence — flag it
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

  // Apply penalties
  const totalPenalty = pennyPenalty + receiveOnlyPenalty + pnlDivPenalty;
  const trustScore = Math.max(0, rawTrustScore - totalPenalty);

  // Sample-size gate — relaxed if trader has significant open positions
  const totalDataPoints = resolvedBets.length + positions.length;
  let gatedScore: number;
  if (resolvedBets.length >= 10) {
    gatedScore = trustScore; // enough resolved data, no gate
  } else if (resolvedBets.length >= 5) {
    gatedScore = Math.min(trustScore, 50);
  } else if (totalDataPoints >= 20) {
    // Few resolved but many open positions — cap at C range, let live edge speak
    gatedScore = Math.min(trustScore, 60);
  } else if (totalDataPoints >= 5) {
    gatedScore = Math.min(trustScore, 40);
  } else {
    gatedScore = Math.min(trustScore, 25); // almost no data at all
  }

  // Hard cap: penny-lottery + receive-only wallets cannot exceed C grade
  if (pennyRatio >= 0.8 && receiveOnlyPenalty > 0) {
    gatedScore = Math.min(gatedScore, 49); // cap at D
  }

  const trustGrade = gradeFromScore(gatedScore);
  const trustTier = totalDataPoints < 5 ? 'UNPROVEN' : tierFromGrade(trustGrade);

  // --- SIGNALS ---
  const reasoning: string[] = [];
  const flags: string[] = [];
  const greenFlags: string[] = [];

  if (resolvedBets.length >= 10) {
    if (calibrationReport.brierScore < 0.2) greenFlags.push(`Strong Brier score: ${calibrationReport.brierScore}`);
    if (calibrationReport.brierScore > 0.35) flags.push(`Weak Brier score: ${calibrationReport.brierScore}`);
    if (calibrationReport.overconfidenceBias > 0.1) flags.push(`Overconfidence bias: ${calibrationReport.overconfidenceBias.toFixed(3)}`);
    if (calibrationReport.overconfidenceBias < -0.05) greenFlags.push(`Conservative (underconfident) bias`);
    if (calibrationReport.skillDecomposition.skill > 60) greenFlags.push(`Genuine predictive skill detected (${calibrationReport.skillDecomposition.skill}/100)`);
    if (calibrationReport.skillDecomposition.luck > 70) flags.push(`High luck component: ${calibrationReport.skillDecomposition.luck}/100 — returns may not persist`);
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
  if (resolvedBets.length < 10) flags.push(`Thin resolved data: only ${resolvedBets.length} resolved bets`);

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

    reasoning.push(
      `On-chain verification: wallet age ${provenance.walletAgeDays} days, ${provenance.totalTransactions} txs, provenance grade ${provenance.provenanceGrade}.`,
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
