import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSecret } from './secrets.mjs';

const store = (v) => ({ get: async () => v });

test('a Worker secret is a string', async () => {
  assert.equal(await readSecret('team.cloudflareaccess.com'), 'team.cloudflareaccess.com');
});

test('a Secrets Store binding is awaited, not stringified', async () => {
  assert.equal(await readSecret(store('team.cloudflareaccess.com')), 'team.cloudflareaccess.com');
});

test('unset in every shape it takes', async () => {
  for (const v of [undefined, null, '', '   ', store(''), store(null), store('  ')]) {
    assert.equal(await readSecret(v), null);
  }
});

test('surrounding whitespace is stripped', async () => {
  // A value pasted into a dashboard field arrives with a trailing newline more
  // often than not, and it would otherwise be spliced straight into a URL path.
  assert.equal(await readSecret('  team.cloudflareaccess.com\n'), 'team.cloudflareaccess.com');
  assert.equal(await readSecret(store('\tabc ')), 'abc');
});

test('an object that is not a binding is not a value', async () => {
  assert.equal(await readSecret({ value: 'nope' }), null);
});
