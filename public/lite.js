// The lite card's few kilobytes of JavaScript.
//
// The page works without this — it is server-rendered HTML with native
// <details> for the event cards (worker/lib/lite-page.mjs) — so everything here
// is an upgrade: the address bar settling on the canonical link, "now" and
// "past" read off the viewer's own clock (the server cannot bake them in, the
// page is cached for an hour), Share, copy-the-address, and fetching the app
// in the background so ← Back to App is quick.
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
      var host = el.querySelector('summary') || el.querySelector('h2');
      if (host) host.appendChild(badge);
    } else if (end < now && el.classList.contains('lc-ev')) {
      el.classList.add('past');
    }
  });

  function flash(el, text) {
    var saved = el.textContent;
    el.textContent = text;
    setTimeout(function () { el.textContent = saved; }, 1400);
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

  // The app, fetched while nobody is waiting on it, so ← Back to App opens
  // from cache. Not on a connection that has asked us to save data.
  var conn = navigator.connection || {};
  if (!conn.saveData && !/2g/.test(conn.effectiveType || '')) {
    var idle = window.requestIdleCallback || function (fn) { setTimeout(fn, 2500); };
    idle(function () {
      ['/app.css', '/app.js', '/lib/maplibre-gl.js', '/lib/maplibre-gl.css'].forEach(function (href) {
        var l = document.createElement('link');
        l.rel = 'prefetch';
        l.href = href;
        document.head.appendChild(l);
      });
    });
  }
})();
