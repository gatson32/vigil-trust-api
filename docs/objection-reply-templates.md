# Objection Reply Templates — Launch Day

**v1.22.7 — 2026-04-22.** Pre-written replies to the objections we expect within
the first 48 hours of the X launch thread. Every reply is ≤ 280 chars and
written to be posted as a quote-tweet, in-thread reply, or DM without edits.

Rules:
- Never defensive. Never apologetic. Never dunk.
- Every reply points to a public URL the skeptic can verify in ≤ 60s.
- If a reply cites a number, it must match prod at post time. Re-check before sending.
- "Don't know yet" is a valid answer if we commit to a date.

---

## 1. "This is just PnL with extra steps."

No. PnL rewards whales with 3 lucky tails.

We score by **Brier Skill Score vs. market mid at entry** + calibration, with a
bootstrap 95% CI on every grade. The #3 top-PnL wallet has a 0.6% win rate on
338 resolved bets. Skill ≠ stake.

→ vigilscore.xyz/polymarket/methodology

---

## 2. "The reference forecast is circular."

It's not. We benchmark against **market mid at the trader's entry timestamp**,
not resolution. Using resolution as the benchmark is circular — three of the
competitors we audited actually do that.

Methodology is published, bootstrapped, and line-numbered.

→ vigilscore.xyz/polymarket/methodology#reference-forecast

---

## 3. "Bootstrap CIs on a non-stationary process are meaningless."

Fair concern. That's why we use non-parametric resampling over per-bet squared
errors (not returns), and publish `INS` instead of a grade whenever the CI95
span ≥ 20 points OR n < 30.

We would rather publish nothing than a misleading letter.

---

## 4. "If you publish the formula, someone will just copy it."

Go ahead.

The formula isn't the moat. The moat is:
(a) wallet-label pipeline disambiguating identity,
(b) live-graded leaderboard every 5 min,
(c) skill-weighted consensus API.

Copy the formula — you still need the labels and the graph.

---

## 5. "You're just another Nansen."

Nansen and Arkham grade by realized PnL + activity. That is not forecasting
skill. Neither publishes a calibration-grounded score with confidence intervals
on prediction markets.

VIGIL is the first hosted skill-weighted consensus product for Polymarket.

---

## 6. "Polymarket users are degens, not forecasters."

47% of Polymarket weekly volume is **geopolitics** — Iran peace deal, Hormuz
closure, elections, tail-risk. Those markets have real experts behind some
wallets. Our job is to find which ones, with math.

Look at the Iran peace deal consensus right now → 9pt divergence from market
mid. That's not degens.

---

## 7. "Sample sizes are too small for letter grades."

Agreed. That's exactly why we ship `INS` (Insufficient Data) on any wallet
with n<30 resolved bets or a CI95 span ≥ 20pts. At launch, far more wallets
will be INS than graded. That's a feature.

→ vigilscore.xyz/polymarket/methodology#insufficient-data

---

## 8. "How do you prevent Sybils from gaming your leaderboard?"

Three layers, all shipped in v1.22.8:

1. Wallets <30 days old are force-INS regardless of bet count.
2. Consensus weight scales `log(wallet_age_days)` between 30d→0x and 730d→1x.
3. Stake-size weighted (`√stake`), not count-weighted — a fresh Sybil needs
   real USDC at real risk, not more wallets.

Full spec: vigilscore.xyz/polymarket/methodology#anti-sybil

---

## 9. "This violates Polymarket's ToS."

We use public data: Gamma API, CLOB log, on-chain USDC + redemption events.
No scraping of logged-in pages, no credential reuse, no downstream redistribution.

We also publish a standing offer: if Polymarket wants an integration, we'll
operate under their API terms. api@vigilscore.xyz.

→ vigilscore.xyz/about

---

## 10. "Non-custodial is marketing. What's your actual attack surface?"

The attack surface is: our grading bug produces misleading trust scores.
That's why the full formula, the reference forecast definition, the bootstrap
code, and the INS threshold are all public.

We hold zero user funds, zero private keys, zero signing authority.
After Polycule, that distinction is not optional.

---

## 11. "Your API pricing is insane for a research preview."

Research preview is free. 60 req/min forever.

Pro ($299) unlocks 10k/day + historical grades. Elite ($1,499) unlocks the
wallet-label pipeline and <60s A/B-wallet position alerts. Comp set:
Nansen Alpha $1.5k, Arkham Ultra $2k+, OddsJam $349.

We're positioned mid-market. Enterprise pricing is custom.

→ vigilscore.xyz/api/pricing

---

## 12. "I paste my wallet and get a D. Your model is wrong."

Maybe it is. The provenance on every grade shows which bets drove it, the
Brier decomposition, and which markets anchored the CI. If the math is wrong
on YOUR wallet specifically, email api@vigilscore.xyz — we'll credit you
publicly for finding it.

→ vigilscore.xyz/v1/polymarket/YOUR_WALLET

---

## Bonus — the trolls

**"Who even asked for this?"**
Anyone who's ever read a Polymarket thread and wondered which loud wallet was
actually skilled. 47% of volume is geopolitics. Someone had to build this.

**"rug pull inbound"**
Zero custody. Zero signing. Zero funds on our side. Read what we hold:
vigilscore.xyz/about#data

**"Show me a single Grade A wallet."**
If we don't have one on launch day, we'll say so rather than force one.
Better to ship INS honestly than to inflate grades. Check the leaderboard live:
vigilscore.xyz/polymarket/leaderboard

---

## Operator checklist before replying

- [ ] The number in the reply matches the live page right now.
- [ ] The URL resolves (not a 404 from a renamed route).
- [ ] The tone is factual, not defensive.
- [ ] If the reply cites a competitor, the claim is accurate (no strawmen).
- [ ] If you don't know the answer, say so and give a date.
