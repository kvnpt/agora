// Every page script loads: it is there, and it parses.
//
// CI runs none of next/next.js, next/editing.js, next/month.js, bundle.js or
// map.js, and nothing else reads them as code: on 19 Nov 2026 a syntax error
// put at the end of next.js and editing.js passed all 1,251 tests and the
// Worker's build, and a merge is a deploy. The page would have been blank for
// everybody. Parsing is the least a browser does with a script, so this does
// it to all of them: every file under public/, every inline <script> in the
// three pages, and every script a page names, by <script src> or by
// loadScript()/import(), is a file that exists.
//
// It proves a script would START, not that it works: a door that throws when
// pressed (Add service, 31 Oct to 3 Nov 2026) is e2e/doors.test.mjs's.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const PUBLIC = new URL('../public/', import.meta.url);
const root = PUBLIC.pathname;

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? walk(p) : [p];
  });
}

const files = walk(root);
const scripts = files.filter(f => /\.m?js$/.test(f));
const pages = files.filter(f => f.endsWith('.html'));
const rel = (f) => path.relative(path.dirname(root), f);
// A SyntaxError from vm says where on the first line of its stack: "file:line".
const where = (e, f) => (String(e.stack).split('\n')[0].startsWith(f) ? String(e.stack).split('\n')[0] : f);

test('every classic page script parses as a browser would parse it', () => {
  // A .js under public/ is a classic script (the modules are .mjs): compiled
  // the way a <script> tag compiles it, so a top-level `return` or `import`
  // fails here as it would there.
  const bad = [];
  for (const f of scripts.filter(f => f.endsWith('.js'))) {
    try { new vm.Script(fs.readFileSync(f, 'utf8'), { filename: rel(f) }); }
    catch (e) { bad.push(`${where(e, rel(f))}: ${e.message}`); }
  }
  assert.ok(scripts.length > 40, `found only ${scripts.length} scripts under public/`);
  assert.deepEqual(bad, []);
});

test('every page module parses', async () => {
  const mods = scripts.filter(f => f.endsWith('.mjs'));
  assert.ok(mods.length > 0);
  const bad = [];
  await Promise.all(mods.map(f => run(process.execPath, ['--check', f])
    .catch(e => bad.push(`${rel(f)}: ${String(e.stderr).trim().split('\n').slice(0, 5).join(' ')}`))));
  assert.deepEqual(bad, []);
});

test('every inline <script> in a page parses', () => {
  const bad = [];
  let n = 0;
  for (const f of pages) {
    const html = fs.readFileSync(f, 'utf8');
    for (const m of html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
      const attrs = m[1] || '';
      if (/\bsrc=/.test(attrs) || /type="(?!text\/javascript)[^"]*"/.test(attrs)) continue;
      n++;
      // Errors name the page's own line, not the script's.
      const lineOffset = html.slice(0, m.index).split('\n').length - 1;
      try { new vm.Script(m[2], { filename: rel(f), lineOffset }); }
      catch (e) { bad.push(`${where(e, rel(f))}: ${e.message}`); }
    }
  }
  assert.ok(n >= 4, `found only ${n} inline scripts`);
  assert.deepEqual(bad, []);
});

test('every script a page names is a file that is there', () => {
  // <script src="/next/next.js">, loadScript('/next/month.js'),
  // import('/shared/tz.mjs'): a missing one is a 404 and whatever runs on it
  // never starts.
  const named = new Map();
  for (const f of [...pages, ...scripts.filter(f => !f.includes(`${path.sep}lib${path.sep}`))]) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/['"`](\/(?:shared|next|lib)\/[A-Za-z0-9_.\/-]+\.m?js)(?:\?[^'"`]*)?['"`]/g)) {
      if (!named.has(m[1])) named.set(m[1], rel(f));
    }
    for (const m of src.matchAll(/<script\s[^>]*src="(\/[^"?#]+)/g)) {
      if (!named.has(m[1])) named.set(m[1], rel(f));
    }
  }
  assert.ok(named.has('/next/next.js') && named.has('/next/editing.js') && named.has('/next/month.js'),
    'the scan no longer sees how the page loads its own scripts');
  const missing = [...named].filter(([p]) => !fs.existsSync(path.join(root, p))).map(([p, by]) => `${p} (named in ${by})`);
  assert.deepEqual(missing, []);
});
