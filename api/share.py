"""Doctor share links."""
import re
import secrets

from flask import jsonify, request

from config import MAX_BLOB_BYTES, SHARE_TTL_HOURS, app
from db import get_db, now_ts
from helpers import err, is_premium_now, require_user


# ---------- Doctor share links ----------
@app.route('/api/share', methods=['POST'])
def share_create():
    user = require_user()
    if not user:
        return err('unauthorized', 'Not signed in.', 401)
    if not is_premium_now(user):
        return err('premium_required', 'Doctor share links are a premium feature.', 402)
    data = request.get_json(silent=True) or {}
    iv = data.get('iv') or ''
    ct = data.get('ciphertext') or ''
    # The label is health context ("Endocrinologist, diabetes follow-up"), so the
    # server only takes it encrypted. A plaintext 'label' from an old client is ignored.
    label_enc = data.get('labelEnc') or None
    if not iv or not ct:
        return err('invalid_payload', 'Missing iv or ciphertext.')
    if len(ct) > MAX_BLOB_BYTES:
        return err('blob_too_large', f'Max {MAX_BLOB_BYTES} bytes.', 413)
    if label_enc is not None and (not isinstance(label_enc, str) or len(label_enc) > 1024):
        return err('invalid_payload', 'Bad labelEnc.')
    token = secrets.token_hex(16)
    expires = now_ts() + SHARE_TTL_HOURS * 3600
    db = get_db()
    db.execute(
        """INSERT INTO share_links (token, user_id, iv, ciphertext, created_at, expires_at, label_enc)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (token, user['id'], iv, ct, now_ts(), expires, label_enc),
    )
    db.commit()
    return jsonify(token=token, expiresAt=expires, hours=SHARE_TTL_HOURS)


@app.route('/api/share/<token>')
def share_fetch(token):
    if not re.match(r'^[a-f0-9]{32}$', token):
        return err('invalid_token', 'Bad token.', 404)
    db = get_db()
    row = db.execute('SELECT iv, ciphertext, expires_at FROM share_links WHERE token = ? AND expires_at > ?', (token, now_ts())).fetchone()
    if not row:
        return err('not_found', 'Share link expired or not found.', 404)
    db.execute('UPDATE share_links SET views = views + 1 WHERE token = ?', (token,))
    db.commit()
    # No label: anyone holding the token gets this without the k= key. The viewer
    # reads the label from inside the encrypted payload.
    return jsonify(iv=row['iv'], ciphertext=row['ciphertext'], expiresAt=row['expires_at'])


@app.route('/api/share/<token>', methods=['DELETE'])
def share_revoke(token):
    user = require_user()
    if not user:
        return err('unauthorized', 'Not signed in.', 401)
    if not re.match(r'^[a-f0-9]{32}$', token):
        return err('invalid_token', 'Bad token.', 404)
    db = get_db()
    db.execute('DELETE FROM share_links WHERE token = ? AND user_id = ?', (token, user['id']))
    db.commit()
    return jsonify(revoked=True)


@app.route('/api/share', methods=['GET'])
def share_list():
    user = require_user()
    if not user:
        return err('unauthorized', 'Not signed in.', 401)
    rows = get_db().execute(
        'SELECT token, created_at, expires_at, views, label_enc FROM share_links WHERE user_id = ? ORDER BY created_at DESC',
        (user['id'],),
    ).fetchall()
    return jsonify(links=[dict(r) for r in rows])
