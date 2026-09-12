// Reading a parish out of an Avada portfolio page.
//
// The fixture is real: it is the markup the Archdiocese's REST API actually
// returned for Holy Cross Mission, trimmed of the page-builder wrappers but
// with every element this parser reads left exactly as it arrived — the
// escaped entities in the title, the icon markup between the contact links,
// the unclosed <p> in the Location tab, and an address that names no street.

import test from 'node:test';
import assert from 'node:assert';
import {
  sections, location, languages, parishWebsite, email, phone, isVague, toParish, text,
} from './scrape-antiochian.mjs';

const HOLY_CROSS = {
  id: 49935,
  slug: 'holy-cross-melbourne',
  link: 'https://www.antiochian.org.au/avada_portfolio/holy-cross-melbourne/',
  title: { rendered: 'Holy Cross Mission, Melbourne North' },
  content: {
    rendered: `<div class="awb-tab-pane-inner">
<h3>Main Parish Contact</h3>
<i class="fb-icon-element fa fa-envelope-o"></i>| <a href="mailto:fr.sassali@antiochian.org.au">Email Reverend Father Stephanos Assali</a></p>
<i class="fb-icon-element fa fa-globe"></i> | Soon</p>
<i class="fb-icon-element fa fa-phone"></i> | <a href="tel:0475 459 706" target="_blank" rel="noopener noreferrer">0475 459 706</a></p>
<h4>Parish Priest</h4>
<ul><li>Reverend Father Stephanos Assali</li></ul>
</div><div class="awb-tab-pane-inner">
<h3>Languages</h3>
<ul><li>Arabic</li><li>English</li></ul>
<h3>Services on Offer</h3>
<ul><li>English Catechism Classes (by appointment)</li><li>Pre-Marriage Classes</li></ul>
</div><div class="awb-tab-pane-inner">
<h3>Location</h3>
<p>Temporary place of worship in Kalkallo, VIC, Australia (contact the clergy)</div>
</div><div class="awb-tab-pane-inner">
<h3>Sundays</h3>
<ul><li>Morning<ul><li>9:00AM- Matins (Arabic)</li><li>10:00AM- Liturgy (Mostly Arabic)</li></ul></li></ul>
</div>`,
  },
};

// A parish that publishes a real street address, worded as these pages word it.
const WOLLONGONG = {
  id: 2324,
  slug: 'st-elias-wollongong',
  link: 'https://www.antiochian.org.au/avada_portfolio/st-elias-wollongong/',
  title: { rendered: 'St. Elias, Wollongong' },
  content: {
    rendered: `<div class="awb-tab-pane-inner"><h3>Main Parish Contact</h3>
<a href="mailto:office@saintelias.org.au">Email the parish</a></p>
<a href="https://www.saintelias.org.au/" target="_blank">Parish website</a></p>
<a href="tel:0242294211">(02) 4229 4211</a></p>
</div><div class="awb-tab-pane-inner"><h3>Languages</h3><ul><li>Arabic</li><li>English</li></ul>
</div><div class="awb-tab-pane-inner"><h3>Location</h3>
<p>86 Kenny Street, Wollongong NSW 2500</p></div>`,
  },
};

test('the h3 sections of a page are keyed by their heading', () => {
  const secs = sections(HOLY_CROSS.content.rendered);
  assert.deepEqual(Object.keys(secs).sort(),
    ['Languages', 'Location', 'Main Parish Contact', 'Services on Offer', 'Sundays']);
});

test('the address is whatever the Location section says, verbatim', () => {
  assert.equal(location(sections(WOLLONGONG.content.rendered)), '86 Kenny Street, Wollongong NSW 2500');
  assert.equal(location(sections(HOLY_CROSS.content.rendered)),
    'Temporary place of worship in Kalkallo, VIC, Australia (contact the clergy)');
});

test('an address that names no street is flagged rather than geocoded', () => {
  // It would geocode — to the middle of Kalkallo, looking like a real pin.
  assert.equal(isVague('Temporary place of worship in Kalkallo, VIC, Australia (contact the clergy)'), true);
  assert.equal(isVague('PO Box 42, Marrickville NSW 2204'), true);
  assert.equal(isVague(null), true);
  assert.equal(isVague('86 Kenny Street, Wollongong NSW 2500'), false);
});

test('languages come out as the names the column wants', () => {
  assert.deepEqual(languages(sections(HOLY_CROSS.content.rendered)), ['Arabic', 'English']);
  // "Services on Offer" sits under its own heading and must not leak in.
  assert.ok(!languages(sections(HOLY_CROSS.content.rendered)).includes('Pre-Marriage Classes'));
});

test('contact details survive the icon markup between them', () => {
  assert.equal(email(HOLY_CROSS.content.rendered), 'fr.sassali@antiochian.org.au');
  assert.equal(phone(HOLY_CROSS.content.rendered), '0475 459 706');
});

test('the parish website is the external link, never the Archdiocese', () => {
  assert.equal(parishWebsite(WOLLONGONG.content.rendered), 'https://www.saintelias.org.au/');
  // Holy Cross has no site yet — its page says "Soon", and a mailto is not one.
  assert.equal(parishWebsite(HOLY_CROSS.content.rendered), null);
});

test('the suburb comes off the end of the directory name', () => {
  assert.equal(toParish(WOLLONGONG, { indexEntry: { cats: [114] } }).suburb, 'Wollongong');
  assert.equal(toParish(HOLY_CROSS, { indexEntry: { cats: [156] } }).suburb, 'Melbourne North');
});

test("a monastery's second dedication does not become its suburb", () => {
  const goulburn = {
    id: 2943,
    slug: 'st-michaels-antiochian-village-and-st-anna-monastery-goulburn',
    title: { rendered: 'St. Michael’s Monastery, Antiochian Village, Goulburn | St. Anna’s Chapel' },
    content: { rendered: '<h3>Location</h3><p>Goulburn NSW</p>' },
  };
  const row = toParish(goulburn, { indexEntry: { cats: [114, 646] } });
  assert.equal(row.suburb, 'Goulburn');
  assert.equal(row.is_monastery, true);
});

test('the state is a hint from the directory, and New Zealand has none', () => {
  const nz = toParish({
    id: 2455, slug: 'x', title: { rendered: 'St. Michael the Archangel, Dunedin' },
    content: { rendered: '<h3>Location</h3><p>Dunedin</p>' },
  }, { indexEntry: { cats: [160] } });
  assert.equal(nz.country, 'New Zealand');
  assert.equal(nz.state_abbr, null);
  assert.equal(toParish(WOLLONGONG, { indexEntry: { cats: [114] } }).state, 'New South Wales');
});

test('each row points at the page its address came from', () => {
  assert.equal(toParish(WOLLONGONG, { indexEntry: { cats: [114] } }).source_ref,
    'https://www.antiochian.org.au/avada_portfolio/st-elias-wollongong/');
});

test('escaped entities in a title are decoded', () => {
  const row = toParish({
    id: 2328, slug: 'y', title: { rendered: 'St.s Michael &#038; Gabriel,  Ryde' },
    content: { rendered: '<h3>Location</h3><p>72 Belmore St, Ryde NSW 2112</p>' },
  }, { indexEntry: { cats: [114] } });
  assert.equal(row.name, 'St.s Michael & Gabriel,  Ryde');
  assert.equal(row.suburb, 'Ryde');
});

test('list items keep their own lines when markup becomes text', () => {
  assert.equal(text('<ul><li>Arabic</li><li>English</li></ul>'), 'Arabic\nEnglish');
});
