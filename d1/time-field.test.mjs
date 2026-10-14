// The time a rule's form takes, typed or picked (public/shared/time-field.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import TF from '../public/shared/time-field.js';

test('a typed time reads the ways people type one', () => {
  const cases = {
    '9': '09:00', '9am': '09:00', '9 AM': '09:00', '9:30': '09:30', '930': '09:30', '0930': '09:30',
    '9.30 pm': '21:30', '9.30p.m.': '21:30', '6:05pm': '18:05', '18:05': '18:05', '12pm': '12:00',
    '12am': '00:00', '12:15 am': '00:15', 'noon': '12:00', 'midnight': '00:00', '23:45': '23:45', '7p': '19:00',
  };
  for (const [typed, want] of Object.entries(cases)) assert.equal(TF.parseTime(typed), want, typed);
});

test('what is not a time is not read as one', () => {
  for (const typed of ['', '  ', '24:00', '13pm', '0am', '9:60', '9:3o', 'evening', '1234567']) {
    assert.equal(TF.parseTime(typed), null, typed);
  }
});

test('a time shows on the twelve-hour clock, and reads back as itself', () => {
  assert.equal(TF.formatTime('09:00'), '9:00 am');
  assert.equal(TF.formatTime('00:30'), '12:30 am');
  assert.equal(TF.formatTime('12:00'), '12:00 pm');
  assert.equal(TF.formatTime('18:45'), '6:45 pm');
  assert.equal(TF.formatTime(''), '');
  for (const s of TF.slots()) assert.equal(TF.parseTime(TF.formatTime(s)), s);
});

test('the list is every quarter-hour, and an odd time scrolls to the one before it', () => {
  const s = TF.slots();
  assert.equal(s.length, 96);
  assert.equal(s[0], '00:00');
  assert.equal(s[37], '09:15');
  assert.equal(s.at(-1), '23:45');
  assert.equal(TF.nearestSlot('18:05'), '18:00');
  assert.equal(TF.nearestSlot('18:15'), '18:15');
  assert.equal(TF.addMinutes('09:30', 60), '10:30');
  assert.equal(TF.addMinutes('23:30', 60), '23:45', 'never past the day');
});
