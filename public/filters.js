const JURISDICTIONS = ['antiochian', 'greek', 'serbian', 'russian', 'romanian', 'coptic'];

function initFilters(state) {
  // Jurisdiction chips
  const chipContainer = document.getElementById('jurisdiction-chips');
  chipContainer.innerHTML = JURISDICTIONS.map(j =>
    `<button class="jurisdiction-chip${state.filters.jurisdiction === j ? ' active' : ''}" data-jurisdiction="${j}">${capitalize(j)}</button>`
  ).join('');

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

    if (state.mode === 'services') {
      window.agoraFetchSchedules();
    } else {
      window.agoraFetchEvents();
    }
  });

  // Type filter + distance slider (injected after mode bar)
  const modeBar = document.querySelector('.mode-bar');
  const filterControls = document.createElement('div');
  filterControls.className = 'filter-controls';
  filterControls.id = 'filter-controls';
  filterControls.innerHTML = `
    <select id="type-filter">
      <option value="">All types</option>
      <option value="liturgy">Liturgy</option>
      <option value="vespers">Vespers</option>
      <option value="feast">Feast</option>
      <option value="festival">Festival</option>
      <option value="youth">Youth</option>
      <option value="talk">Talk</option>
      <option value="fundraiser">Fundraiser</option>
      <option value="other">Other</option>
    </select>
    <div class="distance-slider">
      <label>Within <span id="distance-value">${state.filters.distance}</span> km</label>
      <input type="range" id="distance-filter" min="1" max="100" value="${state.filters.distance}">
    </div>
  `;
  modeBar.parentNode.insertBefore(filterControls, modeBar.nextSibling);

  document.getElementById('type-filter').addEventListener('change', e => {
    state.filters.type = e.target.value;
    window.agoraFetchEvents();
  });

  const distSlider = document.getElementById('distance-filter');
  const distLabel = document.getElementById('distance-value');
  distSlider.addEventListener('input', () => { distLabel.textContent = distSlider.value; });
  distSlider.addEventListener('change', () => {
    state.filters.distance = parseInt(distSlider.value);
    window.agoraFetchEvents();
  });
}

function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }
