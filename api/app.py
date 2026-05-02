"""My GLP Shot API — auth, E2EE sync, subscription state, doctor share links.

Privacy posture:
- Server stores: email, bcrypt(client-derived auth_token), opaque ciphertext blob.
- Server NEVER sees: password, encryption key, plaintext data.
- Client derives both auth_token and encryption_key from master password via
  PBKDF2-SHA-256 (600k iters, salt = SHA-256("myglpshot-v1:" + email)).
  See web/app.js → deriveAccountCreds().
"""
import json
import os
import re
import secrets
import sqlite3
import time
from contextlib import closing
from datetime import datetime, timezone

import bcrypt
from flask import Flask, g, jsonify, make_response, request

# ---------- Config ----------
DB_PATH = os.environ.get('MGS_DB', '/data/api.db')
RESEND_API_KEY = os.environ.get('RESEND_API_KEY', '')
APP_BASE_URL = os.environ.get('APP_BASE_URL', 'https://myglpshot.com')
MAIL_FROM = os.environ.get('MAIL_FROM', 'My GLP Shot <hello@myglpshot.com>')
TRIAL_DAYS = 14
SESSION_DAYS = 90
SHARE_TTL_HOURS = 24
MAX_BLOB_BYTES = 2 * 1024 * 1024  # 2 MB ciphertext cap
EMAIL_RE = re.compile(r'^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$')
TOKEN_RE = re.compile(r'^[a-f0-9]{32,}$')
LOOKUP_RE = re.compile(r'^[a-f0-9]{64}$')

app = Flask(__name__)


# ---------- DB ----------
SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    email               TEXT UNIQUE NOT NULL,
    password_hash       TEXT NOT NULL,
    created_at          INTEGER NOT NULL,
    email_verified_at   INTEGER,
    subscription_status TEXT NOT NULL DEFAULT 'trial',
    trial_ends_at       INTEGER,
    premium_until       INTEGER,
    stripe_customer_id  TEXT,
    notes               TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
    token       TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    user_agent  TEXT,
    last_seen   INTEGER
);
CREATE TABLE IF NOT EXISTS sync_blobs (
    user_id     INTEGER PRIMARY KEY,
    iv          TEXT NOT NULL,
    ciphertext  TEXT NOT NULL,
    updated_at  INTEGER NOT NULL,
    size        INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS share_links (
    token       TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL,
    iv          TEXT NOT NULL,
    ciphertext  TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    views       INTEGER NOT NULL DEFAULT 0,
    label       TEXT
);
CREATE TABLE IF NOT EXISTS password_resets (
    token       TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    used_at     INTEGER
);
CREATE TABLE IF NOT EXISTS legacy_blobs (
    lookup_id   TEXT PRIMARY KEY,
    iv          TEXT NOT NULL,
    ciphertext  TEXT NOT NULL,
    updated_at  INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    size        INTEGER NOT NULL
);
"""


def get_db():
    db = getattr(g, '_db', None)
    if db is None:
        db = g._db = sqlite3.connect(DB_PATH)
        db.row_factory = sqlite3.Row
        db.executescript(SCHEMA)
        db.commit()
    return db


@app.teardown_appcontext
def close_db(_):
    db = getattr(g, '_db', None)
    if db is not None:
        db.close()


def now_ts():
    return int(time.time())


# ---------- Helpers ----------
def err(code, message, status=400):
    return jsonify(error=code, message=message), status


def normalize_email(email):
    return (email or '').strip().lower()


def is_premium_now(user_row):
    if not user_row:
        return False
    status = user_row['subscription_status']
    if status == 'lifetime':
        return True
    if status == 'premium':
        if user_row['premium_until'] and user_row['premium_until'] > now_ts():
            return True
        return False
    if status == 'trial':
        if user_row['trial_ends_at'] and user_row['trial_ends_at'] > now_ts():
            return True
        return False
    return False


def public_user(user_row):
    if not user_row:
        return None
    return {
        'id': user_row['id'],
        'email': user_row['email'],
        'subscriptionStatus': user_row['subscription_status'],
        'trialEndsAt': user_row['trial_ends_at'],
        'premiumUntil': user_row['premium_until'],
        'isPremium': is_premium_now(user_row),
        'createdAt': user_row['created_at'],
    }


def get_session_user():
    """Read session cookie or Authorization: Bearer header."""
    token = request.cookies.get('mgs_session')
    if not token:
        auth = request.headers.get('Authorization', '')
        if auth.startswith('Bearer '):
            token = auth[7:].strip()
    if not token or not TOKEN_RE.match(token):
        return None, None
    db = get_db()
    sess = db.execute(
        'SELECT * FROM sessions WHERE token = ? AND expires_at > ?',
        (token, now_ts())
    ).fetchone()
    if not sess:
        return None, None
    user = db.execute('SELECT * FROM users WHERE id = ?', (sess['user_id'],)).fetchone()
    if not user:
        return None, None
    db.execute('UPDATE sessions SET last_seen = ? WHERE token = ?', (now_ts(), token))
    db.commit()
    return user, sess


def require_user():
    user, _ = get_session_user()
    if not user:
        return None
    return user


def send_email(to, subject, html, text=None):
    """Best-effort email via Resend. No-op if unset."""
    if not RESEND_API_KEY:
        app.logger.info('Email skipped (no API key): to=%s subj=%s', to, subject)
        return False
    try:
        import requests as _r
        resp = _r.post(
            'https://api.resend.com/emails',
            headers={'Authorization': f'Bearer {RESEND_API_KEY}'},
            json={'from': MAIL_FROM, 'to': to, 'subject': subject, 'html': html, 'text': text or ''},
            timeout=10,
        )
        return resp.status_code in (200, 202)
    except Exception as e:
        app.logger.exception('send_email failed: %s', e)
        return False


# ---------- Health ----------
@app.route('/api/health')
def health():
    return jsonify(ok=True, ts=now_ts())


# ---------- Auth ----------
@app.route('/api/signup', methods=['POST'])
def signup():
    data = request.get_json(silent=True) or {}
    email = normalize_email(data.get('email'))
    auth_token = (data.get('authToken') or '').strip()
    if not EMAIL_RE.match(email):
        return err('invalid_email', 'Please enter a valid email.')
    if not auth_token or len(auth_token) < 32 or len(auth_token) > 256:
        return err('invalid_auth_token', 'Auth token missing or wrong length.')

    db = get_db()
    existing = db.execute('SELECT id FROM users WHERE email = ?', (email,)).fetchone()
    if existing:
        return err('email_in_use', 'An account with this email already exists.', 409)

    pw_hash = bcrypt.hashpw(auth_token.encode('utf-8'), bcrypt.gensalt(rounds=12)).decode()
    trial_ends = now_ts() + TRIAL_DAYS * 86400
    cur = db.execute(
        """INSERT INTO users (email, password_hash, created_at, subscription_status, trial_ends_at)
           VALUES (?, ?, ?, 'trial', ?)""",
        (email, pw_hash, now_ts(), trial_ends),
    )
    user_id = cur.lastrowid
    db.commit()
    user = db.execute('SELECT * FROM users WHERE id = ?', (user_id,)).fetchone()
    sess_token = _create_session(user_id)
    resp = make_response(jsonify(user=public_user(user), token=sess_token))
    _set_session_cookie(resp, sess_token)
    return resp


@app.route('/api/login', methods=['POST'])
def login():
    data = request.get_json(silent=True) or {}
    email = normalize_email(data.get('email'))
    auth_token = (data.get('authToken') or '').strip()
    if not EMAIL_RE.match(email) or not auth_token:
        return err('invalid_credentials', 'Email or password incorrect.', 401)

    db = get_db()
    user = db.execute('SELECT * FROM users WHERE email = ?', (email,)).fetchone()
    # Constant-ish-time: always run a bcrypt check
    pw_hash = user['password_hash'] if user else '$2b$12$' + 'x' * 53
    ok = False
    try:
        ok = bcrypt.checkpw(auth_token.encode('utf-8'), pw_hash.encode('utf-8'))
    except Exception:
        ok = False
    if not user or not ok:
        return err('invalid_credentials', 'Email or password incorrect.', 401)

    sess_token = _create_session(user['id'])
    resp = make_response(jsonify(user=public_user(user), token=sess_token))
    _set_session_cookie(resp, sess_token)
    return resp


@app.route('/api/logout', methods=['POST'])
def logout():
    user, sess = get_session_user()
    if sess:
        get_db().execute('DELETE FROM sessions WHERE token = ?', (sess['token'],))
        get_db().commit()
    resp = make_response(jsonify(ok=True))
    resp.set_cookie('mgs_session', '', expires=0, path='/', secure=True, samesite='Lax')
    return resp


@app.route('/api/me')
def me():
    user = require_user()
    if not user:
        return err('unauthorized', 'Not signed in.', 401)
    return jsonify(user=public_user(user))


@app.route('/api/forgot', methods=['POST'])
def forgot_password():
    data = request.get_json(silent=True) or {}
    email = normalize_email(data.get('email'))
    if not EMAIL_RE.match(email):
        return err('invalid_email', 'Please enter a valid email.')
    db = get_db()
    user = db.execute('SELECT * FROM users WHERE email = ?', (email,)).fetchone()
    # Always return ok to avoid email enumeration
    if user:
        token = secrets.token_hex(32)
        db.execute(
            'INSERT INTO password_resets (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
            (token, user['id'], now_ts(), now_ts() + 3600),
        )
        db.commit()
        link = f'{APP_BASE_URL}/reset.html#token={token}'
        send_email(
            email,
            'Reset your My GLP Shot password',
            f'<p>Click to reset: <a href="{link}">{link}</a></p>'
            '<p><strong>Important:</strong> resetting your password will permanently lose your cloud-synced data, because '
            'we encrypt with your password and cannot decrypt without it. Your local data on each device is not affected.</p>'
            '<p>This link expires in 1 hour.</p>',
        )
    return jsonify(ok=True)


@app.route('/api/reset', methods=['POST'])
def reset_password():
    data = request.get_json(silent=True) or {}
    token = (data.get('token') or '').strip()
    new_auth_token = (data.get('authToken') or '').strip()
    if not TOKEN_RE.match(token) or not new_auth_token or len(new_auth_token) < 32:
        return err('invalid_request', 'Invalid reset token.')
    db = get_db()
    row = db.execute(
        'SELECT * FROM password_resets WHERE token = ? AND used_at IS NULL AND expires_at > ?',
        (token, now_ts()),
    ).fetchone()
    if not row:
        return err('invalid_or_expired', 'Reset link is invalid or expired.', 400)
    pw_hash = bcrypt.hashpw(new_auth_token.encode('utf-8'), bcrypt.gensalt(rounds=12)).decode()
    db.execute('UPDATE users SET password_hash = ? WHERE id = ?', (pw_hash, row['user_id']))
    db.execute('UPDATE password_resets SET used_at = ? WHERE token = ?', (now_ts(), token))
    db.execute('DELETE FROM sync_blobs WHERE user_id = ?', (row['user_id'],))  # E2EE: cloud copy can't be decrypted
    db.execute('DELETE FROM sessions WHERE user_id = ?', (row['user_id'],))
    db.commit()
    return jsonify(ok=True, lostCloudData=True)


def _create_session(user_id):
    token = secrets.token_hex(32)
    expires = now_ts() + SESSION_DAYS * 86400
    ua = request.headers.get('User-Agent', '')[:500]
    db = get_db()
    db.execute(
        'INSERT INTO sessions (token, user_id, created_at, expires_at, user_agent, last_seen) VALUES (?, ?, ?, ?, ?, ?)',
        (token, user_id, now_ts(), expires, ua, now_ts()),
    )
    db.commit()
    return token


def _set_session_cookie(resp, token):
    resp.set_cookie(
        'mgs_session', token,
        max_age=SESSION_DAYS * 86400,
        path='/',
        secure=True,
        httponly=True,
        samesite='Lax',
    )


# ---------- E2EE sync (account-bound, requires login) ----------
@app.route('/api/me/sync', methods=['GET'])
def sync_get():
    user = require_user()
    if not user:
        return err('unauthorized', 'Not signed in.', 401)
    row = get_db().execute('SELECT iv, ciphertext, updated_at FROM sync_blobs WHERE user_id = ?', (user['id'],)).fetchone()
    if not row:
        return jsonify(exists=False)
    return jsonify(exists=True, iv=row['iv'], ciphertext=row['ciphertext'], updatedAt=row['updated_at'])


@app.route('/api/me/sync', methods=['PUT'])
def sync_put():
    user = require_user()
    if not user:
        return err('unauthorized', 'Not signed in.', 401)
    data = request.get_json(silent=True) or {}
    iv = data.get('iv') or ''
    ct = data.get('ciphertext') or ''
    if not iv or not ct:
        return err('invalid_payload', 'Missing iv or ciphertext.')
    if len(ct) > MAX_BLOB_BYTES:
        return err('blob_too_large', f'Max {MAX_BLOB_BYTES} bytes.', 413)
    db = get_db()
    db.execute(
        """INSERT INTO sync_blobs (user_id, iv, ciphertext, updated_at, size)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET iv=excluded.iv, ciphertext=excluded.ciphertext, updated_at=excluded.updated_at, size=excluded.size""",
        (user['id'], iv, ct, now_ts(), len(ct)),
    )
    db.commit()
    return jsonify(updatedAt=now_ts())


@app.route('/api/me/sync', methods=['DELETE'])
def sync_delete():
    user = require_user()
    if not user:
        return err('unauthorized', 'Not signed in.', 401)
    db = get_db()
    db.execute('DELETE FROM sync_blobs WHERE user_id = ?', (user['id'],))
    db.commit()
    return jsonify(deleted=True)


# ---------- Doctor share links ----------
@app.route('/api/share', methods=['POST'])
def share_create():
    user = require_user()
    if not user:
        return err('unauthorized', 'Not signed in.', 401)
    if not is_premium_now(user):
        return err('premium_required', 'Doctor share links are a premium feature.', 402)
    data = request.get_json(silent=True) or {}
    iv = data.get('iv') or ''
    ct = data.get('ciphertext') or ''
    label = (data.get('label') or '')[:120] or None
    if not iv or not ct:
        return err('invalid_payload', 'Missing iv or ciphertext.')
    if len(ct) > MAX_BLOB_BYTES:
        return err('blob_too_large', f'Max {MAX_BLOB_BYTES} bytes.', 413)
    token = secrets.token_hex(16)
    expires = now_ts() + SHARE_TTL_HOURS * 3600
    db = get_db()
    db.execute(
        """INSERT INTO share_links (token, user_id, iv, ciphertext, created_at, expires_at, label)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (token, user['id'], iv, ct, now_ts(), expires, label),
    )
    db.commit()
    return jsonify(token=token, expiresAt=expires, hours=SHARE_TTL_HOURS)


@app.route('/api/share/<token>')
def share_fetch(token):
    if not re.match(r'^[a-f0-9]{32}$', token):
        return err('invalid_token', 'Bad token.', 404)
    db = get_db()
    row = db.execute('SELECT * FROM share_links WHERE token = ? AND expires_at > ?', (token, now_ts())).fetchone()
    if not row:
        return err('not_found', 'Share link expired or not found.', 404)
    db.execute('UPDATE share_links SET views = views + 1 WHERE token = ?', (token,))
    db.commit()
    return jsonify(iv=row['iv'], ciphertext=row['ciphertext'], expiresAt=row['expires_at'], label=row['label'])


@app.route('/api/share/<token>', methods=['DELETE'])
def share_revoke(token):
    user = require_user()
    if not user:
        return err('unauthorized', 'Not signed in.', 401)
    if not re.match(r'^[a-f0-9]{32}$', token):
        return err('invalid_token', 'Bad token.', 404)
    db = get_db()
    db.execute('DELETE FROM share_links WHERE token = ? AND user_id = ?', (token, user['id']))
    db.commit()
    return jsonify(revoked=True)


@app.route('/api/share', methods=['GET'])
def share_list():
    user = require_user()
    if not user:
        return err('unauthorized', 'Not signed in.', 401)
    rows = get_db().execute(
        'SELECT token, created_at, expires_at, views, label FROM share_links WHERE user_id = ? ORDER BY created_at DESC',
        (user['id'],),
    ).fetchall()
    return jsonify(links=[dict(r) for r in rows])


# ---------- Legacy lookup_id sync (back-compat for jdubb-style accounts) ----------
# Path stays /api/sync/<lookup_id> so existing PWAs using `api/sync/<id>` keep working.
@app.route('/api/sync/<lookup_id>', methods=['GET'])
def legacy_get(lookup_id):
    if not LOOKUP_RE.match(lookup_id):
        return err('invalid_lookup_id', 'Bad lookup id.', 400)
    row = get_db().execute(
        'SELECT iv, ciphertext, updated_at FROM legacy_blobs WHERE lookup_id = ?', (lookup_id,)
    ).fetchone()
    if not row:
        return err('not_found', 'No data for this lookup id.', 404)
    return jsonify(iv=row['iv'], ciphertext=row['ciphertext'], updated_at=row['updated_at'])


@app.route('/api/sync/<lookup_id>', methods=['PUT'])
def legacy_put(lookup_id):
    if not LOOKUP_RE.match(lookup_id):
        return err('invalid_lookup_id', 'Bad lookup id.', 400)
    data = request.get_json(silent=True) or {}
    iv = data.get('iv') or ''
    ct = data.get('ciphertext') or ''
    if not iv or not ct or len(ct) > MAX_BLOB_BYTES:
        return err('invalid_payload', 'Missing or oversized payload.')
    db = get_db()
    db.execute(
        """INSERT INTO legacy_blobs (lookup_id, iv, ciphertext, updated_at, created_at, size)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(lookup_id) DO UPDATE SET iv=excluded.iv, ciphertext=excluded.ciphertext, updated_at=excluded.updated_at, size=excluded.size""",
        (lookup_id, iv, ct, now_ts(), now_ts(), len(ct)),
    )
    db.commit()
    return jsonify(updated_at=now_ts())


@app.route('/api/sync/<lookup_id>', methods=['DELETE'])
def legacy_delete(lookup_id):
    if not LOOKUP_RE.match(lookup_id):
        return err('invalid_lookup_id', 'Bad lookup id.', 400)
    get_db().execute('DELETE FROM legacy_blobs WHERE lookup_id = ?', (lookup_id,))
    get_db().commit()
    return jsonify(deleted=True)


@app.route('/api/sync/<lookup_id>/exists')
def legacy_exists(lookup_id):
    if not LOOKUP_RE.match(lookup_id):
        return err('invalid_lookup_id', 'Bad lookup id.', 400)
    row = get_db().execute(
        'SELECT updated_at FROM legacy_blobs WHERE lookup_id = ?', (lookup_id,)
    ).fetchone()
    if not row:
        return jsonify(exists=False)
    return jsonify(exists=True, updated_at=row['updated_at'])


# ---------- Bootstrap ----------
def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    with closing(sqlite3.connect(DB_PATH)) as c:
        c.executescript(SCHEMA)
        c.commit()


init_db()


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8080, debug=False)
