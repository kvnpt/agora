// Reading JSON while it is still being written.
//
// The poster reader asks Claude for one JSON document and streams it, so the
// editor's fields can fill in as the model writes them — the title typing
// itself in, then the date, then the times — instead of all at once at the
// end. That needs to know, mid-stream, which value just finished and where it
// sits: `events[1].start_time` closed with "19:30".
//
// Re-parsing the whole text on every chunk would answer that too, and costs
// O(n²) over a few hundred chunks — a real slice of Workers Free's 10ms of CPU,
// which is metered on compute and not on waiting. So this reads each character
// once and keeps the parse state between chunks, including the awkward ones: a
// chunk can end inside an escape, halfway through a \uXXXX, or between the two
// halves of a surrogate pair.
//
//   const s = createJsonScanner({ onValue, partial });
//   s.push(text) … s.push(text);
//   const doc = s.end();            // the whole document, or a throw
//
// onValue({ path, value, done }) hears about every value as it closes —
// scalars and containers alike — with its path from the root
// (['events', 0, 'title']). `partial(path)` says which strings are worth
// hearing about while still open: those arrive with done:false and the text
// so far, once per push.

const ESCAPES = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
const HEX = /[0-9a-fA-F]/;
const LITERAL = /[-+0-9.eEtrufalsn]/;
const SPACE = new Set([' ', '\n', '\r', '\t']);

export function createJsonScanner({ onValue = () => {}, partial = () => false } = {}) {
  const stack = [];   // open containers: { type, value, key, path }
  let root, haveRoot = false;
  // What the next significant character may be: value | valueOrClose |
  // keyOrClose | key | colon | commaOrClose | string | literal | end
  let state = 'value';
  let str = null;     // the string being read: { role, text, esc, hex, path, emitted }
  let lit = null;     // the number / true / false / null being read: { text, path }
  let pos = 0;

  const top = () => stack[stack.length - 1];
  const fail = (msg) => { throw new Error(`${msg} at character ${pos}`); };

  /** Where a value starting now will sit. */
  function nextPath() {
    const f = top();
    if (!f) return [];
    return [...f.path, f.type === 'object' ? f.key : f.value.length];
  }

  function complete(value, path) {
    const f = top();
    if (!f) { root = value; haveRoot = true; state = 'end'; }
    else if (f.type === 'object') { f.value[f.key] = value; state = 'commaOrClose'; }
    else { f.value.push(value); state = 'commaOrClose'; }
    onValue({ path, value, done: true });
  }

  function startValue(ch) {
    const path = nextPath();
    if (ch === '{') { stack.push({ type: 'object', value: {}, key: null, path }); state = 'keyOrClose'; }
    else if (ch === '[') { stack.push({ type: 'array', value: [], path }); state = 'valueOrClose'; }
    else if (ch === '"') { str = { role: 'value', text: '', esc: false, hex: null, path, emitted: '' }; state = 'string'; }
    else if (ch === '-' || (ch >= '0' && ch <= '9') || ch === 't' || ch === 'f' || ch === 'n') {
      lit = { text: ch, path }; state = 'literal';
    } else fail(`Unexpected ${JSON.stringify(ch)}`);
  }

  function startKey() {
    str = { role: 'key', text: '', esc: false, hex: null };
    state = 'string';
  }

  function finishLiteral() {
    let v;
    try { v = JSON.parse(lit.text); } catch { fail(`Not a value: ${JSON.stringify(lit.text)}`); }
    const { path } = lit;
    lit = null;
    complete(v, path);
  }

  function close(ch) {
    const f = top();
    if (!f || (ch === '}') !== (f.type === 'object')) fail(`Unexpected ${ch}`);
    stack.pop();
    complete(f.value, f.path);
  }

  function readStringChar(ch) {
    if (str.hex !== null) {
      if (!HEX.test(ch)) fail('Bad \\u escape');
      str.hex += ch;
      if (str.hex.length === 4) { str.text += String.fromCharCode(parseInt(str.hex, 16)); str.hex = null; }
      return;
    }
    if (str.esc) {
      str.esc = false;
      if (ch === 'u') { str.hex = ''; return; }
      if (!(ch in ESCAPES)) fail('Bad escape');
      str.text += ESCAPES[ch];
      return;
    }
    if (ch === '\\') { str.esc = true; return; }
    if (ch !== '"') { str.text += ch; return; }
    const s = str;
    str = null;
    if (s.role === 'key') { top().key = s.text; state = 'colon'; }
    else complete(s.text, s.path);
  }

  function push(text) {
    for (let i = 0; i < text.length; i++, pos++) {
      const ch = text[i];
      if (state === 'string') { readStringChar(ch); continue; }
      if (state === 'literal') {
        if (LITERAL.test(ch)) { lit.text += ch; continue; }
        finishLiteral();          // and the delimiter is read below, in the new state
      }
      if (SPACE.has(ch)) continue;
      switch (state) {
        case 'value': startValue(ch); break;
        case 'valueOrClose': if (ch === ']') close(ch); else startValue(ch); break;
        case 'keyOrClose':
          if (ch === '}') close(ch);
          else if (ch === '"') startKey();
          else fail('Expected a key');
          break;
        case 'key': if (ch === '"') startKey(); else fail('Expected a key'); break;
        case 'colon': if (ch === ':') state = 'value'; else fail('Expected ":"'); break;
        case 'commaOrClose':
          if (ch === ',') state = top().type === 'object' ? 'key' : 'value';
          else if (ch === '}' || ch === ']') close(ch);
          else fail('Expected "," or a closing bracket');
          break;
        default: fail('Text after the end of the document');
      }
    }
    // The open string, so far — once per push rather than once per character.
    if (str && str.role === 'value' && str.text !== str.emitted && partial(str.path)) {
      str.emitted = str.text;
      let v = str.text;
      // Half a surrogate pair is not a character; hold it back until its other
      // half arrives.
      const last = v.charCodeAt(v.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) v = v.slice(0, -1);
      onValue({ path: str.path, value: v, done: false });
    }
  }

  function end() {
    if (state === 'literal') finishLiteral();
    if (!haveRoot) fail('The document ended early');
    return root;
  }

  return { push, end };
}
