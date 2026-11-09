#!/usr/bin/env python3
"""Offline selftest for the cloud push version check (issue #23).

A push carries baseUpdatedAt, the updatedAt the device last saw. If another
device pushed since, PUT /api/me/sync must refuse with 409 and leave the stored
blob alone, so the client pulls and merges instead of overwriting.

Temp SQLite DB, stubbed session, Flask test client, no network. Run with a venv
built from api/requirements.txt:

    /tmp/v/bin/python scripts/api-sync-selftest.py
"""
import os
import sys
import tempfile

tmp = tempfile.mkdtemp(prefix='mgs-sync-')
os.environ.update(MGS_DB=os.path.join(tmp, 'api.db'), MATTERMOST_WEBHOOK_URL='')
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'api'))
import app as api  # noqa: E402

api.get_session_user = lambda: ({'id': 1}, None)
client = api.app.test_client()
clock = {'now': 1000}
api.now_ts = lambda: clock['now']


def put(ct, **extra):
    return client.put('/api/me/sync', json={'iv': 'iv', 'ciphertext': ct, **extra})


def stored():
    with api.sqlite3.connect(os.environ['MGS_DB']) as c:
        return c.execute('SELECT ciphertext, updated_at FROM sync_blobs WHERE user_id = 1').fetchone()


# First push, no blob yet: base null is fine.
r = put('a', baseUpdatedAt=None)
assert r.status_code == 200, r.get_json()
v1 = r.get_json()['updatedAt']
assert stored() == ('a', v1)

# Device B pushes on top of v1.
clock['now'] = 1005
r = put('b', baseUpdatedAt=v1)
assert r.status_code == 200, r.get_json()
v2 = r.get_json()['updatedAt']
assert v2 > v1 and stored() == ('b', v2)

# Device A still thinks the cloud is v1: refused, blob unchanged.
clock['now'] = 1010
r = put('a2', baseUpdatedAt=v1)
assert r.status_code == 409, r.status_code
assert r.get_json()['error'] == 'stale' and r.get_json()['updatedAt'] == v2
assert stored() == ('b', v2), 'stale push must not write'

# After pulling, A pushes with the matching base and succeeds.
r = put('ab', baseUpdatedAt=v2)
assert r.status_code == 200 and stored() == ('ab', r.get_json()['updatedAt'])
v3 = r.get_json()['updatedAt']

# Two pushes in the same second still get distinct versions, so a device that
# saw the first cannot overwrite the second.
r = put('c', baseUpdatedAt=v3)
v4 = r.get_json()['updatedAt']
assert r.status_code == 200 and v4 > v3, (v3, v4)
assert put('d', baseUpdatedAt=v3).status_code == 409
assert stored() == ('c', v4)

# Explicit null means "never saw a blob": refused once one exists, unlike a
# missing field. A fresh device that pulled then pushed would otherwise wipe
# whatever another device pushed in between.
r = put('fresh', baseUpdatedAt=None)
assert r.status_code == 409 and r.get_json()['updatedAt'] == v4, r.status_code
assert stored() == ('c', v4)

# Old clients (no baseUpdatedAt) keep last-write-wins.
r = put('old')
assert r.status_code == 200 and stored()[0] == 'old'

# Garbage base is rejected, not treated as "no check".
assert put('x', baseUpdatedAt='1').status_code == 400
assert put('x', baseUpdatedAt=True).status_code == 400
assert stored()[0] == 'old'

print('api-sync-selftest: ok')
