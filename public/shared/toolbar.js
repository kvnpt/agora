// The toolbar's rows, laid out once for both places that have one.
//
// The main sheet and the parish card filter with the same controls (the
// builders in app.js paint each `filter-slot`), and they drifted the moment
// each laid its own rows out: the card had the language on a line by itself
// and When pushed to the right, while the feed had the language, the kind and
// bookmarks on one row and When centred under them. So the rows live here and
// both ask for them:
//
//   pills  the language, the kind of event, bookmarks;   `pillsEnd` (Save list)
//   when   `whenStart` (the timetable), and when, centred
//
// `scope` is 'main' (state.filters) or 'parish' (state.parishFilters); the
// When control is shared between them. The extras are markup the caller owns.
//
// Same dual-mode wrapper as its neighbours.
(function (root) {
  function slot(what, scope) {
    return `<div class="filter-slot" data-filter-slot="${what}" data-filter-scope="${scope}"></div>`;
  }

  function rowsHTML(scope, opts = {}) {
    const { pillsEnd = '', whenStart = '', pillsId = '' } = opts;
    return `<div class="mode-bar-row mode-bar-row-pills"${pillsId ? ` id="${pillsId}"` : ''}>`
      + slot('lang', scope) + slot('kind', scope) + slot('bookmarks', scope) + pillsEnd
      + `</div>`
      + `<div class="mode-bar-row mode-bar-row-when">` + whenStart + slot('when', scope) + `</div>`;
  }

  const api = { rowsHTML };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.AgoraToolbar = api;
})(typeof window !== 'undefined' ? window : null);
