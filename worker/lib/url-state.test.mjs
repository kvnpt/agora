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
  assert.equal(U.classifyPath('/services').services, true);
  assert.equal(U.classifyPath('/social/services').socialOnly, false, 'services wins');
  assert.equal(U.classifyPath('/en').englishStrict, true);
  assert.equal(U.classifyPath('/bilingual').englishStrict, false);
  assert.equal(U.classifyPath('/liturgy').service, 'liturgy');
  assert.equal(U.classifyPath('/next-tue', { today }).dateFocus, '2026-10-06');
  assert.deepEqual(U.classifyPath('/smg+sgr').parishSlugs, ['smg', 'sgr']);
  assert.equal(U.classifyPath('/donate').donate, true);
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
