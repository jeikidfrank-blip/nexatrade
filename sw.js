const CACHE_NAME = "nexatrade-app-v1";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./payments.js",
  "./supabase-config.js",
  "./manifest.webmanifest",
  "./nexatrade-icon-192.png",
  "./nexatrade-icon-512.png",
  "./nexatrade-icon-maskable-192.png",
  "./nexatrade-icon-maskable-512.png",
  "./nexatrade-icon-180.png",
  "./nexatrade-icon-32.png",
  "./safaricom-mpesa.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME && (k.startsWith("nexatrade-app-") || k.startsWith("nexatask-app-"))).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Let the messages app keep its own behavior/caching; don't hijack its navigations.
  const path = url.pathname.toLowerCase();
  if (
    path.endsWith("/messages.html") ||
    path.endsWith("/messages.js") ||
    path.endsWith("/messages.css") ||
    path.endsWith("/messages.webmanifest") ||
    path.endsWith("/messages-sw.js") ||
    path.endsWith("/messages-icon-192.png") ||
    path.endsWith("/messages-icon-512.png")
  ) {
    return;
  }

  // Network-first for fresh app updates; fall back to cache offline.
  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {});
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        if (request.mode === "navigate") {
          const fallback = await caches.match("./index.html");
          if (fallback) return fallback;
        }
        throw new Error("Offline and no cached response");
      })
  );
});
