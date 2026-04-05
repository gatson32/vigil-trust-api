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
    version: '1.6.0',
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

    // Score all agents in parallel
    const results = await Promise.allSettled(
      addresses.map(async (addr: string) => {
        if (!isUpstreamAvailable()) throw new Error('Upstream unavailable');
        const raw = await fetchAgentByWallet(addr);
        if (!raw) throw new Error(`Agent not found: ${addr}`);
        recordUpstreamSuccess();
        const scored = scoreAgent(raw);
        const context: SentinelContext = {
          allAgents: [scored],
          scanTimestamp: Date.now(),
        };
        const sentinel = assessAgent(scored, context);
        return { scored, sentinel };
      })
    );

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
      if (sentinel.threatLevel === 'CRITICAL' || sentinel.threatLevel === 'EMERGENCY') {
        alerts.push(`SENTINEL_THREAT: ${sentinel.threatLevel}`);
      }

      return {
        address: addresses[i],
        name: scored.name,
        status: alerts.length > 0 ? 'alert' as const : 'ok' as const,
        trustScore: scored.trustScore,
        trustTier: scored.trustTier,
        riskFlags: scored.riskFlags,
        sentinelThreat: sentinel.threatLevel,
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

// --- API Documentation root ---
app.get('/v1', (_req, res) => {
  res.json({
    service: 'VIGIL Trust Score API',
    version: '1.6.0',
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
║         VIGIL Trust Score API v1.3.0             ║
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
