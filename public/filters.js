const JURISDICTIONS = [
  { key: 'antiochian', label: 'Antiochian', color: '#1e3a5f' },
  { key: 'greek', label: 'Greek', color: '#00508f' },
  { key: 'serbian', label: 'Serbian', color: '#b22234' },
  { key: 'russian', label: 'Russian', color: '#c8a951' },
  { key: 'romanian', label: 'Romanian', color: '#002b7f' },
  { key: 'macedonian', label: 'Macedonian', color: '#d20000' }
];

function initFilters(state) {
  const chipContainer = document.getElementById('jurisdiction-chips');
  // Put subdomain jurisdiction first if accessed from a jurisdiction subdomain
  let ordered = JURISDICTIONS;
  if (state.subdomainJurisdiction) {
    ordered = [
      ...JURISDICTIONS.filter(j => j.key === state.subdomainJurisdiction),
      ...JURISDICTIONS.filter(j => j.key !== state.subdomainJurisdiction)
    ];
  }
  chipContainer.innerHTML = ordered.map(j =>
    `<button class="jurisdiction-chip${state.filters.jurisdiction === j.key ? ' active' : ''}" data-jurisdiction="${j.key}" data-color="${j.color}">${j.label}</button>`
  ).join('');

  applyChipColors(chipContainer);

  chipContainer.addEventListener('click', e => {
    const chip = e.target.closest('.jurisdiction-chip');
    if (!chip) return;

    const j = chip.dataset.jurisdiction;
    if (state.filters.jurisdiction === j) {
      state.filters.jurisdiction = null;
      chip.classList.remove('active');
    } else {
      chipContainer.querySelectorAll('.jurisdiction-chip').forEach(c => c.classList.remove('active'));
      state.filters.jurisdiction = j;
      chip.classList.add('active');
    }

    applyChipColors(chipContainer);

    // Reset parish filter + parish focus when jurisdiction changes
    state.filters.parishIds = null;
    state.filters.showAllParishes = null;
    state.parishFocus = null;
    if (state.parishSheetFocus && typeof window.closeParishSheet === 'function') {
      window.closeParishSheet();
    }
    if (typeof syncResetFab === 'function') syncResetFab();
    if (typeof window.agoraSyncParishRowVisibility === 'function') window.agoraSyncParishRowVisibility();
    if (typeof renderParishPills === 'function') renderParishPills();

    if (typeof updateArchdioceseEventsBanner === 'function') updateArchdioceseEventsBanner();

    if (state.mode === 'services') {
      window.agoraFetchSchedules();
    } else {
      window.agoraFetchEvents();
    }
    if (typeof window.agoraSyncURL === 'function') window.agoraSyncURL();
  });
}

function applyChipColors(container) {
  const anyActive = container.querySelector('.jurisdiction-chip.active');
  // Route colours through the parish/jurisdiction lift funnel — pass-through
  // in light mode, OKLab L-floor lift in dark — so the chip text/underline
  // matches the lifted parish-colour treatment elsewhere.
  const lift = window.getParishDisplayColor || (h => h);
  container.querySelectorAll('.jurisdiction-chip').forEach(chip => {
    const c = lift(chip.dataset.color);
    if (chip.classList.contains('active')) {
      // Selected: full color fill
      chip.style.background = c;
      chip.style.color = '#ffffff';
      chip.style.borderBottomColor = 'transparent';
      chip.style.opacity = '1';
    } else if (!anyActive) {
      // No filter active (all jurisdictions): colored underline
      chip.style.background = '';
      chip.style.color = c;
      chip.style.borderBottomColor = c;
      chip.style.opacity = '1';
    } else {
      // Another jurisdiction selected: dimmed
      chip.style.background = '';
      chip.style.color = '';
      chip.style.borderBottomColor = '';
      chip.style.opacity = '0.35';
    }
  });
}
window.applyChipColors = applyChipColors;

function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }
