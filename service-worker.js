const CACHE_NAME = "gharseva-shell-v9";
const APP_URL = new URL("./index.html", self.registration.scope).href;
const APP_SHELL = [
  APP_URL,
  new URL("./manifest.webmanifest", self.registration.scope).href,
  new URL("./ghar-seva-192.png", self.registration.scope).href,
  new URL("./ghar-seva-512.png", self.registration.scope).href
];

try {
  importScripts(
    "https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js",
    "https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js"
  );
  self.firebase.initializeApp({
    apiKey: "AIzaSyDIxwHt557G595L05OwTNpeZQ6dVrZovCM",
    authDomain: "ghar-seva-1cb1a.firebaseapp.com",
    projectId: "ghar-seva-1cb1a",
    storageBucket: "ghar-seva-1cb1a.firebasestorage.app",
    messagingSenderId: "732729369046",
    appId: "1:732729369046:web:54f9bbf7993e1111dbc477",
    measurementId: "G-S44T374LKB"
  });
  self.firebase.messaging().onBackgroundMessage((payload) => {
    const notification = payload.notification || {};
    const title = notification.title || "GharSeva · Booking update";
    const options = {
      body: notification.body || "आपकी booking में नया update है।",
      icon: "./ghar-seva-192.png",
      data: payload.data || {}
    };
    return self.registration.showNotification(title, options);
  });
} catch (error) {
  console.error("Firebase background messaging could not be initialized.", error);
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data?.url || "./", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const existing = clients.find((client) => client.url === targetUrl);
      if (existing) return existing.focus();
      return self.clients.openWindow(targetUrl);
    })
  );
});

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
