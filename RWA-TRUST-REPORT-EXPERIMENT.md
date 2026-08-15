# Experiment Spec — "RWA Trust Report" (the weekend test)

*A cheap, hand-run validation to answer ONE question before spending real time on RWA: does the retail market want a VIGIL-style trust score for tokenized real-world assets? Run this AFTER the Polymarket launch has paying users — not before.*

---

## Hypothesis (what we're testing)

> Normal people buying long-tail tokenized-RWA tokens (fractional real estate, small private-credit pools, new "RWA" tokens) have no trustworthy way to answer *"is this actually backed by anything, and can I trust this issuer?"* — and a free, rigorous, wallet-pasteable grade would get shared and eventually paid for.

We are **not** testing whether RWA is big (it is) or whether institutions want ratings (Credora/Particula already serve them). We're testing whether **retail wants a trust grade**, because that's the only seam VIGIL could enter.

## The one metric that decides go / no-go

Publish the report, then watch for **one week**:

- **GO signal:** it gets shared unprompted, people reply asking "can you grade X?", or ≥1 person asks to pay / subscribe for ongoing grades.
- **NO-GO signal:** crickets. A few polite likes, no shares, no requests, no willingness to pay.

Write the decision rule down now so euphoria/sunk-cost doesn't rewrite it later: **no organic "do more of this" demand in 7 days = RWA is not market #2. Drop it and stay focused on Polymarket.**

## Hard constraints (protect your focus)

- ⏱️ **Timebox: one weekend to build, one week to observe.** If it runs long, you're pivoting, not testing. Stop.
- 🚫 No smart contracts. No token. No new domain/brand. No institutional positioning.
- 🚫 No new code in the first pass — this is done **by hand, in a Google Doc / X thread.** You're testing demand, not building product. Code only comes if the test passes.
- ✅ Reuse the VIGIL brand and voice. This is "VIGIL turns its lens on RWA," not a new company.

---

## Step 1 — Pick 15–20 targets (the messy long tail, not the giants)

Do NOT grade BUIDL or Ondo — the giants are safe and boring and already covered. Grade the stuff a normal person might actually ape into and get hurt by:

- **Tokenized real estate:** 6–8 specific properties from **RealT** and **Lofty**.
- **Small private-credit pools:** 3–4 from **Centrifuge / Goldfinch / Maple** (the smaller, newer pools, not the flagship).
- **"RWA" tokens on Base / Solana:** 4–6 newer tokens claiming real-world backing — including at least 2 you *suspect* are RWA-in-name-only. The contrast is the content.

Use **rwa.xyz** and **DIA** to find candidates and pull their metadata.

## Step 2 — The rubric (VIGIL-style, 6 factors, A–F)

Score each target 0–100 on six factors, then map to a letter grade (reuse VIGIL's A/B/C/D/F bands). These six are the retail-readable version of the institutional RWA risk factors the real raters use:

| # | Factor | The question | Weight |
|---|---|---|---|
| 1 | **Proof of backing** | Is there verifiable proof-of-reserves / attestation (Chainlink PoR, Chronicle, an auditor) that the asset exists? Or just a claim? | 30% |
| 2 | **Issuer identity** | Is the issuer a real, named, findable legal entity — or anon? | 20% |
| 3 | **Legal wrapper** | Is there a real legal claim (LLC interest, SPV, fund share) or just a token with a promise? | 20% |
| 4 | **Redemption path** | Can a holder actually redeem / exit for the underlying, and is that mechanism documented? | 15% |
| 5 | **Jurisdiction & custody** | Where is it domiciled, who custodies the asset, is it bankruptcy-remote? | 10% |
| 6 | **Liquidity reality** | Is there real secondary liquidity, or would exiting crater the price? | 5% |

**The killer feature = the "RWA-in-name-only" flag.** Any token scoring near-zero on factors 1+3 (no verifiable backing, no legal claim) gets a loud **"RWA IN NAME ONLY"** badge. That contrast — genuinely-backed vs. narrative-cosplay — is the whole story, and it's your 2021-hack story turned into a product.

## Step 3 — Publish (free, one page)

A single "VIGIL RWA Trust Report #1" — a table of the 15–20 grades, each with a one-line why, the six-factor breakdown for the 3 most interesting, and the "IN NAME ONLY" flags called out. Google Doc or a landing page; whichever ships Saturday.

## Step 4 — Distribute (same playbook as Polymarket)

- An X thread led by the most surprising result ("I graded 20 'RWA' tokens on whether they're actually backed. 5 aren't. Here's the list 🧵").
- Post in RWA-focused Telegram/Discord/subreddits.
- DM 5 people who hold or shill long-tail RWA tokens: "graded yours — want the breakdown?"
- Tie it to your real story: *"I lost everything to a hack in 2021. Now I grade whether 'backed' actually means backed."*

## Step 5 — Decide, honestly

At day 7, apply the go/no-go rule from the top. Two legitimate outcomes:
- **GO:** you found market #2. Now — and only now — is building RWA scoring into VIGIL's engine justified. It's cheap because factors 1–6 slot into the existing scoring architecture.
- **NO-GO:** you spent a weekend, not a quarter, and you *know* instead of wondering. Back to Polymarket with a clear conscience.

---

## Why this maps onto what you already built

If the test passes, you're not starting over — VIGIL already has: a scoring engine with weighted factors + letter grades, a confidence-interval framework, a non-custodial "we prove everything" posture, a Chrome extension pattern, and shareable grade pages. An RWA trust score is a **new rubric in an existing machine**, not a new machine. That's exactly why RWA is a strong *expansion*, and exactly why it must wait until the machine has paying customers on market #1.
