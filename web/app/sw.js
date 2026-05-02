// My GLP Shot service worker — network-first for app shell so updates are picked up on every visit; cache fallback for offline.
const CACHE = 'mglp-v0.17.0';
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'lib/chart.min.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon.ico',
];

self.addEventListener('install', (e) => {
  // Pre-cache shell so the app boots offline even on first run after activation.
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => null))))
      .then(() => self.skipWaiting())
  );
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
      }).catch(() => caches.match(req).then(c => c || caches.match('index.html')))
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
    for (const c of clientsList) {
      if ('focus' in c) return c.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (_) { data = { title: 'My GLP Shot', body: e.data ? e.data.text() : '' }; }
  const title = data.title || 'My GLP Shot';
  const opts = { body: data.body || 'Shot reminder', icon: 'icons/icon-192.png', data: { url: '/' } };
  e.waitUntil(self.registration.showNotification(title, opts));
});
