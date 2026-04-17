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
    if (state.parishFocus) {
      state.parishFocus = null;
      if (typeof removeParishCardHeader === 'function') removeParishCardHeader();
    }
    if (typeof syncResetFab === 'function') syncResetFab();
    const parishRow = document.getElementById('parish-filter-row');
    if (state.filters.jurisdiction) {
      parishRow.classList.add('visible');
      if (typeof renderParishPills === 'function') renderParishPills();
    } else {
      parishRow.classList.remove('visible');
    }

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
  container.querySelectorAll('.jurisdiction-chip').forEach(chip => {
    if (chip.classList.contains('active')) {
      // Selected: full color fill
      chip.style.background = chip.dataset.color;
      chip.style.color = '#ffffff';
      chip.style.borderBottomColor = 'transparent';
      chip.style.opacity = '1';
    } else if (!anyActive) {
      // No filter active (all jurisdictions): colored underline
      chip.style.background = '';
      chip.style.color = chip.dataset.color;
      chip.style.borderBottomColor = chip.dataset.color;
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

function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }
