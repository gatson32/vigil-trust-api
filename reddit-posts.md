# Reddit Posts — Ready to Post Monday

## Post 1: r/polymarket

**Title:** We scored Polymarket's top 10 wallets by PnL. 6 out of 10 scored F. Here's the data.

**Body:**

We built VIGIL — a trust-scoring engine that evaluates Polymarket traders on 6 dimensions: calibration, live edge, profitability, consistency, discipline, and sample size.

We ran the top 10 most profitable wallets on the Polymarket leaderboard through it. The results were rough.

**Full results:**

| # | Trader | Leaderboard PnL | VIGIL Grade | Score | Resolved Bets |
|---|--------|-----------------|-------------|-------|---------------|
| 1 | 0x4924...3782 | $6.4M | D | 46 | 15 |
| 2 | HorizonSplendidView | $4.0M | F | 10 | 20 |
| 3 | reachingthesky | $3.7M | F | 12 | 10 |
| 4 | beachboy4 | $3.2M | F | 29 | 27 |
| 5 | majorexploiter | $2.4M | F | 22 | 0 |
| 6 | RN1 | $2.2M | B | 65 | 856 |
| 7 | sovereign2013 | $1.8M | D | 42 | 35 |
| 8 | 0x2A2C...9Bc1 | $1.8M | C | 59 | 254 |
| 9 | Countryside | $1.6M | F | 25 | 798 |
| 10 | swisstony | $1.3M | F | 30 | 914 |

**The standouts:**

The #1 wallet has $6.4M on the leaderboard but only 15 resolved bets out of 2,000 trades. Over 99% of their positions haven't settled yet.

Countryside shows $1.6M on the leaderboard. VIGIL's resolved PnL calculation shows -$40.4M in actual losses. 1% win rate.

The only wallet to score B or above: RN1 (#6). 856 resolved bets, Brier score of 0.10, 66% skill attribution. This is the only trader in the top 10 who demonstrably knows what they're doing.

**What VIGIL measures:**

The core insight is calibration — when a trader buys at $0.70 (implying 70% confidence), does the event actually happen 70% of the time? Most leaderboard tools show PnL, which can come from leverage, timing, unrealized gains, or one massive bet. None of that is predictive skill.

We also built a CLOB Resolution Engine that reconstructs bet outcomes from the order book after Polymarket's API purges old position data.

Score any wallet free, no signup: https://vigil-trust-api.onrender.com

Chrome extension is pending review in the Chrome Web Store — trust badges directly on Polymarket profiles.

Not financial advice. Just data.

---

## Post 2: r/CryptoCurrency

**Title:** We built a trust-scoring engine for prediction market traders. Tested it on Polymarket's top 10 wallets. Here's what we found.

**Body:**

Prediction markets are one of the fastest-growing sectors in crypto right now. Polymarket alone processes billions in volume. And one of the most common strategies people use is copy-trading — following "top wallets" based on leaderboard PnL.

The problem: PnL doesn't mean skill. It can come from unrealized gains on open positions, one leveraged bet that hasn't resolved, or structural arbitrage. None of that tells you if someone can actually forecast outcomes.

We built VIGIL to answer a different question: **is this trader actually calibrated?** When they buy at 70 cents (implying 70% probability), does the event happen 70% of the time?

We scored Polymarket's top 10 wallets by all-time PnL. 6 out of 10 scored F. Only 1 scored B or above.

The most dramatic case: a wallet showing $1.6M profit on the leaderboard has -$40.4M in resolved losses and a 1% win rate.

The only wallet that demonstrated real skill: RN1 — B/65, with an 0.10 Brier score across 856 resolved bets. For context, a Brier score under 0.15 indicates genuine forecasting ability.

**How it works:**

VIGIL scores 6 dimensions (25% calibration, 25% live edge, 15% profitability, 15% consistency, 10% discipline, 10% sample size). Every score includes a confidence interval based on the number of resolved bets. On-chain verification cross-checks API-reported PnL against actual USDC flows on Polygon.

It's free, no signup required: https://vigil-trust-api.onrender.com

We have a Chrome extension pending in the Web Store and a Telegram bot live. API access is available for builders.

Not financial advice.

---

## Posting Notes:

- Post r/polymarket first (Monday morning EST) — smaller sub, will get attention and comments
- Post r/CryptoCurrency 2-3 hours later — reference the r/polymarket discussion if it gets traction
- Engage with every comment in the first hour
- Do NOT shill — answer questions about methodology, be transparent about limitations
- If asked about code/methodology: link to the API docs, explain the Brier score, explain calibration
- If challenged: "these are informational scores, not trading signals — always DYOR"
