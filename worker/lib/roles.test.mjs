// The role model, and the bootstrap rule that makes it safe to deploy.

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRole, can, mayTouchParish, denial, parseParishIds, rolePayload, ROLES }
  from './roles.mjs';

const db = (rows) => ({
  prepare: () => ({ all: async () => { if (rows instanceof Error) throw rows; return { results: rows }; } }),
});

const row = (email, role, parishIds) => ({
  email, role, parish_ids: parishIds ? JSON.stringify(parishIds) : null,
});

// ── the bootstrap rule ──

test('an empty table makes everybody an owner, and says that it did', async () => {
  // The deploy that adds this must not lock the existing admin out of their
  // own panel. Before roles existed, everyone through Access was effectively
  // an owner — an empty table reproduces exactly that.
  const r = await resolveRole(db([]), 'anyone@example.org');
  assert.equal(r.role, 'owner');
  assert.equal(r.bootstrap, true);
});

test('a missing table reads as empty rather than throwing', async () => {
  // The code can deploy before the schema change lands, in either order.
  const r = await resolveRole(db(new Error('no such table: admin_roles')), 'a@b.c');
  assert.equal(r.role, 'owner');
  assert.equal(r.bootstrap, true);
});

test('the first row flips the rule: absence stops meaning owner', async () => {
  // THE DANGEROUS EDGE. Under a plain "missing means default" rule, adding a
  // sub-admin to Access and forgetting their row would silently make them an
  // owner — the exact failure this whole tier exists to prevent.
  const rows = [row('owner@example.org', 'owner')];
  assert.equal((await resolveRole(db(rows), 'owner@example.org')).role, 'owner');

  const stranger = await resolveRole(db(rows), 'someone-else@example.org');
  assert.equal(stranger.role, null);
  assert.equal(stranger.bootstrap, false);
});

test('email matching ignores case and surrounding space', async () => {
  // An identity provider may hand back a different casing than whoever typed
  // the row.
  const rows = [row('Deacon@Example.ORG', 'editor')];
  assert.equal((await resolveRole(db(rows), 'deacon@example.org')).role, 'editor');
  assert.equal((await resolveRole(db(rows), '  DEACON@EXAMPLE.ORG  ')).role, 'editor');
});

test('a role the code does not know is no role, not a guess', async () => {
  const rows = [row('a@b.c', 'superuser')];
  assert.equal((await resolveRole(db(rows), 'a@b.c')).role, null);
});

test('an unknown identity gets nothing, including null and empty', async () => {
  const rows = [row('a@b.c', 'owner')];
  for (const who of [null, undefined, '', '   ']) {
    assert.equal((await resolveRole(db(rows), who)).role, null, `${JSON.stringify(who)} got in`);
  }
});

// ── capabilities ──

test('owner may do everything the panel offers', async () => {
  for (const c of ['parish.delete', 'parish.acronym', 'colors.edit', 'people.manage',
    'adapter.pace', 'schedule.delete', 'links.edit']) {
    assert.equal(can('owner', c), true, `owner should have ${c}`);
  }
});

test('editor loses exactly the three that are hard to undo or reach site-wide', async () => {
  assert.equal(can('editor', 'parish.delete'), false);
  assert.equal(can('editor', 'parish.acronym'), false);
  assert.equal(can('editor', 'colors.edit'), false);
  assert.equal(can('editor', 'people.manage'), false);
  // …and keeps the day-to-day work.
  for (const c of ['parish.edit', 'schedule.edit', 'schedule.create', 'schedule.delete',
    'override.edit', 'adapter.run', 'links.edit']) {
    assert.equal(can('editor', c), true, `editor should keep ${c}`);
  }
});

test('a parish contact cannot create a parish or touch a scraper', async () => {
  // No create: a new parish is not their business, and it would be a way out
  // of their own scope — they would simply make one and own it.
  assert.equal(can('parish', 'parish.create'), false);
  assert.equal(can('parish', 'adapter.pace'), false);
  assert.equal(can('parish', 'adapter.run'), false);
  assert.equal(can('parish', 'parish.delete'), false);
  assert.equal(can('parish', 'parish.edit'), true);
  assert.equal(can('parish', 'schedule.edit'), true);
});

test('no role can do anything at all', async () => {
  for (const c of ['parish.edit', 'schedule.edit', 'links.edit', 'adapter.run']) {
    assert.equal(can(null, c), false);
  }
});

test('an unknown capability is refused rather than allowed', async () => {
  // Fail closed: a capability string nobody has defined must not pass because
  // a Set lookup happened to miss.
  assert.equal(can('owner', 'nuclear.launch'), false);
});

// ── parish scoping ──

test('only the parish role is scoped', async () => {
  const anyParish = 'greek-stparaskevi-blacktown';
  assert.equal(mayTouchParish({ role: 'owner', parishIds: [] }, anyParish), true);
  assert.equal(mayTouchParish({ role: 'editor', parishIds: [] }, anyParish), true);
});

test('a parish contact reaches their own parishes and no others', async () => {
  const who = { role: 'parish', parishIds: ['greek-stparaskevi-blacktown'] };
  assert.equal(mayTouchParish(who, 'greek-stparaskevi-blacktown'), true);
  assert.equal(mayTouchParish(who, 'greek-gopssc-buderim'), false);
  // A missing parish id is not a wildcard.
  assert.equal(mayTouchParish(who, null), false);
  assert.equal(mayTouchParish(who, undefined), false);
  assert.equal(mayTouchParish(who, ''), false);
});

test('a parish contact with an empty list touches nothing', async () => {
  // The right reading of "scoped to these parishes" when the list is empty,
  // and why the panel refuses to save that combination.
  assert.equal(mayTouchParish({ role: 'parish', parishIds: [] }, 'anything'), false);
});

test('parish_ids that is not a list of strings reads as none', async () => {
  assert.deepEqual(parseParishIds(null), []);
  assert.deepEqual(parseParishIds('not json'), []);
  assert.deepEqual(parseParishIds('{"a":1}'), []);
  assert.deepEqual(parseParishIds('[1,2,null,"ok",""]'), ['ok']);
});

// ── what the person is told ──

test('a refusal names the role and the thing, not just "forbidden"', async () => {
  assert.match(denial('editor', 'parish.delete'), /editor cannot delete a parish/);
  assert.match(denial('editor', 'parish.acronym'), /changes its public link/);
  assert.match(denial('parish', 'colors.edit'), /site-wide/);
});

test('somebody with no row is told to ask an owner, not that they are broken', async () => {
  assert.match(denial(null, 'parish.edit'), /not on the admin list/);
  assert.match(denial(null, 'parish.edit'), /ask an owner/i);
});

test('the payload lets the panel grey out exactly what the API will refuse', async () => {
  // One source of truth for both: the panel asks for the same capability map
  // the guard consults, so a disabled button and a 403 cannot disagree.
  const p = rolePayload({ role: 'editor', parishIds: [], bootstrap: false });
  assert.equal(p.can['parish.delete'], false);
  assert.equal(p.can['schedule.edit'], true);
  assert.equal(p.role, 'editor');

  const none = rolePayload({ role: null, parishIds: [], bootstrap: false });
  assert.ok(Object.values(none.can).every(v => v === false), 'no role should have nothing');

  // Every capability any role has is present as a key, so the panel never
  // reads undefined and treats it as permission.
  const owner = rolePayload({ role: 'owner', parishIds: [], bootstrap: true });
  for (const r of ROLES) {
    const pp = rolePayload({ role: r, parishIds: [], bootstrap: false });
    assert.deepEqual(Object.keys(pp.can).sort(), Object.keys(owner.can).sort());
  }
});
