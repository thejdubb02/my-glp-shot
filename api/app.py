"""My GLP Shot API — auth, E2EE sync, subscription state, doctor share links.

Privacy posture:
- Server stores: email, bcrypt(client-derived auth_token), opaque ciphertext blob.
- Server NEVER sees: password, encryption key, plaintext data.
- Client derives both auth_token and encryption_key from master password via
  PBKDF2-SHA-256 (600k iters, salt = SHA-256("myglpshot-v1:" + email)).
  See web/app/js/account.js, deriveAccountCreds().
"""
import os
import sqlite3
from contextlib import closing

from config import DB_PATH, app
from db import SCHEMA, _configure_connection
from helpers import purge_expired

# Each feature module registers its routes on `app` when imported. Imported in
# the order its section had in the old single-file app.py.
import config
import db
import helpers
import health
import auth
import sync
import share
import billing
import admin
import billing_test_mode
import push
import smart_import

# The API used to be this one file, and scripts and selftests still do
# `import app` and read names off it (app.stripe, app.now_ts, app.public_user).
# Re-export every module-level name so that keeps working.
for _m in (config, db, helpers, health, auth, sync, share, billing, admin, billing_test_mode, push, smart_import):
    globals().update({k: v for k, v in vars(_m).items() if not k.startswith('__')})
del _m


# ---------- Bootstrap ----------
def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    with closing(sqlite3.connect(DB_PATH, timeout=10.0)) as c:
        # journal_mode=WAL is persistent in the database file, so setting it here
        # applies to every later connection too.
        c.execute('PRAGMA journal_mode=WAL')
        c.execute('PRAGMA busy_timeout=10000')
        c.executescript(SCHEMA)
        # Idempotent column adds for older DBs (tolerates concurrent worker init).
        for stmt in (
            'ALTER TABLE users ADD COLUMN stripe_subscription_id TEXT',
            'ALTER TABLE users ADD COLUMN stripe_customer_id_test TEXT',
            'ALTER TABLE users ADD COLUMN stripe_subscription_id_test TEXT',
            'ALTER TABLE users ADD COLUMN test_subscription_status TEXT',
            'ALTER TABLE users ADD COLUMN test_premium_until INTEGER',
            'ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0',
            # Signup attribution. Without these, "where did this user come from?"
            # is unanswerable after the fact: the marketing site is Cloudflare-
            # fronted so origin logs never see the original referrer, and logs
            # rotate away long before the question gets asked.
            'ALTER TABLE users ADD COLUMN signup_referrer TEXT',
            'ALTER TABLE users ADD COLUMN signup_landing TEXT',
            'ALTER TABLE users ADD COLUMN signup_utm_source TEXT',
            'ALTER TABLE users ADD COLUMN signup_utm_medium TEXT',
            'ALTER TABLE users ADD COLUMN signup_utm_campaign TEXT',
            # Set while a subscription is still running but will not renew (cancelled
            # in the billing portal). Without it a cancelled trial still read
            # "Subscribed, first payment on ...".
            'ALTER TABLE users ADD COLUMN cancel_at_period_end INTEGER NOT NULL DEFAULT 0',
            'ALTER TABLE share_links ADD COLUMN label_enc TEXT',
        ):
            try:
                c.execute(stmt)
            except sqlite3.OperationalError:
                pass
        # Labels written before issue #25 are plaintext health context. Drop them
        # rather than re-encrypt: the server has no key, and links live 24 h, so
        # the cost is a missing label on a link that expires within a day.
        c.execute('UPDATE share_links SET label = NULL WHERE label IS NOT NULL')
        c.commit()
        # Sweep expired rows at boot so retention doesn't depend on anyone
        # remembering to hit the admin endpoint.
        try:
            _configure_connection(c)
            purge_expired(c)
        except Exception as e:  # never block startup on housekeeping
            print(f'[init_db] purge skipped: {e}')


init_db()


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8080, debug=False)
