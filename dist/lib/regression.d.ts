import type { ScoredAgent } from './scoring.js';
export interface RegressionResult {
    regressionScore: number;
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
export type RegressionAlertType = 'SUCCESS_RATE_DROP' | 'LATENCY_INCREASE' | 'ERROR_PATTERN_CHANGE' | 'VOLUME_COLLAPSE' | 'QUALITY_DEGRADATION' | 'RELIABILITY_CLIFF';
export interface TrendAnalysis {
    direction: 'improving' | 'stable' | 'declining' | 'volatile';
    momentum: number;
    volatility: number;
    daysUntilCritical: number | null;
}
/**
 * Record a performance snapshot for regression tracking.
 */
export declare function recordPerformance(agent: ScoredAgent): Promise<void>;
/**
 * Detect performance regressions by comparing recent behavior to baseline.
 */
export declare function detectRegression(agent: ScoredAgent): Promise<RegressionResult>;
export declare function getRegressionStats(): Promise<{
    trackedAgents: number;
    totalSnapshots: number;
    agentsWithAlerts: number;
    storageMode: 'postgresql' | 'memory';
}>;
