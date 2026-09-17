// Starting the extraction from the panel, and what happens when it cannot.
//
// The unconfigured path matters most: until somebody sets a token, every
// deployment is in it, and the panel has to degrade to a link rather than to a
// broken button.

import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchExtraction, recentExtractionRuns, workflowPageUrl, githubConfig } from './github-actions.mjs';

const REPO = 'kvnpt/agora';
const env = (over = {}) => ({ GITHUB_REPO: REPO, GITHUB_ACTIONS_TOKEN: 'ghp_test', ...over });
const store = (value) => ({ get: async () => value });

/** Records calls and answers with whatever is queued. */
function spy(...responses) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body });
    const r = responses.shift();
    if (r instanceof Error) throw r;
    return r ?? new Response(null, { status: 204 });
  };
  impl.calls = calls;
  return impl;
}

const runsBody = (runs) => new Response(JSON.stringify({ workflow_runs: runs }), { status: 200 });

test('a dispatch names one source key and runs from main', async () => {
  const f = spy(new Response(null, { status: 204 }));
  const r = await dispatchExtraction(env(), 'stparaskevi-blacktown', { fetchImpl: f });

  assert.equal(r.started, true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].method, 'POST');
  assert.match(f.calls[0].url, /repos\/kvnpt\/agora\/actions\/workflows\/parish-pdf\.yml\/dispatches$/);

  const body = JSON.parse(f.calls[0].body);
  // One parish, not all of them: re-fetching Blacktown should not also go and
  // hit every other parish's website.
  assert.deepEqual(body, { ref: 'main', inputs: { key: 'stparaskevi-blacktown' } });
});

test('the request carries the headers GitHub requires', async () => {
  const f = spy(new Response(null, { status: 204 }));
  await dispatchExtraction(env(), 'gopssc-buderim', { fetchImpl: f });
  const h = f.calls[0].headers;
  assert.equal(h.Authorization, 'Bearer ghp_test');
  assert.equal(h['X-GitHub-Api-Version'], '2022-11-28');
  // GitHub refuses a request with no User-Agent outright.
  assert.match(h['User-Agent'], /Agora/);
});

test('with no token the panel says so and hands back the link', async () => {
  const f = spy();
  const r = await dispatchExtraction(env({ GITHUB_ACTIONS_TOKEN: undefined }), 'gopssc-buderim', { fetchImpl: f });
  assert.equal(r.started, false);
  assert.equal(r.configured, false);
  assert.equal(r.dispatchUrl, workflowPageUrl(REPO));
  assert.match(r.error, /Run it from GitHub instead/);
  assert.equal(f.calls.length, 0, 'should not have called GitHub at all');
});

test('a 404 names both things that cause it', async () => {
  // A token without Actions access and a wrong repo are indistinguishable from
  // the status code, and reporting "not found" for a repository that is
  // plainly there sends somebody looking in the wrong place.
  const f = spy(new Response('{"message":"Not Found"}', { status: 404 }));
  const r = await dispatchExtraction(env(), 'gopssc-buderim', { fetchImpl: f });
  assert.equal(r.started, false);
  assert.match(r.error, /GITHUB_REPO is wrong/);
  assert.match(r.error, /no Actions access/);
});

test('a refusal carries GitHub\'s own words, bounded', async () => {
  const f = spy(new Response('x'.repeat(5000), { status: 422 }));
  const r = await dispatchExtraction(env(), 'gopssc-buderim', { fetchImpl: f });
  assert.match(r.error, /422/);
  assert.ok(r.error.length < 300, 'a 5KB body should not be pasted into a toast');
});

test('a network failure is a message, never a throw', async () => {
  // This is wired to a button. A rejected promise here would surface as a
  // dead click.
  const f = spy(new Error('connect ETIMEDOUT'));
  const r = await dispatchExtraction(env(), 'gopssc-buderim', { fetchImpl: f });
  assert.equal(r.started, false);
  assert.match(r.error, /Could not reach GitHub/);
});

test('run history comes back shaped for a card', async () => {
  const f = spy(runsBody([
    { id: 1, status: 'completed', conclusion: 'success', event: 'schedule',
      run_started_at: '2026-09-13T19:16:07Z', html_url: 'https://github.com/kvnpt/agora/actions/runs/1' },
    { id: 2, status: 'in_progress', conclusion: null, event: 'workflow_dispatch',
      run_started_at: '2026-09-17T04:00:00Z', html_url: 'https://github.com/kvnpt/agora/actions/runs/2' },
  ]));
  const r = await recentExtractionRuns(env(), { fetchImpl: f });
  assert.equal(r.runs.length, 2);
  assert.deepEqual(r.runs[0], {
    id: 1, status: 'completed', conclusion: 'success', event: 'schedule',
    startedAt: '2026-09-13T19:16:07Z', url: 'https://github.com/kvnpt/agora/actions/runs/1',
  });
  // A queued or running run has no conclusion yet, and the panel needs to tell
  // that apart from a failure — it is what "the button worked" looks like.
  assert.equal(r.runs[1].status, 'in_progress');
  assert.equal(r.runs[1].conclusion, null);
});

test('history is readable with no token at all', async () => {
  // A public repository answers this anonymously, and "the extractor last ran
  // on Sunday" is worth showing even where the panel cannot start one.
  const f = spy(runsBody([]));
  const r = await recentExtractionRuns(env({ GITHUB_ACTIONS_TOKEN: undefined }), { fetchImpl: f });
  assert.equal(r.configured, false);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].headers.Authorization, undefined);
});

test('an unreadable history is an empty list with a reason, not a throw', async () => {
  for (const [res, pattern] of [
    [new Response('', { status: 404 }), /private and no token/],
    [new Response('', { status: 500 }), /500/],
    [new Response('not json', { status: 200 }), /not JSON/],
    [new Error('boom'), /Could not reach GitHub/],
  ]) {
    const r = await recentExtractionRuns(env(), { fetchImpl: spy(res) });
    assert.deepEqual(r.runs, []);
    assert.match(r.error, pattern);
  }
});

test('with no repo configured, nothing is attempted and there is no link to give', async () => {
  const f = spy();
  const d = await dispatchExtraction({ GITHUB_ACTIONS_TOKEN: 'x' }, 'k', { fetchImpl: f });
  assert.equal(d.started, false);
  assert.equal(d.dispatchUrl, null);
  assert.match(d.error, /GITHUB_REPO is not set/);

  const h = await recentExtractionRuns({}, { fetchImpl: f });
  assert.deepEqual(h.runs, []);
  assert.equal(h.configured, false);
  assert.equal(f.calls.length, 0);
});

test('both config shapes are read, like every other secret here', async () => {
  // A Worker secret is a string; a Secrets Store binding is an object you
  // await a .get() on. auth.mjs learned this the hard way — an object binding
  // is truthy and would interpolate into a URL as "[object Object]".
  const c = await githubConfig({ GITHUB_REPO: store(REPO), GITHUB_ACTIONS_TOKEN: store('ghp_stored') });
  assert.equal(c.repo, REPO);
  assert.equal(c.token, 'ghp_stored');
  assert.equal(c.dispatchUrl, 'https://github.com/kvnpt/agora/actions/workflows/parish-pdf.yml');
});
