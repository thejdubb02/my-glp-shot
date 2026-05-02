#!/usr/bin/env python3
"""Grant lifetime premium to a user.

Usage:
    sudo python3 scripts/grant-premium.py <email> [--monthly | --annual | --lifetime]

Defaults to lifetime. Run on VPS1 with access to the Docker volume.
"""
import argparse
import os
import sqlite3
import sys
import time

DEFAULT_DB = '/var/lib/docker/volumes/docker_mgs-data/_data/api.db'


def main():
    p = argparse.ArgumentParser()
    p.add_argument('email')
    p.add_argument('--monthly', action='store_true', help='30-day premium')
    p.add_argument('--annual', action='store_true', help='365-day premium')
    p.add_argument('--lifetime', action='store_true', help='Permanent (default)')
    p.add_argument('--db', default=os.environ.get('MGS_DB_PATH', DEFAULT_DB))
    args = p.parse_args()

    if not os.path.exists(args.db):
        print(f'DB not found at {args.db}', file=sys.stderr); sys.exit(1)

    if args.monthly:
        status, until = 'premium', int(time.time()) + 30 * 86400
        label = '30 days'
    elif args.annual:
        status, until = 'premium', int(time.time()) + 365 * 86400
        label = '365 days'
    else:
        status, until = 'lifetime', None
        label = 'lifetime'

    db = sqlite3.connect(args.db)
    db.row_factory = sqlite3.Row
    user = db.execute('SELECT id, email FROM users WHERE email = ?', (args.email.lower(),)).fetchone()
    if not user:
        print(f'No user with email {args.email}', file=sys.stderr); sys.exit(2)

    db.execute(
        'UPDATE users SET subscription_status = ?, premium_until = ? WHERE id = ?',
        (status, until, user['id']),
    )
    db.commit()
    print(f'✓ Granted {label} premium to {user["email"]} (id={user["id"]})')


if __name__ == '__main__':
    main()
