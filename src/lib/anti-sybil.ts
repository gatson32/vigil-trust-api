/**
 * Anti-Sybil difficulty adjustment — v1.22.8.
 *
 * The launch-day objection we expect on X:
 *   "What stops someone from spinning up 100 wallets and farming an A grade?"
 *
 * Answer, layered:
 *   1. Every grade's weight in the skill-weighted consensus is multiplied by
 *      `ageFactor(ageDays)`, a log-curve that's zero for wallets under 30 days
 *      and saturates near 1.0 around 730 days.
 *   2. Wallets with ageDays < MIN_AGE_FOR_GRADE are force-labeled `INS`
 *      regardless of bet count — we don't letter-grade wallets that could
 *      trivially be puppet accounts.
 *   3. Stake weighting (√stake) means a new Sybil needs real USDC to move the
 *      leaderboard, not just wallets.
 *
 * This module is intentionally side-effect free and framework-agnostic —
 * both the scoring path and the consensus path import from here.
 */
// Purposefully no other imports: this module is the lowest-level primitive
// and must not pull on PolymarketRiskReport etc.

// ───────────────────────── TUNABLES ─────────────────────────

/** Wallets younger than this (days) are force-INS regardless of bet count. */
export const MIN_AGE_FOR_GRADE = 30;

/** Full-credit age threshold — ageFactor saturates here. */
export const AGE_FACTOR_CEILING_DAYS = 730;

/** Zero-credit floor — ageFactor is 0 below this. */
export const AGE_FACTOR_FLOOR_DAYS = 30;

/** Consensus-weight floor: even the oldest wallet gets no more than 1.0x. */
export const MAX_AGE_FACTOR = 1.0;

// ───────────────────────── CORE ─────────────────────────

/**
 * Sybil-difficulty weight in `[0, 1]`, piecewise-log over wallet age in days.
 *
 * ageDays ≤ FLOOR      → 0           (too new to count)
 * ageDays ≥ CEILING    → 1           (full credit)
 * otherwise            → log-scaled  (log(age) - log(floor)) / (log(ceiling) - log(floor))
 *
 * We use a log curve, not linear, so a 60-day wallet is meaningfully under a
 * 180-day wallet but a 720-day wallet is not meaningfully over a 540-day one.
 */
export function ageFactor(ageDays: number | null | undefined): number {
  if (ageDays == null || !Number.isFinite(ageDays)) return 0;
  if (ageDays <= AGE_FACTOR_FLOOR_DAYS) return 0;
  if (ageDays >= AGE_FACTOR_CEILING_DAYS) return MAX_AGE_FACTOR;
  const num = Math.log(ageDays) - Math.log(AGE_FACTOR_FLOOR_DAYS);
  const den = Math.log(AGE_FACTOR_CEILING_DAYS) - Math.log(AGE_FACTOR_FLOOR_DAYS);
  return Math.max(0, Math.min(MAX_AGE_FACTOR, num / den));
}

/** Sybil-gate verdict attached to a scored report. */
export interface AntiSybilVerdict {
  eligibleForGrade: boolean;    // If false, consumer should downgrade to INS
  ageFactor: number;            // 0..1 consensus weight multiplier
  reason: string;               // Human-readable provenance
  ageDaysUsed: number | null;   // Echo of the input
}

export interface AntiSybilInput {
  /** Wallet age in days. null = unknown (e.g. basescan off, USDC recipient only). */
  ageDays: number | null;
  /** Total observed on-chain transactions — used as a secondary signal. */
  txCount?: number | null;
  /** Resolved-bet count on Polymarket — matured-trader signal if basescan unknown. */
  resolvedBets?: number | null;
}

/**
 * Decide if this wallet is mature enough to letter-grade, and compute the
 * consensus-weight multiplier.
 */
export function antiSybilVerdict(input: AntiSybilInput): AntiSybilVerdict {
  const { ageDays, txCount, resolvedBets } = input;

  // Case A: basescan returned nothing. Fall back to resolvedBets as a
  // proof-of-work proxy: a wallet with 30+ resolved bets on Polymarket has
  // real USDC at real risk, hard to farm cheaply.
  if (ageDays == null) {
    const resolved = resolvedBets ?? 0;
    if (resolved >= 100) {
      return {
        eligibleForGrade: true,
        ageFactor: 0.7,  // penalized: we couldn't verify age
        reason: `Wallet age unknown; ${resolved} resolved bets supply enough PoW to grade (factor 0.70)`,
        ageDaysUsed: null,
      };
    }
    return {
      eligibleForGrade: false,
      ageFactor: 0,
      reason: `Wallet age unknown and only ${resolved} resolved bets — insufficient to distinguish from a fresh Sybil`,
      ageDaysUsed: null,
    };
  }

  // Case B: basescan returned a real age.
  const factor = ageFactor(ageDays);

  if (ageDays < MIN_AGE_FOR_GRADE) {
    return {
      eligibleForGrade: false,
      ageFactor: 0,
      reason: `Wallet is only ${ageDays} days old — force-INS (threshold ${MIN_AGE_FOR_GRADE}d)`,
      ageDaysUsed: ageDays,
    };
  }

  // Extra safeguard: very old wallet with almost no tx history = dormant proxy.
  if (ageDays > 1000 && (txCount ?? 0) < 5) {
    return {
      eligibleForGrade: false,
      ageFactor: 0,
      reason: `Wallet is ${ageDays} days old but only ${txCount ?? 0} txs — dormant-proxy pattern, force-INS`,
      ageDaysUsed: ageDays,
    };
  }

  return {
    eligibleForGrade: true,
    ageFactor: factor,
    reason: `Wallet age ${ageDays}d → difficulty factor ${factor.toFixed(2)}`,
    ageDaysUsed: ageDays,
  };
}

/**
 * Consensus-path helper: returns the weight multiplier to apply on top of
 * `√stake × exp(-days/30) × gradeWeight`. Never throws; defaults to 0 on
 * bad input so a failing sybil check can never increase a wallet's influence.
 */
export function consensusWeightMultiplier(ageDays: number | null | undefined, resolvedBets: number): number {
  try {
    const v = antiSybilVerdict({ ageDays: ageDays ?? null, resolvedBets });
    return v.eligibleForGrade ? v.ageFactor : 0;
  } catch {
    return 0;
  }
}
