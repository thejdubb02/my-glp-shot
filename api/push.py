"""Web Push reminder routes."""
from flask import jsonify, request

from config import VAPID_PRIVATE_KEY, VAPID_PUBLIC_KEY, app
from db import get_db, now_ts
from helpers import err, require_user


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
    # Reminders are queued per account, not per device, so only drop them once no
    # device is left to receive them. Deleting them on every unsubscribe meant
    # turning notifications off on a laptop silently stopped the phone's too.
    left = db.execute('SELECT COUNT(*) FROM push_subscriptions WHERE user_id = ?', (user['id'],)).fetchone()[0]
    if not left:
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
