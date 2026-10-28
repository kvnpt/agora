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
  assert.equal(U.pageKind(U.classifyPath('/services')), 'timetable', 'the timetable of services');
  assert.equal(U.pageKind(U.classifyPath('/sgr/services')), null, 'at a parish, the app answers it');
  assert.equal(U.classifyPath('/parishes').timetable, true, '/parishes is the timetable too');
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

test('/weeknights and /weekends are spans of the week, and a timetable page', () => {
  const w = U.classifyPath('/greek/weeknights/services');
  assert.deepEqual([w.jurisdiction, w.dayGroup, w.kind, w.day, w.parishSlugs], ['greek', 'weeknights', 'services', null, null]);
  assert.equal(U.classifyPath('/weekend').dayGroup, 'weekends', 'one spelling for both');
  assert.equal(U.classifyPath('/weeknight/vespers').dayGroup, 'weeknights');
  assert.equal(U.pageKind(U.classifyPath('/weekends')), 'timetable');
  assert.equal(U.pageKind(U.classifyPath('/weeknights/liturgy')), 'timetable');
  const p = U.classifyPath('/sgr/weekends');
  assert.deepEqual([p.parishSlugs, p.dayGroup, U.pageKind(p)], [['sgr'], 'weekends', 'parish']);
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

test('the kind filter: Services and its three, Talks and Bible studies, Socials and its two', () => {
  const k = (p) => { const r = U.classifyPath(p); return [r.kind, r.kindSub, r.service]; };
  assert.deepEqual(k('/services'), ['services', null, null]);
  assert.deepEqual(k('/greek/prayer'), ['services', 'prayer', null]);
  // /liturgy, /feast and /bible-study are services (services.js) first; the
  // app reads a feed-wide one as its kind (kindOfService).
  assert.deepEqual(k('/liturgy'), [null, null, 'liturgy']);
  assert.deepEqual(k('/bible-study'), [null, null, 'bible-study']);
  assert.deepEqual(U.kindOfService('liturgy'), ['services', 'liturgy']);
  assert.deepEqual(U.kindOfService('feast'), ['services', 'feast']);
  assert.deepEqual(U.kindOfService('bible-study'), ['talks', 'bible-study']);
  assert.equal(U.kindOfService('vespers'), null);
  assert.deepEqual(k('/talks'), ['talks', null, null]);
  assert.deepEqual(k('/social'), ['socials', null, null]);
  assert.deepEqual(k('/social-gatherings'), ['socials', 'social', null]);
  assert.deepEqual(k('/youth'), ['socials', 'youth', null]);
  assert.equal(U.kindSegment('socials', 'youth'), 'youth');
  // As people type them, or as links once had them: read and never written.
  assert.deepEqual(k('/social-youth'), ['socials', 'youth', null]);
  assert.deepEqual(k('/talk'), ['talks', null, null]);
  assert.deepEqual(k('/socials'), ['socials', null, null]);
  assert.deepEqual(U.classifyPath('/sgr/talk').parishSlugs, ['sgr'], '/sgr/talk is St George, with its talks');
  assert.deepEqual(U.classifyPath('/smg/youth').parishSlugs, ['smg'], '/smg/youth is SMG, with its youth groups');
  assert.deepEqual(k('/'), [null, null, null]);
  assert.deepEqual(k('/talks/timetables'), [null, null, null], 'the timetable wins');
  for (const old of ['/worship', '/services-liturgy', '/studies']) {
    assert.equal(U.classifyPath(old).kind, null, `${old} is gone (the Worker redirects it)`);
  }
  for (const [seg, [kind, sub]] of Object.entries(U.KIND_SEGMENTS)) {
    assert.equal(U.kindSegment(kind, sub), seg, 'every segment round-trips');
  }
  assert.equal(U.kindSegment(null), null);
  assert.equal(U.kindSegment('services', 'liturgy'), 'liturgy', 'a sub-kind is its own word');
  assert.equal(U.kindSegment('services', 'feast'), 'feast');
  assert.equal(U.kindSegment('talks', 'bible-study'), 'bible-study');
  for (const p of ['/talks', '/youth', '/social-youth', '/this-week']) assert.equal(U.pageKind(U.classifyPath(p)), null, `${p} is the app's`);
});

test('a language filter is any language: English keeps its spellings, the rest are /in-<language>', () => {
  const l = (p) => { const r = U.classifyPath(p); return [r.lang, r.langStrict, r.englishOnly]; };
  assert.deepEqual(l('/en'), ['English', false, true]);
  assert.deepEqual(l('/en-only'), ['English', true, true]);
  assert.deepEqual(l('/in-greek'), ['Greek', false, false]);
  assert.deepEqual(l('/in-church-slavonic-only'), ['Church Slavonic', true, false]);
  assert.equal(U.englishSegment({ lang: 'English' }), 'en');
  assert.equal(U.englishSegment({ lang: 'English', langStrict: true }), 'en-only');
  assert.equal(U.englishSegment({ lang: 'Church Slavonic', langStrict: true }), 'in-slavonic-only');
  // Slavonic and Russian are Church Slavonic (languages.js), so the old links land there.
  assert.deepEqual(l('/in-slavonic'), ['Church Slavonic', false, false]);
  assert.deepEqual(l('/in-russian'), ['Church Slavonic', false, false]);
  assert.equal(U.englishSegment({ englishOnly: true, englishStrict: false }), 'en', 'the older names still mean English');
  assert.equal(U.englishSegment({}), null);
  assert.equal(U.pageKind(U.classifyPath('/sgr/in-greek')), null, 'a language beside a parish is the app\'s');
});

test('/this-week is the feed for the next seven days', () => {
  assert.equal(U.classifyPath('/this-week').week, true);
  assert.equal(U.classifyPath('/greek/this-week').jurisdiction, 'greek');
  assert.equal(U.classifyPath('/this-week').weekOffset, 0);
});

test('a week either side, and the month: /next-week, /in-3-weeks, /last-week, /2-weeks-ago, /this-month', () => {
  const w = (p) => { const r = U.classifyPath(p, { today: '2026-10-14' }); return [r.week, r.weekOffset, r.dateFocus]; };
  assert.deepEqual(w('/next-week'), [true, 1, null], 'a week, not "from seven days out"');
  assert.deepEqual(w('/in-3-weeks'), [true, 3, null]);
  assert.deepEqual(w('/last-week'), [true, -1, null]);
  assert.deepEqual(w('/2-weeks-ago'), [true, -2, null]);
  assert.equal(U.classifyPath('/this-month').month, true);
  for (const n of [-3, -1, 0, 1, 2, 5]) assert.equal(U.weekOffsetOf(U.weekSegment(n)), n, `week ${n} round-trips`);
  for (const p of ['/next-week', '/this-month', '/last-week']) assert.equal(U.pageKind(U.classifyPath(p)), null, `${p} is the app's`);
});

test('an old /worship, /services-liturgy or /studies link is sent to its name now; a current one is left alone', () => {
  assert.equal(U.renamedPath('/worship'), '/services');
  assert.equal(U.renamedPath('/greek/Worship-Liturgy'), '/greek/liturgy');
  assert.equal(U.renamedPath('/sgr/worship-feast/next-sun'), '/sgr/feast/next-sun');
  assert.equal(U.renamedPath('/services-prayer'), '/prayer');
  assert.equal(U.renamedPath('/studies/en'), '/talks/en');
  assert.equal(U.renamedPath('/liturgy'), null);
  assert.equal(U.renamedPath('/services'), null);
  assert.equal(U.renamedPath('/timetables'), null);
  assert.equal(U.renamedPath('/worshipful'), null, 'whole segments only');
  assert.equal(U.renamedPath('/'), null);
});

test('/monasteries is a where, beside a jurisdiction or a region, and a page of its own', () => {
  const r = U.classifyPath('/greek/monasteries');
  assert.equal(r.jurisdiction, 'greek');
  assert.equal(r.monasteries, true);
  assert.equal(r.parishSlugs, null, 'not a parish');
  assert.equal(U.classifyPath('/monastery').monasteries, true);
  assert.equal(U.pageKind(U.classifyPath('/monasteries')), 'timetable');
  assert.equal(U.pageKind(U.classifyPath('/sgr/monasteries')), null, "a parish card does not answer it");
});

test('several jurisdictions or days: /antiochian+greek, /wed+fri, or one segment each', () => {
  const r = U.classifyPath('/greek+antiochian/wed+fri');
  assert.deepEqual([r.jurisdiction, r.day], [['antiochian', 'greek'], [3, 5]], 'in the tabs’ order, and from Sunday');
  assert.deepEqual(U.classifyPath('/greek/antiochian').jurisdiction, ['antiochian', 'greek']);
  assert.deepEqual(U.classifyPath('/fri/wed').day, [3, 5]);
  assert.equal(U.classifyPath('/greek').jurisdiction, 'greek', 'one is still its key');
  assert.equal(U.classifyPath('/sun').day, 0, 'and one day its number');
  assert.equal(U.classifyPath('/greek+greek').jurisdiction, 'greek');
  assert.deepEqual(U.classifyPath('/wed+sgr').parishSlugs, ['wed', 'sgr'], 'a mix is a list of parishes, as it always was');
  assert.deepEqual(U.classifyPath('/sgr/wed+fri').day, [3, 5], 'beside a parish too');
  assert.equal(U.pageKind(U.classifyPath('/antiochian+greek')), 'timetable');
  assert.equal(U.jurisdictionSegment(['greek', 'antiochian']), 'antiochian+greek');
  assert.equal(U.jurisdictionSegment('greek'), 'greek');
  assert.equal(U.jurisdictionSegment(null), null);
  assert.deepEqual(U.jurisdictionValue(['serbian', 'greek', 'serbian']), ['greek', 'serbian']);
  assert.equal(U.jurisdictionValue([]), null);
  assert.ok(U.jurisdictionMatches(['greek', 'serbian'], 'serbian'));
  assert.ok(!U.jurisdictionMatches('greek', 'serbian'));
  assert.ok(U.jurisdictionMatches(null, 'serbian'));
});

test('a word nothing claims, after a parish, is what is asked of it: /smmp/disco keeps St Mary’s', () => {
  const r = U.classifyPath('/smmp/disco', { today });
  assert.deepEqual([r.parishSlugs, r.words], [['smmp'], ['disco']]);
  assert.equal(U.pageKind(r), 'parish');
  assert.deepEqual(U.classifyPath('/smmp/disco-night/sat', { today }).words, ['disco-night']);
  assert.equal(U.classifyPath('/smmp/disco-night/sat', { today }).day, 6, 'a word the grammar knows keeps its meaning');
  assert.deepEqual(U.classifyPath('/sgr/youth', { today }).words, [], '/youth is a kind, never a search');
  assert.deepEqual(U.classifyPath('/sgr', { today }).words, []);
  // The reader finds which word is the parish; the rest are its words, in order.
  const back = U.parishNamed(U.classifyPath('/disco/night/smmp', { today }), 'smmp');
  assert.deepEqual([back.parishSlugs, back.words], [['smmp'], ['disco', 'night']]);
});
