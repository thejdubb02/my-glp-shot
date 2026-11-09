# State machines

Every lifecycle in the app, where its state lives, and where it may change.
Most are implicit (a few columns or flags, not one status field). Change a
machine only at the places listed for it; a new write site elsewhere is how
the bugs below got in. Mapped 2026-11-09. Open problems are GitHub issues
labelled `state-machine`.

## Client (web/app)

### Cloud push (explicit): `syncPush` in app.js
- States: idle, pending (debounce timer), pushing, failed (dirty, no timer).
- Every push goes through `accountSyncPush()`, which runs one push at a time.
  `markSyncDirty()` arms it, `resetSyncPush()` disarms it on sign-out and
  account delete. Never call `pushToCloud()` directly.
- Error shown to the user: `settings.syncLastError`, set by
  `noteSyncFailure()`, cleared by a successful push.
- Test: `scripts/sync-push-selftest.mjs`.

### Account / session: `account = { user, encryptionKey }`
- signed out (both null); signed in (both set); signed in without key
  (user set, key null: no backup possible, reported via `syncLastError`).
- Persisted: `mgs_session_token`, `account.cred` (key), `mgs_last_user`
  (offline cache, trusted only when the network fails).
- Writers: signup, login, `tryRestoreAccount`, `accountLogout`, delete account.

### Subscription (derived, read-only on the client)
- From server fields on `account.user`: `subscriptionStatus`, `isPremium`,
  `hasSubscription`, `cancelAtPeriodEnd`, `trialEndsAt`, `premiumUntil`.
- Predicates: `isPremium`, `hasPaidPlan`, `isOnTrial`, `isSubscribedInTrial`,
  `isCancelling`. `onAccountChanged` still re-derives some inline.

### Smaller ones
- Service worker update: `registerSW` reloads on `controllerchange`.
- Install prompt: `deferredInstallPrompt` + `installDismissedAt`.
- Notifications: browser permission x `settings.notify` x push subscription,
  read together in `updateNotifyStatus`.
- Weight edit: `_editingWeightId` (null means new).
- Dose status: none stored. Next and overdue are computed from shot times.

## Server (api/app.py)

### Subscription: `users` billing columns
- `subscription_status`: `trial | premium | lifetime | free` (free text, no CHECK).
- Also `trial_ends_at`, `premium_until`, `stripe_subscription_id`,
  `cancel_at_period_end`, plus `*_test` shadows.
- Truth for access is `is_premium_now()`, computed at read time. A lapsed
  `premium` row is not rewritten to `free`.
- Stripe writes only in `_apply_subscription()` (re-fetched subscription, old-sub
  guard, lifetime never touched). Admin writes: grant-lifetime, extend-trial,
  demote-to-free. Scripts: grant/revoke-premium.
- A missing period end keeps the stored `premium_until` (never NULL a payer).

### Other lifecycles
- Password reset tokens: `password_resets` live, used, expired, purged.
- Sessions: `sessions`, deleted on logout, reset, email change, force-logout.
- Sync blob: `sync_blobs`, one row per user, last write wins (no version check).
- Share links: live or deleted (expiry in the fetch query).
- Push: `push_subscriptions.fail_count`; `push_reminders.sent_at` means queued
  (NULL) or claimed/sent/retired (set).
- Admin: `users.is_admin`, set only by `scripts/promote-admin.py`.
- `users.email_verified_at` is never set; there is no verified state.
