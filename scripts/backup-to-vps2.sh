#!/usr/bin/env bash
# my-glp-shot daily backup: SQLite online .backup -> openssl AES-256-CBC encrypt -> rclone to Hetzner.
# Named for vps2 because systemd, the runner and the docs all point at this path; the
# destination moved on 2026-09-19, the filename did not.
# Retention: last 7 locally on vps1. Nothing is pruned on Hetzner yet, see step 5b.
# Passphrase: wsg-api-keys.json -> mgs_backup_passphrase. Never rotate without re-encrypting old backups.
set -euo pipefail

DB_HOST_PATH=/var/lib/docker/volumes/docker_mgs-data/_data/api.db
KEYS_JSON=/root/.openclaw/workspace/daily/wsg-api-keys.json
# VPS2_HOST / VPS2_DIR removed 2026-09-19: vps2 retired, this ships to Hetzner now.
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

# 5. Keep the last 7 locally on vps1 for a fast restore.
mkdir -p /opt/backups/my-glp-shot
cp "$WORK/mgs-${TS}.db.gz.enc" "$WORK/mgs-${TS}.manifest.json" /opt/backups/my-glp-shot/
ls -1t /opt/backups/my-glp-shot/mgs-*.db.gz.enc 2>/dev/null | tail -n +8 | xargs -r rm -f
ls -1t /opt/backups/my-glp-shot/mgs-*.manifest.json 2>/dev/null | tail -n +8 | xargs -r rm -f

# 5b. Ship to Hetzner.
#
# This used to rsync to vps2 and prune there. vps2 was never offsite: same
# provider, same account, one box away, and it was retired on 2026-09-19. Same
# reasoning as the Mattermost job, which moved for the same reason.
#
# Retention on the remote is deliberately absent, matching every other stream
# here: nothing is pruned from Hetzner until a restore has been proven end to
# end. See BACKUP-PLAN.md Stage 2. Local 7-copy retention above is unchanged.
RCLONE_DEST="hetzner:Backups/$HOSTLABEL/my-glp-shot"
rclone copy "$WORK/mgs-${TS}.db.gz.enc" "$RCLONE_DEST/" --no-traverse
rclone copy "$WORK/mgs-${TS}.manifest.json" "$RCLONE_DEST/" --no-traverse

# Verify it actually arrived, at the right size. An upload that half-lands is
# the case the old rsync could not detect either.
REMOTE_SIZE=$(rclone size "$RCLONE_DEST/mgs-${TS}.db.gz.enc" --json 2>/dev/null \
              | grep -oE '"bytes":[0-9]+' | cut -d: -f2)
if [ "$REMOTE_SIZE" != "$SIZE" ]; then
  echo "FAIL upload size mismatch: local=$SIZE remote=${REMOTE_SIZE:-none}" >&2
  exit 3
fi

echo "OK $TS size=$SIZE sha256=$SHA"
