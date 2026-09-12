// Reading recurrence rules out of a parish's published service times.
//
// Every line quoted here is one the Antiochian directory actually publishes,
// including the awkward ones: a time with no meridiem, a parenthesis that names
// a service rather than a language, two simultaneous liturgies distinguished
// only by the words "in the hall", a Vespers held at another town's address,
// and a service with no time at all.

import test from 'node:test';
import assert from 'node:assert';
import {
  dayOfHeading, parseTime, parseLanguages, parseWeekOfMonth, eventTypeFor,
  parseServiceLine, rulesForParish, planWrite, buildScheduleSql,
} from './antiochian-schedules.mjs';

test('a day heading is recognised singular or plural', () => {
  assert.equal(dayOfHeading('Sundays'), 0);
  assert.equal(dayOfHeading('Sunday'), 0);
  assert.equal(dayOfHeading('Wednesday'), 3);
  assert.equal(dayOfHeading('Wednesdays'), 3);
  assert.equal(dayOfHeading('Saturdays'), 6);
  // Not days, though they sit among them on the page.
  assert.equal(dayOfHeading('Sunday School'), null);
  assert.equal(dayOfHeading('Languages'), null);
  assert.equal(dayOfHeading('Patron Feast Day'), null);
});

test('every time format the directory uses', () => {
  assert.equal(parseTime('9:00AM- Matins'), '09:00');
  assert.equal(parseTime('09:30AM- Liturgy'), '09:30');
  assert.equal(parseTime('6:00 PM- Liturgy'), '18:00');
  assert.equal(parseTime('11:00 AM- Liturgy'), '11:00');
  assert.equal(parseTime('07:00PM- Liturgy'), '19:00');
  assert.equal(parseTime('3:30PM- Vespers'), '15:30');
  // One line gives no meridiem at all; 24-hour is the only reading that does
  // not invent one, and it is the right one here.
  assert.equal(parseTime('09:30 – Liturgy (English)'), '09:30');
  assert.equal(parseTime('Morning'), null);
  assert.equal(parseTime('Compline Service, spiritual talk'), null);
});

test('midnight and noon do not wrap', () => {
  assert.equal(parseTime('12:00AM- Vigil'), '00:00');
  assert.equal(parseTime('12:30PM- Liturgy'), '12:30');
});

test('a parenthesis is languages only when it names languages', () => {
  assert.deepEqual(parseLanguages('Arabic'), ['Arabic']);
  assert.deepEqual(parseLanguages('Arabic and English'), ['Arabic', 'English']);
  assert.deepEqual(parseLanguages('English & Arabic'), ['English', 'Arabic']);
  assert.deepEqual(parseLanguages('English/ Slavonic'), ['English', 'Slavonic']);
  // The qualifier is dropped rather than guessed at — this claims less than the
  // page does, never more.
  assert.deepEqual(parseLanguages('Mostly Arabic'), ['Arabic']);
  // Not a language list: it names the service.
  assert.equal(parseLanguages('Paraklesis Service'), null);
  assert.equal(parseLanguages('old building'), null);
});

test('"Bi-Lingual" resolves to the parish\'s own declared languages', () => {
  // The same page publishes them under ABOUT, so this reads an answer rather
  // than assuming Antiochian bilingual must mean Arabic and English.
  assert.deepEqual(parseLanguages('Bi-Lingual ', ['Arabic', 'English']), ['Arabic', 'English']);
  assert.equal(parseLanguages('Bi-Lingual', null), null);
});

test('which weeks of the month, in the vocabulary recurrence.mjs uses', () => {
  assert.equal(parseWeekOfMonth('1st Sunday of every month in the hall.'), 'first');
  assert.equal(parseWeekOfMonth('Every 1st Sunday of the month.'), 'first');
  assert.equal(parseWeekOfMonth('1st and 3rd Sunday of the Month.'), 'first,third');
  assert.equal(parseWeekOfMonth('Liturgy (English)'), null);
});

test('a pattern week_of_month cannot express is refused, not widened', () => {
  // Widening "every 2nd last Friday" to every Friday would put a service on the
  // map three Fridays a month too often.
  assert.equal(parseWeekOfMonth('Every 2nd last Friday.'), 'unsupported');
});

test('the service type comes from the name', () => {
  assert.equal(eventTypeFor('Liturgy'), 'liturgy');
  assert.equal(eventTypeFor('Matins'), 'prayer');
  assert.equal(eventTypeFor('Vespers'), 'prayer');
  assert.equal(eventTypeFor('Small Compline'), 'prayer');
  assert.equal(eventTypeFor('Paraklesis'), 'prayer');
  assert.equal(eventTypeFor('Sisterhood of Saints Mary and Martha (Paraklesis Service)'), 'prayer');
});

test('a plain service line becomes a rule', () => {
  const r = parseServiceLine('10:00AM- Liturgy (Mostly Arabic)', { day: 0 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.rule, {
    day_of_week: 0, start_time: '10:00', title: 'Liturgy',
    event_type: 'liturgy', languages: ['Arabic'], week_of_month: null,
  });
});

test('the detail that distinguishes two simultaneous liturgies is kept', () => {
  // Punchbowl holds an Arabic liturgy in the church and an English one in the
  // hall, both at 09:30 on first Sundays. The read-path dedup partitions on
  // parish, time and TITLE, so losing "in the hall" would hide one of them.
  const r = parseServiceLine('09:30 – Liturgy (English) –  1st Sunday of every month in the hall.', { day: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.rule.title, 'Liturgy (in the hall)');
  assert.equal(r.rule.week_of_month, 'first');
  assert.deepEqual(r.rule.languages, ['English']);
});

test('a service held at another address keeps the address in its title', () => {
  // St Mary Magdalene serves Pomona and Gympie from Elimbah, and `schedules`
  // has no location column — dropping it would put them at the wrong church.
  const r = parseServiceLine('3:30PM- Vespers (English) @ 23 Hill Street POMONA QLD 4568', { day: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.rule.title, 'Vespers at 23 Hill Street POMONA QLD 4568');
  assert.equal(r.rule.start_time, '15:30');
});

test('a service published without a time is refused, never invented', () => {
  const r = parseServiceLine('Compline Service, spiritual talk and children’s activities.', { day: 5 });
  assert.equal(r.ok, false);
  assert.match(r.why, /no time/);
});

test('layout labels are not services', () => {
  for (const label of ['Morning', 'Evening', 'Evenings', 'Weekly', 'n/a', 'Note :']) {
    assert.equal(parseServiceLine(label, { day: 0 }).ok, false, label);
  }
});

test('services at the same hour are marked concurrent', () => {
  const parish = {
    name: 'St. Nicholas, Punchbowl',
    languages: ['Arabic', 'English'],
    sections: {
      Sundays: [
        'Morning',
        '8:30AM- Matins (Arabic)',
        '09:30AM- Liturgy (Mostly Arabic)',
        '09:30 – Liturgy (English) –  1st Sunday of every month in the hall.',
      ].join('\n'),
    },
  };
  const { rules } = rulesForParish(parish);
  assert.equal(rules.length, 3);
  const at930 = rules.filter((r) => r.start_time === '09:30');
  assert.equal(at930.length, 2);
  assert.ok(at930.every((r) => r.concurrent === 1));
  // ...and the 08:30 Matins is alone, so it is not.
  assert.equal(rules.find((r) => r.start_time === '08:30').concurrent, 0);
});

test('a parish that publishes no times yields no rules and no error', () => {
  const { rules, dropped } = rulesForParish({
    name: 'St. George Mission, Auckland',
    sections: { Languages: 'English\nArabic', 'Services on Offer': 'Baptism\nConfession' },
  });
  assert.deepEqual(rules, []);
  assert.deepEqual(dropped, []);
});

test('an existing rule at the same slot is updated, not duplicated', () => {
  // The nine hand-seeded rules are all called "Sunday Divine Liturgy", so
  // matching on title would leave each one in place with the directory's
  // version beside it — two cards for one service.
  const existing = [
    { id: 1, parish_id: 'p', day_of_week: 0, start_time: '10:00', title: 'Sunday Divine Liturgy' },
    { id: 5, parish_id: 'p', day_of_week: 6, start_time: '17:00', title: 'Saturday Vespers' },
  ];
  const rules = [
    { parish_id: 'p', day_of_week: 0, start_time: '10:00', title: 'Liturgy' },
    { parish_id: 'p', day_of_week: 0, start_time: '09:00', title: 'Matins' },
  ];
  const { updates, inserts, untouched } = planWrite(rules, existing);
  assert.deepEqual(updates.map((u) => [u.id, u.title]), [[1, 'Liturgy']]);
  assert.deepEqual(inserts.map((i) => i.title), ['Matins']);
  // A rule the directory does not mention is left alone: a page omitting a
  // service is weak evidence that it has stopped.
  assert.deepEqual(untouched.map((u) => u.id), [5]);
});

test('the SQL updates by id and guards every insert', () => {
  const sql = buildScheduleSql({
    updates: [{
      id: 4, parish_id: 'p', day_of_week: 0, start_time: '09:00', title: 'Matins',
      event_type: 'prayer', languages: ['English'], week_of_month: null, concurrent: 0,
      source_name: 'Antiochian Archdiocese', source_ref: 'https://x/', source_checked_at: '2026-09-12T11:00:00Z',
    }],
    inserts: [{
      parish_id: 'p', day_of_week: 0, start_time: '18:00', title: "St Elias' Liturgy",
      event_type: 'liturgy', languages: null, week_of_month: 'first', concurrent: 1,
      source_name: 'Antiochian Archdiocese', source_ref: 'https://x/', source_checked_at: null,
    }],
  });
  assert.match(sql, /UPDATE schedules SET .*title='Matins'.*WHERE id=4;/);
  assert.match(sql, /source_checked_at='2026-09-12T11:00:00Z'/);
  assert.match(sql, /active=1/);
  // An apostrophe in a title must not end the string literal.
  assert.match(sql, /'St Elias'' Liturgy'/);
  assert.match(sql, /WHERE NOT EXISTS \(SELECT 1 FROM schedules WHERE parish_id='p'/);
  // A rule with no languages writes a bare NULL, not the string "null".
  assert.match(sql, /'liturgy', NULL, 'first'/);
});
