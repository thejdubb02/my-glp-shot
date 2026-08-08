#!/usr/bin/env python3
"""Send every reminder that has come due. Run once a minute from cron.

    docker exec my-glp-shot-api python push_dispatch.py

Deliberately a separate process rather than a thread inside the app: gunicorn
runs two workers, so an in-process scheduler would fire every reminder twice.

Claiming is done with a conditional UPDATE, so two overlapping runs (a slow one
still finishing when the next minute ticks) cannot both send the same reminder.
"""
import logging
import os
import sqlite3
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from push_send import send_to_user  # noqa: E402

DB_PATH = os.environ.get('MGS_DB', '/data/api.db')
GRACE_SECONDS = 3600   # a reminder more than an hour late is stale, not useful

logging.basicConfig(level=logging.INFO, format='[push] %(message)s')
log = logging.getLogger('push_dispatch')


def main():
    if not os.environ.get('VAPID_PRIVATE_KEY'):
        log.info('VAPID_PRIVATE_KEY unset — push not configured, nothing to do.')
        return 0
    db = sqlite3.connect(DB_PATH, timeout=10.0)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA busy_timeout=10000')
    now = int(time.time())

    due = db.execute(
        """SELECT * FROM push_reminders
           WHERE sent_at IS NULL AND fire_at <= ? AND fire_at > ?
           ORDER BY fire_at LIMIT 500""",
        (now, now - GRACE_SECONDS),
    ).fetchall()

    # Retire anything too late to be worth sending, so it can't pile up.
    stale = db.execute(
        'UPDATE push_reminders SET sent_at = ? WHERE sent_at IS NULL AND fire_at <= ?',
        (now, now - GRACE_SECONDS),
    ).rowcount
    db.commit()
    if stale:
        log.info('retired %d stale reminder(s)', stale)

    sent_total = failed_total = 0
    for r in due:
        # Claim first: the UPDATE only succeeds for whoever gets there first.
        claimed = db.execute(
            'UPDATE push_reminders SET sent_at = ? WHERE id = ? AND sent_at IS NULL',
            (now, r['id']),
        ).rowcount
        db.commit()
        if not claimed:
            continue
        sent, failed = send_to_user(db, r['user_id'], r['title'], r['body'], r['url'] or '/')
        sent_total += sent
        failed_total += failed

    if due:
        log.info('%d due — %d delivered, %d failed', len(due), sent_total, failed_total)
    db.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
