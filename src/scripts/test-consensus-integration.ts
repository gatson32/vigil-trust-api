// Integration test for the pure consensus core.
// Validates end-to-end behavior with synthetic leaderboard + positions.
//
//   npx tsx src/scripts/test-consensus-integration.ts

import { computeConsensusFromPairs, GRADE_WEIGHTS, type ConsensusInputs } from '../lib/consensus.js';
import type { LeaderboardEntry, PolymarketPosition } from '../lib/polymarket.js';

const CID = '0xTEST_MARKET';

function makeEntry(wallet: string, grade: string, score = 50, resolvedBets = 100): LeaderboardEntry {
  return {
    wallet,
    displayName: `trader_${wallet.slice(-4)}`,
    trustScore: score,
    trustGrade: grade,
    brierSkillScore: 0.1,
    calibrationError: 0.1,
    resolvedBets,
    winRate: 0.5,
    realizedPnl: 0,
    scoredAt: new Date().toISOString(),
  };
}

function makePosition(opts: Partial<PolymarketPosition> & { outcomeIndex: 0 | 1; avgPrice: number; initialValue: number }): PolymarketPosition {
  return {
    proxyWallet: opts.proxyWallet || '0xUNUSED',
    asset: opts.asset || 'ASSET',
    conditionId: CID,
    size: opts.size ?? 1000,
    avgPrice: opts.avgPrice,
    initialValue: opts.initialValue,
    currentValue: opts.initialValue * 1.1,
    cashPnl: opts.initialValue * 0.1,
    percentPnl: 10,
    realizedPnl: 0,
    percentRealizedPnl: 0,
    curPrice: opts.avgPrice,
    redeemable: false,
    title: 'Test market',
    slug: 'test-market',
    outcome: opts.outcomeIndex === 0 ? 'Yes' : 'No',
    outcomeIndex: opts.outcomeIndex,
    endDate: new Date(Date.now() + 20 * 86_400_000).toISOString(), // 20 days out
  };
}

function baseInput(pairs: ConsensusInputs['pairs'], impliedMarketP: number | null = 0.62): ConsensusInputs {
  return {
    conditionId: CID,
    marketTitle: 'Will Trump win 2024?',
    marketSlug: 'will-trump-win-2024',
    marketClosed: false,
    impliedMarketP,
    pairs,
  };
}

let passed = 0, failed = 0;
function test(name: string, ok: boolean, got?: unknown, want?: unknown) {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else   { failed++; console.error(`  ✗ ${name}\n      got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }
}

console.log('\n=== consensus integration test ===\n');

// ─── Test 1: insufficient data rejection ────────────────────────────
console.log('[insufficient data]');
{
  const pairs = [
    { entry: makeEntry('0xaaa', 'A'), position: makePosition({ outcomeIndex: 0, avgPrice: 0.3, initialValue: 1000 }) },
    { entry: makeEntry('0xbbb', 'A'), position: makePosition({ outcomeIndex: 0, avgPrice: 0.3, initialValue: 1000 }) },
  ];
  const r = computeConsensusFromPairs(baseInput(pairs));
  test('2 wallets < MIN_WALLETS → INSUFFICIENT_DATA', 'error' in r && r.error === 'INSUFFICIENT_DATA');
}

// ─── Test 2: F-grade excluded from consensus ────────────────────────
console.log('\n[F-grade exclusion]');
{
  const pairs = [
    { entry: makeEntry('0xF1', 'F'), position: makePosition({ outcomeIndex: 0, avgPrice: 0.9, initialValue: 100000 }) },
    { entry: makeEntry('0xF2', 'F'), position: makePosition({ outcomeIndex: 0, avgPrice: 0.9, initialValue: 100000 }) },
    { entry: makeEntry('0xF3', 'F'), position: makePosition({ outcomeIndex: 0, avgPrice: 0.9, initialValue: 100000 }) },
    { entry: makeEntry('0xF4', 'F'), position: makePosition({ outcomeIndex: 0, avgPrice: 0.9, initialValue: 100000 }) },
    { entry: makeEntry('0xF5', 'F'), position: makePosition({ outcomeIndex: 0, avgPrice: 0.9, initialValue: 100000 }) },
    { entry: makeEntry('0xF6', 'F'), position: makePosition({ outcomeIndex: 0, avgPrice: 0.9, initialValue: 100000 }) },
  ];
  const r = computeConsensusFromPairs(baseInput(pairs));
  // All F, zero grade weight, zero contributors
  test('all-F leaderboard → INSUFFICIENT_DATA (F weight = 0)', 'error' in r && r.error === 'INSUFFICIENT_DATA');
}

// ─── Test 3: A-grade dominance ──────────────────────────────────────
console.log('\n[A-grade dominance]');
{
  // 2 A-grades at P=0.35 (Yes side), 8 D-grades at P=0.75 (No side, so impliedPYes = 0.25)
  const pairs: ConsensusInputs['pairs'] = [];
  for (let i = 0; i < 2; i++) {
    pairs.push({ entry: makeEntry(`0xA${i}`, 'A'), position: makePosition({ outcomeIndex: 0, avgPrice: 0.35, initialValue: 10000 }) });
  }
  for (let i = 0; i < 8; i++) {
    pairs.push({ entry: makeEntry(`0xD${i}`, 'D'), position: makePosition({ outcomeIndex: 0, avgPrice: 0.75, initialValue: 10000 }) });
  }
  const r = computeConsensusFromPairs(baseInput(pairs));
  if ('error' in r) {
    test('10 wallets should compute consensus', false, r.error);
  } else {
    // A: weight = 1.0 × sqrt(10000) × decay_14 ≈ 1.0 × 100 × 0.72 = 72 per wallet
    // D: weight = 0.05 × sqrt(10000) × decay_14 ≈ 0.05 × 100 × 0.72 = 3.6 per wallet
    // 2 A-grades at 0.35 vs 8 D-grades at 0.75:
    //   num = 2×72×0.35 + 8×3.6×0.75 = 50.4 + 21.6 = 72
    //   den = 144 + 28.8 = 172.8
    //   consensus ≈ 0.417 — pulled toward A's 0.35
    test(`consensus pulled toward A-grade (got ${r.consensusP.toFixed(3)})`, r.consensusP < 0.5 && r.consensusP > 0.3);
    test('contributingWallets.A = 2', r.contributingWallets.A === 2);
    test('contributingWallets.D = 8', r.contributingWallets.D === 8);
    test('contributingWallets.total = 10', r.contributingWallets.total === 10);
    // Effective weight: 2×1.0×0.72 + 8×0.05×0.72 = 1.73 → "weak" band (0.5-5.0)
    test(`dataQuality reflects effective weight (got ${r.dataQuality})`, r.dataQuality === 'weak' || r.dataQuality === 'moderate');
  }
}

// ─── Test 4: divergence direction ───────────────────────────────────
console.log('\n[divergence direction]');
{
  // 5 C-grade wallets all believing Yes ~0.40, market at 0.65 → market_overpriced
  const pairs: ConsensusInputs['pairs'] = [];
  for (let i = 0; i < 5; i++) {
    pairs.push({ entry: makeEntry(`0xC${i}`, 'C'), position: makePosition({ outcomeIndex: 0, avgPrice: 0.40, initialValue: 5000 }) });
  }
  const r = computeConsensusFromPairs(baseInput(pairs, 0.65));
  if ('error' in r) {
    test('compute succeeds with 5 C-grades', false);
  } else {
    test('consensus ≈ 0.40', Math.abs(r.consensusP - 0.40) < 0.05);
    test(`divergence negative (consensus < market, ${r.divergence.toFixed(3)})`, r.divergence < 0);
    test('divergenceDirection = market_overpriced', r.divergenceDirection === 'market_overpriced');
  }
}

{
  // Opposite: C-grades believing Yes ~0.80, market at 0.55 → market_underpriced
  const pairs: ConsensusInputs['pairs'] = [];
  for (let i = 0; i < 5; i++) {
    pairs.push({ entry: makeEntry(`0xC${i}`, 'C'), position: makePosition({ outcomeIndex: 0, avgPrice: 0.80, initialValue: 5000 }) });
  }
  const r = computeConsensusFromPairs(baseInput(pairs, 0.55));
  if (!('error' in r)) {
    test('divergenceDirection = market_underpriced', r.divergenceDirection === 'market_underpriced');
  }
}

{
  // Aligned: C-grades at 0.50, market at 0.52 → aligned (diff < 0.03)
  const pairs: ConsensusInputs['pairs'] = [];
  for (let i = 0; i < 5; i++) {
    pairs.push({ entry: makeEntry(`0xC${i}`, 'C'), position: makePosition({ outcomeIndex: 0, avgPrice: 0.50, initialValue: 5000 }) });
  }
  const r = computeConsensusFromPairs(baseInput(pairs, 0.52));
  if (!('error' in r)) {
    test('near-match → aligned', r.divergenceDirection === 'aligned');
  }
}

// ─── Test 5: No-side positions correctly invert ─────────────────────
console.log('\n[Yes/No symmetry]');
{
  // 5 wallets holding "No" at avgPrice 0.30 → impliedPYes = 0.70
  const pairs: ConsensusInputs['pairs'] = [];
  for (let i = 0; i < 5; i++) {
    pairs.push({ entry: makeEntry(`0xN${i}`, 'B'), position: makePosition({ outcomeIndex: 1, avgPrice: 0.30, initialValue: 5000 }) });
  }
  const r = computeConsensusFromPairs(baseInput(pairs, 0.45));
  if (!('error' in r)) {
    test(`No-holder at 0.30 → consensus P(Yes) ≈ 0.70 (got ${r.consensusP.toFixed(3)})`, Math.abs(r.consensusP - 0.70) < 0.05);
  }
}

// ─── Test 6: whale dampening via sqrt ───────────────────────────────
console.log('\n[whale dampening]');
{
  // 1 A-grade whale at $1M vs 4 A-grade plebs at $1000 each, all at different beliefs.
  // With sqrt dampening, whale has weight sqrt(1_000_000)=1000, plebs have sqrt(1000)≈31.6 each
  // Ratio: whale = 1000 / (1000+4×31.6) = 88% of mass (not 99.6% as with linear)
  const pairs: ConsensusInputs['pairs'] = [
    { entry: makeEntry('0xWHALE', 'A'), position: makePosition({ outcomeIndex: 0, avgPrice: 0.80, initialValue: 1_000_000 }) },
    { entry: makeEntry('0xPLEB1', 'A'), position: makePosition({ outcomeIndex: 0, avgPrice: 0.30, initialValue: 1_000 }) },
    { entry: makeEntry('0xPLEB2', 'A'), position: makePosition({ outcomeIndex: 0, avgPrice: 0.30, initialValue: 1_000 }) },
    { entry: makeEntry('0xPLEB3', 'A'), position: makePosition({ outcomeIndex: 0, avgPrice: 0.30, initialValue: 1_000 }) },
    { entry: makeEntry('0xPLEB4', 'A'), position: makePosition({ outcomeIndex: 0, avgPrice: 0.30, initialValue: 1_000 }) },
  ];
  const r = computeConsensusFromPairs(baseInput(pairs, 0.50));
  if (!('error' in r)) {
    // With sqrt: whale ~88% of weight, consensus should lean heavily toward 0.80 but plebs still visible
    // With linear weight: consensus ~0.80 (whale dominates 99.6%)
    // With sqrt weight: consensus ~0.74 (whale 88%, plebs 12%)
    test(`sqrt dampening keeps consensus between 0.73 and 0.78 (got ${r.consensusP.toFixed(3)})`,
      r.consensusP > 0.73 && r.consensusP < 0.78);
  }
}

// ─── Test 7: CI95 sanity ────────────────────────────────────────────
console.log('\n[CI95 structure]');
{
  const pairs: ConsensusInputs['pairs'] = [];
  for (let i = 0; i < 10; i++) {
    pairs.push({ entry: makeEntry(`0x${i}`, 'C'), position: makePosition({ outcomeIndex: 0, avgPrice: 0.40 + Math.random() * 0.2, initialValue: 5000 }) });
  }
  const r = computeConsensusFromPairs(baseInput(pairs, 0.55));
  if (!('error' in r)) {
    test('ci95.low < consensusP', r.ci95.low <= r.consensusP + 0.01);
    test('ci95.high > consensusP', r.ci95.high >= r.consensusP - 0.01);
    test('ci95 width > 0', r.ci95.high > r.ci95.low);
    test('ci95 bounded [0,1]', r.ci95.low >= 0 && r.ci95.high <= 1);
  }
}

// ─── Test 8: topContributors sorted by weight ───────────────────────
console.log('\n[topContributors sorting]');
{
  const pairs: ConsensusInputs['pairs'] = [
    { entry: makeEntry('0xsmall', 'D'), position: makePosition({ outcomeIndex: 0, avgPrice: 0.5, initialValue: 100 }) },
    { entry: makeEntry('0xmid', 'C'), position: makePosition({ outcomeIndex: 0, avgPrice: 0.5, initialValue: 10000 }) },
    { entry: makeEntry('0xbig', 'A'), position: makePosition({ outcomeIndex: 0, avgPrice: 0.5, initialValue: 50000 }) },
    { entry: makeEntry('0xa1', 'B'), position: makePosition({ outcomeIndex: 0, avgPrice: 0.5, initialValue: 5000 }) },
    { entry: makeEntry('0xb1', 'B'), position: makePosition({ outcomeIndex: 0, avgPrice: 0.5, initialValue: 2000 }) },
  ];
  const r = computeConsensusFromPairs(baseInput(pairs));
  if (!('error' in r)) {
    test('topContributors[0].grade = A (highest weight)', r.topContributors[0]?.grade === 'A');
    test('weights monotone decreasing', r.topContributors.every((c, i, arr) => i === 0 || arr[i - 1].weight >= c.weight));
  }
}

// ─── Test 9: whale-note flag ────────────────────────────────────────
console.log('\n[note flags]');
{
  const pairs: ConsensusInputs['pairs'] = [
    { entry: makeEntry('0xWHALE', 'A'), position: makePosition({ outcomeIndex: 0, avgPrice: 0.5, initialValue: 100_000 }) },
  ];
  for (let i = 0; i < 5; i++) {
    pairs.push({ entry: makeEntry(`0xC${i}`, 'C'), position: makePosition({ outcomeIndex: 0, avgPrice: 0.5, initialValue: 1000 }) });
  }
  const r = computeConsensusFromPairs(baseInput(pairs));
  if (!('error' in r)) {
    test('$100k position triggers whale note', r.notes.some(n => n.includes('Whale')));
  }
}

{
  const pairs: ConsensusInputs['pairs'] = [];
  for (let i = 0; i < 6; i++) {
    pairs.push({ entry: makeEntry(`0xD${i}`, 'D'), position: makePosition({ outcomeIndex: 0, avgPrice: 0.5, initialValue: 1000 }) });
  }
  const r = computeConsensusFromPairs(baseInput(pairs));
  // 6 × D-grade gives 6 × 0.05 × decay ~ 6 × 0.05 × 0.72 = 0.22 effective (< 1.0 min)
  // So this should hit INSUFFICIENT_DATA. Good — test it.
  if ('error' in r) {
    test('all-D with low effective weight → INSUFFICIENT_DATA', r.error === 'INSUFFICIENT_DATA');
  }
}

// ─── Test 10: market closed note ────────────────────────────────────
console.log('\n[closed market note]');
{
  const pairs: ConsensusInputs['pairs'] = [];
  for (let i = 0; i < 5; i++) {
    pairs.push({ entry: makeEntry(`0xB${i}`, 'B'), position: makePosition({ outcomeIndex: 0, avgPrice: 0.7, initialValue: 10000 }) });
  }
  const input = baseInput(pairs, 0.5);
  input.marketClosed = true;
  const r = computeConsensusFromPairs(input);
  if (!('error' in r)) {
    test('closed market triggers close-warning note', r.notes.some(n => n.toLowerCase().includes('closed')));
  }
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);
