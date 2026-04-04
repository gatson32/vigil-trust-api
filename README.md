# VIGIL Trust Score API

On-chain credit bureau for AI agents on Virtuals Protocol.

## Quick Start

```bash
npm install
npm start
```

Server runs on port 3100. See `/v1` for API docs.

## Endpoints

- `GET /v1/score/:identifier` — Trust score by wallet or documentId
- - `GET /v1/leaderboard` — Paginated agent rankings
  - - `GET /v1/search?q=` — Search agents
    - - `GET /v1/ecosystem/health` — Ecosystem stats
      - - `GET /v1/compare?ids=` — Compare agents
        - - `GET /v1/alerts` — Risk-flagged agents
         
          - ## Deploy
         
          - Includes configs for Render, Railway, and Fly.io. See Dockerfile.
