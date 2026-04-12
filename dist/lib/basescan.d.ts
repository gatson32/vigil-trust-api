export declare const CHAINS: {
    readonly BASE: {
        readonly id: 8453;
        readonly name: "Base";
        readonly usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
    };
    readonly POLYGON: {
        readonly id: 137;
        readonly name: "Polygon";
        readonly usdc: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359";
    };
};
export type ChainKey = keyof typeof CHAINS;
export interface WalletProvenance {
    wallet: string;
    chainId: number;
    firstTxTimestamp: number;
    firstTxDate: string;
    walletAgeDays: number;
    totalTransactions: number;
    uniqueCounterparties: number;
    inboundTxCount: number;
    outboundTxCount: number;
    totalEthReceived: string;
    totalEthSent: string;
    netEthFlow: string;
    usdcTransfers: number;
    totalUsdcIn: number;
    totalUsdcOut: number;
    protocolsUsed: string[];
    uniqueContractsInteracted: number;
    contractInteractions: number;
    botScore: number;
    washTradingScore: number;
    topCounterpartyConcentration: number;
    medianTxIntervalSec: number;
    burstTxCount: number;
    provenanceScore: number;
    provenanceGrade: 'A' | 'B' | 'C' | 'D' | 'F';
    flags: string[];
    greenFlags: string[];
    fetchedAt: string;
    dataSource: 'basescan-v2';
}
export interface BasescanTx {
    hash: string;
    from: string;
    to: string;
    value: string;
    timeStamp: string;
    isError: string;
    functionName: string;
    contractAddress: string;
    input: string;
}
export interface BasescanTokenTx {
    hash: string;
    from: string;
    to: string;
    value: string;
    tokenName: string;
    tokenSymbol: string;
    tokenDecimal: string;
    contractAddress: string;
    timeStamp: string;
}
/**
 * Fetch normal transactions for a wallet on Base.
 * Returns up to 1000 most recent transactions.
 */
export declare function fetchTransactions(wallet: string, chainId?: number): Promise<BasescanTx[]>;
/**
 * Fetch ERC-20 token transfers for a wallet.
 */
export declare function fetchTokenTransfers(wallet: string, chainId?: number): Promise<BasescanTokenTx[]>;
/**
 * Fetch native token balance for a wallet.
 */
export declare function fetchBalance(wallet: string, chainId?: number): Promise<string>;
/**
 * Compute full wallet provenance from on-chain data.
 * This is the VERIFICATION LAYER — ground truth that can't be faked.
 */
export declare function getWalletProvenance(wallet: string, chainId?: number): Promise<WalletProvenance | null>;
/**
 * Check if Basescan API is configured and available.
 */
export declare function isBasescanConfigured(): boolean;
/**
 * Quick sybil check: wallet age < 7 days AND < 5 txs = likely sybil.
 * Returns null if Basescan is not configured (graceful skip).
 */
export declare function quickSybilCheck(wallet: string): Promise<{
    isSuspicious: boolean;
    reason: string | null;
    ageDays: number;
    txCount: number;
} | null>;
