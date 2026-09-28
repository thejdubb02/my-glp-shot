# My GLP Shot

Privacy-first GLP-1 / peptide injection tracker. PWA + end-to-end encrypted cloud sync. Works on any device.

**Live:** https://myglpshot.com

## Repo layout

```
my-glp-shot/
├── web/         Static PWA (HTML/CSS/JS, served by nginx on the host)
├── api/         Flask backend (Dockerized: auth, sync, sharing, reports)
├── docker/      Dockerfile + docker-compose.yml
├── scripts/     Admin / migration tools
└── docs/        Internal documentation
```

## Tech stack

- **Frontend:** vanilla HTML/CSS/JS, Chart.js, IndexedDB, Web Crypto API. No framework, no build step.
- **Backend:** Python 3.11 + Flask + SQLite, containerized via Docker.
- **Crypto:** PBKDF2-SHA-256 (600k iters) + AES-GCM 256, all in browser. Server holds opaque ciphertext + auth hashes only.
- **Hosting:** VPS1 (Hetzner). nginx + Cloudflare in front. Domain: myglpshot.com.

## Tests

Client suites run in Node against the real `web/app/app.js`, with a fake
IndexedDB and no browser:

```
bash scripts/run-tests.sh
```

It discovers every `scripts/*-selftest.mjs`. Each one pins behaviour that once
failed quietly: sync merges (`sync-merge`), dates and time zones (`dates`),
backups, notes, dose and supply maths, weight units, measurements, the
subscribe path, and the PWA shell.

Server suites run inside the API container, or a throwaway one built from the
same image:

```
python3 scripts/api-selftest.py --base http://127.0.0.1:PORT --admin-token TOKEN
docker exec -i my-glp-shot-api python3 - < scripts/subscribe-e2e.py
docker exec my-glp-shot-api python push-selftest.py
```

`subscribe-e2e.py` drives the real checkout endpoint and replays Stripe
webhooks, including out-of-order ones. Add `--live` to create real (never
completed) Checkout Sessions so Stripe itself checks the amounts.

## Pricing

- **Free**: local-first tracking, body diagram, heatmap, weight chart, side effects, mood, streaks, reconstitution calculator, single-device cloud backup
- **Premium** ($1.99/mo or $19.99/yr, 14-day free trial): multi-device sync, supply tracking, body measurements, lab tracking, plateau detection, PDF export, doctor share link, advanced insights

## Privacy

- All cryptography runs in the browser. The server cannot read user data.
- Email = account identity (recovery channel for billing only). Master password derives both auth + encryption key (Bitwarden-style dual hash).
- Forgot password = lose cloud copy. Local data preserved.
- Not HIPAA-regulated (consumer tool, no healthcare provider integration). Privacy policy + terms in app.

## License

MIT.
