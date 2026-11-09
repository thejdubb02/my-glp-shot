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
    MATTERMOST_WEBHOOK_URL='',
)
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'api'))
import app as api  # noqa: E402

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

    api._apply_subscription_test = apply_with_duplicate
    try:
        assert post('/api/stripe/webhook/test', TEST_SUB_EVENT).status_code == 200
    finally:
        api._apply_subscription_test = real
    assert inner[0].get('duplicate') is True, f'concurrent duplicate ran: {inner[0]}'
    assert user('test_subscription_status') == 'premium'
    assert event_rows() == ['TEST:evt_3']

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
