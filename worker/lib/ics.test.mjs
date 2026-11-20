import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeText, foldLine, utcStamp, summaryOf, locationOf, calendarText } from './ics.mjs';

const ORIGIN = 'https://orthodoxy.au';
const SGR = { id: 'sgr-id', name: 'St. George Cathedral, Redfern', address: 'Cnr Walker & Cooper Sts, Redfern 2016 NSW', lat: -33.89, lng: 151.2 };
const SMG = { id: 'smg-id', name: 'Sts. Michael & Gabriel, Ryde', address: '72 Belmore St, Ryde', lat: -33.81, lng: 151.1 };
const parishes = new Map([[SGR.id, SGR], [SMG.id, SMG]]);

const liturgy = {
  id: '20:2026-11-22', parish_id: SGR.id, title: 'Liturgy', feast: null,
  start_utc: '2026-11-21T23:30:00.000Z', end_utc: '2026-11-22T01:00:00.000Z', start_local: '2026-11-22T10:30',
  languages: '["English"]', status: 'approved', is_tombstone: 0, created_at: '2026-09-01T00:00:00Z',
};

/** The calendar's lines unfolded, as a calendar reads them. */
const unfold = (text) => text.replace(/\r\n /g, '').split('\r\n');

test('text values are escaped: commas, semicolons, backslashes and new lines', () => {
  assert.equal(escapeText('Matins, Liturgy; then lunch\\coffee\nAll welcome'), 'Matins\\, Liturgy\\; then lunch\\\\coffee\\nAll welcome');
});

test('a long line folds at 75 octets, never inside a Greek letter', () => {
  const line = `SUMMARY:${'Θεία Λειτουργία '.repeat(8)}`;
  const folded = foldLine(line);
  for (const part of folded.split('\r\n')) assert.ok(new TextEncoder().encode(part).length <= 75, part);
  assert.equal(folded.replace(/\r\n /g, ''), line);
  assert.ok(!folded.includes('�'));
});

test('times are written in UTC', () => {
  assert.equal(utcStamp('2026-11-21T23:30:00.000Z'), '20261121T233000Z');
  assert.equal(utcStamp('nonsense'), null);
});

test('a date of a regular service: its own id as the UID, the parish as where, the card as its link', () => {
  const lines = unfold(calendarText({ name: 'St George, Redfern', events: [liturgy], parishes, origin: ORIGIN }));
  assert.equal(lines[0], 'BEGIN:VCALENDAR');
  assert.ok(lines.includes('X-WR-CALNAME:St George\\, Redfern'));
  assert.ok(lines.includes('REFRESH-INTERVAL;VALUE=DURATION:PT6H'));
  assert.ok(lines.includes('UID:20:2026-11-22@orthodoxy.au'));
  assert.ok(lines.includes('DTSTART:20261121T233000Z'));
  assert.ok(lines.includes('DTEND:20261122T010000Z'));
  assert.ok(lines.includes('SUMMARY:Liturgy'));
  assert.ok(lines.includes('LOCATION:St. George Cathedral\\, Redfern\\, Cnr Walker & Cooper Sts\\, Redfern 2016 NSW'));
  assert.ok(lines.includes('URL:https://orthodoxy.au/20:2026-11-22'));
  assert.ok(lines.some(l => l.startsWith('DESCRIPTION:') && l.includes('In English.') && l.endsWith('https://orthodoxy.au/20:2026-11-22')));
  assert.ok(!lines.some(l => l.startsWith('RRULE')), 'dates are written out, never a repeat rule');
  assert.ok(!lines.some(l => l.startsWith('STATUS:')));
  assert.equal(lines.at(-2), 'END:VCALENDAR');
});

test('lines end in CRLF, as RFC 5545 asks', () => {
  const text = calendarText({ name: 'x', events: [liturgy], parishes, origin: ORIGIN });
  assert.ok(text.endsWith('END:VCALENDAR\r\n'));
  assert.ok(!/[^\r]\n/.test(text));
});

test('the saint goes after a dash', () => {
  assert.equal(summaryOf({ title: 'Great Vespers', feast: 'Archangels Michael and Gabriel' }), 'Great Vespers — Archangels Michael and Gabriel');
});

test('nothing disappears: a cancelled date stays, says so, and takes no time, but is not STATUS:CANCELLED', () => {
  const off = { ...liturgy, status: 'cancelled', is_tombstone: 1 };
  const lines = unfold(calendarText({ name: 'x', events: [off], parishes, origin: ORIGIN }));
  assert.ok(lines.includes('SUMMARY:Cancelled: Liturgy'));
  assert.ok(lines.includes('TRANSP:TRANSPARENT'));
  assert.ok(lines.some(l => l.startsWith('DESCRIPTION:This has been cancelled.')));
  assert.ok(!lines.includes('STATUS:CANCELLED'), 'Google hides those outright');
  assert.equal(summaryOf({ ...liturgy, status: 'combined', is_tombstone: 1 }), 'Combined: Liturgy');
  assert.equal(summaryOf({ ...liturgy, status: 'break', is_tombstone: 1 }), 'On a break: Liturgy');
});

test('where: a place of its own, else another parish, else home', () => {
  assert.equal(locationOf({ ...liturgy, location_override: 'Parish hall, 12 Smith St' }, parishes), 'Parish hall, 12 Smith St');
  assert.equal(locationOf({ ...liturgy, location_parish_id: SMG.id }, parishes), 'Sts. Michael & Gabriel, Ryde, 72 Belmore St, Ryde');
  assert.equal(locationOf(liturgy, parishes), 'St. George Cathedral, Redfern, Cnr Walker & Cooper Sts, Redfern 2016 NSW');
});

test('no end time on file: held for the usual 90 minutes', () => {
  const lines = unfold(calendarText({ name: 'x', events: [{ ...liturgy, end_utc: null }], parishes, origin: ORIGIN }));
  assert.ok(lines.includes('DTEND:20261122T010000Z'));
});

test('one date to open is not a subscription', () => {
  const text = calendarText({ name: null, events: [liturgy], parishes, origin: ORIGIN, feed: false });
  assert.ok(!text.includes('REFRESH-INTERVAL'));
  assert.ok(!text.includes('X-WR-CALNAME'));
});
