// A parish logo, at the size it is actually drawn.
//
// The biggest thing a first load downloaded was not code or data but five
// parish logos: 512px PNGs of up to 480 KB each, 1.3 MB between them, for an
// avatar 44px wide and a 32px map sprite. A PNG of a photographed crest does
// not compress, and 512px was four times what any screen asks for.
//
// So every logo is encoded here before it leaves the browser, by whichever
// editor uploads it (the parish sheet's cropper, /admin's file field): square,
// LOGO_SIZE on a side, WebP where the browser can write it. Safari cannot
// encode WebP from a canvas, and says so by quietly handing back a PNG — which
// is what the first production shrink got, from an iPhone: 192px PNGs of
// photographed crests at 30–90 KB, the largest two still over the line that
// offered to shrink them, so the offer came straight back after every press.
// Where WebP is not available the answer is JPEG (7–15 KB for the same five),
// and PNG only for an image that actually has transparent pixels, which JPEG
// would paint black. A Worker has no image pipeline, and this is a canvas's
// work anyway.
//
// 192px covers the largest place a logo appears — the 44px sheet avatar at a
// 3x display is 132px — with room to spare, and lands at ~5–20 KB as WebP.
//
// Classic script, the same dual shape as its neighbours: a browser global,
// nothing for the Worker (which never touches pixels).
(function (root) {
  const LOGO_SIZE = 192;
  const WEBP_QUALITY = 0.86;

  const toBlob = (canvas, type, q) => new Promise(r => canvas.toBlob(r, type, q));

  const JPEG_QUALITY = 0.85;

  /** Does any pixel let the background through? */
  function hasTransparency(canvas) {
    try {
      const px = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      for (let i = 3; i < px.length; i += 4) if (px[i] < 255) return true;
      return false;
    } catch {
      return true;   // unreadable (tainted): keep the format that cannot lose alpha
    }
  }

  /** A canvas as WebP if the browser can write it; else JPEG, or PNG if it needs alpha. */
  async function encodeCanvas(canvas) {
    const webp = await toBlob(canvas, 'image/webp', WEBP_QUALITY);
    // A browser that cannot encode WebP does not fail — it quietly returns a
    // PNG. Check what came back rather than what was asked for.
    if (webp && webp.type === 'image/webp') return webp;
    if (hasTransparency(canvas)) return toBlob(canvas, 'image/png');
    const jpeg = await toBlob(canvas, 'image/jpeg', JPEG_QUALITY);
    return (jpeg && jpeg.type === 'image/jpeg') ? jpeg : toBlob(canvas, 'image/png');
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Could not read that image'));
      img.src = src;
    });
  }

  /**
   * Any image — a File, a Blob, an <img>, a URL — as a square logo blob,
   * centre-cropped to cover. An SVG is returned untouched: it is already the
   * right size at every size, and rasterising it would only make it worse.
   */
  async function shrinkToSquare(source, size = LOGO_SIZE) {
    if (source && source.type === 'image/svg+xml') return source;
    let img = source, url = null;
    if (typeof source === 'string') img = await loadImage(source);
    else if (source instanceof Blob) { url = URL.createObjectURL(source); img = await loadImage(url); }
    try {
      const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
      const side = Math.min(w, h);
      const out = Math.min(size, side);   // never scale a small logo UP
      const canvas = document.createElement('canvas');
      canvas.width = out; canvas.height = out;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, out, out);
      return encodeCanvas(canvas);
    } finally {
      if (url) URL.revokeObjectURL(url);
    }
  }

  const api = { LOGO_SIZE, encodeCanvas, shrinkToSquare };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.AgoraLogo = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
