/* TimeSave Social V20.1 – PWA Service Worker (Network-First, OAuth/API-sicher) */
const CACHE_NAME = 'timesave-social-shell-v20.1';
const SHELL_ASSETS = [
  '/manifest.webmanifest',
  '/static/icons/icon-192.png',
  '/static/icons/icon-512.png',
  '/static/icons/apple-touch-icon.png'
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

  // Never intercept API, OAuth callbacks, legal pages, or public media / verification files
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/oauth/') ||
    url.pathname.startsWith('/legal/') ||
    url.pathname.startsWith('/public/')
  ) {
    return;
  }

  // Network-first for HTML & static assets so Render deploys are always immediately visible
  event.respondWith(
    fetch(req).catch(() => caches.match(req))
  );
});
