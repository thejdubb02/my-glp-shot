#!/usr/bin/env python3
"""Verify the Web Push pipeline without a real browser subscription.

Browser delivery itself needs a user to grant notification permission, which
cannot be automated. Everything up to the handoff to the push service can be,
and that is where the bugs live: allow-listing, replace-not-append scheduling,
claim-once dispatch, and pruning of dead endpoints.

Run inside the API container against a throwaway DB:

    docker exec my-glp-shot-api python push-selftest.py
"""
import os
import sqlite3
import sys
import tempfile
import time
from unittest import mock

PASS, FAIL = [], []


def check(name, cond, detail=''):
    (PASS if cond else FAIL).append(name)
    print(f'{"PASS" if cond else "FAIL"}  {name}' + (f'  — {detail}' if detail and not cond else ''))


def main():
    tmp = tempfile.mkdtemp()
    db_path = os.path.join(tmp, 'push-test.db')
    os.environ['MGS_DB'] = db_path
    os.environ['VAPID_PUBLIC_KEY'] = 'test-public'
    os.environ['VAPID_PRIVATE_KEY'] = 'test-private'
    os.environ.setdefault('APP_BASE_URL', 'https://app.myglpshot.com')

    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    sys.path.insert(0, '/app')
    import app as mgs

    client = mgs.app.test_client()
    now = int(time.time())

    # --- an account with a session ---------------------------------------
    r = client.post('/api/signup', json={'email': 'push@example.com', 'authToken': 'a' * 64})
    check('signup for push test', r.status_code == 200, str(r.data[:120]))
    token = r.get_json()['token']
    hdr = {'Authorization': f'Bearer {token}'}

    # --- VAPID key is public ---------------------------------------------
    r = client.get('/api/push/key')
    check('vapid public key served', r.status_code == 200 and r.get_json()['publicKey'] == 'test-public')

    # --- subscribe --------------------------------------------------------
    sub = {'endpoint': 'https://push.example.com/abc123', 'keys': {'p256dh': 'k' * 87, 'auth': 'a' * 22}}
    r = client.post('/api/push/subscribe', json=sub, headers=hdr)
    check('subscribe accepted', r.status_code == 200, str(r.data[:120]))
    r = client.post('/api/push/subscribe', json={'endpoint': 'http://insecure', 'keys': {'p256dh': 'x', 'auth': 'y'}}, headers=hdr)
    check('non-https endpoint refused', r.status_code == 400)
    # A fresh client: the main one holds the session cookie set at signup, so
    # reusing it here would prove nothing.
    anon = mgs.app.test_client()
    r = anon.post('/api/push/subscribe', json=sub)
    check('subscribe requires auth', r.status_code == 401, f'{r.status_code}')
    r = anon.put('/api/push/schedule', json={'reminders': []})
    check('schedule requires auth', r.status_code == 401, f'{r.status_code}')
    r = anon.get('/api/push/status')
    check('status requires auth', r.status_code == 401, f'{r.status_code}')

    # Re-subscribing with the same endpoint must update, not duplicate.
    client.post('/api/push/subscribe', json=sub, headers=hdr)
    con = sqlite3.connect(db_path)
    n = con.execute('SELECT COUNT(*) FROM push_subscriptions').fetchone()[0]
    check('re-subscribe does not duplicate the device', n == 1, f'rows={n}')

    # --- scheduling -------------------------------------------------------
    r = client.put('/api/push/schedule', json={'reminders': [
        {'kind': 'shot', 'fireAt': now + 600},
        {'kind': 'daily:weight', 'fireAt': now + 700},
    ]}, headers=hdr)
    check('schedule accepted', r.status_code == 200 and r.get_json()['queued'] == 2, str(r.data[:150]))

    # Unknown kinds have no server-side copy, so they must be dropped.
    r = client.put('/api/push/schedule', json={'reminders': [
        {'kind': 'shot', 'fireAt': now + 600},
        {'kind': 'daily:secret-medication-name', 'fireAt': now + 800},
        {'kind': '<script>alert(1)</script>', 'fireAt': now + 900},
    ]}, headers=hdr)
    check('unknown reminder kinds are dropped', r.get_json()['queued'] == 1, str(r.data[:150]))

    # Replace, not append.
    total = con.execute('SELECT COUNT(*) FROM push_reminders WHERE sent_at IS NULL').fetchone()[0]
    check('schedule replaces rather than appends', total == 1, f'rows={total}')

    # Past and far-future times are refused.
    r = client.put('/api/push/schedule', json={'reminders': [
        {'kind': 'shot', 'fireAt': now - 100},
        {'kind': 'shot', 'fireAt': now + 400 * 86400},
        {'kind': 'shot', 'fireAt': now + 300},
    ]}, headers=hdr)
    check('past and out-of-horizon times refused', r.get_json()['queued'] == 1, str(r.data[:150]))

    r = client.put('/api/push/schedule', json={'reminders': [{'kind': 'shot', 'fireAt': now + i} for i in range(100)]}, headers=hdr)
    check('oversized schedule refused', r.status_code == 400, f'{r.status_code}')

    # Body text must come from the server's list, never from the client.
    client.put('/api/push/schedule', json={'reminders': [{'kind': 'shot', 'fireAt': now + 300, 'title': 'Tirzepatide 7.5mg', 'body': 'leak'}]}, headers=hdr)
    row = con.execute('SELECT title, body FROM push_reminders WHERE sent_at IS NULL').fetchone()
    check('client cannot set notification text', row and 'Tirzepatide' not in row[0] and row[1] != 'leak', str(row))

    # --- status -----------------------------------------------------------
    r = client.get('/api/push/status', headers=hdr)
    j = r.get_json()
    check('status reports device + queue', j['devices'] == 1 and j['queued'] == 1, str(j))

    # --- dispatch ---------------------------------------------------------
    con.execute('UPDATE push_reminders SET fire_at = ? WHERE sent_at IS NULL', (now - 5,))
    con.commit()

    sent_calls = []
    import push_send

    def fake_webpush(**kw):
        sent_calls.append(kw)
        return True

    with mock.patch.object(push_send, 'webpush', fake_webpush):
        import push_dispatch
        push_dispatch.main()
    check('dispatcher delivered the due reminder', len(sent_calls) == 1, f'calls={len(sent_calls)}')

    # Running again must not re-send: the claim is a conditional UPDATE.
    with mock.patch.object(push_send, 'webpush', fake_webpush):
        push_dispatch.main()
    check('second dispatch does not re-send', len(sent_calls) == 1, f'calls={len(sent_calls)}')

    # --- dead endpoint pruning -------------------------------------------
    con.execute('UPDATE push_reminders SET sent_at = NULL, fire_at = ?', (now - 5,))
    con.commit()

    class Resp:
        status_code = 410

    def gone_webpush(**kw):
        raise push_send.WebPushException('gone', response=Resp())

    with mock.patch.object(push_send, 'webpush', gone_webpush):
        push_dispatch.main()
    left = con.execute('SELECT COUNT(*) FROM push_subscriptions').fetchone()[0]
    check('410 from push service prunes the dead device', left == 0, f'rows={left}')

    # --- unsubscribe clears the queue ------------------------------------
    client.post('/api/push/subscribe', json=sub, headers=hdr)
    client.put('/api/push/schedule', json={'reminders': [{'kind': 'shot', 'fireAt': now + 900}]}, headers=hdr)
    client.post('/api/push/unsubscribe', json={}, headers=hdr)
    subs = con.execute('SELECT COUNT(*) FROM push_subscriptions').fetchone()[0]
    queued = con.execute('SELECT COUNT(*) FROM push_reminders WHERE sent_at IS NULL').fetchone()[0]
    check('unsubscribe drops device and queued reminders', subs == 0 and queued == 0, f'subs={subs} queued={queued}')

    con.close()
    print(f'\n{len(PASS)} passed, {len(FAIL)} failed')
    if FAIL:
        print('FAILED: ' + ', '.join(FAIL))
    return 1 if FAIL else 0


if __name__ == '__main__':
    sys.exit(main())
