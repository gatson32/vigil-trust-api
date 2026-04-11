// VIGIL — Polymarket Prediction Market Adapter + Calibration Scoring
// The PROPRIETARY layer: calibration scoring measures genuine predictive
// skill vs. speed arb vs. luck. Nobody else computes this.
//
// Data sources:
//   gamma-api.polymarket.com — markets (active/resolved)
//   data-api.polymarket.com  — trades, positions, activity per wallet
//   clob.polymarket.com      — orderbook, prices (public)

import { TTLCache } from './cache.js';

const USER_AGENT = 'VIGIL-Trust/1.9.0 (vigil.trust; prediction-market-scoring)';
const GAMMA_BASE = 'https://gamma-api.polymarket.com';
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

export interface ResolvedMarket {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  outcomes: string[];         // ["Yes", "No"]
  outcomePrices: number[];    // [1, 0] for Yes resolution
  closed: boolean;
  endDate: string;
  volume: number;
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
  calibration: number;      // PROPRIETARY: how well-calibrated (30%)
  profitability: number;    // risk-adjusted PnL (20%)
  consistency: number;      // return stability (20%)
  discipline: number;       // sizing + diversification (15%)
  sampleSize: number;       // resolved bet count (15%)

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

  // Meta
  scoredAt: string;
  dataSource: 'polymarket-v1';
  disclaimer: string;
}

// ============================================================
//  CACHES
// ============================================================

const resolvedMarketsCache = new TTLCache<Map<string, ResolvedMarket>>(300); // 5 min
const RESOLVED_KEY = 'resolved-markets';

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
 * Fetch current positions for a wallet.
 */
export async function fetchPositions(wallet: string): Promise<PolymarketPosition[]> {
  const data = await fetchJson<PolymarketPosition[]>(
    `${DATA_BASE}/positions?user=${wallet}&limit=200`,
  );
  return Array.isArray(data) ? data : [];
}

/**
 * Fetch resolved markets (for calibration matching).
 * Caches for 5 minutes since resolutions don't change often.
 */
export async function fetchResolvedMarkets(limit = 1000): Promise<Map<string, ResolvedMarket>> {
  const cached = resolvedMarketsCache.get(RESOLVED_KEY);
  if (cached) return cached;

  const raw = await fetchJson<any[]>(
    `${GAMMA_BASE}/markets?limit=${limit}&closed=true&order=endDate&ascending=false`,
  );

  const map = new Map<string, ResolvedMarket>();
  for (const m of raw) {
    if (!m.conditionId) continue;
    const outcomes = JSON.parse(m.outcomes || '[]');
    const prices = JSON.parse(m.outcomePrices || '[]').map(Number);

    // A resolved market has one outcome at price ~1 and others at ~0
    const hasResolution = prices.some((p: number) => p > 0.9);
    if (!hasResolution) continue;

    map.set(m.conditionId, {
      id: m.id,
      question: m.question || '',
      conditionId: m.conditionId,
      slug: m.slug || '',
      outcomes,
      outcomePrices: prices,
      closed: true,
      endDate: m.endDate || '',
      volume: m.volumeNum || 0,
    });
  }

  resolvedMarketsCache.set(RESOLVED_KEY, map);
  return map;
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

function matchTradesAgainstResolutions(
  trades: PolymarketTrade[],
  resolved: Map<string, ResolvedMarket>,
): ResolvedBet[] {
  const bets: ResolvedBet[] = [];

  for (const t of trades) {
    if (t.side !== 'BUY') continue; // only score entry bets, not exits

    const market = resolved.get(t.conditionId);
    if (!market) continue; // market hasn't resolved yet

    // Determine if this bet was correct
    const resolutionPrices = market.outcomePrices;
    const winningIndex = resolutionPrices.findIndex(p => p > 0.9);
    const correct = t.outcomeIndex === winningIndex;

    // The price they paid IS their implied probability
    const impliedProb = t.price;

    // PnL: if correct, gained (1 - price) per share; if wrong, lost price per share
    const pnl = correct
      ? t.size * (1 - t.price)
      : t.size * (-t.price);

    bets.push({ impliedProb, correct, pnl, size: t.size });
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
  calibration: 0.30,
  profitability: 0.20,
  consistency: 0.20,
  discipline: 0.15,
  sampleSize: 0.15,
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
  // Fetch all data in parallel
  const [trades, positions, resolvedMarkets] = await Promise.all([
    fetchTrades(wallet),
    fetchPositions(wallet),
    fetchResolvedMarkets(),
  ]);

  if (trades.length === 0 && positions.length === 0) return null;

  // --- Match trades against resolved markets for calibration ---
  const resolvedBets = matchTradesAgainstResolutions(trades, resolvedMarkets);
  const calibrationReport = computeCalibration(resolvedBets);

  // --- Compute raw metrics ---
  const buyTrades = trades.filter(t => t.side === 'BUY');
  const uniqueMarkets = new Set(trades.map(t => t.conditionId)).size;
  const totalVolume = trades.reduce((s, t) => s + (t.usdcSize || t.size * t.price), 0);

  // PnL from positions
  const realizedPnl = positions.reduce((s, p) => s + (p.realizedPnl || 0), 0);
  const unrealizedPnl = positions.reduce((s, p) => s + (p.cashPnl || 0), 0);
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

  // --- COMPOSITE SCORE ---
  const trustScore = Math.round(
    calibrationDim * WEIGHTS.calibration +
    profitabilityDim * WEIGHTS.profitability +
    consistencyDim * WEIGHTS.consistency +
    disciplineDim * WEIGHTS.discipline +
    sampleSizeDim * WEIGHTS.sampleSize
  );

  // Sample-size gate (same as DegenClaw — can't grade what you can't measure)
  const gatedScore = resolvedBets.length < 5
    ? Math.min(trustScore, 35)
    : resolvedBets.length < 10
      ? Math.min(trustScore, 50)
      : trustScore;

  const trustGrade = gradeFromScore(gatedScore);
  const trustTier = resolvedBets.length < 5 ? 'UNPROVEN' : tierFromGrade(trustGrade);

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

  if (totalPnl > 0) greenFlags.push(`Net profitable: +$${Math.round(totalPnl)} total PnL`);
  if (totalPnl < -100) flags.push(`Net loss: -$${Math.round(Math.abs(totalPnl))} total PnL`);
  if (winRate > 0.6 && resolvedBets.length >= 10) greenFlags.push(`Strong win rate: ${(winRate * 100).toFixed(0)}%`);
  if (winRate < 0.4 && resolvedBets.length >= 10) flags.push(`Low win rate: ${(winRate * 100).toFixed(0)}%`);
  if (concentration > 0.5) flags.push(`Concentrated portfolio: ${(concentration * 100).toFixed(0)}% in single market`);
  if (uniqueMarkets >= 20) greenFlags.push(`Well-diversified: ${uniqueMarkets} unique markets`);
  if (resolvedBets.length < 10) flags.push(`Thin resolved data: only ${resolvedBets.length} resolved bets`);

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
    trustScore: gatedScore,
    trustGrade,
    trustTier,
    calibrationReport,
    reasoning,
    flags,
    greenFlags,
    scoredAt: new Date().toISOString(),
    dataSource: 'polymarket-v1',
    disclaimer: 'VIGIL Trust Score is informational only — not investment advice. Calibration scoring requires resolved markets and may not reflect recent performance.',
  };
}
