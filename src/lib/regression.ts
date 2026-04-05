// VIGIL Proprietary — Performance Regression & Model Drift Detector
// Catches performance degradation post-model-update via rolling statistical analysis
// Patent-pending scoring methodology. All rights reserved.

import type { ScoredAgent } from './scoring.js';

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
  window: string;  // e.g., "7d vs 90d"
}

export type RegressionAlertType =
  | 'SUCCESS_RATE_DROP'      // Success rate declining
  | 'LATENCY_INCREASE'      // Slower execution
  | 'ERROR_PATTERN_CHANGE'  // Different types of errors appearing
  | 'VOLUME_COLLAPSE'       // Sudden drop in activity
  | 'QUALITY_DEGRADATION'   // Lower scores across dimensions
  | 'RELIABILITY_CLIFF';    // Sudden reliability drop (model update?)

export interface TrendAnalysis {
  direction: 'improving' | 'stable' | 'declining' | 'volatile';
  momentum: number;           // -100 to +100
  volatility: number;         // 0-100 (how unstable)
  daysUntilCritical: number | null;  // Projected days until score drops below threshold
}

// ─── Performance History Store ──────────────────────────────────────

interface PerformanceSnapshot {
  timestamp: number;
  trustScore: number;
  successRate: number;
  activityScore: number;
  reliabilityScore: number;
  txVolume: number;  // Transactions since last snapshot
}

const performanceHistory = new Map<string, PerformanceSnapshot[]>();
const MAX_HISTORY = 336; // 14 days at 1 snapshot/hour

// ─── Recording ──────────────────────────────────────────────────────

/**
 * Record a performance snapshot for regression tracking.
 */
export function recordPerformance(agent: ScoredAgent): void {
  const key = agent.walletAddress.toLowerCase();
  const now = Date.now();

  let history = performanceHistory.get(key);
  if (!history) {
    history = [];
    performanceHistory.set(key, history);
  }

  // Deduplicate: skip if last snapshot < 30 min ago
  const last = history[history.length - 1];
  if (last && (now - last.timestamp) < 30 * 60 * 1000) return;

  history.push({
    timestamp: now,
    trustScore: agent.trustScore,
    successRate: agent.successRate,
    activityScore: agent.activityScore,
    reliabilityScore: agent.reliabilityScore,
    txVolume: agent.transactionCount,
  });

  // Prune old
  if (history.length > MAX_HISTORY) {
    performanceHistory.set(key, history.slice(-MAX_HISTORY));
  }
}

// ─── Analysis ───────────────────────────────────────────────────────

/**
 * Detect performance regressions by comparing recent behavior to baseline.
 */
export function detectRegression(agent: ScoredAgent): RegressionResult {
  const key = agent.walletAddress.toLowerCase();
  const history = performanceHistory.get(key) || [];
  const alerts: RegressionAlert[] = [];

  // Record current state
  recordPerformance(agent);

  // Need at least some history to detect regression
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
    ? (trustDrop / baselineAvg.trustScore) * 100
    : 0;

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
  if (srDrop > 3) { // More than 3% absolute drop
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
  // Sudden drop (not gradual) — compare last 2 snapshots to one before
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
  // Recent transaction volume dramatically lower than baseline
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

  // Simple linear regression for trend
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += scores[i];
    sumXY += i * scores[i];
    sumX2 += i * i;
  }

  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const mean = sumY / n;

  // Momentum: normalized slope (-100 to +100)
  const momentum = Math.max(-100, Math.min(100, Math.round(slope * 10)));

  // Volatility: standard deviation of scores
  const variance = scores.reduce((acc, s) => acc + Math.pow(s - mean, 2), 0) / n;
  const stddev = Math.sqrt(variance);
  const volatility = Math.min(100, Math.round(stddev * 2));

  // Direction
  let direction: TrendAnalysis['direction'];
  if (volatility > 20) direction = 'volatile';
  else if (momentum > 5) direction = 'improving';
  else if (momentum < -5) direction = 'declining';
  else direction = 'stable';

  // Project days until critical (score < 30)
  let daysUntilCritical: number | null = null;
  if (slope < 0 && scores[scores.length - 1] > 30) {
    const pointsUntilCritical = scores[scores.length - 1] - 30;
    const snapshotsUntilCritical = pointsUntilCritical / Math.abs(slope);
    // Assume ~1 snapshot per hour
    daysUntilCritical = Math.round(snapshotsUntilCritical / 24);
    if (daysUntilCritical > 365) daysUntilCritical = null; // Too far out to predict
  }

  return { direction, momentum, volatility, daysUntilCritical };
}

// ─── Helpers ────────────────────────────────────────────────────────

function computeAverages(snapshots: PerformanceSnapshot[]): {
  trustScore: number;
  successRate: number;
  activityScore: number;
  reliabilityScore: number;
  txVolume: number;
} {
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

export function getRegressionStats(): {
  trackedAgents: number;
  totalSnapshots: number;
  agentsWithAlerts: number;
} {
  let total = 0;
  let withAlerts = 0;

  for (const history of performanceHistory.values()) {
    total += history.length;
    // Check if any recent regression
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
  };
}
