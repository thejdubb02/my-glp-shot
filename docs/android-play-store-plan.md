# My GLP Shot on Android — port plan

Written 2026-08-08, after the pre-release hardening pass (commit `b60d5c0`).

## The short version

Ship the existing PWA as a **Trusted Web Activity (TWA)**. It is the same code
running in a Chrome engine inside an Android shell, so there is no second app to
maintain and no rewrite. Bubblewrap generates the project in an afternoon.

**Two things decide the schedule, and neither is code:**

1. **Payments.** Google Play does not allow Stripe for in-app digital
   subscriptions. This has to be resolved before submission, not after.
2. **Notifications.** Reminders currently cannot fire when the app is closed.
   That is the feature Android users will judge the app on, and fixing it
   properly touches the privacy promise.

Everything else is checklist work.

---

## Why TWA, and not the alternatives

| Option | Verdict |
|---|---|
| **TWA (Bubblewrap)** | **Chosen.** One codebase. Full PWA capability including web push. Installs as a real Play Store app. No WebView quirks — it runs the user's Chrome. |
| Capacitor / Cordova | Adds a plugin layer and a build step to a project that deliberately has neither. Worth it only if we need native APIs the web can't reach — we don't yet. |
| React Native / native rewrite | Months of work to reproduce an app that already works, and then two codebases to keep in sync forever. No. |

TWA's one real constraint: the app must stay a good PWA. It already is —
installable, offline-capable, service-worker-backed. The hardening pass fixed
the manifest gaps (`id`, `lang`, `categories`, `display_override`, screenshots,
maskable and monochrome icons) that Bubblewrap reads.

---

## Blocker 1 — Play Billing vs Stripe

**The problem.** Play policy requires Google Play Billing for digital goods and
subscriptions bought inside an Android app. My GLP Shot Premium ($1.99/mo,
$19.99/yr) is exactly that. A TWA that opens Stripe Checkout inside the app is a
policy violation and a likely rejection or removal.

Google's cut is 15% on the first $1M of annual revenue — on $1.99/mo that is
about 30¢ per subscriber per month.

**Three ways out, in order of how much work they are:**

### A. Android app does not sell anything *(fastest, recommended for v1)*
The Android app signs users in and honours whatever subscription they already
have. Premium is bought on the web, at myglpshot.com, in a browser.

- Zero billing code. The existing Stripe flow is untouched.
- Play-compliant, provided the app does **not** link out to the web checkout or
  advertise a cheaper price elsewhere. It may say "Premium is managed on the
  web" — the wording matters and should be checked against current policy at
  submission time.
- Cost: some conversion loss from users who install from Play and hit a wall.

### B. Google Play Billing alongside Stripe
Android buys via Play Billing; web keeps Stripe. The server learns to verify
both and reconcile them into one `subscription_status`.

- Real work: Play Billing integration, server-side receipt verification via the
  Play Developer API, Real-time Developer Notifications, and a reconciliation
  path for a user who somehow ends up subscribed on both.
- The right answer once Play is a meaningful acquisition channel.

### C. External payment link
Following the 2025 US antitrust ruling, Google must permit external payment
links in the US, under conditions that are still moving and are region-specific.

- Do not build on this without checking current policy. It is not a stable
  foundation for a launch.

**Recommendation: launch with A, move to B once Play install volume justifies
the integration.** This needs a decision from Justin before submission.

---

## Blocker 2 — Notifications

**What is broken today.** Reminders are scheduled with `setTimeout`, which only
runs while the page is open, plus a `TimestampTrigger` path for the Notification
Triggers API — which was verified unsupported in current Chromium during this
audit. So:

> A shot reminder set for 9am tomorrow does not fire unless the app happens to
> be open at 9am.

That is invisible on the web, where users don't expect much. On Android it reads
as a broken app and it is what one-star reviews are made of.

**The fix is Web Push** (VAPID), which works in a TWA and delivers when the app
is closed. It needs:

- Server: a VAPID keypair, a `push_subscriptions` table, subscribe/unsubscribe
  endpoints, and a scheduler that sends due reminders. `pywebpush` covers the
  sending.
- Client: a subscription flow at the point the user enables reminders, plus the
  `push` handler the service worker already has.

**The privacy question this raises — and it needs Justin's answer.**

Today the server cannot read anything. To send "your shot is due at 9am", the
server has to know *when* to send. That is a schedule, and a schedule is
health-adjacent data the server currently never sees.

| Approach | What the server learns | Reminder reliability |
|---|---|---|
| **Minimal-disclosure push** | A next-fire timestamp and a generic string ("Time for your shot"). No medication, no dose, no history. It can infer a dosing cadence. | Reliable. Fires with the app closed. |
| **Keep it fully local** | Nothing. | Unreliable — today's behaviour. |
| **Native alarms (later)** | Nothing. Android's `AlarmManager` fires locally. | Reliable, but needs a Bubblewrap plugin or a small native module, so it is not v1. |

Minimal-disclosure push is the normal trade and is defensible, but it changes
what the privacy policy claims and should be an explicit, opt-in choice with the
disclosure written plainly. **This is a product decision, not a technical one.**

---

## Play Store requirements checklist

### Identity and packaging
- [ ] Package name — suggest `com.myglpshot.app`. Permanent; cannot change after publish.
- [ ] Generate with Bubblewrap against `https://app.myglpshot.com/manifest.webmanifest`.
- [ ] Upload key + Play App Signing. **Back the keystore up to Vaultwarden** — losing it means losing the ability to update the app.
- [ ] `assetlinks.json` served at `https://app.myglpshot.com/.well-known/assetlinks.json`, containing the signing-key fingerprint. **Without this the TWA shows a browser address bar** and looks like a website in a box.
- [ ] Target the API level Play currently requires for new submissions (check at build time — it moves annually).

### Store listing
- [x] 512×512 icon — generated as `web/app/icons/play-store-512.png`.
- [ ] 1024×500 feature graphic — **not made yet**.
- [ ] Phone screenshots, min 2 — `web/app/screenshots/` has three usable ones.
- [ ] Short description (80 chars) and full description (4000).
- [ ] Content rating questionnaire (IARC).

### The parts that get health apps rejected
- [ ] **Data safety form.** Must declare health data collection and the E2EE
      posture honestly. Note **Smart Import is the exception**: it sends the
      user's uploaded file to Google Gemini in plaintext. That must be declared
      and is already disclosed in the privacy policy — keep the two consistent.
- [ ] **Account deletion.** Play requires both in-app deletion *and* a publicly
      reachable web URL. The API supports it (`DELETE /api/me`, verified working
      in production); the **public web page still needs building**.
- [ ] **Health app declaration.** Position it as a personal tracking and
      logging tool. It must not read as diagnosis, treatment advice, or dosing
      recommendation — the insights copy should be reviewed with that lens.
- [ ] **Medical disclaimer** visible in-app and in the listing.
- [ ] Privacy policy URL — exists at myglpshot.com/privacy.html.
- [ ] No claims about GLP-1 outcomes in the listing that we can't support.

### Technical gates before submission
- [ ] Web Push working (Blocker 2).
- [ ] Billing decision made and implemented (Blocker 1).
- [ ] `scripts/api-selftest.py` green.
- [ ] Test on a real low-end Android device, not only an emulator.
- [ ] Offline behaviour verified: airplane mode, cold start, log a shot, reconnect, confirm it syncs.

---

## Build sequence

**Phase 1 — make the PWA worth packaging (do first)**
1. Web Push end to end, once the privacy question is answered.
2. Public account-deletion page.
3. Storage: request persistence at a point where Chrome will grant it. Verified
   `persisted: false` in production today, which means data is evictable under
   storage pressure. A TWA install generally gets it automatically, but the web
   PWA should not rely on that.

**Phase 2 — package**
4. Bubblewrap init, keystore, `assetlinks.json`, install and verify no address bar.
5. Internal testing track. Real device. Real subscription.

**Phase 3 — submit**
6. Listing assets, data safety form, health declaration, content rating.
7. Closed test with a handful of real users before production rollout.

**Phase 4 — after launch**
8. Play Billing (Blocker 1, option B) once volume justifies it.
9. Native alarm scheduling to remove the server from the reminder path entirely.

---

## What is already done

The hardening pass closed the things that would have made an Android launch
worse, because a packaged app makes every one of them harder to fix:

- Cloud sync and doctor share silently failed above ~121 KB of data. Fixed and
  verified in production at 651 KB.
- A cloud pull wiped local records instead of merging. Now merges on stable IDs.
- The database ran without WAL under 8 concurrent threads, and concurrent
  signups returned 500. Both fixed.
- Stripe webhook failures permanently dropped subscription changes. Fixed —
  which matters more once Play Billing is a second source of truth.
- Stored XSS via a crafted import file, on the origin holding the data
  encryption key. Fixed at every entry point.
- Analytics had been CSP-blocked and recording nothing, so there is no usable
  PWA baseline to compare a Play launch against. Fixed — **let it collect for a
  few weeks before launch so there is something to measure against.**
