#!/usr/bin/env python3
"""Exercise native CORS and real session lookup with Flask's offline client."""
import os
import sys
import tempfile
from pathlib import Path

from apipatch import patch

with tempfile.TemporaryDirectory(prefix='mgs-cors-') as tmp:
    os.environ.update(
        MGS_DB=str(Path(tmp) / 'api.db'),
        MGS_NATIVE_ORIGINS=' https://shell.example:8443 , *, null ',
        HERALD_URL='',
    )
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
    import app as api

    patch('STRIPE_WEBHOOK_SECRET', '')
    patch('STRIPE_WEBHOOK_SECRET_TEST', '')
    patch('MGS_ADMIN_TOKEN', 'offline-admin-token')
    base = 'https://app.myglpshot.com'
    allowed = ('https://localhost', 'capacitor://localhost', 'https://shell.example:8443')
    cookie_token = 'a' * 64
    bearer_token = 'b' * 64
    with api.app.app_context():
        db = api.get_db()
        db.executemany(
            "INSERT INTO users (id, email, password_hash, created_at, subscription_status) "
            "VALUES (?, ?, 'unused', 0, 'free')",
            [(1, 'cookie@example.com'), (2, 'bearer@example.com')],
        )
        db.executemany(
            'INSERT INTO sessions (token, user_id, created_at, expires_at, last_seen) '
            'VALUES (?, ?, 0, ?, ?)',
            [(token, user, api.now_ts() + 3600, api.now_ts())
             for token, user in [(cookie_token, 1), (bearer_token, 2)]],
        )
        db.commit()

    client = api.app.test_client()
    client.set_cookie('mgs_session', cookie_token, domain='app.myglpshot.com', secure=True)

    def request(method, path, origin, **kwargs):
        headers = {'Origin': origin, **kwargs.pop('headers', {})}
        response = client.open(path, method=method, base_url=base, headers=headers, **kwargs)
        assert 'Access-Control-Allow-Credentials' not in response.headers
        return response

    def no_cors(response):
        assert not any(name.lower().startswith('access-control-') for name, _ in response.headers)

    for origin in allowed:
        response = request('OPTIONS', '/api/me/sync', origin, headers={
            'Access-Control-Request-Method': 'PUT',
            'Access-Control-Request-Headers': 'authorization, content-type',
        })
        assert response.status_code == 204
        assert response.headers['Access-Control-Allow-Origin'] == origin
        assert {'Authorization', 'Content-Type'} <= set(response.headers['Access-Control-Allow-Headers'].split(', '))
        assert {'GET', 'POST', 'PUT', 'DELETE'} <= set(response.headers['Access-Control-Allow-Methods'].split(', '))
        assert 'Origin' in response.vary

        response = request('GET', '/api/me', origin)
        assert response.status_code == 401
        assert response.headers['Access-Control-Allow-Origin'] == origin

        response = request('GET', '/api/me', origin, headers={'Authorization': 'Bearer ' + bearer_token})
        assert response.status_code == 200
        assert response.get_json()['user']['id'] == 2

        response = request('PUT', '/api/me/sync', origin, json={})
        assert response.status_code == 401
        response = request('PUT', '/api/me/sync', origin, data='body', content_type='text/plain',
                           headers={'Authorization': 'Bearer ' + bearer_token})
        assert response.status_code == 415
        assert response.headers['Access-Control-Allow-Origin'] == origin

    for origin in ('https://foreign.example', 'https://localhost.evil.example', 'null', '*'):
        response = request('OPTIONS', '/api/me', origin)
        no_cors(response)
        assert 'Origin' in response.vary
        response = request('GET', '/api/me', origin)
        no_cors(response)
        assert response.status_code == 200
        assert response.get_json()['user']['id'] == 1

    response = request('GET', '/api/me', base, headers={'Authorization': 'Bearer ' + bearer_token})
    no_cors(response)
    assert response.status_code == 200
    assert response.get_json()['user']['id'] == 1

    legacy_admin = {'X-Admin-Token': 'offline-admin-token'}
    assert request('GET', '/api/admin/users', base, headers=legacy_admin).status_code == 200
    assert request('GET', '/api/admin/users', allowed[0], headers=legacy_admin).status_code == 401
    assert request('GET', '/api/admin/users', allowed[0], headers={
        'Authorization': 'Bearer offline-admin-token',
    }).status_code == 200

    no_cors(request('OPTIONS', '/outside-api', allowed[0]))
    for path in ('/api/stripe/webhook', '/api/stripe/webhook/test'):
        no_cors(request('OPTIONS', path, allowed[0]))
        no_cors(request('POST', path, allowed[0], json={}))

print('PASS native CORS, Bearer-only sessions, web cookies, JSON guard, and webhook exclusions')
