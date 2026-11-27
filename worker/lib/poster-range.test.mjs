// What still names a poster object — the question asked before one is deleted.
//
// The query is checked here as TEXT as well as run elsewhere, because the one
// limit that matters is D1's and the tests run on Node's SQLite: D1 refuses a
// compound SELECT of more than five terms ("too many terms in compound
// SELECT"), Node allows hundreds, and a sixth term — a rule's own poster,
// added as a term of its own — passed every test and failed every draft's
// Done and Discard under `wrangler dev`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { namesPoster, referencedSql, posterKeyOf } from './poster-range.mjs';

const key = 'posters/rule-7-abc.jpg';
const cols = ['poster_path', 'patch_poster_path', 'poster_path', 'source_ref', 'poster_path', 'info_source_ref']
  .map(c => namesPoster(c, key));

test('the query that keeps a poster stays within D1’s five terms', () => {
  const sql = referencedSql(...cols);
  const terms = sql.split(/\bUNION\s+ALL\b/i).length;
  assert.ok(terms <= 5, `${terms} terms in a compound SELECT; D1 allows five`);
});

test('every place a poster can be named is asked: a date, a one-off, a draft, a rule’s source and its own poster, a parish', () => {
  const sql = referencedSql(...cols);
  for (const t of ['events', 'schedule_overrides', 'drafts', 'schedules', 'parishes']) assert.match(sql, new RegExp(`FROM ${t}\\b`));
  assert.match(sql, /FROM schedules WHERE \(source_ref = \?.*\) OR \(poster_path = \?/);
  assert.equal(posterKeyOf('/posters/rule-7-abc.jpg?v=1'), key);
});

// ── a gallery: several pictures in one value (public/shared/posters.js) ──

import { createRequire } from 'node:module';
import { namesPicture, namesSamePoster, posterKeysOf, posterValue, isPdfPoster } from './poster-range.mjs';
const Database = createRequire(import.meta.url)('better-sqlite3');

test('a gallery names each of its pictures, and nothing a single path does not', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, poster_path TEXT)');
  const rows = [
    '["/posters/a.jpg","/posters/b.jpg?v=3"]',  // 1: a gallery
    '/posters/b.jpg?v=3',                       // 2: one picture, versioned
    '/posters/ab.jpg',                          // 3: a key that starts like another
    '["/posters/xa.jpg","/posters/c.jpg"]',     // 4: a key that ends like another
  ];
  rows.forEach((p, i) => db.prepare('INSERT INTO t (id, poster_path) VALUES (?, ?)').run(i + 1, p));
  const hits = (key) => {
    const n = namesPicture('poster_path', key);
    return db.prepare(`SELECT id FROM t WHERE ${n.sql} ORDER BY id`).all(...n.args).map(r => r.id);
  };
  assert.deepEqual(hits('posters/a.jpg'), [1]);
  assert.deepEqual(hits('posters/b.jpg'), [1, 2]);
  assert.deepEqual(hits('posters/c.jpg'), [4]);
  assert.deepEqual(hits('posters/ab.jpg'), [3]);
  assert.deepEqual(hits('posters/x.jpg'), []);
  // The same gallery, whole; the same picture, with or without its ?v=.
  const same = (v) => {
    const n = namesSamePoster('poster_path', v);
    return db.prepare(`SELECT id FROM t WHERE ${n.sql} ORDER BY id`).all(...n.args).map(r => r.id);
  };
  assert.deepEqual(same(rows[0]), [1]);
  assert.deepEqual(same('/posters/b.jpg'), [2]);
  // Still five terms with a gallery's longer test in four of them.
  const sql = referencedSql(...['poster_path', 'patch_poster_path', 'poster_path', 'source_ref', 'poster_path', 'info_source_ref']
    .map(c => namesPicture(c, key)));
  assert.ok(sql.split(/\bUNION\s+ALL\b/i).length <= 5);
});

test('a poster value is a path for one picture and a list for several, its keys in order', () => {
  assert.equal(posterValue([]), null);
  assert.equal(posterValue(['/posters/a.jpg']), '/posters/a.jpg');
  assert.equal(posterValue(['/posters/a.jpg', '/posters/b.jpg', '/posters/a.jpg']), '["/posters/a.jpg","/posters/b.jpg"]');
  assert.deepEqual(posterKeysOf('["/posters/a.jpg?v=1","/posters/b.webp"]'), ['posters/a.jpg', 'posters/b.webp']);
  assert.deepEqual(posterKeysOf(['/posters/a.jpg', 'posters/a.jpg', null, '["/posters/c.png"]']), ['posters/a.jpg', 'posters/c.png']);
  assert.equal(isPdfPoster('/posters/x.pdf'), true);
  assert.equal(isPdfPoster('["/posters/x.pdf","/posters/y.pdf"]'), false, 'a gallery is pictures');
});
