# Checking the frontend in a browser

CLAUDE.md names the limit: CI covers `public/shared/` well and **executes none
of** `app.js`, `filters.js`, `bundle.js` or `map.js`. So a change to rendering,
filtering or wiring merges on the strength of whatever its author did to check
it. This is how to do that here, and what has already cost time.

Everything below was worked out the hard way. It is written down so the next
session spends its time on the change rather than on the harness.

## Where the bugs actually are

Two shipped-and-caught bugs in one week, both the same shape:

| | The logic | The way in |
|---|---|---|
| Combine asks | correct, tested, 26 passing tests | the parish list came back **empty** for a contact, so the ask was unreachable |
| Parish notices | correct, tested, 6 passing tests | `renderProposals()` early-returned before the new section, so it never rendered for the only person who sees it |

Neither was a logic error and neither could fail a test. **The risk concentrates
at the entry point to a new feature — the control that reveals it — not in the
feature's behaviour.** Test the behaviour, then open the thing and look for the
door.

A useful habit: before writing a browser script that drives a new control,
write one that just asserts the control is *there*, for the role that is
supposed to see it. Both bugs above would have died in thirty seconds.

## Running the app

```bash
npx wrangler d1 execute agora --local --file=d1/schema.sql      # first run only
npx wrangler d1 execute agora --local --file=d1/seed-parishes.sql
npm run dev
```

**Wait for readiness, never a fixed sleep.** `wrangler dev` takes 15–40s here:

```bash
for i in $(seq 1 14); do
  sleep 3
  [ "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8787/api/admin/ping)" = "200" ] && break
done
```

**Stopping it: do not `pkill -f workerd`.** The pattern matches the shell
running the command, which kills the shell mid-command and loses whatever
followed it in the same line. Use:

```bash
ps aux | grep -E "wrangler|worke[r]d" | grep -v grep | awk '{print $2}' \
  | while read pid; do kill "$pid" 2>/dev/null; done
```

**`wrangler dev` flakes.** An empty `✘ [ERROR]` with `Error: Network connection
lost` in `~/.config/.wrangler/logs/` is its proxy dying, not the Worker. Restart
and re-run; it is not your change.

## Playwright

Chromium is preinstalled. **The path is versioned** — `/opt/pw-browsers/chromium`
is a directory that does not contain the binary:

```js
chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' })
```

Check with `ls /opt/pw-browsers` if a launch fails; the version moves.

Install the driver into the scratchpad, not the repo:

```bash
cd "$SCRATCHPAD" && npm init -y >/dev/null && npm install playwright
```

### Console noise that is not yours

Two failures are environmental and appear on every page load. Filter them, or
every run reports errors:

- `ERR_CERT_AUTHORITY_INVALID` — `api.iconify.design` is blocked by the agent
  proxy, so **every glyph is missing**. A blank circular button in a screenshot
  is usually this, not your CSS.
- `Bad response code: 404` from `pmtiles.js` — the basemap archive is not in
  local R2, so the map is a grey rectangle. `docs/deploy.md` covers it.

```js
page.on('console', m => {
  const t = m.text();
  if (m.type() === 'error' &&
      !/ERR_CERT_AUTHORITY_INVALID|pmtiles|Bad response code|404 \(Not Found\)/.test(t)) {
    errors.push(t);
  }
});
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
```

Keep `pageerror` **unfiltered** — that is your code throwing.

A 403 from `/api/admin/*` may be the thing under test (a refusal you designed),
so filter it only in scripts where it is expected.

### Waiting for the app to be ready

`networkidle` is not enough — the admin ping lands after first paint:

```js
await page.goto('http://localhost:8787/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.agoraState && window.agoraState.isAdmin === true,
  { timeout: 20000 });
await page.waitForTimeout(1800);   // parishes + first render
```

## The trap that will waste an hour

**`/api/bundle` is served `max-age=60, stale-while-revalidate=600`.** A bare
`fetch('/api/bundle')` in a probe gets the cached body, so a write you just made
appears not to have happened. This looked exactly like a broken write once and
was not.

Read state through the app, which bypasses the cache on the write path:

```js
await page.evaluate(() => window.agoraState.events)     // good
await page.evaluate(() => fetch('/api/bundle'))         // stale, silently
await page.evaluate(() => fetch('/api/bundle', { cache: 'no-store' }))  // fine
```

`agoraBundle.load({ fresh: true })` is what the app itself uses after a write.

## Useful handles the app exposes

```js
window.agoraState              // the whole state object, incl. adminWho
window.openParishSheet(id)     // open a parish card without clicking the map
window.closeParishSheet()
window.expandEventCard(id)     // open an event drawer by id, synthetic ids too
window.setEventEditMode(id)    // enter/leave the drawer's edit mode
window.agoraAdminMay(cap, pid) // the same two questions the Worker asks
```

## Driving the roles

`AGORA_DEV_ADMIN=true` makes `adminIdentity()` return `'dev'`, so the role is
whatever `admin_roles` says for `'dev'` — and an **empty table means owner**
(the bootstrap rule). Switch roles between reloads:

```bash
D1="npx wrangler d1 execute agora --local --command"
$D1 "DELETE FROM admin_roles"                                        # bootstrap owner
$D1 "INSERT INTO admin_roles (email, role, parish_ids)
     VALUES ('dev','parish','[\"antiochian-stgeorge-redfern\"]')"    # parish contact
$D1 "UPDATE admin_roles SET role='owner', parish_ids=NULL WHERE email='dev'"
$D1 "INSERT INTO admin_roles (email, role) VALUES ('someone@else','owner')"  # no role at all
```

A reload is needed after each — the role is read once, by `checkAdmin()`.

### Making the client and the server disagree

Several controls predict what the Worker will say (the add-event dialog decides
whether a press will be an ask before making it). To exercise the fallback path
you need them to disagree, and the only reliable way is to **change the role
underneath an open dialog**:

```js
// Open as an owner: the client predicts no refusal and sends no `propose`.
await page.locator('#parish-add-event-fab').click();
// Narrow the role in D1, then press. The Worker refuses; the fallback runs.
execSync(`npx wrangler d1 execute agora --local --command "INSERT INTO admin_roles ..."`);
await page.locator('#new-event-save').click();
```

### Resetting between runs

Event state accumulates and will make the second run of a script behave
differently from the first — a candidate list that was empty is not, an
occurrence that was `approved` is `combined`. Reset first:

```bash
npx wrangler d1 execute agora --local --command \
  "DELETE FROM schedule_overrides; DELETE FROM event_parishes; DELETE FROM event_replaces;
   DELETE FROM events; DELETE FROM admin_proposals; DELETE FROM parish_notices_seen;
   DELETE FROM admin_roles;"
```

## Screenshots

Worth taking; they catch layout problems nothing else will (a native date input
clipping to `09/22/2` in a three-column grid, for one). Clip to the region:

```js
const b = await page.locator('#btn-account').boundingBox();
await page.screenshot({ path: 'out.png',
  clip: { x: b.x - 60, y: b.y - 14, width: 130, height: b.height + 28 } });
```

Remember the missing glyphs — an empty-looking button is probably iconify.

## What to say in the PR

CLAUDE.md asks for it, and means it: *"Tests pass" is not, when no test ran the
line that changed.* Say which paths you drove and what you observed —
"11 parishes offered with 10 tagged, was 1 and 0" is a check; "verified in the
browser" is not.
