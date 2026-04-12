# Twitter Bot (@VIGILscore) — Setup Guide

## 1. Create Twitter Developer Account
1. Go to https://developer.twitter.com
2. Apply for API access (Free tier = 1,500 tweets/month)
3. Create a new App called "VIGIL Trust Score"

## 2. Get API Keys
From the Developer Portal → Your App → Keys and Tokens:
- `TWITTER_API_KEY` (Consumer Key)
- `TWITTER_API_SECRET` (Consumer Secret)
- `TWITTER_ACCESS_TOKEN`
- `TWITTER_ACCESS_SECRET`
- `TWITTER_BEARER_TOKEN`

## 3. Add to Render Environment
In Render dashboard → vigil-trust-api → Environment:
```
TWITTER_API_KEY=xxx
TWITTER_API_SECRET=xxx
TWITTER_ACCESS_TOKEN=xxx
TWITTER_ACCESS_SECRET=xxx
```

## 4. Bot Features (to build)

### Reply Bot
When someone tweets "@VIGILscore 0x..." or "@VIGILscore username":
- Score the wallet
- Reply with grade, score, top 3 dimensions, PnL
- Include link to full scorecard
- Include OG image for card preview

### Daily Leaderboard
Auto-tweet daily at 9am EST:
- Top 3 movers (biggest score changes)
- Worst-to-best improvements
- New wallets scored

### Whale Alert
When a wallet with 1000+ trades gets scored for the first time:
- Tweet the result with context
- Tag relevant Polymarket-related accounts

## 5. Bot Code Location
Once API keys are set, the bot code will be added to:
`/src/lib/twitter-bot.ts`

And integrated into server.ts similar to the Telegram bot.

## 6. Rate Limits (Free Tier)
- 1,500 tweets/month
- 50 tweets/day is safe
- Budget: 30 replies + 1 daily leaderboard + ~19 whale alerts
