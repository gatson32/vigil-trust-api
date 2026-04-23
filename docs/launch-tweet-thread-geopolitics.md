# X Launch Thread v1.22.2 — Geopolitics Pivot

**v1.22.2 — updated 2026-04-22.** Hero rewrites led us to pivot the launch
narrative from "PnL lies" (generic Polymarket) to "the trust engine for
Polymarket geopolitics" (vertical specific). Geopolitics is **47% of Polymarket
weekly volume**, the Iran peace deal resolves ON launch day, and no competitor
ships a hosted skill-weighted consensus product for this category. The thread
leads with that stake.

---

## The one-tweet version (highest compression)

> 47% of Polymarket's volume is geopolitics.
> The loudest traders are rarely the most right.
>
> We graded every wallet with Brier Skill Score + a bootstrap 95% CI.
> Skill-weighted consensus on Iran, Hormuz, elections — live today.
>
> vigilscore.xyz
>
> @Polymarket

**Char count:** ~244.

---

## The full thread (13 tweets)

**1/**
47% of Polymarket's weekly volume is geopolitics.
Iran peace deal. Strait of Hormuz. Global elections. Tail-risk.

The loudest traders on these markets are rarely the most right. We built the tool that tells you who actually is.

🧵 @Polymarket

**2/**
Meet VIGIL — the trust engine for Polymarket geopolitics.

Every wallet graded A–F on real forecasting skill:
→ Brier Skill Score vs. market mid at entry (not resolution — that's circular)
→ Calibration error
→ Bootstrap 95% CI on every grade
→ "Insufficient Data" if n<30 or CI span ≥ 20 pts

Math is fully published. vigilscore.xyz/polymarket/methodology

**3/**
We graded Polymarket's top 10 by PnL. Zero As. Zero Bs. One C. Six Ds. Three Fs.

The #3 whale (+$11.9M) hit 2 of 338 resolved bets. That's 0.6%.
The #7 whale (+$7.5M) sits at 6.2% across 964.

PnL doesn't mean skill. Stake size + lucky tails do.

**4/**
The fix isn't a new leaderboard. It's a new signal.

Introducing skill-weighted consensus: on any live Polymarket market, we take every trader who's bet on it, weight them by grade × √stake × e^(-days/30), and output what the calibrated money actually thinks the probability is.

**5/**
Example, live right now.

Iran peace deal 2026 — market mid: 14%.
VIGIL skill-consensus (A/B wallets only, 42 traders, weighted): **23%**.

9-point divergence. Skilled money disagrees with the crowd. Not a trade signal. A revealed-belief signal.

vigilscore.xyz/polymarket/markets/iran-peace-deal-2026/consensus

**6/**
We ship three launch-day flagship markets on the leaderboard:
→ Iran peace deal
→ Strait of Hormuz closure
→ BTC $150k by July 31

Skill-weighted consensus updated every 5 minutes. Divergence from market mid is the interesting signal.

**7/**
On confidence intervals — the kill-shot fix.

Every grade now ships with a 1,000-iteration bootstrap CI95. If a wallet has 14 resolved bets, we don't show a letter, we show "INS" — Insufficient Data.

Better to publish nothing than a misleading grade.

**8/**
Competitor acknowledgment, since people will ask.

Nansen / Arkham: wallet intel by realized PnL + activity. Not skill.
Unusual Whales / OddsJam: flow + odds. Not forecaster grades.
Polymarket Analytics: leaderboard by volume. Not calibration.

Nobody ships hosted skill-weighted consensus. We do.

**9/**
"But if you publish the formula, won't someone copy it?"

Go ahead. The formula isn't the moat.

The moat is: (a) wallet-labeling pipeline disambiguating identity across wallets, (b) live-graded leaderboard updated every 5 min, (c) the consensus API that turns grades into an actionable signal.

**10/**
Non-custodial by design.

No private keys. No custody. No signing. We read public Polymarket data + on-chain state. After Polycule, "non-custodial" has to mean something. For VIGIL it means: there's no attack surface for stolen funds because there are no funds.

**11/**
Pricing.

Free — score any wallet, full leaderboard, 60 req/min.
Pro $299/mo — 10k calls/day, webhooks, CSV exports.
Elite $1,499/mo — unlimited, sub-60s A/B-wallet position alerts, wallet-label pipeline.
Enterprise — custom.

vigilscore.xyz/api/pricing

**12/**
This is a research preview. Everything is published:
→ Formula
→ Reference forecast definition
→ Bootstrap procedure
→ INS threshold

Find an error — in the math, the code, or a specific grade — open an issue or email api@vigilscore.xyz. We'll credit you publicly.

**13/**
Try it:

1. Paste any Polymarket wallet → grade in ~2s
2. Open the Iran market consensus → see skilled money's probability
3. Read the methodology → verify every number

vigilscore.xyz

Built by @gatson32. No VCs.

---

## Notes

- Tweet 5 needs real numbers before posting — pull current Iran-peace mid + live consensus at post time, don't ship placeholders.
- Tweet 7 INS wording assumes v1.22.0 CI95 is deployed. Verify on prod before thread goes live.
- Tweet 11 Elite $1,499 matches the pricing page /api/pricing shipped in v1.22.4.
- If launch morning shows <10 A-grade wallets globally, reframe tweet 6 as "we ship three flagship markets: consensus refreshed every 5 minutes — divergences are the signal, not the absolute numbers."
