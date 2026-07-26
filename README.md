# Live Chat App (no saved transcripts)

A minimal chat app where:
- Users log in with their **Google account**.
- You see who else is **online right now**.
- You can request to chat 1-on-1; the other person accepts/declines.
- Messages travel only through the **live socket connection** — nothing is
  ever written to a database or file. Close the tab, disconnect, or leave
  the chat, and the conversation is gone forever from server memory too.

## 1. Set up in VS Code

```bash
git clone <your-repo-or-just-copy-this-folder>
cd live-chat-app
python -m venv venv
source venv/bin/activate      # on Windows: venv\Scripts\activate
pip install -r requirements.txt
```

## 2. Get Google OAuth credentials

1. Go to https://console.cloud.google.com/ → create a project.
2. Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
3. Application type: **Web application**.
4. Authorized redirect URI: `http://localhost:5000/auth/callback`
5. Copy the **Client ID** and **Client Secret**.

## 3. Set environment variables

```bash
export GOOGLE_CLIENT_ID="your-client-id"
export GOOGLE_CLIENT_SECRET="your-client-secret"
export SECRET_KEY="any-random-string"
```

(On Windows PowerShell use `$env:GOOGLE_CLIENT_ID="..."` etc.)

## 4. Run it

```bash
python app.py
```

Open http://localhost:5000 in two different browsers (or one normal + one
incognito window) and sign in with two different Google accounts to test
the live chat between two users.

## How "no transcript" is enforced

- There is no database, no file writes, no logging of message content.
- `online_users`, `pending_requests`, and `active_rooms` are plain Python
  dictionaries that live only in server RAM.
- On `disconnect`, a user's entry is deleted and their room is torn down.
- Restarting the server wipes everything immediately.

## Turning this into a mobile app later

Since this is a normal web app (Flask + HTML/JS), you can later wrap it in:
- **WebView-based app** (e.g. a simple Android/iOS WebView pointing at your
  deployed URL), or
- **Capacitor/Cordova** to package it as a native app shell,
without changing the backend at all.

## Production notes (before deploying)

- Switch `app.run` mode to use `eventlet` or `gevent` as the async server
  (already included in requirements) for real concurrency with Socket.IO.
- Serve over HTTPS — Google OAuth requires it in production (redirect URI
  must be `https://yourdomain.com/auth/callback`).
- Set a strong random `SECRET_KEY`.
- Consider a rate limit on `request_chat` to prevent spam requests.
