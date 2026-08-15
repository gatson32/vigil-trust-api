# VIGIL Polymarket Launch — Honest Readiness Checklist

*Compiled 2026-08-15 from the actual code state (v1.22.10), not the stale session-context doc. The goal of launch is not a viral spike — it's the **first paying customer.** This list is ordered by what actually blocks that.*

---

## The one-line status

**The product is built. The store window is dressed. But the cash register isn't installed** — there is no way to take a payment. That's the real gap between here and first revenue, and almost nothing else on this list matters until it's closed.

---

## What's actually DONE (verified in code)

- ✅ **Scoring engine v1.22.10** — six-dimension grades, non-linear BSS, bootstrap 95% CI on every grade.
- ✅ **Leaderboard survives redeploys.** `loadLeaderboardFromDb()` runs on boot from the `leaderboard_cache` table, *plus* a cold-boot fallback that seeds from `TOP_WALLETS` if the DB is empty. **The "pending v1.20.2 deploy" worry is obsolete** — this landed around v1.21 and is more robust than the old note claimed. The leaderboard is never blank.
- ✅ **Health endpoint** `/v1/health` exists (Render's healthcheck target).
- ✅ **Deploy config** (`render.yaml`, Dockerfile) present and coherent.
- ✅ **Anti-Sybil, wallet-labels pipeline, methodology page, ToS posture page** — all shipped.
- ✅ **Pricing page** renders at `/api/pricing` and `/v1/api/pricing` ($299 Pro / $1,499 Elite).
- ✅ **Launch marketing** — X threads, objection templates, press snapshot all drafted.

Translation: this is a real, launch-quality product. The remaining work is small and specific.

---

## 🔴 BLOCKER #1 — You can't take money (fix before anything else)

**Finding:** there is **no payment integration.** No Stripe, no checkout, no Payment Links. The pricing page shows the tiers but clicking through leads nowhere billable. The word "billing" appears only in the privacy policy text. **Right now the product literally cannot convert a willing buyer.**

This is the single most important thing on the page, because "first paying customer" is impossible without it.

**The lean fix (do this — no code, today):**
1. Create a **Stripe account** (or use one you have).
2. Create two **Stripe Payment Links** — one for Pro ($299/mo), one for Elite ($1,499/mo). Five minutes in the dashboard, zero code.
3. Point the pricing page buttons at those links.
4. When someone pays, Stripe emails you → you **manually issue their API key** and bump their tier. Ugly, manual, and completely fine for your first 5–10 customers.

**Do NOT** build a full Stripe Checkout + webhook + auto-provisioning system yet. That's the right move at ~10+ customers, not at zero. Manual key issuance for the first handful is the disciplined, focus-first path — validate that people pay before you automate collecting from them.

*(When you're ready to automate: a `/v1/api/checkout` route that creates a Checkout Session + a `/v1/webhooks/stripe` handler that provisions the API key on `checkout.session.completed`. I can scaffold this whenever you say go — it needs your Stripe secret key and price IDs as env vars.)*

---

## 🟡 NEEDS YOU — I can't do these (access/accounts)

- **Verify the live deploy.** Confirm the Render service is running the latest commit: open `https://<your-render-url>/v1/health` and check the published commit hash matches `git rev-parse HEAD`. If it's behind, Manual Deploy → Deploy latest commit. *(I can't reach your Render dashboard.)*
- **Chrome extension review.** Per the docs it was resubmitted; chase the store review to "Published."
- **Stripe account + Payment Links** (Blocker #1).
- **Custody hygiene** — the `vigil-evaluator` worker in `render.yaml` uses a `WHITELISTED_WALLET_PRIVATE_KEY` env var. Confirm that wallet holds **only trivial gas funds** and nothing you'd mourn. A leaked deploy env var is a classic drain vector — exactly the 2021 pattern. Rotate if there's any doubt.

---

## 🟢 OPEN CODE WORK — I can do these on request

Ordered by launch value:

1. **Wire the pricing buttons to Stripe Payment Links** (once you've made them) — tiny change, unblocks revenue.
2. **(Later) Automated Stripe Checkout + webhook + key provisioning** — the scaffold above.
3. **A "share this grade" public page + OG image** — every shared grade is a free ad; this is your distribution loop.
4. **Smoke-test pass** — `launch-morning-check.sh` exists; I can extend it to assert `/v1/health`, leaderboard non-empty, and a sample grade all return 200 before you flip the launch switch.

---

## The real path to first dollar (the only sequence that matters)

1. Stripe Payment Links live, pricing buttons pointed at them. *(Blocker #1 — hours.)*
2. Verify the live site is on the latest commit. *(Minutes.)*
3. Do the **ten hand-to-hand conversations** from the game plan — score wallets for real Polymarket traders, find the one who says "I'd pay for this."
4. Send them the Payment Link. **Get one payment.** That's the milestone. Everything before it is preparation; everything after it is a business.
5. *Then* fire the loud launch (threads, press, extension) at something already validated.

You are much closer than that stale doc suggested. The product's done. Install the cash register, talk to ten humans, land one. Go.
