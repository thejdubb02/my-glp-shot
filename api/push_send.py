"""Web Push delivery for My GLP Shot.

Split out from app.py so the dispatcher (push_dispatch.py, run from cron) can
send without importing the whole Flask app and its request context.

The payload a device receives contains only a title, a body and a path — all
chosen from the fixed allow-list in app.py. Nothing about the medication, the
dose or the user's history is ever sent, which is what makes server-scheduled
reminders compatible with the end-to-end-encrypted store.
"""
import json
import logging
import os

from pywebpush import WebPushException, webpush

log = logging.getLogger(__name__)

VAPID_PRIVATE_KEY = os.environ.get('VAPID_PRIVATE_KEY', '')
VAPID_SUBJECT = os.environ.get('VAPID_SUBJECT', 'mailto:hello@myglpshot.com')
MAX_FAILURES = 5


def _send_one(sub_row, title, body, url):
    """Push to a single subscription. Returns (ok, gone).

    `gone` means the endpoint is permanently dead — 404/410 is how a push
    service reports that the user uninstalled the app or cleared site data — so
    the caller can delete the row instead of retrying it forever.
    """
    subscription = {
        'endpoint': sub_row['endpoint'],
        'keys': {'p256dh': sub_row['p256dh'], 'auth': sub_row['auth']},
    }
    try:
        webpush(
            subscription_info=subscription,
            data=json.dumps({'title': title, 'body': body, 'url': url}),
            vapid_private_key=VAPID_PRIVATE_KEY,
            vapid_claims={'sub': VAPID_SUBJECT},
            timeout=10,
        )
        return True, False
    except WebPushException as e:
        status = getattr(getattr(e, 'response', None), 'status_code', None)
        if status in (404, 410):
            return False, True
        log.warning('push failed (status=%s): %s', status, e)
        return False, False
    except Exception as e:
        log.warning('push error: %s', e)
        return False, False


def send_to_user(db, user_id, title, body, url='/'):
    """Push to every device registered to one account. Returns (sent, failed)."""
    subs = db.execute(
        'SELECT * FROM push_subscriptions WHERE user_id = ?', (user_id,)
    ).fetchall()
    sent = failed = 0
    for s in subs:
        ok, gone = _send_one(s, title, body, url)
        if ok:
            sent += 1
            db.execute(
                'UPDATE push_subscriptions SET last_ok_at = strftime("%s","now"), fail_count = 0 WHERE id = ?',
                (s['id'],),
            )
            continue
        failed += 1
        if gone:
            db.execute('DELETE FROM push_subscriptions WHERE id = ?', (s['id'],))
        else:
            db.execute('UPDATE push_subscriptions SET fail_count = fail_count + 1 WHERE id = ?', (s['id'],))
            db.execute('DELETE FROM push_subscriptions WHERE id = ? AND fail_count >= ?', (s['id'], MAX_FAILURES))
    db.commit()
    return sent, failed
