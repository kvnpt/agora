// Emit paste-safe copies of the D1 SQL files for the Cloudflare dashboard console.
//
//   node scripts/sql-for-console.js
//
// The canonical files (d1/schema.sql, d1/seed-parishes.sql) carry the design
// notes and are what wrangler applies. But SQL `--` comments run to end of line,
// so if a paste collapses newlines — which the dashboard textarea and many
// clipboards do — the leading comment swallows the whole file, D1 parses zero
// statements, and returns "Requests without any query are not supported".
//
// These *.console.sql siblings strip every comment and put one statement per
// line, so they survive any amount of whitespace mangling.

const fs = require('fs');
const path = require('path');

function stripComments(sql) {
  let out = '';
  let i = 0;
  let inLine = false, inBlock = false, inStr = false;
  while (i < sql.length) {
    const c = sql[i], n = sql[i + 1];
    if (inStr) {
      out += c;
      if (c === "'") {
        if (n === "'") { out += n; i += 2; continue; }  // escaped quote
        inStr = false;
      }
      i++; continue;
    }
    if (inLine) { if (c === '\n') { inLine = false; out += '\n'; } i++; continue; }
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i += 2; continue; } i++; continue; }
    if (c === "'") { inStr = true; out += c; i++; continue; }
    if (c === '-' && n === '-') { inLine = true; i += 2; continue; }
    if (c === '/' && n === '*') { inBlock = true; i += 2; continue; }
    out += c; i++;
  }
  return out;
}

// Collapse each statement onto a single line, ';'-terminated.
function oneStatementPerLine(sql) {
  return sql
    .split(';')
    .map(s => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map(s => s + ';')
    .join('\n');
}

for (const name of ['schema', 'seed-parishes']) {
  const src = path.join(__dirname, '..', 'd1', `${name}.sql`);
  const dst = path.join(__dirname, '..', 'd1', `${name}.console.sql`);
  const statements = oneStatementPerLine(stripComments(fs.readFileSync(src, 'utf8')));
  fs.writeFileSync(dst, statements + '\n');
  console.log(`${dst} — ${statements.split('\n').length} statements`);
}
