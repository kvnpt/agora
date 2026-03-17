const jurisdictions = [
  { id: 'antiochian', label: 'Antiochian' },
  { id: 'greek', label: 'Greek' },
  { id: 'serbian', label: 'Serbian' },
  { id: 'russian', label: 'Russian' },
  { id: 'romanian', label: 'Romanian' },
  { id: 'coptic', label: 'Coptic' }
];

function initFilters(state) {
  // Jurisdiction chips
  const chipsContainer = document.getElementById('jurisdiction-chips');
  chipsContainer.innerHTML = jurisdictions.map(j =>
    `<button class="chip" data-jurisdiction="${j.id}">${j.label}</button>`
  ).join('');

  chipsContainer.addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (!chip) return;

    const jur = chip.dataset.jurisdiction;

    // Toggle: if already active, deselect
    if (state.filters.jurisdiction === jur) {
      state.filters.jurisdiction = null;
      chip.classList.remove('active');
    } else {
      // Deselect all, select this one
      chipsContainer.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      state.filters.jurisdiction = jur;
    }
    window.agoraFetchEvents();
  });

  // Event type select
  document.getElementById('type-filter').addEventListener('change', e => {
    state.filters.type = e.target.value;
    window.agoraFetchEvents();
  });

  // Distance slider
  const slider = document.getElementById('distance-filter');
  const label = document.getElementById('distance-value');
  slider.addEventListener('input', e => {
    label.textContent = e.target.value;
    state.filters.distance = parseInt(e.target.value);
  });
  slider.addEventListener('change', () => {
    window.agoraFetchEvents();
  });
}
