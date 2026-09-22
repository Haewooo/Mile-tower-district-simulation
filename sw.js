/**
 * Offline cache.
 *
 * Everything here is static, so the whole app is precached on install and
 * served cache-first afterwards: once it has been opened with a connection,
 * it runs without one. That is about 1.8 MB, most of it the three.js bundle
 * and the three HDRI environment maps.
 *
 * Cache-first is right for this because every cached URL is content that only
 * changes when the build changes, and a build changes CACHE. The old cache is
 * dropped on activate, so a new version cannot serve a stale bundle against a
 * fresh index.html.
 *
 * Navigations fall back to the cached shell when the network is gone, which
 * is what makes an installed copy open at all in airplane mode.
 */
const CACHE = 'mile-tower-v1';

const PRECACHE = [
  './',
  './index.html',
  './dist/app.js',
  './vendor/three.bundle.min.js',
  './assets/hdri/city.exr',
  './assets/hdri/sunset.exr',
  './assets/hdri/night.exr',
  './textures/manifest.json',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // One failure should not sink the install, so they are added individually.
    await Promise.all(PRECACHE.map(url =>
      cache.add(new Request(url, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(n => n !== CACHE).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Google Fonts and anything else off-origin: let the network handle it and
  // let it fail offline — the CSS stack falls back to a system Korean face.
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cached = await caches.match(req, { ignoreSearch: true });
    if (cached) return cached;
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') {
        const cache = await caches.open(CACHE);
        cache.put(req, res.clone());
      }
      return res;
    } catch {
      if (req.mode === 'navigate') {
        const shell = await caches.match('./index.html');
        if (shell) return shell;
      }
      throw new Error('offline and not cached: ' + url.pathname);
    }
  })());
});
