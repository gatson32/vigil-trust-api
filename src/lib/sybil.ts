// VIGIL Proprietary — Sybil & Collusion Detection Engine
// Detects coordinated manipulation, circular fund flows, and artificial metric inflation
// Patent-pending scoring methodology. All rights reserved.

import type { ScoredAgent } from './scoring.js';

// ─── Types ──────────────────────────────────────────────────────────

export interface SybilResult {
  sybilRiskScore: number;           // 0-100 (0 = clean, 100 = definite sybil)
  collusionDetected: boolean;
  quarantineRecommended: boolean;
  flags: SybilFlag[];
  clusterIds: string[];             // Suspected sybil cluster memberships
  networkMetrics: NetworkMetrics;
}

export interface SybilFlag {
  type: SybilFlagType;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  evidence: string;
  confidence: number;               // 0-1
}

export type SybilFlagType =
  | 'CIRCULAR_FLOW'          // A→B→C→A fund patterns
  | 'SELF_DEALING'           // Agent buying from itself via proxy
  | 'VOLUME_INFLATION'       // Artificial transaction volume
  | 'REFERRAL_BIAS'          // Suspicious referral concentration
  | 'TIMING_CORRELATION'     // Coordinated same-block transactions
  | 'WALLET_CLUSTER'         // Wallets likely controlled by same entity
  | 'METRIC_FARMING'         // Pattern consistent with metric manipulation
  | 'WASH_TRADING';          // Buy-sell loops with minimal spread

export interface NetworkMetrics {
  inDegree: number;            // How many agents send TO this agent
  outDegree: number;           // How many agents this agent sends TO
  reciprocityRate: number;     // % of connections that are bidirectional
  clusterCoefficient: number;  // Local clustering (triadic closure)
  betweennessCentrality: number; // How often agent bridges between others
}

// ─── Transaction Graph Store ────────────────────────────────────────

interface AgentNode {
  walletAddress: string;
  name: string;
  edges: Map<string, EdgeData>;  // Target wallet → edge data
}

interface EdgeData {
  txCount: number;
  totalValue: number;
  firstSeen: number;
  lastSeen: number;
  avgSpread: number;  // Price spread in agent-to-agent trades
}

const agentGraph = new Map<string, AgentNode>();

// ─── Graph Builder ──────────────────────────────────────────────────

/**
 * Register an agent in the transaction graph.
 * In production, this consumes raw ACP transaction events.
 * For now, we build the graph from scored agent metadata.
 */
export function registerAgent(agent: ScoredAgent): void {
  const key = agent.walletAddress.toLowerCase();

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
 * Called when we observe agent-to-agent commerce on ACP.
 */
export function recordTransaction(
  from: string,
  to: string,
  value: number,
  spread: number = 0,
): void {
  const fromKey = from.toLowerCase();
  const toKey = to.toLowerCase();
  const now = Date.now();

  // Ensure nodes exist
  if (!agentGraph.has(fromKey)) {
    agentGraph.set(fromKey, { walletAddress: from, name: '', edges: new Map() });
  }
  if (!agentGraph.has(toKey)) {
    agentGraph.set(toKey, { walletAddress: to, name: '', edges: new Map() });
  }

  const node = agentGraph.get(fromKey)!;
  const existing = node.edges.get(toKey);

  if (existing) {
    existing.txCount++;
    existing.totalValue += value;
    existing.lastSeen = now;
    existing.avgSpread = (existing.avgSpread * (existing.txCount - 1) + spread) / existing.txCount;
  } else {
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
export function analyzeSybilRisk(agent: ScoredAgent): SybilResult {
  const key = agent.walletAddress.toLowerCase();
  const flags: SybilFlag[] = [];

  registerAgent(agent);
  const node = agentGraph.get(key);
  const networkMetrics = computeNetworkMetrics(key);

  // === Check 1: Buyer Concentration Anomaly ===
  // If agent has high volume but very few unique buyers = suspicious
  if (agent.transactionCount > 100 && agent.uniqueBuyerCount > 0) {
    const txPerBuyer = agent.transactionCount / agent.uniqueBuyerCount;
    if (txPerBuyer > 50) {
      flags.push({
        type: 'VOLUME_INFLATION',
        severity: txPerBuyer > 200 ? 'critical' : 'high',
        description: `Extremely low buyer diversity: ${txPerBuyer.toFixed(0)} transactions per unique buyer`,
        evidence: `${agent.transactionCount} txs from only ${agent.uniqueBuyerCount} buyers`,
        confidence: Math.min(0.9, txPerBuyer / 200),
      });
    }
  }

  // === Check 2: Metric Farming Pattern ===
  // High job count but near-zero economic value = farming metrics
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
  // 100% success rate over large volume is statistically improbable
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
      if (edge.avgSpread < 0.005 && edge.txCount > 10) { // < 0.5% spread
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
          break; // One wash trading flag is enough
        }
      }
    }
  }

  // === Check 6: Wallet Age vs Activity Ratio ===
  // Brand new wallet with massive activity = suspicious
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
    const severityWeight =
      flag.severity === 'critical' ? 30 :
        flag.severity === 'high' ? 20 :
          flag.severity === 'medium' ? 10 : 5;
    sybilRiskScore += severityWeight * flag.confidence;
  }
  sybilRiskScore = Math.min(100, Math.round(sybilRiskScore));

  // Determine cluster membership
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

// ─── Network Metrics ────────────────────────────────────────────────

function computeNetworkMetrics(walletKey: string): NetworkMetrics {
  const node = agentGraph.get(walletKey);
  if (!node) {
    return {
      inDegree: 0, outDegree: 0, reciprocityRate: 0,
      clusterCoefficient: 0, betweennessCentrality: 0,
    };
  }

  const outDegree = node.edges.size;

  // Count in-degree (how many agents have edges TO this one)
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

  // Cluster coefficient: what fraction of this agent's neighbors are connected to each other
  const neighbors = new Set([...node.edges.keys()]);
  let triangles = 0;
  let possibleTriangles = 0;

  for (const n1 of neighbors) {
    for (const n2 of neighbors) {
      if (n1 !== n2) {
        possibleTriangles++;
        const n1Node = agentGraph.get(n1);
        if (n1Node?.edges.has(n2)) triangles++;
      }
    }
  }

  const clusterCoefficient = possibleTriangles > 0
    ? triangles / possibleTriangles
    : 0;

  // Betweenness centrality approximation (simplified)
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

function detectClusterMembership(walletKey: string): string[] {
  const node = agentGraph.get(walletKey);
  if (!node || node.edges.size === 0) return [];

  // Simple connected-component detection
  // Group tightly-connected agents into suspected sybil clusters
  const visited = new Set<string>();
  const cluster: string[] = [];

  function dfs(key: string, depth: number) {
    if (depth > 3 || visited.has(key)) return; // Max 3 hops
    visited.add(key);
    cluster.push(key);

    const n = agentGraph.get(key);
    if (!n) return;

    for (const [neighbor, edge] of n.edges) {
      // Only follow strong connections (>5 txs and bidirectional)
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

export function getSybilStats(): {
  trackedAgents: number;
  totalEdges: number;
  suspectedClusters: number;
} {
  let totalEdges = 0;
  const clusters = new Set<string>();

  for (const node of agentGraph.values()) {
    totalEdges += node.edges.size;
  }

  // Count unique clusters
  for (const [key] of agentGraph) {
    const c = detectClusterMembership(key);
    c.forEach(id => clusters.add(id));
  }

  return {
    trackedAgents: agentGraph.size,
    totalEdges,
    suspectedClusters: clusters.size,
  };
}
