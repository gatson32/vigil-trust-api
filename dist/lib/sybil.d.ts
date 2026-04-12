import type { ScoredAgent } from './scoring.js';
export interface SybilResult {
    sybilRiskScore: number;
    collusionDetected: boolean;
    quarantineRecommended: boolean;
    flags: SybilFlag[];
    clusterIds: string[];
    networkMetrics: NetworkMetrics;
}
export interface SybilFlag {
    type: SybilFlagType;
    severity: 'low' | 'medium' | 'high' | 'critical';
    description: string;
    evidence: string;
    confidence: number;
    flaggedAt?: number;
}
export type SybilFlagType = 'CIRCULAR_FLOW' | 'SELF_DEALING' | 'VOLUME_INFLATION' | 'REFERRAL_BIAS' | 'TIMING_CORRELATION' | 'WALLET_CLUSTER' | 'METRIC_FARMING' | 'WASH_TRADING';
export interface NetworkMetrics {
    inDegree: number;
    outDegree: number;
    reciprocityRate: number;
    clusterCoefficient: number;
    betweennessCentrality: number;
}
/**
 * Register an agent in the transaction graph.
 */
export declare function registerAgent(agent: ScoredAgent): Promise<void>;
/**
 * Record a transaction between two agents.
 */
export declare function recordTransaction(from: string, to: string, value: number, spread?: number): Promise<void>;
/**
 * Analyze an agent for sybil/collusion risk.
 */
export declare function analyzeSybilRisk(agent: ScoredAgent): SybilResult;
/**
 * Persist a sybil scan result to the database.
 */
export declare function saveScanResult(agent: ScoredAgent, result: SybilResult): Promise<void>;
/**
 * Get all persisted scan results, optionally filtered by risk threshold.
 */
export declare function getScanResults(minRisk?: number, limit?: number): Promise<Array<{
    walletAddress: string;
    name: string;
    sybilRiskScore: number;
    collusionDetected: boolean;
    quarantineRecommended: boolean;
    flags: SybilFlag[];
    scannedAt: string;
}> | null>;
export declare function getSybilStats(): Promise<{
    trackedAgents: number;
    totalEdges: number;
    suspectedClusters: number;
    storageMode: 'postgresql' | 'memory';
}>;
