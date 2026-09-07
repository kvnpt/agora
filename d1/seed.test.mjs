// The seed has to be safe to run twice.
//
// Parishes always were — they have a natural primary key and ON CONFLICT(id)
// DO NOTHING. Schedules were not: an AUTOINCREMENT id and no natural key meant
// a second run inserted a second copy of every rule, and a duplicated rule
// renders every service twice in the feed. Nothing failed; the site was just
// quietly wrong, which is the kind of thing worth a test.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const SCHEMA = fs.readFileSync('d1/schema.sql', 'utf8');
const SEEDS = ['d1/seed-parishes.sql', 'd1/seed-parishes.console.sql'];

const fresh = () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
};
const counts = (db) => ({
  parishes: db.prepare("SELECT COUNT(*) n FROM parishes WHERE id != '_unassigned'").get().n,
  schedules: db.prepare('SELECT COUNT(*) n FROM schedules').get().n,
});

for (const path of SEEDS) {
  const seed = fs.readFileSync(path, 'utf8');

  // The console variant is generated separately, by stripping comments and
  // flattening each statement onto one line. Idempotency has to survive that
  // transformation too, or pasting into the dashboard reintroduces the bug.
  test(`${path} — populates an empty database`, () => {
    const db = fresh();
    db.exec(seed);
    const c = counts(db);
    assert.ok(c.parishes > 0, 'no parishes were inserted');
    assert.ok(c.schedules > 0, 'no schedules were inserted');
  });

  test(`${path} — is idempotent`, () => {
    const db = fresh();
    db.exec(seed);
    const first = counts(db);
    db.exec(seed);
    db.exec(seed);
    assert.deepStrictEqual(counts(db), first,
      're-running the seed changed the row counts');
  });
}

test('a rule that differs only by week_of_month is not treated as a duplicate', () => {
  // This is why the guard is a WHERE NOT EXISTS and not a unique index. A
  // parish can genuinely hold "1st Saturday 9am Liturgy" and "3rd Saturday 9am
  // Liturgy": same parish, weekday, time and title, different week_of_month. A
  // unique index over those four columns would reject the second one outright.
  const db = fresh();
  const seed = fs.readFileSync('d1/seed-parishes.sql', 'utf8');
  db.exec(seed);

  const base = db.prepare('SELECT * FROM schedules ORDER BY id LIMIT 1').get();
  assert.strictEqual(base.week_of_month, null, 'seeded rules carry no week_of_month');

  db.prepare(`INSERT INTO schedules (parish_id, day_of_week, start_time, end_time, title, event_type, week_of_month)
              VALUES (?,?,?,?,?,?,'first')`)
    .run(base.parish_id, base.day_of_week, base.start_time, base.end_time, base.title, base.event_type);

  const before = counts(db).schedules;
  db.exec(seed);

  assert.strictEqual(counts(db).schedules, before,
    'the seed inserted again despite its own rule already existing');

  const variants = db.prepare(
    'SELECT week_of_month FROM schedules WHERE parish_id = ? AND day_of_week = ? AND start_time = ? AND title = ? ORDER BY week_of_month'
  ).all(base.parish_id, base.day_of_week, base.start_time, base.title);
  assert.deepStrictEqual(variants.map(v => v.week_of_month), [null, 'first'],
    'both the generic rule and the week-of-month rule must survive');
});
