/* TimeSave Social V20.3 – PWA Service Worker (Network-First, OAuth/API-sicher) */
const CACHE_NAME = 'timesave-social-shell-v20.5';
const SHELL_ASSETS = [
  '/manifest.webmanifest?v=20.3',
  '/static/icons/icon-192.png?v=20.3',
  '/static/icons/icon-512.png?v=20.3',
  '/static/icons/apple-touch-icon.png?v=20.3'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/oauth/') ||
    url.pathname.startsWith('/legal/') ||
    url.pathname.startsWith('/public/')
  ) {
    return;
  }

  event.respondWith(
    fetch(req).catch(() => caches.match(req))
  );
});
