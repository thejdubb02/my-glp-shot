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

echo "· app.js syntax"
node --check web/app/app.js || { echo "✗ app.js does not parse"; exit 1; }

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
