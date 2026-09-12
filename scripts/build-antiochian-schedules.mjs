// Turn the Antiochian directory's published service times into schedule rows.
//
// Reads the scraped file, pairs every parish with the row already in production
// (matched on `info_source_ref`, which this import set to the parish's own
// directory page — an exact join, where name matching would not be), and emits
// the SQL. Prints the plan first: what it will change, what it will add, and
// what it will leave alone.

import { readFile, writeFile } from 'node:fs/promises';
import { rulesForParish, planWrite, buildScheduleSql, SOURCE_NAME } from './antiochian-schedules.mjs';

const PARISHES = 'https://agora.orthodoxy.au/api/parishes';
const SCHEDULES = 'https://agora.orthodoxy.au/api/schedules';
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const get = async (url) => {
  const res = await fetch(url, { headers: { 'User-Agent': 'agora-parish-import/1.0' } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const body = await res.json();
  return Array.isArray(body) ? body : (body.parishes || body.schedules || []);
};

const scraped = JSON.parse(await readFile(process.argv[2] || './antiochian-scraped.json', 'utf8'));
const index = JSON.parse(await readFile(process.argv[3] || './cache/antiochian/index.json', 'utf8'));
const output = process.argv[4] || './antiochian-schedules.sql';

// When we read the source. NOT the page's own last-modified date, which the
// directory does publish: that is the publisher asserting something about
// itself, and a parish that changes its times without touching the page would
// carry a date saying the times are current. The read is the weaker claim and
// the only one we can make — it records freshness, never veracity.
const checkedAt = scraped.scraped_at || new Date().toISOString();
const parishes = await get(PARISHES);
const byRef = new Map(parishes.filter((p) => p.info_source_ref).map((p) => [p.info_source_ref, p]));
const existing = (await get(SCHEDULES)).filter((s) => byRef.has(
  parishes.find((p) => p.id === s.parish_id)?.info_source_ref,
));

const rules = [];
const dropped = [];
const noParish = [];
for (const p of scraped.parishes) {
  const parish = byRef.get(p.source_ref);
  if (!parish) { noParish.push(p.name); continue; }
  const { rules: rs, dropped: ds } = rulesForParish(p);
  dropped.push(...ds);
  for (const r of rs) {
    rules.push({
      ...r,
      parish_id: parish.id,
      source_name: SOURCE_NAME,
      source_ref: p.source_ref,
      source_checked_at: checkedAt,
    });
  }
}

const { updates, inserts, untouched } = planWrite(rules, existing);

console.log(`${scraped.parishes.length} parishes scraped, ${rules.length} rules parsed`);
if (noParish.length) console.log(`\nNO PARISH ROW (skipped): ${noParish.join(', ')}`);

console.log(`\nUPDATES IN PLACE (${updates.length}) — an existing rule at the same parish, day and time:`);
for (const u of updates) {
  const was = existing.find((e) => e.id === u.id);
  console.log(`  #${String(u.id).padStart(3)} ${u.parish_id}`);
  console.log(`        ${DAYS[u.day_of_week]} ${u.start_time}  ${JSON.stringify(was.title)} -> ${JSON.stringify(u.title)}`
    + `${u.languages ? `  langs ${u.languages.join('/')}` : ''}`
    + `${was.event_type !== u.event_type ? `  type ${was.event_type} -> ${u.event_type}` : ''}`);
}

console.log(`\nLEFT ALONE (${untouched.length}) — the directory does not mention these, which is not evidence they stopped:`);
for (const e of untouched) console.log(`  #${String(e.id).padStart(3)} ${e.parish_id}  ${DAYS[e.day_of_week]} ${e.start_time}  ${JSON.stringify(e.title)}`);

const byParish = new Map();
for (const r of inserts) {
  if (!byParish.has(r.parish_id)) byParish.set(r.parish_id, []);
  byParish.get(r.parish_id).push(r);
}
console.log(`\nNEW (${inserts.length}) across ${byParish.size} parishes:`);
for (const [pid, rs] of byParish) {
  console.log(`  ${pid}`);
  for (const r of rs) {
    console.log(`        ${DAYS[r.day_of_week]} ${r.start_time}  ${r.event_type.padEnd(7)} ${r.title}`
      + `${r.languages ? `  (${r.languages.join(', ')})` : ''}`
      + `${r.week_of_month ? `  weeks: ${r.week_of_month}` : ''}${r.concurrent ? '  [concurrent]' : ''}`);
  }
}

console.log(`\nDROPPED (${dropped.length}) — published without a time, so no rule is invented:`);
for (const d of dropped) console.log(`  ${d.parish} [${d.day}] ${JSON.stringify(d.line)}\n      ${d.why}`);

console.log(`\nevery rule is stamped read ${checkedAt}`);

await writeFile(output, `${buildScheduleSql({ updates, inserts })}\n`);
console.log(`\nwrote ${updates.length + inserts.length} statements to ${output}`);
