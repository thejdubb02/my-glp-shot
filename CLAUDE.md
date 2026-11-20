# my-glp-shot

GLP-1 and peptide injection tracker at https://myglpshot.com. Static PWA with
end-to-end encrypted cloud sync, Flask API, Stripe billing (Premium $1.99/mo or
$19.99/yr). README.md has the overview.

## Where it runs

- Production: vps1, repo at `/opt/my-glp-shot`. nginx serves `web/` from
  `/opt/my-glp-shot/web/app` and `web/landing`. API runs in Docker
  (`docker/docker-compose.yml`, container `my-glp-shot-api`, `127.0.0.1:5012`).
- Hosts: `myglpshot.com` (landing), `app.myglpshot.com` (PWA), Cloudflare in front.
- API database: SQLite at `/data/api.db` in the `mgs-data` volume.
- Secrets live in `docker/api.env` on the box (gitignored, never in the repo).

## Layout

- `web/app/`: the PWA (`js/` one file per feature, `data.js`, `sw.js`, `index.html`). Vanilla JS,
  no framework, no build step. `web/landing/`, `web/admin/`: marketing and admin.
- `api/`: Flask backend, one module per feature. `app.py` is the entry point
  (gunicorn `app:app`): it imports the feature modules, runs DB bootstrap and
  re-exports every name for scripts that `import app`. `config.py` (env, the
  Flask `app`), `db.py`, `helpers.py`, then `auth`, `sync` (incl. legacy),
  `share`, `billing`, `billing_test_mode`, `admin` (incl. Umami), `health`,
  `push`, `smart_import`.
  `push_dispatch.py`, `push_send.py`: web push. `requirements.txt`: pinned deps.
- `android/`, `capacitor.config.json`, `package.json`: the native app shell
  (Capacitor), Android only for now. It ships a copy of `web/app/` made by
  `scripts/build-native-www.sh` (no analytics, no service worker). Code switches
  on `IS_NATIVE`, never on "android", so iOS can reuse it. Plan and open
  decisions: `docs/android-fdroid-spec.md`. Debug builds only; no release
  signing key exists yet.
- `docker/`: Dockerfile and compose. `deploy/`: nginx vhosts and rate limits.
- `scripts/`: selftests, admin tools (grant-premium, list-users), backups.
- `docs/`: internal notes, code review record, launch plans. `content/`: site copy.
- `docs/state-machines.md`: every lifecycle (sync, auth, billing, push) and where it may change. Read before touching one.

## Tests

Client suites (offline, no browser, run the real `web/app/js/` files):

```
bash scripts/run-tests.sh
```

It checks syntax, script order, then every `scripts/*-selftest.mjs` (sync-merge,
dates, backup, notes, dose-supply, weight-units, measurements, subscribe-path,
pwa, insights, pdf-export, achievements, admin and more). It installs
`fake-indexeddb` into a temp dir if missing.

Not part of the gate, they need a live API, Stripe or a browser:
`scripts/api-selftest.py`, `scripts/push-selftest.py`, `scripts/subscribe-e2e.py`,
`scripts/qa-smoke-test.js`, `scripts/theme-contrast-test.js`. Do not run them.
No lint config exists. When you fix a client bug, add or extend a
`scripts/*-selftest.mjs` that fails without the fix.

## Hard rules

- Commit straight to `main`. No branches, no PRs.
- Never commit a secret. Credentials come from Vaultwarden or OpenBao at runtime.
  Never commit `docker/api.env*` or any `.env` file (a backup with live keys was
  committed once in 2026-08).
- Never deploy, push, restart containers or touch vps1 from an agent run.
- Never call Stripe (live or test), Resend, OpenRouter or any paid API. Smart
  Import and `scripts/weekly-audit.py` call OpenRouter; do not run them.
- Never run `grant-premium.py`, `revoke-premium.py`, `promote-admin.py` or
  `backup-*` against anything. There is no production data on the build box.
- Nothing user-facing sends itself: no email, no push, no Herald ping.
- Privacy is the product: the server must only ever hold ciphertext and auth
  hashes. Do not add code that sends plaintext health data to the server, to
  analytics, or to an LLM. Keep the CSP and security headers intact.
- Billing and sync bugs lose user data. Keep deletions syncing, and keep Stripe
  webhooks safe to replay out of order.

## Conventions

- Vanilla JS in `web/app/`; a new script file must also go in the service worker
  `CRITICAL` list in `sw.js` and load after `data.js`. Bump the cache/version when
  shipped files change (the same version also goes in `package.json` and
  `android/app/build.gradle`; a selftest checks they match).
- API is plain Flask modules (no Blueprints) on one `app` from `config.py`, with
  SQLite and plain SQL. Keep dependency pins exact. A new module must be imported
  in `app.py`. API selftests stub names with `patch()` from `scripts/apipatch.py`;
  a plain `api.X = stub` no longer reaches the module that uses `X`.
- Python tools go in `scripts/` (this repo's convention), shell helpers too.
- Public text and site copy: no em dashes, en dashes or the ellipsis character.
  (Privacy and landing pages were cleaned of them on purpose.)
