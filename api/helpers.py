"""Shared request, user, attempt-throttle, email and Herald helpers, plus retention."""
from flask import jsonify, request

from config import HERALD_URL, MAIL_FROM, NATIVE_APP_ORIGINS, RESEND_API_KEY, SESSION_TOUCH_INTERVAL, TOKEN_RE, app
from db import get_db, now_ts


# ---------- Helpers ----------
def err(code, message, status=400):
    return jsonify(error=code, message=message), status


STRIPE_WEBHOOK_PATHS = ('/api/stripe/webhook', '/api/stripe/webhook/test')


def is_native_origin():
    return request.headers.get('Origin') in NATIVE_APP_ORIGINS


def _supports_native_cors():
    return request.path.startswith('/api/') and request.path not in STRIPE_WEBHOOK_PATHS


@app.before_request
def _native_preflight():
    if request.method == 'OPTIONS' and _supports_native_cors() and is_native_origin():
        return '', 204
    return None


@app.after_request
def _native_cors(response):
    if _supports_native_cors():
        response.vary.add('Origin')
        if is_native_origin():
            response.headers['Access-Control-Allow-Origin'] = request.headers['Origin']
            if request.method == 'OPTIONS':
                response.headers['Access-Control-Allow-Methods'] = 'GET, HEAD, POST, PUT, DELETE, OPTIONS'
                response.headers['Access-Control-Allow-Headers'] = 'Authorization, Content-Type, Accept'
    return response


@app.before_request
def _enforce_json_for_mutations():
    """CSRF mitigation: state-changing endpoints must use application/json.
    Cross-origin form posts cannot send JSON. CORS permits JSON preflights only
    for native origins, whose sessions require an explicit Bearer token.
    Stripe webhooks are exempt because their signatures are verified.
    """
    if request.method not in ('POST', 'PUT', 'DELETE', 'PATCH'):
        return None
    p = request.path or ''
    # Stripe webhook signs its body; no need to gate on content-type.
    if p in STRIPE_WEBHOOK_PATHS:
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


# RFC 2606 / RFC 6761 reserve these for documentation and testing, so no real
# person can ever receive mail at one. Our own self-tests sign up under
# @example.com, and every run was posting a "new signup" line to the team chat
# and incrementing the signup counter — noise that looks like traction and
# quietly corrupts the only number we watch.
RESERVED_EMAIL_DOMAINS = ('example.com', 'example.org', 'example.net',
                          'example.edu', 'test', 'invalid', 'localhost')


def is_test_email(email):
    """True for addresses that cannot belong to a real user."""
    domain = (email or '').rsplit('@', 1)[-1].strip().lower()
    if not domain:
        return False
    return domain in RESERVED_EMAIL_DOMAINS or domain.endswith('.test') or domain.endswith('.invalid')


# SQL form of the same rule, for the places that count users rather than inspect
# one. Appended to a WHERE clause. Kept next to is_test_email so the two cannot
# drift — a metric that disagrees with the notification is worse than either.
NOT_TEST_SQL = (
    ' AND ' + ' AND '.join(f"email NOT LIKE '%@{d}'" for d in RESERVED_EMAIL_DOMAINS)
    + " AND email NOT LIKE '%.test' AND email NOT LIKE '%.invalid'"
)
# Same rule for subqueries that filter by user_id rather than by email.
REAL_USER_IDS_SQL = f'SELECT id FROM users WHERE COALESCE(is_admin, 0) = 0{NOT_TEST_SQL}'


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
        # Subscribing during the trial does NOT end the trial — the account stays
        # 'trial' until the days already paid for run out. Without this flag the app
        # cannot tell that apart from a trial nobody has paid for, and goes on asking
        # a paying customer to subscribe.
        'hasSubscription': bool(user_row['stripe_subscription_id']),
        # Still running, but cancelled and will not renew.
        'cancelAtPeriodEnd': bool(user_row['stripe_subscription_id']) and bool(_safe_col(user_row, 'cancel_at_period_end')),
        'isAdmin': bool(_safe_col(user_row, 'is_admin')),
    }


def _safe_col(row, name, default=0):
    """sqlite3.Row throws on missing column on older DBs pre-migration."""
    try:
        return row[name]
    except (IndexError, KeyError):
        return default


def get_session_user():
    """Read a web session cookie or an Authorization: Bearer header."""
    token = None if is_native_origin() else request.cookies.get('mgs_session')
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


def notify_herald(tag, title, body):
    """Best-effort operator ping through Herald. No-op if HERALD_URL is empty.

    Fired on a daemon thread: a slow or down Herald must never add latency to
    a signup, and must never fail one. Nothing here is retried: a missed
    notification is a missed notification, not a reason to hold up a user.
    """
    if not HERALD_URL:
        return False

    def _post():
        try:
            import requests as _r
            r = _r.post(HERALD_URL, data={'tag': tag, 'title': title, 'body': body}, timeout=6)
            if r.status_code >= 300:
                app.logger.warning('herald notify failed: HTTP %s', r.status_code)
        except Exception as e:
            app.logger.warning('herald notify failed: %s', e)

    try:
        import threading
        threading.Thread(target=_post, daemon=True).start()
        return True
    except Exception as e:
        app.logger.warning('herald notify could not start: %s', e)
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
