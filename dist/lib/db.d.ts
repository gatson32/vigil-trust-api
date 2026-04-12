import pg from 'pg';
export declare function isDbConnected(): boolean;
export declare function getPool(): pg.Pool | null;
/**
 * Initialize the database connection and run migrations.
 * Safe to call multiple times — idempotent.
 */
export declare function initDb(): Promise<boolean>;
/**
 * Gracefully shut down the connection pool.
 */
export declare function closeDb(): Promise<void>;
/**
 * Execute a query against the pool. Returns null if DB is not connected.
 */
export declare function query<T extends pg.QueryResultRow = any>(text: string, params?: unknown[]): Promise<pg.QueryResult<T> | null>;
