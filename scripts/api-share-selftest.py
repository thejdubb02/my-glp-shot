#!/usr/bin/env python3
"""Offline selftest for doctor share labels (issue #25).

Imports api/app.py against a temp SQLite DB and drives the share routes with the
Flask test client. The unauthenticated GET /api/share/<token> must never return
a plaintext label, the server must not store one even if an old client sends
it, and labels written before the fix must be gone after a restart.
Run with a venv built from api/requirements.txt:

    /tmp/v/bin/python scripts/api-share-selftest.py
"""
import os
import sys
import tempfile

tmp = tempfile.mkdtemp(prefix='mgs-share-')
os.environ.update(
    MGS_DB=os.path.join(tmp, 'api.db'),
    STRIPE_API_KEY='sk_dummy',
    STRIPE_WEBHOOK_SECRET='whsec_dummy',
    MATTERMOST_WEBHOOK_URL='',
)
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'api'))
import app as api  # noqa: E402

LABEL = 'Dr. Smith - April visit'
client = api.app.test_client()
api.require_user = lambda: {'id': 1}
api.is_premium_now = lambda _u: True


def db():
    return api.sqlite3.connect(os.environ['MGS_DB'])


def create(**extra):
    r = client.post('/api/share', json={'iv': 'aXY=', 'ciphertext': 'Y3Q=', **extra})
    assert r.status_code == 200, r.get_json()
    return r.get_json()['token']


def test_fetch_never_returns_label():
    token = create(label=LABEL)  # an old cached client still sends plaintext
    j = client.get(f'/api/share/{token}').get_json()
    assert 'label' not in j, f'share_fetch returned label: {j}'
    assert LABEL not in str(j), f'plaintext label in fetch: {j}'


def test_server_does_not_store_plaintext():
    create(label=LABEL)
    with db() as c:
        rows = [r for r in c.execute('SELECT * FROM share_links') if LABEL in str(r)]
    assert not rows, f'plaintext label stored: {rows}'


def test_owner_list_returns_ciphertext():
    token = create(labelEnc='aXY=.c2VhbGVk')
    links = client.get('/api/share').get_json()['links']
    row = next(l for l in links if l['token'] == token)
    assert row['label_enc'] == 'aXY=.c2VhbGVk', row
    assert 'aXY=.c2VhbGVk' not in str(client.get(f'/api/share/{token}').get_json())


def test_old_plaintext_rows_dropped_at_boot():
    with db() as c:
        c.execute("""INSERT INTO share_links (token, user_id, iv, ciphertext, created_at, expires_at, label)
                     VALUES (?, 1, 'aXY=', 'Y3Q=', 0, 4000000000, ?)""", ('cd' * 16, LABEL))
    api.init_db()
    j = client.get(f'/api/share/{"cd" * 16}').get_json()
    assert j.get('ciphertext') == 'Y3Q=', f'old link no longer opens: {j}'
    with db() as c:
        assert c.execute('SELECT label FROM share_links WHERE token = ?', ('cd' * 16,)).fetchone()[0] is None
    assert client.get('/api/share').status_code == 200


def test_bad_label_enc_refused():
    r = client.post('/api/share', json={'iv': 'aXY=', 'ciphertext': 'Y3Q=', 'labelEnc': 'x' * 2000})
    assert r.status_code == 400, r.status_code


failed = 0
for name, fn in list(globals().items()):
    if name.startswith('test_') and callable(fn):
        try:
            fn()
            print(f'ok   {name}')
        except Exception as e:
            failed += 1
            print(f'FAIL {name}: {e}')
print(f'{"FAILED" if failed else "PASSED"} ({failed} failing)')
sys.exit(1 if failed else 0)
