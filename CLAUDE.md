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
docker run -p 3000:3000 -v /opt/agora/data:/app/data -e AGORA_DB_PATH=/app/data/agora.db --env-file /home/ubuntu/.env agora:latest
```

`AGORA_DB_PATH` is **required** — `db.js` throws at startup if it's unset. No silent fallback to a repo-local `./data/agora.db` (that footgun let dev & prod share a DB for a while).

Data dirs (host-side):
- Prod: `/opt/agora/data/agora.db` → mounted into `agora`
- Dev:  `/opt/agora/data-dev/agora.db` → mounted into `agora-dev` (separate volume, isolated)
- Backups: `/opt/agora/backups/` — nightly 03:15 via `/home/ubuntu/agora-backup.sh` (14-day retention, gzip)

## Key Patterns

- **Adapters** live in `adapters/`. Auto-discovered by `registry.js`. Copy `_template.js` to add a new one.
- **All timestamps UTC** in DB. Frontend converts to `Australia/Sydney` via `Intl.DateTimeFormat`.
- **Dedup** via `source_hash` unique index on events table.
- **AI-parsed events** go to `pending_review` status; manual/API events are auto-approved.
- **Schema migrations** use SQLite `user_version` pragma in `db.js`.

## Deploy

Container `agora` on `homelab` Docker network at 172.18.0.2. Caddy proxies `agora.orthodoxy.au` to `172.18.0.2:3000`. Dev is `agora-dev` at 172.18.0.3, host port 3002 (Tailscale only).

| Branch push | Deploys to | URL |
|-------------|-----------|-----|
| `git push origin dev` | `agora-dev` container, port 3002 | `http://100.64.0.2:3002` (Tailscale only) |
| `git push origin main` | `agora` container, port 3000 | `https://agora.orthodoxy.au` |

To merge dev → production:
```bash
git checkout main
git merge dev
git push origin main   # webhook auto-deploys
```

## Deploy discipline — one path rule

There is exactly one way to (re)deploy agora or agora-dev:

1. `git push origin main` → webhook rebuilds and restarts `agora` via compose
2. `git push origin dev`  → webhook rebuilds and restarts `agora-dev` via compose
3. Manual (only when debugging and you can't push):
   - Prod: `cd /home/ubuntu/agora && docker compose up -d --build agora`
   - Dev:  `cd /home/ubuntu/agora && docker compose --profile dev up -d --build agora-dev`

The compose file at `docker-compose.yml` is the single source of truth for env vars, volumes, ports, and network. **Never** run `docker run` manually for these containers — a manual `docker run` that omits `AGORA_DB_PATH` or the data-dev volume will silently diverge and crash the next restart. This is how `agora-dev` went dark on 2026-04-13.

Enforcement: `hades-guard.sh` PreToolUse hook hard-blocks `docker run agora*` and raw `docker build agora*` (outside `docker compose build`). The error message includes the correct command — copy-paste and continue.

If you need a throwaway dev instance of a different shape, give it a different container name, different port, and tear it down yourself. Do not touch `agora` or `agora-dev`.

## Email

To email rendered markdown: `render-md /path/to/file.md email "Subject"`
Sends styled HTML to mail@kevinpaul.au via the mailserver container. No config needed.

## Env Vars

- `ANTHROPIC_API_KEY` — for Claude Vision poster parsing
- `GOOGLE_API_KEY` — for Google Calendar adapter
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — for OAuth
- `GOOGLE_REDIRECT_URI` — OAuth callback URL
- `AGORA_SESSION_SECRET` — session cookie signing
