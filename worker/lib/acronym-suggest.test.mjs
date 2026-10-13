// Suggesting a parish's acronym: the house style by rule, Claude when there is
// a key, and nothing offered that a save would refuse.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ruleCandidates, suggestAcronym, buildAcronymRequest, acronymContext, ACRONYM_MODEL,
} from './acronym-suggest.mjs';

/** Just enough of D1 for the one query the suggestion makes. */
const dbWith = (rows) => ({
  prepare: () => ({ all: async () => ({ results: rows }) }),
});

/** A Messages API that answers with these candidates, and remembers what it was sent. */
function modelSaying(candidates, { status = 200, stop = 'end_turn' } = {}) {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body), headers: init.headers });
    if (status !== 200) return new Response('{"error":"nope"}', { status });
    return Response.json({
      stop_reason: stop,
      content: [
        { type: 'thinking', thinking: '', signature: 'x' },
        { type: 'text', text: JSON.stringify({ candidates }) },
      ],
    });
  };
  return { fetchImpl, sent };
}

test('the rule is the dedication’s initials, then the suburb’s', () => {
  assert.deepEqual(ruleCandidates('St George Monastery, Yellow Rock', 'Holy Monastery of St George').slice(0, 3),
    ['sgy', 'sgyr', 'sg']);
  assert.equal(ruleCandidates('St George, Redfern')[0], 'sgr');
  assert.equal(ruleCandidates('Sts Peter & Paul, Doonside')[0], 'sppd');
  assert.equal(ruleCandidates("St Mary's Greek Orthodox Church, Mount Pritchard")[0], 'smm');
  // No suburb in the short name: the full name's initials stand alone.
  assert.equal(ruleCandidates('Holy Trinity', '')[0], 'ht');
});

test('without a key the rule decides, and nothing is sent anywhere', async () => {
  const { fetchImpl, sent } = modelSaying(['zzz']);
  const r = await suggestAcronym({ name: 'St George Monastery, Yellow Rock' }, { db: dbWith([]), fetchImpl });
  assert.deepEqual(r, { acronym: 'sgy', source: 'rule', alternatives: ['sgyr', 'sg'] });
  assert.equal(sent.length, 0);
});

test('the model’s first free candidate wins, and the site’s acronyms are its examples', async () => {
  const rows = [
    { id: 'antiochian-stgeorge-redfern', name: 'St George, Redfern', full_name: null, acronym: 'sgr' },
    { id: 'x', name: 'St George, Yellow Rock (old)', full_name: null, acronym: 'SGY' },
  ];
  const { fetchImpl, sent } = modelSaying(['sgy', 'greek', 'sgyr', 'St G Y R']);
  const r = await suggestAcronym(
    { name: 'St George Monastery, Yellow Rock', fullName: 'Holy Monastery of St George', jurisdiction: 'antiochian' },
    { db: dbWith(rows), apiKey: 'k', fetchImpl },
  );
  // sgy is taken (case and spaces aside), greek is a reserved link.
  assert.equal(r.acronym, 'sgyr');
  assert.equal(r.source, 'model');
  assert.ok(!r.alternatives.includes('sgy') && !r.alternatives.includes('greek'));
  const body = sent[0].body;
  assert.equal(body.model, ACRONYM_MODEL);
  assert.equal(body.output_config.format.type, 'json_schema');
  assert.match(body.messages[0].content, /St George, Redfern → sgr/);
  assert.match(body.messages[0].content, /Already taken: sgr, sgy/);
  assert.equal(sent[0].headers['x-api-key'], 'k');
});

test('a parish’s own acronym is not a clash with itself', async () => {
  const rows = [{ id: 'me', name: 'St George, Yellow Rock', full_name: null, acronym: 'sgy' }];
  const r = await suggestAcronym({ name: 'St George, Yellow Rock', parishId: 'me' }, { db: dbWith(rows) });
  assert.equal(r.acronym, 'sgy');
});

test('a model that fails, refuses or is cut off leaves it to the rule', async () => {
  for (const opts of [{ status: 529 }, { stop: 'refusal' }, { stop: 'max_tokens' }]) {
    const { fetchImpl } = modelSaying(['abc'], opts);
    const r = await suggestAcronym({ name: 'St George, Redfern' }, { db: dbWith([]), apiKey: 'k', fetchImpl });
    assert.deepEqual([r.acronym, r.source], ['sgr', 'rule'], JSON.stringify(opts));
  }
  const throws = async () => { throw new TypeError('network'); };
  const r = await suggestAcronym({ name: 'St George, Redfern' }, { db: dbWith([]), apiKey: 'k', fetchImpl: throws });
  assert.equal(r.acronym, 'sgr');
});

test('every name taken: the rule’s first, numbered', async () => {
  const rows = ['sgr', 'sg', 'hsgr', 'hsg', 'sgr2'].map((a, i) => ({ id: `p${i}`, name: 'x', full_name: null, acronym: a }));
  const r = await suggestAcronym({ name: 'St George, Redfern', fullName: 'Holy St George' }, { db: dbWith(rows) });
  assert.equal(r.acronym, 'sgr3');
});

test('the request is small and asks for JSON', () => {
  const req = buildAcronymRequest(acronymContext({ name: 'A, B' }));
  assert.ok(req.max_tokens <= 2048);
  assert.equal(req.output_config.effort, 'low');
  assert.deepEqual(req.output_config.format.schema.required, ['candidates']);
});
