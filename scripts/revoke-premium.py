#!/usr/bin/env python3
"""Revoke comp / lifetime premium from a user.

Usage:
    sudo python3 scripts/revoke-premium.py <email>            # downgrade to free now
    sudo python3 scripts/revoke-premium.py <email> --to-trial # restart 14d trial

Note: this only affects the local users table, not Stripe. If the user has a paid
Stripe subscription, cancel it via the Stripe dashboard or have them open
Settings -> Manage subscription.
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
    p.add_argument('--to-trial', action='store_true', help='Reset to a fresh 14-day trial')
    p.add_argument('--db', default=os.environ.get('MGS_DB_PATH', DEFAULT_DB))
    args = p.parse_args()

    if not os.path.exists(args.db):
        print(f'DB not found at {args.db}', file=sys.stderr); sys.exit(1)
    db = sqlite3.connect(args.db)
    db.row_factory = sqlite3.Row
    user = db.execute('SELECT id, email, subscription_status FROM users WHERE email = ?',
                      (args.email.lower(),)).fetchone()
    if not user:
        print(f'No user with email {args.email}', file=sys.stderr); sys.exit(2)

    if args.to_trial:
        trial_ends = int(time.time()) + 14 * 86400
        db.execute(
            "UPDATE users SET subscription_status='trial', premium_until=NULL, trial_ends_at=? WHERE id=?",
            (trial_ends, user['id']),
        )
        msg = f'reset to fresh 14-day trial'
    else:
        db.execute(
            "UPDATE users SET subscription_status='free', premium_until=NULL WHERE id=?",
            (user['id'],),
        )
        msg = 'downgraded to free'
    db.commit()
    print(f'✓ {user["email"]}: {msg} (was {user["subscription_status"]})')


if __name__ == '__main__':
    main()
