// VIGIL Proprietary — Task Complexity & Execution Sophistication Engine
// Weights job volume by difficulty — 100 simple swaps ≠ 10 complex multi-protocol ops
// Patent-pending scoring methodology. All rights reserved.

import type { ScoredAgent } from './scoring.js';

// ─── Types ──────────────────────────────────────────────────────────

export interface ComplexityProfile {
  // Raw metrics
  totalJobs: number;
  weightedJobScore: number;       // Complexity-adjusted job volume
  avgComplexity: number;          // Average complexity per job (1.0 = simple)
  maxComplexity: number;          // Highest complexity job completed
  complexityDistribution: ComplexityBucket[];

  // Derived scores (0-100)
  taskComplexityScore: number;    // How sophisticated is this agent?
  executionQualityScore: number;  // How well does it handle hard tasks?
  versatilityScore: number;       // Does it handle variety?
  compositeScore: number;         // Weighted blend
}

export interface ComplexityBucket {
  tier: 'trivial' | 'simple' | 'moderate' | 'complex' | 'expert';
  label: string;
  range: [number, number];        // Complexity multiplier range
  count: number;
  successRate: number;
}

// ─── Complexity Tiers ───────────────────────────────────────────────

const COMPLEXITY_TIERS = {
  trivial: { label: 'Trivial', range: [0, 1] as [number, number], weight: 0.5 },
  simple: { label: 'Simple', range: [1, 2] as [number, number], weight: 1.0 },
  moderate: { label: 'Moderate', range: [2, 4] as [number, number], weight: 2.5 },
  complex: { label: 'Complex', range: [4, 8] as [number, number], weight: 5.0 },
  expert: { label: 'Expert', range: [8, Infinity] as [number, number], weight: 10.0 },
};

// ─── Complexity Estimation ──────────────────────────────────────────

/**
 * Estimate job complexity from available on-chain signals.
 *
 * Complexity factors (multiplicative):
 * - Price tier: Higher-priced jobs tend to be more complex
 * - Offering diversity: Agents with many offerings handle varied tasks
 * - Cross-chain capability: Multi-chain agents handle more complex workflows
 * - Graduation status: Graduated agents are vetted for higher complexity
 * - Resource utilization: Agents with resources handle data-intensive tasks
 *
 * In production, this would analyze ACP smart contract calldata,
 * multi-step transaction sequences, and oracle dependencies.
 */
export function estimateJobComplexity(agent: ScoredAgent): {
  avgComplexity: number;
  distribution: Map<string, number>;
} {
  let baseComplexity = 1.0;

  // Factor 1: Price signal — higher-priced offerings suggest complexity
  if (agent.offeringCount > 0 && agent.grossAgenticAmount > 0) {
    const avgPrice = agent.grossAgenticAmount / Math.max(1, agent.transactionCount);
    if (avgPrice > 1000) baseComplexity *= 2.5;
    else if (avgPrice > 100) baseComplexity *= 1.8;
    else if (avgPrice > 10) baseComplexity *= 1.3;
  }

  // Factor 2: Offering diversity — more offerings = broader capability
  if (agent.offeringCount >= 5) baseComplexity *= 1.5;
  else if (agent.offeringCount >= 3) baseComplexity *= 1.2;

  // Factor 3: Multi-chain capability
  if (agent.chainCount > 3) baseComplexity *= 2.0;
  else if (agent.chainCount > 1) baseComplexity *= 1.4;

  // Factor 4: Graduation status (vetted agents handle harder tasks)
  if (agent.hasGraduated) baseComplexity *= 1.3;

  // Factor 5: Resource utilization (data-intensive operations)
  if (agent.resourceCount > 0) baseComplexity *= 1.2;

  // Factor 6: Buyer diversity — more buyers = market-proven complexity
  const buyerRatio = agent.uniqueBuyerCount / Math.max(1, agent.transactionCount);
  if (buyerRatio > 0.5) baseComplexity *= 1.3;
  else if (buyerRatio < 0.05) baseComplexity *= 0.7; // Low diversity = simple repeat tasks

  // Distribute across complexity tiers based on estimated avg
  const distribution = new Map<string, number>();
  const total = agent.successfulJobCount;

  if (baseComplexity <= 1.5) {
    distribution.set('trivial', Math.round(total * 0.5));
    distribution.set('simple', Math.round(total * 0.4));
    distribution.set('moderate', Math.round(total * 0.1));
  } else if (baseComplexity <= 3) {
    distribution.set('trivial', Math.round(total * 0.1));
    distribution.set('simple', Math.round(total * 0.3));
    distribution.set('moderate', Math.round(total * 0.4));
    distribution.set('complex', Math.round(total * 0.2));
  } else if (baseComplexity <= 6) {
    distribution.set('simple', Math.round(total * 0.1));
    distribution.set('moderate', Math.round(total * 0.3));
    distribution.set('complex', Math.round(total * 0.4));
    distribution.set('expert', Math.round(total * 0.2));
  } else {
    distribution.set('moderate', Math.round(total * 0.1));
    distribution.set('complex', Math.round(total * 0.3));
    distribution.set('expert', Math.round(total * 0.6));
  }

  return { avgComplexity: baseComplexity, distribution };
}

// ─── Scoring ────────────────────────────────────────────────────────

/**
 * Score an agent's task complexity profile.
 * Returns scores across three dimensions + composite.
 */
export function scoreComplexity(agent: ScoredAgent): ComplexityProfile {
  const { avgComplexity, distribution } = estimateJobComplexity(agent);

  // Build bucket stats
  const buckets: ComplexityBucket[] = Object.entries(COMPLEXITY_TIERS).map(([tier, config]) => ({
    tier: tier as ComplexityBucket['tier'],
    label: config.label,
    range: config.range,
    count: distribution.get(tier) || 0,
    // Estimate per-tier success rate (complex tasks fail more)
    successRate: tier === 'expert' ? agent.successRate * 0.85 :
      tier === 'complex' ? agent.successRate * 0.92 :
        agent.successRate,
  }));

  // Weighted job score — complexity-adjusted volume
  let weightedJobScore = 0;
  for (const [tier, count] of distribution) {
    const weight = COMPLEXITY_TIERS[tier as keyof typeof COMPLEXITY_TIERS]?.weight || 1;
    weightedJobScore += count * weight;
  }

  // Max complexity encountered
  let maxComplexity = 0;
  for (const [tier, count] of distribution) {
    if (count > 0) {
      const range = COMPLEXITY_TIERS[tier as keyof typeof COMPLEXITY_TIERS]?.range;
      if (range) maxComplexity = Math.max(maxComplexity, range[1] === Infinity ? 10 : range[1]);
    }
  }

  // === Task Complexity Score (0-100) ===
  // How sophisticated are the tasks this agent handles?
  const complexityNorm = Math.min(100, Math.round(
    Math.log(1 + avgComplexity) / Math.log(1 + 10) * 100
  ));

  // === Execution Quality Score (0-100) ===
  // How well does it handle hard tasks?
  const hardTaskCount = (distribution.get('complex') || 0) + (distribution.get('expert') || 0);
  const hardTaskRatio = agent.successfulJobCount > 0
    ? hardTaskCount / agent.successfulJobCount
    : 0;
  const executionQuality = Math.min(100, Math.round(
    agent.successRate * (0.5 + 0.5 * hardTaskRatio) // Bonus for maintaining success on hard tasks
  ));

  // === Versatility Score (0-100) ===
  // Does the agent handle a variety of task types?
  const activeTiers = buckets.filter(b => b.count > 0).length;
  const versatility = Math.min(100, Math.round(
    (activeTiers / 5) * 60 + // Tier diversity (up to 60 points)
    Math.min(40, agent.offeringCount * 10) // Offering variety (up to 40 points)
  ));

  // === Composite (weighted blend) ===
  const composite = Math.round(
    complexityNorm * 0.4 +
    executionQuality * 0.35 +
    versatility * 0.25
  );

  return {
    totalJobs: agent.successfulJobCount,
    weightedJobScore: Math.round(weightedJobScore),
    avgComplexity: Math.round(avgComplexity * 100) / 100,
    maxComplexity,
    complexityDistribution: buckets,
    taskComplexityScore: complexityNorm,
    executionQualityScore: executionQuality,
    versatilityScore: versatility,
    compositeScore: composite,
  };
}
