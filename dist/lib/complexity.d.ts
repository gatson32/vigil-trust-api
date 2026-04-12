import type { ScoredAgent } from './scoring.js';
export interface ComplexityProfile {
    totalJobs: number;
    weightedJobScore: number;
    avgComplexity: number;
    maxComplexity: number;
    complexityDistribution: ComplexityBucket[];
    taskComplexityScore: number;
    executionQualityScore: number;
    versatilityScore: number;
    compositeScore: number;
}
export interface ComplexityBucket {
    tier: 'trivial' | 'simple' | 'moderate' | 'complex' | 'expert';
    label: string;
    range: [number, number];
    count: number;
    successRate: number;
}
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
export declare function estimateJobComplexity(agent: ScoredAgent): {
    avgComplexity: number;
    distribution: Map<string, number>;
};
/**
 * Score an agent's task complexity profile.
 * Returns scores across three dimensions + composite.
 */
export declare function scoreComplexity(agent: ScoredAgent): ComplexityProfile;
