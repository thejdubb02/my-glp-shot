"""Live Stripe billing: prices, checkout, portal, webhook."""
import os
import time

import stripe
from flask import jsonify, request

from config import (
    MGS_APP_NAME, MGS_EMOJI, STRIPE_API_KEY, STRIPE_API_KEY_TEST, STRIPE_PRICE_MONTHLY,
    STRIPE_PRICE_MONTHLY_TEST, STRIPE_PRICE_YEARLY, STRIPE_PRICE_YEARLY_TEST, STRIPE_WEBHOOK_SECRET,
    TRIAL_DAYS, app,
)
from db import get_db, now_ts
from helpers import err, notify_herald, require_user


# ---------- Billing (Stripe) ----------
def _stripe_ready():
    return bool(STRIPE_API_KEY and STRIPE_PRICE_MONTHLY and STRIPE_PRICE_YEARLY)


def _stripe_test_ready():
    return bool(STRIPE_API_KEY_TEST and STRIPE_PRICE_MONTHLY_TEST and STRIPE_PRICE_YEARLY_TEST)


def _ensure_customer(user):
    """Return stripe_customer_id, creating one if needed."""
    if user['stripe_customer_id']:
        return user['stripe_customer_id']
    cust = stripe.Customer.create(
        email=user['email'],
        metadata={'user_id': str(user['id']), 'app': 'myglpshot'},
    )
    get_db().execute(
        'UPDATE users SET stripe_customer_id = ? WHERE id = ?',
        (cust.id, user['id']),
    )
    get_db().commit()
    return cust.id


@app.route('/api/billing/prices')
def billing_prices():
    if not _stripe_ready():
        return err('billing_unavailable', 'Billing is not configured.', 503)
    return jsonify(
        monthly={'priceId': STRIPE_PRICE_MONTHLY, 'amount': 199, 'interval': 'month'},
        yearly={'priceId': STRIPE_PRICE_YEARLY, 'amount': 1999, 'interval': 'year'},
        trialDays=TRIAL_DAYS,
    )


@app.route('/api/billing/checkout', methods=['POST'])
def billing_checkout():
    user = require_user()
    if not user:
        return err('unauthorized', 'Not signed in.', 401)
    if not _stripe_ready():
        return err('billing_unavailable', 'Billing is not configured.', 503)
    data = request.get_json(silent=True) or {}
    plan = (data.get('plan') or 'yearly').lower()
    price_id = STRIPE_PRICE_YEARLY if plan == 'yearly' else STRIPE_PRICE_MONTHLY
    customer_id = _ensure_customer(user)
    app_base = os.environ.get('APP_URL', 'https://app.myglpshot.com').rstrip('/')

    # Defend against duplicate subscriptions: if the customer already has an active or trialing sub,
    # send them to the customer portal instead. They can change plan there.
    try:
        subs = stripe.Subscription.list(customer=customer_id, status='all', limit=10)
        for s in subs.data:
            if s.status in ('active', 'trialing', 'past_due', 'unpaid'):
                portal = stripe.billing_portal.Session.create(
                    customer=customer_id, return_url=f'{app_base}/'
                )
                return jsonify(url=portal.url, alreadySubscribed=True)
    except stripe.StripeError as e:
        app.logger.warning('subscription list check failed (continuing): %s', e)
    # The guard above cannot see a checkout that is open but not yet paid. Two tabs
    # (or a double click) used to create two sessions, and paying both made two
    # subscriptions (#27). Expire the older open ones so only the newest can be paid.
    try:
        for s in stripe.checkout.Session.list(customer=customer_id, status='open', limit=10).data:
            try:
                stripe.checkout.Session.expire(s['id'])
            except stripe.StripeError as e:
                app.logger.warning('could not expire open checkout %s: %s', s['id'], e)
    except stripe.StripeError as e:
        app.logger.warning('open checkout list failed (continuing): %s', e)
    subscription_data = {'metadata': {'user_id': str(user['id']), 'app': 'myglpshot'}}
    terms = _trial_terms(user)
    subscription_data.update(terms)
    # Stripe labels its submit button "Start trial" whenever a subscription opens with
    # a trial period, and there is no way to override that text. For someone converting
    # mid-trial it reads as "here is a brand new 14-day trial", which is what Lin
    # reported on 2026-08-25. custom_text is the one place we can correct it in situ.
    custom_text = {}
    if terms.get('trial_end'):
        t = time.gmtime(terms['trial_end'])
        when = '%s %d, %d' % (time.strftime('%B', t), t.tm_mday, t.tm_year)
        custom_text['submit'] = {'message': (
            'This continues the trial you already have rather than starting a new one. '
            'You keep your remaining days and nothing is charged today. '
            'Your first payment is on %s.' % when
        )}
    try:
        sess = stripe.checkout.Session.create(
            mode='subscription',
            customer=customer_id,
            line_items=[{'price': price_id, 'quantity': 1}],
            allow_promotion_codes=True,
            subscription_data=subscription_data,
            custom_text=custom_text or None,
            metadata={'user_id': str(user['id']), 'app': 'myglpshot'},
            success_url=f'{app_base}/?billing=success&session_id={{CHECKOUT_SESSION_ID}}',
            cancel_url=f'{app_base}/?billing=canceled',
        )
    except stripe.StripeError as e:
        app.logger.exception('checkout failed: %s', e)
        return err('stripe_error', str(getattr(e, 'user_message', None) or 'Stripe error'), 502)
    return jsonify(url=sess.url, sessionId=sess.id)


@app.route('/api/billing/portal', methods=['POST'])
def billing_portal():
    user = require_user()
    if not user:
        return err('unauthorized', 'Not signed in.', 401)
    if not user['stripe_customer_id']:
        return err('no_customer', 'No billing record yet — start a subscription first.', 400)
    app_base = os.environ.get('APP_URL', 'https://app.myglpshot.com').rstrip('/')
    try:
        sess = stripe.billing_portal.Session.create(
            customer=user['stripe_customer_id'],
            return_url=f'{app_base}/',
        )
    except stripe.StripeError as e:
        app.logger.exception('portal failed: %s', e)
        return err('stripe_error', str(getattr(e, 'user_message', None) or 'Stripe error'), 502)
    return jsonify(url=sess.url)


def _period_end(sub):
    """Paid-through timestamp for a Stripe subscription.

    Stripe moved current_period_end off the Subscription object and onto each
    subscription item in the 2025-03-31 API version. Reading only the top-level
    field silently yields None on a newer account, which would write a NULL
    premium_until and drop a paying customer to free.
    """
    top = sub.get('current_period_end')
    if top:
        return top
    items = (sub.get('items') or {}).get('data') or []
    ends = [i.get('current_period_end') for i in items if i.get('current_period_end')]
    return max(ends) if ends else None


def _trial_terms(user):
    """The trial half of subscription_data for this user, as a dict to merge in.

    One function so the live checkout and the admin test checkout cannot disagree.
    They did disagree until 2026-08-25: the test path hardcoded trial_period_days,
    so stripe-smoke.sh happily passed while trial users had no Upgrade button at all
    and mid-trial converts were being charged on the spot.

    Three outcomes:
      * never trialled            -> trial_period_days, the introductory offer
      * trial still running       -> trial_end, the SAME timestamp already on the row
      * trial spent, or under 48h -> nothing, bill today
    """
    if not _has_used_trial(user):
        return {'trial_period_days': TRIAL_DAYS}
    keep = _remaining_trial_end(user)
    return {'trial_end': keep} if keep else {}


def _remaining_trial_end(user):
    """Unix ts of an in-flight trial, or None if there is nothing left to honour.

    Stripe refuses a trial_end less than 48 hours out, so a user converting on the
    final day is simply billed immediately — which is the right answer: their trial
    is over. Anyone earlier keeps the rest of their fortnight.
    """
    if (user['subscription_status'] or '').lower() != 'trial':
        return None
    ends = user['trial_ends_at']
    if not ends:
        return None
    ends = int(ends)
    return ends if ends - int(time.time()) >= 2 * 86400 else None


def _has_used_trial(user):
    """True if this account has already consumed its introductory trial.

    Without this check every new Checkout session handed out another 14 free
    days, so cancel-and-resubscribe was an unlimited free plan.
    """
    if user['trial_ends_at']:
        return True
    return (user['subscription_status'] or '').lower() in ('premium', 'lifetime', 'free')


def _apply_subscription(sub):
    """Update a user's subscription columns from a Stripe Subscription object/dict."""
    cust_id = sub.get('customer')
    if not cust_id:
        return
    db = get_db()
    user = db.execute('SELECT * FROM users WHERE stripe_customer_id = ?', (cust_id,)).fetchone()
    if not user:
        # Fall back to subscription metadata user_id
        meta = sub.get('metadata') or {}
        uid = meta.get('user_id')
        if not uid:
            return
        user = db.execute('SELECT * FROM users WHERE id = ?', (uid,)).fetchone()
        if not user:
            return
        db.execute('UPDATE users SET stripe_customer_id = ? WHERE id = ?', (cust_id, user['id']))

    # Lifetime grants are out-of-band (manual admin action) and must never be
    # demoted by an unrelated Stripe webhook (e.g. a one-time charge being
    # refunded, or a stale subscription being canceled).
    if (user['subscription_status'] or '').lower() == 'lifetime':
        return

    status = sub.get('status')  # trialing | active | past_due | canceled | unpaid | incomplete | incomplete_expired
    sub_id = sub.get('id')
    # Stripe does not deliver webhooks in order. A late cancel for a subscription
    # the user has since replaced would overwrite the live subscription id with
    # the dead one, and account deletion would then cancel the dead one and leave
    # the live one billing. Only a new active or trialing subscription may replace
    # the one on file; anything else about another subscription is history.
    current_sub = user['stripe_subscription_id']
    if current_sub and sub_id and sub_id != current_sub and status not in ('active', 'trialing'):
        db.commit()  # keep a customer-id backfill made above
        return
    if current_sub and sub_id and sub_id != current_sub:
        # Usually a duplicate checkout: both subs may be billing (#27). Operator ping only.
        notify_herald(
            'money',
            f"{MGS_EMOJI} {MGS_APP_NAME}: second live subscription",
            f"{user['email']}: {sub_id} replaces {current_sub}. Check Stripe for a double charge.",
        )
    current_period_end = _period_end(sub)
    trial_end = sub.get('trial_end')
    # Newer Stripe API versions record a portal cancel as cancel_at rather than
    # cancel_at_period_end, so either one means "will not renew".
    cancelling = 1 if (sub.get('cancel_at_period_end') or sub.get('cancel_at')) else 0

    if status in ('active', 'trialing'):
        new_status = 'premium' if status == 'active' else 'trial'
        # premium_until is "paid through" — for trialing, use trial_end; for active, current_period_end.
        # A missing end (Stripe API shape change) keeps the stored one: writing NULL
        # would read as not premium and drop a paying customer to free.
        until = trial_end if status == 'trialing' else current_period_end
        was_paid = (user['subscription_status'] or '').lower() == 'premium'
        db.execute(
            """UPDATE users
               SET subscription_status = ?,
                   premium_until = CASE
                       WHEN stripe_subscription_id = ? AND premium_until IS NOT NULL
                           THEN MAX(COALESCE(?, premium_until), premium_until)
                       ELSE COALESCE(?, premium_until) END,
                   trial_ends_at = COALESCE(?, trial_ends_at),
                   stripe_subscription_id = ?,
                   cancel_at_period_end = ?
               WHERE id = ?""",
            (new_status, sub_id, until, until, trial_end, sub_id, cancelling, user['id']),
        )
        # Only on the transition into paid — renewals fire this same webhook every
        # billing period and shouldn't ping.
        if new_status == 'premium' and not was_paid:
            notify_herald(
                'money',
                f"{MGS_EMOJI} {MGS_APP_NAME}: paid subscription",
                user['email'],
            )
    elif status in ('canceled', 'unpaid', 'incomplete_expired'):
        # Don't yank premium mid-period: keep premium_until, just flip status when
        # it lapses. A trial user who cancels keeps the trial they already had,
        # rather than being promoted to 'premium' because premium_until held the
        # trial end. The subscription id is cleared because there is no live
        # subscription any more; leaving it set made the app go on telling a
        # cancelled user "Subscribed, first payment on ...".
        now = now_ts()
        db.execute(
            """UPDATE users
               SET subscription_status = CASE
                       WHEN subscription_status = 'trial' AND trial_ends_at IS NOT NULL AND trial_ends_at > ? THEN 'trial'
                       WHEN premium_until IS NOT NULL AND premium_until > ? THEN 'premium'
                       ELSE 'free'
                   END,
                   stripe_subscription_id = NULL,
                   cancel_at_period_end = 0
               WHERE id = ?""",
            (now, now, user['id']),
        )
    elif status == 'past_due':
        # Keep current state; Stripe is dunning.
        db.execute('UPDATE users SET stripe_subscription_id = ? WHERE id = ?', (sub_id, user['id']))
    db.commit()


@app.route('/api/stripe/webhook', methods=['POST'])
def stripe_webhook():
    if not STRIPE_WEBHOOK_SECRET:
        return err('webhook_unconfigured', 'Webhook secret missing.', 503)
    payload = request.get_data()
    sig_header = request.headers.get('Stripe-Signature', '')
    try:
        event = stripe.Webhook.construct_event(payload, sig_header, STRIPE_WEBHOOK_SECRET)
    except (ValueError, stripe.error.SignatureVerificationError) as e:
        app.logger.warning('Stripe webhook signature failed: %s', e)
        return err('bad_signature', 'Invalid signature.', 400)

    et = event['type']
    eid = event.get('id')
    obj = event['data']['object']
    # Idempotency: the event is recorded only after its handler succeeds, so a
    # worker killed mid-handler (deploy restart, OOM) leaves no row and Stripe's
    # retry runs it again. Two concurrent deliveries may both run the handler and
    # finish in either order, so the older fetch can land last. _apply_subscription
    # therefore never moves premium_until backwards for the same subscription (#28).
    if eid and get_db().execute('SELECT 1 FROM stripe_events WHERE id = ?', (eid,)).fetchone():
        return jsonify(received=True, duplicate=True)
    try:
        if et == 'checkout.session.completed':
            # Link customer to user via metadata, then refresh the subscription.
            meta = obj.get('metadata') or {}
            uid = meta.get('user_id')
            cust_id = obj.get('customer')
            sub_id = obj.get('subscription')
            if uid and cust_id:
                get_db().execute(
                    'UPDATE users SET stripe_customer_id = COALESCE(stripe_customer_id, ?) WHERE id = ?',
                    (cust_id, uid),
                )
                get_db().commit()
            if sub_id:
                sub = stripe.Subscription.retrieve(sub_id, api_key=STRIPE_API_KEY)
                _apply_subscription(sub)
        elif et in ('customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'):
            # Apply Stripe's current view of the subscription, not the snapshot in
            # the event. Events arrive out of order, so a delayed 'updated: active'
            # landing after 'deleted' used to revive a cancelled subscription.
            # Stripe's docs recommend exactly this re-fetch.
            sub = stripe.Subscription.retrieve(obj['id'], api_key=STRIPE_API_KEY) if obj.get('id') else obj
            _apply_subscription(sub)
        elif et == 'invoice.payment_failed':
            app.logger.warning('Payment failed for customer %s', obj.get('customer'))
        # Any other event type is ignored.
        if eid:
            db = get_db()
            db.execute(
                'INSERT OR IGNORE INTO stripe_events (id, type, received_at) VALUES (?, ?, ?)',
                (eid, et, now_ts()),
            )
            db.commit()
    except Exception as e:
        # Fail loudly so Stripe retries. Returning 200 here meant a transient
        # error permanently dropped a subscription change: the user paid and
        # never got premium. No event row was written, so the retry runs.
        app.logger.exception('webhook handler error for %s: %s', et, e)
        return err('handler_error', 'Webhook handler failed; retry.', 500)
    return jsonify(received=True)
