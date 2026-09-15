// Reading recurrence rules out of what a Greek parish publishes in prose.
//
// Every sentence quoted here is one an Australian Greek parish actually
// publishes on its own site, including the awkward ones: a span whose first
// half carries no meridiem, a monthly English liturgy, a service that alternates
// between two churches, a confession availability dressed as a timetable, and a
// parish whose own two pages give the same service two different hours.

import test from 'node:test';
import assert from 'node:assert';
import {
  daysIn, parseTime, parseRange, parseWeekOfMonth, parseLanguages, eventTypeFor,
  ruleFromSentence, planWrite, markConcurrent, buildScheduleSql, buildWebsiteSql,
} from './greek-schedules.mjs';
import { SERVICE_TIMES } from './greek-service-times.mjs';
import { normaliseUrl, sameSite, directoryFields, directoryWebsite } from './greek-directory.mjs';
import { scoreLink, pageText, timetableScore, candidatePages } from './greek-crawl.mjs';

test('a weekday is found however the sentence names it', () => {
  assert.deepEqual(daysIn('Matins and Liturgy take place every Sunday morning'), [0]);
  assert.deepEqual(daysIn('Vespers take place every Saturday at 3pm'), [6]);
  assert.deepEqual(daysIn('Every Tuesday and Sunday our Parish conducts these services'), [0, 2]);
  assert.deepEqual(daysIn('English liturgies are served every Friday at 6pm'), [5]);
  assert.deepEqual(daysIn('Sundays 8 am - 9 am'), [0]);
  // No weekday at all.
  assert.deepEqual(daysIn('All weekday liturgies start at 6:30am'), []);
  assert.deepEqual(daysIn('Please contact the church office'), []);
});

test('"Sunday School" names a day and is still not a Sunday service', () => {
  // daysIn is deliberately dumb — it finds the word. Refusing this sentence is
  // the curator's job, which is why the times file quotes sentences rather than
  // letting the parser loose on a page.
  assert.deepEqual(daysIn('Sunday School'), [0]);
  assert.equal(ruleFromSentence('Sunday School', { title: 'Sunday School' }).ok, false);
});

test('every time format these sites use', () => {
  assert.equal(parseTime('starting at 7:30am'), '07:30');
  assert.equal(parseTime('7.30am - 10.30am'), '07:30');
  assert.equal(parseTime('commence at 8:30am'), '08:30');
  assert.equal(parseTime('every Friday at 6pm'), '18:00');
  assert.equal(parseTime('Vespers take place every Saturday at 3pm'), '15:00');
  assert.equal(parseTime('The Liturgy begins at 9:00am.'), '09:00');
  // In "8-9 am" the 8 carries no meridiem of its own, so it is not a time
  // parseTime can read on its own and it returns the 9 that is. Reading the
  // span is parseRange's job, and it gets 08:00 — which is why nothing in this
  // file calls parseTime on a span.
  assert.equal(parseTime('Matins 8-9 am'), '09:00');
  assert.equal(parseRange('Matins 8-9 am').start, '08:00');
  assert.equal(parseTime('12:00 pm'), '12:00');
  assert.equal(parseTime('12:00 am'), '00:00');
  assert.equal(parseTime('19:00'), '19:00');
  // Greek meridiems, which three of these parishes use.
  assert.equal(parseTime('7:30 π.μ.'), '07:30');
  assert.equal(parseTime('6:00 μ.μ.'), '18:00');
  // Not times.
  assert.equal(parseTime('Please contact the church office'), null);
  assert.equal(parseTime('services from 9'), null, 'a bare number is not a time');
  assert.equal(parseTime('99:99'), null);
});

test('a span gives a start and an end, and lends its meridiem leftwards', () => {
  assert.deepEqual(parseRange('from 7:30am-10:30am'), { start: '07:30', end: '10:30' });
  assert.deepEqual(parseRange('7.30am - 10.30am'), { start: '07:30', end: '10:30' });
  assert.deepEqual(parseRange('Divine Liturgy 9-10.30 am'), { start: '09:00', end: '10:30' });
  // The one that catches a naive parser: "8-9 am" must not read 8 as 20:00.
  assert.deepEqual(parseRange('Matins 8-9 am'), { start: '08:00', end: '09:00' });
  assert.deepEqual(parseRange('Matins and Divine Liturgy, 7:30 – 11:15 am'), { start: '07:30', end: '11:15' });
  // A single time has no end rather than an end equal to its start.
  assert.deepEqual(parseRange('every Saturday at 3pm'), { start: '15:00', end: null });
});

test('an inexpressible recurrence is refused BEFORE anything else is read', () => {
  // week_of_month NULL means EVERY week, so a pattern the column cannot spell
  // has to refuse rather than fall through to null. Coburg's Compline runs on
  // Tuesdays but at a church that alternates, so "every Tuesday" is false half
  // the time.
  assert.equal(parseWeekOfMonth('held weekly on Tuesdays at 7pm. The location alternates between the Parishes'), 'unsupported');
  assert.equal(parseWeekOfMonth('takes place every second week at St Vasilios'), 'unsupported');
  assert.equal(parseWeekOfMonth('a fortnightly Vespers'), 'unsupported');
  assert.equal(parseWeekOfMonth('every 2nd last Friday'), 'unsupported');
  // Expressible.
  assert.equal(parseWeekOfMonth('the last Saturday morning of every month'), 'last');
  assert.equal(parseWeekOfMonth('1st and 3rd Sunday of the month'), 'first,third');
  assert.equal(parseWeekOfMonth('the first Sunday of each month'), 'first');
  // Says nothing about weeks: every matching weekday.
  assert.equal(parseWeekOfMonth('Vespers take place every Saturday at 3pm'), null);
});

test('the service vocabulary maps onto schedules.event_type', () => {
  assert.equal(eventTypeFor('Matins & Divine Liturgy'), 'liturgy');
  assert.equal(eventTypeFor('Divine Liturgy'), 'liturgy');
  assert.equal(eventTypeFor('Matins'), 'prayer');
  assert.equal(eventTypeFor('Vespers'), 'prayer');
  assert.equal(eventTypeFor('Midnight Service'), 'prayer');
  assert.equal(eventTypeFor('Paraklesis'), 'prayer');
  assert.equal(eventTypeFor('Catechism Classes'), 'talk');
  assert.equal(eventTypeFor('Parish BBQ'), 'other');
  // "Matins and Divine Liturgy" is one block that IS the liturgy — the liturgy
  // test has to win over the matins test, or the commonest rule in the run is
  // typed as an office.
  assert.equal(eventTypeFor('Matins and Divine Liturgy'), 'liturgy');
});

test('languages are read only from the words that name one', () => {
  assert.deepEqual(parseLanguages('English liturgies are served every Friday at 6pm'), ['English']);
  assert.deepEqual(parseLanguages('Divine Liturgy in English on the last Saturday'), ['English']);
  assert.equal(parseLanguages('Matins and Divine Liturgy 7:30am'), null);
});

test('a sentence becomes one rule per weekday it names', () => {
  const res = ruleFromSentence(
    'Every Tuesday and Sunday our Parish conducts these services commencing at 6:30am with the Midnight Service',
    { title: 'Midnight Service' },
  );
  assert.equal(res.ok, true);
  assert.equal(res.rules.length, 2);
  assert.deepEqual(res.rules.map((r) => r.day_of_week), [0, 2]);
  assert.equal(res.rules[0].start_time, '06:30');
  assert.equal(res.rules[0].event_type, 'prayer');
});

test('a monthly English liturgy keeps both its week and its language', () => {
  const res = ruleFromSentence(
    'St Sophia has implemented a new initiative to perform the Divine Liturgy in English on the last Saturday morning of every month. The Liturgy begins at 9:00am.',
    { title: 'Divine Liturgy in English' },
  );
  assert.equal(res.ok, true);
  assert.equal(res.rules.length, 1);
  assert.equal(res.rules[0].day_of_week, 6);
  assert.equal(res.rules[0].start_time, '09:00');
  assert.equal(res.rules[0].week_of_month, 'last');
  assert.deepEqual(res.rules[0].languages, ['English']);
  assert.equal(res.rules[0].event_type, 'liturgy');
});

test('the things that look like a timetable and are not', () => {
  const no = (s, t) => ruleFromSentence(s, { title: t || 'X' });
  assert.equal(no('Administration Office Hours: Monday–Friday: 9:00 am–4:00 pm').why, 'opening hours, not a service');
  assert.equal(no('CHURCH OPENING HOURS Monday - Friday 10am - 12noon').why, 'opening hours, not a service');
  assert.match(
    no('Fr Nikolaos is available at the Church every Monday to Friday between 4.00 - 6.00pm for Holy Confession').why,
    /availability/,
  );
  assert.match(no('Confession can be arranged by appointment').why, /appointment/);
  assert.match(no('services most feast days and Weekends from 9:00am').why, /"most"/);
  // Named a day, gave no hour: never invented.
  assert.equal(no('Sunday: Matins and Divine Liturgy, Greek language').why, 'no time published');
  // Gave an hour, named no day.
  assert.equal(no('All weekday liturgies start at 6:30am').why, 'no weekday named');
});

test('a rule is never widened when the pattern cannot be spelled', () => {
  const res = ruleFromSentence(
    'The service of the Small Compline is held weekly on Tuesdays at 7pm in English. '
    + 'The location alternates between the Parishes of St Basil’s (Brunswick) and The Presentation of Our Lord (Coburg).',
    { title: 'Small Compline' },
  );
  assert.equal(res.ok, false);
  assert.match(res.why, /week_of_month cannot express/);
});

// ── the curated file ───────────────────────────────────────────────────────

test('every curated entry parses to exactly the rule it claims', () => {
  assert.ok(SERVICE_TIMES.length > 0);
  for (const entry of SERVICE_TIMES) {
    const res = ruleFromSentence(entry.quote, {
      title: entry.title,
      days: entry.days,
      languages: entry.languages,
      weekOfMonth: entry.week_of_month,
    });
    assert.equal(res.ok, true, `${entry.parish_id} — ${entry.title}: ${res.why}`);
    assert.deepEqual(
      res.rules.map((r) => r.day_of_week),
      entry.days,
      `${entry.parish_id} — ${entry.title}: days`,
    );
    assert.equal(res.rules[0].start_time, entry.start_time, `${entry.parish_id} — ${entry.title}: start`);
    assert.equal(res.rules[0].end_time, entry.end_time ?? null, `${entry.parish_id} — ${entry.title}: end`);
    assert.equal(res.rules[0].event_type, entry.event_type, `${entry.parish_id} — ${entry.title}: type`);
  }
});

test('every curated entry cites a page, not a parish homepage guess', () => {
  for (const e of SERVICE_TIMES) {
    assert.match(e.source_ref, /^https?:\/\//, `${e.parish_id} has no source_ref`);
    assert.ok(e.quote.length > 12, `${e.parish_id} quote is too short to check`);
  }
});

// ── directory reading ──────────────────────────────────────────────────────

test('the directory list is read label by label', () => {
  const html = `<ul class="church-informations list-style-none">
    <li><span class='information-label'>Address</span>Cnr Isabel &amp; Cecilia Sts, Belmore, NSW 2192</li>
    <li><span class='information-label'>Phone</span>(02) 9789 1659</li>
    <li><span class='information-label'>Website</span>
        https://www.allsaints.com.au    </li>
    <li><span class='information-label'>Parish Priest</span>Rev Fr. Dimitrios Papaoikonomou</li>
    <li><span class='information-label'>Mobile</span>0481 813 330</li>
    <li><span class='information-label'>Mobile</span>0421 776 471</li>
  </ul>`;
  const f = directoryFields(html);
  assert.equal(f.get('address'), 'Cnr Isabel & Cecilia Sts, Belmore, NSW 2192');
  assert.equal(directoryWebsite(html), 'https://www.allsaints.com.au');
  // Repeated labels belong to successive clergy; the first is the parish's.
  assert.equal(f.get('mobile'), '0481 813 330');
});

test('a page with no Website row yields no website, not an empty string', () => {
  const html = `<ul><li><span class='information-label'>Address</span>6-12 East Terrace Bankstown</li></ul>`;
  assert.equal(directoryWebsite(html), null);
});

test('urls are normalised before they are compared', () => {
  assert.equal(normaliseUrl('https://www.allsaints.com.au/'), 'https://www.allsaints.com.au');
  assert.equal(normaliseUrl('allsaints.com.au'), 'https://allsaints.com.au');
  assert.equal(normaliseUrl('  http://stvasiliosbrunswick.com  '), 'http://stvasiliosbrunswick.com');
  assert.equal(normaliseUrl('N/A'), null);
  assert.equal(normaliseUrl('contact the office'), null);
  assert.equal(normaliseUrl(''), null);
  // Same place, four spellings — or the run reports a third of the rows moved.
  assert.ok(sameSite('https://www.stspyridon.org.au/', 'http://stspyridon.org.au'));
  assert.ok(!sameSite('https://stnicholas.com.au', 'https://stnicholas.org.au'));
  assert.ok(!sameSite(null, null), 'two missing websites are not the same site');
});

// ── the crawl ──────────────────────────────────────────────────────────────

test('a timetable link outranks a page that merely uses the words', () => {
  assert.ok(scoreLink('/our-programs', 'Our Programs') > 0);
  assert.ok(scoreLink('/church-services', 'Church Services') > scoreLink('/parish-life', 'Parish Life'));
  assert.ok(scoreLink('/programma', 'Πρόγραμμα') > 0);
  // Pages that use the vocabulary and never hold a timetable.
  assert.ok(scoreLink('/services/weddings', 'Wedding Services') <= 0);
  assert.ok(scoreLink('/shop/calendar', 'Buy a Calendar') <= 0);
  assert.equal(scoreLink('/gallery', 'Gallery'), 0);
});

test('a malformed percent-escape does not stop the site being read', () => {
  // One of these hosts emits a stray % in a query string; decodeURIComponent
  // throws on it, which killed a whole crawl once.
  assert.doesNotThrow(() => scoreLink('/services?x=%zz', 'Services'));
  assert.ok(scoreLink('/services?x=%zz', 'Services') > 0);
});

test('block tags become line breaks and inline tags do not', () => {
  // A time separated from its weekday by a stray newline is a time this run
  // cannot use, so the distinction decides whether a rule is found at all.
  const html = '<p>Vespers take place every <strong>Saturday</strong> at <em>3pm</em></p><p>Next</p>';
  assert.equal(pageText(html), 'Vespers take place every Saturday at 3pm\nNext');
  assert.equal(pageText('<div>Sunday<br>7:30am</div>'), 'Sunday\n7:30am');
  assert.equal(pageText('<script>var a="<p>x</p>";</script><p>Real</p>'), 'Real');
  assert.equal(pageText('<p>Caf&eacute;&nbsp;&amp; hall</p>'), 'Café & hall');
  // A numeric entity decodes to the character it names — an en dash stays an en
  // dash rather than being flattened to a hyphen, so a sentence quoted into
  // greek-service-times.mjs matches the page it was copied from. parseRange
  // reads all three dashes, so nothing downstream cares which one it is.
  assert.equal(pageText('<p>7:30&#8211;11 am</p>'), '7:30–11 am');
  assert.equal(parseRange('7:30–11 am').start, '07:30');
});

test('timetable score counts weekday-and-time over a two-line window', () => {
  assert.ok(timetableScore('Sunday Services\nMatins and Liturgy every Sunday from 7:30am') > 0);
  assert.equal(timetableScore('Welcome to our parish\nWe are a community of faith'), 0);
});

test('candidate pages stay on the parish\'s own site', () => {
  const html = '<a href="/services">Services</a>'
    + '<a href="https://facebook.com/x/services">Services on Facebook</a>'
    + '<a href="/shop/calendar">Calendar</a>';
  const got = candidatePages(html, 'https://example.org');
  assert.deepEqual(got.map((c) => c.url), ['https://example.org/services']);
});

// ── writing ────────────────────────────────────────────────────────────────

test('a re-run updates the row it already wrote instead of duplicating it', () => {
  const rules = [{ parish_id: 'greek-x', day_of_week: 0, start_time: '07:30', title: 'Matins & Divine Liturgy' }];
  // Matched on parish+day+time, never title: /admin renames happen.
  const existing = [{ id: 7, parish_id: 'greek-x', day_of_week: 0, start_time: '07:30', title: 'Sunday Divine Liturgy' }];
  const { updates, inserts, untouched } = planWrite(rules, existing);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].id, 7);
  assert.equal(inserts.length, 0);
  assert.equal(untouched.length, 0);
});

test('a rule the parish does not mention is left alone, not deleted', () => {
  const existing = [{ id: 9, parish_id: 'greek-x', day_of_week: 6, start_time: '18:00', title: 'Vespers' }];
  const { inserts, untouched } = planWrite([], existing);
  assert.equal(inserts.length, 0);
  assert.deepEqual(untouched.map((e) => e.id), [9]);
});

test('simultaneous services are marked concurrent so the dedup cannot eat one', () => {
  const rules = markConcurrent([
    { parish_id: 'p', day_of_week: 0, start_time: '09:00', title: 'Liturgy (Greek)' },
    { parish_id: 'p', day_of_week: 0, start_time: '09:00', title: 'Liturgy (English)' },
    { parish_id: 'p', day_of_week: 6, start_time: '18:00', title: 'Vespers' },
  ]);
  assert.deepEqual(rules.map((r) => r.concurrent), [1, 1, 0]);
});

test('an insert is guarded so re-running writes nothing twice', () => {
  const sql = buildScheduleSql({
    updates: [],
    inserts: [{
      parish_id: 'greek-x', day_of_week: 0, start_time: '07:30', end_time: '10:30',
      title: "Matins & Divine Liturgy", event_type: 'liturgy', languages: ['Greek', 'English'],
      week_of_month: null, concurrent: 0, source_name: 'Parish website',
      source_ref: 'https://example.org/services', source_checked_at: '2026-09-15T00:00:00Z',
    }],
  });
  assert.match(sql, /INSERT INTO schedules/);
  assert.match(sql, /WHERE NOT EXISTS/);
  assert.match(sql, /'\["Greek", "English"\]'/);
  assert.match(sql, /'10:30'/);
  assert.ok(!sql.includes('NULL,NULL'));
});

test('a quote mark in a title cannot break out of the statement', () => {
  const sql = buildScheduleSql({
    updates: [],
    inserts: [{
      parish_id: "greek-x", day_of_week: 0, start_time: '09:00', end_time: null,
      title: "St John's Liturgy", event_type: 'liturgy', languages: null,
      week_of_month: null, concurrent: 0, source_name: 'Parish website',
      source_ref: 'https://example.org', source_checked_at: '2026-09-15T00:00:00Z',
    }],
  });
  assert.match(sql, /'St John''s Liturgy'/);
});

test('a website correction re-stamps when we looked and nothing else', () => {
  const sql = buildWebsiteSql(
    [{ id: 'greek-steuphemia-bankstown', website: 'https://www.steuphemia.org' }],
    '2026-09-15T00:00:00Z',
  );
  assert.match(sql, /UPDATE parishes SET website='https:\/\/www\.steuphemia\.org'/);
  assert.match(sql, /info_checked_at='2026-09-15T00:00:00Z'/);
  // info_verified_at means a PERSON stood in front of the place. A scrape is
  // not that, and writing it would freeze the row against future correction.
  assert.ok(!sql.includes('info_verified_at'));
  // The address on these rows still came from the Archdiocese directory.
  assert.ok(!sql.includes('info_source_ref'));
  assert.ok(!sql.includes('info_source_name'));
});

test('clearing a dead website writes NULL rather than an empty string', () => {
  const sql = buildWebsiteSql([{ id: 'greek-ladyaxionestin-northcote', website: null }], '2026-09-15T00:00:00Z');
  assert.match(sql, /SET website=NULL/);
});
