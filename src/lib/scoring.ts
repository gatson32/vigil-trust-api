// VIGIL Trust Score Algorithm v2 — Proprietary
// On-chain credit scoring with behavioral anomaly detection, task complexity
// analysis, economic sustainability scoring, sybil detection, and regression monitoring.
// Patent-pending methodology. All rights reserved.

export interface AgentRaw {
  id: number;
  documentId: string;
  name: string;
  description: string;
  walletAddress: string;
  profilePic: string | null;
  category: string;
  tokenAddress: string | null;
  symbol: string | null;
  twitterHandle: string | null;
  createdAt: string;
  updatedAt: string;
  lastActiveAt: string | null;
  successfulJobCount: number;
  successRate: number;
  uniqueBuyerCount: number;
  transactionCount: number;
  grossAgenticAmount: number;
  hasGraduated: boolean;
  walletBalance: string;
  isHighRisk: boolean | null;
  jobs: Array<{ id: number; name: string; type: string; price: number }>;
  resources: Array<unknown>;
  offerings: Array<{ id: number; name: string; price: number; priceUsd: number }>;
  enabledChains: Array<{ id: number; name: string }>;
  metrics: {
    successfulJobCount: number;
    successRate: number;
    uniqueBuyerCount: number;
    isOnline: boolean;
    minsFromLastOnlineTime: number;
    transactionCount: number;
    grossAgenticAmount: number;
    revenue: number | null;
    rating: number | null;
    lastActiveAt: string | null;
  };
  revenue: number | null;
  rating: number | null;
  role: string | null;
  cluster: string | null;
}

export interface ScoredAgent {
  // Identity
  name: string;
  documentId: string;
  walletAddress: string;
  profilePic: string | null;
  description: string;
  category: string;
  symbol: string | null;
  twitterHandle: string | null;
  cluster: string | null;
  role: string | null;
  hasGraduated: boolean;
  isOnline: boolean;

  // Raw metrics
  successRate: number;
  successfulJobCount: number;
  uniqueBuyerCount: number;
  transactionCount: number;
  grossAgenticAmount: number;
  walletBalance: number;
  jobCount: number;
  resourceCount: number;
  offeringCount: number;
  chainCount: number;
  accountAgeDays: number;
  daysSinceActive: number;
  revenue: number;

  // VIGIL Score Breakdown — Core Dimensions (each 0-100)
  reliabilityScore: number;   // success rate + job volume
  activityScore: number;      // recency + transaction volume
  economicScore: number;      // revenue + aGDP + wallet health
  reputationScore: number;    // unique buyers + graduation + offerings
  longevityScore: number;     // account age + consistency

  // VIGIL Score Breakdown — Proprietary Dimensions (each 0-100)
  behavioralScore: number;    // anomaly detection (100 = normal)
  complexityScore: number;    // task sophistication + execution quality
  sustainabilityScore: number; // unit economics + margin health
  sybilRiskScore: number;     // collusion/manipulation risk (0 = clean)
  regressionScore: number;    // performance stability (100 = stable)

  // Final
  trustScore: number;         // 0-100 composite (v2 algorithm)
  trustTier: 'ELITE' | 'TRUSTED' | 'ESTABLISHED' | 'EMERGING' | 'NEW' | 'INACTIVE' | 'HIGH_RISK';
  trustGrade: 'A' | 'B' | 'C' | 'D' | 'F';
  riskFlags: string[];
}

// VIGIL Trust Score v2 — Proprietary Weighted Algorithm
// Core dimensions (55% total) + Proprietary dimensions (45% total)
const WEIGHTS = {
  // Core (publicly observable metrics)
  reliability: 0.15,
  activity: 0.10,
  economic: 0.10,
  reputation: 0.10,
  longevity: 0.10,
  // Proprietary (VIGIL's competitive moat)
  behavioral: 0.10,      // Anomaly detection
  complexity: 0.10,      // Task sophistication
  sustainability: 0.10,  // Unit economics
  // Sybil + Regression are penalty/flag systems, not additive
};

// Normalize a value to 0-100 using logarithmic scaling for heavy-tailed distributions
function logNorm(value: number, _median: number, max: number): number {
  if (value <= 0) return 0;
  const normalized = Math.log(1 + value) / Math.log(1 + max);
  return Math.min(100, Math.round(normalized * 100));
}

// Linear normalize
function linearNorm(value: number, max: number): number {
  if (max <= 0) return 0;
  return Math.min(100, Math.round((value / max) * 100));
}

// Safe number coercion — returns 0 for NaN, null, undefined, non-numeric strings
function safeNum(val: unknown, fallback: number = 0): number {
  if (val === null || val === undefined) return fallback;
  const n = typeof val === 'string' ? parseFloat(val) : Number(val);
  return Number.isFinite(n) ? n : fallback;
}

// Validate that a date string parses to a valid timestamp
function safeDate(val: string | null | undefined): number | null {
  if (!val) return null;
  const ts = new Date(val).getTime();
  return Number.isFinite(ts) ? ts : null;
}

export async function scoreAgent(agent: AgentRaw): Promise<ScoredAgent> {
  const now = Date.now();
  const createdAt = safeDate(agent.createdAt) ?? now; // fallback to now if unparseable
  const lastActive = safeDate(agent.lastActiveAt) ?? createdAt;
  const accountAgeDays = Math.max(1, (now - createdAt) / (1000 * 60 * 60 * 24));
  const daysSinceActive = Math.max(0, (now - lastActive) / (1000 * 60 * 60 * 24));
  const walletBalance = safeNum(agent.walletBalance, 0);
  const revenue = safeNum(agent.revenue) || safeNum(agent.metrics?.revenue) || 0;
  const isOnline = agent.metrics?.isOnline === true;

  const riskFlags: string[] = [];

  // === Safe numeric extraction from raw agent ===
  const successRate = safeNum(agent.successRate);
  const successfulJobCount = safeNum(agent.successfulJobCount);
  const uniqueBuyerCount = safeNum(agent.uniqueBuyerCount);
  const transactionCount = safeNum(agent.transactionCount);
  const grossAgenticAmount = safeNum(agent.grossAgenticAmount);

  // === RELIABILITY (30%) ===
  // Success rate is the strongest signal
  const srScore = Math.min(100, Math.max(0, successRate)); // Clamp to 0-100
  // Volume matters — 1 job at 100% ≠ 10,000 jobs at 99%
  const volumeScore = logNorm(successfulJobCount, 100, 1_200_000);
  // Penalize zero jobs
  const reliabilityScore = successfulJobCount === 0
    ? 0
    : Math.round(srScore * 0.6 + volumeScore * 0.4);

  // === ACTIVITY (25%) ===
  // Recency — exponential decay
  let recencyScore: number;
  if (daysSinceActive <= 1) recencyScore = 100;
  else if (daysSinceActive <= 7) recencyScore = 85;
  else if (daysSinceActive <= 30) recencyScore = 60;
  else if (daysSinceActive <= 90) recencyScore = 30;
  else if (daysSinceActive <= 180) recencyScore = 10;
  else recencyScore = 0;

  const txScore = logNorm(transactionCount, 1000, 1_200_000);
  const onlineBonus = isOnline ? 10 : 0;
  const activityScore = Math.min(100, Math.round(recencyScore * 0.5 + txScore * 0.4 + onlineBonus));

  // === ECONOMIC (20%) ===
  const agdpScore = logNorm(grossAgenticAmount, 10000, 220_000_000);
  const revenueScore = logNorm(revenue, 1000, 600_000);
  const balanceScore = walletBalance > 0 ? Math.min(30, logNorm(walletBalance, 10, 10000)) : 0;
  const economicScore = Math.round(agdpScore * 0.5 + revenueScore * 0.35 + balanceScore * 0.15);

  // === REPUTATION (15%) ===
  const buyerScore = logNorm(uniqueBuyerCount, 100, 8000);
  const graduationBonus = agent.hasGraduated ? 20 : 0;
  const offeringScore = Math.min(30, (agent.offerings?.length || 0) * 10);
  const reputationScore = Math.min(100, Math.round(buyerScore * 0.5 + graduationBonus + offeringScore));

  // === LONGEVITY (10%) ===
  const ageScore = linearNorm(Math.min(accountAgeDays, 365), 365);
  // Consistency: active for a good portion of their lifespan
  const activeRatio = accountAgeDays > 0
    ? Math.max(0, 1 - (daysSinceActive / accountAgeDays))
    : 0;
  const consistencyScore = Math.round(activeRatio * 100);
  const longevityScore = Math.round(ageScore * 0.6 + consistencyScore * 0.4);

  // === PROPRIETARY DIMENSIONS (computed lazily for first-pass scoring) ===
  // These use the partially-scored agent to compute advanced metrics.
  // Build a partial agent for the proprietary modules to consume.
  const partialAgent: ScoredAgent = {
    name: agent.name,
    documentId: agent.documentId,
    walletAddress: agent.walletAddress,
    profilePic: agent.profilePic,
    description: agent.description || '',
    category: agent.category || 'UNKNOWN',
    symbol: agent.symbol,
    twitterHandle: agent.twitterHandle,
    cluster: agent.cluster,
    role: agent.role,
    hasGraduated: agent.hasGraduated,
    isOnline,
    successRate,
    successfulJobCount,
    uniqueBuyerCount,
    transactionCount,
    grossAgenticAmount,
    walletBalance,
    jobCount: agent.jobs?.length || 0,
    resourceCount: agent.resources?.length || 0,
    offeringCount: agent.offerings?.length || 0,
    chainCount: agent.enabledChains?.length || 0,
    accountAgeDays: Math.round(accountAgeDays),
    daysSinceActive: Math.round(daysSinceActive),
    revenue,
    reliabilityScore,
    activityScore,
    economicScore,
    reputationScore,
    longevityScore,
    // Placeholders — filled below
    behavioralScore: 100,
    complexityScore: 0,
    sustainabilityScore: 0,
    sybilRiskScore: 0,
    regressionScore: 100,
    trustScore: 0,
    trustTier: 'NEW',
    trustGrade: 'F',
    riskFlags: [],
  };

  // Proprietary scoring (safe imports — these are pure functions)
  let behavioralScore = 100;  // Default: no anomaly detected
  let complexityScore = 0;
  let sustainabilityScore = 0;
  let sybilRiskScore = 0;
  let regressionScore = 100;  // Default: stable

  try {
    // Dynamic lazy imports to avoid circular dependencies
    // These modules consume ScoredAgent but don't import scoring.ts
    const { detectAnomalies } = await import('./behavioral.js');
    const anomaly = detectAnomalies(partialAgent);
    behavioralScore = anomaly.anomalyScore;
    if (anomaly.driftDetected) {
      riskFlags.push(`BEHAVIORAL_DRIFT_${anomaly.driftSeverity.toUpperCase()}`);
    }
  } catch { behavioralScore = 100; } // Graceful fallback

  try {
    const { scoreComplexity } = await import('./complexity.js');
    const complexity = scoreComplexity(partialAgent);
    complexityScore = complexity.compositeScore;
  } catch { complexityScore = 50; }

  try {
    const { scoreEconomics } = await import('./economics.js');
    const economics = scoreEconomics(partialAgent);
    sustainabilityScore = economics.compositeScore;
    if (economics.grossMarginPercent < -20) {
      riskFlags.push('UNSUSTAINABLE_ECONOMICS');
    }
    if (economics.burnRate > 10) {
      riskFlags.push('HIGH_BURN_RATE');
    }
  } catch { sustainabilityScore = 50; }

  try {
    const { analyzeSybilRisk } = await import('./sybil.js');
    const sybil = analyzeSybilRisk(partialAgent);
    sybilRiskScore = sybil.sybilRiskScore;
    if (sybil.collusionDetected) {
      riskFlags.push('COLLUSION_SUSPECTED');
    }
    if (sybil.quarantineRecommended) {
      riskFlags.push('SYBIL_QUARANTINE');
    }
    for (const flag of sybil.flags) {
      if (flag.severity === 'critical') {
        riskFlags.push(`SYBIL_${flag.type}`);
      }
    }
  } catch { sybilRiskScore = 0; }

  try {
    const { detectRegression } = await import('./regression.js');
    const regression = detectRegression(partialAgent);
    regressionScore = regression.regressionScore;
    if (regression.regressionDetected) {
      riskFlags.push(`REGRESSION_${regression.regressionSeverity.toUpperCase()}`);
    }
  } catch { regressionScore = 100; }

  // === COMPOSITE SCORE v2 ===
  // Core dimensions (55%) + Proprietary dimensions (45%)
  let trustScore = Math.min(100, Math.round(
    // Core
    reliabilityScore * WEIGHTS.reliability +
    activityScore * WEIGHTS.activity +
    economicScore * WEIGHTS.economic +
    reputationScore * WEIGHTS.reputation +
    longevityScore * WEIGHTS.longevity +
    // Proprietary
    behavioralScore * WEIGHTS.behavioral +
    complexityScore * WEIGHTS.complexity +
    sustainabilityScore * WEIGHTS.sustainability
  ));

  // === PENALTY MODIFIERS (sybil + regression reduce score) ===
  if (sybilRiskScore >= 75) {
    trustScore = Math.min(trustScore, 15); // Hard cap: quarantine
  } else if (sybilRiskScore >= 50) {
    trustScore = Math.round(trustScore * 0.7); // 30% penalty
  } else if (sybilRiskScore >= 25) {
    trustScore = Math.round(trustScore * 0.9); // 10% penalty
  }

  if (regressionScore < 50) {
    trustScore = Math.round(trustScore * 0.85); // 15% penalty for severe regression
  }

  // === RISK FLAGS ===
  if (agent.isHighRisk) {
    riskFlags.push('FLAGGED_HIGH_RISK');
    trustScore = Math.min(trustScore, 20);
  }
  if (successRate < 50 && successfulJobCount > 100) {
    riskFlags.push('LOW_SUCCESS_RATE');
  }
  if (daysSinceActive > 90) {
    riskFlags.push('DORMANT');
  }
  if (successfulJobCount === 0 && transactionCount === 0) {
    riskFlags.push('NO_ACTIVITY');
  }
  if (walletBalance <= 0 && successfulJobCount > 0) {
    riskFlags.push('EMPTY_WALLET');
  }

  // Deduplicate flags
  const uniqueFlags = [...new Set(riskFlags)];

  // === TIER ===
  let trustTier: ScoredAgent['trustTier'];
  if (agent.isHighRisk) trustTier = 'HIGH_RISK';
  else if (daysSinceActive > 180 && successfulJobCount === 0) trustTier = 'INACTIVE';
  else if (trustScore >= 80) trustTier = 'ELITE';
  else if (trustScore >= 60) trustTier = 'TRUSTED';
  else if (trustScore >= 40) trustTier = 'ESTABLISHED';
  else if (trustScore >= 20) trustTier = 'EMERGING';
  else trustTier = 'NEW';

  // === GRADE (letter grade for quick readability) ===
  let trustGrade: ScoredAgent['trustGrade'];
  if (trustScore >= 90) trustGrade = 'A';
  else if (trustScore >= 75) trustGrade = 'B';
  else if (trustScore >= 60) trustGrade = 'C';
  else if (trustScore >= 40) trustGrade = 'D';
  else trustGrade = 'F';

  return {
    name: agent.name,
    documentId: agent.documentId,
    walletAddress: agent.walletAddress,
    profilePic: agent.profilePic,
    description: agent.description || '',
    category: agent.category || 'UNKNOWN',
    symbol: agent.symbol,
    twitterHandle: agent.twitterHandle,
    cluster: agent.cluster,
    role: agent.role,
    hasGraduated: agent.hasGraduated,
    isOnline,
    successRate,
    successfulJobCount,
    uniqueBuyerCount,
    transactionCount,
    grossAgenticAmount,
    walletBalance,
    jobCount: agent.jobs?.length || 0,
    resourceCount: agent.resources?.length || 0,
    offeringCount: agent.offerings?.length || 0,
    chainCount: agent.enabledChains?.length || 0,
    accountAgeDays: Math.round(accountAgeDays),
    daysSinceActive: Math.round(daysSinceActive),
    revenue,
    reliabilityScore,
    activityScore,
    economicScore,
    reputationScore,
    longevityScore,
    behavioralScore,
    complexityScore,
    sustainabilityScore,
    sybilRiskScore,
    regressionScore,
    trustScore,
    trustTier,
    trustGrade,
    riskFlags: uniqueFlags,
  };
}

// Tier config for UI
export const TIER_CONFIG = {
  ELITE:       { label: 'Elite',       color: '#00ff88', bg: 'rgba(0,255,136,0.1)', icon: '◆' },
  TRUSTED:     { label: 'Trusted',     color: '#00ccff', bg: 'rgba(0,204,255,0.1)', icon: '◇' },
  ESTABLISHED: { label: 'Established', color: '#ffaa00', bg: 'rgba(255,170,0,0.1)', icon: '○' },
  EMERGING:    { label: 'Emerging',    color: '#ff6600', bg: 'rgba(255,102,0,0.1)', icon: '△' },
  NEW:         { label: 'New',         color: '#888888', bg: 'rgba(136,136,136,0.1)', icon: '·' },
  INACTIVE:    { label: 'Inactive',    color: '#444444', bg: 'rgba(68,68,68,0.1)',  icon: '✕' },
  HIGH_RISK:   { label: 'High Risk',   color: '#ff0044', bg: 'rgba(255,0,68,0.1)',  icon: '⚠' },
} as const;
