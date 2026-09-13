// Labels and order. The COLOURS ARE NOT HERE, deliberately.
//
// They used to be, as a sixth hex per row stamped into data-color at render
// time, and that made the chips the one surface in the app that could not see
// a colour change: /admin's overrides arrive with the bundle and reach every
// reader through jurisdictionColor(), and a chip painted from its own frozen
// copy never asks. Setting Greek to another blue moved the map dots, the
// cards, the feed lines and the parish sheet, and left this row alone.
//
// Resolved per chip in applyChipColors instead, at paint time.
const JURISDICTIONS = [
  { key: 'antiochian', label: 'Antiochian' },
  { key: 'greek', label: 'Greek' },
  { key: 'serbian', label: 'Serbian' },
  { key: 'russian', label: 'Russian' },
  { key: 'romanian', label: 'Romanian' },
  { key: 'macedonian', label: 'Macedonian' }
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
    `<button class="jurisdiction-chip${state.filters.jurisdiction === j.key ? ' active' : ''}" data-jurisdiction="${j.key}">${j.label}</button>`
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
  if (!container) return;
  const anyActive = container.querySelector('.jurisdiction-chip.active');
  // getJurisdictionColor is the shared table plus /admin's overrides plus the
  // dark-mode OKLab lift, and it is the no-substitution path: with a filter
  // active, getParishDisplayColor would answer every chip with the SELECTED
  // jurisdiction's colour, which is right for a parish card and wrong for a
  // row of six chips naming six different jurisdictions.
  const resolve = window.getJurisdictionColor || (() => '');
  container.querySelectorAll('.jurisdiction-chip').forEach(chip => {
    const c = resolve(chip.dataset.jurisdiction);
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
      // Another jurisdiction selected: dimmed but still legible
      chip.style.background = '';
      chip.style.color = '';
      chip.style.borderBottomColor = '';
      chip.style.opacity = '0.6';
    }
  });
}
window.applyChipColors = applyChipColors;

// Repaint from wherever the chips happen to be. The overrides land with the
// bundle, which resolves after initFilters has already painted once — every
// other reader of a colour re-renders on that load, and the chips do not.
window.agoraRepaintJurisdictionChips = function () {
  applyChipColors(document.getElementById('jurisdiction-chips'));
};

function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }
