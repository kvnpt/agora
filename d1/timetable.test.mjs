// Which parishes and rules a link means — the one question the app's Schedules
// view and the Worker's timetable page both ask (public/shared/timetable.js).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const T = require('../public/shared/timetable.js');

const redfern = { id: 'sgr', jurisdiction: 'antiochian', address: 'Cnr Walker & Cooper Streets, Redfern NSW 2016', lat: -33.89, lng: 151.2 };
const buderim = { id: 'bud', jurisdiction: 'greek', address: '7 Main Street, Buderim QLD 4556', lat: -26.68, lng: 153.05 };

test('a parish is in scope by jurisdiction, region and the parishes a link names', () => {
  assert.ok(T.parishInScope(redfern, {}));
  assert.ok(T.parishInScope(redfern, { jurisdiction: 'antiochian', location: 'nsw' }));
  assert.ok(!T.parishInScope(redfern, { location: 'qld' }));
  assert.ok(T.parishInScope(buderim, { location: 'queensland' }), 'an alias is a region too');
  assert.ok(!T.parishInScope(buderim, { jurisdiction: 'antiochian' }));
  assert.ok(!T.parishInScope(redfern, { parishIds: new Set(['bud']) }));
  assert.ok(!T.parishInScope({ id: '_unassigned' }, {}));
});

test('a rule answers the service, day, part of the day and language asked for', () => {
  const vespers = { parish_id: 'sgr', day_of_week: 6, start_time: '18:00', title: 'Vespers', event_type: 'prayer' };
  assert.ok(T.ruleMatches(vespers, { service: 'vespers', day: 6, part: 'evening' }));
  assert.ok(!T.ruleMatches(vespers, { part: 'morning' }));
  assert.ok(!T.ruleMatches(vespers, { day: 0 }));
  assert.ok(!T.ruleMatches(vespers, { service: 'liturgy' }));
  // A service by its own tags alone: never its parish's.
  assert.ok(!T.ruleMatches(vespers, { englishOnly: true }), 'no languages anywhere is not English');
  assert.ok(!T.ruleMatches({ ...vespers, parish_languages: '["English"]' }, { englishOnly: true }), 'the parish column is not read');
  assert.ok(!T.ruleMatches(vespers, { englishOnly: true }, { parishOk: true }), 'an untagged service is in no language');
  assert.ok(T.ruleMatches({ ...vespers, languages: '["Greek","English"]' }, { englishOnly: true }));
  assert.ok(!T.ruleMatches({ ...vespers, languages: '["Greek","English"]' }, { englishOnly: true, englishStrict: true }));
  assert.ok(T.ruleMatches({ ...vespers, languages: '["English"]' }, { englishOnly: true, englishStrict: true }));
});

test('only a service carries a language; anything else goes with its parish', () => {
  const talk = { parish_id: 'snb', day_of_week: 3, start_time: '19:15', title: 'Bible Study', event_type: 'talk', languages: '["Arabic"]' };
  const lit = { parish_id: 'snb', day_of_week: 0, start_time: '09:00', title: 'Divine Liturgy', event_type: 'liturgy', languages: '["Greek","English"]' };
  const vespers = { parish_id: 'snb', day_of_week: 6, start_time: '18:00', title: 'Vespers', event_type: 'vespers', languages: '["English"]' };
  assert.ok(T.isService(lit) && T.isService(vespers) && !T.isService(talk));
  assert.deepEqual(T.parishLangsOf([talk, lit, vespers]), ['Greek', 'English'], "a talk's tag is not read");
  assert.equal(T.serviceLangs(talk), null);
  const en = T.langFilterOf({ lang: 'English' });
  const ar = T.langFilterOf({ lang: 'Arabic' });
  assert.ok(T.parishAnswersLang([talk, lit], en));
  assert.ok(!T.parishAnswersLang([talk, lit], ar), 'a tagged talk does not make an Arabic parish');
  assert.ok(T.ruleMatches(talk, { lang: 'English' }, { parishOk: T.parishAnswersLang([talk, lit], en) }));
  assert.ok(!T.ruleMatches(talk, { lang: 'Arabic' }, { parishOk: T.parishAnswersLang([talk, lit], ar) }));
  assert.equal(T.parishLangsOf([]).length, 0, 'no services, no languages');
});

test('weeknights are Monday to Friday evenings; weekends are Saturday and Sunday, all day', () => {
  const rule = (day_of_week, start_time) => ({ parish_id: 'sgr', day_of_week, start_time, title: 'Vespers', event_type: 'prayer' });
  assert.ok(T.ruleMatches(rule(3, '18:00'), { dayGroup: 'weeknights' }));
  assert.ok(!T.ruleMatches(rule(3, '09:00'), { dayGroup: 'weeknights' }), 'a weekday morning is not a weeknight');
  assert.ok(!T.ruleMatches(rule(6, '18:00'), { dayGroup: 'weeknights' }), 'Saturday evening is the weekend');
  assert.ok(T.ruleMatches(rule(6, '18:00'), { dayGroup: 'weekends' }));
  assert.ok(T.ruleMatches(rule(0, '08:30'), { dayGroup: 'weekends' }));
  assert.ok(!T.ruleMatches(rule(5, '19:00'), { dayGroup: 'weekends' }), 'Friday night is a weeknight');
  assert.ok(T.narrowsRules({ dayGroup: 'weekends' }));
});

test('a service, a day, a part of the day or a language asks something of the rules; a place does not', () => {
  for (const f of [{ service: 'bible-study' }, { day: 0 }, { day: 3 }, { part: 'evening' }, { englishOnly: true }]) {
    assert.ok(T.narrowsRules(f), JSON.stringify(f));
  }
  for (const f of [{}, { jurisdiction: 'antiochian' }, { location: 'nsw' }, { parishIds: new Set(['sgr', 'bud']) },
    { service: null, day: null, part: null, englishOnly: false }]) {
    assert.ok(!T.narrowsRules(f), JSON.stringify(f));
  }
});

test('a parish_scoped rule is only in a list that names its one parish', () => {
  const setup = { parish_id: 'sgr', day_of_week: 2, start_time: '19:00', title: 'Setup', parish_scoped: 1 };
  assert.ok(!T.ruleMatches(setup, {}));
  assert.ok(!T.ruleMatches(setup, { parishIds: new Set(['sgr', 'bud']) }));
  assert.ok(T.ruleMatches(setup, { parishIds: new Set(['sgr']) }));
});

test('a languages column reads as an array or as nothing', () => {
  assert.deepEqual(T.langsOf('["Greek","English"]'), ['Greek', 'English']);
  assert.equal(T.langsOf('[]'), null);
  assert.equal(T.langsOf('not json'), null);
  assert.equal(T.langsOf(null), null);
});

test('a monastery is one by its name: monastery, convent, skete', () => {
  const named = (name, full_name) => ({ id: 'x', jurisdiction: 'russian', name, full_name });
  for (const [name, full] of [
    ['Holy Transfiguration Monastery, Gunningrah'], ['Our Lady of Kazan Convent, Kentlyn'],
    ['St. John the Baptist Skete, Kentlyn'], ['Nativity Skete, Inglewood'], ['St George, Yellow Rock', 'Holy Monastery of St. George'],
  ]) assert.ok(T.isMonastery(named(name, full)), name);
  for (const name of ['St George Cathedral, Redfern', 'Monastery Road Parish'.replace('Monastery ', 'Monasterio ')]) {
    assert.ok(!T.isMonastery(named(name)), name);
  }
  assert.ok(T.parishInScope(named('St Sava Monastery, Elaine'), { monasteries: true }));
  assert.ok(!T.parishInScope(redfern, { monasteries: true }));
  assert.ok(T.parishInScope(redfern, { monasteries: false }));
});
