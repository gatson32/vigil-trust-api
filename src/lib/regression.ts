// VIGIL Proprietary — Performance Regression & Model Drift Detector
// Catches performance degradation post-model-update via rolling statistical analysis
// PostgreSQL-backed with in-memory fallback
// Patent-pending scoring methodology. All rights reserved.

import type { ScoredAgent } from './scoring.js';
import { isDbConnected, query } from './db.js';

// ─── Types ──────────────────────────────────────────────────────────

export interface RegressionResult {
  regressionScore: number;         // 0-100 (100 = stable, 0 = severe regression)
  regressionDetected: boolean;
  regressionSeverity: 'none' | 'minor' | 'moderate' | 'severe' | 'critical';
  alerts: RegressionAlert[];
  trend: TrendAnalysis;
  performanceGrade: 'A' | 'B' | 'C' | 'D' | 'F';
}

export interface RegressionAlert {
  type: RegressionAlertType;
  severity: 'info' | 'warning' | 'critical';
  description: string;
  metric: string;
  currentValue: number;
  baselineValue: number;
  changePercent: number;
  window: string;
}

export type RegressionAlertType =
  | 'SUCCESS_RATE_DROP'
  | 'LATENCY_INCREASE'
  | 'ERROR_PATTERN_CHANGE'
  | 'VOLUME_COLLAPSE'
  | 'QUALITY_DEGRADATION'
  | 'RELIABILITY_CLIFF';

export interface TrendAnalysis {
  direction: 'improving' | 'stable' | 'declining' | 'volatile';
  momentum: number;
  volatility: number;
  daysUntilCritical: number | null;
}

// ─── Performance History Store (in-memory fallback) ────────────────

interface PerformanceSnapshot {
  timestamp: number;
  trustScore: number;
  successRate: number;
  activityScore: number;
  reliabilityScore: number;
  txVolume: number;
}

const performanceHistory = new Map<string, PerformanceSnapshot[]>();
const MAX_HISTORY = 336; // 14 days at 1 snapshot/hour

// ─── Recording ──────────────────────────────────────────────────────

/**
 * Record a performance snapshot for regression tracking.
 */
export async function recordPerformance(agent: ScoredAgent): Promise<void> {
  const key = agent.walletAddress.toLowerCase();
  const now = Date.now();

  // In-memory dedup check
  const history = performanceHistory.get(key) || [];
  const last = history[history.length - 1];
  if (last && (now - last.timestamp) < 30 * 60 * 1000) return;

  const snapshot: PerformanceSnapshot = {
    timestamp: now,
    trustScore: agent.trustScore,
    successRate: agent.successRate,
    activityScore: agent.activityScore,
    reliabilityScore: agent.reliabilityScore,
    txVolume: agent.transactionCount,
  };

  // Persist to DB
  if (isDbConnected()) {
    await query(
      `INSERT INTO regression_snapshots (wallet_address, trust_score, success_rate, activity_score, reliability, tx_volume)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [key, snapshot.trustScore, snapshot.successRate, snapshot.activityScore, snapshot.reliabilityScore, snapshot.txVolume],
    );
  }

  // In-memory storage
  if (!performanceHistory.has(key)) {
    performanceHistory.set(key, []);
  }
  performanceHistory.get(key)!.push(snapshot);

  if (performanceHistory.get(key)!.length > MAX_HISTORY) {
    performanceHistory.set(key, performanceHistory.get(key)!.slice(-MAX_HISTORY));
  }
}

// ─── Analysis ───────────────────────────────────────────────────────

/**
 * Detect performance regressions by comparing recent behavior to baseline.
 */
export async function detectRegression(agent: ScoredAgent): Promise<RegressionResult> {
  const key = agent.walletAddress.toLowerCase();
  const alerts: RegressionAlert[] = [];

  await recordPerformance(agent);

  // Get history — prefer DB if connected, fall back to memory
  let history: PerformanceSnapshot[];

  if (isDbConnected()) {
    const dbResult = await query<{
      trust_score: number; success_rate: number;
      activity_score: number; reliability: number;
      tx_volume: number; created_at: Date;
    }>(
      `SELECT trust_score, success_rate, activity_score, reliability, tx_volume, created_at
       FROM regression_snapshots
       WHERE wallet_address = $1
       ORDER BY created_at ASC
       LIMIT $2`,
      [key, MAX_HISTORY],
    );

    if (dbResult && dbResult.rows.length > 0) {
      history = dbResult.rows.map(r => ({
        timestamp: new Date(r.created_at).getTime(),
        trustScore: r.trust_score,
        successRate: r.success_rate,
        activityScore: r.activity_score,
        reliabilityScore: r.reliability,
        txVolume: r.tx_volume,
      }));
    } else {
      history = performanceHistory.get(key) || [];
    }
  } else {
    history = performanceHistory.get(key) || [];
  }

  if (history.length < 3) {
    return {
      regressionScore: 100,
      regressionDetected: false,
      regressionSeverity: 'none',
      alerts: [],
      trend: { direction: 'stable', momentum: 0, volatility: 0, daysUntilCritical: null },
      performanceGrade: scoreToGrade(agent.trustScore),
    };
  }

  // Split history into baseline (older 75%) and recent (newest 25%)
  const splitIdx = Math.floor(history.length * 0.75);
  const baseline = history.slice(0, splitIdx);
  const recent = history.slice(splitIdx);

  const baselineAvg = computeAverages(baseline);
  const recentAvg = computeAverages(recent);

  // === Check 1: Trust Score Regression ===
  const trustDrop = baselineAvg.trustScore - recentAvg.trustScore;
  const trustDropPct = baselineAvg.trustScore > 0
    ? (trustDrop / baselineAvg.trustScore) * 100 : 0;

  if (trustDropPct > 5) {
    alerts.push({
      type: 'QUALITY_DEGRADATION',
      severity: trustDropPct > 15 ? 'critical' : 'warning',
      description: `Trust score declining: ${recentAvg.trustScore.toFixed(0)} vs ${baselineAvg.trustScore.toFixed(0)} baseline`,
      metric: 'trustScore',
      currentValue: recentAvg.trustScore,
      baselineValue: baselineAvg.trustScore,
      changePercent: -trustDropPct,
      window: `${recent.length} snapshots vs ${baseline.length} snapshots`,
    });
  }

  // === Check 2: Success Rate Drop ===
  const srDrop = baselineAvg.successRate - recentAvg.successRate;
  if (srDrop > 3) {
    alerts.push({
      type: 'SUCCESS_RATE_DROP',
      severity: srDrop > 10 ? 'critical' : 'warning',
      description: `Success rate dropped ${srDrop.toFixed(1)}% from baseline`,
      metric: 'successRate',
      currentValue: recentAvg.successRate,
      baselineValue: baselineAvg.successRate,
      changePercent: -srDrop,
      window: `${recent.length} vs ${baseline.length} snapshots`,
    });
  }

  // === Check 3: Reliability Cliff ===
  if (history.length >= 3) {
    const prev = history[history.length - 3];
    const curr = history[history.length - 1];
    const reliabilityDrop = prev.reliabilityScore - curr.reliabilityScore;

    if (reliabilityDrop > 15) {
      alerts.push({
        type: 'RELIABILITY_CLIFF',
        severity: 'critical',
        description: `Reliability plunged ${reliabilityDrop} points — possible model update or degradation`,
        metric: 'reliabilityScore',
        currentValue: curr.reliabilityScore,
        baselineValue: prev.reliabilityScore,
        changePercent: prev.reliabilityScore > 0 ? -(reliabilityDrop / prev.reliabilityScore * 100) : 0,
        window: 'last 3 snapshots',
      });
    }
  }

  // === Check 4: Volume Collapse ===
  if (baselineAvg.txVolume > 0) {
    const volumeChange = ((recentAvg.txVolume - baselineAvg.txVolume) / baselineAvg.txVolume) * 100;
    if (volumeChange < -40) {
      alerts.push({
        type: 'VOLUME_COLLAPSE',
        severity: volumeChange < -70 ? 'critical' : 'warning',
        description: `Transaction volume dropped ${Math.abs(volumeChange).toFixed(0)}% from baseline`,
        metric: 'txVolume',
        currentValue: recentAvg.txVolume,
        baselineValue: baselineAvg.txVolume,
        changePercent: volumeChange,
        window: `${recent.length} vs ${baseline.length} snapshots`,
      });
    }
  }

  // === Trend Analysis ===
  const trend = analyzeTrend(history);

  // === Composite Regression Score ===
  let regressionScore = 100;
  for (const alert of alerts) {
    const penalty = alert.severity === 'critical' ? 25 : alert.severity === 'warning' ? 12 : 5;
    regressionScore -= penalty;
  }
  regressionScore = Math.max(0, Math.min(100, regressionScore));

  let regressionSeverity: RegressionResult['regressionSeverity'] = 'none';
  if (regressionScore < 25) regressionSeverity = 'critical';
  else if (regressionScore < 50) regressionSeverity = 'severe';
  else if (regressionScore < 70) regressionSeverity = 'moderate';
  else if (regressionScore < 85) regressionSeverity = 'minor';

  return {
    regressionScore,
    regressionDetected: regressionScore < 80,
    regressionSeverity,
    alerts,
    trend,
    performanceGrade: scoreToGrade(agent.trustScore),
  };
}

// ─── Trend Computation ──────────────────────────────────────────────

function analyzeTrend(history: PerformanceSnapshot[]): TrendAnalysis {
  if (history.length < 3) {
    return { direction: 'stable', momentum: 0, volatility: 0, daysUntilCritical: null };
  }

  const scores = history.map(h => h.trustScore);
  const n = scores.length;

  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += scores[i];
    sumXY += i * scores[i];
    sumX2 += i * i;
  }

  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const mean = sumY / n;

  const momentum = Math.max(-100, Math.min(100, Math.round(slope * 10)));

  const variance = scores.reduce((acc, s) => acc + Math.pow(s - mean, 2), 0) / n;
  const stddev = Math.sqrt(variance);
  const volatility = Math.min(100, Math.round(stddev * 2));

  let direction: TrendAnalysis['direction'];
  if (volatility > 20) direction = 'volatile';
  else if (momentum > 5) direction = 'improving';
  else if (momentum < -5) direction = 'declining';
  else direction = 'stable';

  let daysUntilCritical: number | null = null;
  if (slope < 0 && scores[scores.length - 1] > 30) {
    const pointsUntilCritical = scores[scores.length - 1] - 30;
    const snapshotsUntilCritical = pointsUntilCritical / Math.abs(slope);
    daysUntilCritical = Math.round(snapshotsUntilCritical / 24);
    if (daysUntilCritical > 365) daysUntilCritical = null;
  }

  return { direction, momentum, volatility, daysUntilCritical };
}

// ─── Helpers ────────────────────────────────────────────────────────

function computeAverages(snapshots: PerformanceSnapshot[]) {
  if (snapshots.length === 0) {
    return { trustScore: 0, successRate: 0, activityScore: 0, reliabilityScore: 0, txVolume: 0 };
  }

  const sum = snapshots.reduce((acc, s) => ({
    trustScore: acc.trustScore + s.trustScore,
    successRate: acc.successRate + s.successRate,
    activityScore: acc.activityScore + s.activityScore,
    reliabilityScore: acc.reliabilityScore + s.reliabilityScore,
    txVolume: acc.txVolume + s.txVolume,
  }), { trustScore: 0, successRate: 0, activityScore: 0, reliabilityScore: 0, txVolume: 0 });

  const n = snapshots.length;
  return {
    trustScore: sum.trustScore / n,
    successRate: sum.successRate / n,
    activityScore: sum.activityScore / n,
    reliabilityScore: sum.reliabilityScore / n,
    txVolume: sum.txVolume / n,
  };
}

function scoreToGrade(score: number): 'A' | 'B' | 'C' | 'D' | 'F' {
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 60) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

export async function getRegressionStats(): Promise<{
  trackedAgents: number;
  totalSnapshots: number;
  agentsWithAlerts: number;
  storageMode: 'postgresql' | 'memory';
}> {
  if (isDbConnected()) {
    const agents = await query<{ count: string }>(
      'SELECT COUNT(DISTINCT wallet_address) as count FROM regression_snapshots',
    );
    const total = await query<{ count: string }>(
      'SELECT COUNT(*) as count FROM regression_snapshots',
    );

    return {
      trackedAgents: agents ? parseInt(agents.rows[0].count) : 0,
      totalSnapshots: total ? parseInt(total.rows[0].count) : 0,
      agentsWithAlerts: 0, // TODO: track in DB
      storageMode: 'postgresql',
    };
  }

  // Fallback
  let total = 0;
  let withAlerts = 0;

  for (const history of performanceHistory.values()) {
    total += history.length;
    if (history.length >= 3) {
      const recent = history.slice(-3);
      const baseline = history.slice(0, -3);
      if (baseline.length > 0) {
        const baseAvg = baseline.reduce((a, b) => a + b.trustScore, 0) / baseline.length;
        const recentAvg = recent.reduce((a, b) => a + b.trustScore, 0) / recent.length;
        if (baseAvg - recentAvg > 5) withAlerts++;
      }
    }
  }

  return {
    trackedAgents: performanceHistory.size,
    totalSnapshots: total,
    agentsWithAlerts: withAlerts,
    storageMode: 'memory',
  };
}
