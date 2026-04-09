# DegenClaw BD Outreach — Draft

**Target:** DegenClaw / Virtuals Protocol product lead (need to identify — try @everythingempt0 or the Virtuals Discord #partnerships channel)
**Goal:** Become the official risk-score layer for DegenClaw Arena subscriptions
**Send after:** VIGIL × DegenClaw is live on prod and the launch thread has at least 24h to accumulate engagement

---

## Option 1 — Cold DM (Twitter/Discord)

Hey [name] — Chris from VIGIL (on-chain credit bureau for Virtuals agents).

Quick note: we shipped a DegenClaw risk-score module this week. 176 agents scored, live API + public pages at vigil.trust/degenclaw. Not competing with your AI Council — different question (backer-side risk vs. grant-side ranking).

Two things that might be interesting for you:

1. Of 176 DegenClaw agents, we rate 2 as B, zero as A, 131 as F. Your leaderboard is working correctly — the top ranked agents ARE better — but backers currently have no way to distinguish "sharp, robust, 100-trade track record" from "lucky 11-trade streak." We can close that gap.

2. Our scoring generated real signal: your rank-1 (Nexor, 11 trades) and rank-38 (Monyet, Sortino -0.2, +$149 PnL) are both C-grade. Rank-4 ("10") is the only B. That kind of independent confirmation / contradiction is exactly what backers need before subscribing in USDC.

Would love 20 minutes to talk about making VIGIL the default risk check on subscribe flow. Happy to send sample scores, API keys, or just show you the live pages first.

—Chris
vigil.trust · gatson32@gmail.com

---

## Option 2 — Formal partnership pitch (if they bite)

**Subject:** Partnership proposal — VIGIL risk scoring integration for DegenClaw subscriptions

Hi [name],

Thanks for the quick reply. Here's what I had in mind.

**The problem.** DegenClaw's AI Council picks winners (the $100K pot). Backers pick subscriptions (the recurring USDC). These are different decisions and currently share the same signal — the composite leaderboard rank. That's fine for picking winners, but it gives backers no way to tell "real skill with 200-trade history" from "lucky 11-trade streak" from "agent that just blew up 80% last week."

Right now backers subscribe on vibes. That's bad for the ecosystem — one high-profile blowup damages trust in the whole arena.

**What VIGIL does.** We maintain an independent, public trust score per agent based on:
- Risk-adjusted returns (Sortino, profit factor, win rate)
- Sample-size gating (we refuse to issue a high grade on thin data)
- Downside signal detection (severe drawdowns, loss streaks, leverage spikes)

Every DegenClaw agent already has a VIGIL score. Try: vigil.trust/degenclaw/Nexor or vigil.trust/degenclaw/10

**The ask — three integration levels, pick whichever works for you:**

**Tier 1 (zero commitment):** Link to VIGIL score cards from agent profiles on degen.virtuals.io. Backers see a VIGIL badge next to the composite rank, click through for the risk breakdown. No revenue share, no integration work on your side beyond a linked badge.

**Tier 2 (default check):** Embed the VIGIL score in the subscribe flow. Before a backer confirms a USDC subscription, they see the VIGIL grade and can click through for details. Reduces backer-side blowup risk significantly. Small revenue share to cover our scoring cost (e.g. $0.10 per check, billed to DegenClaw in monthly rollups).

**Tier 3 (official partnership):** "Official risk score of DegenClaw Arena." Co-marketing, mutual links, we share anonymized backer-side subscription analytics back to you so you can see which risk profiles actually retain backers. Joint announcement, thought leadership.

**Why us.** VIGIL already scores 1000+ agents across the Virtuals Protocol ecosystem. DegenClaw isn't a separate dataset — it's a new vertical on top of a platform we already cover. We're already the scoring layer; we're just asking to make it official for the arena.

**Not a threat.** We're not building a competing leaderboard. Composite rank ≠ risk score. Your AI Council product is for grant allocation, VIGIL is for backer due diligence. Different customers, different angles, complementary.

Happy to ship a prototype integration on our side within a week if there's interest. Open to any terms that work for you.

—Chris
Founder, VIGIL
vigil.trust · gatson32@gmail.com

---

## Objection handling prep

**"We already have the AI Council for this."**
The AI Council picks grant winners — that's a single-decision annual event. Backer subscriptions are continuous, small-dollar, user-initiated. Different decision, different cadence, different risk tolerance. Backers need real-time signal, not seasonal verdicts.

**"Why should we endorse a third-party score?"**
Because not endorsing one is worse — backers currently decide based on raw composite score, which is designed to reward winners, not to prevent blowups. First blowup where a high-ranked agent loses subscriber capital, the backlash lands on DegenClaw. Having an independent risk layer ATTACHED reduces that liability.

**"What's your data moat?"**
We don't have one. Anyone can compute these numbers. Our moat is (a) being first, (b) being integrated, (c) having cross-agent history — we score every agent in the Virtuals ecosystem, so we can flag "this DegenClaw agent is also a historically bad ACP actor" in ways a DegenClaw-only solution can't.

**"What if your scores are wrong?"**
Every score has transparent reasoning. If an agent owner thinks they're unfairly rated, the score card shows exactly what would move it up. No human review, no black box — just math. Agents improve their score by trading better, full stop.

**"Revenue share terms?"**
Open. $0.10 per check is a starting point. Happy to run it free for the first 30 days to prove value, then revisit.
