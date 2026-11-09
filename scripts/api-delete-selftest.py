#!/usr/bin/env python3
"""Offline test: account delete (self and admin) must never orphan a Stripe sub.

Imports api/app.py against a temp SQLite DB with dummy keys and stubs
stripe.Subscription.delete, so nothing touches the network.

Run with a venv built from api/requirements.txt:
  python3 -m venv /tmp/v && /tmp/v/bin/pip install -q -r api/requirements.txt
  /tmp/v/bin/python scripts/api-delete-selftest.py
"""
import os
import secrets
import sys
import tempfile

tmp = tempfile.mkdtemp(prefix='mgs-delete-test-')
os.environ.update({
    'MGS_DB': os.path.join(tmp, 'api.db'),
    'STRIPE_API_KEY': 'sk_live_dummy',
    'STRIPE_PRICE_MONTHLY': 'price_m_dummy',
    'STRIPE_PRICE_YEARLY': 'price_y_dummy',
    'STRIPE_API_KEY_TEST': 'sk_test_dummy',
    'MGS_ADMIN_TOKEN': 'admin-dummy-token',
    'RESEND_API_KEY': '',
    'OPENROUTER_API_KEY': '',
    'MATTERMOST_WEBHOOK_URL': '',
})
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'api'))

import sqlite3  # noqa: E402
import stripe  # noqa: E402
import app as api  # noqa: E402

calls = []
behaviour = {}  # sub_id -> exception to raise


def fake_delete(sub_id, **kw):
    calls.append((sub_id, kw.get('api_key')))
    if sub_id in behaviour:
        raise behaviour[sub_id]
    return {'id': sub_id, 'status': 'canceled'}


stripe.Subscription.delete = fake_delete
client = api.app.test_client()
ADMIN = {'Authorization': 'Bearer admin-dummy-token'}


def db():
    c = sqlite3.connect(os.environ['MGS_DB'])
    c.row_factory = sqlite3.Row
    return c


def make_user(live_sub=None, test_sub=None):
    email = f'u{secrets.token_hex(4)}@example.com'
    token = secrets.token_hex(32)
    with db() as c:
        uid = c.execute(
            """INSERT INTO users (email, password_hash, created_at, subscription_status,
                                  stripe_subscription_id, stripe_subscription_id_test)
               VALUES (?, 'x', ?, 'premium', ?, ?)""",
            (email, api.now_ts(), live_sub, test_sub)).lastrowid
        c.execute('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
                  (token, uid, api.now_ts(), api.now_ts() + 3600))
    return uid, token


def exists(uid):
    with db() as c:
        return c.execute('SELECT 1 FROM users WHERE id = ?', (uid,)).fetchone() is not None


def self_delete(uid, token):
    return client.delete('/api/me', headers={'Authorization': 'Bearer ' + token})


def admin_delete(uid, token):
    return client.delete(f'/api/admin/users/{uid}', headers=ADMIN)


failures = []


def check(name, cond):
    print(('ok   ' if cond else 'FAIL ') + name)
    if not cond:
        failures.append(name)


for label, do_delete in (('self', self_delete), ('admin', admin_delete)):
    # Cancel succeeds -> live and test subs cancelled with their own keys, user gone.
    calls.clear()
    live, test = f'sub_live_{label}', f'sub_test_{label}'
    uid, tok = make_user(live, test)
    r = do_delete(uid, tok)
    check(f'{label}: cancel ok -> 200', r.status_code == 200)
    check(f'{label}: cancel ok -> user deleted', not exists(uid))
    check(f'{label}: live sub cancelled with live key', (live, 'sk_live_dummy') in calls)
    check(f'{label}: test sub cancelled with test key', (test, 'sk_test_dummy') in calls)

    # Live cancel fails -> 502, user kept.
    bad = f'sub_bad_{label}'
    behaviour[bad] = stripe.APIConnectionError('network down')
    uid, tok = make_user(bad)
    r = do_delete(uid, tok)
    check(f'{label}: cancel error -> 502', r.status_code == 502)
    check(f'{label}: cancel error -> message shown', bool((r.get_json() or {}).get('message')))
    check(f'{label}: cancel error -> user row still there', exists(uid))

    # Test-mode cancel fails -> also refused.
    badt = f'sub_badtest_{label}'
    behaviour[badt] = stripe.APIError('stripe 500')
    uid, tok = make_user(None, badt)
    r = do_delete(uid, tok)
    check(f'{label}: test-sub cancel error -> 502 and user kept', r.status_code == 502 and exists(uid))

    # Already gone / already canceled -> fine, user deleted.
    gone, canceled = f'sub_gone_{label}', f'sub_canceled_{label}'
    behaviour[gone] = stripe.InvalidRequestError(f'No such subscription: {gone}', 'id', code='resource_missing')
    behaviour[canceled] = stripe.InvalidRequestError(
        'A canceled subscription can only update its cancellation_details and metadata.', None)
    uid, tok = make_user(gone, canceled)
    r = do_delete(uid, tok)
    check(f'{label}: already canceled -> 200 and user deleted', r.status_code == 200 and not exists(uid))

print(f'\n{len(failures)} failure(s)')
sys.exit(1 if failures else 0)
