# Play Store listing — copy and form answers

Drafted 2026-08-22. Every factual claim here was checked against the running
code, not against the marketing site. Where the two disagree, the code wins and
the marketing copy is the thing to fix.

**Nothing here is submitted automatically.** It is a draft for Justin to review,
edit and paste. The data-safety section in particular is a legal declaration.

---

## App title (30 chars max)

```
My GLP Shot
```
11 characters. Leaves room, and matches `short_name` in the manifest so the
launcher label and the listing agree.

## Short description (80 chars max)

```
Private GLP-1 shot tracker. Doses, weight, side effects. Works offline.
```
70 characters.

Deliberately leads with "private" and "offline" rather than a feature list —
those are the two things that differentiate it from Shotsy and the rest, and
they are both literally true rather than aspirational.

## Full description (4000 chars max)

```
My GLP Shot is a private tracker for GLP-1 and peptide injections. Log your
shot, your weight, and how you actually feel — then see the patterns.

Your data stays on your device by default. There is no account to create before
you can use it, nothing is uploaded unless you choose to turn on backup, and the
app works with no signal at all.

WHAT YOU CAN TRACK
• Shots — dose, date, medication and injection site, with rotation suggestions
  so you are not guessing which side you used last
• Weight, with a chart and a goal
• Side effects — 22 of them, graded mild / moderate / severe, on shot days and
  on the days between
• Mood, appetite and "food noise" — the mental chatter about food that people
  on GLP-1s notice first
• A note for each day, so a number on a chart still means something months later
• Optional cycle tracking, since GLP-1 medications can change cycle length and
  symptoms

WHAT IT SHOWS YOU
• A countdown to your next shot, and a streak
• When your side effects actually tend to land relative to your shot
• Whether your mood or appetite follows your dose cycle
• Plateau detection that tells you when a stall is normal variation
• A PDF report to hand your prescriber

PRIVACY, PLAINLY
Everything is stored on your device. If you turn on cloud backup, your data is
encrypted in your browser before it is sent — with a key derived from your
password, which we never receive. We cannot read your data. That is a
consequence of the design, not a promise.

The one exception is Smart Import, which is optional: if you use it to bring
data over from another tracker, that file is sent to an AI model to be read.
Everything else stays encrypted or stays local. Our privacy policy spells this
out.

The code is open source. You can read exactly what it does.

FREE
Local tracking, body diagram, side effects, mood, weight chart, streaks, the
mixing calculator, and single-device cloud backup.

PREMIUM — $1.99/month or $19.99/year, with a 14-day free trial
Multi-device sync, supply and pen tracking, body measurements, lab tracking,
plateau detection, PDF export, a doctor share link, and the deeper insights.

NOT MEDICAL ADVICE
My GLP Shot records what you tell it and shows you your own data. It does not
diagnose anything and does not recommend a dose. Talk to your prescriber before
changing a dose, a schedule or a medication.

Works with Tirzepatide (Mounjaro, Zepbound), Semaglutide (Ozempic, Wegovy),
Liraglutide (Saxenda, Victoza), Dulaglutide (Trulicity), Exenatide (Byetta,
Bydureon), Retatrutide and compounded peptides.
```

Claims checked against the code: 22 side effects (`SIDE_EFFECTS` in data.js),
7 medications (`MED_PRESETS`), the free/premium split (`applyPremiumGates` and
the pricing endpoint), the trial length and prices (`/api/billing/prices`
returns 199 / 1999 / 14 days).

## Category and tags

- Category: **Health & Fitness** (not Medical — Medical invites a stricter
  review and this is a logging tool, not a clinical one)
- Tags: health, medical, lifestyle — matches `categories` in the manifest

---

## Data safety form

This is the section that gets health apps rejected, and the answers must match
the privacy policy word for word in substance. They do, as of 2026-08-22 — both
`web/landing/privacy.html` and `web/app/privacy.html` were verified.

### Does your app collect or share any of the required user data types?
**Yes.**

### Data types

| Type | Collected | Shared | Purpose | Optional? |
|---|---|---|---|---|
| Email address | Yes | No | Account management, billing | Required only if you create an account; the app works without one |
| Health info (doses, weight, symptoms, cycle) | Yes | **Yes — Smart Import only** | App functionality | Yes — local-only unless you turn on backup or use Smart Import |
| Purchase history | Yes | Yes (Stripe) | Billing | Only if you subscribe |
| App interactions | Yes | No | Analytics (self-hosted Umami; page views and a few product events, no ad cookies, no cross-site tracking) | — |
| Crash logs / diagnostics | No | No | — | — |
| Device or other IDs | No | No | — | — |
| Location, contacts, photos, files | No | No | — | — |

### Is data encrypted in transit?
**Yes** — HTTPS everywhere, HSTS enabled.

### Is data encrypted at rest?
**Yes**, and worth stating precisely: the cloud backup is end-to-end encrypted
(AES-256-GCM) with a key derived in the browser via PBKDF2-SHA-256, 600,000
iterations, salted with the account email. The server stores ciphertext it
cannot read.

### Can users request data deletion?
**Yes** — in-app (Settings → Delete account and all cloud data) and via a public
web page: **https://myglpshot.com/delete-account.html**

### Third parties that receive data, and when
- **Stripe** — only if you subscribe. Billing details. Never health data.
- **Resend** — transactional email only (password reset, email-change notices).
- **Google Gemini, via our own LiteLLM gateway / OpenRouter** — **only** if you
  use Smart Import. Receives the export file you chose to upload, in readable
  form. This is the single path where health data leaves the device unencrypted.
- **Your browser's push service** (Google/Apple/Mozilla) — only if you enable
  reminders. Receives a device token and a fire time; the notification wording
  is chosen server-side from a fixed list, so no personal content is sent.

Not used for training, advertising or profiling. No ad SDKs are present in the
app at all.

---

## Still needed from Justin

- [ ] Package name — permanent after publish. `com.myglpshot.app` suggested.
- [ ] Play Console account and the IARC content-rating questionnaire.
- [ ] Health app declaration — position as personal tracking and logging.
- [ ] Confirm the pricing in the description still matches Stripe at submission.

## Assets ready

- Feature graphic 1024×500 — `web/app/store/play-feature-graphic-1024x500.png`
- Icon 512×512 — `web/app/icons/play-store-512.png`
- Phone screenshots ×3 and a desktop one — declared in the manifest and verified
  to exist at their stated sizes by `scripts/pwa-selftest.mjs`
