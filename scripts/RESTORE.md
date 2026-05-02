# my-glp-shot — Restore from VPS2 backup

Daily encrypted backups land on VPS2 at `/opt/backups/my-glp-shot/`.
Retention: last 30 daily + 12 monthly (1st-of-month preserved indefinitely up to 12).
Last 7 also kept on VPS1 at `/opt/backups/my-glp-shot/` for fast restore.

## To restore (VPS1)

```bash
# 1. Pick a backup. Newest local first:
ls -1t /opt/backups/my-glp-shot/mgs-*.db.gz.enc | head -5

# Or pull from VPS2:
rsync -av root@187.124.65.189:/opt/backups/my-glp-shot/mgs-YYYYMMDDTHHMMSSZ.db.gz.enc /tmp/

# 2. Decrypt + decompress.
PASS=$(python3 -c "import json;print(json.load(open('/root/.openclaw/workspace/daily/wsg-api-keys.json'))['mgs_backup_passphrase'])")
openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 \
  -in /tmp/mgs-YYYYMMDDTHHMMSSZ.db.gz.enc \
  -pass "pass:$PASS" | gunzip > /tmp/api.db

# 3. Verify integrity.
sqlite3 /tmp/api.db "PRAGMA integrity_check;"

# 4. Stop API, swap DB, restart.
cd /opt/my-glp-shot/docker
docker compose stop api
cp /var/lib/docker/volumes/docker_mgs-data/_data/api.db \
   /var/lib/docker/volumes/docker_mgs-data/_data/api.db.before-restore-$(date +%s)
cp /tmp/api.db /var/lib/docker/volumes/docker_mgs-data/_data/api.db
chown 999:systemd-journal /var/lib/docker/volumes/docker_mgs-data/_data/api.db
docker compose start api
curl -sf https://app.myglpshot.com/api/health
```

## Encryption

- Cipher: AES-256-CBC, PBKDF2 600k iterations, random salt per file (openssl `enc -salt`).
- Passphrase: `wsg-api-keys.json` -> `mgs_backup_passphrase` (64-char base64, generated 2026-05-02).
- **Never rotate** without first decrypting + re-encrypting all existing backups, or the old archive becomes unrecoverable.

## Run on demand

```bash
systemctl start mgs-backup.service
journalctl -u mgs-backup.service -n 50 --no-pager
```

## Failure surface

- Telegram alert via Sam fires only on failure (success is silent).
- Timer: `systemctl list-timers mgs-backup.timer`
- Last run logs: `journalctl -u mgs-backup.service -n 200 --no-pager`
