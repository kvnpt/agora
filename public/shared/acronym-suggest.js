// An acronym field that fills itself from the parish's names.
//
// POST /api/admin/acronym-suggestion (worker/lib/acronym-suggest.mjs) answers
// with an acronym no other parish holds and no route shadows — Claude Haiku's
// reading of the names where the deployment has a key, the house rule
// ("St George, Yellow Rock" → sgy) where it does not. This puts it in the field.
//
// It only ever fills a field that is EMPTY, or still holds what it filled
// last: an acronym somebody typed is theirs, and a name changed after a
// suggestion re-suggests only while the suggestion is untouched. The field
// gets an `input` event, so whatever paints its hint (the clash check, the
// orthodoxy.au/… preview) repaints as if it had been typed.
//
// A classic script, like its neighbours: app.js and /admin both load it.
(function (root) {
  if (typeof document === 'undefined') return;

  /**
   * @param {object} o
   * @param {HTMLInputElement} o.input          the acronym field
   * @param {() => {name?: string, full_name?: string, jurisdiction?: string}} o.names
   * @param {Element[]} [o.watch]              fields whose change re-asks (the names)
   * @param {string|null} [o.parishId]         the parish being edited, so its own acronym is no clash
   * @param {(r: {acronym: string, source: string}) => void} [o.onFill]
   * @param {boolean} [o.now]                  ask once straight away
   */
  function wire({ input, names, watch = [], parishId = null, onFill = null, now = false }) {
    if (!input || input.dataset.acronymSuggest) return;
    input.dataset.acronymSuggest = '1';
    let suggested = null;      // what this field was last filled with
    let asked = 0;             // only the latest answer lands

    const untouched = () => !input.value.trim() || (suggested !== null && input.value === suggested);

    async function ask() {
      if (!untouched()) return;
      const n = names() || {};
      if (!String(n.name || '').trim() && !String(n.full_name || '').trim()) return;
      const mine = ++asked;
      input.classList.add('is-suggesting');
      let r = null;
      try {
        const res = await fetch('/api/admin/acronym-suggestion', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...n, parish_id: parishId }),
        });
        if (res.ok) r = await res.json();
      } catch { /* a suggestion that does not come is no suggestion */ }
      if (mine !== asked) return;
      input.classList.remove('is-suggesting');
      // Typed into while it was asking: leave it.
      if (!r || !r.acronym || !untouched()) return;
      input.value = suggested = r.acronym;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      if (onFill) onFill(r);
    }

    watch.filter(Boolean).forEach(el => el.addEventListener('change', ask));
    if (now) ask();
    return { ask };
  }

  root.AgoraAcronymSuggest = { wire };
})(typeof window !== 'undefined' ? window : globalThis);
