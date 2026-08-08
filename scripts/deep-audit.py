#!/usr/bin/env python3
"""On-demand deep code audit of My GLP Shot across a panel of frontier LLMs.

Differs from weekly-audit.py: that one is a cheap free-tier regression sweep.
This one is the pre-release gate — strong models, the codebase split into
focused slices so each review is deep rather than skimmed, and every model
sees every slice.

Key: MYGLPSHOT_OR_KEY from /opt/or-keys/secrets/keys.env (own child key,
capped, registered in agent-infra/llm-registry.yaml). Never hardcoded.

Usage:
    python3 scripts/deep-audit.py [--repo PATH] [--out DIR] [--slices a,b,c,d]
"""
import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

KEYS_ENV = Path('/opt/or-keys/secrets/keys.env')
OR_URL = 'https://openrouter.ai/api/v1/chat/completions'

MODELS = [
    'google/gemini-3.1-pro-preview',
    'openai/gpt-5.3-codex',
    'x-ai/grok-4.20',
    'deepseek/deepseek-v4-pro',
]

# Each slice is (name, description, [(label, path, line_from, line_to)]).
# line_from/line_to are 1-indexed and inclusive; None means whole file.
SLICES = {
    'a': {
        'title': 'Backend + deployment',
        'focus': (
            'Flask/SQLite correctness under gunicorn concurrency (2 workers x 4 threads), '
            'auth and session handling, CSRF, IDOR, Stripe webhook idempotency and ordering, '
            'trial abuse, GDPR/CCPA deletion completeness, SQL correctness, unbounded table growth, '
            'nginx header and rate-limit gaps, container hardening.'
        ),
        'files': [
            ('api/app.py', None, None),
            ('api/Dockerfile', None, None),
            ('api/requirements.txt', None, None),
            ('docker/docker-compose.yml', None, None),
            ('deploy/nginx-app.myglpshot.com.conf', None, None),
        ],
    },
    'b': {
        'title': 'Client crypto, account, and sync',
        'focus': (
            'End-to-end encryption correctness, key derivation and storage, session token handling, '
            'base64 encoding of large buffers, sync conflict resolution and data loss, '
            'IndexedDB record identity across devices, replay and downgrade attacks, '
            'error paths that silently swallow failures.'
        ),
        'files': [('web/app/app.js', 4900, 6471)],
    },
    'c': {
        'title': 'Client application core',
        'focus': (
            'IndexedDB schema and upgrade safety, notification scheduling reliability, '
            'timezone correctness, XSS via innerHTML, null/undefined DOM refs, '
            'premium gating that can be bypassed client-side, dead code, memory leaks, '
            'unhandled promise rejections.'
        ),
        'files': [('web/app/app.js', 1, 4899)],
    },
    'd': {
        'title': 'PWA shell + service worker + admin',
        'focus': (
            'Service worker caching and update correctness, offline behaviour, manifest '
            'completeness for Play Store / TWA packaging, accessibility, CSP compatibility, '
            'admin SPA auth handling, asset weight.'
        ),
        'files': [
            ('web/app/index.html', None, None),
            ('web/app/sw.js', None, None),
            ('web/app/manifest.webmanifest', None, None),
            ('web/admin/admin.js', None, None),
        ],
    },
}

CONTEXT = """PROJECT: My GLP Shot — a privacy-first GLP-1 / peptide injection tracker.
Live: https://myglpshot.com (marketing), https://app.myglpshot.com (the PWA).

ARCHITECTURE
- Frontend: vanilla HTML/CSS/JS PWA. No framework, no build step. IndexedDB for
  local data, Chart.js for charts, Web Crypto for all cryptography.
- Backend: Python 3.11 + Flask + SQLite in Docker behind nginx, run by gunicorn
  with 2 workers x 4 threads. SQLite file on a Docker volume.
- Crypto: the client derives 512 bits via PBKDF2-SHA-256 (600k iters, salt =
  SHA-256("myglpshot-v1:" + email)). First 256 bits are an AES-GCM key that
  never leaves the device; last 256 bits are an authToken sent to the server,
  which bcrypts it. Sync blobs are AES-256-GCM ciphertext + IV, opaque to the
  server.
- Billing: Stripe. $1.99/mo, $19.99/yr, 14-day trial. Webhook at
  /api/stripe/webhook updates users.subscription_status and premium_until.
- Sessions: httpOnly cookie `mgs_session`, plus a Bearer token fallback the
  client also stores in localStorage.

WHERE THIS IS GOING
The code is being hardened for production and then packaged as an Android app
for the Google Play Store. Treat "would this fail a Play Store review, leak
health data, lose a user's data, or break under real concurrency" as the bar.
"""

PROMPT = """{context}
REVIEW SLICE: {title}
PRIORITY FOCUS: {focus}

Audit the source below. You are the last reviewer before this ships to real
patients tracking real medication. Assume nothing is safe because it looks
intentional — verify the logic.

RULES
- Report only defects you can point at in the code shown. No speculative advice.
- Before reporting a missing protection, check whether it is provided elsewhere
  in the supplied source (e.g. security headers may live in the nginx config,
  not the HTML).
- Prefer one precise finding over three vague ones.
- Rank by real-world blast radius: silent data loss and health-data exposure
  outrank style.

OUTPUT — a JSON object, nothing else, no markdown fences:
{{"findings": [
  {{"severity": "CRITICAL|HIGH|MEDIUM|LOW",
    "file": "<path>",
    "line": <int or null>,
    "title": "<short label>",
    "issue": "<what is wrong and the concrete conditions that trigger it>",
    "fix": "<the specific change to make>"}}
]}}

Cap at 25 findings. If the slice is genuinely clean, return an empty list.

SOURCE:
========
{source}
"""


def envkey(name, path=KEYS_ENV):
    if not path.exists():
        return os.environ.get(name, '')
    for line in path.read_text().splitlines():
        if line.startswith(name + '='):
            return line.split('=', 1)[1].strip()
    return os.environ.get(name, '')


def build_source(repo, files):
    parts = []
    for rel, lo, hi in files:
        p = repo / rel
        if not p.exists():
            continue
        text = p.read_text(errors='replace')
        lines = text.splitlines()
        lo_i = (lo or 1) - 1
        hi_i = hi if hi else len(lines)
        chunk = lines[lo_i:hi_i]
        span = f' (lines {lo}-{hi})' if lo or hi else ''
        parts.append(f'\n===== FILE: {rel}{span} =====\n')
        # Number the lines so cited line numbers are checkable.
        parts.append('\n'.join(f'{lo_i + n + 1}: {l}' for n, l in enumerate(chunk)))
        parts.append('\n')
    return ''.join(parts)


def call_model(model, prompt, key):
    body = {
        'model': model,
        'messages': [{'role': 'user', 'content': prompt}],
        'temperature': 0.1,
        'max_tokens': 16000,
    }
    req = urllib.request.Request(
        OR_URL,
        data=json.dumps(body).encode(),
        headers={
            'Authorization': f'Bearer {key}',
            'HTTP-Referer': 'https://myglpshot.com',
            'X-Title': 'My GLP Shot deep audit',
            'Content-Type': 'application/json',
        },
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=900) as r:
            data = json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return None, f'[http {e.code}] {e.read().decode("utf-8", "replace")[:400]}'
    except Exception as e:
        return None, f'[error] {e}'
    try:
        return data['choices'][0]['message']['content'], None
    except (KeyError, IndexError, TypeError):
        return None, f'[malformed] {json.dumps(data)[:400]}'


def parse_json_findings(text):
    """Models sometimes wrap JSON in fences or prose. Recover the object."""
    if not text:
        return []
    t = text.strip()
    t = re.sub(r'^```(?:json)?\s*', '', t)
    t = re.sub(r'\s*```$', '', t)
    try:
        return json.loads(t).get('findings', [])
    except Exception:
        pass
    m = re.search(r'\{.*"findings".*\}', t, re.S)
    if m:
        try:
            return json.loads(m.group(0)).get('findings', [])
        except Exception:
            pass
    return []


def norm(f):
    """Dedupe key: file + rough title, punctuation-insensitive."""
    base = f"{f.get('file', '')}:{f.get('title', '')}".lower()
    return re.sub(r'[^a-z0-9]+', '', base)[:90]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--repo', default='/opt/my-glp-shot')
    ap.add_argument('--out', default='')
    ap.add_argument('--slices', default='a,b,c,d')
    ap.add_argument('--models', default=','.join(MODELS))
    args = ap.parse_args()

    repo = Path(args.repo)
    key = envkey('MYGLPSHOT_OR_KEY')
    if not key:
        sys.exit('MYGLPSHOT_OR_KEY not found in /opt/or-keys/secrets/keys.env')

    out_dir = Path(args.out) if args.out else repo / 'audit-history' / 'deep'
    out_dir.mkdir(parents=True, exist_ok=True)

    models = [m.strip() for m in args.models.split(',') if m.strip()]
    slice_keys = [s.strip() for s in args.slices.split(',') if s.strip() in SLICES]

    jobs = []
    for sk in slice_keys:
        sl = SLICES[sk]
        source = build_source(repo, sl['files'])
        if not source.strip():
            print(f'[audit] slice {sk}: no source found, skipping', file=sys.stderr)
            continue
        prompt = PROMPT.format(context=CONTEXT, title=sl['title'], focus=sl['focus'], source=source)
        print(f'[audit] slice {sk} ({sl["title"]}): {len(source):,} chars', file=sys.stderr)
        for m in models:
            jobs.append((sk, m, prompt))

    results = []
    with ThreadPoolExecutor(max_workers=8) as ex:
        futs = {ex.submit(call_model, m, p, key): (sk, m) for sk, m, p in jobs}
        for fut in as_completed(futs):
            sk, m = futs[fut]
            text, error = fut.result()
            slug = f'{sk}__{m.replace("/", "_").replace(":", "-")}'
            if error:
                print(f'[audit] {slug}: {error}', file=sys.stderr)
                (out_dir / f'{slug}.error.txt').write_text(error)
                continue
            (out_dir / f'{slug}.raw.txt').write_text(text)
            found = parse_json_findings(text)
            print(f'[audit] {slug}: {len(found)} findings', file=sys.stderr)
            for f in found:
                if not isinstance(f, dict):
                    continue
                f['slice'] = sk
                f['model'] = m
                results.append(f)

    # Merge: same finding from several models is stronger evidence, not noise.
    rank = {'CRITICAL': 4, 'HIGH': 3, 'MEDIUM': 2, 'LOW': 1}
    merged = {}
    for f in results:
        k = norm(f)
        sev = (f.get('severity') or 'LOW').upper()
        if sev not in rank:
            sev = 'LOW'
        f['severity'] = sev
        if k not in merged:
            f['confirmedBy'] = [f['model']]
            merged[k] = f
        else:
            prev = merged[k]
            if f['model'] not in prev['confirmedBy']:
                prev['confirmedBy'].append(f['model'])
            if rank[sev] > rank[prev['severity']]:
                prev['severity'] = sev
                prev['issue'] = f.get('issue') or prev.get('issue')
                prev['fix'] = f.get('fix') or prev.get('fix')

    final = sorted(
        merged.values(),
        key=lambda x: (-rank[x['severity']], -len(x['confirmedBy']), x.get('file', '')),
    )
    summary = {
        'models': models,
        'slices': slice_keys,
        'total': len(final),
        'bySeverity': {s: sum(1 for f in final if f['severity'] == s) for s in ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW')},
        'findings': final,
    }
    (out_dir / 'summary.json').write_text(json.dumps(summary, indent=2))
    print(f'[audit] {summary["bySeverity"]} -> {out_dir / "summary.json"}', file=sys.stderr)


if __name__ == '__main__':
    main()
