// Minimal service worker — required by browsers to allow "Add to Home Screen" /
// install prompts. It deliberately does NOT cache or intercept chat traffic,
// since this app is built around nothing ever being stored anywhere.

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  self.clients.claim();
});

// Pass every request straight through to the network — no caching,
// consistent with the "nothing saved" design of this app.
self.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request));
});

// Show the incoming push notification. Content is always generic/disguised
// by design (set server-side) — this just displays whatever was sent.
self.addEventListener("push", (event) => {
  let data = { title: "Myntra", body: "New arrivals just for you. Shop now." };
  try {
    if (event.data) data = event.data.json();
  } catch (e) {
    // fall back to default above
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/static/icon-192.png",
      badge: "/static/icon-192.png",
    })
  );
});

// Tapping the notification opens (or focuses) the app.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientsArr) => {
      const existing = clientsArr.find((c) => c.url.includes(self.location.origin));
      if (existing) return existing.focus();
      return self.clients.openWindow("/");
    })
  );
});