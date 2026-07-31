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
      if (!confirm(`Remove ${nickname || email} from your chats?`)) return;
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
    addContactForm.classList.add("hidden"); // fold the form back away after a successful add
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
    // This chat is already open, so mark it seen immediately instead of
    // waiting for the next time the conversation is opened.
    socket.emit("mark_seen", { other_email: currentContactEmail });
  }
});

socket.on("contact_message_deleted", ({ id }) => {
  const el = contactMessagesEl.querySelector(`[data-message-id="${id}"]`);
  if (el) el.remove();
});

// The sender gets told live when their sent messages were just seen —
// flip those ticks from grey to blue right away.
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

// Presence — only ever shown for people already in your Chats list. The
// server broadcasts this for everyone technically, but we simply never
// render anyone who isn't in myContacts, so no one else's status is ever
// visible in this UI.
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
const LAST_ACTIVE_KEY = "auralook_last_active";
let inactivityTimer = null;

function goToLock() {
  // Idle timeout and app-quit only require re-entering the PIN — the
  // Google sign-in itself stays intact. Only the manual Logout button
  // does a full session clear (see the "Logout" link's href).
  window.location.href = "/lock";
}

function resetInactivityTimer() {
  // localStorage (not a plain JS variable) so this timestamp survives
  // even if Android fully kills and restarts the app process — the head
  // script in lobby.html reads this same key on the next page load.
  localStorage.setItem(LAST_ACTIVE_KEY, String(Date.now()));
  if (inactivityTimer) clearTimeout(inactivityTimer);
  inactivityTimer = setTimeout(goToLock, INACTIVITY_LIMIT_MS);
}

["mousemove", "mousedown", "keydown", "touchstart", "scroll"].forEach((evt) => {
  document.addEventListener(evt, resetInactivityTimer, { passive: true });
});
resetInactivityTimer();

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    // Ask the server directly whether it's still unlocked, rather than
    // guessing from a client-side timestamp. This works even if Android
    // just resumed an already-loaded page from memory without making any
    // new network request on its own — this fetch call itself becomes
    // that first request, and the server's own idle timer (tracked via
    // real request timestamps, not anything client-side) gives the
    // authoritative answer.
    fetch("/api/session-check")
      .then((res) => res.json())
      .then((data) => {
        if (data.locked) {
          goToLock();
        } else {
          resetInactivityTimer();
        }
      })
      .catch(() => {
        // If even this check fails (e.g. no network yet), fall back to
        // the local timestamp as a reasonable best guess.
        const lastActive = parseInt(localStorage.getItem(LAST_ACTIVE_KEY) || "0", 10);
        if (Date.now() - lastActive >= INACTIVITY_LIMIT_MS) goToLock();
      });
  }
});

// Note: the check for "has it been 2+ minutes since I was last active" runs
// twice, on purpose: once instantly in lobby.html's <head> (covers a full
// app kill + restart, before any content renders), and again here via
// visibilitychange (covers Android just pausing the process without fully
// killing it, where no fresh page load happens at all). Both read the same
// localStorage timestamp, so they stay in agreement regardless of which
// scenario actually occurred.

// Defense-in-depth: if the browser ever restores this page from
// "back/forward cache" (bfcache) despite the no-store header on the
// server response, "pageshow" still fires with event.persisted = true —
// unlike a plain script tag, which would NOT re-run in that case. Re-check
// here too, so there's no gap even in that edge case.
window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    const lastActive = parseInt(localStorage.getItem(LAST_ACTIVE_KEY) || "0", 10);
    const elapsed = Date.now() - lastActive;
    if (elapsed >= INACTIVITY_LIMIT_MS) {
      goToLock();
    }
  }
});