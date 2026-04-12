/**
 * VIGIL × DegenClaw — Risk Scoring Adapter
 *
 * Pulls live data from the DegenClaw Arena leaderboard and trader API,
 * computes a VIGIL-native risk score for each agent trading Hyperliquid
 * perps, and exposes it as both HTTP JSON and a public score card.
 *
 * Angle: DegenClaw's own AI Council ranks agents by expected return
 * (composite score). VIGIL ranks them by downside risk — "will this
 * agent blow up?" Different product, different buyer (backers vs. grants).
 *
 * Data sources:
 *   - https://degen.virtuals.io/api/leaderboard   (public, no auth)
 *   - https://dgclaw-trader.virtuals.io/users/:w  (public, no auth)
 *   - https://acpx.virtuals.io/api/agents/:id     (public, no auth)
 */
export interface DegenClawAgent {
    id: string;
    name: string;
    tokenSymbol: string | null;
    agentAddress: string;
    subscriptionPrice?: number;
    performance: {
        totalRealizedPnl: number;
        perpRealizedPnl: number;
        spotRealizedPnl: number;
        avgRoe: number;
        winRate: number;
        profitFactor: number;
        sortinoRatio: number;
        compositeScore: number;
        rank: number;
        totalTradeCount: number;
        winCount: number;
        lossCount: number;
        totalTradeVolume: number;
        closedPositionCount: number;
        qualified?: boolean;
    };
    acpAgent?: {
        walletAddress: string;
        id?: string | number;
    };
}
export interface DegenClawAccount {
    balance: number;
    withdrawable: number;
    marginUsed: number;
}
export interface DegenClawPosition {
    asset: string;
    size: number;
    entryPrice: number;
    markPrice: number;
    unrealizedPnl: number;
    leverage: number;
    liquidationPrice: number | null;
    side: 'LONG' | 'SHORT';
}
export interface DegenClawTrade {
    timestamp: number;
    asset: string;
    side: 'BUY' | 'SELL';
    size: number;
    price: number;
    fee: number;
    closedPnl: number | null;
    leverage: number | null;
}
export interface DegenClawRiskReport {
    agentId: string;
    agentName: string;
    tokenSymbol: string | null;
    wallet: string;
    leaderboardRank: number;
    raw: {
        totalRealizedPnl: number;
        avgRoe: number;
        winRate: number;
        profitFactor: number;
        sortinoRatio: number;
        totalTradeCount: number;
        totalTradeVolume: number;
    };
    profitability: number;
    consistency: number;
    discipline: number;
    capitalRisk: number;
    sampleSize: number;
    trustScore: number;
    trustGrade: 'A' | 'B' | 'C' | 'D' | 'F';
    trustTier: 'SHARP' | 'SOLID' | 'DEVELOPING' | 'RISKY' | 'DANGER' | 'UNPROVEN';
    reasoning: string[];
    flags: string[];
    greenFlags: string[];
    scoredAt: string;
    dataSource: 'degenclaw-leaderboard-v1';
    disclaimer: string;
}
/**
 * Fetch the full DegenClaw leaderboard (top 1000). Cached 60s.
 */
export declare function fetchLeaderboard(): Promise<DegenClawAgent[]>;
/**
 * Find a DegenClaw agent by name (case-insensitive), id, or wallet address.
 */
export declare function findAgent(query: string): Promise<DegenClawAgent | null>;
/**
 * Fetch live account state for a DegenClaw wallet.
 * Used for deeper scoring / open position analysis.
 */
export declare function fetchAccount(wallet: string): Promise<DegenClawAccount | null>;
/**
 * Fetch open positions for a DegenClaw wallet.
 */
export declare function fetchPositions(wallet: string): Promise<DegenClawPosition[]>;
/**
 * Compute a VIGIL risk score for a DegenClaw agent from leaderboard data.
 *
 * Dimensions (each 0-100, higher = better):
 *   - profitability    : raw PnL + ROE. Rewards winners.
 *   - consistency      : Sortino ratio + stability of returns.
 *   - discipline       : win rate + profit factor. Rewards process.
 *   - capitalRisk      : 100 = safe, 0 = likely to blow up.
 *                         Based on loss chain exposure, ROE tail, trade frequency.
 *   - sampleSize       : 100 = long track record, 0 = barely traded.
 *
 * Trust score = weighted blend with a STRONG penalty for low sample size.
 * We refuse to issue a confident grade on fewer than 10 closed trades.
 */
export declare function scoreDegenClawAgent(agent: DegenClawAgent): DegenClawRiskReport;
/**
 * One-shot: resolve query → agent → score. Used by the HTTP endpoint.
 */
export declare function scoreByQuery(query: string): Promise<DegenClawRiskReport | null>;
/**
 * Score every agent on the leaderboard. Used by the bulk endpoint
 * and by launch tweet generation.
 */
export declare function scoreAllAgents(): Promise<DegenClawRiskReport[]>;
