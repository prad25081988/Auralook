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

socket.on("online_list", (users) => {
  onlineListEl.innerHTML = "";
  users.forEach((u) => {
    if (u.sid === socket.id) return; // don't show yourself
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

socket.on("chat_started", ({ room, with_name }) => {
  myCurrentRoom = room;
  partnerNameEl.textContent = with_name;
  messagesEl.innerHTML = "";
  noChatEl.classList.add("hidden");
  chatWindowEl.classList.remove("hidden");
});

socket.on("receive_message", ({ text, from }) => {
  appendMessage(`${from}: ${text}`, "theirs");
});

socket.on("partner_left", () => {
  appendMessage("The other person left the chat.", "system");
  myCurrentRoom = null;
});

messageForm.onsubmit = (e) => {
  e.preventDefault();
  const text = messageInput.value.trim();
  if (!text || !myCurrentRoom) return;
  socket.emit("send_message", { text });
  appendMessage(`You: ${text}`, "mine");
  messageInput.value = "";
};

leaveBtn.onclick = () => {
  socket.emit("leave_chat");
  chatWindowEl.classList.add("hidden");
  noChatEl.classList.remove("hidden");
  myCurrentRoom = null;
};

function appendMessage(text, cls) {
  const div = document.createElement("div");
  div.className = `message ${cls}`;
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}
