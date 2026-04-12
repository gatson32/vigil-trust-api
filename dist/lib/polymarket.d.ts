import { type WalletProvenance } from './basescan.js';
export interface PolymarketTrade {
    proxyWallet: string;
    side: 'BUY' | 'SELL';
    asset: string;
    conditionId: string;
    size: number;
    price: number;
    usdcSize?: number;
    timestamp: number;
    title: string;
    slug: string;
    outcome: string;
    outcomeIndex: number;
    name?: string;
    pseudonym?: string;
    transactionHash: string;
}
export interface PolymarketPosition {
    proxyWallet: string;
    asset: string;
    conditionId: string;
    size: number;
    avgPrice: number;
    initialValue: number;
    currentValue: number;
    cashPnl: number;
    percentPnl: number;
    realizedPnl: number;
    percentRealizedPnl: number;
    curPrice: number;
    redeemable: boolean;
    title: string;
    slug: string;
    outcome: string;
    outcomeIndex: number;
    endDate: string;
}
/** A single calibration bucket (e.g. bets in the 0.60-0.70 range) */
export interface CalibrationBucket {
    range: string;
    midpoint: number;
    totalBets: number;
    correctBets: number;
    actualRate: number;
    expectedRate: number;
    error: number;
}
/** Full calibration analysis — the proprietary scoring layer */
export interface CalibrationReport {
    buckets: CalibrationBucket[];
    brierScore: number;
    calibrationError: number;
    resolvedBets: number;
    overconfidenceBias: number;
    skillDecomposition: {
        skill: number;
        luck: number;
        edge: number;
    };
    brierDecomposition: {
        calibration: number;
        resolution: number;
        uncertainty: number;
    };
    brierSkillScore: number;
    logLoss: number;
    logLossSkill: number;
    timeliness: {
        avgDaysBeforeResolution: number;
        earlyMoverPct: number;
        timelinessScore: number;
    };
}
/** VIGIL trust report for a Polymarket trader */
export interface PolymarketRiskReport {
    wallet: string;
    displayName: string;
    pseudonym: string;
    raw: {
        totalTrades: number;
        totalVolume: number;
        totalPnl: number;
        realizedPnl: number;
        unrealizedPnl: number;
        winRate: number;
        openPositions: number;
        resolvedBets: number;
        uniqueMarkets: number;
    };
    calibration: number;
    profitability: number;
    consistency: number;
    discipline: number;
    sampleSize: number;
    liveEdge: number;
    trustScore: number;
    trustGrade: 'A' | 'B' | 'C' | 'D' | 'F';
    trustTier: 'SHARP' | 'SOLID' | 'DEVELOPING' | 'RISKY' | 'DANGER' | 'UNPROVEN';
    confidence: {
        level: 'high' | 'medium' | 'low' | 'very_low';
        margin: number;
        resolvedBets: number;
        description: string;
    };
    calibrationReport: CalibrationReport;
    reasoning: string[];
    flags: string[];
    greenFlags: string[];
    onChain: {
        verified: boolean;
        provenance: WalletProvenance | null;
        pnlDivergence: number | null;
        pnlVerified: boolean;
    } | null;
    scoredAt: string;
    dataSource: 'polymarket-v1';
    disclaimer: string;
}
/**
 * Fetch all trades for a wallet. Paginates automatically.
 * Caps at 2000 trades to stay reasonable.
 */
export declare function fetchTrades(wallet: string, maxTrades?: number): Promise<PolymarketTrade[]>;
/**
 * Fetch current (open) positions for a wallet.
 */
export declare function fetchPositions(wallet: string): Promise<PolymarketPosition[]>;
/**
 * Fetch ALL positions (open + redeemed) for calibration.
 * Positions with curPrice > 0.95 or < 0.05 are effectively resolved.
 * This is far more reliable than cross-referencing the gamma API,
 * because it directly reflects the trader's actual bets and outcomes.
 */
export declare function fetchAllPositions(wallet: string): Promise<PolymarketPosition[]>;
export declare function scorePolymarketTrader(wallet: string): Promise<PolymarketRiskReport | null>;
/** Summary of a discovered wallet before full scoring */
export interface DiscoveredWallet {
    wallet: string;
    marketsTraded: number;
    firstSeen: string;
}
/** A scored wallet in the skill leaderboard */
export interface LeaderboardEntry {
    wallet: string;
    displayName: string;
    trustScore: number;
    trustGrade: string;
    brierSkillScore: number;
    calibrationError: number;
    resolvedBets: number;
    winRate: number;
    realizedPnl: number;
    scoredAt: string;
}
/** Get current skill leaderboard */
export declare function getSkillLeaderboard(): LeaderboardEntry[];
/** Get crawler status */
export declare function getCrawlerStatus(): {
    discoveredWallets: number;
    leaderboardSize: number;
    lastCrawl: string | null;
    crawlInProgress: boolean;
};
/**
 * Phase 1: Crawl resolved markets from Gamma API and collect unique wallet addresses.
 * Scans the top N resolved markets by volume, pulls trades from each, deduplicates wallets.
 *
 * @param maxMarkets - how many resolved markets to scan (default 100)
 * @param minVolume - minimum market volume to consider (filters noise)
 */
export declare function crawlResolvedMarkets(maxMarkets?: number, minVolume?: number): Promise<Map<string, DiscoveredWallet>>;
/**
 * Phase 2: Score discovered wallets and build the skill leaderboard.
 * Only scores wallets seen in 3+ resolved markets (likely to have enough data).
 * Filters for positive BSS and decent calibration to surface genuinely skilled traders.
 *
 * @param maxToScore - how many wallets to attempt scoring (default 200)
 * @param minMarketsTraded - minimum resolved markets a wallet must appear in (default 3)
 */
export declare function buildSkillLeaderboard(maxToScore?: number, minMarketsTraded?: number): Promise<LeaderboardEntry[]>;
/**
 * Full crawl pipeline: discover wallets → score → build leaderboard.
 * Designed to run as a background job (cron or manual trigger).
 */
export declare function runDiscoveryCrawl(options?: {
    maxMarkets?: number;
    minVolume?: number;
    maxToScore?: number;
    minMarketsTraded?: number;
}): Promise<{
    status: string;
    discovered: number;
    scored: number;
    topGrade: string | null;
}>;
