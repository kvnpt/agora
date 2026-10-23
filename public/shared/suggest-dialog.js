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
// A poster too (Kevin, 20 Oct 2026). It shows in the dialog the moment it is
// picked, as if it were already on the suggestion, but nothing is uploaded:
// the image waits in this browser's IndexedDB (too big for localStorage, and
// a Blob there stays a Blob) and the suggest page uploads it once Access has
// confirmed the address, has it read with what they wrote beside it, and
// sends the suggestion as an event with its poster.
//
// A card that slides up, like the editors' (form-sheet.js, 23 Oct 2026),
// its Submit in the bar and Cancel turning into Discard once typed in.
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

  /** What is worth keeping from the dialog, or an error to show instead. A poster says enough on its own. */
  function draftFrom(v) {
    const out = {
      kind: 'change',
      about: String(v.about || ''),
      change_body: String(v.change_body || '').trim(),
      name: String(v.name || '').trim(),
      contact: !!v.contact,
      relation: v.contact ? String(v.relation || '').trim() : '',
    };
    if (v.poster) out.poster = true;
    if (!out.contact && !out.change_body && !out.poster) return { error: 'Say what should change.', field: 'change_body' };
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

  // ── the poster, held in this browser until the sign-in ──
  //
  // One per parish, like the draft, and forgotten on the same clock. Every
  // call fails quietly to "no poster": a private window may have no
  // IndexedDB, and the suggestion still goes with what they wrote.

  const DB_NAME = 'agora-suggest';
  const STORE = 'posters';

  function posterStore(mode, idb = root.indexedDB) {
    return new Promise((resolve, reject) => {
      if (!idb) return reject(new Error('no IndexedDB'));
      const req = idb.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(STORE, mode);
        tx.oncomplete = tx.onabort = () => db.close();
        resolve(tx.objectStore(STORE));
      };
    });
  }
  const done = (req) => new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  /** Keep a picked poster for a parish. True if it was kept. */
  async function savePoster(parishId, blob, { idb, now = Date.now() } = {}) {
    try {
      const store = await posterStore('readwrite', idb);
      await done(store.put({ blob, type: blob.type || '', at: now }, parishId));
      return true;
    } catch { return false; }
  }

  /** Read and forget the poster for a parish: null if there is none, or it went stale. */
  async function takePoster(parishId, { idb, now = Date.now() } = {}) {
    try {
      const store = await posterStore('readwrite', idb);
      const v = await done(store.get(parishId));
      store.delete(parishId);
      if (!v || !v.blob || !(now - Number(v.at) < MAX_AGE_MS)) return null;
      return v.blob;
    } catch { return null; }
  }

  async function dropPoster(parishId, { idb } = {}) {
    try { (await posterStore('readwrite', idb)).delete(parishId); } catch { /* nothing kept */ }
  }

  const api = { KEY, MAX_AGE_MS, OTHER_TOPICS, draftFrom, takeDraft, saveDraft, savePoster, takePoster, dropPoster };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AgoraSuggest = api;
  if (typeof document === 'undefined') return;

  // ── the dialog ──

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  let current = null;
  const PICTURE = '<svg class="sg-poster-icon" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="1.75"/><path d="m21 15-5-5L5 21"/></svg>';

  function close() {
    if (current) current.close();
  }

  /**
   * Open the card for one parish (a form card, public/shared/form-sheet.js).
   * `services` are its service times as the suggest page lists them
   * ("Sunday 9:30am · Divine Liturgy"); `href` is where Confirm goes, the
   * link that was tapped. `signInHref`, when given, offers a plain sign-in to
   * somebody who already keeps the parish. `about` picks "What is it about?"
   * for them when the tap already said (an Add + under the service times is
   * 'A service time not listed').
   */
  function open({ parishId, parishName = '', services = [], href = null, signInHref = null, about = '' }) {
    close();
    const target = href || `/admin?suggest=${encodeURIComponent(parishId)}`;
    let preview = null;
    const sheet = root.AgoraFormSheet.open({
      title: 'Suggest an edit',
      sub: parishName,
      cls: 'suggest-dialog',
      onClose: () => {
        if (preview) URL.revokeObjectURL(preview);
        if (current === sheet) current = null;
      },
    });
    current = sheet;
    const wrap = sheet.el;
    sheet.body.innerHTML = `
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
          <div class="edit-row sg-poster">
            <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden data-sg-file>
            <button type="button" class="sg-poster-pick" data-sg-pick>${PICTURE}<span><b>Add a poster</b><small>Or paste one, or drop it here</small></span></button>
            <div class="sg-poster-card" data-sg-card hidden>
              <img class="sg-poster-thumb" alt="Your poster">
              <span class="sg-poster-side"><b>Poster added</b><small>It goes with your suggestion.</small>
                <button type="button" class="sg-poster-remove" data-sg-remove>Remove</button></span>
            </div>
          </div>
          <div class="edit-row">
            <input id="sg-name" name="name" maxlength="120" autocomplete="name" placeholder="Name" aria-label="Name"></div>
          <label class="edit-check sg-check"><input type="checkbox" name="contact">
            <span><b>Add me as a permanent editor</b></span></label>
          <div class="edit-row" data-sg-contact hidden>
            <input id="sg-rel" name="relation" maxlength="120" placeholder="Your role at the parish" aria-label="Your role at the parish"></div>
          <div class="sg-error" role="alert" hidden></div>
          <div class="form-actions">
            <button type="submit" class="btn-save sg-submit" data-fs-label="Submit">Confirm email and submit</button>
          </div>
          <p class="edit-row-hint sg-next">Next, our sign-in (Cloudflare) emails you a one-time code to confirm the address is yours. What you wrote here is sent the moment you are confirmed, and whoever keeps the parish can write back to you. Nothing on the page changes until one of them has looked.</p>
          ${signInHref ? `<p class="edit-row-hint sg-signin">Already keep this parish? <a href="${esc(signInHref)}">Just sign in</a>.</p>` : ''}
        </form>`;

    const form = wrap.querySelector('form');
    const f = form.elements;
    const err = wrap.querySelector('.sg-error');
    const contactRow = wrap.querySelector('[data-sg-contact]');
    const sync = () => { contactRow.hidden = !f.contact.checked; };
    if (about && [...f.about.options].some(o => o.value === about)) f.about.value = about;
    form.addEventListener('change', sync);

    // The poster: on the dialog at once, from the file itself. It is not
    // shrunk or sent here; the suggest page does both, after the sign-in.
    let poster = null;
    const fileInput = wrap.querySelector('[data-sg-file]');
    const pick = wrap.querySelector('[data-sg-pick]');
    const card = wrap.querySelector('[data-sg-card]');
    const thumb = card.querySelector('img');
    const setPoster = (file) => {
      if (preview) { URL.revokeObjectURL(preview); preview = null; }
      poster = file || null;
      if (poster) thumb.src = preview = URL.createObjectURL(poster);
      else { thumb.removeAttribute('src'); fileInput.value = ''; }
      card.hidden = !poster;
      pick.hidden = !!poster;
    };
    const addPoster = (file) => {
      if (!file) return;
      if (!/^image\//.test(file.type || '')) {
        err.textContent = 'That is not an image. Add a photo or a scan of the poster.';
        err.hidden = false;
        return;
      }
      err.hidden = true;
      setPoster(file);
    };
    pick.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => addPoster(fileInput.files[0]));
    card.querySelector('[data-sg-remove]').addEventListener('click', () => setPoster(null));
    wrap.addEventListener('dragover', (e) => { e.preventDefault(); pick.classList.add('is-dragging'); });
    wrap.addEventListener('dragleave', (e) => { if (e.target === wrap) pick.classList.remove('is-dragging'); });
    wrap.addEventListener('drop', (e) => {
      e.preventDefault();
      pick.classList.remove('is-dragging');
      addPoster(e.dataTransfer && e.dataTransfer.files[0]);
    });
    form.addEventListener('paste', (e) => {
      const img = e.clipboardData && [...(e.clipboardData.files || [])].find(x => /^image\//.test(x.type));
      if (!img) return;
      e.preventDefault();
      addPoster(img);
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = {};
      for (const n of FIELDS) v[n] = f[n] ? f[n].value : '';
      v.contact = f.contact.checked;
      v.poster = !!poster;
      const r = draftFrom(v);
      if (r.error) {
        err.textContent = r.error;
        err.hidden = false;
        if (f[r.field]) f[r.field].focus();
        return;
      }
      const btn = wrap.querySelector('.sg-submit');
      btn.disabled = true;
      // Kept in this browser — the same origin the suggest page is on — and
      // read back there once Access has let them through. A poster that
      // cannot be kept (no IndexedDB here) is said plainly, rather than lost
      // on the way through the sign-in.
      if (poster && !(await savePoster(parishId, poster))) {
        btn.disabled = false;
        err.textContent = 'This browser could not keep the poster through the sign-in. Remove it and send what you wrote, then add the poster on the next page.';
        err.hidden = false;
        return;
      }
      if (!poster) dropPoster(parishId);
      saveDraft(parishId, r.draft);
      btn.textContent = 'Going to confirm your email…';
      root.location.href = target;
    });
    // Not on a phone: the keyboard would come up over the card before they chose to type.
    if (!root.AgoraFormSheet.touchFirst()) setTimeout(() => f.change_body.focus({ preventScroll: true }), 50);
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
    // Without the form card (a page that does not load it), the link itself.
    if (!parishId || !root.AgoraFormSheet) return;
    e.preventDefault();
    const services = typeof api.servicesFor === 'function' ? (api.servicesFor(parishId) || []) : [];
    open({ parishId, parishName: a.dataset.parishName || '', services, href: a.href });
  });

  Object.assign(api, { open, close });
})(typeof globalThis !== 'undefined' ? globalThis : this);
