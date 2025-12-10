// service-worker.js
// REcargasPaCuba – B4.1 PWA & rendimiento

'use strict';

const CACHE_VERSION = 'v1';
const CACHE_NAME = `rpc-static-${CACHE_VERSION}`;

// Archivos que SÍ existen en tu proyecto según el árbol de VS Code
const CORE_ASSETS = [
  '/',
  '/index.html',
  '/registro.html',
  '/recargar.html',
  '/historial.html',
  '/cuenta.html',
  '/cambiar-password.html',
  '/terminos.html',
  '/privacidad.html',
  '/reembolsos.html',

  '/manifest.json',
  '/favicon.ico',

  // JS core (carpeta /js que se ve en el explorador)
  '/js/firebase.js',
  '/js/userData.js',
  '/js/products.js',

  // Iconos PWA que tienes en la raíz
  '/app-icon-192.png',
  '/app-icon-512.png'
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

// Detectar si la petición es HTML/navegación
function isHtmlRequest(request) {
  return request.mode === 'navigate' ||
    (request.headers.get('accept') || '').includes('text/html');
}

// Fetch:
// - HTML → network-first (frescura, fallback a cache).
// - Estáticos → cache-first (rendimiento).
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
            .then(match => match || caches.match('/index.html'));
        })
    );
    return;
  }

  // Estáticos: cache-first
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
