# VIGIL Launch-Day Scoring Snapshot

**Embargoed until Tuesday, April 22, 2026 — 09:00 ET.**
**v1.22.7 — generated 2026-04-22.**

---

## Headline

We ran VIGIL's skill-grading engine on Polymarket's top 10 wallets by realized
PnL. The result:

| Grade | Count | Wallets |
|---|---|---|
| A | 0 | — |
| B | 0 | — |
| C | 1 | swisstony |
| D | 6 | Theo4, Fredi9999, kch123, Len9311238, RN1, PrincessCaro |
| F | 3 | zxgngl, RepTrump, walletmobile |

**Every wallet ranked by PnL is graded C or worse on actual forecasting skill.**

Six of the ten have fewer than 30 resolved bets, meaning they would be flagged
`INS` (Insufficient Data) under VIGIL's launch threshold — their grades above
reflect the legacy v1.21 scorer for press comparability, but the v1.22
methodology explicitly refuses to letter-grade them.

## The two pattern extremes

**kch123 (rank #3, +$11.9M PnL):** 338 resolved bets, 0.6% win rate. A textbook
long-tail-lottery pattern: many tiny bets on far-out-of-the-money outcomes, a
few of which hit big. Brier Skill Score: **-31.3** (a score of 0 is the market
mid; negative means worse than the market).

**RN1 (rank #7, +$7.5M PnL):** 964 resolved bets, 6.2% win rate. Similar
pattern at 3× the sample size.

**swisstony (rank #8, +$6.1M PnL):** 508 resolved bets, 55.9% win rate. The
only top-PnL whale whose skill score clears the C threshold.

## How to verify

Every grade in the CSV attached is reproducible from public inputs:

1. Hit `https://vigilscore.xyz/v1/polymarket/<wallet>` — returns the JSON
   report with all raw bet data, Brier decomposition, and bootstrap CI95.
2. The full scoring formula, reference-forecast definition, and bootstrap
   procedure are published at `https://vigilscore.xyz/polymarket/methodology`.
3. If any number in the CSV differs from the live endpoint, the live endpoint
   is canonical — the CSV is a launch-day snapshot.

## Contact

- `api@vigilscore.xyz` — technical questions, methodology disputes, embargo.
- Chris Gatson, founder — available for interviews Tuesday 09:00–17:00 ET.

## What's NOT in this snapshot

- **Top 50.** Our crawler is still seeding the discovery pipeline. We'll
  publish the top-50 at `https://vigilscore.xyz/polymarket/leaderboard`
  post-launch as wallets accrue enough resolved bets to pass the INS
  threshold.
- **Live skill-weighted consensus.** See the leaderboard + featured markets
  (Iran peace deal, Strait of Hormuz, BTC $150k July 31) for the live
  divergence feed between market mid and skilled-money consensus.
- **Wallet-labels pipeline.** Ships in Elite tier post-launch; the moat, not
  the formula.

Attached: `SCORING-SNAPSHOT-PRESS-EMBARGO.csv`.
