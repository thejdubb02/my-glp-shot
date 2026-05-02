#!/usr/bin/env python3
"""List all users in the My GLP Shot DB.

Usage:
    sudo python3 scripts/list-users.py
"""
import os
import sqlite3
import sys
import time
from datetime import datetime

DEFAULT_DB = '/var/lib/docker/volumes/docker_mgs-data/_data/api.db'


def main():
    db_path = os.environ.get('MGS_DB_PATH', DEFAULT_DB)
    if not os.path.exists(db_path):
        print(f'DB not found at {db_path}', file=sys.stderr); sys.exit(1)
    db = sqlite3.connect(db_path)
    db.row_factory = sqlite3.Row
    rows = db.execute('SELECT * FROM users ORDER BY created_at DESC').fetchall()
    if not rows:
        print('(no users)'); return
    print(f'{"id":<4} {"email":<32} {"status":<10} {"trial_ends":<20} {"premium_until":<20} created')
    print('-' * 110)
    now = int(time.time())
    for r in rows:
        te = datetime.fromtimestamp(r['trial_ends_at']).strftime('%Y-%m-%d %H:%M') if r['trial_ends_at'] else '—'
        pu = datetime.fromtimestamp(r['premium_until']).strftime('%Y-%m-%d %H:%M') if r['premium_until'] else '—'
        ca = datetime.fromtimestamp(r['created_at']).strftime('%Y-%m-%d %H:%M') if r['created_at'] else '—'
        print(f'{r["id"]:<4} {r["email"]:<32} {r["subscription_status"]:<10} {te:<20} {pu:<20} {ca}')
    print('-' * 110)
    print(f'Total: {len(rows)} users')


if __name__ == '__main__':
    main()
