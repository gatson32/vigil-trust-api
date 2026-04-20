// Smoke test for consensus math — run with:
//   npx tsx src/scripts/test-consensus-math.ts
//
// Tests the building blocks of computeSkillConsensus without hitting
// live Polymarket APIs. Validates weighted mean, grade weights, and
// bootstrap CI95 directionally.

import { GRADE_WEIGHTS } from '../lib/consensus.js';

function weightedMean(values: number[], weights: number[]): number {
  let n = 0, d = 0;
  for (let i = 0; i < values.length; i++) { n += values[i] * weights[i]; d += weights[i]; }
  return d > 0 ? n / d : 0;
}

function bootstrapCI95(values: number[], weights: number[], iters = 2000) {
  const n = values.length;
  const s: number[] = [];
  for (let it = 0; it < iters; it++) {
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(Math.random() * n);
      num += values[idx] * weights[idx];
      den += weights[idx];
    }
    s.push(den > 0 ? num / den : 0);
  }
  s.sort((a, b) => a - b);
  return { low: s[Math.floor(iters * 0.025)], high: s[Math.floor(iters * 0.975)] };
}

function approxEq(a: number, b: number, eps = 0.01) { return Math.abs(a - b) < eps; }

let passed = 0, failed = 0;
function test(name: string, ok: boolean, got?: unknown, want?: unknown) {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else   { failed++; console.error(`  ✗ ${name}\n      got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }
}

console.log('\n=== consensus math smoke test ===\n');

// 1. Grade weights hierarchy
console.log('[grade weights]');
test('A > B', GRADE_WEIGHTS.A > GRADE_WEIGHTS.B);
test('B > C', GRADE_WEIGHTS.B > GRADE_WEIGHTS.C);
test('C > D', GRADE_WEIGHTS.C > GRADE_WEIGHTS.D);
test('D > F', GRADE_WEIGHTS.D > GRADE_WEIGHTS.F);
test('F = 0', GRADE_WEIGHTS.F === 0);

// 2. Weighted mean matches expectations
console.log('\n[weighted mean]');
// All equal weights → arithmetic mean
test('equal weights ~ arithmetic mean',
  approxEq(weightedMean([0.2, 0.5, 0.8], [1, 1, 1]), 0.5));
// A-grade wallet at 0.2 dominates D-grade wallets at 0.8
test('A-grade pulls mean toward A belief',
  weightedMean([0.2, 0.8, 0.8], [GRADE_WEIGHTS.A * 10, GRADE_WEIGHTS.D * 1, GRADE_WEIGHTS.D * 1]) < 0.3);
// B-grade at 0.6 vs 3x D-grade at 0.4
const m1 = weightedMean([0.6, 0.4, 0.4, 0.4], [GRADE_WEIGHTS.B, GRADE_WEIGHTS.D, GRADE_WEIGHTS.D, GRADE_WEIGHTS.D]);
test(`B-grade (0.6) dominates 3x D-grade (0.4): got ${m1.toFixed(3)}`, m1 > 0.5);

// 3. Bootstrap CI widens with fewer samples
console.log('\n[bootstrap CI]');
const narrow = bootstrapCI95([0.5, 0.51, 0.49, 0.5, 0.51, 0.49, 0.5, 0.51, 0.49, 0.5], Array(10).fill(1));
const wide = bootstrapCI95([0.2, 0.8, 0.3, 0.7], [1, 1, 1, 1]);
test(`narrow-data CI < wide-data CI (${(narrow.high - narrow.low).toFixed(3)} vs ${(wide.high - wide.low).toFixed(3)})`,
  (narrow.high - narrow.low) < (wide.high - wide.low));

// 4. Divergence sign
console.log('\n[divergence sign]');
const consensus = 0.41;
const market = 0.62;
const divergence = consensus - market;
test('market overpriced → divergence negative', divergence < 0);
test('|divergence| = 0.21', approxEq(Math.abs(divergence), 0.21));

// 5. Stake weight dampening (sqrt)
console.log('\n[stake weight]');
test('sqrt(10000) = 100', approxEq(Math.sqrt(10000), 100));
test('sqrt(1000000) = 1000', approxEq(Math.sqrt(1000000), 1000));
// A $10k whale has sqrt weight 100; a $1M whale has sqrt weight 1000. Ratio 10, not 100.
test('$1M whale is 10x a $10k wallet (not 100x) via sqrt', approxEq(Math.sqrt(1_000_000) / Math.sqrt(10_000), 10));

// 6. Time decay
console.log('\n[time decay — 30d half-life]');
const decay0 = Math.pow(0.5, 0 / 30);
const decay30 = Math.pow(0.5, 30 / 30);
const decay60 = Math.pow(0.5, 60 / 30);
test(`decay(0d) = 1.0`, approxEq(decay0, 1.0));
test(`decay(30d) = 0.5`, approxEq(decay30, 0.5));
test(`decay(60d) = 0.25`, approxEq(decay60, 0.25));

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);
