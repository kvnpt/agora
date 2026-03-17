# Agora — Orthodox Event Finder for Sydney

## Project

Aggregates Orthodox parish events in Sydney into one location-aware feed.
Core concept: **adapter system** — each parish gets a small JS module that knows how to pull events from that parish's unique source.

## Stack

- **Backend:** Node.js + Express, SQLite (better-sqlite3), node-cron
- **Frontend:** Vanilla JS, Leaflet maps, no build step
- **AI:** Claude Haiku vision for poster parsing
- **Auth:** Google OAuth (optional for browsing)

## Run

```bash
npm install
node server.js        # http://localhost:3000
```

Docker:
```bash
docker build -t agora:latest .
docker run -p 3000:3000 -v /opt/agora/data:/app/data --env-file /home/ubuntu/.env agora:latest
```

## Key Patterns

- **Adapters** live in `adapters/`. Auto-discovered by `registry.js`. Copy `_template.js` to add a new one.
- **All timestamps UTC** in DB. Frontend converts to `Australia/Sydney` via `Intl.DateTimeFormat`.
- **Dedup** via `source_hash` unique index on events table.
- **AI-parsed events** go to `pending_review` status; manual/API events are auto-approved.
- **Schema migrations** use SQLite `user_version` pragma in `db.js`.

## Deploy

Container `agora` on `homelab` Docker network. Caddy proxies `agora.orthodoxy.au` to `agora:3000`.

## Env Vars

- `ANTHROPIC_API_KEY` — for Claude Vision poster parsing
- `GOOGLE_API_KEY` — for Google Calendar adapter
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — for OAuth
- `GOOGLE_REDIRECT_URI` — OAuth callback URL
- `AGORA_SESSION_SECRET` — session cookie signing
