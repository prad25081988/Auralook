// Auralook — contacts-only chat.
// Add someone by email + a nickname of your own choosing. Once added,
// message them anytime, online or offline. People you haven't added are
// never visible anywhere in this UI, even if they're using the app too.

const socket = io();
const myEmail = document.body.dataset.myEmail;

const contactsListEl = document.getElementById("contacts-list");
const addContactForm = document.getElementById("add-contact-form");
const addContactToggleBtn = document.getElementById("add-contact-toggle-btn");
const addContactEmailInput = document.getElementById("add-contact-email");
const addContactNicknameInput = document.getElementById("add-contact-nickname");
const addContactError = document.getElementById("add-contact-error");

const noChatEl = document.getElementById("no-chat");
const contactChatWindowEl = document.getElementById("contact-chat-window");
const contactStatusDotEl = document.getElementById("contact-status-dot");
const contactPartnerNameEl = document.getElementById("contact-partner-name");
const contactMessagesEl = document.getElementById("contact-messages");
const contactMessageForm = document.getElementById("contact-message-form");
const contactMessageInput = document.getElementById("contact-message-input");
const contactCloseBtn = document.getElementById("contact-close-btn");
const contactClearBtn = document.getElementById("contact-clear-btn");
const imageInput = document.getElementById("image-input");
const imageBtn = document.getElementById("image-btn");
const lightboxEl = document.getElementById("image-lightbox");
const lightboxImgEl = document.getElementById("lightbox-img");
const lightboxCloseBtn = document.getElementById("lightbox-close-btn");

// Just for viewing full-size — no download/save is triggered by this.
function openImageLightbox(dataUrl) {
  lightboxImgEl.src = dataUrl;
  lightboxEl.classList.remove("hidden");
}

function closeImageLightbox() {
  lightboxEl.classList.add("hidden");
  lightboxImgEl.src = "";
}

lightboxCloseBtn.onclick = closeImageLightbox;
lightboxEl.onclick = (e) => {
  if (e.target === lightboxEl) closeImageLightbox(); // clicking the dark backdrop also closes it
};

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB — balances image quality with loading/decryption speed

let currentContactEmail = null;
let currentContactName = null;
let onlineEmails = new Set();
let lastRenderedDateLabel = null; // tracks the last date-separator shown, so we only insert a new one when the day actually changes

async function loadContacts() {
  try {
    const res = await fetch("/api/contacts/list");
    const data = await res.json();
    if (data.error) return;
    renderContactsList(data.contacts || []);
  } catch (e) {
    console.error("Failed to load contacts:", e);
  }
}

function renderContactsList(contacts) {
  contactsListEl.innerHTML = "";
  contacts.forEach(({ email, nickname, online }) => {
    if (online) onlineEmails.add(email.toLowerCase());
    else onlineEmails.delete(email.toLowerCase());

    const li = document.createElement("li");
    li.className = "contact-item";
    li.dataset.email = email;

    const dot = document.createElement("span");
    dot.className = `status-dot ${online ? "online" : "offline"}`;
    li.appendChild(dot);

    const label = document.createElement("span");
    label.className = "contact-label";
    label.textContent = nickname || email;
    label.onclick = () => openContactChat(email, nickname || email);
    li.appendChild(label);

    const removeBtn = document.createElement("button");
    removeBtn.className = "remove-contact-btn";
    removeBtn.textContent = "Remove";
    removeBtn.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`Remove ${nickname || email} from your list?`)) return;
      try {
        await fetch("/api/contacts/remove", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email }),
        });
        if (currentContactEmail === email) contactCloseBtn.click();
        loadContacts();
      } catch (err) {
        alert("Could not remove this contact. Please try again.");
      }
    };
    li.appendChild(removeBtn);

    contactsListEl.appendChild(li);
  });
}

addContactToggleBtn.onclick = () => {
  addContactForm.classList.toggle("hidden");
  addContactError.classList.add("hidden");
  if (!addContactForm.classList.contains("hidden")) {
    addContactEmailInput.focus();
  }
};

addContactForm.onsubmit = async (e) => {
  e.preventDefault();
  const email = addContactEmailInput.value.trim().toLowerCase();
  const nickname = addContactNicknameInput.value.trim();
  addContactError.classList.add("hidden");
  try {
    const res = await fetch("/api/contacts/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, nickname }),
    });
    const data = await res.json();
    if (data.error) {
      addContactError.textContent = data.error;
      addContactError.classList.remove("hidden");
      return;
    }
    addContactEmailInput.value = "";
    addContactNicknameInput.value = "";
    addContactForm.classList.add("hidden");
    loadContacts();
  } catch (err) {
    addContactError.textContent = "Could not add contact. Please try again.";
    addContactError.classList.remove("hidden");
  }
};

async function openContactChat(email, name) {
  currentContactEmail = email;
  currentContactName = name;
  contactPartnerNameEl.textContent = name;
  updateContactStatusDot();
  lastRenderedDateLabel = null; // reset date-separator tracking for this conversation

  noChatEl.classList.add("hidden");
  contactChatWindowEl.classList.remove("hidden");
  contactMessagesEl.innerHTML = "Loading...";

  try {
    const res = await fetch(`/api/conversation/${encodeURIComponent(email)}`);
    const data = await res.json();
    contactMessagesEl.innerHTML = "";
    (data.messages || []).forEach((m) => appendContactMessage(m));
  } catch (e) {
    contactMessagesEl.innerHTML = "Could not load this conversation.";
  }
}

function updateContactStatusDot() {
  if (!currentContactEmail) return;
  const isOnline = onlineEmails.has(currentContactEmail.toLowerCase());
  contactStatusDotEl.className = `status-dot ${isOnline ? "online" : "offline"}`;
}

contactCloseBtn.onclick = () => {
  currentContactEmail = null;
  currentContactName = null;
  contactChatWindowEl.classList.add("hidden");
  noChatEl.classList.remove("hidden");
};

contactClearBtn.onclick = async () => {
  if (!currentContactEmail) return;
  try {
    const res = await fetch(`/api/conversation/${encodeURIComponent(currentContactEmail)}/clear-for-me`, {
      method: "POST",
    });
    const data = await res.json();
    if (data.error) {
      alert(data.error);
      return;
    }
    contactMessagesEl.innerHTML = "";
  } catch (err) {
    alert("Could not clear this. Please try again.");
  }
};

contactMessageForm.onsubmit = async (e) => {
  e.preventDefault();
  const text = contactMessageInput.value.trim();
  if (!text || !currentContactEmail) return;
  contactMessageInput.value = "";
  try {
    const res = await fetch("/api/message/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to_email: currentContactEmail, text }),
    });
    const data = await res.json();
    if (data.error) {
      alert(data.error);
      return;
    }
    appendContactMessage({ id: data.id, from: myEmail, isMine: true, text });
  } catch (err) {
    alert("Could not send that message. Please try again.");
  }
};

// --- Image sending ---
imageBtn.onclick = () => {
  if (!currentContactEmail) {
    alert("Pick a contact first before sending an image.");
    return;
  }
  imageInput.click();
};

imageInput.onchange = async () => {
  const file = imageInput.files[0];
  imageInput.value = "";
  if (!file) return;

  if (!file.type.startsWith("image/")) {
    alert("Please select an image file.");
    return;
  }
  if (file.size > MAX_IMAGE_BYTES) {
    alert("Image is too large. Please pick something under 10MB.");
    return;
  }

  try {
    const base64Data = await fileToBase64(file);
    const res = await fetch("/api/message/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to_email: currentContactEmail,
        text: base64Data,
        msgType: "image",
        mimeType: file.type,
      }),
    });
    const data = await res.json();
    if (data.error) {
      alert(data.error);
      return;
    }
    appendContactMessage({
      id: data.id,
      from: myEmail,
      isMine: true,
      text: base64Data,
      msgType: "image",
      mimeType: file.type,
    });
  } catch (err) {
    alert("Could not send that image. Please try again.");
  }
};

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]); // strip the "data:...;base64," prefix
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

const DISPLAY_TIMEZONE = "Asia/Kolkata"; // always show India time, regardless of device settings

// Formats a date as YYYY-MM-DD *in IST specifically*, used only to compare
// whether two moments fall on the same calendar day in India — comparing
// raw Date objects directly can give the wrong day if the device itself is
// set to a different timezone.
function istDateKey(date) {
  return date.toLocaleDateString("en-CA", { timeZone: DISPLAY_TIMEZONE });
}

function formatDateLabel(date) {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const key = istDateKey(date);
  if (key === istDateKey(now)) return "Today";
  if (key === istDateKey(yesterday)) return "Yesterday";
  return date.toLocaleDateString("en-IN", { timeZone: DISPLAY_TIMEZONE, day: "numeric", month: "short", year: "numeric" });
}

function formatTimeLabel(date) {
  return date.toLocaleTimeString("en-IN", { timeZone: DISPLAY_TIMEZONE, hour: "2-digit", minute: "2-digit", hour12: true });
}

function appendDateSeparatorIfNeeded(date) {
  const label = formatDateLabel(date);
  if (label === lastRenderedDateLabel) return;
  lastRenderedDateLabel = label;
  const sep = document.createElement("div");
  sep.className = "date-separator";
  sep.textContent = label;
  contactMessagesEl.appendChild(sep);
}

const URL_REGEX = /(https?:\/\/[^\s]+)/g;

// Safely builds message content with clickable links, without using
// innerHTML (avoids any XSS risk from message text). Tapping a link like
// an Instagram or Facebook URL will open it in the browser, and Android
// will automatically offer to open it in that app instead if installed —
// that's standard OS behavior once it's a real link, no special code
// needed for that part.
function appendLinkifiedText(container, text) {
  let lastIndex = 0;
  let match;
  URL_REGEX.lastIndex = 0;
  while ((match = URL_REGEX.exec(text)) !== null) {
    if (match.index > lastIndex) {
      container.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
    }
    const a = document.createElement("a");
    a.href = match[0];
    a.textContent = match[0];
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.className = "msg-link";
    container.appendChild(a);
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    container.appendChild(document.createTextNode(text.slice(lastIndex)));
  }
}

function appendContactMessage(m) {
  const msgDate = m.createdAt ? new Date(m.createdAt) : new Date();
  appendDateSeparatorIfNeeded(msgDate);

  const div = document.createElement("div");
  div.className = `message ${m.isMine ? "mine" : "theirs"}`;
  div.dataset.messageId = m.id;

  const senderLabel = m.isMine ? "You" : currentContactName || m.from;

  if (m.msgType === "image") {
    const label = document.createElement("div");
    label.className = "image-label";
    label.textContent = `${senderLabel}:`;
    div.appendChild(label);

    const dataUrl = `data:${m.mimeType || "image/jpeg"};base64,${m.text}`;
    const img = document.createElement("img");
    img.src = dataUrl;
    img.className = "chat-image";
    img.style.cursor = "zoom-in";
    img.onclick = () => openImageLightbox(dataUrl);
    div.appendChild(img);

    const downloadLink = document.createElement("a");
    downloadLink.href = dataUrl;
    downloadLink.download = `image-${m.id}.${(m.mimeType || "image/jpeg").split("/")[1] || "jpg"}`;
    downloadLink.textContent = "Download";
    downloadLink.className = "image-download-link";
    div.appendChild(downloadLink);
  } else {
    div.appendChild(document.createTextNode(`${senderLabel}: `));
    appendLinkifiedText(div, m.text);
  }

  const timeLabel = document.createElement("span");
  timeLabel.className = "msg-time";
  timeLabel.textContent = ` ${formatTimeLabel(msgDate)}`;
  div.appendChild(timeLabel);

  if (m.isMine) {
    const tick = document.createElement("span");
    tick.className = `seen-tick ${m.seen ? "seen" : "unseen"}`;
    tick.textContent = m.seen ? " ✓✓" : " ✓";
    tick.dataset.tickFor = m.id;
    div.appendChild(tick);
  }

  const actions = document.createElement("div");
  actions.className = "contact-msg-actions";

  const deleteForMeBtn = document.createElement("button");
  deleteForMeBtn.textContent = "Delete for me";
  deleteForMeBtn.onclick = () => deleteContactMessage(m.id, "delete-for-me", div);
  actions.appendChild(deleteForMeBtn);

  if (m.isMine) {
    const deleteForEveryoneBtn = document.createElement("button");
    deleteForEveryoneBtn.textContent = "Delete for everyone";
    deleteForEveryoneBtn.onclick = () => deleteContactMessage(m.id, "delete-for-everyone", div);
    actions.appendChild(deleteForEveryoneBtn);
  }

  div.appendChild(actions);
  contactMessagesEl.appendChild(div);
  contactMessagesEl.scrollTop = contactMessagesEl.scrollHeight;
}

async function deleteContactMessage(id, endpoint, el) {
  try {
    const res = await fetch(`/api/message/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    const data = await res.json();
    if (data.error) {
      alert(data.error);
      return;
    }
    el.remove();
  } catch (err) {
    alert("Could not delete that message. Please try again.");
  }
}

socket.on("contact_message_received", (m) => {
  if (currentContactEmail && m.from.toLowerCase() === currentContactEmail.toLowerCase()) {
    appendContactMessage(m);
    socket.emit("mark_seen", { other_email: currentContactEmail });
    clearPushNotifications(); // already looking at this exact chat — clear any tray notification right away
  }
});

socket.on("contact_message_deleted", ({ id }) => {
  const el = contactMessagesEl.querySelector(`[data-message-id="${id}"]`);
  if (el) el.remove();
});

socket.on("messages_seen", ({ ids }) => {
  (ids || []).forEach((id) => {
    const tick = contactMessagesEl.querySelector(`[data-tick-for="${id}"]`);
    if (tick) {
      tick.classList.remove("unseen");
      tick.classList.add("seen");
      tick.textContent = " ✓✓";
    }
  });
});

socket.on("presence_update", ({ email, online }) => {
  const normalized = email.toLowerCase();
  if (online) onlineEmails.add(normalized);
  else onlineEmails.delete(normalized);

  const li = contactsListEl.querySelector(`[data-email="${normalized}"]`);
  if (li) {
    const dot = li.querySelector(".status-dot");
    if (dot) dot.className = `status-dot ${online ? "online" : "offline"}`;
  }
  updateContactStatusDot();
});

loadContacts();

// ===========================================================================
// AUTO-LOGOUT after 2 minutes of inactivity
// ===========================================================================
const INACTIVITY_LIMIT_MS = 2 * 60 * 1000;
let inactivityTimer = null;
let lastActivityAt = Date.now();

function goToLock() {
  // Idle timeout and app-quit only require re-entering the PIN — the
  // Google sign-in itself stays intact. Only the manual Logout button
  // does a full session clear (see the "Logout" link's href).
  window.location.href = "/lock";
}

function resetInactivityTimer() {
  lastActivityAt = Date.now();
  if (inactivityTimer) clearTimeout(inactivityTimer);
  inactivityTimer = setTimeout(goToLock, INACTIVITY_LIMIT_MS);
}

["mousemove", "mousedown", "keydown", "touchstart", "scroll"].forEach((evt) => {
  document.addEventListener(evt, resetInactivityTimer, { passive: true });
});
resetInactivityTimer();

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    const elapsed = Date.now() - lastActivityAt;
    if (elapsed >= INACTIVITY_LIMIT_MS) {
      goToLock();
    } else {
      resetInactivityTimer();
    }
  }
});

// Note: quit-detection (full app close vs. minimize) runs as an inline
// script in lobby.html's <head>, so it executes instantly before any page
// content renders — see there for the actual check.

// ===========================================================================
// PUSH NOTIFICATIONS — lets you know about a new message while offline.
// The notification itself is deliberately generic (looks like a shopping
// alert, not a chat app) — that's controlled entirely server-side; this
// code just handles asking permission and registering the subscription.
// ===========================================================================
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

async function setupPushNotifications() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;

  try {
    const keyRes = await fetch("/api/push/vapid-public-key");
    const { key } = await keyRes.json();
    if (!key) return; // push not configured server-side yet

    const permission = await Notification.requestPermission();
    if (permission !== "granted") return;

    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      });
    }

    await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(subscription),
    });
  } catch (e) {
    console.error("Push notification setup failed:", e);
  }
}

setupPushNotifications();

// Tell the service worker to dismiss any lingering notifications whenever
// you actually open or return to the app — matches "once I see it by
// checking the app, the notification should disappear."
function clearPushNotifications() {
  if (navigator.serviceWorker && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({ type: "CLOSE_NOTIFICATIONS" });
  }
}

clearPushNotifications(); // on initial load
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") clearPushNotifications();
});