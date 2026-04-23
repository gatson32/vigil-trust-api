# VIGIL

**The trust engine for Polymarket geopolitics traders.**

Geopolitics is 47% of Polymarket volume — Iran peace deal, Strait of Hormuz, global elections, tail-risk. The loudest traders are rarely the most right. VIGIL grades every forecaster A–F on actual skill (Brier Skill Score + calibration) and publishes a **bootstrap 95% confidence interval on every grade**. Skill-weighted consensus across A/B wallets surfaces signal, not noise.

→ Live at **[vigilscore.xyz](https://vigilscore.xyz)**
→ Methodology: **[vigilscore.xyz/polymarket/methodology](https://vigilscore.xyz/polymarket/methodology)**
→ JSON API: **[vigilscore.xyz/v1](https://vigilscore.xyz/v1)**

---

## What VIGIL does

1. **Grade any Polymarket wallet** by pasting an address or username → returns a letter grade A–F with a 0–100 score and a 95% CI band.
2. **Skill-weighted consensus** on every live market — instead of the crowd average, a weighted consensus of wallets graded A and B, weighted by `grade × √stake × exp(-days/30)`.
3. **Divergence feed** — live leaderboard of markets where skilled money disagrees with the crowd.
4. **Alerts** when A/B-graded wallets open or close meaningful positions in geopolitics markets.

## The scoring math (no hand-waving)

Every grade is composed of six dimensions:

| Dimension | Weight | What it measures |
|---|---|---|
| Brier Skill Score | 40% | Calibration-adjusted accuracy vs. market mid at entry |
| Calibration error | 25% | Does 70% confidence resolve ~70% of the time? |
| Consistency | 15% | Performance stability across market categories |
| Discipline | 10% | Stake-to-conviction alignment; penny-lottery penalty |
| Sample size | 5% | Statistical weight of n resolved bets |
| Recency | 5% | Exponential decay, 30-day half-life |

Reference forecast = **market mid-price at the trader's entry timestamp, not resolution** (using resolution is circular — we verified three competitors make that mistake).

Bootstrap CI95: 1000 non-parametric resamples over per-bet squared errors; score range derived from the 2.5th and 97.5th Brier percentiles via the analytic score-from-Brier gradient. If n < 30 or CI span ≥ 20 points, we show `INS` (Insufficient Data) instead of a grade — we would rather publish nothing than a misleading letter.

Full derivation: [/polymarket/methodology](https://vigilscore.xyz/polymarket/methodology).

## Why this exists

The existing on-chain analytics market is bifurcated: wallet-intel platforms (Nansen, Arkham) grade based on realized PnL and activity patterns; Polymarket-native analytics (OddsJam, Unusual Whales adjacents) surface flow but not skill. Neither publishes a calibration-grounded skill score with confidence intervals. We do.

**If another team copies VIGIL, good.** Our moat isn't the formula — it's published. The moat is: (a) the wallet-labeling pipeline that disambiguates identity across wallets, (b) the live-graded leaderboard updated every 5 minutes, (c) the skill-weighted consensus API that turns grades into a signal the user actually consumes. Copy the formula; you still need the labels and the graph.

## Non-custodial by design

VIGIL never holds funds, never signs transactions, never requests private keys. We read public Polymarket data and on-chain state. Every grade is reproducible from public inputs.

After the Polycule incident, "non-custodial" has to mean something. For VIGIL it means: there is no attack surface for stolen funds because there are no funds. The only data we persist is: (a) wallet addresses we've scanned, (b) the grades and CIs we've computed, (c) email addresses of subscribers who opt in to alerts.

## Pricing

- **Free** — score any wallet, browse the leaderboard, 60 req/min
- **Pro — $299/mo** — 10k req/day API, CSV exports, full historical grades, divergence alerts
- **Elite — $1,499/mo** — unlimited API, webhook firehose, A/B-wallet position alerts <60s, wallet-label pipeline access
- **Enterprise** — custom

Pricing at [/api/pricing](https://vigilscore.xyz/api/pricing).

## Research preview

VIGIL launches in research-preview mode. We publish everything: the formula, the reference forecast, the bootstrap procedure, the INS threshold. If you find an error — in the math, the code, or a specific grade — open an issue or email `api@vigilscore.xyz`.

## Stack

TypeScript / Express / Node, Postgres with in-memory fallback. Tsx runtime (no tsc compile step). Deployed on Render with auto-deploy from `main`.

## License

See `LICENSE`.
