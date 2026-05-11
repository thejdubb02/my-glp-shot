#!/usr/bin/env python3
"""Flip is_admin=1 on a My GLP Shot user account.

Usage:
  promote-admin.py <email>            # promote
  promote-admin.py --revoke <email>   # demote

Run on the host where /data/api.db lives, or set MGS_DB to the DB path.
"""
import argparse
import os
import sqlite3
import sys

DB_PATH = os.environ.get('MGS_DB', '/data/api.db')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('email')
    ap.add_argument('--revoke', action='store_true', help='Set is_admin=0 instead of 1')
    args = ap.parse_args()

    target = 1 if not args.revoke else 0
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        # Ensure the column exists (idempotent — survives running before app boots).
        try:
            conn.execute('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0')
            conn.commit()
        except sqlite3.OperationalError:
            pass

        row = conn.execute('SELECT id, email, is_admin FROM users WHERE LOWER(email) = LOWER(?)', (args.email,)).fetchone()
        if not row:
            print(f'No user with email {args.email!r}', file=sys.stderr)
            sys.exit(1)
        conn.execute('UPDATE users SET is_admin = ? WHERE id = ?', (target, row['id']))
        conn.commit()
        verb = 'promoted to admin' if target else 'demoted from admin'
        print(f'User {row["email"]} (id={row["id"]}) {verb}.')
    finally:
        conn.close()


if __name__ == '__main__':
    main()
