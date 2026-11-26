const CACHE_NAME = "nexatrade-messages-v5";
const APP_SHELL = [
  "./messages.html",
  "./messages.css",
  "./messages.js",
  "./messages.webmanifest",
  "./messages-icon-192.png",
  "./messages-icon-512.png",
  "./safaricom-mpesa.png",
  "./supabase-config.js"
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
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let payload = {};
    try {
      payload = event.data ? event.data.json() : {};
    } catch (error) {
      console.error("Could not parse withdrawal push notification:", error);
    }

    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (clients.some((client) => client.visibilityState === "visible")) return;

    await self.registration.showNotification(payload.title || "New withdrawal message", {
      body: payload.body || "A new message has arrived in your NexaTrade inbox.",
      icon: "./messages-icon-192.png",
      badge: "./messages-icon-192.png",
      tag: payload.tag || "nexatrade-withdrawal",
      data: { url: payload.url || "./messages.html?thread=MPESA" }
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const requestedUrl = new URL(
      event.notification.data?.url || "./messages.html?thread=MPESA",
      self.registration.scope
    );
    const url = requestedUrl.origin === self.location.origin
      ? requestedUrl
      : new URL("./messages.html?thread=MPESA", self.registration.scope);
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of clients) {
      if (new URL(client.url).origin === url.origin) {
        await client.navigate(url.href);
        return client.focus();
      }
    }
    return self.clients.openWindow(url.href);
  })());
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Network-first so Android/PWA users receive updated HTML/CSS/JS after deploys.
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
          const fallback = await caches.match("./messages.html");
          if (fallback) return fallback;
        }
        throw new Error("Offline and no cached response");
      })
  );
});
