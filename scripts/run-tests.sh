#!/usr/bin/env bash
# Every offline test suite, one command. No arguments, no setup to remember.
#
#   scripts/run-tests.sh
#
# Suites run the SHIPPED web/app/app.js in a VM (see scripts/lib/app-harness.mjs),
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
for f in web/app/data.js web/app/app.js web/app/sw.js; do
  node --check "$f" || { echo "✗ $f does not parse"; exit 1; }
done

# data.js must be loaded before app.js everywhere it is loaded at all. Getting
# that order wrong leaves every data table undefined at evaluation time, which
# surfaces as confusing app-level errors rather than a load error.
echo "· script order"
python3 - <<'PYEOF' || exit 1
import re, sys
html = open('web/app/index.html').read()
order = re.findall(r'<script src="(data|app)\.js', html)
if order != ['data', 'app']:
    print(f"  ✗ index.html loads {order}, expected ['data', 'app']"); sys.exit(1)
sw = open('web/app/sw.js').read()
crit = re.search(r'const CRITICAL = \[(.*?)\]', sw, re.S).group(1)
for f in ('data.js', 'app.js', 'index.html', 'styles.css'):
    if f not in crit:
        print(f"  ✗ {f} missing from the service worker CRITICAL list (breaks offline boot)"); sys.exit(1)
print("  ok")
PYEOF

FAILED=()
for suite in scripts/*-selftest.mjs; do
  [ -e "$suite" ] || continue
  name="$(basename "$suite" .mjs)"
  out="$(node "$suite" 2>&1)"
  if [ $? -eq 0 ]; then
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
