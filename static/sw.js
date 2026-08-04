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
// No icon/badge specified — keeps it looking like a plain generic alert
// rather than clearly tied to this app.
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
      vibrate: [200, 100, 200], // buzz-pause-buzz, standard notification pattern
      tag: "auralook-alert", // same tag = replaces the previous one instead of stacking
      renotify: true, // still vibrate/alert again even when replacing an existing one
    })
  );
});

// Tapping the notification just dismisses it — no action, doesn't open
// or focus the app.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
});

// Lets the page tell this service worker "I've been opened / messages were
// just seen — clear any notifications you're currently showing." This is
// what makes notifications disappear once you've manually checked the app,
// rather than lingering in the tray.
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "CLOSE_NOTIFICATIONS") {
    self.registration.getNotifications().then((notifications) => {
      notifications.forEach((n) => n.close());
    });
  }
});