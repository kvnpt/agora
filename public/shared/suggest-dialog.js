// "Suggest edits", asked before the sign-in rather than after it.
//
// /admin?suggest= is behind Cloudflare Access, so the link used to drop a
// reader straight onto a sign-in page with nothing said: an email box, from
// a company they had not heard of, before they had written a word. Most left
// there. Now the link opens this dialog first, on the page they are reading
// (the app's parish card, or the lite card a shared link lands on): what
// should change, their name, and the offer to keep the parish's page
// themselves. Only then "Confirm email and submit" goes through Access — and
// what they wrote goes with them, kept in this browser, filled into the
// suggest page and sent as soon as Access has confirmed the address
// (admin.html, suggestPage). Nothing is posted before then, because nothing
// can be: the suggestion is filed under the address Access verified.
//
// Few words on purpose: the fields say what they are as placeholders, and
// the one box says what it asks (Kevin's markup of 19 Oct 2026).
//
// Classic script, the dual shape of its neighbours: the draft helpers are a
// module export for the tests (d1/suggest-dialog.test.mjs), the dialog a
// browser global that the app, the lite card and /admin all load.
(function (root) {
  const KEY = (pid) => `agora-suggest-draft:${pid}`;
  // A draft older than this was abandoned at the sign-in page, not delayed by it.
  const MAX_AGE_MS = 2 * 3600 * 1000;
  // The suggest form's own options, word for word, so a choice made here is
  // the one selected there (admin.html, suggestPage).
  const OTHER_TOPICS = [
    'A service time not listed',
    'An event',
    "The parish's details — address, phone, website",
    'Something else',
  ];
  const FIELDS = ['about', 'change_body', 'name', 'relation'];

  /** What is worth keeping from the dialog, or an error to show instead. */
  function draftFrom(v) {
    const out = {
      kind: 'change',
      about: String(v.about || ''),
      change_body: String(v.change_body || '').trim(),
      name: String(v.name || '').trim(),
      contact: !!v.contact,
      relation: v.contact ? String(v.relation || '').trim() : '',
    };
    if (!out.contact && !out.change_body) return { error: 'Say what should change.', field: 'change_body' };
    if (out.contact && !out.name) return { error: 'Tell us your name, so the owner knows who is asking.', field: 'name' };
    return { draft: out };
  }

  /** Read and forget the draft for a parish: null if there is none, or it went stale. */
  function takeDraft(parishId, storage = root.localStorage, now = Date.now()) {
    let v = null;
    try {
      v = JSON.parse(storage.getItem(KEY(parishId)) || 'null');
      storage.removeItem(KEY(parishId));
    } catch { return null; }
    if (!v || typeof v !== 'object' || !(now - Number(v.at) < MAX_AGE_MS)) return null;
    return v;
  }

  function saveDraft(parishId, draft, storage = root.localStorage, now = Date.now()) {
    try { storage.setItem(KEY(parishId), JSON.stringify({ ...draft, submit: true, at: now })); return true; } catch { return false; }
  }

  const api = { KEY, MAX_AGE_MS, OTHER_TOPICS, draftFrom, takeDraft, saveDraft };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AgoraSuggest = api;
  if (typeof document === 'undefined') return;

  // ── the dialog ──

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  let current = null;

  function close() {
    if (!current) return;
    current.remove();
    current = null;
    document.removeEventListener('keydown', onKey, true);
  }
  function onKey(e) {
    if (e.key === 'Escape' && current) { e.stopPropagation(); close(); }
  }

  /**
   * Open the dialog for one parish. `services` are its service times as the
   * suggest page lists them ("Sunday 9:30am · Divine Liturgy"); `href` is
   * where Confirm goes, the link that was tapped. `signInHref`, when given,
   * offers a plain sign-in to somebody who already keeps the parish. `about`
   * picks "What is it about?" for them when the tap already said (an Add +
   * under the service times is 'A service time not listed').
   */
  function open({ parishId, parishName = '', services = [], href = null, signInHref = null, about = '' }) {
    close();
    const target = href || `/admin?suggest=${encodeURIComponent(parishId)}`;
    const wrap = document.createElement('div');
    wrap.className = 'escalate-backdrop open suggest-dialog';
    wrap.innerHTML = `
      <div class="escalate-modal form-modal" role="dialog" aria-modal="true" aria-labelledby="sg-title">
        <button class="donate-close" type="button" aria-label="Close" data-sg-close>&times;</button>
        <h2 id="sg-title">Suggest an edit</h2>
        ${parishName ? `<div class="escalate-modal-sub">${esc(parishName)}</div>` : ''}
        <form class="detail-edit-form sg-form" novalidate>
          <div class="edit-row">
            <select id="sg-about" name="about" aria-label="What is it about? (optional)">
              <option value="">What is it about?</option>
              ${services.length ? `<optgroup label="Service times">${services.map(o => `<option>${esc(o)}</option>`).join('')}</optgroup>` : ''}
              <optgroup label="${services.length ? 'Something else' : 'What part of the page'}">
                ${OTHER_TOPICS.map(o => `<option>${esc(o)}</option>`).join('')}
              </optgroup>
            </select></div>
          <div class="edit-row">
            <textarea id="sg-body" name="change_body" rows="4" maxlength="2000" placeholder="Details" aria-label="Details"></textarea></div>
          <div class="edit-row">
            <input id="sg-name" name="name" maxlength="120" autocomplete="name" placeholder="Name" aria-label="Name"></div>
          <label class="edit-check sg-check"><input type="checkbox" name="contact">
            <span><b>Add me as a permanent editor</b></span></label>
          <div class="edit-row" data-sg-contact hidden>
            <input id="sg-rel" name="relation" maxlength="120" placeholder="Your role at the parish" aria-label="Your role at the parish"></div>
          <div class="sg-error" role="alert" hidden></div>
          <div class="form-actions">
            <button type="submit" class="btn-save sg-submit">Confirm email and submit</button>
            <button type="button" class="btn-outline" data-sg-close>Cancel</button>
          </div>
          <p class="edit-row-hint sg-next">Next, our sign-in (Cloudflare) emails you a one-time code to confirm the address is yours. What you wrote here is sent the moment you are confirmed, and whoever keeps the parish can write back to you. Nothing on the page changes until one of them has looked.</p>
          ${signInHref ? `<p class="edit-row-hint sg-signin">Already keep this parish? <a href="${esc(signInHref)}">Just sign in</a>.</p>` : ''}
        </form>
      </div>`;
    document.body.appendChild(wrap);
    current = wrap;
    document.addEventListener('keydown', onKey, true);

    const form = wrap.querySelector('form');
    const f = form.elements;
    const err = wrap.querySelector('.sg-error');
    const contactRow = wrap.querySelector('[data-sg-contact]');
    const sync = () => { contactRow.hidden = !f.contact.checked; };
    if (about && [...f.about.options].some(o => o.value === about)) f.about.value = about;
    form.addEventListener('change', sync);
    wrap.addEventListener('click', (e) => {
      if (e.target === wrap || e.target.closest('[data-sg-close]')) close();
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = {};
      for (const n of FIELDS) v[n] = f[n] ? f[n].value : '';
      v.contact = f.contact.checked;
      const r = draftFrom(v);
      if (r.error) {
        err.textContent = r.error;
        err.hidden = false;
        if (f[r.field]) f[r.field].focus();
        return;
      }
      // Kept in this browser — the same origin the suggest page is on — and
      // read back there once Access has let them through.
      saveDraft(parishId, r.draft);
      const btn = wrap.querySelector('.sg-submit');
      btn.disabled = true;
      btn.textContent = 'Going to confirm your email…';
      root.location.href = target;
    });
    setTimeout(() => f.change_body.focus({ preventScroll: true }), 50);
    return wrap;
  }

  /** The parish a suggest link is for, from its href. */
  function parishOfLink(a) {
    try { return new URL(a.href, root.location.href).searchParams.get('suggest'); } catch { return null; }
  }

  // Any "Suggest edits" link on the page opens the dialog instead of leaving.
  // A modified click (a new tab) still follows the link: the suggest page
  // asks the same questions after the sign-in.
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a.ps-contribute');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const parishId = parishOfLink(a);
    if (!parishId) return;
    e.preventDefault();
    const services = typeof api.servicesFor === 'function' ? (api.servicesFor(parishId) || []) : [];
    open({ parishId, parishName: a.dataset.parishName || '', services, href: a.href });
  });

  Object.assign(api, { open, close });
})(typeof globalThis !== 'undefined' ? globalThis : this);
