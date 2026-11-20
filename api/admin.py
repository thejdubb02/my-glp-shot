"""Admin routes (bearer-token gated) and the Umami traffic proxy."""
import json
import secrets
import time

from flask import jsonify, request

from config import (
    MGS_ADMIN_TOKEN, TOKEN_RE, UMAMI_PASSWORD, UMAMI_URL, UMAMI_USERNAME, UMAMI_WEBSITE_ID_LANDING,
    UMAMI_WEBSITE_ID_PWA, app,
)
from db import get_db, now_ts
from helpers import NOT_TEST_SQL, REAL_USER_IDS_SQL, err, get_session_user, is_native_origin, is_premium_now
from billing import _stripe_ready, _stripe_test_ready


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
    if not token and not is_native_origin():
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


def _live_subscription_block(u):
    """409 if the user has a live Stripe subscription (live or test mode).
    Admin tier overrides would fight it: the next renewal webhook undoes a
    demote, a lifetime grant leaves it billing, a trial hides a paying user."""
    live = u['stripe_subscription_id'] and (u['subscription_status'] or '') in ('premium', 'trial')
    test = u['stripe_subscription_id_test'] and (u['test_subscription_status'] or '') in ('premium', 'trial')
    if live or test:
        return err('live_subscription',
                   'User has a live Stripe subscription. Cancel it in Stripe first, then retry.', 409)
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
                   u.signup_referrer, u.signup_landing,
                   u.signup_utm_source, u.signup_utm_medium, u.signup_utm_campaign,
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
            'signupReferrer': r['signup_referrer'],
            'signupLanding': r['signup_landing'],
            'signupUtmSource': r['signup_utm_source'],
            'signupUtmMedium': r['signup_utm_medium'],
            'signupUtmCampaign': r['signup_utm_campaign'],
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
        'SELECT token, created_at, expires_at, views FROM share_links WHERE user_id = ? ORDER BY created_at DESC LIMIT 20',
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
    u = db.execute('SELECT * FROM users WHERE id = ?', (user_id,)).fetchone()
    if not u:
        return err('not_found', 'User not found.', 404)
    blocked = _live_subscription_block(u)
    if blocked:
        return blocked
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
    blocked = _live_subscription_block(u)
    if blocked:
        return blocked
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
    rows = db.execute('SELECT subscription_status, premium_until, trial_ends_at FROM users WHERE COALESCE(is_admin, 0) = 0' + NOT_TEST_SQL).fetchall()
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
            'SELECT COUNT(*) AS c FROM users WHERE created_at >= ? AND created_at < ? AND COALESCE(is_admin, 0) = 0' + NOT_TEST_SQL,
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
        f'''SELECT COUNT(*) AS c, COALESCE(SUM(size), 0) AS bytes
           FROM sync_blobs sb
           WHERE sb.user_id IN ({REAL_USER_IDS_SQL})'''
    ).fetchone()
    share_stats = db.execute(
        f'''SELECT COUNT(*) AS active FROM share_links sl
           WHERE sl.expires_at > ?
             AND sl.user_id IN ({REAL_USER_IDS_SQL})''',
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
