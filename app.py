"""
Auralook chat app.

ONE unified messaging system: add someone by email, and that becomes a
single ongoing conversation — whether they're online or not. Messages are
delivered live instantly if the other person is currently connected, and
simply wait in storage if they're not; either way it's the exact same chat
thread, continuing seamlessly once both are online together.

Design notes:
- Messages are stored server-side, encrypted at rest (the server does hold
  the decryption key — this is NOT end-to-end encryption). This is what
  makes a continuous, always-available conversation possible; true E2EE
  can't support this because it depends on a live key exchange that has no
  meaning once a session ends.
- Only the 5 most recent messages per conversation are ever kept.
- "Delete for me" hides a message only on the requester's side. "Delete for
  everyone" permanently deletes it, and is only allowed on messages the
  requester originally sent (matches WhatsApp's rule).
- "Online" is just a live presence indicator (a green dot next to a
  contact's name) — it does NOT create or destroy anything. Minimizing the
  app, a flaky connection, or briefly disconnecting has zero effect on the
  conversation itself.
- Also includes: Google login, a shared PIN gate, a custom display name
  step, and a 3-minute inactivity auto-logout.
"""

import os
import uuid
from datetime import timedelta
from flask import Flask, redirect, url_for, session, render_template, request, send_from_directory, jsonify
from flask_socketio import SocketIO, emit
from authlib.integrations.flask_client import OAuth

import db

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "dev-secret-change-me")
app.permanent_session_lifetime = timedelta(minutes=3)

socketio = SocketIO(
    app,
    cors_allowed_origins="*",
    async_mode="threading",
    max_http_buffer_size=22 * 1024 * 1024,
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

try:
    db.init_db()
except Exception as e:
    print(f"[startup] Database not ready yet: {e}")

# ---------------------------------------------------------------------------
# Presence tracking only — purely informational (the little online dot).
# Never used to gate whether messaging works; that's handled entirely by
# the persistent contacts system in db.py.
# ---------------------------------------------------------------------------
email_to_sid = {}  # email -> sid, so we know who's currently connected


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
    session.permanent = True
    return render_template("lobby.html", display_name=session["display_name"], my_email=user["email"])


@app.route("/skip-login")
def skip_login():
    if not SKIP_GOOGLE_LOGIN:
        return redirect(url_for("index"))
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
# Contacts + messaging (REST API, backed by Postgres) — THE single chat system
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
    # Include live presence so the UI can show an online/offline dot
    online_emails = set(email_to_sid.keys())
    return jsonify({
        "contacts": [{"email": c, "online": c.lower() in online_emails} for c in contacts]
    })


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

    # Deliver live instantly if the recipient happens to be connected right
    # now — purely a nice-to-have; the message is safely stored either way.
    recipient_sid = email_to_sid.get(to_email)
    if recipient_sid:
        socketio.emit(
            "contact_message_received",
            {"id": message_id, "from": user["email"], "text": text, "isMine": False},
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

    recipient_sid = email_to_sid.get(recipient_email)
    if recipient_sid:
        socketio.emit("contact_message_deleted", {"id": message_id}, room=recipient_sid)

    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Socket.IO — presence only (the online/offline dot). No chat state lives
# here at all, so minimizing the app / a dropped connection / reconnecting
# never affects any conversation.
# ---------------------------------------------------------------------------
@socketio.on("connect")
def on_connect():
    user = session.get("user")
    if not user or not session.get("pin_verified") or not session.get("display_name"):
        return False
    email_to_sid[user["email"].lower()] = request.sid
    emit("presence_update", {"email": user["email"].lower(), "online": True}, broadcast=True)


@socketio.on("disconnect")
def on_disconnect():
    sid = request.sid
    email = next((e for e, s in email_to_sid.items() if s == sid), None)
    if email:
        email_to_sid.pop(email, None)
        emit("presence_update", {"email": email, "online": False}, broadcast=True)


if __name__ == "__main__":
    socketio.run(app, host="0.0.0.0", port=5000, debug=True)