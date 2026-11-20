"""SQLite schema and per-request connection."""
import sqlite3
import time

from flask import g

from config import DB_PATH, app


# ---------- DB ----------
SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    email               TEXT UNIQUE NOT NULL,
    password_hash       TEXT NOT NULL,
    created_at          INTEGER NOT NULL,
    email_verified_at   INTEGER,
    subscription_status TEXT NOT NULL DEFAULT 'trial',
    trial_ends_at       INTEGER,
    premium_until       INTEGER,
    stripe_customer_id  TEXT,
    stripe_subscription_id TEXT,
    stripe_customer_id_test     TEXT,
    stripe_subscription_id_test TEXT,
    test_subscription_status    TEXT,
    test_premium_until          INTEGER,
    notes               TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
    token       TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    user_agent  TEXT,
    last_seen   INTEGER
);
CREATE TABLE IF NOT EXISTS sync_blobs (
    user_id     INTEGER PRIMARY KEY,
    iv          TEXT NOT NULL,
    ciphertext  TEXT NOT NULL,
    updated_at  INTEGER NOT NULL,
    size        INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS share_links (
    token       TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL,
    iv          TEXT NOT NULL,
    ciphertext  TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    views       INTEGER NOT NULL DEFAULT 0,
    label       TEXT,               -- legacy plaintext label, always NULL now (issue #25)
    label_enc   TEXT                -- owner's label, AES-GCM under the account key, "iv.ct"
);
CREATE TABLE IF NOT EXISTS password_resets (
    token       TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    used_at     INTEGER
);
-- Per-identifier throttling. nginx already limits by IP, which does nothing
-- against a spread-out attempt on ONE account from many addresses, and nothing
-- to stop someone's inbox being flooded with reset mails.
CREATE TABLE IF NOT EXISTS auth_attempts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    scope       TEXT NOT NULL,      -- 'login' | 'forgot'
    identifier  TEXT NOT NULL,      -- normalised email
    ts          INTEGER NOT NULL,
    ok          INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS stripe_events (
    id          TEXT PRIMARY KEY,
    type        TEXT NOT NULL,
    received_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS legacy_blobs (
    lookup_id   TEXT PRIMARY KEY,
    iv          TEXT NOT NULL,
    ciphertext  TEXT NOT NULL,
    updated_at  INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    size        INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_audit (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    action          TEXT NOT NULL,
    target_user_id  INTEGER,
    ip              TEXT,
    user_agent      TEXT,
    extra           TEXT,
    ts              INTEGER NOT NULL
);
-- Web Push. Deliberately minimal-disclosure: the server stores WHEN to send and
-- a generic string, never what the reminder is about. The client computes fire
-- times locally from data the server cannot read, and uploads only timestamps.
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    endpoint    TEXT UNIQUE NOT NULL,
    p256dh      TEXT NOT NULL,
    auth        TEXT NOT NULL,
    user_agent  TEXT,
    created_at  INTEGER NOT NULL,
    last_ok_at  INTEGER,
    fail_count  INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS push_reminders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    kind        TEXT NOT NULL,          -- 'shot' | 'daily:<key>'; no medication, no dose
    fire_at     INTEGER NOT NULL,
    title       TEXT NOT NULL,          -- from a fixed server-side allow-list
    body        TEXT NOT NULL,
    url         TEXT,
    sent_at     INTEGER,
    created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_audit_ts_idx ON admin_audit(ts DESC);
CREATE INDEX IF NOT EXISTS push_subs_user_idx ON push_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS push_rem_due_idx   ON push_reminders(fire_at) WHERE sent_at IS NULL;
CREATE INDEX IF NOT EXISTS push_rem_user_idx  ON push_reminders(user_id);
-- Every lookup below ran as a full table scan before these existed.
CREATE INDEX IF NOT EXISTS sessions_user_idx      ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx   ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS share_links_user_idx   ON share_links(user_id);
CREATE INDEX IF NOT EXISTS share_links_exp_idx    ON share_links(expires_at);
CREATE INDEX IF NOT EXISTS pw_resets_user_idx     ON password_resets(user_id);
CREATE INDEX IF NOT EXISTS pw_resets_exp_idx      ON password_resets(expires_at);
CREATE INDEX IF NOT EXISTS users_customer_idx     ON users(stripe_customer_id);
CREATE INDEX IF NOT EXISTS users_customer_test_idx ON users(stripe_customer_id_test);
CREATE INDEX IF NOT EXISTS users_created_idx      ON users(created_at);
CREATE INDEX IF NOT EXISTS stripe_events_ts_idx   ON stripe_events(received_at);
CREATE INDEX IF NOT EXISTS auth_attempts_idx      ON auth_attempts(scope, identifier, ts);
"""


def _configure_connection(db):
    """Pragmas that make SQLite safe under gunicorn's 2 workers x 4 threads.

    Without WAL every reader blocks every writer, and without a busy timeout a
    contended write fails instantly with 'database is locked' instead of waiting
    its turn. Both are per-connection settings, so they belong here rather than
    in the schema.
    """
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA journal_mode=WAL')
    db.execute('PRAGMA busy_timeout=5000')
    db.execute('PRAGMA synchronous=NORMAL')
    db.execute('PRAGMA foreign_keys=ON')
    return db


def get_db():
    db = getattr(g, '_db', None)
    if db is None:
        # The schema is created once at boot by init_db(). Re-running it on every
        # request re-parsed 8 CREATE statements and forced an implicit commit
        # before each one, for no benefit.
        db = g._db = _configure_connection(sqlite3.connect(DB_PATH, timeout=5.0))
    return db


@app.teardown_appcontext
def close_db(_):
    db = getattr(g, '_db', None)
    if db is not None:
        db.close()


def now_ts():
    return int(time.time())
