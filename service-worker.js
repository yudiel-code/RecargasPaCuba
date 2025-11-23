const CACHE_NAME = "rpc-v" + Date.now();

// Archivos esenciales de la app
const CORE_ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",

  // ICONOS ACTUALIZADOS (los nuevos que subiste)
  "./app-icon-96.png",
  "./app-icon-128.png",
  "./app-icon-144.png",
  "./app-icon-152.png",
  "./app-icon-192.png",
  "./app-icon-256.png",
  "./app-icon-384.png",
  "./app-icon-512.png",
  "./app-icon-1024.png"
];

// INSTALACIÓN — CACHEA ARCHIVOS ESENCIALES
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(CORE_ASSETS);
    })
  );
  self.skipWaiting(); // Para activar la nueva versión sin esperar
});

// ACTIVACIÓN — BORRA CACHÉ ANTIGUA
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim(); // Toma control inmediato
});

// INTERCEPCIÓN DE PETICIONES
self.addEventListener("fetch", (event) => {
  const request = event.request;

  // 1️⃣ — PRIORIDAD: obtener siempre versión más nueva de internet
  event.respondWith(
    fetch(request)
      .then((response) => {
        // guarda copia en caché
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(request, clone);
        });
        return response; // devuelve versión en línea
      })
      .catch(() => {
        // 2️⃣ — Si no hay internet, usar caché
        return caches.match(request).then((cacheResponse) => {
          // fallback: si no existe en caché, devolver index.html
          return cacheResponse || caches.match("./index.html");
        });
      })
  );
});
