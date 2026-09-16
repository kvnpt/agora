// Finding the current schedule PDF on a parish's page.
//
// The HTML here is the shape stparaskevi.au actually serves: a Weebly page with
// one month's heading and an English and a Greek link under it.

import test from 'node:test';
import assert from 'node:assert';
import { discoverPdfUrl, hrefs, periodOf } from './pdf-discover.mjs';
import { PDF_SOURCES } from '../worker/lib/pdf-sources.mjs';

const INDEX = 'https://www.stparaskevi.au/church-programme.html';

const pageFor = (month, year) => `
  <div class="paragraph"><span>monthly church programme</span></div>
  <h2>${month.toUpperCase()} ${year}</h2>
  <div>English</div>
  <a href="/uploads/4/2/1/2/42128533/programme_${month}_${year}_en.pdf">Click here to download</a>
  <div>GReek</div>
  <a href="/uploads/4/2/1/2/42128533/programme_${month}_${year}_gr.pdf">Click here to download</a>
  <a href="/contact-us.html">Contact Us</a>`;

const BLACKTOWN = PDF_SOURCES.find((s) => s.key === 'stparaskevi-blacktown');

test('hrefs are resolved against the page they are on', () => {
  const got = hrefs('<a href="/uploads/x.pdf">a</a><a href="https://other.example/y.pdf">b</a>', INDEX);
  assert.deepEqual(got, [
    'https://www.stparaskevi.au/uploads/x.pdf',
    'https://other.example/y.pdf',
  ]);
});

test('the English programme is picked out from beside the Greek one', () => {
  const { url, reason } = discoverPdfUrl(pageFor('july', 2026), BLACKTOWN);
  assert.equal(url, 'https://www.stparaskevi.au/uploads/4/2/1/2/42128533/programme_july_2026_en.pdf');
  assert.equal(reason, 'one link matched');
});

test('a new month on the page is what discovery is for', () => {
  // The whole point: pdf-sources.mjs still remembers July, and the extractor
  // downloads October without anybody editing a line.
  const { url } = discoverPdfUrl(pageFor('october', 2026), BLACKTOWN);
  assert.match(url, /programme_october_2026_en\.pdf$/);
  assert.notEqual(url, BLACKTOWN.sourceUrl, 'discovery should have moved off the remembered URL');
});

test('an archive of months resolves to the newest, across a year boundary', () => {
  const page = `
    ${pageFor('november', 2026)}
    <a href="/uploads/4/2/1/2/42128533/programme_january_2027_en.pdf">January</a>
    <a href="/uploads/4/2/1/2/42128533/programme_december_2026_en.pdf">December</a>`;
  const { url, reason } = discoverPdfUrl(page, BLACKTOWN);
  assert.match(url, /programme_january_2027_en\.pdf$/);
  assert.match(reason, /newest of 3/);
});

test('two files for the same month are refused rather than guessed between', () => {
  // Picking arbitrarily here is how a run silently starts serving the wrong
  // file. Refusing falls back to the remembered URL, which is known to work.
  const page = pageFor('july', 2026)
    + '<a href="/uploads/archive/programme_july_2026_en.pdf">archived copy</a>';
  const { url, reason } = discoverPdfUrl(page, BLACKTOWN);
  assert.equal(url, null);
  assert.match(reason, /same month/);
});

test('a query string is not the same file, because the pattern is anchored', () => {
  // `...programme_july_2026_en.pdf?v=2` does NOT match: linkPattern ends in
  // `\.pdf$`. That is the right behaviour and worth pinning — a cache-busting
  // query would otherwise read as a second file for the same month and send
  // discovery into the refusal above every time the parish touched its page.
  const page = pageFor('july', 2026)
    + '<a href="/uploads/4/2/1/2/42128533/programme_july_2026_en.pdf?v=2">again</a>';
  const { url } = discoverPdfUrl(page, BLACKTOWN);
  assert.match(url, /programme_july_2026_en\.pdf$/);
});

test('a page that no longer links a programme yields nothing, not a wrong guess', () => {
  const { url, reason } = discoverPdfUrl('<h2>Under construction</h2><a href="/contact-us.html">Contact</a>', BLACKTOWN);
  assert.equal(url, null);
  assert.match(reason, /no link on .*church-programme\.html matched/);
});

test('a source with no index is left alone', () => {
  // Buderim: the site links no PDF from any page, so there is nothing to follow
  // and the remembered URL is the only answer.
  const buderim = PDF_SOURCES.find((s) => s.key === 'gopssc-buderim');
  assert.equal(buderim.indexUrl, undefined);
  assert.equal(discoverPdfUrl(pageFor('july', 2026), buderim).url, null);
  assert.match(discoverPdfUrl(pageFor('july', 2026), buderim).reason, /no index configured/);
});

test('a period is read whichever order the pattern captured it in', () => {
  assert.equal(periodOf(['july', '2026']), periodOf(['2026', 'july']));
  assert.ok(periodOf(['january', '2027']) > periodOf(['december', '2026']));
  assert.ok(periodOf(['february', '2026']) > periodOf(['january', '2026']));
  // Abbreviations, since a parish may rename its files.
  assert.equal(periodOf(['sep', '2026']), periodOf(['september', '2026']));
  // Nothing datelike.
  assert.equal(periodOf(['programme', 'en']), null);
  assert.equal(periodOf([]), null);
  assert.equal(periodOf(undefined), null);
});

test('the configured pattern only matches that parish\'s own files', () => {
  const re = BLACKTOWN.linkPattern;
  assert.ok(re.test('/uploads/4/2/1/2/42128533/programme_july_2026_en.pdf'));
  assert.ok(!re.test('/uploads/4/2/1/2/42128533/programme_july_2026_gr.pdf'), 'the Greek edition is not the English one');
  assert.ok(!re.test('/uploads/newsletter_july_2026_en.pdf'));
  assert.ok(!re.test('/programme_july_2026_en.pdf.html'));
});

test('every source that names an index also names a pattern', () => {
  // Half a configuration silently disables discovery, which would look exactly
  // like a parish that never publishes.
  for (const s of PDF_SOURCES) {
    assert.equal(
      Boolean(s.indexUrl), Boolean(s.linkPattern),
      `${s.key}: indexUrl and linkPattern have to be set together`,
    );
  }
});
