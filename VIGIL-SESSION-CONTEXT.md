# VIGIL Trust Score Engine — Session Context
## Last Updated: April 18, 2026

---

## PROJECT OVERVIEW

VIGIL is a trust scoring engine for Polymarket prediction market traders. It scores wallets across 6 dimensions of forecasting skill and assigns letter grades (A-F). The goal is to be the "credit bureau" for prediction market traders — separating genuine skill from luck/bots/noise.

**Stack:** Node/TypeScript API on Render.com, PostgreSQL database, Polymarket data APIs
**Repo:** https://github.com/gatson32/vigil-trust-api
**Live:** https://vigil-trust-api.onrender.com/polymarket
**Leaderboard:** https://vigil-trust-api.onrender.com/polymarket/leaderboard

---

## CURRENT STATUS (v1.20.2)

### What's Working
- **23,659 wallets scanned** by discovery crawler
- **Scoring model v1.20.1** is live and producing correct grades
- influenz.eth ($1M+ PnL) now correctly scores **A/95** (was stuck at D/49)
- products ($700K PnL) scores **B/79**
- 123987456 ($121K PnL) scores **A/84**
- Chrome extension resubmitted (was rejected for unused `activeTab` permission — fixed and resubmitted)

### What's Pending (NEEDS PUSH + DEPLOY)
- **v1.20.2 is committed but NOT pushed/deployed yet**
- v1.20.2 adds `leaderboard_cache` PostgreSQL table so the leaderboard survives Render redeploys
- Without this, every redeploy wipes the in-memory leaderboard and shows empty page for ~2 minutes
- **Action needed:** `git push` then Manual Deploy on Render dashboard

### Known Issue
- Render Manual Deploy URL: Go to https://dashboard.render.com → click "My project" → find vigil-trust-api service → "Manual Deploy" → "Deploy latest commit"
- Git lock files sometimes block commits from sandbox — run `rm -f .git/HEAD.lock .git/index.lock` from local terminal

---

## SCORING MODEL (v1.20.1)

### Weights
```
calibration:   0.25  (BSS-driven, non-linear mapping)
profitability: 0.20  (ROI scaling: -20% = 0, +30% = 100)
liveEdge:      0.20  (open position performance)
consistency:   0.15  (IQR-based, doesn't penalize winners)
discipline:    0.10  (market diversification + position sizing)
sampleSize:    0.10  (resolved bet count tiers)
```

### Grade Thresholds
- A: 80+ (SHARP)
- B: 65+ (SOLID)
- C: 50+ (DEVELOPING)
- D: 35+ (RISKY)
- F: <35 (DANGER)

### Proven Winner Bonus
- +8 pts: 500+ resolved bets, positive BSS, positive PnL
- +5 pts: 250+ resolved bets, positive BSS, positive PnL
- +3 pts: 100+ resolved bets, BSS > 0.10, positive PnL

### BSS (Brier Skill Score) Mapping — Non-Linear
```
BSS <= -1:     0
BSS -1 to 0:   0 → 50 (linear)
BSS 0 to 0.10: 50 → 70 (above baseline)
BSS 0.10 to 0.25: 70 → 90 (elite territory)
BSS 0.25+:     90 → 100 (world-class, asymptotic)
```

### Penalties
- **Penny-lottery:** 30pts if 80%+ sub-$0.10 bets AND BSS negative; 15pts if 50%+
- **Receive-only wallet:** 5pts if zero outbound txs
- **PnL divergence:** FLAG ONLY (no score penalty as of v1.20.0) — Polymarket proxy architecture causes false divergence
- **Hard cap:** Penny + receive-only + negative BSS → capped at D/49. Does NOT apply if BSS is positive (v1.20.1 fix)

### Calibration Formula
```
calScore = (1 - calibrationError * 2) * 100  (40% weight)
bssScore = non-linear mapping above          (60% weight)
calibrationDim = calScore * 0.4 + bssScore * 0.6
```

### Profitability Formula
```
roi = totalPnl / totalVolume
profitabilityDim = (roi + 0.2) * 200  (clamped 0-100)
// ROI -20% = 0, ROI 0% = 40, ROI +10% = 60, ROI +30% = 100
```

### Consistency Formula (IQR-based)
```
betReturns = resolvedBets.map(b => b.pnl / (b.size * b.impliedProb))
q1 = 25th percentile, q3 = 75th percentile
iqr = q3 - q1
iqrScore = (1 - iqr / 2) * 100
profitBonus = median > 0 ? min(15, median * 30) : 0
consistencyDim = min(100, iqrScore + profitBonus)
```

---

## KEY FILES

### `/src/lib/polymarket.ts`
- All scoring logic, calibration computation, BSS calculation
- Discovery crawler (crawlResolvedMarkets, scoreAndBuildLeaderboard)
- In-memory leaderboard store + DB persistence (v1.20.2)
- `WEIGHTS` constant at ~line 705
- `scorePolymarketTrader()` main scoring function at ~line 732
- Penalties section at ~line 950+
- Crawler at ~line 1294+
- `loadLeaderboardFromDb()` at ~line 1283 (v1.20.2)

### `/src/server.ts` (~3500+ lines)
- Express API + server-rendered HTML pages
- `TOP_WALLETS` array for prescore cron
- `knownEliteWallets` loaded from `discovery_alerts` table on boot
- Homepage renderer at ~line 3141
- Prescore cron at ~line 3154
- Boot sequence at ~line 3048 (DB loads, cron scheduling)
- Leaderboard HTML page rendering (inline templates)

### `/src/lib/db.ts`
- PostgreSQL connection and table creation
- Tables: `discovery_alerts`, `leaderboard_cache` (v1.20.2), `email_subscribers`, etc.

### `/chrome-extension/`
- Manifest V3 Chrome extension
- Injects trust badges on Polymarket profile pages
- Popup search for any wallet
- Submitted to Chrome Web Store (resubmitted after `activeTab` rejection fix)

---

## VERSION HISTORY

| Version | Changes |
|---------|---------|
| v1.19.0 | BSS-driven calibration, IQR consistency, simplified gating, weight rebalance |
| v1.20.0 | Remove PnL divergence penalty, non-linear BSS mapping, profitability 20%, proven winner bonus |
| v1.20.1 | Fix penny-lottery hard cap — only applies when BSS is negative |
| v1.20.2 | Persist leaderboard to PostgreSQL `leaderboard_cache` table (PENDING DEPLOY) |

---

## ARCHITECTURE

### Cron Jobs (after boot)
- **Prescore:** 30s delay, then hourly — scores `TOP_WALLETS` array
- **Discovery crawler:** 2min delay, then every 2 hours — scans 500 markets, scores 500 wallets

### Boot Sequence
1. Connect to PostgreSQL
2. Load `leaderboard_cache` → in-memory leaderboard (v1.20.2)
3. Load `discovery_alerts` → `knownEliteWallets` for homepage elite section
4. Start Express server
5. Schedule prescore cron (30s)
6. Schedule discovery crawler (2min)

### Data Flow
```
Polymarket APIs → Discovery Crawler → scorePolymarketTrader() → In-Memory Leaderboard → leaderboard_cache (PostgreSQL)
                                                                                      → discovery_alerts (A/B only)
                                                                                      → prescoredCache (Map, 2hr TTL)
```

### Rate Limiting
- 3-second delay between wallet scores in prescore cron
- 300ms delay every 5 wallets in crawler
- Render.com deployment

---

## BUGS FIXED (ALL SESSIONS)

1. **Calibration used resolution sub-component** (near-zero for Polymarket) → Now uses BSS (v1.19.0)
2. **Live Edge 25% weight** measuring noise → Reduced to 20%
3. **Profitability needed +50% ROI** to max out → Realistic scaling (v1.19.0)
4. **Consistency CV penalized winners** → IQR-based (v1.19.0)
5. **6-tier gating caps** compressed all scores → Simplified 3-tier (v1.19.0)
6. **PnL divergence -15pts** hit every big trader → Flag-only (v1.20.0)
7. **Linear BSS mapping** compressed elite forecasters → Non-linear (v1.20.0)
8. **Penny-lottery hard cap** locked skilled penny traders at D/49 → BSS-positive exemption (v1.20.1)
9. **Leaderboard in-memory only** wiped on every deploy → PostgreSQL persistence (v1.20.2)
10. **Chrome extension `activeTab`** unused permission → Removed (resubmitted)

---

## LAUNCH PLAN

- **Target:** Tuesday viral launch
- **Chrome extension:** Resubmitted, awaiting review (1-3 business days)
- **Leaderboard:** Needs v1.20.2 deployed for persistence
- **Scoring:** Model is solid — A-grades for million-dollar forecasters, D-grades for bad calibrators regardless of PnL
- **Data:** 23,659 wallets discovered, ~500 on leaderboard with full scores
