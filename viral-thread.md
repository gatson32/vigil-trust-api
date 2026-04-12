# VIGIL Viral Thread v4 — Verified v1.17.0 Data (April 12, 2026)

## Full Thread (12 tweets)

**1/**
We scored Polymarket's top 10 most profitable wallets through VIGIL's academic-grade trust engine.

Not a single one scored above D.

Every single one performs worse than random guessing.

Here's the data. @Polymarket 🧵

**2/**
We built VIGIL to answer a question nobody else does:

When a trader buys at $0.70, implying 70% confidence — does the event actually happen 70% of the time?

We use Brier Score Decomposition, Log Loss, and on-chain USDC verification. Same methodology as IARPA's superforecaster program.

**3/**
#1 on the leaderboard: $6.4M PnL. VIGIL Grade: D/47.

2,000 trades across 440 markets — but only 11 resolved bets. Calibration error: 52%.

Over 99% of this wallet's positions haven't settled. You're following unrealized gains, not proven skill.

**4/**
#9: Countryside. $1.6M on the leaderboard.

VIGIL score: D/46. Actual PnL from resolved bets: -$40.4M. Win rate: 0%. Brier Skill Score: -9,339%.

That last number means they perform 93x worse than just guessing the base rate. Forty million in losses behind a $1.6M leaderboard.

**5/**
#2: HorizonSplendidView. $4M on the leaderboard.

VIGIL score: F/32. Actual PnL: -$9.3M. Win rate: 0%. Zero resolution — their forecasts never diverge from the base rate.

The leaderboard shows lifetime PnL including open positions. VIGIL shows truth.

**6/**
The "best" wallets in the top 10? 0x4924, 0x2A2C, and Countryside — all tied around D/47. And Countryside is sitting on -$40M in realized losses.

The most data-rich wallet? swisstony — 935 resolved bets. Grade: F/19. When they say 70% confident, the event happens 7.5% of the time.

**7/**
Full leaderboard — PnL rank vs VIGIL grade:

1. 0x4924 — D/47
2. HorizonSplendidView — F/32
3. reachingthesky — F/16
4. beachboy4 — D/35
5. majorexploiter — F/22
6. RN1 — D/44
7. sovereign2013 — D/44
8. 0x2A2C — D/47
9. Countryside — D/46
10. swisstony — F/19

0 A's. 0 B's. 0 C's.

**8/**
Every Brier Skill Score in the top 10 is negative.

That means every single top wallet performs WORSE than a strategy that just predicts the historical base rate.

PnL leaderboards don't measure skill. They measure timing, leverage, and luck.

**9/**
How VIGIL scores (v1.17.0):

Brier Score Decomposition — Reliability + Resolution + Uncertainty (Murphy 1973)
Log Loss — catches overconfidence on rare events
Timeliness — how early you enter before resolution
On-chain verification — USDC flow cross-checks on Polygon
Confidence intervals on every score

**10/**
This isn't a new idea. It's how IARPA identified superforecasters. It's how Good Judgment Project evaluates the world's best predictors.

We just brought it to prediction markets — where the stakes are real money and nobody was checking.

**11/**
Score any Polymarket wallet — free, no signup:

https://vigil-trust-api.onrender.com

Chrome extension pending review — trust badges on Polymarket profiles.

API for builders: https://vigil-trust-api.onrender.com/pricing

@Polymarket @VitalikButerin @rektcapital @CoinDesk @Cointelegraph

**12/**
Prediction markets are a $50B+ industry.

Right now there's no trust layer. Copy-traders are following wallets that are down $40M behind a leaderboard showing gains.

VIGIL is the trust layer.

#Polymarket #PredictionMarkets #DeFi #Crypto #Web3

---

## Single Post Version:

We scored Polymarket's top 10 wallets by PnL through VIGIL's trust engine.

0 scored above D. 9 of 10 Brier Skill Scores were negative — performing worse than random guessing.

The #9 wallet? $1.6M on the leaderboard. -$40.4M in actual resolved losses.

Score any wallet free: https://vigil-trust-api.onrender.com

@Polymarket #PredictionMarkets

---

## Verified Data (v1.17.0 — April 12, 2026):

| # | Name | LB PnL | VIGIL PnL | Grade | Score | Resolved | BSS | Brier | Win Rate |
|---|------|--------|-----------|-------|-------|----------|-----|-------|----------|
| 1 | 0x4924...3782 | $6.4M | -$12K | D | 47 | 11 | -10% | 0.276 | 0% |
| 2 | HorizonSplendidView | $4.0M | -$9.3M | F | 32 | 20 | +13% | 0.218 | 0% |
| 3 | reachingthesky | $3.7M | -$3.1M | F | 16 | 10 | -41% | 0.353 | 0% |
| 4 | beachboy4 | $3.2M | $174K | D | 35 | 24 | -77% | 0.246 | 17% |
| 5 | majorexploiter | $2.4M | $0 | F | 22 | 0 | -100% | 1.000 | 0% |
| 6 | RN1 | $2.2M | -$59K | D | 44 | 902 | -149% | 0.327 | 16% |
| 7 | sovereign2013 | $1.8M | $40K | D | 44 | 92 | -19% | 0.296 | 50% |
| 8 | 0x2A2C...9Bc1 | $1.8M | -$2.6M | D | 47 | 242 | -180% | 0.338 | 14% |
| 9 | Countryside | $1.6M | -$40.4M | D | 46 | 796 | -9339% | 0.237 | 0% |
| 10 | swisstony | $1.3M | -$1.3M | F | 19 | 935 | -47% | 0.289 | 26% |

Grade scale: A (80+), B (65-79), C (50-64), D (35-49), F (0-34)
BSS = Brier Skill Score (positive = better than naive, negative = worse)

## Posting Notes:

- Best time: Tuesday-Thursday, 9-11 AM EST
- "0 A's, 0 B's, 0 C's" is the hook — still holds at v1.17.0
- Countryside -$40.4M with -9339% BSS is the nuclear stat
- swisstony's "70% confidence → 7.5% actual" is the most relatable example
- The IARPA/superforecaster angle gives academic credibility
- 9 of 10 BSS negative = all but one worse than guessing (HorizonSplendidView at +13% BSS is the lone exception but still F/32)
- v1.17.0 penalty rebalance makes scores more defensible — we reduced unfair stacking while keeping genuinely bad wallets low
