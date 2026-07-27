const socket = io();

const onlineListEl = document.getElementById("online-list");
const noChatEl = document.getElementById("no-chat");
const chatWindowEl = document.getElementById("chat-window");
const partnerNameEl = document.getElementById("partner-name");
const messagesEl = document.getElementById("messages");
const messageForm = document.getElementById("message-form");
const messageInput = document.getElementById("message-input");
const leaveBtn = document.getElementById("leave-btn");
const clearChatBtn = document.getElementById("clear-chat-btn");
const selectModeBtn = document.getElementById("select-mode-btn");
const deleteSelectedBtn = document.getElementById("delete-selected-btn");
const imageInput = document.getElementById("image-input");
const imageBtn = document.getElementById("image-btn");

const modalEl = document.getElementById("request-modal");
const requestTextEl = document.getElementById("request-text");
const acceptBtn = document.getElementById("accept-btn");
const declineBtn = document.getElementById("decline-btn");

let myCurrentRoom = null;
let pendingRequesterSid = null;

const MAX_IMAGE_BYTES = 15 * 1024 * 1024; // 15MB cap, server buffer sized with headroom above this

// --- End-to-end encryption state (per chat session) ---
let myKeyPair = null;
let sharedKey = null;

// Converting large byte arrays to base64 using String.fromCharCode(...bytes)
// crashes once bytes.length gets much above ~65,000 (call-stack limit) —
// which any real photo blows past instantly. This chunked version has no
// such limit, so images of any reasonable size encode safely.
function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000; // 32KB per chunk
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function generateKeyPair() {
  myKeyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey"]
  );
}

async function exportPublicKey() {
  const raw = await crypto.subtle.exportKey("raw", myKeyPair.publicKey);
  return bytesToBase64(new Uint8Array(raw));
}

async function deriveSharedKey(partnerPublicKeyBase64) {
  const raw = Uint8Array.from(atob(partnerPublicKeyBase64), (c) => c.charCodeAt(0));
  const partnerPublicKey = await crypto.subtle.importKey(
    "raw",
    raw,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    []
  );
  sharedKey = await crypto.subtle.deriveKey(
    { name: "ECDH", public: partnerPublicKey },
    myKeyPair.privateKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

// Generic encrypt/decrypt over raw bytes — used for both text and images
async function encryptBytes(bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, sharedKey, bytes);
  return {
    iv: bytesToBase64(iv),
    data: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

async function decryptBytes(payload) {
  const iv = Uint8Array.from(atob(payload.iv), (c) => c.charCodeAt(0));
  const data = Uint8Array.from(atob(payload.data), (c) => c.charCodeAt(0));
  const plainBuffer = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, sharedKey, data);
  return plainBuffer;
}

async function encryptMessage(plainText) {
  return encryptBytes(new TextEncoder().encode(plainText));
}

async function decryptMessage(payload) {
  const buffer = await decryptBytes(payload);
  return new TextDecoder().decode(buffer);
}

// --- Presence list ---
socket.on("online_list", (users) => {
  onlineListEl.innerHTML = "";
  users.forEach((u) => {
    if (u.sid === socket.id) return;
    const li = document.createElement("li");
    li.textContent = u.name;
    const btn = document.createElement("button");
    btn.textContent = "Chat";
    btn.onclick = () => socket.emit("request_chat", { target_sid: u.sid });
    li.appendChild(btn);
    onlineListEl.appendChild(li);
  });
});

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

socket.on("chat_declined", () => {
  alert("The other user declined your chat request.");
});

socket.on("chat_error", ({ message }) => {
  alert(message);
});

// --- Chat starts: generate keys and swap public keys before anyone can type ---
socket.on("chat_started", async ({ room, with_name }) => {
  myCurrentRoom = room;
  sharedKey = null;
  partnerNameEl.textContent = with_name;
  messagesEl.innerHTML = "";
  noChatEl.classList.add("hidden");
  chatWindowEl.classList.remove("hidden");
  appendSystemMessage("Setting up secure encryption for this chat...");

  await generateKeyPair();
  const myPublicKey = await exportPublicKey();
  socket.emit("exchange_key", { publicKey: myPublicKey });
});

socket.on("exchange_key", async ({ publicKey }) => {
  await deriveSharedKey(publicKey);
  appendSystemMessage("🔒 Chat is now end-to-end encrypted.");
});

socket.on("receive_message", async (payload) => {
  if (!sharedKey) return;
  try {
    if (payload.msgType === "image") {
      const buffer = await decryptBytes(payload);
      const blob = new Blob([buffer], { type: payload.mimeType || "image/jpeg" });
      appendImageMessage(URL.createObjectURL(blob), payload.from, "theirs");
    } else {
      const text = await decryptMessage(payload);
      appendTextMessage(`${payload.from}: ${text}`, "theirs");
    }
  } catch (e) {
    appendSystemMessage("[Could not decrypt an incoming message]");
  }
});

socket.on("partner_left", () => {
  appendSystemMessage("The other person left the chat.");
  myCurrentRoom = null;
  sharedKey = null;
});

messageForm.onsubmit = async (e) => {
  e.preventDefault();
  const text = messageInput.value.trim();
  if (!text || !myCurrentRoom || !sharedKey) return;
  const encrypted = await encryptMessage(text);
  socket.emit("send_message", { ...encrypted, msgType: "text" });
  appendTextMessage(`You: ${text}`, "mine", true); // true = show sent checkmark
  messageInput.value = "";
};

// --- Image sending ---
imageBtn.onclick = () => {
  if (!myCurrentRoom || !sharedKey) {
    alert("You need an active encrypted chat before sending an image.");
    return;
  }
  imageInput.click();
};

imageInput.onchange = async () => {
  const file = imageInput.files[0];
  imageInput.value = ""; // reset so selecting the same file again still fires onchange
  if (!file) return;

  if (!file.type.startsWith("image/")) {
    alert("Please select an image file.");
    return;
  }
  if (file.size > MAX_IMAGE_BYTES) {
    alert("Image is too large. Please pick something under 15MB.");
    return;
  }

  // Show an immediate "Sending..." placeholder so large photos don't look frozen
  const placeholder = appendSendingPlaceholder();

  try {
    const arrayBuffer = await file.arrayBuffer();
    const encrypted = await encryptBytes(arrayBuffer);
    socket.emit("send_message", { ...encrypted, msgType: "image", mimeType: file.type });

    const localUrl = URL.createObjectURL(file);
    replaceWithImageMessage(placeholder, localUrl, "You", "mine");
  } catch (err) {
    console.error("Image send failed:", err);
    placeholder.remove();
    alert("Something went wrong sending that image. Please try again with a smaller file.");
  }
};

leaveBtn.onclick = () => {
  socket.emit("leave_chat");
  chatWindowEl.classList.add("hidden");
  noChatEl.classList.remove("hidden");
  myCurrentRoom = null;
  sharedKey = null;
};

function appendTextMessage(text, cls, showSent) {
  const div = document.createElement("div");
  div.className = `message ${cls}`;
  div.textContent = text;
  if (showSent) {
    const tick = document.createElement("span");
    tick.className = "sent-tick";
    tick.textContent = " ✓";
    div.appendChild(tick);
  }
  if (cls !== "system") addDeleteButton(div);
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function appendSystemMessage(text) {
  appendTextMessage(text, "system");
}

function appendImageMessage(url, fromLabel, cls) {
  const wrapper = document.createElement("div");
  wrapper.className = `message ${cls} image-message`;

  const label = document.createElement("div");
  label.className = "image-label";
  label.textContent = fromLabel;
  wrapper.appendChild(label);

  const img = document.createElement("img");
  img.src = url;
  img.className = "chat-image";
  wrapper.appendChild(img);

  addDeleteButton(wrapper);
  messagesEl.appendChild(wrapper);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return wrapper;
}

// Placeholder shown while a photo is being encrypted/sent
function appendSendingPlaceholder() {
  const wrapper = document.createElement("div");
  wrapper.className = "message mine image-message sending-placeholder";
  wrapper.textContent = "Sending photo...";
  messagesEl.appendChild(wrapper);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return wrapper;
}

// Swap the placeholder out for the real image + a "Sent" checkmark once done
function replaceWithImageMessage(placeholder, url, fromLabel, cls) {
  placeholder.innerHTML = "";
  placeholder.className = `message ${cls} image-message`;

  const label = document.createElement("div");
  label.className = "image-label";
  label.textContent = fromLabel;
  placeholder.appendChild(label);

  const img = document.createElement("img");
  img.src = url;
  img.className = "chat-image";
  placeholder.appendChild(img);

  const tick = document.createElement("div");
  tick.className = "sent-tick image-sent-tick";
  tick.textContent = "Sent ✓";
  placeholder.appendChild(tick);

  addDeleteButton(placeholder);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// Adds a small "×" that removes just this one message from your own view,
// plus a checkbox (hidden unless "Select" mode is on) for bulk deletion.
// This never touches the other person's screen or any server data — since
// nothing is stored anywhere, "deleting" simply means removing it from the
// DOM here.
function addDeleteButton(el) {
  el.classList.add("has-delete");

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "msg-select-checkbox";
  el.appendChild(checkbox);

  const btn = document.createElement("button");
  btn.className = "delete-msg-btn";
  btn.setAttribute("aria-label", "Delete this message from your view");
  btn.textContent = "×";
  btn.onclick = () => el.remove();
  el.appendChild(btn);
}

// "Clear chat" — wipes every message from your own view in one go.
// Purely local: the other person's screen and the (nonexistent) server
// history are completely unaffected.
clearChatBtn.onclick = () => {
  messagesEl.innerHTML = "";
};

// --- Multi-select mode for bulk-deleting specific messages ---
let selectModeActive = false;

selectModeBtn.onclick = () => {
  selectModeActive = !selectModeActive;
  messagesEl.classList.toggle("select-mode", selectModeActive);
  selectModeBtn.textContent = selectModeActive ? "Cancel" : "Select";
  deleteSelectedBtn.classList.toggle("hidden", !selectModeActive);
  if (!selectModeActive) {
    // Leaving select mode: uncheck everything so it starts fresh next time
    messagesEl.querySelectorAll(".msg-select-checkbox").forEach((cb) => (cb.checked = false));
  }
};

deleteSelectedBtn.onclick = () => {
  const checked = messagesEl.querySelectorAll(".msg-select-checkbox:checked");
  checked.forEach((cb) => cb.closest(".message").remove());
};