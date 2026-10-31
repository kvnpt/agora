# Checking the frontend in a browser

CLAUDE.md names the limit: CI covers `public/shared/` and the Worker well and
**executes none of** `next/next.js`, `next/editing.js`, `bundle.js` or `map.js`. So a change to rendering,
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

## Running the page

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
  proxy. /admin still draws its glyphs from it, so a blank button there is
  usually this, not your CSS; the page's icons are inline SVG.
- `404 (Not Found)` for `/tiles/oceania/{z}/{x}/{y}.mvt` — the basemap archive
  is not in local R2, so the Worker has no tiles to give and the map is a grey
  rectangle. `docs/deploy.md` covers it. Worse,
  the map's `load` never fires, so **the map's loader stays up** over it. (The
  page's own layers go on at `style.load` since 30 Oct 2026, so the dots are
  there under the loader.)
  To check anything on the map, drop the archive's source from the base style
  before the page asks for it:

  ```js
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const orig = window.buildBaseStyle;
      window.buildBaseStyle = async (...a) => {
        const st = await orig(...a);
        const bad = Object.keys(st.sources).filter(k => (st.sources[k].tiles || []).some(t => t.includes('/tiles/')));
        bad.forEach(k => delete st.sources[k]);
        st.layers = st.layers.filter(l => !bad.includes(l.source));
        return st;
      };
    });
  });
  ```

  Glyphs and sprites are served locally, so labels and icons still draw.

```js
page.on('console', m => {
  const t = m.text();
  if (m.type() === 'error' &&
      !/ERR_CERT_AUTHORITY_INVALID|\/tiles\/|404 \(Not Found\)/.test(t)) {
    errors.push(t);
  }
});
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
```

Keep `pageerror` **unfiltered** — that is your code throwing.

A 403 from `/api/admin/*` may be the thing under test (a refusal you designed),
so filter it only in scripts where it is expected.

### Waiting for the page to be ready

`networkidle` is not enough. A link's first paint is the Worker's card
(`.sheet.open.ssr`), which next.js replaces with its own once the bundle is in;
a click on the painted one is a plain link. Wait for the page's own:

```js
await page.goto('http://localhost:8787/sgr', { waitUntil: 'load' });
await page.waitForSelector('.sheet.parish.open:not(.ssr)', { timeout: 20000 });
```

The admin ping lands after that, and an editor's controls with it. Wait for the
door itself — `.sheet.parish.open .tt-edit`, `[data-edit-details]` — which is
also the check that it is there for the role that should see it.

## The trap that used to waste an hour

`/api/bundle` was served `max-age=60, stale-while-revalidate=600`, and a bare
`fetch('/api/bundle')` handed back the browser's copy without asking — so a
write you had just made looked like it never happened, in probes and, worse, in
the app after pressing Back to app in /admin.

It is now `no-cache` with an ETag (`worker/lib/data-version.mjs`): the browser
asks every time and gets a 304 when nothing moved. Every successful write under
`/api/admin/` bumps a data version, which is also what the edge cache keys the
body on. So a plain `fetch('/api/bundle')` after a write is current.

Two things can still look stale, and neither is the browser:

- **Another Cloudflare location** trusts its copy of the version for 15
  seconds. The location that took the write updates at once, and a browser
  script talks to one location, so this bites only when comparing two
  machines.
- **A write that never went through the Worker** — an import run from a
  terminal straight into D1 — does not bump the version. Its body stays cached
  for up to ten minutes. Bump by hand (any admin write does it) if you need it
  sooner.

`x-data-version` on the response says which version answered.

## Every link is the page, with its card painted in

Since v3 took `/` (docs/lite-pages.md), every page path is the same page, with
the link's head and card written in by the Worker. Things that follow for a
browser script:

- **A changed head or card renders stale.** They are kept at the edge under the
  data version and the hour, which only an admin write or the clock moves — so
  after editing `page-card.mjs`, `page-head.mjs`, `lite-page.mjs` or
  `lite-timetable.mjs`, bump the version (any admin write) or stop `wrangler dev`,
  `rm -rf .wrangler/state/v3/cache`, and start it again. The page around them is
  read fresh on every request.
- **Check the painted card with JavaScript off too** (`javaScriptEnabled: false`);
  it is meant to read without it.
- `curl -D - http://localhost:8787/sgr` shows `x-agora-page: parish` (or `event`,
  `timetable`, `home`, `other`); `failed-open` means the Worker could not read D1
  and served the page as deployed.
- **A collection's link opens its card over the page** (`/sun/liturgy`, `/greek`),
  covering the filters button. Press Escape first to reach the page under it.
- **The dev bypass makes every browser an admin.** For a visitor, answer
  `/api/admin/ping` with a 403 in the context (`ctx.route`).

## Useful handles the page exposes

```js
window.openParishSheet(id)        // open a parish card without clicking the map
window.agoraOpenEventSheet(id)    // open an event card by id, synthetic ids too
window.NextEdit.editDetails(pid)  // the details pencil
window.NextEdit.editLine([ruleId])// a timetable line's pencil
window.NextEdit.editEvent(id)     // an event card's pencil
window.NextEdit.addEvent(pid)     // the add-event editor, as Add + opens it
window.NextEdit.addService(pid)   // Add schedule
window.agoraStateRef              // what map.js reads
```

Each `NextEdit` call checks the capability first, as its control does, so one
that does nothing for a role is the same answer the page gives.

## Driving the roles

`AGORA_DEV_ADMIN=true` makes `adminIdentity()` return `'dev'`, so the role is
whatever `admin_roles` says for `'dev'` — and an **empty table means owner**
(the bootstrap rule, which only `AGORA_DEV_ADMIN` turns on; in production an
empty table is nobody). Switch roles between reloads:

```bash
D1="npx wrangler d1 execute agora --local --command"
$D1 "DELETE FROM admin_roles"                                        # bootstrap owner
$D1 "INSERT INTO admin_roles (email, role, parish_ids)
     VALUES ('dev','parish','[\"antiochian-stgeorge-redfern\"]')"    # parish contact
$D1 "UPDATE admin_roles SET role='owner', parish_ids=NULL WHERE email='dev'"
$D1 "INSERT INTO admin_roles (email, role) VALUES ('someone@else','owner')"  # no role at all
```

A reload is needed after each — the page reads the role once, by `checkSignIn()`.

### Making the client and the server disagree

Several controls predict what the Worker will say (the add-event editor decides
whether a card's publish will be an ask before making it). To exercise the
fallback path you need them to disagree, and the only reliable way is to
**change the role underneath an open dialog**:

```js
// Open as an owner: the client predicts no refusal and sends no `propose`.
await page.locator('.sheet.parish.open .add-box[data-suggest="An event"]').click();
// …type a card and tick another parish under "Also at other parishes"…
// Narrow the role in D1, then press. The Worker refuses; the card shows the ask.
execSync(`npx wrangler d1 execute agora --local --command "INSERT INTO admin_roles ..."`);
await page.locator('.new-event-modal [data-ee="publish"]').click();
```

That path found a real bug the first time it was driven: typing the reason
cleared the refusal, so the second press went without the ask and was refused
again.

### Resetting between runs

Event state accumulates and will make the second run of a script behave
differently from the first — a candidate list that was empty is not, an
occurrence that was `approved` is `combined`. Reset first:

```bash
npx wrangler d1 execute agora --local --command \
  "DELETE FROM schedule_overrides; DELETE FROM event_parishes; DELETE FROM event_replaces;
   DELETE FROM events; DELETE FROM admin_proposals; DELETE FROM parish_notices_seen;
   DELETE FROM draft_events; DELETE FROM drafts; DELETE FROM admin_roles;"
```

## The add-event editor and the poster reader

The editor (`public/shared/event-editor.js`) is the same component on the page
(`.new-event-modal`, behind the dotted **Add +** under a card's Coming up) and in
/admin (`#add-event-editor`, behind **Events** → + Event). Its controls carry
`data-ee` hooks — `parish` (the picker; /admin has no select of its own any
more), `suggest` and `move-suggested` (whose poster it is, and the one-tap
move), `poster-input`, `drop`, `status`, `publish`, `save-draft`, `discard`,
`add-card` — and each field `data-ee-field="title"` and so on.

**Reading a poster needs Claude, and a browser check should not.** Point the
Worker at a local stand-in that answers `POST /v1/messages` with a canned
stream, slowly enough to watch the fields fill:

```bash
# A stand-in for the Messages API: replays a canned Haiku stream per mode
# (one event, three events, not_an_event, a 529 — and `elsewhere`, St Elias,
# Wollongong's poster as read at another parish, for the move; the signs and the
# programme; `recurring_croydonpark`, a choir practice's weekly flyer) with a delay
# between deltas. Switch with POST /__mode {"mode": "elsewhere"}.
node scripts/mock-anthropic.mjs 8788 &

# The Worker reads the key through the Secrets Store binding; give the local
# store one (any value — the stand-in does not check it).
npx wrangler secrets-store secret create caf2bffa59d544e88e6649b71c3e6c09 \
  --name ANTHROPIC_API_KEY --scopes workers --value local-test-key

npx wrangler dev --local --var AGORA_DEV_ADMIN:true \
  --var ANTHROPIC_BASE_URL:http://127.0.0.1:8788
```

`setInputFiles` on `[data-ee="poster-input"]` needs a file a canvas can decode
— a `page.screenshot()` written to disk is one. The stream itself can be read
without a browser: create a draft with `POST /api/admin/drafts`, then
`curl -N -X POST localhost:8787/api/admin/drafts/<id>/poster -H 'content-type:
image/jpeg' --data-binary @poster.jpg` prints the frames as they arrive.

Drafts accumulate between runs and fill the "Saved drafts here" strip; clear
them with `DELETE FROM draft_events; DELETE FROM drafts;`.

**Signs and programmes.** Three more modes are written from real photos —
`sign_rookwood` (St Athanasios, Rookwood's board: Saturdays 8–10, Sundays 8–11,
in Greek), `sign_doonside` (Sts Peter & Paul, Doonside's: Sunday 10am in Arabic
and English, 6pm on the 2nd and 4th Sundays in English) and
`programme_rookwood` (St Athanasios's October 2026 programme, nine dates with
their saints). Each is what a good read of that photo says; drop any image with
the mode set. A sign shows its review above an empty, hidden card: **Add to
timetable** should ask "keep it by hand?" at a parish read from a directory,
add the rule with `source_name = 'Church signage'` and the photo as its ref, and
**Done** should leave the photo served. Rookwood is not in the seed, and a
programme only matches once the sign's two rules are on file — so run the sign
first. The programme's cards should all carry **regular service**, and Publish
should write nine overrides with `patch_feast` and the poster and no row in
`events`. Doonside's sign agrees with the seed's timetable, and offers only to
mark it checked.

**A one-off that is really weekly.** `weekday_dandenong` is St Paul,
Dandenong's "Sunday" poster as it was read on 31 Oct 2026: Matins and the
Liturgy as events on the coming Sunday, Sunday School and Fellowship as
services. Open a card: **Convert to weekly** beside Date
(`[data-act="regular"]`) should move it under "Held regularly", open, with
English and Arabic still ticked; with both moved the cards go and the bar
says **Done**. **Add to timetable** should write the rule with the poster on
it.

**The move.** With `elsewhere`, drop a poster at St Nicholas, Punchbowl (a seed
parish): the suggestion names St Elias, Wollongong and the venue holds its
address. **Move it there** should leave the picker on St Elias, the suggestion
gone, the venue empty, and `drafts.parish_id` changed; Publish should land the
event on St Elias's sheet. As a contact of Punchbowl alone, the suggestion says
whose it is and offers no button, and the picker holds one parish.

**Suggest edits with a poster.** The page needs somebody with no role: insert
an owner who is not `dev` (`INSERT INTO admin_roles (email, role) VALUES
('someone@else','owner')`) and open `/admin?suggest=<parish id>`. The door is
**Add an event**; the poster box is `#suggest-poster-pick`, its input
`#suggest-poster-file` (`setInputFiles`), its status `#suggest-poster-status`,
and the which-event select `#suggest-poster-pickone` (`three` mode). Assert the
input and the select are *hidden* too: the form's `display: block` beats
`[hidden]`, which is how they first came out visible. A lapsed Access sign-in is
`page.route('**/api/admin/suggestions/poster**', r => r.abort())` — the form
should offer **Confirm my email again** and bring back what was typed.

## Screenshots

Worth taking; they catch layout problems nothing else will (a native date input
clipping to `09/22/2` in a three-column grid, for one). Clip to the region:

```js
const b = await page.locator('#btn-account').boundingBox();
await page.screenshot({ path: 'out.png',
  clip: { x: b.x - 60, y: b.y - 14, width: 130, height: b.height + 28 } });
```

Remember the missing glyphs in /admin — an empty-looking button there is probably iconify.

## What to say in the PR

CLAUDE.md asks for it, and means it: *"Tests pass" is not, when no test ran the
line that changed.* Say which paths you drove and what you observed —
"11 parishes offered with 10 tagged, was 1 and 0" is a check; "verified in the
browser" is not.
