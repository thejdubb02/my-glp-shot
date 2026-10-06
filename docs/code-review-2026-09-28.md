# Code review, 28 September 2026

A read-only review in four areas (accounts, billing and push, sync and data,
core logic), run with the agy CLI, then every finding checked against the code
by hand. Twelve were real and are fixed in `194612c` (server) and `002af7a`
(client), release 0.65.0. Each fix has a test that fails on the previous code.

## Fixed

| Area | Defect | Effect |
|---|---|---|
| Accounts | Signup granted admin to any address in `MGS_ADMIN_EMAILS`, unverified | One listed address had no account, so anyone could claim admin over all user data. Not exploited. |
| Accounts | A failed `/api/me` was read as "signed out" | Opening the app offline, or during an API outage, hid a signed-in user's whole log behind the sign-in screen |
| Sync | Content keys for supplies, cycles, med changes and expenses named fields the records never had | A restore or a pull onto a new device kept one supply, one cycle and one med change and dropped the rest |
| Sync | Editing a shot minted a new uid; pull-side sanitizers stripped uid and updatedAt; a known uid was always skipped | Edits duplicated on other devices or never reached them |
| Sync | Six savers wrote with a raw `put` | Those rows never got a uid |
| Billing | Webhooks applied from the event snapshot | A delayed "active" could revive a cancelled subscription |
| Billing | A late cancel for an old subscription overwrote the live subscription id | Account deletion would cancel the dead one and leave the live one billing |
| Billing | Cancelling kept the subscription id, and a trial user who cancelled became "premium" | The app went on saying "Subscribed" |
| Push | Unsubscribing one device deleted the account's queued reminders | Other devices went silent |
| Push | A transient send failure marked the reminder sent | Never retried |
| Dates | Shot timestamps were filed under their UTC date | Evening shots west of UTC counted toward the next day |
| Dates | The daily reminder stepped forward 24 hours, not one day | Skipped a day across spring-forward |
| UI | "Holding steady" read the oldest shots; the next-shot panel quoted the first shot ever | Wrong badge, wrong "last shot" |

Checked and rejected: the CSRF claim (the session cookie is `SameSite=Lax`, so
a cross-site POST carries no session), the admin-token shape claim (the
configured token is not session-shaped), and the metrics claim (the dashboard
already counts only users whose access is current).

## Not fixed

- **Importing the same CSV twice doubles it.** File imports do not dedupe
  against what is already stored.

It is on the GLP board in Kaneo.

## Follow-ups the same day

- **0.65.1: a pending cancellation is shown.** A cancel from the billing
  portal sets `cancel_at_period_end` and the subscription runs to the end of
  the trial or period. It is now stored and the app says "Cancelled. Access
  until DATE" with a Resume button, instead of promising a first payment.
- **0.65.2: doctor share links and password reset worked again.** Found by
  running the release in the Android and iPhone test browsers. The site's CSP
  (added in August) blocks inline script, and `view.html`, `reset.html` and
  the theme snippet were all inline, so a share link sat on "Loading..." and
  the reset form did nothing. Only production sends the header, which is why
  no Node test could see it. The scripts are now separate files and
  `pwa-selftest` fails on any inline script. Verified end to end on live with
  a throwaway account on both engines.
- **0.66.0: deletions sync.** Deleting records a tombstone that travels in
  full syncs and backups (payload v11, IndexedDB v12) and removes the row on
  every other device unless that copy was edited after the delete. Tombstones
  expire after 180 days and stay out of doctor shares.

## Later

- **0.67.0 (2026-10-06): weight entries can be fixed.** A user typed 118
  for 218, the app showed a 100 lb weekly loss and awarded a badge, and there
  was no way to correct it. Insights > Weight now has "Entries and weekly
  change": every weigh-in grouped by Monday-start week with that week's
  change, and a tap opens the entry to edit or delete. A new weight more than
  10% from the nearest other weigh-in asks "Save anyway?". Badges the data no
  longer earns are removed from settings. Test: `weight-edit-selftest`.
  Verified on both test browsers and live.
- **Open: legacy `myglpshot.com/app/` cannot reach the API.** The account API
  path is relative, so `/app/api/me` gets `index.html` and session restore
  fails. `app.myglpshot.com` is unaffected. Kaneo GLP-13.
