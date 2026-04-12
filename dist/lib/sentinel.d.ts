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
    confidence: number;
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
    overallConfidence: number;
    allAlerts: SentinelAlert[];
    recommendedActions: string[];
    crossSentinelEscalation: boolean;
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
/**
 * Runs all 12 sentinels against an agent and aggregates results.
 *
 * @param agent The agent to scan
 * @param context Contextual data (all agents, graph, history)
 * @returns Array of alerts from all sentinels
 */
export declare function runSentinelNetwork(agent: ScoredAgent, context: SentinelContext): SentinelAlert[];
/**
 * Aggregates sentinel alerts into a composite verdict with threat assessment.
 *
 * @param agent The agent being assessed
 * @param context Contextual data
 * @returns Aggregated verdict with threat level and recommendations
 */
export declare function assembleSentinelVerdict(agent: ScoredAgent, context: SentinelContext): SentinelVerdict;
/**
 * Performs extended analysis when an agent is flagged by sentinel network.
 * Re-runs sentinels with extended lookback and broader graph analysis.
 *
 * @param agent The flagged agent
 * @param alerts Initial alerts that triggered deep dive
 * @param context Extended context with more history
 * @returns Additional findings and alerts
 */
export declare function deepDive(agent: ScoredAgent, alerts: SentinelAlert[], context: SentinelContext): DeepDiveAnalysis;
/**
 * Public interface: scan a single agent and return comprehensive verdict.
 * This is the main entry point for external systems.
 *
 * @param agent The agent to assess
 * @param context Contextual data
 * @returns Complete verdict with all alerts and recommendations
 */
export declare function assessAgent(agent: ScoredAgent, context: SentinelContext): SentinelVerdict;
export type { SentinelAlert, SentinelVerdict, DeepDiveAnalysis, SentinelContext };
