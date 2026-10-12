// Links in what a parish writes, made clickable.
//
// A description is where the registration link goes — "Register at
// trybooking.com/CXYZA", "RSVP to youth@stgeorge.org.au" — and as plain text a
// reader had to copy it by hand off a phone. Here a URL, a www. address, a bare
// web address on a domain a parish would use, and an email address become
// links; everything else is escaped exactly as before.
//
// Escaping comes first and is per piece: the text between links is escaped
// on its own, and a link's own text is escaped inside the anchor, so nothing
// a description says can become markup. A trailing full stop or bracket is
// left outside the link — "see trybooking.com/X." links to trybooking.com/X.
//
// Same dual-mode wrapper as its neighbours: window.AgoraLinkify for the app,
// module.exports for the Worker's lite pages and the tests.
(function (root) {
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // A bare domain is only a link on a domain a parish's link would be on;
  // "St. John" and "8.30am" are not addresses.
  const TLDS = 'com|org|net|au|nz|church|info|io|edu|gov|events|app|me|co|uk';
  const PATTERN = new RegExp([
    'https?:\\/\\/[^\\s<>"\']+',
    'www\\.[^\\s<>"\']+',
    '[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}',
    `(?:[A-Z0-9-]+\\.)+(?:${TLDS})\\b(?:\\/[^\\s<>"']*)?`,
  ].join('|'), 'gi');

  /** Peel the punctuation a sentence puts after a link back off it. */
  function trimTail(url) {
    let u = url, tail = '';
    for (;;) {
      const last = u.slice(-1);
      if (/[.,;:!?'"]/.test(last)) { tail = last + tail; u = u.slice(0, -1); continue; }
      // A closing bracket belongs to the link only if the link opened one.
      if (last === ')' && (u.match(/\(/g) || []).length < (u.match(/\)/g) || []).length) {
        tail = last + tail; u = u.slice(0, -1); continue;
      }
      return { url: u, tail };
    }
  }

  /** `text` as HTML: escaped, with its links as anchors (class "desc-link"). */
  function linkify(text) {
    const s = String(text == null ? '' : text);
    let out = '', at = 0, m;
    PATTERN.lastIndex = 0;
    while ((m = PATTERN.exec(s))) {
      // An email's domain is matched as the email, which comes first in the
      // pattern, so it is never also a bare address.
      const { url, tail } = trimTail(m[0]);
      if (!url || !/[a-z0-9/=#_&-]$/i.test(url)) continue;
      const isEmail = /^[^/:]+@/.test(url);
      const href = isEmail ? `mailto:${url}` : /^https?:\/\//i.test(url) ? url : `https://${url}`;
      out += esc(s.slice(at, m.index));
      out += `<a class="desc-link" href="${esc(href)}"${isEmail ? '' : ' target="_blank" rel="noopener nofollow"'}>${esc(url)}</a>${esc(tail)}`;
      at = m.index + m[0].length;
    }
    return out + esc(s.slice(at));
  }

  const api = { linkify };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.AgoraLinkify = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
