// VIGIL Score History — In-memory store with periodic snapshots
// Tracks trust score changes over time for trend analysis
// Future: swap this for Redis/PostgreSQL when scaling

export interface ScoreSnapshot {
  timestamp: number;       // Unix ms
  trustScore: number;
  trustTier: string;
  reliabilityScore: number;
  activityScore: number;
  economicScore: number;
  reputationScore: number;
  longevityScore: number;
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

// ─── In-memory store ────────────────────────────────────────────────

const store = new Map<string, AgentHistory>();
const MAX_SNAPSHOTS_PER_AGENT = 168; // 7 days at 1 snapshot/hour
const SNAPSHOT_INTERVAL_MS = 60 * 60 * 1000; // Minimum 1 hour between snapshots

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Record a score snapshot for an agent.
 * Deduplicates: won't store a new snapshot if less than SNAPSHOT_INTERVAL_MS
 * has passed since the last one, UNLESS the score changed.
 */
export function recordSnapshot(
  walletAddress: string,
  name: string,
  scores: Omit<ScoreSnapshot, 'timestamp'>,
): void {
  const key = walletAddress.toLowerCase();
  const now = Date.now();

  let history = store.get(key);
  if (!history) {
    history = {
      walletAddress,
      name,
      snapshots: [],
      firstSeen: now,
      lastUpdated: now,
    };
    store.set(key, history);
  }

  // Check if we should add a new snapshot
  const last = history.snapshots[history.snapshots.length - 1];
  if (last) {
    const timeSince = now - last.timestamp;
    const scoreChanged = last.trustScore !== scores.trustScore ||
      last.trustTier !== scores.trustTier;

    // Skip if too recent AND score hasn't changed
    if (timeSince < SNAPSHOT_INTERVAL_MS && !scoreChanged) {
      return;
    }
  }

  // Add snapshot
  history.snapshots.push({ ...scores, timestamp: now });
  history.name = name; // Update name in case it changed
  history.lastUpdated = now;

  // Prune old snapshots (keep most recent MAX_SNAPSHOTS_PER_AGENT)
  if (history.snapshots.length > MAX_SNAPSHOTS_PER_AGENT) {
    history.snapshots = history.snapshots.slice(-MAX_SNAPSHOTS_PER_AGENT);
  }
}

/**
 * Get full history for an agent
 */
export function getHistory(walletAddress: string): AgentHistory | null {
  return store.get(walletAddress.toLowerCase()) || null;
}

/**
 * Get score deltas — compare latest snapshot to a previous one
 * @param hoursBack How many hours back to compare (default: 24)
 */
export function getScoreDeltas(walletAddress: string, hoursBack: number = 24): ScoreDelta[] | null {
  const history = store.get(walletAddress.toLowerCase());
  if (!history || history.snapshots.length < 2) return null;

  const latest = history.snapshots[history.snapshots.length - 1];
  const cutoff = latest.timestamp - (hoursBack * 60 * 60 * 1000);

  // Find the snapshot closest to the cutoff time
  let previous = history.snapshots[0];
  for (const snap of history.snapshots) {
    if (snap.timestamp <= cutoff) {
      previous = snap;
    } else {
      break;
    }
  }

  // If the "previous" is the same as latest, use the second-to-last
  if (previous.timestamp === latest.timestamp && history.snapshots.length >= 2) {
    previous = history.snapshots[history.snapshots.length - 2];
  }

  const fields = [
    'trustScore', 'reliabilityScore', 'activityScore',
    'economicScore', 'reputationScore', 'longevityScore',
  ] as const;

  return fields.map(field => {
    const prev = previous[field];
    const curr = latest[field];
    const change = curr - prev;
    return {
      field,
      previous: prev,
      current: curr,
      change: Math.round(change * 100) / 100,
      direction: change > 0 ? 'up' as const : change < 0 ? 'down' as const : 'stable' as const,
    };
  });
}

/**
 * Get stats about the history store
 */
export function getHistoryStats(): {
  trackedAgents: number;
  totalSnapshots: number;
  oldestSnapshot: number | null;
} {
  let totalSnapshots = 0;
  let oldestSnapshot: number | null = null;

  for (const history of store.values()) {
    totalSnapshots += history.snapshots.length;
    if (history.snapshots.length > 0) {
      const first = history.snapshots[0].timestamp;
      if (oldestSnapshot === null || first < oldestSnapshot) {
        oldestSnapshot = first;
      }
    }
  }

  return {
    trackedAgents: store.size,
    totalSnapshots,
    oldestSnapshot,
  };
}

/**
 * Get all agents that have had score changes in the last N hours
 */
export function getRecentMovers(hoursBack: number = 24, limit: number = 10): Array<{
  walletAddress: string;
  name: string;
  scoreBefore: number;
  scoreNow: number;
  change: number;
  tierBefore: string;
  tierNow: string;
}> {
  const cutoff = Date.now() - (hoursBack * 60 * 60 * 1000);
  const movers: Array<{
    walletAddress: string;
    name: string;
    scoreBefore: number;
    scoreNow: number;
    change: number;
    tierBefore: string;
    tierNow: string;
  }> = [];

  for (const history of store.values()) {
    if (history.snapshots.length < 2) continue;

    const latest = history.snapshots[history.snapshots.length - 1];
    if (latest.timestamp < cutoff) continue; // Not active recently

    // Find snapshot near cutoff
    let previous = history.snapshots[0];
    for (const snap of history.snapshots) {
      if (snap.timestamp <= cutoff) previous = snap;
      else break;
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

  // Sort by absolute change, descending
  movers.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
  return movers.slice(0, limit);
}
