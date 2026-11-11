# My GLP Shot: iOS technical spec

Status: proposed, 2026-11-11. Drafted by Codex CLI, reviewed and trimmed by Claude Code (file:line references spot-checked). Scope: keep the web app/PWA exactly as it is and add an App Store app using the same encrypted sync backend.

## Summary

- Wrap the existing web app with Capacitor (the app files ship inside the iOS app, so it opens offline). No rewrite.
- Add native pieces Apple wants to see: on-device dose reminders, Keychain for keys, share/export, in-app purchase.
- Apple requires in-app purchase (StoreKit) for Premium inside the iOS app. Stripe stays on the web. Both unlock the same account.
- Two privacy gaps to settle first (they exist on the web too): Smart Import sends file text to our server and OpenRouter, and web push tells the server when reminders fire.
- Needs: Apple Developer account ($99/yr), a hosted Mac for builds, owner decisions in section 12. Rough effort 5 to 8 weeks.

## 1. Recommended architecture

**Ship a Capacitor app containing a versioned copy of `web/app/`, with small native integrations.**

| Approach | Assessment |
|---|---|
| Capacitor bundled assets | Recommended. Reuses vanilla JS, IndexedDB, charts, sanitizers, encryption and tested sync behavior. Starts offline immediately. Adds native reminders, Keychain, StoreKit and file sharing. |
| Remote WKWebView loading `app.myglpshot.com` | Reject for launch. Requires network for initial loading, couples native releases to website changes, and exposes a native bridge to remotely delivered code. Provides less App Store differentiation. |
| SwiftUI rewrite | Defer. Duplicates roughly 8,000 lines of client behavior and creates substantial crypto, merge, deletion and feature-parity risk. Consider later for specific screens. |

Capacitor itself uses WKWebView. The decision is bundled assets versus remotely loaded application code. Its default iOS scheme is `capacitor`. See [Capacitor configuration](https://capacitorjs.com/docs/config).

Add `ios/`, a pinned Node toolchain and an asset packaging command. Generate a native asset directory from `web/app/`; do not maintain a second handwritten frontend. Production configuration: `webDir` points to generated assets, origin `capacitor://localhost`, no `server.url`.

Introduce narrow platform adapters for API transport, secure credentials, billing, notifications, files and lifecycle events. Preserve browser implementations and the state transitions documented in `docs/state-machines.md`.

## 2. App Store review risks

- **4.2:** A wrapper alone risks rejection. Demonstrate useful offline tracking, native scheduled reminders, native export/share and polished iPhone navigation.
- **1.4.1:** Explain health estimates and their limitations. Keep prescriber warnings. Audit dose-related insights and claims.
- **1.4.2:** The mixing calculator is a particular risk because it calculates injection quantities. Remove it from the iOS launch unless the owner establishes eligibility under Apple's drug dosage calculator requirements.
- **3.1.1:** Offer StoreKit for digital Premium. Existing web purchases can unlock the same account through the multiplatform model.
- **US steering:** Current guidelines permit external purchase links in the US storefront without a link entitlement. This is not a worldwide Stripe exemption.
- **5.1.1:** Keep account deletion available within the app.

These requirements come from [Apple's review guidelines](https://developer.apple.com/app-store/review/guidelines/). Apple announced the US court-driven changes on [May 1, 2025](https://developer.apple.com/news/?id=9txfddzf).

Launch recommendation: StoreKit purchase UI in every supported storefront; retain Stripe on the web. Defer optional US-only external checkout links. If added, use verified App Store storefront information, not device locale or IP, and recheck rules before submission.

Code-specific medical review targets:

- `web/app/data.js:138`: mixing calculator help and syringe-unit instructions.
- `web/app/data.js:225`: modeled active drug levels.
- `web/app/app.js:4898`: schedule drift interpretation.
- `web/app/index.html:809`: existing medical disclaimer.

Provide a review account with synthetic data, working Premium access, offline demonstration instructions and explicit notes identifying native functionality.

## 3. One Premium entitlement, two billing providers

Current entitlement truth is `is_premium_now()` in `api/app.py:353`. `public_user()` at line 369 and client subscription predicates currently assume one Stripe subscription. **Do not let Apple callbacks write directly into those shared billing columns.**

Add one table, `apple_subs`: user id, environment, original transaction id (unique), product, expires_at, revoked_at, last signed transaction date. Stripe keeps its existing columns on `users`; trial and lifetime/admin grants stay where they are. `is_premium_now()` becomes "existing Stripe/trial/lifetime check OR an unrevoked `apple_subs` row with `expires_at > now`".

Claude's review note: Codex's first draft proposed five new tables (`billing_sources`, `apple_transactions`, `billing_events`, `purchase_intents`, `premium_grants`) and moving Stripe into a generic ledger. That rewrites billing that was just hardened in #26 to #31. Start with the one table above; a generic ledger only earns its place if a third provider (Google Play, see `docs/android-play-store-plan.md`) arrives.

Uniquely bind each Apple original transaction ID to one My GLP Shot account. Use a server-generated random UUID as `appAccountToken`, never email or health data.

Define access as the union of valid provider periods, approved grace periods, account trial and admin grants. A cancellation or refund affects only its own source. Overlapping subscriptions do not add durations together.

Return backward-compatible `isPremium` plus provider-aware fields: `billingSources`, `accessExpiresAt`, `willRenew`, `managementProvider` and `pendingPurchase`. Replace Stripe-specific assumptions behind `hasSubscription`.

### Purchase and restore

1. Require My GLP Shot sign-in before buying or restoring.
2. Native StoreKit 2 bridge loads localized monthly/yearly products in one subscription group.
3. Server checks all billing sources before issuing a purchase intent.
4. Client purchases with `appAccountToken` and submits the signed transaction to `POST /api/billing/apple/verify`.
5. Server verifies Apple's signature chain, bundle/app identity, environment, allowed product and account binding.
6. Persist verified purchase and recompute entitlement atomically. Finish the StoreKit transaction after durable acceptance.
7. Consume unfinished transactions and transaction updates after restart. Provide explicit Restore Purchases and subscription management.

Use Apple's server library and [App Store Server API](https://developer.apple.com/documentation/appstoreserverapi) for verification and reconciliation.

### Replay and ordering safety

- Add App Store Server Notifications V2 endpoint; verify outer and nested signed payloads before trusting identifiers.
- Treat notifications as reconciliation triggers, not instructions to overwrite entitlement.
- Store verified transaction facts by transaction ID. Persist revocations explicitly so an older purchase event cannot revive a refunded transaction.
- Serialize reconciliation per provider subscription. Fetch current provider state inside that serialized workflow; reject stale writes using a revision.
- Commit source updates, entitlement projection and processed-event marker together. Alternatively, acknowledge only after inserting a durable retryable inbox event.
- Preserve Stripe's signature verification, current-state refetch and old-subscription protection at `api/app.py:1383` and `api/app.py:1482`.
- Replace the blanket nondecreasing-expiry rule with explicit handling for authoritative refunds/revocations.
- Isolate Apple sandbox and Stripe test records from production entitlement.
- Periodically reconcile sources to recover missed notifications. Provider outages must not erase already verified access.

### Preventing double charges

Change `api/app.py:1232` checkout admission to check **both** providers. The current Stripe lookup fails open on errors; purchase admission should fail closed when provider status is uncertain.

Block purchases when another paid source, pending purchase or cancellation-through-expiry exists. Offer management of the existing provider. Switching providers happens after existing access expires.

Reserve one active purchase intent per account; reuse Stripe Checkout sessions with idempotency keys and expire competing sessions.

**Absolute prevention across Apple and Stripe is impossible:** delayed Apple approvals, external renewals and already-open checkout flows can race. Detect overlap after every reconciliation, suppress further offers, show both management routes and provide a refund/support process. Never silently cancel a valid purchase.

Keep the existing account trial separate from StoreKit introductory eligibility. Do not promise every existing user a fresh 14-day Apple trial.

## 4. Native origin, auth and security changes

| Existing code | Required change |
|---|---|
| `web/app/app.js:6079` | Replace relative API constants with platform-configured `https://app.myglpshot.com/api` for native. |
| `web/app/app.js:1027` | Route the separate signup/login fetch through the same adapter. Audit reset, legacy sync and share fetches too. |
| `web/app/app.js:6114` | Native requests use Bearer auth with `credentials: 'omit'`; web retains its existing cookie path. |
| `api/app.py:401` | Existing Bearer support can serve native clients. Authenticate every request independently of Origin. |
| `api/app.py:1012` | Keep web cookies Secure, HttpOnly and SameSite=Lax. Avoid a SameSite=None workaround for WKWebView cookie restrictions. |
| `api/app.py:264` | Retain JSON mutation checks and review CSRF assumptions when introducing CORS. |
| `deploy/nginx-app.myglpshot.com.conf:9` and `:50` | Ensure OPTIONS and actual responses receive consistent CORS handling across specialized and generic API locations. |
| `deploy/mgs-security-headers.conf:21` | Native bundled documents need their own CSP; nginx headers do not protect locally loaded assets. |
| `web/app/app.js:7708` | Generate doctor-share URLs using the HTTPS app domain, not `location.origin`. |

Implement CORS in one layer, preferably Flask:

- Exact allowed origin `capacitor://localhost`, plus explicitly needed web origins.
- Allow only required methods and `Authorization`, `Content-Type`, `Accept`.
- Return `Vary: Origin`; include CORS on errors and preflights.
- No wildcard, arbitrary origin reflection, `null` origin or credentialed native cookies.
- Retain rate limits, TLS and existing web security headers.

Native CSP: bundled scripts only, explicit API `connect-src`, existing required image/blob/style allowances, no remote analytics or Stripe scripts. CSP meta cannot implement `frame-ancestors`; constrain native navigation and bridge access separately.

Open external sites in the system browser. Never navigate the bridge-enabled webview to arbitrary remote content. Omit the embedded admin UI from native launch.

## 5. Offline storage and service workers

The native bundle supplies the shell. **Do not rely on service workers under `capacitor://localhost`.**

Skip native SW registration, controller reloads, browser installation UI and web update checks at `web/app/app.js:3616` and `:3645`. Keep the existing PWA SW unchanged for browsers.

Retain IndexedDB initially. Test persistence across app termination and signed upgrades; never clear website data during updates. Safari/PWA and native storage are separate: migrate using encrypted account sync or explicit file import.

On foreground/network recovery: pull, merge and push through existing synchronization entry points. Preserve tombstones, conflict retries, device ownership and email-change locking. Background execution is opportunistic, never required for durable local logging.

Offline Premium uses the last verified server snapshot with a documented bounded expiry policy. Free local tracking remains usable. Never trust an editable local boolean as online entitlement authority.

## 6. Keys and privacy

Move native session tokens and remembered AES keys from localStorage (`web/app/app.js:6118`, `:6327`) into a narrowly scoped Keychain bridge.

- Use device-only, nonsynchronizing accessibility, normally `WhenUnlockedThisDeviceOnly`.
- Optional biometric unlock can gate access; avoid requiring background decryption.
- Preserve existing PBKDF2/AES-GCM formats for cross-platform compatibility.
- Keep decrypted keys in memory only after unlock. Never persist passwords.
- Apply key rotation during email changes and clear credentials on logout/deletion.
- Handle Keychain items surviving reinstall: detect a new installation and require deliberate account restoration.
- Keychain protects credentials, not plaintext IndexedDB records. Define native backup exclusions and app-lock behavior separately.

Two existing privacy conflicts need explicit resolution:

1. Smart Import sends plaintext health files to the API and OpenRouter (`web/app/app.js:2142`, `api/app.py:2499`). Disable that path for native launch and resolve the web exception against the stated privacy rule.
2. Analytics receives health-related counts during export (`web/app/app.js:2120`, approximately). Exclude analytics from native packaging and audit all event properties.

The server already holds email and billing metadata. Document necessary identity/payment metadata separately from the promise that health content remains ciphertext.

## 7. Reminders and push

**Launch with native local notifications**, using schedules computed on-device. Reuse `computeUpcomingReminders()` behind a notification adapter.

Schedule a bounded rolling queue within iOS limits; rebuild after edits, sync, foregrounding and timezone changes. Cancel stale reminders on account switch/deletion. Use generic lock-screen wording by default.

The existing VAPID code (`api/push_send.py:32`) is Web Push, not an APNs transport. Keep it for the PWA. Native notifications require native permission handling, not browser `Notification`/`PushManager`.

Current web schedules expose `kind` and `fireAt` (`api/app.py:2393`), so the existing server does learn reminder metadata. Native local notifications avoid that disclosure.

Defer APNs unless remote notifications are needed. Then store device tokens with consent and send generic signals or encrypted content. Never include medication, dose, weight or notes in APNs payloads. Silent pushes cannot guarantee timely sync or reminders. Prevent duplicate local/APNs delivery.

## 8. Optional HealthKit

Defer until after launch. Start with opt-in body-mass import/export using a small native bridge.

Request only required types with clear purpose strings. Keep processing on-device; sync imported values only inside the existing encrypted payload. Deduplicate using HealthKit sample IDs and source metadata; define deletion behavior before enabling bidirectional writes.

Do not use HealthKit data for advertising, analytics or AI. Review cloud handling and consent against [Apple's HealthKit privacy requirements](https://developer.apple.com/documentation/healthkit/protecting-user-privacy).

## 9. Build, signing and releases without owning a Mac

Develop shared JS and run existing Node tests on Linux. **iOS compilation, simulator tests, archiving and signing still require macOS/Xcode**, available through a hosted macOS runner or rented Mac.

Owner supplies Developer Program membership, legal entity details, bundle ID, App Store Connect record, subscription products and agreements. Obtain approval before new infrastructure spend.

CI: existing client suites and offline API suites on Linux; pinned Xcode/Capacitor dependencies, simulator tests and signed archives on macOS. Use protected secrets or runtime secret retrieval, temporary signing keychains and least-privilege App Store Connect credentials.

Xcode Cloud is an alternative; initial configuration may require hosted Xcode access. See [Apple's workflow setup](https://developer.apple.com/documentation/xcode/configuring-your-first-xcode-cloud-workflow).

TestFlight on a physical iPhone is a release gate. Simulator success is insufficient for notification, purchase, Keychain and lifecycle behavior.

Ship native HTML/JS/CSS changes through App Store releases initially. Keep web deployments independent. Maintain backend compatibility with older native versions; use additive migrations and versioned payload handling. No remote executable-code update mechanism at launch.

Owner approves uploads and public releases. Include privacy labels/manifests, encryption export-compliance determination, screenshots, support/privacy URLs and review credentials.

## 10. Account deletion

Extend the existing `DELETE /api/me` and `_delete_user_everywhere()` at `api/app.py:718` and `:746`.

Apple subscriptions cannot be canceled like Stripe subscriptions. Replace the current UI promise that deletion cancels every subscription (`web/app/app.js:1505`) with provider-specific wording.

Offer Apple subscription management, explain continuing billing, and allow immediate deletion without requiring cancellation first. Remove cloud data, credentials, notification registrations and account links. Retain only legally necessary billing records with documented minimization and retention.

Late billing events must never recreate deleted accounts. Apple's [account deletion guidance](https://developer.apple.com/support/offering-account-deletion-in-your-app/) explicitly addresses continuing Apple subscriptions.

## 11. Phases and acceptance gates

| Phase | Rough effort |
|---|---|
| Resolve calculator/privacy scope, storefronts, developer account and pricing | 2-4 days |
| Capacitor packaging, transport/CORS, CSP, Keychain, lifecycle and file adapters | 5-8 days |
| Provider ledger, StoreKit bridge, verification, notifications and reconciliation | 8-12 days |
| Native reminders, accessibility, iPhone polish and deletion flow | 4-6 days |
| CI, device/TestFlight QA, review materials and fixes | 5-8 days |

Estimate: **5-8 engineer weeks**, plus owner decisions and App Review time. HealthKit adds roughly 1-2 weeks.

Required checks: existing client gate; offline billing replay tests covering reversed events, duplicates, refunds, concurrent purchases, sandbox isolation and deletion; account-switch/key-rotation tests; cold offline launch; signed upgrade persistence; DST reminders; restore after reinstall; web/native concurrent edits and deletion tombstones.

## 12. Owner decisions

- US-only launch or multiple storefronts? Which legal entity submits?
- Approve removing the mixing calculator from iOS launch?
- Remove Smart Import entirely, or replace it with local parsing?
- Keep current prices after Apple fees? Offer an Apple introductory trial?
- Which hosted Mac service and budget?
- What offline Premium grace period and provider-switch policy?
- Should account deletion also erase local records by default?
- Is HealthKit worth delaying launch?
- Who handles duplicate-charge refunds and App Review correspondence?
