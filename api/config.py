"""Settings read from the environment, the Stripe key, and the Flask app object."""
import os
import re

import stripe
from flask import Flask


# ---------- Config ----------
DB_PATH = os.environ.get('MGS_DB', '/data/api.db')
RESEND_API_KEY = os.environ.get('RESEND_API_KEY', '')
APP_BASE_URL = os.environ.get('APP_BASE_URL', 'https://myglpshot.com')
MAIL_FROM = os.environ.get('MAIL_FROM', 'My GLP Shot <hello@myglpshot.com>')
TRIAL_DAYS = 14
SESSION_DAYS = 90
SESSION_TOUCH_INTERVAL = 300  # seconds between last_seen writes for one session
SHARE_TTL_HOURS = 24
MAX_BLOB_BYTES = 2 * 1024 * 1024  # 2 MB ciphertext cap
STRIPE_API_KEY = os.environ.get('STRIPE_API_KEY', '')
STRIPE_WEBHOOK_SECRET = os.environ.get('STRIPE_WEBHOOK_SECRET', '')
STRIPE_PRICE_MONTHLY = os.environ.get('STRIPE_PRICE_MONTHLY', '')
STRIPE_PRICE_YEARLY = os.environ.get('STRIPE_PRICE_YEARLY', '')
# Parallel test-mode Stripe keys. When set, /api/stripe/webhook/test handles
# test-mode events and admins can launch test checkouts without polluting live
# customer data. Test customer/subscription IDs live in *_test columns.
STRIPE_API_KEY_TEST = os.environ.get('STRIPE_API_KEY_TEST', '')
STRIPE_WEBHOOK_SECRET_TEST = os.environ.get('STRIPE_WEBHOOK_SECRET_TEST', '')
STRIPE_PRICE_MONTHLY_TEST = os.environ.get('STRIPE_PRICE_MONTHLY_TEST', '')
STRIPE_PRICE_YEARLY_TEST = os.environ.get('STRIPE_PRICE_YEARLY_TEST', '')
# Admin bearer token. If unset, admin endpoints are disabled.
MGS_ADMIN_TOKEN = os.environ.get('MGS_ADMIN_TOKEN', '')
# Admin is never granted at signup. It used to be, for any address listed in
# MGS_ADMIN_EMAILS, but signup does not verify the address, so whoever registered
# a listed address first became an admin over every user's data. On 2026-09-28 one
# of the two listed addresses had no account, which left admin open to anyone who
# typed it in. Promote with scripts/promote-admin.py on the box instead.
# Smart Import calls OpenRouter directly with this service's own capped child key
# (orkeys: myglpshot-import) and the @preset/smart-text job, so a retired model is
# fixed in the preset, not here. Google's own API is deliberately not reachable.
OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'
OPENROUTER_API_KEY = os.environ.get('OPENROUTER_API_KEY', '')
# Web Push (VAPID). Generate once with scripts/gen-vapid-keys.py and put both in
# docker/api.env. Without them the push endpoints report unavailable and the
# client falls back to in-page timers.
VAPID_PUBLIC_KEY = os.environ.get('VAPID_PUBLIC_KEY', '')
VAPID_PRIVATE_KEY = os.environ.get('VAPID_PRIVATE_KEY', '')
VAPID_SUBJECT = os.environ.get('VAPID_SUBJECT', 'mailto:hello@myglpshot.com')
# Umami analytics — used by the admin Traffic card. Optional; if unset the
# /api/admin/traffic endpoint returns an empty-state payload instead of erroring.
UMAMI_URL = os.environ.get('UMAMI_URL', '').rstrip('/')
UMAMI_USERNAME = os.environ.get('UMAMI_USERNAME', '')
UMAMI_PASSWORD = os.environ.get('UMAMI_PASSWORD', '')
UMAMI_WEBSITE_ID_LANDING = os.environ.get('UMAMI_WEBSITE_ID_LANDING', '')
UMAMI_WEBSITE_ID_PWA = os.environ.get('UMAMI_WEBSITE_ID_PWA', '')
# Herald (fleet notification router on vps1, tailnet only) for operator pings:
# new signups (tag `signup`, quiet) and paid conversions (tag `money`, phone).
# Herald feeds are shared with other apps, so every message names the app.
HERALD_URL = os.environ.get('HERALD_URL', 'http://100.110.232.76:8018/notify/wsg')
MGS_EMOJI = '💉'
MGS_APP_NAME = 'My GLP Shot'
if STRIPE_API_KEY:
    stripe.api_key = STRIPE_API_KEY

# Hard-fail on a misconfiguration that would let test webhook events corrupt live state.
if STRIPE_WEBHOOK_SECRET and STRIPE_WEBHOOK_SECRET_TEST and STRIPE_WEBHOOK_SECRET == STRIPE_WEBHOOK_SECRET_TEST:
    raise RuntimeError(
        'STRIPE_WEBHOOK_SECRET and STRIPE_WEBHOOK_SECRET_TEST must differ. '
        'Test and live webhook secrets must come from separate Stripe modes.'
    )

EMAIL_RE = re.compile(r'^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$')
TOKEN_RE = re.compile(r'^[a-f0-9]{32,}$')
LOOKUP_RE = re.compile(r'^[a-f0-9]{64}$')

app = Flask('app')  # 'app' keeps the logger name and root path the single-file app.py had
