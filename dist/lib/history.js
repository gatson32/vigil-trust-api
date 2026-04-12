// VIGIL Score History — PostgreSQL-backed with in-memory fallback
// Tracks trust score changes over time for trend analysis
// Automatically uses PostgreSQL when DATABASE_URL is set, otherwise falls back to Map
import { isDbConnected, query } from './db.js';
// ─── In-memory fallback store ──────────────────────────────────────
const memStore = new Map();
const MAX_SNAPSHOTS_PER_AGENT = 168; // 7 days at 1 snapshot/hour
const SNAPSHOT_INTERVAL_MS = 60 * 60 * 1000; // Minimum 1 hour between snapshots
// Track last insert times for dedup (both modes)
const lastInsertTime = new Map();
// ─── Public API ─────────────────────────────────────────────────────
/**
 * Record a score snapshot for an agent.
 * Uses PostgreSQL if available, otherwise in-memory.
 */
export async function recordSnapshot(walletAddress, name, scores) {
    const key = walletAddress.toLowerCase();
    const now = Date.now();
    // Dedup: skip if last snapshot < SNAPSHOT_INTERVAL_MS ago
    const lastTime = lastInsertTime.get(key);
    if (lastTime && (now - lastTime) < SNAPSHOT_INTERVAL_MS) {
        return;
    }
    if (isDbConnected()) {
        await recordSnapshotDb(key, name, scores);
    }
    else {
        recordSnapshotMem(key, walletAddress, name, scores, now);
    }
    lastInsertTime.set(key, now);
}
/**
 * Get full history for an agent.
 */
export async function getHistory(walletAddress) {
    const key = walletAddress.toLowerCase();
    if (isDbConnected()) {
        return getHistoryDb(key);
    }
    return memStore.get(key) || null;
}
/**
 * Get score deltas — compare latest snapshot to a previous one.
 */
export async function getScoreDeltas(walletAddress, hoursBack = 24) {
    const key = walletAddress.toLowerCase();
    if (isDbConnected()) {
        return getScoreDeltasDb(key, hoursBack);
    }
    return getScoreDeltasMem(key, hoursBack);
}
/**
 * Get stats about the history store.
 */
export async function getHistoryStats() {
    if (isDbConnected()) {
        return getHistoryStatsDb();
    }
    return getHistoryStatsMem();
}
/**
 * Get all agents that have had score changes in the last N hours.
 */
export async function getRecentMovers(hoursBack = 24, limit = 10) {
    if (isDbConnected()) {
        return getRecentMoversDb(hoursBack, limit);
    }
    return getRecentMoversMem(hoursBack, limit);
}
// ─── PostgreSQL Implementation ─────────────────────────────────────
async function recordSnapshotDb(key, name, scores) {
    // Upsert agent metadata
    await query(`INSERT INTO agents (wallet_address, agent_name, first_seen, last_updated)
     VALUES ($1, $2, NOW(), NOW())
     ON CONFLICT (wallet_address) DO UPDATE SET
       agent_name = EXCLUDED.agent_name,
       last_updated = NOW()`, [key, name]);
    // Insert snapshot
    await query(`INSERT INTO score_snapshots (
      wallet_address, agent_name, trust_score, trust_tier,
      reliability, activity, economic, reputation, longevity,
      behavioral, complexity, sustainability, sybil_risk, regression,
      risk_flags
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`, [
        key, name, scores.trustScore, scores.trustTier,
        scores.reliabilityScore, scores.activityScore, scores.economicScore,
        scores.reputationScore, scores.longevityScore,
        scores.behavioralScore ?? 0, scores.complexityScore ?? 0,
        scores.sustainabilityScore ?? 0, scores.sybilRiskScore ?? 0,
        scores.regressionScore ?? 0, scores.riskFlags,
    ]);
}
async function getHistoryDb(key) {
    const agentResult = await query('SELECT wallet_address, agent_name, first_seen, last_updated FROM agents WHERE wallet_address = $1', [key]);
    if (!agentResult || agentResult.rows.length === 0)
        return null;
    const agent = agentResult.rows[0];
    const snapResult = await query(`SELECT trust_score, trust_tier, reliability, activity, economic,
            reputation, longevity, behavioral, complexity, sustainability,
            sybil_risk, regression, risk_flags, created_at
     FROM score_snapshots
     WHERE wallet_address = $1
     ORDER BY created_at ASC
     LIMIT $2`, [key, MAX_SNAPSHOTS_PER_AGENT]);
    if (!snapResult)
        return null;
    const snapshots = snapResult.rows.map(r => ({
        timestamp: new Date(r.created_at).getTime(),
        trustScore: r.trust_score,
        trustTier: r.trust_tier,
        reliabilityScore: r.reliability,
        activityScore: r.activity,
        economicScore: r.economic,
        reputationScore: r.reputation,
        longevityScore: r.longevity,
        behavioralScore: r.behavioral,
        complexityScore: r.complexity,
        sustainabilityScore: r.sustainability,
        sybilRiskScore: r.sybil_risk,
        regressionScore: r.regression,
        riskFlags: r.risk_flags || [],
    }));
    return {
        walletAddress: agent.wallet_address,
        name: agent.agent_name,
        snapshots,
        firstSeen: new Date(agent.first_seen).getTime(),
        lastUpdated: new Date(agent.last_updated).getTime(),
    };
}
async function getScoreDeltasDb(key, hoursBack) {
    // Get latest snapshot
    const latestResult = await query(`SELECT trust_score, reliability, activity, economic, reputation, longevity
     FROM score_snapshots WHERE wallet_address = $1
     ORDER BY created_at DESC LIMIT 1`, [key]);
    if (!latestResult || latestResult.rows.length === 0)
        return null;
    const latest = latestResult.rows[0];
    // Get snapshot closest to hoursBack ago
    const prevResult = await query(`SELECT trust_score, reliability, activity, economic, reputation, longevity
     FROM score_snapshots WHERE wallet_address = $1 AND created_at <= NOW() - $2::interval
     ORDER BY created_at DESC LIMIT 1`, [key, `${hoursBack} hours`]);
    if (!prevResult || prevResult.rows.length === 0)
        return null;
    const previous = prevResult.rows[0];
    const fields = [
        { field: 'trustScore', prev: previous.trust_score, curr: latest.trust_score },
        { field: 'reliabilityScore', prev: previous.reliability, curr: latest.reliability },
        { field: 'activityScore', prev: previous.activity, curr: latest.activity },
        { field: 'economicScore', prev: previous.economic, curr: latest.economic },
        { field: 'reputationScore', prev: previous.reputation, curr: latest.reputation },
        { field: 'longevityScore', prev: previous.longevity, curr: latest.longevity },
    ];
    return fields.map(({ field, prev, curr }) => {
        const change = curr - prev;
        return {
            field,
            previous: prev,
            current: curr,
            change: Math.round(change * 100) / 100,
            direction: change > 0 ? 'up' : change < 0 ? 'down' : 'stable',
        };
    });
}
async function getHistoryStatsDb() {
    const agentCount = await query('SELECT COUNT(*) as count FROM agents');
    const snapCount = await query('SELECT COUNT(*) as count FROM score_snapshots');
    const oldest = await query('SELECT MIN(created_at) as oldest FROM score_snapshots');
    return {
        trackedAgents: agentCount ? parseInt(agentCount.rows[0].count) : 0,
        totalSnapshots: snapCount ? parseInt(snapCount.rows[0].count) : 0,
        oldestSnapshot: oldest?.rows[0]?.oldest ? new Date(oldest.rows[0].oldest).getTime() : null,
        storageMode: 'postgresql',
    };
}
async function getRecentMoversDb(hoursBack, limit) {
    // Get the most recent snapshot and the one closest to hoursBack ago for each agent
    const result = await query(`
    WITH latest AS (
      SELECT DISTINCT ON (wallet_address)
        wallet_address, agent_name, trust_score AS latest_score, trust_tier AS latest_tier
      FROM score_snapshots
      WHERE created_at > NOW() - $1::interval
      ORDER BY wallet_address, created_at DESC
    ),
    previous AS (
      SELECT DISTINCT ON (wallet_address)
        wallet_address, trust_score AS prev_score, trust_tier AS prev_tier
      FROM score_snapshots
      WHERE created_at <= NOW() - $1::interval
      ORDER BY wallet_address, created_at DESC
    )
    SELECT l.wallet_address, l.agent_name, l.latest_score, l.latest_tier,
           COALESCE(p.prev_score, l.latest_score) AS prev_score,
           COALESCE(p.prev_tier, l.latest_tier) AS prev_tier
    FROM latest l
    LEFT JOIN previous p ON l.wallet_address = p.wallet_address
    WHERE l.latest_score != COALESCE(p.prev_score, l.latest_score)
    ORDER BY ABS(l.latest_score - COALESCE(p.prev_score, l.latest_score)) DESC
    LIMIT $2
  `, [`${hoursBack} hours`, limit]);
    if (!result)
        return [];
    return result.rows.map(r => ({
        walletAddress: r.wallet_address,
        name: r.agent_name,
        scoreBefore: r.prev_score,
        scoreNow: r.latest_score,
        change: r.latest_score - r.prev_score,
        tierBefore: r.prev_tier,
        tierNow: r.latest_tier,
    }));
}
// ─── In-Memory Fallback Implementation ─────────────────────────────
function recordSnapshotMem(key, walletAddress, name, scores, now) {
    let history = memStore.get(key);
    if (!history) {
        history = { walletAddress, name, snapshots: [], firstSeen: now, lastUpdated: now };
        memStore.set(key, history);
    }
    const last = history.snapshots[history.snapshots.length - 1];
    if (last) {
        const timeSince = now - last.timestamp;
        const scoreChanged = last.trustScore !== scores.trustScore || last.trustTier !== scores.trustTier;
        if (timeSince < SNAPSHOT_INTERVAL_MS && !scoreChanged)
            return;
    }
    history.snapshots.push({ ...scores, timestamp: now });
    history.name = name;
    history.lastUpdated = now;
    if (history.snapshots.length > MAX_SNAPSHOTS_PER_AGENT) {
        history.snapshots = history.snapshots.slice(-MAX_SNAPSHOTS_PER_AGENT);
    }
}
function getScoreDeltasMem(key, hoursBack) {
    const history = memStore.get(key);
    if (!history || history.snapshots.length < 2)
        return null;
    const latest = history.snapshots[history.snapshots.length - 1];
    const cutoff = latest.timestamp - (hoursBack * 60 * 60 * 1000);
    let previous = history.snapshots[0];
    for (const snap of history.snapshots) {
        if (snap.timestamp <= cutoff)
            previous = snap;
        else
            break;
    }
    if (previous.timestamp === latest.timestamp && history.snapshots.length >= 2) {
        previous = history.snapshots[history.snapshots.length - 2];
    }
    const fields = [
        'trustScore', 'reliabilityScore', 'activityScore',
        'economicScore', 'reputationScore', 'longevityScore',
    ];
    return fields.map(field => {
        const prev = previous[field];
        const curr = latest[field];
        const change = curr - prev;
        return {
            field,
            previous: prev,
            current: curr,
            change: Math.round(change * 100) / 100,
            direction: change > 0 ? 'up' : change < 0 ? 'down' : 'stable',
        };
    });
}
function getHistoryStatsMem() {
    let totalSnapshots = 0;
    let oldestSnapshot = null;
    for (const history of memStore.values()) {
        totalSnapshots += history.snapshots.length;
        if (history.snapshots.length > 0) {
            const first = history.snapshots[0].timestamp;
            if (oldestSnapshot === null || first < oldestSnapshot)
                oldestSnapshot = first;
        }
    }
    return { trackedAgents: memStore.size, totalSnapshots, oldestSnapshot, storageMode: 'memory' };
}
function getRecentMoversMem(hoursBack, limit) {
    const cutoff = Date.now() - (hoursBack * 60 * 60 * 1000);
    const movers = [];
    for (const history of memStore.values()) {
        if (history.snapshots.length < 2)
            continue;
        const latest = history.snapshots[history.snapshots.length - 1];
        if (latest.timestamp < cutoff)
            continue;
        let previous = history.snapshots[0];
        for (const snap of history.snapshots) {
            if (snap.timestamp <= cutoff)
                previous = snap;
            else
                break;
        }
        const change = latest.trustScore - previous.trustScore;
        if (change !== 0) {
            movers.push({
                walletAddress: history.walletAddress,
                name: history.name,
                scoreBefore: previous.trustScore,
                scoreNow: latest.trustScore,
                change,
                tierBefore: previous.trustTier,
                tierNow: latest.trustTier,
            });
        }
    }
    movers.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
    return movers.slice(0, limit);
}
