# VIGIL × DegenClaw — Data Surface Research

**Date:** April 8, 2026
**Status:** Research complete. Implementation ready.
**Strategic context:** Freedom Council verdict (10-0) — Ship VIGIL as the on-demand risk scoring layer for DegenClaw Arena agents via an ACP job handler + minimal "paste URL, get score" page. We are the referee, not the trader.

---

## 1. What DegenClaw Arena Is

A Virtuals-Protocol-operated trading competition where AI agents autonomously trade Hyperliquid perpetuals with real USDC capital. Agents compete on a public leaderboard (`degen.virtuals.io`). Backers subscribe to agents in USDC. Virtuals puts $100K USDC behind the top 10 agents weekly via an "AI Council" evaluation (GPT-5.4 + Gemini 3.1 + Opus 4.6 ensemble).

**VIGIL's angle:** DegenClaw's built-in Council answers "who's the best?" — a ranking question. VIGIL answers "will this one blow up?" — a risk question. Different product, different buyer (backers, not grant committee), same dataset.

---

## 2. Public API Endpoints (no auth for reads)

### 2.1 DegenClaw Leaderboard — `degen.virtuals.io`

**`GET https://degen.virtuals.io/api/leaderboard?limit=1000&offset=0`**

Returns `{ data: Agent[] }` where each Agent has:

| Field | Type | Notes |
|---|---|---|
| `id` | string | Internal DegenClaw agent id |
| `name` | string | Agent display name |
| `tokenSymbol` | string | e.g. "NXR" |
| `agentAddress` | string | EVM address — **this is the Hyperliquid trading wallet** |
| `acpAgent.walletAddress` | string | Same wallet (ACP-side mirror) |
| `performance.totalRealizedPnl` | number | USDC, lifetime |
| `performance.perpRealizedPnl` | number | |
| `performance.spotRealizedPnl` | number | |
| `performance.avgRoe` | number | 0.19 = 19% |
| `performance.winRate` | number | 0-1 |
| `performance.profitFactor` | number | gross wins / gross losses |
| `performance.sortinoRatio` | number | already-computed downside risk ratio |
| `performance.compositeScore` | number | DegenClaw's own ranking score |
| `performance.rank` | number | current leaderboard position |
| `totalTradeCount` | number | |
| `winCount` / `lossCount` | number | |
| `totalTradeVolume` | number | USDC |
| `closedPositionCount` | number | |

**This single endpoint is the entire leaderboard universe.** We hit it once per cache period and have everything we need to score every agent.

### 2.2 DegenClaw Trader API — `dgclaw-trader.virtuals.io`

Per-wallet endpoints for deeper analytics:

| Endpoint | Returns |
|---|---|
| `GET /users/{wallet}/account` | balance, withdrawable USDC, margin usage |
| `GET /users/{wallet}/positions` | open positions with unrealized PnL, entry, leverage |
| `GET /users/{wallet}/perp-trades` | full trade history — every fill |
| `GET /tickers` | 417 supported markets with mark/oracle/funding |

**These give us the raw trade tape**, which is where real risk signals live — drawdown chains, martingaling, leverage spikes, concentration, tail positions.

### 2.3 ACP Agent Details — `acpx.virtuals.io`

**`GET https://acpx.virtuals.io/api/agents/{agentId}/details`**

Returns rich ACP-side metadata: `walletAddress`, `successfulJobCount`, `successRate`, `uniqueBuyerCount`, `transactionCount`, `grossAgenticAmount`, `revenue`, `isHighRisk`, `jobs[]`, `resources[]`, `metrics{}`. Useful as a cross-check signal (an agent with zero ACP reputation scoring high on DegenClaw is a different trust profile than one with 500 successful jobs).

---

## 3. VIGIL DegenClaw Risk Score — Input Signals

Given a DegenClaw agent wallet we can compute:

**Performance signals (from leaderboard)**
- Realized PnL, ROE
- Win rate, profit factor, Sortino
- Composite rank (DegenClaw's own signal)

**Risk signals (from trade tape)**
- Max drawdown (peak-to-trough equity)
- Drawdown recovery time
- Largest single-trade loss vs. account size (tail risk)
- Leverage distribution (mean, max, p95)
- Position concentration (single-asset exposure)
- Martingale detection (size doubling after losses)
- Time-to-blowup heuristic (rate of capital decay under stress)
- Trade frequency (overtrading flag)

**Reputation signals (from ACP details)**
- ACP job count + success rate (operator track record outside trading)
- Unique buyer count (market validation)
- `isHighRisk` flag (if Virtuals itself has flagged the agent)

**Subscription-price sanity check**
- Does subscription price match risk-adjusted expected return? An agent charging $50/mo USDC with a -90% drawdown history is a red flag regardless of their rank.

---

## 4. Key Constants

| Item | Value |
|---|---|
| DegenClaw trader wallet | `0xd478a8B40372db16cA8045F28C6FE07228F3781A` |
| DegenClaw trader ACP ID | `8654` |
| DegenClaw subscription agent wallet | `0xC751AF68b3041eDc01d4A0b5eC4BFF2Bf07Bae73` |
| DegenClaw subscription agent ACP ID | `1850` |
| Leaderboard base | `https://degen.virtuals.io/api/leaderboard` |
| Trader API base | `https://dgclaw-trader.virtuals.io` |
| ACP details base | `https://acpx.virtuals.io/api/agents` |

---

## 5. Implementation Plan (from research → build)

1. **`src/lib/degenclaw.ts`** — Data adapter. Exposes `fetchLeaderboard()`, `fetchAgentByNameOrId(query)`, `fetchTradeHistory(wallet)`, `fetchAcpMetrics(agentId)`. Caches leaderboard for 60s.
2. **`src/lib/scoring.ts`** — Add `computeDegenClawRiskScore(agentData)` that ingests the adapter output and emits `{ trustScore, riskScore, consistencyScore, reasoning[], flags[] }`.
3. **`src/server.ts`** — New route: `GET /v1/degenclaw/:agent` returns the score as JSON. New route: `GET /degenclaw/:agent` returns a minimal HTML score card (the "paste URL → see score" UX).
4. **`src/lib/evaluator.ts`** — Register new ACP job handler `degenclaw_risk_score`. Accepts `{ agent: string }` input, runs the scoring pipeline, returns the score deliverable.
5. **Launch** — Tweet thread with 5-10 real score permalinks, tag Virtuals + DegenClaw + top-ranked agents.
6. **BD handoff** — Draft outreach message to DegenClaw team with live data showing we've already scored their entire leaderboard.

---

## 6. Competitive moat

Any team can compute these same numbers. VIGIL's moat is:
1. **First mover** — we ship before anyone else notices DegenClaw needs this.
2. **Cross-agent trust graph** — VIGIL already scores 100s of non-DegenClaw agents. We can answer "is this agent an experienced ACP operator who just started trading, or a brand new wallet with beginner's luck?" Nobody else can do that cross-reference.
3. **On-demand ACP-native** — We're the only risk layer that's a hireable ACP service, meaning any agent in the Virtuals ecosystem can build VIGIL checks into their workflow.
4. **Data history accumulates** — Every score we compute adds to our snapshot history. In 30 days we can say "this agent's risk score trended from B+ to D- as leverage climbed" — something no single-snapshot competitor can claim.
