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