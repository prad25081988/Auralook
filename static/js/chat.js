const socket = io();

const onlineListEl = document.getElementById("online-list");
const noChatEl = document.getElementById("no-chat");
const chatWindowEl = document.getElementById("chat-window");
const partnerNameEl = document.getElementById("partner-name");
const messagesEl = document.getElementById("messages");
const messageForm = document.getElementById("message-form");
const messageInput = document.getElementById("message-input");
const leaveBtn = document.getElementById("leave-btn");

const modalEl = document.getElementById("request-modal");
const requestTextEl = document.getElementById("request-text");
const acceptBtn = document.getElementById("accept-btn");
const declineBtn = document.getElementById("decline-btn");

let myCurrentRoom = null;
let pendingRequesterSid = null;

// --- End-to-end encryption state (per chat session) ---
let myKeyPair = null;       // { publicKey, privateKey } - generated fresh each chat
let sharedKey = null;       // derived AES-GCM key, known only to the two browsers

// Generate a fresh ECDH key pair for this chat session
async function generateKeyPair() {
  myKeyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey"]
  );
}

// Export our public key so we can send it to the other side (safe to expose)
async function exportPublicKey() {
  const raw = await crypto.subtle.exportKey("raw", myKeyPair.publicKey);
  return btoa(String.fromCharCode(...new Uint8Array(raw)));
}

// Import the partner's public key and derive our shared AES-GCM key
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

async function encryptMessage(plainText) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plainText);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, sharedKey, encoded);
  return {
    iv: btoa(String.fromCharCode(...iv)),
    data: btoa(String.fromCharCode(...new Uint8Array(ciphertext))),
  };
}

async function decryptMessage(payload) {
  const iv = Uint8Array.from(atob(payload.iv), (c) => c.charCodeAt(0));
  const data = Uint8Array.from(atob(payload.data), (c) => c.charCodeAt(0));
  const plainBuffer = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, sharedKey, data);
  return new TextDecoder().decode(plainBuffer);
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
  appendMessage("Setting up secure encryption for this chat...", "system");

  await generateKeyPair();
  const myPublicKey = await exportPublicKey();
  socket.emit("exchange_key", { publicKey: myPublicKey });
});

socket.on("exchange_key", async ({ publicKey }) => {
  await deriveSharedKey(publicKey);
  appendMessage("🔒 Chat is now end-to-end encrypted.", "system");
});

socket.on("receive_message", async (payload) => {
  if (!sharedKey) return;
  try {
    const text = await decryptMessage(payload);
    appendMessage(`${payload.from}: ${text}`, "theirs");
  } catch (e) {
    appendMessage("[Could not decrypt a message]", "system");
  }
});

socket.on("partner_left", () => {
  appendMessage("The other person left the chat.", "system");
  myCurrentRoom = null;
  sharedKey = null;
});

messageForm.onsubmit = async (e) => {
  e.preventDefault();
  const text = messageInput.value.trim();
  if (!text || !myCurrentRoom || !sharedKey) return;
  const encrypted = await encryptMessage(text);
  socket.emit("send_message", encrypted);
  appendMessage(`You: ${text}`, "mine");
  messageInput.value = "";
};

leaveBtn.onclick = () => {
  socket.emit("leave_chat");
  chatWindowEl.classList.add("hidden");
  noChatEl.classList.remove("hidden");
  myCurrentRoom = null;
  sharedKey = null;
};

function appendMessage(text, cls) {
  const div = document.createElement("div");
  div.className = `message ${cls}`;
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}