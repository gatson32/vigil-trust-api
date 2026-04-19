// VIGIL — PostgreSQL Database Connection & Schema Manager
// Provides persistent storage for history, sybil graph, and regression data
// Falls back gracefully to in-memory when DATABASE_URL is not set

import pg from 'pg';
const { Pool } = pg;

// ─── Connection ────────────────────────────────────────────────────

let pool: pg.Pool | null = null;
let dbReady = false;

export function isDbConnected(): boolean {
  return dbReady;
}

export function getPool(): pg.Pool | null {
  return pool;
}

/**
 * Initialize the database connection and run migrations.
 * Safe to call multiple times — idempotent.
 */
export async function initDb(): Promise<boolean> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log('[DB] No DATABASE_URL set — running in memory-only mode');
    return false;
  }

  try {
    pool = new Pool({
      connectionString: url,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      ssl: url.includes('render.com') || url.includes('neon.tech') || url.includes('supabase')
        ? { rejectUnauthorized: false }
        : undefined,
    });

    // Test connection
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();

    console.log('[DB] PostgreSQL connected');

    // Run migrations
    await runMigrations();
    dbReady = true;
    console.log('[DB] Migrations complete — persistent storage active');
    return true;
  } catch (err) {
    console.error('[DB] Failed to connect to PostgreSQL:', (err as Error).message);
    console.log('[DB] Falling back to in-memory storage');
    pool = null;
    dbReady = false;
    return false;
  }
}

/**
 * Gracefully shut down the connection pool.
 */
export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    dbReady = false;
    console.log('[DB] Connection pool closed');
  }
}

// ─── Schema Migrations ─────────────────────────────────────────────

async function runMigrations(): Promise<void> {
  if (!pool) return;

  await pool.query(`
    -- Score history snapshots
    CREATE TABLE IF NOT EXISTS score_snapshots (
      id              BIGSERIAL PRIMARY KEY,
      wallet_address  TEXT NOT NULL,
      agent_name      TEXT NOT NULL DEFAULT '',
      trust_score     REAL NOT NULL,
      trust_tier      TEXT NOT NULL DEFAULT '',
      reliability     REAL NOT NULL DEFAULT 0,
      activity        REAL NOT NULL DEFAULT 0,
      economic        REAL NOT NULL DEFAULT 0,
      reputation      REAL NOT NULL DEFAULT 0,
      longevity       REAL NOT NULL DEFAULT 0,
      behavioral      REAL NOT NULL DEFAULT 0,
      complexity      REAL NOT NULL DEFAULT 0,
      sustainability  REAL NOT NULL DEFAULT 0,
      sybil_risk      REAL NOT NULL DEFAULT 0,
      regression      REAL NOT NULL DEFAULT 0,
      risk_flags      TEXT[] NOT NULL DEFAULT '{}',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_wallet
      ON score_snapshots (wallet_address, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_snapshots_created
      ON score_snapshots (created_at DESC);

    -- Agent metadata (first/last seen, name)
    CREATE TABLE IF NOT EXISTS agents (
      wallet_address  TEXT PRIMARY KEY,
      agent_name      TEXT NOT NULL DEFAULT '',
      first_seen      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_updated    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Sybil transaction graph edges
    CREATE TABLE IF NOT EXISTS sybil_edges (
      id              BIGSERIAL PRIMARY KEY,
      from_wallet     TEXT NOT NULL,
      to_wallet       TEXT NOT NULL,
      tx_count        INTEGER NOT NULL DEFAULT 1,
      total_value     REAL NOT NULL DEFAULT 0,
      avg_spread      REAL NOT NULL DEFAULT 0,
      first_seen      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (from_wallet, to_wallet)
    );

    CREATE INDEX IF NOT EXISTS idx_sybil_from
      ON sybil_edges (from_wallet);

    CREATE INDEX IF NOT EXISTS idx_sybil_to
      ON sybil_edges (to_wallet);

    -- Regression performance snapshots
    CREATE TABLE IF NOT EXISTS regression_snapshots (
      id              BIGSERIAL PRIMARY KEY,
      wallet_address  TEXT NOT NULL,
      trust_score     REAL NOT NULL,
      success_rate    REAL NOT NULL DEFAULT 0,
      activity_score  REAL NOT NULL DEFAULT 0,
      reliability     REAL NOT NULL DEFAULT 0,
      tx_volume       INTEGER NOT NULL DEFAULT 0,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_regression_wallet
      ON regression_snapshots (wallet_address, created_at DESC);

    -- Sybil scan results cache
    CREATE TABLE IF NOT EXISTS sybil_scan_results (
      id                  BIGSERIAL PRIMARY KEY,
      wallet_address      TEXT NOT NULL,
      agent_name          TEXT NOT NULL DEFAULT '',
      sybil_risk_score    REAL NOT NULL DEFAULT 0,
      collusion_detected  BOOLEAN NOT NULL DEFAULT FALSE,
      quarantine_rec      BOOLEAN NOT NULL DEFAULT FALSE,
      flags_json          JSONB NOT NULL DEFAULT '[]',
      cluster_ids         TEXT[] NOT NULL DEFAULT '{}',
      network_metrics     JSONB NOT NULL DEFAULT '{}',
      scanned_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_sybil_scan_wallet
      ON sybil_scan_results (wallet_address);

    CREATE INDEX IF NOT EXISTS idx_sybil_scan_risk
      ON sybil_scan_results (sybil_risk_score DESC);

    -- ─── MOAT LAYER ──────────────────────────────────────────────
    -- Daily(ish) snapshots of every DegenClaw agent's VIGIL grade.
    -- Every row is a permanent entry in the time-series moat.
    -- A competitor entering later CAN'T backfill this.
    CREATE TABLE IF NOT EXISTS degenclaw_snapshots (
      id              BIGSERIAL PRIMARY KEY,
      agent_name      TEXT NOT NULL,
      wallet_address  TEXT NOT NULL DEFAULT '',
      dc_rank         INTEGER,
      trust_grade     TEXT NOT NULL,
      trust_score     REAL NOT NULL,
      trust_tier      TEXT NOT NULL,
      profitability   REAL NOT NULL DEFAULT 0,
      consistency     REAL NOT NULL DEFAULT 0,
      discipline      REAL NOT NULL DEFAULT 0,
      capital_risk    REAL NOT NULL DEFAULT 0,
      sample_size     REAL NOT NULL DEFAULT 0,
      pnl             REAL NOT NULL DEFAULT 0,
      win_rate        REAL NOT NULL DEFAULT 0,
      sortino_raw     REAL NOT NULL DEFAULT 0,
      sortino_clamped REAL NOT NULL DEFAULT 0,
      profit_factor   REAL NOT NULL DEFAULT 0,
      trade_count     INTEGER NOT NULL DEFAULT 0,
      volume          REAL NOT NULL DEFAULT 0,
      signals         JSONB NOT NULL DEFAULT '[]',
      raw             JSONB NOT NULL DEFAULT '{}',
      captured_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_dc_snap_agent
      ON degenclaw_snapshots (agent_name, captured_at DESC);

    CREATE INDEX IF NOT EXISTS idx_dc_snap_captured
      ON degenclaw_snapshots (captured_at DESC);

    CREATE INDEX IF NOT EXISTS idx_dc_snap_wallet
      ON degenclaw_snapshots (wallet_address, captured_at DESC);

    -- Cross-venue identity graph — links the same agent across
    -- different trading venues / social handles / wallets.
    CREATE TABLE IF NOT EXISTS agent_identities (
      id              BIGSERIAL PRIMARY KEY,
      canonical_id    TEXT NOT NULL,
      venue           TEXT NOT NULL,
      venue_id        TEXT NOT NULL,
      display_name    TEXT NOT NULL DEFAULT '',
      wallet_address  TEXT NOT NULL DEFAULT '',
      socials         JSONB NOT NULL DEFAULT '{}',
      first_linked    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_confirmed  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (venue, venue_id)
    );

    CREATE INDEX IF NOT EXISTS idx_agent_identity_canonical
      ON agent_identities (canonical_id);

    CREATE TABLE IF NOT EXISTS email_subscribers (
      id            SERIAL PRIMARY KEY,
      email         TEXT NOT NULL UNIQUE,
      subscribed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      alert_type    TEXT NOT NULL DEFAULT 'a_grade'
    );

    CREATE TABLE IF NOT EXISTS discovery_alerts (
      id            SERIAL PRIMARY KEY,
      wallet        TEXT NOT NULL,
      display_name  TEXT,
      trust_grade   TEXT NOT NULL,
      trust_score   INTEGER NOT NULL,
      brier_skill   REAL,
      resolved_bets INTEGER,
      discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS leaderboard_cache (
      wallet        TEXT PRIMARY KEY,
      display_name  TEXT,
      trust_grade   TEXT NOT NULL,
      trust_score   INTEGER NOT NULL,
      brier_skill   REAL,
      calibration_error REAL,
      resolved_bets INTEGER,
      realized_pnl  REAL,
      scored_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_leaderboard_score
      ON leaderboard_cache (trust_score DESC);
  `);
}

// ─── Query Helpers ─────────────────────────────────────────────────

/**
 * Execute a query against the pool. Returns null if DB is not connected.
 */
export async function query<T extends pg.QueryResultRow = any>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T> | null> {
  if (!pool || !dbReady) return null;
  try {
    return await pool.query<T>(text, params);
  } catch (err) {
    console.error('[DB] Query error:', (err as Error).message);
    return null;
  }
}
