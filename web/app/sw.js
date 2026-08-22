// My GLP Shot service worker — network-first for app shell so updates are picked up on every visit; cache fallback for offline.
const CACHE = 'mglp-v0.54.0';
// Without these three the app cannot boot offline at all, so a failure to cache
// them must fail the install rather than leaving a service worker that claims
// offline support it can't deliver.
const CRITICAL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
];
const OPTIONAL = [
  'lib/chart.min.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon.ico',
];

self.addEventListener('install', (e) => {
  // Pre-cache shell so the app boots offline even on first run after activation.
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await c.addAll(CRITICAL);                                   // rejects install on failure
    await Promise.all(OPTIONAL.map(u => c.add(u).catch(() => null)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network-first for navigation + JS/CSS so users always get the latest on each load.
// Cache-first for icons/images (cheap to keep stale).
function isShellAsset(url) {
  return /\.(html|js|css|webmanifest)(\?|$)/i.test(url) || url.endsWith('/');
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Never cache /api/* — always live.
  if (url.pathname.startsWith('/api/')) return;

  if (req.mode === 'navigate' || isShellAsset(url.pathname)) {
    e.respondWith(
      fetch(req).then(res => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      }).catch(async () => {
        const cached = await caches.match(req);
        if (cached) return cached;
        // Only a navigation may fall back to the app shell. Serving index.html
        // in response to a failed app.js or styles.css request handed the page
        // HTML with a JS content-type, which fails to parse and looks like a
        // corrupt app rather than an offline one.
        if (req.mode === 'navigate') {
          const shell = await caches.match('index.html');
          if (shell) return shell;
        }
        return new Response('Offline', { status: 503, statusText: 'Offline' });
      })
    );
    return;
  }

  // Static assets (icons/images): cache-first with background refresh.
  e.respondWith(
    caches.match(req).then(cached => {
      const fetchPromise = fetch(req).then(res => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      }).catch(() => cached);
      return cached || fetchPromise;
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil((async () => {
    const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // If a window is already open: focus it and ask it to deep-link to the
    // reminder section. Use postMessage so the page can handle without a full
    // reload (preserves IDB-backed UI state).
    for (const c of clientsList) {
      if ('focus' in c) {
        try { c.postMessage({ type: 'reminder-click', url }); } catch (_) {}
        try { return await c.focus(); } catch (_) {}
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (_) { data = { title: 'My GLP Shot', body: e.data ? e.data.text() : '' }; }
  const title = data.title || 'My GLP Shot';
  const opts = {
    body: data.body || 'Shot reminder',
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    // Carry the server's deep link through, so tapping a weigh-in reminder opens
    // the weigh-in and not just the home screen. This was hardcoded to '/'.
    data: { url: data.url || '/' },
    tag: data.tag || undefined,
    renotify: !!data.tag,
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});
