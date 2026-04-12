export interface ScoreSnapshot {
    timestamp: number;
    trustScore: number;
    trustTier: string;
    reliabilityScore: number;
    activityScore: number;
    economicScore: number;
    reputationScore: number;
    longevityScore: number;
    behavioralScore?: number;
    complexityScore?: number;
    sustainabilityScore?: number;
    sybilRiskScore?: number;
    regressionScore?: number;
    riskFlags: string[];
}
export interface AgentHistory {
    walletAddress: string;
    name: string;
    snapshots: ScoreSnapshot[];
    firstSeen: number;
    lastUpdated: number;
}
export interface ScoreDelta {
    field: string;
    previous: number;
    current: number;
    change: number;
    direction: 'up' | 'down' | 'stable';
}
/**
 * Record a score snapshot for an agent.
 * Uses PostgreSQL if available, otherwise in-memory.
 */
export declare function recordSnapshot(walletAddress: string, name: string, scores: Omit<ScoreSnapshot, 'timestamp'>): Promise<void>;
/**
 * Get full history for an agent.
 */
export declare function getHistory(walletAddress: string): Promise<AgentHistory | null>;
/**
 * Get score deltas — compare latest snapshot to a previous one.
 */
export declare function getScoreDeltas(walletAddress: string, hoursBack?: number): Promise<ScoreDelta[] | null>;
/**
 * Get stats about the history store.
 */
export declare function getHistoryStats(): Promise<{
    trackedAgents: number;
    totalSnapshots: number;
    oldestSnapshot: number | null;
    storageMode: 'postgresql' | 'memory';
}>;
/**
 * Get all agents that have had score changes in the last N hours.
 */
export declare function getRecentMovers(hoursBack?: number, limit?: number): Promise<Array<{
    walletAddress: string;
    name: string;
    scoreBefore: number;
    scoreNow: number;
    change: number;
    tierBefore: string;
    tierNow: string;
}>>;
