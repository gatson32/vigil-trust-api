# VIGIL operations scripts

## `launch-morning-check.sh`

End-to-end smoke test of prod. Hits the health endpoint, skill
leaderboard, featured-market consensus, labels API, static pages, OG
image, sitemap, robots — exits 0 on all-green, 1 on any failure.

```bash
./scripts/launch-morning-check.sh
# or target a different environment:
BASE=https://staging.vigilscore.xyz ./scripts/launch-morning-check.sh
```

### Scheduling

**Launch-morning, one-off:** run from your laptop at 08:30 ET on launch
Tuesday. Takes ~15 seconds. Output is plain ANSI so it'll read cleanly
from the terminal.

**Recurring (recommended post-launch):** add a crontab entry. On macOS:

```
30 8 * * * cd ~/Desktop/VIGIL/vigil-trust-api && ./scripts/launch-morning-check.sh > /tmp/vigil-health.log 2>&1 || osascript -e 'display notification "VIGIL health check FAILED" with title "VIGIL"'
```

Or on a Linux host with email:

```
30 13 * * * /opt/vigil/scripts/launch-morning-check.sh | mail -s "VIGIL morning health" api@vigilscore.xyz
```

(`30 13 * * *` = 13:30 UTC = 08:30 ET — flip to `30 12` during EDT.)

### What it checks

- `/v1/health` — service status + DB
- `/v1/polymarket/leaderboard/skill` — non-INS count
- `/polymarket/markets/<slug>/consensus` — three featured launch markets
- `/v1/labels/stats` — labels API populated
- `/polymarket/methodology`, `/api/pricing`, `/about`, `/research-preview`
- `/static/og/vigil-og.png` — correct content-type
- `/sitemap.xml`, `/robots.txt`

### Exit codes

- `0` — all checks passed
- `1` — at least one failure; stdout shows which
