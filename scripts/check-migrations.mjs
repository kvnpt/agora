// Does the baseline still describe a database migrated forward?
//
//   node scripts/check-migrations.mjs [base-ref]
//
// d1/migrations/README.md states the rule and the manual procedure: "a column
// added to the baseline needs a matching ALTER TABLE here", checked by
// building a database from the previous baseline, applying the new files, and
// diffing against a fresh one. This is that, run on every pull request.
//
// WHY IT IS WORTH A CI STEP. The manual version is a thing to remember at
// exactly the moment somebody is thinking about something else, and both ways
// of forgetting fail QUIETLY:
//
//   * Baseline changed, no migration — production never gets the column. The
//     deploy then runs code that names it. `INSERT INTO t (a, b, newcol)`
//     fails for EVERY write, not just the new feature's: adding
//     patch_poster_path to overrides.mjs would have broken cancel, modify,
//     combine and hide in one go. Caught by hand, twice, minutes before a
//     merge; that is not a control.
//   * Migration changed, baseline not — a fresh database and a live one drift,
//     and every test runs against the one that is wrong.
//
// WHAT IT COMPARES, and why not just the SQL text. `ALTER TABLE ... ADD COLUMN`
// appends the column to the STORED sql after any table constraints, while the
// baseline writes it before them — so two structurally identical tables have
// different `sqlite_master.sql`, and a text diff is all false positives. A
// table rebuilt and renamed (migration 011) also comes back with its name
// quoted. So this compares what actually matters:
//
//   * columns, by name, type and POSITION — position because ADD COLUMN can
//     only append, which is the constraint the whole rule exists to serve
//   * CHECK constraints, as a set — 011 widened one, and `PRAGMA table_info`
//     cannot see them at all
//   * indexes, by normalised sql
//
// A comment-only edit to the baseline is structurally identical to its
// predecessor and passes without needing a migration, which is most of the
// edits this file gets.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const BASE = process.argv[2] || 'origin/main';
const SCHEMA = 'd1/schema.sql';

// stderr is piped rather than inherited: `git show ref:path` is used below as
// an existence TEST, and its "fatal: path ... exists on disk, but not in ..."
// is the expected answer, not a problem to print.
const git = (...args) => execFileSync('git', args, {
  encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
});

/** The baseline as it stood at `ref`, or null when it did not exist. */
function schemaAt(ref) {
  try { return git('show', `${ref}:${SCHEMA}`); } catch { return null; }
}

/**
 * Migration files that exist now and did not exist at `ref`.
 *
 * By EXISTENCE and not by `git diff --diff-filter=A`: the diff only sees what
 * has been committed, so running this locally after writing the migration and
 * before committing it would report that you had not written one — which is
 * precisely the moment the check is meant to help. `git show ref:path` failing
 * is the test, and it answers the same for a committed, staged or untracked
 * file.
 */
function newMigrations(ref) {
  const dir = 'd1/migrations';
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    // The .console.sql siblings are the same statements with comments stripped,
    // for pasting into the dashboard. Applying both would run everything twice.
    .filter(f => f.endsWith('.sql') && !f.endsWith('.console.sql'))
    .map(f => `${dir}/${f}`)
    .filter(f => {
      try { git('show', `${ref}:${f}`); return false; } catch { return true; }
    })
    .sort();
}

/** A structural fingerprint: columns in order, CHECKs as a set, indexes. */
function fingerprint(db) {
  const objects = db.prepare(
    "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'"
  ).all();

  const tables = {};
  for (const o of objects.filter(x => x.type === 'table')) {
    tables[o.name] = {
      columns: db.prepare(`PRAGMA table_info("${o.name}")`).all()
        .map(c => `${c.name}:${c.type}:${c.notnull}:${c.dflt_value ?? ''}:${c.pk}`),
      // Order-insensitive: a rebuild may emit them in a different order and
      // mean the same thing.
      checks: checksIn(o.sql).sort(),
    };
  }

  const indexes = {};
  for (const o of objects.filter(x => x.type === 'index' && x.sql)) {
    indexes[o.name] = normalise(o.sql);
  }
  return { tables, indexes };
}

/** Every CHECK(...) in a CREATE TABLE, normalised, with balanced parens. */
function checksIn(sql) {
  const found = [];
  const text = stripComments(sql || '');
  const re = /\bCHECK\s*\(/gi;
  let m;
  while ((m = re.exec(text))) {
    let depth = 1, i = m.index + m[0].length;
    while (i < text.length && depth > 0) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')') depth--;
      i++;
    }
    found.push(normalise(text.slice(m.index, i)));
  }
  return found;
}

const stripComments = (sql) => sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');

/** Whitespace collapsed, identifier quoting dropped — a rename leaves quotes. */
const normalise = (sql) => stripComments(sql)
  .replace(/"([A-Za-z_][A-Za-z0-9_]*)"/g, '$1')
  .replace(/\s+/g, ' ')
  .trim();

function build(sqlText, migrations = []) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(sqlText);
  for (const file of migrations) db.exec(fs.readFileSync(file, 'utf8'));
  return db;
}

/** Every way the two fingerprints disagree, as sentences. */
function differences(want, got) {
  const out = [];
  const names = [...new Set([...Object.keys(want.tables), ...Object.keys(got.tables)])].sort();
  for (const t of names) {
    const a = want.tables[t], b = got.tables[t];
    if (!a) { out.push(`table ${t}: in the migrated database and not in the baseline`); continue; }
    if (!b) { out.push(`table ${t}: in the baseline and not in the migrated database — it needs a migration`); continue; }
    if (a.columns.join('|') !== b.columns.join('|')) {
      const onlyBaseline = a.columns.filter(c => !b.columns.includes(c));
      const onlyMigrated = b.columns.filter(c => !a.columns.includes(c));
      if (onlyBaseline.length || onlyMigrated.length) {
        if (onlyBaseline.length) out.push(`table ${t}: baseline has ${onlyBaseline.join(', ')} and the migrated database does not`);
        if (onlyMigrated.length) out.push(`table ${t}: migrated database has ${onlyMigrated.join(', ')} and the baseline does not`);
      } else {
        // Same columns, different positions — the one the README calls out,
        // because ADD COLUMN can only append.
        out.push(`table ${t}: same columns in a different ORDER.\n`
          + `      baseline: ${a.columns.map(c => c.split(':')[0]).join(', ')}\n`
          + `      migrated: ${b.columns.map(c => c.split(':')[0]).join(', ')}`);
      }
    }
    if (a.checks.join('|') !== b.checks.join('|')) {
      out.push(`table ${t}: CHECK constraints differ.\n`
        + `      baseline: ${a.checks.join(' ; ') || '(none)'}\n`
        + `      migrated: ${b.checks.join(' ; ') || '(none)'}`);
    }
  }
  const idx = [...new Set([...Object.keys(want.indexes), ...Object.keys(got.indexes)])].sort();
  for (const i of idx) {
    if (want.indexes[i] !== got.indexes[i]) {
      out.push(`index ${i}: ${!want.indexes[i] ? 'only in the migrated database'
        : !got.indexes[i] ? 'only in the baseline — a rebuild drops indexes, so the migration has to recreate them'
        : 'defined differently'}`);
    }
  }
  return out;
}

function main() {
  const before = schemaAt(BASE);
  if (before === null) {
    console.log(`No ${SCHEMA} at ${BASE} — nothing to compare against.`);
    return 0;
  }
  const after = fs.readFileSync(SCHEMA, 'utf8');

  const oldPrint = fingerprint(build(before));
  const newPrint = fingerprint(build(after));

  // A comment-only edit is most of what this file gets, and needs no migration.
  if (!differences(newPrint, oldPrint).length) {
    console.log('Baseline is structurally unchanged — no migration needed.');
    return 0;
  }

  const migrations = newMigrations(BASE);
  if (!migrations.length) {
    console.error(
      `\n${SCHEMA} changed structurally and no new migration was added.\n\n` +
      'A live database cannot be rebuilt from the baseline, so the change reaches\n' +
      'production only if a file in d1/migrations/ makes it. Without one the deploy\n' +
      'runs code against a schema that does not have the change — and a column named\n' +
      'in an INSERT fails EVERY write to that table, not just the new feature\'s.\n\n' +
      'Add the migration, or revert the baseline.\n'
    );
    return 1;
  }

  let migrated;
  try {
    migrated = fingerprint(build(before, migrations));
  } catch (err) {
    console.error(`\nApplying ${migrations.join(', ')} to the previous baseline failed:\n  ${err.message}\n`);
    return 1;
  }

  const diffs = differences(newPrint, migrated);
  if (diffs.length) {
    console.error(
      `\nThe baseline and a database migrated forward do not match.\n\n` +
      `  previous baseline: ${BASE}:${SCHEMA}\n` +
      `  migrations applied: ${migrations.join(', ')}\n\n` +
      diffs.map(d => `  - ${d}`).join('\n') +
      '\n\nd1/migrations/README.md: "A baseline the live database does not match is\n' +
      'worse than no baseline, because everything downstream trusts it."\n'
    );
    return 1;
  }

  console.log(`Baseline matches a database migrated forward (${migrations.join(', ')}).`);
  return 0;
}

process.exit(main());
