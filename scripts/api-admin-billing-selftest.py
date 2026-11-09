#!/usr/bin/env python3
"""Offline check: admin grant-lifetime, extend-trial and demote-to-free refuse
(409) while a user has a live Stripe subscription, and still work without one.

Imports api/app.py against a temp SQLite DB with a stub `stripe` module that
fails on any use, so nothing touches the network. Needs api/requirements.txt:
  python3 -m venv /tmp/v && /tmp/v/bin/pip install -q -r api/requirements.txt
  /tmp/v/bin/python scripts/api-admin-billing-selftest.py
"""
import os
import sys
import tempfile
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP = tempfile.mkdtemp(prefix='mgs-admin-billing-')
os.environ.update({
    'MGS_DB': os.path.join(TMP, 'api.db'),
    'MGS_ADMIN_TOKEN': 'selftest-admin-token',
    'STRIPE_API_KEY': '', 'STRIPE_API_KEY_TEST': '',
    'RESEND_API_KEY': '', 'OPENROUTER_API_KEY': '', 'MATTERMOST_WEBHOOK_URL': '',
})


class _NoStripe(types.ModuleType):
    def __getattr__(self, name):
        raise AssertionError(f'stripe.{name} used in an offline test')


sys.modules['stripe'] = _NoStripe('stripe')
sys.path.insert(0, os.path.join(ROOT, 'api'))
import app as api  # noqa: E402

client = api.app.test_client()
HDR = {'Authorization': 'Bearer selftest-admin-token', 'Content-Type': 'application/json'}
ACTIONS = {
    'grant-lifetime': 'lifetime',
    'extend-trial': 'trial',
    'demote-to-free': 'free',
}
# (label, columns) for users that must be refused, and that must be allowed.
LIVE = [
    ('live premium', {'subscription_status': 'premium', 'stripe_subscription_id': 'sub_live'}),
    ('live trialing', {'subscription_status': 'trial', 'stripe_subscription_id': 'sub_live'}),
    ('test premium', {'test_subscription_status': 'premium', 'stripe_subscription_id_test': 'sub_test'}),
]
NOT_LIVE = [
    ('no subscription', {'subscription_status': 'trial'}),
    ('canceled test sub', {'subscription_status': 'free', 'test_subscription_status': 'free',
                           'stripe_subscription_id_test': 'sub_test_old'}),
]
fails = []
n = 0


def make_user(cols):
    global n
    n += 1
    with api.app.app_context():
        db = api.get_db()
        cur = db.execute(
            'INSERT INTO users (email, password_hash, created_at, subscription_status) VALUES (?,?,?,?)',
            (f'u{n}@example.test', 'x', api.now_ts(), 'trial'))
        uid = cur.lastrowid
        for k, v in cols.items():
            db.execute(f'UPDATE users SET {k} = ? WHERE id = ?', (v, uid))
        db.commit()
    return uid


def status_of(uid):
    with api.app.app_context():
        return api.get_db().execute('SELECT subscription_status FROM users WHERE id = ?', (uid,)).fetchone()[0]


def check(ok, msg):
    print(('ok   ' if ok else 'FAIL ') + msg)
    if not ok:
        fails.append(msg)


for action, target in ACTIONS.items():
    for label, cols in LIVE:
        uid = make_user(cols)
        before = status_of(uid)
        r = client.post(f'/api/admin/users/{uid}/{action}', headers=HDR, json={'days': 30})
        body = r.get_json() or {}
        check(r.status_code == 409 and 'Stripe' in (body.get('message') or ''),
              f'{action} refused for {label} (got {r.status_code} {body})')
        check(status_of(uid) == before, f'{action} left {label} status untouched')
    for label, cols in NOT_LIVE:
        uid = make_user(cols)
        r = client.post(f'/api/admin/users/{uid}/{action}', headers=HDR, json={'days': 30})
        check(r.status_code == 200, f'{action} allowed for {label} (got {r.status_code})')
        check(status_of(uid) == target, f'{action} set {label} to {target}')

print(f'\n{len(fails)} failure(s)' if fails else '\nall passed')
sys.exit(1 if fails else 0)
