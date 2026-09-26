// The ladder, and the rulings made against it.
//
// The case behind every assertion here: St Mary Magdalene, Elimbah publishes
// two Vespers on its Antiochian directory page. Neither runs — confirmed by
// telephone — and both rules were deleted in /admin. A re-import recreated
// them, because `planWrite` pairs a scraped rule with an EXISTING row and a
// deleted row is not one.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  slotKey, parseSlot, indexOverrides, mayWriteField, pinnedFields,
  suppressionFor, pinFor, validateOverride, describeOverride,
  publicOverridePayload, readInfoOverrides, PINNABLE_FIELDS, adminEditProvenance,
} from './info-overrides.mjs';

const require = createRequire(import.meta.url);
const { outranks, tierRank, sourceTier, governingTier, SOURCE_TIERS, tierLabel } =
  require('../../public/shared/source-tiers.js');

const ELIMBAH = 'antiochian-stmarymagdalene-elimbah';

const ruling = (over = {}) => ({
  parish_id: ELIMBAH,
  target: 'schedule',
  subject: '0|18:00',
  decision: 'suppress',
  tier: 'admin',
  source_label: 'Vespers',
  note: 'Confirmed by telephone that neither Vespers has run for years.',
  ...over,
});

// ── the ladder ─────────────────────────────────────────────────────────────

test('the ladder runs admin > parish > jurisdiction > search > directory', () => {
  const order = SOURCE_TIERS.map((t) => t.id);
  assert.deepEqual(order, ['admin', 'parish', 'jurisdiction', 'search', 'directory']);
  for (let i = 1; i < order.length; i++) {
    assert.equal(outranks(order[i - 1], order[i]), true, `${order[i - 1]} should beat ${order[i]}`);
    assert.equal(outranks(order[i], order[i - 1]), false, `${order[i]} should not beat ${order[i - 1]}`);
  }
});

test('nothing outranks itself', () => {
  // Two reads of one website disagreeing is not something a rank settles, so
  // the later read does not get to win by being later.
  for (const t of SOURCE_TIERS) assert.equal(outranks(t.id, t.id), false, t.id);
});

test('an absent tier loses to every real one, and beats nothing', () => {
  for (const t of SOURCE_TIERS) {
    assert.equal(outranks(t.id, null), true, `${t.id} should beat unsourced`);
    assert.equal(outranks(null, t.id), false, `unsourced should not beat ${t.id}`);
  }
  assert.equal(outranks(null, null), false);
  assert.equal(tierRank('not-a-tier'), Number.POSITIVE_INFINITY);
});

// ── deriving a tier from a row that predates the table ─────────────────────

test('an import from the jurisdiction’s own host is a jurisdiction read', () => {
  // The real Elimbah row: type 'import', ref on antiochian.org.au. 281 of the
  // 293 rows in production say 'import', which is why the ref has to decide.
  assert.equal(sourceTier({
    info_source_type: 'import',
    info_source_ref: 'https://www.antiochian.org.au/avada_portfolio/st-mary-magdalene-elimbah/',
    website: 'http://www.australianorthodoxchristians.org',
  }, 'https://antiochian.org.au'), 'jurisdiction');
});

test('an import from anywhere else is a third-party directory', () => {
  // The 22 ROCOR rows: the diocese publishes no addresses, so those came from
  // an aggregator. jurisdictions.mjs already says so in prose.
  assert.equal(sourceTier({
    info_source_type: 'import',
    info_source_ref: 'https://orthodoxyinamerica.example/au/x',
  }, 'https://rocor.org.au'), 'directory');
  assert.equal(sourceTier({
    info_source_type: 'import',
    info_source_ref: 'https://www.openstreetmap.org/node/1',
  }, 'https://soc.org.au'), 'directory');
});

test('a row scraped from the parish’s own site is a parish read either way', () => {
  assert.equal(sourceTier({ info_source_type: 'website', info_source_ref: 'https://x.example' }, null), 'parish');
  assert.equal(sourceTier({
    info_source_type: 'import',
    info_source_ref: 'https://stgeorge.example/about',
    website: 'https://www.stgeorge.example/',
  }, 'https://greekorthodox.org.au'), 'parish');
});

test('a person beats everything, and no ref at all is no tier', () => {
  assert.equal(sourceTier({ info_source_type: 'person', info_source_ref: null }, null), 'admin');
  assert.equal(sourceTier({ info_source_type: 'import', info_source_ref: null }, 'https://x.example'), null);
  assert.equal(sourceTier(null, null), null);
});

test('a jurisdiction with no directory cannot have been the source', () => {
  // Romanian and Macedonian have no `directory` in JURISDICTION_SOURCES.
  assert.equal(sourceTier({
    info_source_type: 'import', info_source_ref: 'https://somewhere.example/x',
  }, null), 'directory');
});

// ── slots ──────────────────────────────────────────────────────────────────

test('a slot is a weekday and a local time, and nothing looser', () => {
  assert.equal(slotKey(0, '18:00'), '0|18:00');
  assert.equal(slotKey('6', '23:59'), '6|23:59');
  assert.equal(slotKey(7, '18:00'), null);
  assert.equal(slotKey(-1, '18:00'), null);
  assert.equal(slotKey(0, '9:00'), null, 'an unpadded hour would not match a stored one');
  assert.equal(slotKey(0, '24:00'), null);
  assert.equal(slotKey(0, ''), null);
});

test('parseSlot refuses anything slotKey would not have produced', () => {
  // A half-parsed subject is worse than none: it would index under a key no
  // importer ever asks about, and the suppression would silently never fire.
  assert.deepEqual(parseSlot('0|18:00'), { day_of_week: 0, start_time: '18:00' });
  for (const bad of ['0|09', '0|9:00', '0|24:00', '7|10:00', '0|18:00 ', 'address', '', null]) {
    assert.equal(parseSlot(bad), null, JSON.stringify(bad));
  }
});

test('a round trip through the key is lossless', () => {
  for (let d = 0; d <= 6; d++) {
    for (const t of ['00:00', '09:30', '18:00', '23:59']) {
      assert.deepEqual(parseSlot(slotKey(d, t)), { day_of_week: d, start_time: t });
    }
  }
});

// ── the guards ─────────────────────────────────────────────────────────────

test('a suppression stops the jurisdiction re-run that would recreate the rule', () => {
  const idx = indexOverrides([ruling()]);
  const hit = suppressionFor(idx, ELIMBAH, 0, '18:00', 'jurisdiction');
  assert.ok(hit, 'the Antiochian re-import should be refused');
  assert.match(hit.note, /telephone/);
});

test('a suppression is keyed on the slot, so an upstream rename does not slip past', () => {
  const idx = indexOverrides([ruling({ source_label: 'Vespers' })]);
  // Same slot, the source now calls it something else.
  assert.ok(suppressionFor(idx, ELIMBAH, 0, '18:00', 'jurisdiction'));
  // A genuinely different slot is untouched: the ruling is about one service.
  assert.equal(suppressionFor(idx, ELIMBAH, 0, '17:00', 'jurisdiction'), null);
  assert.equal(suppressionFor(idx, ELIMBAH, 3, '18:00', 'jurisdiction'), null);
  assert.equal(suppressionFor(idx, 'some-other-parish', 0, '18:00', 'jurisdiction'), null);
});

test('a pin is not a suppression and a suppression is not a pin', () => {
  const idx = indexOverrides([
    ruling({ subject: '0|18:00', decision: 'suppress' }),
    ruling({ subject: '0|09:30', decision: 'pin' }),
  ]);
  assert.ok(suppressionFor(idx, ELIMBAH, 0, '18:00', 'jurisdiction'));
  assert.equal(pinFor(idx, ELIMBAH, 0, '18:00', 'jurisdiction'), null);
  assert.ok(pinFor(idx, ELIMBAH, 0, '09:30', 'jurisdiction'));
  assert.equal(suppressionFor(idx, ELIMBAH, 0, '09:30', 'jurisdiction'), null);
});

test('a better source gets through a ruling made on a weaker one', () => {
  // A ruling made on the parish's own website does not bind an admin, who is
  // above it. This is what makes the ladder a ladder rather than a lock.
  const idx = indexOverrides([ruling({ tier: 'parish' })]);
  assert.ok(suppressionFor(idx, ELIMBAH, 0, '18:00', 'jurisdiction'));
  assert.equal(suppressionFor(idx, ELIMBAH, 0, '18:00', 'admin'), null);
});

test('a ruling made on an admin’s decision binds even another admin write', () => {
  // Deliberate. Re-adding a deleted rule should mean lifting the ruling first,
  // so the next person reads a decision that was reversed rather than one that
  // quietly stopped applying.
  const idx = indexOverrides([ruling({ tier: 'admin' })]);
  assert.ok(suppressionFor(idx, ELIMBAH, 0, '18:00', 'admin'));
});

test('no ruling means every import behaves exactly as it did before', () => {
  const idx = indexOverrides([]);
  assert.equal(suppressionFor(idx, ELIMBAH, 0, '18:00', 'directory'), null);
  assert.equal(mayWriteField(idx, ELIMBAH, 'address', 'directory'), true);
  assert.deepEqual(pinnedFields(idx, ELIMBAH, 'directory'), []);
});

test('an address pinned to the parish site survives a jurisdiction re-read', () => {
  // The other half of Elimbah: the directory gives "Coronation Street" with no
  // street number, and the parish's own site has it.
  const idx = indexOverrides([{
    parish_id: ELIMBAH, target: 'field', subject: 'address', decision: 'pin',
    tier: 'parish', note: 'The directory omits the street number.',
  }]);
  assert.equal(mayWriteField(idx, ELIMBAH, 'address', 'jurisdiction'), false);
  assert.equal(mayWriteField(idx, ELIMBAH, 'address', 'directory'), false);
  assert.equal(mayWriteField(idx, ELIMBAH, 'address', 'parish'), false, 'same tier does not win');
  assert.equal(mayWriteField(idx, ELIMBAH, 'address', 'admin'), true);
  assert.equal(mayWriteField(idx, ELIMBAH, 'phone', 'jurisdiction'), true, 'one field, not the row');
});

test('pinnedFields names what a given source must leave alone', () => {
  const idx = indexOverrides([
    { parish_id: ELIMBAH, target: 'field', subject: 'address', decision: 'pin', tier: 'parish', note: 'n' },
    { parish_id: ELIMBAH, target: 'field', subject: 'phone', decision: 'pin', tier: 'directory', note: 'n' },
  ]);
  assert.deepEqual(pinnedFields(idx, ELIMBAH, 'jurisdiction').map((f) => f.field), ['address'],
    'a jurisdiction read outranks a directory pin but not a parish one');
  assert.deepEqual(pinnedFields(idx, ELIMBAH, 'admin').map((f) => f.field), []);
  assert.deepEqual(
    pinnedFields(idx, ELIMBAH, 'directory').map((f) => f.field).sort(), ['address', 'phone']);
});

// ── validation ─────────────────────────────────────────────────────────────

test('a ruling without a reason is refused', () => {
  const r = validateOverride({ ...ruling(), note: '   ' });
  assert.equal(r.ok, false);
  assert.match(r.error, /Say why/);
});

test('a field is pinned, never suppressed', () => {
  const r = validateOverride({ ...ruling(), target: 'field', field: 'address', decision: 'suppress' });
  assert.equal(r.ok, false);
  assert.match(r.error, /pinned, never suppressed/);
});

test('only a field an import actually writes can be pinned', () => {
  assert.equal(validateOverride({ ...ruling(), target: 'field', field: 'address', decision: 'pin' }).ok, true);
  for (const f of ['id', 'jurisdiction', 'info_source_ref', 'color', '']) {
    const r = validateOverride({ ...ruling(), target: 'field', field: f, decision: 'pin' });
    assert.equal(r.ok, false, `${f} should not be pinnable`);
  }
  assert.ok(!PINNABLE_FIELDS.includes('info_checked_at'),
    'pinning provenance would let a pin argue with its own source line');
});

test('a made-up tier is refused rather than sorted to the bottom', () => {
  // Storing one would make every comparison against it come out "loses", so a
  // ruling nobody could see would silently protect nothing.
  const r = validateOverride({ ...ruling(), tier: 'vibes' });
  assert.equal(r.ok, false);
  assert.match(r.error, /where the better information came from/);
});

test('a schedule ruling takes a weekday and a time, or a subject already shaped', () => {
  const a = validateOverride({ ...ruling(), subject: undefined, day_of_week: 0, start_time: '18:00' });
  assert.equal(a.ok, true);
  assert.equal(a.row.subject, '0|18:00');
  const b = validateOverride(ruling());
  assert.equal(b.row.subject, '0|18:00');
  assert.equal(validateOverride({ ...ruling(), subject: 'sunday evening' }).ok, false);
  assert.equal(validateOverride({ ...ruling(), subject: undefined, day_of_week: 9, start_time: '18:00' }).ok, false);
});

test('blank optional fields become null rather than empty strings', () => {
  // An empty source_ref rendered as a link would be a link to nowhere.
  const r = validateOverride({ ...ruling(), source_ref: '   ', source_name: '', checked_at: '' });
  assert.equal(r.row.source_ref, null);
  assert.equal(r.row.source_name, null);
  assert.equal(r.row.checked_at, null);
});

test('a ruling about a parish that is not there is refused', () => {
  assert.equal(validateOverride(ruling(), { parishExists: false }).ok, false);
});

// ── how it reads ───────────────────────────────────────────────────────────

test('a suppression explains itself in one line, to somebody who did not make it', () => {
  const line = describeOverride({ ...ruling(), source_label: 'Vespers' });
  assert.match(line, /Sunday 18:00/);
  assert.match(line, /Vespers/);
  assert.match(line, /does not run/);
});

test('a ruling with no quoted title still reads as a sentence', () => {
  const line = describeOverride({ ...ruling(), source_label: null });
  assert.ok(!line.includes('null'), line);
  assert.ok(!line.includes('undefined'), line);
  assert.match(line, /a service/);
});

test('every tier has a label, and an unknown one does not render as itself', () => {
  for (const t of SOURCE_TIERS) assert.ok(tierLabel(t.id).length > 3, t.id);
  assert.equal(tierLabel('nope'), 'Unsourced');
});

// ── what leaves the Worker ─────────────────────────────────────────────────

test('the public payload carries the reason and not the admin’s address', () => {
  // /api/info-overrides has no authentication — the import scripts run from a
  // terminal with no Cloudflare credential and must see the same rulings.
  const rows = [{ ...ruling(), id: 3, updated_by: 'someone@example.com', created_at: 'x' }];
  const out = publicOverridePayload(rows);
  assert.equal(out.length, 1);
  assert.equal('updated_by' in out[0], false);
  assert.equal('id' in out[0], false);
  assert.match(out[0].note, /telephone/);
  assert.equal(out[0].subject, '0|18:00');
  assert.equal(JSON.stringify(out).includes('example.com'), false);
});

test('the public payload survives being handed straight back to the guards', () => {
  // The importers index exactly what the endpoint returns, so a field dropped
  // on the way out is a suppression that stops working in the place it matters.
  const idx = indexOverrides(publicOverridePayload([{ ...ruling(), id: 1, updated_by: 'a@b.c' }]));
  assert.ok(suppressionFor(idx, ELIMBAH, 0, '18:00', 'jurisdiction'));
});

// ── the deploy window ──────────────────────────────────────────────────────

test('a missing table reads as no rulings, and nothing else does', async () => {
  // The Worker may deploy before d1/migrations/010 is applied. A database
  // without the table cannot hold a ruling, so [] is the truth there. Any
  // other failure is the opposite fact — the database is unreachable — and an
  // importer that read it as "nothing has been ruled" would recreate every
  // service somebody deleted.
  const missing = { prepare: () => ({ all: async () => { throw new Error('D1_ERROR: no such table: info_overrides'); } }) };
  assert.deepEqual(await readInfoOverrides(missing), []);

  const broken = { prepare: () => ({ all: async () => { throw new Error('D1_ERROR: network'); } }) };
  await assert.rejects(() => readInfoOverrides(broken), /network/);
});

// ── governingTier: a parish with a website speaks for itself ───────────────

test('a parish with a website is governed at the parish tier, whatever filled the row', () => {
  const dir = 'https://greekorthodox.org.au';
  const row = { info_source_type: 'import', info_source_ref: 'https://greekorthodox.org.au/churches/x/' };
  assert.equal(sourceTier(row, dir), 'jurisdiction', 'provenance stays honest');
  assert.equal(governingTier(row, dir), 'jurisdiction');
  assert.equal(governingTier({ ...row, website: 'https://facebook.com/ArchMichaelGOC' }, dir), 'parish');
  assert.equal(governingTier({ ...row, website: '   ' }, dir), 'jurisdiction', 'a blank website is no website');
  // Never lower than where the row came from: a person's row stays theirs.
  assert.equal(governingTier({ info_source_type: 'person', website: 'https://x.example' }, dir), 'admin');
  assert.equal(governingTier(null, dir), null);
});

// ── adminEditProvenance: an edit in /admin says who says so ────────────────

const STORED = {
  phone: '(02) 9436 1957', website: null, address: '49-59 Holterman St', lat: -33.8, lng: 151.2,
  color: '#0061fe',
  info_source_type: 'import', info_source_name: 'Greek Orthodox Archdiocese of Australia',
  info_source_ref: 'https://greekorthodox.org.au/churches/st-michael/',
  info_checked_at: '2026-09-15T15:02:20.591Z',
};
const NOW = '2026-09-24T05:00:00Z';

test('changing a detail makes the source the editor, checked now, and pins the field', () => {
  const r = adminEditProvenance(STORED, { phone: '0404 172 171' }, { now: NOW, sourceName: 'Parish Contact' });
  assert.deepEqual(r.changed, ['phone']);
  assert.deepEqual(r.sets, {
    info_source_type: 'person', info_source_name: 'Parish Contact', info_source_ref: null,
    info_checked_at: NOW,
  });
  assert.deepEqual(r.pinFields, ['phone']);
  assert.equal(sourceTier({ ...STORED, ...r.sets }, null), 'admin');
});

test('a form that posts every field counts only what changed', () => {
  // The in-app sheet and /admin both post the whole form, source fields
  // included, and /admin posts the checked date back as a bare day.
  const body = { ...STORED, phone: '(02) 9436 1957 ', info_checked_at: '2026-09-15' };
  const r = adminEditProvenance(STORED, body, { now: NOW });
  assert.deepEqual(r.changed, []);
  assert.deepEqual(r.pinFields, []);
  assert.equal(r.sets.info_checked_at, STORED.info_checked_at,
    'an untouched day must not round the stored timestamp down to midnight');
  assert.equal(r.sets.info_source_type, undefined);
});

test('a colour change says nothing about the details', () => {
  const r = adminEditProvenance(STORED, { color: '#ff0000' }, { now: NOW });
  assert.deepEqual(r.sets, {});
});

test('a source the admin set in the same save stands, and so does a day they picked', () => {
  const r = adminEditProvenance(STORED, {
    phone: '0404 172 171', info_source_type: 'website', info_source_name: 'Parish bulletin',
    info_source_ref: 'https://facebook.com/ArchMichaelGOC', info_checked_at: '2026-09-20',
  }, { now: NOW });
  assert.equal(r.sets.info_source_type, undefined);
  assert.equal(r.sets.info_checked_at, '2026-09-20');
  assert.deepEqual(r.pinFields, ['phone']);
});

test('editing only the source still stamps the check', () => {
  const r = adminEditProvenance(STORED, { info_source_name: 'Parish bulletin' }, { now: NOW });
  assert.deepEqual(r.sets, { info_checked_at: NOW });
  assert.deepEqual(r.pinFields, []);
});

test('an address pins its coordinates; coordinates alone pin nothing', () => {
  const addr = adminEditProvenance(STORED, { address: '49-59 Holtermann St' }, { now: NOW });
  assert.deepEqual(addr.pinFields, ['address', 'lat', 'lng']);
  const dot = adminEditProvenance(STORED, { lat: -33.81, lng: 151.21 }, { now: NOW });
  assert.equal(dot.sets.info_source_name, 'Admin', 'moving the dot is still an edit, recorded as Admin by default');
  assert.deepEqual(dot.pinFields, [], 'a re-located dot is the geocoder again, not a checked fact');
  assert.equal(adminEditProvenance(STORED, { lat: '-33.8', lng: 151.2 }, { now: NOW }).changed.length, 0,
    'the same coordinates as a string are not a change');
});

test('a field the caller pins itself is left to the caller', () => {
  const r = adminEditProvenance(STORED, { phone: '1' }, { now: NOW, explicitPins: ['phone'] });
  assert.deepEqual(r.pinFields, []);
});

test('an edit is recorded as Admin, or as Parish Contact for a parish contact', async () => {
  const { adminSourceName } = await import('./info-overrides.mjs');
  assert.equal(adminSourceName('owner'), 'Admin');
  assert.equal(adminSourceName('editor'), 'Admin');
  assert.equal(adminSourceName('parish'), 'Parish Contact');
});
