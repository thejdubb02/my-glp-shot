#!/usr/bin/env python3
"""Black-box functional test for the My GLP Shot API.

Runs against a throwaway instance (see scripts/README or the deploy notes) and
asserts the behaviours that have bitten us before: signup races, sync round
trips, premium gating, webhook idempotency, retention, and concurrency under
SQLite. Exits non-zero on the first failure so it can gate a deploy.

    python3 scripts/api-selftest.py --base http://127.0.0.1:5099 --admin-token TOKEN
"""
import argparse
import json
import secrets
import sys
import threading
import urllib.error
import urllib.request

PASS, FAIL = [], []


def call(base, path, method='GET', body=None, token=None, admin=None, raw=False):
    url = f'{base}{path}'
    data = None
    headers = {'Accept': 'application/json'}
    if body is not None:
        data = json.dumps(body).encode()
        headers['Content-Type'] = 'application/json'
    if token:
        headers['Authorization'] = f'Bearer {token}'
    if admin:
        headers['Authorization'] = f'Bearer {admin}'
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            payload = r.read().decode()
            return r.status, (payload if raw else json.loads(payload or '{}'))
    except urllib.error.HTTPError as e:
        payload = e.read().decode()
        try:
            return e.code, json.loads(payload or '{}')
        except ValueError:
            return e.code, {'raw': payload[:200]}
    except Exception as e:
        return 0, {'error': str(e)}


def check(name, cond, detail=''):
    (PASS if cond else FAIL).append(name)
    print(f'{"PASS" if cond else "FAIL"}  {name}' + (f'  — {detail}' if detail and not cond else ''))


# Accounts this run created, as (email, authToken). Populated as they are made
# and torn down at the end — see the cleanup block in main(). A suite that is
# safe to point at production must not leave user rows behind when it does.
CREATED = []


def _track(email, auth):
    CREATED.append((email, auth))
    return email


def _cleanup(b, admin_token=''):
    """Delete every account this run created. Best-effort and never fails the
    run: leftover rows are untidy, but a cleanup error is not a product bug.

    Signing in as each account is enough for all but one — the throttle test
    deliberately locks its own account out, and the lockout outlives the run.
    With an admin token that last one can be removed directly; without one it is
    reported rather than hidden. It is harmless either way: reserved-domain
    addresses are excluded from the signup notification and every count."""
    removed, missed = 0, []
    for email, auth in CREATED:
        try:
            st, j = call(b, '/api/login', 'POST', {'email': email, 'authToken': auth})
            if st == 401:
                continue  # already deleted by one of the tests — nothing to do
            if st != 200:
                # 429 is the expected one: the throttle test deliberately locks
                # its own account out, and the lockout outlives the run.
                missed.append(f'{email} (login {st})')
                continue
            tok = j.get('token')
            st, _ = call(b, '/api/me', 'DELETE', token=tok)
            if st == 200:
                removed += 1
            else:
                missed.append(f'{email} (delete {st})')
        except Exception as e:
            missed.append(f'{email} ({e})')
    # Anything the login route could not reach, try again as admin.
    if missed and admin_token:
        st, j = call(b, '/api/admin/users', admin=admin_token)
        if st == 200:
            by_email = {u.get('email'): u.get('id') for u in (j.get('users') or j.get('data') or [])}
            still = []
            for entry in missed:
                email = entry.split(' ')[0]
                uid = by_email.get(email)
                if not uid:
                    still.append(entry)
                    continue
                st, _ = call(b, f'/api/admin/users/{uid}', 'DELETE', admin=admin_token)
                if st == 200:
                    removed += 1
                else:
                    still.append(f'{email} (admin delete {st})')
            missed = still
    print(f'cleanup: removed {removed} test account(s)' + (f'; could not remove {missed}' if missed else ''))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--base', default='http://127.0.0.1:5099')
    ap.add_argument('--admin-token', default='')
    args = ap.parse_args()
    b = args.base

    # --- health -------------------------------------------------------------
    st, j = call(b, '/api/health')
    check('health returns ok', st == 200 and j.get('ok') is True, f'{st} {j}')

    # --- signup -------------------------------------------------------------
    email = f'selftest-{secrets.token_hex(6)}@example.com'
    auth = secrets.token_hex(32)
    _track(email, auth)
    st, j = call(b, '/api/signup', 'POST', {'email': email, 'authToken': auth})
    check('signup succeeds', st == 200 and 'token' in j, f'{st} {j}')
    token = j.get('token')
    check('signup starts a trial', (j.get('user') or {}).get('subscriptionStatus') == 'trial', str(j))
    check('trial counts as premium', (j.get('user') or {}).get('isPremium') is True, str(j))

    # --- duplicate signup ---------------------------------------------------
    st, j = call(b, '/api/signup', 'POST', {'email': email, 'authToken': auth})
    check('duplicate signup returns 409', st == 409, f'{st} {j}')

    # Concurrent duplicate signups must all be rejected cleanly, never 500.
    race_email = f'race-{secrets.token_hex(6)}@example.com'
    codes = []
    lock = threading.Lock()
    # Whichever racer wins owns the account, so record the token that won —
    # otherwise cleanup cannot sign in to delete it.
    winner_auth = []

    def racer():
        a = secrets.token_hex(32)
        st, _ = call(b, '/api/signup', 'POST', {'email': race_email, 'authToken': a})
        with lock:
            codes.append(st)
            if st == 200:
                winner_auth.append(a)

    threads = [threading.Thread(target=racer) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    check('signup race: exactly one winner', codes.count(200) == 1, f'codes={codes}')
    check('signup race: no 500s', not any(c >= 500 for c in codes), f'codes={codes}')

    # --- login --------------------------------------------------------------
    st, j = call(b, '/api/login', 'POST', {'email': email, 'authToken': auth})
    check('login succeeds', st == 200 and 'token' in j, f'{st} {j}')
    st, j = call(b, '/api/login', 'POST', {'email': email, 'authToken': secrets.token_hex(32)})
    check('login rejects wrong token', st == 401, f'{st} {j}')

    # --- auth required ------------------------------------------------------
    st, _ = call(b, '/api/me')
    check('/api/me requires auth', st == 401)
    st, j = call(b, '/api/me', token=token)
    check('/api/me works with bearer', st == 200 and j.get('user', {}).get('email') == email, str(j))

    # --- CSRF content-type gate --------------------------------------------
    req = urllib.request.Request(f'{b}/api/logout', data=b'x=1', method='POST',
                                 headers={'Content-Type': 'application/x-www-form-urlencoded'})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            st = r.status
    except urllib.error.HTTPError as e:
        st = e.code
    check('form-encoded mutation is refused', st == 415, f'got {st}')

    # --- sync round trip ----------------------------------------------------
    st, j = call(b, '/api/me/sync', token=token)
    check('sync starts empty', st == 200 and j.get('exists') is False, str(j))
    blob = {'iv': 'AAAAAAAAAAAAAAAA', 'ciphertext': 'Q0lQSEVSVEVYVA=='}
    st, j = call(b, '/api/me/sync', 'PUT', blob, token=token)
    check('sync push accepted', st == 200 and 'updatedAt' in j, f'{st} {j}')
    st, j = call(b, '/api/me/sync', token=token)
    check('sync pull returns what was pushed',
          st == 200 and j.get('exists') and j.get('ciphertext') == blob['ciphertext'], str(j)[:200])

    # Oversized blob must be refused, not truncated.
    st, j = call(b, '/api/me/sync', 'PUT', {'iv': 'AAAA', 'ciphertext': 'A' * (2 * 1024 * 1024 + 10)}, token=token)
    check('oversized blob refused with 413', st == 413, f'{st} {j}')
    st, j = call(b, '/api/me/sync', token=token)
    check('oversized push did not clobber good blob', j.get('ciphertext') == blob['ciphertext'], str(j)[:120])

    # --- share links --------------------------------------------------------
    st, j = call(b, '/api/share', 'POST', {'iv': 'AAAA', 'ciphertext': 'U0hBUkU=', 'label': 'selftest'}, token=token)
    check('share create works on trial', st == 200 and 'token' in j, f'{st} {j}')
    share_token = j.get('token')
    if share_token:
        st, j = call(b, f'/api/share/{share_token}')
        check('share fetch is public', st == 200 and j.get('ciphertext') == 'U0hBUkU=', str(j)[:150])
        st, j = call(b, '/api/share/' + 'f' * 32)
        check('unknown share token 404s', st == 404, f'{st}')
        st, j = call(b, f'/api/share/{share_token}', 'DELETE', token=token)
        check('share revoke works', st == 200, f'{st} {j}')
        st, _ = call(b, f'/api/share/{share_token}')
        check('revoked share is gone', st == 404, f'{st}')

    # A second account must not be able to revoke the first account's link.
    st, j = call(b, '/api/share', 'POST', {'iv': 'AAAA', 'ciphertext': 'U0hBUkU='}, token=token)
    victim_share = j.get('token')
    other_email = f'other-{secrets.token_hex(6)}@example.com'
    other_auth = secrets.token_hex(32)
    _track(other_email, other_auth)
    st, j = call(b, '/api/signup', 'POST', {'email': other_email, 'authToken': other_auth})
    other_token = j.get('token')
    if victim_share and other_token:
        call(b, f'/api/share/{victim_share}', 'DELETE', token=other_token)
        st, _ = call(b, f'/api/share/{victim_share}')
        check('another user cannot revoke your share link (IDOR)', st == 200, f'got {st}')

    # --- account deletion ---------------------------------------------------
    st, j = call(b, '/api/me', 'DELETE', token=other_token)
    check('account delete works', st == 200 and j.get('deleted'), f'{st} {j}')
    st, _ = call(b, '/api/me', token=other_token)
    check('session dead after delete', st == 401, f'got {st}')

    # --- admin --------------------------------------------------------------
    if args.admin_token:
        st, j = call(b, '/api/admin/users', admin=args.admin_token)
        check('admin users listing works', st == 200 and 'users' in j, f'{st} {str(j)[:120]}')
        st, j = call(b, '/api/admin/users')
        check('admin endpoint refuses anonymous', st == 401, f'{st}')
        st, j = call(b, '/api/admin/users', admin='wrong-token-entirely')
        check('admin endpoint refuses bad token', st == 401, f'{st}')
        st, j = call(b, '/api/admin/metrics', admin=args.admin_token)
        check('admin metrics works', st == 200 and 'totals' in j, f'{st} {str(j)[:120]}')
        st, j = call(b, '/api/admin/purge', 'POST', {}, admin=args.admin_token)
        check('admin purge works', st == 200 and 'deleted' in j, f'{st} {str(j)[:150]}')

    # --- legacy sync is read-only ------------------------------------------
    lookup = 'a' * 64
    st, j = call(b, f'/api/sync/{lookup}', 'PUT', {'iv': 'AAAA', 'ciphertext': 'QUJD'})
    check('legacy sync PUT is closed', st == 410, f'{st} {j}')
    st, j = call(b, f'/api/sync/{lookup}', 'DELETE')
    check('legacy sync DELETE is closed', st == 410, f'{st} {j}')
    st, j = call(b, f'/api/sync/{lookup}')
    check('legacy sync GET still readable for recovery', st == 404, f'{st} {j}')
    st, j = call(b, f'/api/sync/{lookup}/exists')
    check('legacy exists still answers', st == 200 and j.get('exists') is False, f'{st} {j}')

    # --- per-account throttling --------------------------------------------
    # nginx limits by IP; these limits are per identifier, so a spread-out
    # attempt against one account is what they exist to stop.
    victim = f'throttle-{secrets.token_hex(6)}@example.com'
    victim_auth = secrets.token_hex(32)
    _track(victim, victim_auth)
    call(b, '/api/signup', 'POST', {'email': victim, 'authToken': victim_auth})
    codes = []
    for _ in range(13):
        st, _ = call(b, '/api/login', 'POST', {'email': victim, 'authToken': secrets.token_hex(32)})
        codes.append(st)
    check('repeated wrong passwords eventually 429', 429 in codes, f'codes={codes}')
    check('throttle does not trip immediately', codes[0] == 401, f'first={codes[0]}')

    # A different account must be unaffected by that one being throttled.
    st, _ = call(b, '/api/login', 'POST', {'email': email, 'authToken': secrets.token_hex(32)})
    check('throttle is per-account, not global', st == 401, f'got {st}')

    forgot_codes = []
    fmail = f'forgot-{secrets.token_hex(6)}@example.com'
    for _ in range(6):
        st, _ = call(b, '/api/forgot', 'POST', {'email': fmail})
        forgot_codes.append(st)
    check('forgot always returns ok (no enumeration)', set(forgot_codes) == {200}, f'codes={forgot_codes}')

    # --- concurrency: the SQLite locking case -------------------------------
    errors = []

    def hammer(n):
        for i in range(12):
            st, j = call(b, '/api/me/sync', 'PUT',
                         {'iv': 'AAAAAAAAAAAAAAAA', 'ciphertext': f'Q0lQSEVS{n}{i}'}, token=token)
            if st != 200:
                with lock:
                    errors.append((n, i, st, str(j)[:120]))

    threads = [threading.Thread(target=hammer, args=(n,)) for n in range(10)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    check('120 concurrent writes, zero failures', not errors, f'{len(errors)} failed: {errors[:3]}')

    # --- cleanup ------------------------------------------------------------
    # Runs whatever the result: a failing suite should not also leave litter.
    if winner_auth:
        _track(race_email, winner_auth[0])
    _cleanup(b, args.admin_token)

    print(f'\n{len(PASS)} passed, {len(FAIL)} failed')
    if FAIL:
        print('FAILED: ' + ', '.join(FAIL))
    return 1 if FAIL else 0


if __name__ == '__main__':
    sys.exit(main())
