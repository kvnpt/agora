// Matching ROCOR directory rows against the World Orthodox Directory.
//
// The fixtures are real. Every case below is something the two sources actually
// disagreed about on the run that imported these parishes, and each one produced
// a wrong answer before the rule that now prevents it.

import test from 'node:test';
import assert from 'node:assert';
import { attachAddresses } from './rocor-world-directory.mjs';

// Entries as the World Orthodox Directory publishes them.
const ENTRIES = [
  { id: '1', path: '/en/i/1/x', country: 'australia', state: 'new-south-wales', suburb: 'corrimal', name: 'Holy Dormition Orthodox Church, Corrimal, Australia', address: '61 Wilford St, Corrimal, New South Wales, NSW 2518 Australia' },
  // The same parish a second time, with its whole address typed into the
  // suburb field as well.
  { id: '2', path: '/en/i/2/x', country: 'australia', state: 'new-south-wales', suburb: 'wollongong-', name: 'Holy Dormition Orthodox Church Corrimal Australia , Wollongong, Australia', address: '61 Wilford St Corrimal NSW , Wollongong , New South Wales, 2518 Australia' },
  { id: '3', path: '/en/i/3/x', country: 'australia', state: 'new-south-wales', suburb: 'fairfield', name: 'Saint Nicholas Orthodox Church, Fairfield, Australia', address: '13/15 Barbara St, Fairfield, New South Wales, NSW 2165 Australia' },
  { id: '4', path: '/en/i/4/x', country: 'australia', state: 'new-south-wales', suburb: 'wallsend', name: 'Saint Nicholas Orthodox Church, Wallsend, Australia', address: '3 Irving St, Wallsend, New South Wales, NSW 2287 Australia' },
  { id: '5', path: '/en/i/5/x', country: 'new-zealand', state: 'auckland', suburb: 'balmoral', name: 'Resurrection of Christ Orthodox Church, Balmoral, New Zealand', address: '455-461 Dominion Road, Balmoral, Auckland, 1003 New Zealand' },
  { id: '6', path: '/en/i/6/x', country: 'new-zealand', state: 'wellington', suburb: 'wellington', name: 'Christ the Savior Orthodox Church, Wellington, New Zealand', address: '62 Darlington Rd, Wellington, Wellington, 6022 New Zealand' },
  { id: '7', path: '/en/i/7/x', country: 'australia', state: 'queensland', suburb: 'arundel', name: 'Saints Cyril and Methodius Orthodox Church, Arundel, Australia', address: '114 Allied Dr, Arundel, Queensland, QLD 4214 Australia' },
  { id: '8', path: '/en/i/8/x', country: 'australia', state: 'new-south-wales', suburb: 'gunningrah', name: 'Holy Transfiguration Orthodox Monastery, Gunningrah, Australia', address: 'Richardsons Road, Gunningrah, New South Wales, NSW 2632 Australia' },
];

const row = (name, suburb, state, country = 'Australia') => ({ name, suburb, state, country });

test('a parish listed twice at one street is one parish, not an ambiguity', () => {
  const r = row('Holy Dormition Church', 'Woollongong', 'New South Wales');
  attachAddresses([r], ENTRIES);
  // The tidier of the two listings wins, so the suburb is usable.
  assert.equal(r.directory_address, '61 Wilford St, Corrimal, New South Wales, NSW 2518 Australia');
  assert.equal(r.directory_suburb, 'Corrimal');
});

test('the suburb separates two parishes that share a dedication and a state', () => {
  const fairfield = row('St. Nicholas Church', 'Fairfield', 'New South Wales');
  const wallsend = row('St. Nicholas Church', 'Wallsend', 'New South Wales');
  attachAddresses([fairfield, wallsend], ENTRIES);
  assert.match(fairfield.directory_address, /Barbara St/);
  assert.match(wallsend.directory_address, /Irving St/);
});

test('a New Zealand parish is separated by its region, which is not a state', () => {
  // "Christ" is the only distinctive token in both "Resurrection of Christ" and
  // "Christ the Savior", and New Zealand entries carry no state to tell them
  // apart — the directory files them under Auckland and Wellington instead.
  const auckland = row('Resurrection of Christ Church', 'Auckland', 'New Zealand', 'New Zealand');
  attachAddresses([auckland], ENTRIES);
  assert.match(auckland.directory_address, /Dominion Road/);
  assert.equal(auckland.directory_suburb, 'Balmoral');
});

test('a suburb the diocese gets wrong is reported, not silently replaced', () => {
  const r = row('Holy Transfiguration Monastery', 'Bombala', 'New South Wales');
  const report = attachAddresses([r], ENTRIES);
  assert.equal(r.directory_suburb, 'Gunningrah');
  assert.match(report.join('\n'), /SUBURB DIFFERS.*Bombala.*Gunningrah/);
});

test('an entry known to be out of date is skipped and says so', () => {
  // The Gold Coast address is this community's former home; it has moved to
  // South Tweed Heads, which is in a different state AND a different timezone.
  const r = row('Sts. Cyril and Methodius Community / St Xenia Church', 'Tweed Heads', 'Queensland');
  const report = attachAddresses([r], ENTRIES, {
    'Sts. Cyril and Methodius Community / St Xenia Church | Tweed Heads': { why: 'the parish has moved. Arundel is the old site' },
  });
  assert.equal(r.directory_address, undefined);
  assert.match(report.join('\n'), /IGNORED/);
});

test('a parish the directory does not list gets no address and no guess', () => {
  const r = row('St Mary’s Orthodox Church', 'Bunbury', 'Western Australia');
  const report = attachAddresses([r], ENTRIES);
  assert.equal(r.directory_address, undefined);
  assert.match(report.join('\n'), /no entry/);
});
