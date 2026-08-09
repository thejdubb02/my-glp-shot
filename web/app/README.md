# My GLP Shot — PWA

The app itself, served as static files by nginx at **https://app.myglpshot.com**.
No build step: what is in this directory is what ships.

## Files

```
index.html            app shell — every view lives here, toggled by showView()
app.js                everything: IndexedDB, crypto, sync, charts, insights, push
styles.css            theme + 20 colour variants
sw.js                 service worker — offline shell, push handler
manifest.webmanifest  install metadata, Play Store / TWA reads this
view.html             doctor share viewer (decrypts from the URL fragment)
privacy.html          privacy policy · terms.html · reset.html
icons/                generated — see scripts/build-icons.py, logo.svg is the master
screenshots/          referenced by the manifest and the Play listing
lib/chart.min.js      bundled Chart.js, no CDN
```

## How data flows

**Local first.** Everything lives in IndexedDB on the device and works with no
account and no network. An account adds an encrypted cloud copy on top; it is
never the source of truth while the app is running.

**Crypto.** `deriveAccountCreds()` runs PBKDF2-SHA-256 (600k iterations, salt =
SHA-256 of `myglpshot-v1:<email>`) to derive 512 bits from the master password.
The first 256 become an AES-GCM key that never leaves the device; the last 256
become the auth token the server bcrypts. The server holds ciphertext and hashes
— it cannot read a single entry.

**Sync is a merge, never a replace.** Records carry a stable `uid` (stamped in
`dbAdd`), and `mergeStore()` matches on uid *or* a content key so rows written
before uids existed still dedupe. A pull only ever adds. This matters: the old
behaviour cleared every local store first, which destroyed anything logged since
the last push.

**Payloads are gzipped before encryption**, behind an `MGSZ1:` magic header, with
a fallback for blobs written before that existed. Base64 goes through
`bytesToBase64()` — the obvious `btoa(String.fromCharCode(...bytes))` overflows
the call stack at ~124 KB and silently killed sync for anyone with real history.

**Reminders are server-sent.** In-page timers only fire while a tab is open. The
client computes fire times locally and uploads `{kind, fireAt}` pairs only; the
notification wording is chosen server-side from a fixed list. The server learns
when to buzz you and nothing else.

## Working on it

- Bump `APP_VERSION` in `app.js` **and** `CACHE` in `sw.js` together, or clients
  keep the old bundle.
- Regenerate icons with `scripts/build-icons.py` after editing `icons/logo.svg`;
  never hand-edit the PNGs.
- Social cards come from `scripts/build-social-cards.py`.
- Untrusted input (import files, LLM parse output, cloud payloads) goes through
  `sanitizeShot` / `sanitizeWeight` / `sanitizeSettings` at the door. Renderers
  downstream assume that has happened.
- `scripts/api-selftest.py` and `scripts/push-selftest.py` gate a deploy.

## Privacy

Data never leaves the device unless the user turns on cloud backup, creates a
doctor share link, or uses Smart Import. **Smart Import is the exception worth
knowing:** it sends the uploaded file to Google Gemini in plaintext to parse it.
That is disclosed in the privacy policy and must stay disclosed in the Play
Store data safety form.

## License

MIT.
