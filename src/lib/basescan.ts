// VIGIL — Multi-Chain On-Chain Verification Layer
// Ground truth from Base + Polygon. No API middleman can fake this.
//
// What this provides that NOBODY else has in our space:
//   1. Wallet provenance — age, tx count, unique counterparties
//   2. On-chain PnL verification — cross-check API-reported PnL against real USDC transfers
//   3. Contract interaction fingerprint — what protocols has this wallet touched?
//   4. Sybil detection — fresh wallets with few txs get flagged
//
// Uses Etherscan V2 API: chainid=8453 (Base), chainid=137 (Polygon)

import { TTLCache } from './cache.js';

const ETHERSCAN_V2 = 'https://api.etherscan.io/v2/api';
const USER_AGENT = 'VIGIL-Trust/1.17.0';

// Supported chains
export const CHAINS = {
  BASE: { id: 8453, name: 'Base', usdc: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' },
  POLYGON: { id: 137, name: 'Polygon', usdc: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359' }, // native USDC on Polygon
} as const;

export type ChainKey = keyof typeof CHAINS;

// Known contract addresses — Base
const BASE_PROTOCOLS: Record<string, string> = {
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 'USDC',
  '0x4200000000000000000000000000000000000006': 'WETH',
  '0x940181a94a35a4569e4529a3cdfb74e38fd98631': 'Aerodrome',
  '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43': 'Aave v3',
  '0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22': 'Compound v3',
  '0x3d4e44eb1374240ce5f1b871ab261cd16335b76a': 'Uniswap V3 Router',
  '0x198ef79f1f515f02dfe9e3115ed9fc07183f02fc': 'Virtuals Protocol',
};

// Known contract addresses — Polygon (for Polymarket)
const POLYGON_PROTOCOLS: Record<string, string> = {
  '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359': 'USDC',
  '0x2791bca1f2de4661ed88a30c99a7a9449aa84174': 'USDC.e (Bridged)',
  '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270': 'WMATIC',
  '0x4bfb4297f0c915f612d8b56e822e0c0b2e889ed6': 'Polymarket CTF Exchange',
  '0x9a26e6d4a93ec9103c16a2c77a7e3ba62c21354c': 'Polymarket Neg Risk CTF Exchange',
  '0x4d97dcd97ec945f40cf65f87097ace5ea0476045': 'Polymarket Neg Risk Adapter',
};

function getProtocolsForChain(chainId: number): Record<string, string> {
  return chainId === CHAINS.POLYGON.id ? POLYGON_PROTOCOLS : BASE_PROTOCOLS;
}

function getUsdcAddress(chainId: number): string {
  return chainId === CHAINS.POLYGON.id ? CHAINS.POLYGON.usdc : CHAINS.BASE.usdc;
}

// Cache wallet provenance for 30 min (on-chain data doesn't change fast)
const provenanceCache = new TTLCache<WalletProvenance>(1800);

// ============================================================
//  TYPES
// ============================================================

export interface WalletProvenance {
  wallet: string;
  chainId: number;

  // Age & activity
  firstTxTimestamp: number;     // unix seconds
  firstTxDate: string;          // ISO date
  walletAgeDays: number;
  totalTransactions: number;
  uniqueCounterparties: number;
  inboundTxCount: number;
  outboundTxCount: number;

  // Value flows
  totalEthReceived: string;     // in ETH (string for precision)
  totalEthSent: string;
  netEthFlow: string;

  // USDC flows (for PnL verification)
  usdcTransfers: number;
  totalUsdcIn: number;          // in USDC (6 decimals)
  totalUsdcOut: number;

  // Contract interaction fingerprint
  protocolsUsed: string[];      // human-readable names
  uniqueContractsInteracted: number;
  contractInteractions: number;

  // v1.17.0: Advanced behavioral signals
  botScore: number;                 // 0-100: likelihood of automated trading (higher = more bot-like)
  washTradingScore: number;         // 0-100: likelihood of wash trading (higher = more suspicious)
  topCounterpartyConcentration: number; // % of txs with single counterparty
  medianTxIntervalSec: number;      // median seconds between consecutive txs
  burstTxCount: number;             // txs within 5-second windows (bot signal)

  // VIGIL risk signals
  provenanceScore: number;      // 0-100 composite
  provenanceGrade: 'A' | 'B' | 'C' | 'D' | 'F';
  flags: string[];
  greenFlags: string[];

  // Meta
  fetchedAt: string;
  dataSource: 'basescan-v2';
}

export interface BasescanTx {
  hash: string;
  from: string;
  to: string;
  value: string;           // in wei
  timeStamp: string;       // unix seconds
  isError: string;         // "0" = success
  functionName: string;
  contractAddress: string;
  input: string;
}

export interface BasescanTokenTx {
  hash: string;
  from: string;
  to: string;
  value: string;           // in token decimals
  tokenName: string;
  tokenSymbol: string;
  tokenDecimal: string;
  contractAddress: string;
  timeStamp: string;
}

// ============================================================
//  API CLIENT
// ============================================================

function getApiKey(): string | null {
  return process.env.BASESCAN_API_KEY?.trim() || null;
}

async function etherscanFetch<T>(params: Record<string, string>, chainId: number = CHAINS.BASE.id): Promise<T> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('BASESCAN_API_KEY not configured');

  const url = new URL(ETHERSCAN_V2);
  url.searchParams.set('chainid', String(chainId));
  url.searchParams.set('apikey', apiKey);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);

  let retries = 0;
  const maxRetries = 2;

  while (retries <= maxRetries) {
    try {
      const res = await fetch(url.toString(), {
        headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
        signal: ctrl.signal,
      });

      // Handle rate limit with retry
      if (res.status === 429) {
        if (retries < maxRetries) {
          retries++;
          await delay(1000 * retries); // 1s, 2s backoff
          continue;
        }
      }

      if (!res.ok) throw new Error(`Basescan HTTP ${res.status}`);
      const data = await res.json() as { status: string; message: string; result: T };

      // Check for rate limit error in response
      if (data.message && data.message.includes('rate')) {
        if (retries < maxRetries) {
          retries++;
          await delay(1000 * retries); // 1s, 2s backoff
          continue;
        }
      }

      if (data.status === '0' && data.message === 'NOTOK') {
        // Generic error message to avoid leaking API key
        throw new Error('Basescan API returned an error');
      }
      return data.result;
    } catch (err) {
      if (retries < maxRetries && (err instanceof Error ? err.message.includes('rate') || err.message.includes('429') : false)) {
        retries++;
        await delay(1000 * retries);
        continue;
      }
      throw err;
    } finally {
      if (retries > 0 || !url.toString().includes('apikey')) {
        // Only clear if not retrying
        if (retries === 0) clearTimeout(timer);
      }
    }
  }

  clearTimeout(timer);
  throw new Error('Basescan API failed after retries');
}

// Rate limit: Etherscan free = 5 calls/sec. Add small delay between calls.
function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ============================================================
//  FETCHERS
// ============================================================

/**
 * Fetch normal transactions for a wallet on Base.
 * Returns up to 1000 most recent transactions.
 */
export async function fetchTransactions(wallet: string, chainId: number = CHAINS.BASE.id): Promise<BasescanTx[]> {
  const result = await etherscanFetch<BasescanTx[]>({
    module: 'account',
    action: 'txlist',
    address: wallet,
    startblock: '0',
    endblock: '99999999',
    page: '1',
    offset: '1000',
    sort: 'asc',
  }, chainId);
  if (!Array.isArray(result)) {
    console.warn(`[basescan] fetchTransactions returned non-array for ${wallet}: API may have failed or returned error`);
    return [];
  }
  return result;
}

/**
 * Fetch ERC-20 token transfers for a wallet.
 */
export async function fetchTokenTransfers(wallet: string, chainId: number = CHAINS.BASE.id): Promise<BasescanTokenTx[]> {
  const result = await etherscanFetch<BasescanTokenTx[]>({
    module: 'account',
    action: 'tokentx',
    address: wallet,
    startblock: '0',
    endblock: '99999999',
    page: '1',
    offset: '2000',
    sort: 'asc',
  }, chainId);
  if (!Array.isArray(result)) {
    console.warn(`[basescan] fetchTokenTransfers returned non-array for ${wallet}: API may have failed or returned error`);
    return [];
  }
  return result;
}

/**
 * Fetch native token balance for a wallet.
 */
export async function fetchBalance(wallet: string, chainId: number = CHAINS.BASE.id): Promise<string> {
  const result = await etherscanFetch<string>({
    module: 'account',
    action: 'balance',
    address: wallet,
    tag: 'latest',
  }, chainId);
  return result;
}

// ============================================================
//  WALLET PROVENANCE SCORING
// ============================================================

/**
 * Compute full wallet provenance from on-chain data.
 * This is the VERIFICATION LAYER — ground truth that can't be faked.
 */
export async function getWalletProvenance(wallet: string, chainId: number = CHAINS.BASE.id): Promise<WalletProvenance | null> {
  // Check cache first (keyed by wallet+chain)
  const cacheKey = `${wallet.toLowerCase()}-${chainId}`;
  const cached = provenanceCache.get(cacheKey);
  if (cached) return cached;

  const apiKey = getApiKey();
  if (!apiKey) return null; // graceful degradation if key not set

  try {
    const chainName = chainId === CHAINS.POLYGON.id ? 'Polygon' : 'Base';

    // Fetch transactions and token transfers in parallel
    const [txs, tokenTxs] = await Promise.all([
      fetchTransactions(wallet, chainId),
      delay(200).then(() => fetchTokenTransfers(wallet, chainId)), // rate limit gap
    ]);

    if (txs.length === 0 && tokenTxs.length === 0) {
      const empty: WalletProvenance = {
        wallet: wallet.toLowerCase(),
        chainId,
        firstTxTimestamp: 0,
        firstTxDate: 'never',
        walletAgeDays: 0,
        totalTransactions: 0,
        uniqueCounterparties: 0,
        inboundTxCount: 0,
        outboundTxCount: 0,
        totalEthReceived: '0',
        totalEthSent: '0',
        netEthFlow: '0',
        usdcTransfers: 0,
        totalUsdcIn: 0,
        totalUsdcOut: 0,
        protocolsUsed: [],
        uniqueContractsInteracted: 0,
        contractInteractions: 0,
        botScore: 0,
        washTradingScore: 0,
        topCounterpartyConcentration: 0,
        medianTxIntervalSec: 0,
        burstTxCount: 0,
        provenanceScore: 0,
        provenanceGrade: 'F',
        flags: [`No on-chain history on ${chainName} chain`, 'Wallet may operate on a different chain'],
        greenFlags: [],
        fetchedAt: new Date().toISOString(),
        dataSource: 'basescan-v2',
      };
      provenanceCache.set(cacheKey, empty);
      return empty;
    }

    const walletLower = wallet.toLowerCase();

    // --- Transaction Analysis ---
    const successTxs = txs.filter(t => t.isError === '0');
    const counterparties = new Set<string>();
    let ethReceived = BigInt(0);
    let ethSent = BigInt(0);
    let inbound = 0;
    let outbound = 0;
    let contractCalls = 0;
    const contractsUsed = new Set<string>();

    for (const tx of successTxs) {
      const from = tx.from.toLowerCase();
      const to = (tx.to || '').toLowerCase();
      const val = BigInt(tx.value || '0');

      if (from === walletLower) {
        outbound++;
        ethSent += val;
        if (to) counterparties.add(to);
      }
      if (to === walletLower) {
        inbound++;
        ethReceived += val;
        counterparties.add(from);
      }

      // Contract interaction detection
      if (tx.input && tx.input !== '0x' && to) {
        contractCalls++;
        contractsUsed.add(to);
      }
    }

    // --- Protocol Fingerprinting ---
    // Add token transfer contract addresses to contractsUsed for protocol detection
    for (const tx of tokenTxs) {
      if (tx.contractAddress) {
        contractsUsed.add(tx.contractAddress.toLowerCase());
      }
    }

    const protocolsUsed: string[] = [];
    const knownProtocols = getProtocolsForChain(chainId);
    for (const [addr, name] of Object.entries(knownProtocols)) {
      if (contractsUsed.has(addr.toLowerCase())) {
        protocolsUsed.push(name);
      }
    }

    // --- USDC Analysis (for PnL cross-check) ---
    const usdcAddr = getUsdcAddress(chainId);
    // Match both native USDC and bridged USDC.e on Polygon
    const usdcTxs = tokenTxs.filter(
      t => t.contractAddress.toLowerCase() === usdcAddr ||
           (chainId === CHAINS.POLYGON.id && t.contractAddress.toLowerCase() === '0x2791bca1f2de4661ed88a30c99a7a9449aa84174'),
    );
    let usdcIn = 0;
    let usdcOut = 0;
    for (const tx of usdcTxs) {
      // Use tokenDecimal field if available; default to 6 for USDC
      const decimals = Number(tx.tokenDecimal) || 6;
      const amount = Number(tx.value) / Math.pow(10, decimals);
      if (tx.to.toLowerCase() === walletLower) {
        usdcIn += amount;
      } else {
        usdcOut += amount;
      }
    }

    // --- v1.17.0: BOT DETECTION (Transaction Timing Analysis) ---
    // Bots trade in tight bursts with consistent timing. Humans don't.
    const allTimestamps = successTxs.map(t => Number(t.timeStamp)).filter(t => t > 0).sort((a, b) => a - b);
    let medianTxIntervalSec = 0;
    let burstTxCount = 0;
    let botScore = 0;

    if (allTimestamps.length >= 3) {
      // Compute intervals between consecutive transactions
      const intervals: number[] = [];
      for (let i = 1; i < allTimestamps.length; i++) {
        intervals.push(allTimestamps[i] - allTimestamps[i - 1]);
      }
      intervals.sort((a, b) => a - b);
      medianTxIntervalSec = intervals[Math.floor(intervals.length / 2)];

      // Count burst transactions (within 5-second windows)
      for (let i = 1; i < allTimestamps.length; i++) {
        if (allTimestamps[i] - allTimestamps[i - 1] <= 5) burstTxCount++;
      }

      // Bot score: high burst ratio + low median interval = bot-like
      const burstRatio = allTimestamps.length > 1 ? burstTxCount / (allTimestamps.length - 1) : 0;
      // Median interval < 30 seconds is suspicious, < 10 is very bot-like
      const intervalScore = medianTxIntervalSec < 10 ? 50 : medianTxIntervalSec < 30 ? 30 : medianTxIntervalSec < 60 ? 15 : 0;
      const burstScore = burstRatio > 0.5 ? 50 : burstRatio > 0.2 ? 30 : burstRatio > 0.05 ? 10 : 0;
      botScore = Math.min(100, intervalScore + burstScore);
    }

    // --- v1.17.0: WASH TRADING DETECTION (Counterparty Concentration) ---
    // If most transactions go to/from one address, it's likely self-dealing.
    let topCounterpartyConcentration = 0;
    let washTradingScore = 0;

    if (counterparties.size > 0) {
      const cpCounts: Record<string, number> = {};
      for (const tx of successTxs) {
        const from = tx.from.toLowerCase();
        const to = (tx.to || '').toLowerCase();
        if (from === walletLower && to) cpCounts[to] = (cpCounts[to] || 0) + 1;
        if (to === walletLower) cpCounts[from] = (cpCounts[from] || 0) + 1;
      }
      const maxCpCount = Math.max(...Object.values(cpCounts));
      const totalInteractions = Object.values(cpCounts).reduce((s, v) => s + v, 0);
      topCounterpartyConcentration = totalInteractions > 0 ? maxCpCount / totalInteractions : 0;

      // High concentration + few counterparties = wash trading signal
      if (topCounterpartyConcentration > 0.7 && counterparties.size < 5) {
        washTradingScore = 80;
      } else if (topCounterpartyConcentration > 0.5 && counterparties.size < 10) {
        washTradingScore = 50;
      } else if (topCounterpartyConcentration > 0.3) {
        washTradingScore = 20;
      }
    }

    // --- Wallet Age ---
    // Collect all timestamps from both txs and tokenTxs, filter valid ones, take minimum
    const timestamps: number[] = [];
    for (const tx of successTxs) {
      const ts = Number(tx.timeStamp);
      if (ts > 0) timestamps.push(ts);
    }
    for (const tx of tokenTxs) {
      const ts = Number(tx.timeStamp);
      if (ts > 0) timestamps.push(ts);
    }
    const firstTs = timestamps.length > 0 ? Math.min(...timestamps) : 0;
    const nowSec = Math.floor(Date.now() / 1000);
    const ageDays = firstTs > 0 ? Math.floor((nowSec - firstTs) / 86400) : 0;

    // --- ETH formatting ---
    const weiToEth = (wei: bigint): string => {
      // Use BigInt division for integer part to avoid overflow
      const integerPart = wei / BigInt('1000000000000000000');
      const remainder = wei % BigInt('1000000000000000000');
      const decimalPart = Number(remainder) / 1e18;
      const eth = Number(integerPart) + decimalPart;
      return eth.toFixed(6);
    };

    // ============================================================
    //  PROVENANCE SCORE — the on-chain trust dimension
    // ============================================================

    let score = 0;
    const flags: string[] = [];
    const greenFlags: string[] = [];

    // 1. Wallet Age (0-25 points)
    //    <7 days = 0, 7-30 days = 5, 30-90 = 10, 90-180 = 15, 180-365 = 20, 365+ = 25
    if (ageDays >= 365) { score += 25; greenFlags.push(`Wallet age: ${ageDays} days (mature)`); }
    else if (ageDays >= 180) { score += 20; greenFlags.push(`Wallet age: ${ageDays} days`); }
    else if (ageDays >= 90) score += 15;
    else if (ageDays >= 30) score += 10;
    else if (ageDays >= 7) { score += 5; flags.push(`Young wallet: only ${ageDays} days old`); }
    else { flags.push(`Very new wallet: ${ageDays} days old — possible sybil`); }

    // 2. Transaction Volume (0-25 points)
    //    <5 = 0, 5-20 = 5, 20-50 = 10, 50-200 = 15, 200-500 = 20, 500+ = 25
    const txCount = successTxs.length + tokenTxs.length; // count both ETH txs and token transfers
    if (txCount >= 500) { score += 25; greenFlags.push(`Heavy on-chain activity: ${txCount} txs`); }
    else if (txCount >= 200) { score += 20; greenFlags.push(`Active on-chain: ${txCount} txs`); }
    else if (txCount >= 50) score += 15;
    else if (txCount >= 20) score += 10;
    else if (txCount >= 5) score += 5;
    else { flags.push(`Minimal on-chain activity: only ${txCount} txs`); }

    // 3. Counterparty Diversity (0-20 points)
    //    <3 = 0, 3-10 = 5, 10-25 = 10, 25-50 = 15, 50+ = 20
    const cpCount = counterparties.size;
    if (cpCount >= 50) { score += 20; greenFlags.push(`Diverse counterparties: ${cpCount} unique addresses`); }
    else if (cpCount >= 25) score += 15;
    else if (cpCount >= 10) score += 10;
    else if (cpCount >= 3) score += 5;
    else { flags.push(`Limited counterparties: only ${cpCount} unique addresses`); }

    // 4. Protocol Breadth (0-15 points)
    //    0 protocols = 0, 1 = 3, 2 = 6, 3 = 10, 4+ = 15
    if (protocolsUsed.length >= 4) { score += 15; greenFlags.push(`Multi-protocol user: ${protocolsUsed.join(', ')}`); }
    else if (protocolsUsed.length >= 3) score += 10;
    else if (protocolsUsed.length >= 2) score += 6;
    else if (protocolsUsed.length >= 1) score += 3;

    // 5. USDC Activity (0-15 points)
    //    Wallets that move USDC are engaged in DeFi/trading
    const totalUsdc = usdcIn + usdcOut;
    if (totalUsdc >= 10000) { score += 15; greenFlags.push(`Significant USDC flow: $${Math.round(totalUsdc).toLocaleString()}`); }
    else if (totalUsdc >= 1000) score += 10;
    else if (totalUsdc >= 100) score += 5;
    else if (totalUsdc > 0) score += 2;

    // Clamp 0-100
    score = Math.max(0, Math.min(100, score));

    // Grade
    const provenanceGrade: WalletProvenance['provenanceGrade'] =
      score >= 80 ? 'A' :
      score >= 60 ? 'B' :
      score >= 40 ? 'C' :
      score >= 20 ? 'D' : 'F';

    // Extra flags
    if (inbound > 0 && outbound === 0) flags.push('Receive-only wallet: never sent a transaction');
    if (usdcIn > 0 && usdcOut === 0) flags.push('USDC only flows in, never out');
    if (contractCalls === 0 && txCount > 10) flags.push('No contract interactions despite activity — possible EOA-only transfers');

    // v1.17.0: Bot and wash trading flags
    if (botScore >= 60) flags.push(`Bot-like behavior detected: ${burstTxCount} burst txs, median interval ${medianTxIntervalSec}s`);
    else if (botScore >= 30) flags.push(`Possible automated trading: ${burstTxCount} burst txs`);
    if (botScore < 15 && txCount >= 20) greenFlags.push('Human-like transaction patterns');

    if (washTradingScore >= 60) flags.push(`Wash trading signal: ${(topCounterpartyConcentration * 100).toFixed(0)}% of txs with single counterparty`);
    else if (washTradingScore >= 30) flags.push(`Counterparty concentration: ${(topCounterpartyConcentration * 100).toFixed(0)}% with top address`);
    if (washTradingScore < 20 && counterparties.size >= 10) greenFlags.push(`Diverse trading network: ${counterparties.size} counterparties`);

    const result: WalletProvenance = {
      wallet: walletLower,
      chainId,
      firstTxTimestamp: firstTs,
      firstTxDate: firstTs > 0 ? new Date(firstTs * 1000).toISOString().split('T')[0] : 'never',
      walletAgeDays: ageDays,
      totalTransactions: txCount,
      uniqueCounterparties: cpCount,
      inboundTxCount: inbound,
      outboundTxCount: outbound,
      totalEthReceived: weiToEth(ethReceived),
      totalEthSent: weiToEth(ethSent),
      netEthFlow: weiToEth(ethReceived - ethSent),
      usdcTransfers: usdcTxs.length,
      totalUsdcIn: Math.round(usdcIn * 100) / 100,
      totalUsdcOut: Math.round(usdcOut * 100) / 100,
      protocolsUsed,
      uniqueContractsInteracted: contractsUsed.size,
      contractInteractions: contractCalls,
      botScore,
      washTradingScore,
      topCounterpartyConcentration: Math.round(topCounterpartyConcentration * 100) / 100,
      medianTxIntervalSec,
      burstTxCount,
      provenanceScore: score,
      provenanceGrade,
      flags,
      greenFlags,
      fetchedAt: new Date().toISOString(),
      dataSource: 'basescan-v2',
    };

    provenanceCache.set(cacheKey, result);
    return result;
  } catch (err) {
    // Graceful degradation — on-chain layer is additive, not required
    console.error(`[basescan] Failed for ${wallet}:`, err);
    return null;
  }
}

// ============================================================
//  HELPERS FOR INTEGRATION
// ============================================================

/**
 * Check if Basescan API is configured and available.
 */
export function isBasescanConfigured(): boolean {
  return !!getApiKey();
}

// ============================================================
//  v1.21.0: POLYMARKET ON-CHAIN COVERAGE CROSS-CHECK
//
//  Ground truth — read the wallet's USDC.e transfers FROM Polymarket
//  contracts on Polygon. Each transfer = either a sell settlement or a
//  winning-share redemption. Used as a quality gate: if data-api says
//  N resolved bets but on-chain shows M>>N withdrawals from Polymarket
//  contracts, the scorer is blind-spotted and should warn loudly.
// ============================================================

// Polymarket Polygon contract addresses (lowercase)
const POLYMARKET_CONTRACTS = new Set<string>([
  '0x4bfb4297f0c915f612d8b56e822e0c0b2e889ed6', // CTF Exchange
  '0x9a26e6d4a93ec9103c16a2c77a7e3ba62c21354c', // Neg Risk CTF Exchange
  '0x4d97dcd97ec945f40cf65f87097ace5ea0476045', // Neg Risk Adapter / Conditional Tokens
  '0xd91e80cf2e7be2e162c6513ced06f1dd0da35296', // Polymarket UMA CTF Adapter
]);

// USDC.e on Polygon — what Polymarket actually moves
const USDC_E_POLYGON = '0x2791bca1f2de4661ed88a30c99a7a9449aa84174';

export interface PolymarketOnChainCoverage {
  wallet: string;
  usdcInflowsFromPolymarket: number;     // total USDC.e received from Polymarket contracts
  usdcOutflowsToPolymarket: number;      // total USDC.e sent to Polymarket contracts
  withdrawalTxCount: number;             // how many on-chain pay-out events observed
  largestWithdrawal: number;             // biggest single USDC.e withdrawal
  firstPolymarketTxDate: string;         // ISO date of first Polymarket interaction
  fetchedAt: string;
}

/**
 * Ground-truth on-chain coverage for a Polymarket wallet. Reads USDC.e
 * transfers between the wallet and any Polymarket contract on Polygon.
 * Returns null if Etherscan/Basescan is not configured (graceful degrade).
 *
 * This is the anti-blind-spot check: any deviation between data-api
 * redeem totals and on-chain withdrawals tells us to look harder.
 */
export async function getPolymarketOnChainCoverage(
  wallet: string,
): Promise<PolymarketOnChainCoverage | null> {
  const apiKey = getApiKey();
  if (!apiKey) return null;

  try {
    const tokenTxs = await fetchTokenTransfers(wallet, CHAINS.POLYGON.id);
    const walletLower = wallet.toLowerCase();

    let usdcIn = 0;
    let usdcOut = 0;
    let withdrawCount = 0;
    let largest = 0;
    let firstTs = 0;

    for (const tx of tokenTxs) {
      if (tx.contractAddress.toLowerCase() !== USDC_E_POLYGON) continue;
      const from = tx.from.toLowerCase();
      const to = tx.to.toLowerCase();
      const decimals = Number(tx.tokenDecimal) || 6;
      const amount = Number(tx.value) / Math.pow(10, decimals);
      const ts = Number(tx.timeStamp);

      const fromPM = POLYMARKET_CONTRACTS.has(from);
      const toPM = POLYMARKET_CONTRACTS.has(to);
      if (!fromPM && !toPM) continue;

      if (firstTs === 0 || ts < firstTs) firstTs = ts;

      if (fromPM && to === walletLower) {
        usdcIn += amount;
        withdrawCount++;
        if (amount > largest) largest = amount;
      } else if (toPM && from === walletLower) {
        usdcOut += amount;
      }
    }

    return {
      wallet: walletLower,
      usdcInflowsFromPolymarket: Math.round(usdcIn * 100) / 100,
      usdcOutflowsToPolymarket: Math.round(usdcOut * 100) / 100,
      withdrawalTxCount: withdrawCount,
      largestWithdrawal: Math.round(largest * 100) / 100,
      firstPolymarketTxDate: firstTs > 0 ? new Date(firstTs * 1000).toISOString().split('T')[0] : 'never',
      fetchedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.error(`[basescan] getPolymarketOnChainCoverage failed for ${wallet}:`, err);
    return null;
  }
}

/**
 * Quick sybil check: wallet age < 7 days AND < 5 txs = likely sybil.
 * Returns null if Basescan is not configured (graceful skip).
 */
export async function quickSybilCheck(wallet: string): Promise<{
  isSuspicious: boolean;
  reason: string | null;
  ageDays: number;
  txCount: number;
} | null> {
  const prov = await getWalletProvenance(wallet);
  if (!prov) return null;

  const suspicious = prov.walletAgeDays < 7 && prov.totalTransactions < 5;
  return {
    isSuspicious: suspicious,
    reason: suspicious
      ? `Wallet is ${prov.walletAgeDays} days old with only ${prov.totalTransactions} transactions`
      : null,
    ageDays: prov.walletAgeDays,
    txCount: prov.totalTransactions,
  };
}
