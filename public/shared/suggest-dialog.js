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
// Or on WhatsApp alone (Kevin, 6 Nov 2026: no email at all). Where the site
// has Agora's number, "No email? Confirm on WhatsApp" holds what they wrote
// on the site under a code (POST /api/suggest/whatsapp, outside Access) and
// opens WhatsApp with a message that carries it. The phone that sends it is
// who it is from, and the suggestion goes the moment the message arrives
// (worker/routes/ingest.mjs). Their poster goes up with it, unread until
// then. The card waits, says when it has gone, and can be closed: closing
// it sends nothing and stops nothing.
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

  /**
   * What "Confirm on WhatsApp" holds for them, from a draft: as the suggest
   * page sends it after the sign-in (admin.html). With a poster it is an
   * event, and what they wrote is its details, a service time it names
   * first; without one, the change.
   */
  function whatsappPayload(parishId, d) {
    const topic = d.about && !OTHER_TOPICS.includes(d.about) ? d.about : '';
    const body = d.poster ? [topic, d.change_body].map(x => String(x || '').trim()).filter(Boolean).join(': ') : d.change_body;
    return { parish_id: parishId, about: d.about || '', body, name: d.name, poster: !!d.poster };
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

  const api = { KEY, MAX_AGE_MS, OTHER_TOPICS, draftFrom, whatsappPayload, takeDraft, saveDraft, savePoster, takePoster, dropPoster };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AgoraSuggest = api;
  if (typeof document === 'undefined') return;

  // ── the dialog ──

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  let current = null;
  const CHAT = '<svg class="sg-wa-icon" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11.5a8 8 0 0 1-11.8 7L4 20l1.5-4.1A8 8 0 1 1 20 11.5Z"/></svg>';
  const PICTURE = '<svg class="sg-poster-icon" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="1.75"/><path d="m21 15-5-5L5 21"/></svg>';

  function close() {
    if (current) current.close();
  }

  // Whether this site has Agora's WhatsApp number: asked once a page.
  let whatsappAsked = null;
  const whatsapp = () => whatsappAsked || (whatsappAsked = fetch('/api/suggest/whatsapp', { cache: 'no-store' })
    .then(r => (r.ok ? r.json() : null)).then(b => (b && b.ready ? b : null)).catch(() => null));

  /**
   * A poster small enough to send (the editor's shrink, when the page has
   * it): a phone's photo can be twice what the reader takes.
   */
  async function shrink(file) {
    if (root.AgoraEventEditor && root.AgoraEventEditor.shrinkPoster) {
      try { return await root.AgoraEventEditor.shrinkPoster(file); } catch { return file; }
    }
    if (file.size <= 1.5 * 1024 * 1024 && /^image\/(jpeg|png|webp)$/.test(file.type)) return file;
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = reject;
        i.src = url;
      });
      const scale = Math.min(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      return (await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.85))) || file;
    } catch { return file; } finally { URL.revokeObjectURL(url); }
  }

  /**
   * Open the card for one parish (a form card, public/shared/form-sheet.js).
   * `services` are its service times as the suggest page lists them
   * ("Sunday 9:30am · Divine Liturgy"); `href` is where Confirm goes, the
   * link that was tapped. `signInHref`, when given, offers a plain sign-in to
   * somebody who already keeps the parish. `about` picks "What is it about?"
   * for them when the tap already said (an Add + under the service times is
   * 'A service time not listed'). `editor` ticks "Add me as a permanent
   * editor" for them.
   *
   * Opened from no parish (the foot of the page's "Become an editor"), it
   * asks which first: `parishes` are the groups to choose from, as
   * [{ label, parishes: [{ id, name }] }], with `parishId`, if any, chosen
   * already. A service time to pick comes with the parish picked, from
   * `servicesFor` when the page gives it one.
   */
  function open({ parishId, parishName = '', services = [], href = null, signInHref = null, about = '', editor = false, parishes = null, title = 'Suggest an edit' }) {
    close();
    const picking = Array.isArray(parishes) && parishes.length > 0;
    let pid = parishId || '';
    let preview = null;
    // Typed in, and not yet handed to WhatsApp: Cancel asks before it goes.
    let typed = false, handed = false, polling = null;
    const sheet = root.AgoraFormSheet.open({
      title,
      sub: picking ? '' : parishName,
      cls: 'suggest-dialog',
      leave: () => (typed && !handed ? [{ label: 'Discard', danger: true, run: () => sheet.close() }] : null),
      onClose: () => {
        if (preview) URL.revokeObjectURL(preview);
        if (polling) polling();
        if (current === sheet) current = null;
      },
    });
    current = sheet;
    const wrap = sheet.el;
    const aboutOptions = (list) => `
              <option value="">What is it about?</option>
              ${list.length ? `<optgroup label="Service times">${list.map(o => `<option>${esc(o)}</option>`).join('')}</optgroup>` : ''}
              <optgroup label="${list.length ? 'Something else' : 'What part of the page'}">
                ${OTHER_TOPICS.map(o => `<option>${esc(o)}</option>`).join('')}
              </optgroup>`;
    const servicesOf = (id) => (id && typeof api.servicesFor === 'function' ? (api.servicesFor(id) || []) : []);
    if (picking) services = servicesOf(pid);
    sheet.body.innerHTML = `
        <form class="detail-edit-form sg-form" novalidate>
          ${picking ? `<div class="edit-row">
            <select id="sg-parish" name="parish" aria-label="Which parish?">
              <option value="">Which parish?</option>
              ${parishes.map(g => `<optgroup label="${esc(g.label)}">${g.parishes.map(p => `<option value="${esc(p.id)}"${p.id === pid ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</optgroup>`).join('')}
            </select></div>` : ''}
          <div class="edit-row">
            <select id="sg-about" name="about" aria-label="What is it about? (optional)">${aboutOptions(services)}
            </select></div>
          <div class="edit-row">
            <textarea id="sg-body" name="change_body" rows="4" maxlength="2000" placeholder="Details" aria-label="Details"></textarea></div>
          <div class="edit-row sg-poster">
            <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden data-sg-file>
            <button type="button" class="sg-poster-pick" data-sg-pick>${PICTURE}<span><b>Add an image</b><small>A poster or flyer. Or paste one, or drop it here</small></span></button>
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
          <div class="sg-wa" data-sg-wa hidden>
            <button type="button" class="sg-wa-pick" data-sg-wa-go>${CHAT}<span><b>No email? Confirm on WhatsApp</b><small>Send one message from your phone instead</small></span></button>
          </div>
          ${signInHref ? `<p class="edit-row-hint sg-signin">Already keep this parish? <a href="${esc(signInHref)}">Just sign in</a>.</p>` : ''}
        </form>`;

    const form = wrap.querySelector('form');
    const f = form.elements;
    const err = wrap.querySelector('.sg-error');
    const contactRow = wrap.querySelector('[data-sg-contact]');
    const waRow = wrap.querySelector('[data-sg-wa]');
    let wa = null;
    // Becoming an editor is an account, and an account an email: WhatsApp
    // alone sends a suggestion, so it is not offered with the box ticked.
    const sync = () => {
      contactRow.hidden = !f.contact.checked;
      waRow.hidden = !wa || f.contact.checked;
    };
    const typing = (e) => { if (e.isTrusted) typed = true; };
    form.addEventListener('input', typing);
    form.addEventListener('change', typing);
    whatsapp().then((ready) => { wa = ready; if (current === sheet) sync(); });
    if (about && [...f.about.options].some(o => o.value === about)) f.about.value = about;
    f.contact.checked = !!editor;
    sync();
    form.addEventListener('change', sync);
    // Another parish, its own service times; what was chosen stays chosen where it can.
    if (picking) f.parish.addEventListener('change', () => {
      pid = f.parish.value;
      const was = f.about.value;
      f.about.innerHTML = aboutOptions(servicesOf(pid));
      if ([...f.about.options].some(o => o.value === was)) f.about.value = was;
    });

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

    /** The form as a draft, or null when it says what is missing. */
    const checked = () => {
      if (!pid) {
        err.textContent = 'Choose the parish.';
        err.hidden = false;
        f.parish.focus();
        return null;
      }
      const v = {};
      for (const n of FIELDS) v[n] = f[n] ? f[n].value : '';
      v.contact = f.contact.checked;
      v.poster = !!poster;
      const r = draftFrom(v);
      if (r.error) {
        err.textContent = r.error;
        err.hidden = false;
        if (f[r.field]) f[r.field].focus();
        return null;
      }
      return r;
    };

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const r = checked();
      if (!r) return;
      const btn = wrap.querySelector('.sg-submit');
      btn.disabled = true;
      // Kept in this browser — the same origin the suggest page is on — and
      // read back there once Access has let them through. A poster that
      // cannot be kept (no IndexedDB here) is said plainly, rather than lost
      // on the way through the sign-in.
      if (poster && !(await savePoster(pid, poster))) {
        btn.disabled = false;
        err.textContent = 'This browser could not keep the poster through the sign-in. Remove it and send what you wrote, then add the poster on the next page.';
        err.hidden = false;
        return;
      }
      if (!poster) dropPoster(pid);
      saveDraft(pid, r.draft);
      btn.textContent = 'Going to confirm your email…';
      root.location.href = href || `/admin?suggest=${encodeURIComponent(pid)}`;
    });

    // ── or on WhatsApp ──
    const waGo = wrap.querySelector('[data-sg-wa-go]');
    waGo.addEventListener('click', async () => {
      const r = checked();
      if (!r || !wa) return;
      err.hidden = true;
      waGo.disabled = true;
      const fail = (msg) => { waGo.disabled = false; err.textContent = msg; err.hidden = false; };
      const made = await fetch('/api/suggest/whatsapp', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(whatsappPayload(pid, r.draft)),
      }).then(res => res.json().then(b => ({ ok: res.ok, b }))).catch(() => null);
      if (!made || !made.ok) return fail((made && made.b && made.b.error) || 'That did not reach the site. Try again.');
      const t = made.b;
      if (poster) {
        const blob = await shrink(poster);
        const up = await fetch(`/api/suggest/whatsapp/${encodeURIComponent(t.secret)}/poster`, {
          method: 'POST', headers: { 'content-type': blob.type || 'image/jpeg' }, body: blob,
        }).then(res => res.json().then(b => ({ ok: res.ok, b }))).catch(() => null);
        if (!up || !up.ok) return fail(`${(up && up.b && up.b.error) || 'Your poster did not reach the site.'} Remove it and send what you wrote, or try again.`);
      }
      handed = true;
      dropPoster(pid);
      waiting(t);
    });

    /** Their message to send, and the card watching for it to arrive. */
    function waiting(t) {
      const name = parishName || ((f.parish && f.parish.selectedOptions[0]) || {}).textContent || 'the parish';
      const shown = `+${t.number}`;
      sheet.body.innerHTML = `
        <div class="sg-wa-step">
          <p class="sg-wa-lead"><b>Send this on WhatsApp</b></p>
          <p class="sg-wa-msg">${esc(t.text)}</p>
          <a class="sg-wa-open" href="${esc(t.url)}" target="_blank" rel="noopener">${CHAT}<span>Open WhatsApp</span></a>
          <p class="edit-row-hint">WhatsApp opens with it written, to Agora's number: just send it. On another phone, send it to ${esc(shown)} in the next half hour. What you wrote goes to whoever keeps ${esc(name)} the moment it arrives, from your WhatsApp number, and they can write back to you there. Nothing on the page changes until one of them has looked.</p>
          <p class="sg-wa-status" data-sg-wa-status aria-live="polite">Waiting for your message. You can close this: it still goes when you send it.</p>
        </div>`;
      // Nothing here is undone by leaving: the bar's way out says so.
      const way = wrap.querySelector('[data-frame-cancel]');
      if (way) way.textContent = 'Close';
      const status = sheet.body.querySelector('[data-sg-wa-status]');
      const until = Date.parse(t.expires_at) || (Date.now() + 30 * 60e3);
      let stopped = false, timer = null;
      const stop = () => { stopped = true; clearTimeout(timer); document.removeEventListener('visibilitychange', ask); };
      polling = stop;
      const ask = async () => {
        clearTimeout(timer);
        if (stopped || document.hidden) return;
        const b = await fetch(`/api/suggest/whatsapp/${encodeURIComponent(t.secret)}`, { cache: 'no-store' })
          .then(res => res.json()).catch(() => null);
        if (stopped) return;
        const st = b && b.status;
        if (st === 'sent') {
          stop();
          status.classList.add('is-done');
          status.innerHTML = `<b>Sent. Thank you.</b> It's with whoever keeps ${esc(name)} now. WhatsApp has the message we sent back.`;
          return;
        }
        if (st === 'refused') {
          stop();
          status.classList.add('is-error');
          status.textContent = 'Your message arrived, but it could not be sent on. WhatsApp has the message we sent back saying why.';
          return;
        }
        if (st === 'expired' || Date.now() > until) {
          stop();
          status.classList.add('is-error');
          status.textContent = 'That code has run out. Close this and send your suggestion again.';
          return;
        }
        timer = setTimeout(ask, st === 'sending' ? 1500 : 3000);
      };
      // Back from WhatsApp: asked at once, rather than at the next tick.
      document.addEventListener('visibilitychange', ask);
      timer = setTimeout(ask, 3000);
    }
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
