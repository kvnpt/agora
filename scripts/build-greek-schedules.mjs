// Pass 3 of the Greek SERVICE TIMES run: plan the write and emit the SQL.
//
//   node scripts/build-greek-schedules.mjs greek-sites.json greek-schedules.sql greek-websites.sql
//
// Reads the curated times in `greek-service-times.mjs` and pass 1's site
// report, pairs each parish with the row in production, and writes two files:
// the schedule rules, and the `parishes.website` corrections. Prints the plan
// first — what it will add, what it will change, what it deliberately will not,
// and the denominator behind all three.
//
// THE DENOMINATOR IS THE POINT. A schedule import usually reports what it
// wrote. This one has to report what it did not, because the headline finding
// is not "N rules" — it is that 135 Greek parishes exist, the Archdiocese
// publishes a service time for none of them, and most of the parishes do not
// publish one either. A run that printed only its 14 rules would read like a
// thin scrape rather than a full one.

import { readFile, writeFile } from 'node:fs/promises';
import {
  ruleFromSentence, planWrite, markConcurrent, buildScheduleSql, buildWebsiteSql, SOURCE_NAME,
} from './greek-schedules.mjs';
import { SERVICE_TIMES, PUBLISHES_BUT_NOT_A_RULE } from './greek-service-times.mjs';
import { SITE_OVERRIDES } from './greek-site-overrides.mjs';
import { normaliseUrl, sameSite } from './greek-directory.mjs';
import { ADAPTERS } from '../worker/lib/adapters.mjs';

const PARISHES = 'https://agora.orthodoxy.au/api/parishes';
const SCHEDULES = 'https://agora.orthodoxy.au/api/schedules';
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const sitesFile = process.argv[2] || './greek-sites.json';
const scheduleOut = process.argv[3] || './greek-schedules.sql';
const websiteOut = process.argv[4] || './greek-websites.sql';

const get = async (url) => {
  const res = await fetch(url, { headers: { 'User-Agent': 'agora-parish-import/1.0' } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const body = await res.json();
  return Array.isArray(body) ? body : (body.parishes || body.schedules || []);
};

const report = JSON.parse(await readFile(sitesFile, 'utf8'));
const checkedAt = report.scraped_at || new Date().toISOString();

const parishes = await get(PARISHES);
const greek = parishes.filter((p) => p.jurisdiction === 'greek');
const byId = new Map(greek.map((p) => [p.id, p]));
const allSchedules = await get(SCHEDULES);
const existing = allSchedules.filter((s) => byId.has(s.parish_id));

// A parish with a LIVE adapter is not this import's to describe. Nothing Greek
// has one today except the Blacktown PDF, and the guard is kept because the
// general rule holds: a source re-read every four hours beats a page a person
// read once. (docs/parish-ingestion.md, the Antiochian run.)
const adapted = new Set(ADAPTERS.map((a) => a.parishId));

// ── rules ──────────────────────────────────────────────────────────────────

const rules = [];
const refused = [];
const deferred = [];
for (const entry of SERVICE_TIMES) {
  const parish = byId.get(entry.parish_id);
  if (!parish) { refused.push({ ...entry, why: 'no such Greek parish row' }); continue; }
  if (adapted.has(parish.id)) { deferred.push(`${parish.name} (${parish.id})`); continue; }

  const res = ruleFromSentence(entry.quote, {
    title: entry.title,
    days: entry.days,
    languages: entry.languages,
    weekOfMonth: entry.week_of_month,
  });
  if (!res.ok) { refused.push({ ...entry, why: res.why }); continue; }
  for (const r of res.rules) {
    rules.push({
      ...r,
      // The curated end_time wins: a quote that is a clause of a longer sentence
      // ("followed by Matins at 7am") carries no span, and the parish states none.
      end_time: entry.end_time ?? r.end_time ?? null,
      parish_id: parish.id,
      source_name: SOURCE_NAME,
      source_ref: entry.source_ref,
      source_checked_at: checkedAt,
    });
  }
}
markConcurrent(rules);
const { updates, inserts, untouched } = planWrite(rules, existing);

// ── websites ───────────────────────────────────────────────────────────────

const websiteChanges = [];
const stampOnly = [];
for (const row of report.parishes) {
  const parish = byId.get(row.id);
  if (!parish) continue;
  const override = SITE_OVERRIDES[row.id];
  const stored = normaliseUrl(parish.website);
  let next;
  if (override && override.website !== undefined) next = override.website;
  else if (row.directory_website) next = row.directory_website;
  else next = stored;

  if (!sameSite(next, stored) && !(next === null && stored === null)) {
    websiteChanges.push({ id: row.id, website: next, was: stored, why: override?.found || 'the directory' });
  } else if (row.directory_ref) {
    stampOnly.push(row.id);
  }
}

// ── the report ─────────────────────────────────────────────────────────────

const readable = report.parishes.filter((r) => r.live
  || (SITE_OVERRIDES[r.id] && SITE_OVERRIDES[r.id].website && !SITE_OVERRIDES[r.id].unreachable));
const noSite = Object.entries(SITE_OVERRIDES).filter(([, v]) => v.website === null);
const unreachable = Object.entries(SITE_OVERRIDES).filter(([, v]) => v.unreachable);

console.log(`${greek.length} Greek parishes in production, ${existing.length} schedules between them.\n`);
console.log('WHERE THE TIMES COULD COME FROM');
console.log(`  the Archdiocese directory publishes a service time for  0 of ${greek.length}`);
console.log(`  parishes with a readable site of their own              ${readable.length}`);
console.log(`  parishes whose site exists and this environment cannot open  ${unreachable.length}`);
console.log(`  parishes searched and found to publish nowhere          ${noSite.length}`);

console.log(`\nNEW RULES (${inserts.length}) across ${new Set(inserts.map((r) => r.parish_id)).size} parishes:`);
const byParish = new Map();
for (const r of inserts) {
  if (!byParish.has(r.parish_id)) byParish.set(r.parish_id, []);
  byParish.get(r.parish_id).push(r);
}
for (const [pid, rs] of byParish) {
  console.log(`  ${pid}  (${byId.get(pid).timezone})`);
  for (const r of rs.sort((a, b) => a.day_of_week - b.day_of_week || a.start_time.localeCompare(b.start_time))) {
    console.log(`        ${DAYS[r.day_of_week]} ${r.start_time}${r.end_time ? `-${r.end_time}` : '      '}  `
      + `${r.event_type.padEnd(7)} ${r.title}`
      + `${r.languages ? `  (${r.languages.join(', ')})` : ''}`
      + `${r.week_of_month ? `  weeks: ${r.week_of_month}` : ''}${r.concurrent ? '  [concurrent]' : ''}`);
  }
}

if (updates.length) {
  console.log(`\nUPDATED IN PLACE (${updates.length}) — same parish, weekday and start time:`);
  for (const u of updates) {
    const was = existing.find((e) => e.id === u.id);
    console.log(`  #${u.id} ${u.parish_id} ${DAYS[u.day_of_week]} ${u.start_time}  ${JSON.stringify(was.title)} -> ${JSON.stringify(u.title)}`);
  }
}
if (untouched.length) {
  console.log(`\nLEFT ALONE (${untouched.length}) — not mentioned by the parish, which is not evidence it stopped:`);
  for (const e of untouched) console.log(`  #${e.id} ${e.parish_id} ${DAYS[e.day_of_week]} ${e.start_time} ${JSON.stringify(e.title)}`);
}
if (deferred.length) {
  console.log(`\nLEFT TO THEIR ADAPTER (${deferred.length}) — a live source beats a page read once:`);
  for (const d of deferred) console.log(`  ${d}`);
}

console.log(`\nPUBLISHES SOMETHING, AND IT IS NOT A RULE (${PUBLISHES_BUT_NOT_A_RULE.length}):`);
for (const p of PUBLISHES_BUT_NOT_A_RULE) console.log(`  ${p.parish_id}\n      ${p.why}\n      ${p.url}`);

if (refused.length) {
  console.log(`\nCURATED BUT REFUSED BY THE PARSER (${refused.length}) — each is a bug in the entry or the parser:`);
  for (const r of refused) console.log(`  ${r.parish_id} ${JSON.stringify(r.title)} — ${r.why}`);
}

console.log(`\nWEBSITE CORRECTIONS (${websiteChanges.length}):`);
for (const c of websiteChanges) {
  console.log(`  ${c.id.padEnd(38)} ${c.was || '(none)'}\n      -> ${c.website || '(cleared)'}   [${c.why}]`);
}
console.log(`\n${stampOnly.length} further rows keep the website they had; every row read gets info_checked_at = ${checkedAt}.`);

await writeFile(scheduleOut, `${buildScheduleSql({ updates, inserts })}\n`);
// `website` omitted on the stamp-only rows, so their statement carries the
// timestamp alone and cannot walk back a URL somebody has edited in /admin.
const stamped = [...websiteChanges, ...stampOnly.map((id) => ({ id }))];
await writeFile(websiteOut, `${buildWebsiteSql(stamped, checkedAt)}\n`);
console.log(`\nwrote ${updates.length + inserts.length} schedule statements to ${scheduleOut}`);
console.log(`wrote ${stamped.length} parish statements to ${websiteOut}`);
