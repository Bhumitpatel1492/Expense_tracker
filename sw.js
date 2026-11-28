/* Service worker: offline app shell + push reminders. Bump VERSION when app files change. */
const VERSION = 'et-v9';
const SDK_CACHE = 'firebase-sdk-10.12.2';
const ASSETS = ['./', './index.html', './styles.css', './app.js', './config.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/badge-96.png'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(VERSION).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== SDK_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()));
});

// Network first for our own files (so updates show up immediately), cache as offline fallback.
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET') return;
  // Firebase SDK files are versioned and never change: cache first, so the app also opens offline.
  if (url.origin === 'https://www.gstatic.com' && url.pathname.startsWith('/firebasejs/')) {
    event.respondWith(caches.open(SDK_CACHE).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) c.put(req, res.clone());
      return res;
    }));
    return;
  }
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(req, { cache: 'no-cache' }).then(res => { // always revalidate with the server
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('./index.html'))));
});

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data && event.data.text() }; }
  // Firebase Cloud Messaging wraps our fields in "data" (or "notification").
  if (data.data || data.notification) data = { ...(data.notification || {}), ...(data.data || {}) };
  const title = data.title || '💸 Expense reminder';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || "Add today's payments to your expense tracker.",
    icon: 'icons/icon-192.png',
    badge: 'icons/badge-96.png',
    tag: 'daily-reminder',
    renotify: true,
    requireInteraction: false,
    data: { url: data.url || './#add' },
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || './#add', self.registration.scope).href;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) {
      if (client.url.startsWith(self.registration.scope)) {
        await client.focus();
        client.postMessage({ type: 'open-add' });
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
