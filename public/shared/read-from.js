// Where a parish's details and times come from: ONE setting per parish.
//
//   directory  its jurisdiction's directory is read by the import scripts
//              (Antiochian, Greek, ROCOR, Serbian…). The stopgap for a parish
//              nobody looks after yet.
//   website    its own website (or a PDF / calendar adapter) is read. The
//              jurisdiction directory leaves it alone.
//   hand       a person keeps it — a parish contact, or the owner. Nothing
//              automated writes to it, details or times.
//
// This replaced a ladder of source tiers, per-field pins and per-slot
// "suppress" rulings, which refereed between scrapers fact by fact. That was
// the wrong shape for a site maintained by parish contacts: scraping is only
// ever a stopgap until somebody owns the parish, and a parish whose source
// turned out to be wrong is not one to keep scraping around — it is one to
// keep by hand. docs/sources-and-ingestion.md has the history.
//
// A classic script, like its neighbours: app.js cannot import, the Worker and
// the import scripts can. One file, three readers.
(function (root) {
  const READ_FROM = ['directory', 'website', 'hand'];

  const LABELS = {
    directory: 'Read from its jurisdiction’s directory',
    website: 'Read from its own website',
    hand: 'Kept by hand',
  };

  const HINTS = {
    directory: 'The archdiocese’s or diocese’s parish listing is re-read from time to time and may overwrite details and service times.',
    website: 'The parish’s own website (or its PDF or calendar) is re-read and may overwrite details and service times.',
    hand: 'Only people change this parish. No import touches it.',
  };

  /** The setting, read defensively: anything unknown counts as hand-kept. */
  function readFrom(parish) {
    const v = parish && parish.read_from;
    if (v == null) return 'directory';   // a row from before the column existed
    return READ_FROM.includes(v) ? v : 'hand';
  }

  /**
   * May an import of this KIND write to this parish? `kind` is what the script
   * reads: 'directory' or 'website'.
   *
   *   directory  only a parish still read from its directory — the stopgap.
   *   website    a parish read from its website, AND one still on the
   *              directory: finding a parish's own site is exactly what ends
   *              the stopgap, so the import that reads it takes the parish
   *              over (and sets read_from = 'website' as it writes).
   *   hand       nothing, ever.
   */
  function mayImport(parish, kind) {
    const rf = readFrom(parish);
    if (rf === 'hand') return false;
    if (kind === 'website') return rf === 'website' || rf === 'directory';
    return rf === kind;
  }

  const api = { READ_FROM, LABELS, HINTS, readFrom, mayImport };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AgoraReadFrom = api;
})(typeof window !== 'undefined' ? window : globalThis);
