// Nombre distinto para obligar siempre a refrescar cache
const CACHE_NAME = "rpc-v" + Date.now();

// Archivos que NO deben quedarse en caché antiguo
const CORE_ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png"
];

// INSTALACIÓN
self.addEventListener("install", (event) => {
  self.skipWaiting();

  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(CORE_ASSETS);
    })
  );
});

// ACTIVACIÓN
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key); // Borra cache viejo automáticamente
          }
        })
      )
    )
  );
  self.clients.claim();
});

// FETCH (carga SIEMPRE la versión nueva si existe)
self.addEventListener("fetch", (event) => {
  // No cachear peticiones POST o externas raras
  if (event.request.method !== "GET") return;

  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        // Guarda la nueva versión en cache
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, networkResponse.clone());
        });
        return networkResponse;
      })
      .catch(() =>
        caches.match(event.request).then((resp) => resp || caches.match("./index.html"))
      )
  );
});
