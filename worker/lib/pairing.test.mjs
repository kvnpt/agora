// What a calendar's dated services become against the timetable, decided
// without a database: the questions asked, what an answer may do, the
// override a pair needs, and the words an unsure one is passed on in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { expandFrom } from '../../public/shared/project.mjs';
import { localSpanToUtc } from '../../public/shared/tz.mjs';
import { reconcile } from './reconcile.mjs';
import { leftoverWords, questionsFor, resolvePairing, overrideFor, suggestionFor, occurrenceKey } from './pairing.mjs';
import { ADAPTER_READS_DDL, answersFor, askModel, buildPairingRequest, PAIRING_MODEL } from './pairing-read.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const TZ = 'Australia/Melbourne';
const SUNDAY = '2026-11-08';
const RULES = [
  { id: 1, parish_id: 'gs', day_of_week: 0, start_time: '09:00', end_time: '10:00', title: 'Matins', event_type: 'liturgy', p_timezone: TZ },
  { id: 2, parish_id: 'gs', day_of_week: 0, start_time: '10:00', end_time: '12:00', title: 'Liturgy', event_type: 'liturgy', p_timezone: TZ },
];
const PROJECTED = expandFrom({ schedules: RULES, overrides: [] }, '2026-11-07T13:00:00Z', '2026-11-08T13:00:00Z');
const at = (title, start, end) => {
  const s = localSpanToUtc(TZ, SUNDAY, start, end || null);
  return { title, start_utc: s.start_utc, end_utc: s.end_utc || null, source_hash: `${title}@${start}` };
};
const diffOf = (scraped) => reconcile({ projected: PROJECTED, scraped, timezone: TZ, windowFrom: SUNDAY, windowTo: SUNDAY });
const plan = (scraped, answers = new Map(), spoken = new Set()) => {
  const diff = diffOf(scraped);
  const questions = questionsFor({ diff, timezone: TZ, spoken });
  return { diff, questions, ...resolvePairing({ diff, questions, answers, spoken }) };
};
const liturgy = PROJECTED.find(i => i.title === 'Liturgy');

test('what is left of a title once its service is named', () => {
  assert.deepEqual(leftoverWords('Divine Liturgy', 'Liturgy'), []);
  assert.deepEqual(leftoverWords('Matins (Orthros)', 'Matins'), []);
  assert.deepEqual(leftoverWords('Divine Liturgy in English', 'Liturgy'), [], 'a language is how, not what day');
  assert.deepEqual(leftoverWords('Divine Liturgy – St Nicholas', 'Liturgy'), ['st', 'nicholas']);
  assert.deepEqual(leftoverWords('Liturgy of St John Chrysostom', 'Liturgy'), ['st', 'john', 'chrysostom'],
    'a liturgy\'s own name is left over too: that is the model\'s to tell apart');
});

test('a calendar that says what the timetable says asks nothing and writes nothing', () => {
  const p = plan([at('Matins (Orthros)', '09:00', '10:00'), at('Divine Liturgy', '10:00', '12:00'), at('Bookshop', '12:00')]);
  assert.equal(p.questions.length, 0);
  assert.equal(p.pairs.length, 2);
  assert.deepEqual(p.oneOffs.map(e => e.title), ['Bookshop']);
  assert.equal(p.missing.length, 0);
  for (const pair of p.pairs) assert.equal(overrideFor(pair, TZ), null, `${pair.instance.title} needs no row`);
});

test('a subtitle is asked about only where the title says more than the service', () => {
  const p = plan([at('Matins (Orthros)', '09:00'), at('Divine Liturgy – St Nicholas', '10:00')]);
  assert.equal(p.questions.length, 1);
  assert.equal(p.questions[0].kind, 'subtitle');
  assert.equal(p.questions[0].key, occurrenceKey(liturgy));
  assert.equal(p.questions[0].text, 'subtitle\nregular service: "Liturgy"\ncalendar entry: "Divine Liturgy – St Nicholas"');

  const answered = plan([at('Matins (Orthros)', '09:00'), at('Divine Liturgy – St Nicholas', '10:00')],
    new Map([[p.questions[0].text, { entry: 0, sure: true, service: '', feast: 'St Nicholas' }]]));
  const pair = answered.pairs.find(x => x.instance === liturgy || x.instance.title === 'Liturgy');
  assert.equal(pair.feast, 'St Nicholas');
  const o = overrideFor(pair, TZ);
  assert.equal(o.patch_feast, 'St Nicholas');
  assert.equal(o.patch_start_time, null, 'the time is the rule\'s');
  assert.equal(o.occurrence_date, SUNDAY);
});

test('a moved service carries its new hours, and its end only when that end makes sense', () => {
  const p = plan([at('Matins (Orthros)', '08:30', '09:30'), at('Divine Liturgy', '09:30', '11:30')]);
  const lit = p.pairs.find(x => x.instance.title === 'Liturgy');
  assert.deepEqual([overrideFor(lit, TZ).patch_start_time, overrideFor(lit, TZ).patch_end_time], ['09:30', '11:30']);
  assert.match(overrideFor(lit, TZ).note, /^From the source: "Divine Liturgy" at 09:30$/);

  const noEnd = plan([at('Matins (Orthros)', '09:00'), at('Divine Liturgy', '09:30')]);
  assert.equal(overrideFor(noEnd.pairs.find(x => x.instance.title === 'Liturgy'), TZ).patch_end_time, null,
    'no end from the source: the rule\'s noon end would be wrong as often as right, so none');
});

test('an entry at the rule\'s minute under another name is asked about, and stays its own until answered', () => {
  const scraped = [at('Matins (Orthros)', '09:00'), at('Feast of St Nicholas', '10:00'), at('Bookshop', '12:00')];
  const p = plan(scraped);
  const which = p.questions.filter(q => q.kind === 'which');
  assert.equal(which.length, 1);
  assert.equal(which[0].text, [
    'which', 'date: Sunday 8 November 2026', 'regular service: "Liturgy" at 10:00',
    'unmatched calendar entries that day:', '1. "Feast of St Nicholas" at 10:00', '2. "Bookshop" at 12:00',
  ].join('\n'));
  assert.equal(p.missing.length, 0, 'held: never a cancellation');
  assert.deepEqual(p.oneOffs.map(e => e.title).sort(), ['Bookshop', 'Feast of St Nicholas']);

  const sure = plan(scraped, new Map([[which[0].text, { entry: 1, sure: true, service: 'Divine Liturgy', feast: 'St Nicholas' }]]));
  const pair = sure.pairs.find(x => x.instance.title === 'Liturgy');
  assert.equal(pair.event.title, 'Feast of St Nicholas');
  assert.equal(pair.service, '', 'the same service keeps the timetable\'s name');
  assert.equal(pair.feast, 'St Nicholas');
  assert.deepEqual(sure.oneOffs.map(e => e.title), ['Bookshop']);
});

test('a different service the model names takes the day\'s title', () => {
  // A Saturday with Vespers on the timetable, and on the feast a Vesperal
  // Liturgy instead, under the feast's name: a liturgy is not Vespers.
  const sat = expandFrom({ schedules: [{ id: 5, parish_id: 'gs', day_of_week: 6, start_time: '17:00', title: 'Vespers',
    event_type: 'vespers', p_timezone: TZ }], overrides: [] }, '2026-11-06T13:00:00Z', '2026-11-07T13:00:00Z');
  const s = localSpanToUtc(TZ, '2026-11-07', '17:00', null);
  const scraped = [{ title: 'Synaxis of the Archangels', start_utc: s.start_utc, end_utc: null, source_hash: 'x' }];
  const diff = reconcile({ projected: sat, scraped, timezone: TZ, windowFrom: '2026-11-07', windowTo: '2026-11-07' });
  const [q] = questionsFor({ diff, timezone: TZ });
  const answers = new Map([[q.text, { entry: 1, sure: true, service: 'Vesperal Liturgy', feast: 'Synaxis of the Archangels' }]]);
  const p = resolvePairing({ diff, questions: [q], answers });
  const o = overrideFor(p.pairs[0], TZ, () => 'liturgy');
  assert.equal(o.patch_title, 'Vesperal Liturgy');
  assert.equal(o.patch_event_type, 'liturgy');
  assert.equal(o.patch_feast, 'Synaxis of the Archangels');

  // "Divine Liturgy" for a rule called "Liturgy" is the same service: no title.
  const sun = [at('Matins (Orthros)', '09:00'), at('Nativity of the Theotokos', '10:00')];
  const sq = plan(sun).questions.find(x => x.kind === 'which');
  const same = plan(sun, new Map([[sq.text, { entry: 1, sure: true, service: 'Divine Liturgy', feast: '' }]]));
  assert.equal(overrideFor(same.pairs.find(x => x.instance.title === 'Liturgy'), TZ), null);
});

test('an unsure answer withholds the cancellation and is passed on; it never makes one', () => {
  const scraped = [at('Matins (Orthros)', '09:00'), at('Parish feast day', '11:00')];
  const q = plan(scraped).questions.find(x => x.kind === 'which');
  assert.ok(plan(scraped).missing.some(i => i.title === 'Liturgy'), 'the rules alone would cancel it');

  const unsure = plan(scraped, new Map([[q.text, { entry: 1, sure: false, service: '', feast: '' }]]));
  assert.equal(unsure.missing.length, 0);
  assert.equal(unsure.withheld.length, 1);
  assert.equal(unsure.unsure.length, 1);
  assert.deepEqual(unsure.oneOffs.map(e => e.title), ['Parish feast day']);

  const s = suggestionFor(unsure.unsure[0], 'The parish calendar');
  assert.equal(s.about, 'Sunday 8 November 2026, Liturgy at 10:00');
  assert.equal(s.body, 'The parish calendar shows "Parish feast day", which might be the Liturgy moved or renamed for the day. '
    + 'Agora could not tell whether the Liturgy is on as usual, so for now the page shows it at 10:00, and the entries as events of their own. '
    + 'If it has moved or is not on, change that day\'s Liturgy; the parish calendar will not undo it.');

  // "None of these is it", sure: the rules' answer, a cancellation the rules
  // alone would make, stands. The answer added nothing to it.
  const none = plan(scraped, new Map([[q.text, { entry: 0, sure: true, service: '', feast: '' }]]));
  assert.deepEqual(none.missing.map(i => i.title), ['Liturgy']);

  // And a held occurrence the model says is not the entry is still not missing.
  const heldScrape = [at('Matins (Orthros)', '09:00'), at('Memorial service', '10:00')];
  const hq = plan(heldScrape).questions.find(x => x.kind === 'which');
  const held = plan(heldScrape, new Map([[hq.text, { entry: 0, sure: true, service: '', feast: '' }]]));
  assert.equal(held.missing.length, 0, 'an answer can never cause a cancellation');
});

test('an answer out of range, or an entry already taken, pairs nothing', () => {
  const scraped = [at('Matins (Orthros)', '09:00'), at('Feast of St Nicholas', '10:00')];
  const q = plan(scraped).questions.find(x => x.kind === 'which');
  for (const entry of [2, -1, 99]) {
    const p = plan(scraped, new Map([[q.text, { entry, sure: true, service: '', feast: '' }]]));
    assert.ok(!p.pairs.some(x => x.instance.title === 'Liturgy'), `entry ${entry}`);
    assert.equal(p.missing.length, 0, 'held, so still not missing');
  }
});

test('a feast the model writes in a paragraph is not kept', () => {
  const p0 = plan([at('Matins (Orthros)', '09:00'), at('Divine Liturgy – St Nicholas', '10:00')]);
  const p = plan([at('Matins (Orthros)', '09:00'), at('Divine Liturgy – St Nicholas', '10:00')],
    new Map([[p0.questions[0].text, { entry: 0, sure: true, service: '', feast: 'x'.repeat(200) }]]));
  assert.equal(overrideFor(p.pairs.find(x => x.instance.title === 'Liturgy'), TZ), null);
});

test('where a person has spoken, nothing is asked', () => {
  const spoken = new Set([occurrenceKey(liturgy)]);
  const p = plan([at('Matins (Orthros)', '09:00'), at('Divine Liturgy – St Nicholas', '10:00'), at('Feast', '10:00')], new Map(), spoken);
  assert.ok(!p.questions.some(q => q.key === occurrenceKey(liturgy)));
});

// ── the asking, and the remembering ──────────────────────────────────────

class D1 {
  constructor(db) { this.db = db; }
  prepare(sql) { return new S(this.db, sql, []); }
  async batch(stmts) { return this.db.transaction(() => stmts.map(s => s._run()))(); }
}
class S {
  constructor(db, sql, a) { this.db = db; this.sql = sql; this.args = a; }
  bind(...a) { return new S(this.db, this.sql, a); }
  _run() { const r = this.db.prepare(this.sql).run(...this.args); return { meta: { changes: r.changes } }; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args) }; }
  async run() { return this._run(); }
}

const reply = (body, { status = 200 } = {}) => async (url, init) => {
  reply.calls.push({ url, body: JSON.parse(init.body) });
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
};
reply.calls = [];
const message = (answers, stop = 'end_turn') => ({
  stop_reason: stop,
  content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify({ answers }) }],
});
const QS = [{ text: 'subtitle\nregular service: "Liturgy"\ncalendar entry: "Divine Liturgy – St Nicholas"' }];

test('the first-use DDL builds the same table as the baseline', () => {
  const base = new Database(':memory:');
  base.exec(fs.readFileSync('d1/schema.sql', 'utf8'));
  const lazy = new Database(':memory:');
  for (const sql of ADAPTER_READS_DDL) lazy.exec(sql);
  const cols = (db) => db.prepare('PRAGMA table_info(adapter_reads)').all();
  assert.ok(cols(base).length, 'the baseline has the table');
  assert.deepEqual(cols(lazy), cols(base));
});

test('one request, in the shape Haiku 5.5 takes', () => {
  const r = buildPairingRequest(QS);
  assert.equal(r.model, PAIRING_MODEL);
  assert.equal(r.model, 'claude-haiku-5-5');
  assert.equal(r.output_config.effort, 'low');
  assert.equal(r.output_config.format.type, 'json_schema');
  for (const k of ['temperature', 'top_p', 'top_k', 'thinking']) assert.ok(!(k in r), `no ${k}`);
  assert.equal(r.messages.length, 1, 'no prefill');
  assert.match(r.messages[0].content, /^id: q1\nsubtitle\n/);
});

test('every failure leaves the questions unanswered, and never throws', async () => {
  const cases = [
    reply('overloaded', { status: 529 }),
    reply(message([{ id: 'q1', entry: 0, sure: true, service: '', feast: 'St Nicholas' }], 'max_tokens')),
    reply(message([{ id: 'q1', entry: 0, sure: true, service: '', feast: 'St Nicholas' }], 'refusal')),
    reply({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }] }),
    async () => { throw new Error('network'); },
  ];
  for (const fetchImpl of cases) {
    const got = await askModel(QS, { apiKey: 'k', fetchImpl });
    assert.equal(got.size, 0);
  }
  const ok = await askModel(QS, { apiKey: 'k', fetchImpl: reply(message([
    { id: 'q1', entry: 0, sure: true, service: '', feast: 'St Nicholas' },
    { id: 'q7', entry: 1, sure: true, service: '', feast: 'out of range' },
  ])) });
  assert.deepEqual([...ok.entries()], [[0, { entry: 0, sure: true, service: '', feast: 'St Nicholas' }]]);
});

test('asked once, remembered after; nothing asked without a key or a cache', async () => {
  const db = new D1(new Database(':memory:'));
  reply.calls = [];
  const fetchImpl = reply(message([{ id: 'q1', entry: 0, sure: true, service: '', feast: 'St Nicholas' }]));

  const none = await answersFor(QS, { db, adapterId: 'a', fetchImpl });
  assert.equal(none.asked, 0, 'no key, no request');
  assert.equal(reply.calls.length, 0);

  const first = await answersFor(QS, { db, adapterId: 'a', apiKey: 'k', fetchImpl });
  assert.equal(first.asked, 1);
  assert.ok(first.fresh.has(QS[0].text));
  assert.equal(first.answers.get(QS[0].text).feast, 'St Nicholas');

  const second = await answersFor([...QS, ...QS], { db, adapterId: 'a', apiKey: 'k', fetchImpl });
  assert.equal(second.asked, 0);
  assert.equal(second.fresh.size, 0, 'an answer is passed on by the run that got it, once');
  assert.equal(second.answers.get(QS[0].text).feast, 'St Nicholas');
  assert.equal(reply.calls.length, 1);

  const broken = { prepare() { throw new Error('D1 down'); }, async batch() { throw new Error('D1 down'); } };
  const b = await answersFor([{ text: 'another' }], { db: broken, adapterId: 'a', apiKey: 'k', fetchImpl });
  assert.equal(b.asked, 0, 'somewhere to keep the answer, or no asking: else every run asks afresh');
  assert.equal(reply.calls.length, 1);
});
