"""
Auralook chat app.

Contacts-only model: add someone by email and give them a nickname of your
own choosing (not their own name — whatever YOU want to call them). Once
added, message them anytime, online or offline, no permission needed.
People you haven't added are never visible anywhere, even if they're
currently logged into the app themselves — there's no public "who's
online" list, by design.

Also includes: Google login, a shared PIN gate (with a 3-strike device
lockout), a 3-minute inactivity auto-logout, and best-effort detection of
a full app quit vs. just minimizing.
"""

import os
import uuid
from datetime import timedelta
import time
from flask import Flask, redirect, url_for, session, render_template, request, send_from_directory, jsonify, make_response
from flask_socketio import SocketIO, emit
from authlib.integrations.flask_client import OAuth

import db

app = Flask(__name__)
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0  # always serve fresh static files — avoids
# phones/browsers running an old cached chat.js after a deploy, which can
# look exactly like a logic bug when it's actually just a stale cache
app.secret_key = os.environ.get("SECRET_KEY", "dev-secret-change-me")
app.permanent_session_lifetime = timedelta(days=7)  # keeps Google sign-in alive long-term;
# the 2-minute PIN re-entry is enforced separately, client-side + via /lock,
# NOT by this cookie expiring — otherwise the two race each other and you'd
# get bounced all the way back to Google sign-in instead of just the PIN.

socketio = SocketIO(
    app,
    cors_allowed_origins="*",
    async_mode="threading",
    max_http_buffer_size=22 * 1024 * 1024,
)

ACCESS_PIN = os.environ.get("ACCESS_PIN")
if not ACCESS_PIN:
    # No fallback to a known/shared value on purpose — if ACCESS_PIN isn't
    # set in the environment, generate a random one at startup instead.
    # Nobody (including you) will know it without setting ACCESS_PIN
    # explicitly, which fails safe rather than silently using an old PIN
    # that may have been shared or exposed elsewhere.
    ACCESS_PIN = uuid.uuid4().hex[:8]
    print(
        "[startup] WARNING: ACCESS_PIN is not set. Generated a random one "
        "for this run only — set ACCESS_PIN in your environment variables "
        "so the PIN is something you actually know."
    )
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
# Presence — ONLY used to show an online/offline dot next to contacts you've
# already added. Never exposes who else is using the app.
# ---------------------------------------------------------------------------
email_to_sid = {}  # email -> sid

IDLE_LOCK_SECONDS = 120  # 2 minutes - matches the desired idle timeout


@app.before_request
def enforce_idle_lock():
    """Runs on every single real request the browser makes, server-side —
    completely immune to bfcache, localStorage quirks, or anything else
    client-side, since cookies are always sent fresh with every actual
    HTTP request regardless of any browser caching behavior. This is what
    correctly catches 'app was quit and reopened after 2+ minutes', no
    matter what the browser/OS did with the page in between.
    """
    if session.get("user") and session.get("pin_verified"):
        last_seen = session.get("last_seen")
        now_ts = time.time()
        if last_seen is not None and (now_ts - last_seen) > IDLE_LOCK_SECONDS:
            session["pin_verified"] = False
        session["last_seen"] = now_ts


def _require_login():
    user = session.get("user")
    if not user or not session.get("pin_verified"):
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
    session.permanent = True
    my_name = "Guest"  # topbar always shows "Guest" regardless of the real Google account name
    response = make_response(render_template("lobby.html", my_name=my_name, my_email=user["email"]))
    # Critical: without this, Chrome/Safari can silently restore this page
    # from "back/forward cache" instead of truly reloading it — which
    # skips our inline lock-check script entirely, since bfcache resumes a
    # frozen page rather than re-running any load-time scripts.
    response.headers["Cache-Control"] = "no-store"
    return response


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
            session.pop("pin_attempts", None)
            return redirect(url_for("index"))

        session["pin_attempts"] = session.get("pin_attempts", 0) + 1
        if session["pin_attempts"] >= 3:
            session.clear()
            return render_template(
                "login.html",
                skip_login_enabled=SKIP_GOOGLE_LOGIN,
                error="Too many incorrect PIN attempts. This device has been locked.",
                locked=True,
            )
        error = f"Incorrect PIN. Try again. ({session['pin_attempts']}/3 attempts)"
    return render_template("pin.html", error=error)


@app.route("/logout", methods=["GET", "POST"])
def logout():
    session.clear()
    return redirect(url_for("index"))


@app.route("/lock", methods=["GET", "POST"])
def lock():
    """Used for idle-timeout and app-quit — only requires the PIN again,
    keeps the Google sign-in itself intact. A full /logout (only triggered
    by the manual Logout button) is the only thing that requires signing
    in with Google again from scratch."""
    session["pin_verified"] = False
    session.pop("pin_attempts", None)
    return redirect(url_for("index"))


# ---------------------------------------------------------------------------
# Contacts + messaging (REST API, backed by Postgres) — the only chat system
# ---------------------------------------------------------------------------
@app.route("/api/contacts/add", methods=["POST"])
def api_add_contact():
    user = _require_login()
    if not user:
        return jsonify({"error": "Not logged in"}), 401

    body = request.json or {}
    contact_email = body.get("email", "").strip().lower()
    nickname = (body.get("nickname") or "").strip() or None

    if not contact_email or "@" not in contact_email:
        return jsonify({"error": "Please enter a valid email address."}), 400
    if contact_email == user["email"].lower():
        return jsonify({"error": "You can't add yourself."}), 400

    try:
        db.add_contact(user["email"], contact_email, nickname)
    except Exception as e:
        return jsonify({"error": f"Could not add contact: {e}"}), 500

    return jsonify({"ok": True, "email": contact_email})


@app.route("/api/contacts/remove", methods=["POST"])
def api_remove_contact():
    user = _require_login()
    if not user:
        return jsonify({"error": "Not logged in"}), 401
    contact_email = (request.json or {}).get("email", "").strip().lower()
    if not contact_email:
        return jsonify({"error": "Missing email."}), 400
    try:
        db.remove_contact(user["email"], contact_email)
    except Exception as e:
        return jsonify({"error": f"Could not remove contact: {e}"}), 500
    return jsonify({"ok": True})


@app.route("/api/session-check")
def api_session_check():
    """Lightweight endpoint the client calls whenever the app becomes
    visible again (foregrounded) — this doesn't rely on a fresh page load
    happening at all, which matters because some Android/PWA setups just
    resume an already-loaded page from memory without making any new
    network request. This forces an explicit check against the server's
    authoritative, already-tracked idle timer (see enforce_idle_lock
    above) regardless of what the browser did with the page in between.
    """
    locked = not (session.get("user") and session.get("pin_verified"))
    return jsonify({"locked": locked})


@app.route("/api/contacts/list")
def api_list_contacts():
    user = _require_login()
    if not user:
        return jsonify({"error": "Not logged in"}), 401
    try:
        contacts = db.list_contacts(user["email"])  # each: {"email": ..., "nickname": ...}
    except Exception as e:
        return jsonify({"error": f"Could not load contacts: {e}"}), 500
    online_emails = set(email_to_sid.keys())
    for c in contacts:
        c["online"] = c["email"].lower() in online_emails
    return jsonify({"contacts": contacts})


@app.route("/api/conversation/<other_email>/clear-for-me", methods=["POST"])
def api_clear_conversation(other_email):
    user = _require_login()
    if not user:
        return jsonify({"error": "Not logged in"}), 401
    try:
        db.clear_conversation_for_me(user["email"], other_email)
    except Exception as e:
        return jsonify({"error": f"Could not clear chat: {e}"}), 500
    return jsonify({"ok": True})


@app.route("/api/conversation/<other_email>")
def api_get_conversation(other_email):
    user = _require_login()
    if not user:
        return jsonify({"error": "Not logged in"}), 401
    try:
        messages = db.get_conversation(user["email"], other_email)
        newly_seen_ids = db.mark_conversation_seen(user["email"], other_email)
    except Exception as e:
        return jsonify({"error": f"Could not load conversation: {e}"}), 500

    # Tell the original sender live (if they're online) that these
    # messages were just seen, so their tick can flip to blue immediately.
    if newly_seen_ids:
        sender_sid = email_to_sid.get(other_email.lower())
        if sender_sid:
            socketio.emit("messages_seen", {"ids": newly_seen_ids}, room=sender_sid)

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
# Socket.IO — presence only. Only tells YOUR browser about online/offline
# status for emails already in YOUR contacts list (enforced client-side by
# simply never rendering anyone else). No public discovery, no ephemeral
# chat system — contacts are the only way to message anyone.
# ---------------------------------------------------------------------------
@socketio.on("connect")
def on_connect():
    user = session.get("user")
    if not user or not session.get("pin_verified"):
        return False
    email = user["email"].lower()
    email_to_sid[email] = request.sid
    emit("presence_update", {"email": email, "online": True}, broadcast=True)


@socketio.on("disconnect")
def on_disconnect():
    sid = request.sid
    email = next((e for e, s in email_to_sid.items() if s == sid), None)
    if email:
        email_to_sid.pop(email, None)
        emit("presence_update", {"email": email, "online": False}, broadcast=True)


@socketio.on("mark_seen")
def on_mark_seen(data):
    """Client calls this when a message arrives live while that exact chat
    is already open, so it gets marked seen immediately rather than
    waiting for the next time the conversation is opened."""
    user = session.get("user")
    if not user or not session.get("pin_verified"):
        return
    other_email = (data.get("other_email") or "").strip().lower()
    if not other_email:
        return
    newly_seen_ids = db.mark_conversation_seen(user["email"], other_email)
    if newly_seen_ids:
        sender_sid = email_to_sid.get(other_email)
        if sender_sid:
            emit("messages_seen", {"ids": newly_seen_ids}, room=sender_sid)


if __name__ == "__main__":
    socketio.run(app, host="0.0.0.0", port=5000, debug=True)