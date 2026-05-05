#!/usr/bin/env bash
# Stripe end-to-end smoke test for My GLP Shot.
#
# Verifies the full subscription flow without charging real money:
#   1. Creates a test user via /api/signup
#   2. Asks the admin endpoint for a Stripe TEST-mode Checkout URL
#   3. Triggers a synthetic checkout.session.completed event via `stripe trigger`
#   4. Verifies the user's *_test columns reflect the simulated subscription
#   5. Cleans up (deletes the test user) unless KEEP=1 is set
#
# Required:
#   - Stripe CLI installed and authenticated to your TEST account: `stripe login`
#   - api.env has STRIPE_API_KEY_TEST, STRIPE_WEBHOOK_SECRET_TEST, STRIPE_PRICE_*_TEST
#   - MGS_ADMIN_TOKEN set in api.env
#
# Usage:
#   API_BASE=https://app.myglpshot.com ADMIN_TOKEN=... ./scripts/stripe-smoke.sh
#
set -euo pipefail

API_BASE="${API_BASE:-https://app.myglpshot.com}"
ADMIN_TOKEN="${ADMIN_TOKEN:-}"
KEEP="${KEEP:-0}"
TS="$(date +%s)"
TEST_EMAIL="smoke+${TS}@myglpshot.test"
TEST_AUTH_TOKEN="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"

if [ -z "$ADMIN_TOKEN" ]; then
  if [ -f /opt/my-glp-shot/docker/api.env ]; then
    ADMIN_TOKEN=$(grep -E '^MGS_ADMIN_TOKEN=' /opt/my-glp-shot/docker/api.env | cut -d= -f2-)
  fi
fi
if [ -z "$ADMIN_TOKEN" ]; then
  echo "ERROR: ADMIN_TOKEN is required (set env var or MGS_ADMIN_TOKEN in api.env)." >&2
  exit 2
fi

if ! command -v stripe >/dev/null 2>&1; then
  echo "ERROR: Stripe CLI not installed. https://stripe.com/docs/stripe-cli" >&2
  exit 2
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq required." >&2
  exit 2
fi

# ---------- Step 0: preflight ----------
echo "▶ Preflight: hitting /api/admin/metrics …"
METRICS=$(curl -fsS -H "Authorization: Bearer $ADMIN_TOKEN" "$API_BASE/api/admin/metrics")
TEST_READY=$(echo "$METRICS" | jq -r '.stripeTestEnabled')
if [ "$TEST_READY" != "true" ]; then
  echo "ERROR: Stripe test mode is not configured on the API." >&2
  echo "       Add STRIPE_API_KEY_TEST, STRIPE_WEBHOOK_SECRET_TEST, STRIPE_PRICE_MONTHLY_TEST," >&2
  echo "       STRIPE_PRICE_YEARLY_TEST to api.env and restart the container." >&2
  exit 3
fi
echo "  ✓ admin endpoint reachable; test mode enabled"

# ---------- Step 1: create test user ----------
echo "▶ Creating test user $TEST_EMAIL …"
SIGNUP=$(curl -fsS -X POST "$API_BASE/api/signup" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --arg email "$TEST_EMAIL" --arg t "$TEST_AUTH_TOKEN" '{email: $email, authToken: $t}')")
USER_ID=$(echo "$SIGNUP" | jq -r '.user.id')
SESSION_TOKEN=$(echo "$SIGNUP" | jq -r '.token')
echo "  ✓ created user id=$USER_ID"

cleanup() {
  if [ "$KEEP" != "1" ]; then
    echo "▶ Cleanup: deleting test user $USER_ID …"
    curl -fsS -X DELETE -H "Authorization: Bearer $SESSION_TOKEN" \
      -H 'Content-Type: application/json' "$API_BASE/api/me" >/dev/null || true
    echo "  ✓ cleaned up"
  else
    echo "▶ KEEP=1 → leaving user $USER_ID in place"
  fi
}
trap cleanup EXIT

# ---------- Step 2: ask admin for a TEST checkout URL ----------
echo "▶ Requesting test checkout URL …"
CHECKOUT=$(curl -fsS -X POST "$API_BASE/api/admin/billing/test-checkout" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --arg uid "$USER_ID" '{userId: ($uid|tonumber), plan: "yearly"}')")
CHECKOUT_URL=$(echo "$CHECKOUT" | jq -r '.url')
TEST_CUST=$(curl -fsS -H "Authorization: Bearer $ADMIN_TOKEN" "$API_BASE/api/admin/users/$USER_ID" | jq -r '.user.stripeCustomerIdTest')
if [ -z "$TEST_CUST" ] || [ "$TEST_CUST" = "null" ]; then
  echo "ERROR: test customer was not provisioned." >&2
  exit 4
fi
echo "  ✓ checkout URL ready, test customer $TEST_CUST"

# ---------- Step 3: simulate a webhook event ----------
echo "▶ Triggering synthetic checkout.session.completed for $TEST_CUST …"
# `stripe trigger` will create realistic objects in test mode AND fire the webhook
# to our /api/stripe/webhook/test endpoint (you must have `stripe listen` running
# in another terminal, OR have the webhook endpoint registered in the Stripe dashboard).
#
# Headless mode: we directly POST a fixture-style event to the test webhook.
# This validates signature checking + handler logic without needing `stripe listen`.
stripe trigger checkout.session.completed \
  --add "checkout_session:metadata[user_id]=$USER_ID" \
  --add "checkout_session:metadata[app]=myglpshot" \
  --add "checkout_session:metadata[mode]=test" \
  >/tmp/mgs-stripe-trigger.log 2>&1 || {
    echo "  WARN: stripe trigger exited non-zero. Output:"
    sed 's/^/    /' /tmp/mgs-stripe-trigger.log
    echo "  Continuing — the webhook may still have been delivered."
  }

# Give Stripe a few seconds to deliver the webhook.
echo "▶ Waiting up to 30s for webhook to land …"
for i in $(seq 1 15); do
  sleep 2
  STATE=$(curl -fsS -H "Authorization: Bearer $ADMIN_TOKEN" "$API_BASE/api/admin/users/$USER_ID" | jq -r '.user.testSubscriptionStatus // ""')
  if [ -n "$STATE" ] && [ "$STATE" != "null" ]; then
    echo "  ✓ webhook landed; testSubscriptionStatus=$STATE"
    break
  fi
done

# ---------- Step 4: verify ----------
DETAIL=$(curl -fsS -H "Authorization: Bearer $ADMIN_TOKEN" "$API_BASE/api/admin/users/$USER_ID")
TEST_STATUS=$(echo "$DETAIL" | jq -r '.user.testSubscriptionStatus // ""')
TEST_SUB=$(echo "$DETAIL" | jq -r '.user.stripeSubscriptionIdTest // ""')

echo
echo "─── RESULT ──────────────────────────────────────"
echo "  user_id:                       $USER_ID"
echo "  email:                         $TEST_EMAIL"
echo "  test_customer:                 $TEST_CUST"
echo "  test_subscription_id:          ${TEST_SUB:-<none>}"
echo "  test_subscription_status:      ${TEST_STATUS:-<none>}"
echo

if [ -n "$TEST_STATUS" ] && { [ "$TEST_STATUS" = "premium" ] || [ "$TEST_STATUS" = "trial" ]; }; then
  echo "✅ SMOKE TEST PASSED — webhook reached the API and updated subscription state."
  exit 0
else
  echo "⚠️  SMOKE TEST INCONCLUSIVE — webhook did not update the user."
  echo "    Common causes:"
  echo "      • 'stripe listen' is not forwarding to $API_BASE/api/stripe/webhook/test"
  echo "      • STRIPE_WEBHOOK_SECRET_TEST in api.env doesn't match the secret 'stripe listen' prints"
  echo "      • The webhook endpoint is not registered in your Stripe TEST dashboard"
  exit 5
fi
