// The words a poster came with on WhatsApp, as a card's description.
//
// Kevin (19 Nov 2026): "the descriptions should have come from WhatsApp by
// default". The words are the parish's own, so they go in as written, but
// for WhatsApp's own marks — *bold*, _italic_, ~struck~ — which a card shows
// as typed, stars and all. Each line is trimmed (a forward keeps stray
// spaces at the start of lines), and no more is kept than a description
// holds. Emojis stay: they are how the parish wrote it. A mark is only a mark
// where WhatsApp makes one, round a word or words, so an address with an
// underscore in it ("my_name@x.org") or "2 * 3" is left alone.
//
// One file for both: the Worker's read fills a card with it
// (worker/lib/draft-read.mjs), and the editor's Fill from WhatsApp gives the
// same words (shared/event-editor.js).
//
// Same dual-mode wrapper as its neighbours: window.AgoraWhatsappWords for the
// app, module.exports for the Worker and the tests.
(function (root) {
  /** The most a description holds (poster-read.mjs normalizeEvent). */
  const MAX = 1000;

  const mark = (c) => new RegExp(`(^|[\\s(])\\${c}(\\S(?:[^${c}\\n]*\\S)?)\\${c}(?=$|[\\s).,!?:;])`, 'g');
  const MARKS = ['*', '_', '~'].map(mark);

  /** Cut at a word, with an ellipsis, as the reader's notes are. */
  function clip(text, n) {
    if (text.length <= n) return text;
    const cut = text.slice(0, n - 1);
    const at = cut.lastIndexOf(' ');
    return `${(at > n * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,;:.-]+$/, '')}…`;
  }

  /** The words as a description, or null when there are none. */
  function plainWords(text) {
    const t = String(text || '').replace(/\r\n?/g, '\n')
      .split('\n').map(line => MARKS.reduce((s, re) => s.replace(re, '$1$2'), line.trim()))
      .join('\n').replace(/\n{3,}/g, '\n\n').trim();
    return t ? clip(t, MAX) : null;
  }

  const api = { plainWords };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.AgoraWhatsappWords = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
