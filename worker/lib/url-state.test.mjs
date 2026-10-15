// The URL grammar, shared by the app and the Worker's lite pages.
//
// These are the links people actually send — the parish share button, the
// event share button, the URL chip — and what each must mean.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const U = require('../../public/shared/url-state.js');
const today = '2026-09-30'; // a Wednesday

test('a parish, alone and with a focus', () => {
  assert.deepEqual(U.classifyPath('/sgr').parishSlugs, ['sgr']);
  const d = U.classifyPath('/sgr/next-tue', { today });
  assert.deepEqual([d.parishSlugs, d.dateFocus, d.precision], [['sgr'], '2026-10-06', 'day']);
  const s = U.classifyPath('/SGR/Wed/Liturgy', { today });
  assert.deepEqual([s.parishSlugs, s.day, s.service], [['sgr'], 3, 'liturgy']);
  const m = U.classifyPath('/sgr/october', { today });
  assert.deepEqual([m.dateFocus, m.precision], ['2026-10-01', 'month']);
});

test('event ids, stored and projected', () => {
  assert.equal(U.classifyPath('/102').eventId, '102');
  assert.equal(U.classifyPath('/42:2026-10-04').eventId, '42:2026-10-04');
  assert.equal(U.classifyPath('/42:2026-10-04').parishSlugs, null);
  assert.equal(U.isEventId('sgr'), false);
});

test('app views are not parishes', () => {
  const g = U.classifyPath('/greek/qld');
  assert.deepEqual([g.jurisdiction, g.location, g.parishSlugs], ['greek', 'qld', null]);
  assert.equal(U.classifyPath('/timetables').timetable, true);
  assert.equal(U.classifyPath('/timetable').timetable, true, 'the singular, as people type it');
  assert.equal(U.classifyPath('/social/timetables').socialOnly, false, 'the timetable wins');
  assert.equal(U.classifyPath('/services').worshipOnly, true, 'the feed narrowed to services');
  assert.equal(U.classifyPath('/services').timetable, false, '/services is not the timetable any more');
  assert.equal(U.classifyPath('/greek/services').worshipOnly, true);
  assert.equal(U.classifyPath('/services/timetables').worshipOnly, false, 'the timetable wins over services too');
  const both = U.classifyPath('/social/services');
  assert.deepEqual([both.kind, both.socialOnly, both.worshipOnly], ['services', false, true], 'one kind at a time: the later wins');
  assert.equal(U.pageKind(U.classifyPath('/services')), null, 'the app answers it, as it does /social');
  assert.equal(U.classifyPath('/liturgy').service, 'liturgy');
  assert.equal(U.classifyPath('/next-tue', { today }).dateFocus, '2026-10-06');
  assert.deepEqual(U.classifyPath('/smg+sgr').parishSlugs, ['smg', 'sgr']);
  assert.equal(U.classifyPath('/donate').donate, true);
});

test('English is any service with English in it; English only is nothing else', () => {
  for (const p of ['/en', '/English', '/bilingual', '/half-english', '/English-half', '/some-english']) {
    const r = U.classifyPath(p);
    assert.deepEqual([r.englishOnly, r.englishStrict, r.parishSlugs], [true, false, null], p);
  }
  for (const p of ['/EN-only', '/english-only', '/full-English']) {
    const r = U.classifyPath(p);
    assert.deepEqual([r.englishOnly, r.englishStrict, r.parishSlugs], [true, true, null], p);
  }
  const g = U.classifyPath('/greek/qld/english-only');
  assert.deepEqual([g.jurisdiction, g.location, g.englishStrict], ['greek', 'qld', true]);
});

test('a language filter writes one spelling of each', () => {
  assert.equal(U.englishSegment({ englishOnly: false }), null);
  assert.equal(U.englishSegment({ englishOnly: true, englishStrict: false }), 'en');
  assert.equal(U.englishSegment({ englishOnly: true, englishStrict: true }), 'en-only');
  // and each reads back as what wrote it
  assert.equal(U.classifyPath('/en-only').englishStrict, true);
  assert.equal(U.classifyPath('/en').englishStrict, false);
});

test('no acronym may spell a language', () => {
  const slugs = require('../../public/shared/slugs.js');
  for (const s of ['en', 'english', 'bilingual', 'half-english', 'english-half', 'some-english',
    'en-only', 'english-only', 'full-english']) {
    assert.ok(slugs.reservedSlugReason(s), s);
  }
});

test('a part of the day combines with everything a feed filter does', () => {
  const e = U.classifyPath('/antiochian/evening');
  assert.deepEqual([e.jurisdiction, e.part, e.parishSlugs], ['antiochian', 'evening', null]);
  const w = U.classifyPath('/greek/qld/wed/mornings/liturgy');
  assert.deepEqual([w.jurisdiction, w.location, w.day, w.part, w.service], ['greek', 'qld', 3, 'morning', 'liturgy']);
  const p = U.classifyPath('/sgr/evening');
  assert.deepEqual([p.parishSlugs, p.part], [['sgr'], 'evening']);
  assert.equal(U.classifyPath('/liturgy').part, null);
});

test('a path that will not decode means nothing, and does not throw', () => {
  assert.equal(U.classifyPath('/%E0%A4%A').parishSlugs, null);
});

test('a day focus pins only an event on that day', () => {
  const at = (id, d) => ({ id, start_utc: `${d}T00:00:00Z`, day: d });
  const events = [at('b', '2026-10-06'), at('a', '2026-10-04'), at('c', '2026-10-06')];
  const local = e => e.day;
  assert.equal(U.firstEventOnDay(events, '2026-10-06', 'day', local).id, 'b');
  assert.equal(U.firstEventOnDay(events, '2026-10-05', 'day', local), null, 'a quiet day pins nothing');
  assert.equal(U.firstEventOnDay(events, '2026-10-01', 'month', local), null, 'a month is not a day');
  assert.equal(U.firstEventOnDay([{ ...events[0], is_tombstone: 1 }], '2026-10-06', 'day', local), null);
});

test('the kind filter: Services and its three, Studies, Socials and its two', () => {
  const k = (p) => { const r = U.classifyPath(p); return [r.kind, r.kindSub]; };
  assert.deepEqual(k('/services'), ['services', null]);
  assert.deepEqual(k('/services-liturgy'), ['services', 'liturgy']);
  assert.deepEqual(k('/greek/services-prayer'), ['services', 'prayer']);
  assert.deepEqual(k('/services-feast'), ['services', 'feast']);
  assert.deepEqual(k('/worship-liturgy'), ['services', 'liturgy'], 'the old name still reads');
  assert.deepEqual(k('/studies'), ['studies', null]);
  assert.deepEqual(k('/social'), ['socials', null]);
  assert.deepEqual(k('/social-gatherings'), ['socials', 'social']);
  assert.deepEqual(k('/social-youth'), ['socials', 'youth']);
  assert.deepEqual(k('/'), [null, null]);
  assert.deepEqual(k('/studies/timetables'), [null, null], 'the timetable wins');
  for (const [seg, [kind, sub]] of Object.entries(U.KIND_SEGMENTS)) {
    assert.equal(U.kindSegment(kind, sub), seg, 'every segment round-trips');
  }
  assert.equal(U.kindSegment(null), null);
  assert.equal(U.kindSegment('services', 'feast'), 'services-feast', 'the new name is the one written');
  for (const p of ['/studies', '/social-youth', '/this-week']) assert.equal(U.pageKind(U.classifyPath(p)), null, `${p} is the app's`);
});

test('a language filter is any language: English keeps its spellings, the rest are /in-<language>', () => {
  const l = (p) => { const r = U.classifyPath(p); return [r.lang, r.langStrict, r.englishOnly]; };
  assert.deepEqual(l('/en'), ['English', false, true]);
  assert.deepEqual(l('/en-only'), ['English', true, true]);
  assert.deepEqual(l('/in-greek'), ['Greek', false, false]);
  assert.deepEqual(l('/in-church-slavonic-only'), ['Church Slavonic', true, false]);
  assert.equal(U.englishSegment({ lang: 'English' }), 'en');
  assert.equal(U.englishSegment({ lang: 'English', langStrict: true }), 'en-only');
  assert.equal(U.englishSegment({ lang: 'Church Slavonic', langStrict: true }), 'in-church-slavonic-only');
  assert.equal(U.englishSegment({ englishOnly: true, englishStrict: false }), 'en', 'the older names still mean English');
  assert.equal(U.englishSegment({}), null);
  assert.equal(U.pageKind(U.classifyPath('/sgr/in-greek')), null, 'a language beside a parish is the app\'s');
});

test('/this-week is the feed for the next seven days', () => {
  assert.equal(U.classifyPath('/this-week').week, true);
  assert.equal(U.classifyPath('/greek/this-week').jurisdiction, 'greek');
  assert.equal(U.classifyPath('/next-week', { today: '2026-10-14' }).week, false, 'next-week is still a date');
});

test('an old /worship link is sent to its /services name; a current one is left alone', () => {
  assert.equal(U.renamedPath('/worship'), '/services');
  assert.equal(U.renamedPath('/greek/Worship-Liturgy'), '/greek/services-liturgy');
  assert.equal(U.renamedPath('/sgr/worship-feast/next-sun'), '/sgr/services-feast/next-sun');
  assert.equal(U.renamedPath('/services'), null);
  assert.equal(U.renamedPath('/timetables'), null);
  assert.equal(U.renamedPath('/worshipful'), null, 'whole segments only');
  assert.equal(U.renamedPath('/'), null);
});
