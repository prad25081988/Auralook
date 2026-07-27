"""
Live-only chat app.
- Login with Google account
- See who else is online right now
- Request to chat 1-on-1
- Messages travel ONLY through the live socket connection
- Nothing is ever written to a database or file.
  Close the tab / disconnect => the conversation is gone forever.
"""

import os
import uuid
from flask import Flask, redirect, url_for, session, render_template, request
from flask_socketio import SocketIO, emit, join_room, leave_room
from authlib.integrations.flask_client import OAuth

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "dev-secret-change-me")
socketio = SocketIO(
    app,
    cors_allowed_origins="*",
    async_mode="threading",
    max_http_buffer_size=6 * 1024 * 1024,  # allow images up to ~6MB through the socket
)

# ---------------------------------------------------------------------------
# Google OAuth setup
# You must create your own credentials at https://console.cloud.google.com/
# and set them as environment variables before running:
#   GOOGLE_CLIENT_ID=xxxx
#   GOOGLE_CLIENT_SECRET=xxxx
# ---------------------------------------------------------------------------
oauth = OAuth(app)
google = oauth.register(
    name="google",
    client_id=os.environ.get("GOOGLE_CLIENT_ID"),
    client_secret=os.environ.get("GOOGLE_CLIENT_SECRET"),
    server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
    client_kwargs={"scope": "openid email profile"},
)

# ---------------------------------------------------------------------------
# IN-MEMORY STATE ONLY — nothing here ever touches disk or a database.
# All of this is wiped the moment the server restarts, and per-user entries
# are wiped the moment that user disconnects.
# ---------------------------------------------------------------------------
online_users = {}      # sid -> {"name": str, "email": str, "user_id": str}
pending_requests = {}  # target_sid -> requester_sid
active_rooms = {}      # sid -> room_id (so we know who is currently chatting)


# ---------------------------------------------------------------------------
# Auth routes
# ---------------------------------------------------------------------------
@app.route("/")
def index():
    user = session.get("user")
    if not user:
        return render_template("login.html")
    return render_template("lobby.html", user=user)


@app.route("/login")
def login():
    redirect_uri = url_for("auth_callback", _external=True)
    return google.authorize_redirect(redirect_uri)


@app.route("/auth/callback")
def auth_callback():
    token = google.authorize_access_token()
    user_info = token.get("userinfo")
    session["user"] = {
        "id": user_info["sub"],
        "name": user_info.get("name"),
        "email": user_info.get("email"),
        "picture": user_info.get("picture"),
    }
    return redirect(url_for("index"))


@app.route("/logout")
def logout():
    session.pop("user", None)
    return redirect(url_for("index"))


# ---------------------------------------------------------------------------
# Socket.IO events — presence + signaling + relaying chat messages live
# ---------------------------------------------------------------------------
@socketio.on("connect")
def on_connect():
    user = session.get("user")
    if not user:
        return False  # reject unauthenticated sockets

    online_users[request.sid] = {
        "name": user["name"],
        "email": user["email"],
        "user_id": user["id"],
    }
    broadcast_online_list()


@socketio.on("disconnect")
def on_disconnect():
    sid = request.sid
    online_users.pop(sid, None)

    # If they were in a room, tell the partner and tear the room down
    room_id = active_rooms.pop(sid, None)
    if room_id:
        emit("partner_left", {}, room=room_id)

    # Clean up any pending request pointing at/from this sid
    pending_requests.pop(sid, None)
    for target, requester in list(pending_requests.items()):
        if requester == sid:
            pending_requests.pop(target, None)

    broadcast_online_list()


def broadcast_online_list():
    users = [
        {"sid": sid, "name": info["name"]}
        for sid, info in online_users.items()
    ]
    emit("online_list", users, broadcast=True)


@socketio.on("request_chat")
def on_request_chat(data):
    target_sid = data.get("target_sid")
    if target_sid not in online_users:
        emit("chat_error", {"message": "That user is no longer online."})
        return
    pending_requests[target_sid] = request.sid
    requester_name = online_users[request.sid]["name"]
    emit("incoming_request", {"from_sid": request.sid, "from_name": requester_name}, room=target_sid)


@socketio.on("respond_chat")
def on_respond_chat(data):
    accepted = data.get("accepted")
    requester_sid = data.get("requester_sid")
    target_sid = request.sid

    pending_requests.pop(target_sid, None)

    if not accepted:
        emit("chat_declined", {}, room=requester_sid)
        return

    if requester_sid not in online_users:
        emit("chat_error", {"message": "The other user disconnected."})
        return

    room_id = str(uuid.uuid4())
    join_room(room_id, sid=requester_sid)
    join_room(room_id, sid=target_sid)
    active_rooms[requester_sid] = room_id
    active_rooms[target_sid] = room_id

    emit("chat_started", {"room": room_id, "with_name": online_users[target_sid]["name"]}, room=requester_sid)
    emit("chat_started", {"room": room_id, "with_name": online_users[requester_sid]["name"]}, room=target_sid)


@socketio.on("exchange_key")
def on_exchange_key(data):
    room_id = active_rooms.get(request.sid)
    if not room_id:
        return
    # Just relay the public key blindly — server never sees the private key
    # or the resulting shared secret, so it can never decrypt messages.
    emit("exchange_key", {"publicKey": data.get("publicKey")}, room=room_id, include_self=False)


@socketio.on("send_message")
def on_send_message(data):
    room_id = active_rooms.get(request.sid)
    if not room_id:
        return
    sender_name = online_users.get(request.sid, {}).get("name", "Unknown")
    # The server only ever sees the encrypted blob (iv + ciphertext).
    # It has no key to decrypt it and never stores it anywhere — same
    # rule applies whether this is a text message or an image.
    emit(
        "receive_message",
        {
            "iv": data.get("iv"),
            "data": data.get("data"),
            "from": sender_name,
            "msgType": data.get("msgType", "text"),
            "mimeType": data.get("mimeType"),
        },
        room=room_id,
        include_self=False,
    )


@socketio.on("leave_chat")
def on_leave_chat():
    room_id = active_rooms.pop(request.sid, None)
    if room_id:
        leave_room(room_id)
        emit("partner_left", {}, room=room_id)


if __name__ == "__main__":
    socketio.run(app, host="0.0.0.0", port=5000, debug=True)