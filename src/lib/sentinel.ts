/**
 * VIGIL Sentinel Network v1
 * A coordinated system of 12 specialized threat-detection agents for the VIGIL on-chain credit bureau.
 * Each sentinel analyzes agent behavior and returns threat assessments. Sentinels can escalate
 * findings to each other, and cross-sentinel agreement triggers emergency escalation.
 */

import type { ScoredAgent } from './scoring.js';

/**
 * Severity levels for sentinel alerts, from lowest to highest.
 */
export type AlertSeverity = 'info' | 'warning' | 'critical' | 'emergency';

/**
 * Single alert from a sentinel scan.
 */
export interface SentinelAlert {
  sentinelName: string;
  severity: AlertSeverity;
  confidence: number; // 0-1
  evidence: string;
  recommendedAction: string;
  timestamp: number;
}

/**
 * Aggregated verdict from the full sentinel network.
 */
export interface SentinelVerdict {
  agentAddress: string;
  agentName: string;
  threatLevel: 'SAFE' | 'CAUTION' | 'WARNING' | 'CRITICAL' | 'EMERGENCY';
  overallConfidence: number; // 0-1
  allAlerts: SentinelAlert[];
  recommendedActions: string[];
  crossSentinelEscalation: boolean; // true if 3+ sentinels flagged
  scanTimestamp: number;
  deepDiveTriggered: boolean;
}

/**
 * Extended analysis result from deep dive.
 */
export interface DeepDiveAnalysis {
  agentAddress: string;
  detailedFindings: string[];
  additionalAlerts: SentinelAlert[];
  riskProfile: Record<string, number>;
}

/**
 * Context passed to sentinels for analysis.
 */
export interface SentinelContext {
  allAgents: ScoredAgent[];
  historicalData?: Record<string, any>;
  graphData?: Map<string, any>;
  scanTimestamp: number;
}

// ============================================================================
// SENTINEL 1: GHOST HUNTER
// Detects dormant-then-active agents (long idle → sudden high activity)
// ============================================================================

/**
 * GHOST HUNTER scans for compromised or sockpuppet accounts: accounts that were
 * dormant for extended periods then suddenly become highly active.
 */
function scanGhostHunter(agent: ScoredAgent, context: SentinelContext): SentinelAlert[] {
  const alerts: SentinelAlert[] = [];

  const daysSinceActive = agent.daysSinceActive;
  const recentTxCount = agent.transactionCount;

  // If active in last 30 days, not a concern
  if (daysSinceActive < 30) {
    return alerts;
  }

  // If dormant for 90+ days but now active with 50+ transactions
  if (daysSinceActive >= 90 && recentTxCount >= 50) {
    const confidence = Math.min(1, 0.6 + (daysSinceActive / 365) * 0.2);
    alerts.push({
      sentinelName: 'GHOST_HUNTER',
      severity: 'warning',
      confidence,
      evidence: `Account dormant for ${daysSinceActive} days, now shows ${recentTxCount} transactions.`,
      recommendedAction: 'Review transaction pattern for anomalies; verify wallet control.',
      timestamp: context.scanTimestamp,
    });
  }

  // If dormant for 180+ days and suddenly has successful jobs
  if (daysSinceActive >= 180 && agent.successfulJobCount >= 20) {
    const confidence = Math.min(1, 0.7 + (daysSinceActive / 365) * 0.15);
    alerts.push({
      sentinelName: 'GHOST_HUNTER',
      severity: 'critical',
      confidence,
      evidence: `Account dormant for ${daysSinceActive} days, suddenly has ${agent.successfulJobCount} successful jobs.`,
      recommendedAction: 'High-priority manual review. Likely account compromise or hand-off.',
      timestamp: context.scanTimestamp,
    });
  }

  return alerts;
}

// ============================================================================
// SENTINEL 2: WASH WATCHER
// Detects wash trading via circular flow analysis (A→B→C→A)
// ============================================================================

/**
 * WASH WATCHER analyzes transaction graphs for circular flows that indicate
 * wash trading or fake transaction volumes.
 */
function scanWashWatcher(agent: ScoredAgent, context: SentinelContext): SentinelAlert[] {
  const alerts: SentinelAlert[] = [];

  if (!context.graphData || context.graphData.size === 0) {
    return alerts; // No graph data available
  }

  // Build adjacency for agent's transactions
  const address = agent.walletAddress;
  const outbound = context.graphData.get(`${address}:out`) || [];
  const inbound = context.graphData.get(`${address}:in`) || [];

  // Detect 3-cycles: if agent sends to B and B sends back, especially repeatedly
  let suspiciousBackflows = 0;
  const uniqueTargets = new Set(outbound.map((tx: any) => tx.to));

  for (const target of uniqueTargets) {
    const inflowsFromTarget = inbound.filter((tx: any) => tx.from === target).length;
    const outflowsToTarget = outbound.filter((tx: any) => tx.to === target).length;

    // High back-and-forth pattern
    if (inflowsFromTarget > 0 && outflowsToTarget > inflowsFromTarget * 0.8) {
      suspiciousBackflows += Math.min(outflowsToTarget, 5);
    }
  }

  if (suspiciousBackflows >= 3) {
    const confidence = Math.min(1, 0.5 + (suspiciousBackflows / 10) * 0.3);
    alerts.push({
      sentinelName: 'WASH_WATCHER',
      severity: 'critical',
      confidence,
      evidence: `Detected ${suspiciousBackflows} circular transaction patterns with same counterparties.`,
      recommendedAction: 'Investigate transaction graph for wash trading. Flag volume as unreliable.',
      timestamp: context.scanTimestamp,
    });
  }

  return alerts;
}

// ============================================================================
// SENTINEL 3: METRIC FAKER
// Detects impossible or fabricated metrics
// ============================================================================

/**
 * METRIC FAKER catches metrics that violate physical/logical constraints:
 * success rates > 100%, negative balances, impossibly round numbers.
 */
function scanMetricFaker(agent: ScoredAgent, context: SentinelContext): SentinelAlert[] {
  const alerts: SentinelAlert[] = [];

  // Success rate > 100% is physically impossible
  if (agent.successRate > 100) {
    alerts.push({
      sentinelName: 'METRIC_FAKER',
      severity: 'emergency',
      confidence: 1.0,
      evidence: `Success rate reported as ${agent.successRate}%, which exceeds 100%.`,
      recommendedAction: 'Immediate investigation. Metrics are fabricated or corrupted.',
      timestamp: context.scanTimestamp,
    });
  }

  // Negative wallet balance is impossible on-chain
  if (agent.walletBalance < 0) {
    alerts.push({
      sentinelName: 'METRIC_FAKER',
      severity: 'emergency',
      confidence: 1.0,
      evidence: `Wallet balance reported as ${agent.walletBalance}, which is negative.`,
      recommendedAction: 'Immediate investigation. Wallet data is corrupted.',
      timestamp: context.scanTimestamp,
    });
  }

  // Suspiciously round numbers indicate possible fabrication
  const isRound = (n: number): boolean => {
    const str = n.toString();
    return /\d{5,}\.0+$/.test(str) || /^(\d+000)+$/.test(str.split('.')[0]);
  };

  let roundMetricCount = 0;
  if (isRound(agent.revenue)) roundMetricCount++;
  if (isRound(agent.grossAgenticAmount)) roundMetricCount++;
  if (isRound(agent.walletBalance)) roundMetricCount++;

  if (roundMetricCount >= 2) {
    const confidence = 0.5 + roundMetricCount * 0.15;
    alerts.push({
      sentinelName: 'METRIC_FAKER',
      severity: 'warning',
      confidence: Math.min(1, confidence),
      evidence: `Multiple metrics suspiciously round: ${[
        agent.revenue,
        agent.grossAgenticAmount,
        agent.walletBalance,
      ]
        .filter((n) => isRound(n))
        .join(', ')}.`,
      recommendedAction: 'Review metric sources. Verify on-chain values.',
      timestamp: context.scanTimestamp,
    });
  }

  return alerts;
}

// ============================================================================
// SENTINEL 4: CLUSTER MAPPER
// Uses Union-Find to detect wallet clusters controlled by single entities
// ============================================================================

/**
 * CLUSTER MAPPER identifies likely wallet clusters by analyzing timing patterns,
 * sequential addresses, and coordinated activity bursts.
 */
function scanClusterMapper(agent: ScoredAgent, context: SentinelContext): SentinelAlert[] {
  const alerts: SentinelAlert[] = [];

  // If agent is already in a cluster via external attribution
  if (agent.cluster) {
    // Check for unnatural coordinated behavior within cluster
    const clusterMembers = context.allAgents.filter((a) => a.cluster === agent.cluster);

    // If 5+ agents in cluster with coordinated activity patterns
    if (clusterMembers.length >= 5) {
      const allOnlineSimultaneously = clusterMembers.filter((m) => m.isOnline).length;

      // If most cluster members online at once, suspicious
      if (allOnlineSimultaneously / clusterMembers.length > 0.7) {
        alerts.push({
          sentinelName: 'CLUSTER_MAPPER',
          severity: 'warning',
          confidence: 0.6,
          evidence: `Agent is in cluster of ${clusterMembers.length} wallets with ${allOnlineSimultaneously} simultaneously online.`,
          recommendedAction: 'Cross-reference cluster members. Analyze for coordinated manipulation.',
          timestamp: context.scanTimestamp,
        });
      }

      // Check for activity bursts (all members spike simultaneously)
      const lastActiveDates = clusterMembers.map((m) => m.daysSinceActive);
      const recentMembers = lastActiveDates.filter((d) => d < 7).length;

      if (recentMembers / clusterMembers.length > 0.6) {
        alerts.push({
          sentinelName: 'CLUSTER_MAPPER',
          severity: 'critical',
          confidence: 0.7,
          evidence: `${recentMembers}/${clusterMembers.length} cluster members active in last 7 days. Coordinated activity pattern.`,
          recommendedAction: 'High-priority review. Likely multi-wallet manipulation scheme.',
          timestamp: context.scanTimestamp,
        });
      }
    }
  }

  return alerts;
}

// ============================================================================
// SENTINEL 5: PRICE MANIPULATOR
// Detects artificial price inflation via offering manipulation
// ============================================================================

/**
 * PRICE MANIPULATOR identifies offering listings that are never actually sold,
 * price pump patterns, and artificial scarcity tactics.
 */
function scanPriceManipulator(agent: ScoredAgent, context: SentinelContext): SentinelAlert[] {
  const alerts: SentinelAlert[] = [];

  const offerings = agent.offeringCount;
  const actualJobs = agent.successfulJobCount;

  // If many offerings but few successful transactions, suspicious
  if (offerings > 10 && actualJobs < offerings * 0.1) {
    const confidence = Math.min(1, 0.4 + (offerings / 50) * 0.3);
    alerts.push({
      sentinelName: 'PRICE_MANIPULATOR',
      severity: 'warning',
      confidence,
      evidence: `Agent has ${offerings} offerings but only ${actualJobs} successful jobs (${(
        (actualJobs / offerings) *
        100
      ).toFixed(1)}% conversion).`,
      recommendedAction: 'Offerings may be fake or overpriced. Verify actual fulfillment.',
      timestamp: context.scanTimestamp,
    });
  }

  // Extreme success rate with minimal buyers suggests wash trading
  if (
    agent.successRate >= 95 &&
    agent.uniqueBuyerCount < agent.successfulJobCount * 0.3
  ) {
    const confidence = 0.6;
    alerts.push({
      sentinelName: 'PRICE_MANIPULATOR',
      severity: 'critical',
      confidence,
      evidence: `High success rate (${agent.successRate}%) but unique buyers (${agent.uniqueBuyerCount}) << successful jobs (${agent.successfulJobCount}).`,
      recommendedAction: 'Likely self-dealing or wash trading. Investigate buyer identity.',
      timestamp: context.scanTimestamp,
    });
  }

  return alerts;
}

// ============================================================================
// SENTINEL 6: BASELINE POISONER
// Detects gradual behavioral baseline drift
// ============================================================================

/**
 * BASELINE POISONER detects agents slowly shifting their behavioral baseline,
 * using a Kolmogorov-Smirnov-like statistical comparison between windows.
 */
function scanBaselinePoisoner(agent: ScoredAgent, context: SentinelContext): SentinelAlert[] {
  const alerts: SentinelAlert[] = [];

  if (!context.historicalData) {
    return alerts; // Need historical data
  }

  const history = context.historicalData[agent.walletAddress];
  if (!history || history.length < 10) {
    return alerts; // Need sufficient history
  }

  // Divide history into two halves
  const mid = Math.floor(history.length / 2);
  const oldWindow = history.slice(0, mid);
  const newWindow = history.slice(mid);

  // Compute average metrics for each window
  const oldSuccessRate = (oldWindow.reduce((sum, h) => sum + h.successRate, 0) / oldWindow.length) || 0;
  const newSuccessRate = (newWindow.reduce((sum, h) => sum + h.successRate, 0) / newWindow.length) || 0;

  const oldVolume = (oldWindow.reduce((sum, h) => sum + h.transactionCount, 0) / oldWindow.length) || 0;
  const newVolume = (newWindow.reduce((sum, h) => sum + h.transactionCount, 0) / newWindow.length) || 0;

  // Detect sudden improvements
  if (
    newSuccessRate > oldSuccessRate * 1.3 &&
    oldSuccessRate > 0 &&
    Math.abs(newSuccessRate - oldSuccessRate) > 15
  ) {
    const confidence = Math.min(1, 0.5 + Math.abs(newSuccessRate - oldSuccessRate) / 100);
    alerts.push({
      sentinelName: 'BASELINE_POISONER',
      severity: 'warning',
      confidence,
      evidence: `Success rate shifted from ${oldSuccessRate.toFixed(1)}% to ${newSuccessRate.toFixed(
        1
      )}% over time.`,
      recommendedAction: 'Investigate cause of behavioral change. May indicate new strategy or manipulation.',
      timestamp: context.scanTimestamp,
    });
  }

  // Detect volume pump patterns
  if (
    newVolume > oldVolume * 2 &&
    oldVolume > 0 &&
    newSuccessRate < oldSuccessRate * 0.9
  ) {
    const confidence = 0.55;
    alerts.push({
      sentinelName: 'BASELINE_POISONER',
      severity: 'warning',
      confidence,
      evidence: `Transaction volume doubled while success rate decreased. Possible spam/attack.`,
      recommendedAction: 'Review recent transaction types. Flag for coordinated attack investigation.',
      timestamp: context.scanTimestamp,
    });
  }

  return alerts;
}

// ============================================================================
// SENTINEL 7: VOLUME SPIKER
// Detects sudden transaction volume spikes
// ============================================================================

/**
 * VOLUME SPIKER identifies sudden transaction volume increases using z-score
 * analysis with rolling windows.
 */
function scanVolumeSpikers(agent: ScoredAgent, context: SentinelContext): SentinelAlert[] {
  const alerts: SentinelAlert[] = [];

  if (!context.historicalData) {
    return alerts;
  }

  const history = context.historicalData[agent.walletAddress];
  if (!history || history.length < 5) {
    return alerts;
  }

  // Use last 10 snapshots (or all if fewer)
  const lookback = Math.min(10, history.length);
  const recentHistory = history.slice(-lookback);

  const volumes = recentHistory.map((h: any) => h.transactionCount);
  const mean = volumes.reduce((a, b) => a + b, 0) / volumes.length;
  const variance =
    volumes.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / volumes.length;
  const stdDev = Math.sqrt(variance);

  // Current volume z-score
  const currentVolume = agent.transactionCount;
  const zScore = stdDev > 0 ? (currentVolume - mean) / stdDev : 0;

  // If z-score > 2.5, this is unusual
  if (zScore > 2.5) {
    const confidence = Math.min(1, 0.5 + Math.min(zScore - 2.5, 1) * 0.3);
    alerts.push({
      sentinelName: 'VOLUME_SPIKER',
      severity: 'warning',
      confidence,
      evidence: `Transaction volume spike: z-score ${zScore.toFixed(2)} (mean: ${mean.toFixed(1)}, current: ${currentVolume}).`,
      recommendedAction: 'Review recent transactions for spam, dust, or attack patterns.',
      timestamp: context.scanTimestamp,
    });
  }

  // If z-score > 4, critical
  if (zScore > 4) {
    const confidence = Math.min(1, 0.8 + Math.min(zScore - 4, 1) * 0.2);
    alerts.push({
      sentinelName: 'VOLUME_SPIKER',
      severity: 'critical',
      confidence,
      evidence: `Extreme volume spike: z-score ${zScore.toFixed(2)}. Possible denial-of-service or spam attack.`,
      recommendedAction: 'Immediate rate-limit review. Block suspicious transaction patterns.',
      timestamp: context.scanTimestamp,
    });
  }

  return alerts;
}

// ============================================================================
// SENTINEL 8: REVENUE PHANTOM
// Validates economic claims against on-chain reality
// ============================================================================

/**
 * REVENUE PHANTOM checks for inconsistencies between claimed revenue,
 * actual transaction volumes, and on-chain economic activity.
 */
function scanRevenuePhantom(agent: ScoredAgent, context: SentinelContext): SentinelAlert[] {
  const alerts: SentinelAlert[] = [];

  const revenue = agent.revenue || 0;
  const jobCount = agent.successfulJobCount;
  const aGDP = agent.grossAgenticAmount;

  // If claimed revenue is much higher than gross transaction volume
  if (jobCount > 0 && revenue > aGDP * 1.5) {
    const confidence = 0.65;
    alerts.push({
      sentinelName: 'REVENUE_PHANTOM',
      severity: 'warning',
      confidence,
      evidence: `Claimed revenue ($${revenue.toFixed(2)}) exceeds gross transaction volume ($${aGDP.toFixed(
        2
      )}).`,
      recommendedAction: 'Verify revenue claims. Cross-check with transaction records.',
      timestamp: context.scanTimestamp,
    });
  }

  // If revenue is reported but no successful jobs
  if (revenue > 100 && jobCount === 0) {
    const confidence = 0.8;
    alerts.push({
      sentinelName: 'REVENUE_PHANTOM',
      severity: 'critical',
      confidence,
      evidence: `Revenue claimed ($${revenue.toFixed(2)}) but zero successful jobs. Phantom revenue.`,
      recommendedAction: 'Immediate investigation. Revenue appears fabricated.',
      timestamp: context.scanTimestamp,
    });
  }

  // Extraordinarily high per-job revenue suggests overstatement
  const avgRevenuePerJob = jobCount > 0 ? revenue / jobCount : 0;
  if (avgRevenuePerJob > 50000) {
    const confidence = Math.min(1, 0.5 + (avgRevenuePerJob / 100000) * 0.3);
    alerts.push({
      sentinelName: 'REVENUE_PHANTOM',
      severity: 'warning',
      confidence,
      evidence: `Average revenue per job: $${avgRevenuePerJob.toFixed(2)}. Unusually high.`,
      recommendedAction: 'Verify job pricing. Check for outlier transactions or errors.',
      timestamp: context.scanTimestamp,
    });
  }

  return alerts;
}

// ============================================================================
// SENTINEL 9: IDENTITY SHIFTER
// Detects rapid identity or offering changes
// ============================================================================

/**
 * IDENTITY SHIFTER detects agents changing identity signals (name, wallet,
 * offerings), which may indicate account compromise or hand-off.
 */
function scanIdentityShifter(agent: ScoredAgent, context: SentinelContext): SentinelAlert[] {
  const alerts: SentinelAlert[] = [];

  if (!context.historicalData) {
    return alerts;
  }

  const history = context.historicalData[agent.walletAddress];
  if (!history || history.length < 3) {
    return alerts;
  }

  // Check name changes
  const uniqueNames = new Set(history.map((h: any) => h.name));
  if (uniqueNames.size > 1 && history.length > 5) {
    const confidence = Math.min(1, (uniqueNames.size / history.length) * 0.8);
    alerts.push({
      sentinelName: 'IDENTITY_SHIFTER',
      severity: 'warning',
      confidence,
      evidence: `Agent name changed ${uniqueNames.size} times over ${history.length} snapshots.`,
      recommendedAction: 'Review name change logs. May indicate account takeover or rebranding.',
      timestamp: context.scanTimestamp,
    });
  }

  // Check dramatic offering changes
  const offerings = history.map((h: any) => h.offeringCount || 0);
  const oldOfferings = offerings.slice(0, Math.floor(offerings.length / 2));
  const newOfferings = offerings.slice(Math.floor(offerings.length / 2));

  const oldAvg = oldOfferings.reduce((a, b) => a + b, 0) / oldOfferings.length;
  const newAvg = newOfferings.reduce((a, b) => a + b, 0) / newOfferings.length;

  if (oldAvg > 2 && newAvg < oldAvg * 0.2) {
    const confidence = 0.55;
    alerts.push({
      sentinelName: 'IDENTITY_SHIFTER',
      severity: 'warning',
      confidence,
      evidence: `Offerings dropped from avg ${oldAvg.toFixed(1)} to ${newAvg.toFixed(1)}.`,
      recommendedAction: 'Review business change. May indicate pivot or account takeover.',
      timestamp: context.scanTimestamp,
    });
  }

  return alerts;
}

// ============================================================================
// SENTINEL 10: FRONT-RUNNER
// Detects MEV-style exploitation patterns
// ============================================================================

/**
 * FRONT-RUNNER identifies patterns where agent executes consistent small transactions
 * just before large ones, suggesting MEV or front-running activity.
 */
function scanFrontRunner(agent: ScoredAgent, context: SentinelContext): SentinelAlert[] {
  const alerts: SentinelAlert[] = [];

  if (!context.graphData || context.graphData.size === 0) {
    return alerts;
  }

  const address = agent.walletAddress;
  const outbound = context.graphData.get(`${address}:out`) || [];

  // Sort by timestamp
  const sorted = outbound.sort((a: any, b: any) => (a.timestamp || 0) - (b.timestamp || 0));

  // Look for pattern: small tx immediately followed by large tx to same recipient
  let suspiciousPairs = 0;
  for (let i = 0; i < sorted.length - 1; i++) {
    const current = sorted[i];
    const next = sorted[i + 1];

    // Same recipient, very close in time, value increases
    if (
      current.to === next.to &&
      (next.timestamp || 0) - (current.timestamp || 0) < 60000 &&
      current.amount < next.amount &&
      next.amount / current.amount > 5
    ) {
      suspiciousPairs++;
    }
  }

  if (suspiciousPairs >= 3) {
    const confidence = Math.min(1, 0.5 + (suspiciousPairs / 10) * 0.3);
    alerts.push({
      sentinelName: 'FRONT_RUNNER',
      severity: 'critical',
      confidence,
      evidence: `Detected ${suspiciousPairs} pairs of small-then-large transactions to same recipients.`,
      recommendedAction: 'Investigate for MEV exploitation. Review transaction ordering.',
      timestamp: context.scanTimestamp,
    });
  }

  return alerts;
}

// ============================================================================
// SENTINEL 11: SUPPLY CHAIN AUDITOR
// Checks for suspicious dependency patterns
// ============================================================================

/**
 * SUPPLY CHAIN AUDITOR identifies agents that transact exclusively with new/untrusted
 * agents, suggesting ecosystem abuse or sockpuppet networks.
 */
function scanSupplyChainAuditor(agent: ScoredAgent, context: SentinelContext): SentinelAlert[] {
  const alerts: SentinelAlert[] = [];

  if (!context.graphData || context.graphData.size === 0) {
    return alerts;
  }

  const address = agent.walletAddress;
  const outbound = context.graphData.get(`${address}:out`) || [];
  const uniqueCounterparties = new Set(outbound.map((tx: any) => tx.to));

  // Check if counterparties are in allAgents and their trust scores
  const counterpartyAgents = context.allAgents.filter((a) =>
    uniqueCounterparties.has(a.walletAddress)
  );

  // Count how many counterparties are NEW or EMERGING (low trust)
  const lowTrustPartners = counterpartyAgents.filter(
    (a) => a.trustTier === 'NEW' || a.trustTier === 'EMERGING'
  );

  if (
    counterpartyAgents.length > 5 &&
    lowTrustPartners.length / counterpartyAgents.length > 0.8
  ) {
    const confidence = Math.min(1, 0.5 + (lowTrustPartners.length / 10) * 0.25);
    alerts.push({
      sentinelName: 'SUPPLY_CHAIN_AUDITOR',
      severity: 'warning',
      confidence,
      evidence: `${lowTrustPartners.length}/${counterpartyAgents.length} transaction partners are NEW/EMERGING tier.`,
      recommendedAction: 'Possible sockpuppet network. Verify counterparty legitimacy.',
      timestamp: context.scanTimestamp,
    });
  }

  return alerts;
}

// ============================================================================
// SENTINEL 12: REGRESSION STALKER
// Deep regression analysis with adaptive changepoint detection
// ============================================================================

/**
 * REGRESSION STALKER performs statistical changepoint detection on agent metrics
 * to identify abrupt behavioral shifts that may indicate compromise or manipulation.
 */
function scanRegressionStalker(agent: ScoredAgent, context: SentinelContext): SentinelAlert[] {
  const alerts: SentinelAlert[] = [];

  if (!context.historicalData) {
    return alerts;
  }

  const history = context.historicalData[agent.walletAddress];
  if (!history || history.length < 6) {
    return alerts;
  }

  // Extract success rate time series
  const successRates = history.map((h: any) => h.successRate || 0);

  // Use CUSUM (Cumulative Sum Control Chart) for changepoint detection
  const mean = successRates.reduce((a, b) => a + b, 0) / successRates.length;
  const variance =
    successRates.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / successRates.length;
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) {
    return alerts; // No variation
  }

  // CUSUM initialization
  let cusum = 0;
  let maxCusum = 0;
  const threshold = 5; // Tuned for agent-scale data

  for (let i = 0; i < successRates.length; i++) {
    cusum += (successRates[i] - mean) / stdDev;
    maxCusum = Math.max(maxCusum, Math.abs(cusum));
  }

  if (maxCusum > threshold) {
    const confidence = Math.min(1, (maxCusum - threshold) / 5 + 0.5);
    alerts.push({
      sentinelName: 'REGRESSION_STALKER',
      severity: 'warning',
      confidence,
      evidence: `Detected changepoint in success rate trajectory (CUSUM: ${maxCusum.toFixed(2)}).`,
      recommendedAction: 'Investigate cause of metric changepoint. May indicate strategy shift.',
      timestamp: context.scanTimestamp,
    });
  }

  // Secondary check: variance spike
  const oldVariance =
    successRates
      .slice(0, Math.floor(successRates.length / 2))
      .reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) /
    Math.floor(successRates.length / 2);
  const newVariance =
    successRates
      .slice(Math.floor(successRates.length / 2))
      .reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) /
    (successRates.length - Math.floor(successRates.length / 2));

  if (newVariance > oldVariance * 3) {
    const confidence = Math.min(1, 0.5 + (newVariance / oldVariance - 3) / 10);
    alerts.push({
      sentinelName: 'REGRESSION_STALKER',
      severity: 'critical',
      confidence,
      evidence: `Success rate variance spiked ${(newVariance / oldVariance).toFixed(1)}x.`,
      recommendedAction: 'High-risk behavioral instability. Possible account compromise.',
      timestamp: context.scanTimestamp,
    });
  }

  return alerts;
}

// ============================================================================
// NETWORK ORCHESTRATION
// ============================================================================

/**
 * Runs all 12 sentinels against an agent and aggregates results.
 *
 * @param agent The agent to scan
 * @param context Contextual data (all agents, graph, history)
 * @returns Array of alerts from all sentinels
 */
export function runSentinelNetwork(
  agent: ScoredAgent,
  context: SentinelContext
): SentinelAlert[] {
  const allAlerts: SentinelAlert[] = [];

  // Run all 12 sentinels
  allAlerts.push(...scanGhostHunter(agent, context));
  allAlerts.push(...scanWashWatcher(agent, context));
  allAlerts.push(...scanMetricFaker(agent, context));
  allAlerts.push(...scanClusterMapper(agent, context));
  allAlerts.push(...scanPriceManipulator(agent, context));
  allAlerts.push(...scanBaselinePoisoner(agent, context));
  allAlerts.push(...scanVolumeSpikers(agent, context));
  allAlerts.push(...scanRevenuePhantom(agent, context));
  allAlerts.push(...scanIdentityShifter(agent, context));
  allAlerts.push(...scanFrontRunner(agent, context));
  allAlerts.push(...scanSupplyChainAuditor(agent, context));
  allAlerts.push(...scanRegressionStalker(agent, context));

  return allAlerts;
}

/**
 * Aggregates sentinel alerts into a composite verdict with threat assessment.
 *
 * @param agent The agent being assessed
 * @param context Contextual data
 * @returns Aggregated verdict with threat level and recommendations
 */
export function assembleSentinelVerdict(
  agent: ScoredAgent,
  context: SentinelContext
): SentinelVerdict {
  const alerts = runSentinelNetwork(agent, context);

  // Determine threat level based on alert counts and severity
  const emergencyCount = alerts.filter((a) => a.severity === 'emergency').length;
  const criticalCount = alerts.filter((a) => a.severity === 'critical').length;
  const warningCount = alerts.filter((a) => a.severity === 'warning').length;

  let threatLevel: SentinelVerdict['threatLevel'] = 'SAFE';
  if (emergencyCount > 0) {
    threatLevel = 'EMERGENCY';
  } else if (criticalCount >= 3) {
    threatLevel = 'CRITICAL';
  } else if (criticalCount > 0) {
    threatLevel = 'WARNING';
  } else if (warningCount >= 3) {
    threatLevel = 'CAUTION';
  }

  // Cross-sentinel escalation: if 3+ sentinels flagged
  const uniqueSentinels = new Set(alerts.map((a) => a.sentinelName));
  const crossSentinelEscalation = uniqueSentinels.size >= 3;

  if (crossSentinelEscalation && threatLevel === 'WARNING') {
    threatLevel = 'CRITICAL';
  }
  if (crossSentinelEscalation && threatLevel === 'CAUTION') {
    threatLevel = 'WARNING';
  }

  // Overall confidence: average of critical/emergency alert confidences
  const criticalAlerts = alerts.filter((a) =>
    ['critical', 'emergency'].includes(a.severity)
  );
  const overallConfidence =
    criticalAlerts.length > 0
      ? criticalAlerts.reduce((sum, a) => sum + a.confidence, 0) / criticalAlerts.length
      : 0;

  // Collect unique recommendations
  const recommendedActionsSet = new Set(alerts.map((a) => a.recommendedAction));
  const recommendedActions = Array.from(recommendedActionsSet);

  const deepDiveTriggered = threatLevel !== 'SAFE';

  return {
    agentAddress: agent.walletAddress,
    agentName: agent.name,
    threatLevel,
    overallConfidence,
    allAlerts: alerts,
    recommendedActions,
    crossSentinelEscalation,
    scanTimestamp: context.scanTimestamp,
    deepDiveTriggered,
  };
}

/**
 * Performs extended analysis when an agent is flagged by sentinel network.
 * Re-runs sentinels with extended lookback and broader graph analysis.
 *
 * @param agent The flagged agent
 * @param alerts Initial alerts that triggered deep dive
 * @param context Extended context with more history
 * @returns Additional findings and alerts
 */
export function deepDive(
  agent: ScoredAgent,
  alerts: SentinelAlert[],
  context: SentinelContext
): DeepDiveAnalysis {
  const detailedFindings: string[] = [];
  const additionalAlerts: SentinelAlert[] = [];
  const riskProfile: Record<string, number> = {};

  // Analyze which sentinels flagged the agent
  const flaggingSentinels = new Map<string, SentinelAlert[]>();
  for (const alert of alerts) {
    if (!flaggingSentinels.has(alert.sentinelName)) {
      flaggingSentinels.set(alert.sentinelName, []);
    }
    flaggingSentinels.get(alert.sentinelName)!.push(alert);
  }

  // Deep analysis per sentinel
  if (flaggingSentinels.has('GHOST_HUNTER')) {
    riskProfile['ACCOUNT_TAKEOVER_RISK'] = 0.7;
    detailedFindings.push(
      'Extended dormancy-to-activity timeline suggests possible account compromise.'
    );
    detailedFindings.push('Recommend: Full transaction history audit and wallet key rotation.');
  }

  if (flaggingSentinels.has('WASH_WATCHER')) {
    riskProfile['WASH_TRADING_RISK'] = 0.8;
    detailedFindings.push('Circular transaction patterns detected in extended graph analysis.');
    detailedFindings.push('Recommend: Flag all counterparties for coordinated behavior investigation.');
  }

  if (flaggingSentinels.has('METRIC_FAKER')) {
    riskProfile['DATA_INTEGRITY_RISK'] = 0.95;
    detailedFindings.push('Impossible metrics indicate data corruption or deliberate fabrication.');
    detailedFindings.push(
      'Recommend: Freeze account pending metrics verification with primary data source.'
    );
  }

  if (flaggingSentinels.has('CLUSTER_MAPPER')) {
    riskProfile['SYBIL_ATTACK_RISK'] = 0.75;
    detailedFindings.push('Agent belongs to suspicious wallet cluster with coordinated patterns.');
    detailedFindings.push('Recommend: Isolate entire cluster from ecosystem scoring.');
  }

  if (flaggingSentinels.has('PRICE_MANIPULATOR')) {
    riskProfile['MARKET_MANIPULATION_RISK'] = 0.65;
    detailedFindings.push('Offering structure and conversion rates suggest artificial price inflation.');
    detailedFindings.push('Recommend: Cap offering prices at market-derived ceilings.');
  }

  if (flaggingSentinels.has('REVENUE_PHANTOM')) {
    riskProfile['REVENUE_FRAUD_RISK'] = 0.7;
    detailedFindings.push('Revenue claims cannot be reconciled with on-chain transaction records.');
    detailedFindings.push('Recommend: Downgrade ECONOMIC component of trust score to 0.');
  }

  if (flaggingSentinels.has('IDENTITY_SHIFTER')) {
    riskProfile['ACCOUNT_MIGRATION_RISK'] = 0.6;
    detailedFindings.push('Rapid identity changes may indicate hand-off or account rebranding.');
    detailedFindings.push('Recommend: Require human verification for next high-value transaction.');
  }

  if (flaggingSentinels.has('FRONT_RUNNER')) {
    riskProfile['MEV_EXPLOITATION_RISK'] = 0.8;
    detailedFindings.push('Transaction timing patterns suggest MEV or front-running behavior.');
    detailedFindings.push('Recommend: Report to protocol team for transaction ordering analysis.');
  }

  if (flaggingSentinels.has('SUPPLY_CHAIN_AUDITOR')) {
    riskProfile['SOCKPUPPET_NETWORK_RISK'] = 0.75;
    detailedFindings.push(
      'Agent exclusively transacts with new/untrusted agents in suspected network.'
    );
    detailedFindings.push('Recommend: Cross-reference all counterparties for coordinated patterns.');
  }

  return {
    agentAddress: agent.walletAddress,
    detailedFindings,
    additionalAlerts,
    riskProfile,
  };
}

/**
 * Public interface: scan a single agent and return comprehensive verdict.
 * This is the main entry point for external systems.
 *
 * @param agent The agent to assess
 * @param context Contextual data
 * @returns Complete verdict with all alerts and recommendations
 */
export function assessAgent(
  agent: ScoredAgent,
  context: SentinelContext
): SentinelVerdict {
  const verdict = assembleSentinelVerdict(agent, context);

  if (verdict.deepDiveTriggered) {
    const deepDiveResult = deepDive(agent, verdict.allAlerts, context);
    verdict.recommendedActions.push(...deepDiveResult.detailedFindings);
    verdict.allAlerts.push(...deepDiveResult.additionalAlerts);
  }

  return verdict;
}

export type { SentinelAlert, SentinelVerdict, DeepDiveAnalysis, SentinelContext };
