"""Stripe TEST mode: separate keys, separate columns, never touches live data."""
import os

import stripe
from flask import jsonify, request

from config import (
    STRIPE_API_KEY_TEST, STRIPE_PRICE_MONTHLY_TEST, STRIPE_PRICE_YEARLY_TEST,
    STRIPE_WEBHOOK_SECRET_TEST, app,
)
from db import get_db, now_ts
from helpers import _safe_col, err
from auth import _delete_user_everywhere
from billing import _period_end, _stripe_test_ready, _trial_terms
from admin import _audit, _live_subscription_block, admin_gate


# ---------- Stripe TEST mode (separate keys, separate columns, never touches live data) ----------
def _apply_subscription_test(sub):
    """Test-mode counterpart of _apply_subscription. Updates *_test columns only.
    Live subscription_status / premium_until are never touched in test mode.
    """
    cust_id = sub.get('customer')
    if not cust_id:
        return
    db = get_db()
    user = db.execute('SELECT * FROM users WHERE stripe_customer_id_test = ?', (cust_id,)).fetchone()
    if not user:
        meta = sub.get('metadata') or {}
        uid = meta.get('user_id')
        if not uid:
            return
        user = db.execute('SELECT * FROM users WHERE id = ?', (uid,)).fetchone()
        if not user:
            return
        db.execute('UPDATE users SET stripe_customer_id_test = ? WHERE id = ?', (cust_id, user['id']))
    status = sub.get('status')
    sub_id = sub.get('id')
    # Same rule as the live handler: a late event about a replaced sub is history (#31).
    current_sub = _safe_col(user, 'stripe_subscription_id_test', None)
    if current_sub and sub_id and sub_id != current_sub and status not in ('active', 'trialing'):
        db.commit()
        return
    cpe = _period_end(sub)
    trial_end = sub.get('trial_end')
    if status in ('active', 'trialing'):
        new_status = 'premium' if status == 'active' else 'trial'
        until = trial_end if status == 'trialing' else cpe
        db.execute(
            """UPDATE users SET test_subscription_status = ?, test_premium_until = ?,
                                stripe_subscription_id_test = ? WHERE id = ?""",
            (new_status, until, sub_id, user['id']),
        )
    elif status in ('canceled', 'unpaid', 'incomplete_expired'):
        db.execute(
            """UPDATE users SET test_subscription_status = 'free',
                                stripe_subscription_id_test = NULL WHERE id = ?""",
            (user['id'],),
        )
    db.commit()


def _handle_test_event(et, obj):
    # The test API key is passed per call. Assigning it to the process-global
    # `stripe.api_key` raced with concurrent live requests on the other
    # gunicorn threads — a live checkout could execute against the test key.
    if et == 'checkout.session.completed':
        meta = obj.get('metadata') or {}
        uid = meta.get('user_id')
        cust_id = obj.get('customer')
        sub_id = obj.get('subscription')
        if uid and cust_id:
            get_db().execute(
                'UPDATE users SET stripe_customer_id_test = COALESCE(stripe_customer_id_test, ?) WHERE id = ?',
                (cust_id, uid),
            )
            get_db().commit()
        if sub_id:
            sub = stripe.Subscription.retrieve(sub_id, api_key=STRIPE_API_KEY_TEST)
            _apply_subscription_test(sub)
    elif et in ('customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'):
        _apply_subscription_test(obj)


@app.route('/api/stripe/webhook/test', methods=['POST'])
def stripe_webhook_test():
    """Parallel webhook for Stripe test-mode events. Verifies with the test
    webhook secret and writes only to *_test columns."""
    if not STRIPE_WEBHOOK_SECRET_TEST:
        return err('webhook_unconfigured', 'Test webhook secret missing.', 503)
    payload = request.get_data()
    sig = request.headers.get('Stripe-Signature', '')
    try:
        event = stripe.Webhook.construct_event(payload, sig, STRIPE_WEBHOOK_SECRET_TEST)
    except (ValueError, stripe.error.SignatureVerificationError) as e:
        app.logger.warning('Stripe TEST webhook signature failed: %s', e)
        return err('bad_signature', 'Invalid signature.', 400)
    et = event['type']
    eid = event.get('id')
    obj = event['data']['object']
    # Namespace test event rows so a colliding live event ID can't silently
    # short-circuit a legitimate test event (or vice versa).
    test_eid = f'TEST:{eid}' if eid else None
    # Unlike the live webhook, the claim is taken before the handler: subscription
    # events apply the event snapshot (no re-fetch), so a concurrent duplicate
    # running late would roll back a newer event. A worker killed mid-handler
    # therefore still loses the test event. Test mode only; live is safe.
    if test_eid:
        db = get_db()
        claimed = db.execute(
            'INSERT OR IGNORE INTO stripe_events (id, type, received_at) VALUES (?, ?, ?)',
            (test_eid, f'TEST:{et}', now_ts()),
        ).rowcount
        db.commit()
        if not claimed:
            return jsonify(received=True, duplicate=True)
    try:
        _handle_test_event(et, obj)
    except Exception as e:
        app.logger.exception('TEST webhook handler error for %s: %s', et, e)
        if test_eid:
            try:
                db = get_db()
                db.execute('DELETE FROM stripe_events WHERE id = ?', (test_eid,))
                db.commit()
            except Exception:
                app.logger.exception('failed to release test idempotency claim for %s', test_eid)
        return err('handler_error', 'Test webhook handler failed; retry.', 500)
    return jsonify(received=True, mode='test')


@app.route('/api/admin/billing/test-checkout', methods=['POST'])
def admin_test_checkout():
    """Create a Stripe TEST-mode Checkout session for a given user.
    Used by the smoke test script and by the admin UI to verify the full live flow
    without charging real money. Returns a Checkout URL.
    """
    blocked = admin_gate()
    if blocked:
        return blocked
    if not _stripe_test_ready():
        return err('test_unavailable', 'Stripe test mode is not configured (STRIPE_*_TEST env vars).', 503)
    data = request.get_json(silent=True) or {}
    user_id = data.get('userId')
    plan = (data.get('plan') or 'yearly').lower()
    if plan not in ('yearly', 'monthly'):
        return err('invalid_plan', 'plan must be "yearly" or "monthly".', 400)
    if not user_id:
        return err('user_id_required', 'userId is required.', 400)
    db = get_db()
    user = db.execute('SELECT * FROM users WHERE id = ?', (user_id,)).fetchone()
    if not user:
        return err('not_found', 'User not found.', 404)
    price_id = STRIPE_PRICE_YEARLY_TEST if plan == 'yearly' else STRIPE_PRICE_MONTHLY_TEST
    # api_key is passed per call rather than swapped on the module global, which
    # would be visible to every other thread in this worker mid-request.
    try:
        # Reuse test customer if we already created one for this user.
        cust_id = user['stripe_customer_id_test']
        if not cust_id:
            cust = stripe.Customer.create(
                email=user['email'],
                metadata={'user_id': str(user['id']), 'app': 'myglpshot', 'mode': 'test'},
                api_key=STRIPE_API_KEY_TEST,
            )
            cust_id = cust.id
            db.execute('UPDATE users SET stripe_customer_id_test = ? WHERE id = ?', (cust_id, user['id']))
            db.commit()
        app_base = os.environ.get('APP_URL', 'https://app.myglpshot.com').rstrip('/')
        sess = stripe.checkout.Session.create(
            mode='subscription',
            customer=cust_id,
            line_items=[{'price': price_id, 'quantity': 1}],
            allow_promotion_codes=True,
            # Same trial decision as the live path, so a test-mode run reproduces
            # what a real customer would get rather than always granting 14 days.
            subscription_data=dict(
                _trial_terms(user),
                metadata={'user_id': str(user['id']), 'app': 'myglpshot', 'mode': 'test'},
            ),
            metadata={'user_id': str(user['id']), 'app': 'myglpshot', 'mode': 'test'},
            success_url=f'{app_base}/?billing=test-success&session_id={{CHECKOUT_SESSION_ID}}',
            cancel_url=f'{app_base}/?billing=test-canceled',
            api_key=STRIPE_API_KEY_TEST,
        )
    except stripe.StripeError as e:
        app.logger.exception('admin test-checkout failed: %s', e)
        return err('stripe_error', str(getattr(e, 'user_message', None) or 'Stripe error'), 502)
    _audit('test_checkout_created', user['id'], {'plan': plan, 'sessionId': sess.id})
    return jsonify(url=sess.url, sessionId=sess.id, mode='test')


@app.route('/api/admin/users/<int:user_id>/demote-to-free', methods=['POST'])
def admin_demote_to_free(user_id):
    """Force a user to the 'free' tier (trial expired, no premium). Used to
    create demo accounts that show the gated UI for testing."""
    blocked = admin_gate()
    if blocked:
        return blocked
    db = get_db()
    u = db.execute('SELECT * FROM users WHERE id = ?', (user_id,)).fetchone()
    if not u:
        return err('not_found', 'User not found.', 404)
    blocked = _live_subscription_block(u)
    if blocked:
        return blocked
    past = now_ts() - 86400
    db.execute(
        """UPDATE users SET subscription_status = 'free',
                            trial_ends_at = ?,
                            premium_until = NULL
           WHERE id = ?""",
        (past, user_id),
    )
    db.commit()
    _audit('demote_to_free', user_id)
    return jsonify(ok=True)


@app.route('/api/admin/users/<int:user_id>', methods=['DELETE'])
def admin_delete_user(user_id):
    """Hard-delete a user and all their associated rows. Used for cleaning up
    demo / test accounts. Cancels any active Stripe subscription first."""
    blocked = admin_gate()
    if blocked:
        return blocked
    db = get_db()
    u = db.execute('SELECT * FROM users WHERE id = ?', (user_id,)).fetchone()
    if not u:
        return err('not_found', 'User not found.', 404)
    if not _delete_user_everywhere(u):
        return err('stripe_cancel_failed',
                   'Stripe could not cancel this user\'s subscription, so the user was not deleted. '
                   'Check the server log and try again.', 502)
    _audit('delete_user', user_id, {'email': u['email']})
    return jsonify(deleted=True, email=u['email'])


@app.route('/api/admin/users/<int:user_id>/clear-test-state', methods=['POST'])
def admin_clear_test_state(user_id):
    """Wipe a user's *_test columns so the next smoke test starts clean."""
    blocked = admin_gate()
    if blocked:
        return blocked
    db = get_db()
    db.execute(
        """UPDATE users SET stripe_customer_id_test = NULL,
                            stripe_subscription_id_test = NULL,
                            test_subscription_status = NULL,
                            test_premium_until = NULL
           WHERE id = ?""",
        (user_id,),
    )
    db.commit()
    _audit('clear_test_state', user_id)
    return jsonify(ok=True)


@app.route('/api/admin/audit')
def admin_audit_list():
    blocked = admin_gate()
    if blocked:
        return blocked
    try:
        limit = max(1, min(500, int(request.args.get('limit', 100))))
    except ValueError:
        limit = 100
    rows = get_db().execute(
        'SELECT id, action, target_user_id, ip, user_agent, extra, ts FROM admin_audit ORDER BY ts DESC LIMIT ?',
        (limit,),
    ).fetchall()
    return jsonify(audit=[dict(r) for r in rows])
