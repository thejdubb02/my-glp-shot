#!/usr/bin/env python3
"""End-to-end check of the subscribe path, run against the real API code.

Why this exists: stripe-smoke.sh drives /api/admin/test-checkout, which hardcodes
trial_period_days and never touches the live /api/billing/checkout branch. So it
would have passed happily while a trial user had no way to subscribe at all, and
it still cannot see whether converting mid-trial keeps the days already promised.

This drives the REAL endpoint through Flask's test client, for every account state,
and captures the exact payload handed to Stripe. Two modes:

    python3 subscribe-e2e.py            # offline: intercepts Session.create
    python3 subscribe-e2e.py --live     # also makes real Checkout Sessions

Both modes create a live-mode Stripe Customer (that call is not intercepted) and
delete it again at the end. --live additionally creates two Checkout Sessions and
expires them. Nothing is charged either way: a Checkout Session bills nobody until
someone completes it, and nobody completes these. The proof --live adds is
amount_total, which is Stripe's own arithmetic rather than ours -- 0 when the
remaining trial is honoured, 1999 when it is not.

The throwaway account uses a .test domain, so it is excluded from the signup
metrics and the Mattermost notification, and it is deleted on the way out.

Run inside the API container, which already has the env and the DB:
    docker exec -i my-glp-shot-api python3 - --live < scripts/subscribe-e2e.py
"""
import os
import sys
import sqlite3
import time
import secrets

sys.path.insert(0, '/app')
import app as A  # noqa: E402

LIVE = '--live' in sys.argv
TS = int(time.time())
EMAIL = 'subcheck+%d@myglpshot.test' % TS   # .test => excluded from metrics and Mattermost
TOKEN = secrets.token_hex(32)
DAY = 86400

captured = []
real_create = A.stripe.checkout.Session.create


class FakeSession:
    id = 'cs_test_intercepted'
    url = 'https://checkout.stripe.com/intercepted'


def intercept(**kw):
    captured.append(kw)
    return FakeSession()


def db():
    c = sqlite3.connect(os.environ.get('MGS_DB', '/data/api.db'))
    c.row_factory = sqlite3.Row
    return c


class Check:
    def __init__(self):
        self.p = self.f = 0
        self.fails = []

    def ok(self, name, cond, detail=''):
        if cond:
            self.p += 1
            print('  ok    %s' % name)
        else:
            self.f += 1
            self.fails.append('%s - %s' % (name, detail))
            print('  FAIL  %s  (%s)' % (name, detail))

    def report(self):
        print('\n%d passed, %d failed' % (self.p, self.f))
        for x in self.fails:
            print('  x ' + x)
        return 1 if self.f else 0


C = Check()
client = A.app.test_client()

# ---------- sign up a throwaway account ----------
r = client.post('/api/signup', json={'email': EMAIL, 'authToken': TOKEN})
if r.status_code != 200:
    print('signup failed: %s %s' % (r.status_code, r.get_data(as_text=True)[:200]))
    sys.exit(2)
uid = r.get_json()['user']['id']
print('\ntest user #%s %s\n' % (uid, EMAIL))


def set_state(status, trial_ends):
    c = db()
    c.execute('UPDATE users SET subscription_status=?, trial_ends_at=? WHERE id=?',
              (status, trial_ends, uid))
    c.commit()
    c.close()


def checkout(plan='yearly'):
    del captured[:]
    resp = client.post('/api/billing/checkout', json={'plan': plan})
    return resp, (captured[0] if captured else None)


def sub_data(kw):
    return (kw or {}).get('subscription_data', {})


now = int(time.time())

# ---------- the scenarios ----------
A.stripe.checkout.Session.create = intercept

print('1. fresh trial, 14 days left - the ordinary case')
set_state('trial', now + 14 * DAY)
r, kw = checkout()
sd = sub_data(kw)
C.ok('checkout succeeds', r.status_code == 200,
     '%s %s' % (r.status_code, r.get_data(as_text=True)[:120]))
C.ok('keeps the existing trial', sd.get('trial_end') == now + 14 * DAY,
     'trial_end=%s want=%s' % (sd.get('trial_end'), now + 14 * DAY))
C.ok('does NOT grant a second 14 days', 'trial_period_days' not in sd, str(sd))

print("\n2. Lin's exact state - trial, 3.8 days left")
lin_end = now + int(3.8 * DAY)
set_state('trial', lin_end)
r, kw = checkout()
sd = sub_data(kw)
C.ok('checkout succeeds', r.status_code == 200, str(r.status_code))
C.ok('she keeps all 3.8 remaining days', sd.get('trial_end') == lin_end,
     'trial_end=%s want=%s' % (sd.get('trial_end'), lin_end))
C.ok('not billed today', 'trial_period_days' not in sd and bool(sd.get('trial_end')), str(sd))

print("\n3. trial with 1 day left - inside Stripe's 48h floor, must bill now")
set_state('trial', now + DAY)
r, kw = checkout()
sd = sub_data(kw)
C.ok('checkout succeeds', r.status_code == 200, str(r.status_code))
C.ok('no trial_end passed', 'trial_end' not in sd, str(sd))
C.ok('no fresh trial either', 'trial_period_days' not in sd, str(sd))

print('\n4. trial already expired')
set_state('trial', now - 2 * DAY)
r, kw = checkout()
sd = sub_data(kw)
C.ok('no trial of any kind', 'trial_end' not in sd and 'trial_period_days' not in sd, str(sd))

print('\n5. free tier (trial burned) - pays today, no free days')
set_state('free', now - 30 * DAY)
r, kw = checkout()
sd = sub_data(kw)
C.ok('no trial of any kind', 'trial_end' not in sd and 'trial_period_days' not in sd, str(sd))

print('\n6. account that never had a trial - gets the introductory 14 days')
set_state('trial', None)
r, kw = checkout()
sd = sub_data(kw)
C.ok('grants the introductory trial', sd.get('trial_period_days') == A.TRIAL_DAYS, str(sd))
C.ok('no trial_end alongside it', 'trial_end' not in sd, str(sd))

print('\n7. cancel-and-resubscribe cannot farm a second trial')
set_state('trial', now - 1 * DAY)      # trial they already used, now past
r, kw = checkout()
sd = sub_data(kw)
C.ok('past trial grants nothing',
     not sd.get('trial_end') and not sd.get('trial_period_days'), str(sd))

print('\n8. payload sanity')
set_state('trial', now + 9 * DAY)
r, kw = checkout('monthly')
C.ok('monthly plan uses the monthly price',
     kw['line_items'][0]['price'] == A.STRIPE_PRICE_MONTHLY, str(kw['line_items']))
C.ok('subscription mode', kw['mode'] == 'subscription')
C.ok('user_id in metadata', kw['metadata']['user_id'] == str(uid))
C.ok('promo codes allowed', kw['allow_promotion_codes'] is True)

# ---------- real calls, so Stripe itself validates the payload ----------
# amount_total is the proof, and it is Stripe's own arithmetic rather than ours:
# a session that honours the remaining trial shows 0 due today, and one inside the
# 48h floor shows the full price. If the fix silently stopped working, this is the
# number that would move.
A.stripe.checkout.Session.create = real_create
live_sessions = []


def live_checkout(label, trial_ends, want_amount):
    set_state('trial', trial_ends)
    resp = client.post('/api/billing/checkout', json={'plan': 'yearly'})
    body = resp.get_json() or {}
    C.ok('%s: Stripe accepted the payload' % label,
         resp.status_code == 200 and bool(body.get('url')),
         '%s %s' % (resp.status_code, str(body)[:200]))
    if not body.get('sessionId'):
        return
    live_sessions.append(body['sessionId'])
    s = A.stripe.checkout.Session.retrieve(body['sessionId'], api_key=A.STRIPE_API_KEY)
    print('    %s  status=%s/%s  amount_total=%s  livemode=%s'
          % (s.id[:28], s.status, s.payment_status, s.amount_total, s.livemode))
    C.ok('%s: due today is %s' % (label, want_amount), s.amount_total == want_amount,
         'amount_total=%s want=%s' % (s.amount_total, want_amount))
    C.ok('%s: open and unpaid' % label,
         s.status == 'open' and s.payment_status == 'unpaid',
         '%s/%s' % (s.status, s.payment_status))
    C.ok('%s: no subscription created, nothing charged' % label,
         not s.get('subscription'), str(s.get('subscription')))


if LIVE:
    print('\n9. LIVE - real Checkout Sessions (nothing is charged)')
    live_checkout('mid-trial, 9 days left', now + 9 * DAY, 0)
    live_checkout('last day, inside 48h floor', now + DAY, 1999)

    print('\n10. LIVE - the webhook half: does paying actually grant premium?')
    c = db()
    cust = c.execute('SELECT stripe_customer_id FROM users WHERE id=?', (uid,)).fetchone()[0]
    c.close()
    with A.app.app_context():
        # Exactly the shape Stripe posts when a mid-trial subscription is created:
        # status 'trialing' until the trial_end passes, then 'active'.
        A._apply_subscription({
            'id': 'sub_e2e_synthetic', 'customer': cust, 'status': 'trialing',
            'trial_end': now + 9 * DAY, 'cancel_at_period_end': False,
            'items': {'data': [{'current_period_end': now + 365 * DAY}]},
            'metadata': {'user_id': str(uid), 'app': 'myglpshot'},
        })
    c = db()
    u = c.execute('SELECT * FROM users WHERE id=?', (uid,)).fetchone()
    c.close()
    C.ok('subscribing mid-trial keeps trial status until it runs out',
         u['subscription_status'] == 'trial', u['subscription_status'])
    C.ok('subscription id recorded, so access will not lapse',
         u['stripe_subscription_id'] == 'sub_e2e_synthetic', str(u['stripe_subscription_id']))
    C.ok('paid through the end of the trial', u['premium_until'] == now + 9 * DAY,
         str(u['premium_until']))

    with A.app.app_context():
        # Trial ends, first payment succeeds.
        A._apply_subscription({
            'id': 'sub_e2e_synthetic', 'customer': cust, 'status': 'active',
            'trial_end': now + 9 * DAY, 'cancel_at_period_end': False,
            'items': {'data': [{'current_period_end': now + 365 * DAY}]},
            'metadata': {'user_id': str(uid), 'app': 'myglpshot'},
        })
    c = db()
    u = c.execute('SELECT * FROM users WHERE id=?', (uid,)).fetchone()
    c.close()
    C.ok('first payment flips the account to premium',
         u['subscription_status'] == 'premium', u['subscription_status'])
    C.ok('paid through a year out', u['premium_until'] == now + 365 * DAY,
         str(u['premium_until']))
    C.ok('public_user reports premium', A.public_user(u)['isPremium'] is True,
         str(A.public_user(u)))
else:
    print('\n9-10. LIVE - skipped (pass --live for real Checkout Sessions)')

# ---------- cleanup ----------
print('\ncleanup')
c = db()
row = c.execute('SELECT stripe_customer_id FROM users WHERE id=?', (uid,)).fetchone()
cust = row['stripe_customer_id'] if row else None
c.close()

for sid in live_sessions:
    try:
        A.stripe.checkout.Session.expire(sid, api_key=A.STRIPE_API_KEY)
        print('  expired checkout session %s' % sid)
    except Exception as e:
        print('  WARNING could not expire session %s: %s' % (sid, e))
if cust:
    try:
        A.stripe.Customer.delete(cust, api_key=A.STRIPE_API_KEY)
        print('  deleted stripe customer %s' % cust)
    except Exception as e:
        print('  WARNING could not delete customer %s: %s' % (cust, e))

c = db()
c.execute('DELETE FROM users WHERE id=?', (uid,))
for t in ('sessions', 'sync_blobs', 'push_subscriptions', 'audit_log'):
    try:
        c.execute('DELETE FROM %s WHERE user_id=?' % t, (uid,))
    except sqlite3.OperationalError:
        pass
c.commit()
left = c.execute('SELECT COUNT(*) c FROM users WHERE id=?', (uid,)).fetchone()['c']
c.close()
C.ok('test user removed', left == 0, '%d rows left' % left)

sys.exit(C.report())
