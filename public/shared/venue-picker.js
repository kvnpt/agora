// Where an event or a service is held, chosen — the one control every form
// that asks uses: a rule's form, Add schedule, an event's edit dialog and the
// add-event editor's cards (in the app and in /admin).
//
// Three answers, as worker/lib/venues.mjs reads them:
//
//   At the parish     nothing set; the parish's church
//   Another parish    one parish on file, picked from a list nearest-first and
//                     searched by name or suburb — the way Combine picks them
//   Somewhere else    the place in words, and a pin: looked up from the
//                     address (POST /api/admin/geocode, the parish form's own
//                     lookup) or put on the door by hand where the host offers
//                     a map (`pickPin`). Typing new words drops a looked-up pin
//                     — it described the old address — but never a hand-placed
//                     one, the rule the parish form keeps.
//
// The value is the four fields a request sends: location_parish_id,
// location_override, location_lat, location_lng. `onChange` hears every change.
(function (root) {
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const EMPTY = { location_parish_id: null, location_override: null, location_lat: null, location_lng: null };
  const MAX_LIST = 8;

  const km = (a, b) => {
    if (!a || !b || a.lat == null || b.lat == null) return Infinity;
    const r = Math.PI / 180;
    const x = (b.lng - a.lng) * r * Math.cos(((a.lat + b.lat) / 2) * r);
    const y = (b.lat - a.lat) * r;
    return Math.sqrt(x * x + y * y) * 6371;
  };

  // The suburb out of an address: the last part that is not a state, a
  // postcode or a country, with any state and postcode trailing it taken off
  // — "12/14 Balmoral Ave, Croydon Park, NSW 2133" is Croydon Park.
  const NOT_A_PLACE = /^(n\.?s\.?w\.?|vic|qld|s\.?a|w\.?a|tas|n\.?t|a\.?c\.?t|australia|new zealand|nz|\d{4})$/i;
  const STATE_TAIL = /\s+(n\.?s\.?w\.?|vic|qld|sa|wa|tas|nt|act)\.?(\s+\d{4})?$|\s+\d{4}$/i;
  function suburbOf(address) {
    const parts = String(address || '').split(',').map(x => x.trim().replace(STATE_TAIL, '').trim()).filter(Boolean);
    for (let i = parts.length - 1; i >= 0; i--) {
      if (!NOT_A_PLACE.test(parts[i]) && !/^\d/.test(parts[i])) return parts[i];
    }
    return '';
  }

  /** Which of the three a value is. */
  const modeOf = (v) => (v.location_parish_id ? 'parish'
    : (v.location_override || v.location_lat != null) ? 'custom' : 'home');

  /**
   * @param {HTMLElement} el
   * @param {object} o
   *   value      the four fields, as stored
   *   host       the parish running it: {id, name, lat, lng}
   *   parishes   every parish on file: [{id, name, address, lat, lng, jurisdiction}]
   *   geocode    async (address) => {lat, lng} | null — omitted, no lookup
   *   pickPin    ({lat, lng, title}, done) => void — omitted, no map
   *   onChange   (value) => void
   */
  function mount(el, o) {
    const st = {
      v: { ...EMPTY, ...(o.value || {}) },
      mode: null,
      q: '',
      manualPin: false,
      status: '',
    };
    st.mode = modeOf(st.v);
    const host = o.host || {};
    const others = (o.parishes || []).filter(p => p && p.id && p.id !== host.id && p.id !== '_unassigned');

    el.classList.add('vp');
    el.innerHTML = `
      <div class="vp-modes" role="radiogroup" aria-label="Where it is held">
        <button type="button" role="radio" data-vp-mode="home">At ${esc(host.name ? 'the parish' : 'home')}</button>
        <button type="button" role="radio" data-vp-mode="parish">Another parish</button>
        <button type="button" role="radio" data-vp-mode="custom">Somewhere else</button>
      </div>
      <div class="vp-pane" data-vp-pane="parish" hidden>
        <input class="vp-search" type="search" placeholder="Search parishes by name or suburb" autocomplete="off">
        <div class="vp-list" role="listbox"></div>
      </div>
      <div class="vp-pane" data-vp-pane="custom" hidden>
        <input class="vp-text" placeholder="The place and its address — Bankstown Sports Club, 8 Greenfield Pde, Bankstown" autocomplete="off">
        <div class="vp-actions">
          ${o.geocode ? '<button type="button" class="vp-btn" data-vp-act="lookup">Look up the address</button>' : ''}
          ${o.pickPin ? '<button type="button" class="vp-btn" data-vp-act="pin">Move the pin</button>' : ''}
        </div>
        <div class="vp-status" aria-live="polite"></div>
      </div>`;
    const $ = (sel) => el.querySelector(sel);
    $('.vp-text').value = st.v.location_override || '';

    const emit = () => { if (o.onChange) o.onChange({ ...st.v }); };

    function renderList() {
      const q = st.q.trim().toLowerCase();
      const chosen = st.v.location_parish_id;
      let list = others
        .filter(p => !q || `${p.name} ${p.address || ''} ${p.jurisdiction || ''}`.toLowerCase().includes(q))
        .sort((a, b) => km(host, a) - km(host, b) || String(a.name).localeCompare(String(b.name)));
      // The chosen one always shows, first.
      const picked = others.find(p => p.id === chosen);
      list = list.filter(p => p.id !== chosen).slice(0, picked ? MAX_LIST - 1 : MAX_LIST);
      if (picked) list.unshift(picked);
      $('.vp-list').innerHTML = list.length ? list.map(p => {
        const d = km(host, p);
        // The suburb only where the name does not already say it.
        const sub = suburbOf(p.address);
        const where = sub && !String(p.name).toLowerCase().includes(sub.toLowerCase()) ? sub : '';
        return `<button type="button" role="option" class="vp-item${p.id === chosen ? ' on' : ''}" data-vp-parish="${esc(p.id)}" aria-selected="${p.id === chosen}">
          <span class="vp-name">${esc(p.name)}</span>
          <span class="vp-meta">${esc([where, Number.isFinite(d) ? `${d < 10 ? d.toFixed(1) : Math.round(d)} km` : ''].filter(Boolean).join(' · '))}</span>
        </button>`;
      }).join('') : '<div class="vp-empty">No parish matches.</div>';
    }

    function renderStatus() {
      const v = st.v;
      $('.vp-status').textContent = st.status
        || (v.location_lat != null
          ? `Pin: ${v.location_lat.toFixed(5)}, ${v.location_lng.toFixed(5)}${st.manualPin ? ' (placed by hand)' : ''} — it shows on the map as its own marker.`
          : (v.location_override ? 'No pin yet — look the address up, or place it by hand.' : ''));
    }

    function render() {
      el.querySelectorAll('[data-vp-mode]').forEach(b => {
        const on = b.dataset.vpMode === st.mode;
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', String(on));
      });
      el.querySelectorAll('[data-vp-pane]').forEach(p => { p.hidden = p.dataset.vpPane !== st.mode; });
      if (st.mode === 'parish') renderList();
      if (st.mode === 'custom') renderStatus();
    }

    el.addEventListener('click', async (e) => {
      const m = e.target.closest('[data-vp-mode]');
      if (m) {
        st.mode = m.dataset.vpMode;
        st.status = '';
        // Each answer is the whole place: choosing one forgets the others.
        if (st.mode === 'home') st.v = { ...EMPTY };
        else if (st.mode === 'parish') st.v = { ...EMPTY, location_parish_id: st.v.location_parish_id || null };
        else st.v = { ...EMPTY, location_override: $('.vp-text').value.trim() || null,
          location_lat: st.v.location_parish_id ? null : st.v.location_lat,
          location_lng: st.v.location_parish_id ? null : st.v.location_lng };
        render();
        emit();
        if (st.mode === 'parish') $('.vp-search').focus({ preventScroll: true });
        if (st.mode === 'custom') $('.vp-text').focus({ preventScroll: true });
        return;
      }
      const item = e.target.closest('[data-vp-parish]');
      if (item) {
        st.v = { ...EMPTY, location_parish_id: item.dataset.vpParish };
        renderList();
        emit();
        return;
      }
      const act = e.target.closest('[data-vp-act]');
      if (!act) return;
      if (act.dataset.vpAct === 'lookup') {
        const words = $('.vp-text').value.trim();
        if (!words) { st.status = 'Type the address first.'; renderStatus(); return; }
        act.disabled = true;
        st.status = 'Looking that address up…';
        renderStatus();
        let c = null;
        try { c = await o.geocode(words); } catch { c = null; }
        act.disabled = false;
        if (!c) { st.status = 'No match for that address. Place the pin by hand instead.'; renderStatus(); return; }
        st.status = '';
        st.manualPin = false;
        st.v = { ...st.v, location_override: words, location_lat: c.lat, location_lng: c.lng };
        renderStatus();
        emit();
      } else if (act.dataset.vpAct === 'pin') {
        const start = st.v.location_lat != null ? { lat: st.v.location_lat, lng: st.v.location_lng }
          : (host.lat != null ? { lat: host.lat, lng: host.lng } : null);
        o.pickPin({ ...(start || {}), title: st.v.location_override || 'Where it is held' }, (c) => {
          if (!c) return;
          st.manualPin = true;
          st.status = '';
          st.v = { ...st.v, location_override: $('.vp-text').value.trim() || st.v.location_override, location_lat: c.lat, location_lng: c.lng };
          renderStatus();
          emit();
        });
      }
    });

    $('.vp-search').addEventListener('input', (e) => { st.q = e.target.value; renderList(); });
    $('.vp-text').addEventListener('input', (e) => {
      const words = e.target.value.trim() || null;
      // A looked-up pin described the old words; a hand-placed one stays.
      const keep = st.manualPin;
      st.v = { ...st.v, location_override: words,
        location_lat: keep ? st.v.location_lat : null, location_lng: keep ? st.v.location_lng : null };
      st.status = '';
      renderStatus();
      emit();
    });

    render();
    return {
      get: () => ({ ...st.v }),
      set(v) {
        st.v = { ...EMPTY, ...(v || {}) };
        st.mode = modeOf(st.v);
        $('.vp-text').value = st.v.location_override || '';
        render();
      },
    };
  }

  const api = { mount, modeOf, suburbOf, EMPTY };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.AgoraVenuePicker = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
