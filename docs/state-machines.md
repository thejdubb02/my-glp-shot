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
- Email change rotates the key, so `accountChangeEmail()` runs inside
  `withSyncPushHeld()`: it waits for running and queued pushes, then holds the
  queue until the re-encrypted blob is stored and the new key swapped in.
  Pushes asked for meanwhile run after it with the new key.
- Version check: each PUT sends `baseUpdatedAt` (`settings.syncLastUpdatedAt`,
  the server's `updatedAt` this device last saw, null before the first push;
  null is refused while a blob exists, so a fresh device merges first).
  A 409 `stale` means another device pushed since: `pushToCloud()` pulls,
  `applyPulledPayload()` merges, then retries once with the pulled `updatedAt`.
  A second 409 fails the push and leaves it dirty for the next retry.
- Error shown to the user: `settings.syncLastError`, set by
  `noteSyncFailure()`, cleared by a successful push.
- Tests: `scripts/sync-push-selftest.mjs`, `scripts/sync-conflict-selftest.mjs`.

### Synced record deletion: `tombstones` store in app.js
- States per record: live, tombstoned (row gone, tombstone kept 180 days).
- UID stores delete through `dbDelSynced()` (key: uid or content key). A legacy
  row (no uid, or a `ck-` uid) is also buried by the `ck-` uid derived from its
  content, so a delete on a device that pulled it reaches the uid-less copy
  (`rowBuried`). Daily
  stores (notes, moods, appetites, foodNoise, symptoms) delete through
  `dbDelDay()` (key `day|store|date`); an un-ticked symptom is tombstoned on
  its own in `saveSymptomDay()` (key `day|symptoms|date|symptom`).
  Symptoms carry `seAt` (ms per symptom); their tombstones compare against it,
  and a merge keeps the source times instead of stamping now. Payload v12.
- A pull folds tombstones in (`mergeTombstones`), removes older local copies
  (`mergeStore`, `pruneDailyRows`) and skips older pulled rows. A row written
  after the delete (newer `updatedAt`) wins. Never delete a synced row
  directly. A pulled mood, appetite or food-noise row replaces the local one
  only when its `updatedAt` is newer (no stamp counts as oldest).
- A device whose last push (`syncLastPushAt`, taken when the push starts) is
  older than the 180-day prune window may have missed tombstones. On an
  account cloud pull (`applyPulledPayload(p, { cloud: true })`) it first drops
  local rows no newer than that push that the cloud copy no longer holds
  (`dropRowsDeletedWhileAway`). Only when `syncLastPushV` equals the cloud
  payload version; file and legacy restores never delete, and they (and
  `importRows`) clear `syncLastPushV`, since imported rows keep old stamps the
  cloud has not seen. The next successful push sets it again.
  Tests: `scripts/sync-merge-selftest.mjs`, `scripts/daily-delete-selftest.mjs`,
  `scripts/daily-lww-selftest.mjs`, `scripts/stale-device-selftest.mjs`.

### Account / session: `account = { user, encryptionKey }`
- signed out (both null); signed in (both set); signed in without key
  (user set, key null: no backup possible, reported via `syncLastError`).
- Persisted: `mgs_session_token`, `account.cred` (key), `mgs_last_user`
  (offline cache, trusted only when the network fails).
- Writers: signup, login, `tryRestoreAccount`, `accountLogout`, delete account.
- Native API requests omit cookies and use the stored Bearer token for sessions.
  The API ignores session cookies on requests from `https://localhost`,
  `capacitor://localhost`, and exact origins added through `MGS_NATIVE_ORIGINS`
  (comma-separated). These origins receive CORS headers without credential
  support. Stripe webhooks are excluded. Web sessions still prefer the cookie
  and fall back to the Bearer token.
- Native server address (`mgs_api_base`) may change only while signed out, so a
  session token never reaches another server. On a custom server the device
  owner is stored as `<api base>#<user id>`, since ids are unique per server.
- Device owner: `mgs_device_owner` (localStorage, kept across sign-out and
  account delete). Every sign-in calls `claimDevice(user)` before any push; a
  different account erases local data first (`eraseLocalData`). No owner
  recorded keeps the data. Sign-in pulls and merges before it pushes.
  Restore uses `account.cred` only when its email matches the signed-in
  user (trimmed, case-insensitive); otherwise it clears it and stays
  signed in without key.
  Sign-out runs `flushBeforeSignOut()` first. Test: `scripts/account-switch-selftest.mjs`.

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
- Native app reminders (`IS_NATIVE`): no push subscription and no server.
  `scheduleNativeReminders` in `js/reminders.js` is the only writer: each run
  cancels everything pending on the phone and queues the list again (one
  repeating entry per enabled daily reminder, one dated entry per upcoming
  shot), and queues nothing unless the phone's notification permission is
  granted. A phone that was never asked is asked once, when there is
  something to queue (settings arrive with sync). It runs wherever the web app would re-arm its timer, so shot
  reminders only reach as far ahead as the last time the app was open.
  Test: `scripts/platform-selftest.mjs`.
- Weight edit: `_editingWeightId` (null means new).
- Dose status: none stored. Next and overdue are computed from shot times.

## Server (api/)

### Subscription: `users` billing columns
- `subscription_status`: `trial | premium | lifetime | free` (free text, no CHECK).
- Also `trial_ends_at`, `premium_until`, `stripe_subscription_id`,
  `cancel_at_period_end`, plus `*_test` shadows.
- Truth for access is `is_premium_now()`, computed at read time. A lapsed
  `premium` row is not rewritten to `free`.
- Stripe writes only in `_apply_subscription()` (re-fetched subscription, old-sub
  guard, lifetime never touched). Admin writes: grant-lifetime, extend-trial,
  demote-to-free; each refuses with 409 (`_live_subscription_block`) while the
  user has a live subscription (`stripe_subscription_id` or its test shadow set
  and status `premium`/`trial`), so the admin cancels in Stripe first.
  Scripts: grant/revoke-premium.
- Account delete (self `DELETE /api/me` and admin `DELETE /api/admin/users/<id>`)
  goes through `_delete_user_everywhere()`: cancel live and test subs first; if a
  cancel fails (not "already canceled / no such sub") nothing is deleted and the
  route returns 502.
- A missing period end keeps the stored `premium_until` (never NULL a payer).
- Webhook idempotency: the live webhook writes its `stripe_events` row only
  after the handler succeeds, so a crash mid-handler leaves no row and Stripe's
  retry runs it; concurrent duplicates may both run, safe because it re-fetches.
  The test webhook claims first (`TEST:` ids, released on error) because it
  applies event snapshots; a killed test worker can still lose a test event.
  Test: `scripts/api-webhook-selftest.py` (offline, not in run-tests.sh).

### Other lifecycles
- Password reset tokens: `password_resets` live, used, expired, purged.
- Sessions: `sessions`, deleted on logout, reset, email change, force-logout.
  Created only by `_create_session`, which inserts only if `password_hash` still
  equals the hash the caller verified (one conditional INSERT), so a login racing
  a reset cannot leave a session behind; no row means 401 `invalid_credentials`.
  Test: `scripts/api-auth-selftest.py` (offline, not in run-tests.sh).
- Sync blob: `sync_blobs`, one row per user. `updated_at` is the version: it
  only goes up (stored + 1 within a second). `sync_put` writes only if
  `baseUpdatedAt` is missing (old clients, last write wins), null with no blob
  stored yet, or not older than the stored `updated_at`, in one conditional upsert; else 409 `stale`.
  Test: `scripts/api-sync-selftest.py` (offline, not in run-tests.sh).
- Share links: live or deleted (expiry in the fetch query). The label is never
  plaintext on the server (issue #25): the doctor reads it as `shareLabel`
  inside the encrypted payload, the owner's copy is `label_enc` ("iv.ct",
  AES-GCM under the account key). `share_create` ignores a plaintext `label`
  from old clients, `share_fetch` returns no label, and `init_db` nulls the
  legacy `label` column at every boot. An email change re-keys the account, so
  `label_enc` on links made before it no longer opens (links last 24 h).
  Test: `scripts/api-share-selftest.py` (offline, not in run-tests.sh),
  `scripts/share-label-selftest.mjs`.
- Push: `push_subscriptions.fail_count`; `push_reminders.sent_at` means queued
  (NULL) or claimed/sent/retired (set).
- Admin: `users.is_admin`, set only by `scripts/promote-admin.py`.
- `users.email_verified_at` is never set; there is no verified state.
