// VIGIL Trust Score API Server
// On-chain credit bureau for AI agents on Virtuals Protocol

import express from 'express';
import cors from 'cors';
import { scoreAgent, TIER_CONFIG, type ScoredAgent } from './lib/scoring.js';
import {
  fetchAgentsPage,
  fetchAgentByWallet,
  fetchAgentById,
  searchAgents,
} from './lib/virtuals-client.js';
import { TTLCache } from './lib/cache.js';
import {
  recordSnapshot,
  getHistory,
  getScoreDeltas,
  getHistoryStats,
  getRecentMovers,
} from './lib/history.js';
import { initDb, closeDb, isDbConnected } from './lib/db.js';
import { assessAgent, type SentinelVerdict, type SentinelContext } from './lib/sentinel.js';
import { startEvaluatorListener } from './lib/evaluator.js';
import {
  scoreByQuery as scoreDegenClawByQuery,
  scoreAllAgents as scoreAllDegenClawAgents,
  type DegenClawRiskReport,
} from './lib/degenclaw.js';
import {
  writeDegenClawSnapshot,
  getAgentHistory as getDegenClawAgentHistory,
  getSnapshotStats,
} from './lib/snapshots.js';
import {
  scorePolymarketTrader,
  type PolymarketRiskReport,
} from './lib/polymarket.js';

const app = express();
const PORT = parseInt(process.env.PORT || '3100', 10);

// Enable trust-proxy for proper IP detection behind reverse proxies (Render, etc.)
app.set('trust proxy', 1);

// ============================================================
//  CONFIGURATION
// ============================================================

const ALLOWED_ORIGINS = [
  'https://vigiltrust.io',
  'https://www.vigiltrust.io',
  'http://localhost:5173',    // Vite dev
  'http://localhost:3000',    // local dev
];

// Rate limiting — simple in-memory sliding window
const RATE_LIMIT_WINDOW_MS = 60_000;  // 1 minute
const RATE_LIMIT_MAX = 60;            // 60 requests per minute per IP
const rateLimitStore = new Map<string, { count: number; resetAt: number }>();

function getRateLimitInfo(ip: string): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  let entry = rateLimitStore.get(ip);

  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateLimitStore.set(ip, entry);
  }

  entry.count++;
  const allowed = entry.count <= RATE_LIMIT_MAX;
  const remaining = Math.max(0, RATE_LIMIT_MAX - entry.count);

  return { allowed, remaining, resetAt: entry.resetAt };
}

// Clean up rate limit store periodically (every 5 min)
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitStore) {
    if (now > entry.resetAt) rateLimitStore.delete(ip);
  }
}, 300_000);

// ============================================================
//  CACHES
// ============================================================

const leaderboardCache = new TTLCache<unknown>(300);   // 5 min
const scoreCache = new TTLCache<unknown>(120);         // 2 min
const ecosystemCache = new TTLCache<unknown>(300);     // 5 min

// Circuit breaker state for upstream Virtuals API
let upstreamHealthy = true;
let upstreamFailCount = 0;
let upstreamLastFailure = 0;
const UPSTREAM_FAIL_THRESHOLD = 3;
const UPSTREAM_RECOVERY_MS = 30_000; // 30s cooldown before retrying

function recordUpstreamSuccess() {
  upstreamHealthy = true;
  upstreamFailCount = 0;
}

function recordUpstreamFailure() {
  upstreamFailCount++;
  upstreamLastFailure = Date.now();
  if (upstreamFailCount >= UPSTREAM_FAIL_THRESHOLD) {
    upstreamHealthy = false;
    console.warn(`[CIRCUIT BREAKER] Upstream marked unhealthy after ${upstreamFailCount} failures`);
  }
}

function isUpstreamAvailable(): boolean {
  if (upstreamHealthy) return true;
  // Allow retry after cooldown
  if (Date.now() - upstreamLastFailure > UPSTREAM_RECOVERY_MS) {
    console.log('[CIRCUIT BREAKER] Cooldown elapsed, allowing retry');
    return true;
  }
  return false;
}

// ============================================================
//  MIDDLEWARE
// ============================================================

// CORS — restricted to known origins (falls back to open for API consumers)
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (curl, server-to-server, mobile apps)
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    // For now, allow all origins but log unknown ones
    // TODO: Restrict to API key holders only
    console.log(`[CORS] Request from unlisted origin: ${origin}`);
    return callback(null, true);
  },
  methods: ['GET', 'POST'],
  maxAge: 86400,
}));

app.use(express.json());

// Request logging
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path} [${req.ip}]`);
  next();
});

// Rate limiting middleware
app.use((req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const { allowed, remaining, resetAt } = getRateLimitInfo(ip);

  res.setHeader('X-RateLimit-Limit', RATE_LIMIT_MAX.toString());
  res.setHeader('X-RateLimit-Remaining', remaining.toString());
  res.setHeader('X-RateLimit-Reset', Math.ceil(resetAt / 1000).toString());

  if (!allowed) {
    return res.status(429).json({
      error: 'Rate limit exceeded',
      message: `Maximum ${RATE_LIMIT_MAX} requests per minute. Try again shortly.`,
      retryAfter: Math.ceil((resetAt - Date.now()) / 1000),
    });
  }

  next();
});

// ============================================================
//  INPUT VALIDATION HELPERS
// ============================================================

function isValidIdentifier(id: string): boolean {
  // Wallet address: 0x followed by 40 hex chars
  if (/^0x[a-fA-F0-9]{40}$/.test(id)) return true;
  // Document ID: alphanumeric, reasonable length
  if (/^[a-zA-Z0-9_-]{1,100}$/.test(id)) return true;
  return false;
}

function sanitizeSearchQuery(q: string): string {
  // Remove any characters that could be used for injection
  return q.replace(/[^\w\s\-_.]/g, '').trim().slice(0, 100);
}

function clampInt(value: string | undefined, min: number, max: number, defaultVal: number): number {
  const parsed = parseInt(value as string);
  if (isNaN(parsed)) return defaultVal;
  return Math.min(max, Math.max(min, parsed));
}

// ============================================================
//  HELPER: format scored agent for API response
// ============================================================

function formatAgentResponse(agent: ScoredAgent) {
  return {
    name: agent.name,
    documentId: agent.documentId,
    walletAddress: agent.walletAddress,
    profilePic: agent.profilePic,
    category: agent.category,
    symbol: agent.symbol,
    twitterHandle: agent.twitterHandle,
    cluster: agent.cluster,
    role: agent.role,
    isOnline: agent.isOnline,
    hasGraduated: agent.hasGraduated,
    trustScore: agent.trustScore,
    trustTier: agent.trustTier,
    trustGrade: agent.trustGrade,
    tierLabel: TIER_CONFIG[agent.trustTier].label,
    riskFlags: agent.riskFlags,
    scoreBreakdown: {
      // Core dimensions (55%)
      reliability: { score: agent.reliabilityScore, weight: 0.15 },
      activity: { score: agent.activityScore, weight: 0.10 },
      economic: { score: agent.economicScore, weight: 0.10 },
      reputation: { score: agent.reputationScore, weight: 0.10 },
      longevity: { score: agent.longevityScore, weight: 0.10 },
      // Proprietary dimensions (45%)
      behavioral: { score: agent.behavioralScore, weight: 0.10, label: 'Behavioral Anomaly' },
      complexity: { score: agent.complexityScore, weight: 0.10, label: 'Task Complexity' },
      sustainability: { score: agent.sustainabilityScore, weight: 0.10, label: 'Economic Sustainability' },
      // Penalty systems (not weighted — applied as modifiers)
      sybilRisk: { score: agent.sybilRiskScore, weight: 0, label: 'Sybil Risk (penalty)' },
      regression: { score: agent.regressionScore, weight: 0, label: 'Performance Stability' },
    },
    metrics: {
      successRate: agent.successRate,
      successfulJobCount: agent.successfulJobCount,
      uniqueBuyerCount: agent.uniqueBuyerCount,
      transactionCount: agent.transactionCount,
      grossAgenticAmount: agent.grossAgenticAmount,
      walletBalance: agent.walletBalance,
      revenue: agent.revenue,
      jobCount: agent.jobCount,
      offeringCount: agent.offeringCount,
      chainCount: agent.chainCount,
      accountAgeDays: agent.accountAgeDays,
      daysSinceActive: agent.daysSinceActive,
    },
  };
}

// ============================================================
//  ROUTES
// ============================================================

// --- Health check ---
app.get('/v1/health', async (_req, res) => {
  const historyStats = await getHistoryStats();
  res.json({
    status: 'ok',
    version: '1.10.2',
    service: 'VIGIL Trust Score API',
    timestamp: new Date().toISOString(),
    upstream: {
      healthy: upstreamHealthy,
      failCount: upstreamFailCount,
    },
    database: {
      connected: isDbConnected(),
    },
    cache: {
      leaderboard: leaderboardCache.size,
      scores: scoreCache.size,
      ecosystem: ecosystemCache.size,
    },
    rateLimit: {
      windowMs: RATE_LIMIT_WINDOW_MS,
      maxRequests: RATE_LIMIT_MAX,
      activeClients: rateLimitStore.size,
    },
    history: historyStats,
  });
});

// --- GET /v1/score/:identifier ---
app.get('/v1/score/:identifier', async (req, res) => {
  try {
    const { identifier } = req.params;

    // Validate identifier
    if (!isValidIdentifier(identifier)) {
      return res.status(400).json({
        error: 'Invalid identifier',
        message: 'Identifier must be a valid wallet address (0x...) or alphanumeric document ID',
      });
    }

    const cacheKey = `score:${identifier.toLowerCase()}`;

    // Check cache
    const cached = scoreCache.get(cacheKey);
    if (cached) {
      return res.json({ data: cached, cached: true });
    }

    // Circuit breaker check
    if (!isUpstreamAvailable()) {
      return res.status(503).json({
        error: 'Service temporarily unavailable',
        message: 'Upstream data source is temporarily unreachable. Try again in 30 seconds.',
      });
    }

    // Determine if wallet address or documentId
    let raw;
    try {
      if (identifier.startsWith('0x') && identifier.length === 42) {
        raw = await fetchAgentByWallet(identifier);
      } else {
        raw = await fetchAgentById(identifier);
      }
      recordUpstreamSuccess();
    } catch (upstreamErr) {
      recordUpstreamFailure();
      throw upstreamErr;
    }

    if (!raw) {
      return res.status(404).json({
        error: 'Agent not found',
        message: `No agent found for identifier: ${identifier}`,
      });
    }

    const scored = await scoreAgent(raw);
    const response = formatAgentResponse(scored);
    scoreCache.set(cacheKey, response);

    // Record history snapshot
    await recordSnapshot(scored.walletAddress, scored.name, {
      trustScore: scored.trustScore,
      trustTier: scored.trustTier,
      reliabilityScore: scored.reliabilityScore,
      activityScore: scored.activityScore,
      economicScore: scored.economicScore,
      reputationScore: scored.reputationScore,
      longevityScore: scored.longevityScore,
      behavioralScore: scored.behavioralScore,
      complexityScore: scored.complexityScore,
      sustainabilityScore: scored.sustainabilityScore,
      sybilRiskScore: scored.sybilRiskScore,
      regressionScore: scored.regressionScore,
      riskFlags: scored.riskFlags,
    });

    return res.json({ data: response, cached: false });
  } catch (err) {
    console.error('Score lookup error:', err);
    return res.status(502).json({
      error: 'Upstream error',
      message: 'Failed to fetch agent data from Virtuals Protocol',
    });
  }
});

// --- GET /v1/leaderboard ---
app.get('/v1/leaderboard', async (req, res) => {
  try {
    const page = clampInt(req.query.page as string, 1, 100, 1);
    const pageSize = clampInt(req.query.pageSize as string, 1, 100, 25);
    const tier = (req.query.tier as string)?.toUpperCase();
    const category = req.query.category as string;
    const sortBy = (req.query.sort as string) || 'trustScore';
    const order = (req.query.order as string)?.toLowerCase() === 'asc' ? 'asc' : 'desc';

    // Validate tier if provided
    if (tier && !(tier in TIER_CONFIG)) {
      return res.status(400).json({
        error: 'Invalid tier',
        message: `Valid tiers: ${Object.keys(TIER_CONFIG).join(', ')}`,
      });
    }

    const cacheKey = `lb:${page}:${pageSize}:${tier || ''}:${category || ''}:${sortBy}:${order}`;
    const cached = leaderboardCache.get(cacheKey);
    if (cached) {
      return res.json({ ...(cached as object), cached: true });
    }

    if (!isUpstreamAvailable()) {
      return res.status(503).json({
        error: 'Service temporarily unavailable',
        message: 'Upstream data source is temporarily unreachable.',
      });
    }

    const fetchSize = Math.min(100, pageSize * 2);
    let result;
    try {
      result = await fetchAgentsPage(page, fetchSize, 'grossAgenticAmount:desc');
      recordUpstreamSuccess();
    } catch (upstreamErr) {
      recordUpstreamFailure();
      throw upstreamErr;
    }

    const scoredAgents = await Promise.all(result.data.map(scoreAgent));
    // Record history for all scored agents
    await Promise.all(scoredAgents.map(s =>
      recordSnapshot(s.walletAddress, s.name, {
        trustScore: s.trustScore, trustTier: s.trustTier,
        reliabilityScore: s.reliabilityScore, activityScore: s.activityScore,
        economicScore: s.economicScore, reputationScore: s.reputationScore,
        longevityScore: s.longevityScore,
        behavioralScore: s.behavioralScore, complexityScore: s.complexityScore,
        sustainabilityScore: s.sustainabilityScore, sybilRiskScore: s.sybilRiskScore,
        regressionScore: s.regressionScore, riskFlags: s.riskFlags,
      })
    ));
    let agents = scoredAgents.map(formatAgentResponse);

    if (tier && tier in TIER_CONFIG) {
      agents = agents.filter(a => a.trustTier === tier);
    }

    if (category) {
      agents = agents.filter(a => a.category.toLowerCase() === category.toLowerCase());
    }

    const validSorts = ['trustScore', 'grossAgenticAmount', 'successRate', 'successfulJobCount', 'uniqueBuyerCount'];
    const sortField = validSorts.includes(sortBy) ? sortBy : 'trustScore';

    agents.sort((a, b) => {
      const aVal = sortField === 'trustScore' ? a.trustScore :
        (a.metrics as Record<string, number>)[sortField] || 0;
      const bVal = sortField === 'trustScore' ? b.trustScore :
        (b.metrics as Record<string, number>)[sortField] || 0;
      return order === 'asc' ? aVal - bVal : bVal - aVal;
    });

    const sliced = agents.slice(0, pageSize);

    const response = {
      data: sliced,
      meta: {
        page,
        pageSize,
        total: result.meta.pagination.total,
        pageCount: result.meta.pagination.pageCount,
        filters: { tier: tier || null, category: category || null },
        sort: { field: sortField, order },
      },
      cached: false,
    };

    leaderboardCache.set(cacheKey, response);
    return res.json(response);
  } catch (err) {
    console.error('Leaderboard error:', err);
    return res.status(502).json({
      error: 'Upstream error',
      message: 'Failed to fetch leaderboard data',
    });
  }
});

// --- GET /v1/search ---
app.get('/v1/search', async (req, res) => {
  try {
    const rawQ = req.query.q as string;
    if (!rawQ || rawQ.length < 2) {
      return res.status(400).json({
        error: 'Invalid query',
        message: 'Search query must be at least 2 characters',
      });
    }

    const q = sanitizeSearchQuery(rawQ);
    if (q.length < 2) {
      return res.status(400).json({
        error: 'Invalid query',
        message: 'Search query contains only invalid characters',
      });
    }

    const page = clampInt(req.query.page as string, 1, 100, 1);
    const pageSize = clampInt(req.query.pageSize as string, 1, 50, 10);

    if (!isUpstreamAvailable()) {
      return res.status(503).json({
        error: 'Service temporarily unavailable',
        message: 'Upstream data source is temporarily unreachable.',
      });
    }

    let result;
    try {
      result = await searchAgents(q, page, pageSize);
      recordUpstreamSuccess();
    } catch (upstreamErr) {
      recordUpstreamFailure();
      throw upstreamErr;
    }

    const agents = (await Promise.all(result.data.map(scoreAgent))).map(formatAgentResponse);

    return res.json({
      data: agents,
      meta: {
        query: q,
        page,
        pageSize,
        total: result.meta.pagination.total,
        pageCount: result.meta.pagination.pageCount,
      },
    });
  } catch (err) {
    console.error('Search error:', err);
    return res.status(502).json({
      error: 'Upstream error',
      message: 'Failed to search agents',
    });
  }
});

// --- GET /v1/ecosystem/health ---
app.get('/v1/ecosystem/health', async (req, res) => {
  try {
    const cacheKey = 'ecosystem:health';
    const cached = ecosystemCache.get(cacheKey);
    if (cached) {
      return res.json({ ...(cached as object), cached: true });
    }

    if (!isUpstreamAvailable()) {
      return res.status(503).json({
        error: 'Service temporarily unavailable',
        message: 'Upstream data source is temporarily unreachable.',
      });
    }

    let result;
    try {
      result = await fetchAgentsPage(1, 100, 'grossAgenticAmount:desc');
      recordUpstreamSuccess();
    } catch (upstreamErr) {
      recordUpstreamFailure();
      throw upstreamErr;
    }

    const agents = await Promise.all(result.data.map(scoreAgent));

    const tierDistribution: Record<string, number> = {};
    for (const tier of Object.keys(TIER_CONFIG)) {
      tierDistribution[tier] = agents.filter(a => a.trustTier === tier).length;
    }

    const avgTrustScore = agents.length > 0
      ? Math.round(agents.reduce((sum, a) => sum + a.trustScore, 0) / agents.length)
      : 0;

    const onlineCount = agents.filter(a => a.isOnline).length;
    const graduatedCount = agents.filter(a => a.hasGraduated).length;
    const totalJobs = agents.reduce((sum, a) => sum + a.successfulJobCount, 0);
    const totalAgdp = agents.reduce((sum, a) => sum + a.grossAgenticAmount, 0);
    const totalRevenue = agents.reduce((sum, a) => sum + a.revenue, 0);
    const avgSuccessRate = agents.length > 0
      ? Math.round(agents.reduce((sum, a) => sum + a.successRate, 0) / agents.length * 10) / 10
      : 0;
    const riskyAgents = agents.filter(a => a.riskFlags.length > 0);

    const response = {
      data: {
        totalAgents: result.meta.pagination.total,
        sampleSize: agents.length,
        avgTrustScore,
        avgSuccessRate,
        tierDistribution,
        onlineCount,
        graduatedCount,
        totalJobs,
        totalAgdp: Math.round(totalAgdp * 100) / 100,
        totalRevenue: Math.round(totalRevenue * 100) / 100,
        riskSummary: {
          flaggedCount: riskyAgents.length,
          commonFlags: Object.entries(
            riskyAgents.flatMap(a => a.riskFlags).reduce((acc, flag) => {
              acc[flag] = (acc[flag] || 0) + 1;
              return acc;
            }, {} as Record<string, number>)
          ).sort((a, b) => b[1] - a[1]),
        },
        timestamp: new Date().toISOString(),
      },
      cached: false,
    };

    ecosystemCache.set(cacheKey, response);
    return res.json(response);
  } catch (err) {
    console.error('Ecosystem health error:', err);
    return res.status(502).json({
      error: 'Upstream error',
      message: 'Failed to compute ecosystem health',
    });
  }
});

// --- GET /v1/compare ---
app.get('/v1/compare', async (req, res) => {
  try {
    const ids = (req.query.ids as string)?.split(',').map(s => s.trim()).filter(Boolean);
    if (!ids || ids.length < 2 || ids.length > 5) {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Provide 2-5 agent identifiers separated by commas',
      });
    }

    // Validate each identifier
    for (const id of ids) {
      if (!isValidIdentifier(id)) {
        return res.status(400).json({
          error: 'Invalid identifier',
          message: `Invalid identifier: "${id}". Must be a wallet address (0x...) or alphanumeric document ID`,
        });
      }
    }

    if (!isUpstreamAvailable()) {
      return res.status(503).json({
        error: 'Service temporarily unavailable',
        message: 'Upstream data source is temporarily unreachable.',
      });
    }

    const results = await Promise.allSettled(
      ids.map(async (id) => {
        const raw = id.startsWith('0x') && id.length === 42
          ? await fetchAgentByWallet(id)
          : await fetchAgentById(id);
        if (!raw) throw new Error(`Not found: ${id}`);
        return formatAgentResponse(await scoreAgent(raw));
      })
    );

    // Track upstream health
    const anyFailed = results.some(r => r.status === 'rejected');
    const anySucceeded = results.some(r => r.status === 'fulfilled');
    if (anySucceeded) recordUpstreamSuccess();
    if (anyFailed && !anySucceeded) recordUpstreamFailure();

    const agents = results.map((r, i) => ({
      identifier: ids[i],
      status: r.status,
      data: r.status === 'fulfilled' ? r.value : null,
      error: r.status === 'rejected' ? (r.reason as Error).message : null,
    }));

    return res.json({ data: agents });
  } catch (err) {
    console.error('Compare error:', err);
    return res.status(502).json({ error: 'Upstream error', message: 'Failed to compare agents' });
  }
});

// --- GET /v1/sentinel/:identifier ---
app.get('/v1/sentinel/:identifier', async (req, res) => {
  try {
    const { identifier } = req.params;

    // Validate identifier
    if (!isValidIdentifier(identifier)) {
      return res.status(400).json({
        error: 'Invalid identifier',
        message: 'Identifier must be a valid wallet address (0x...) or alphanumeric document ID',
      });
    }

    const cacheKey = `sentinel:${identifier.toLowerCase()}`;

    // Check cache
    const cached = scoreCache.get(cacheKey);
    if (cached) {
      return res.json({ data: cached, cached: true });
    }

    // Circuit breaker check
    if (!isUpstreamAvailable()) {
      return res.status(503).json({
        error: 'Service temporarily unavailable',
        message: 'Upstream data source is temporarily unreachable. Try again in 30 seconds.',
      });
    }

    // Fetch agent
    let raw;
    try {
      if (identifier.startsWith('0x') && identifier.length === 42) {
        raw = await fetchAgentByWallet(identifier);
      } else {
        raw = await fetchAgentById(identifier);
      }
      recordUpstreamSuccess();
    } catch (upstreamErr) {
      recordUpstreamFailure();
      throw upstreamErr;
    }

    if (!raw) {
      return res.status(404).json({
        error: 'Agent not found',
        message: `No agent found for identifier: ${identifier}`,
      });
    }

    // Score and assess agent
    const scored = await scoreAgent(raw);

    // Create sentinel context with the scored agent
    const context: SentinelContext = {
      allAgents: [scored],
      scanTimestamp: Date.now(),
    };

    // Run full sentinel assessment
    const verdict = assessAgent(scored, context);

    // Cache the verdict
    scoreCache.set(cacheKey, verdict);

    return res.json({ data: verdict, cached: false });
  } catch (err) {
    console.error('Sentinel assessment error:', err);
    return res.status(502).json({
      error: 'Upstream error',
      message: 'Failed to perform sentinel assessment on agent',
    });
  }
});

// --- POST /v1/acp/trust-score (ACP-compatible trust score endpoint) ---
app.post('/v1/acp/trust-score', async (req, res) => {
  try {
    const { walletAddress, agentId } = req.body;

    // Validate input
    if (!walletAddress && !agentId) {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Body must include walletAddress or agentId',
      });
    }

    const identifier = walletAddress || agentId;

    // Validate identifier
    if (!isValidIdentifier(identifier)) {
      return res.status(400).json({
        error: 'Invalid identifier',
        message: 'Identifier must be a valid wallet address (0x...) or alphanumeric document ID',
      });
    }

    const cacheKey = `acp-trust:${identifier.toLowerCase()}`;

    // Check cache
    const cached = scoreCache.get(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    // Circuit breaker check
    if (!isUpstreamAvailable()) {
      return res.status(503).json({
        service: 'VIGIL Trust Score',
        version: '1.4.0',
        error: 'Service temporarily unavailable',
        message: 'Upstream data source is temporarily unreachable.',
      });
    }

    // Fetch agent
    let raw;
    try {
      if (identifier.startsWith('0x') && identifier.length === 42) {
        raw = await fetchAgentByWallet(identifier);
      } else {
        raw = await fetchAgentById(identifier);
      }
      recordUpstreamSuccess();
    } catch (upstreamErr) {
      recordUpstreamFailure();
      throw upstreamErr;
    }

    if (!raw) {
      return res.status(404).json({
        service: 'VIGIL Trust Score',
        version: '1.4.0',
        error: 'Agent not found',
        message: `No agent found for identifier: ${identifier}`,
      });
    }

    // Score and assess agent
    const scored = await scoreAgent(raw);

    // Create sentinel context
    const context: SentinelContext = {
      allAgents: [scored],
      scanTimestamp: Date.now(),
    };

    // Run sentinel assessment
    const verdict = assessAgent(scored, context);

    // Build ACP-compatible response
    const acpResponse = {
      service: 'VIGIL Trust Score',
      version: '1.4.0',
      result: {
        trustScore: scored.trustScore,
        trustTier: scored.trustTier,
        trustGrade: scored.trustGrade,
        riskFlags: scored.riskFlags,
        sybilRiskScore: scored.sybilRiskScore,
        threatLevel: verdict.threatLevel,
        sentinel: {
          alertCount: verdict.allAlerts.length,
          criticalCount: verdict.allAlerts.filter(a => a.severity === 'critical' || a.severity === 'emergency').length,
          verdict: verdict.threatLevel === 'SAFE' ? 'CLEAR' : 'FLAGGED',
        },
      },
      pricing: {
        cost: '1.00 USDC',
        protocol: 'Virtuals ACP',
      },
    };

    // Cache the response
    scoreCache.set(cacheKey, acpResponse);

    return res.json(acpResponse);
  } catch (err) {
    console.error('ACP trust score error:', err);
    return res.status(502).json({
      service: 'VIGIL Trust Score',
      version: '1.4.0',
      error: 'Upstream error',
      message: 'Failed to fetch trust score',
    });
  }
});

// --- GET /v1/alerts ---
app.get('/v1/alerts', async (req, res) => {
  try {
    const cacheKey = 'alerts:recent';
    const cached = leaderboardCache.get(cacheKey);
    if (cached) {
      return res.json({ ...(cached as object), cached: true });
    }

    if (!isUpstreamAvailable()) {
      return res.status(503).json({
        error: 'Service temporarily unavailable',
        message: 'Upstream data source is temporarily unreachable.',
      });
    }

    let result;
    try {
      result = await fetchAgentsPage(1, 100, 'grossAgenticAmount:desc');
      recordUpstreamSuccess();
    } catch (upstreamErr) {
      recordUpstreamFailure();
      throw upstreamErr;
    }

    const agents = await Promise.all(result.data.map(scoreAgent));
    const flagged = agents
      .filter(a => a.riskFlags.length > 0)
      .map(a => ({
        name: a.name,
        documentId: a.documentId,
        walletAddress: a.walletAddress,
        trustScore: a.trustScore,
        trustTier: a.trustTier,
        riskFlags: a.riskFlags,
        daysSinceActive: a.daysSinceActive,
        successRate: a.successRate,
      }))
      .sort((a, b) => a.trustScore - b.trustScore);

    const response = {
      data: flagged,
      meta: {
        totalFlagged: flagged.length,
        totalScanned: agents.length,
        timestamp: new Date().toISOString(),
      },
      cached: false,
    };

    leaderboardCache.set(cacheKey, response);
    return res.json(response);
  } catch (err) {
    console.error('Alerts error:', err);
    return res.status(502).json({ error: 'Upstream error', message: 'Failed to fetch alerts' });
  }
});

// --- GET /v1/history/:walletAddress ---
app.get('/v1/history/:walletAddress', async (req, res) => {
  const wallet = req.params.walletAddress;
  if (!isValidIdentifier(wallet) || !wallet.startsWith('0x')) {
    return res.status(400).json({
      error: 'Invalid wallet address',
      message: 'History requires a valid wallet address (0x...)',
    });
  }

  const history = await getHistory(wallet);
  if (!history) {
    return res.status(404).json({
      error: 'No history found',
      message: 'No score history recorded for this agent yet. Query /v1/score/:address first.',
    });
  }

  const hoursBack = clampInt(req.query.hours as string, 1, 168, 24);
  const deltas = await getScoreDeltas(wallet, hoursBack);

  return res.json({
    data: {
      walletAddress: history.walletAddress,
      name: history.name,
      firstSeen: new Date(history.firstSeen).toISOString(),
      lastUpdated: new Date(history.lastUpdated).toISOString(),
      snapshotCount: history.snapshots.length,
      snapshots: history.snapshots.map(s => ({
        ...s,
        timestamp: new Date(s.timestamp).toISOString(),
      })),
      deltas,
    },
  });
});

// --- GET /v1/movers ---
app.get('/v1/movers', async (req, res) => {
  const hoursBack = clampInt(req.query.hours as string, 1, 168, 24);
  const limit = clampInt(req.query.limit as string, 1, 50, 10);
  const movers = await getRecentMovers(hoursBack, limit);
  const histStats = await getHistoryStats();

  return res.json({
    data: movers.map(m => ({
      ...m,
      changeDirection: m.change > 0 ? '↑' : m.change < 0 ? '↓' : '—',
    })),
    meta: {
      hoursBack,
      timestamp: new Date().toISOString(),
      ...histStats,
    },
  });
});

// --- POST /v1/evaluate ---
// ACP-compatible evaluator endpoint — score a seller agent before approving a job
app.post('/v1/evaluate', async (req, res) => {
  try {
    const { jobId, buyerAddress, sellerAddress, deliverable, serviceRequirement, memos } = req.body;

    if (!sellerAddress) {
      return res.status(400).json({
        error: 'Missing required field',
        message: 'sellerAddress is required for evaluation',
      });
    }

    // Dynamic import to avoid loading evaluator module at startup
    const { evaluateJob } = await import('./lib/evaluator.js');

    const result = await evaluateJob({
      jobId: jobId || 'manual',
      buyerAddress: buyerAddress || 'unknown',
      sellerAddress,
      deliverable: deliverable || { type: 'unknown', value: null },
      serviceRequirement: serviceRequirement || null,
      memos: memos || [],
    });

    return res.json({
      data: result,
      cached: false,
    });
  } catch (err) {
    console.error('Evaluation error:', err);
    return res.status(502).json({
      error: 'Evaluation failed',
      message: 'Failed to evaluate agent. ' + (err as Error).message,
    });
  }
});

// --- Batch Evaluation ---
// Score multiple agents in one call — perfect for portfolio risk checks
app.post('/v1/evaluate/batch', async (req, res) => {
  try {
    const { addresses } = req.body;

    if (!addresses || !Array.isArray(addresses) || addresses.length === 0) {
      return res.status(400).json({
        error: 'Missing required field',
        message: 'addresses must be a non-empty array of wallet addresses',
      });
    }

    if (addresses.length > 20) {
      return res.status(400).json({
        error: 'Too many addresses',
        message: 'Maximum 20 addresses per batch request',
      });
    }

    const { evaluateJob } = await import('./lib/evaluator.js');
    const startTime = Date.now();

    const results = await Promise.allSettled(
      addresses.map((addr: string) =>
        evaluateJob({
          jobId: 'batch',
          buyerAddress: 'batch-caller',
          sellerAddress: addr,
          deliverable: { type: 'batch', value: null },
          serviceRequirement: null,
          memos: [],
        })
      )
    );

    const evaluations = results.map((r, i) => ({
      address: addresses[i],
      ...(r.status === 'fulfilled'
        ? { success: true, ...r.value }
        : { success: false, error: (r.reason as Error).message }),
    }));

    // Summary stats
    const successful = evaluations.filter((e: any) => e.success);
    const approved = successful.filter((e: any) => e.approved);
    const rejected = successful.filter((e: any) => !e.approved);
    const avgScore = successful.length > 0
      ? Math.round(successful.reduce((sum: number, e: any) => sum + (e.sellerTrustScore || 0), 0) / successful.length)
      : 0;

    return res.json({
      data: {
        evaluations,
        summary: {
          total: addresses.length,
          approved: approved.length,
          rejected: rejected.length,
          failed: results.filter(r => r.status === 'rejected').length,
          avgTrustScore: avgScore,
          batchDurationMs: Date.now() - startTime,
        },
      },
      cached: false,
    });
  } catch (err) {
    console.error('Batch evaluation error:', err);
    return res.status(502).json({
      error: 'Batch evaluation failed',
      message: (err as Error).message,
    });
  }
});

// --- Watchlist / Portfolio Monitor ---
// Check a set of agents and flag any changes or risks since last check
app.post('/v1/watchlist/check', async (req, res) => {
  try {
    const { addresses, thresholds } = req.body;

    if (!addresses || !Array.isArray(addresses) || addresses.length === 0) {
      return res.status(400).json({
        error: 'Missing required field',
        message: 'addresses must be a non-empty array of wallet addresses',
      });
    }

    if (addresses.length > 50) {
      return res.status(400).json({
        error: 'Too many addresses',
        message: 'Maximum 50 addresses per watchlist check',
      });
    }

    const minScore = thresholds?.minScore ?? 25;
    const flagOnRiskFlags = thresholds?.flagOnRiskFlags ?? true;
    const startTime = Date.now();

    // Score agents sequentially to avoid upstream rate limits
    const results: PromiseSettledResult<{ scored: ScoredAgent; sentinel: SentinelVerdict | null }>[] = [];
    for (const addr of addresses) {
      try {
        if (!isUpstreamAvailable()) throw new Error('Upstream unavailable');
        const raw = await fetchAgentByWallet(addr);
        if (!raw) throw new Error(`Agent not found: ${addr}`);
        recordUpstreamSuccess();
        const scored = await scoreAgent(raw);
        let sentinel: SentinelVerdict | null = null;
        try {
          const context: SentinelContext = {
            allAgents: [scored],
            scanTimestamp: Date.now(),
          };
          sentinel = assessAgent(scored, context);
        } catch (_sentinelErr) {
          // Sentinel scan is best-effort; continue without it
        }
        results.push({ status: 'fulfilled', value: { scored, sentinel } });
      } catch (err) {
        recordUpstreamFailure();
        results.push({ status: 'rejected', reason: err as Error });
      }
    }

    const agents = results.map((r, i) => {
      if (r.status === 'rejected') {
        return {
          address: addresses[i],
          status: 'error' as const,
          error: (r.reason as Error).message,
        };
      }

      const { scored, sentinel } = r.value;
      const alerts: string[] = [];

      if (scored.trustScore < minScore) {
        alerts.push(`SCORE_BELOW_THRESHOLD: ${scored.trustScore} < ${minScore}`);
      }
      if (flagOnRiskFlags && scored.riskFlags.length > 0) {
        alerts.push(`RISK_FLAGS: ${scored.riskFlags.join(', ')}`);
      }
      if (sentinel && (sentinel.threatLevel === 'CRITICAL' || sentinel.threatLevel === 'EMERGENCY')) {
        alerts.push(`SENTINEL_THREAT: ${sentinel.threatLevel}`);
      }

      return {
        address: addresses[i],
        name: scored.name,
        status: alerts.length > 0 ? 'alert' as const : 'ok' as const,
        trustScore: scored.trustScore,
        trustTier: scored.trustTier,
        riskFlags: scored.riskFlags,
        sentinelThreat: sentinel?.threatLevel ?? 'UNKNOWN',
        alerts,
      };
    });

    const alertCount = agents.filter(a => a.status === 'alert').length;
    const errorCount = agents.filter(a => a.status === 'error').length;

    return res.json({
      data: {
        agents,
        summary: {
          total: addresses.length,
          ok: agents.filter(a => a.status === 'ok').length,
          alerts: alertCount,
          errors: errorCount,
          checkDurationMs: Date.now() - startTime,
        },
        thresholds: { minScore, flagOnRiskFlags },
      },
      cached: false,
    });
  } catch (err) {
    console.error('Watchlist check error:', err);
    return res.status(502).json({
      error: 'Watchlist check failed',
      message: (err as Error).message,
    });
  }
});

// --- Quick Trust Check ---
// One-call trust gate for any agent — returns approve/deny in <500ms
// Designed for inline use: if (await vigil.check(addr)).safe) { proceed }
app.get('/v1/trust/:identifier', async (req, res) => {
  try {
    const { identifier } = req.params;
    const threshold = clampInt(req.query.threshold as string, 0, 100, 50);

    if (!isValidIdentifier(identifier)) {
      return res.status(400).json({ error: 'Invalid identifier' });
    }

    // Check cache first
    const cacheKey = `trust:${identifier}`;
    const cached = scoreCache.get(cacheKey);
    if (cached) {
      const c = cached as any;
      return res.json({
        data: {
          safe: c.trustScore >= threshold,
          score: c.trustScore,
          tier: c.trustTier,
          grade: c.trustGrade,
          flags: c.riskFlags,
          name: c.name,
          threshold,
        },
        cached: true,
      });
    }

    if (!isUpstreamAvailable()) {
      return res.status(503).json({ error: 'Upstream temporarily unavailable' });
    }

    const raw = identifier.startsWith('0x') && identifier.length === 42
      ? await fetchAgentByWallet(identifier)
      : await fetchAgentById(identifier);

    if (!raw) {
      return res.status(404).json({
        data: { safe: false, score: -1, tier: 'UNKNOWN', grade: 'F', flags: ['NOT_FOUND'], name: null, threshold },
      });
    }

    recordUpstreamSuccess();
    const scored = await scoreAgent(raw);
    scoreCache.set(cacheKey, scored);

    return res.json({
      data: {
        safe: scored.trustScore >= threshold,
        score: scored.trustScore,
        tier: scored.trustTier,
        grade: scored.trustGrade,
        flags: scored.riskFlags,
        name: scored.name,
        threshold,
      },
      cached: false,
    });
  } catch (err) {
    recordUpstreamFailure();
    console.error('Trust check error:', err);
    return res.status(502).json({ error: 'Trust check failed', message: (err as Error).message });
  }
});

// --- Top Agents by Category ---
// Returns the most trusted agents, optionally filtered — useful for discovery
app.get('/v1/top', async (req, res) => {
  try {
    const limit = clampInt(req.query.limit as string, 1, 50, 10);
    const minScore = clampInt(req.query.minScore as string, 0, 100, 50);
    const role = (req.query.role as string || '').toUpperCase();

    if (!isUpstreamAvailable()) {
      return res.status(503).json({ error: 'Upstream temporarily unavailable' });
    }

    const response = await fetchAgentsPage(1, 100);
    if (!response || !response.data || response.data.length === 0) {
      return res.json({ data: { agents: [], total: 0, filters: { minScore, role: role || 'ALL', limit } }, cached: false });
    }
    recordUpstreamSuccess();

    const allScored = await Promise.all(response.data.map((r: any) => scoreAgent(r)));
    let filtered = allScored
      .filter((a: ScoredAgent) => a.trustScore >= minScore)
      .sort((a: ScoredAgent, b: ScoredAgent) => b.trustScore - a.trustScore);

    if (role && ['PROVIDER', 'BUYER', 'HYBRID'].includes(role)) {
      filtered = filtered.filter((a: ScoredAgent) => a.role === role);
    }

    const top = filtered.slice(0, limit).map((a: ScoredAgent) => ({
      name: a.name,
      walletAddress: a.walletAddress,
      documentId: a.documentId,
      trustScore: a.trustScore,
      trustTier: a.trustTier,
      trustGrade: a.trustGrade,
      role: a.role,
      successRate: a.successRate,
      revenue: a.revenue,
      jobCount: a.jobCount,
      riskFlags: a.riskFlags,
    }));

    return res.json({
      data: {
        agents: top,
        total: filtered.length,
        filters: { minScore, role: role || 'ALL', limit },
      },
      cached: false,
    });
  } catch (err) {
    recordUpstreamFailure();
    console.error('Top agents error:', err);
    return res.status(502).json({ error: 'Failed to fetch top agents', message: (err as Error).message });
  }
});

// --- Risk Scan (deep) ---
// Full risk analysis combining trust score + sentinel + behavioral flags
app.get('/v1/risk/:identifier', async (req, res) => {
  try {
    const { identifier } = req.params;

    if (!isValidIdentifier(identifier)) {
      return res.status(400).json({ error: 'Invalid identifier' });
    }

    if (!isUpstreamAvailable()) {
      return res.status(503).json({ error: 'Upstream temporarily unavailable' });
    }

    const raw = identifier.startsWith('0x') && identifier.length === 42
      ? await fetchAgentByWallet(identifier)
      : await fetchAgentById(identifier);

    if (!raw) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    recordUpstreamSuccess();
    const scored = await scoreAgent(raw);

    let sentinel: SentinelVerdict | null = null;
    try {
      const context: SentinelContext = { allAgents: [scored], scanTimestamp: Date.now() };
      sentinel = assessAgent(scored, context);
    } catch (_) { /* sentinel best-effort */ }

    // Build risk profile
    const riskFactors: string[] = [];
    if (scored.trustScore < 25) riskFactors.push('CRITICALLY_LOW_TRUST_SCORE');
    if (scored.trustScore < 50) riskFactors.push('BELOW_AVERAGE_TRUST');
    if (scored.successRate < 50) riskFactors.push('LOW_SUCCESS_RATE');
    if (scored.walletBalance <= 0) riskFactors.push('EMPTY_WALLET');
    if (scored.daysSinceActive > 30) riskFactors.push('DORMANT');
    if (scored.uniqueBuyerCount <= 1) riskFactors.push('CONCENTRATED_CLIENT_BASE');
    if (scored.sybilRiskScore > 50) riskFactors.push('SYBIL_RISK_ELEVATED');
    if (scored.regressionScore < 50) riskFactors.push('PERFORMANCE_DECLINING');

    const riskLevel = riskFactors.length === 0 ? 'LOW'
      : riskFactors.length <= 2 ? 'MODERATE'
      : riskFactors.length <= 4 ? 'HIGH'
      : 'CRITICAL';

    return res.json({
      data: {
        agent: {
          name: scored.name,
          walletAddress: scored.walletAddress,
          documentId: scored.documentId,
        },
        riskLevel,
        trustScore: scored.trustScore,
        trustTier: scored.trustTier,
        trustGrade: scored.trustGrade,
        riskFactors,
        riskFlags: scored.riskFlags,
        sentinel: sentinel ? {
          threatLevel: sentinel.threatLevel,
          alerts: sentinel.allAlerts?.length || 0,
          escalation: sentinel.crossSentinelEscalation,
        } : null,
        recommendation: riskLevel === 'LOW' ? 'SAFE_TO_TRANSACT'
          : riskLevel === 'MODERATE' ? 'PROCEED_WITH_CAUTION'
          : riskLevel === 'HIGH' ? 'ADDITIONAL_VERIFICATION_RECOMMENDED'
          : 'DO_NOT_TRANSACT',
        scoreBreakdown: {
          reliability: scored.reliabilityScore,
          activity: scored.activityScore,
          economic: scored.economicScore,
          reputation: scored.reputationScore,
          longevity: scored.longevityScore,
          behavioral: scored.behavioralScore,
          complexity: scored.complexityScore,
          sustainability: scored.sustainabilityScore,
          sybilRisk: scored.sybilRiskScore,
          regression: scored.regressionScore,
        },
      },
      cached: false,
    });
  } catch (err) {
    recordUpstreamFailure();
    console.error('Risk scan error:', err);
    return res.status(502).json({ error: 'Risk scan failed', message: (err as Error).message });
  }
});

// ============================================================
//  DEGENCLAW — HTML render helpers
// ============================================================

function dcEscape(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function dcGradeColor(grade: string): string {
  return ({ A: '#10b981', B: '#22c55e', C: '#eab308', D: '#f97316', F: '#ef4444' } as Record<string, string>)[grade] || '#64748b';
}

function dcTierBlurb(tier: string): string {
  const blurbs: Record<string, string> = {
    SHARP: 'Strong risk-adjusted returns on a robust sample.',
    SOLID: 'Process is working. Metrics hold up under scrutiny.',
    DEVELOPING: 'Mixed signals. More data needed before confident call.',
    RISKY: 'Capital at elevated risk given current metrics.',
    DANGER: 'High probability of further losses. Exercise extreme caution.',
    UNPROVEN: 'Insufficient trade history for a confident rating.',
  };
  return blurbs[tier] || '';
}

function renderDegenClawScoreCard(r: DegenClawRiskReport): string {
  const color = dcGradeColor(r.trustGrade);
  const rowBar = (label: string, val: number) =>
    `<div class="bar-row"><span class="bar-label">${dcEscape(label)}</span><div class="bar-track"><div class="bar-fill" style="width:${val}%;background:${color}"></div></div><span class="bar-val">${val}</span></div>`;
  const flagList = (items: string[], cls: string, prefix: string) =>
    items.length === 0 ? '' :
    `<ul class="flag-list ${cls}">${items.map(f => `<li>${prefix} ${dcEscape(f)}</li>`).join('')}</ul>`;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>VIGIL Risk Score — ${dcEscape(r.agentName)} | DegenClaw</title>
<meta name="description" content="VIGIL Trust Score ${r.trustScore}/100 (${r.trustGrade}) for ${dcEscape(r.agentName)} — ${dcTierBlurb(r.trustTier)}"/>
<meta property="og:title" content="VIGIL Risk Score: ${dcEscape(r.agentName)} — ${r.trustGrade} (${r.trustScore}/100)"/>
<meta property="og:description" content="${dcEscape(dcTierBlurb(r.trustTier))}"/>
<style>
:root{--bg:#0b0d12;--card:#13161d;--ink:#e8ecf1;--muted:#8892a6;--line:#20242d;--accent:${color};}
*{box-sizing:border-box}body{margin:0;font:16px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Inter,system-ui,sans-serif;background:var(--bg);color:var(--ink)}
.wrap{max-width:760px;margin:0 auto;padding:32px 20px 60px}
.topbar{display:flex;align-items:center;gap:12px;margin-bottom:32px}
.logo{font-weight:800;letter-spacing:0.02em;font-size:20px}
.logo span{color:var(--muted);font-weight:500;font-size:14px;margin-left:8px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px 28px 22px;margin-bottom:18px}
.score-row{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;flex-wrap:wrap}
.score-main h1{margin:0 0 4px;font-size:26px;font-weight:700}
.score-main .sub{color:var(--muted);font-size:14px;margin-bottom:0}
.grade{display:flex;flex-direction:column;align-items:center;min-width:120px}
.grade-letter{font-size:72px;font-weight:800;line-height:1;color:var(--accent)}
.grade-num{font-size:14px;color:var(--muted);margin-top:4px}
.tier{display:inline-block;padding:4px 10px;border-radius:999px;font-size:12px;font-weight:700;letter-spacing:0.04em;background:var(--accent);color:#0b0d12;margin-top:10px}
.tier-blurb{color:var(--muted);font-size:14px;margin-top:10px}
.section-title{font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:var(--muted);margin:0 0 12px;font-weight:600}
.bar-row{display:flex;align-items:center;gap:12px;margin-bottom:10px;font-size:14px}
.bar-label{min-width:120px;color:var(--muted)}
.bar-track{flex:1;height:8px;background:#1a1e26;border-radius:4px;overflow:hidden}
.bar-fill{height:100%;border-radius:4px;transition:width .5s}
.bar-val{min-width:32px;text-align:right;font-variant-numeric:tabular-nums;color:var(--ink)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:14px;margin-top:6px}
.stat{background:#0f1218;border:1px solid var(--line);border-radius:8px;padding:12px 14px}
.stat-label{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px}
.stat-val{font-size:16px;font-weight:600;font-variant-numeric:tabular-nums}
.flag-list{padding:0;margin:8px 0 0;list-style:none;font-size:14px}
.flag-list li{padding:6px 10px;border-radius:6px;margin-bottom:6px}
.flag-list.red li{background:#2a1414;color:#fca5a5}
.flag-list.green li{background:#102418;color:#86efac}
.reasoning{color:var(--muted);font-size:14px;margin-top:10px}.reasoning p{margin:6px 0}
.foot{font-size:12px;color:var(--muted);padding:16px 0 0;border-top:1px solid var(--line);margin-top:22px;line-height:1.5}
a{color:#60a5fa;text-decoration:none}a:hover{text-decoration:underline}
</style></head><body><div class="wrap">
<div class="topbar"><div class="logo">VIGIL<span>Trust Score for the AI Agent Economy</span></div></div>
<div class="card"><div class="score-row">
<div class="score-main">
<h1>${dcEscape(r.agentName)}${r.tokenSymbol ? ` <span style="color:var(--muted);font-weight:400">$${dcEscape(r.tokenSymbol)}</span>` : ''}</h1>
<div class="sub">DegenClaw Arena · Rank #${r.leaderboardRank} · <a href="https://degen.virtuals.io" target="_blank" rel="noopener">view on DegenClaw</a></div>
<div class="tier">${r.trustTier}</div><div class="tier-blurb">${dcTierBlurb(r.trustTier)}</div>
</div>
<div class="grade"><div class="grade-letter">${r.trustGrade}</div><div class="grade-num">${r.trustScore} / 100</div></div>
</div></div>
<div class="card"><h3 class="section-title">VIGIL Dimensions</h3>
${rowBar('Profitability', r.profitability)}${rowBar('Consistency', r.consistency)}${rowBar('Discipline', r.discipline)}${rowBar('Capital Risk', r.capitalRisk)}${rowBar('Sample Size', r.sampleSize)}
</div>
<div class="card"><h3 class="section-title">Raw Metrics</h3><div class="stats">
<div class="stat"><div class="stat-label">Realized PnL</div><div class="stat-val">$${r.raw.totalRealizedPnl.toFixed(0)}</div></div>
<div class="stat"><div class="stat-label">Avg ROE</div><div class="stat-val">${(r.raw.avgRoe*100).toFixed(0)}%</div></div>
<div class="stat"><div class="stat-label">Win Rate</div><div class="stat-val">${(r.raw.winRate*100).toFixed(0)}%</div></div>
<div class="stat"><div class="stat-label">Profit Factor</div><div class="stat-val">${r.raw.profitFactor.toFixed(2)}</div></div>
<div class="stat"><div class="stat-label">Sortino</div><div class="stat-val">${r.raw.sortinoRatio.toFixed(2)}</div></div>
<div class="stat"><div class="stat-label">Trades</div><div class="stat-val">${r.raw.totalTradeCount}</div></div>
<div class="stat"><div class="stat-label">Volume</div><div class="stat-val">$${r.raw.totalTradeVolume.toFixed(0)}</div></div>
</div></div>
${(r.greenFlags.length>0||r.flags.length>0)?`<div class="card"><h3 class="section-title">Signals</h3>${flagList(r.greenFlags,'green','✓')}${flagList(r.flags,'red','⚠')}</div>`:''}
<div class="card"><h3 class="section-title">Reasoning</h3><div class="reasoning">${r.reasoning.map(p=>`<p>${dcEscape(p)}</p>`).join('')}</div></div>
<div class="foot"><strong>${dcEscape(r.disclaimer)}</strong><br/>Wallet: <code>${dcEscape(r.wallet)}</code><br/>Scored: ${r.scoredAt} · Source: ${r.dataSource}<br/>JSON: <a href="/v1/degenclaw/${encodeURIComponent(r.agentName)}">/v1/degenclaw/${dcEscape(r.agentName)}</a> · All agents: <a href="/degenclaw">/degenclaw</a></div>
</div></body></html>`;
}

function renderDegenClawNotFound(query: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"/><title>Not found — VIGIL × DegenClaw</title><style>body{margin:0;font:16px/1.6 -apple-system,system-ui,sans-serif;background:#0b0d12;color:#e8ecf1;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}.box{max-width:520px;text-align:center}h1{font-size:22px;margin:0 0 12px}p{color:#8892a6}a{color:#60a5fa}</style></head><body><div class="box"><h1>No DegenClaw agent found for "${dcEscape(query)}"</h1><p>Try the agent name exactly as shown on <a href="https://degen.virtuals.io" target="_blank">degen.virtuals.io</a>, its id, or its wallet address.</p><p>Browse the full leaderboard at <a href="/degenclaw">/degenclaw</a></p></div></body></html>`;
}

function renderDegenClawError(query: string, msg: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"/><title>Error — VIGIL × DegenClaw</title><style>body{margin:0;font:16px/1.6 -apple-system,system-ui,sans-serif;background:#0b0d12;color:#e8ecf1;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}.box{max-width:520px;text-align:center}h1{font-size:22px;margin:0 0 12px;color:#ef4444}p{color:#8892a6}code{background:#1a1e26;padding:2px 6px;border-radius:4px;word-break:break-all}</style></head><body><div class="box"><h1>Upstream error</h1><p>We couldn't fetch data for "${dcEscape(query)}" right now.</p><p><code>${dcEscape(msg)}</code></p><p>Try again in a few seconds.</p></div></body></html>`;
}

function renderDegenClawIndex(all: DegenClawRiskReport[]): string {
  const top = [...all].sort((a, b) => b.trustScore - a.trustScore).slice(0, 25);
  const bottom = [...all].filter(r => r.raw.totalTradeCount >= 10).sort((a, b) => a.trustScore - b.trustScore).slice(0, 10);
  const row = (r: DegenClawRiskReport) => `<tr><td class="rank">#${r.leaderboardRank}</td><td><a href="/degenclaw/${encodeURIComponent(r.agentName)}">${dcEscape(r.agentName)}</a></td><td class="grade" style="color:${dcGradeColor(r.trustGrade)}">${r.trustGrade}</td><td class="num">${r.trustScore}</td><td class="num">$${r.raw.totalRealizedPnl.toFixed(0)}</td><td class="num">${(r.raw.winRate*100).toFixed(0)}%</td><td class="num">${r.raw.sortinoRatio.toFixed(2)}</td><td class="num">${r.raw.totalTradeCount}</td></tr>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>VIGIL × DegenClaw — Risk Rankings for Every Arena Agent</title><meta name="description" content="Independent VIGIL trust scores for every AI agent trading Hyperliquid perps in the DegenClaw Arena."/><style>body{margin:0;font:15px/1.55 -apple-system,system-ui,sans-serif;background:#0b0d12;color:#e8ecf1}.wrap{max-width:960px;margin:0 auto;padding:32px 20px 60px}h1{font-size:28px;margin:0 0 6px}.lede{color:#8892a6;max-width:640px;margin-bottom:32px}h2{font-size:15px;text-transform:uppercase;letter-spacing:0.08em;color:#8892a6;margin:28px 0 12px;font-weight:600}table{width:100%;border-collapse:collapse;background:#13161d;border:1px solid #20242d;border-radius:10px;overflow:hidden}th,td{padding:10px 14px;text-align:left;border-bottom:1px solid #20242d;font-size:14px}th{background:#0f1218;color:#8892a6;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;font-weight:600}tr:last-child td{border-bottom:none}td.rank{color:#8892a6;font-variant-numeric:tabular-nums}td.num{text-align:right;font-variant-numeric:tabular-nums}td.grade{font-weight:700;font-size:16px}a{color:#60a5fa;text-decoration:none}a:hover{text-decoration:underline}.foot{color:#8892a6;font-size:12px;margin-top:28px;line-height:1.6}</style></head><body><div class="wrap"><h1>VIGIL × DegenClaw Arena</h1><p class="lede">Independent risk ratings for every AI agent trading Hyperliquid perps. DegenClaw's own AI Council ranks by expected return — VIGIL rates by downside risk. <em>Not investment advice.</em></p><h2>Top 25 by VIGIL Trust Score</h2><table><thead><tr><th>DC Rank</th><th>Agent</th><th>Grade</th><th>Score</th><th>PnL</th><th>Win</th><th>Sortino</th><th>Trades</th></tr></thead><tbody>${top.map(row).join('')}</tbody></table><h2>Bottom 10 — Elevated Risk (min 10 trades)</h2><table><thead><tr><th>DC Rank</th><th>Agent</th><th>Grade</th><th>Score</th><th>PnL</th><th>Win</th><th>Sortino</th><th>Trades</th></tr></thead><tbody>${bottom.map(row).join('')}</tbody></table><div class="foot">VIGIL Trust Score is informational only — not investment advice, not a recommendation to subscribe, not a guarantee of future performance.<br/>Data from <a href="https://degen.virtuals.io" target="_blank" rel="noopener">degen.virtuals.io</a> public leaderboard · updated every 60s<br/>JSON: <a href="/v1/degenclaw/leaderboard">/v1/degenclaw/leaderboard</a></div></div></body></html>`;
}

// ============================================================
//  DEGENCLAW — Risk scoring for Hyperliquid trading agents
// ============================================================

app.get('/v1/degenclaw/leaderboard', async (req, res) => {
  try {
    const limit = clampInt(req.query.limit as string, 1, 1000, 100);
    const sort = String(req.query.sort || 'trustScore');
    const order = String(req.query.order || 'desc') === 'asc' ? 1 : -1;
    const all = await scoreAllDegenClawAgents();
    const sorted = all.sort((a, b) => {
      const av = (a as unknown as Record<string, number>)[sort] ?? 0;
      const bv = (b as unknown as Record<string, number>)[sort] ?? 0;
      return (av - bv) * order;
    });
    return res.json({
      data: sorted.slice(0, limit).map((r) => ({
        agentId: r.agentId, agentName: r.agentName, tokenSymbol: r.tokenSymbol,
        wallet: r.wallet, leaderboardRank: r.leaderboardRank,
        trustScore: r.trustScore, trustGrade: r.trustGrade, trustTier: r.trustTier,
        profitability: r.profitability, consistency: r.consistency, discipline: r.discipline,
        capitalRisk: r.capitalRisk, sampleSize: r.sampleSize,
        raw: r.raw, flags: r.flags, greenFlags: r.greenFlags,
        permalink: `/degenclaw/${encodeURIComponent(r.agentName)}`,
      })),
      meta: {
        total: all.length, returned: Math.min(limit, all.length),
        sort, order: order === 1 ? 'asc' : 'desc',
        dataSource: 'degenclaw-leaderboard-v1',
        scoredAt: new Date().toISOString(),
        disclaimer: 'VIGIL Trust Score is informational only — not investment advice.',
      },
    });
  } catch (err) {
    return res.status(502).json({ error: 'DEGENCLAW_UPSTREAM_ERROR', message: (err as Error).message });
  }
});

app.get('/v1/degenclaw/:agent', async (req, res) => {
  try {
    const query = decodeURIComponent(String(req.params.agent || '')).trim();
    if (!query) return res.status(400).json({ error: 'MISSING_AGENT', message: 'Agent name, id, or wallet required' });
    const report = await scoreDegenClawByQuery(query);
    if (!report) return res.status(404).json({ error: 'AGENT_NOT_FOUND', message: `No DegenClaw agent found for "${query}".` });
    return res.json(report);
  } catch (err) {
    return res.status(502).json({ error: 'DEGENCLAW_UPSTREAM_ERROR', message: (err as Error).message });
  }
});

app.get('/degenclaw/:agent', async (req, res) => {
  const query = decodeURIComponent(String(req.params.agent || '')).trim();
  try {
    const report = await scoreDegenClawByQuery(query);
    if (!report) { res.status(404).type('html').send(renderDegenClawNotFound(query)); return; }
    res.type('html').send(renderDegenClawScoreCard(report));
  } catch (err) {
    res.status(502).type('html').send(renderDegenClawError(query, (err as Error).message));
  }
});

app.get('/degenclaw', async (_req, res) => {
  try {
    const all = await scoreAllDegenClawAgents();
    res.type('html').send(renderDegenClawIndex(all));
  } catch (err) {
    res.status(502).type('html').send(renderDegenClawError('leaderboard', (err as Error).message));
  }
});


// ============================================================
//  POLYMARKET — Prediction Market Agent Scoring
//  PROPRIETARY: Calibration scoring measures genuine predictive
//  skill vs. speed arb vs. luck. Nobody else computes this.
// ============================================================

// JSON API: score a Polymarket trader by wallet
app.get('/v1/polymarket/:wallet', async (req, res) => {
  try {
    const wallet = String(req.params.wallet || '').trim();
    if (!wallet || !wallet.startsWith('0x')) {
      return res.status(400).json({ error: 'INVALID_WALLET', message: 'Provide a valid 0x wallet address.' });
    }
    const report = await scorePolymarketTrader(wallet);
    if (!report) {
      return res.status(404).json({ error: 'TRADER_NOT_FOUND', message: `No Polymarket activity found for ${wallet}.` });
    }
    return res.json(report);
  } catch (err) {
    return res.status(502).json({ error: 'POLYMARKET_UPSTREAM_ERROR', message: (err as Error).message });
  }
});

// HTML score card for a Polymarket trader
app.get('/polymarket/:wallet', async (req, res) => {
  const wallet = String(req.params.wallet || '').trim();
  try {
    const report = await scorePolymarketTrader(wallet);
    if (!report) {
      res.status(404).type('html').send(renderPolymarketNotFound(wallet));
      return;
    }
    res.type('html').send(renderPolymarketScoreCard(report));
  } catch (err) {
    res.status(502).type('html').send(renderPolymarketError(wallet, (err as Error).message));
  }
});

// HTML index (landing page for /polymarket)
app.get('/polymarket', (_req, res) => {
  res.type('html').send(renderPolymarketIndex());
});

// ============================================================
//  POLYMARKET HTML RENDERERS
// ============================================================

function pmEscape(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function pmGradeColor(grade: string): string {
  switch (grade) {
    case 'A': return '#10b981';
    case 'B': return '#34d399';
    case 'C': return '#eab308';
    case 'D': return '#f97316';
    default: return '#ef4444';
  }
}

function pmBarColor(grade: string): string {
  switch (grade) {
    case 'A': case 'B': return '#10b981';
    case 'C': return '#eab308';
    default: return '#ef4444';
  }
}

function renderPolymarketScoreCard(r: PolymarketRiskReport): string {
  const gc = pmGradeColor(r.trustGrade);
  const bc = pmBarColor(r.trustGrade);
  const dims = [
    { label: 'Calibration', val: r.calibration },
    { label: 'Profitability', val: r.profitability },
    { label: 'Consistency', val: r.consistency },
    { label: 'Discipline', val: r.discipline },
    { label: 'Sample Size', val: r.sampleSize },
  ];

  const greenFlagsHtml = r.greenFlags.map(f => `<div class="signal green">\u2713 ${pmEscape(f)}</div>`).join('');
  const flagsHtml = r.flags.map(f => `<div class="signal red">\u26A0 ${pmEscape(f)}</div>`).join('');

  const calBucketsHtml = r.calibrationReport.buckets.map(b =>
    `<tr><td>${b.range}</td><td>${b.totalBets}</td><td>${(b.expectedRate * 100).toFixed(0)}%</td><td>${(b.actualRate * 100).toFixed(0)}%</td><td>${(b.error * 100).toFixed(1)}%</td></tr>`
  ).join('');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>VIGIL x ${pmEscape(r.displayName)} - Polymarket Trust Score</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0a0e1a;color:#d1d5db;line-height:1.6;padding:24px;max-width:800px;margin:0 auto}
.hdr{font-size:14px;color:#6b7280;margin-bottom:24px}.hdr b{color:#a78bfa}
.card{background:#111827;border:1px solid #1f2937;border-radius:12px;padding:24px;margin-bottom:16px}
.hero{display:flex;justify-content:space-between;align-items:flex-start}
.name{font-size:28px;font-weight:700;color:#fff}.wallet{font-size:12px;color:#6b7280;font-family:monospace;word-break:break-all}
.tier{display:inline-block;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:700;margin-top:8px;background:${gc}22;color:${gc};border:1px solid ${gc}44}
.blurb{color:#9ca3af;margin-top:8px;font-size:14px}
.grade{font-size:64px;font-weight:800;color:${gc};text-align:right}.score-num{font-size:16px;color:#9ca3af;text-align:right}
.sec-title{text-transform:uppercase;font-size:12px;font-weight:700;color:#6b7280;letter-spacing:1px;margin-bottom:12px}
.dim{display:flex;align-items:center;margin-bottom:10px}.dim-label{width:120px;font-size:14px;color:#9ca3af}
.dim-bar{flex:1;height:10px;background:#1f2937;border-radius:5px;overflow:hidden;margin:0 12px}
.dim-fill{height:100%;background:${bc};border-radius:5px}.dim-val{font-size:14px;color:#fff;min-width:30px;text-align:right}
.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px}
.metric{background:#0d1117;border:1px solid #1f2937;border-radius:8px;padding:12px}
.metric-label{font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#6b7280;margin-bottom:4px}
.metric-val{font-size:20px;font-weight:700;color:#fff}
.signal{padding:8px 16px;border-radius:6px;margin-bottom:6px;font-size:13px}
.green{background:#10b98115;color:#10b981;border:1px solid #10b98130}
.red{background:#ef444415;color:#ef4444;border:1px solid #ef444430}
.cal-table{width:100%;border-collapse:collapse;font-size:13px;margin-top:8px}
.cal-table th{text-align:left;color:#6b7280;font-size:11px;text-transform:uppercase;padding:6px 8px;border-bottom:1px solid #1f2937}
.cal-table td{padding:6px 8px;border-bottom:1px solid #1f293744}
.skill-bar{display:flex;gap:4px;margin-top:8px;height:24px;border-radius:6px;overflow:hidden}
.skill-seg{display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;color:#fff}
.foot{margin-top:24px;font-size:11px;color:#4b5563;text-align:center;line-height:1.8}
.foot a{color:#6b7280}
</style></head><body>
<div class="hdr"><b>VIGIL</b> Trust Score for the AI Agent Economy</div>
<div class="card"><div class="hero"><div>
<div class="name">${pmEscape(r.displayName)}</div>
<div class="wallet">${pmEscape(r.wallet)}</div>
<div>Polymarket Trader</div>
<div class="tier">${r.trustTier}</div>
<div class="blurb">${r.trustTier === 'SHARP' ? 'Elite calibration. Metrics hold up under scrutiny.' : r.trustTier === 'SOLID' ? 'Process is working. Metrics hold up under scrutiny.' : r.trustTier === 'DEVELOPING' ? 'Mixed signals. More data needed.' : r.trustTier === 'UNPROVEN' ? 'Insufficient resolved bets for calibration.' : r.trustTier === 'RISKY' ? 'Below-average risk profile. Proceed with caution.' : 'High probability of further losses.'}</div>
</div><div><div class="grade">${r.trustGrade}</div><div class="score-num">${r.trustScore} / 100</div></div></div></div>

<div class="card"><div class="sec-title">VIGIL Dimensions</div>
${dims.map(d => `<div class="dim"><div class="dim-label">${d.label}</div><div class="dim-bar"><div class="dim-fill" style="width:${d.val}%"></div></div><div class="dim-val">${d.val}</div></div>`).join('')}
</div>

<div class="card"><div class="sec-title">Raw Metrics</div><div class="metrics">
<div class="metric"><div class="metric-label">Total PnL</div><div class="metric-val">$${r.raw.totalPnl}</div></div>
<div class="metric"><div class="metric-label">Win Rate</div><div class="metric-val">${Math.round(r.raw.winRate * 100)}%</div></div>
<div class="metric"><div class="metric-label">Resolved Bets</div><div class="metric-val">${r.raw.resolvedBets}</div></div>
<div class="metric"><div class="metric-label">Total Trades</div><div class="metric-val">${r.raw.totalTrades}</div></div>
<div class="metric"><div class="metric-label">Volume</div><div class="metric-val">$${Math.round(r.raw.totalVolume)}</div></div>
<div class="metric"><div class="metric-label">Markets</div><div class="metric-val">${r.raw.uniqueMarkets}</div></div>
<div class="metric"><div class="metric-label">Brier Score</div><div class="metric-val">${r.calibrationReport.brierScore}</div></div>
<div class="metric"><div class="metric-label">Open Positions</div><div class="metric-val">${r.raw.openPositions}</div></div>
</div></div>

${r.calibrationReport.buckets.length > 0 ? `<div class="card"><div class="sec-title">Calibration Analysis</div>
<p style="font-size:13px;color:#9ca3af;margin-bottom:8px">When this trader buys at $0.70, they imply 70% probability. Perfect calibration = the event happens 70% of the time.</p>
<table class="cal-table"><tr><th>Bucket</th><th>Bets</th><th>Expected</th><th>Actual</th><th>Error</th></tr>${calBucketsHtml}</table>
<div style="margin-top:12px"><span style="font-size:12px;color:#6b7280">Calibration Error: </span><span style="font-size:14px;font-weight:600;color:${r.calibrationReport.calibrationError < 0.1 ? '#10b981' : r.calibrationReport.calibrationError < 0.2 ? '#eab308' : '#ef4444'}">${(r.calibrationReport.calibrationError * 100).toFixed(1)}%</span></div>
</div>` : ''}

${r.calibrationReport.skillDecomposition.skill > 0 ? `<div class="card"><div class="sec-title">Skill vs. Luck Decomposition</div>
<p style="font-size:13px;color:#9ca3af;margin-bottom:12px">How much of returns came from genuine predictive skill vs. variance?</p>
<div class="skill-bar">
<div class="skill-seg" style="flex:${r.calibrationReport.skillDecomposition.skill};background:#10b981">Skill ${r.calibrationReport.skillDecomposition.skill.toFixed(0)}%</div>
<div class="skill-seg" style="flex:${Math.max(r.calibrationReport.skillDecomposition.luck, 1)};background:#6366f1">Luck ${r.calibrationReport.skillDecomposition.luck.toFixed(0)}%</div>
</div></div>` : ''}

<div class="card"><div class="sec-title">Signals</div>${greenFlagsHtml}${flagsHtml}</div>

<div class="card"><div class="sec-title">Reasoning</div>
${r.reasoning.map(line => `<p style="font-size:13px;color:#9ca3af;margin-bottom:6px">${pmEscape(line)}</p>`).join('')}
</div>

<div class="foot"><strong>${pmEscape(r.disclaimer)}</strong><br/>Scored: ${r.scoredAt} | Source: ${r.dataSource}<br/>JSON: <a href="/v1/polymarket/${r.wallet}">/v1/polymarket/...</a> | <a href="/polymarket">/polymarket</a></div>
</body></html>`;
}

function renderPolymarketNotFound(wallet: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>VIGIL - Trader Not Found</title>
<style>body{font-family:-apple-system,sans-serif;background:#0a0e1a;color:#d1d5db;display:flex;justify-content:center;align-items:center;min-height:100vh;text-align:center}h1{color:#ef4444;font-size:48px}p{color:#6b7280}a{color:#a78bfa}</style></head>
<body><div><h1>404</h1><p>No Polymarket activity found for <code>${pmEscape(wallet)}</code>.</p><p><a href="/polymarket">Back to index</a></p></div></body></html>`;
}

function renderPolymarketError(wallet: string, message: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>VIGIL - Error</title>
<style>body{font-family:-apple-system,sans-serif;background:#0a0e1a;color:#d1d5db;display:flex;justify-content:center;align-items:center;min-height:100vh;text-align:center}h1{color:#f97316;font-size:48px}p{color:#6b7280}a{color:#a78bfa}</style></head>
<body><div><h1>502</h1><p>Error scoring <code>${pmEscape(wallet)}</code>: ${pmEscape(message)}</p><p><a href="/polymarket">Back to index</a></p></div></body></html>`;
}

function renderPolymarketIndex(): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>VIGIL x Polymarket - Prediction Market Trust Scoring</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0a0e1a;color:#d1d5db;line-height:1.6;padding:24px;max-width:800px;margin:0 auto}
h1{font-size:32px;color:#fff;margin-bottom:8px}h1 span{color:#a78bfa}
.sub{color:#9ca3af;font-size:14px;margin-bottom:32px;font-style:italic}
.card{background:#111827;border:1px solid #1f2937;border-radius:12px;padding:24px;margin-bottom:16px}
.sec-title{text-transform:uppercase;font-size:12px;font-weight:700;color:#6b7280;letter-spacing:1px;margin-bottom:12px}
.feature{display:flex;align-items:flex-start;gap:12px;margin-bottom:16px}
.feat-title{color:#fff;font-weight:600;font-size:15px}.feat-desc{color:#9ca3af;font-size:13px}
code{background:#1f2937;padding:2px 6px;border-radius:4px;font-size:13px;color:#a78bfa}
.foot{margin-top:32px;font-size:11px;color:#4b5563;text-align:center}
</style></head><body>
<h1><span>VIGIL</span> x Polymarket</h1>
<div class="sub">Independent trust scoring for prediction market traders. Calibration-first methodology. <em>Not investment advice.</em></div>

<div class="card"><div class="sec-title">The Proprietary Layer: Calibration Scoring</div>
<div class="feature"><div><div class="feat-title">Calibration Analysis</div><div class="feat-desc">When a trader buys YES at $0.70, they imply 70% probability. We check: does the event actually happen 70% of the time? This separates genuine skill from speed arb and luck.</div></div></div>
<div class="feature"><div><div class="feat-title">Skill vs. Luck Decomposition</div><div class="feat-desc">Returns decomposed into Skill (calibration-weighted alpha), Luck (variance residual). Know what you are buying before you copy-trade.</div></div></div>
<div class="feature"><div><div class="feat-title">Brier Score + 5-Dimension Trust Rating</div><div class="feat-desc">Calibration (30%), Profitability (20%), Consistency (20%), Discipline (15%), Sample Size (15%).</div></div></div>
</div>

<div class="card"><div class="sec-title">Score Any Trader</div>
<p style="font-size:14px;color:#9ca3af;margin-bottom:12px">Paste any Polymarket wallet address:</p>
<p><code>/polymarket/0x...</code> (HTML card)</p>
<p><code>/v1/polymarket/0x...</code> (JSON API)</p>
</div>

<div class="card"><div class="sec-title">What Makes This Different</div>
<p style="font-size:14px;color:#9ca3af">Every other Polymarket leaderboard ranks by raw P&L. 14 of the top 20 most profitable wallets are bots running structural arbitrage. VIGIL scores what actually matters: <strong style="color:#fff">can this trader predict the future?</strong></p>
</div>

<div class="foot">VIGIL Trust Score is informational only.<br/><a href="/degenclaw" style="color:#6b7280">DegenClaw Scoring</a> | <a href="/v1" style="color:#6b7280">API Docs</a></div>
</body></html>`;
}

// ============================================================
//  MOAT LAYER — Time-series snapshots & grade history
//  Every call to /v1/internal/snapshot writes a permanent row
//  per agent into degenclaw_snapshots. This is the ONLY part of
//  VIGIL a competitor cannot retroactively backfill.
// ============================================================

// Trigger a snapshot write. Protected by SNAPSHOT_KEY env var so
// only the scheduled task / cron can hit it.
app.post('/v1/internal/snapshot', async (req, res) => {
  const providedKey = String(req.headers['x-snapshot-key'] || req.query.key || '').trim();
  const expectedKey = (process.env.SNAPSHOT_KEY || '').trim();
  if (!expectedKey) {
    return res.status(503).json({ error: 'SNAPSHOT_KEY_NOT_CONFIGURED', message: 'Server has no SNAPSHOT_KEY set — cannot accept snapshot writes.' });
  }
  if (providedKey !== expectedKey) {
    return res.status(401).json({ error: 'UNAUTHORIZED' });
  }
  try {
    const result = await writeDegenClawSnapshot();
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: 'SNAPSHOT_FAILED', message: (err as Error).message });
  }
});

// Public moat stats — "we have N days of history and X total snapshots"
app.get('/v1/moat/stats', async (_req, res) => {
  try {
    const stats = await getSnapshotStats();
    return res.json({
      ...stats,
      note: 'Time-series history for DegenClaw agents. Every row is a permanent snapshot. Competitors cannot backfill past data.',
    });
  } catch (err) {
    return res.status(500).json({ error: 'STATS_FAILED', message: (err as Error).message });
  }
});

// Grade-history timeline for a single agent (JSON).
app.get('/v1/degenclaw/:agent/history', async (req, res) => {
  try {
    const agent = decodeURIComponent(String(req.params.agent || '')).trim();
    if (!agent) return res.status(400).json({ error: 'MISSING_AGENT' });
    const days = Math.min(365, Math.max(1, parseInt(String(req.query.days || '30'), 10) || 30));
    const history = await getDegenClawAgentHistory(agent, days);
    return res.json({ agent, days, count: history.length, history });
  } catch (err) {
    return res.status(500).json({ error: 'HISTORY_FAILED', message: (err as Error).message });
  }
});

// --- API Documentation root ---
app.get('/v1', (_req, res) => {
  res.json({
    service: 'VIGIL Trust Score API',
    version: '1.10.2',
    description: 'On-chain credit bureau and evaluator agent for AI agents on Virtuals Protocol',
    endpoints: {
      'GET /v1/health': 'Service health check + upstream status + rate limit info',
      'GET /v1/score/:identifier': 'Trust score for a single agent (wallet address or documentId)',
      'GET /v1/leaderboard': 'Paginated agent rankings (query: page, pageSize, tier, category, sort, order)',
      'GET /v1/search?q=': 'Search agents by name or symbol',
      'GET /v1/ecosystem/health': 'Aggregated ecosystem statistics',
      'GET /v1/compare?ids=id1,id2': 'Compare 2-5 agents side by side',
      'GET /v1/sentinel/:identifier': 'Full 12-sentinel security scan (returns SentinelVerdict)',
      'POST /v1/acp/trust-score': 'ACP-compatible trust score endpoint (body: {walletAddress|agentId})',
      'GET /v1/alerts': 'Agents with active risk flags',
      'GET /v1/history/:walletAddress': 'Score history + trends for an agent (query: hours)',
      'GET /v1/movers': 'Agents with biggest score changes (query: hours, limit)',
      'POST /v1/evaluate': 'ACP evaluator — score seller trustworthiness before approving a job (body: {sellerAddress, jobId?, buyerAddress?, deliverable?})',
      'POST /v1/evaluate/batch': 'Batch evaluate up to 20 agents at once (body: {addresses: string[]})',
      'POST /v1/watchlist/check': 'Monitor a portfolio of agents for risk changes (body: {addresses: string[], thresholds?: {minScore?, flagOnRiskFlags?}})',
      'GET /v1/trust/:identifier': 'Quick trust gate — returns safe/unsafe + score in <500ms (query: threshold=50)',
      'GET /v1/top': 'Most trusted agents in the ecosystem (query: limit, minScore, role)',
      'GET /v1/risk/:identifier': 'Deep risk analysis — trust + sentinel + behavioral factors + recommendation',
      'GET /v1/degenclaw/leaderboard': 'VIGIL risk scores for every DegenClaw Arena agent (query: limit, sort, order)',
      'GET /v1/degenclaw/:agent': 'VIGIL risk report for a single DegenClaw agent (name, id, or wallet)',
      'GET /degenclaw/:agent': 'Public HTML score card for a DegenClaw agent — shareable permalink',
      'GET /degenclaw': 'Public HTML index of the DegenClaw leaderboard ranked by VIGIL trust score',
      'GET /v1/degenclaw/:agent/history': 'Time-series grade history for a DegenClaw agent (query: days, default 30)',
      'GET /v1/moat/stats': 'Public moat stats — total snapshots, unique agents, days of history',
      'POST /v1/internal/snapshot': 'Trigger a full snapshot write (requires X-Snapshot-Key header)',
      'GET /v1/polymarket/:wallet': 'VIGIL trust report + calibration scoring for a Polymarket trader',
      'GET /polymarket/:wallet': 'Public HTML score card with calibration analysis',
      'GET /polymarket': 'Polymarket prediction market trust scoring index',
    },
    scoring: {
      dimensions: {
        reliability: '30% — success rate + job volume',
        activity: '25% — recency + transaction volume',
        economic: '20% — revenue + aGDP + wallet health',
        reputation: '15% — unique buyers + graduation + offerings',
        longevity: '10% — account age + consistency',
      },
      tiers: Object.entries(TIER_CONFIG).map(([key, val]) => ({
        tier: key,
        label: val.label,
        range: key === 'ELITE' ? '80-100' :
          key === 'TRUSTED' ? '60-79' :
          key === 'ESTABLISHED' ? '40-59' :
          key === 'EMERGING' ? '20-39' :
          key === 'NEW' ? '0-19' :
          key === 'INACTIVE' ? 'N/A' : 'Flagged',
      })),
    },
    rateLimit: {
      maxRequests: RATE_LIMIT_MAX,
      windowMs: RATE_LIMIT_WINDOW_MS,
      note: 'Rate limit headers included in every response',
    },
    links: {
      twitter: 'https://twitter.com/VIGIL_Trust',
      token: '0xFe19FEfC9B05d1a52e95C3d2a4daD0448C8f3BA6 (Base)',
      acp: 'https://app.virtuals.io/acp/agents/alb3eav5ej58ynsqtbez7cd0',
      github: 'https://github.com/gatson32/vigil-agent',
    },
  });
});

// --- 404 handler ---
app.use((_req, res) => {
  res.status(404).json({
    error: 'Not found',
    message: 'Unknown endpoint. See GET /v1 for documentation.',
  });
});

// --- Start server ---
async function start() {
  // Initialize database (graceful fallback to memory if unavailable)
  const dbConnected = await initDb();

  app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════╗
║         VIGIL Trust Score API v1.7.0             ║
║     On-chain credit bureau for AI agents         ║
╠══════════════════════════════════════════════════╣
║  Server:    http://localhost:${PORT}               ║
║  Docs:      http://localhost:${PORT}/v1            ║
║  Health:    http://localhost:${PORT}/v1/health     ║
║  Storage:   ${dbConnected ? 'PostgreSQL (persistent)' : 'In-Memory (volatile)'}       ║
║  Rate Limit: ${RATE_LIMIT_MAX} req/min per IP             ║
╚══════════════════════════════════════════════════╝
    `);
  });

  // Start ACP evaluator listener in the background (optional, non-fatal)
  if (process.env.WHITELISTED_WALLET_PRIVATE_KEY && process.env.SESSION_ENTITY_KEY_ID) {
    console.log('[BOOT] Starting ACP evaluator listener...');
    startEvaluatorListener().catch((err) => {
      console.error('[BOOT] Evaluator listener failed to start (API will continue running):', err);
    });
  } else {
    console.log('[BOOT] ACP evaluator listener NOT started (missing WHITELISTED_WALLET_PRIVATE_KEY or SESSION_ENTITY_KEY_ID)');
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('[SHUTDOWN] Received SIGTERM, closing database...');
  await closeDb();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[SHUTDOWN] Received SIGINT, closing database...');
  await closeDb();
  process.exit(0);
});

start().catch(err => {
  console.error('[FATAL] Failed to start server:', err);
  process.exit(1);
});

export default app;
