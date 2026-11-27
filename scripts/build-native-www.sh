#!/usr/bin/env bash
# Builds the web bundle that ships inside the native app (Android now, iOS
# later). The website itself needs no build: this copies web/app and removes
# what must not be in an app store build.
#
#   bash scripts/build-native-www.sh [out-dir]     default: build/native-www
#
# Needs `npm ci` first (Chart.js comes from npm so its source is on record).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$(realpath -m "${1:-$ROOT/build/native-www}")"
CHART="$ROOT/node_modules/chart.js/dist/chart.umd.js"
TRACKER_HOST='analytics.willhitestrategy.org'
# The app talks to its own files and to the sync server, whose address the user
# can change in Settings, so any https host is allowed for connections only.
CSP="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' https:; base-uri 'self'; form-action 'self'; object-src 'none'"

[ -f "$CHART" ] || { echo "build-native-www: run npm ci first (missing chart.js)" >&2; exit 1; }
case "$OUT" in "$ROOT"/build/*|/tmp/*) ;; *) echo "build-native-www: refusing to write to $OUT" >&2; exit 1 ;; esac

rm -rf "$OUT"
mkdir -p "$OUT"
cp -R "$ROOT/web/app/." "$OUT/"

# Website-only files: service worker, robots and sitemap, install manifest, store art, social cards,
# and the two pages people reach from a link (doctor view, password reset).
rm -rf "$OUT/sw.js" "$OUT/manifest.webmanifest" "$OUT/store" "$OUT/screenshots" \
       "$OUT/README.md" "$OUT/og-image.png" "$OUT/twitter-image.png" \
       "$OUT/view.html" "$OUT/view.js" "$OUT/reset.html" "$OUT/reset.js" \
       "$OUT/robots.txt" "$OUT/sitemap.xml"

cp "$CHART" "$OUT/lib/chart.min.js"

# No tracking and no install manifest in the app; add the app's own CSP, which
# the website gets from nginx instead.
grep -q "$TRACKER_HOST" "$OUT/index.html" || { echo "build-native-www: tracker tag not found, check index.html" >&2; exit 1; }
sed -i -e "/$TRACKER_HOST/d" -e '/rel="manifest"/d' \
       -e "0,/<meta charset[^>]*>/s||&\n<meta http-equiv=\"Content-Security-Policy\" content=\"$CSP\">|" "$OUT/index.html"

# Nothing in the bundle may load a script from the network.
if grep -rIlE '<script[^>]+src="(https?:)?//' "$OUT" >/dev/null; then
  echo "build-native-www: a page still loads a remote script:" >&2
  grep -rIlE '<script[^>]+src="(https?:)?//' "$OUT" >&2
  exit 1
fi
grep -q 'http-equiv="Content-Security-Policy"' "$OUT/index.html" || { echo "build-native-www: CSP tag missing" >&2; exit 1; }
echo "build-native-www: wrote $OUT"
