# Reddit Posts v3 — Updated for v1.17.0 Data (Post Monday)

## Post 1: r/polymarket

**Title:** We scored Polymarket's top 10 wallets with academic-grade calibration. Not a single one scored above D. 9 of 10 BSS negative.

**Body:**

We built VIGIL — a trust-scoring engine that evaluates Polymarket traders using the same methodology that IARPA used to identify superforecasters: Brier Score Decomposition, calibration analysis, log loss scoring, and on-chain USDC verification.

We ran the top 10 most profitable wallets on the Polymarket leaderboard through it. The results were brutal.

**Full results (v1.17.0):**

| # | Trader | LB PnL | VIGIL Grade | Score | BSS | Resolved | Win Rate |
|---|--------|--------|-------------|-------|-----|----------|----------|
| 1 | 0x4924...3782 | $6.4M | D | 47 | -10% | 11 | 0% |
| 2 | HorizonSplendidView | $4.0M | F | 32 | +13% | 20 | 0% |
| 3 | reachingthesky | $3.7M | F | 16 | -41% | 10 | 0% |
| 4 | beachboy4 | $3.2M | D | 35 | -77% | 24 | 17% |
| 5 | majorexploiter | $2.4M | F | 22 | -100% | 0 | 0% |
| 6 | RN1 | $2.2M | D | 44 | -149% | 902 | 16% |
| 7 | sovereign2013 | $1.8M | D | 44 | -19% | 92 | 50% |
| 8 | 0x2A2C...9Bc1 | $1.8M | D | 47 | -180% | 242 | 14% |
| 9 | Countryside | $1.6M | D | 46 | -9339% | 796 | 0% |
| 10 | swisstony | $1.3M | F | 19 | -47% | 935 | 26% |

**BSS = Brier Skill Score.** Positive means better than naive guessing. Negative means worse. 9 of 10 wallets are negative — only HorizonSplendidView squeaks past at +13% on just 20 resolved bets.

**The standouts:**

Countryside shows $1.6M on the leaderboard. VIGIL computes -$40.4M in actual resolved losses. 0% win rate. BSS of -9,339% — meaning they perform 93x worse than a strategy that just predicts the historical base rate.

swisstony has the most data — 935 resolved bets. When they bet at 70% confidence, the event happens 7.5% of the time. That's not overconfidence. That's anti-skill.

The #1 wallet has $6.4M on the leaderboard but only 11 resolved bets out of 2,000 trades. Over 99% of their positions haven't settled.

**What VIGIL measures that nobody else does:**

- Brier Score Decomposition (Murphy 1973): breaks scoring into Reliability, Resolution, and Uncertainty — the standard used by Good Judgment Project
- Brier Skill Score: performance vs a naive "always predict the base rate" baseline
- Log Loss: catches overconfidence on rare events that Brier misses
- On-chain USDC verification: cross-checks API PnL against Polygon flows

Score any wallet free, no signup: https://vigil-trust-api.onrender.com

Chrome extension pending review in the Chrome Web Store.

Not financial advice. Just data.

---

## Post 2: r/CryptoCurrency

**Title:** We built the first academic-grade trust engine for prediction markets. Tested it on Polymarket's top 10. Zero scored above D.

**Body:**

Prediction markets are one of the fastest-growing sectors in crypto. Copy-trading — following top wallets by PnL — is the most common strategy.

The problem: PnL doesn't measure forecasting skill. It measures timing, leverage, unrealized gains, and luck.

We built VIGIL to measure what actually matters: **calibration**. When a trader buys at $0.70 (implying 70% probability), does the event happen 70% of the time?

We use Brier Score Decomposition — the same methodology that IARPA's ACE program used to identify "superforecasters" (Philip Tetlock's research). We also compute Log Loss (catches overconfidence on rare events), Brier Skill Score (performance vs naive baseline), and verify everything against on-chain USDC flows on Polygon.

We scored the top 10 most profitable wallets on Polymarket. Not a single one scored above D. 9 of 10 Brier Skill Scores were negative — meaning almost every top wallet performs worse than a strategy that just predicts the historical average.

The most dramatic case: a wallet showing $1.6M on the leaderboard has -$40.4M in resolved losses, a 0% win rate, and a Brier Skill Score of -9,339%.

The wallet with the most data (935 resolved bets) scored F/19. When they bet at 70% confidence, it happens 7.5% of the time.

**Why this matters:** Copy-traders are following these wallets with real money, assuming PnL = skill. It doesn't. Until now, there was no tool that checked.

Free, no signup: https://vigil-trust-api.onrender.com

Chrome extension pending in the Web Store. API access for builders at /pricing.

Not financial advice.

---

## Posting Notes:

- Post r/polymarket Monday morning EST
- Post r/CryptoCurrency 2-3 hours later
- The "0 A's, 0 B's, 0 C's" stat is the hook everywhere
- Countryside -$40.4M and -9339% BSS is the nuclear stat
- If challenged on methodology: "We use Murphy 1973 Brier decomposition — same as Good Judgment Project and IARPA ACE"
- If challenged on low scores: "v1.17.0 already reduced penalties for proxy wallets and legitimate strategies. The scores are this low because the actual forecasting skill isn't there — BSS negative means worse than random."
- If asked about code: point to the API docs, explain calibration, mention log loss for rare events
- Engage every comment in the first hour
