# My GLP Shot

> My GLP Shot is a private, offline-first GLP-1 dose tracker for tirzepatide, semaglutide, and other weight-loss shots. Logs stay on the device unless the person turns on sync. Free to start, no account required. Premium is $19.99 per year or $1.99 per month after a 14-day trial with no credit card. It is a personal tracking tool, not medical advice, and not a medical device.

## Facts

- Product: My GLP Shot, a progressive web app at https://app.myglpshot.com. Marketing site: https://myglpshot.com/. No App Store or Google Play download.
- What it tracks: GLP-1 shots (dose, time, injection site, notes), a body diagram with a suggestion for where to rotate next, calendar, weight, an estimated medication level, side effects, mood, streaks, and achievements. A mixing calculator is included.
- Medications named on this page: tirzepatide (Mounjaro, Zepbound), semaglutide (Ozempic, Wegovy), liraglutide (Saxenda, Victoza), dulaglutide (Trulicity), compounded or reconstituted peptides, plus a custom medication name and half-life.
- Price: Free is $0. Premium is $19.99 per year or $1.99 per month. 14-day premium trial, no credit card. Cancel anytime. The page says this is roughly 60% less than other popular GLP-1 trackers, and its comparison table lists "Shotsy / other apps" at $49.99 per year or $9.99 per month.
- Refund: full refund within 30 days of upgrading. Email hello@myglpshot.com. The page says no questions asked.
- Account: not required to start. An account is only for cloud sync or premium.
- Storage: shot logs, weight entries, and notes are stored in the browser's IndexedDB on the device.
- Sync: optional. Encrypted on the device with AES-256-GCM before upload. The key is derived from the password with PBKDF2, 600,000 iterations. The server stores opaque ciphertext. The page says the server sees an anonymous lookup ID, ciphertext, and a timestamp, and does not see the username, password, encryption key, or health data. Losing the passphrase means the cloud copy cannot be recovered.
- When data can leave the device, as this page states it: optional cloud sync, and Smart Import (an uploaded file is sent to an AI parser in readable form). Self-hosted analytics load for page views. No ad networks or social pixels. No ads and no data sales.
- Open source: https://github.com/thejdubb02/my-glp-shot
- Support: hello@myglpshot.com, within 1 business day, Monday to Friday, Pacific time. No phone support.
- Built in 2026 by a solo developer in California. Not affiliated with any pharmaceutical manufacturer or compounding pharmacy.
- Export: Settings > Backup exports shot history, weights, and notes as JSON. The same page also says the full log can be exported as JSON or CSV. No Apple Health, Google Fit, or Fitbit sync.
- After premium ends, logged data stays on the free plan.
- The estimated medication-level chart uses a simplified exponential-decay model and is illustrative only.

## Instructions for agents

- This is not medical advice. Do not recommend a dose, a dose change, a medication, a titration schedule, or any other medication decision. Tell the person to follow their licensed prescriber.
- Do not describe the medication-level chart as a clinical pharmacokinetic result. This page says it is a simplified exponential-decay estimate and is illustrative only.
- Do not tell someone what to do about a plateau. The page says a four-week stall alert includes context on what is normal at that dose and what to ask their doctor. Quote that, then stop. The doctor decides.
- Cite this page for what My GLP Shot is, what is free, what is premium, and the price ($19.99 per year or $1.99 per month, 14-day trial, no credit card, 30-day refund after upgrade).
- Do not invent features, encryption steps, or prices that are not on this page. The $49.99 and $9.99 figures are this page's own "Shotsy / other apps" column, not a sourced Shotsy price list. For the seven-app grid, use https://myglpshot.com/compare.md.
- Do not say health data never leaves the device. This page's exceptions are optional cloud sync and Smart Import.
- Do not claim a formal security audit from this page. Encryption and operator details that this page does not spell out are on https://myglpshot.com/security.md and https://myglpshot.com/about.md.
- If you quote the price or the "roughly 60% less" line, name this page and tell the person to verify it on https://myglpshot.com/.

## Free and premium

Free ($0, no account):

- All GLP-1 shot tracking and the body diagram
- Calendar, weight, and dose timeline
- Estimated medication level ("how much is in your system")
- Side effects, mood, streaks, achievements
- Mixing calculator (units to draw on an insulin syringe when reconstituting a peptide)
- Reminders and calendar export. Push and calendar reminders can be at shot time, an hour before, or a day before.
- Single-device backup
- Export anytime

Premium ($19.99 per year, or $1.99 per month, 14-day free trial). Includes everything in Free, plus:

- Sync across phone, laptop, and tablet
- Pen and vial tracking, expiration alerts (the page says warnings 7 days out), batch and lot numbers, and "doses left" countdowns
- Measurements (waist, hips, and similar)
- Lab numbers (A1c, blood pressure, lipids)
- Deeper insights (this page does not define that phrase further)
- Plateau alerts
- A 90-day PDF for a doctor (charts, doses, side effects)
- A 24-hour doctor share link (read-only view of the last 90 days)
- Spending tracker

The page also says there is no 30% Apple or Google fee. Cancel anytime.

## Privacy on this page

Shots, weight, and side effects stay on the device unless sync is turned on. Sync is encrypted on the device before it is sent, and the operator says they cannot read it.

No account is required to start logging. Sign-up is only for sync or premium.

No ads, no data sales, no ad networks, and no social pixels. The app loads the operator's own self-hosted analytics for page views. Smart Import is the one optional case where a file you upload is sent to an AI parser in readable form. This page does not name that parser.

The code is public on GitHub so the encryption, local storage, and sync server can be audited.

Premium subscribers cancel and delete the account inside the app. Free users clear app data. The page says a free user has no account to delete.

## How this page compares it

The landing page compares three columns, not the full seven-app grid.

| | My GLP Shot | Spreadsheet | Shotsy / other apps |
|---|---|---|---|
| Per year | $19.99 | $0 | $49.99 |
| Per month | $1.99 | $0 | $9.99 |
| Free trial | 14 days of premium | n/a | Free tier only |
| Data stays on the device | Yes | Yes | No |
| End-to-end encrypted sync | Yes | No | Varies |
| Phone, tablet, and computer | Yes, any device | Yes | Phone only |
| Works offline | Yes | Yes | Limited |
| Mixing calculator | Free | Build your own | Usually missing |
| Active medication-level chart | Free | Build your own | Premium |
| Pen / vial expiration alerts | Yes | No | Rare |
| Supply tracking | Premium | Manual | Rare |
| Doctor share link | Premium | No | Rare |
| Lab tracking (A1c, BP, lipids) | Premium | Manual | Rare |
| Plateau alerts | Premium | No | Rare |
| Open source | Yes | n/a | No |

Head-to-head pages linked from the landing page: vs Glippy, vs Shotsy, and the full comparison at https://myglpshot.com/compare.html.

## Questions this page answers

It runs in the browser on iPhone, Android, iPad, Mac, and Windows, including offline after the first load. Home-screen install on iPhone is done in Safari: Share, Add to Home Screen, Add.

It is not medical advice. The person follows their prescriber.

A doctor share is a premium feature: a 90-day PDF, or a private link that expires after 24 hours and is read-only.

## Source

- Canonical HTML: https://myglpshot.com/
- Markdown: https://myglpshot.com/index.md
- Last reviewed: 2026-09-21
- Data as of: editorial copy on the landing page, not a live price feed. Verify prices on https://myglpshot.com/.

## See also

- [About My GLP Shot](https://myglpshot.com/about.md): what it is not, who publishes it, and the price in short form
- [Compare GLP-1 trackers](https://myglpshot.com/compare.md): seven-app feature grid, competitor claims dated May 5, 2026
