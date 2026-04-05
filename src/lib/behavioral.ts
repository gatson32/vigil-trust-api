// VIGIL Proprietary — Behavioral Anomaly Detection Engine
// Detects compromised agents, model drift, and manipulation via on-chain pattern analysis
// Patent-pending scoring methodology. All rights reserved.

import type { ScoredAgent } from './scoring.js';

// ─── Types ──────────────────────────────────────────────────────────

export interface BehaviorProfile {
  walletAddress: string;
  windowStart: number;  // Unix ms
  windowEnd: number;
  // Transaction timing
  avgInterTxTimeMs: number;
  stddevInterTxTimeMs: number;
  // Activity patterns
  activeHoursDistribution: number[];  // 24 bins (hour of day)
  dayOfWeekDistribution: number[];    // 7 bins
  // Counterparty patterns
  uniqueCounterparties: number;
  topCounterpartyConcentration: number; // % of txs going to top counterparty
  newCounterpartyRate: number;          // % of txs with never-seen-before counterparties
  // Economic patterns
  avgTxValue: number;
  stddevTxValue: number;
  txValueDistribution: number[];  // 5 buckets: micro, small, medium, large, whale
}

export interface AnomalyResult {
  anomalyScore: number;           // 0-100 (100 = normal, 0 = extreme anomaly)
  driftDetected: boolean;
  driftSeverity: 'none' | 'low' | 'medium' | 'high' | 'critical';
  signals: AnomalySignal[];
  behaviorFingerprint: string;    // Hash of agent's typical behavior profile
}

export interface AnomalySignal {
  type: string;
  description: string;
  weight: number;     // How much this signal contributes to anomaly
  severity: 'info' | 'warning' | 'critical';
  value: number;      // Raw value
  baseline: number;   // Expected value
  deviation: number;  // How far off (standard deviations or %)
}

// ─── Behavior Store ─────────────────────────────────────────────────

const baselineProfiles = new Map<string, BehaviorProfile>();  // 90-day baselines
const recentProfiles = new Map<string, BehaviorProfile>();    // 7-day windows

// ─── Core Analysis Functions ────────────────────────────────────────

/**
 * Kullback-Leibler Divergence between two probability distributions
 * Measures how different a recent distribution is from a baseline
 * Lower = more similar. 0 = identical.
 */
function klDivergence(p: number[], q: number[]): number {
  if (p.length !== q.length || p.length === 0) return 0;

  const total_p = p.reduce((a, b) => a + b, 0);
  const total_q = q.reduce((a, b) => a + b, 0);

  if (total_p === 0 || total_q === 0) return 0;

  // Normalize to probability distributions with Laplace smoothing
  const epsilon = 1e-10;
  const pNorm = p.map(v => (v / total_p) + epsilon);
  const qNorm = q.map(v => (v / total_q) + epsilon);

  // Re-normalize after smoothing
  const sumP = pNorm.reduce((a, b) => a + b, 0);
  const sumQ = qNorm.reduce((a, b) => a + b, 0);

  let kl = 0;
  for (let i = 0; i < pNorm.length; i++) {
    const pi = pNorm[i] / sumP;
    const qi = qNorm[i] / sumQ;
    if (pi > 0 && qi > 0) {
      kl += pi * Math.log(pi / qi);
    }
  }

  return Math.max(0, kl);
}

/**
 * Jensen-Shannon Divergence — symmetric, bounded version of KL
 * Returns value between 0 (identical) and ln(2) (~0.693)
 */
function jsDivergence(p: number[], q: number[]): number {
  if (p.length !== q.length || p.length === 0) return 0;

  const total_p = p.reduce((a, b) => a + b, 0);
  const total_q = q.reduce((a, b) => a + b, 0);
  if (total_p === 0 || total_q === 0) return 0;

  const pNorm = p.map(v => v / total_p);
  const qNorm = q.map(v => v / total_q);
  const m = pNorm.map((pi, i) => (pi + qNorm[i]) / 2);

  return (klDivergence(pNorm, m) + klDivergence(qNorm, m)) / 2;
}

/**
 * Z-score: how many standard deviations a value is from baseline
 */
function zScore(value: number, mean: number, stddev: number): number {
  if (stddev === 0) return value === mean ? 0 : 3; // Cap at 3 if no variance
  return Math.abs((value - mean) / stddev);
}

// ─── Profile Builder ────────────────────────────────────────────────

/**
 * Build a behavior profile from scored agent data + transaction metadata
 * In production, this would consume raw on-chain tx data.
 * For now, we synthesize behavioral signals from available ACP data.
 */
export function buildProfileFromAgent(agent: ScoredAgent): BehaviorProfile {
  const now = Date.now();

  // Derive behavioral signals from available metrics
  const txPerDay = agent.transactionCount / Math.max(1, agent.accountAgeDays);
  const avgInterTxMs = txPerDay > 0 ? (24 * 60 * 60 * 1000) / txPerDay : Infinity;
  const avgTxValue = agent.transactionCount > 0
    ? agent.grossAgenticAmount / agent.transactionCount
    : 0;

  // Counterparty concentration from buyer data
  const buyerDensity = agent.transactionCount > 0
    ? agent.uniqueBuyerCount / agent.transactionCount
    : 0;
  const topConcentration = agent.uniqueBuyerCount > 0
    ? Math.max(0.1, 1 - Math.log(agent.uniqueBuyerCount + 1) / Math.log(1000))
    : 1.0;

  // Simulate distributions from available data (would be real tx data in production)
  const activityDist = new Array(24).fill(0);
  const dayDist = new Array(7).fill(0);
  const valueDist = [0, 0, 0, 0, 0]; // micro, small, medium, large, whale

  // Estimate distributions from job patterns
  if (agent.successfulJobCount > 0) {
    // Spread activity across hours (real data would be precise)
    for (let h = 0; h < 24; h++) {
      activityDist[h] = agent.isOnline ? 1 + Math.random() * 2 : Math.random();
    }
    for (let d = 0; d < 7; d++) {
      dayDist[d] = 1 + Math.random();
    }
    // Estimate value distribution from average
    if (avgTxValue < 1) valueDist[0] = agent.transactionCount;
    else if (avgTxValue < 100) valueDist[1] = agent.transactionCount;
    else if (avgTxValue < 10000) valueDist[2] = agent.transactionCount;
    else if (avgTxValue < 100000) valueDist[3] = agent.transactionCount;
    else valueDist[4] = agent.transactionCount;
  }

  return {
    walletAddress: agent.walletAddress,
    windowStart: now - 7 * 24 * 60 * 60 * 1000,
    windowEnd: now,
    avgInterTxTimeMs: avgInterTxMs,
    stddevInterTxTimeMs: avgInterTxMs * 0.3, // Estimated variance
    activeHoursDistribution: activityDist,
    dayOfWeekDistribution: dayDist,
    uniqueCounterparties: agent.uniqueBuyerCount,
    topCounterpartyConcentration: topConcentration,
    newCounterpartyRate: buyerDensity,
    avgTxValue,
    stddevTxValue: avgTxValue * 0.5, // Estimated variance
    txValueDistribution: valueDist,
  };
}

// ─── Anomaly Detection ──────────────────────────────────────────────

/**
 * Analyze an agent's recent behavior against their historical baseline.
 * Returns an anomaly score (100 = normal, 0 = extreme anomaly) with signals.
 */
export function detectAnomalies(agent: ScoredAgent): AnomalyResult {
  const key = agent.walletAddress.toLowerCase();
  const recent = buildProfileFromAgent(agent);

  // Get or create baseline
  let baseline = baselineProfiles.get(key);
  if (!baseline) {
    // First time seeing this agent — establish baseline
    baselineProfiles.set(key, recent);
    recentProfiles.set(key, recent);
    return {
      anomalyScore: 100,
      driftDetected: false,
      driftSeverity: 'none',
      signals: [],
      behaviorFingerprint: generateFingerprint(recent),
    };
  }

  const signals: AnomalySignal[] = [];

  // === Signal 1: Transaction Timing Drift ===
  if (baseline.avgInterTxTimeMs > 0 && baseline.avgInterTxTimeMs < Infinity) {
    const timingZ = zScore(
      recent.avgInterTxTimeMs,
      baseline.avgInterTxTimeMs,
      baseline.stddevInterTxTimeMs,
    );
    if (timingZ > 2) {
      signals.push({
        type: 'TIMING_DRIFT',
        description: `Transaction frequency shifted ${timingZ > 3 ? 'dramatically' : 'noticeably'} from baseline`,
        weight: 0.2,
        severity: timingZ > 3 ? 'critical' : 'warning',
        value: recent.avgInterTxTimeMs,
        baseline: baseline.avgInterTxTimeMs,
        deviation: timingZ,
      });
    }
  }

  // === Signal 2: Activity Pattern Shift (hour-of-day) ===
  const hourDrift = jsDivergence(
    recent.activeHoursDistribution,
    baseline.activeHoursDistribution,
  );
  if (hourDrift > 0.15) {
    signals.push({
      type: 'ACTIVITY_PATTERN_SHIFT',
      description: `Activity hours changed significantly (JS divergence: ${hourDrift.toFixed(3)})`,
      weight: 0.15,
      severity: hourDrift > 0.35 ? 'critical' : 'warning',
      value: hourDrift,
      baseline: 0,
      deviation: hourDrift / 0.15,
    });
  }

  // === Signal 3: Counterparty Concentration Change ===
  const concentrationChange = Math.abs(
    recent.topCounterpartyConcentration - baseline.topCounterpartyConcentration,
  );
  if (concentrationChange > 0.2) {
    const direction = recent.topCounterpartyConcentration > baseline.topCounterpartyConcentration
      ? 'concentrating' : 'diversifying';
    signals.push({
      type: 'COUNTERPARTY_SHIFT',
      description: `Agent is ${direction} counterparty interactions (${(concentrationChange * 100).toFixed(0)}% shift)`,
      weight: 0.2,
      severity: concentrationChange > 0.4 ? 'critical' : 'warning',
      value: recent.topCounterpartyConcentration,
      baseline: baseline.topCounterpartyConcentration,
      deviation: concentrationChange / 0.2,
    });
  }

  // === Signal 4: Transaction Value Distribution Shift ===
  const valueDrift = jsDivergence(
    recent.txValueDistribution,
    baseline.txValueDistribution,
  );
  if (valueDrift > 0.2) {
    signals.push({
      type: 'VALUE_DISTRIBUTION_SHIFT',
      description: `Transaction value pattern changed (JS divergence: ${valueDrift.toFixed(3)})`,
      weight: 0.25,
      severity: valueDrift > 0.4 ? 'critical' : 'warning',
      value: valueDrift,
      baseline: 0,
      deviation: valueDrift / 0.2,
    });
  }

  // === Signal 5: New Counterparty Surge ===
  if (recent.newCounterpartyRate > baseline.newCounterpartyRate * 2 && baseline.newCounterpartyRate > 0) {
    signals.push({
      type: 'NEW_COUNTERPARTY_SURGE',
      description: `Unusually high rate of new counterparties (${(recent.newCounterpartyRate * 100).toFixed(0)}% vs ${(baseline.newCounterpartyRate * 100).toFixed(0)}% baseline)`,
      weight: 0.15,
      severity: 'warning',
      value: recent.newCounterpartyRate,
      baseline: baseline.newCounterpartyRate,
      deviation: recent.newCounterpartyRate / Math.max(0.001, baseline.newCounterpartyRate),
    });
  }

  // === Signal 6: Sudden Volume Spike/Drop ===
  if (baseline.avgTxValue > 0) {
    const valueZ = zScore(recent.avgTxValue, baseline.avgTxValue, baseline.stddevTxValue);
    if (valueZ > 2.5) {
      signals.push({
        type: 'VOLUME_ANOMALY',
        description: `Average transaction value ${recent.avgTxValue > baseline.avgTxValue ? 'spiked' : 'dropped'} (${valueZ.toFixed(1)}σ from baseline)`,
        weight: 0.2,
        severity: valueZ > 4 ? 'critical' : 'warning',
        value: recent.avgTxValue,
        baseline: baseline.avgTxValue,
        deviation: valueZ,
      });
    }
  }

  // === Calculate composite anomaly score ===
  let totalWeight = 0;
  let weightedPenalty = 0;

  for (const signal of signals) {
    totalWeight += signal.weight;
    const severityMult = signal.severity === 'critical' ? 1.0 : signal.severity === 'warning' ? 0.6 : 0.3;
    weightedPenalty += signal.weight * severityMult * Math.min(1, signal.deviation / 3);
  }

  // Score: 100 = perfectly normal, 0 = extreme anomaly
  const anomalyScore = Math.max(0, Math.min(100, Math.round(100 - weightedPenalty * 100)));

  const driftDetected = anomalyScore < 70;
  let driftSeverity: AnomalyResult['driftSeverity'] = 'none';
  if (anomalyScore < 30) driftSeverity = 'critical';
  else if (anomalyScore < 50) driftSeverity = 'high';
  else if (anomalyScore < 70) driftSeverity = 'medium';
  else if (anomalyScore < 85) driftSeverity = 'low';

  // Update stored profiles
  recentProfiles.set(key, recent);

  // Slowly evolve baseline (exponential moving average)
  if (anomalyScore > 60) {
    // Only update baseline if behavior is not anomalous (avoid poisoning)
    const alpha = 0.05; // 5% weight to new data
    const evolved = blendProfiles(baseline, recent, alpha);
    baselineProfiles.set(key, evolved);
  }

  return {
    anomalyScore,
    driftDetected,
    driftSeverity,
    signals,
    behaviorFingerprint: generateFingerprint(recent),
  };
}

// ─── Utility ────────────────────────────────────────────────────────

function blendProfiles(a: BehaviorProfile, b: BehaviorProfile, alpha: number): BehaviorProfile {
  const blend = (x: number, y: number) => x * (1 - alpha) + y * alpha;
  const blendArr = (x: number[], y: number[]) =>
    x.map((v, i) => blend(v, y[i] || 0));

  return {
    ...a,
    avgInterTxTimeMs: blend(a.avgInterTxTimeMs, b.avgInterTxTimeMs),
    stddevInterTxTimeMs: blend(a.stddevInterTxTimeMs, b.stddevInterTxTimeMs),
    activeHoursDistribution: blendArr(a.activeHoursDistribution, b.activeHoursDistribution),
    dayOfWeekDistribution: blendArr(a.dayOfWeekDistribution, b.dayOfWeekDistribution),
    uniqueCounterparties: Math.round(blend(a.uniqueCounterparties, b.uniqueCounterparties)),
    topCounterpartyConcentration: blend(a.topCounterpartyConcentration, b.topCounterpartyConcentration),
    newCounterpartyRate: blend(a.newCounterpartyRate, b.newCounterpartyRate),
    avgTxValue: blend(a.avgTxValue, b.avgTxValue),
    stddevTxValue: blend(a.stddevTxValue, b.stddevTxValue),
    txValueDistribution: blendArr(a.txValueDistribution, b.txValueDistribution),
    windowEnd: b.windowEnd,
  };
}

function generateFingerprint(profile: BehaviorProfile): string {
  // Simple hash of key behavioral characteristics
  const key = [
    Math.round(profile.avgInterTxTimeMs / 1000),
    Math.round(profile.avgTxValue * 100),
    profile.uniqueCounterparties,
    Math.round(profile.topCounterpartyConcentration * 100),
    ...profile.txValueDistribution.map(v => Math.round(v)),
  ].join(':');

  // Simple hash
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    const char = key.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return `VBF-${Math.abs(hash).toString(16).padStart(8, '0')}`;
}

// ─── Exports for testing ────────────────────────────────────────────

export const _internal = {
  klDivergence,
  jsDivergence,
  zScore,
  blendProfiles,
  generateFingerprint,
};
