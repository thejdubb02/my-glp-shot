# ShotClock

Offline-first GLP-1 / peptide injection tracker. PWA. All data lives in IndexedDB on the user's device — no accounts, no backend, no servers see health data.

Live: https://tools.willhitestrategy.org/shotclock/

## Features
- Log shots (medication, dose mg, datetime, injection site, notes)
- Site rotation suggestion (least recently used)
- Countdown to next dose based on configured cadence
- Weight log + line chart
- Estimated medication level chart (exponential decay, configurable half-life)
- JSON export / import
- ICS calendar reminder download (works on iOS Calendar, Google Calendar, etc.)
- Optional in-page browser notification when shot is due
- Installable PWA (iOS Add-to-Home-Screen, Android native install)
- Persistent storage via `navigator.storage.persist()`
- Fully offline — service worker caches the entire app shell

## Stack
Vanilla HTML/CSS/JS. Chart.js bundled locally. No build step.

## Files
```
index.html              app shell
app.js                  logic + IndexedDB
styles.css              theme
sw.js                   service worker (cache + offline)
manifest.webmanifest    PWA manifest
icons/                  192, 512, maskable, apple-touch
lib/chart.min.js        bundled Chart.js (no CDN)
```

## Deploy
Static files served by nginx under `/shotclock/`. No backend.

## Privacy
Your data never leaves your device unless you explicitly export it. The host (tools.willhitestrategy.org) only serves the app code — it does not see, store, or transmit any of the data you log.

## License
MIT.
