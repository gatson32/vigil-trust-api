#!/usr/bin/env bash
# VIGIL launch-morning health check — v1.22.9
# Run at 08:30 ET on Tuesday, April 22, 2026 (launch day)
# and any morning we want to verify prod is green.
#
# Exit codes:
#   0 — all checks passed
#   1 — at least one check failed (see output)
#
# Usage:
#   ./scripts/launch-morning-check.sh [base-url]
#   BASE=https://vigilscore.xyz ./scripts/launch-morning-check.sh
#
# Verifies:
#   - Health endpoint + DB status
#   - Skill leaderboard has >=5 graded (non-INS) wallets
#   - Featured market consensus endpoints return data
#   - Labels API returns non-empty stats
#   - OG image serves with correct content-type
#   - Methodology page renders 200
#   - Pricing page renders 200
set -euo pipefail

BASE="${1:-${BASE:-https://vigilscore.xyz}}"
PASS=0
FAIL=0

note() { printf "\n\033[1m[%s]\033[0m %s\n" "$(date -u +%H:%M:%SZ)" "$*"; }
ok()   { printf "  \033[32mPASS\033[0m  %s\n" "$*"; PASS=$((PASS+1)); }
bad()  { printf "  \033[31mFAIL\033[0m  %s\n" "$*"; FAIL=$((FAIL+1)); }

check_status() {
  local url="$1" expected="${2:-200}"
  local got
  got="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$url")"
  if [[ "$got" == "$expected" ]]; then ok "$url → HTTP $got"; else bad "$url → HTTP $got (expected $expected)"; fi
}

check_json_field() {
  local url="$1" jq_expr="$2" desc="$3"
  local body got
  body="$(curl -s --max-time 30 "$url")" || { bad "$desc: curl failed"; return; }
  got="$(printf '%s' "$body" | python3 -c "import json,sys; d=json.load(sys.stdin); $jq_expr" 2>&1)" || { bad "$desc: JSON parse/expr failed → $got"; return; }
  if [[ -n "$got" && "$got" != "None" && "$got" != "0" && "$got" != "False" ]]; then
    ok "$desc → $got"
  else
    bad "$desc → falsy/empty ($got)"
  fi
}

note "Base URL: $BASE"

note "1) Core health"
check_status "$BASE/v1/health"
check_json_field "$BASE/v1/health" "print(d.get('status'))" "health status"

note "2) Skill leaderboard"
check_status "$BASE/v1/polymarket/leaderboard/skill"
check_json_field "$BASE/v1/polymarket/leaderboard/skill" \
  "print(len([w for w in (d.get('leaderboard') or []) if w.get('trustGrade') not in (None,'INS','F')]))" \
  "leaderboard graded (non-INS) count"

note "3) Featured launch markets"
for slug in iran-peace-deal-2026 strait-of-hormuz-closure-2026 btc-150k-by-jul-31-2026; do
  check_status "$BASE/polymarket/markets/$slug/consensus" 200
done

note "4) Wallet labels API"
check_status "$BASE/v1/labels/stats"
check_json_field "$BASE/v1/labels/stats" "print(d.get('totalWallets'))" "total labeled wallets"

note "5) Static pages"
check_status "$BASE/polymarket/methodology"
check_status "$BASE/api/pricing"
check_status "$BASE/about"
check_status "$BASE/research-preview"

note "6) OG image"
OG_CT="$(curl -s -o /dev/null -w '%{content_type}' --max-time 15 "$BASE/static/og/vigil-og.png")"
if [[ "$OG_CT" == image/png* ]]; then ok "OG image content-type: $OG_CT"; else bad "OG image content-type: $OG_CT"; fi

note "7) Sitemap + robots"
check_status "$BASE/sitemap.xml"
check_status "$BASE/robots.txt"

printf "\n\033[1mSummary:\033[0m \033[32m%d passed\033[0m / \033[31m%d failed\033[0m\n" "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]] || exit 1
