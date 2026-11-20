#!/usr/bin/env python3
"""Offline selftest for the Stripe webhook idempotency record (issue #12).

Imports api/app.py against a temp SQLite DB, stubs the stripe signature check
and Subscription.retrieve (no network), and drives both webhooks with the Flask
test client. Run with a venv built from api/requirements.txt:

    /tmp/v/bin/python scripts/api-webhook-selftest.py
"""
import json
import os
import sys
import tempfile

tmp = tempfile.mkdtemp(prefix='mgs-webhook-')
os.environ.update(
    MGS_DB=os.path.join(tmp, 'api.db'),
    STRIPE_API_KEY='sk_dummy',
    STRIPE_WEBHOOK_SECRET='whsec_dummy',
    STRIPE_API_KEY_TEST='sk_test_dummy',
    STRIPE_WEBHOOK_SECRET_TEST='whsec_test_dummy',
    HERALD_URL='',
)
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'api'))
import app as api  # noqa: E402
from apipatch import patch  # noqa: E402

api.stripe.Webhook.construct_event = lambda payload, *_: json.loads(payload)


class WorkerKilled(BaseException):
    """Stands in for a killed worker: escapes `except Exception` like SIGKILL would."""


calls = []
retrieve_mode = {'value': 'ok'}


def fake_retrieve(sub_id, **_):
    calls.append(sub_id)
    if retrieve_mode['value'] == 'kill':
        raise WorkerKilled()
    if retrieve_mode['value'] == 'raise':
        raise RuntimeError('stripe down')
    return {'id': sub_id, 'customer': 'cus_1', 'status': 'active',
            'current_period_end': 4_000_000_000, 'metadata': {}}


api.stripe.Subscription.retrieve = fake_retrieve
client = api.app.test_client()


def db():
    return api.sqlite3.connect(os.environ['MGS_DB'])


def reset():
    with db() as c:
        c.execute('DELETE FROM stripe_events')
        c.execute('DELETE FROM users')
        c.execute("""INSERT INTO users (id, email, password_hash, created_at, subscription_status,
                     stripe_customer_id, stripe_customer_id_test)
                     VALUES (1, 'a@example.com', 'x', 0, 'free', 'cus_1', 'cus_1')""")
    calls.clear()


def post(path, event):
    try:
        return client.post(path, data=json.dumps(event), headers={'Stripe-Signature': 'stub'})
    except WorkerKilled:
        return None


def event_rows():
    with db() as c:
        return [r[0] for r in c.execute('SELECT id FROM stripe_events')]


def user(col):
    with db() as c:
        return c.execute(f'SELECT {col} FROM users WHERE id = 1').fetchone()[0]


SUB_EVENT = {'id': 'evt_1', 'type': 'customer.subscription.updated',
             'data': {'object': {'id': 'sub_1', 'customer': 'cus_1'}}}


def test_killed_mid_handler_then_retry_applies():
    reset()
    retrieve_mode['value'] = 'kill'
    assert post('/api/stripe/webhook', SUB_EVENT) is None
    assert event_rows() == [], f'killed handler left a claim: {event_rows()}'
    retrieve_mode['value'] = 'ok'
    r = post('/api/stripe/webhook', SUB_EVENT)
    assert r.status_code == 200 and not r.get_json().get('duplicate'), r.get_json()
    assert user('subscription_status') == 'premium'
    assert event_rows() == ['evt_1']


def test_handler_error_returns_500_and_leaves_no_row():
    reset()
    retrieve_mode['value'] = 'raise'
    r = post('/api/stripe/webhook', SUB_EVENT)
    assert r.status_code == 500
    assert event_rows() == []
    retrieve_mode['value'] = 'ok'
    assert post('/api/stripe/webhook', SUB_EVENT).status_code == 200
    assert user('subscription_status') == 'premium'


def test_successful_event_replayed_is_noop():
    reset()
    retrieve_mode['value'] = 'ok'
    assert post('/api/stripe/webhook', SUB_EVENT).status_code == 200
    with db() as c:
        c.execute("UPDATE users SET subscription_status = 'free' WHERE id = 1")
    r = post('/api/stripe/webhook', SUB_EVENT)
    assert r.get_json().get('duplicate') is True, r.get_json()
    assert calls == ['sub_1'], f'replay ran the handler again: {calls}'
    assert user('subscription_status') == 'free'


TEST_SUB_EVENT = {'id': 'evt_3', 'type': 'customer.subscription.updated',
                  'data': {'object': {'id': 'sub_1', 'customer': 'cus_1', 'status': 'active',
                                      'current_period_end': 4_000_000_000, 'metadata': {}}}}


def test_test_mode_concurrent_duplicate_is_excluded():
    # Test mode applies the event snapshot, so a duplicate delivered while the
    # first copy is still running must be refused, or it could land late and
    # roll back a newer event.
    reset()
    inner = []
    real = api._apply_subscription_test

    def apply_with_duplicate(sub):
        if not inner:
            inner.append(None)  # set first so the nested delivery does not recurse
            inner[0] = post('/api/stripe/webhook/test', TEST_SUB_EVENT).get_json()
        real(sub)

    patch('_apply_subscription_test', apply_with_duplicate)
    try:
        assert post('/api/stripe/webhook/test', TEST_SUB_EVENT).status_code == 200
    finally:
        patch('_apply_subscription_test', real)
    assert inner[0].get('duplicate') is True, f'concurrent duplicate ran: {inner[0]}'
    assert user('test_subscription_status') == 'premium'
    assert event_rows() == ['TEST:evt_3']

def test_stale_fetch_cannot_move_paid_through_backwards():
    # #28: two handlers for the same sub finish out of order. The older fetch
    # (period end about now) lands last and must not cut off a paying user.
    reset()
    retrieve_mode['value'] = 'ok'
    assert post('/api/stripe/webhook', SUB_EVENT).status_code == 200
    assert user('premium_until') == 4_000_000_000
    stale = dict(SUB_EVENT, id='evt_stale')
    real = api.stripe.Subscription.retrieve
    api.stripe.Subscription.retrieve = lambda sid, **_: {
        'id': sid, 'customer': 'cus_1', 'status': 'active',
        'current_period_end': api.now_ts(), 'metadata': {}}
    try:
        assert post('/api/stripe/webhook', stale).status_code == 200
    finally:
        api.stripe.Subscription.retrieve = real
    assert user('premium_until') == 4_000_000_000, user('premium_until')


def test_second_live_sub_pings_operator():
    # #27: a different live sub replacing the one on file means a possible double charge.
    reset()
    pings = []
    real = api.notify_herald
    patch('notify_herald', lambda *a: pings.append(a))
    try:
        with db() as c:
            c.execute("UPDATE users SET stripe_subscription_id = 'sub_old' WHERE id = 1")
        assert post('/api/stripe/webhook', SUB_EVENT).status_code == 200
    finally:
        patch('notify_herald', real)
    assert any(p[0] == 'money' and 'sub_old' in p[2] and 'sub_1' in p[2] for p in pings), pings


def test_test_mode_late_cancel_of_old_sub_is_ignored():
    # #31: new test sub is active, then a delayed cancel for the old one arrives.
    reset()
    new = {'id': 'evt_new', 'type': 'customer.subscription.updated',
           'data': {'object': {'id': 'sub_new', 'customer': 'cus_1', 'status': 'active',
                               'current_period_end': 4_000_000_000, 'metadata': {}}}}
    old = {'id': 'evt_old', 'type': 'customer.subscription.deleted',
           'data': {'object': {'id': 'sub_old', 'customer': 'cus_1', 'status': 'canceled', 'metadata': {}}}}
    assert post('/api/stripe/webhook/test', new).status_code == 200
    assert post('/api/stripe/webhook/test', old).status_code == 200
    assert user('test_subscription_status') == 'premium', user('test_subscription_status')
    assert user('stripe_subscription_id_test') == 'sub_new', user('stripe_subscription_id_test')
    gone = {'id': 'evt_gone', 'type': 'customer.subscription.deleted',
            'data': {'object': {'id': 'sub_new', 'customer': 'cus_1', 'status': 'canceled', 'metadata': {}}}}
    assert post('/api/stripe/webhook/test', gone).status_code == 200
    assert user('test_subscription_status') == 'free'
    assert user('stripe_subscription_id_test') is None, 'cancel must clear the id, not store the dead one'


TOK = 'a' * 64


def test_checkout_expires_older_open_sessions():
    # #27: a second checkout must kill the first, so both cannot be paid.
    reset()
    patch('STRIPE_PRICE_MONTHLY', 'price_m')
    patch('STRIPE_PRICE_YEARLY', 'price_y')
    with db() as c:
        c.execute("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, 1, ?, ?)",
                  (TOK, api.now_ts(), api.now_ts() + 3600))
    expired = []

    class L:
        def __init__(self, data): self.data = data
    saved = (api.stripe.Subscription.list, api.stripe.checkout.Session.list,
             api.stripe.checkout.Session.expire, api.stripe.checkout.Session.create)
    api.stripe.Subscription.list = lambda **_: L([])
    api.stripe.checkout.Session.list = lambda **kw: L([{'id': 'cs_old'}] if kw.get('status') == 'open' else [])
    api.stripe.checkout.Session.expire = lambda sid, **_: expired.append(sid)
    api.stripe.checkout.Session.create = lambda **_: type('S', (), {'url': 'https://x', 'id': 'cs_new'})()
    try:
        r = client.post('/api/billing/checkout', json={'plan': 'monthly'},
                        headers={'Authorization': 'Bearer ' + TOK})
    finally:
        (api.stripe.Subscription.list, api.stripe.checkout.Session.list,
         api.stripe.checkout.Session.expire, api.stripe.checkout.Session.create) = saved
    assert r.status_code == 200, r.get_json()
    assert expired == ['cs_old'], expired


failed = 0
for name, fn in list(globals().items()):
    if name.startswith('test_') and callable(fn):
        try:
            fn()
            print(f'ok   {name}')
        except AssertionError as e:
            failed += 1
            print(f'FAIL {name}: {e}')
print(f'{"FAILED" if failed else "PASSED"} ({failed} failing)')
sys.exit(1 if failed else 0)
