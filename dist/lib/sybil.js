// VIGIL Proprietary — Sybil & Collusion Detection Engine
// Detects coordinated manipulation, circular fund flows, and artificial metric inflation
// PostgreSQL-backed with in-memory fallback for transaction graph
// Patent-pending scoring methodology. All rights reserved.
import { isDbConnected, query } from './db.js';
const agentGraph = new Map();
// ─── Threshold Fuzzing ──────────────────────────────────────────
/**
 * Add ±10% randomization to thresholds to prevent attackers from gaming exact cutoffs.
 */
function fuzzyThreshold(baseThreshold, randomSeed) {
    // Deterministic hash-based "random" value derived from seed
    let hash = 0;
    for (let i = 0; i < randomSeed.length; i++) {
        const char = randomSeed.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    const variance = ((Math.abs(hash) % 20) - 10) / 100; // ±10%
    return baseThreshold * (1 + variance);
}
/**
 * Apply time-decay to flag confidence: older flags weigh less.
 * Decay rate: 50% weight after 30 days, negligible after 90 days.
 */
function applyTimeDecay(confidence, flaggedAt) {
    if (!flaggedAt)
        return confidence; // No timestamp = fresh flag, full weight
    const ageMs = Date.now() - flaggedAt;
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    // Exponential decay: exp(-ageDays / 30)
    const decayFactor = Math.exp(-ageDays / 30);
    return confidence * decayFactor;
}
// ─── Graph Builder ──────────────────────────────────────────────────
/**
 * Register an agent in the transaction graph.
 */
export async function registerAgent(agent) {
    const key = agent.walletAddress.toLowerCase();
    if (isDbConnected()) {
        await query(`INSERT INTO agents (wallet_address, agent_name, first_seen, last_updated)
       VALUES ($1, $2, NOW(), NOW())
       ON CONFLICT (wallet_address) DO UPDATE SET
         agent_name = EXCLUDED.agent_name,
         last_updated = NOW()`, [key, agent.name]);
    }
    // Always maintain in-memory graph for fast analysis
    if (!agentGraph.has(key)) {
        agentGraph.set(key, {
            walletAddress: agent.walletAddress,
            name: agent.name,
            edges: new Map(),
        });
    }
}
/**
 * Record a transaction between two agents.
 */
export async function recordTransaction(from, to, value, spread = 0) {
    const fromKey = from.toLowerCase();
    const toKey = to.toLowerCase();
    const now = Date.now();
    // Persist to DB if available
    if (isDbConnected()) {
        await query(`INSERT INTO sybil_edges (from_wallet, to_wallet, tx_count, total_value, avg_spread, first_seen, last_seen)
       VALUES ($1, $2, 1, $3, $4, NOW(), NOW())
       ON CONFLICT (from_wallet, to_wallet) DO UPDATE SET
         tx_count = sybil_edges.tx_count + 1,
         total_value = sybil_edges.total_value + EXCLUDED.total_value,
         avg_spread = (sybil_edges.avg_spread * sybil_edges.tx_count + EXCLUDED.avg_spread)
                      / (sybil_edges.tx_count + 1),
         last_seen = NOW()`, [fromKey, toKey, value, spread]);
    }
    // In-memory graph update
    if (!agentGraph.has(fromKey)) {
        agentGraph.set(fromKey, { walletAddress: from, name: '', edges: new Map() });
    }
    if (!agentGraph.has(toKey)) {
        agentGraph.set(toKey, { walletAddress: to, name: '', edges: new Map() });
    }
    const node = agentGraph.get(fromKey);
    const existing = node.edges.get(toKey);
    if (existing) {
        existing.txCount++;
        existing.totalValue += value;
        existing.lastSeen = now;
        existing.avgSpread = (existing.avgSpread * (existing.txCount - 1) + spread) / existing.txCount;
    }
    else {
        node.edges.set(toKey, {
            txCount: 1,
            totalValue: value,
            firstSeen: now,
            lastSeen: now,
            avgSpread: spread,
        });
    }
}
// ─── Analysis ───────────────────────────────────────────────────────
/**
 * Analyze an agent for sybil/collusion risk.
 */
export function analyzeSybilRisk(agent) {
    const key = agent.walletAddress.toLowerCase();
    const flags = [];
    // Register in memory graph (sync for speed during scoring)
    if (!agentGraph.has(key)) {
        agentGraph.set(key, {
            walletAddress: agent.walletAddress,
            name: agent.name,
            edges: new Map(),
        });
    }
    const node = agentGraph.get(key);
    const networkMetrics = computeNetworkMetrics(key);
    // === Check 1: Buyer Concentration Anomaly ===
    if (agent.transactionCount > 100 && agent.uniqueBuyerCount > 0) {
        const txPerBuyer = agent.transactionCount / agent.uniqueBuyerCount;
        const threshold = fuzzyThreshold(50, agent.walletAddress); // Fuzzy cutoff ±10%
        if (txPerBuyer > threshold) {
            flags.push({
                type: 'VOLUME_INFLATION',
                severity: txPerBuyer > 200 ? 'critical' : 'high',
                description: `Extremely low buyer diversity: ${txPerBuyer.toFixed(0)} transactions per unique buyer`,
                evidence: `${agent.transactionCount} txs from only ${agent.uniqueBuyerCount} buyers`,
                confidence: Math.min(0.9, txPerBuyer / 200),
                flaggedAt: Date.now(),
            });
        }
    }
    // === Check 2: Metric Farming Pattern ===
    if (agent.successfulJobCount > 500) {
        const valuePerJob = agent.grossAgenticAmount / agent.successfulJobCount;
        if (valuePerJob < 0.01 && agent.successRate > 98) {
            flags.push({
                type: 'METRIC_FARMING',
                severity: 'high',
                description: 'Pattern consistent with metric farming: high volume, near-zero value, perfect success rate',
                evidence: `${agent.successfulJobCount} jobs, avg value $${valuePerJob.toFixed(4)}, ${agent.successRate}% success`,
                confidence: 0.75,
            });
        }
    }
    // === Check 3: Suspicious Success Rate ===
    if (agent.successRate >= 100 && agent.successfulJobCount > 1000) {
        flags.push({
            type: 'METRIC_FARMING',
            severity: 'medium',
            description: 'Perfect success rate over >1000 jobs is statistically unusual',
            evidence: `${agent.successfulJobCount} jobs at 100.0% success rate`,
            confidence: 0.5,
        });
    }
    // === Check 4: Reciprocity Analysis (from graph) ===
    if (networkMetrics.reciprocityRate > 0.8 && node && node.edges.size > 3) {
        flags.push({
            type: 'CIRCULAR_FLOW',
            severity: 'high',
            description: `${(networkMetrics.reciprocityRate * 100).toFixed(0)}% of connections are bidirectional — possible circular flow`,
            evidence: `${node.edges.size} connections, ${(networkMetrics.reciprocityRate * 100).toFixed(0)}% reciprocal`,
            confidence: networkMetrics.reciprocityRate * 0.8,
        });
    }
    // === Check 5: Wash Trading Signals ===
    if (node) {
        for (const [target, edge] of node.edges) {
            if (edge.avgSpread < 0.005 && edge.txCount > 10) {
                const reverseNode = agentGraph.get(target);
                const reverseEdge = reverseNode?.edges.get(key);
                if (reverseEdge && reverseEdge.txCount > 5) {
                    flags.push({
                        type: 'WASH_TRADING',
                        severity: 'critical',
                        description: 'Bidirectional trading with minimal spread detected',
                        evidence: `${edge.txCount} txs to ${target.slice(0, 10)}... at ${(edge.avgSpread * 100).toFixed(2)}% spread, ${reverseEdge.txCount} txs back`,
                        confidence: 0.85,
                    });
                    break;
                }
            }
        }
    }
    // === Check 6: Wallet Age vs Activity Ratio ===
    if (agent.accountAgeDays < 7 && agent.transactionCount > 500) {
        flags.push({
            type: 'VOLUME_INFLATION',
            severity: 'medium',
            description: `New agent (${agent.accountAgeDays}d old) with unusually high activity`,
            evidence: `${agent.transactionCount} transactions in ${agent.accountAgeDays} days`,
            confidence: 0.6,
        });
    }
    // === Calculate Composite Sybil Risk Score ===
    let sybilRiskScore = 0;
    for (const flag of flags) {
        const severityWeight = flag.severity === 'critical' ? 30 :
            flag.severity === 'high' ? 20 :
                flag.severity === 'medium' ? 10 : 5;
        // Apply time-decay to confidence: older flags weigh less
        const decayedConfidence = applyTimeDecay(flag.confidence, flag.flaggedAt);
        sybilRiskScore += severityWeight * decayedConfidence;
    }
    sybilRiskScore = Math.min(100, Math.round(sybilRiskScore));
    const clusterIds = detectClusterMembership(key);
    return {
        sybilRiskScore,
        collusionDetected: sybilRiskScore >= 60,
        quarantineRecommended: sybilRiskScore >= 75,
        flags,
        clusterIds,
        networkMetrics,
    };
}
/**
 * Persist a sybil scan result to the database.
 */
export async function saveScanResult(agent, result) {
    if (!isDbConnected())
        return;
    await query(`INSERT INTO sybil_scan_results (
      wallet_address, agent_name, sybil_risk_score,
      collusion_detected, quarantine_rec, flags_json,
      cluster_ids, network_metrics
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [
        agent.walletAddress.toLowerCase(),
        agent.name,
        result.sybilRiskScore,
        result.collusionDetected,
        result.quarantineRecommended,
        JSON.stringify(result.flags),
        result.clusterIds,
        JSON.stringify(result.networkMetrics),
    ]);
}
/**
 * Get all persisted scan results, optionally filtered by risk threshold.
 */
export async function getScanResults(minRisk = 0, limit = 100) {
    if (!isDbConnected())
        return null;
    const result = await query(`SELECT wallet_address, agent_name, sybil_risk_score,
            collusion_detected, quarantine_rec, flags_json, scanned_at
     FROM sybil_scan_results
     WHERE sybil_risk_score >= $1
     ORDER BY sybil_risk_score DESC
     LIMIT $2`, [minRisk, limit]);
    if (!result)
        return null;
    return result.rows.map(r => ({
        walletAddress: r.wallet_address,
        name: r.agent_name,
        sybilRiskScore: r.sybil_risk_score,
        collusionDetected: r.collusion_detected,
        quarantineRecommended: r.quarantine_rec,
        flags: r.flags_json,
        scannedAt: new Date(r.scanned_at).toISOString(),
    }));
}
// ─── Network Metrics ────────────────────────────────────────────────
function computeNetworkMetrics(walletKey) {
    const node = agentGraph.get(walletKey);
    if (!node) {
        return {
            inDegree: 0, outDegree: 0, reciprocityRate: 0,
            clusterCoefficient: 0, betweennessCentrality: 0,
        };
    }
    const outDegree = node.edges.size;
    let inDegree = 0;
    let reciprocalCount = 0;
    for (const [, otherNode] of agentGraph) {
        if (otherNode.edges.has(walletKey)) {
            inDegree++;
            if (node.edges.has(otherNode.walletAddress.toLowerCase())) {
                reciprocalCount++;
            }
        }
    }
    const totalConnections = Math.max(1, inDegree + outDegree);
    const reciprocityRate = totalConnections > 0
        ? (reciprocalCount * 2) / totalConnections
        : 0;
    const neighbors = new Set([...node.edges.keys()]);
    let triangles = 0;
    let possibleTriangles = 0;
    for (const n1 of neighbors) {
        for (const n2 of neighbors) {
            if (n1 !== n2) {
                possibleTriangles++;
                const n1Node = agentGraph.get(n1);
                if (n1Node?.edges.has(n2))
                    triangles++;
            }
        }
    }
    const clusterCoefficient = possibleTriangles > 0 ? triangles / possibleTriangles : 0;
    const totalNodes = agentGraph.size;
    const betweennessCentrality = totalNodes > 2
        ? Math.min(1, (inDegree * outDegree) / ((totalNodes - 1) * (totalNodes - 2)))
        : 0;
    return {
        inDegree,
        outDegree,
        reciprocityRate: Math.round(reciprocityRate * 100) / 100,
        clusterCoefficient: Math.round(clusterCoefficient * 100) / 100,
        betweennessCentrality: Math.round(betweennessCentrality * 1000) / 1000,
    };
}
// ─── Cluster Detection ──────────────────────────────────────────────
function detectClusterMembership(walletKey) {
    const node = agentGraph.get(walletKey);
    if (!node || node.edges.size === 0)
        return [];
    const visited = new Set();
    const cluster = [];
    function dfs(key, depth) {
        if (depth > 3 || visited.has(key))
            return;
        visited.add(key);
        cluster.push(key);
        const n = agentGraph.get(key);
        if (!n)
            return;
        for (const [neighbor, edge] of n.edges) {
            if (edge.txCount >= 5) {
                const reverseNode = agentGraph.get(neighbor);
                if (reverseNode?.edges.has(key)) {
                    dfs(neighbor, depth + 1);
                }
            }
        }
    }
    dfs(walletKey, 0);
    if (cluster.length >= 3) {
        const clusterId = `SYB-${cluster.sort().join('').slice(0, 8)}`;
        return [clusterId];
    }
    return [];
}
// ─── Stats ──────────────────────────────────────────────────────────
export async function getSybilStats() {
    if (isDbConnected()) {
        const agents = await query('SELECT COUNT(*) as count FROM agents');
        const edges = await query('SELECT COUNT(*) as count FROM sybil_edges');
        const scans = await query('SELECT COUNT(DISTINCT wallet_address) as count FROM sybil_scan_results WHERE sybil_risk_score >= 50');
        return {
            trackedAgents: agents ? parseInt(agents.rows[0].count) : 0,
            totalEdges: edges ? parseInt(edges.rows[0].count) : 0,
            suspectedClusters: scans ? parseInt(scans.rows[0].count) : 0,
            storageMode: 'postgresql',
        };
    }
    // Fallback: in-memory stats
    let totalEdges = 0;
    const clusters = new Set();
    for (const node of agentGraph.values()) {
        totalEdges += node.edges.size;
    }
    for (const [key] of agentGraph) {
        const c = detectClusterMembership(key);
        c.forEach(id => clusters.add(id));
    }
    return {
        trackedAgents: agentGraph.size,
        totalEdges,
        suspectedClusters: clusters.size,
        storageMode: 'memory',
    };
}
