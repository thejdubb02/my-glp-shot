#!/usr/bin/env bash
# my-glp-shot daily backup: SQLite online .backup -> openssl AES-256-CBC encrypt -> rsync to VPS2.
# Retention on VPS2: 30 daily + 12 monthly (1st of month preserved).
# Passphrase: wsg-api-keys.json -> mgs_backup_passphrase. Never rotate without re-encrypting old backups.
set -euo pipefail

DB_HOST_PATH=/var/lib/docker/volumes/docker_mgs-data/_data/api.db
KEYS_JSON=/root/.openclaw/workspace/daily/wsg-api-keys.json
VPS2_HOST=root@187.124.65.189
VPS2_DIR=/opt/backups/my-glp-shot
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

DATE=$(date -u +%Y%m%d)
TS=$(date -u +%Y%m%dT%H%M%SZ)
HOSTLABEL=$(hostname -s)

PASS=$(python3 -c "import json,sys;print(json.load(open('$KEYS_JSON'))['mgs_backup_passphrase'])")
[ -n "$PASS" ] || { echo "missing passphrase"; exit 2; }

# 1. Online backup (no downtime, consistent across WAL).
sqlite3 "$DB_HOST_PATH" ".backup '$WORK/api.db'"

# 2. Verify integrity before encrypting.
sqlite3 "$WORK/api.db" "PRAGMA integrity_check;" | grep -q '^ok$' || { echo "integrity_check failed"; exit 3; }

# 3. Compress + encrypt. AES-256-CBC w/ PBKDF2 600k iters (matches app E2EE strength).
gzip -9 "$WORK/api.db"
openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt \
  -in "$WORK/api.db.gz" \
  -out "$WORK/mgs-${TS}.db.gz.enc" \
  -pass "pass:$PASS"

# 4. Sidecar manifest (unencrypted: just metadata, no secrets).
SIZE=$(stat -c%s "$WORK/mgs-${TS}.db.gz.enc")
SHA=$(sha256sum "$WORK/mgs-${TS}.db.gz.enc" | awk '{print $1}')
cat > "$WORK/mgs-${TS}.manifest.json" <<EOF
{
  "ts": "$TS",
  "host": "$HOSTLABEL",
  "src": "$DB_HOST_PATH",
  "size_bytes": $SIZE,
  "sha256": "$SHA",
  "encryption": "openssl-aes-256-cbc-pbkdf2-iter-600000",
  "compression": "gzip-9",
  "passphrase_ref": "wsg-api-keys.json:mgs_backup_passphrase"
}
EOF

# 5. Ship to VPS2 (also keep last 7 local on VPS1 for fast restore).
mkdir -p /opt/backups/my-glp-shot
cp "$WORK/mgs-${TS}.db.gz.enc" "$WORK/mgs-${TS}.manifest.json" /opt/backups/my-glp-shot/
ls -1t /opt/backups/my-glp-shot/mgs-*.db.gz.enc 2>/dev/null | tail -n +8 | xargs -r rm -f
ls -1t /opt/backups/my-glp-shot/mgs-*.manifest.json 2>/dev/null | tail -n +8 | xargs -r rm -f

rsync -a --partial --timeout=120 \
  "$WORK/mgs-${TS}.db.gz.enc" "$WORK/mgs-${TS}.manifest.json" \
  "${VPS2_HOST}:${VPS2_DIR}/"

# 6. VPS2-side retention: 30 daily + monthly (keep 1st-of-month forever, prune any non-1st older than 30d).
ssh "$VPS2_HOST" bash <<'REMOTE'
set -euo pipefail
cd /opt/backups/my-glp-shot
# Find encrypted blobs older than 30 days where the date in the filename isn't the 1st.
find . -maxdepth 1 -name 'mgs-*.db.gz.enc' -mtime +30 | while read f; do
  fname=$(basename "$f")
  # filename: mgs-YYYYMMDDTHHMMSSZ.db.gz.enc -> day = chars 12-13 (0-indexed)
  day="${fname:11:2}"
  if [ "$day" != "01" ]; then
    rm -f "$f" "${f%.db.gz.enc}.manifest.json"
  fi
done
# Hard cap: keep at most 12 monthlies (oldest pruned).
ls -1 mgs-*01T*.db.gz.enc 2>/dev/null | sort | head -n -12 | while read f; do
  rm -f "$f" "${f%.db.gz.enc}.manifest.json"
done
REMOTE

echo "OK $TS size=$SIZE sha256=$SHA"
