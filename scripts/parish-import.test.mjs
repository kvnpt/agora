// Minting ids and matching a scrape against rows that already exist.
//
// The fixtures are real: the parishes below are the rows the database actually
// held before the Greek Archdiocese import, and the names are as the two
// directories actually publish them. That matters, because every hazard here
// was found by running the thing and not by imagining it — a suburb the id does
// not contain, a dedication the length cap truncates mid-honorific, and two
// parishes in one suburb sharing a saint.

import test from 'node:test';
import assert from 'node:assert';
import { parishId, reconcile, buildUpsert } from './parish-import.mjs';

// The Antiochian rows as seeded by hand, before any scraping.
const SEEDED = [
  { id: 'antiochian-stelias-wollongong', jurisdiction: 'antiochian', name: 'St Elias, Wollongong', address: 'Wollongong NSW' },
  { id: 'antiochian-stgeorge-redfern', jurisdiction: 'antiochian', name: 'St George Cathedral, Redfern', address: 'Redfern NSW' },
  { id: 'antiochian-stjohnbaptist-croydonpark', jurisdiction: 'antiochian', name: 'St John the Baptist, Croydon Park', address: 'Croydon Park NSW' },
  { id: 'antiochian-stmary-mayshill', jurisdiction: 'antiochian', name: "St Mary's, Mays Hill", address: 'Mays Hill NSW' },
  { id: 'antiochian-stnicholas-bankstown', jurisdiction: 'antiochian', name: 'St Nicholas, Bankstown', address: 'Bankstown NSW' },
  { id: 'antiochian-stnicholas-punchbowl', jurisdiction: 'antiochian', name: 'St Nicholas, Punchbowl', address: 'Punchbowl NSW' },
  { id: 'antiochian-stmichaelgabriel-ryde', jurisdiction: 'antiochian', name: 'Sts Michael & Gabriel, Ryde', address: 'Ryde NSW' },
  { id: 'antiochian-stspeterpaul-doonside', jurisdiction: 'antiochian', name: 'Sts Peter & Paul, Doonside', address: 'Doonside NSW' },
  { id: 'antiochian-good-shepherd-antiochian-church', jurisdiction: 'antiochian', name: 'The Good Shepherd, Clayton', address: 'Clayton VIC' },
];

test('an id keeps the dedication and drops the institution', () => {
  assert.equal(parishId('greek', 'Archdiocesan Church of St Sophia (Holy Wisdom of God)', 'Bowden'),
    'greek-stsophia-bowden');
  assert.equal(parishId('greek', 'Holy Trinity Greek Orthodox Parish of Hobart', 'Hobart'),
    'greek-holytrinity-hobart');
  assert.equal(parishId('greek', 'Cathedral of the Annunciation of our Lady', 'Redfern'),
    'greek-annunciationlady-redfern');
});

test('the length cap never leaves a dangling honorific', () => {
  // "st" here is the start of the NEXT saint, cut off by the cap.
  assert.equal(parishId('greek', 'St Paraskevi, St John The Merciful & St Barbara', 'St Albans'),
    'greek-stparaskevi-stalbans');
  assert.equal(parishId('greek', 'The Resurrection of St Lazarus', 'Bunurong'),
    'greek-resurrection-bunurong');
  assert.equal(parishId('greek', 'St Stylianos, Sts Peter & Paul & St Gregory of Palama', 'Gymea'),
    'greek-ststylianos-gymea');
});

test('a word merely ending in "st" is not an honorific', () => {
  // The first run shipped this bug and it reached production: the trailing
  // honorific was trimmed off the joined STRING, so "baptist" lost its tail and
  // "Nativity of Christ" became nativitychri. Port Adelaide has since been
  // renamed to the id below, so this test is what keeps it that way.
  assert.equal(parishId('antiochian', 'St John the Baptist', 'Croydon Park'),
    'antiochian-stjohnbaptist-croydonpark');
  assert.equal(parishId('greek', 'The Nativity of Christ', 'Port Adelaide'),
    'greek-nativitychrist-portadelaide');
  assert.equal(parishId('greek', 'Greek Orthodox Parish of the Sunshine Coast', 'Buderim'),
    'greek-sunshinecoast-buderim');
});

test('a dedication that is itself a plural saint keeps its name', () => {
  // Nothing was stranded by the cap here, so nothing is trimmed: All Saints is
  // not All.
  assert.equal(parishId('greek', 'All Saints', 'Belmore'), 'greek-allsaints-belmore');
  assert.equal(parishId('greek', 'Sts Peter & Paul', 'Doonside'), 'greek-stspeterpaul-doonside');
});

test('the suburb is what separates ten parishes sharing a saint', () => {
  const ids = ['Wallaroo', 'Darwin', 'Thevenard', 'Bankstown']
    .map((s) => parishId('greek', 'St Nicholas', s));
  assert.equal(new Set(ids).size, 4);
  assert.equal(ids[0], 'greek-stnicholas-wallaroo');
});

test('a parenthetical qualifier does not reach the id', () => {
  assert.equal(parishId('greek', 'St Savvas of Kalymnos (Ukrainian Orthodox Parish)', 'Banksia'),
    'greek-stsavvaskalymnos-banksia');
});

test('reconcile pins a hand-made id that derivation cannot reproduce', () => {
  // The whole reason this module exists. Derivation gives one thing and the
  // database holds quite another; the write has to use the database's.
  const { pinned } = reconcile(
    [{ jurisdiction: 'antiochian', name: 'The Good Shepherd', suburb: 'Clayton' }], SEEDED);

  assert.equal(pinned.length, 1);
  assert.equal(pinned[0].id, 'antiochian-good-shepherd-antiochian-church');
  assert.notEqual(pinned[0].derived_id, pinned[0].id);
});

test('reconcile matches every seeded Antiochian parish, however it was named', () => {
  // As the directory publishes them, which is not how the seed spells them:
  // an apostrophe, an ampersand, a "Cathedral", a leading "The".
  const scraped = [
    { jurisdiction: 'antiochian', name: 'St Elias', suburb: 'Wollongong' },
    { jurisdiction: 'antiochian', name: 'St George', suburb: 'Redfern' },
    { jurisdiction: 'antiochian', name: 'St John the Baptist', suburb: 'Croydon Park' },
    { jurisdiction: 'antiochian', name: "St Mary's", suburb: 'Mays Hill' },
    { jurisdiction: 'antiochian', name: 'St Nicholas', suburb: 'Bankstown' },
    { jurisdiction: 'antiochian', name: 'St Nicholas', suburb: 'Punchbowl' },
    { jurisdiction: 'antiochian', name: 'Sts Michael & Gabriel', suburb: 'Ryde' },
    { jurisdiction: 'antiochian', name: 'Sts Peter and Paul', suburb: 'Doonside' },
    { jurisdiction: 'antiochian', name: 'The Good Shepherd', suburb: 'Clayton' },
  ];
  const { pinned, fresh, ambiguous } = reconcile(scraped, SEEDED);

  assert.equal(fresh.length, 0, 'a fresh row here would be a duplicate parish');
  assert.equal(ambiguous.length, 0);
  assert.deepEqual(pinned.map((p) => p.id).sort(), SEEDED.map((s) => s.id).sort());
});

test('two parishes sharing a saint are told apart by suburb, not guessed at', () => {
  const { pinned } = reconcile(
    [{ jurisdiction: 'antiochian', name: 'St Nicholas', suburb: 'Punchbowl' }], SEEDED);
  assert.equal(pinned[0].id, 'antiochian-stnicholas-punchbowl');
});

test('an acronym id is pinned by content, since nothing derives it', () => {
  // greek-gopssc-buderim is GOPSSC, typed by a person. Derivation gives
  // sunshinecoast and always will; only the content match finds the real row.
  const live = [{ id: 'greek-gopssc-buderim', jurisdiction: 'greek',
                  name: 'Sunshine Coast, Buderim',
                  address: "St Mark's Anglican Church, 7 Main Street, Buderim QLD 4556" }];
  const { pinned } = reconcile(
    [{ jurisdiction: 'greek', name: 'Greek Orthodox Parish of the Sunshine Coast',
       suburb: 'Buderim' }], live);

  assert.equal(pinned.length, 1);
  assert.equal(pinned[0].id, 'greek-gopssc-buderim');
});

test('a parish genuinely new to the database gets a derived id', () => {
  const { pinned, fresh } = reconcile(
    [{ jurisdiction: 'antiochian', name: 'St Nicholas', suburb: 'Geelong' }], SEEDED);
  assert.equal(pinned.length, 0);
  assert.equal(fresh[0].id, 'antiochian-stnicholas-geelong');
});

test('jurisdiction alone never makes a match', () => {
  // A Greek parish in a suburb where an Antiochian one already stands is a
  // different parish, not the same one.
  const { pinned, fresh } = reconcile(
    [{ jurisdiction: 'greek', name: 'St Nicholas', suburb: 'Bankstown' }], SEEDED);
  assert.equal(pinned.length, 0);
  assert.equal(fresh[0].id, 'greek-stnicholas-bankstown');
});

test('an ambiguous match is reported, never resolved', () => {
  const twins = [
    { id: 'x-holycross-a', jurisdiction: 'greek', name: 'Holy Cross, Wollongong', address: 'Wollongong NSW' },
    { id: 'x-holycross-b', jurisdiction: 'greek', name: 'Holy Cross Chapel, Wollongong', address: 'Wollongong NSW' },
  ];
  const { pinned, fresh, ambiguous } = reconcile(
    [{ jurisdiction: 'greek', name: 'Holy Cross', suburb: 'Wollongong' }], twins);

  assert.equal(pinned.length, 0);
  assert.equal(fresh.length, 0, 'guessing here would duplicate a parish');
  assert.deepEqual(ambiguous[0].candidates, ['x-holycross-a', 'x-holycross-b']);
});

const ROW = {
  id: 'greek-stnicholas-darwin', name: 'St Nicholas, Darwin', jurisdiction: 'greek',
  address: '1 Example St, Darwin NT 0800', lat: -12.46, lng: 130.84,
  timezone: 'Australia/Darwin', feast_day: '6th December',
  info_source_type: 'import', info_source_ref: 'https://example.org/',
};

test('the upsert refuses to overwrite a pin somebody has checked', () => {
  const out = buildUpsert([ROW]);
  assert.match(out, /WHERE parishes\.info_verified_at IS NULL;/);
  assert.match(out, /info_verified_at\) VALUES/);
  assert.match(out, /NULL\)/);            // never stamps verification itself
  assert.doesNotMatch(out, /languages=excluded/);  // set by people, not scrapes
});

test('the upsert will not run without the things the schema requires', () => {
  assert.throws(() => buildUpsert([{ ...ROW, id: undefined }]), /explicit id/);
  assert.throws(() => buildUpsert([{ ...ROW, lat: null }]), /NOT NULL/);
  assert.throws(() => buildUpsert([{ ...ROW, timezone: null }]), /never defaulted/);
  assert.throws(() => buildUpsert([ROW, ROW]), /duplicate id/);
});

test('an apostrophe in a parish name cannot break out of the statement', () => {
  const out = buildUpsert([{ ...ROW, name: "The Holy Virgin's Protection, South Yarra" }]);
  assert.match(out, /'The Holy Virgin''s Protection, South Yarra'/);
});

// The Russian directory is the first that lists monasteries, convents and
// sketes, and those words behave exactly like "church" and "cathedral": every
// one of them has it, so it distinguishes none of them. Before they were
// generic, the Marrickville monastery minted the id `russian-monastery-...`.
test('a monastery is named by its dedication, not by being a monastery', () => {
  assert.equal(parishId('russian', 'Orthodox Monastery of the Archangel Michael', 'Marrickville'),
    'russian-archangelmichael-marrickville');
  assert.equal(parishId('russian', 'Our Lady of Kazan Convent', 'Kentlyn'),
    'russian-ladykazan-kentlyn');
  assert.equal(parishId('russian', 'Monastery of the Prophet Elias', 'Monarto South'),
    'russian-prophetelias-monartosouth');
  assert.equal(parishId('russian', 'St. John the Baptist Skete', 'Kentlyn'),
    'russian-stjohnbaptist-kentlyn');
});

test('the cap never reduces a dedication to a bare qualifier', () => {
  // "transfiguration" is 15 characters and will not fit beside "holy", so the
  // cap used to keep the qualifier and throw the dedication away.
  assert.equal(parishId('russian', 'Holy Transfiguration Monastery', 'Bombala'),
    'russian-transfiguration-bombala');
  // ...but a qualifier that shares the name with something that fits stays put:
  // "Holy Trinity" is the dedication, and this id is already in production.
  assert.equal(parishId('greek', 'Holy Trinity Greek Orthodox Parish of Hobart', 'Hobart'),
    'greek-holytrinity-hobart');
  assert.equal(parishId('russian', 'Holy Virgin Protection Cathedral', 'East Brunswick'),
    'russian-holyvirgin-eastbrunswick');
  // "All Saints" is a dedication that is nothing but qualifier and honorific,
  // and the rule must not strip it to nothing.
  assert.equal(parishId('greek', 'All Saints', 'Belmore'), 'greek-allsaints-belmore');
});
