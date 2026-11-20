"""Signup, login, sessions, account email change, password reset, account delete."""
import re
import secrets
import sqlite3
from datetime import datetime, timezone
from urllib.parse import urlparse

import bcrypt
import stripe
from flask import jsonify, make_response, request

from config import (
    APP_BASE_URL, EMAIL_RE, MAX_BLOB_BYTES, MGS_APP_NAME, MGS_EMOJI, SESSION_DAYS, STRIPE_API_KEY,
    STRIPE_API_KEY_TEST, TOKEN_RE, TRIAL_DAYS, app,
)
from db import get_db, now_ts
from helpers import (
    FORGOT_MAX, FORGOT_WINDOW, LOGIN_MAX_FAILURES, LOGIN_WINDOW, NOT_TEST_SQL, _record_attempt,
    _safe_col, _too_many_attempts, err, get_session_user, is_test_email, normalize_email,
    notify_herald, public_user, require_user, send_email,
)
from billing import _stripe_ready


# ---------- Auth ----------
ATTRIB_MAX = 120
_ATTRIB_SAFE = re.compile(r'[^A-Za-z0-9 ._\-/:+%&=?~]')


def _clean_attribution(raw):
    """Normalise client-supplied signup attribution.

    Deliberately stores the referrer HOST, not the full referring URL. A search
    referrer carries the query in its path, so keeping the URL would silently
    record what someone typed into Google about their weight or medication. The
    host is what attribution actually needs, and it can't leak that.

    Everything is length-capped and character-filtered because this is untrusted
    input that later renders in the admin panel.
    """
    out = {k: None for k in ('referrer', 'landing', 'utm_source', 'utm_medium', 'utm_campaign')}
    if not isinstance(raw, dict):
        return out

    def clean(v, limit=ATTRIB_MAX):
        if not isinstance(v, str):
            return None
        v = _ATTRIB_SAFE.sub('', v.strip())[:limit]
        return v or None

    ref = clean(raw.get('referrer'))
    if ref:
        # Accept either a bare host or a URL; keep only the host either way.
        try:
            parsed = urlparse(ref if '//' in ref else f'//{ref}')
            ref = (parsed.hostname or ref).lower()
        except ValueError:
            ref = ref.lower()
        if ref.startswith('www.'):
            ref = ref[4:]
    out['referrer'] = clean(ref, 80)

    landing = raw.get('landing')
    if isinstance(landing, str):
        # Split BEFORE the character filter: '#' is not in the safe set, so
        # filtering first turned '/x#frag' into '/xfrag' — gluing the fragment
        # onto the path instead of dropping it.
        landing = landing.strip().split('?', 1)[0].split('#', 1)[0]
        landing = clean(landing, 80)
        if landing and not landing.startswith('/'):
            landing = '/' + landing
        out['landing'] = landing or None

    for key in ('utm_source', 'utm_medium', 'utm_campaign'):
        out[key] = clean(raw.get(key), 60)
    return out


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
    is_admin = 0
    attrib = _clean_attribution(data.get('attribution'))
    try:
        cur = db.execute(
            """INSERT INTO users (email, password_hash, created_at, subscription_status, trial_ends_at, is_admin,
                                  signup_referrer, signup_landing,
                                  signup_utm_source, signup_utm_medium, signup_utm_campaign)
               VALUES (?, ?, ?, 'trial', ?, ?, ?, ?, ?, ?, ?)""",
            (email, pw_hash, now_ts(), trial_ends, is_admin,
             attrib['referrer'], attrib['landing'],
             attrib['utm_source'], attrib['utm_medium'], attrib['utm_campaign']),
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
        # Shares the #app-signups channel with Daily Deck, so the shape matches
        # its lines and the leading emoji + app name is what tells them apart.
        # Admin accounts are excluded from both counts, same as /api/admin/metrics.
        midnight = int(datetime.now(timezone.utc).replace(
            hour=0, minute=0, second=0, microsecond=0).timestamp())
        # Reserved-domain addresses are self-test accounts; they are excluded
        # from the counts for the same reason admin accounts are — the number is
        # meant to answer "how many real people signed up", and a test run must
        # not move it.
        today = db.execute(
            'SELECT COUNT(*) AS c FROM users WHERE created_at >= ? AND COALESCE(is_admin, 0) = 0' + NOT_TEST_SQL,
            (midnight,),
        ).fetchone()['c']
        total = db.execute(
            'SELECT COUNT(*) AS c FROM users WHERE COALESCE(is_admin, 0) = 0' + NOT_TEST_SQL
        ).fetchone()['c']
        if not is_admin and not is_test_email(email):
            notify_herald(
                'signup',
                f"{MGS_EMOJI} {MGS_APP_NAME}: new signup",
                f"{email}\n{today} today, {total} total",
            )
    except Exception as e:
        # A notification problem is never a reason to fail a signup.
        app.logger.warning('signup notify failed: %s', e)

    sess_token = _create_session(user_id, pw_hash)
    if not sess_token:
        return err('invalid_credentials', 'Email or password incorrect.', 401)
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

    sess_token = _create_session(user['id'], pw_hash)
    if not sess_token:
        return err('invalid_credentials', 'Email or password incorrect.', 401)
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
    if not _delete_user_everywhere(user):
        return err('stripe_cancel_failed',
                   'We could not cancel your subscription with our payment provider, '
                   'so your account was not deleted. Please try again in a few minutes.', 502)
    resp = make_response(jsonify(deleted=True))
    resp.set_cookie('mgs_session', '', expires=0, path='/', secure=True, samesite='Lax')
    return resp


def _stripe_sub_already_gone(e):
    """A cancel that fails because the sub is already canceled or unknown is fine."""
    # Only Stripe's "bad request" class: a network or auth error must never
    # count as gone, whatever its message says.
    if not isinstance(e, stripe.InvalidRequestError):
        return False
    msg = str(getattr(e, 'user_message', None) or e).lower()
    return getattr(e, 'code', None) == 'resource_missing' or 'canceled subscription' in msg


def _delete_user_everywhere(user):
    """Cancel the user's live and test Stripe subscriptions, then delete every
    row keyed on them. If a cancel fails, delete nothing and return False: a
    deleted user with a live sub keeps being charged and its webhooks find no
    row. Test subs matter too, they keep firing webhooks at a missing user."""
    subs = []
    live_sub = user['stripe_subscription_id']
    # Cancelling needs only the API key. _stripe_ready() also wants both price ids,
    # so a missing price setting used to skip the cancel and delete a paying user (#29).
    if live_sub and not STRIPE_API_KEY:
        app.logger.warning('User %s has sub %s but no STRIPE_API_KEY, not deleted', user['id'], live_sub)
        return False
    if live_sub:
        subs.append((live_sub, STRIPE_API_KEY))
    # Two checkouts completed close together leave a second live sub that only
    # Stripe knows about (#27). Cancel everything still live on the customer.
    if STRIPE_API_KEY and user['stripe_customer_id']:
        try:
            listed = stripe.Subscription.list(customer=user['stripe_customer_id'], status='all',
                                              limit=100, api_key=STRIPE_API_KEY)
        except stripe.StripeError as e:
            app.logger.warning('Stripe sub list failed, user %s not deleted: %s', user['id'], e)
            return False
        for s in listed.data:
            if s['status'] not in ('canceled', 'incomplete_expired') and s['id'] != live_sub:
                subs.append((s['id'], STRIPE_API_KEY))
    if STRIPE_API_KEY_TEST and _safe_col(user, 'stripe_subscription_id_test', None):
        subs.append((user['stripe_subscription_id_test'], STRIPE_API_KEY_TEST))
    for sub_id, key in subs:
        try:
            stripe.Subscription.delete(sub_id, api_key=key)
        except stripe.StripeError as e:
            if _stripe_sub_already_gone(e):
                continue
            app.logger.warning('Stripe sub cancel failed, user %s not deleted: %s', user['id'], e)
            return False
    db = get_db()
    uid = user['id']
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
    return True


@app.route('/api/me/email', methods=['POST'])
def change_email():
    """Change the account email — which, in this design, also rotates the
    encryption key.

    The email is not just a label. It is the PBKDF2 salt:

        salt      = SHA-256("myglpshot-v1:" + email)
        bits      = PBKDF2(password, salt, 600k) -> 512
        aes_key   = bits[0:256]   (never leaves the browser)
        authToken = bits[256:512] (sent here, stored bcrypted)

    So changing the email necessarily changes BOTH the auth token and the key
    that the cloud blob is encrypted under. The client therefore has to send a
    blob it has already re-encrypted with the new key, and the swap has to be
    atomic: an email that changes without its blob leaves a user holding a key
    that cannot decrypt their own ciphertext, which is indistinguishable from
    data loss.

    Requires the current auth token as well as a session, because a session
    alone is a device that was left signed in, and this is an identity change.
    """
    user = require_user()
    if not user:
        return err('unauthorized', 'Not signed in.', 401)

    data = request.get_json(silent=True) or {}
    current_auth_token = data.get('currentAuthToken') or ''
    new_email = normalize_email(data.get('newEmail'))
    new_auth_token = data.get('newAuthToken') or ''
    iv = data.get('iv') or ''
    ct = data.get('ciphertext') or ''

    old_email = user['email']

    # Throttled on the CURRENT address: this verifies a password, so it is a
    # guessing oracle if left open.
    if _too_many_attempts('change_email', old_email, LOGIN_WINDOW, LOGIN_MAX_FAILURES):
        return err('too_many_attempts', 'Too many attempts. Try again later.', 429)

    if not EMAIL_RE.match(new_email):
        return err('invalid_email', 'Please enter a valid email.')
    if not new_auth_token or not current_auth_token:
        return err('invalid_payload', 'Missing credentials.')
    if new_email == old_email:
        return err('same_email', 'That is already your email address.')

    # Re-authenticate against the stored hash.
    ok = False
    try:
        ok = bcrypt.checkpw(current_auth_token.encode('utf-8'), user['password_hash'].encode('utf-8'))
    except Exception:
        ok = False
    if not ok:
        _record_attempt('change_email', old_email, ok=False)
        return err('invalid_credentials', 'Password incorrect.', 401)

    db = get_db()
    if db.execute('SELECT id FROM users WHERE email = ?', (new_email,)).fetchone():
        return err('email_in_use', 'An account with this email already exists.', 409)

    # If there is a stored blob, a re-encrypted replacement is mandatory —
    # see the docstring. Refusing here is what prevents the lockout.
    has_blob = db.execute('SELECT user_id FROM sync_blobs WHERE user_id = ?', (user['id'],)).fetchone() is not None
    if has_blob and not (iv and ct):
        return err('reencrypted_blob_required',
                   'Your cloud backup must be re-encrypted before the address can change.')
    if ct and len(ct) > MAX_BLOB_BYTES:
        return err('blob_too_large', f'Max {MAX_BLOB_BYTES} bytes.', 413)

    new_hash = bcrypt.hashpw(new_auth_token.encode('utf-8'), bcrypt.gensalt(rounds=12)).decode()
    _, current_sess = get_session_user()
    keep_token = current_sess['token'] if current_sess else None

    try:
        with db:  # one transaction — commits together or rolls back together
            db.execute(
                'UPDATE users SET email = ?, password_hash = ?, email_verified_at = NULL WHERE id = ?',
                (new_email, new_hash, user['id']),
            )
            if iv and ct:
                db.execute(
                    """INSERT INTO sync_blobs (user_id, iv, ciphertext, updated_at, size)
                       VALUES (?, ?, ?, ?, ?)
                       ON CONFLICT(user_id) DO UPDATE SET iv=excluded.iv,
                         ciphertext=excluded.ciphertext, updated_at=excluded.updated_at,
                         size=excluded.size""",
                    (user['id'], iv, ct, now_ts(), len(ct)),
                )
            # Other devices hold a key derived from the OLD address; they can no
            # longer read the blob and must sign in again to re-derive it.
            if keep_token:
                db.execute('DELETE FROM sessions WHERE user_id = ? AND token != ?', (user['id'], keep_token))
            else:
                db.execute('DELETE FROM sessions WHERE user_id = ?', (user['id'],))
            # Reset links were issued against the old identity.
            db.execute('DELETE FROM password_resets WHERE user_id = ?', (user['id'],))
            # Throttle counters follow the address.
            db.execute('DELETE FROM auth_attempts WHERE identifier = ?', (old_email,))
    except sqlite3.IntegrityError:
        # UNIQUE(email) lost a race with a concurrent signup.
        return err('email_in_use', 'An account with this email already exists.', 409)

    # Billing follows the account. Best-effort: a Stripe hiccup must not undo a
    # change that has already been committed above.
    if _stripe_ready() and user['stripe_customer_id']:
        try:
            stripe.Customer.modify(user['stripe_customer_id'], email=new_email, api_key=STRIPE_API_KEY)
        except stripe.StripeError as e:
            app.logger.warning('Stripe customer email update failed for user %s: %s', user['id'], e)

    # Tell BOTH addresses. The old one is the only warning a user gets if
    # someone else changed it.
    send_email(
        old_email,
        f'{MGS_APP_NAME}: your email address was changed',
        f'<p>The address on your {MGS_APP_NAME} account was changed to <strong>{new_email}</strong>.</p>'
        f'<p>If this was not you, reply to this message immediately.</p>',
    )
    send_email(
        new_email,
        f'{MGS_APP_NAME}: this is now your account email',
        f'<p>Your {MGS_APP_NAME} account email was changed from {old_email} to this address.</p>'
        f'<p>Sign in with this address and your existing password from now on.</p>',
    )
    app.logger.info('email changed for user %s', user['id'])

    fresh = db.execute('SELECT * FROM users WHERE id = ?', (user['id'],)).fetchone()
    return jsonify(user=public_user(fresh), changed=True)


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


def _create_session(user_id, pw_hash):
    """Insert a session only if the account still has the hash the caller
    verified, in one statement: a password reset that lands between the check
    and here must not leave a session behind. Returns None when it did."""
    token = secrets.token_hex(32)
    expires = now_ts() + SESSION_DAYS * 86400
    ua = request.headers.get('User-Agent', '')[:500]
    db = get_db()
    cur = db.execute(
        '''INSERT INTO sessions (token, user_id, created_at, expires_at, user_agent, last_seen)
           SELECT ?, ?, ?, ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM users WHERE id = ? AND password_hash = ?)''',
        (token, user_id, now_ts(), expires, ua, now_ts(), user_id, pw_hash),
    )
    db.commit()
    return token if cur.rowcount == 1 else None


def _set_session_cookie(resp, token):
    resp.set_cookie(
        'mgs_session', token,
        max_age=SESSION_DAYS * 86400,
        path='/',
        secure=True,
        httponly=True,
        samesite='Lax',
    )
