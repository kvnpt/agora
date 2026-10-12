// Links in descriptions — public/shared/linkify.js, which the app's drawer and
// the lite card both render through.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { linkify } = require('../public/shared/linkify.js');

const hrefs = (html) => [...html.matchAll(/href="([^"]+)"/g)].map(m => m[1]);

test('a registration link, a www. address, a bare one and an email are links', () => {
  const html = linkify('Register at https://www.trybooking.com/CXYZA or trybooking.com/ABC, see www.stgeorge.org.au, RSVP youth@stgeorge.org.au.');
  assert.deepEqual(hrefs(html), ['https://www.trybooking.com/CXYZA', 'https://trybooking.com/ABC',
    'https://www.stgeorge.org.au', 'mailto:youth@stgeorge.org.au']);
  assert.match(html, /<a class="desc-link" href="https:\/\/www\.trybooking\.com\/CXYZA" target="_blank" rel="noopener nofollow">/);
  assert.match(html, /youth@stgeorge\.org\.au<\/a>\.$/, 'the full stop after a link stays outside it');
});

test('everything else is escaped, links included', () => {
  const html = linkify('<b>Bring a plate</b> & https://x.com/?a=1&b="2"');
  assert.match(html, /^&lt;b&gt;Bring a plate&lt;\/b&gt; &amp; /);
  assert.equal(hrefs(html)[0], 'https://x.com/?a=1&amp;b=');
  assert.ok(!/<b>/.test(html));
});

test('times, saints and initials are not links; a bracket around a link is not part of it', () => {
  assert.equal(linkify('Vespers 6.30pm, St. John, Fr. N. Smith'), 'Vespers 6.30pm, St. John, Fr. N. Smith');
  assert.deepEqual(hrefs(linkify('(see stgeorge.org.au)')), ['https://stgeorge.org.au']);
  assert.equal(linkify(null), '');
});
