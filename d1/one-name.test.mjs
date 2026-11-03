// One name, one function, in each page script's own scope.
//
// Two `function x()` declarations in one scope are not an error in a classic
// script: the second one wins everywhere, the first one's callers included.
// That is how rule-form.js's Date pill (`daysHTML(attr, multi)`, #168) took
// the place of its seven weekday ticks (`daysHTML(days)`), and Add service and
// Edit service threw before they opened, from 31 Oct to 3 Nov 2026. CI runs
// none of the form, so the scan is the check: a declaration at the scripts'
// top level (two spaces in, inside their one wrapping function) is unique.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const dirs = ['public/shared', 'public/next'];

test('no page script declares one function name twice in its own scope', () => {
  const dupes = [];
  for (const dir of dirs) {
    const url = new URL(`../${dir}/`, import.meta.url);
    for (const name of readdirSync(url).filter(n => n.endsWith('.js'))) {
      const src = readFileSync(new URL(name, url), 'utf8');
      const seen = new Map();
      for (const m of src.matchAll(/^ {2}(?:async )?function\*? ?([A-Za-z0-9_$]+)\s*\(/gm)) {
        seen.set(m[1], (seen.get(m[1]) || 0) + 1);
      }
      for (const [fn, n] of seen) if (n > 1) dupes.push(`${dir}/${name}: ${fn} ×${n}`);
    }
  }
  assert.deepEqual(dupes, []);
});
