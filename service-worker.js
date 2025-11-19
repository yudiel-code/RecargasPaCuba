// service-worker.js
const CACHE_NAME = 'rpc-cache-v2';
const ASSETS = [
  '/RecargasPaCuba/',
  '/RecargasPaCuba/index.html',
  '/RecargasPaCuba/icon-192.png',
  '/RecargasPaCuba/icon-512.png',
  '/RecargasPaCuba/manifest.json'
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => k !== CACHE_NAME ? caches.delete(k) : null))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  e.respondWith(
    caches.match(e.request).then(res => res || fetch(e.request))
  );
});
