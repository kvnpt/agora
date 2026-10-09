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
the point of the modules being shared. What nothing *executes* is the app built
on top of them: `app.js`, `filters.js`, `bundle.js`, `map.js`. A few tests read
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
| `ANTHROPIC_API_KEY` | Reading a dropped poster with Claude (optional — without it the editor is typed by hand). Set a monthly spend limit on the key in the Anthropic Console |

A secret reaches `env` as a **string** (a Worker secret) or as an **object with
`.get()`** (a Secrets Store binding). `readSecret()` in `worker/lib/secrets.mjs`
takes either. Do not compare a binding for truthiness and call it configured —
an object always passes, and the value then renders as `[object Object]`.
