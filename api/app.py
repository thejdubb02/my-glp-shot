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
SESSION_TOUCH_INTERVAL = 300  # seconds between last_seen writes for one session
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
# Addresses that get is_admin=1 the moment they sign up. The operator's own
# account is otherwise a chicken-and-egg problem: the in-app admin view needs a
# signed-in admin, and promoting one by hand means a shell on the box every time.
# Server-side env only — never anything a request can influence.
MGS_ADMIN_EMAILS = {
    e.strip().lower() for e in os.environ.get('MGS_ADMIN_EMAILS', '').split(',') if e.strip()
}
# Smart Import goes through the LiteLLM gateway, not Google directly: the gateway
# holds the spend cap, the fallback chain, and the only key that appears in the
# fleet's registry. Google's own API is deliberately no longer reachable from here.
LITELLM_BASE_URL = os.environ.get('LITELLM_BASE_URL', 'http://litellm-gateway:4000')
LITELLM_API_KEY = os.environ.get('LITELLM_API_KEY', '')
# Web Push (VAPID). Generate once with scripts/gen-vapid-keys.py and put both in
# docker/api.env. Without them the push endpoints report unavailable and the
# client falls back to in-page timers.
VAPID_PUBLIC_KEY = os.environ.get('VAPID_PUBLIC_KEY', '')
VAPID_PRIVATE_KEY = os.environ.get('VAPID_PRIVATE_KEY', '')
VAPID_SUBJECT = os.environ.get('VAPID_SUBJECT', 'mailto:hello@myglpshot.com')
# Umami analytics — used by the admin Traffic card. Optional; if unset the
# /api/admin/traffic endpoint returns an empty-state payload instead of erroring.
UMAMI_URL = os.environ.get('UMAMI_URL', '').rstrip('/')
UMAMI_USERNAME = os.environ.get('UMAMI_USERNAME', '')
UMAMI_PASSWORD = os.environ.get('UMAMI_PASSWORD', '')
UMAMI_WEBSITE_ID_LANDING = os.environ.get('UMAMI_WEBSITE_ID_LANDING', '')
UMAMI_WEBSITE_ID_PWA = os.environ.get('UMAMI_WEBSITE_ID_PWA', '')
# Mattermost incoming webhook for operator notifications (new signups, first
# paid conversion). Optional — unset means the notifier is a silent no-op.
MATTERMOST_WEBHOOK_URL = os.environ.get('MATTERMOST_WEBHOOK_URL', '')
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
-- Per-identifier throttling. nginx already limits by IP, which does nothing
-- against a spread-out attempt on ONE account from many addresses, and nothing
-- to stop someone's inbox being flooded with reset mails.
CREATE TABLE IF NOT EXISTS auth_attempts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    scope       TEXT NOT NULL,      -- 'login' | 'forgot'
    identifier  TEXT NOT NULL,      -- normalised email
    ts          INTEGER NOT NULL,
    ok          INTEGER NOT NULL DEFAULT 0
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
-- Web Push. Deliberately minimal-disclosure: the server stores WHEN to send and
-- a generic string, never what the reminder is about. The client computes fire
-- times locally from data the server cannot read, and uploads only timestamps.
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    endpoint    TEXT UNIQUE NOT NULL,
    p256dh      TEXT NOT NULL,
    auth        TEXT NOT NULL,
    user_agent  TEXT,
    created_at  INTEGER NOT NULL,
    last_ok_at  INTEGER,
    fail_count  INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS push_reminders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    kind        TEXT NOT NULL,          -- 'shot' | 'daily:<key>'; no medication, no dose
    fire_at     INTEGER NOT NULL,
    title       TEXT NOT NULL,          -- from a fixed server-side allow-list
    body        TEXT NOT NULL,
    url         TEXT,
    sent_at     INTEGER,
    created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_audit_ts_idx ON admin_audit(ts DESC);
CREATE INDEX IF NOT EXISTS push_subs_user_idx ON push_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS push_rem_due_idx   ON push_reminders(fire_at) WHERE sent_at IS NULL;
CREATE INDEX IF NOT EXISTS push_rem_user_idx  ON push_reminders(user_id);
-- Every lookup below ran as a full table scan before these existed.
CREATE INDEX IF NOT EXISTS sessions_user_idx      ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx   ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS share_links_user_idx   ON share_links(user_id);
CREATE INDEX IF NOT EXISTS share_links_exp_idx    ON share_links(expires_at);
CREATE INDEX IF NOT EXISTS pw_resets_user_idx     ON password_resets(user_id);
CREATE INDEX IF NOT EXISTS pw_resets_exp_idx      ON password_resets(expires_at);
CREATE INDEX IF NOT EXISTS users_customer_idx     ON users(stripe_customer_id);
CREATE INDEX IF NOT EXISTS users_customer_test_idx ON users(stripe_customer_id_test);
CREATE INDEX IF NOT EXISTS users_created_idx      ON users(created_at);
CREATE INDEX IF NOT EXISTS stripe_events_ts_idx   ON stripe_events(received_at);
CREATE INDEX IF NOT EXISTS auth_attempts_idx      ON auth_attempts(scope, identifier, ts);
"""


def _configure_connection(db):
    """Pragmas that make SQLite safe under gunicorn's 2 workers x 4 threads.

    Without WAL every reader blocks every writer, and without a busy timeout a
    contended write fails instantly with 'database is locked' instead of waiting
    its turn. Both are per-connection settings, so they belong here rather than
    in the schema.
    """
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA journal_mode=WAL')
    db.execute('PRAGMA busy_timeout=5000')
    db.execute('PRAGMA synchronous=NORMAL')
    db.execute('PRAGMA foreign_keys=ON')
    return db


def get_db():
    db = getattr(g, '_db', None)
    if db is None:
        # The schema is created once at boot by init_db(). Re-running it on every
        # request re-parsed 8 CREATE statements and forced an implicit commit
        # before each one, for no benefit.
        db = g._db = _configure_connection(sqlite3.connect(DB_PATH, timeout=5.0))
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


# Per-account throttles. nginx's limit_req is keyed on IP, so it does not slow a
# credential-stuffing run spread across many addresses against one account, and
# it does not stop someone triggering a reset mail to a victim's inbox on repeat.
LOGIN_WINDOW = 900          # 15 minutes
LOGIN_MAX_FAILURES = 10     # failed logins per account per window
FORGOT_WINDOW = 3600        # 1 hour
FORGOT_MAX = 3              # reset mails per address per window


def _record_attempt(scope, identifier, ok=False):
    try:
        db = get_db()
        db.execute(
            'INSERT INTO auth_attempts (scope, identifier, ts, ok) VALUES (?, ?, ?, ?)',
            (scope, identifier[:200], now_ts(), 1 if ok else 0),
        )
        db.commit()
    except Exception as e:
        app.logger.warning('auth_attempts write failed: %s', e)


def _too_many_attempts(scope, identifier, window, limit, failures_only=True):
    """True if `identifier` is over the limit for `scope` inside `window`."""
    try:
        sql = 'SELECT COUNT(*) AS c FROM auth_attempts WHERE scope = ? AND identifier = ? AND ts > ?'
        params = [scope, identifier[:200], now_ts() - window]
        if failures_only:
            sql += ' AND ok = 0'
        return get_db().execute(sql, params).fetchone()['c'] >= limit
    except Exception as e:
        # A throttle that errors must not lock everyone out of their account.
        app.logger.warning('auth_attempts read failed: %s', e)
        return False


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
        'isAdmin': bool(_safe_col(user_row, 'is_admin')),
    }


def _safe_col(row, name, default=0):
    """sqlite3.Row throws on missing column on older DBs pre-migration."""
    try:
        return row[name]
    except (IndexError, KeyError):
        return default


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
    # last_seen only drives an admin "when were they last here" column, so a
    # write on literally every authenticated request was pure write contention.
    # Once every 5 minutes is the same information at a fraction of the cost.
    now = now_ts()
    if (sess['last_seen'] or 0) < now - SESSION_TOUCH_INTERVAL:
        db.execute('UPDATE sessions SET last_seen = ? WHERE token = ?', (now, token))
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


def notify_mattermost(text):
    """Best-effort operator ping to Mattermost. No-op if unset.

    Fired on a daemon thread: a slow or down Mattermost must never add latency to
    a signup, and must never fail one. Nothing here is retried — a missed
    notification is a missed notification, not a reason to hold up a user.
    """
    if not MATTERMOST_WEBHOOK_URL:
        return False

    def _post():
        try:
            import requests as _r
            _r.post(MATTERMOST_WEBHOOK_URL, json={'text': text}, timeout=6)
        except Exception as e:
            app.logger.warning('mattermost notify failed: %s', e)

    try:
        import threading
        threading.Thread(target=_post, daemon=True).start()
        return True
    except Exception as e:
        app.logger.warning('mattermost notify could not start: %s', e)
        return False


# ---------- Retention ----------
# Expired rows used to accumulate forever: dead sessions, spent reset tokens,
# lapsed share links and every Stripe event ever seen. That is both unbounded
# growth and a privacy problem — an expired doctor share link is still health
# data sitting in the database.
LEGACY_BLOB_TTL_DAYS = 400   # untouched legacy sync blobs are unreachable data
STRIPE_EVENT_TTL_DAYS = 120  # only needed for the idempotency window


def purge_expired(db=None):
    """Delete rows that are past their useful life. Safe to call repeatedly."""
    db = db or get_db()
    now = now_ts()
    deleted = {}
    deleted['sessions'] = db.execute('DELETE FROM sessions WHERE expires_at < ?', (now,)).rowcount
    deleted['share_links'] = db.execute('DELETE FROM share_links WHERE expires_at < ?', (now,)).rowcount
    deleted['password_resets'] = db.execute(
        'DELETE FROM password_resets WHERE expires_at < ? OR used_at IS NOT NULL', (now,)
    ).rowcount
    deleted['stripe_events'] = db.execute(
        'DELETE FROM stripe_events WHERE received_at < ?', (now - STRIPE_EVENT_TTL_DAYS * 86400,)
    ).rowcount
    deleted['auth_attempts'] = db.execute(
        'DELETE FROM auth_attempts WHERE ts < ?', (now - 86400,)
    ).rowcount
    # Legacy blobs carry no user_id — a content-addressed lookup_id is the only
    # handle — so age is the only retention lever available for them.
    deleted['legacy_blobs'] = db.execute(
        'DELETE FROM legacy_blobs WHERE updated_at < ?', (now - LEGACY_BLOB_TTL_DAYS * 86400,)
    ).rowcount
    db.commit()
    return deleted


# ---------- Health ----------
@app.route('/api/health')
def health():
    """Liveness + a real database read, so a wedged DB fails the healthcheck."""
    try:
        get_db().execute('SELECT 1').fetchone()
    except Exception as e:
        app.logger.exception('health check DB probe failed: %s', e)
        return jsonify(ok=False, error='db_unavailable'), 503
    return jsonify(ok=True, ts=now_ts())


@app.route('/api/admin/purge', methods=['POST'])
def admin_purge():
    blocked = admin_gate()
    if blocked:
        return blocked
    deleted = purge_expired()
    _audit('purge_expired', None, deleted)
    return jsonify(ok=True, deleted=deleted)


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
    is_admin = 1 if email in MGS_ADMIN_EMAILS else 0
    try:
        cur = db.execute(
            """INSERT INTO users (email, password_hash, created_at, subscription_status, trial_ends_at, is_admin)
               VALUES (?, ?, ?, 'trial', ?, ?)""",
            (email, pw_hash, now_ts(), trial_ends, is_admin),
        )
    except sqlite3.IntegrityError:
        # Two signups for the same address in flight at once — the UNIQUE index is
        # the real guard; the SELECT above is only a fast path. Report it as the
        # conflict it is instead of a 500.
        return err('email_in_use', 'An account with this email already exists.', 409)
    user_id = cur.lastrowid
    db.commit()
    user = db.execute('SELECT * FROM users WHERE id = ?', (user_id,)).fetchone()

    try:
        total = db.execute('SELECT COUNT(*) AS c FROM users').fetchone()['c']
        notify_mattermost(
            f"🎉 **New My GLP Shot signup** — `{email}`\n"
            f"Account #{user_id} · {TRIAL_DAYS}-day trial runs to "
            f"{datetime.fromtimestamp(trial_ends, timezone.utc).strftime('%Y-%m-%d')} · "
            f"{total} accounts total."
        )
    except Exception as e:
        # A notification problem is never a reason to fail a signup.
        app.logger.warning('signup notify failed: %s', e)

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
    if _too_many_attempts('login', email, LOGIN_WINDOW, LOGIN_MAX_FAILURES):
        return err('too_many_attempts',
                   'Too many failed sign-in attempts for this account. Try again in 15 minutes.', 429)

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
        _record_attempt('login', email, ok=False)
        return err('invalid_credentials', 'Email or password incorrect.', 401)
    # Clear the run of failures so a successful sign-in resets the counter.
    get_db().execute('DELETE FROM auth_attempts WHERE scope = ? AND identifier = ?', ('login', email))
    get_db().commit()

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
    # Best-effort: cancel Stripe subscriptions so we don't keep billing. Test-mode
    # subscriptions are cancelled too — a leftover test sub keeps firing webhooks
    # for a user row that no longer exists.
    if _stripe_ready() and user['stripe_subscription_id']:
        try:
            stripe.Subscription.delete(user['stripe_subscription_id'], api_key=STRIPE_API_KEY)
        except stripe.StripeError as e:
            app.logger.warning('Stripe sub cancel failed during account delete: %s', e)
    if STRIPE_API_KEY_TEST and _safe_col(user, 'stripe_subscription_id_test', None):
        try:
            stripe.Subscription.delete(user['stripe_subscription_id_test'], api_key=STRIPE_API_KEY_TEST)
        except stripe.StripeError as e:
            app.logger.warning('Stripe TEST sub cancel failed during account delete: %s', e)
    db.execute('DELETE FROM share_links WHERE user_id = ?', (uid,))
    db.execute('DELETE FROM sync_blobs WHERE user_id = ?', (uid,))
    db.execute('DELETE FROM sessions WHERE user_id = ?', (uid,))
    db.execute('DELETE FROM password_resets WHERE user_id = ?', (uid,))
    # Push rows are a per-device identifier and a reminder schedule — personal
    # data, and they outlived the account when push was added. Delete-account
    # has to cover every table that keys on user_id.
    db.execute('DELETE FROM push_subscriptions WHERE user_id = ?', (uid,))
    db.execute('DELETE FROM push_reminders WHERE user_id = ?', (uid,))
    db.execute('DELETE FROM auth_attempts WHERE identifier = ?', (user['email'],))
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
    # Cap reset mails per address. Still returns ok either way — saying "you are
    # rate limited" would confirm the address exists, which is exactly what the
    # generic response below is protecting against.
    if _too_many_attempts('forgot', email, FORGOT_WINDOW, FORGOT_MAX, failures_only=False):
        app.logger.warning('forgot-password throttled for %s', email)
        return jsonify(ok=True)
    _record_attempt('forgot', email, ok=True)
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
    # Burn every outstanding reset for this account, not just the one used —
    # otherwise an older emailed link stays live and can reset the new password.
    db.execute(
        'UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL',
        (now_ts(), row['user_id']),
    )
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


# Writes to this path are CLOSED (2026-08-09). The lookup_id is the only
# credential, it travels in the URL — so it lands in access logs, browser
# history and referrer headers — and there was no ownership check, meaning
# anyone who ever saw one could overwrite or destroy that person's cloud copy.
#
# Read stays open so anyone still holding a legacy id can recover their data
# into an account; a read exposes ciphertext they cannot decrypt without the
# passphrase. Rows untouched for LEGACY_BLOB_TTL_DAYS are swept by purge_expired.
@app.route('/api/sync/<lookup_id>', methods=['PUT', 'DELETE'])
def legacy_write_closed(lookup_id):
    return err(
        'legacy_sync_closed',
        'Legacy sync is read-only. Sign in with an account to back up — open the app '
        'and use "Restore from legacy sync" to bring your old data across.',
        410,
    )


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
    # Only first-time subscribers get the introductory trial.
    subscription_data = {'metadata': {'user_id': str(user['id']), 'app': 'myglpshot'}}
    if not _has_used_trial(user):
        subscription_data['trial_period_days'] = TRIAL_DAYS
    try:
        sess = stripe.checkout.Session.create(
            mode='subscription',
            customer=customer_id,
            line_items=[{'price': price_id, 'quantity': 1}],
            allow_promotion_codes=True,
            subscription_data=subscription_data,
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


def _period_end(sub):
    """Paid-through timestamp for a Stripe subscription.

    Stripe moved current_period_end off the Subscription object and onto each
    subscription item in the 2025-03-31 API version. Reading only the top-level
    field silently yields None on a newer account, which would write a NULL
    premium_until and drop a paying customer to free.
    """
    top = sub.get('current_period_end')
    if top:
        return top
    items = (sub.get('items') or {}).get('data') or []
    ends = [i.get('current_period_end') for i in items if i.get('current_period_end')]
    return max(ends) if ends else None


def _has_used_trial(user):
    """True if this account has already consumed its introductory trial.

    Without this check every new Checkout session handed out another 14 free
    days, so cancel-and-resubscribe was an unlimited free plan.
    """
    if user['trial_ends_at']:
        return True
    return (user['subscription_status'] or '').lower() in ('premium', 'lifetime', 'free')


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
    current_period_end = _period_end(sub)
    trial_end = sub.get('trial_end')
    cancel_at_period_end = sub.get('cancel_at_period_end')

    if status in ('active', 'trialing'):
        new_status = 'premium' if status == 'active' else 'trial'
        # premium_until is "paid through" — for trialing, use trial_end; for active, current_period_end.
        until = trial_end if status == 'trialing' else current_period_end
        was_paid = (user['subscription_status'] or '').lower() == 'premium'
        db.execute(
            """UPDATE users
               SET subscription_status = ?,
                   premium_until = ?,
                   trial_ends_at = COALESCE(?, trial_ends_at),
                   stripe_subscription_id = ?
               WHERE id = ?""",
            (new_status, until, trial_end, sub_id, user['id']),
        )
        # Only on the transition into paid — renewals fire this same webhook every
        # billing period and shouldn't ping.
        if new_status == 'premium' and not was_paid:
            notify_mattermost(f"💳 **My GLP Shot — paid subscription** — `{user['email']}` (account #{user['id']}).")
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
    # Idempotency. INSERT OR IGNORE claims the event atomically — the previous
    # SELECT-then-INSERT let two concurrent deliveries of the same event both
    # pass the check and process twice.
    if eid:
        db = get_db()
        claimed = db.execute(
            'INSERT OR IGNORE INTO stripe_events (id, type, received_at) VALUES (?, ?, ?)',
            (eid, et, now_ts()),
        ).rowcount
        db.commit()
        if not claimed:
            return jsonify(received=True, duplicate=True)
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
                sub = stripe.Subscription.retrieve(sub_id, api_key=STRIPE_API_KEY)
                _apply_subscription(sub)
        elif et in ('customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'):
            _apply_subscription(obj)
        elif et == 'invoice.payment_failed':
            app.logger.warning('Payment failed for customer %s', obj.get('customer'))
        # Any other event type is ignored.
    except Exception as e:
        # Release the idempotency claim and fail loudly. Returning 200 here meant
        # a transient error permanently dropped a subscription change — the user
        # paid and never got premium, and Stripe never retried.
        app.logger.exception('webhook handler error for %s: %s', et, e)
        if eid:
            try:
                db = get_db()
                db.execute('DELETE FROM stripe_events WHERE id = ?', (eid,))
                db.commit()
            except Exception:
                app.logger.exception('failed to release idempotency claim for %s', eid)
        return err('handler_error', 'Webhook handler failed; retry.', 500)
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
    """Admin authorized if EITHER a valid session belongs to a user with
    is_admin=1, OR the legacy MGS_ADMIN_TOKEN bearer is presented.

    Session path is what the PWA uses (cookie auth → no token entry, no
    second login). Token path stays for emergency / scripted access when
    no admin session exists."""
    # 1) Session-based admin (PWA embed, signed-in user with is_admin=1)
    user, _ = get_session_user()
    if user is not None:
        try:
            if int(user['is_admin'] or 0) == 1:
                return True
        except (KeyError, IndexError, TypeError):
            pass

    # 2) Legacy bearer token. Note: if a session token IS present in the
    # Authorization header, get_session_user() above already handled it; we
    # only fall through here for the raw admin token case.
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
    # Don't compare session-shaped tokens against the admin secret.
    if TOKEN_RE.match(token):
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
    # Always exclude admin/staff accounts so the user table reflects real
    # customers only. Admins manage themselves out-of-band (DB / promote script).
    where, params = ['COALESCE(u.is_admin, 0) = 0'], []
    if q:
        where.append('LOWER(u.email) LIKE ?')
        params.append(f'%{q}%')
    if status:
        where.append('u.subscription_status = ?')
        params.append(status)
    where_sql = 'WHERE ' + ' AND '.join(where)
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
    # Admin accounts (owner / staff) are excluded from every count and curve
    # so the dashboard reflects REAL users only. Toggle in DB via is_admin=1.
    rows = db.execute('SELECT subscription_status, premium_until, trial_ends_at FROM users WHERE COALESCE(is_admin, 0) = 0').fetchall()
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
            'SELECT COUNT(*) AS c FROM users WHERE created_at >= ? AND created_at < ? AND COALESCE(is_admin, 0) = 0',
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
    # Sync + share stats also exclude admin-owned rows so totals stay honest.
    sync_stats = db.execute(
        '''SELECT COUNT(*) AS c, COALESCE(SUM(size), 0) AS bytes
           FROM sync_blobs sb
           WHERE sb.user_id IN (SELECT id FROM users WHERE COALESCE(is_admin, 0) = 0)'''
    ).fetchone()
    share_stats = db.execute(
        '''SELECT COUNT(*) AS active FROM share_links sl
           WHERE sl.expires_at > ?
             AND sl.user_id IN (SELECT id FROM users WHERE COALESCE(is_admin, 0) = 0)''',
        (now,)
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


# ---------- Umami traffic proxy (admin only) ----------
# Cached login token so we don't hammer Umami's /auth/login on every request.
_umami_state = {'token': '', 'expires_at': 0}


def _umami_login():
    """Return a Bearer token for Umami's API, cached for ~50 minutes."""
    if not (UMAMI_URL and UMAMI_USERNAME and UMAMI_PASSWORD):
        return ''
    now = now_ts()
    if _umami_state['token'] and _umami_state['expires_at'] > now + 60:
        return _umami_state['token']
    try:
        import requests as _r
        resp = _r.post(
            f'{UMAMI_URL}/api/auth/login',
            json={'username': UMAMI_USERNAME, 'password': UMAMI_PASSWORD},
            timeout=8,
        )
        if resp.status_code != 200:
            app.logger.warning('umami login failed: %s %s', resp.status_code, resp.text[:200])
            return ''
        tok = resp.json().get('token', '')
        _umami_state['token'] = tok
        _umami_state['expires_at'] = now + 50 * 60  # 50 min
        return tok
    except Exception as e:
        app.logger.warning('umami login error: %s', e)
        return ''


def _umami_get(path, params=None):
    tok = _umami_login()
    if not tok:
        return None
    try:
        import requests as _r
        resp = _r.get(
            f'{UMAMI_URL}{path}',
            headers={'Authorization': f'Bearer {tok}'},
            params=params or {},
            timeout=10,
        )
        if resp.status_code == 401:
            # Token expired despite our cache window — wipe and retry once.
            _umami_state['token'] = ''
            _umami_state['expires_at'] = 0
            tok = _umami_login()
            if not tok:
                return None
            resp = _r.get(
                f'{UMAMI_URL}{path}',
                headers={'Authorization': f'Bearer {tok}'},
                params=params or {},
                timeout=10,
            )
        if resp.status_code != 200:
            return None
        return resp.json()
    except Exception as e:
        app.logger.warning('umami GET %s failed: %s', path, e)
        return None


def _umami_website_payload(website_id, label):
    """Fetch the stats + top pages + top referrers for one Umami website."""
    if not website_id:
        return None
    now_ms = int(time.time() * 1000)
    starts = {
        '24h': now_ms - 24 * 3600 * 1000,
        '7d':  now_ms - 7 * 86400 * 1000,
        '30d': now_ms - 30 * 86400 * 1000,
    }
    ranges = {}
    for label_key, start_ms in starts.items():
        stats = _umami_get(f'/api/websites/{website_id}/stats', {'startAt': start_ms, 'endAt': now_ms})
        if stats is None:
            stats = {}
        # Umami returns ints OR {'value', 'change'} dicts depending on the
        # comparison flag. Normalize to ints.
        def _as_int(v):
            if isinstance(v, dict):
                return int(v.get('value', 0) or 0)
            try:
                return int(v or 0)
            except (TypeError, ValueError):
                return 0
        ranges[label_key] = {
            'pageviews': _as_int(stats.get('pageviews')),
            'visitors':  _as_int(stats.get('visitors')),
            'visits':    _as_int(stats.get('visits')),
            'bounces':   _as_int(stats.get('bounces')),
        }
    # Top pages (7d window)
    pages_raw = _umami_get(
        f'/api/websites/{website_id}/metrics',
        {'type': 'url', 'startAt': starts['7d'], 'endAt': now_ms, 'limit': 8},
    ) or []
    top_pages = [{'url': p.get('x', '') or '', 'views': int(p.get('y', 0) or 0)} for p in pages_raw][:8]
    # Top referrers (7d)
    refs_raw = _umami_get(
        f'/api/websites/{website_id}/metrics',
        {'type': 'referrer', 'startAt': starts['7d'], 'endAt': now_ms, 'limit': 8},
    ) or []
    top_referrers = [{'source': p.get('x', '') or 'Direct', 'visits': int(p.get('y', 0) or 0)} for p in refs_raw][:8]
    return {
        'label': label,
        'websiteId': website_id,
        'ranges': ranges,
        'topPages': top_pages,
        'topReferrers': top_referrers,
    }


@app.route('/api/admin/traffic')
def admin_traffic():
    blocked = admin_gate()
    if blocked:
        return blocked
    if not UMAMI_URL:
        return jsonify(configured=False, message='Umami not configured. Set UMAMI_URL/UMAMI_USERNAME/UMAMI_PASSWORD/UMAMI_WEBSITE_ID_* in api.env.'), 200
    landing = _umami_website_payload(UMAMI_WEBSITE_ID_LANDING, 'Marketing (myglpshot.com)')
    pwa = _umami_website_payload(UMAMI_WEBSITE_ID_PWA, 'PWA (app.myglpshot.com)')
    sites = [s for s in (landing, pwa) if s]
    if not sites:
        return jsonify(configured=True, ok=False, message='Could not reach Umami or no website IDs configured.'), 200
    return jsonify(configured=True, ok=True, sites=sites, ts=now_ts())


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
    cpe = _period_end(sub)
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
        claimed = db.execute(
            'INSERT OR IGNORE INTO stripe_events (id, type, received_at) VALUES (?, ?, ?)',
            (test_eid, f'TEST:{et}', now_ts()),
        ).rowcount
        db.commit()
        if not claimed:
            return jsonify(received=True, duplicate=True)
    try:
        # The test API key is passed per call. Assigning it to the process-global
        # `stripe.api_key` raced with concurrent live requests on the other
        # gunicorn threads — a live checkout could execute against the test key.
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
                sub = stripe.Subscription.retrieve(sub_id, api_key=STRIPE_API_KEY_TEST)
                _apply_subscription_test(sub)
        elif et in ('customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'):
            _apply_subscription_test(obj)
    except Exception as e:
        app.logger.exception('TEST webhook handler error for %s: %s', et, e)
        if test_eid:
            try:
                db = get_db()
                db.execute('DELETE FROM stripe_events WHERE id = ?', (test_eid,))
                db.commit()
            except Exception:
                app.logger.exception('failed to release test idempotency claim for %s', test_eid)
        return err('handler_error', 'Test webhook handler failed; retry.', 500)
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
    # api_key is passed per call rather than swapped on the module global, which
    # would be visible to every other thread in this worker mid-request.
    try:
        # Reuse test customer if we already created one for this user.
        cust_id = user['stripe_customer_id_test']
        if not cust_id:
            cust = stripe.Customer.create(
                email=user['email'],
                metadata={'user_id': str(user['id']), 'app': 'myglpshot', 'mode': 'test'},
                api_key=STRIPE_API_KEY_TEST,
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
            api_key=STRIPE_API_KEY_TEST,
        )
    except stripe.StripeError as e:
        app.logger.exception('admin test-checkout failed: %s', e)
        return err('stripe_error', str(getattr(e, 'user_message', None) or 'Stripe error'), 502)
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
    db.execute('DELETE FROM push_subscriptions WHERE user_id = ?', (user_id,))
    db.execute('DELETE FROM push_reminders WHERE user_id = ?', (user_id,))
    db.execute('DELETE FROM auth_attempts WHERE identifier = ?', (u['email'],))
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


# ---------- Web Push reminders ----------
# Design note (this is the whole privacy argument, so it lives next to the code):
#
# Reminders have to survive the app being closed, which means a server has to
# send them, which means a server has to know when. That is the only thing it
# learns. The client computes fire times from the schedule in its own encrypted
# store and uploads timestamps plus a *kind*; the wording is chosen here from a
# fixed list. The server never receives the medication, the dose, the injection
# site, or any history — a database dump would show that someone gets a nudge on
# a rhythm, not what they take.
PUSH_MAX_QUEUED = 32          # upcoming reminders one account may have queued
PUSH_MAX_HORIZON_DAYS = 45    # refuse fire times further out than this
PUSH_MAX_FAILURES = 5         # consecutive failures before a subscription is dropped

# Reminder copy is server-side so an uploaded string can never become the text of
# a notification (or a place to smuggle detail into the server's database).
PUSH_COPY = {
    'shot':                ('💧 My GLP Shot',   'Your next shot is due.',                          '/#reminder=shot'),
    'daily:weight':        ('⚖️ Log your weight', 'Quick daily weigh-in keeps your chart honest.',   '/#reminder=weight'),
    'daily:moodAppetite':  ('😊 How are you feeling?', 'Tap to log mood, appetite, and food-noise for today.', '/#reminder=moodAppetite'),
    'daily:sideEffects':   ('🩺 Side effects check-in', 'Anything to report today? Logging helps spot patterns.', '/#reminder=sideEffects'),
    'daily:measurements':  ('📏 Body measurements', 'Time to log waist, hips, and any other tracked sites.', '/#reminder=measurements'),
}


def _push_ready():
    return bool(VAPID_PRIVATE_KEY and VAPID_PUBLIC_KEY)


@app.route('/api/push/key')
def push_key():
    """Public VAPID key, needed by the browser to create a subscription."""
    if not _push_ready():
        return err('push_unavailable', 'Push is not configured on this server.', 503)
    return jsonify(publicKey=VAPID_PUBLIC_KEY)


@app.route('/api/push/subscribe', methods=['POST'])
def push_subscribe():
    user = require_user()
    if not user:
        return err('unauthorized', 'Not signed in.', 401)
    if not _push_ready():
        return err('push_unavailable', 'Push is not configured on this server.', 503)
    data = request.get_json(silent=True) or {}
    endpoint = (data.get('endpoint') or '').strip()
    keys = data.get('keys') or {}
    p256dh = (keys.get('p256dh') or '').strip()
    auth_k = (keys.get('auth') or '').strip()
    if not endpoint.startswith('https://') or len(endpoint) > 1000 or not p256dh or not auth_k:
        return err('invalid_subscription', 'Malformed push subscription.', 400)
    db = get_db()
    db.execute(
        """INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, created_at, fail_count)
           VALUES (?, ?, ?, ?, ?, ?, 0)
           ON CONFLICT(endpoint) DO UPDATE SET
               user_id=excluded.user_id, p256dh=excluded.p256dh,
               auth=excluded.auth, fail_count=0""",
        (user['id'], endpoint, p256dh[:200], auth_k[:100],
         request.headers.get('User-Agent', '')[:300], now_ts()),
    )
    db.commit()
    return jsonify(ok=True)


@app.route('/api/push/unsubscribe', methods=['POST'])
def push_unsubscribe():
    user = require_user()
    if not user:
        return err('unauthorized', 'Not signed in.', 401)
    data = request.get_json(silent=True) or {}
    endpoint = (data.get('endpoint') or '').strip()
    db = get_db()
    if endpoint:
        db.execute('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', (endpoint, user['id']))
    else:
        db.execute('DELETE FROM push_subscriptions WHERE user_id = ?', (user['id'],))
    # A device that stops receiving reminders should stop having them queued.
    db.execute('DELETE FROM push_reminders WHERE user_id = ? AND sent_at IS NULL', (user['id'],))
    db.commit()
    return jsonify(ok=True)


@app.route('/api/push/schedule', methods=['PUT'])
def push_schedule():
    """Replace this account's queued reminders with the set the client just computed.

    Replace rather than append: the client is the only thing that knows the real
    schedule, so its latest view is always authoritative, and a settings change
    must be able to cancel a reminder rather than add a second one.
    """
    user = require_user()
    if not user:
        return err('unauthorized', 'Not signed in.', 401)
    if not _push_ready():
        return err('push_unavailable', 'Push is not configured on this server.', 503)
    data = request.get_json(silent=True) or {}
    items = data.get('reminders')
    if not isinstance(items, list):
        return err('invalid_payload', 'reminders must be a list.', 400)
    if len(items) > PUSH_MAX_QUEUED:
        return err('too_many', f'At most {PUSH_MAX_QUEUED} queued reminders.', 400)

    now = now_ts()
    horizon = now + PUSH_MAX_HORIZON_DAYS * 86400
    rows = []
    for it in items:
        if not isinstance(it, dict):
            continue
        kind = str(it.get('kind') or '')
        if kind not in PUSH_COPY:
            continue                       # unknown kind: no copy exists, so nothing to send
        try:
            fire_at = int(it.get('fireAt'))
        except (TypeError, ValueError):
            continue
        if fire_at <= now or fire_at > horizon:
            continue
        title, body, url = PUSH_COPY[kind]
        rows.append((user['id'], kind, fire_at, title, body, url, now))

    db = get_db()
    db.execute('DELETE FROM push_reminders WHERE user_id = ? AND sent_at IS NULL', (user['id'],))
    if rows:
        db.executemany(
            """INSERT INTO push_reminders (user_id, kind, fire_at, title, body, url, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            rows,
        )
    db.commit()
    has_sub = db.execute('SELECT 1 FROM push_subscriptions WHERE user_id = ?', (user['id'],)).fetchone()
    return jsonify(ok=True, queued=len(rows), hasSubscription=bool(has_sub))


@app.route('/api/push/status')
def push_status():
    user = require_user()
    if not user:
        return err('unauthorized', 'Not signed in.', 401)
    db = get_db()
    subs = db.execute('SELECT COUNT(*) AS c FROM push_subscriptions WHERE user_id = ?', (user['id'],)).fetchone()['c']
    queued = db.execute(
        'SELECT COUNT(*) AS c FROM push_reminders WHERE user_id = ? AND sent_at IS NULL AND fire_at > ?',
        (user['id'], now_ts()),
    ).fetchone()['c']
    nxt = db.execute(
        'SELECT MIN(fire_at) AS n FROM push_reminders WHERE user_id = ? AND sent_at IS NULL AND fire_at > ?',
        (user['id'], now_ts()),
    ).fetchone()['n']
    return jsonify(configured=_push_ready(), devices=subs, queued=queued, nextFireAt=nxt)


@app.route('/api/push/test', methods=['POST'])
def push_test():
    user = require_user()
    if not user:
        return err('unauthorized', 'Not signed in.', 401)
    if not _push_ready():
        return err('push_unavailable', 'Push is not configured on this server.', 503)
    from push_send import send_to_user
    sent, failed = send_to_user(get_db(), user['id'],
                                '💧 My GLP Shot', 'Push reminders are working.', '/')
    if not sent:
        return err('no_devices', 'No push device registered, or delivery failed.', 400)
    return jsonify(ok=True, sent=sent, failed=failed)


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
    if not LITELLM_API_KEY:
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
            'model': 'gemini-2.5-flash',
            'messages': [{'role': 'user', 'content': IMPORT_PROMPT + chunk}],
            'temperature': 0.0,
            'max_tokens': 32768,
            'response_format': {'type': 'json_object'},
        }
        try:
            # The key goes in a header, not the query string: URLs end up in
            # nginx access logs, proxy logs and error traces.
            r = _r.post(
                f'{LITELLM_BASE_URL}/v1/chat/completions',
                headers={'Authorization': f'Bearer {LITELLM_API_KEY}',
                         'Content-Type': 'application/json'},
                json=body, timeout=150,
            )
        except Exception as e:
            app.logger.exception('LLM call failed (chunk %d/%d): %s', idx + 1, len(chunks), e)
            return err('llm_error', f'AI parser timed out on chunk {idx + 1}/{len(chunks)}. Try a smaller file.', 502)
        if r.status_code != 200:
            app.logger.warning('LLM %s (chunk %d/%d): %s', r.status_code, idx + 1, len(chunks), r.text[:300])
            return err('llm_error', f'AI parser returned {r.status_code} on chunk {idx + 1}/{len(chunks)}.', 502)
        try:
            out = r.json()
            raw = out['choices'][0]['message']['content']
            parsed = json.loads(raw)
        except (KeyError, IndexError, ValueError, TypeError) as e:
            app.logger.warning('LLM malformed (chunk %d/%d): %s — %s', idx + 1, len(chunks), e, r.text[:300])
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
    with closing(sqlite3.connect(DB_PATH, timeout=10.0)) as c:
        # journal_mode=WAL is persistent in the database file, so setting it here
        # applies to every later connection too.
        c.execute('PRAGMA journal_mode=WAL')
        c.execute('PRAGMA busy_timeout=10000')
        c.executescript(SCHEMA)
        # Idempotent column adds for older DBs (tolerates concurrent worker init).
        for stmt in (
            'ALTER TABLE users ADD COLUMN stripe_subscription_id TEXT',
            'ALTER TABLE users ADD COLUMN stripe_customer_id_test TEXT',
            'ALTER TABLE users ADD COLUMN stripe_subscription_id_test TEXT',
            'ALTER TABLE users ADD COLUMN test_subscription_status TEXT',
            'ALTER TABLE users ADD COLUMN test_premium_until INTEGER',
            'ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0',
        ):
            try:
                c.execute(stmt)
            except sqlite3.OperationalError:
                pass
        c.commit()
        # Sweep expired rows at boot so retention doesn't depend on anyone
        # remembering to hit the admin endpoint.
        try:
            _configure_connection(c)
            purge_expired(c)
        except Exception as e:  # never block startup on housekeeping
            print(f'[init_db] purge skipped: {e}')


init_db()


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8080, debug=False)
