// The lite card's few kilobytes of JavaScript.
//
// The page works without this — it is server-rendered HTML with native
// <details> for the event cards (worker/lib/lite-page.mjs) — so everything here
// is an upgrade: the address bar settling on the canonical link, "now" and
// "past" read off the viewer's own clock (the server cannot bake them in, the
// page is cached for an hour), Share, copy-the-address, and the app's loading
// screen the moment somebody asks for the app.
(function () {
  'use strict';

  // /sgr/next-tue → /sgr/2026-10-06. The server resolved it; the address bar
  // should say what the page is, so the link somebody copies from it next week
  // still means this Tuesday.
  var canonical = document.querySelector('link[rel="canonical"]');
  if (canonical && window.history && history.replaceState) {
    try {
      var want = new URL(canonical.href);
      if (want.origin === location.origin && want.pathname !== location.pathname) {
        history.replaceState(null, '', want.pathname + location.search + location.hash);
      }
    } catch (e) { /* a canonical that will not parse changes nothing */ }
  }

  // The card's header sticks to the top as it does in the app, so the day
  // headers below stick under it: the app measures the same height into the
  // same variable (--ps-stack-h) for its parish card. Without this they stick
  // at the top, behind the header — the page still reads, just less well.
  var card = document.querySelector('.lite-card');
  var head = card && card.querySelector('.ps-header, .tt-head');
  function stackHeight() {
    card.style.setProperty('--ps-stack-h', Math.round(head.getBoundingClientRect().height) + 'px');
  }
  if (head) {
    stackHeight();
    window.addEventListener('resize', stackHeight);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(stackHeight);
  }

  // Now, and already over.
  var now = Date.now();
  document.querySelectorAll('[data-start]').forEach(function (el) {
    var start = Date.parse(el.getAttribute('data-start'));
    var endAttr = el.getAttribute('data-end');
    var end = endAttr ? Date.parse(endAttr) : start + 3600000;
    if (!isFinite(start)) return;
    if (start <= now && now <= end && !el.classList.contains('tomb')) {
      var badge = document.createElement('span');
      badge.className = 'lc-badge now';
      badge.textContent = 'Now';
      // Beside the title, as the app's badges sit; the pinned card's own copy
      // of the event carries it, not the article around it.
      var host = el.querySelector('.event-title') || el.querySelector('summary');
      if (host) host.appendChild(badge);
    } else if (end < now && el.classList.contains('lc-ev')) {
      el.classList.add('past');
    }
  });

  // The app's buttons carry an icon beside their words, so only the words
  // change: the label span when there is one, the whole button when not.
  function flash(el, text) {
    var label = el.querySelector('.ps-info-copy-text, span:not(.ps-btn-glyph)') || el;
    var saved = label.textContent;
    label.textContent = text;
    el.classList.add('copied');
    setTimeout(function () { label.textContent = saved; el.classList.remove('copied'); }, 1400);
  }
  function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    var ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* nothing more to try */ }
    document.body.removeChild(ta);
    return Promise.resolve();
  }

  var share = document.querySelector('[data-share]');
  if (share) {
    share.hidden = false;
    share.addEventListener('click', function () {
      var url = canonical ? canonical.href : location.href;
      if (navigator.share) {
        navigator.share({ title: document.title, url: url }).catch(function () {});
      } else {
        copy(url).then(function () { flash(share, 'Link copied'); });
      }
    });
  }

  document.querySelectorAll('[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      copy(btn.getAttribute('data-copy')).then(function () { flash(btn, 'Copied'); });
    });
  });

  // The way into the app: the ✕ and anywhere on the hero are the app as it
  // opens with no link; VIEW MAP and the buttons in the card are this page's
  // link in it (?app). Nothing of the app is fetched until one is pressed —
  // most people sent a link read it and go — and then the app's own loading
  // screen goes up at once, in this tab, and the app loads behind it as it
  // always has: index.html paints the same screen and carries on from there.
  function intoApp(a) {
    if ((a.target && a.target !== '_self') || a.hasAttribute('download')) return false;
    var u;
    try { u = new URL(a.href, location.href); } catch (e) { return false; }
    return u.origin === location.origin
      && (u.pathname === '/' || /(^|&)app(=|&|$)/.test(u.search.slice(1)));
  }

  var SVG_NS = 'http://www.w3.org/2000/svg';
  // The tree as index.html draws it before anything has loaded: the pale
  // outline, nothing filled yet. index.html keeps the last one it drew; with
  // none kept, fetch one and keep it, so the app most likely draws the same.
  function mountTree(wrap, text) {
    var src = new DOMParser().parseFromString(text, 'image/svg+xml').querySelector('svg');
    if (!src) return;
    var out = document.createElementNS(SVG_NS, 'svg');
    out.setAttribute('class', 'ls-tree');
    out.setAttribute('viewBox', src.getAttribute('viewBox') || '0 0 2048 2048');
    out.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    out.setAttribute('aria-hidden', 'true');
    var outline = document.createElementNS(SVG_NS, 'g');
    outline.setAttribute('class', 'ls-outline-pass');
    Array.prototype.forEach.call(src.childNodes, function (n) { outline.appendChild(n.cloneNode(true)); });
    out.appendChild(outline);
    wrap.appendChild(out);
  }
  function showLoading() {
    if (document.getElementById('loading-screen')) return;
    var screen = document.createElement('div');
    screen.id = 'loading-screen';
    screen.setAttribute('aria-hidden', 'true');
    screen.innerHTML = '<div class="ls-header">orthodoxy.au</div><div class="ls-tree-wrap"></div>'
      + '<div class="ls-log"><div class="ls-log-line">» boot orthodoxy.au</div></div>';
    document.body.appendChild(screen);
    document.body.setAttribute('aria-busy', 'true');
    var wrap = screen.querySelector('.ls-tree-wrap');
    var kept = null;
    try { kept = localStorage.getItem('ls-tree-svg'); } catch (e) { /* storage off */ }
    if (kept) { mountTree(wrap, kept); return; }
    var idx = Math.floor(Math.random() * 7) + 1;
    fetch('/eucalyptus/eucalyptus-' + idx + '.svg')
      .then(function (r) { return r.ok ? r.text() : null; })
      .then(function (text) {
        if (!text) return;
        try {
          localStorage.setItem('ls-tree-svg', text);
          localStorage.setItem('ls-tree-idx', String(idx));
        } catch (e) { /* storage off */ }
        if (wrap.isConnected && !wrap.firstChild) mountTree(wrap, text);
      })
      .catch(function () { /* the screen reads without a tree */ });
  }
  function openApp(href) {
    showLoading();
    // Two frames, so the screen has been painted before this page starts going.
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { location.assign(href); });
    });
  }
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target.closest('a[href]');
    if (a) {
      if (!intoApp(a)) return;
      e.preventDefault();
      openApp(a.href);
    } else if (e.target.closest('.lite-hero')) {
      openApp('/');
    }
  });
  var hero = document.querySelector('.lite-hero');
  if (hero) hero.style.cursor = 'pointer';
  // Back from the app can bring this page back as it was left — screen and all.
  window.addEventListener('pageshow', function (e) {
    if (!e.persisted) return;
    var screen = document.getElementById('loading-screen');
    if (screen) screen.parentNode.removeChild(screen);
    document.body.removeAttribute('aria-busy');
  });
})();
