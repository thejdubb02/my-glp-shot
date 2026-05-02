// My GLP Shot service worker — offline app shell + notification click handling.
const CACHE = 'shotclock-v8';
const ASSETS = [
  './',
  'index.html',
  'privacy.html',
  'terms.html',
  'styles.css?v=7',
  'app.js?v=7',
  'manifest.webmanifest',
  'lib/chart.min.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon-16.png',
  'icons/favicon-32.png',
  'icons/favicon-96.png',
  'icons/favicon.ico',
  'icons/logo.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  e.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(res => {
        if (!res || res.status !== 200 || res.type !== 'basic') return res;
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
        return res;
      }).catch(() => caches.match('index.html'));
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/shotclock/';
  e.waitUntil((async () => {
    const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of clientsList) {
      if (c.url.includes('/shotclock/') && 'focus' in c) return c.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});

// Optional: real Web Push fallback (won't fire without backend; harmless to define)
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (_) { data = { title: 'ShotClock', body: e.data ? e.data.text() : '' }; }
  const title = data.title || 'ShotClock';
  const opts = { body: data.body || 'Shot reminder', icon: 'icons/icon-192.png', data: { url: '/shotclock/' } };
  e.waitUntil(self.registration.showNotification(title, opts));
});
