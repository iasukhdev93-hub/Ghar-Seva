const CACHE_NAME = "gharseva-shell-v4";
const APP_URL = new URL("./index.html", self.registration.scope).href;
const APP_SHELL = [
  APP_URL,
  new URL("./manifest.webmanifest", self.registration.scope).href,
  new URL("./icons/ghar-seva-192.png", self.registration.scope).href,
  new URL("./icons/ghar-seva-512.png", self.registration.scope).href
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => Promise.all(
        cacheNames
          .filter((cacheName) => cacheName.startsWith("gharseva-shell-") && cacheName !== CACHE_NAME)
          .map((cacheName) => caches.delete(cacheName))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(APP_URL, copy));
          }
          return response;
        })
        .catch(async () => (await caches.match(request)) || (await caches.match(APP_URL)))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cachedResponse) => cachedResponse || fetch(request))
  );
});
