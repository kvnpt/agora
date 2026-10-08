// The SSE parser both halves of the poster reader use: the Worker reading
// Claude's stream, and the editor reading the Worker's.

import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSseParser, sseFrame } = require('../public/shared/sse.js');

function parse(chunks, { end = true } = {}) {
  const got = [];
  const p = createSseParser(e => got.push(e));
  for (const c of chunks) p.push(c);
  if (end) p.end();
  return got;
}

const STREAM =
  'event: message_start\ndata: {"type":"message_start"}\n\n' +
  ': keep-alive\n\n' +
  'event: content_block_delta\r\ndata: {"type":"content_block_delta","delta":{"text":"Hi"}}\r\n\r\n' +
  'data: line one\ndata: line two\n\n' +
  'event: message_stop\rdata: {}\r\r';

const WANT = [
  { event: 'message_start', data: '{"type":"message_start"}', id: undefined },
  { event: 'content_block_delta', data: '{"type":"content_block_delta","delta":{"text":"Hi"}}', id: undefined },
  { event: 'message', data: 'line one\nline two', id: undefined },
  { event: 'message_stop', data: '{}', id: undefined },
];

test('LF, CRLF and lone CR all end a line; comments dispatch nothing', () => {
  assert.deepStrictEqual(parse([STREAM]), WANT);
});

test('every split point gives the same events, CRLF pairs included', () => {
  for (let i = 0; i <= STREAM.length; i++) {
    assert.deepStrictEqual(parse([STREAM.slice(0, i), STREAM.slice(i)]), WANT, `split at ${i}`);
  }
});

test('one character at a time', () => {
  assert.deepStrictEqual(parse([...STREAM]), WANT);
});

test('nothing is dispatched before its blank line', () => {
  assert.deepStrictEqual(parse(['event: a\ndata: 1\n'], { end: false }), []);
  // ...but a stream that closes on a complete event still delivers it.
  assert.deepStrictEqual(parse(['event: a\ndata: 1']), [{ event: 'a', data: '1', id: undefined }]);
});

test('an event with no data is not dispatched; one leading space is stripped', () => {
  assert.deepStrictEqual(parse(['event: ping\n\n', 'data:  two spaces\n\n']),
    [{ event: 'message', data: ' two spaces', id: undefined }]);
});

test('sseFrame round-trips through the parser', () => {
  const payload = { name: 'title', value: 'Line\nbreak "quoted"', done: true };
  const got = parse([sseFrame('field', payload)]);
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].event, 'field');
  assert.deepStrictEqual(JSON.parse(got[0].data), payload);
});
