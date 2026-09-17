// Starting and watching the "Extract parish PDFs" workflow from /admin.
//
// WHY THE PANEL NEEDS THIS AT ALL. The Worker cannot read a PDF — that is the
// whole reason the extraction is a GitHub Action, and docs/adapters.md argues
// it at length. But it left the panel with a card that says "out of dates" and
// a button that cannot help: **Run now** on a PDF adapter re-reads an R2 object
// only the Action can rewrite, so the one control on the card was guaranteed
// not to be the fix. The remedy lived on a website the operator may not have an
// account for.
//
// So the panel gets a second button, and this is the thin client behind it. It
// does exactly two things: start the workflow for ONE source key, and report
// what the last few runs did.
//
// FAILING SOFT IS THE POINT. A deployment with no token is the normal case
// until somebody sets one, and it must not look broken: every function here
// answers `{ configured: false, dispatchUrl }` instead of throwing, and the
// panel falls back to a link to the workflow page. That link still needs a
// GitHub account, which is the thing this exists to avoid — but it is an
// honest degradation and it is what today already asks for, minus the treasure
// hunt.
//
// THE TOKEN. A fine-grained personal access token scoped to this repository
// alone, with Actions: read and write, as a Worker secret named
// GITHUB_ACTIONS_TOKEN. It can start this workflow and read run history; it
// cannot read code, write contents, or touch another repository. Set the
// repository with the GITHUB_REPO var in wrangler.toml — it is an identifier,
// not a secret, and seeing it in a config file beats guessing at it.

import { readSecret } from './secrets.mjs';

/** The workflow file, which is also its API id. */
export const WORKFLOW_FILE = 'parish-pdf.yml';

// GitHub refuses a request with no User-Agent, and a named one makes this
// deployment identifiable in their logs rather than anonymous traffic.
const UA = 'Agora-OrthodoxEventFinder/1.0 (orthodoxy.au)';

const api = (repo, path) => `https://api.github.com/repos/${repo}/actions/${path}`;

/** Where a person goes when this Worker cannot do it for them. */
export const workflowPageUrl = (repo) =>
  `https://github.com/${repo}/actions/workflows/${WORKFLOW_FILE}`;

/**
 * Resolve the configuration, without deciding whether it is usable.
 *
 * A repo with no token is still worth having: the deep link needs it, and the
 * run history is readable without credentials on a public repository.
 */
export async function githubConfig(env) {
  const repo = (await readSecret(env.GITHUB_REPO)) || null;
  const token = (await readSecret(env.GITHUB_ACTIONS_TOKEN)) || null;
  return { repo, token, dispatchUrl: repo ? workflowPageUrl(repo) : null };
}

const headers = (token) => ({
  'Accept': 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': UA,
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
});

/**
 * Start the extraction for one source key.
 *
 * Returns `{ started: true }`, or `{ started: false, ... }` with a reason a
 * person can act on. Never throws: this is wired to a button, and a button that
 * turns into a 500 teaches nothing.
 *
 * `key` names ONE entry in PDF_SOURCES. The workflow takes it as an input and
 * extracts only that parish, so re-fetching Blacktown does not also re-fetch
 * every other parish's website.
 */
export async function dispatchExtraction(env, key, { fetchImpl = fetch } = {}) {
  const { repo, token, dispatchUrl } = await githubConfig(env);
  if (!repo) {
    return { started: false, configured: false, dispatchUrl: null,
      error: 'GITHUB_REPO is not set on this deployment, so the panel cannot start the extraction.' };
  }
  if (!token) {
    return { started: false, configured: false, dispatchUrl,
      error: 'GITHUB_ACTIONS_TOKEN is not set, so the panel cannot start the extraction. Run it from GitHub instead.' };
  }

  let res;
  try {
    res = await fetchImpl(api(repo, `workflows/${WORKFLOW_FILE}/dispatches`), {
      method: 'POST',
      headers: { ...headers(token), 'Content-Type': 'application/json' },
      // `ref` is the branch the workflow runs FROM, which has to be the default
      // branch: that is where pdf-sources.mjs is authoritative, and extracting
      // against a feature branch would fetch whatever URL that branch happens
      // to remember.
      body: JSON.stringify({ ref: 'main', inputs: { key } }),
    });
  } catch (err) {
    return { started: false, configured: true, dispatchUrl, error: `Could not reach GitHub: ${err.message}` };
  }

  // 204 is the documented success. There is no run id in the response — the
  // dispatch is fire-and-forget — so the panel finds the run by polling the
  // list afterwards.
  if (res.status === 204) return { started: true, configured: true, dispatchUrl };

  const detail = await res.text().catch(() => '');
  const reason = res.status === 404
    // 404 is what a token without Actions access gets, as well as a wrong repo.
    // Naming both beats reporting "not found" for a repository that is plainly
    // there.
    ? 'GitHub answered 404 — either GITHUB_REPO is wrong or the token has no Actions access to it.'
    : `GitHub refused the request (${res.status}). ${detail.slice(0, 200)}`;
  return { started: false, configured: true, dispatchUrl, error: reason };
}

/**
 * The most recent runs of the extraction workflow.
 *
 * Read WITHOUT a token where none is set — a public repository answers this
 * anonymously, and a card that can say "the extractor last ran on Sunday and
 * succeeded" is worth having even on a deployment that cannot start one.
 */
export async function recentExtractionRuns(env, { fetchImpl = fetch, limit = 5 } = {}) {
  const { repo, token, dispatchUrl } = await githubConfig(env);
  if (!repo) return { configured: false, dispatchUrl: null, runs: [] };

  let res;
  try {
    res = await fetchImpl(api(repo, `workflows/${WORKFLOW_FILE}/runs?per_page=${limit}`), {
      headers: headers(token),
    });
  } catch (err) {
    return { configured: !!token, dispatchUrl, runs: [], error: `Could not reach GitHub: ${err.message}` };
  }
  if (!res.ok) {
    return {
      configured: !!token, dispatchUrl, runs: [],
      error: res.status === 404
        ? 'GitHub answered 404 for the workflow — the repository may be private and no token is set.'
        // Anonymous reads are rate-limited to 60 an hour per IP, so a
        // deployment with no token can get this simply by being on a busy
        // network. Worth saying, because the fix is a token rather than a retry.
        : res.status === 403
          ? 'GitHub answered 403 — an anonymous read was refused or rate-limited. Set GITHUB_ACTIONS_TOKEN to read this reliably.'
          : `GitHub answered ${res.status}.`,
    };
  }

  let body;
  try { body = await res.json(); } catch { return { configured: !!token, dispatchUrl, runs: [], error: 'GitHub sent something that is not JSON.' }; }

  const runs = (body.workflow_runs || []).map(r => ({
    id: r.id,
    // 'completed' plus a conclusion, or 'in_progress'/'queued' with none yet.
    // The panel distinguishes them: a queued run is the button working.
    status: r.status,
    conclusion: r.conclusion || null,
    event: r.event,
    startedAt: r.run_started_at || r.created_at,
    url: r.html_url,
  }));
  return { configured: !!token, dispatchUrl, runs };
}
