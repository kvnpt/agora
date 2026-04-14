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

Container `agora` on `homelab` Docker network. Caddy proxies `agora.orthodoxy.au` to `agora:3000`.

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

### Dev redeploy — **only** via `git push origin dev`

Do **not** `docker run` agora-dev by hand. The webhook passes a specific flag set; missing any one of them breaks the container (notably `AGORA_DB_PATH` — `db.js` throws at startup without it). A manual run crashed agora-dev once already.

If you truly must launch a dev container outside the webhook (e.g. testing an unpushed branch), use the **exact** flag set the webhook uses:

```bash
docker run -d --name agora-dev --network homelab \
  -p 3002:3000 \
  -v /opt/agora/data-dev:/app/data \
  -e AGORA_DB_PATH=/app/data/agora.db \
  --env-file /home/ubuntu/.env \
  agora:dev
```

Otherwise: `git push origin dev` and let the webhook do it.

## Email

To email rendered markdown: `render-md /path/to/file.md email "Subject"`
Sends styled HTML to mail@kevinpaul.au via the mailserver container. No config needed.

## Env Vars

- `ANTHROPIC_API_KEY` — for Claude Vision poster parsing
- `GOOGLE_API_KEY` — for Google Calendar adapter
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — for OAuth
- `GOOGLE_REDIRECT_URI` — OAuth callback URL
- `AGORA_SESSION_SECRET` — session cookie signing
