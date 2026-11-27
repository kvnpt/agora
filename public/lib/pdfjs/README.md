# pdf.js

Mozilla's [pdf.js](https://mozilla.github.io/pdf.js/), `pdfjs-dist@5.7.284`,
the **legacy** build (it carries the polyfills older iPhones need), as
published on npm: `legacy/build/pdf.min.mjs`, `legacy/build/pdf.worker.min.mjs`
and three of its `wasm/` decoders (JPEG 2000, JBIG2, colour profiles), which
scanned PDFs use. Apache-2.0 (LICENSE; the decoders' own beside them).

The add-event editor loads it the first time a PDF is opened there
(`public/shared/event-editor.js`, `pdfPages`), to draw a PDF's pages as the
poster's picture. The poster reader reads the PDF itself and needs none of
this. The service worker never keeps it (`public/sw.js`).

To update: `npm pack pdfjs-dist@<version>`, and copy the same files over.
