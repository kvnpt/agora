// Pushing overlapping map dots apart, in pixels.
//
// The alternative to a cluster glyph. Supercluster answers crowding by
// DELETING the dots and drawing one symbol that stands for them; this answers
// it by moving them, so every parish keeps its own dot and its own colour and
// a crowd reads as a crowd rather than as a number.
//
// Three properties make it usable on a map rather than just in a diagram:
//
//   SPRING. Pure repulsion would let a dense city push its outermost dots
//   arbitrarily far. Every point is pulled back toward where it really is on
//   each pass, so a crowd bulges and then holds instead of expanding.
//
//   MAX SHIFT. A hard ceiling on how far any one dot may end up from the
//   truth. The spring discourages a big lie; this forbids it. A dot that
//   cannot fit stays overlapped rather than being moved somewhere it is not.
//
//   DETERMINISM. No randomness anywhere, including the nudge that separates
//   two parishes sharing an address — it comes off the index, by golden
//   angle. The same input gives the same output every time, so recomputing on
//   a zoom change cannot make the dots jitter, and a test can assert exact
//   positions.
//
// Pure and pixel-space: no MapLibre, no lng/lat, no DOM. The caller projects.
(function (root) {
  const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

  /**
   * @param {{x:number,y:number}[]} points  true positions, in pixels
   * @param {object} [opts]
   * @param {number} [opts.minDist]    how far apart two dots should end up
   * @param {number} [opts.iterations] relaxation passes
   * @param {number} [opts.damping]    0..1, share of the overlap resolved per pass
   * @param {number} [opts.spring]     0..1, pull back toward the true position
   * @param {number} [opts.maxShift]   ceiling on |displaced - true|
   * @returns {{x:number,y:number}[]}  displaced positions, same order
   */
  function declutter(points, opts) {
    const o = opts || {};
    const minDist = o.minDist > 0 ? o.minDist : 12;
    const iterations = Number.isFinite(o.iterations) ? o.iterations : 150;
    // Swept against a 60-dot pile, which is what a capital city looks like at
    // national zoom. Fully resolving each overlap (damping 1) and pulling back
    // gently (spring 0.03) clears 97% of the visually merged pairs; a softer
    // damping or a firmer spring both leave two to three times as many.
    const damping = Number.isFinite(o.damping) ? o.damping : 1;
    const spring = Number.isFinite(o.spring) ? o.spring : 0.03;
    // A rail, not a shaping force — the spring settles well inside it. Set so
    // that a big city can actually form a blob instead of being clamped flat.
    const maxShift = Number.isFinite(o.maxShift) ? o.maxShift : minDist * 8;

    const n = points.length;
    const ox = new Float64Array(n);
    const oy = new Float64Array(n);
    const px = new Float64Array(n);
    const py = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      ox[i] = px[i] = points[i].x;
      oy[i] = py[i] = points[i].y;
    }
    if (n < 2 || iterations <= 0) return points.map((p) => ({ x: p.x, y: p.y }));

    const min2 = minDist * minDist;
    const cell = minDist;
    const buckets = new Map();
    const key = (cx, cy) => cx * 73856093 ^ cy * 19349663;

    for (let iter = 0; iter < iterations; iter++) {
      // Rebuild the grid each pass — points have moved since the last one.
      buckets.clear();
      for (let i = 0; i < n; i++) {
        const k = key(Math.floor(px[i] / cell), Math.floor(py[i] / cell));
        const b = buckets.get(k);
        if (b) b.push(i); else buckets.set(k, [i]);
      }

      for (let i = 0; i < n; i++) {
        const cx = Math.floor(px[i] / cell);
        const cy = Math.floor(py[i] / cell);
        for (let gx = cx - 1; gx <= cx + 1; gx++) {
          for (let gy = cy - 1; gy <= cy + 1; gy++) {
            const b = buckets.get(key(gx, gy));
            if (!b) continue;
            for (let bi = 0; bi < b.length; bi++) {
              const j = b[bi];
              if (j <= i) continue;   // each pair once
              let dx = px[j] - px[i];
              let dy = py[j] - py[i];
              let d2 = dx * dx + dy * dy;
              if (d2 >= min2) continue;
              if (d2 < 1e-12) {
                // Two parishes at one address. Separate them along a fixed
                // per-index direction rather than a random one, so the answer
                // is stable across recomputes.
                const a = j * GOLDEN_ANGLE;
                dx = Math.cos(a); dy = Math.sin(a); d2 = 1;
              }
              const d = Math.sqrt(d2);
              const push = ((minDist - d) / 2) * damping;
              const ux = dx / d;
              const uy = dy / d;
              px[i] -= ux * push; py[i] -= uy * push;
              px[j] += ux * push; py[j] += uy * push;
            }
          }
        }
      }

      // Pull everything back toward the truth, then refuse any dot that has
      // wandered further than it is allowed to.
      for (let i = 0; i < n; i++) {
        px[i] += (ox[i] - px[i]) * spring;
        py[i] += (oy[i] - py[i]) * spring;
        const sx = px[i] - ox[i];
        const sy = py[i] - oy[i];
        const s2 = sx * sx + sy * sy;
        if (s2 > maxShift * maxShift) {
          const s = Math.sqrt(s2);
          px[i] = ox[i] + (sx / s) * maxShift;
          py[i] = oy[i] + (sy / s) * maxShift;
        }
      }
    }

    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = { x: px[i], y: py[i] };
    return out;
  }

  const api = { declutter };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.AgoraDeclutter = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
