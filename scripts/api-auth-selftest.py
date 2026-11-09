#!/usr/bin/env python3
"""Offline selftest: a login that verified the old password must not leave a
session behind after a password reset (issue #24).

Imports api/app.py against a temp SQLite DB and drives /api/login with the
Flask test client. No network. Run with a venv built from api/requirements.txt:

    /tmp/v/bin/python scripts/api-auth-selftest.py
"""
import os
import sqlite3
import sys
import tempfile

tmp = tempfile.mkdtemp(prefix='mgs-auth-')
os.environ.update(MGS_DB=os.path.join(tmp, 'api.db'), MATTERMOST_WEBHOOK_URL='')
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'api'))
import app as api  # noqa: E402

TOKEN = 'a' * 64
EMAIL = 'a@example.com'
real_checkpw = api.bcrypt.checkpw
client = api.app.test_client()


def db():
    return sqlite3.connect(os.environ['MGS_DB'])


def sessions():
    with db() as c:
        return c.execute('SELECT COUNT(*) FROM sessions').fetchone()[0]


def login():
    return client.post('/api/login', json={'email': EMAIL, 'authToken': TOKEN})


failures = 0


def check(name, cond):
    global failures
    print(('PASS ' if cond else 'FAIL ') + name)
    failures += 0 if cond else 1


with db() as c:
    c.execute('INSERT INTO users (id, email, password_hash, created_at, subscription_status) '
              "VALUES (1, ?, ?, 0, 'free')",
              (EMAIL, api.bcrypt.hashpw(TOKEN.encode(), api.bcrypt.gensalt(rounds=4)).decode()))

r = login()
check('normal login returns 200 and a token', r.status_code == 200 and r.get_json().get('token'))
check('normal login creates one session', sessions() == 1)

with db() as c:
    c.execute('DELETE FROM sessions')


def checkpw_then_reset(pw, hashed):
    """Verify, then let a password reset commit before the session insert."""
    ok = real_checkpw(pw, hashed)
    with db() as c:
        c.execute('UPDATE users SET password_hash = ? WHERE id = 1', ('$2b$04$reset',))
        c.execute('DELETE FROM sessions WHERE user_id = 1')
    return ok


api.bcrypt.checkpw = checkpw_then_reset
r = login()
api.bcrypt.checkpw = real_checkpw
check('login racing a reset is refused', r.status_code == 401
      and r.get_json().get('error') == 'invalid_credentials')
check('login racing a reset leaves no session', sessions() == 0)

sys.exit(1 if failures else 0)
