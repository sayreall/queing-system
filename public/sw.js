// Bump this whenever a deployed asset changes, so clients cannot keep an
// incompatible dashboard script after the HTML has been updated.
const CACHE_NAME = "pickleball-queue-v49";
const ASSETS = [
  "./",
  "./index.html",
  "./tv.html",
  "./login.html",
  "./admin.html",
  "./import.html",
  "./css/styles.css",
  "./js/dashboard.js",
  "./js/queue.js",
  "./js/firebase.js",
  "./js/login.js",
  "./manifest.json",
  "./manifest-longos.json",
  "./assets/images/deuce-game-logo.png",
  "./assets/images/logologinpage-transparent.png",
  "./assets/images/logo-lpc.jpg",
  "./assets/images/balian-pc.jpg"
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
        cacheNames.map((name) => {
          if (name !== CACHE_NAME) {
            return caches.delete(name);
          }
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  // Ignore requests that aren't HTTP/HTTPS (like chrome-extension://) or are Firebase API calls
  if (!event.request.url.startsWith("http") || event.request.url.includes("firestore.googleapis.com") || event.request.url.includes("identitytoolkit.googleapis.com")) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      // Background fetch to update cache
      const fetchPromise = fetch(event.request).then((networkResponse) => {
        // Only cache valid responses
        if (networkResponse && networkResponse.status === 200 && (networkResponse.type === 'basic' || networkResponse.type === 'cors')) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      }).catch((err) => {
        console.warn("Network fetch failed, serving from cache if available:", err);
      });

      // Stale-While-Revalidate: Return cached immediately if we have it, otherwise wait for network
      if (cachedResponse) {
        return cachedResponse;
      }
      
      return fetchPromise.then(res => {
        if (!res && event.request.mode === "navigate") {
          return caches.match("./index.html");
        }
        return res;
      });
    })
  );
});
