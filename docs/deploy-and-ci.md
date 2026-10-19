# Deploying, CI and checking your change

How a merge becomes a deploy, why green CI is the gate, and what CI cannot see. Split out of CLAUDE.md, which keeps the rules that bite and links here for the reasons.

Deploying is automated, because it has to be: `wrangler deploy` needs Node, and
the dashboard's inline editor cannot take the thousand-odd static assets that
ship with the code. **Cloudflare Workers Builds** does it — the repo is connected
in the Cloudflare dashboard and every push to `main` deploys.

There is no deploy workflow in `.github/workflows/`, deliberately. One existed
(`wrangler-action` behind a `CLOUDFLARE_API_TOKEN`) and was deleted rather than
kept alongside, because two deploy paths race on every push. Workers Builds needs
no credential stored anywhere, which is worth more here than the test gate it
gives up — CI still runs on every pull request, so the gate lives there instead.

**Green CI is the merge gate, not a human.** A pull request whose checks pass may
be merged without waiting for a review, Claude's own included. It is the same
reasoning that deleted the deploy workflow: the gate that actually catches things
here is the machine one, and a review step nobody is reliably awake for is a
queue rather than a safeguard. Merging is deploying, so it is the check being
*green* that earns the merge — a red or still-running one waits, every time, and
"probably a flake" is not a reason to merge past it.

What that buys has a limit worth naming, and it is not "CI cannot see the
frontend". `public/shared/` is covered well — the projection, the timezone maths,
the dedup and the slug tables are imported by the suite directly, which is half
the point of the modules being shared. What nothing *executes* is the page built
on top of them: `next/next.js`, `next/editing.js`, `bundle.js`, `map.js`. A few tests read
those as text, to assert they reach for the shared table rather than keeping a
private copy, and that is not the same as running them.

So a change to rendering, filtering or wiring merges on the strength of whatever
its author did to check it, and the PR should say what that was. Reproducing the
fault against the old code first and then re-measuring is the honest version.
"Tests pass" is not, when no test ran the line that changed.

**`docs/browser-checks.md` is how to do that here** — driving the app with
Playwright, the console noise that is environmental rather than yours, and the
way `/api/bundle` is cached, which used to make a write you had just made
look like it never happened.

It also records where the risk actually sits, which is not where it feels like
it sits. Two bugs shipped in one week with full test coverage of their logic and
a broken **way in**: a combine ask whose parish list came back empty for the
only role that needed it, and a notices panel whose render was unreachable
behind an early return. Neither was a logic error; neither could fail a test.
Test the behaviour, then open the thing and check the door is there.

```bash
npm run deploy       # the same thing, if you do have a terminal
```

`docs/deploy.md` is the runbook, written for a browser and nothing else: the
Cloudflare dashboard and the GitHub Actions tab, in order, with the check that
proves each step landed. It also covers the two things that block a *useful* site
rather than a working one — the missing basemap archive, and the one adapter
whose parish is not in the seed.

Secrets (set once, via `wrangler secret put` or the dashboard):

| Secret | For |
|---|---|
| `GOOGLE_API_KEY` | The Google Calendar adapter |
| `ACCESS_TEAM_DOMAIN` | Cloudflare Access, e.g. `yourteam.cloudflareaccess.com` |
| `ACCESS_AUD` | The Access application's audience tag |
| `ANTHROPIC_API_KEY` | Reading a dropped poster with Claude, and suggesting a parish's acronym from its names (optional — without it the editor is typed by hand, and the acronym comes from the initials rule). Set a monthly spend limit on the key in the Anthropic Console |

Not a secret but worth knowing here: the `EMAIL` binding (Cloudflare Email
Sending, for the claim emails) is commented out in `wrangler.toml` until the
account is on Workers Paid with orthodoxy.au onboarded as a sending domain —
docs/people-and-access.md, "Emails about claims".

A secret reaches `env` as a **string** (a Worker secret) or as an **object with
`.get()`** (a Secrets Store binding). `readSecret()` in `worker/lib/secrets.mjs`
takes either. Do not compare a binding for truthiness and call it configured —
an object always passes, and the value then renders as `[object Object]`.

## Previews

Every pull request gets a **Worker Preview**: Workers Builds builds the branch
with `npx wrangler preview` and comments the link on the PR —
`<branch>-agora.<subdomain>.workers.dev`. It is the way to see a change to the
four files CI never runs, from a phone, before merging.

A Preview binds **only** what `wrangler.toml`'s `[previews]` block declares —
Cloudflare inherits no binding, var or secret from the top level — and that
block is the whole safety story:

- **Data:** `agora-preview` (D1) and `agora-preview` (R2), a copy. Nothing a
  Preview writes reaches production, the data version included (it lives in the
  bucket).
- **No secrets.** No `ACCESS_*`, so the admin API refuses everyone and a Preview
  needs no Access policy; no Anthropic, Google or GitHub key, so those features
  degrade the way they are built to. A public link with no key on it is safe to
  leave public. Adding a secret to `[previews]` ends that, so don't.
- **No cron**, by Cloudflare's design, so no scrape runs against the copy. Email
  is not declared either.
- **No indexing:** Cloudflare sends `noindex` on workers.dev Preview URLs.

`preview_urls = true` is what gives a Preview a URL. It also brings back the
version-preview workers.dev hostnames `workers_dev = false` was set to remove;
those run production's bindings, but the admin page there is the same door the
top of `wrangler.toml` describes, with the admin API still refusing behind it.

`.github/workflows/previews.yml` looks after the rest:

- **Closing a PR deletes its Preview.** Cloudflare keeps one until it is deleted
  or evicted at the cap (100 per Worker on Free, 500 on paid), so without this a
  PR open for an hour leaves a link that works for months.
- **"Run workflow" refreshes the copy** — from production (`d1 export`, then the
  bucket synced server-side) or from the dev seed — and bumps its data version.
  It reads production and writes only the names it checks are not production's.
  A migration reaches production before its merge (docs/database.md), so a
  production refresh already has it; a seed refresh builds from the branch's
  baseline.

Both need repository secrets `CLOUDFLARE_API_KEY` (an API token, not the
Global API Key: Workers Scripts: Edit, D1: Edit) and `CLOUDFLARE_ACCOUNT_ID`, and the bucket copy uses the `R2_*` keys the
basemap workflow has, which must reach `agora-preview` too. That is a Cloudflare
credential in GitHub after all — not for deploying, which stays with Workers
Builds alone, so nothing races.
