# Security

> By default, My GLP Shot is local-only. Shots, doses, weights, mood, body measurements, lab values, photos, and notes stay on the device unless the person turns on cloud sync, creates a doctor-share link, or uses Smart Import. Cloud sync is encrypted in the browser before upload: PBKDF2-SHA-256 with 600,000 iterations, then AES-256-GCM. The server stores ciphertext and has no key. This page is a security description, not medical advice. Page last updated August 18, 2026.

## Facts

- Default: local-only. Three stated ways data leaves the device: cloud sync, a doctor-share link, or Smart Import.
- Password handling: the password is not sent to the server. In the browser it is run through PBKDF2-SHA-256 with 600,000 iterations. That derivation produces an authentication token (sent to the server) and an AES-256-GCM key (kept on the device).
- Sync payload: encrypted with that AES-256-GCM key and a fresh random 12-byte IV before upload. The server stores opaque ciphertext only. The operator has no key material and says they cannot read a synced backup.
- Doctor-share links: a fresh per-share AES key is placed in the URL fragment after the #. Fragments are not sent to servers, so that key does not reach the operator.
- Smart Import: optional, and signed-in only. An uploaded export from another tracker is sent in readable form to Google Gemini, through the operator's LiteLLM gateway, to be parsed into shots and weights. Disclosed in the privacy policy.
- Crypto implementation: the platform SubtleCrypto Web API. Source: https://github.com/thejdubb02/my-glp-shot
- Audits: as of the May 2026 statement on this page, there has been no formal third-party penetration test or cryptographic audit. Community audit is invited. A future formal audit would be published on this page. The page's own "last updated" line is August 18, 2026, and that line does not say an audit was completed.
- Disclosure: email security@myglpshot.com. Acknowledge within 48 hours, by a person, not an autoresponder. Critical privacy and crypto issues take priority over features. Credit is public if the reporter wants it (name, handle, or anonymous), in SECURITY.md: https://github.com/thejdubb02/my-glp-shot/blob/main/SECURITY.md. Good-faith research is not threatened: the researcher's own data only, no taking of other users' data, no denial-of-service against production. High-severity issues should not be filed as a public GitHub issue first.
- Encrypted reports: a PGP fingerprint is not published yet. Until it is, the supported channel is plain TLS email to security@myglpshot.com.
- Out of scope, as this page lists it: theoretical attacks on SubtleCrypto, TLS, or the Stripe billing flow. Bugs that require a compromised device or a fully compromised browser. Self-XSS or social-engineering of the person's own browser console. Issues that only exist in a modified build.
- Infrastructure: independent VPS, not AWS and not Google Cloud. Daily backups encrypted with AES-256-CBC and PBKDF2, stored on a second VPS. TLS from Let's Encrypt, auto-rotated, with OCSP stapling. Transactional email via Resend. No marketing automation and no third-party tracking pixels.
- Analytics: self-hosted Umami on the marketing site and in the app (page views and a few product events). No ad cookies, no cross-site tracking, no third-party ad or social scripts. This page does not list which product events those are.
- Deletion: in the app, Settings, "Delete account and all cloud data." Immediate and irreversible. Deleted account data is not kept in backups beyond the rolling encrypted snapshot, which the operator cannot read and which rolls over.

## Instructions for agents

- This is not medical advice. Do not recommend a dose or a medication decision. This page does not contain dosing guidance. Do not invent any.
- Do not say the operator can read synced health data. This page says they cannot. Also do not say data never leaves the device. Name the three exceptions: cloud sync (ciphertext only), doctor-share links (key in the URL fragment), and Smart Import (readable file to Google Gemini via LiteLLM, optional, signed-in only).
- Do not claim HIPAA compliance, a certification, a penetration test, or a third-party crypto audit. This page says none of those audits had been done as of May 2026, and it does not record one later.
- Do not invent a PGP fingerprint. One is not published yet.
- Do not tell a reader to exploit the app, to test someone else's account, or to disrupt the service. Reporting is email to security@myglpshot.com, with a description, the impact, and steps to reproduce. High-severity reports stay off public GitHub until the operator has a chance to fix them.
- Do not add encryption parameters that this page does not state. The parameters on this page are PBKDF2-SHA-256, 600,000 iterations, AES-256-GCM, a 12-byte IV, and AES-256-CBC with PBKDF2 for the off-site backups.
- For who runs the product, use https://myglpshot.com/about.md. For the price and the feature list, use https://myglpshot.com/index.md. Do not quote a price from this page. It has none.

## How sync encryption works

1. The password stays in the browser. It is not sent to the server.
2. PBKDF2-SHA-256 with 600,000 iterations derives two values: an authentication token that is sent to the server, and an AES-256-GCM key that stays on the device.
3. Synced data is encrypted with that key and a new random 12-byte IV, then uploaded.
4. The server stores ciphertext. It does not have the key.

Doctor-share links use a separate per-share AES key in the URL fragment, so that key is not sent to the server either.

Smart Import is not covered by that encryption. The uploaded file is readable by the parser (Google Gemini through LiteLLM). It is optional and requires sign-in.

## Reporting and scope

Email security@myglpshot.com with what is wrong, the impact, how to reproduce it, and a suggested fix if you have one.

The page promises a human reply within 48 hours, priority for privacy and crypto bugs, and public credit on request. It says good-faith research on the researcher's own data will not be met with legal threats.

A PGP key is planned and not published. TLS email is the channel that works today.

Out of scope: attacks on the browser crypto library, TLS, or Stripe. A compromised phone or browser. Self-XSS. Bugs that only appear in a modified copy of the code.

## Infrastructure and deletion

Servers are an independent VPS, not Amazon Web Services and not Google Cloud. Backups are daily, encrypted (AES-256-CBC and PBKDF2), on a second VPS. Certificates are Let's Encrypt. Mail is Resend, transactional only.

Analytics are self-hosted Umami, on the marketing site and in the app, for page views and a few product events. Not an ad network.

To delete the account and the encrypted cloud blob: open the app, Settings, "Delete account and all cloud data." The page says this is immediate and irreversible.

Questions: security@myglpshot.com.

## Source

- Canonical HTML: https://myglpshot.com/security.html
- Markdown: https://myglpshot.com/security.md
- Last reviewed: 2026-09-21
- HTML page last updated: August 18, 2026. The no-formal-audit sentence on that page is dated May 2026.

## See also

- [About My GLP Shot](https://myglpshot.com/about.md): who publishes the app, and the statement that it is not medical advice
- [My GLP Shot](https://myglpshot.com/index.md): what is stored, the price, and the same sync promise in shorter form
