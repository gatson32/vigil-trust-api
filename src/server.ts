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

const app = express();
const PORT = parseInt(process.env.PORT || '3100', 10);

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
  methods: ['GET'],
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
    tierLabel: TIER_CONFIG[agent.trustTier].label,
    riskFlags: agent.riskFlags,
    scoreBreakdown: {
      reliability: { score: agent.reliabilityScore, weight: 0.30 },
      activity: { score: agent.activityScore, weight: 0.25 },
      economic: { score: agent.economicScore, weight: 0.20 },
      reputation: { score: agent.reputationScore, weight: 0.15 },
      longevity: { score: agent.longevityScore, weight: 0.10 },
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
app.get('/v1/health', (_req, res) => {
  res.json({
    status: 'ok',
    version: '1.1.0',
    service: 'VIGIL Trust Score API',
    timestamp: new Date().toISOString(),
    upstream: {
      healthy: upstreamHealthy,
      failCount: upstreamFailCount,
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

    const scored = scoreAgent(raw);
    const response = formatAgentResponse(scored);
    scoreCache.set(cacheKey, response);

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

    let agents = result.data.map(scoreAgent).map(formatAgentResponse);

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

    const agents = result.data.map(scoreAgent).map(formatAgentResponse);

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

    const agents = result.data.map(scoreAgent);

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
        return formatAgentResponse(scoreAgent(raw));
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

    const agents = result.data.map(scoreAgent);
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

// --- API Documentation root ---
app.get('/v1', (_req, res) => {
  res.json({
    service: 'VIGIL Trust Score API',
    version: '1.1.0',
    description: 'On-chain credit bureau for AI agents on Virtuals Protocol',
    endpoints: {
      'GET /v1/health': 'Service health check + upstream status + rate limit info',
      'GET /v1/score/:identifier': 'Trust score for a single agent (wallet address or documentId)',
      'GET /v1/leaderboard': 'Paginated agent rankings (query: page, pageSize, tier, category, sort, order)',
      'GET /v1/search?q=': 'Search agents by name or symbol',
      'GET /v1/ecosystem/health': 'Aggregated ecosystem statistics',
      'GET /v1/compare?ids=id1,id2': 'Compare 2-5 agents side by side',
      'GET /v1/alerts': 'Agents with active risk flags',
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
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║         VIGIL Trust Score API v1.1.0             ║
║     On-chain credit bureau for AI agents         ║
╠══════════════════════════════════════════════════╣
║  Server:    http://localhost:${PORT}               ║
║  Docs:      http://localhost:${PORT}/v1            ║
║  Health:    http://localhost:${PORT}/v1/health     ║
║  Rate Limit: ${RATE_LIMIT_MAX} req/min per IP             ║
╚══════════════════════════════════════════════════╝
  `);
});

export default app;
