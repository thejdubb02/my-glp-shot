// Carries "where did this visitor come from" across the hop from myglpshot.com
// to app.myglpshot.com.
//
// The two are separate origins, so the app cannot read this site's storage, and
// document.referrer on the app only ever says "myglpshot.com" — which is the last
// hop, not the source. Without this, every signup that arrives via the marketing
// site is indistinguishable from every other, and the origin logs can't help
// because Cloudflare serves these pages from its edge.
//
// Only the referrer HOST travels, never the full referring URL: a search
// referrer carries the query in its path, and what someone typed into Google
// about their weight or their medication is not ours to forward.
(function () {
  'use strict';

  var APP_HOST = 'app.myglpshot.com';
  var KEY = 'mgs_attrib';
  var UTM = ['utm_source', 'utm_medium', 'utm_campaign'];

  function referrerHost() {
    if (!document.referrer) return '';
    try {
      var h = new URL(document.referrer).hostname.toLowerCase();
      // An internal hop is not a source.
      if (h === location.hostname || h === APP_HOST) return '';
      return h.indexOf('www.') === 0 ? h.slice(4) : h;
    } catch (_) { return ''; }
  }

  // First touch wins. If someone arrives from Google, reads three comparison
  // pages and then signs up, the credit belongs to Google — not to the last
  // internal page they happened to be on.
  function attribution() {
    var stored = null;
    try { stored = JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch (_) {}
    if (stored && stored.ref !== undefined) return stored;

    var params = new URLSearchParams(location.search);
    var fresh = { ref: referrerHost(), lp: location.pathname };
    UTM.forEach(function (k) {
      var v = params.get(k);
      if (v) fresh[k] = v.slice(0, 60);
    });
    try { sessionStorage.setItem(KEY, JSON.stringify(fresh)); } catch (_) {}
    return fresh;
  }

  function decorate() {
    var a = attribution();
    var links = document.querySelectorAll('a[href*="' + APP_HOST + '"]');
    for (var i = 0; i < links.length; i++) {
      var el = links[i];
      var url;
      try { url = new URL(el.href); } catch (_) { continue; }
      if (url.hostname !== APP_HOST) continue;
      // Never overwrite params already on a deliberately-tagged link.
      if (a.ref && !url.searchParams.has('mgs_ref')) url.searchParams.set('mgs_ref', a.ref);
      if (a.lp && !url.searchParams.has('mgs_lp')) url.searchParams.set('mgs_lp', a.lp);
      UTM.forEach(function (k) {
        if (a[k] && !url.searchParams.has(k)) url.searchParams.set(k, a[k]);
      });
      el.href = url.toString();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', decorate, { once: true });
  } else {
    decorate();
  }
})();
