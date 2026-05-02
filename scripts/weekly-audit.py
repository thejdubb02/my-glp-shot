#!/usr/bin/env python3
"""Weekly free-LLM audit of the My GLP Shot codebase.

- Bundles repo into a digest
- Runs the audit through Gemini Flash + OpenRouter free models in parallel
- Persists each report under /opt/my-glp-shot/audit-history/<date>/
- Diffs CRITICAL/HIGH findings against the previous run
- Telegrams Justin via Sam (urgent) when new findings appear

Cost: $0/run (free LLM tiers).
"""
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

REPO = Path('/opt/my-glp-shot')
HIST = REPO / 'audit-history'
ENV_FILE = Path('/root/.openclaw/workspace/daily/wsg-cp/.env')

INCLUDE = [
    'api/app.py', 'api/requirements.txt', 'api/Dockerfile',
    'docker/docker-compose.yml',
    'web/app/index.html', 'web/app/app.js', 'web/app/styles.css',
    'web/app/sw.js', 'web/app/manifest.webmanifest',
]

MODELS = [
    ('gemini-2.5-flash', 'gemini'),
    ('openai/gpt-oss-120b:free', 'openrouter'),
    ('z-ai/glm-4.5-air:free', 'openrouter'),
    ('qwen/qwen3-coder:free', 'openrouter'),
]


def envkey(name):
    for line in ENV_FILE.read_text().splitlines():
        if line.startswith(name + '='):
            return line.split('=', 1)[1].strip()
    return ''


GEMINI_KEY = envkey('GEMINI_API_KEY')
OR_KEY = envkey('OPENROUTER_API_KEY')


def build_digest():
    parts = ['=== REPO DIGEST: My GLP Shot ===\n']
    for rel in INCLUDE:
        p = REPO / rel
        if p.exists():
            parts.append(f'\n===== FILE: {rel} =====\n')
            parts.append(p.read_text())
    return ''.join(parts)


PROMPT_TEMPLATE = """You are auditing My GLP Shot — a privacy-first GLP-1 tracker. PWA + Flask API + Stripe billing + E2EE sync. Live at https://app.myglpshot.com.

CRYPTO: Client derives authToken (sent to server, bcrypt-hashed) and encryptionKey (stays on device) via PBKDF2-SHA-256 600k iters from email+password. Sync blob = AES-256-GCM ciphertext + IV.

STRIPE: $1.99/mo, $19.99/yr, 14-day trial. Webhook at /api/stripe/webhook updates users.subscription_status + premium_until. Signature verified via stripe SDK. Idempotency tracked in stripe_events.

Find bugs, security issues, and high-leverage optimizations. Focus on auth, session/cookie/CSRF, webhook idempotency + race conditions, IDOR on share links, PII leaks, IndexedDB upgrade paths, sync conflicts, PWA gotchas, DOM null refs, CSP/CORS, input validation, dead code.

OUTPUT FORMAT (strict):
- One Markdown bullet per finding, no tables.
- Format: "- [SEVERITY] file:line — issue. Fix: <action>."
- SEVERITY is exactly one of: CRITICAL, HIGH, MEDIUM, LOW.
- ONLY cite line numbers that actually exist (the digest below has all source). If you cannot pin a line, omit ":line".
- ~30 findings max. Skip nice-to-haves below MEDIUM unless they are 5-min wins. No preamble, no closing summary.

REPO DIGEST FOLLOWS:
==========
"""


def run_gemini(prompt):
    url = f'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={GEMINI_KEY}'
    body = {
        'contents': [{'parts': [{'text': prompt}]}],
        'generationConfig': {'temperature': 0.2, 'maxOutputTokens': 8192},
    }
    return _post(url, {'Content-Type': 'application/json'}, body, extract='gemini')


def run_openrouter(model, prompt):
    body = {
        'model': model,
        'messages': [{'role': 'user', 'content': prompt}],
        'temperature': 0.2,
        'max_tokens': 8192,
    }
    headers = {
        'Authorization': f'Bearer {OR_KEY}',
        'HTTP-Referer': 'https://myglpshot.com',
        'X-Title': 'My GLP Shot Weekly Audit',
        'Content-Type': 'application/json',
    }
    return _post('https://openrouter.ai/api/v1/chat/completions', headers, body, extract='openai')


def _post(url, headers, body, extract):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers=headers, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=240) as r:
            data = json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return f'[error {e.code}] {e.read().decode("utf-8", "replace")[:300]}'
    except Exception as e:
        return f'[error] {e}'
    try:
        if extract == 'gemini':
            return data['candidates'][0]['content']['parts'][0]['text']
        return data['choices'][0]['message']['content']
    except (KeyError, IndexError, TypeError):
        return f'[malformed response] {json.dumps(data)[:300]}'


FINDING_RE = re.compile(
    r'^\s*[-*]\s*\[?\s*(CRITICAL|HIGH|MEDIUM|LOW)\s*\]?\s*[:.\-—]?\s*(.+)$',
    re.IGNORECASE | re.MULTILINE,
)


def parse_findings(text):
    out = []
    for m in FINDING_RE.finditer(text or ''):
        sev = m.group(1).upper()
        body = m.group(2).strip()
        if len(body) < 10:
            continue
        out.append((sev, body))
    return out


def normalize(body):
    """Normalize a finding for diff: lowercase, drop spaces/punct."""
    return re.sub(r'[^a-z0-9]+', '', body.lower())[:140]


def main():
    HIST.mkdir(exist_ok=True)
    today = datetime.utcnow().strftime('%Y-%m-%d')
    out_dir = HIST / today
    out_dir.mkdir(exist_ok=True)

    digest = build_digest()
    prompt = PROMPT_TEMPLATE + digest

    print(f'[audit] digest {len(digest)} chars; running {len(MODELS)} models in parallel...', file=sys.stderr)
    results = {}
    with ThreadPoolExecutor(max_workers=4) as ex:
        futs = {}
        for model, kind in MODELS:
            slug = model.replace('/', '_').replace(':', '-')
            fn = (lambda m: run_gemini(prompt)) if kind == 'gemini' else (lambda m=model: run_openrouter(m, prompt))
            futs[ex.submit(fn, model)] = slug
        for f in futs:
            slug = futs[f]
            text = f.result()
            (out_dir / f'{slug}.md').write_text(text)
            results[slug] = text
            print(f'[audit] {slug}: {len(text)} chars', file=sys.stderr)

    # Aggregate findings, dedupe across models
    all_findings = []
    for slug, text in results.items():
        for sev, body in parse_findings(text):
            all_findings.append({'sev': sev, 'body': body, 'src': slug, 'norm': normalize(body)})

    # Dedupe by normalized body, keep highest severity
    sev_rank = {'CRITICAL': 4, 'HIGH': 3, 'MEDIUM': 2, 'LOW': 1}
    by_norm = {}
    for f in all_findings:
        n = f['norm']
        if n not in by_norm or sev_rank[f['sev']] > sev_rank[by_norm[n]['sev']]:
            by_norm[n] = f
    deduped = sorted(by_norm.values(), key=lambda x: (-sev_rank[x['sev']], x['body']))

    summary = {
        'date': today,
        'total': len(deduped),
        'by_sev': {s: sum(1 for x in deduped if x['sev'] == s) for s in ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']},
        'findings': [{'sev': x['sev'], 'body': x['body'], 'src': x['src']} for x in deduped],
    }
    (out_dir / 'summary.json').write_text(json.dumps(summary, indent=2))

    # Diff vs previous run
    prev = sorted([d for d in HIST.iterdir() if d.is_dir() and d.name != today])
    new_high = []
    if prev:
        prev_summary = prev[-1] / 'summary.json'
        if prev_summary.exists():
            try:
                prev_data = json.loads(prev_summary.read_text())
                prev_norms = {normalize(f['body']) for f in prev_data['findings']}
                for f in deduped:
                    if f['sev'] in ('CRITICAL', 'HIGH') and f['norm'] not in prev_norms:
                        new_high.append(f)
            except Exception:
                new_high = [f for f in deduped if f['sev'] in ('CRITICAL', 'HIGH')]
    else:
        # First run: alert only on CRITICAL
        new_high = [f for f in deduped if f['sev'] == 'CRITICAL']

    print(f'[audit] {summary["by_sev"]} total; {len(new_high)} new CRITICAL/HIGH', file=sys.stderr)

    if new_high:
        send_alert(today, new_high, summary['by_sev'])
    elif summary['by_sev']['CRITICAL'] or summary['by_sev']['HIGH']:
        # Weekly digest even if nothing new (so Justin knows the audit ran).
        send_digest(today, summary['by_sev'], deduped)
    else:
        print('[audit] no critical/high findings; not alerting.', file=sys.stderr)


def send_alert(date, new_findings, counts):
    lines = [f'🚨 My GLP Shot weekly audit — {len(new_findings)} NEW issue(s)']
    lines.append(f'Date: {date} · Total: C{counts["CRITICAL"]}/H{counts["HIGH"]}/M{counts["MEDIUM"]}/L{counts["LOW"]}')
    lines.append('')
    for f in new_findings[:12]:
        lines.append(f'[{f["sev"]}] {f["body"][:240]}')
    lines.append('')
    lines.append(f'Full reports: /opt/my-glp-shot/audit-history/{date}/')
    _telegram('\n'.join(lines), urgent=True)


def send_digest(date, counts, findings):
    lines = [f'📋 My GLP Shot weekly audit — {date}']
    lines.append(f'No new criticals. C{counts["CRITICAL"]}/H{counts["HIGH"]}/M{counts["MEDIUM"]}/L{counts["LOW"]}')
    lines.append('')
    high = [f for f in findings if f['sev'] in ('CRITICAL', 'HIGH')][:5]
    for f in high:
        lines.append(f'[{f["sev"]}] {f["body"][:200]}')
    _telegram('\n'.join(lines), urgent=False)


def _telegram(message, urgent=False):
    """Use the wsg_core.notify helper if present; otherwise log."""
    try:
        sys.path.insert(0, '/home/claude/wsg-lite')
        from wsg_core.notify import send_telegram  # noqa
        send_telegram(message, urgent=urgent)
    except Exception as e:
        print(f'[audit] telegram unavailable: {e}; message follows:', file=sys.stderr)
        print(message, file=sys.stderr)


if __name__ == '__main__':
    main()
