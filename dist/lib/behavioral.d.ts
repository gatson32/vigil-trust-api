import type { ScoredAgent } from './scoring.js';
export interface BehaviorProfile {
    walletAddress: string;
    windowStart: number;
    windowEnd: number;
    avgInterTxTimeMs: number;
    stddevInterTxTimeMs: number;
    activeHoursDistribution: number[];
    dayOfWeekDistribution: number[];
    uniqueCounterparties: number;
    topCounterpartyConcentration: number;
    newCounterpartyRate: number;
    avgTxValue: number;
    stddevTxValue: number;
    txValueDistribution: number[];
}
export interface AnomalyResult {
    anomalyScore: number;
    driftDetected: boolean;
    driftSeverity: 'none' | 'low' | 'medium' | 'high' | 'critical';
    signals: AnomalySignal[];
    behaviorFingerprint: string;
    dataQuality: 'synthesized' | 'on-chain';
}
export interface AnomalySignal {
    type: string;
    description: string;
    weight: number;
    severity: 'info' | 'warning' | 'critical';
    value: number;
    baseline: number;
    deviation: number;
}
/**
 * Kullback-Leibler Divergence between two probability distributions
 * Measures how different a recent distribution is from a baseline
 * Lower = more similar. 0 = identical.
 */
declare function klDivergence(p: number[], q: number[]): number;
/**
 * Jensen-Shannon Divergence — symmetric, bounded version of KL
 * Returns value between 0 (identical) and ln(2) (~0.693)
 */
declare function jsDivergence(p: number[], q: number[]): number;
/**
 * Z-score: how many standard deviations a value is from baseline
 */
declare function zScore(value: number, mean: number, stddev: number): number;
/**
 * Build a behavior profile from scored agent data + transaction metadata
 * KNOWN LIMITATION: This function synthesizes behavioral signals from aggregated metrics
 * rather than consuming raw on-chain transaction data. In production, this would parse
 * detailed transaction-level data (timing, value, counterparties) from on-chain sources.
 * Synthesized profiles are less precise but provide useful signals for anomaly detection.
 */
export declare function buildProfileFromAgent(agent: ScoredAgent): BehaviorProfile;
/**
 * Analyze an agent's recent behavior against their historical baseline.
 * Returns an anomaly score (100 = normal, 0 = extreme anomaly) with signals.
 */
export declare function detectAnomalies(agent: ScoredAgent): AnomalyResult;
declare function blendProfiles(a: BehaviorProfile, b: BehaviorProfile, alpha: number): BehaviorProfile;
declare function generateFingerprint(profile: BehaviorProfile): string;
export declare const _internal: {
    klDivergence: typeof klDivergence;
    jsDivergence: typeof jsDivergence;
    zScore: typeof zScore;
    blendProfiles: typeof blendProfiles;
    generateFingerprint: typeof generateFingerprint;
};
export {};
