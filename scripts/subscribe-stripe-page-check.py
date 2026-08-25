#!/usr/bin/env python3
"""Create ONE live Checkout Session for a throwaway mid-trial account and print its
URL, so the Stripe-hosted page itself can be inspected.

Stripe labels its submit button "Start trial" whenever a subscription opens with a
trial period, and there is no API to change that. Lin read it as a brand new 14-day
trial (2026-08-25). custom_text is the only place we can correct it, and the only way
to know it landed is to look at the rendered page.

Nothing is charged: the session is never completed. Run --cleanup afterwards to expire
the session, delete the Stripe customer and remove the .test account.

    docker exec -i my-glp-shot-api python3 - < scripts/subscribe-stripe-page-check.py
    docker exec -i my-glp-shot-api python3 - --cleanup < scripts/subscribe-stripe-page-check.py
"""
import os
import sys
import json
import time
import sqlite3
import secrets

sys.path.insert(0, '/app')
import app as A  # noqa: E402

STATE = '/tmp/stripe-page-check.json'
DAY = 86400


def db():
    c = sqlite3.connect(os.environ.get('MGS_DB', '/data/api.db'))
    c.row_factory = sqlite3.Row
    return c


if '--cleanup' in sys.argv:
    if not os.path.exists(STATE):
        print('nothing to clean up')
        sys.exit(0)
    st = json.load(open(STATE))
    try:
        A.stripe.checkout.Session.expire(st['session'], api_key=A.STRIPE_API_KEY)
        print('expired session %s' % st['session'])
    except Exception as e:
        print('WARNING expire failed: %s' % e)
    c = db()
    row = c.execute('SELECT stripe_customer_id FROM users WHERE id=?', (st['uid'],)).fetchone()
    cust = row['stripe_customer_id'] if row else None
    c.close()
    if cust:
        try:
            A.stripe.Customer.delete(cust, api_key=A.STRIPE_API_KEY)
            print('deleted customer %s' % cust)
        except Exception as e:
            print('WARNING customer delete failed: %s' % e)
    c = db()
    c.execute('DELETE FROM users WHERE id=?', (st['uid'],))
    for t in ('sessions', 'sync_blobs', 'push_subscriptions', 'audit_log'):
        try:
            c.execute('DELETE FROM %s WHERE user_id=?' % t, (st['uid'],))
        except sqlite3.OperationalError:
            pass
    c.commit()
    left = c.execute('SELECT COUNT(*) c FROM users WHERE id=?', (st['uid'],)).fetchone()['c']
    c.close()
    print('test user removed' if left == 0 else 'WARNING %d rows left' % left)
    os.remove(STATE)
    sys.exit(0)

client = A.app.test_client()
email = 'pagecheck+%d@myglpshot.test' % int(time.time())
r = client.post('/api/signup', json={'email': email, 'authToken': secrets.token_hex(32)})
if r.status_code != 200:
    print('signup failed: %s' % r.get_data(as_text=True)[:200])
    sys.exit(2)
uid = r.get_json()['user']['id']

# Put the account exactly where Lin was: mid-trial, several days left.
trial_end = int(time.time()) + 4 * DAY
c = db()
c.execute("UPDATE users SET subscription_status='trial', trial_ends_at=? WHERE id=?",
          (trial_end, uid))
c.commit()
c.close()

r = client.post('/api/billing/checkout', json={'plan': 'yearly'})
body = r.get_json() or {}
if not body.get('url'):
    print('checkout failed: %s %s' % (r.status_code, str(body)[:200]))
    sys.exit(2)

json.dump({'uid': uid, 'session': body['sessionId']}, open(STATE, 'w'))
print('uid=%s' % uid)
print('session=%s' % body['sessionId'])
print('URL=%s' % body['url'])
