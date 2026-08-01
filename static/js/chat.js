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

function appendContactMessage(m) {
  const msgDate = m.createdAt ? new Date(m.createdAt) : new Date();
  appendDateSeparatorIfNeeded(msgDate);

  const div = document.createElement("div");
  div.className = `message ${m.isMine ? "mine" : "theirs"}`;
  div.dataset.messageId = m.id;
  div.textContent = `${m.isMine ? "You" : currentContactName || m.from}: ${m.text}`;

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