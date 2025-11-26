/* service-worker.js - RecargasPaCuba
   - EXCLUYE /admin/ DEL CACHE
   - Precaching de assets públicos
   - Network-first para navegación de admin
   - skipWaiting + clients.claim
   - Mensajes para forzar actualización/limpieza
*/

const CACHE_PREFIX = "rpc-pro-";
const CACHE_VERSION = Date.now().toString();
const PRECACHE = `${CACHE_PREFIX}static-${CACHE_VERSION}`;
const RUNTIME = `${CACHE_PREFIX}runtime-${CACHE_VERSION}`;

const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-256.png",
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

// Helper: determina si la petición pertenece al panel admin
function isAdminRequest(url) {
  // Asegúrate que la carpeta admin esté realmente bajo /admin/
  return url.pathname.startsWith("/admin/") || url.pathname.startsWith("/admin");
}

// Trim cache utility (simple)
async function trimCache(cacheName, maxItems) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length > maxItems) {
    const deleteCount = keys.length - maxItems;
    for (let i = 0; i < deleteCount; i++) {
      await cache.delete(keys[i]);
    }
  }
}

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(PRECACHE).then((cache) =>
      cache.addAll(PRECACHE_URLS.map((u) => new Request(u, { cache: "reload" })))
    )
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // Eliminar caches anteriores que no coincidan con la version actual
    const keys = await caches.keys();
    await Promise.all(
      keys.map((key) => {
        if (!key.includes(CACHE_VERSION)) {
          return caches.delete(key);
        }
        return Promise.resolve();
      })
    );
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // 1) Si es petición al admin -> siempre red a la red (no cache)
  if (isAdminRequest(url)) {
    // Network-first para admin (devolver error si no hay red)
    event.respondWith(
      fetch(req).catch(async () => {
        // si no hay red, intentar una respuesta del cache si existe (muy raro porque no cacheamos)
        const cached = await caches.match(req);
        return cached || new Response("Offline", { status: 503, statusText: "Offline" });
      })
    );
    return;
  }

  // 2) Navegación normal (no admin) -> Network-first con fallback a precache index.html
  if (req.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const response = await fetch(req);
        // guardar la respuesta en runtime cache
        const cache = await caches.open(RUNTIME);
        cache.put(req, response.clone());
        return response;
      } catch (err) {
        const cached = await caches.match("./index.html");
        return cached || new Response("Offline", { status: 503, statusText: "Offline" });
      }
    })());
    return;
  }

  // 3) Images -> Cache First (limitar tamaño)
  if (req.destination === "image") {
    event.respondWith(
      caches.open(`${CACHE_PREFIX}images-${CACHE_VERSION}`).then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) return cached;
        try {
          const networkResponse = await fetch(req);
          if (networkResponse && networkResponse.status === 200) {
            cache.put(req, networkResponse.clone());
            // trimming background (60 entradas máximo)
            trimCache(`${CACHE_PREFIX}images-${CACHE_VERSION}`, 60);
          }
          return networkResponse;
        } catch (e) {
          return caches.match("./icon-256.png");
        }
      })
    );
    return;
  }

  // 4) CSS/JS/Fonts -> Stale-While-Revalidate
  if (req.destination === "style" || req.destination === "script" || req.destination === "font") {
    event.respondWith(
      caches.open(RUNTIME).then(async (cache) => {
        const cached = await cache.match(req);
        const networkPromise = fetch(req).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            cache.put(req, networkResponse.clone());
          }
          return networkResponse;
        }).catch(() => null);
        return cached || (await networkPromise) || new Response("", { status: 503 });
      })
    );
    return;
  }

  // 5) Default: try cache then network (for small assets)
  event.respondWith(
    caches.match(req).then((cached) => {
      return cached || fetch(req).then(async (networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const cache = await caches.open(RUNTIME);
          cache.put(req, networkResponse.clone());
        }
        return networkResponse;
      }).catch(() => cached || new Response("", { status: 503 }));
    })
  );
});

// Mensajes desde la app para forzar skipWaiting / limpieza
self.addEventListener("message", (event) => {
  if (!event.data) return;
  const { type } = event.data;
  if (type === "SKIP_WAITING") {
    self.skipWaiting();
  }
  if (type === "CLEAR_OLD_CACHES") {
    caches.keys().then((keys) => {
      keys.forEach((k) => {
        if (!k.includes(CACHE_VERSION)) {
          caches.delete(k);
        }
      });
    });
  }
});
