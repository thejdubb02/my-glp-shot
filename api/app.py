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
import stripe
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
STRIPE_API_KEY = os.environ.get('STRIPE_API_KEY', '')
STRIPE_WEBHOOK_SECRET = os.environ.get('STRIPE_WEBHOOK_SECRET', '')
STRIPE_PRICE_MONTHLY = os.environ.get('STRIPE_PRICE_MONTHLY', '')
STRIPE_PRICE_YEARLY = os.environ.get('STRIPE_PRICE_YEARLY', '')
# Parallel test-mode Stripe keys. When set, /api/stripe/webhook/test handles
# test-mode events and admins can launch test checkouts without polluting live
# customer data. Test customer/subscription IDs live in *_test columns.
STRIPE_API_KEY_TEST = os.environ.get('STRIPE_API_KEY_TEST', '')
STRIPE_WEBHOOK_SECRET_TEST = os.environ.get('STRIPE_WEBHOOK_SECRET_TEST', '')
STRIPE_PRICE_MONTHLY_TEST = os.environ.get('STRIPE_PRICE_MONTHLY_TEST', '')
STRIPE_PRICE_YEARLY_TEST = os.environ.get('STRIPE_PRICE_YEARLY_TEST', '')
# Admin bearer token. If unset, admin endpoints are disabled.
MGS_ADMIN_TOKEN = os.environ.get('MGS_ADMIN_TOKEN', '')
GEMINI_API_KEY = os.environ.get('GEMINI_API_KEY', '')
if STRIPE_API_KEY:
    stripe.api_key = STRIPE_API_KEY

# Hard-fail on a misconfiguration that would let test webhook events corrupt live state.
if STRIPE_WEBHOOK_SECRET and STRIPE_WEBHOOK_SECRET_TEST and STRIPE_WEBHOOK_SECRET == STRIPE_WEBHOOK_SECRET_TEST:
    raise RuntimeError(
        'STRIPE_WEBHOOK_SECRET and STRIPE_WEBHOOK_SECRET_TEST must differ. '
        'Test and live webhook secrets must come from separate Stripe modes.'
    )

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
    stripe_subscription_id TEXT,
    stripe_customer_id_test     TEXT,
    stripe_subscription_id_test TEXT,
    test_subscription_status    TEXT,
    test_premium_until          INTEGER,
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
CREATE TABLE IF NOT EXISTS stripe_events (
    id          TEXT PRIMARY KEY,
    type        TEXT NOT NULL,
    received_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS legacy_blobs (
    lookup_id   TEXT PRIMARY KEY,
    iv          TEXT NOT NULL,
    ciphertext  TEXT NOT NULL,
    updated_at  INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    size        INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_audit (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    action          TEXT NOT NULL,
    target_user_id  INTEGER,
    ip              TEXT,
    user_agent      TEXT,
    extra           TEXT,
    ts              INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_audit_ts_idx ON admin_audit(ts DESC);
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


@app.before_request
def _enforce_json_for_mutations():
    """CSRF mitigation: state-changing endpoints must use application/json.
    Cross-origin form posts can't send that without a preflight (which our CORS rejects),
    so this structurally blocks CSRF without a token. Stripe webhook is exempt
    (it sends application/json anyway, but its signature is HMAC-verified).
    """
    if request.method not in ('POST', 'PUT', 'DELETE', 'PATCH'):
        return None
    p = request.path or ''
    # Stripe webhook signs its body; no need to gate on content-type.
    if p in ('/api/stripe/webhook', '/api/stripe/webhook/test'):
        return None
    ct = (request.headers.get('Content-Type') or '').split(';', 1)[0].strip().lower()
    # Allow methods with no body to skip the check.
    if request.content_length in (None, 0) and ct == '':
        return None
    if ct != 'application/json':
        return err('content_type', 'application/json required.', 415)
    return None


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
        'hasStripeCustomer': bool(user_row['stripe_customer_id']),
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


@app.route('/api/me', methods=['DELETE'])
def delete_account():
    """Hard-delete the user. GDPR/CCPA compliance + user privacy.
    Cancels any active Stripe subscription, then removes all rows for the user.
    Local IndexedDB is the user's responsibility (Settings -> Erase all data on this device).
    """
    user = require_user()
    if not user:
        return err('unauthorized', 'Not signed in.', 401)
    db = get_db()
    uid = user['id']
    # Best-effort: cancel Stripe subscription so we don't keep billing.
    if _stripe_ready() and user['stripe_subscription_id']:
        try:
            stripe.Subscription.delete(user['stripe_subscription_id'])
        except stripe.StripeError as e:
            app.logger.warning('Stripe sub cancel failed during account delete: %s', e)
    db.execute('DELETE FROM share_links WHERE user_id = ?', (uid,))
    db.execute('DELETE FROM sync_blobs WHERE user_id = ?', (uid,))
    db.execute('DELETE FROM sessions WHERE user_id = ?', (uid,))
    db.execute('DELETE FROM password_resets WHERE user_id = ?', (uid,))
    db.execute('DELETE FROM users WHERE id = ?', (uid,))
    db.commit()
    resp = make_response(jsonify(deleted=True))
    resp.set_cookie('mgs_session', '', expires=0, path='/', secure=True, samesite='Lax')
    return resp


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
    db.execute('DELETE FROM share_links WHERE user_id = ?', (row['user_id'],))  # Old shares contain pre-reset data
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


# ---------- Billing (Stripe) ----------
def _stripe_ready():
    return bool(STRIPE_API_KEY and STRIPE_PRICE_MONTHLY and STRIPE_PRICE_YEARLY)


def _ensure_customer(user):
    """Return stripe_customer_id, creating one if needed."""
    if user['stripe_customer_id']:
        return user['stripe_customer_id']
    cust = stripe.Customer.create(
        email=user['email'],
        metadata={'user_id': str(user['id']), 'app': 'myglpshot'},
    )
    get_db().execute(
        'UPDATE users SET stripe_customer_id = ? WHERE id = ?',
        (cust.id, user['id']),
    )
    get_db().commit()
    return cust.id


@app.route('/api/billing/prices')
def billing_prices():
    if not _stripe_ready():
        return err('billing_unavailable', 'Billing is not configured.', 503)
    return jsonify(
        monthly={'priceId': STRIPE_PRICE_MONTHLY, 'amount': 199, 'interval': 'month'},
        yearly={'priceId': STRIPE_PRICE_YEARLY, 'amount': 1999, 'interval': 'year'},
        trialDays=TRIAL_DAYS,
    )


@app.route('/api/billing/checkout', methods=['POST'])
def billing_checkout():
    user = require_user()
    if not user:
        return err('unauthorized', 'Not signed in.', 401)
    if not _stripe_ready():
        return err('billing_unavailable', 'Billing is not configured.', 503)
    data = request.get_json(silent=True) or {}
    plan = (data.get('plan') or 'yearly').lower()
    price_id = STRIPE_PRICE_YEARLY if plan == 'yearly' else STRIPE_PRICE_MONTHLY
    customer_id = _ensure_customer(user)
    app_base = os.environ.get('APP_URL', 'https://app.myglpshot.com').rstrip('/')

    # Defend against duplicate subscriptions: if the customer already has an active or trialing sub,
    # send them to the customer portal instead. They can change plan there.
    try:
        subs = stripe.Subscription.list(customer=customer_id, status='all', limit=10)
        for s in subs.data:
            if s.status in ('active', 'trialing', 'past_due', 'unpaid'):
                portal = stripe.billing_portal.Session.create(
                    customer=customer_id, return_url=f'{app_base}/'
                )
                return jsonify(url=portal.url, alreadySubscribed=True)
    except stripe.StripeError as e:
        app.logger.warning('subscription list check failed (continuing): %s', e)
    try:
        sess = stripe.checkout.Session.create(
            mode='subscription',
            customer=customer_id,
            line_items=[{'price': price_id, 'quantity': 1}],
            allow_promotion_codes=True,
            subscription_data={
                'trial_period_days': TRIAL_DAYS,
                'metadata': {'user_id': str(user['id']), 'app': 'myglpshot'},
            },
            metadata={'user_id': str(user['id']), 'app': 'myglpshot'},
            success_url=f'{app_base}/?billing=success&session_id={{CHECKOUT_SESSION_ID}}',
            cancel_url=f'{app_base}/?billing=canceled',
        )
    except stripe.StripeError as e:
        app.logger.exception('checkout failed: %s', e)
        return err('stripe_error', str(getattr(e, 'user_message', None) or 'Stripe error'), 502)
    return jsonify(url=sess.url, sessionId=sess.id)


@app.route('/api/billing/portal', methods=['POST'])
def billing_portal():
    user = require_user()
    if not user:
        return err('unauthorized', 'Not signed in.', 401)
    if not user['stripe_customer_id']:
        return err('no_customer', 'No billing record yet — start a subscription first.', 400)
    app_base = os.environ.get('APP_URL', 'https://app.myglpshot.com').rstrip('/')
    try:
        sess = stripe.billing_portal.Session.create(
            customer=user['stripe_customer_id'],
            return_url=f'{app_base}/',
        )
    except stripe.StripeError as e:
        app.logger.exception('portal failed: %s', e)
        return err('stripe_error', str(getattr(e, 'user_message', None) or 'Stripe error'), 502)
    return jsonify(url=sess.url)


def _apply_subscription(sub):
    """Update a user's subscription columns from a Stripe Subscription object/dict."""
    cust_id = sub.get('customer')
    if not cust_id:
        return
    db = get_db()
    user = db.execute('SELECT * FROM users WHERE stripe_customer_id = ?', (cust_id,)).fetchone()
    if not user:
        # Fall back to subscription metadata user_id
        meta = sub.get('metadata') or {}
        uid = meta.get('user_id')
        if not uid:
            return
        user = db.execute('SELECT * FROM users WHERE id = ?', (uid,)).fetchone()
        if not user:
            return
        db.execute('UPDATE users SET stripe_customer_id = ? WHERE id = ?', (cust_id, user['id']))

    # Lifetime grants are out-of-band (manual admin action) and must never be
    # demoted by an unrelated Stripe webhook (e.g. a one-time charge being
    # refunded, or a stale subscription being canceled).
    if (user['subscription_status'] or '').lower() == 'lifetime':
        return

    status = sub.get('status')  # trialing | active | past_due | canceled | unpaid | incomplete | incomplete_expired
    sub_id = sub.get('id')
    current_period_end = sub.get('current_period_end')
    trial_end = sub.get('trial_end')
    cancel_at_period_end = sub.get('cancel_at_period_end')

    if status in ('active', 'trialing'):
        new_status = 'premium' if status == 'active' else 'trial'
        # premium_until is "paid through" — for trialing, use trial_end; for active, current_period_end.
        until = trial_end if status == 'trialing' else current_period_end
        db.execute(
            """UPDATE users
               SET subscription_status = ?,
                   premium_until = ?,
                   trial_ends_at = COALESCE(?, trial_ends_at),
                   stripe_subscription_id = ?
               WHERE id = ?""",
            (new_status, until, trial_end, sub_id, user['id']),
        )
    elif status in ('canceled', 'unpaid', 'incomplete_expired'):
        # Don't yank premium mid-period — keep premium_until, just flip status when it lapses.
        db.execute(
            """UPDATE users
               SET subscription_status = CASE
                       WHEN premium_until IS NOT NULL AND premium_until > ? THEN 'premium'
                       ELSE 'free'
                   END,
                   stripe_subscription_id = ?
               WHERE id = ?""",
            (now_ts(), sub_id, user['id']),
        )
    elif status == 'past_due':
        # Keep current state; Stripe is dunning.
        db.execute('UPDATE users SET stripe_subscription_id = ? WHERE id = ?', (sub_id, user['id']))
    db.commit()


@app.route('/api/stripe/webhook', methods=['POST'])
def stripe_webhook():
    if not STRIPE_WEBHOOK_SECRET:
        return err('webhook_unconfigured', 'Webhook secret missing.', 503)
    payload = request.get_data()
    sig_header = request.headers.get('Stripe-Signature', '')
    try:
        event = stripe.Webhook.construct_event(payload, sig_header, STRIPE_WEBHOOK_SECRET)
    except (ValueError, stripe.error.SignatureVerificationError) as e:
        app.logger.warning('Stripe webhook signature failed: %s', e)
        return err('bad_signature', 'Invalid signature.', 400)

    et = event['type']
    eid = event.get('id')
    obj = event['data']['object']
    # Idempotency: skip events we've already processed.
    if eid:
        db = get_db()
        seen = db.execute('SELECT 1 FROM stripe_events WHERE id = ?', (eid,)).fetchone()
        if seen:
            return jsonify(received=True, duplicate=True)
        db.execute(
            'INSERT INTO stripe_events (id, type, received_at) VALUES (?, ?, ?)',
            (eid, et, now_ts()),
        )
        db.commit()
    try:
        if et == 'checkout.session.completed':
            # Link customer to user via metadata, then refresh the subscription.
            meta = obj.get('metadata') or {}
            uid = meta.get('user_id')
            cust_id = obj.get('customer')
            sub_id = obj.get('subscription')
            if uid and cust_id:
                get_db().execute(
                    'UPDATE users SET stripe_customer_id = COALESCE(stripe_customer_id, ?) WHERE id = ?',
                    (cust_id, uid),
                )
                get_db().commit()
            if sub_id:
                sub = stripe.Subscription.retrieve(sub_id)
                _apply_subscription(sub)
        elif et in ('customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'):
            _apply_subscription(obj)
        elif et == 'invoice.payment_failed':
            app.logger.warning('Payment failed for customer %s', obj.get('customer'))
        # Any other event type is ignored.
    except Exception as e:
        app.logger.exception('webhook handler error for %s: %s', et, e)
        # Still 200 so Stripe doesn't retry endlessly on internal bugs.
    return jsonify(received=True)


# ---------- Admin (bearer-token-gated) ----------
def _audit(action, target_uid=None, extra=None):
    """Append-only audit log for admin mutations. Compromised admin can't
    cover their tracks without DB write access."""
    try:
        db = get_db()
        ip = (request.headers.get('X-Real-IP')
              or (request.headers.get('X-Forwarded-For') or '').split(',')[0].strip()
              or request.remote_addr or '')
        ua = request.headers.get('User-Agent', '')[:300]
        extra_json = json.dumps(extra)[:1000] if extra else None
        db.execute(
            'INSERT INTO admin_audit (action, target_user_id, ip, user_agent, extra, ts) VALUES (?,?,?,?,?,?)',
            (action, target_uid, ip[:64], ua, extra_json, now_ts()),
        )
        db.commit()
    except Exception as e:
        app.logger.exception('audit log write failed: %s', e)


def require_admin():
    """Constant-time admin bearer token check. Returns True if request is authorized."""
    if not MGS_ADMIN_TOKEN:
        return False
    auth = request.headers.get('Authorization', '')
    token = ''
    if auth.startswith('Bearer '):
        token = auth[7:].strip()
    if not token:
        token = request.headers.get('X-Admin-Token', '').strip()
    if not token:
        return False
    return secrets.compare_digest(token, MGS_ADMIN_TOKEN)


def admin_gate():
    if not require_admin():
        return err('admin_unauthorized', 'Admin token missing or invalid.', 401)
    return None


@app.route('/api/admin/users')
def admin_users():
    blocked = admin_gate()
    if blocked:
        return blocked
    db = get_db()
    q = (request.args.get('q') or '').strip().lower()
    status = (request.args.get('status') or '').strip()
    try:
        limit = max(1, min(500, int(request.args.get('limit', 100))))
        offset = max(0, int(request.args.get('offset', 0)))
    except ValueError:
        limit, offset = 100, 0
    where, params = [], []
    if q:
        where.append('LOWER(email) LIKE ?')
        params.append(f'%{q}%')
    if status:
        where.append('subscription_status = ?')
        params.append(status)
    where_sql = ('WHERE ' + ' AND '.join(where)) if where else ''
    rows = db.execute(
        f"""SELECT u.id, u.email, u.created_at, u.subscription_status,
                   u.trial_ends_at, u.premium_until, u.stripe_customer_id,
                   u.stripe_subscription_id, u.notes,
                   (SELECT updated_at FROM sync_blobs sb WHERE sb.user_id = u.id) AS sync_updated_at,
                   (SELECT size FROM sync_blobs sb WHERE sb.user_id = u.id) AS sync_size,
                   (SELECT MAX(last_seen) FROM sessions s WHERE s.user_id = u.id) AS last_seen,
                   (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > {now_ts()}) AS active_sessions,
                   (SELECT COUNT(*) FROM share_links sl WHERE sl.user_id = u.id AND sl.expires_at > {now_ts()}) AS active_shares
            FROM users u
            {where_sql}
            ORDER BY u.created_at DESC
            LIMIT ? OFFSET ?""",
        (*params, limit, offset),
    ).fetchall()
    total = db.execute(f'SELECT COUNT(*) AS c FROM users u {where_sql}', params).fetchone()['c']
    return jsonify(
        total=total,
        limit=limit,
        offset=offset,
        users=[{
            'id': r['id'],
            'email': r['email'],
            'createdAt': r['created_at'],
            'subscriptionStatus': r['subscription_status'],
            'trialEndsAt': r['trial_ends_at'],
            'premiumUntil': r['premium_until'],
            'isPremium': is_premium_now(r),
            'hasStripeCustomer': bool(r['stripe_customer_id']),
            'stripeCustomerId': r['stripe_customer_id'],
            'stripeSubscriptionId': r['stripe_subscription_id'],
            'syncUpdatedAt': r['sync_updated_at'],
            'syncSize': r['sync_size'],
            'lastSeen': r['last_seen'],
            'activeSessions': r['active_sessions'],
            'activeShares': r['active_shares'],
            'notes': r['notes'],
        } for r in rows],
    )


@app.route('/api/admin/users/<int:user_id>')
def admin_user_detail(user_id):
    blocked = admin_gate()
    if blocked:
        return blocked
    db = get_db()
    u = db.execute('SELECT * FROM users WHERE id = ?', (user_id,)).fetchone()
    if not u:
        return err('not_found', 'User not found.', 404)
    sessions = db.execute(
        'SELECT token, created_at, expires_at, last_seen, user_agent FROM sessions WHERE user_id = ? ORDER BY COALESCE(last_seen, 0) DESC LIMIT 20',
        (user_id,),
    ).fetchall()
    shares = db.execute(
        'SELECT token, created_at, expires_at, views, label FROM share_links WHERE user_id = ? ORDER BY created_at DESC LIMIT 20',
        (user_id,),
    ).fetchall()
    sync = db.execute(
        'SELECT updated_at, size FROM sync_blobs WHERE user_id = ?',
        (user_id,),
    ).fetchone()
    # Stripe events for this user (linked via customer_id, scanned from recent events)
    return jsonify(
        user={
            'id': u['id'],
            'email': u['email'],
            'createdAt': u['created_at'],
            'subscriptionStatus': u['subscription_status'],
            'trialEndsAt': u['trial_ends_at'],
            'premiumUntil': u['premium_until'],
            'isPremium': is_premium_now(u),
            'stripeCustomerId': u['stripe_customer_id'],
            'stripeSubscriptionId': u['stripe_subscription_id'],
            'stripeCustomerIdTest': u['stripe_customer_id_test'],
            'stripeSubscriptionIdTest': u['stripe_subscription_id_test'],
            'testSubscriptionStatus': u['test_subscription_status'],
            'testPremiumUntil': u['test_premium_until'],
            'notes': u['notes'],
        },
        sessions=[{
            'tokenPrefix': r['token'][:8],
            'createdAt': r['created_at'],
            'expiresAt': r['expires_at'],
            'lastSeen': r['last_seen'],
            'userAgent': r['user_agent'],
        } for r in sessions],
        shareLinks=[dict(r) for r in shares],
        sync={'updatedAt': sync['updated_at'], 'size': sync['size']} if sync else None,
    )


@app.route('/api/admin/users/<int:user_id>/grant-lifetime', methods=['POST'])
def admin_grant_lifetime(user_id):
    blocked = admin_gate()
    if blocked:
        return blocked
    db = get_db()
    u = db.execute('SELECT id FROM users WHERE id = ?', (user_id,)).fetchone()
    if not u:
        return err('not_found', 'User not found.', 404)
    db.execute(
        "UPDATE users SET subscription_status = 'lifetime', premium_until = NULL WHERE id = ?",
        (user_id,),
    )
    db.commit()
    _audit('grant_lifetime', user_id)
    return jsonify(ok=True)


@app.route('/api/admin/users/<int:user_id>/extend-trial', methods=['POST'])
def admin_extend_trial(user_id):
    blocked = admin_gate()
    if blocked:
        return blocked
    data = request.get_json(silent=True) or {}
    try:
        days = int(data.get('days', 14))
    except (TypeError, ValueError):
        return err('invalid_days', 'days must be an integer.', 400)
    if days < 1 or days > 365:
        return err('invalid_days', 'days must be between 1 and 365.', 400)
    db = get_db()
    u = db.execute('SELECT * FROM users WHERE id = ?', (user_id,)).fetchone()
    if not u:
        return err('not_found', 'User not found.', 404)
    base = max(now_ts(), u['trial_ends_at'] or 0)
    new_end = base + days * 86400
    db.execute(
        "UPDATE users SET subscription_status = 'trial', trial_ends_at = ? WHERE id = ?",
        (new_end, user_id),
    )
    db.commit()
    _audit('extend_trial', user_id, {'days': days, 'newEndsAt': new_end})
    return jsonify(ok=True, trialEndsAt=new_end)


@app.route('/api/admin/users/<int:user_id>/force-logout', methods=['POST'])
def admin_force_logout(user_id):
    blocked = admin_gate()
    if blocked:
        return blocked
    db = get_db()
    n = db.execute('DELETE FROM sessions WHERE user_id = ?', (user_id,)).rowcount
    db.commit()
    _audit('force_logout', user_id, {'sessionsDeleted': n})
    return jsonify(ok=True)


@app.route('/api/admin/users/<int:user_id>/notes', methods=['PUT'])
def admin_set_notes(user_id):
    blocked = admin_gate()
    if blocked:
        return blocked
    data = request.get_json(silent=True) or {}
    notes = (data.get('notes') or '')[:2000] or None
    db = get_db()
    u = db.execute('SELECT id FROM users WHERE id = ?', (user_id,)).fetchone()
    if not u:
        return err('not_found', 'User not found.', 404)
    db.execute('UPDATE users SET notes = ? WHERE id = ?', (notes, user_id))
    db.commit()
    _audit('set_notes', user_id, {'len': len(notes) if notes else 0})
    return jsonify(ok=True)


@app.route('/api/admin/metrics')
def admin_metrics():
    blocked = admin_gate()
    if blocked:
        return blocked
    db = get_db()
    now = now_ts()
    day = 86400
    rows = db.execute('SELECT subscription_status, premium_until, trial_ends_at FROM users').fetchall()
    by_status = {'trial': 0, 'premium': 0, 'lifetime': 0, 'free': 0, 'other': 0}
    active_premium = 0
    active_trial = 0
    for r in rows:
        s = r['subscription_status'] or 'other'
        by_status[s] = by_status.get(s, 0) + 1
        if is_premium_now(r):
            if s == 'trial':
                active_trial += 1
            else:
                active_premium += 1
    # Signups over last 90 days, bucketed weekly.
    weeks = 13
    signup_curve = []
    for i in range(weeks - 1, -1, -1):
        start = now - (i + 1) * 7 * day
        end = now - i * 7 * day
        c = db.execute(
            'SELECT COUNT(*) AS c FROM users WHERE created_at >= ? AND created_at < ?',
            (start, end),
        ).fetchone()['c']
        signup_curve.append({'weekStart': start, 'count': c})
    # Stripe event volume last 30 days, daily.
    event_curve = []
    for i in range(29, -1, -1):
        start = now - (i + 1) * day
        end = now - i * day
        c = db.execute(
            'SELECT COUNT(*) AS c FROM stripe_events WHERE received_at >= ? AND received_at < ?',
            (start, end),
        ).fetchone()['c']
        event_curve.append({'dayStart': start, 'count': c})
    # MRR estimate: $1.99/mo × monthly subs + $19.99/yr × yearly subs / 12.
    # We don't track plan per-user, so approximate by counting active premium and using yearly avg
    # ($19.99 / 12 = $1.666). This is a rough estimate; the dashboard labels it as such.
    mrr_estimate_cents = active_premium * 166  # cents/mo
    sync_stats = db.execute('SELECT COUNT(*) AS c, COALESCE(SUM(size), 0) AS bytes FROM sync_blobs').fetchone()
    share_stats = db.execute(
        'SELECT COUNT(*) AS active FROM share_links WHERE expires_at > ?', (now,)
    ).fetchone()
    return jsonify(
        totals={
            'users': len(rows),
            'syncedAccounts': sync_stats['c'],
            'syncBytes': sync_stats['bytes'],
            'activeShareLinks': share_stats['active'],
            'activePremium': active_premium,
            'activeTrial': active_trial,
        },
        byStatus=by_status,
        mrrEstimateCents=mrr_estimate_cents,
        signupCurveWeekly=signup_curve,
        stripeEventCurveDaily=event_curve,
        stripeTestEnabled=_stripe_test_ready(),
        stripeLiveEnabled=_stripe_ready(),
        ts=now,
    )


@app.route('/api/admin/stripe-events')
def admin_stripe_events():
    blocked = admin_gate()
    if blocked:
        return blocked
    try:
        limit = max(1, min(500, int(request.args.get('limit', 100))))
    except ValueError:
        limit = 100
    rows = get_db().execute(
        'SELECT id, type, received_at FROM stripe_events ORDER BY received_at DESC LIMIT ?',
        (limit,),
    ).fetchall()
    return jsonify(events=[dict(r) for r in rows])


# ---------- Stripe TEST mode (separate keys, separate columns, never touches live data) ----------
def _stripe_test_ready():
    return bool(STRIPE_API_KEY_TEST and STRIPE_PRICE_MONTHLY_TEST and STRIPE_PRICE_YEARLY_TEST)


def _apply_subscription_test(sub):
    """Test-mode counterpart of _apply_subscription. Updates *_test columns only.
    Live subscription_status / premium_until are never touched in test mode.
    """
    cust_id = sub.get('customer')
    if not cust_id:
        return
    db = get_db()
    user = db.execute('SELECT * FROM users WHERE stripe_customer_id_test = ?', (cust_id,)).fetchone()
    if not user:
        meta = sub.get('metadata') or {}
        uid = meta.get('user_id')
        if not uid:
            return
        user = db.execute('SELECT * FROM users WHERE id = ?', (uid,)).fetchone()
        if not user:
            return
        db.execute('UPDATE users SET stripe_customer_id_test = ? WHERE id = ?', (cust_id, user['id']))
    status = sub.get('status')
    sub_id = sub.get('id')
    cpe = sub.get('current_period_end')
    trial_end = sub.get('trial_end')
    if status in ('active', 'trialing'):
        new_status = 'premium' if status == 'active' else 'trial'
        until = trial_end if status == 'trialing' else cpe
        db.execute(
            """UPDATE users SET test_subscription_status = ?, test_premium_until = ?,
                                stripe_subscription_id_test = ? WHERE id = ?""",
            (new_status, until, sub_id, user['id']),
        )
    elif status in ('canceled', 'unpaid', 'incomplete_expired'):
        db.execute(
            """UPDATE users SET test_subscription_status = 'free',
                                stripe_subscription_id_test = ? WHERE id = ?""",
            (sub_id, user['id']),
        )
    db.commit()


@app.route('/api/stripe/webhook/test', methods=['POST'])
def stripe_webhook_test():
    """Parallel webhook for Stripe test-mode events. Verifies with the test
    webhook secret and writes only to *_test columns."""
    if not STRIPE_WEBHOOK_SECRET_TEST:
        return err('webhook_unconfigured', 'Test webhook secret missing.', 503)
    payload = request.get_data()
    sig = request.headers.get('Stripe-Signature', '')
    try:
        event = stripe.Webhook.construct_event(payload, sig, STRIPE_WEBHOOK_SECRET_TEST)
    except (ValueError, stripe.error.SignatureVerificationError) as e:
        app.logger.warning('Stripe TEST webhook signature failed: %s', e)
        return err('bad_signature', 'Invalid signature.', 400)
    et = event['type']
    eid = event.get('id')
    obj = event['data']['object']
    # Namespace test event rows so a colliding live event ID can't silently
    # short-circuit a legitimate test event (or vice versa).
    test_eid = f'TEST:{eid}' if eid else None
    if test_eid:
        db = get_db()
        seen = db.execute('SELECT 1 FROM stripe_events WHERE id = ?', (test_eid,)).fetchone()
        if seen:
            return jsonify(received=True, duplicate=True)
        db.execute('INSERT INTO stripe_events (id, type, received_at) VALUES (?, ?, ?)',
                   (test_eid, f'TEST:{et}', now_ts()))
        db.commit()
    try:
        # In test mode we use the test API key for any retrieval call.
        prev = stripe.api_key
        if STRIPE_API_KEY_TEST:
            stripe.api_key = STRIPE_API_KEY_TEST
        try:
            if et == 'checkout.session.completed':
                meta = obj.get('metadata') or {}
                uid = meta.get('user_id')
                cust_id = obj.get('customer')
                sub_id = obj.get('subscription')
                if uid and cust_id:
                    get_db().execute(
                        'UPDATE users SET stripe_customer_id_test = COALESCE(stripe_customer_id_test, ?) WHERE id = ?',
                        (cust_id, uid),
                    )
                    get_db().commit()
                if sub_id:
                    sub = stripe.Subscription.retrieve(sub_id)
                    _apply_subscription_test(sub)
            elif et in ('customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'):
                _apply_subscription_test(obj)
        finally:
            stripe.api_key = prev
    except Exception as e:
        app.logger.exception('TEST webhook handler error for %s: %s', et, e)
    return jsonify(received=True, mode='test')


@app.route('/api/admin/billing/test-checkout', methods=['POST'])
def admin_test_checkout():
    """Create a Stripe TEST-mode Checkout session for a given user.
    Used by the smoke test script and by the admin UI to verify the full live flow
    without charging real money. Returns a Checkout URL.
    """
    blocked = admin_gate()
    if blocked:
        return blocked
    if not _stripe_test_ready():
        return err('test_unavailable', 'Stripe test mode is not configured (STRIPE_*_TEST env vars).', 503)
    data = request.get_json(silent=True) or {}
    user_id = data.get('userId')
    plan = (data.get('plan') or 'yearly').lower()
    if plan not in ('yearly', 'monthly'):
        return err('invalid_plan', 'plan must be "yearly" or "monthly".', 400)
    if not user_id:
        return err('user_id_required', 'userId is required.', 400)
    db = get_db()
    user = db.execute('SELECT * FROM users WHERE id = ?', (user_id,)).fetchone()
    if not user:
        return err('not_found', 'User not found.', 404)
    price_id = STRIPE_PRICE_YEARLY_TEST if plan == 'yearly' else STRIPE_PRICE_MONTHLY_TEST
    prev = stripe.api_key
    stripe.api_key = STRIPE_API_KEY_TEST
    try:
        # Reuse test customer if we already created one for this user.
        cust_id = user['stripe_customer_id_test']
        if not cust_id:
            cust = stripe.Customer.create(
                email=user['email'],
                metadata={'user_id': str(user['id']), 'app': 'myglpshot', 'mode': 'test'},
            )
            cust_id = cust.id
            db.execute('UPDATE users SET stripe_customer_id_test = ? WHERE id = ?', (cust_id, user['id']))
            db.commit()
        app_base = os.environ.get('APP_URL', 'https://app.myglpshot.com').rstrip('/')
        sess = stripe.checkout.Session.create(
            mode='subscription',
            customer=cust_id,
            line_items=[{'price': price_id, 'quantity': 1}],
            allow_promotion_codes=True,
            subscription_data={
                'trial_period_days': TRIAL_DAYS,
                'metadata': {'user_id': str(user['id']), 'app': 'myglpshot', 'mode': 'test'},
            },
            metadata={'user_id': str(user['id']), 'app': 'myglpshot', 'mode': 'test'},
            success_url=f'{app_base}/?billing=test-success&session_id={{CHECKOUT_SESSION_ID}}',
            cancel_url=f'{app_base}/?billing=test-canceled',
        )
    except stripe.StripeError as e:
        app.logger.exception('admin test-checkout failed: %s', e)
        return err('stripe_error', str(getattr(e, 'user_message', None) or 'Stripe error'), 502)
    finally:
        stripe.api_key = prev
    _audit('test_checkout_created', user['id'], {'plan': plan, 'sessionId': sess.id})
    return jsonify(url=sess.url, sessionId=sess.id, mode='test')


@app.route('/api/admin/users/<int:user_id>/demote-to-free', methods=['POST'])
def admin_demote_to_free(user_id):
    """Force a user to the 'free' tier (trial expired, no premium). Used to
    create demo accounts that show the gated UI for testing."""
    blocked = admin_gate()
    if blocked:
        return blocked
    db = get_db()
    u = db.execute('SELECT id FROM users WHERE id = ?', (user_id,)).fetchone()
    if not u:
        return err('not_found', 'User not found.', 404)
    past = now_ts() - 86400
    db.execute(
        """UPDATE users SET subscription_status = 'free',
                            trial_ends_at = ?,
                            premium_until = NULL
           WHERE id = ?""",
        (past, user_id),
    )
    db.commit()
    _audit('demote_to_free', user_id)
    return jsonify(ok=True)


@app.route('/api/admin/users/<int:user_id>', methods=['DELETE'])
def admin_delete_user(user_id):
    """Hard-delete a user and all their associated rows. Used for cleaning up
    demo / test accounts. Cancels any active Stripe subscription first."""
    blocked = admin_gate()
    if blocked:
        return blocked
    db = get_db()
    u = db.execute('SELECT * FROM users WHERE id = ?', (user_id,)).fetchone()
    if not u:
        return err('not_found', 'User not found.', 404)
    # Best-effort: cancel live Stripe subscription so we don't keep billing.
    if _stripe_ready() and u['stripe_subscription_id']:
        try:
            stripe.Subscription.delete(u['stripe_subscription_id'])
        except stripe.StripeError as e:
            app.logger.warning('Stripe sub cancel failed during admin delete: %s', e)
    db.execute('DELETE FROM share_links WHERE user_id = ?', (user_id,))
    db.execute('DELETE FROM sync_blobs WHERE user_id = ?', (user_id,))
    db.execute('DELETE FROM sessions WHERE user_id = ?', (user_id,))
    db.execute('DELETE FROM password_resets WHERE user_id = ?', (user_id,))
    db.execute('DELETE FROM users WHERE id = ?', (user_id,))
    db.commit()
    _audit('delete_user', user_id, {'email': u['email']})
    return jsonify(deleted=True, email=u['email'])


@app.route('/api/admin/users/<int:user_id>/clear-test-state', methods=['POST'])
def admin_clear_test_state(user_id):
    """Wipe a user's *_test columns so the next smoke test starts clean."""
    blocked = admin_gate()
    if blocked:
        return blocked
    db = get_db()
    db.execute(
        """UPDATE users SET stripe_customer_id_test = NULL,
                            stripe_subscription_id_test = NULL,
                            test_subscription_status = NULL,
                            test_premium_until = NULL
           WHERE id = ?""",
        (user_id,),
    )
    db.commit()
    _audit('clear_test_state', user_id)
    return jsonify(ok=True)


@app.route('/api/admin/audit')
def admin_audit_list():
    blocked = admin_gate()
    if blocked:
        return blocked
    try:
        limit = max(1, min(500, int(request.args.get('limit', 100))))
    except ValueError:
        limit = 100
    rows = get_db().execute(
        'SELECT id, action, target_user_id, ip, user_agent, extra, ts FROM admin_audit ORDER BY ts DESC LIMIT ?',
        (limit,),
    ).fetchall()
    return jsonify(audit=[dict(r) for r in rows])


# ---------- LLM-powered import ----------
IMPORT_PROMPT = (
    "You are a parser. The text below is an export from a GLP-1 / weight-loss / "
    "shot-tracking app (e.g. Shotsy, MyFitnessPal, etc.). Extract all shots and weights.\n\n"
    "Return ONLY valid JSON, no markdown fences, with this exact shape:\n"
    "{\n"
    '  "shots": [{"when":"ISO8601 datetime","dose":<mg as number>,"med":"<medication>",'
    '"site":"<one of: Abdomen — Left, Abdomen — Right, Thigh — Left, Thigh — Right, '
    'Upper arm — Left, Upper arm — Right, or empty string>","notes":"<string>"}],\n'
    '  "weights": [{"date":"YYYY-MM-DD","value":<lb as number>,"unit":"lb|kg"}]\n'
    "}\n\n"
    "Rules:\n"
    "- Convert dates to ISO8601 (assume midnight if time is missing).\n"
    "- Convert kg weights to lb if the source uses kg, BUT keep unit:\"kg\" if you cannot convert reliably.\n"
    "- Skip rows that lack a date or dose for shots / a date or value for weights.\n"
    "- If site is unrecognized, return empty string.\n"
    "- Default med to 'Tirzepatide' if not specified.\n"
    "- Output the JSON only.\n\n"
    "INPUT:\n"
)


@app.route('/api/import/parse', methods=['POST'])
def import_parse():
    user = require_user()
    if not user:
        return err('unauthorized', 'Not signed in.', 401)
    if not GEMINI_API_KEY:
        return err('llm_unavailable', 'LLM import is not configured on this server.', 503)
    data = request.get_json(silent=True) or {}
    text = (data.get('text') or '')
    if not text or len(text) < 10:
        return err('empty', 'No text to parse.', 400)
    if len(text) > 1_500_000:
        return err('too_large', 'Text exceeds 1.5 MB. Trim and retry.', 413)

    # Chunk on line boundaries so each Gemini call stays under the model's effective response budget.
    # 120K chars per chunk keeps response JSON well under the 32K-token cap even for densely-logged data.
    CHUNK = 120_000
    chunks = []
    if len(text) <= CHUNK:
        chunks = [text]
    else:
        start = 0
        while start < len(text):
            end = min(start + CHUNK, len(text))
            if end < len(text):
                # Backtrack to the last newline so we don't split a row mid-line.
                nl = text.rfind('\n', start, end)
                if nl > start + (CHUNK // 2):
                    end = nl + 1
            chunks.append(text[start:end])
            start = end

    import requests as _r
    all_shots, all_weights = [], []
    for idx, chunk in enumerate(chunks):
        body = {
            'contents': [{'parts': [{'text': IMPORT_PROMPT + chunk}]}],
            'generationConfig': {
                'temperature': 0.0,
                'maxOutputTokens': 32768,
                'responseMimeType': 'application/json',
            },
        }
        try:
            r = _r.post(
                f'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={GEMINI_API_KEY}',
                json=body, timeout=150,
            )
        except Exception as e:
            app.logger.exception('Gemini call failed (chunk %d/%d): %s', idx + 1, len(chunks), e)
            return err('llm_error', f'AI parser timed out on chunk {idx + 1}/{len(chunks)}. Try a smaller file.', 502)
        if r.status_code != 200:
            app.logger.warning('Gemini %s (chunk %d/%d): %s', r.status_code, idx + 1, len(chunks), r.text[:300])
            return err('llm_error', f'AI parser returned {r.status_code} on chunk {idx + 1}/{len(chunks)}.', 502)
        try:
            out = r.json()
            raw = out['candidates'][0]['content']['parts'][0]['text']
            parsed = json.loads(raw)
        except (KeyError, IndexError, ValueError, TypeError) as e:
            app.logger.warning('Gemini malformed (chunk %d/%d): %s — %s', idx + 1, len(chunks), e, r.text[:300])
            # Don't fail the whole import on one bad chunk — log + skip.
            continue
        shots = parsed.get('shots') if isinstance(parsed, dict) else None
        weights = parsed.get('weights') if isinstance(parsed, dict) else None
        if isinstance(shots, list): all_shots.extend(shots)
        if isinstance(weights, list): all_weights.extend(weights)

    # De-dupe across chunks: chunk overlap or repeated headers can produce duplicate rows.
    def _key_shot(s):
        try: return (str(s.get('when',''))[:16], round(float(s.get('dose') or 0), 3))
        except Exception: return (str(s.get('when','')), str(s.get('dose','')))
    def _key_weight(w):
        try: return (str(w.get('date',''))[:10], round(float(w.get('value') or 0), 2))
        except Exception: return (str(w.get('date','')), str(w.get('value','')))
    seen_s, dedup_s = set(), []
    for s in all_shots:
        k = _key_shot(s)
        if k in seen_s: continue
        seen_s.add(k); dedup_s.append(s)
    seen_w, dedup_w = set(), []
    for w in all_weights:
        k = _key_weight(w)
        if k in seen_w: continue
        seen_w.add(k); dedup_w.append(w)

    return jsonify(shots=dedup_s[:5000], weights=dedup_w[:5000], chunks=len(chunks))


# ---------- Bootstrap ----------
def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    with closing(sqlite3.connect(DB_PATH)) as c:
        c.executescript(SCHEMA)
        # Idempotent column adds for older DBs (tolerates concurrent worker init).
        for stmt in (
            'ALTER TABLE users ADD COLUMN stripe_subscription_id TEXT',
            'ALTER TABLE users ADD COLUMN stripe_customer_id_test TEXT',
            'ALTER TABLE users ADD COLUMN stripe_subscription_id_test TEXT',
            'ALTER TABLE users ADD COLUMN test_subscription_status TEXT',
            'ALTER TABLE users ADD COLUMN test_premium_until INTEGER',
        ):
            try:
                c.execute(stmt)
            except sqlite3.OperationalError:
                pass
        c.commit()


init_db()


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8080, debug=False)
