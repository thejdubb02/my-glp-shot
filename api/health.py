"""Health check and the admin retention purge."""
from flask import jsonify

from config import app
from db import get_db, now_ts
from helpers import purge_expired
from admin import _audit, admin_gate


# ---------- Health ----------
@app.route('/api/health')
def health():
    """Liveness + a real database read, so a wedged DB fails the healthcheck."""
    try:
        get_db().execute('SELECT 1').fetchone()
    except Exception as e:
        app.logger.exception('health check DB probe failed: %s', e)
        return jsonify(ok=False, error='db_unavailable'), 503
    return jsonify(ok=True, ts=now_ts())


@app.route('/api/admin/purge', methods=['POST'])
def admin_purge():
    blocked = admin_gate()
    if blocked:
        return blocked
    deleted = purge_expired()
    _audit('purge_expired', None, deleted)
    return jsonify(ok=True, deleted=deleted)
