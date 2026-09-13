const CACHE_NAME = "pickleball-queue-v1";
const ASSETS = [
  "./",
  "./index.html",
  "./tv.html",
  "./login.html",
  "./manifest.json",
  "./deuce-game-logo.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS).catch(err => console.warn("Cache addAll failed:", err));
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => {
      return response || fetch(event.request);
    }).catch(() => {
      // Fallback if offline
      if (event.request.mode === "navigate") {
        return caches.match("./index.html");
      }
    })
  );
});
