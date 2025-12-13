// service-worker.js
// REcargasPaCuba â€“ B4.1 PWA & rendimiento

'use strict';

const CACHE_VERSION = 'v4';
const CACHE_NAME = `rpc-static-${CACHE_VERSION}`;

// Archivos que SÃ existen en tu proyecto segÃºn el Ã¡rbol de VS Code
const CORE_ASSETS = [
  './',
  './index.html',
  './registro.html',
  './recargar.html',
  './historial.html',
  './cuenta.html',
  './cambiar-password.html',
  './terminos.html',
  './privacidad.html',
  './reembolsos.html',
  './offline.html',

  './manifest.json',
  './favicon.ico',

  // JS core (carpeta /js que se ve en el explorador)
  './js/firebase.js',
  './js/userData.js',
  './js/products.js',
  './js/app.js',
  './js/ui.js',
  './js/validators.js',

  // CSS base de la app
  './styles/base.css',
  './styles/app.css',

  // Iconos PWA que tienes en la raíz
  './app-icon-96.png',
  './app-icon-128.png',
  './app-icon-144.png',
  './app-icon-152.png',
  './app-icon-192.png',
  './app-icon-256.png',
  './app-icon-384.png',
  './app-icon-512.png',
  './app-icon-1024.png',
  './icon-256.png',
  './google.png'
];

// Install: cache de HTML principal, JS e iconos
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting())
      .catch(err => {
        console.error('[SW] Error en install:', err);
      })
  );
});

// Activate: limpieza de caches antiguos
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys
          .filter(key => key.startsWith('rpc-static-') && key !== CACHE_NAME)
          .map(key => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

// Detectar si la peticiÃ³n es HTML/navegaciÃ³n
function isHtmlRequest(request) {
  return request.mode === 'navigate' ||
    (request.headers.get('accept') || '').includes('text/html');
}

// Fetch:
// - HTML â†’ network-first (frescura, fallback a cache).
// - EstÃ¡ticos â†’ cache-first (rendimiento).
self.addEventListener('fetch', event => {
  const { request } = event;

  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) {
    return;
  }

  if (isHtmlRequest(request)) {
    // HTML: network-first
    event.respondWith(
      fetch(request)
        .then(response => {
          const respClone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, respClone));
          return response;
        })
        .catch(() => {
          return caches.match(request)
            .then(match => match || caches.match('/offline.html') || caches.match('/index.html'));
        })
    );
    return;
  }

  // CSS: stale-while-revalidate para evitar CSS obsoleto
  if (request.destination === 'style' || request.url.endsWith('.css')) {
    event.respondWith(
      caches.match(request).then(cacheResponse => {
        const fetchPromise = fetch(request)
          .then(networkResponse => {
            if (!networkResponse || !networkResponse.ok || networkResponse.type === 'opaque') {
              return networkResponse;
            }
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request, responseClone));
            return networkResponse;
          })
          .catch(() => null);

        // Devuelve cache si existe, sino espera red
        return cacheResponse || fetchPromise.then(resp => resp || new Response('', { status: 503, statusText: 'Service Unavailable' }));
      })
    );
    return;
  }

  // EstÃ¡ticos: cache-first
  event.respondWith(
    caches.match(request).then(cacheResponse => {
      if (cacheResponse) return cacheResponse;

      return fetch(request)
        .then(networkResponse => {
          const respClone = networkResponse.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, respClone));
          return networkResponse;
        })
        .catch(() => {
          return new Response('', { status: 503, statusText: 'Service Unavailable' });
        });
    })
  );
});
