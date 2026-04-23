// VIGIL Trust Score API Server
// On-chain credit bureau for AI agents on Virtuals Protocol

import express from 'express';
import cors from 'cors';
import { randomBytes, timingSafeEqual } from 'crypto';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename_landing = fileURLToPath(import.meta.url);
const __dirname_landing = dirname(__filename_landing);
const LANDING_V3_HTML = readFileSync(join(__dirname_landing, 'landing-v3.html'), 'utf-8');
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
import { initDb, closeDb, isDbConnected, query } from './lib/db.js';
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
  runDiscoveryCrawl,
  getSkillLeaderboard,
  getCrawlerStatus,
  loadLeaderboardFromDb,
  seedSkillLeaderboard,
  resetCrawlInProgress,
  type LeaderboardEntry,
} from './lib/polymarket.js';
import {
  computeSkillConsensus,
  resolveMarketSlug,
  getConsensusCacheStats,
  warmConsensusCache,
  computeDivergenceLeaderboard,
  type DivergenceLeaderboard,
  type DivergenceRow,
} from './lib/consensus.js';
import {
  getWalletProvenance,
  isBasescanConfigured,
  quickSybilCheck,
} from './lib/basescan.js';

const app = express();
const PORT = parseInt(process.env.PORT || '3100', 10);

// Enable trust-proxy for proper IP detection behind reverse proxies (Render, etc.)
app.set('trust proxy', 1);

// ============================================================
//  CONFIGURATION
// ============================================================

const ALLOWED_ORIGINS = [
  'https://vigilscore.xyz',
  'https://www.vigilscore.xyz',
  'https://vigil-trust-api.onrender.com',   // legacy — fallback during DNS transition
  'http://localhost:5173',    // Vite dev
  'http://localhost:3000',    // local dev
];

// Recently scored wallets — displayed on homepage
interface RecentScore {
  wallet: string;
  displayName: string;
  trustGrade: string;
  trustScore: number;
  totalPnl: number;
  resolvedBets: number;
  scoredAt: string;
}
const recentScores: RecentScore[] = [];
const MAX_RECENT = 50;

// Username → wallet lookup cache. Grows as wallets get scored.
const usernameToWallet = new Map<string, string>();
// Persisted discovery alerts (loaded from DB on boot, so homepage elite table works before crawler runs)
interface KnownEliteWallet { wallet: string; displayName: string; trustGrade: string; trustScore: number; brierSkillScore: number; resolvedBets: number }
let knownEliteWallets: KnownEliteWallet[] = [];

function addRecentScore(r: PolymarketRiskReport): void {
  // Avoid duplicates — remove existing entry for same wallet
  const idx = recentScores.findIndex(s => s.wallet === r.wallet);
  if (idx >= 0) recentScores.splice(idx, 1);
  recentScores.unshift({
    wallet: r.wallet,
    displayName: r.displayName,
    trustGrade: r.trustGrade,
    trustScore: r.trustScore,
    totalPnl: r.raw.totalPnl,
    resolvedBets: r.raw.resolvedBets,
    scoredAt: r.scoredAt,
  });
  if (recentScores.length > MAX_RECENT) recentScores.pop();

  // Index username → wallet for search
  if (r.displayName && r.displayName !== r.wallet) {
    usernameToWallet.set(r.displayName.toLowerCase(), r.wallet);
  }
  if (r.pseudonym) {
    usernameToWallet.set(r.pseudonym.toLowerCase(), r.wallet);
  }
}

// Resolve an identifier to a wallet address
// Accepts: 0x address, Polymarket username, or partial match
function resolveWalletIdentifier(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.startsWith('0x') && trimmed.length >= 40) return trimmed.toLowerCase();

  // Exact username match
  const exact = usernameToWallet.get(trimmed.toLowerCase());
  if (exact) return exact;

  // Partial match — find first username containing the search term
  const lower = trimmed.toLowerCase();
  for (const [name, wallet] of usernameToWallet) {
    if (name.includes(lower)) return wallet;
  }

  return null;
}

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
//  EMAIL CAPTURE — Newsletter / launch updates
// ============================================================
const emailSubscribers: Set<string> = new Set();

// ============================================================
//  API KEY SYSTEM — Paid tiers bypass rate limits
// ============================================================

interface ApiKeyRecord {
  key: string;
  tier: 'free' | 'starter' | 'pro' | 'enterprise';
  owner: string;           // email
  monthlyLimit: number;    // max requests per month
  monthlyUsage: number;
  ratePerMin: number;      // per-minute rate limit
  createdAt: string;
  expiresAt: string | null;
}

const API_TIERS = {
  free:       { monthlyLimit: 100,    ratePerMin: 10,    price: 0,   label: 'Free' },
  starter:    { monthlyLimit: 1000,   ratePerMin: 30,    price: 29,  label: 'Starter — $29/mo' },
  pro:        { monthlyLimit: 10000,  ratePerMin: 120,   price: 99,  label: 'Pro — $99/mo' },
  enterprise: { monthlyLimit: 100000, ratePerMin: 600,   price: 499, label: 'Enterprise — $499/mo' },
};

// In-memory API key store (will move to DB later)
const apiKeyStore = new Map<string, ApiKeyRecord>();

function generateApiKey(): string {
  return 'vgl_' + randomBytes(24).toString('base64url').slice(0, 32);
}

function validateApiKey(key: string): ApiKeyRecord | null {
  const record = apiKeyStore.get(key);
  if (!record) return null;
  if (record.expiresAt && new Date(record.expiresAt) < new Date()) return null;
  return record;
}

function getApiKeyRateLimit(key: string): { allowed: boolean; remaining: number } {
  const record = apiKeyStore.get(key);
  if (!record) return { allowed: false, remaining: 0 };

  if (record.monthlyUsage >= record.monthlyLimit) {
    return { allowed: false, remaining: 0 };
  }

  record.monthlyUsage++;
  return { allowed: true, remaining: record.monthlyLimit - record.monthlyUsage };
}

// Reset monthly usage on the 1st of each month
setInterval(() => {
  const now = new Date();
  if (now.getDate() === 1 && now.getHours() === 0 && now.getMinutes() < 6) {
    for (const record of apiKeyStore.values()) {
      record.monthlyUsage = 0;
    }
    console.log('[API Keys] Monthly usage reset');
  }
}, 300_000); // check every 5 min

// ============================================================
//  CACHES
// ============================================================

const leaderboardCache = new TTLCache<unknown>(300);   // 5 min
const scoreCache = new TTLCache<unknown>(120);         // 2 min
const ecosystemCache = new TTLCache<unknown>(300);     // 5 min

// Prescore cache: stores full PolymarketRiskReport keyed by wallet address
// Structure: { wallet: PolymarketRiskReport & { cachedAt: number } }
const prescoredCache = new Map<string, any>();

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

// 301 redirect from legacy onrender subdomain → canonical vigilscore.xyz
// GET-only: leaves webhook POSTs untouched for transition safety
app.use((req, res, next) => {
  if (req.hostname === 'vigil-trust-api.onrender.com' && req.method === 'GET') {
    return res.redirect(301, `https://vigilscore.xyz${req.originalUrl}`);
  }
  next();
});

// CORS — restricted to known origins
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (curl, server-to-server, mobile apps)
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    // Reject unknown origins
    console.log(`[CORS] Request from unlisted origin rejected: ${origin}`);
    return callback(new Error('CORS not allowed'), false);
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

// Rate limiting middleware — API key holders get elevated limits
app.use((req, res, next) => {
  const apiKey = req.headers['x-api-key'] as string || req.query.api_key as string;

  // If valid API key, use its own rate limit
  if (apiKey) {
    const record = validateApiKey(apiKey);
    if (record) {
      const { allowed, remaining } = getApiKeyRateLimit(apiKey);
      res.setHeader('X-RateLimit-Limit', record.monthlyLimit.toString());
      res.setHeader('X-RateLimit-Remaining', remaining.toString());
      res.setHeader('X-Api-Tier', record.tier);

      if (!allowed) {
        return res.status(429).json({
          error: 'Monthly API limit exceeded',
          message: `Your ${record.tier} plan allows ${record.monthlyLimit} requests/month. Upgrade at /v1/api/pricing`,
          tier: record.tier,
        });
      }
      return next();
    }
    // Invalid key — fall through to IP-based limiting
  }

  // Default IP-based rate limiting for unauthenticated requests
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const { allowed, remaining, resetAt } = getRateLimitInfo(ip);

  res.setHeader('X-RateLimit-Limit', RATE_LIMIT_MAX.toString());
  res.setHeader('X-RateLimit-Remaining', remaining.toString());
  res.setHeader('X-RateLimit-Reset', Math.ceil(resetAt / 1000).toString());

  if (!allowed) {
    return res.status(429).json({
      error: 'Rate limit exceeded',
      message: `Maximum ${RATE_LIMIT_MAX} requests per minute. Add an API key for higher limits. See /v1/api/pricing`,
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

// --- Privacy Policy ---
app.get('/privacy', (_req, res) => {
  res.type('html').send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>VIGIL — Privacy Policy</title></head>
<body style="background:#0c0c0c;color:#e8e8e8;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;margin:0;padding:40px 20px;line-height:1.8">
<div style="max-width:700px;margin:0 auto">
<h1 style="color:#fff;font-size:28px;margin-bottom:8px">VIGIL Privacy Policy</h1>
<p style="color:#555;font-size:13px">Last updated: April 12, 2026</p>

<h2 style="color:#fff;font-size:18px;margin-top:32px">What We Collect</h2>
<p>VIGIL collects minimal data necessary to operate the service. We do not require user accounts or logins for basic scoring. Specifically:</p>
<ul style="margin:8px 0;padding-left:20px">
<li><strong>Email addresses</strong> — only if you voluntarily subscribe to our newsletter or create an API key.</li>
<li><strong>API request logs</strong> — IP address, timestamp, and endpoint, retained for up to 30 days for rate limiting and abuse prevention.</li>
<li><strong>Telegram chat IDs</strong> — only if you interact with our Telegram bot, used solely to deliver responses.</li>
</ul>
<p>We do not use cookies, analytics trackers, or browser fingerprinting. We do not link wallet addresses to personal identities.</p>

<h2 style="color:#fff;font-size:18px;margin-top:32px">Chrome Extension</h2>
<p>The VIGIL Chrome extension reads only the wallet address from Polymarket page URLs to fetch trust score data from the VIGIL API. It does not access browsing history, form data, credentials, or any other personal information. No data is sent to any third party.</p>

<h2 style="color:#fff;font-size:18px;margin-top:32px">API Usage</h2>
<p>When you use the VIGIL API or website, we process the wallet address you submit to generate a trust score. Wallet addresses are public blockchain data. We do not link wallet addresses to personal identities. API request logs (IP address, timestamp, endpoint) are retained for up to 30 days for rate limiting and abuse prevention, then deleted.</p>

<h2 style="color:#fff;font-size:18px;margin-top:32px">API Keys</h2>
<p>If you create an API key, we store the email address you provide and your usage count. This data is used solely for account management and billing. We do not share it with third parties.</p>

<h2 style="color:#fff;font-size:18px;margin-top:32px">Cookies &amp; Tracking</h2>
<p>VIGIL does not use cookies, analytics trackers, or any form of browser fingerprinting. No Google Analytics, no Facebook Pixel, no tracking scripts of any kind.</p>

<h2 style="color:#fff;font-size:18px;margin-top:32px">Data Sharing</h2>
<p>We do not sell, rent, or share any data with third parties. Trust scores are computed on our servers and returned directly to you.</p>

<h2 style="color:#fff;font-size:18px;margin-top:32px">Contact</h2>
<p>Questions about this policy: <a href="mailto:gatson32@gmail.com" style="color:#00d4aa">gatson32@gmail.com</a></p>

<div style="margin-top:40px;padding-top:20px;border-top:1px solid #1e1e1e;font-size:12px;color:#444">VIGIL — Built by Freedom United Works</div>
</div></body></html>`);
});

// --- Google Site Verification ---
app.get('/google3752379bc7fac689.html', (_req, res) => {
  res.type('html').send('google-site-verification: google3752379bc7fac689.html');
});

// --- Homepage (v3 landing: 88.6/100 from 30-reviewer panel; percentile grades, live ticker, curl+JSON, pricing, multiplayer teaser) ---
app.get('/', (_req, res) => {
  res.type('html').send(LANDING_V3_HTML);
});

// --- Legacy homepage (preserved at /v1 for API landing / internal reference) ---
app.get('/legacy-home', (_req, res) => {
  res.type('html').send(renderHomepage());
});

// --- Static social cards (OG / Twitter) — served as cached PNG bytes ---
const OG_PNG = readFileSync(join(__dirname_landing, 'static', 'og', 'vigil-og.png'));
const TWITTER_PNG = readFileSync(join(__dirname_landing, 'static', 'og', 'vigil-twitter.png'));
app.get('/static/og/vigil-og.png', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=604800, immutable');
  res.type('image/png').send(OG_PNG);
});
app.get('/static/og/vigil-twitter.png', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=604800, immutable');
  res.type('image/png').send(TWITTER_PNG);
});

// --- Crawler primitives ---
app.get('/robots.txt', (_req, res) => {
  res.type('text/plain').send([
    'User-agent: *',
    'Allow: /',
    'Disallow: /v1/polymarket/discover/crawl',
    'Disallow: /telegram/',
    'Disallow: /legacy-home',
    '',
    'Sitemap: https://vigilscore.xyz/sitemap.xml',
    '',
  ].join('\n'));
});

app.get('/sitemap.xml', (_req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const staticUrls = [
    { loc: '/', priority: '1.0', changefreq: 'daily' },
    { loc: '/polymarket', priority: '0.9', changefreq: 'hourly' },
    { loc: '/polymarket/leaderboard', priority: '0.9', changefreq: 'hourly' },
    { loc: '/polymarket/divergence', priority: '0.9', changefreq: 'hourly' },
    { loc: '/polymarket/consensus/methodology', priority: '0.7', changefreq: 'weekly' },
    { loc: '/polymarket/methodology', priority: '0.7', changefreq: 'weekly' },
    { loc: '/v1', priority: '0.7', changefreq: 'weekly' },
    { loc: '/api/pricing', priority: '0.6', changefreq: 'monthly' },
    { loc: '/privacy', priority: '0.3', changefreq: 'yearly' },
  ];
  let leaderboardUrls: Array<{ loc: string; priority: string; changefreq: string }> = [];
  try {
    const lb = getSkillLeaderboard();
    if (lb && lb.length) {
      leaderboardUrls = lb.slice(0, 500).map(e => ({
        loc: `/polymarket/${e.wallet}`,
        priority: '0.5',
        changefreq: 'daily',
      }));
    }
  } catch (_) { /* ignore */ }
  const all = [...staticUrls, ...leaderboardUrls];
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...all.map(u => `<url><loc>https://vigilscore.xyz${u.loc}</loc><lastmod>${today}</lastmod><changefreq>${u.changefreq}</changefreq><priority>${u.priority}</priority></url>`),
    '</urlset>',
  ].join('\n');
  res.type('application/xml').send(xml);
});

// --- Health check ---
app.get('/v1/health', async (_req, res) => {
  const historyStats = await getHistoryStats();
  res.json({
    status: 'ok',
    version: '1.18.0',
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
      prescore: prescoredCache.size,
    },
    rateLimit: {
      windowMs: RATE_LIMIT_WINDOW_MS,
      maxRequests: RATE_LIMIT_MAX,
      activeClients: rateLimitStore.size,
    },
    history: historyStats,
    basescan: {
      configured: isBasescanConfigured(),
      chain: 'Base (8453)',
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
:root{--bg:#0c0c0c;--card:#141414;--ink:#e8e8e8;--muted:#707070;--line:#1e1e1e;--accent:${color};}
*{box-sizing:border-box}body{margin:0;font:16px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Inter,system-ui,sans-serif;background:var(--bg);color:var(--ink)}
.wrap{max-width:760px;margin:0 auto;padding:32px 20px 60px}
.topbar{display:flex;align-items:center;gap:12px;margin-bottom:32px}
.logo{font-weight:800;letter-spacing:0.02em;font-size:20px}
.logo span{color:var(--muted);font-weight:500;font-size:14px;margin-left:8px}
.card{background:var(--card);border:1px solid var(--line);border-radius:2px;padding:28px 28px 22px;margin-bottom:18px}
.score-row{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;flex-wrap:wrap}
.score-main h1{margin:0 0 4px;font-size:26px;font-weight:700}
.score-main .sub{color:var(--muted);font-size:14px;margin-bottom:0}
.grade{display:flex;flex-direction:column;align-items:center;min-width:120px}
.grade-letter{font-size:72px;font-weight:800;line-height:1;color:var(--accent)}
.grade-num{font-size:14px;color:var(--muted);margin-top:4px}
.tier{display:inline-block;padding:4px 10px;border-radius:2px;font-size:12px;font-weight:700;letter-spacing:0.04em;background:var(--accent);color:#0c0c0c;margin-top:10px}
.tier-blurb{color:var(--muted);font-size:14px;margin-top:10px}
.section-title{font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:var(--muted);margin:0 0 12px;font-weight:600}
.bar-row{display:flex;align-items:center;gap:12px;margin-bottom:10px;font-size:14px}
.bar-label{min-width:120px;color:var(--muted)}
.bar-track{flex:1;height:8px;background:#1a1a1a;border-radius:1px;overflow:hidden}
.bar-fill{height:100%;border-radius:1px;transition:width .5s}
.bar-val{min-width:32px;text-align:right;font-variant-numeric:tabular-nums;color:var(--ink)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:14px;margin-top:6px}
.stat{background:#0f0f0f;border:1px solid var(--line);border-radius:2px;padding:12px 14px}
.stat-label{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px}
.stat-val{font-size:16px;font-weight:600;font-variant-numeric:tabular-nums}
.flag-list{padding:0;margin:8px 0 0;list-style:none;font-size:14px}
.flag-list li{padding:6px 10px;border-radius:2px;margin-bottom:6px}
.flag-list.red li{background:#2a1414;color:#fca5a5}
.flag-list.green li{background:#102418;color:#86efac}
.reasoning{color:var(--muted);font-size:14px;margin-top:10px}.reasoning p{margin:6px 0}
.foot{font-size:12px;color:var(--muted);padding:16px 0 0;border-top:1px solid var(--line);margin-top:22px;line-height:1.5}
a{color:#00d4aa;text-decoration:none}a:hover{text-decoration:underline}
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
  return `<!doctype html><html><head><meta charset="utf-8"/><title>Not found — VIGIL × DegenClaw</title><style>body{margin:0;font:16px/1.6 -apple-system,system-ui,sans-serif;background:#0c0c0c;color:#e8e8e8;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}.box{max-width:520px;text-align:center}h1{font-size:22px;margin:0 0 12px}p{color:#707070}a{color:#00d4aa}</style></head><body><div class="box"><h1>No DegenClaw agent found for "${dcEscape(query)}"</h1><p>Try the agent name exactly as shown on <a href="https://degen.virtuals.io" target="_blank">degen.virtuals.io</a>, its id, or its wallet address.</p><p>Browse the full leaderboard at <a href="/degenclaw">/degenclaw</a></p></div></body></html>`;
}

function renderDegenClawError(query: string, msg: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"/><title>Error — VIGIL × DegenClaw</title><style>body{margin:0;font:16px/1.6 -apple-system,system-ui,sans-serif;background:#0c0c0c;color:#e8e8e8;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}.box{max-width:520px;text-align:center}h1{font-size:22px;margin:0 0 12px;color:#ef4444}p{color:#707070}code{background:#1a1a1a;padding:2px 6px;border-radius:1px;word-break:break-all}</style></head><body><div class="box"><h1>Upstream error</h1><p>We couldn't fetch data for "${dcEscape(query)}" right now.</p><p><code>${dcEscape(msg)}</code></p><p>Try again in a few seconds.</p></div></body></html>`;
}

function renderDegenClawIndex(all: DegenClawRiskReport[]): string {
  const top = [...all].sort((a, b) => b.trustScore - a.trustScore).slice(0, 25);
  const bottom = [...all].filter(r => r.raw.totalTradeCount >= 10).sort((a, b) => a.trustScore - b.trustScore).slice(0, 10);
  const row = (r: DegenClawRiskReport) => `<tr><td class="rank">#${r.leaderboardRank}</td><td><a href="/degenclaw/${encodeURIComponent(r.agentName)}">${dcEscape(r.agentName)}</a></td><td class="grade" style="color:${dcGradeColor(r.trustGrade)}">${r.trustGrade}</td><td class="num">${r.trustScore}</td><td class="num">$${r.raw.totalRealizedPnl.toFixed(0)}</td><td class="num">${(r.raw.winRate*100).toFixed(0)}%</td><td class="num">${r.raw.sortinoRatio.toFixed(2)}</td><td class="num">${r.raw.totalTradeCount}</td></tr>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>VIGIL × DegenClaw — Risk Rankings for Every Arena Agent</title><meta name="description" content="Independent VIGIL trust scores for every AI agent trading Hyperliquid perps in the DegenClaw Arena."/><style>body{margin:0;font:15px/1.55 -apple-system,system-ui,sans-serif;background:#0c0c0c;color:#e8e8e8}.wrap{max-width:960px;margin:0 auto;padding:32px 20px 60px}h1{font-size:28px;margin:0 0 6px}.lede{color:#707070;max-width:640px;margin-bottom:32px}h2{font-size:15px;text-transform:uppercase;letter-spacing:0.08em;color:#707070;margin:28px 0 12px;font-weight:600}table{width:100%;border-collapse:collapse;background:#141414;border:1px solid #1e1e1e;border-radius:2px;overflow:hidden}th,td{padding:10px 14px;text-align:left;border-bottom:1px solid #1e1e1e;font-size:14px}th{background:#0f0f0f;color:#707070;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;font-weight:600}tr:last-child td{border-bottom:none}td.rank{color:#707070;font-variant-numeric:tabular-nums}td.num{text-align:right;font-variant-numeric:tabular-nums}td.grade{font-weight:700;font-size:16px}a{color:#00d4aa;text-decoration:none}a:hover{text-decoration:underline}.foot{color:#707070;font-size:12px;margin-top:28px;line-height:1.6}</style></head><body><div class="wrap"><h1>VIGIL × DegenClaw Arena</h1><p class="lede">Independent risk ratings for every AI agent trading Hyperliquid perps. DegenClaw's own AI Council ranks by expected return — VIGIL rates by downside risk. <em>Not investment advice.</em></p><h2>Top 25 by VIGIL Trust Score</h2><table><thead><tr><th>DC Rank</th><th>Agent</th><th>Grade</th><th>Score</th><th>PnL</th><th>Win</th><th>Sortino</th><th>Trades</th></tr></thead><tbody>${top.map(row).join('')}</tbody></table><h2>Bottom 10 — Elevated Risk (min 10 trades)</h2><table><thead><tr><th>DC Rank</th><th>Agent</th><th>Grade</th><th>Score</th><th>PnL</th><th>Win</th><th>Sortino</th><th>Trades</th></tr></thead><tbody>${bottom.map(row).join('')}</tbody></table><div class="foot">VIGIL Trust Score is informational only — not investment advice, not a recommendation to subscribe, not a guarantee of future performance.<br/>Data from <a href="https://degen.virtuals.io" target="_blank" rel="noopener">degen.virtuals.io</a> public leaderboard · updated every 60s<br/>JSON: <a href="/v1/degenclaw/leaderboard">/v1/degenclaw/leaderboard</a></div></div></body></html>`;
}

// ============================================================
//  DEGENCLAW — Risk scoring for Hyperliquid trading agents
// ============================================================

app.get('/v1/degenclaw/leaderboard', async (req, res) => {
  try {
    const limit = clampInt(req.query.limit as string, 1, 1000, 100);
    const sort = String(req.query.sort || 'trustScore');
    const order = String(req.query.order || 'desc') === 'asc' ? 1 : -1;

    // Whitelist allowed sort fields
    const allowedSorts = ['trustScore', 'trustGrade', 'profitability', 'consistency', 'discipline', 'capitalRisk', 'sampleSize', 'agentName', 'leaderboardRank'];
    const sortField = allowedSorts.includes(sort) ? sort : 'trustScore';

    const all = await scoreAllDegenClawAgents();
    const sorted = all.sort((a, b) => {
      const av = (a as unknown as Record<string, number>)[sortField] ?? 0;
      const bv = (b as unknown as Record<string, number>)[sortField] ?? 0;
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
        sort: sortField, order: order === 1 ? 'asc' : 'desc',
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
// IMPORTANT: Guard against reserved sub-route names that would be caught by :wallet
app.get('/v1/polymarket/:wallet', async (req, res, next) => {
  const reserved = ['compare', 'search', 'recent', 'discover', 'leaderboard', 'api-docs', 'score', 'divergence'];
  if (reserved.includes(req.params.wallet)) return next();
  try {
    const wallet = String(req.params.wallet || '').trim();
    if (!wallet || !wallet.startsWith('0x')) {
      return res.status(400).json({ error: 'INVALID_WALLET', message: 'Provide a valid 0x wallet address.' });
    }

    // Check prescore cache first — 2 hour TTL
    const walletLower = wallet.toLowerCase();
    const cached = prescoredCache.get(walletLower);
    const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
    if (cached && (Date.now() - cached.cachedAt) < TWO_HOURS_MS) {
      const { cachedAt, ...report } = cached;
      return res.json({ ...report, cached: true, cachedAt });
    }

    // Not cached or expired — score normally
    const report = await scorePolymarketTrader(wallet);
    if (!report) {
      return res.status(404).json({ error: 'TRADER_NOT_FOUND', message: `No Polymarket activity found for ${wallet}.` });
    }

    // Update prescore cache
    prescoredCache.set(walletLower, {
      ...report,
      cachedAt: Date.now(),
    });

    addRecentScore(report);
    return res.json(report);
  } catch (err) {
    return res.status(502).json({ error: 'POLYMARKET_UPSTREAM_ERROR', message: (err as Error).message });
  }
});

// v3 landing scorer alias — accepts ?wallet=0x... | ?wallet=username | ?wallet=ens.eth
// Resolves identifier, scores, augments with percentile for the landing-page UI.
app.get('/v1/polymarket/score', async (req, res) => {
  try {
    const raw = String(req.query.wallet || '').trim();
    if (!raw) return res.status(400).json({ error: 'MISSING_WALLET', message: 'Provide ?wallet=<0x address | username | ens>.' });

    // Resolve non-0x identifiers (usernames, ENS) to a wallet address
    let wallet = raw;
    if (!raw.startsWith('0x')) {
      const resolved = resolveWalletIdentifier(raw);
      if (!resolved) {
        return res.status(404).json({ error: 'UNRESOLVED_IDENTIFIER', message: `Could not resolve "${raw}" to a wallet. Try a 0x address.` });
      }
      wallet = resolved;
    }
    if (!wallet.startsWith('0x')) {
      return res.status(400).json({ error: 'INVALID_WALLET', message: 'Provide a valid 0x wallet address.' });
    }

    // Re-use the prescored cache
    const walletLower = wallet.toLowerCase();
    const cached = prescoredCache.get(walletLower);
    const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
    let report: any;
    if (cached && (Date.now() - cached.cachedAt) < TWO_HOURS_MS) {
      const { cachedAt, ...rest } = cached;
      report = { ...rest, cached: true, cachedAt };
    } else {
      const fresh = await scorePolymarketTrader(wallet);
      if (!fresh) {
        return res.status(404).json({ error: 'TRADER_NOT_FOUND', message: `No Polymarket activity found for ${wallet}.` });
      }
      prescoredCache.set(walletLower, { ...fresh, cachedAt: Date.now() });
      addRecentScore(fresh);
      report = fresh;
    }

    // Augment with percentile against live skill leaderboard
    let percentile: number | null = null;
    try {
      const lb = getSkillLeaderboard();
      if (lb && lb.length > 1) {
        const myScore = (report as any).trustScore ?? (report as any).score ?? 0;
        const below = lb.filter(e => (e.trustScore ?? 0) <= myScore).length;
        percentile = Math.round((below / lb.length) * 100);
      }
    } catch (_) { /* ignore */ }

    return res.json({
      ...(report as any),
      grade: (report as any).trustGrade ?? (report as any).grade,
      score: (report as any).trustScore ?? (report as any).score,
      bss: (report as any).brierSkillScore ?? (report as any).bss,
      resolved: (report as any).resolvedBets ?? (report as any).resolved,
      percentile,
    });
  } catch (err) {
    return res.status(502).json({ error: 'POLYMARKET_UPSTREAM_ERROR', message: (err as Error).message });
  }
});

// Search endpoint — resolve username/partial to wallet and redirect
app.get('/polymarket/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.redirect('/');

  const wallet = resolveWalletIdentifier(q);
  if (wallet) return res.redirect(`/polymarket/${wallet}`);

  // Not in cache — try as raw wallet address anyway
  if (q.startsWith('0x') && q.length >= 40) return res.redirect(`/polymarket/${q}`);

  // Unknown username — show not found
  res.status(404).type('html').send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VIGIL — Not Found</title></head>
  <body style="background:#0c0c0c;color:#fff;font-family:'Inter',-apple-system,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:20px;text-align:center">
    <div style="font-size:28px;font-weight:800;letter-spacing:3px;margin-bottom:16px">VIGIL</div>
    <div style="font-size:18px;color:#ef4444;margin-bottom:12px">Username "${hEsc(q)}" not found</div>
    <p style="color:#555;max-width:400px">Try pasting a full wallet address (0x...), or search for a trader who has been scored recently. The username cache grows as more wallets get scored.</p>
    <a href="/" style="margin-top:20px;color:#3b82f6;text-decoration:none">Back to VIGIL</a>
  </body></html>`);
});

// JSON search endpoint
app.get('/v1/polymarket/search', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  if (!q) return res.json({ results: [] });

  const results: { name: string; wallet: string }[] = [];
  for (const [name, wallet] of usernameToWallet) {
    if (name.includes(q)) results.push({ name, wallet });
    if (results.length >= 10) break;
  }
  res.json({ query: q, results });
});

// Legacy URL redirects — these paths are linked from the landing page but not
// yet built as standalone pages. Redirect to the relevant landing anchor / working
// equivalent so internal links and cached shares never 404.
app.get('/polymarket/methodology', (_req, res) => res.type('html').send(gradingMethodologyPage()));
app.get('/polymarket/changelog', (_req, res) => res.redirect(301, '/#builder'));
app.get('/polymarket/weekly', (_req, res) => res.redirect(301, '/#social'));
app.get('/v1/polymarket/api-docs', (_req, res) => res.redirect(301, '/v1'));

// HTML score card for a Polymarket trader
app.get('/polymarket/:wallet', async (req, res, next) => {
  if (['compare', 'search', 'leaderboard', 'methodology', 'changelog', 'weekly', 'divergence'].includes(req.params.wallet)) return next();
  let wallet = String(req.params.wallet || '').trim();

  // If not a wallet address, try username resolution
  if (!wallet.startsWith('0x')) {
    const resolved = resolveWalletIdentifier(wallet);
    if (resolved) return res.redirect(`/polymarket/${resolved}`);
    return res.status(404).type('html').send(renderPolymarketNotFound(wallet));
  }

  try {
    const report = await scorePolymarketTrader(wallet);
    if (!report) {
      res.status(404).type('html').send(renderPolymarketNotFound(wallet));
      return;
    }
    addRecentScore(report);
    res.type('html').send(renderPolymarketScoreCard(report));
  } catch (err) {
    res.status(502).type('html').send(renderPolymarketError(wallet, (err as Error).message));
  }
});

// HTML index (landing page for /polymarket)
app.get('/polymarket', (_req, res) => {
  res.type('html').send(renderPolymarketIndex());
});

// JSON API: recently scored wallets
app.get('/v1/polymarket/recent', (_req, res) => {
  res.json(recentScores);
});

// ============================================================
//  OG IMAGE GENERATOR — branded SVG scorecard for social sharing
// ============================================================
app.get('/v1/polymarket/:wallet/og.svg', async (req, res) => {
  try {
    const wallet = String(req.params.wallet || '').trim();
    const report = await scorePolymarketTrader(wallet);
    if (!report) return res.status(404).send('Not found');

    const gc = report.trustGrade === 'A' ? '#10b981' : report.trustGrade === 'B' ? '#3b82f6' : report.trustGrade === 'C' ? '#eab308' : report.trustGrade === 'D' ? '#f97316' : '#ef4444';
    const pnl = report.raw.totalPnl;
    const pnlStr = pnl >= 0 ? `+$${Math.round(pnl).toLocaleString()}` : `-$${Math.round(Math.abs(pnl)).toLocaleString()}`;
    const pnlColor = pnl >= 0 ? '#10b981' : '#ef4444';
    const name = report.displayName.length > 20 ? report.displayName.slice(0, 18) + '...' : report.displayName;
    const confDesc = report.confidence?.description || `${report.trustGrade}/${report.trustScore}`;

    const dims = [
      { label: 'Calibration', val: report.calibration, weight: '25%' },
      { label: 'Live Edge', val: (report as any).liveEdge ?? 50, weight: '25%' },
      { label: 'Profitability', val: report.profitability, weight: '15%' },
      { label: 'Consistency', val: report.consistency, weight: '15%' },
      { label: 'Discipline', val: report.discipline, weight: '10%' },
      { label: 'Sample Size', val: report.sampleSize, weight: '10%' },
    ];

    const dimBars = dims.map((d, i) => {
      const y = 200 + i * 34;
      const barWidth = Math.max(2, (d.val / 100) * 240);
      const barColor = d.val >= 65 ? '#10b981' : d.val >= 35 ? '#eab308' : '#ef4444';
      return `
        <text x="40" y="${y + 13}" fill="#707070" font-size="12" font-family="system-ui,sans-serif">${d.label}</text>
        <text x="155" y="${y + 13}" fill="#444" font-size="9" font-family="system-ui,sans-serif">${d.weight}</text>
        <rect x="185" y="${y + 1}" width="240" height="12" rx="1" fill="#1e1e1e"/>
        <rect x="185" y="${y + 1}" width="${barWidth}" height="12" rx="1" fill="${barColor}"/>
        <text x="432" y="${y + 13}" fill="#fff" font-size="12" font-weight="700" font-family="system-ui,sans-serif">${d.val}</text>
      `;
    }).join('');

    // Skill vs Luck bar
    const skill = report.calibrationReport?.skillDecomposition?.skill ?? 0;
    const luck = report.calibrationReport?.skillDecomposition?.luck ?? 0;
    const hasSkillData = skill > 0 || luck > 0;
    const skillBarWidth = hasSkillData ? Math.max(10, (skill / (skill + luck)) * 200) : 0;
    const luckBarWidth = hasSkillData ? 200 - skillBarWidth : 0;
    const skillLuckSvg = hasSkillData ? `
      <text x="40" y="420" fill="#555" font-size="9" text-transform="uppercase" letter-spacing="1" font-family="system-ui,sans-serif">Skill vs Luck</text>
      <rect x="185" y="410" width="${skillBarWidth}" height="14" rx="${luckBarWidth > 0 ? '7 0 0 7' : '7'}" fill="#10b981"/>
      <rect x="${185 + skillBarWidth}" y="410" width="${luckBarWidth}" height="14" rx="${skillBarWidth > 0 ? '0 7 7 0' : '7'}" fill="#6366f1"/>
      <text x="395" y="422" fill="#707070" font-size="10" font-family="system-ui,sans-serif">${skill.toFixed(0)}% / ${luck.toFixed(0)}%</text>
    ` : '';

    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 600 315">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0c0c0c"/>
      <stop offset="100%" stop-color="#0f0f0f"/>
    </linearGradient>
  </defs>
  <rect width="600" height="315" fill="url(#bg)"/>
  <rect x="0" y="0" width="600" height="3" fill="${gc}"/>
  <rect x="0" y="312" width="600" height="3" fill="${gc}" opacity="0.3"/>

  <!-- Logo -->
  <text x="40" y="35" fill="#00d4aa" font-size="16" font-weight="800" letter-spacing="4" font-family="monospace">VIGIL</text>
  <text x="115" y="35" fill="#444" font-size="11" font-family="system-ui,sans-serif">Trust Score</text>

  <!-- Grade box -->
  <rect x="472" y="27" width="96" height="96" rx="2" fill="${gc}12" stroke="${gc}" stroke-width="2"/>
  <text x="520" y="88" fill="${gc}" font-size="44" font-weight="800" text-anchor="middle" font-family="monospace">${report.trustGrade}</text>
  <text x="520" y="136" fill="#fff" font-size="22" font-weight="700" text-anchor="middle" font-family="system-ui,sans-serif">${report.trustScore}/100</text>
  <text x="520" y="152" fill="#555" font-size="10" text-anchor="middle" font-family="system-ui,sans-serif">${report.trustTier}</text>

  <!-- Trader info -->
  <text x="40" y="68" fill="#fff" font-size="22" font-weight="700" font-family="system-ui,sans-serif">${hEsc(name)}</text>
  <text x="40" y="85" fill="#555" font-size="10" font-family="monospace">${wallet.slice(0, 10)}...${wallet.slice(-4)}</text>
  <text x="40" y="105" fill="#444" font-size="10" font-family="system-ui,sans-serif">${hEsc(confDesc)}</text>

  <!-- Key metrics row -->
  <text x="40" y="135" fill="#555" font-size="9" text-transform="uppercase" letter-spacing="1" font-family="system-ui,sans-serif">PnL</text>
  <text x="40" y="153" fill="${pnlColor}" font-size="17" font-weight="700" font-family="system-ui,sans-serif">${pnlStr}</text>

  <text x="155" y="135" fill="#555" font-size="9" text-transform="uppercase" letter-spacing="1" font-family="system-ui,sans-serif">Resolved</text>
  <text x="155" y="153" fill="#fff" font-size="17" font-weight="700" font-family="system-ui,sans-serif">${report.raw.resolvedBets}</text>

  <text x="255" y="135" fill="#555" font-size="9" text-transform="uppercase" letter-spacing="1" font-family="system-ui,sans-serif">Win Rate</text>
  <text x="255" y="153" fill="#fff" font-size="17" font-weight="700" font-family="system-ui,sans-serif">${(report.raw.winRate * 100).toFixed(0)}%</text>

  <text x="340" y="135" fill="#555" font-size="9" text-transform="uppercase" letter-spacing="1" font-family="system-ui,sans-serif">Brier</text>
  <text x="340" y="153" fill="${report.calibrationReport.brierScore < 0.2 ? '#10b981' : report.calibrationReport.brierScore < 0.3 ? '#eab308' : '#ef4444'}" font-size="17" font-weight="700" font-family="system-ui,sans-serif">${report.calibrationReport.brierScore.toFixed(3)}</text>

  <!-- Divider -->
  <line x1="40" y1="170" x2="460" y2="170" stroke="#1e1e1e" stroke-width="1"/>

  <!-- Dimension bars header -->
  <text x="40" y="190" fill="#555" font-size="9" text-transform="uppercase" letter-spacing="1" font-family="system-ui,sans-serif">Scoring Dimensions</text>
  ${dimBars}

  <!-- Skill vs Luck -->
  ${skillLuckSvg}

  <!-- Footer -->
  <rect x="0" y="290" width="600" height="25" fill="#06080e"/>
  <text x="40" y="306" fill="#333" font-size="9" font-family="system-ui,sans-serif">vigilscore.xyz</text>
  <text x="300" y="306" fill="#333" font-size="9" text-anchor="middle" font-family="system-ui,sans-serif">Not financial advice</text>
  <text x="560" y="306" fill="#333" font-size="9" text-anchor="end" font-family="system-ui,sans-serif">Score any wallet free</text>
</svg>`;

    res.set('Content-Type', 'image/svg+xml');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(svg);
  } catch (err) {
    res.status(500).send('OG generation failed');
  }
});

// ============================================================
//  COMPARE ENDPOINT — side-by-side wallet scorecards
// ============================================================
app.get('/v1/polymarket/compare', async (req, res) => {
  try {
    const walletsParam = String(req.query.wallets || '');
    const wallets = walletsParam.split(',').map(w => w.trim().toLowerCase()).filter(w => w.startsWith('0x'));
    if (wallets.length < 2 || wallets.length > 5) {
      return res.status(400).json({ error: 'INVALID_PARAMS', message: 'Provide 2-5 comma-separated wallet addresses via ?wallets=0x...,0x...' });
    }

    const results = await Promise.allSettled(wallets.map(w => scorePolymarketTrader(w)));
    const scores = results.map((r, i) => {
      if (r.status === 'fulfilled' && r.value) {
        return r.value;
      }
      return { wallet: wallets[i], error: 'No data found', trustScore: null, trustGrade: null };
    });

    res.json({
      compared: scores.length,
      wallets: scores,
      scoredAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: 'COMPARE_FAILED', message: (err as Error).message });
  }
});

// HTML: side-by-side compare page
app.get('/polymarket/compare', async (req, res) => {
  try {
    const walletsParam = String(req.query.wallets || '');
    const wallets = walletsParam.split(',').map(w => w.trim().toLowerCase()).filter(w => w.startsWith('0x'));
    if (wallets.length < 2 || wallets.length > 5) {
      return res.status(400).type('html').send(`<html><body style="background:#0c0c0c;color:#fff;font-family:sans-serif;padding:40px;text-align:center"><h2>Compare 2-5 wallets</h2><p style="color:#555">Usage: /polymarket/compare?wallets=0x...,0x...</p></body></html>`);
    }

    const results = await Promise.allSettled(wallets.map(w => scorePolymarketTrader(w)));
    const cards = results.map((r, i) => {
      if (r.status !== 'fulfilled' || !r.value) {
        return `<div style="flex:1;min-width:200px;background:#141414;border-radius:2px;padding:20px;border:1px solid #1e1e1e"><p style="color:#ef4444">No data for ${wallets[i].slice(0,8)}...</p></div>`;
      }
      const d = r.value;
      const gc = d.trustGrade === 'A' ? '#10b981' : d.trustGrade === 'B' ? '#3b82f6' : d.trustGrade === 'C' ? '#eab308' : d.trustGrade === 'D' ? '#f97316' : '#ef4444';
      const totalPnl = d.raw.totalPnl;
      const pnl = totalPnl >= 0 ? `+$${Math.round(totalPnl).toLocaleString()}` : `-$${Math.round(Math.abs(totalPnl)).toLocaleString()}`;
      const pnlColor = totalPnl >= 0 ? '#10b981' : '#ef4444';
      const name = d.displayName || d.wallet.slice(0, 10) + '...';
      const dims = [
        ['Calibration', d.calibration],
        ['Live Edge', (d as any).liveEdge ?? '-'],
        ['Profitability', d.profitability],
        ['Consistency', d.consistency],
        ['Discipline', d.discipline],
        ['Sample Size', d.sampleSize],
      ];
      const dimRows = dims.map(([label, val]) => {
        const v = typeof val === 'number' ? val : 0;
        return `<div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0"><span style="color:#555">${label}</span><span style="color:#fff;font-weight:600">${val}</span></div>`;
      }).join('');

      return `<div style="flex:1;min-width:220px;background:#141414;border-radius:2px;padding:20px;border:1px solid #1e1e1e">
        <div style="text-align:center;margin-bottom:12px">
          <div style="display:inline-flex;align-items:center;justify-content:center;width:48px;height:48px;border-radius:2px;background:${gc}15;color:${gc};font-size:22px;font-weight:800;border:1px solid ${gc}40;font-family:'JetBrains Mono','SF Mono',monospace">${d.trustGrade}</div>
          <div style="font-size:28px;font-weight:800;color:#fff;margin-top:4px">${d.trustScore}</div>
          <div style="font-size:10px;color:#555;text-transform:uppercase;letter-spacing:1px">${d.trustTier}</div>
        </div>
        <div style="font-size:14px;font-weight:600;color:#fff;text-align:center;margin-bottom:4px">${hEsc(name)}</div>
        <div style="font-size:11px;color:#444;text-align:center;font-family:monospace;margin-bottom:12px">${d.wallet.slice(0,10)}...${d.wallet.slice(-4)}</div>
        <div style="text-align:center;font-size:18px;font-weight:700;color:${pnlColor};margin-bottom:12px">${pnl}</div>
        <div style="border-top:1px solid #1e1e1e;padding-top:10px">${dimRows}</div>
        <a href="/polymarket/${d.wallet}" style="display:block;text-align:center;margin-top:12px;padding:6px;background:#1e1e1e;border-radius:2px;color:#707070;text-decoration:none;font-size:11px;font-weight:600">Full Scorecard &rarr;</a>
      </div>`;
    }).join('');

    res.type('html').send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VIGIL Compare</title></head>
    <body style="background:#0c0c0c;color:#fff;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;margin:0;padding:24px">
      <div style="max-width:1000px;margin:0 auto">
        <div style="text-align:center;margin-bottom:24px"><a href="/" style="font-size:20px;font-weight:800;letter-spacing:3px;color:#fff;text-decoration:none">VIGIL</a><span style="color:#555;font-size:13px;margin-left:12px">Compare</span></div>
        <div style="display:flex;gap:16px;flex-wrap:wrap;justify-content:center">${cards}</div>
        <div style="text-align:center;margin-top:20px;color:#333;font-size:11px">VIGIL Trust Score is informational only.</div>
      </div>
    </body></html>`);
  } catch (err) {
    res.status(500).type('html').send(`<html><body style="background:#0c0c0c;color:#ef4444;padding:40px">Compare failed: ${pmEscape((err as Error).message)}</body></html>`);
  }
});

// ============================================================
//  SKILL-WEIGHTED CONSENSUS (v1.21.0)
//  For a given market, aggregate the positions of every graded wallet
//  (weighted by grade × sqrt(stake) × time decay) into a single
//  "skilled money" probability. The headline divergence number is
//  (consensusP - impliedMarketP) — it says: where is the calibrated
//  money disagreeing with the market?
// ============================================================

/**
 * GET /v1/polymarket/markets/:marketId/skill-consensus
 *   marketId → Polymarket conditionId (0x...), OR a human-readable slug
 *
 * Response (success):
 *   { marketId, marketTitle, marketSlug, impliedMarketP, consensusP,
 *     divergence, divergenceDirection, contributingWallets, gradeWeights,
 *     effectiveSampleSize, ci95, totalSkillStake, topContributors,
 *     asOf, notes, dataQuality }
 *
 * Response (insufficient data):
 *   { error: 'INSUFFICIENT_DATA' | 'MARKET_NOT_FOUND', message, ... }
 */
app.get('/v1/polymarket/markets/:marketId/skill-consensus', async (req, res) => {
  try {
    let marketId = String(req.params.marketId || '').trim();
    if (!marketId) {
      return res.status(400).json({ error: 'MISSING_MARKET_ID', message: 'Provide a conditionId (0x...) or market slug.' });
    }

    // Resolve slug → conditionId if a non-0x identifier was provided
    if (!marketId.startsWith('0x')) {
      const resolved = await resolveMarketSlug(marketId);
      if (!resolved) {
        return res.status(404).json({ error: 'MARKET_NOT_FOUND', message: `Could not resolve "${marketId}" to a Polymarket market.` });
      }
      marketId = resolved;
    }

    const result = await computeSkillConsensus(marketId);
    if ('error' in result) {
      const status = result.error === 'MARKET_NOT_FOUND' ? 404 : result.error === 'INSUFFICIENT_DATA' ? 422 : 502;
      return res.status(status).json(result);
    }

    return res.json(result);
  } catch (err) {
    return res.status(502).json({ error: 'CONSENSUS_UPSTREAM_ERROR', message: (err as Error).message });
  }
});

/**
 * GET /v1/polymarket/consensus/stats — warm/cold cache visibility.
 */
app.get('/v1/polymarket/consensus/stats', (_req, res) => {
  res.json({
    ...getConsensusCacheStats(),
    leaderboardSize: getSkillLeaderboard().length,
  });
});

/**
 * HTML: /polymarket/consensus/methodology
 */
app.get('/polymarket/consensus/methodology', (_req, res) => {
  res.type('html').send(methodologyPage());
});

/**
 * HTML: /polymarket/markets/:marketId/consensus
 * Shareable divergence page. Reads the same data as the JSON endpoint,
 * renders a single-page scoreboard: market price vs skilled-money price,
 * divergence badge, grade breakdown, top contributors with their revealed
 * beliefs. Self-contained (inline CSS) so it works without the landing shell.
 */
app.get('/polymarket/markets/:marketId/consensus', async (req, res) => {
  try {
    let marketId = String(req.params.marketId || '').trim();
    if (!marketId) return res.status(400).type('html').send(errorPage('Missing market identifier.'));

    if (!marketId.startsWith('0x')) {
      const resolved = await resolveMarketSlug(marketId);
      if (!resolved) return res.status(404).type('html').send(errorPage(`Could not resolve "${hEsc(marketId)}" to a Polymarket market.`));
      marketId = resolved;
    }

    const result = await computeSkillConsensus(marketId);
    if ('error' in result) {
      if (result.error === 'MARKET_NOT_FOUND') {
        return res.status(404).type('html').send(errorPage(`Market ${marketId.slice(0, 10)}… not found on Polymarket.`));
      }
      if (result.error === 'INSUFFICIENT_DATA') {
        return res.status(200).type('html').send(insufficientPage(marketId, result.message));
      }
      return res.status(502).type('html').send(errorPage(result.message));
    }

    return res.type('html').send(consensusPage(result));
  } catch (err) {
    return res.status(502).type('html').send(errorPage((err as Error).message));
  }
});

// ─── HTML helpers for the consensus page ──────────────────────────

function errorPage(msg: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VIGIL — Not Found</title><style>body{background:#0c0c0c;color:#fff;font-family:'Inter',-apple-system,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:20px;text-align:center}a{color:#3b82f6}</style></head><body><div style="font-size:28px;font-weight:800;letter-spacing:3px;margin-bottom:16px"><a href="/" style="color:#fff;text-decoration:none">VIGIL</a></div><div style="font-size:18px;color:#ef4444;margin-bottom:12px">${hEsc(msg)}</div><a href="/" style="margin-top:20px">← Back to VIGIL</a></body></html>`;
}

function insufficientPage(marketId: string, msg: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VIGIL — Insufficient Signal</title><style>body{background:#0c0c0c;color:#fff;font-family:'Inter',-apple-system,sans-serif;margin:0;padding:24px}.wrap{max-width:720px;margin:0 auto}.card{background:#141414;border:1px solid #1e1e1e;border-radius:2px;padding:28px;margin-top:24px}a{color:#3b82f6}</style></head><body><div class="wrap"><div style="text-align:center;margin-bottom:24px"><a href="/" style="font-size:20px;font-weight:800;letter-spacing:3px;color:#fff;text-decoration:none">VIGIL</a></div><div class="card"><div style="font-size:11px;color:#707070;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px">// insufficient signal</div><div style="font-size:22px;font-weight:700;margin-bottom:12px">Not enough graded wallets in this market yet.</div><p style="color:#999;line-height:1.6">${hEsc(msg)}</p><p style="color:#555;font-size:13px;margin-top:20px">Market: <code>${hEsc(marketId)}</code></p><p style="margin-top:24px"><a href="/polymarket/leaderboard">← See the full skill leaderboard</a></p></div></div></body></html>`;
}

function methodologyPage(): string {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>VIGIL Consensus — Methodology</title>
<meta name="description" content="How VIGIL aggregates graded wallet positions into a skill-weighted consensus probability. Full math, assumptions, and limitations.">
<meta property="og:title" content="VIGIL Consensus — Methodology">
<meta property="og:description" content="Grade-weighted, stake-dampened, time-decayed aggregation of Polymarket wallet positions. 1000-resample bootstrap CI.">
<link rel="canonical" href="https://vigilscore.xyz/polymarket/consensus/methodology">
<style>
  body{background:#0c0c0c;color:#fff;font-family:'Inter',-apple-system,sans-serif;margin:0;padding:24px;line-height:1.7}
  .wrap{max-width:760px;margin:0 auto}
  h1{font-size:28px;font-weight:800;margin:0 0 8px;letter-spacing:-0.5px}
  h2{font-size:18px;font-weight:700;margin:32px 0 12px;color:#fff;border-bottom:1px solid #1e1e1e;padding-bottom:8px}
  p{color:#ccc;font-size:15px}
  code,pre{font-family:'JetBrains Mono','SF Mono',monospace;color:#eab308;background:#141414;padding:2px 6px;border-radius:2px;font-size:13px}
  pre{display:block;padding:14px;color:#e5e7eb;line-height:1.5;overflow-x:auto}
  .kicker{font-size:11px;color:#707070;letter-spacing:2.5px;text-transform:uppercase;margin-bottom:8px;font-weight:600}
  a{color:#3b82f6;text-decoration:none}a:hover{text-decoration:underline}
  .header{text-align:center;margin-bottom:24px}
  .brand{font-size:22px;font-weight:800;letter-spacing:3px;color:#fff;text-decoration:none}
  table{width:100%;border-collapse:collapse;margin:14px 0;font-size:14px}
  th,td{padding:8px 12px;border-bottom:1px solid #1e1e1e;text-align:left}
  th{color:#707070;font-size:11px;text-transform:uppercase;letter-spacing:1.5px}
  .footer{text-align:center;margin-top:40px;color:#555;font-size:11px}
</style></head>
<body>
<div class="wrap">
  <div class="header"><a class="brand" href="/">VIGIL</a><div style="color:#707070;font-size:13px;margin-top:4px">Consensus · Methodology</div></div>

  <div class="kicker">// what this is</div>
  <h1>Skill-weighted consensus for Polymarket.</h1>
  <p>For any active Polymarket market, VIGIL aggregates the positions of every graded wallet in our universe (currently ~600 A/B/C/D-graded traders) into a single probability that represents "what does the calibrated money think about this market?" The number you see is <em>not</em> an average of all traders — it's weighted by each trader's historical forecasting skill, the size of their position, and how recently they took it.</p>

  <h2>The formula</h2>
  <pre>weight_i       = grade_weight_i × √(stake_i) × exp(−days_since_entry_i / 30)
P_consensus    = Σ(weight_i × impliedP_Yes_i) / Σ(weight_i)</pre>
  <p>Three weights multiply together:</p>

  <h2>Grade weight</h2>
  <p>A trader's grade is a proxy for their calibration skill — how well their stated probabilities match observed outcomes over their full resolved-bet history. Higher grades get more weight:</p>
  <table>
    <tr><th>Grade</th><th>Weight</th><th>Meaning</th></tr>
    <tr><td><code>A</code></td><td><code>1.00</code></td><td>Demonstrated calibration across 100+ resolved bets. ~3% of scored wallets.</td></tr>
    <tr><td><code>B</code></td><td><code>0.60</code></td><td>Solid calibration. ~8%.</td></tr>
    <tr><td><code>C</code></td><td><code>0.25</code></td><td>Developing. ~20%.</td></tr>
    <tr><td><code>D</code></td><td><code>0.05</code></td><td>Below naïve. Included but heavily down-weighted.</td></tr>
    <tr><td><code>F</code></td><td><code>0.00</code></td><td>Excluded from consensus. Too unreliable to contribute.</td></tr>
  </table>

  <h2>Stake weight (√USDC)</h2>
  <p>A trader staking $100,000 knows more than a trader staking $100 — but not 1000× more. We use <code>√(stake)</code> to dampen whale over-influence. A $1M position is 10× (not 100×) the weight of a $10K position.</p>

  <h2>Time decay (30-day half-life)</h2>
  <p>Beliefs go stale. A position taken 60 days ago reflects the trader's forecast at the time of entry — not today's information. We apply <code>exp(−days/30)</code>, so a 30-day-old position counts for half, a 60-day-old position for a quarter. Fresh positions dominate.</p>

  <h2>Implied P(Yes) per position</h2>
  <p>Each trader's revealed probability is their average entry price, inverted for No-side holders:</p>
  <pre>Yes-side holder:   impliedP_Yes = avgPrice
No-side holder:    impliedP_Yes = 1 − avgPrice</pre>
  <p>Clamped to <code>[0.001, 0.999]</code> to avoid log-singularities downstream.</p>

  <h2>Confidence interval</h2>
  <p>95% CI is computed by 1000-resample bootstrap. We resample (wallet, position) pairs with replacement, recompute the weighted mean, and take the 2.5 / 97.5 percentiles. Wider CI ⇒ more disagreement among contributors.</p>

  <h2>Gates (INSUFFICIENT_DATA)</h2>
  <p>We refuse to publish a consensus if either:</p>
  <table>
    <tr><th>Gate</th><th>Threshold</th><th>Rationale</th></tr>
    <tr><td>Minimum wallets</td><td><code>≥ 5</code></td><td>Fewer than 5 holders is noise, not signal.</td></tr>
    <tr><td>Effective sample size</td><td><code>Σ(grade × decay) ≥ 0.5</code></td><td>E.g. 5 C-grades clears this; 10 F-grades does not.</td></tr>
  </table>

  <h2>Data quality bands</h2>
  <table>
    <tr><th>Band</th><th>Effective sample</th><th>Interpretation</th></tr>
    <tr><td><code>strong</code></td><td>≥ 10</td><td>Multiple A/B-grade contributors. Treat seriously.</td></tr>
    <tr><td><code>moderate</code></td><td>5 – 10</td><td>Useful signal; note the CI width.</td></tr>
    <tr><td><code>weak</code></td><td>0.5 – 5</td><td>Light signal. Could flip with one more data point.</td></tr>
    <tr><td><code>insufficient</code></td><td>&lt; 0.5</td><td>Not published.</td></tr>
  </table>

  <h2>What consensus does NOT mean</h2>
  <p>This is not a price prediction. It is an <em>aggregation of revealed beliefs</em> from traders who have historically been well-calibrated. A divergence between market and consensus is a disagreement, not a trade signal. Skilled traders can be wrong; new information can move the market before it moves consensus.</p>
  <p>Consensus also inherits the limits of its inputs: our graded universe is currently ~600 wallets (growing), and the grade itself is an estimate with its own confidence interval. See the <a href="/polymarket/methodology">scoring methodology</a> for how grades are computed.</p>

  <h2>Known limitations</h2>
  <p>The "days since entry" field is heuristic — Polymarket's position endpoint doesn't expose first-entry timestamps. We approximate from market-close date. v1.22 will cross-reference the trade log to recover exact entry timestamps.</p>
  <p>Positions that have been fully exited aren't counted — only current holdings. If a graded A-grade trader bought at 0.30 and sold at 0.55 two days ago, their conviction is gone from our aggregate.</p>

  <h2>Get the JSON</h2>
  <pre>GET /v1/polymarket/markets/:marketId/skill-consensus</pre>
  <p>Accepts a Polymarket <code>conditionId</code> (0x…) or a slug (<code>will-trump-win-2024</code>). Returns the full breakdown including top contributors. 5-minute TTL cache.</p>

  <div class="footer"><a href="/" style="color:#707070">← Back to VIGIL</a> · <a href="/polymarket/leaderboard" style="color:#707070">Skill Leaderboard</a> · <a href="/polymarket/methodology" style="color:#707070">Grade Methodology</a></div>
</div>
</body></html>`;
}

/**
 * v1.22.0 — Grading Methodology page (/polymarket/methodology)
 * This is the shield for the CRO's #1 failure mode: "first quant bootstraps
 * our data and shows B vs C- overlap at 95% CI." This page publishes the
 * exact formula, reference forecast, bootstrap CI procedure, and INS rule.
 */
function gradingMethodologyPage(): string {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>VIGIL Grading — Methodology</title>
<meta name="description" content="How VIGIL grades Polymarket traders: Brier Skill Score, calibration error, bootstrap CI95, and the 'Insufficient Data' rule. Full math.">
<meta property="og:title" content="VIGIL Grading — Methodology">
<meta property="og:description" content="Brier Skill Score + calibration + bootstrap CI95. Reference forecast = market mid-price at entry. Every grade published with its 95% confidence interval.">
<link rel="canonical" href="https://vigilscore.xyz/polymarket/methodology">
<style>
  body{background:#0c0c0c;color:#fff;font-family:'Inter',-apple-system,sans-serif;margin:0;padding:24px;line-height:1.7}
  .wrap{max-width:760px;margin:0 auto}
  h1{font-size:28px;font-weight:800;margin:0 0 8px;letter-spacing:-0.5px}
  h2{font-size:18px;font-weight:700;margin:32px 0 12px;color:#fff;border-bottom:1px solid #1e1e1e;padding-bottom:8px}
  p{color:#ccc;font-size:15px}
  code,pre{font-family:'JetBrains Mono','SF Mono',monospace;color:#eab308;background:#141414;padding:2px 6px;border-radius:2px;font-size:13px}
  pre{display:block;padding:14px;color:#e5e7eb;line-height:1.5;overflow-x:auto}
  .kicker{font-size:11px;color:#707070;letter-spacing:2.5px;text-transform:uppercase;margin-bottom:8px;font-weight:600}
  a{color:#3b82f6;text-decoration:none}a:hover{text-decoration:underline}
  .header{text-align:center;margin-bottom:24px}
  .brand{font-size:22px;font-weight:800;letter-spacing:3px;color:#fff;text-decoration:none}
  table{width:100%;border-collapse:collapse;margin:14px 0;font-size:14px}
  th,td{padding:8px 12px;border-bottom:1px solid #1e1e1e;text-align:left}
  th{color:#707070;font-size:11px;text-transform:uppercase;letter-spacing:1.5px}
  .callout{background:#141414;border:1px solid #1e1e1e;border-radius:2px;padding:14px;margin:14px 0;color:#e5e7eb;font-size:14px}
  .callout strong{color:#fff}
  .footer{text-align:center;margin-top:40px;color:#555;font-size:11px}
</style></head>
<body>
<div class="wrap">
  <div class="header"><a class="brand" href="/">VIGIL</a><div style="color:#707070;font-size:13px;margin-top:4px">Grading · Methodology</div></div>

  <div class="kicker">// what this grade means</div>
  <h1>How VIGIL grades a Polymarket trader.</h1>
  <p>Every wallet VIGIL scores gets a single letter (<code>A</code>–<code>F</code>) plus a 0–100 score, computed from six dimensions, penalized for red flags, and — critically — published alongside a bootstrap 95% confidence interval. If the CI spans more than one grade-width, or the sample is too thin to support a reliable estimate, the grade is reported as <code>INS</code> (Insufficient Data) rather than a letter.</p>

  <div class="callout"><strong>The honest version.</strong> A letter grade asserts certainty. A letter grade without a confidence interval is a marketing choice pretending to be statistics. We publish every grade with its CI95 so you can see when two traders are statistically distinguishable and when they aren't.</div>

  <h2>The six dimensions</h2>
  <table>
    <tr><th>Dimension</th><th>Weight</th><th>What it measures</th></tr>
    <tr><td><code>Calibration</code></td><td>25%</td><td>How closely stated probabilities match observed outcomes (Brier Skill Score + calibration error).</td></tr>
    <tr><td><code>Live Edge</code></td><td>20%</td><td>Unrealized PnL trajectory on open positions.</td></tr>
    <tr><td><code>Profitability</code></td><td>20%</td><td>Risk-adjusted realized PnL.</td></tr>
    <tr><td><code>Consistency</code></td><td>15%</td><td>Return stability — low coefficient of variation on per-bet returns.</td></tr>
    <tr><td><code>Discipline</code></td><td>10%</td><td>Position sizing, diversification, no concentration risk.</td></tr>
    <tr><td><code>Sample Size</code></td><td>10%</td><td>Resolved-bet count (logarithmic).</td></tr>
  </table>

  <h2>Calibration: Brier Skill Score</h2>
  <p>For each resolved bet, we compare the trader's revealed probability to the outcome:</p>
  <pre>Brier = (1/N) · Σ (impliedProb_i − outcome_i)²
BSS   = 1 − Brier / Brier_climatology
Brier_climatology = base_rate · (1 − base_rate)</pre>
  <p><code>BSS &gt; 0</code> means the trader beats a naive "always predict the base rate" forecaster. <code>BSS &lt; 0</code> means they're worse than doing nothing. We also decompose Brier into Reliability, Resolution, and Uncertainty (Murphy, 1973) to distinguish miscalibrated traders from traders who just bet near 50%.</p>

  <h2>Reference forecast</h2>
  <p>The reference probability against which we score each bet is <strong>the market mid-price at the trader's entry timestamp</strong>, not the final resolution price. Using resolution would be circular — the trader's own position moves the price. Using entry-time mid-price measures genuine forecasting skill relative to the crowd's available information at the moment of the bet.</p>

  <h2>Bootstrap CI95 on the score</h2>
  <p>We compute a 95% confidence interval on the composite trust score via non-parametric bootstrap:</p>
  <pre>1. For each wallet, extract per-bet squared errors e_i = (impliedProb_i − outcome_i)²
2. Resample {e_i} with replacement, N = n_bets, 1000 iterations
3. Recompute mean Brier on each resample
4. Project ΔBrier → ΔCalibrationDim → ΔScore using calibration-dim weight
5. Return 2.5 / 97.5 percentiles as scoreLow / scoreHigh
6. Map score band to grade band via standard grade thresholds</pre>
  <p>Other dimensions are held at point estimate — calibration is the largest variance driver and the one any critic will attack first.</p>

  <h2>The "Insufficient Data" rule</h2>
  <p>A wallet's grade is reported as <code>INS</code> (not a letter) when either:</p>
  <table>
    <tr><th>Trigger</th><th>Threshold</th><th>Why</th></tr>
    <tr><td>Sample too small</td><td><code>resolvedBets &lt; 30</code></td><td>Below n=30, bootstrap CI on Brier is wider than the grade-width; a letter misrepresents precision.</td></tr>
    <tr><td>CI spans grade</td><td><code>scoreHigh − scoreLow ≥ 20</code></td><td>One grade bucket is 15 points. A 20+ span means we can't distinguish D from B at 95%.</td></tr>
  </table>
  <p>This is a deliberate choice to bias toward honesty. Early VIGIL will show many <code>INS</code> wallets. That is correct.</p>

  <h2>Grade thresholds (point estimate)</h2>
  <table>
    <tr><th>Grade</th><th>Score</th><th>Tier</th></tr>
    <tr><td><code>A</code></td><td>80–100</td><td>SHARP — demonstrated calibration, positive BSS, profitable.</td></tr>
    <tr><td><code>B</code></td><td>65–79</td><td>SOLID — net positive skill.</td></tr>
    <tr><td><code>C</code></td><td>50–64</td><td>DEVELOPING — mixed signals.</td></tr>
    <tr><td><code>D</code></td><td>35–49</td><td>RISKY — below naïve baseline or heavy red flags.</td></tr>
    <tr><td><code>F</code></td><td>0–34</td><td>DANGER — net negative signal.</td></tr>
  </table>

  <h2>Penalties</h2>
  <p>Certain patterns deduct from the raw dimension score:</p>
  <ul style="color:#ccc;font-size:15px;line-height:1.7">
    <li><code>Penny-lottery</code>: wallets with ≥50% of bets at sub-$0.10 stakes get a 15pt penalty (or 25pt if ≥80% penny). Reduced to zero if BSS &gt; 0 — if the strategy works, it's not farming.</li>
    <li><code>Receive-only</code>: zero-outbound wallets are lightly flagged (5pt). Many Polymarket proxy/settlement addresses are legitimate.</li>
    <li><code>Penny + Receive-only + BSS &lt; 0</code>: hard-capped at D (49). Only applies when all three conditions hold.</li>
  </ul>

  <h2>What grades are NOT</h2>
  <p>A VIGIL grade is <strong>not</strong>:</p>
  <ul style="color:#ccc;font-size:15px;line-height:1.7">
    <li>A prediction of future performance. Past calibration is historical, not predictive.</li>
    <li>Investment advice. Do not copy-trade an A-grade wallet without understanding why they took the position.</li>
    <li>A legal or compliance determination. Wallets are pseudonymous; we score behavior, not identity.</li>
    <li>Static. Grades update every scoring cycle as new resolved markets flow in.</li>
  </ul>

  <h2>Opt-out</h2>
  <p>If you are a Polymarket trader and do not want your wallet graded publicly, email <code>api@vigilscore.xyz</code> with a signed message from the wallet. We'll exclude it from public display (aggregate anonymized stats may still include it).</p>

  <h2>Reproducibility</h2>
  <p>Scoring code is deterministic given the same input data. The commit hash of the running version is published at <code>/v1/health</code>. Every score response includes a <code>scoredAt</code> timestamp so you can re-run the same wallet later and see what changed.</p>

  <h2>Get the JSON</h2>
  <pre>GET /v1/polymarket/:wallet</pre>
  <p>Response includes <code>trustScore</code>, <code>trustGrade</code>, full <code>calibrationReport</code>, and the bootstrap <code>confidence.ci95</code> block with <code>{scoreLow, scoreHigh, gradeLow, gradeHigh, insufficientData}</code>.</p>

  <h2>Known limitations</h2>
  <p>Polymarket's data-api has a ~3100 trade pagination ceiling per wallet. For very high-volume wallets we sample rather than exhaust. Resolution timestamps are inferred from market close dates — for future versions we'll cross-reference the CLOB log for exact entry time.</p>
  <p>We do not currently detect wash-trading within a wallet's own history. Sybil clustering across wallets is in v1.23.</p>

  <div class="footer">
    <a href="/" style="color:#707070">← Back to VIGIL</a> ·
    <a href="/polymarket/leaderboard" style="color:#707070">Skill Leaderboard</a> ·
    <a href="/polymarket/consensus/methodology" style="color:#707070">Consensus Methodology</a> ·
    <a href="https://github.com/vigil-trust" style="color:#707070">Code</a>
  </div>
</div>
</body></html>`;
}

function consensusPage(r: import('./lib/consensus.js').SkillConsensus): string {
  const marketP = r.impliedMarketP;
  const consP = r.consensusP;
  const div = r.divergence;
  const divAbs = Math.abs(div);
  const divPct = (divAbs * 100).toFixed(1);

  // Divergence color coding
  const divColor = r.divergenceDirection === 'aligned'
    ? '#707070'
    : divAbs > 0.15 ? '#ef4444'
    : divAbs > 0.07 ? '#f97316'
    : '#eab308';

  const divLabel = r.divergenceDirection === 'aligned' ? 'ALIGNED'
    : r.divergenceDirection === 'market_overpriced' ? 'MARKET OVERPRICED'
    : r.divergenceDirection === 'market_underpriced' ? 'MARKET UNDERPRICED'
    : 'NO MARKET PRICE';

  const qualityLabel = { strong: 'STRONG', moderate: 'MODERATE', weak: 'WEAK', insufficient: 'INSUFFICIENT' }[r.dataQuality] ?? 'UNKNOWN';
  const qualityColor = r.dataQuality === 'strong' ? '#10b981' : r.dataQuality === 'moderate' ? '#eab308' : '#f97316';

  // Grade breakdown bars
  const gradeOrder: Array<'A' | 'B' | 'C' | 'D' | 'F'> = ['A', 'B', 'C', 'D', 'F'];
  const gradeColor: Record<string, string> = { A: '#10b981', B: '#3b82f6', C: '#eab308', D: '#f97316', F: '#ef4444' };
  const gradeBars = gradeOrder.map(g => {
    const n = (r.contributingWallets as any)[g] || 0;
    if (n === 0) return '';
    const pct = Math.round((n / r.contributingWallets.total) * 100);
    return `<div style="display:flex;align-items:center;gap:12px;margin-bottom:6px"><div style="width:24px;height:24px;border-radius:2px;background:${gradeColor[g]}20;color:${gradeColor[g]};font-weight:700;font-family:'JetBrains Mono',monospace;display:flex;align-items:center;justify-content:center;font-size:13px">${g}</div><div style="flex:1;background:#1e1e1e;border-radius:2px;height:10px;overflow:hidden"><div style="width:${pct}%;height:100%;background:${gradeColor[g]}"></div></div><div style="width:60px;text-align:right;font-size:13px;color:#999">${n} <span style="color:#555">wallet${n === 1 ? '' : 's'}</span></div></div>`;
  }).join('');

  // Top contributors table
  const contribRows = r.topContributors.map(c => {
    const gc = gradeColor[c.grade] || '#999';
    const impliedPct = (c.impliedPYes * 100).toFixed(1);
    const stake = c.initialValue >= 1000 ? `$${Math.round(c.initialValue / 1000)}K` : `$${Math.round(c.initialValue)}`;
    const side = c.outcome === 'Yes' ? '#10b981' : '#ef4444';
    return `<tr style="border-top:1px solid #1e1e1e"><td style="padding:10px 12px"><a href="/polymarket/${c.wallet}" style="color:#fff;text-decoration:none;font-weight:600">${hEsc(c.displayName || c.wallet.slice(0, 10) + '…')}</a></td><td style="padding:10px 12px"><span style="display:inline-block;padding:2px 6px;border-radius:2px;background:${gc}20;color:${gc};font-family:'JetBrains Mono',monospace;font-size:12px;font-weight:700">${c.grade}/${c.trustScore}</span></td><td style="padding:10px 12px;color:${side};font-weight:600;font-size:13px">${c.outcome}</td><td style="padding:10px 12px;color:#fff;font-weight:700;font-family:'JetBrains Mono',monospace">${impliedPct}%</td><td style="padding:10px 12px;color:#999;font-size:13px">${stake}</td></tr>`;
  }).join('');

  const notesHtml = r.notes.length === 0 ? '' :
    `<div style="margin-top:20px;padding:12px 16px;background:#0a0a0a;border:1px solid #1e1e1e;border-radius:2px"><div style="font-size:10px;color:#707070;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:6px">// notes</div><ul style="margin:0;padding-left:20px;color:#999;font-size:13px;line-height:1.6">${r.notes.map(n => `<li>${hEsc(n)}</li>`).join('')}</ul></div>`;

  const marketPriceBlock = marketP == null
    ? `<div style="font-size:13px;color:#555">Market price unavailable</div>`
    : `<div style="font-size:42px;font-weight:800;color:#fff;font-family:'JetBrains Mono',monospace;letter-spacing:-1px">${(marketP * 100).toFixed(1)}%</div>`;

  const tweetText = marketP == null
    ? `Graded Polymarket wallets' weighted probability on "${r.marketTitle}" is ${(consP * 100).toFixed(1)}%. See the divergence at`
    : r.divergenceDirection === 'aligned'
      ? `Polymarket and graded wallets agree on "${r.marketTitle}" — both ~${(consP * 100).toFixed(1)}%.`
      : `Polymarket market says ${(marketP * 100).toFixed(1)}%. ${r.contributingWallets.total} graded wallets say ${(consP * 100).toFixed(1)}%. Divergence: ${divPct}pp.`;
  const tweetUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(tweetText)}&url=${encodeURIComponent('https://vigilscore.xyz/polymarket/markets/' + r.marketId + '/consensus')}`;

  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>VIGIL Consensus — ${hEsc(r.marketTitle || r.marketId.slice(0, 10))}</title>
<meta name="description" content="Skill-weighted consensus probability from ${r.contributingWallets.total} graded Polymarket wallets. Current divergence: ${divPct}pp.">
<meta property="og:title" content="VIGIL Consensus: ${hEsc(r.marketTitle || 'Polymarket')}">
<meta property="og:description" content="Market: ${marketP != null ? (marketP * 100).toFixed(1) + '%' : '—'} · Skilled money: ${(consP * 100).toFixed(1)}% · Divergence: ${divPct}pp across ${r.contributingWallets.total} graded wallets.">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<link rel="canonical" href="https://vigilscore.xyz/polymarket/markets/${r.marketId}/consensus">
<style>
  *{box-sizing:border-box}
  body{background:#0c0c0c;color:#fff;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;margin:0;padding:24px;line-height:1.6}
  .wrap{max-width:920px;margin:0 auto}
  .kicker{font-size:11px;color:#707070;letter-spacing:2.5px;text-transform:uppercase;margin-bottom:8px;font-weight:600}
  .header{text-align:center;margin-bottom:32px}
  .header a.brand{font-size:22px;font-weight:800;letter-spacing:3px;color:#fff;text-decoration:none}
  .header .sub{color:#707070;font-size:13px;margin-top:4px}
  .card{background:#141414;border:1px solid #1e1e1e;border-radius:2px;padding:24px}
  .title{font-size:22px;font-weight:700;line-height:1.35;margin:0 0 6px}
  .slug{font-family:'JetBrains Mono','SF Mono',monospace;color:#555;font-size:12px}
  .pricerow{display:grid;grid-template-columns:1fr auto 1fr;gap:20px;align-items:center;margin:32px 0}
  .pricecol{text-align:center}
  .pricecol .label{font-size:11px;color:#707070;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:10px;font-weight:600}
  .pricecol .value{font-size:42px;font-weight:800;color:#fff;font-family:'JetBrains Mono','SF Mono',monospace;letter-spacing:-1px}
  .ci{color:#707070;font-size:12px;margin-top:4px;font-family:'JetBrains Mono',monospace}
  .divarrow{font-size:32px;color:#333}
  .divbadge{display:inline-block;padding:12px 18px;border-radius:2px;font-weight:800;letter-spacing:2px;font-size:12px;border:1px solid}
  .divnum{font-size:26px;font-family:'JetBrains Mono',monospace;font-weight:800;margin-top:8px}
  .tag{display:inline-block;padding:4px 10px;border-radius:2px;font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;margin-left:8px}
  .meta-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin-top:24px}
  .mcell{background:#0a0a0a;border:1px solid #1e1e1e;border-radius:2px;padding:14px}
  .mcell .label{font-size:10px;color:#707070;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:6px}
  .mcell .value{font-size:18px;font-weight:700;font-family:'JetBrains Mono',monospace}
  table{width:100%;border-collapse:collapse;margin-top:12px;font-size:14px}
  th{text-align:left;padding:8px 12px;color:#707070;font-size:10px;letter-spacing:1.5px;text-transform:uppercase;border-bottom:1px solid #1e1e1e}
  .share{text-align:center;margin:32px 0 12px}
  .btn{display:inline-block;background:#1f2937;color:#fff;text-decoration:none;padding:12px 20px;border-radius:2px;font-weight:600;font-size:14px;border:1px solid #374151}
  .btn:hover{background:#374151}
  .btn.primary{background:#fff;color:#0c0c0c;border-color:#fff}
  .footer{text-align:center;margin-top:40px;color:#444;font-size:11px}
  .footer a{color:#707070;text-decoration:none;margin:0 8px}
  .footer a:hover{color:#fff}
  @media (max-width:640px){
    .pricerow{grid-template-columns:1fr;gap:12px}
    .divarrow{transform:rotate(90deg)}
  }
</style></head>
<body>
<div class="wrap">
  <div class="header">
    <a class="brand" href="/">VIGIL</a>
    <div class="sub">Skill-Weighted Consensus · Polymarket</div>
  </div>

  <div class="card">
    <div class="kicker">// market</div>
    <div class="title">${hEsc(r.marketTitle || 'Unnamed market')}</div>
    ${r.marketSlug ? `<div class="slug">${hEsc(r.marketSlug)}</div>` : ''}

    <div class="pricerow">
      <div class="pricecol">
        <div class="label">Market Price (Yes)</div>
        ${marketPriceBlock}
      </div>
      <div class="divarrow">→</div>
      <div class="pricecol">
        <div class="label">Skilled Money (Yes)</div>
        <div class="value" style="color:${divColor}">${(consP * 100).toFixed(1)}%</div>
        <div class="ci">95% CI: ${(r.ci95.low * 100).toFixed(1)}% – ${(r.ci95.high * 100).toFixed(1)}%</div>
      </div>
    </div>

    <div style="text-align:center;margin-top:8px;padding:20px;border-top:1px solid #1e1e1e">
      <div class="divbadge" style="color:${divColor};border-color:${divColor}40;background:${divColor}15">${divLabel}</div>
      ${marketP != null ? `<div class="divnum" style="color:${divColor}">Δ ${div >= 0 ? '+' : '−'}${divPct} pp</div>` : ''}
      <div style="color:#707070;font-size:12px;margin-top:6px">${r.contributingWallets.total} graded wallets · effective sample ${r.effectiveSampleSize.toFixed(2)} <span class="tag" style="background:${qualityColor}15;color:${qualityColor};border:1px solid ${qualityColor}40">${qualityLabel}</span></div>
    </div>

    <div class="meta-grid">
      <div class="mcell"><div class="label">Total Skilled Stake</div><div class="value">$${Math.round(r.totalSkillStake).toLocaleString()}</div></div>
      <div class="mcell"><div class="label">A-grade Wallets</div><div class="value" style="color:${gradeColor.A}">${r.contributingWallets.A}</div></div>
      <div class="mcell"><div class="label">B-grade Wallets</div><div class="value" style="color:${gradeColor.B}">${r.contributingWallets.B}</div></div>
      <div class="mcell"><div class="label">As Of</div><div class="value" style="font-size:12px">${new Date(r.asOf).toUTCString().slice(5, 22)}</div></div>
    </div>
  </div>

  <div class="card" style="margin-top:20px">
    <div class="kicker">// grade breakdown</div>
    <div style="margin-top:12px">${gradeBars || '<div style="color:#555">No contributors.</div>'}</div>
    ${notesHtml}
  </div>

  <div class="card" style="margin-top:20px">
    <div class="kicker">// top contributors (by weight)</div>
    <table>
      <thead><tr><th>Wallet</th><th>Grade</th><th>Side</th><th>Implied P(Yes)</th><th>Stake</th></tr></thead>
      <tbody>${contribRows}</tbody>
    </table>
    <div style="margin-top:12px;color:#555;font-size:12px">Weight = grade × √(stake) × exp(−days/30). Implied P(Yes) is the trader's revealed probability (avgPrice, inverted for No-holders).</div>
  </div>

  <div class="share">
    <a class="btn primary" href="${tweetUrl}" target="_blank" rel="noopener">Share on X</a>
    <a class="btn" href="/polymarket/consensus/methodology">Methodology →</a>
    <a class="btn" href="/polymarket/leaderboard">Skill Leaderboard →</a>
  </div>

  <div class="footer">
    VIGIL Consensus is informational. Not financial advice.
    <br>
    <a href="/">Home</a> · <a href="/v1/polymarket/markets/${r.marketId}/skill-consensus">JSON</a> · <a href="/polymarket/consensus/methodology">Methodology</a>
  </div>
</div>
</body></html>`;
}

// ============================================================
//  DIVERGENCE LEADERBOARD (v1.22.0)
//  Across the top-volume active Polymarket markets, rank the ones where
//  skill-weighted consensus diverges most from the market's implied price.
//  This is the "where does the sharp money disagree with the crowd" view.
// ============================================================

/**
 * GET /v1/polymarket/divergence
 *   ?limit=<n>     (default 10, max 25)
 *   ?scan=<n>      (default 40, max 100) — how many top-volume markets to scan
 *
 * Returns the ranked list of markets where the skill-weighted consensus
 * probability diverges most from the current market-implied probability.
 * Only surfaces markets that pass the consensus gates (≥5 wallets,
 * effective sample ≥ 0.5, market price available).
 */
app.get('/v1/polymarket/divergence', async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(25, parseInt(String(req.query.limit || '10'), 10) || 10));
    const scan = Math.max(10, Math.min(100, parseInt(String(req.query.scan || '40'), 10) || 40));
    const leaderboard = await computeDivergenceLeaderboard(limit, scan);
    return res.json(leaderboard);
  } catch (err) {
    return res.status(502).json({ error: 'DIVERGENCE_UPSTREAM_ERROR', message: (err as Error).message });
  }
});

/**
 * HTML: /polymarket/divergence
 * Public-facing divergence leaderboard. Every row links to the market's
 * full consensus page. Header explains the gates. Footer carries the
 * not-a-trade-signal disclaimer.
 */
app.get('/polymarket/divergence', async (_req, res) => {
  try {
    const leaderboard = await computeDivergenceLeaderboard(10, 40);
    return res.type('html').send(divergencePage(leaderboard));
  } catch (err) {
    return res.status(502).type('html').send(errorPage((err as Error).message));
  }
});

function divergencePage(lb: DivergenceLeaderboard): string {
  const rowsHtml = lb.rows.length === 0
    ? `<tr><td colspan="6" style="padding:40px;text-align:center;color:#707070">
        No qualifying markets right now. Each row needs ≥5 graded wallets holding positions, effective sample ≥ 0.5, and a live market price.
       </td></tr>`
    : lb.rows.map((r, i) => divergenceRowHtml(r, i + 1)).join('');

  const topDelta = lb.rows[0] ? (lb.rows[0].divergenceAbs * 100).toFixed(1) + 'pp' : '—';

  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>VIGIL Divergence — Where the Sharp Money Disagrees with Polymarket</title>
<meta name="description" content="Live leaderboard of Polymarket markets where skill-weighted consensus (graded wallets only) diverges most from the market price. Top Δ right now: ${topDelta}.">
<meta property="og:title" content="VIGIL Divergence — Where the Sharp Money Disagrees">
<meta property="og:description" content="Polymarket markets ranked by |consensus − market| across ${lb.scanned} scanned, ${lb.qualified} qualified. Top divergence: ${topDelta}.">
<meta property="og:type" content="website">
<meta property="og:url" content="https://vigilscore.xyz/polymarket/divergence">
<meta property="og:image" content="https://vigilscore.xyz/static/og/vigil-og.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="canonical" href="https://vigilscore.xyz/polymarket/divergence">
<style>
  *{box-sizing:border-box}
  body{background:#0c0c0c;color:#fff;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;margin:0;padding:24px;line-height:1.6}
  .wrap{max-width:1080px;margin:0 auto}
  .header{text-align:center;margin-bottom:32px}
  .header a.brand{font-size:22px;font-weight:800;letter-spacing:3px;color:#fff;text-decoration:none}
  .header .sub{color:#707070;font-size:13px;margin-top:4px}
  .kicker{font-size:11px;color:#707070;letter-spacing:2.5px;text-transform:uppercase;margin-bottom:8px;font-weight:600}
  h1{font-size:28px;font-weight:800;margin:0 0 8px;letter-spacing:-0.5px}
  .card{background:#141414;border:1px solid #1e1e1e;border-radius:2px;padding:24px;margin-bottom:20px}
  p{color:#ccc;font-size:14px;margin:0 0 10px}
  .metabar{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin:20px 0 8px}
  .mcell{background:#0a0a0a;border:1px solid #1e1e1e;border-radius:2px;padding:14px}
  .mcell .label{font-size:10px;color:#707070;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:6px}
  .mcell .value{font-size:20px;font-weight:700;font-family:'JetBrains Mono','SF Mono',monospace}
  table{width:100%;border-collapse:collapse;font-size:14px;margin-top:12px}
  th{text-align:left;padding:10px 12px;color:#707070;font-size:10px;letter-spacing:1.5px;text-transform:uppercase;border-bottom:1px solid #1e1e1e;background:#0a0a0a}
  td{padding:12px;border-bottom:1px solid #1e1e1e;vertical-align:top}
  tr:hover td{background:#181818}
  .rank{color:#555;font-family:'JetBrains Mono',monospace;font-size:13px;font-weight:700;width:32px;text-align:right}
  .market{color:#fff;text-decoration:none;font-weight:600}
  .market:hover{color:#3b82f6}
  .pricecell{font-family:'JetBrains Mono',monospace;font-weight:700;font-size:15px;white-space:nowrap}
  .ci{color:#555;font-size:11px;font-family:'JetBrains Mono',monospace;margin-top:2px}
  .deltacell{font-family:'JetBrains Mono',monospace;font-weight:800;font-size:16px;white-space:nowrap}
  .tag{display:inline-block;padding:2px 8px;border-radius:2px;font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;border:1px solid}
  .sampletag{color:#707070;font-size:11px;font-family:'JetBrains Mono',monospace}
  .disclaimer{background:#0a0a0a;border:1px solid #b45309;border-radius:2px;padding:14px 18px;color:#fbbf24;font-size:13px;line-height:1.5;margin:20px 0}
  .disclaimer strong{color:#fff}
  .footer{text-align:center;margin-top:40px;color:#444;font-size:11px}
  .footer a{color:#707070;text-decoration:none;margin:0 8px}
  .footer a:hover{color:#fff}
  @media (max-width:640px){
    th.hide-sm, td.hide-sm{display:none}
    .wrap{padding:0}
  }
</style></head>
<body>
<div class="wrap">
  <div class="header">
    <a class="brand" href="/">VIGIL</a>
    <div class="sub">Divergence Leaderboard · Polymarket</div>
  </div>

  <div class="card">
    <div class="kicker">// live divergence leaderboard</div>
    <h1>Where the sharp money disagrees with the crowd.</h1>
    <p>
      Every row is an active Polymarket market where the <strong>skill-weighted consensus</strong> (graded wallets only,
      weighted by grade × √stake × exp(−days/30)) diverges from the current market-implied price. Ranked by |Δ|.
      Each row links to the full consensus page with every contributing wallet.
    </p>

    <div class="disclaimer">
      <strong>Not a trade signal.</strong> Divergence is a <em>measurement</em> — the gap between what well-calibrated
      forecasters reveal through their positions and what the market is pricing. Skilled traders are wrong ~5% of the
      time inside their 95% CI by construction. New information moves the market before it moves consensus. Read the
      <a href="/polymarket/consensus/methodology" style="color:#fbbf24;text-decoration:underline">methodology</a> before acting on anything here.
    </div>

    <div class="metabar">
      <div class="mcell"><div class="label">Scanned</div><div class="value">${lb.scanned}</div></div>
      <div class="mcell"><div class="label">Qualified</div><div class="value">${lb.qualified}</div></div>
      <div class="mcell"><div class="label">Top Δ</div><div class="value" style="color:#ef4444">${topDelta}</div></div>
      <div class="mcell"><div class="label">As Of (UTC)</div><div class="value" style="font-size:14px">${new Date(lb.asOf).toUTCString().slice(5, 22)}</div></div>
    </div>
  </div>

  <div class="card" style="padding:0;overflow:hidden">
    <table>
      <thead>
        <tr>
          <th class="rank">#</th>
          <th>Market</th>
          <th>Crowd</th>
          <th>Skilled Money</th>
          <th>Δ</th>
          <th class="hide-sm">Sample</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  </div>

  <div class="card">
    <div class="kicker">// gates</div>
    <p style="color:#999">
      A market only qualifies for this ranking if at least <strong>5 graded wallets</strong> hold positions in it,
      the <strong>effective sample size ≥ 0.5</strong> (Σ of grade × decay weights — roughly half an A-grade wallet's
      worth of signal), and the market price is live. Below those thresholds we refuse to publish a number —
      noise is worse than silence. Data refreshes every 5 minutes.
    </p>
  </div>

  <div class="footer">
    VIGIL is informational. Not financial advice. Not a registered broker-dealer or investment adviser.
    <br>
    <a href="/">Home</a> · <a href="/polymarket/leaderboard">Skill Leaderboard</a> · <a href="/polymarket/consensus/methodology">Consensus Methodology</a> · <a href="/polymarket/methodology">Grading Methodology</a> · <a href="/v1/polymarket/divergence">JSON</a>
  </div>
</div>
</body></html>`;
}

function divergenceRowHtml(r: DivergenceRow, rank: number): string {
  const marketPct = r.impliedMarketP == null ? '—' : (r.impliedMarketP * 100).toFixed(1) + '%';
  const consPct = (r.consensusP * 100).toFixed(1) + '%';
  const deltaPct = (r.divergenceAbs * 100).toFixed(1);
  const signedDelta = (r.divergence >= 0 ? '+' : '−') + deltaPct + 'pp';

  const divColor = r.divergenceAbs > 0.15 ? '#ef4444' : r.divergenceAbs > 0.07 ? '#f97316' : '#eab308';
  const dirLabel = r.divergenceDirection === 'market_overpriced' ? 'OVERPRICED'
    : r.divergenceDirection === 'market_underpriced' ? 'UNDERPRICED'
    : 'ALIGNED';

  const qualityLabel = { strong: 'STRONG', moderate: 'MODERATE', weak: 'WEAK', insufficient: 'INSUFFICIENT' }[r.dataQuality] || 'UNKNOWN';
  const qualityColor = r.dataQuality === 'strong' ? '#10b981' : r.dataQuality === 'moderate' ? '#eab308' : '#f97316';

  const title = r.marketTitle || r.marketSlug || r.marketId.slice(0, 12) + '…';
  const href = `/polymarket/markets/${r.marketId}/consensus`;

  return `<tr>
    <td class="rank">${rank}</td>
    <td><a class="market" href="${href}">${hEsc(title)}</a></td>
    <td class="pricecell" style="color:#999">${marketPct}</td>
    <td class="pricecell" style="color:${divColor}">${consPct}<div class="ci">CI ${(r.ci95.low * 100).toFixed(1)}–${(r.ci95.high * 100).toFixed(1)}</div></td>
    <td class="deltacell" style="color:${divColor}">${signedDelta}<div style="margin-top:4px"><span class="tag" style="color:${divColor};border-color:${divColor}40;background:${divColor}15">${dirLabel}</span></div></td>
    <td class="hide-sm sampletag">${r.contributingWallets}w · es ${r.effectiveSampleSize.toFixed(1)}<div style="margin-top:4px"><span class="tag" style="color:${qualityColor};border-color:${qualityColor}40;background:${qualityColor}15">${qualityLabel}</span></div></td>
  </tr>`;
}

// ============================================================
//  WALLET DISCOVERY & SKILL LEADERBOARD (v1.18.0)
//  Crawl resolved markets, discover skilled wallets, surface A/B grades
// ============================================================

// JSON: Skill-based leaderboard — top wallets ranked by actual forecasting ability
app.get('/v1/polymarket/leaderboard/skill', (_req, res) => {
  const leaderboard = getSkillLeaderboard();
  const status = getCrawlerStatus();

  if (leaderboard.length === 0) {
    return res.json({
      status: 'empty',
      message: status.lastCrawl
        ? 'Leaderboard was built but no qualified wallets found yet. Try again later.'
        : 'Leaderboard not yet built. Trigger a crawl via POST /v1/polymarket/discover/crawl or wait for the next scheduled run.',
      crawlerStatus: status,
      entries: [],
    });
  }

  // Grade distribution
  const grades: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, F: 0 };
  for (const e of leaderboard) grades[e.trustGrade] = (grades[e.trustGrade] || 0) + 1;

  res.json({
    status: 'ok',
    total: leaderboard.length,
    gradeDistribution: grades,
    lastCrawl: status.lastCrawl,
    entries: leaderboard,
  });
});

// JSON: Crawler status
app.get('/v1/polymarket/discover/status', (_req, res) => {
  res.json(getCrawlerStatus());
});

// Trigger a discovery crawl (POST to avoid accidental triggers)
app.post('/v1/polymarket/discover/crawl', async (req, res) => {
  const status = getCrawlerStatus();
  if (status.crawlInProgress) {
    return res.json({ status: 'already_running', ...status });
  }

  // Parse optional params
  const maxMarkets = Math.min(Number(req.query.maxMarkets) || 100, 500);
  const minVolume = Number(req.query.minVolume) || 50000;
  const maxToScore = Math.min(Number(req.query.maxToScore) || 200, 500);

  // Start crawl in background — return immediately
  res.json({
    status: 'started',
    message: `Crawling up to ${maxMarkets} resolved markets, will score up to ${maxToScore} wallets. Check /v1/polymarket/discover/status for progress.`,
    params: { maxMarkets, minVolume, maxToScore },
  });

  // Fire and forget — the crawl updates the in-memory leaderboard
  runDiscoveryCrawl({ maxMarkets, minVolume, maxToScore }).then(result => {
    console.log(`[VIGIL] Discovery crawl finished:`, result);
  }).catch(err => {
    console.error(`[VIGIL] Discovery crawl failed:`, err);
  });
});

// HTML: Skill Leaderboard page
app.get('/polymarket/leaderboard', (_req, res) => {
  const leaderboard = getSkillLeaderboard();
  const status = getCrawlerStatus();

  const gradeColor = (g: string) => {
    switch (g) {
      case 'A': return '#10b981';
      case 'B': return '#3b82f6';
      case 'C': return '#f59e0b';
      case 'D': return '#ef4444';
      default: return '#555';
    }
  };

  let rows = '';
  if (leaderboard.length === 0) {
    rows = `<tr><td colspan="7" style="text-align:center;padding:48px;color:#707070">
      <div style="font-size:14px;font-weight:700;color:#fff;margin-bottom:8px">Leaderboard is loading</div>
      <div style="font-size:13px;color:#555;max-width:400px;margin:0 auto">The discovery crawler builds this leaderboard from resolved Polymarket markets. It takes about 2 minutes after a deploy. Score any wallet now using the search above.</div>
    </td></tr>`;
  } else {
    rows = leaderboard.slice(0, 100).map((e, i) => {
      const gc = gradeColor(e.trustGrade);
      const pnl = e.realizedPnl >= 0
        ? `<span style="color:#10b981">+$${Math.round(e.realizedPnl).toLocaleString()}</span>`
        : `<span style="color:#ef4444">-$${Math.round(Math.abs(e.realizedPnl)).toLocaleString()}</span>`;
      const bssRaw = e.brierSkillScore * 100;
      const bssCapped = Math.max(-999, Math.min(999, bssRaw));
      const bss = bssRaw >= 0
        ? `<span style="color:#10b981">+${bssCapped.toFixed(0)}%</span>`
        : `<span style="color:#ef4444">${bssCapped.toFixed(0)}%</span>`;
      const name = e.displayName.length > 20 ? e.displayName.slice(0, 18) + '...' : e.displayName;
      const rowBg = i % 2 === 0 ? '' : 'background:#12121266;';
      return `<tr style="border-bottom:1px solid #1e1e1e;${rowBg}transition:background .15s" onmouseover="this.style.background='#1a1a1a66'" onmouseout="this.style.background='${i % 2 === 0 ? '' : '#12121266'}'">
        <td style="padding:10px 8px;color:#555">${i + 1}</td>
        <td style="padding:10px 8px"><a href="/polymarket/${e.wallet}" style="color:#00d4aa;text-decoration:none;font-weight:600">${pmEscape(name)}</a></td>
        <td style="padding:10px 8px;text-align:center"><span style="color:${gc};font-weight:700;font-size:15px">${e.trustGrade}/${e.trustScore}</span></td>
        <td style="padding:10px 8px;text-align:center">${bss}</td>
        <td style="padding:10px 8px;text-align:center;color:#e8e8e8">${(e.calibrationError * 100).toFixed(1)}%</td>
        <td style="padding:10px 8px;text-align:center;color:#e8e8e8">${e.resolvedBets}</td>
        <td style="padding:10px 8px;text-align:right">${pnl}</td>
      </tr>`;
    }).join('');
  }

  res.type('html').send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VIGIL — Geopolitics Skill Leaderboard</title>
<meta name="description" content="The top Polymarket forecasters on geopolitics markets — Iran, Hormuz, elections, tail-risk. Ranked by Brier Skill Score, calibration, and bootstrap CI95. Not by PnL.">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&family=JetBrains+Mono:wght@400;600;700;800&display=swap" rel="stylesheet"></head>
  <body style="background:#0c0c0c;color:#fff;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;margin:0;padding:24px">
    <div style="max-width:900px;margin:0 auto">
      <div style="text-align:center;margin-bottom:24px">
        <a href="/" style="font-size:18px;font-weight:800;letter-spacing:4px;color:#fff;text-decoration:none;font-family:'JetBrains Mono','SF Mono',monospace">VIGIL</a>
        <span style="color:#555;font-size:11px;margin-left:12px;letter-spacing:2px;text-transform:uppercase">Geopolitics Skill Leaderboard</span>
      </div>
      <div style="max-width:640px;margin:0 auto 12px auto;padding:14px 16px;background:#0a1a14;border:1px solid #10b98130;border-radius:2px;text-align:center;font-size:12px;color:#10b981;font-family:'JetBrains Mono',monospace;letter-spacing:0.5px">
        LIVE: Iran peace deal · Strait of Hormuz · Global election markets — $47M+ weekly volume
      </div>
      <p style="text-align:center;color:#707070;font-size:14px;margin-bottom:20px">
        Wallets ranked by actual forecasting skill — Brier Skill Score, calibration, bootstrap CI95 — not PnL. Geopolitics is 47% of Polymarket volume; the loudest traders are rarely the most right.
        ${status.lastCrawl ? `<br><span style="color:#333;font-size:11px">Last updated: ${new Date(status.lastCrawl).toUTCString()} · ${status.discoveredWallets.toLocaleString()} wallets scanned</span>` : ''}
      </p>

      <div style="max-width:480px;margin:0 auto 28px auto;text-align:center">
        <form onsubmit="var w=document.getElementById('lb-wallet').value.trim();if(!w)return false;window.location.href='/polymarket/'+encodeURIComponent(w);return false" style="display:flex;gap:8px">
          <input id="lb-wallet" type="text" placeholder="Score any wallet — paste 0x address or username" style="flex:1;background:#0f0f0f;border:1px solid #2a2a2a;border-radius:2px;padding:10px 14px;color:#fff;font-size:13px;outline:none;font-family:'JetBrains Mono','SF Mono',monospace" />
          <button type="submit" style="background:transparent;color:#00d4aa;border:1px solid #00d4aa;border-radius:2px;padding:10px 20px;font-weight:700;font-size:11px;cursor:pointer;white-space:nowrap;letter-spacing:2px;text-transform:uppercase;font-family:'JetBrains Mono','SF Mono',monospace">Score</button>
        </form>
        <div style="margin-top:8px;font-size:11px;color:#333">Not on the leaderboard? Check any Polymarket wallet instantly.</div>
      </div>

      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead>
          <tr style="border-bottom:2px solid #1e1e1e;color:#555;text-transform:uppercase;font-size:11px;letter-spacing:1px">
            <th style="padding:8px;text-align:left">#</th>
            <th style="padding:8px;text-align:left">Trader</th>
            <th style="padding:8px;text-align:center">Grade</th>
            <th style="padding:8px;text-align:center">BSS</th>
            <th style="padding:8px;text-align:center">Cal Error</th>
            <th style="padding:8px;text-align:center">Resolved</th>
            <th style="padding:8px;text-align:right">PnL</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <div style="text-align:center;margin-top:24px;color:#333;font-size:11px">
        VIGIL Trust Score is informational only — not investment advice.<br>
        <a href="/methodology" style="color:#444;text-decoration:none">Methodology</a> ·
        <a href="/v1/polymarket/leaderboard/skill" style="color:#444;text-decoration:none">JSON API</a>
      </div>
    </div>
  </body></html>`);
});

// ============================================================
//  ON-CHAIN VERIFICATION ENDPOINTS (v1.11.0)
// ============================================================

// JSON: wallet provenance report from Basescan
app.get('/v1/onchain/:wallet', async (req, res) => {
  try {
    if (!isBasescanConfigured()) {
      return res.status(503).json({ error: 'BASESCAN_NOT_CONFIGURED', message: 'BASESCAN_API_KEY env var not set.' });
    }
    const wallet = String(req.params.wallet || '').trim();
    if (!wallet || !wallet.startsWith('0x')) {
      return res.status(400).json({ error: 'INVALID_WALLET', message: 'Provide a valid 0x wallet address.' });
    }
    const provenance = await getWalletProvenance(wallet);
    if (!provenance) {
      return res.status(502).json({ error: 'BASESCAN_ERROR', message: 'Failed to fetch on-chain data.' });
    }
    return res.json(provenance);
  } catch (err) {
    return res.status(502).json({ error: 'BASESCAN_ERROR', message: (err as Error).message });
  }
});

// JSON: quick sybil check
app.get('/v1/onchain/:wallet/sybil', async (req, res) => {
  try {
    if (!isBasescanConfigured()) {
      return res.status(503).json({ error: 'BASESCAN_NOT_CONFIGURED', message: 'BASESCAN_API_KEY env var not set.' });
    }
    const wallet = String(req.params.wallet || '').trim();
    if (!wallet || !wallet.startsWith('0x')) {
      return res.status(400).json({ error: 'INVALID_WALLET', message: 'Provide a valid 0x wallet address.' });
    }
    const result = await quickSybilCheck(wallet);
    if (!result) {
      return res.status(502).json({ error: 'BASESCAN_ERROR', message: 'Failed to check wallet.' });
    }
    return res.json(result);
  } catch (err) {
    return res.status(502).json({ error: 'BASESCAN_ERROR', message: (err as Error).message });
  }
});

// JSON: system status for on-chain layer
app.get('/v1/onchain/status', (_req, res) => {
  res.json({
    configured: isBasescanConfigured(),
    chain: 'Base (8453)',
    capabilities: [
      'wallet-provenance',
      'sybil-detection',
      'pnl-verification',
      'protocol-fingerprinting',
    ],
    apiVersion: 'etherscan-v2',
  });
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
    { label: 'Live Edge', val: (r as any).liveEdge ?? 50 },
  ];

  const greenFlagsHtml = r.greenFlags.map(f => `<div class="signal green">\u2713 ${pmEscape(f)}</div>`).join('');
  const flagsHtml = r.flags.map(f => `<div class="signal red">\u26A0 ${pmEscape(f)}</div>`).join('');

  const calBucketsHtml = r.calibrationReport.buckets.map(b =>
    `<tr><td>${b.range}</td><td>${b.totalBets}</td><td>${(b.expectedRate * 100).toFixed(0)}%</td><td>${(b.actualRate * 100).toFixed(0)}%</td><td>${(b.error * 100).toFixed(1)}%</td></tr>`
  ).join('');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>VIGIL x ${pmEscape(r.displayName)} - Polymarket Trust Score</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&family=JetBrains+Mono:wght@400;600;700;800&display=swap" rel="stylesheet">
<meta property="og:title" content="VIGIL: ${pmEscape(r.displayName)} scored ${r.trustGrade}/${r.trustScore}">
<meta property="og:description" content="Trust Score ${r.trustScore}/100 | ${r.trustTier} | ${r.raw.resolvedBets} resolved bets | PnL: ${r.raw.totalPnl >= 0 ? '+' : '-'}$${Math.round(Math.abs(r.raw.totalPnl)).toLocaleString()}">
<meta property="og:image" content="https://vigilscore.xyz/v1/polymarket/${r.wallet}/og.svg">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="VIGIL: ${pmEscape(r.displayName)} scored ${r.trustGrade}/${r.trustScore}">
<meta name="twitter:description" content="${r.trustTier} | ${r.raw.resolvedBets} resolved bets">
<meta name="twitter:image" content="https://vigilscore.xyz/v1/polymarket/${r.wallet}/og.svg">
<style>
*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;background:#0c0c0c;color:#e8e8e8;line-height:1.6;padding:24px;max-width:800px;margin:0 auto}
.hdr{font-size:12px;color:#555;margin-bottom:24px;letter-spacing:2px;text-transform:uppercase;font-family:'JetBrains Mono','SF Mono',monospace}.hdr b{color:#00d4aa}
.card{background:#141414;border:1px solid #1e1e1e;border-radius:2px;padding:24px;margin-bottom:16px}
.hero{display:flex;justify-content:space-between;align-items:flex-start}
.name{font-size:28px;font-weight:700;color:#fff}.wallet{font-size:12px;color:#555;font-family:monospace;word-break:break-all}
.tier{display:inline-block;padding:4px 12px;border-radius:2px;font-size:12px;font-weight:700;margin-top:8px;background:${gc}22;color:${gc};border:1px solid ${gc}44}
.blurb{color:#707070;margin-top:8px;font-size:14px}
.grade{font-size:64px;font-weight:800;color:${gc};text-align:right;font-family:'JetBrains Mono','SF Mono',monospace}.score-num{font-size:14px;color:#707070;text-align:right;font-family:'JetBrains Mono','SF Mono',monospace}
.sec-title{text-transform:uppercase;font-size:12px;font-weight:700;color:#555;letter-spacing:1px;margin-bottom:12px}
.dim{display:flex;align-items:center;margin-bottom:10px}.dim-label{width:120px;font-size:14px;color:#707070}
.dim-bar{flex:1;height:10px;background:#1e1e1e;border-radius:1px;overflow:hidden;margin:0 12px}
.dim-fill{height:100%;background:${bc};border-radius:1px}.dim-val{font-size:14px;color:#fff;min-width:30px;text-align:right}
.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px}
.metric{background:#0f0f0f;border:1px solid #1e1e1e;border-radius:2px;padding:12px}
.metric-label{font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#555;margin-bottom:4px}
.metric-val{font-size:18px;font-weight:700;color:#fff;font-family:'JetBrains Mono','SF Mono',monospace}
.signal{padding:8px 16px;border-radius:2px;margin-bottom:6px;font-size:13px}
.green{background:#10b98115;color:#10b981;border:1px solid #10b98130}
.red{background:#ef444415;color:#ef4444;border:1px solid #ef444430}
.cal-table{width:100%;border-collapse:collapse;font-size:13px;margin-top:8px}
.cal-table th{text-align:left;color:#555;font-size:11px;text-transform:uppercase;padding:6px 8px;border-bottom:1px solid #1e1e1e}
.cal-table td{padding:6px 8px;border-bottom:1px solid #1e1e1e44}
.skill-bar{display:flex;gap:4px;margin-top:8px;height:24px;border-radius:2px;overflow:hidden}
.skill-seg{display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;color:#fff}
.foot{margin-top:24px;font-size:11px;color:#444;text-align:center;line-height:1.8}
.foot a{color:#555}
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
<div class="metric"><div class="metric-label">Brier Skill</div><div class="metric-val" style="color:${r.calibrationReport.brierSkillScore > 0 ? '#10b981' : '#ef4444'}">${Math.max(-999, Math.min(999, r.calibrationReport.brierSkillScore * 100)).toFixed(1)}%</div></div>
<div class="metric"><div class="metric-label">Log Loss</div><div class="metric-val">${r.calibrationReport.logLoss.toFixed(3)}</div></div>
</div></div>

${r.calibrationReport.buckets.length > 0 ? `<div class="card"><div class="sec-title">Calibration Analysis</div>
<p style="font-size:13px;color:#707070;margin-bottom:8px">When this trader buys at $0.70, they imply 70% probability. Perfect calibration = the event happens 70% of the time.</p>
<table class="cal-table"><tr><th>Bucket</th><th>Bets</th><th>Expected</th><th>Actual</th><th>Error</th></tr>${calBucketsHtml}</table>
<div style="margin-top:12px"><span style="font-size:12px;color:#555">Calibration Error: </span><span style="font-size:14px;font-weight:600;color:${r.calibrationReport.calibrationError < 0.1 ? '#10b981' : r.calibrationReport.calibrationError < 0.2 ? '#eab308' : '#ef4444'}">${(r.calibrationReport.calibrationError * 100).toFixed(1)}%</span></div>

<div style="margin-top:16px;display:grid;grid-template-columns:repeat(3,1fr);gap:12px">
<div style="background:#0f0f0f;padding:12px;border-radius:2px;border:1px solid #1e1e1e">
<div style="font-size:10px;color:#555;text-transform:uppercase;letter-spacing:1px">Reliability (CAL)</div>
<div style="font-size:18px;font-weight:700;color:${r.calibrationReport.brierDecomposition.calibration < 0.03 ? '#10b981' : r.calibrationReport.brierDecomposition.calibration < 0.08 ? '#eab308' : '#ef4444'}">${r.calibrationReport.brierDecomposition.calibration.toFixed(4)}</div>
<div style="font-size:10px;color:#444">Lower = better calibrated</div>
</div>
<div style="background:#0f0f0f;padding:12px;border-radius:2px;border:1px solid #1e1e1e">
<div style="font-size:10px;color:#555;text-transform:uppercase;letter-spacing:1px">Resolution (RES)</div>
<div style="font-size:18px;font-weight:700;color:${r.calibrationReport.brierDecomposition.resolution > 0.05 ? '#10b981' : r.calibrationReport.brierDecomposition.resolution > 0.01 ? '#eab308' : '#ef4444'}">${r.calibrationReport.brierDecomposition.resolution.toFixed(4)}</div>
<div style="font-size:10px;color:#444">Higher = stronger opinions</div>
</div>
<div style="background:#0f0f0f;padding:12px;border-radius:2px;border:1px solid #1e1e1e">
<div style="font-size:10px;color:#555;text-transform:uppercase;letter-spacing:1px">Brier Skill Score</div>
<div style="font-size:18px;font-weight:700;color:${r.calibrationReport.brierSkillScore > 0.1 ? '#10b981' : r.calibrationReport.brierSkillScore > 0 ? '#eab308' : '#ef4444'}">${Math.max(-999, Math.min(999, r.calibrationReport.brierSkillScore * 100)).toFixed(1)}%</div>
<div style="font-size:10px;color:#444">vs naive baseline</div>
</div>
</div>

<div style="margin-top:12px;display:grid;grid-template-columns:repeat(2,1fr);gap:12px">
<div style="background:#0f0f0f;padding:12px;border-radius:2px;border:1px solid #1e1e1e">
<div style="font-size:10px;color:#555;text-transform:uppercase;letter-spacing:1px">Log Loss</div>
<div style="font-size:18px;font-weight:700;color:#fff">${r.calibrationReport.logLoss.toFixed(4)}</div>
<div style="font-size:10px;color:#444">Skill: ${(r.calibrationReport.logLossSkill * 100).toFixed(1)}% vs naive — sensitive to rare events</div>
</div>
${r.calibrationReport.timeliness.timelinessScore > 0 ? `<div style="background:#0f0f0f;padding:12px;border-radius:2px;border:1px solid #1e1e1e">
<div style="font-size:10px;color:#555;text-transform:uppercase;letter-spacing:1px">Timeliness</div>
<div style="font-size:18px;font-weight:700;color:${r.calibrationReport.timeliness.timelinessScore >= 60 ? '#10b981' : r.calibrationReport.timeliness.timelinessScore >= 30 ? '#eab308' : '#ef4444'}">${r.calibrationReport.timeliness.timelinessScore}/100</div>
<div style="font-size:10px;color:#444">Avg ${r.calibrationReport.timeliness.avgDaysBeforeResolution.toFixed(0)}d before resolution, ${(r.calibrationReport.timeliness.earlyMoverPct * 100).toFixed(0)}% early mover</div>
</div>` : ''}
</div>
</div>` : ''}

${r.calibrationReport.skillDecomposition.skill > 0 ? `<div class="card"><div class="sec-title">Skill &amp; Variance Analysis</div>
<p style="font-size:13px;color:#707070;margin-bottom:12px">Skill measures calibration quality (0-100). Variance measures return volatility (0-100, higher = more volatile).</p>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
<div style="text-align:center;padding:16px;background:#0f0f0f;border-radius:2px;border:1px solid #1e1e1e">
  <div style="font-size:32px;font-weight:800;color:#10b981">${r.calibrationReport.skillDecomposition.skill.toFixed(0)}</div>
  <div style="font-size:11px;color:#555;text-transform:uppercase;letter-spacing:1px;margin-top:4px">Skill Score</div>
</div>
<div style="text-align:center;padding:16px;background:#0f0f0f;border-radius:2px;border:1px solid #1e1e1e">
  <div style="font-size:32px;font-weight:800;color:#6366f1">${r.calibrationReport.skillDecomposition.luck.toFixed(0)}</div>
  <div style="font-size:11px;color:#555;text-transform:uppercase;letter-spacing:1px;margin-top:4px">Variance</div>
</div>
</div></div>` : ''}

<div class="card"><div class="sec-title">Signals</div>${greenFlagsHtml}${flagsHtml}</div>

${r.onChain?.provenance ? `<div class="card"><div class="sec-title">On-Chain Verification (${r.onChain.provenance.chainId === 137 ? 'Polygon' : 'Base'})</div>
<div class="metrics">
<div class="metric"><div class="metric-label">Wallet Age</div><div class="metric-val">${r.onChain.provenance.walletAgeDays}d</div></div>
<div class="metric"><div class="metric-label">Txns on Base</div><div class="metric-val">${r.onChain.provenance.totalTransactions}</div></div>
<div class="metric"><div class="metric-label">Counterparties</div><div class="metric-val">${r.onChain.provenance.uniqueCounterparties}</div></div>
<div class="metric"><div class="metric-label">USDC In</div><div class="metric-val">$${Math.round(r.onChain.provenance.totalUsdcIn)}</div></div>
<div class="metric"><div class="metric-label">USDC Out</div><div class="metric-val">$${Math.round(r.onChain.provenance.totalUsdcOut)}</div></div>
<div class="metric"><div class="metric-label">Provenance</div><div class="metric-val" style="color:${r.onChain.provenance.provenanceGrade === 'A' ? '#10b981' : r.onChain.provenance.provenanceGrade === 'B' ? '#3b82f6' : r.onChain.provenance.provenanceGrade === 'C' ? '#eab308' : '#ef4444'}">${r.onChain.provenance.provenanceGrade} (${r.onChain.provenance.provenanceScore})</div></div>
</div>
${r.onChain.provenance.protocolsUsed.length > 0 ? `<div style="margin-top:12px;font-size:13px;color:#707070">Protocols: ${r.onChain.provenance.protocolsUsed.join(', ')}</div>` : ''}
${r.onChain.pnlDivergence !== null ? `<div style="margin-top:8px;font-size:13px;color:${r.onChain.pnlVerified ? '#10b981' : '#ef4444'}">PnL ${r.onChain.pnlVerified ? 'verified' : 'divergence'}: $${r.onChain.pnlDivergence} gap between API and on-chain USDC</div>` : ''}
${r.onChain.provenance.greenFlags.map(f => `<div class="signal green" style="margin-top:6px">\u2713 ${pmEscape(f)}</div>`).join('')}
${r.onChain.provenance.flags.map(f => `<div class="signal red" style="margin-top:6px">\u26A0 ${pmEscape(f)}</div>`).join('')}
</div>` : r.onChain === null ? `<div class="card"><div class="sec-title">On-Chain Verification</div><p style="font-size:13px;color:#555">On-chain verification not available. Basescan API key not configured.</p></div>` : ''}

<div class="card"><div class="sec-title">Reasoning</div>
${r.reasoning.map(line => `<p style="font-size:13px;color:#707070;margin-bottom:6px">${pmEscape(line)}</p>`).join('')}
</div>

<div class="card" style="background:#0f0f0f;border:1px solid #1e1e1e">
<div class="sec-title">What Does ${r.trustGrade}/${r.trustScore} Mean?</div>
<p style="font-size:13px;color:#707070;margin-bottom:8px;line-height:1.6">
${r.trustGrade === 'A' ? 'This trader demonstrates elite forecasting skill. Their predictions are well-calibrated and consistently beat naive baselines.' :
  r.trustGrade === 'B' ? 'This trader shows genuine forecasting skill with a meaningful edge across multiple markets.' :
  r.trustGrade === 'C' ? 'This trader shows some skill signal, but not enough to clearly distinguish from luck. More data needed.' :
  r.trustGrade === 'D' ? 'Below average. The data shows poor calibration, thin evidence, or both. When this trader expresses high confidence, events don\'t happen at the rate they imply.' :
  'No demonstrated forecasting skill. This trader performs at or below random chance based on available data.'}
</p>
<p style="font-size:12px;color:#555;line-height:1.6">
<strong style="color:#707070">Confidence:</strong> ${r.confidence.description}. ${r.confidence.margin <= 5 ? 'This score is highly reliable — enough resolved bets to be confident.' : r.confidence.margin <= 10 ? 'Moderate confidence — score may shift as more markets resolve.' : 'Low confidence — take this score with a grain of salt until more markets resolve.'}
</p>
<p style="font-size:11px;color:#444;margin-top:8px">Methodology: Brier Score Decomposition (Murphy 1973), Log Loss, On-Chain USDC Verification. Same approach used by IARPA to identify superforecasters.</p>
</div>

<div class="card" style="text-align:center;background:#0f0f0f">
<div class="sec-title">Share This Score</div>
<div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap">
<a href="https://twitter.com/intent/tweet?text=${encodeURIComponent(`${r.displayName} scored ${r.trustGrade}/${r.trustScore} on VIGIL Trust Score. ${r.trustTier}. ${r.raw.resolvedBets} resolved bets.\n\nScore any Polymarket wallet free:`)}&url=${encodeURIComponent(`https://vigilscore.xyz/polymarket/${r.wallet}`)}" target="_blank" style="display:inline-block;padding:10px 20px;background:transparent;border:1px solid #1d9bf0;color:#1d9bf0;border-radius:2px;font-weight:600;font-size:12px;text-decoration:none;letter-spacing:1px;font-family:'JetBrains Mono',monospace">POST ON X</a>
<button onclick="navigator.clipboard.writeText(window.location.href).then(function(){this.textContent='COPIED'}.bind(this))" style="padding:10px 20px;background:transparent;border:1px solid #2a2a2a;color:#707070;border-radius:2px;font-weight:600;font-size:12px;cursor:pointer;letter-spacing:1px;font-family:'JetBrains Mono',monospace">COPY LINK</button>
<a href="/v1/polymarket/${r.wallet}/og.svg" target="_blank" style="display:inline-block;padding:10px 20px;background:transparent;border:1px solid #2a2a2a;color:#707070;border-radius:2px;font-weight:600;font-size:12px;text-decoration:none;letter-spacing:1px;font-family:'JetBrains Mono',monospace">SCORE CARD</a>
</div>
</div>

<div class="foot"><strong>Not financial advice.</strong> VIGIL Trust Score is informational only.<br/>Scored: ${r.scoredAt} | Source: ${r.dataSource}<br/>JSON: <a href="/v1/polymarket/${r.wallet}">/v1/polymarket/...</a> | <a href="/polymarket">/polymarket</a></div>
</body></html>`;
}

function renderPolymarketNotFound(wallet: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>VIGIL - Trader Not Found</title>
<style>body{font-family:'Inter',-apple-system,sans-serif;background:#0c0c0c;color:#e8e8e8;display:flex;justify-content:center;align-items:center;min-height:100vh;text-align:center}h1{color:#ef4444;font-size:48px}p{color:#555}a{color:#00d4aa}</style></head>
<body><div><h1>404</h1><p>No Polymarket activity found for <code>${pmEscape(wallet)}</code>.</p><p><a href="/polymarket">Back to index</a></p></div></body></html>`;
}

function renderPolymarketError(wallet: string, message: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>VIGIL - Error</title>
<style>body{font-family:'Inter',-apple-system,sans-serif;background:#0c0c0c;color:#e8e8e8;display:flex;justify-content:center;align-items:center;min-height:100vh;text-align:center}h1{color:#f97316;font-size:48px}p{color:#555}a{color:#00d4aa}</style></head>
<body><div><h1>502</h1><p>Error scoring <code>${pmEscape(wallet)}</code>: ${pmEscape(message)}</p><p><a href="/polymarket">Back to index</a></p></div></body></html>`;
}

function renderPolymarketIndex(): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>VIGIL x Polymarket - Prediction Market Trust Scoring</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;background:#0c0c0c;color:#e8e8e8;line-height:1.6;padding:24px;max-width:800px;margin:0 auto}
h1{font-size:32px;color:#fff;margin-bottom:8px}h1 span{color:#00d4aa}
.sub{color:#707070;font-size:14px;margin-bottom:32px;font-style:italic}
.card{background:#141414;border:1px solid #1e1e1e;border-radius:2px;padding:24px;margin-bottom:16px}
.sec-title{text-transform:uppercase;font-size:12px;font-weight:700;color:#555;letter-spacing:1px;margin-bottom:12px}
.feature{display:flex;align-items:flex-start;gap:12px;margin-bottom:16px}
.feat-title{color:#fff;font-weight:600;font-size:15px}.feat-desc{color:#707070;font-size:13px}
code{background:#1e1e1e;padding:2px 6px;border-radius:1px;font-size:13px;color:#00d4aa}
.foot{margin-top:32px;font-size:11px;color:#444;text-align:center}
</style></head><body>
<h1><span>VIGIL</span> x Polymarket</h1>
<div class="sub">Independent trust scoring for prediction market traders. Calibration-first methodology. <em>Not investment advice.</em></div>

<div class="card"><div class="sec-title">The Proprietary Layer: Calibration Scoring</div>
<div class="feature"><div><div class="feat-title">Calibration Analysis</div><div class="feat-desc">When a trader buys YES at $0.70, they imply 70% probability. We check: does the event actually happen 70% of the time? This separates genuine skill from speed arb and luck.</div></div></div>
<div class="feature"><div><div class="feat-title">Skill vs. Luck Decomposition</div><div class="feat-desc">Returns decomposed into Skill (calibration-weighted alpha), Luck (variance residual). Know what you are buying before you copy-trade.</div></div></div>
<div class="feature"><div><div class="feat-title">Brier Score + 6-Dimension Trust Rating</div><div class="feat-desc">Calibration (25%), Live Edge (20%), Profitability (20%), Consistency (15%), Discipline (10%), Sample Size (10%) + Proven Winner Bonus.</div></div></div>
</div>

<div class="card"><div class="sec-title">Score Any Trader</div>
<p style="font-size:14px;color:#707070;margin-bottom:12px">Paste any Polymarket wallet address:</p>
<p><code>/polymarket/0x...</code> (HTML card)</p>
<p><code>/v1/polymarket/0x...</code> (JSON API)</p>
</div>

<div class="card"><div class="sec-title">What Makes This Different</div>
<p style="font-size:14px;color:#707070">Every other Polymarket leaderboard ranks by raw P&L. 14 of the top 20 most profitable wallets are bots running structural arbitrage. VIGIL scores what actually matters: <strong style="color:#fff">can this trader predict the future?</strong></p>
</div>

<div class="foot">VIGIL Trust Score is informational only.<br/><a href="/degenclaw" style="color:#555">DegenClaw Scoring</a> | <a href="/v1" style="color:#555">API Docs</a></div>
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
  const providedKey = String(req.headers['x-snapshot-key'] || '').trim();
  const expectedKey = (process.env.SNAPSHOT_KEY || '').trim();
  if (!expectedKey) {
    return res.status(503).json({ error: 'SNAPSHOT_KEY_NOT_CONFIGURED', message: 'Server has no SNAPSHOT_KEY set — cannot accept snapshot writes.' });
  }
  // Use timing-safe comparison to prevent timing attacks
  let keysMatch = false;
  try {
    keysMatch = timingSafeEqual(Buffer.from(providedKey), Buffer.from(expectedKey));
  } catch {
    // Buffer lengths don't match, keys are definitely not equal
    keysMatch = false;
  }
  if (!keysMatch) {
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
    version: '1.18.0',
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
      'GET /v1/onchain/:wallet': 'On-chain wallet provenance report from Base via Basescan',
      'GET /v1/onchain/:wallet/sybil': 'Quick sybil check (wallet age + tx count)',
      'GET /v1/onchain/status': 'On-chain verification layer status',
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

// ============================================================
//  API KEY MANAGEMENT ENDPOINTS
// ============================================================

// Pricing page (JSON)
app.get('/v1/api/pricing', (_req, res) => {
  res.json({
    tiers: Object.entries(API_TIERS).map(([id, t]) => ({
      id,
      label: t.label,
      price: t.price,
      monthlyLimit: t.monthlyLimit,
      ratePerMin: t.ratePerMin,
      features: id === 'free'
        ? ['100 scores/month', '10 req/min', 'Community support']
        : id === 'starter'
        ? ['1,000 scores/month', '30 req/min', 'Email support', 'Compare endpoint']
        : id === 'pro'
        ? ['10,000 scores/month', '120 req/min', 'Priority support', 'Webhook alerts', 'Bulk scoring']
        : ['100,000 scores/month', '600 req/min', 'Dedicated support', 'Custom dimensions', 'SLA'],
    })),
    currency: 'USD',
    billingCycle: 'monthly',
    contact: 'api@vigilscore.xyz',
  });
});

// Pricing page (HTML)
app.get('/api/pricing', (_req, res) => {
  const tierCards = Object.entries(API_TIERS).map(([id, t]) => {
    const features = id === 'free'
      ? ['100 scores/month', '10 req/min', 'Community support']
      : id === 'starter'
      ? ['1,000 scores/month', '30 req/min', 'Email support', 'Compare endpoint']
      : id === 'pro'
      ? ['10,000 scores/month', '120 req/min', 'Priority support', 'Webhook alerts', 'Bulk scoring']
      : ['100,000 scores/month', '600 req/min', 'Dedicated support', 'Custom dimensions', 'SLA'];

    const popular = id === 'pro' ? `<div style="position:absolute;top:-12px;left:50%;transform:translateX(-50%);background:#3b82f6;color:#fff;padding:2px 12px;border-radius:2px;font-size:11px;font-weight:700">MOST POPULAR</div>` : '';
    const border = id === 'pro' ? 'border:2px solid #3b82f6;' : 'border:1px solid #1e1e1e;';

    return `<div style="position:relative;background:#141414;${border}border-radius:2px;padding:24px;flex:1;min-width:220px">
      ${popular}
      <h3 style="color:#fff;font-size:16px;font-weight:700;margin-bottom:4px">${id.charAt(0).toUpperCase() + id.slice(1)}</h3>
      <div style="font-size:28px;font-weight:800;color:#fff;margin:8px 0">${t.price === 0 ? 'Free' : '$' + t.price}<span style="font-size:14px;color:#555;font-weight:400">${t.price > 0 ? '/mo' : ''}</span></div>
      <ul style="list-style:none;padding:0;margin:16px 0">${features.map(f => `<li style="color:#707070;font-size:13px;padding:4px 0">✓ ${f}</li>`).join('')}</ul>
      ${id === 'free' ? '<a href="/v1/api/keys/create?tier=free&email=demo" style="display:block;text-align:center;padding:10px;background:#1e1e1e;color:#707070;border-radius:2px;text-decoration:none;font-weight:600;font-size:13px">Get Free Key</a>' : `<a href="mailto:api@vigilscore.xyz?subject=VIGIL API ${id} tier" style="display:block;text-align:center;padding:10px;background:#3b82f6;color:#fff;border-radius:2px;text-decoration:none;font-weight:600;font-size:13px">Get Started</a>`}
    </div>`;
  }).join('');

  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>VIGIL API Pricing</title></head>
<body style="background:#0c0c0c;color:#fff;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;margin:0;padding:40px 20px">
<div style="max-width:1000px;margin:0 auto">
  <div style="text-align:center;margin-bottom:40px">
    <h1 style="font-size:32px;font-weight:800;letter-spacing:2px;margin-bottom:8px">VIGIL API</h1>
    <p style="color:#555;font-size:14px">Trust scores for prediction market wallets. Programmatic access.</p>
  </div>
  <div style="display:flex;gap:16px;flex-wrap:wrap;justify-content:center">${tierCards}</div>
  <div style="text-align:center;margin-top:40px">
    <p style="color:#444;font-size:13px">All plans include: REST API access, JSON responses, wallet scoring, compare endpoint</p>
    <p style="color:#444;font-size:12px;margin-top:8px">Questions? <a href="mailto:api@vigilscore.xyz" style="color:#3b82f6">api@vigilscore.xyz</a></p>
  </div>
</div></body></html>`);
});

// Create API key (self-serve for free tier, manual approval for paid)
app.get('/v1/api/keys/create', (req, res) => {
  const tier = (req.query.tier as string) || 'free';
  const email = req.query.email as string;

  if (!email) {
    return res.status(400).json({ error: 'Email required', usage: '/v1/api/keys/create?tier=free&email=you@example.com' });
  }

  if (tier !== 'free' && tier !== 'starter') {
    return res.json({
      message: `${tier} tier requires manual setup. Contact api@vigilscore.xyz`,
      tier,
      pricing: API_TIERS[tier as keyof typeof API_TIERS],
    });
  }

  const tierConfig = API_TIERS[tier as keyof typeof API_TIERS];
  if (!tierConfig) {
    return res.status(400).json({ error: 'Invalid tier', validTiers: Object.keys(API_TIERS) });
  }

  // Check if email already has a key
  for (const record of apiKeyStore.values()) {
    if (record.owner === email.toLowerCase()) {
      return res.json({
        message: 'You already have an API key. Contact api@vigilscore.xyz if you need a new one.',
        tier: record.tier,
      });
    }
  }

  const key = generateApiKey();
  const record: ApiKeyRecord = {
    key,
    tier: tier as ApiKeyRecord['tier'],
    owner: email.toLowerCase(),
    monthlyLimit: tierConfig.monthlyLimit,
    ratePerMin: tierConfig.ratePerMin,
    monthlyUsage: 0,
    createdAt: new Date().toISOString(),
    expiresAt: null,
  };
  apiKeyStore.set(key, record);

  res.json({
    apiKey: key,
    tier: record.tier,
    monthlyLimit: record.monthlyLimit,
    ratePerMin: record.ratePerMin,
    usage: {
      header: 'x-api-key: YOUR_KEY',
      queryParam: '?api_key=YOUR_KEY',
      example: `curl -H "x-api-key: ${key}" https://vigilscore.xyz/v1/polymarket/0x...`,
    },
    warning: 'Save this key — it cannot be retrieved later.',
  });
});

// Check API key usage
app.get('/v1/api/keys/usage', (req, res) => {
  const apiKey = req.headers['x-api-key'] as string || req.query.api_key as string;
  if (!apiKey) {
    return res.status(401).json({ error: 'Provide API key via x-api-key header or api_key query param' });
  }

  const record = validateApiKey(apiKey);
  if (!record) {
    return res.status(401).json({ error: 'Invalid or expired API key' });
  }

  res.json({
    tier: record.tier,
    owner: record.owner,
    monthlyLimit: record.monthlyLimit,
    monthlyUsage: record.monthlyUsage,
    remaining: record.monthlyLimit - record.monthlyUsage,
    ratePerMin: record.ratePerMin,
    createdAt: record.createdAt,
  });
});

// ── Telegram Bot Webhook ──────────────────────────────────────────────

const TG_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_API_BASE = TG_BOT_TOKEN ? `https://api.telegram.org/bot${TG_BOT_TOKEN}` : '';
// Derive webhook secret from bot token for verification
const VIGIL_TG_WEBHOOK_SECRET = TG_BOT_TOKEN ? `vigil_tg_${TG_BOT_TOKEN.slice(-16)}` : '';

async function tgSend(chatId: number, text: string) {
  if (!TG_API_BASE) return;
  await fetch(`${TG_API_BASE}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
}

function tgGradeEmoji(grade: string): string {
  return ({ A: '🟢', B: '🔵', C: '🟡', D: '🟠', F: '🔴' } as Record<string, string>)[grade] || '⚪';
}

function tgPnl(pnl: number): string {
  return pnl >= 0 ? `+$${Math.round(pnl).toLocaleString()}` : `-$${Math.round(Math.abs(pnl)).toLocaleString()}`;
}

app.post('/telegram/webhook', async (req, res) => {
  res.sendStatus(200); // ack immediately
  if (!TG_BOT_TOKEN) return;

  // Verify webhook secret token to prevent unauthorized webhook calls
  const providedSecret = String(req.headers['x-telegram-bot-api-secret-token'] || '');
  if (!providedSecret || providedSecret !== VIGIL_TG_WEBHOOK_SECRET) {
    console.warn('[TG Bot] Webhook called without valid secret token');
    return;
  }

  const msg = req.body?.message;
  if (!msg?.text) return;
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  try {
    if (text.startsWith('/start') || text.startsWith('/help')) {
      await tgSend(chatId, `<b>VIGIL Trust Score Bot</b>\n\nScore any Polymarket wallet's forecasting skill.\n\n<b>Commands:</b>\n/score &lt;wallet or username&gt;\n/compare &lt;wallet1&gt; &lt;wallet2&gt;\n/top — Leaderboard\n\n<b>Example:</b>\n<code>/score swisstony</code>\n\nPowered by <a href="https://vigilscore.xyz">VIGIL</a>`);
    } else if (text.startsWith('/score')) {
      const input = text.replace(/^\/score\s*/, '').split(/\s+/)[0];
      if (!input) { await tgSend(chatId, '⚠️ Usage: <code>/score &lt;wallet or username&gt;</code>'); return; }

      await tgSend(chatId, `⏳ Scoring <code>${input.length > 20 ? input.slice(0, 8) + '...' + input.slice(-4) : input}</code>...`);

      // Resolve username if needed
      let wallet = input;
      if (!wallet.startsWith('0x')) {
        const resolved = resolveWalletIdentifier(wallet);
        if (!resolved) { await tgSend(chatId, `❌ Username "${input}" not found. Try a wallet address.`); return; }
        wallet = resolved;
      }

      const d = await scorePolymarketTrader(wallet);
      if (!d) { await tgSend(chatId, '❌ No trading data found for this wallet.'); return; }

      const name = d.displayName && !d.displayName.startsWith('0x') ? d.displayName.split('-')[0] : d.wallet.slice(0, 8) + '...' + d.wallet.slice(-4);
      const flags = (d.flags || []).slice(0, 3).map((f: string) => `  ⚠️ ${f}`).join('\n');
      const greens = (d.greenFlags || []).slice(0, 2).map((f: string) => `  ✅ ${f}`).join('\n');

      await tgSend(chatId, `${tgGradeEmoji(d.trustGrade)} <b>VIGIL: ${d.trustGrade} / ${d.trustScore}</b>\n<b>${hEsc(name)}</b> — ${d.trustTier}\n\n📊 Cal: ${d.calibration}/100 | Edge: ${d.liveEdge}/100\nProfit: ${d.profitability}/100 | Consist: ${d.consistency}/100\nDisc: ${d.discipline}/100 | Sample: ${d.sampleSize}/100\n\n💰 PnL: <b>${tgPnl(d.raw.totalPnl)}</b>\n📈 ${d.raw.totalTrades} trades, ${d.raw.resolvedBets} resolved${flags ? '\n\n🚩 ' + flags : ''}${greens ? '\n🟢 ' + greens : ''}\n\n🔗 <a href="https://vigilscore.xyz/polymarket/${d.wallet}">Full Scorecard</a>`);
    } else if (text.startsWith('/compare')) {
      const parts = text.replace(/^\/compare\s*/, '').split(/\s+/);
      if (parts.length < 2) { await tgSend(chatId, '⚠️ Usage: <code>/compare &lt;wallet1&gt; &lt;wallet2&gt;</code>'); return; }

      await tgSend(chatId, '⏳ Comparing...');
      const [d1, d2] = await Promise.all([scorePolymarketTrader(parts[0]), scorePolymarketTrader(parts[1])]);
      if (!d1 || !d2) { await tgSend(chatId, '❌ One or both wallets not found.'); return; }

      await tgSend(chatId, `⚔️ <b>VIGIL Head-to-Head</b>\n\n${tgGradeEmoji(d1.trustGrade)} <b>${hEsc(d1.displayName?.split('-')[0] || d1.wallet.slice(0,10))}</b>: ${d1.trustGrade}/${d1.trustScore}\n${tgGradeEmoji(d2.trustGrade)} <b>${hEsc(d2.displayName?.split('-')[0] || d2.wallet.slice(0,10))}</b>: ${d2.trustGrade}/${d2.trustScore}\n\n💰 ${tgPnl(d1.raw.totalPnl)} vs ${tgPnl(d2.raw.totalPnl)}\n\n🔗 <a href="https://vigilscore.xyz/polymarket/compare?w1=${d1.wallet}&w2=${d2.wallet}">Full Comparison</a>`);
    } else if (text.startsWith('/top') || text.startsWith('/leaderboard')) {
      let lb = '🏆 <b>Polymarket Top 10 — VIGIL Scored</b>\n\n';
      for (let i = 0; i < TOP_WALLETS.length; i++) {
        const w = TOP_WALLETS[i];
        lb += `${i + 1}. ${tgGradeEmoji(w.grade)} <b>${hEsc(w.name)}</b> ${w.grade}/${w.score} — ${tgPnl(w.pnl)}\n`;
      }
      lb += `\n🔗 <a href="https://vigilscore.xyz">Full Leaderboard</a>`;
      await tgSend(chatId, lb);
    }
  } catch (e: any) {
    console.error('[TG Bot] Error:', e.message);
    await tgSend(chatId, '❌ Something went wrong. Try again.').catch(() => {});
  }
});

// Setup webhook endpoint (call once to register)
app.get('/telegram/setup', async (req, res) => {
  if (!TG_BOT_TOKEN) { res.json({ error: 'TELEGRAM_BOT_TOKEN not set' }); return; }
  const webhookUrl = `https://vigilscore.xyz/telegram/webhook`;
  const result = await fetch(`${TG_API_BASE}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: webhookUrl, secret_token: VIGIL_TG_WEBHOOK_SECRET }),
  }).then(r => r.json());
  res.json({ webhookUrl, result });
});

// ============================================================
//  EMAIL CAPTURE ENDPOINT
// ============================================================
app.post('/subscribe', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!email || !email.includes('@') || email.length < 5 || email.length > 200) {
    return res.status(400).json({ error: 'Valid email required' });
  }
  if (emailSubscribers.has(email)) {
    return res.json({ success: true, message: 'You\'re on the list! We\'ll alert you when an A-grade forecaster is discovered.' });
  }
  emailSubscribers.add(email);

  // Persist to DB
  try {
    await query('INSERT INTO email_subscribers (email, alert_type) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING', [email, 'a_grade']);
  } catch (err) {
    console.error('[SUBSCRIBE] DB save failed:', err);
  }

  console.log(`[SUBSCRIBE] New A-grade alert subscriber: ${email} (total: ${emailSubscribers.size})`);
  res.json({ success: true, message: 'You\'re on the list! We\'ll alert you when an A-grade forecaster is discovered.' });
});

app.get('/subscribe/count', (_req, res) => {
  res.json({ subscribers: emailSubscribers.size });
});

// Discovery alerts — recent A/B grade wallet finds
app.get('/v1/polymarket/discover/alerts', async (_req, res) => {
  try {
    const result = await query('SELECT * FROM discovery_alerts ORDER BY discovered_at DESC LIMIT 50');
    res.json({ alerts: result?.rows || [], total: result?.rowCount || 0 });
  } catch (err) {
    res.json({ alerts: [], total: 0 });
  }
});

// --- 404 handler (must be last route) ---
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

  // Load subscribers from DB into memory
  if (dbConnected) {
    try {
      const subs = await query('SELECT email FROM email_subscribers');
      if (subs?.rows) {
        for (const row of subs.rows) emailSubscribers.add(row.email);
        console.log(`[BOOT] Loaded ${emailSubscribers.size} email subscribers from DB`);
      }
    } catch (err) {
      console.error('[BOOT] Failed to load subscribers:', err);
    }

    // v1.20.2: Load full leaderboard from DB so it's instant after deploys
    let loaded = 0;
    try {
      loaded = await loadLeaderboardFromDb();
      console.log(`[BOOT] Leaderboard: ${loaded} wallets loaded from database`);
    } catch (err) {
      console.error('[BOOT] Failed to load leaderboard from DB:', err);
    }

    // v1.21.1: Fallback seed from TOP_WALLETS if DB load returned empty.
    // Guarantees the skill leaderboard has real graded wallets even when the
    // crawler hasn't run and leaderboard_cache is empty. Unblocks consensus
    // and divergence endpoints on cold boots.
    if (loaded === 0) {
      const seedEntries: LeaderboardEntry[] = TOP_WALLETS.map((w) => ({
        wallet: w.wallet,
        displayName: w.name,
        trustScore: w.score,
        trustGrade: w.grade,
        brierSkillScore: w.bss,
        calibrationError: w.calibration / 100,
        resolvedBets: w.resolved,
        winRate: w.winRate,
        realizedPnl: w.pnl,
        scoredAt: new Date().toISOString(),
      }));
      const seeded = seedSkillLeaderboard(seedEntries);
      resetCrawlInProgress();
      console.log(`[BOOT] Leaderboard cold-boot fallback: seeded ${seeded} wallets from TOP_WALLETS + cleared stale crawl flag`);
    }

    // Load discovery alerts so homepage elite table works immediately (before crawler runs)
    try {
      const alerts = await query("SELECT wallet, display_name, trust_grade, trust_score, brier_skill, resolved_bets FROM discovery_alerts WHERE trust_grade IN ('A', 'B') ORDER BY trust_score DESC LIMIT 10");
      if (alerts?.rows) {
        knownEliteWallets = alerts.rows.map((row: any) => ({
          wallet: row.wallet,
          displayName: row.display_name || row.wallet.slice(0, 8) + '...' + row.wallet.slice(-4),
          trustGrade: row.trust_grade,
          trustScore: row.trust_score,
          brierSkillScore: row.brier_skill || 0,
          resolvedBets: row.resolved_bets || 0,
        }));
        // Seed username cache from alerts too
        for (const w of knownEliteWallets) {
          if (w.displayName && !w.displayName.startsWith('0x')) {
            usernameToWallet.set(w.displayName.toLowerCase(), w.wallet);
          }
        }
        const aCount = knownEliteWallets.filter(w => w.trustGrade === 'A').length;
        const bCount = knownEliteWallets.filter(w => w.trustGrade === 'B').length;
        console.log(`[BOOT] Loaded ${aCount} A-grade + ${bCount} B-grade wallets from discovery_alerts`);
      }
    } catch (err) {
      console.error('[BOOT] Failed to load discovery alerts:', err);
    }
  }

  app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════╗
║       VIGIL Trust Score API v1.18.0              ║
║     On-chain credit bureau for AI agents         ║
╠══════════════════════════════════════════════════╣
║  Server:    http://localhost:${PORT}               ║
║  Docs:      http://localhost:${PORT}/v1            ║
║  Health:    http://localhost:${PORT}/v1/health     ║
║  Storage:   ${dbConnected ? 'PostgreSQL (persistent)' : 'In-Memory (volatile)'}       ║
║  Rate Limit: ${RATE_LIMIT_MAX} req/min per IP             ║
╚══════════════════════════════════════════════════╝
    `);

    // Schedule prescore cron: 30s after boot, then every hour
    setTimeout(() => runPrescoringCron(), 30000);
    setInterval(() => runPrescoringCron(), 3600000);
    console.log('[BOOT] Prescore cron scheduled: 30s initial delay, then hourly');

    // Schedule discovery crawler: 2 min after boot, then every 2 hours
    // Scans resolved markets, discovers wallets, builds skill leaderboard
    setTimeout(() => {
      runDiscoveryCrawl({ maxMarkets: 300, maxToScore: 400 }).then(r => {
        console.log(`[BOOT] Initial discovery crawl complete: ${r.scored} wallets scored, top grade: ${r.topGrade}`);
      }).catch(err => {
        console.error('[BOOT] Initial discovery crawl failed:', err);
      });
    }, 120000); // 2 min delay — let prescore finish first
    setInterval(() => {
      runDiscoveryCrawl({ maxMarkets: 500, maxToScore: 500 }).then(r => {
        console.log(`[CRON] Discovery crawl complete: ${r.scored} wallets scored, top grade: ${r.topGrade}`);
      }).catch(err => {
        console.error('[CRON] Discovery crawl failed:', err);
      });
    }, 2 * 3600000); // every 2 hours
    console.log('[BOOT] Discovery crawler scheduled: 2min initial delay, then every 2h');

    // Schedule consensus cache warmer: 3 min after boot (let leaderboard load first),
    // then every 5 min. Pre-warms top 20 active markets so landing-page widget is never cold.
    setTimeout(() => {
      warmConsensusCache(20).catch(err => console.error('[BOOT] Initial consensus warm failed:', err));
    }, 180_000);
    setInterval(() => {
      warmConsensusCache(20).catch(err => console.error('[CRON] Consensus warm failed:', err));
    }, 5 * 60 * 1000);
    console.log('[BOOT] Consensus cache warmer scheduled: 3min initial delay, then every 5min');
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

// ============================================================
//  HOMEPAGE RENDERER
// ============================================================

function hEsc(s: string): string {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function gradeColor(g: string): string {
  return g === 'A' ? '#10b981' : g === 'B' ? '#34d399' : g === 'C' ? '#eab308' : g === 'D' ? '#f97316' : '#ef4444';
}

// ============================================================
//  PRESCORE CRON — Background scoring for popular wallets
// ============================================================

async function runPrescoringCron(): Promise<void> {
  console.log(`[CRON] Starting pre-scoring run for ${TOP_WALLETS.length} popular wallets...`);

  for (const wallet of TOP_WALLETS) {
    try {
      const report = await scorePolymarketTrader(wallet.wallet);
      if (report) {
        // Store in prescore cache with timestamp
        prescoredCache.set(wallet.wallet.toLowerCase(), {
          ...report,
          cachedAt: Date.now(),
        });

        // Update TOP_WALLETS entry with fresh data
        wallet.grade = report.trustGrade;
        wallet.score = report.trustScore;
        wallet.resolved = report.raw.resolvedBets;
        wallet.winRate = report.raw.winRate ?? 0;
        wallet.bss = report.calibrationReport.brierSkillScore ?? 0;
        wallet.calibration = Math.round(report.calibrationReport.calibrationError * 1000) / 10; // as percentage e.g. 12.3
        if (report.displayName && !report.displayName.startsWith('0x')) wallet.name = report.displayName;

        const bssPct = (wallet.bss * 100).toFixed(1);
        console.log(`[CRON] Pre-scored ${wallet.name}: ${report.trustGrade}/${report.trustScore} BSS=${bssPct}% win=${(wallet.winRate * 100).toFixed(1)}% resolved=${wallet.resolved}`);
      }
    } catch (err) {
      console.error(`[CRON] Failed to pre-score ${wallet.name} (${wallet.wallet}):`, (err as Error).message);
    }

    // 3-second delay between wallets to avoid hammering upstream
    await new Promise(resolve => setTimeout(resolve, 3000));
  }

  console.log(`[CRON] Pre-scoring complete. Cached ${prescoredCache.size} wallets.`);

  // v1.21.2: After prescore completes, push the freshly scored TOP_WALLETS into
  // the skill leaderboard so consensus/divergence endpoints have graded wallets
  // to aggregate even if the discovery crawler is stuck or hasn't run yet.
  // v1.22.0: Pull bootstrap CI95 from prescoredCache so leaderboard entries
  // carry grade bands (required for public display; "INS" when insufficient).
  try {
    const leaderboardEntries: LeaderboardEntry[] = TOP_WALLETS
      .filter(w => w.resolved > 0)
      .map(w => {
        const cached = prescoredCache.get(w.wallet.toLowerCase());
        const ci95 = cached?.confidence?.ci95 ?? {
          scoreLow: Math.max(0, w.score - 25),
          scoreHigh: Math.min(100, w.score + 25),
          gradeLow: 'INS',
          gradeHigh: 'INS',
          insufficientData: true,
        };
        return {
          wallet: w.wallet,
          displayName: w.name,
          trustScore: w.score,
          trustGrade: w.grade,
          brierSkillScore: w.bss,
          calibrationError: w.calibration / 100,
          resolvedBets: w.resolved,
          winRate: w.winRate,
          realizedPnl: w.pnl,
          scoredAt: new Date().toISOString(),
          ci95: {
            scoreLow: ci95.scoreLow,
            scoreHigh: ci95.scoreHigh,
            gradeLow: ci95.gradeLow,
            gradeHigh: ci95.gradeHigh,
            insufficientData: ci95.insufficientData,
          },
        };
      });
    const merged = seedSkillLeaderboard(leaderboardEntries);
    resetCrawlInProgress();
    const insCount = leaderboardEntries.filter(e => e.ci95?.insufficientData).length;
    console.log(`[CRON] Skill leaderboard now has ${merged} wallets (${insCount} INS, ${merged - insCount} with bootstrap CI)`);
  } catch (err) {
    console.error('[CRON] Failed to seed skill leaderboard from TOP_WALLETS:', err);
  }
}

// Pre-scored top Polymarket wallets (hardcoded, refreshable via cron)
// Polymarket Top 10 by All-Time PnL — authoritative seed from live /v1/polymarket/:wallet pass on 2026-04-20T21:11:26Z.
// winRate and bss are snapshotted from that run; the cron refreshes all four derived fields (grade/score/calibration/winRate/bss)
// every scoring cycle, so the leaderboard card and the grade pages stay coherent.
const TOP_WALLETS: Array<{ wallet: string; name: string; pnl: number; grade: string; score: number; resolved: number; winRate: number; bss: number; calibration: number }> = [
  { wallet: '0x56687bf447db6ffa42ffe2204a05edaa20f55839', name: 'Theo4', pnl: 22053934, grade: 'D', score: 37, resolved: 14, winRate: 0.929, bss: -4.6001, calibration: 52.2 },
  { wallet: '0x1f2dd6d473f3e824cd2f8a89d9c69fb96f6ad0cf', name: 'Fredi9999', pnl: 16619507, grade: 'D', score: 41, resolved: 40, winRate: 0.600, bss: -0.2107, calibration: 27.4 },
  { wallet: '0x6a72f61820b26b1fe4d956e17b6dc2a1ea3033ee', name: 'kch123', pnl: 11866256, grade: 'D', score: 38, resolved: 338, winRate: 0.006, bss: -31.3439, calibration: 39.2 },
  { wallet: '0x78b9ac44a6d7d7a076c14e0ad518b301b63c6b76', name: 'Len9311238', pnl: 8709973, grade: 'D', score: 38, resolved: 7, winRate: 1.000, bss: -0.0952, calibration: 51.2 },
  { wallet: '0xd235973291b2b75ff4070e9c0b01728c520b0f29', name: 'zxgngl', pnl: 7807266, grade: 'F', score: 31, resolved: 6, winRate: 0.833, bss: -0.4773, calibration: 34.3 },
  { wallet: '0x863134d00841b2e200492805a01e1e2f5defaa53', name: 'RepTrump', pnl: 7532410, grade: 'F', score: 31, resolved: 8, winRate: 0.875, bss: -1.4238, calibration: 40.9 },
  { wallet: '0x2005d16a84ceefa912d4e380cd32e7ff827875ea', name: 'RN1', pnl: 7465792, grade: 'D', score: 45, resolved: 964, winRate: 0.062, bss: -3.6104, calibration: 36.7 },
  { wallet: '0x204f72f35326db932158cba6adff0b9a1da95e14', name: 'swisstony', pnl: 6100031, grade: 'C', score: 57, resolved: 508, winRate: 0.559, bss: -0.5292, calibration: 31.3 },
  { wallet: '0x8119010a6e589062aa03583bb3f39ca632d9f887', name: 'PrincessCaro', pnl: 6083643, grade: 'D', score: 35, resolved: 14, winRate: 0.714, bss: -0.2597, calibration: 24.5 },
  { wallet: '0xe9ad918c7678cd38b12603a762e638a5d1ee7091', name: 'walletmobile', pnl: 5942685, grade: 'F', score: 18, resolved: 0, winRate: 0.000, bss: -1.0000, calibration: 100.0 },
];

// Seed username cache from leaderboard on startup
for (const w of TOP_WALLETS) {
  if (w.name && !w.name.startsWith('0x')) {
    usernameToWallet.set(w.name.toLowerCase(), w.wallet);
  }
}

function renderHomepage(): string {
  // v1.22.0 — Pull bootstrap CI95 per wallet for public grade display.
  // Build a map of wallet → ci95 from the live skill leaderboard (or
  // prescoredCache as fallback) so each row shows its CI band.
  const skillLb = getSkillLeaderboard();
  const ciByWallet = new Map<string, { scoreLow: number; scoreHigh: number; gradeLow: string; gradeHigh: string; insufficientData: boolean }>();
  for (const e of skillLb) {
    if (e.ci95) ciByWallet.set(e.wallet.toLowerCase(), e.ci95);
  }

  // Build leaderboard rows
  const leaderboardRows = TOP_WALLETS.map((w, i) => {
    const gc = gradeColor(w.grade);
    const pnlStr = w.pnl >= 0 ? `+$${w.pnl.toLocaleString()}` : `-$${Math.abs(w.pnl).toLocaleString()}`;
    const pnlColor = w.pnl >= 0 ? '#10b981' : '#ef4444';
    const bssPctRaw = w.bss * 100;
    const bssPct = Math.max(-9999, Math.min(9999, bssPctRaw));
    const bssCell = w.resolved >= 5
      ? `<span style="color:${bssPctRaw >= 0 ? '#10b981' : '#ef4444'};font-weight:600">${bssPctRaw >= 0 ? '+' : ''}${bssPct.toFixed(0)}%</span>`
      : `<span style="color:#444">—</span>`;
    const winCell = w.resolved > 0
      ? `${(w.winRate * 100).toFixed(1)}%`
      : `<span style="color:#444">—</span>`;

    // v1.22.0 — Grade cell with bootstrap CI95 band.
    // INS when: resolved < 30 OR CI span >= 20 pts.
    const ci = ciByWallet.get(w.wallet.toLowerCase());
    const pre = prescoredCache.get(w.wallet.toLowerCase());
    const ciData = ci ?? pre?.confidence?.ci95;
    const insufficient = !ciData || ciData.insufficientData || w.resolved < 30;
    const gradeCell = insufficient
      ? `<span title="Insufficient data for grade CI (min 30 resolved bets, CI95 span < 20pts)" style="display:inline-block;padding:0 8px;height:28px;border-radius:2px;background:#55555518;color:#888;text-align:center;line-height:28px;font-weight:700;font-size:11px;border:1px solid #55555530;font-family:'JetBrains Mono',monospace;letter-spacing:0.5px">INS</span>`
      : `<span title="Bootstrap CI95: ${ciData.gradeLow}→${ciData.gradeHigh} (${ciData.scoreLow}-${ciData.scoreHigh})" style="display:inline-block;width:28px;height:28px;border-radius:2px;background:${gc}12;color:${gc};text-align:center;line-height:28px;font-weight:800;font-size:14px;border:1px solid ${gc}30;font-family:'JetBrains Mono',monospace">${w.grade}</span>`;
    const scoreCell = insufficient
      ? `<span style="color:#666;font-size:12px">—</span>`
      : `<span style="color:#fff;font-weight:600">${w.score}</span><br/><span style="font-size:10px;color:#555;font-family:monospace">[${ciData.scoreLow}–${ciData.scoreHigh}]</span>`;

    return `<tr onclick="window.location='/polymarket/${w.wallet}'" style="cursor:pointer">
<td style="color:#555">${i + 1}</td>
<td><span style="color:#fff;font-weight:600">${hEsc(w.name)}</span><br/><span style="font-size:11px;color:#444;font-family:monospace">${w.wallet.slice(0,8)}...${w.wallet.slice(-4)}</span></td>
<td style="color:${pnlColor};font-weight:700">${pnlStr}</td>
<td>${gradeCell}</td>
<td>${scoreCell}</td>
<td style="font-family:'JetBrains Mono',monospace">${bssCell}</td>
<td style="color:#e8e8e8">${winCell}</td>
<td style="color:#707070">${w.resolved}</td>
</tr>`;
  }).join('');

  // Build recently scored rows
  const recentRows = recentScores.slice(0, 8).map(s => {
    const gc = gradeColor(s.trustGrade);
    const pnlStr = s.totalPnl >= 0 ? `+$${Math.round(s.totalPnl).toLocaleString()}` : `-$${Math.round(Math.abs(s.totalPnl)).toLocaleString()}`;
    const pnlColor = s.totalPnl >= 0 ? '#10b981' : '#ef4444';
    const ago = Math.round((Date.now() - new Date(s.scoredAt).getTime()) / 60000);
    const agoStr = ago < 1 ? 'just now' : ago < 60 ? `${ago}m ago` : `${Math.round(ago / 60)}h ago`;
    return `<tr onclick="window.location='/polymarket/${s.wallet}'" style="cursor:pointer">
<td><span style="color:#fff;font-weight:600">${hEsc(s.displayName)}</span></td>
<td style="color:${pnlColor};font-weight:600">${pnlStr}</td>
<td><span style="display:inline-block;width:24px;height:24px;border-radius:2px;background:${gc}12;color:${gc};text-align:center;line-height:24px;font-weight:800;font-size:12px;border:1px solid ${gc}30;font-family:'JetBrains Mono',monospace">${s.trustGrade}</span></td>
<td style="color:#fff">${s.trustScore}</td>
<td style="color:#555;font-size:12px">${agoStr}</td>
</tr>`;
  }).join('');

  // Build VIGIL Elite list — only A and B grade wallets
  const fullLeaderboard = getSkillLeaderboard();
  const liveElite = fullLeaderboard.filter(e => e.trustGrade === 'A' || e.trustGrade === 'B');
  // Use live crawler data if available, otherwise fall back to DB-persisted discovery alerts
  const eliteSource = liveElite.length > 0 ? liveElite.map(e => ({
    wallet: e.wallet, displayName: e.displayName, trustGrade: e.trustGrade,
    trustScore: e.trustScore, brierSkillScore: e.brierSkillScore, resolvedBets: e.resolvedBets, realizedPnl: e.realizedPnl,
  })) : knownEliteWallets.map(w => ({ ...w, realizedPnl: 0 }));
  const eliteWallets = eliteSource.slice(0, 10);
  const aGradeCount = liveElite.length > 0
    ? fullLeaderboard.filter(e => e.trustGrade === 'A').length
    : knownEliteWallets.filter(w => w.trustGrade === 'A').length;
  const bGradeCount = liveElite.length > 0
    ? fullLeaderboard.filter(e => e.trustGrade === 'B').length
    : knownEliteWallets.filter(w => w.trustGrade === 'B').length;
  const skillTop10Rows = eliteWallets.length > 0 ? eliteWallets.map((e, i) => {
    const gc = gradeColor(e.trustGrade);
    const pnl = e.realizedPnl >= 0
      ? `<span style="color:#10b981">+$${Math.round(e.realizedPnl).toLocaleString()}</span>`
      : `<span style="color:#ef4444">-$${Math.round(Math.abs(e.realizedPnl)).toLocaleString()}</span>`;
    const bssRaw = e.brierSkillScore * 100;
    const bssCapped = Math.max(-999, Math.min(999, bssRaw));
    const bss = bssRaw >= 0
      ? `<span style="color:#10b981">+${bssCapped.toFixed(0)}%</span>`
      : `<span style="color:#ef4444">${bssCapped.toFixed(0)}%</span>`;
    const name = e.displayName.length > 20 ? e.displayName.slice(0, 18) + '...' : e.displayName;
    const rowBg = i % 2 === 0 ? '' : 'background:#0d0d0d;';
    return `<tr onclick="window.location='/polymarket/${e.wallet}'" style="cursor:pointer;border-bottom:1px solid #1a1a1a;${rowBg}transition:background .15s" onmouseover="this.style.background='#151515'" onmouseout="this.style.background='${i % 2 === 0 ? '' : '#0d0d0d'}'">
<td style="padding:10px 8px;color:#555;font-family:'JetBrains Mono',monospace;font-size:12px">${i + 1}</td>
<td style="padding:10px 8px"><a href="/polymarket/${e.wallet}" style="color:#00d4aa;text-decoration:none;font-weight:600">${hEsc(name)}</a></td>
<td style="padding:10px 8px;text-align:center"><span style="display:inline-block;width:28px;height:28px;border-radius:2px;background:${gc}12;color:${gc};text-align:center;line-height:28px;font-weight:800;font-size:14px;border:1px solid ${gc}30;font-family:'JetBrains Mono',monospace">${e.trustGrade}</span></td>
<td style="padding:10px 8px;text-align:center;color:#fff;font-weight:700;font-family:'JetBrains Mono',monospace">${e.trustScore}</td>
<td style="padding:10px 8px;text-align:center">${bss}</td>
<td style="padding:10px 8px;text-align:center;color:#e8e8e8">${e.resolvedBets}</td>
<td style="padding:10px 8px;text-align:right">${pnl}</td>
</tr>`;
  }).join('') : '';

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>VIGIL — The Trust Engine for Polymarket Geopolitics Traders</title>
<meta name="description" content="Geopolitics is 47% of Polymarket volume. VIGIL grades every forecaster: Brier Skill Score, calibration, bootstrap CI95. Skill-weighted consensus across A/B-graded wallets. See who's actually right, not just loud.">
<meta property="og:title" content="VIGIL — Trust Engine for Polymarket Geopolitics">
<meta property="og:description" content="47% of Polymarket volume is geopolitics. VIGIL grades every wallet with Brier Skill Score + bootstrap CI95. Follow signal, not noise.">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&family=JetBrains+Mono:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;background:#0c0c0c;color:#e8e8e8;line-height:1.7}
body::before{content:'';display:block;width:100%;height:3px;background:linear-gradient(90deg,#00d4aa,#00d4aa 40%,transparent);position:fixed;top:0;left:0;z-index:999}
a{color:#00d4aa;text-decoration:none}a:hover{color:#fff}

.wrap{max-width:920px;margin:0 auto;padding:48px 28px 60px}
.nav{display:flex;justify-content:space-between;align-items:center;margin-bottom:64px;padding-bottom:20px;border-bottom:1px solid #1a1a1a}
.logo{font-size:18px;font-weight:800;color:#fff;letter-spacing:6px;text-transform:uppercase;font-family:'JetBrains Mono','SF Mono',Consolas,monospace}
.nav-links{display:flex;gap:24px;font-size:13px;letter-spacing:1px;text-transform:uppercase}
.nav-links a{color:#555;transition:color .2s}.nav-links a:hover{color:#00d4aa}

.hero{text-align:center;margin-bottom:72px}
.hero h1{font-size:38px;font-weight:700;color:#fff;line-height:1.15;margin-bottom:20px;letter-spacing:-0.5px}
.hero h1 em{font-style:normal;color:#00d4aa}
.hero p{font-size:15px;color:#555;max-width:640px;margin:0 auto 40px;line-height:1.8}

.search-box{max-width:600px;margin:0 auto 20px}
.search-box form{display:flex;gap:8px}
.search-box input{flex:1;padding:16px 20px;border-radius:2px;border:1px solid #1e1e1e;background:#0a0a0a;color:#fff;font-size:13px;outline:none;font-family:'JetBrains Mono','SF Mono',monospace;transition:border-color .2s}
.search-box input:focus{border-color:#00d4aa}
.search-box select{padding:16px 14px;border-radius:2px;border:1px solid #1e1e1e;background:#0f0f0f;color:#e8e8e8;font-size:13px;cursor:pointer}
.search-box button{padding:16px 32px;border-radius:2px;border:1px solid #00d4aa;background:transparent;color:#00d4aa;font-weight:700;cursor:pointer;letter-spacing:2px;text-transform:uppercase;font-family:'JetBrains Mono','SF Mono',monospace;font-size:12px;transition:all .2s}
.search-box button:hover{background:#00d4aa;color:#0c0c0c}

.sec-hdr{font-size:11px;font-weight:700;letter-spacing:4px;text-transform:uppercase;color:#555;margin-bottom:24px;display:flex;align-items:center;gap:12px}
.sec-hdr::after{content:'';flex:1;height:1px;background:#1a1a1a}

.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:20px;margin-bottom:72px}
.card{background:transparent;border:1px solid #1a1a1a;border-radius:2px;padding:32px;transition:all .25s}
.card:hover{border-color:#00d4aa30;background:#0f0f0f}
.card h3{font-size:16px;font-weight:700;color:#fff;margin-bottom:10px;letter-spacing:0.5px}
.card p{font-size:13px;color:#555;margin-bottom:18px;line-height:1.7}
.card .tag{display:inline-block;padding:3px 10px;border-radius:2px;font-size:10px;font-weight:700;margin-right:6px;letter-spacing:1px}
.tag.live{background:#10b98110;color:#10b981;border:1px solid #10b98125}
.tag.chain{background:#3b82f610;color:#3b82f6;border:1px solid #3b82f625}

.moat{background:#0f0f0f;border:1px solid #1a1a1a;border-radius:2px;padding:40px;margin-bottom:72px}
.moat h2{font-size:20px;font-weight:700;color:#fff;margin-bottom:20px;letter-spacing:0.5px}
.moat p{font-size:14px;color:#555;margin-bottom:14px;line-height:1.8}

.dims{display:grid;grid-template-columns:repeat(6,1fr);gap:0;margin-bottom:72px;border:1px solid #1a1a1a;border-radius:2px;overflow:hidden}
.dim{text-align:center;padding:28px 12px;background:#0f0f0f;border-right:1px solid #1a1a1a}
.dim:last-child{border-right:none}
.dim .pct{font-size:26px;font-weight:800;color:#00d4aa;font-family:'JetBrains Mono','SF Mono',monospace;margin-bottom:6px}
.dim .label{font-size:9px;color:#555;text-transform:uppercase;letter-spacing:2px}

.api-sec{margin-bottom:72px}
.api-sec h2{font-size:11px;font-weight:700;color:#555;margin-bottom:20px;letter-spacing:4px;text-transform:uppercase}
.endpoint{background:transparent;border:1px solid #1a1a1a;border-radius:2px;padding:14px 20px;margin-bottom:6px;font-family:'JetBrains Mono','SF Mono',Consolas,monospace;font-size:12px;display:flex;justify-content:space-between;align-items:center;transition:border-color .2s}
.endpoint:hover{border-color:#1e1e1e;background:#0f0f0f}
.endpoint .method{color:#00d4aa;font-weight:700;margin-right:12px}
.endpoint .path{color:#e8e8e8}
.endpoint .desc{color:#444;font-size:11px}

.foot{text-align:center;padding:40px 0;border-top:1px solid #1a1a1a;font-size:11px;color:#333;line-height:2;font-family:'JetBrains Mono','SF Mono',monospace;letter-spacing:1px}
.foot a{color:#444;transition:color .2s}.foot a:hover{color:#00d4aa}
.foot strong{color:#444}
table{border:1px solid #1a1a1a;border-radius:2px;overflow:hidden}
table tr:hover td{background:#14141466}
table td{padding:12px 8px;border-bottom:1px solid #1a1a1a22;transition:background .15s}
table tr:nth-child(even) td{background:#0e0e0e44}
table th{background:#0a0a0a;padding:12px 8px}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.spinner{display:inline-block;width:14px;height:14px;border:2px solid #ffffff40;border-top-color:#fff;border-radius:50%;animation:spin .6s linear infinite;vertical-align:middle}
.pulse{animation:pulse 2s ease-in-out infinite}
@media(max-width:640px){
  .wrap{padding:16px}
  .dims{grid-template-columns:repeat(3,1fr)}
  .dim{border-bottom:1px solid #1a1a1a}
  table{font-size:12px}
  table th,table td{padding:8px 4px}
  .hero h1{font-size:26px}
  .hero p{font-size:13px}
  .cards{grid-template-columns:1fr}
  .card{min-width:auto!important}
  form{flex-direction:column}
  form select,form input,form button{width:100%;border-radius:2px!important}
  .sec-title{font-size:10px}
  .endpoint{flex-direction:column;gap:4px}
  .nav{flex-direction:column;gap:12px;text-align:center}
  .nav-links{flex-wrap:wrap;justify-content:center;gap:12px}
}
</style>
<script>
function doSearch(e) {
  e.preventDefault();
  var q = document.getElementById('q').value.trim();
  if (!q) return;
  var btn = e.target.querySelector('button');
  btn.innerHTML = '<span class="spinner"></span> Scoring...';
  btn.disabled = true;
  if (q.startsWith('0x')) window.location.href = '/polymarket/' + encodeURIComponent(q);
  else window.location.href = '/polymarket/search?q=' + encodeURIComponent(q);
}
function doCompare(e) {
  e.preventDefault();
  var w1 = document.getElementById('cmp1').value.trim();
  var w2 = document.getElementById('cmp2').value.trim();
  if (!w1 || !w2) return;
  window.location.href = '/polymarket/compare?wallets=' + encodeURIComponent(w1) + ',' + encodeURIComponent(w2);
}
function doSubscribe(e) {
  e.preventDefault();
  var email = document.getElementById('subemail').value.trim();
  if (!email) return;
  var btn = document.getElementById('subbtn');
  btn.textContent = '...';
  btn.disabled = true;
  fetch('/subscribe', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:email})})
    .then(function(r){return r.json()})
    .then(function(d){
      document.getElementById('submsg').style.display='block';
      document.getElementById('submsg').textContent=d.message||'Subscribed!';
      btn.textContent='Done';
    })
    .catch(function(){
      document.getElementById('submsg').style.display='block';
      document.getElementById('submsg').style.color='#ef4444';
      document.getElementById('submsg').textContent='Something went wrong. Try again.';
      btn.textContent='Subscribe';
      btn.disabled=false;
    });
}
</script>
</head><body>
<div class="wrap">

<div class="nav">
  <div class="logo">VIGIL</div>
  <div class="nav-links">
    <a href="/polymarket">Score</a>
    <a href="/polymarket/compare">Compare</a>
    <a href="/polymarket/leaderboard">Leaderboard</a>
    <a href="/api/pricing">API</a>
    <a href="/v1">Docs</a>
  </div>
</div>

<div class="hero">
  <div style="display:inline-block;font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#00d4aa;border:1px solid #00d4aa40;padding:4px 10px;border-radius:2px;margin-bottom:18px;font-family:'JetBrains Mono',monospace">GEOPOLITICS · 47% OF POLYMARKET VOLUME</div>
  <h1>The trust engine for <em>Polymarket geopolitics</em> traders</h1>
  <p>Iran peace deal. Strait of Hormuz. BTC $150k. The markets moving billions are geopolitics, and the loudest traders are rarely the most right. VIGIL grades every forecaster with Brier Skill Score + bootstrap 95% CIs. Skill-weighted consensus across A/B wallets — so you follow signal, not noise.</p>
</div>

<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:0;margin-bottom:48px;border:1px solid #1a1a1a;border-radius:2px;overflow:hidden;background:#0a0a0a">
  <div style="text-align:center;padding:28px 16px;border-right:1px solid #1a1a1a"><div style="font-size:28px;font-weight:800;color:#00d4aa;font-family:'JetBrains Mono','SF Mono',monospace;line-height:1">600+</div><div style="font-size:9px;color:#444;text-transform:uppercase;letter-spacing:3px;margin-top:8px">Wallets Scanned</div></div>
  <a href="/polymarket/leaderboard" style="text-align:center;padding:28px 16px;border-right:1px solid #1a1a1a;text-decoration:none;display:block;transition:background .2s" onmouseover="this.style.background='#111'" onmouseout="this.style.background='transparent'"><div style="font-size:28px;font-weight:800;color:#ef4444;font-family:'JetBrains Mono','SF Mono',monospace;line-height:1">${aGradeCount}</div><div style="font-size:9px;color:#444;text-transform:uppercase;letter-spacing:3px;margin-top:8px">A-Grade Found</div></a>
  <a href="/polymarket/leaderboard" style="text-align:center;padding:28px 16px;border-right:1px solid #1a1a1a;text-decoration:none;display:block;transition:background .2s" onmouseover="this.style.background='#111'" onmouseout="this.style.background='transparent'"><div style="font-size:28px;font-weight:800;color:#00d4aa;font-family:'JetBrains Mono','SF Mono',monospace;line-height:1">${bGradeCount}</div><div style="font-size:9px;color:#444;text-transform:uppercase;letter-spacing:3px;margin-top:8px">B-Grade Found</div></a>
  <div style="text-align:center;padding:28px 16px"><div style="font-size:28px;font-weight:800;color:#555;font-family:'JetBrains Mono','SF Mono',monospace;line-height:1">500+</div><div style="font-size:9px;color:#444;text-transform:uppercase;letter-spacing:3px;margin-top:8px">Markets Crawled</div></div>
</div>

<div class="search-box">
  <form onsubmit="doSearch(event)">
    <input type="text" id="q" placeholder="Wallet address (0x...) or username" autocomplete="off" />
    <button type="submit">Score</button>
  </form>
</div>

<div style="max-width:560px;margin:0 auto 48px;text-align:center;background:#0f0f0f;border:1px solid #1e1e1e;border-radius:2px;padding:24px 28px">
  <div style="font-size:10px;font-weight:700;color:#555;text-transform:uppercase;letter-spacing:3px;margin-bottom:8px">GEOPOLITICS ALERT FEED</div>
  <div style="font-size:15px;font-weight:600;color:#fff;margin-bottom:6px">600+ wallets scanned. ${aGradeCount} A-grades found.</div>
  <p style="font-size:13px;color:#555;margin-bottom:14px">Get notified when skilled money diverges from the crowd on Iran, Hormuz, elections, and tail-risk markets.</p>
  <form onsubmit="doSubscribe(event)" style="display:flex;gap:8px">
    <input type="email" id="subemail" placeholder="you@example.com" style="flex:1;padding:12px 16px;border-radius:2px;border:1px solid #2a2a2a;background:#0c0c0c;color:#fff;font-size:13px;outline:none;font-family:'JetBrains Mono','SF Mono',monospace" />
    <button type="submit" id="subbtn" style="padding:12px 20px;border-radius:2px;border:1px solid #00d4aa;background:transparent;color:#00d4aa;font-weight:700;font-size:11px;cursor:pointer;white-space:nowrap;letter-spacing:2px;text-transform:uppercase;font-family:'JetBrains Mono','SF Mono',monospace">ALERT ME</button>
  </form>
  <div id="submsg" style="font-size:13px;margin-top:8px;color:#00d4aa;display:none"></div>
</div>

<div class="cards">
  <div class="card">
    <h3>Score Any Wallet</h3>
    <p>Paste a wallet address or username. Get a 6-dimension trust score in seconds. Calibration, live edge, profitability, consistency, discipline, sample size.</p>
    <span class="tag live">LIVE</span>
    <span class="tag chain">Polygon</span>
  </div>
  <div class="card">
    <h3>Compare Head-to-Head</h3>
    <p>Put two wallets side by side. See who's actually better across every dimension.</p>
    <form onsubmit="doCompare(event)" style="display:flex;gap:6px;margin-top:8px">
      <input type="text" id="cmp1" placeholder="Wallet 1" style="flex:1;padding:8px;border-radius:2px;border:1px solid #2a2a2a;background:#0f0f0f;color:#fff;font-size:11px;font-family:'JetBrains Mono',monospace" />
      <input type="text" id="cmp2" placeholder="Wallet 2" style="flex:1;padding:8px;border-radius:2px;border:1px solid #2a2a2a;background:#0f0f0f;color:#fff;font-size:11px;font-family:'JetBrains Mono',monospace" />
      <button type="submit" style="padding:8px 14px;border-radius:2px;border:1px solid #00d4aa;background:transparent;color:#00d4aa;font-weight:700;font-size:11px;cursor:pointer;font-family:'JetBrains Mono',monospace;letter-spacing:1px">GO</button>
    </form>
    <span class="tag live">LIVE</span>
    <span class="tag chain">Polygon</span>
  </div>
  <div class="card">
    <h3>Chrome Extension</h3>
    <p>See trust score badges directly on Polymarket profile pages. Coming soon to the Chrome Web Store.</p>
    <span class="tag live">COMING SOON</span>
    <span class="tag chain">Browser</span>
  </div>
</div>

<a href="/polymarket/divergence" style="display:block;text-decoration:none;margin-bottom:48px;padding:28px 32px;background:linear-gradient(135deg,#0f0f0f 0%,#141414 100%);border:1px solid #2a2a2a;border-left:3px solid #ef4444;border-radius:2px;transition:border-color .2s,background .2s" onmouseover="this.style.borderColor='#ef4444';this.style.background='#141414'" onmouseout="this.style.borderColor='#2a2a2a';this.style.background='linear-gradient(135deg,#0f0f0f 0%,#141414 100%)'">
  <div style="display:flex;justify-content:space-between;align-items:center;gap:20px;flex-wrap:wrap">
    <div style="flex:1;min-width:260px">
      <div style="font-size:10px;font-weight:700;color:#ef4444;text-transform:uppercase;letter-spacing:3px;margin-bottom:10px">// live · divergence leaderboard</div>
      <div style="font-size:22px;font-weight:800;color:#fff;margin-bottom:6px;letter-spacing:-0.3px">Where the sharp money disagrees with the crowd.</div>
      <p style="font-size:14px;color:#999;margin:0;line-height:1.55">Active Polymarket markets ranked by the gap between <strong style="color:#fff">skill-weighted consensus</strong> (graded wallets only, weighted by calibration × √stake × recency) and the live market price. Updates every 5 minutes.</p>
    </div>
    <div style="display:flex;align-items:center;gap:14px;color:#ef4444;font-weight:700;font-family:'JetBrains Mono','SF Mono',monospace;font-size:13px;letter-spacing:2px;text-transform:uppercase;white-space:nowrap">See Rankings →</div>
  </div>
</a>

${skillTop10Rows.length > 0 ? `<div class="card" style="overflow-x:auto;margin-bottom:48px;background:#0a0a0a;border-color:#1e1e1e">
  <div class="sec-hdr">VIGIL Elite — A & B Grade Wallets</div>
  <p style="font-size:14px;color:#707070;margin-bottom:16px">The only wallets that scored A or B out of 600+ scanned. These traders show real forecasting skill — not luck, not speed, not size. <a href="/polymarket/leaderboard" style="color:#00d4aa">Full leaderboard →</a></p>
  <table style="width:100%;border-collapse:collapse;font-size:14px">
  <tr style="border-bottom:2px solid #1e1e1e">
    <th style="text-align:left;padding:8px 6px;color:#555;font-size:10px;text-transform:uppercase;letter-spacing:2px;font-family:'JetBrains Mono',monospace">#</th>
    <th style="text-align:left;padding:8px 6px;color:#555;font-size:10px;text-transform:uppercase;letter-spacing:2px;font-family:'JetBrains Mono',monospace">Trader</th>
    <th style="text-align:center;padding:8px 6px;color:#555;font-size:10px;text-transform:uppercase;letter-spacing:2px;font-family:'JetBrains Mono',monospace">Grade</th>
    <th style="text-align:center;padding:8px 6px;color:#555;font-size:10px;text-transform:uppercase;letter-spacing:2px;font-family:'JetBrains Mono',monospace">Score</th>
    <th style="text-align:center;padding:8px 6px;color:#555;font-size:10px;text-transform:uppercase;letter-spacing:2px;font-family:'JetBrains Mono',monospace">BSS</th>
    <th style="text-align:center;padding:8px 6px;color:#555;font-size:10px;text-transform:uppercase;letter-spacing:2px;font-family:'JetBrains Mono',monospace">Resolved</th>
    <th style="text-align:right;padding:8px 6px;color:#555;font-size:10px;text-transform:uppercase;letter-spacing:2px;font-family:'JetBrains Mono',monospace">PnL</th>
  </tr>
  ${skillTop10Rows}
  </table>
</div>` : ''}

<div style="display:grid;grid-template-columns:1fr;gap:20px;margin-bottom:56px">

<div class="card" style="overflow-x:auto">
  <div class="sec-hdr">Polymarket Top 10 by PnL — VIGIL Scored</div>
  <p style="font-size:14px;color:#707070;margin-bottom:16px">These are the highest-earning wallets on Polymarket by all-time PnL. Nine of ten graded D or F. All ten score negative Brier Skill — worse than predicting the base rate every time. Grades update automatically.</p>
  <table style="width:100%;border-collapse:collapse;font-size:14px">
  <tr style="border-bottom:1px solid #1e1e1e">
    <th style="text-align:left;padding:8px 6px;color:#555;font-size:11px;text-transform:uppercase">#</th>
    <th style="text-align:left;padding:8px 6px;color:#555;font-size:11px;text-transform:uppercase">Trader</th>
    <th style="text-align:left;padding:8px 6px;color:#555;font-size:11px;text-transform:uppercase">PnL</th>
    <th style="text-align:left;padding:8px 6px;color:#555;font-size:11px;text-transform:uppercase">Grade</th>
    <th style="text-align:left;padding:8px 6px;color:#555;font-size:11px;text-transform:uppercase">Score</th>
    <th style="text-align:left;padding:8px 6px;color:#555;font-size:11px;text-transform:uppercase">BSS</th>
    <th style="text-align:left;padding:8px 6px;color:#555;font-size:11px;text-transform:uppercase">Win</th>
    <th style="text-align:left;padding:8px 6px;color:#555;font-size:11px;text-transform:uppercase">Resolved</th>
  </tr>
  ${leaderboardRows}
  </table>
</div>

${recentRows.length > 0 ? `<div class="card">
  <div class="sec-hdr">Recently Scored</div>
  <table style="width:100%;border-collapse:collapse;font-size:14px">
  <tr style="border-bottom:1px solid #1e1e1e">
    <th style="text-align:left;padding:8px 6px;color:#555;font-size:11px;text-transform:uppercase">Trader</th>
    <th style="text-align:left;padding:8px 6px;color:#555;font-size:11px;text-transform:uppercase">PnL</th>
    <th style="text-align:left;padding:8px 6px;color:#555;font-size:11px;text-transform:uppercase">Grade</th>
    <th style="text-align:left;padding:8px 6px;color:#555;font-size:11px;text-transform:uppercase">Score</th>
    <th style="text-align:left;padding:8px 6px;color:#555;font-size:11px;text-transform:uppercase">When</th>
  </tr>
  ${recentRows}
  </table>
</div>` : ''}

</div>

<div class="moat">
  <div class="sec-hdr" style="margin-bottom:20px">What Makes VIGIL Different</div>
  <p>14 of the top 20 most profitable wallets on prediction market leaderboards are bots running structural arbitrage. Raw PnL doesn't tell you if someone can actually predict the future — it tells you if they're fast.</p>
  <p>VIGIL is the first system that answers the real question: <strong style="color:#fff">when a trader buys at $0.70, implying 70% confidence, does the event actually happen 70% of the time?</strong> That's calibration — and nobody else computes it.</p>
  <p>Every score is backed by on-chain verification from Base and Polygon. Wallet age, transaction count, USDC flow cross-checks, protocol fingerprinting. We don't trust what APIs report — we verify it against the blockchain.</p>
</div>

<div class="dims">
  <div class="dim"><div class="pct">25%</div><div class="label">Calibration</div></div>
  <div class="dim"><div class="pct">25%</div><div class="label">Live Edge</div></div>
  <div class="dim"><div class="pct">15%</div><div class="label">Profitability</div></div>
  <div class="dim"><div class="pct">15%</div><div class="label">Consistency</div></div>
  <div class="dim"><div class="pct">10%</div><div class="label">Discipline</div></div>
  <div class="dim"><div class="pct">10%</div><div class="label">Sample Size</div></div>
</div>

<div class="card" style="margin-bottom:48px;background:#0f0f0f">
  <div class="sec-hdr" style="margin-bottom:20px">Grade Scale</div>
  <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:0;margin-bottom:24px;border:1px solid #1a1a1a;border-radius:2px;overflow:hidden">
    <div style="text-align:center;padding:20px 8px;border-right:1px solid #1a1a1a"><div style="font-size:32px;font-weight:800;color:#22c55e;font-family:'JetBrains Mono',monospace;line-height:1">A</div><div style="font-size:10px;color:#444;margin-top:6px;font-family:'JetBrains Mono',monospace">80-100</div><div style="font-size:11px;color:#555;margin-top:6px;line-height:1.4">Elite forecaster</div></div>
    <div style="text-align:center;padding:20px 8px;border-right:1px solid #1a1a1a"><div style="font-size:32px;font-weight:800;color:#00d4aa;font-family:'JetBrains Mono',monospace;line-height:1">B</div><div style="font-size:10px;color:#444;margin-top:6px;font-family:'JetBrains Mono',monospace">65-79</div><div style="font-size:11px;color:#555;margin-top:6px;line-height:1.4">Skilled trader</div></div>
    <div style="text-align:center;padding:20px 8px;border-right:1px solid #1a1a1a"><div style="font-size:32px;font-weight:800;color:#f59e0b;font-family:'JetBrains Mono',monospace;line-height:1">C</div><div style="font-size:10px;color:#444;margin-top:6px;font-family:'JetBrains Mono',monospace">50-64</div><div style="font-size:11px;color:#555;margin-top:6px;line-height:1.4">Average signal</div></div>
    <div style="text-align:center;padding:20px 8px;border-right:1px solid #1a1a1a"><div style="font-size:32px;font-weight:800;color:#ef4444;font-family:'JetBrains Mono',monospace;line-height:1">D</div><div style="font-size:10px;color:#444;margin-top:6px;font-family:'JetBrains Mono',monospace">35-49</div><div style="font-size:11px;color:#555;margin-top:6px;line-height:1.4">Below average</div></div>
    <div style="text-align:center;padding:20px 8px"><div style="font-size:32px;font-weight:800;color:#991b1b;font-family:'JetBrains Mono',monospace;line-height:1">F</div><div style="font-size:10px;color:#444;margin-top:6px;font-family:'JetBrains Mono',monospace">0-34</div><div style="font-size:11px;color:#555;margin-top:6px;line-height:1.4">No skill signal</div></div>
  </div>
  <div style="font-size:13px;color:#555;line-height:1.7">
    <p style="margin-bottom:8px"><strong style="color:#707070">Confidence intervals</strong> tell you how reliable the grade is. A score of D/47 ± 3 (high confidence) means we're confident the true score is between 44 and 50 — there's enough data (200+ resolved bets) to be sure. A score of D/47 ± 25 (very low confidence) means the true score could be anywhere from 22 to 72 — take it with a grain of salt.</p>
    <p style="margin-bottom:8px"><strong style="color:#707070">Brier Skill Score (BSS)</strong> compares a trader against a strategy that just predicts the historical average every time. Positive BSS = better than guessing. Negative BSS = worse than guessing. A BSS of -149% means they perform 2.5x worse than if they'd just said "50/50" on everything.</p>
    <p><strong style="color:#707070">How we score:</strong> Same methodology that IARPA used to identify superforecasters — Brier Score Decomposition (Murphy 1973), Log Loss for rare-event sensitivity, and on-chain USDC verification against Polygon. We measure whether traders can actually predict the future, not whether they're fast or lucky.</p>
  </div>
</div>

<div class="api-sec">
  <div class="sec-hdr">API Endpoints</div>
  <div class="endpoint"><div><span class="method">GET</span><span class="path">/v1/polymarket/:wallet</span></div><span class="desc">Trust score + calibration for any Polymarket trader</span></div>
  <div class="endpoint"><div><span class="method">GET</span><span class="path">/polymarket/:wallet</span></div><span class="desc">Visual HTML scorecard</span></div>
  <div class="endpoint"><div><span class="method">GET</span><span class="path">/polymarket/compare</span></div><span class="desc">Compare two wallets head-to-head</span></div>
  <div class="endpoint"><div><span class="method">GET</span><span class="path">/polymarket/leaderboard</span></div><span class="desc">Skill leaderboard — top wallets by forecasting ability</span></div>
  <div class="endpoint"><div><span class="method">GET</span><span class="path">/v1/polymarket/leaderboard/skill</span></div><span class="desc">JSON: Skill-ranked leaderboard</span></div>
  <div class="endpoint"><div><span class="method">POST</span><span class="path">/v1/polymarket/discover/crawl</span></div><span class="desc">Trigger wallet discovery crawl</span></div>
  <div class="endpoint"><div><span class="method">GET</span><span class="path">/v1/onchain/:wallet</span></div><span class="desc">On-chain wallet provenance (Base + Polygon)</span></div>
  <div class="endpoint"><div><span class="method">GET</span><span class="path">/api/pricing</span></div><span class="desc">API pricing and rate limits</span></div>
  <div class="endpoint"><div><span class="method">POST</span><span class="path">/v1/api/keys/create</span></div><span class="desc">Create API key for programmatic access</span></div>
  <div class="endpoint"><div><span class="method">GET</span><span class="path">/v1/health</span></div><span class="desc">Service health + system status</span></div>
</div>

<div class="foot">
  <strong>Not financial advice.</strong> VIGIL Trust Score is informational only. Scores may change as new data becomes available.<br/>
  Past performance does not guarantee future results. Always do your own research.<br/>
  Built by Freedom United Works &middot; v1.18.0 &middot; <a href="/privacy">Privacy Policy</a>
</div>

</div>
</body></html>`;
}

start().catch(err => {
  console.error('[FATAL] Failed to start server:', err);
  process.exit(1);
});

export default app;
