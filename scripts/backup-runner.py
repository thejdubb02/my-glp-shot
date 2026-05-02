#!/usr/bin/env python3
"""Run my-glp-shot backup-to-vps2.sh and Telegram-alert via Sam on failure.

Success is silent (per user feedback_telegram_alerts.md — only escalate real problems).
Failure pings Justin with stdout/stderr tail.
"""
import subprocess, sys, os, datetime, traceback

sys.path.insert(0, '/root/.openclaw/workspace/daily/wsg-cp')
try:
    from wsg_core.notify import send_telegram
except Exception:
    send_telegram = None

SCRIPT = '/opt/my-glp-shot/scripts/backup-to-vps2.sh'

def alert(msg):
    if send_telegram:
        try:
            send_telegram(msg, urgent=True)
        except Exception:
            pass
    print(msg, file=sys.stderr)

def main():
    started = datetime.datetime.utcnow().isoformat() + 'Z'
    try:
        r = subprocess.run([SCRIPT], capture_output=True, text=True, timeout=900)
    except subprocess.TimeoutExpired:
        alert(f'🚨 my-glp-shot backup TIMED OUT after 900s (started {started})')
        return 2
    except Exception as e:
        alert(f'🚨 my-glp-shot backup CRASHED: {e}\n{traceback.format_exc()[-500:]}')
        return 3
    if r.returncode != 0:
        tail = (r.stderr or r.stdout or '')[-1500:]
        alert(f'🚨 my-glp-shot backup FAILED rc={r.returncode}\nstarted: {started}\n---\n{tail}')
        return r.returncode
    return 0

if __name__ == '__main__':
    sys.exit(main())
