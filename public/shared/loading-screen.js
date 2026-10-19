// The gum-tree loader: a eucalyptus that fills green from the ground up while
// a one-line log ticks over under it, over the page as it comes to life.
//
// The app's (index.html, inline), as a file for /next: load it as a plain
// script straight after the #loading-screen markup, before anything else, so
// it shows from the first paint and anything after can log to it. It hands
// out three globals: lsLog(line), lsProgress(0..1) and lsHide(), which the
// page calls once its first render is done. A tree that never hears lsHide
// goes after 10s anyway, so nobody is stuck behind it.
//
// One of seven trees (public/eucalyptus/), kept in this browser so a repeat
// visit draws at once, with a one-in-five chance of a new one. When v3
// replaces the app, index.html loads this instead of its inline copy.
(function () {
  var log = document.getElementById('ls-log');
  var screen = document.getElementById('loading-screen');
  if (!screen) return;
  var progress = 0;

  function lsLog(msg) {
    if (!log) return;
    // One line, re-made each time so its entrance plays again.
    while (log.firstChild) log.removeChild(log.firstChild);
    var line = document.createElement('div');
    line.className = 'ls-log-line';
    line.textContent = msg;
    log.appendChild(line);
  }
  function lsProgress(p) {
    progress = Math.max(progress, Math.min(1, p));
    // The rect arrives with the tree, so look for it every time.
    var rect = document.getElementById('ls-tree-fill-rect');
    if (rect) rect.style.transform = 'scaleY(' + progress + ')';
  }
  var hiding = false;
  function lsHide() {
    if (hiding) return;
    hiding = true;
    lsProgress(1);
    setTimeout(function () {
      screen.classList.add('hidden');
      setTimeout(function () { if (screen.parentNode) screen.parentNode.removeChild(screen); }, 750);
    }, 400);
  }

  // Filler, shuffled so each load reads differently. The page's real steps
  // come through lsLog between them.
  var pool = [
    'Initialising namespace…',
    'Parsing Australia/Sydney timezone…',
    'Reading jurisdiction palette…',
    'Warming haversine cache…',
    'Hydrating cached location…',
    'Shelving collections…',
    'Grouping service times by day…',
    'Binding touch event handlers…',
    'Inflating map container…',
    'Computing viewport bounds…',
    'Synchronising URL slug state…',
    'Registering history popstate handler…',
    'Evaluating prefers-color-scheme…',
    'Reticulating iconostases…',
    'Projecting recurrence rules…',
    'Resolving adapter registry…',
    'Priming MapLibre symbol layers…',
    'Measuring safe-area insets…'
  ];
  for (var i = pool.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var t = pool[i]; pool[i] = pool[j]; pool[j] = t;
  }

  lsLog('» boot orthodoxy.au');
  var poolIdx = 0;
  var spam = setInterval(function () {
    if (!document.getElementById('loading-screen')) { clearInterval(spam); return; }
    lsLog(pool[poolIdx % pool.length]);
    poolIdx++;
    // The tree creeps up on filler too, and real steps push it further.
    lsProgress(progress + 0.02);
  }, 85);

  window.lsLog = lsLog;
  window.lsProgress = lsProgress;
  window.lsHide = lsHide;

  var TOTAL = 7;
  var REROLL_CHANCE = 0.2;
  var cachedSvg = null, cachedIdx = null;
  try {
    cachedSvg = localStorage.getItem('ls-tree-svg');
    cachedIdx = localStorage.getItem('ls-tree-idx');
  } catch (e) { /* storage blocked */ }
  var shouldReroll = !cachedSvg || Math.random() < REROLL_CHANCE;

  // The tree twice: a pale outline always, and the green over it, clipped by
  // a rect that lsProgress grows from the ground.
  function mountTree(text) {
    var SVG_NS = 'http://www.w3.org/2000/svg';
    var doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    var src = doc.querySelector('svg');
    if (!src) return;
    var vb = src.getAttribute('viewBox') || '0 0 2048 2048';
    var parts = vb.split(/\s+/).map(Number);
    var x0 = parts[0] || 0, y0 = parts[1] || 0;
    var vbW = (parts[2] || 2048) - x0;
    var vbH = (parts[3] || 2048) - y0;

    var out = document.createElementNS(SVG_NS, 'svg');
    out.setAttribute('class', 'ls-tree');
    out.setAttribute('viewBox', vb);
    out.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    out.setAttribute('aria-hidden', 'true');

    var defs = document.createElementNS(SVG_NS, 'defs');
    var clip = document.createElementNS(SVG_NS, 'clipPath');
    clip.setAttribute('id', 'ls-tree-fill-clip');
    var rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('id', 'ls-tree-fill-rect');
    rect.setAttribute('x', String(x0));
    rect.setAttribute('y', String(y0));
    rect.setAttribute('width', String(vbW));
    rect.setAttribute('height', String(vbH));
    clip.appendChild(rect);
    defs.appendChild(clip);
    out.appendChild(defs);

    var outline = document.createElementNS(SVG_NS, 'g');
    outline.setAttribute('class', 'ls-outline-pass');
    var colour = document.createElementNS(SVG_NS, 'g');
    colour.setAttribute('class', 'ls-colour-pass');
    colour.setAttribute('clip-path', 'url(#ls-tree-fill-clip)');
    var kids = Array.prototype.slice.call(src.childNodes);
    for (var k = 0; k < kids.length; k++) {
      outline.appendChild(kids[k].cloneNode(true));
      colour.appendChild(kids[k].cloneNode(true));
    }
    out.appendChild(outline);
    out.appendChild(colour);

    var wrap = screen.querySelector('.ls-tree-wrap');
    if (!wrap) return;
    while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
    wrap.appendChild(out);
    lsProgress(progress);
  }

  if (!shouldReroll && cachedSvg) {
    mountTree(cachedSvg);
  } else {
    var idx = Math.floor(Math.random() * TOTAL) + 1;
    fetch('/eucalyptus/eucalyptus-' + idx + '.svg')
      .then(function (r) { return r.ok ? r.text() : null; })
      .then(function (text) {
        if (!text) return;
        try {
          localStorage.setItem('ls-tree-svg', text);
          localStorage.setItem('ls-tree-idx', String(idx));
        } catch (e) { /* storage blocked */ }
        mountTree(text);
      })
      .catch(function () { if (cachedSvg) mountTree(cachedSvg); });
  }

  setTimeout(lsHide, 10000);
})();
