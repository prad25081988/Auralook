// Auralook — unified chat system.
// One conversation per contact, whether they're online or not. Presence
// (the little dot) is purely informational and never affects the chat
// itself — messages are always stored and always available, live-delivered
// instantly when the other person happens to be connected.

const socket = io();
const myEmail = document.body.dataset.myEmail;

const contactsListEl = document.getElementById("contacts-list");
const addContactForm = document.getElementById("add-contact-form");
const addContactInput = document.getElementById("add-contact-input");
const addContactError = document.getElementById("add-contact-error");

const noChatEl = document.getElementById("no-chat");
const contactChatWindowEl = document.getElementById("contact-chat-window");
const contactStatusDotEl = document.getElementById("contact-status-dot");
const contactPartnerEmailEl = document.getElementById("contact-partner-email");
const contactMessagesEl = document.getElementById("contact-messages");
const contactMessageForm = document.getElementById("contact-message-form");
const contactMessageInput = document.getElementById("contact-message-input");
const contactCloseBtn = document.getElementById("contact-close-btn");

let currentContactEmail = null;
let onlineEmails = new Set(); // updated live via presence_update events

async function loadContacts() {
  try {
    const res = await fetch("/api/contacts/list");
    const data = await res.json();
    if (data.error) return;
    onlineEmails = new Set((data.contacts || []).filter((c) => c.online).map((c) => c.email));
    renderContactsList(data.contacts || []);
  } catch (e) {
    console.error("Failed to load contacts:", e);
  }
}

function renderContactsList(contacts) {
  contactsListEl.innerHTML = "";
  contacts.forEach(({ email, online }) => {
    const li = document.createElement("li");
    li.className = "contact-item";
    li.dataset.email = email;

    const dot = document.createElement("span");
    dot.className = `status-dot ${online ? "online" : "offline"}`;
    li.appendChild(dot);

    const label = document.createElement("span");
    label.textContent = email;
    li.appendChild(label);

    li.onclick = () => openContactChat(email);
    contactsListEl.appendChild(li);
  });
}

addContactForm.onsubmit = async (e) => {
  e.preventDefault();
  const email = addContactInput.value.trim().toLowerCase();
  addContactError.classList.add("hidden");
  try {
    const res = await fetch("/api/contacts/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const data = await res.json();
    if (data.error) {
      addContactError.textContent = data.error;
      addContactError.classList.remove("hidden");
      return;
    }
    addContactInput.value = "";
    loadContacts();
  } catch (err) {
    addContactError.textContent = "Could not add contact. Please try again.";
    addContactError.classList.remove("hidden");
  }
};

async function openContactChat(email) {
  currentContactEmail = email;
  contactPartnerEmailEl.textContent = email;
  updateContactStatusDot();

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
  contactChatWindowEl.classList.add("hidden");
  noChatEl.classList.remove("hidden");
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

function appendContactMessage(m) {
  const div = document.createElement("div");
  div.className = `message ${m.isMine ? "mine" : "theirs"}`;
  div.dataset.messageId = m.id;
  div.textContent = `${m.isMine ? "You" : m.from}: ${m.text}`;

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

// Live delivery — same conversation, just pushed instantly if the other
// person happens to be connected right now.
socket.on("contact_message_received", (m) => {
  if (currentContactEmail && m.from.toLowerCase() === currentContactEmail.toLowerCase()) {
    appendContactMessage(m);
  }
});

socket.on("contact_message_deleted", ({ id }) => {
  const el = contactMessagesEl.querySelector(`[data-message-id="${id}"]`);
  if (el) el.remove();
});

// Presence — purely a visual dot next to each contact and in the open chat
// header. Never affects whether messaging works.
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
// AUTO-LOGOUT after 3 minutes of inactivity
// ===========================================================================
const INACTIVITY_LIMIT_MS = 3 * 60 * 1000;
let inactivityTimer = null;
let lastActivityAt = Date.now();

function goToLogin() {
  window.location.href = "/logout";
}

function resetInactivityTimer() {
  lastActivityAt = Date.now();
  if (inactivityTimer) clearTimeout(inactivityTimer);
  inactivityTimer = setTimeout(goToLogin, INACTIVITY_LIMIT_MS);
}

["mousemove", "mousedown", "keydown", "touchstart", "scroll"].forEach((evt) => {
  document.addEventListener(evt, resetInactivityTimer, { passive: true });
});
resetInactivityTimer();

// Phones often pause background tabs entirely, so the setTimeout above may
// not fire exactly on time while minimized. To guarantee correctness, we
// also do an explicit check the moment the app becomes visible again — if
// 3+ minutes have genuinely passed since the last activity, log out
// immediately rather than briefly showing the old screen first.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    const elapsed = Date.now() - lastActivityAt;
    if (elapsed >= INACTIVITY_LIMIT_MS) {
      goToLogin();
    } else {
      resetInactivityTimer();
    }
  }
});