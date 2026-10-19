// "Updated 3 months ago · Antiochian Archdiocese ↗" (public/shared/source-line.js),
// shared by /next and the Worker's lite card.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import L from '../public/shared/source-line.js';

const NOW = Date.parse('2026-10-19T03:00:00Z');

test('how long since we read it, in plain words', () => {
  assert.equal(L.relativeAge('2026-10-19T01:00:00Z', NOW), 'today');
  assert.equal(L.relativeAge('2026-10-18T01:00:00Z', NOW), 'yesterday');
  assert.equal(L.relativeAge('2026-10-12', NOW), '7 days ago');
  assert.equal(L.relativeAge('2026-07-19', NOW), '3 months ago');
  assert.equal(L.relativeAge('2024-10-01', NOW), '2 years ago');
  assert.equal(L.relativeAge('2026-11-01', NOW), 'just now', 'a source dated in the future');
  assert.equal(L.relativeAge(null, NOW), null);
  assert.equal(L.relativeAge('not a date', NOW), null);
});

test('a timetable names whoever changed it last, and a rule with no source says nothing', () => {
  const rules = [
    { source_name: 'Antiochian Archdiocese', source_checked_at: '2026-09-12' },
    { source_name: 'Admin', source_checked_at: '2026-10-15T13:19:36Z' },
    { source_name: null, source_checked_at: '2026-10-18' },
  ];
  assert.equal(L.latestSource(rules).source_name, 'Admin');
  assert.equal(L.latestSource([{ title: 'Liturgy' }]), null);
  assert.equal(L.timetableSourceHTML([{ title: 'Liturgy' }]), '', 'no source, no line');
});

test('the name links only when the ref is a URL or our own sign photo', () => {
  const url = L.sourceLineHTML('Antiochian Archdiocese', 'https://antiochian.org.au/x', '2026-09-12', { now: NOW, cls: 'src-line' });
  assert.match(url, /^<div class="src-line">Updated 1 month ago &middot; <a href="https:\/\/antiochian.org.au\/x" target="_blank" rel="noopener nofollow">Antiochian Archdiocese<span class="source-link-icon"/);
  const sign = L.sourceLineHTML('Church signage', '/posters/sign-1.jpg', null, { now: NOW });
  assert.match(sign, /^<div class="source-line"><a href="\/posters\/sign-1.jpg"/, 'no date, no "Updated", never "unverified"');
  const person = L.sourceLineHTML('Parish Contact', 'Fr John', '2026-10-19', { now: NOW });
  assert.equal(person, '<div class="source-line">Updated today &middot; Parish Contact</div>');
  assert.equal(L.sourceLineHTML('', 'https://x', '2026-10-19'), '');
});

test('what a source says is escaped', () => {
  const html = L.sourceLineHTML('<b>Them</b>', 'javascript:alert(1)', null, { now: NOW });
  assert.equal(html, '<div class="source-line">&lt;b&gt;Them&lt;/b&gt;</div>');
});

test("a parish's details read its info_ columns", () => {
  const p = { info_source_name: 'Parish website', info_source_ref: 'https://example.org', info_checked_at: '2026-10-18' };
  assert.match(L.detailsSourceHTML(p, { now: NOW, cls: 'ps-source' }), /^<div class="ps-source">Updated yesterday &middot; <a href="https:\/\/example.org"/);
  assert.equal(L.detailsSourceHTML({}, { now: NOW }), '');
  assert.equal(L.detailsSourceHTML(null), '');
});
