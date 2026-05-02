#!/usr/bin/env python3
"""List all users in the My GLP Shot DB.

Usage:
    sudo python3 scripts/list-users.py            # all users, newest first
    sudo python3 scripts/list-users.py --premium  # only premium / lifetime
    sudo python3 scripts/list-users.py --trial    # only active trials
    sudo python3 scripts/list-users.py <email>    # single user
"""
import argparse
import os
import sqlite3
import sys
import time
from datetime import datetime

DEFAULT_DB = '/var/lib/docker/volumes/docker_mgs-data/_data/api.db'


def fmt_ts(ts):
    return datetime.fromtimestamp(ts).strftime('%Y-%m-%d %H:%M') if ts else '—'


def fmt_status(row, now):
    s = row['subscription_status']
    if s == 'lifetime':
        return 'LIFETIME 🌟'
    if s == 'premium':
        if row['premium_until'] and row['premium_until'] > now:
            days = (row['premium_until'] - now) / 86400
            return f'PREMIUM ({days:.0f}d left)'
        return 'PREMIUM (lapsed)'
    if s == 'trial':
        if row['trial_ends_at'] and row['trial_ends_at'] > now:
            days = (row['trial_ends_at'] - now) / 86400
            return f'TRIAL ({days:.0f}d left)'
        return 'TRIAL (expired)'
    return s.upper()


def main():
    p = argparse.ArgumentParser()
    p.add_argument('email_or_filter', nargs='?',
                   help='Email substring to filter, or omit for all.')
    p.add_argument('--premium', action='store_true', help='Only paying / lifetime users')
    p.add_argument('--trial', action='store_true', help='Only active trial users')
    p.add_argument('--db', default=os.environ.get('MGS_DB_PATH', DEFAULT_DB))
    args = p.parse_args()

    if not os.path.exists(args.db):
        print(f'DB not found at {args.db}', file=sys.stderr); sys.exit(1)
    db = sqlite3.connect(args.db)
    db.row_factory = sqlite3.Row
    rows = db.execute('SELECT * FROM users ORDER BY created_at DESC').fetchall()
    now = int(time.time())

    if args.email_or_filter:
        rows = [r for r in rows if args.email_or_filter.lower() in r['email'].lower()]
    if args.premium:
        rows = [r for r in rows if r['subscription_status'] in ('premium', 'lifetime')
                and (r['subscription_status'] == 'lifetime'
                     or (r['premium_until'] and r['premium_until'] > now))]
    if args.trial:
        rows = [r for r in rows if r['subscription_status'] == 'trial'
                and r['trial_ends_at'] and r['trial_ends_at'] > now]

    if not rows:
        print('(no users match)'); return

    fmt = '{:<4} {:<32} {:<22} {:<11} {:<16}'
    print(fmt.format('id', 'email', 'status', 'stripe', 'created'))
    print('-' * 90)
    for r in rows:
        stripe_id = (r['stripe_customer_id'] or '')[:10] or '—'
        print(fmt.format(
            r['id'],
            r['email'][:32],
            fmt_status(r, now)[:22],
            stripe_id,
            fmt_ts(r['created_at']),
        ))
    print('-' * 90)
    print(f'Total: {len(rows)}')


if __name__ == '__main__':
    main()
