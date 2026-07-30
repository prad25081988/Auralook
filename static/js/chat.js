// Auralook — chat logic.
//
// Two separate systems, by design:
// 1. CONTACTS (persistent) — added once, then chat anytime online or
//    offline, no permission needed, capped at 5 most recent messages.
// 2. EPHEMERAL (temporary) — for people online but not yet added. Requires
//    the other person to accept a request, and disappears the instant
//    either side disconnects. Nothing here is ever stored.

const socket = io();
const myEmail = document.body.dataset.myEmail;

// --- Contacts (persistent) elements ---
const contactsListEl = document.getElementById("contacts-list");
const onlineUsersListEl = document.getElementById("online-users-list");
const addContactForm = document.getElementById("add-contact-form");
const addContactInput = document.getElementById("add-contact-input");
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

// --- Ephemeral (temporary, permission-based) elements ---
const ephemeralChatWindowEl = document.getElementById("ephemeral-chat-window");
const ephemeralPartnerNameEl = document.getElementById("ephemeral-partner-name");
const ephemeralMessagesEl = document.getElementById("ephemeral-messages");
const ephemeralMessageForm = document.getElementById("ephemeral-message-form");
const ephemeralMessageInput = document.getElementById("ephemeral-message-input");
const ephemeralLeaveBtn = document.getElementById("ephemeral-leave-btn");

const modalEl = document.getElementById("request-modal");
const requestTextEl = document.getElementById("request-text");
const acceptBtn = document.getElementById("accept-btn");
const declineBtn = document.getElementById("decline-btn");

let currentContactEmail = null;
let currentContactName = null;
let onlineEmails = new Set();
let myContactEmails = new Set();
let latestOnlineUsers = []; // [{email, name}]
let pendingRequesterSid = null;

function hideAllChatWindows() {
  noChatEl.classList.add("hidden");
  contactChatWindowEl.classList.add("hidden");
  ephemeralChatWindowEl.classList.add("hidden");
}

// ===========================================================================
// CONTACTS (persistent)
// ===========================================================================
async function loadContacts() {
  try {
    const res = await fetch("/api/contacts/list");
    const data = await res.json();
    if (data.error) return;
    myContactEmails = new Set((data.contacts || []).map((c) => c.email.toLowerCase()));
    renderContactsList(data.contacts || []);
    renderOnlineUsersList();
  } catch (e) {
    console.error("Failed to load contacts:", e);
  }
}

function renderContactsList(contacts) {
  contactsListEl.innerHTML = "";
  contacts.forEach(({ email, displayName, online }) => {
    const li = document.createElement("li");
    li.className = "contact-item";
    li.dataset.email = email;

    const dot = document.createElement("span");
    dot.className = `status-dot ${online ? "online" : "offline"}`;
    li.appendChild(dot);

    const label = document.createElement("span");
    label.className = "contact-label";
    label.textContent = displayName || email;
    label.onclick = () => openContactChat(email, displayName || email);
    li.appendChild(label);

    const removeBtn = document.createElement("button");
    removeBtn.className = "remove-contact-btn";
    removeBtn.textContent = "Remove";
    removeBtn.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`Remove ${displayName || email} from your chats?`)) return;
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

async function addContactByEmail(email) {
  try {
    const res = await fetch("/api/contacts/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const data = await res.json();
    if (data.error) {
      alert(data.error);
      return;
    }
    loadContacts();
  } catch (err) {
    alert("Could not add this contact. Please try again.");
  }
}

async function openContactChat(email, displayName) {
  currentContactEmail = email;
  currentContactName = displayName;
  contactPartnerNameEl.textContent = displayName;
  updateContactStatusDot();

  hideAllChatWindows();
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
  hideAllChatWindows();
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
    alert("Could not clear this chat. Please try again.");
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

function appendContactMessage(m) {
  const div = document.createElement("div");
  div.className = `message ${m.isMine ? "mine" : "theirs"}`;
  div.dataset.messageId = m.id;
  div.textContent = `${m.isMine ? "You" : currentContactName || m.from}: ${m.text}`;

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
  }
});

socket.on("contact_message_deleted", ({ id }) => {
  const el = contactMessagesEl.querySelector(`[data-message-id="${id}"]`);
  if (el) el.remove();
});

// ===========================================================================
// "Online now" discovery list — anyone connected who ISN'T already a
// contact. Has both an Add button (saves them permanently, no permission
// chat needed from then on) and a Chat button (starts a permission-based
// ephemeral chat instead).
// ===========================================================================
function renderOnlineUsersList() {
  onlineUsersListEl.innerHTML = "";
  const others = latestOnlineUsers.filter(
    (u) => u.email.toLowerCase() !== myEmail.toLowerCase() && !myContactEmails.has(u.email.toLowerCase())
  );
  if (others.length === 0) {
    const li = document.createElement("li");
    li.className = "empty-note";
    li.textContent = "No one else online right now.";
    onlineUsersListEl.appendChild(li);
    return;
  }
  others.forEach(({ email, name }) => {
    const li = document.createElement("li");
    li.className = "contact-item";

    const dot = document.createElement("span");
    dot.className = "status-dot online";
    li.appendChild(dot);

    const label = document.createElement("span");
    label.className = "contact-label";
    label.textContent = name || email;
    li.appendChild(label);

    const chatBtn = document.createElement("button");
    chatBtn.className = "chat-request-btn";
    chatBtn.textContent = "Chat";
    chatBtn.title = "Ask permission to start a temporary chat";
    chatBtn.onclick = () => requestEphemeralChat(email);
    li.appendChild(chatBtn);

    const addBtn = document.createElement("button");
    addBtn.className = "add-online-btn";
    addBtn.textContent = "Add";
    addBtn.title = "Save as a contact — chat anytime, no permission needed";
    addBtn.onclick = () => addContactByEmail(email);
    li.appendChild(addBtn);

    onlineUsersListEl.appendChild(li);
  });
}

// We need each online user's sid to send a chat request — the presence
// broadcast includes email/name; sid lookup happens by asking chat.js's own
// socket to resolve it via a small server round trip using email as the key.
// Simplest: request_chat takes an email; server resolves sid itself.
function requestEphemeralChat(email) {
  socket.emit("request_chat", { target_email: email.toLowerCase() });
}

// ===========================================================================
// EPHEMERAL chat (temporary, permission-based, never stored)
// ===========================================================================
socket.on("incoming_request", ({ from_sid, from_name }) => {
  pendingRequesterSid = from_sid;
  requestTextEl.textContent = `${from_name} wants to chat with you.`;
  modalEl.classList.remove("hidden");
});

acceptBtn.onclick = () => {
  socket.emit("respond_chat", { accepted: true, requester_sid: pendingRequesterSid });
  modalEl.classList.add("hidden");
};

declineBtn.onclick = () => {
  socket.emit("respond_chat", { accepted: false, requester_sid: pendingRequesterSid });
  modalEl.classList.add("hidden");
};

socket.on("chat_declined", () => alert("The other user declined your chat request."));
socket.on("chat_error", ({ message }) => alert(message));

socket.on("chat_started", ({ with_name }) => {
  ephemeralPartnerNameEl.textContent = with_name;
  ephemeralMessagesEl.innerHTML = "";
  hideAllChatWindows();
  ephemeralChatWindowEl.classList.remove("hidden");
});

socket.on("ephemeral_message", ({ text, from }) => {
  appendEphemeralMessage(`${from}: ${text}`, "theirs");
});

socket.on("ephemeral_partner_left", () => {
  appendEphemeralMessage("The other person left the chat.", "system");
});

ephemeralMessageForm.onsubmit = (e) => {
  e.preventDefault();
  const text = ephemeralMessageInput.value.trim();
  if (!text) return;
  socket.emit("ephemeral_message", { text });
  appendEphemeralMessage(`You: ${text}`, "mine");
  ephemeralMessageInput.value = "";
};

ephemeralLeaveBtn.onclick = () => {
  socket.emit("leave_ephemeral_chat");
  hideAllChatWindows();
  noChatEl.classList.remove("hidden");
};

function appendEphemeralMessage(text, cls) {
  const div = document.createElement("div");
  div.className = `message ${cls}`;
  div.textContent = text;
  ephemeralMessagesEl.appendChild(div);
  ephemeralMessagesEl.scrollTop = ephemeralMessagesEl.scrollHeight;
}

// ===========================================================================
// Presence
// ===========================================================================
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

socket.on("online_users_update", ({ users }) => {
  latestOnlineUsers = users || [];
  renderOnlineUsersList();
});

loadContacts();

// ===========================================================================
// AUTO-LOGOUT after 3 minutes of inactivity
// ===========================================================================
const INACTIVITY_LIMIT_MS = 2 * 60 * 1000;
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

// ===========================================================================
// QUIT DETECTION — fully closing the app (swiping it away, force-closing)
// should log out immediately, unlike just minimizing which follows the
// normal 2-minute inactivity timer above.
//
// sessionStorage is the right tool here: it's tied to the actual lifetime of
// this browsing context/tab and is guaranteed by the browser to be wiped the
// moment that context is truly destroyed — no JS needs to run during the
// kill for this to happen, unlike events such as "pagehide" which can be
// skipped entirely if the OS terminates the process abruptly. Every page in
// the app (login, pin, set-name, lobby) marks this same flag the moment it
// loads. If the lobby ever loads WITHOUT that flag already present, it means
// this is a brand new browsing context that skipped straight to the lobby —
// which only happens if the app was fully quit and reopened while the login
// cookie was still otherwise valid. In that case, force a fresh login.
(function () {
  const alreadyActive = sessionStorage.getItem("auralook_ctx_active") === "true";
  sessionStorage.setItem("auralook_ctx_active", "true");
  if (!alreadyActive) {
    goToLogin();
  }
})();