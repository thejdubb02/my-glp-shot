#!/usr/bin/env bash
# Every offline test suite, one command. No arguments, no setup to remember.
#
#   scripts/run-tests.sh
#
# Suites run the SHIPPED web/app scripts in a VM (see scripts/lib/app-harness.mjs),
# so they fail when the app changes and the guarded behaviour stops holding.
# Exit code is non-zero if any suite fails, which is what makes this usable as a
# pre-deploy gate.
#
# Not included here (they need network or a browser, so they can't be a local
# gate): api-selftest.py and push-selftest.py run against a live API,
# qa-smoke-test.js and theme-contrast-test.js drive a real Chromium.
set -uo pipefail
cd "$(dirname "$0")/.."

# fake-indexeddb is a test-only dependency and the app itself has no build step,
# so it is not a repo dependency. Find it, or install it somewhere disposable.
find_fidb() {
  [ -n "${FAKE_INDEXEDDB_PATH:-}" ] && [ -d "$FAKE_INDEXEDDB_PATH" ] && { echo "$FAKE_INDEXEDDB_PATH"; return; }
  for d in "./node_modules/fake-indexeddb" "${TMPDIR:-/tmp}/mgs-test-deps/node_modules/fake-indexeddb"; do
    [ -d "$d" ] && { cd "$(dirname "$0")/.." && echo "$(cd "$d" && pwd)"; return; }
  done
  return 1
}

FIDB="$(find_fidb || true)"
if [ -z "$FIDB" ]; then
  echo "· installing fake-indexeddb (test-only dependency)…"
  DEPS="${TMPDIR:-/tmp}/mgs-test-deps"
  mkdir -p "$DEPS"
  ( cd "$DEPS" && npm install --silent --no-fund --no-audit fake-indexeddb >/dev/null 2>&1 )
  FIDB="$DEPS/node_modules/fake-indexeddb"
  [ -d "$FIDB" ] || { echo "✗ could not install fake-indexeddb — is npm available?"; exit 2; }
fi
export FAKE_INDEXEDDB_PATH="$FIDB"

echo "· syntax"
for f in web/app/data.js web/app/js/*.js web/app/sw.js; do
  node --check "$f" || { echo "✗ $f does not parse"; exit 1; }
done

# The app is data.js plus one classic script per feature in web/app/js/. The
# list in index.html is the source of truth. A file on disk that is not listed
# never loads; a different order in reset.html, or a file missing from the
# service worker CRITICAL list, breaks reset or offline boot on a real phone
# while every suite still passes. So all four must agree.
echo "· script list"
python3 - <<'PYEOF' || exit 1
import os, re, sys
def listed(page):
    return re.findall(r'<script src="((?:data|js/[\w-]+)\.js)[?"]', open(page).read())
index = listed('web/app/index.html')
bad = []
if not index or index[0] != 'data.js':
    bad.append(f"index.html must load data.js first, got {index[:2]}")
if len(set(index)) != len(index):
    bad.append("index.html lists a script twice")
disk = sorted('js/' + f for f in os.listdir('web/app/js') if f.endswith('.js'))
if sorted(index[1:]) != disk:
    bad.append(f"index.html and web/app/js/ disagree: {sorted(set(index[1:]) ^ set(disk))}")
if listed('web/app/reset.html') != index:
    bad.append("reset.html does not load the same scripts in the same order as index.html")
sw = open('web/app/sw.js').read()
crit = re.findall(r"'([^']+)'", re.search(r'const CRITICAL = \[(.*?)\]', sw, re.S).group(1))
for f in index + ['index.html', 'styles.css']:
    if f not in crit:
        bad.append(f"{f} missing from the service worker CRITICAL list (breaks offline boot)")
for f in crit:
    if f != './' and not os.path.exists('web/app/' + f):
        bad.append(f"service worker CRITICAL lists {f}, which does not exist (install would fail)")
if os.path.exists('web/app/app.js'):
    bad.append("web/app/app.js is back; the app lives in web/app/js/ now")
for b in bad: print("  ✗ " + b)
if bad: sys.exit(1)
print(f"  ok ({len(index)} scripts)")
PYEOF

FAILED=()
# weekly-audit-selftest.py is the one Python suite that is fully offline.
for suite in scripts/*-selftest.mjs scripts/weekly-audit-selftest.py; do
  [ -e "$suite" ] || continue
  name="$(basename "${suite%.*}")"
  case "$suite" in *.py) run=python3 ;; *) run=node ;; esac
  out="$($run "$suite" 2>&1)"
  rc=$?
  if [ $rc -eq 0 ] && echo "$out" | grep -q '^SKIPPED'; then
    # Suites that need a live API skip rather than fail, but the skip is always
    # reported — a silent skip reads as a pass and hides a broken endpoint.
    echo "− $name — skipped ($(echo "$out" | head -1 | sed 's/^SKIPPED — //'))"
  elif [ $rc -eq 0 ]; then
    echo "✓ $name — $(echo "$out" | grep -oE '[0-9]+ passed' | tail -1)"
  else
    echo "✗ $name"
    echo "$out" | sed 's/^/    /' | tail -25
    FAILED+=("$name")
  fi
done

echo
if [ ${#FAILED[@]} -eq 0 ]; then
  echo "All suites passed."
else
  echo "FAILED: ${FAILED[*]}"
  exit 1
fi
