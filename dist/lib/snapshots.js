// VIGIL — DegenClaw Snapshot Writer
// Writes every current DegenClaw agent grade to the time-series moat table.
// Called on an interval (cron / scheduled task) — every row is permanent.
// This is the ONLY part of VIGIL a competitor cannot backfill no matter
// how much effort they put in after the fact.
import { query, isDbConnected } from './db.js';
import { scoreAllAgents } from './degenclaw.js';
/**
 * Score every current DegenClaw agent and write one row per agent
 * into the degenclaw_snapshots table. Idempotent per call — a new
 * row is written on every invocation (we want the full time-series,
 * not dedupe).
 */
export async function writeDegenClawSnapshot() {
    const started = Date.now();
    const capturedAt = new Date().toISOString();
    if (!isDbConnected()) {
        return {
            ok: false,
            written: 0,
            skipped: 0,
            db: false,
            error: 'DATABASE_URL not configured — snapshot skipped',
            durationMs: Date.now() - started,
            capturedAt,
        };
    }
    let reports;
    try {
        reports = await scoreAllAgents();
    }
    catch (err) {
        return {
            ok: false,
            written: 0,
            skipped: 0,
            db: true,
            error: `scoreAllAgents failed: ${err.message}`,
            durationMs: Date.now() - started,
            capturedAt,
        };
    }
    let written = 0;
    let skipped = 0;
    for (const r of reports) {
        try {
            // Clamp Sortino to ±8 for storage so extreme upstream outliers
            // don't break chart rendering later. Keep raw for transparency.
            const sortinoRaw = Number.isFinite(r.raw.sortinoRatio) ? r.raw.sortinoRatio : 0;
            const sortinoClamped = Math.max(-8, Math.min(8, sortinoRaw));
            const result = await query(`INSERT INTO degenclaw_snapshots (
          agent_name, wallet_address, dc_rank, trust_grade, trust_score, trust_tier,
          profitability, consistency, discipline, capital_risk, sample_size,
          pnl, win_rate, sortino_raw, sortino_clamped, profit_factor,
          trade_count, volume, signals, raw, captured_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10, $11,
          $12, $13, $14, $15, $16,
          $17, $18, $19::jsonb, $20::jsonb, $21
        )`, [
                r.agentName ?? '',
                r.wallet ?? '',
                r.leaderboardRank ?? null,
                r.trustGrade,
                r.trustScore,
                r.trustTier,
                r.profitability,
                r.consistency,
                r.discipline,
                r.capitalRisk,
                r.sampleSize,
                r.raw.totalRealizedPnl,
                r.raw.winRate,
                sortinoRaw,
                sortinoClamped,
                r.raw.profitFactor,
                r.raw.totalTradeCount,
                r.raw.totalTradeVolume,
                JSON.stringify({
                    reasoning: r.reasoning ?? [],
                    flags: r.flags ?? [],
                    greenFlags: r.greenFlags ?? [],
                }),
                JSON.stringify({
                    agentId: r.agentId,
                    tokenSymbol: r.tokenSymbol,
                    dataSource: r.dataSource,
                }),
                capturedAt,
            ]);
            if (result)
                written++;
            else
                skipped++;
        }
        catch (err) {
            console.error(`[snapshot] write failed for ${r.agentName}:`, err.message);
            skipped++;
        }
    }
    console.log(`[snapshot] wrote ${written} DegenClaw rows (${skipped} skipped) in ${Date.now() - started}ms`);
    return {
        ok: true,
        written,
        skipped,
        db: true,
        durationMs: Date.now() - started,
        capturedAt,
    };
}
/**
 * Fetch the grade-history timeline for a single agent.
 * Used by the /degenclaw/:agent/history endpoint (week 2).
 */
export async function getAgentHistory(agentName, days = 30) {
    if (!isDbConnected())
        return [];
    const result = await query(`SELECT captured_at, trust_grade, trust_score, trust_tier, pnl, trade_count, sortino_clamped
     FROM degenclaw_snapshots
     WHERE lower(agent_name) = lower($1)
       AND captured_at > NOW() - ($2::int || ' days')::interval
     ORDER BY captured_at ASC`, [agentName, days]);
    return (result?.rows ?? []).map((row) => ({
        captured_at: row.captured_at instanceof Date ? row.captured_at.toISOString() : String(row.captured_at),
        trust_grade: row.trust_grade,
        trust_score: Number(row.trust_score),
        trust_tier: row.trust_tier,
        pnl: Number(row.pnl),
        trade_count: Number(row.trade_count),
        sortino_clamped: Number(row.sortino_clamped),
    }));
}
/**
 * Count how many snapshots we've accumulated — exposed via /v1/moat/stats
 * so we can show the moat growing on the public landing page.
 * This is the PUBLIC PROOF that competitors can't catch up.
 */
export async function getSnapshotStats() {
    if (!isDbConnected()) {
        return {
            total_snapshots: 0,
            unique_agents: 0,
            first_captured: null,
            last_captured: null,
            days_of_history: 0,
        };
    }
    const result = await query(`SELECT
       COUNT(*)::bigint AS total_snapshots,
       COUNT(DISTINCT agent_name)::bigint AS unique_agents,
       MIN(captured_at) AS first_captured,
       MAX(captured_at) AS last_captured
     FROM degenclaw_snapshots`);
    const row = result?.rows?.[0] ?? {};
    const first = row.first_captured ? new Date(row.first_captured) : null;
    const last = row.last_captured ? new Date(row.last_captured) : null;
    const daysOfHistory = first && last
        ? Math.max(0, Math.round((last.getTime() - first.getTime()) / 86_400_000))
        : 0;
    return {
        total_snapshots: Number(row.total_snapshots ?? 0),
        unique_agents: Number(row.unique_agents ?? 0),
        first_captured: first ? first.toISOString() : null,
        last_captured: last ? last.toISOString() : null,
        days_of_history: daysOfHistory,
    };
}
