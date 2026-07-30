"""
Auralook chat app.

Two messaging paths, by design:
1. LIVE chats between two people online at the same time — fully end-to-end
   encrypted (server never sees plaintext), nothing ever stored, exactly as
   before.
2. CONTACTS messaging — add someone by email, message them even while they
   are offline. This path is stored server-side (encrypted at rest, but the
   server does hold the key), capped at the 5 most recent messages per
   conversation, and supports "delete for me" / "delete for everyone".

Also includes: Google login, a shared PIN gate, a custom display name step,
and a 3-minute inactivity auto-logout (enforced client-side + a matching
server-side session lifetime).
"""

import os
import uuid
from datetime import timedelta
from flask import Flask, redirect, url_for, session, render_template, request, send_from_directory, jsonify
from flask_socketio import SocketIO, emit, join_room, leave_room
from authlib.integrations.flask_client import OAuth

import db

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "dev-secret-change-me")

# Auto-logout after 3 minutes of inactivity — this sets the server-side
# session lifetime; the client also runs its own inactivity timer (see
# chat.js) that calls /logout directly so it doesn't need to wait on a
# request to notice the session expired.
app.permanent_session_lifetime = timedelta(minutes=3)

socketio = SocketIO(
    app,
    cors_allowed_origins="*",
    async_mode="threading",
    max_http_buffer_size=22 * 1024 * 1024,  # headroom for 15MB images after base64 + JSON overhead
)

ACCESS_PIN = os.environ.get("ACCESS_PIN", "bp")
SKIP_GOOGLE_LOGIN = os.environ.get("SKIP_GOOGLE_LOGIN", "true").lower() == "true"

oauth = OAuth(app)
google = oauth.register(
    name="google",
    client_id=os.environ.get("GOOGLE_CLIENT_ID"),
    client_secret=os.environ.get("GOOGLE_CLIENT_SECRET"),
    server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
    client_kwargs={"scope": "openid email profile"},
)

# Set up the contacts/messages tables if a database is configured.
try:
    db.init_db()
except Exception as e:
    print(f"[startup] Database not ready yet: {e}")

# ---------------------------------------------------------------------------
# IN-MEMORY STATE for the LIVE chat path only — nothing here ever touches
# disk or a database. Wiped on restart / disconnect, exactly as before.
# ---------------------------------------------------------------------------
online_users = {}      # sid -> {"name": str, "email": str, "user_id": str}
pending_requests = {}  # target_sid -> requester_sid
active_rooms = {}      # sid -> room_id
email_to_sid = {}      # email -> sid, so contacts messages can be delivered live if the recipient is online


def _require_login():
    user = session.get("user")
    if not user or not session.get("pin_verified") or not session.get("display_name"):
        return None
    return user


# ---------------------------------------------------------------------------
# Auth routes
# ---------------------------------------------------------------------------
@app.route("/sw.js")
def service_worker():
    response = send_from_directory(app.static_folder, "sw.js")
    response.headers["Content-Type"] = "application/javascript"
    return response


@app.route("/")
def index():
    user = session.get("user")
    if not user:
        return render_template("login.html", skip_login_enabled=SKIP_GOOGLE_LOGIN)
    if not session.get("pin_verified"):
        return redirect(url_for("enter_pin"))
    if not session.get("display_name"):
        return redirect(url_for("set_name"))
    session.permanent = True  # activates the 3-minute inactivity lifetime
    return render_template("lobby.html", display_name=session["display_name"], my_email=user["email"])


@app.route("/skip-login")
def skip_login():
    if not SKIP_GOOGLE_LOGIN:
        return redirect(url_for("index"))
    # Give each skipped-login session a distinct fake email so contacts/messages
    # between two guest sessions don't collide with each other.
    session["user"] = {
        "id": "temp-user",
        "name": "Guest",
        "email": f"guest-{uuid.uuid4().hex[:8]}@example.com",
        "picture": None,
    }
    return redirect(url_for("index"))


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


@app.route("/pin", methods=["GET", "POST"])
def enter_pin():
    if not session.get("user"):
        return redirect(url_for("index"))

    error = None
    if request.method == "POST":
        entered = request.form.get("pin", "")
        if entered == ACCESS_PIN:
            session["pin_verified"] = True
            return redirect(url_for("index"))
        error = "Incorrect PIN. Try again."

    return render_template("pin.html", error=error)


@app.route("/set-name", methods=["GET", "POST"])
def set_name():
    if not session.get("user") or not session.get("pin_verified"):
        return redirect(url_for("index"))

    error = None
    if request.method == "POST":
        name = request.form.get("display_name", "").strip()
        if not name:
            error = "Please enter a display name."
        elif len(name) > 30:
            error = "Please keep it under 30 characters."
        else:
            session["display_name"] = name
            return redirect(url_for("index"))

    return render_template("set_name.html", error=error)


@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("index"))


# ---------------------------------------------------------------------------
# Contacts + offline messaging (REST API, backed by Postgres)
# ---------------------------------------------------------------------------
@app.route("/api/contacts/add", methods=["POST"])
def api_add_contact():
    user = _require_login()
    if not user:
        return jsonify({"error": "Not logged in"}), 401

    contact_email = (request.json or {}).get("email", "").strip().lower()
    if not contact_email or "@" not in contact_email:
        return jsonify({"error": "Please enter a valid email address."}), 400
    if contact_email == user["email"].lower():
        return jsonify({"error": "You can't add yourself."}), 400

    try:
        db.add_contact(user["email"], contact_email)
    except Exception as e:
        return jsonify({"error": f"Could not add contact: {e}"}), 500

    return jsonify({"ok": True, "email": contact_email})


@app.route("/api/contacts/list")
def api_list_contacts():
    user = _require_login()
    if not user:
        return jsonify({"error": "Not logged in"}), 401
    try:
        contacts = db.list_contacts(user["email"])
    except Exception as e:
        return jsonify({"error": f"Could not load contacts: {e}"}), 500
    return jsonify({"contacts": contacts})


@app.route("/api/conversation/<other_email>")
def api_get_conversation(other_email):
    user = _require_login()
    if not user:
        return jsonify({"error": "Not logged in"}), 401
    try:
        messages = db.get_conversation(user["email"], other_email)
    except Exception as e:
        return jsonify({"error": f"Could not load conversation: {e}"}), 500
    return jsonify({"messages": messages})


@app.route("/api/message/send", methods=["POST"])
def api_send_message():
    user = _require_login()
    if not user:
        return jsonify({"error": "Not logged in"}), 401

    body = request.json or {}
    to_email = body.get("to_email", "").strip().lower()
    text = body.get("text", "").strip()
    if not to_email or not text:
        return jsonify({"error": "Missing recipient or message text."}), 400

    try:
        message_id = db.send_message(user["email"], to_email, text)
    except Exception as e:
        return jsonify({"error": f"Could not send message: {e}"}), 500

    # If the recipient happens to be online right now, deliver it live too.
    recipient_sid = email_to_sid.get(to_email)
    if recipient_sid:
        socketio.emit(
            "contact_message_received",
            {
                "id": message_id,
                "from": user["email"],
                "text": text,
                "isMine": False,
            },
            room=recipient_sid,
        )

    return jsonify({"ok": True, "id": message_id})


@app.route("/api/message/delete-for-me", methods=["POST"])
def api_delete_for_me():
    user = _require_login()
    if not user:
        return jsonify({"error": "Not logged in"}), 401
    message_id = (request.json or {}).get("id")
    if not message_id:
        return jsonify({"error": "Missing message id."}), 400
    ok = db.delete_for_me(message_id, user["email"])
    return jsonify({"ok": ok})


@app.route("/api/message/delete-for-everyone", methods=["POST"])
def api_delete_for_everyone():
    user = _require_login()
    if not user:
        return jsonify({"error": "Not logged in"}), 401
    message_id = (request.json or {}).get("id")
    if not message_id:
        return jsonify({"error": "Missing message id."}), 400

    recipient_email = db.delete_for_everyone(message_id, user["email"])
    if recipient_email is None:
        return jsonify({"error": "You can only delete-for-everyone on messages you sent."}), 403

    # Notify the recipient live if they're online, so it vanishes from their screen too
    recipient_sid = email_to_sid.get(recipient_email)
    if recipient_sid:
        socketio.emit("contact_message_deleted", {"id": message_id}, room=recipient_sid)

    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Socket.IO events — presence + live 1-on-1 signaling (unchanged E2EE path)
# ---------------------------------------------------------------------------
@socketio.on("connect")
def on_connect():
    user = session.get("user")
    display_name = session.get("display_name")
    if not user or not session.get("pin_verified") or not display_name:
        return False

    online_users[request.sid] = {
        "name": display_name,
        "email": user["email"],
        "user_id": user["id"],
    }
    email_to_sid[user["email"].lower()] = request.sid
    broadcast_online_list()


@socketio.on("disconnect")
def on_disconnect():
    sid = request.sid
    user_info = online_users.pop(sid, None)
    if user_info:
        email_to_sid.pop(user_info["email"].lower(), None)

    room_id = active_rooms.pop(sid, None)
    if room_id:
        emit("partner_left", {}, room=room_id)

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
    emit("exchange_key", {"publicKey": data.get("publicKey")}, room=room_id, include_self=False)


@socketio.on("send_message")
def on_send_message(data):
    room_id = active_rooms.get(request.sid)
    if not room_id:
        return
    sender_name = online_users.get(request.sid, {}).get("name", "Unknown")
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