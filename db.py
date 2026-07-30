"""
Persistent storage for contacts and offline messages.

Design notes (per agreed plan):
- Only used for the "contacts" feature — messaging someone who added you,
  even while you're offline. Live chats between two people who happen to be
  online at the same time still use the separate, fully end-to-end encrypted
  path in app.py/chat.js and never touch this database at all.
- Messages here are encrypted AT REST with a server-held key (Fernet). This
  is NOT end-to-end — the server can decrypt these, unlike the live E2EE
  chats. This tradeoff is what makes offline delivery possible.
- Only the 5 most recent messages per conversation are ever kept — every
  insert immediately trims older rows for that conversation away.
- "Delete for me" hides a message only for the requesting side (a flag per
  side). "Delete for everyone" is a real SQL DELETE — permanent, and only
  the original sender is allowed to do it (matches WhatsApp's rule).
- Images are NOT supported in offline/contact messaging — text only. Photo
  sharing remains a live-chat-only feature.
"""

import os
import psycopg2
from psycopg2.extras import RealDictCursor
from cryptography.fernet import Fernet

DATABASE_URL = os.environ.get("DATABASE_URL")

# Server-side key used to encrypt stored message text. Anthropic/Render never
# generates this for you — set your own via the ENCRYPTION_KEY env var.
# Generate one with: python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
_ENCRYPTION_KEY = os.environ.get("ENCRYPTION_KEY")
_fernet = Fernet(_ENCRYPTION_KEY.encode()) if _ENCRYPTION_KEY else None

MAX_MESSAGES_PER_CONVERSATION = 5


def _get_conn():
    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL is not set — add your Render Postgres connection string.")
    return psycopg2.connect(DATABASE_URL, cursor_factory=RealDictCursor)


def init_db():
    """Create tables if they don't exist yet. Safe to call every startup."""
    if not DATABASE_URL:
        return  # allow the app to run without Postgres configured yet
    conn = _get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS contacts (
                    id SERIAL PRIMARY KEY,
                    owner_email TEXT NOT NULL,
                    contact_email TEXT NOT NULL,
                    added_at TIMESTAMP DEFAULT NOW(),
                    UNIQUE(owner_email, contact_email)
                );
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS users (
                    email TEXT PRIMARY KEY,
                    display_name TEXT NOT NULL,
                    updated_at TIMESTAMP DEFAULT NOW()
                );
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS messages (
                    id SERIAL PRIMARY KEY,
                    conversation_key TEXT NOT NULL,
                    sender_email TEXT NOT NULL,
                    recipient_email TEXT NOT NULL,
                    ciphertext TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT NOW(),
                    deleted_for_sender BOOLEAN DEFAULT FALSE,
                    deleted_for_recipient BOOLEAN DEFAULT FALSE
                );
            """)
            cur.execute("CREATE INDEX IF NOT EXISTS idx_conv_key ON messages(conversation_key);")
        conn.commit()
    finally:
        conn.close()


def _conversation_key(email_a, email_b):
    # Deterministic key regardless of who's "sender" vs "recipient"
    return "|".join(sorted([email_a.lower(), email_b.lower()]))


def _encrypt(text):
    if not _fernet:
        raise RuntimeError("ENCRYPTION_KEY is not set — cannot store messages securely.")
    return _fernet.encrypt(text.encode()).decode()


def _decrypt(token):
    if not _fernet:
        return "[Encryption key missing on server]"
    try:
        return _fernet.decrypt(token.encode()).decode()
    except Exception:
        return "[Could not decrypt this message]"


# ---------------------------------------------------------------------------
# Contacts
# ---------------------------------------------------------------------------
def add_contact(owner_email, contact_email):
    conn = _get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO contacts (owner_email, contact_email) VALUES (%s, %s) "
                "ON CONFLICT (owner_email, contact_email) DO NOTHING;",
                (owner_email.lower(), contact_email.lower()),
            )
        conn.commit()
    finally:
        conn.close()


def list_contacts(owner_email):
    """Only people the user explicitly added. Returns each contact's own
    chosen display name (set during their onboarding) alongside their
    email, so the UI can show a name instead of a raw address — falls back
    to the email itself if that person hasn't set a name yet (e.g. never
    logged in)."""
    conn = _get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT c.contact_email AS email, u.display_name
                FROM contacts c
                LEFT JOIN users u ON u.email = c.contact_email
                WHERE c.owner_email = %s
                ORDER BY c.contact_email;
                """,
                (owner_email.lower(),),
            )
            return [
                {"email": row["email"], "displayName": row["display_name"] or row["email"]}
                for row in cur.fetchall()
            ]
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Users — each person's own chosen display name (set once during
# onboarding), so it can be looked up and shown even while they're offline.
# ---------------------------------------------------------------------------
def upsert_user_name(email, display_name):
    conn = _get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO users (email, display_name) VALUES (%s, %s)
                ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = NOW();
                """,
                (email.lower(), display_name),
            )
        conn.commit()
    finally:
        conn.close()


def remove_contact(owner_email, contact_email):
    conn = _get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM contacts WHERE owner_email = %s AND contact_email = %s;",
                (owner_email.lower(), contact_email.lower()),
            )
        conn.commit()
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Messages
# ---------------------------------------------------------------------------
def send_message(sender_email, recipient_email, text):
    conv_key = _conversation_key(sender_email, recipient_email)
    ciphertext = _encrypt(text)
    conn = _get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO messages (conversation_key, sender_email, recipient_email, ciphertext)
                VALUES (%s, %s, %s, %s) RETURNING id, created_at;
                """,
                (conv_key, sender_email.lower(), recipient_email.lower(), ciphertext),
            )
            new_row = cur.fetchone()

            # Trim to only the most recent MAX_MESSAGES_PER_CONVERSATION for this pair
            cur.execute(
                """
                DELETE FROM messages
                WHERE conversation_key = %s
                AND id NOT IN (
                    SELECT id FROM messages
                    WHERE conversation_key = %s
                    ORDER BY created_at DESC
                    LIMIT %s
                );
                """,
                (conv_key, conv_key, MAX_MESSAGES_PER_CONVERSATION),
            )
        conn.commit()
        return new_row["id"]
    finally:
        conn.close()


def get_conversation(viewer_email, other_email):
    """Last up-to-5 messages between two people, decrypted, with deleted-for-me
    entries filtered out for the person viewing them."""
    conv_key = _conversation_key(viewer_email, other_email)
    conn = _get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, sender_email, recipient_email, ciphertext, created_at,
                       deleted_for_sender, deleted_for_recipient
                FROM messages
                WHERE conversation_key = %s
                ORDER BY created_at ASC
                LIMIT %s;
                """,
                (conv_key, MAX_MESSAGES_PER_CONVERSATION),
            )
            rows = cur.fetchall()

        result = []
        viewer = viewer_email.lower()
        for row in rows:
            is_sender = row["sender_email"] == viewer
            if is_sender and row["deleted_for_sender"]:
                continue
            if not is_sender and row["deleted_for_recipient"]:
                continue
            result.append({
                "id": row["id"],
                "from": row["sender_email"],
                "isMine": is_sender,
                "text": _decrypt(row["ciphertext"]),
                "createdAt": row["created_at"].isoformat(),
            })
        return result
    finally:
        conn.close()


def delete_for_me(message_id, requester_email):
    """Hide a message only for the requester's side. Works whether they were
    the sender or recipient."""
    conn = _get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT sender_email, recipient_email FROM messages WHERE id = %s;", (message_id,))
            row = cur.fetchone()
            if not row:
                return False
            requester = requester_email.lower()
            if row["sender_email"] == requester:
                cur.execute("UPDATE messages SET deleted_for_sender = TRUE WHERE id = %s;", (message_id,))
            elif row["recipient_email"] == requester:
                cur.execute("UPDATE messages SET deleted_for_recipient = TRUE WHERE id = %s;", (message_id,))
            else:
                return False
        conn.commit()
        return True
    finally:
        conn.close()


def delete_for_everyone(message_id, requester_email):
    """Permanently deletes the message row — but ONLY if the requester was
    the original sender (matches WhatsApp's rule). Returns the recipient's
    email on success (so the caller can notify them live), or None if not
    allowed / not found."""
    conn = _get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT sender_email, recipient_email FROM messages WHERE id = %s;", (message_id,))
            row = cur.fetchone()
            if not row or row["sender_email"] != requester_email.lower():
                return None
            recipient = row["recipient_email"]
            cur.execute("DELETE FROM messages WHERE id = %s;", (message_id,))
        conn.commit()
        return recipient
    finally:
        conn.close()