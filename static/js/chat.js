const socket = io();

const onlineListEl = document.getElementById("online-list");
const noChatEl = document.getElementById("no-chat");
const chatWindowEl = document.getElementById("chat-window");
const partnerNameEl = document.getElementById("partner-name");
const messagesEl = document.getElementById("messages");
const messageForm = document.getElementById("message-form");
const messageInput = document.getElementById("message-input");
const leaveBtn = document.getElementById("leave-btn");
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

async function generateKeyPair() {
  myKeyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey"]
  );
}

async function exportPublicKey() {
  const raw = await crypto.subtle.exportKey("raw", myKeyPair.publicKey);
  return btoa(String.fromCharCode(...new Uint8Array(raw)));
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
    iv: btoa(String.fromCharCode(...iv)),
    data: btoa(String.fromCharCode(...new Uint8Array(ciphertext))),
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
  appendTextMessage(`You: ${text}`, "mine");
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
    alert("Image is too large. Please pick something under 4MB.");
    return;
  }

  const arrayBuffer = await file.arrayBuffer();
  const encrypted = await encryptBytes(arrayBuffer);
  socket.emit("send_message", { ...encrypted, msgType: "image", mimeType: file.type });

  const localUrl = URL.createObjectURL(file);
  appendImageMessage(localUrl, "You", "mine");
};

leaveBtn.onclick = () => {
  socket.emit("leave_chat");
  chatWindowEl.classList.add("hidden");
  noChatEl.classList.remove("hidden");
  myCurrentRoom = null;
  sharedKey = null;
};

function appendTextMessage(text, cls) {
  const div = document.createElement("div");
  div.className = `message ${cls}`;
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
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

  messagesEl.appendChild(wrapper);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}