// One setting per parish decides what an import may write — see
// public/shared/read-from.js. It replaced per-slot "suppress" rulings, per-field
// pins and a ladder of source tiers (docs/sources-and-ingestion.md).

import test from 'node:test';
import assert from 'node:assert/strict';
import readFrom from '../public/shared/read-from.js';
import { planWrite } from './antiochian-schedules.mjs';
import { planWrite as greekPlanWrite } from './greek-schedules.mjs';

test('who may write what', () => {
  const p = (read_from) => ({ read_from });
  // The directory is a stopgap: it writes only parishes still on it.
  assert.equal(readFrom.mayImport(p('directory'), 'directory'), true);
  assert.equal(readFrom.mayImport(p('website'), 'directory'), false);
  assert.equal(readFrom.mayImport(p('hand'), 'directory'), false);
  // Reading a parish's own site ends the stopgap, so a website import may take
  // over a directory parish; it never touches one kept by hand.
  assert.equal(readFrom.mayImport(p('website'), 'website'), true);
  assert.equal(readFrom.mayImport(p('directory'), 'website'), true);
  assert.equal(readFrom.mayImport(p('hand'), 'website'), false);
});

test('an unknown value is hand-kept, and a row from before the column is the directory', () => {
  assert.equal(readFrom.readFrom({ read_from: 'something-new' }), 'hand');
  assert.equal(readFrom.mayImport({ read_from: 'something-new' }, 'website'), false);
  assert.equal(readFrom.readFrom({}), 'directory');
  assert.equal(readFrom.readFrom(null), 'directory');
});

test('every value has words for the panel', () => {
  for (const v of readFrom.READ_FROM) {
    assert.ok(readFrom.LABELS[v], v);
    assert.ok(readFrom.HINTS[v], v);
  }
});

test('the planners no longer referee slots: what reaches them is written', () => {
  // Gating is per parish, before planning. A deleted rule at a directory parish
  // comes back on the next run — which is why the panel asks, on the first hand
  // edit, whether to stop reading that parish at all.
  const rule = { parish_id: 'p', day_of_week: 6, start_time: '18:00', title: 'Vespers', event_type: 'vespers' };
  for (const plan of [planWrite, greekPlanWrite]) {
    const out = plan([rule], []);
    assert.equal(out.inserts.length, 1);
    assert.equal(out.refused, undefined);
  }
});
