export interface SnapshotResult {
    ok: boolean;
    written: number;
    skipped: number;
    db: boolean;
    error?: string;
    durationMs: number;
    capturedAt: string;
}
/**
 * Score every current DegenClaw agent and write one row per agent
 * into the degenclaw_snapshots table. Idempotent per call — a new
 * row is written on every invocation (we want the full time-series,
 * not dedupe).
 */
export declare function writeDegenClawSnapshot(): Promise<SnapshotResult>;
/**
 * Fetch the grade-history timeline for a single agent.
 * Used by the /degenclaw/:agent/history endpoint (week 2).
 */
export declare function getAgentHistory(agentName: string, days?: number): Promise<Array<{
    captured_at: string;
    trust_grade: string;
    trust_score: number;
    trust_tier: string;
    pnl: number;
    trade_count: number;
    sortino_clamped: number;
}>>;
/**
 * Count how many snapshots we've accumulated — exposed via /v1/moat/stats
 * so we can show the moat growing on the public landing page.
 * This is the PUBLIC PROOF that competitors can't catch up.
 */
export declare function getSnapshotStats(): Promise<{
    total_snapshots: number;
    unique_agents: number;
    first_captured: string | null;
    last_captured: string | null;
    days_of_history: number;
}>;
