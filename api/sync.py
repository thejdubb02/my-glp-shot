"""E2EE sync blob routes, plus the legacy lookup_id sync routes."""
from flask import jsonify, request

from config import LOOKUP_RE, MAX_BLOB_BYTES, app
from db import get_db, now_ts
from helpers import err, require_user


# ---------- E2EE sync (account-bound, requires login) ----------
@app.route('/api/me/sync', methods=['GET'])
def sync_get():
    user = require_user()
    if not user:
        return err('unauthorized', 'Not signed in.', 401)
    row = get_db().execute('SELECT iv, ciphertext, updated_at FROM sync_blobs WHERE user_id = ?', (user['id'],)).fetchone()
    if not row:
        return jsonify(exists=False)
    return jsonify(exists=True, iv=row['iv'], ciphertext=row['ciphertext'], updatedAt=row['updated_at'])


@app.route('/api/me/sync', methods=['PUT'])
def sync_put():
    user = require_user()
    if not user:
        return err('unauthorized', 'Not signed in.', 401)
    data = request.get_json(silent=True) or {}
    iv = data.get('iv') or ''
    ct = data.get('ciphertext') or ''
    if not iv or not ct:
        return err('invalid_payload', 'Missing iv or ciphertext.')
    if len(ct) > MAX_BLOB_BYTES:
        return err('blob_too_large', f'Max {MAX_BLOB_BYTES} bytes.', 413)
    # baseUpdatedAt is the updatedAt this device last saw. If the stored blob is
    # newer, another device pushed since: refuse, so the client pulls and merges
    # first. null means "never saw one", so it only writes when no blob exists.
    # A missing field keeps last-write-wins for old clients.
    legacy = 'baseUpdatedAt' not in data
    base = data.get('baseUpdatedAt')
    if base is not None and (isinstance(base, bool) or not isinstance(base, int)):
        return err('invalid_payload', 'baseUpdatedAt must be an integer.')
    db = get_db()
    # One statement, so check and write are atomic. updated_at only ever goes up
    # (stored + 1 within the same second), so two pushes never share a version.
    cur = db.execute(
        """INSERT INTO sync_blobs (user_id, iv, ciphertext, updated_at, size)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET iv=excluded.iv, ciphertext=excluded.ciphertext,
             updated_at=MAX(excluded.updated_at, sync_blobs.updated_at + 1), size=excluded.size
           WHERE ? OR sync_blobs.updated_at <= ?""",
        (user['id'], iv, ct, now_ts(), len(ct), legacy, base),
    )
    stored = db.execute('SELECT updated_at FROM sync_blobs WHERE user_id = ?', (user['id'],)).fetchone()['updated_at']
    db.commit()
    if cur.rowcount == 0:
        return jsonify(error='stale', message='Another device backed up newer data.', updatedAt=stored), 409
    return jsonify(updatedAt=stored)


@app.route('/api/me/sync', methods=['DELETE'])
def sync_delete():
    user = require_user()
    if not user:
        return err('unauthorized', 'Not signed in.', 401)
    db = get_db()
    db.execute('DELETE FROM sync_blobs WHERE user_id = ?', (user['id'],))
    db.commit()
    return jsonify(deleted=True)


# ---------- Legacy lookup_id sync (back-compat for jdubb-style accounts) ----------
# Path stays /api/sync/<lookup_id> so existing PWAs using `api/sync/<id>` keep working.
@app.route('/api/sync/<lookup_id>', methods=['GET'])
def legacy_get(lookup_id):
    if not LOOKUP_RE.match(lookup_id):
        return err('invalid_lookup_id', 'Bad lookup id.', 400)
    row = get_db().execute(
        'SELECT iv, ciphertext, updated_at FROM legacy_blobs WHERE lookup_id = ?', (lookup_id,)
    ).fetchone()
    if not row:
        return err('not_found', 'No data for this lookup id.', 404)
    return jsonify(iv=row['iv'], ciphertext=row['ciphertext'], updated_at=row['updated_at'])


# Writes to this path are CLOSED (2026-08-09). The lookup_id is the only
# credential, it travels in the URL — so it lands in access logs, browser
# history and referrer headers — and there was no ownership check, meaning
# anyone who ever saw one could overwrite or destroy that person's cloud copy.
#
# Read stays open so anyone still holding a legacy id can recover their data
# into an account; a read exposes ciphertext they cannot decrypt without the
# passphrase. Rows untouched for LEGACY_BLOB_TTL_DAYS are swept by purge_expired.
@app.route('/api/sync/<lookup_id>', methods=['PUT', 'DELETE'])
def legacy_write_closed(lookup_id):
    return err(
        'legacy_sync_closed',
        'Legacy sync is read-only. Sign in with an account to back up — open the app '
        'and use "Restore from legacy sync" to bring your old data across.',
        410,
    )


@app.route('/api/sync/<lookup_id>/exists')
def legacy_exists(lookup_id):
    if not LOOKUP_RE.match(lookup_id):
        return err('invalid_lookup_id', 'Bad lookup id.', 400)
    row = get_db().execute(
        'SELECT updated_at FROM legacy_blobs WHERE lookup_id = ?', (lookup_id,)
    ).fetchone()
    if not row:
        return jsonify(exists=False)
    return jsonify(exists=True, updated_at=row['updated_at'])
