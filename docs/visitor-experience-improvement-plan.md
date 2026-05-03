# My GLP Shot — Visitor Experience Improvement Plan

**Drafted 2026-05-03 from a real headless mobile audit + LLM critiques + funnel inspection.**

The site, the app, and the AEO scaffolding are all working and on-brand. This plan is the next layer: make the **visitor → installer → premium-trialer → retained-user** path actually flow. Every item below is concrete, ranked by expected lift × effort.

---

## What's already strong (preserve, don't touch)

- Above-fold hero is clear and on-brand: H1, two visible CTAs, trust microcopy.
- Privacy-first messaging is consistent and specific (the AES-256-GCM / PBKDF2 / 600k iters claim is the kind of evidence that actually moves privacy-skeptical visitors).
- 9 valid JSON-LD blocks, 26-Q FAQ schema, llms.txt, every AI bot UA reaches 200.
- Cross-device sync works end-to-end (verified by smoke probe in 2 browser contexts).
- Mobile install bottom-sheet is polished and platform-aware.
- 32-achievement system with branded share cards.

---

## P0 — High-impact bugs and friction (do this week)

### 1. **Duplicate "How My GLP Shot compares" sections** ⚠ live bug
The landing page renders the comparison **twice** — first as `#vs` (a real table with prices + features) and again 800px later as `#compare` (the cards I added in this session). Same H2, both visible. Visitors think "wait, why is this here twice?"

**Action**: delete `#compare` (the cards) and merge any unique copy from it into `#vs`'s subhead. The table is better than the cards because it has concrete numbers ($19.99 vs $49.99) and a clear scannable matrix.

### 2. **App's auth gate is a hard wall**
First visitor experience at `app.myglpshot.com` is "Create account" / "Sign in". No demo, no try-without-account button. The privacy story is "no account required to start" but the door says otherwise.

**Action**: add a "Skip for now → just try it" link below the signup form that drops you straight into the app with local-only mode. Track `tried_without_account` so we can measure how many take this path and how many of them later convert. The PWA already works without an account (it's the headline feature) — we just have to surface it.

### 3. **Landing page is ~12,500 px tall on mobile (≈15 viewports)**
Sections in order today: hero (635) → glance (534) → features (2840) → vs-table (1541) → pricing (1545) → trust (735) → **dup compare (1290)** → faq (1110) → glossary (2261).

**Action**: collapse + reorder.
1. Hero
2. Privacy at a glance (TL;DR for skimmers)
3. Pricing (move up — second-most-asked question after "what is this")
4. vs-table (the comparison)
5. Features (compress: convert long feature grid into 6 tightest features + "and more" link to a `/features` deep-page)
6. Trust
7. FAQ
8. Glossary (move to `/glossary` as its own page — this is SEO long-tail content, not first-visit content)

This compresses to ~6 viewports while preserving the SEO content on a deeper page.

### 4. **CTA copy A/B candidate**
Current: "Try it free →" / "See pricing"
Better candidates (test):
- "Start tracking free →" (action verb, specific)
- "Open the app →" (matches the actual destination)
The hero CTA gets 100% of the clicks — improving it 1% = the highest-leverage copy change on the site.

### 5. **The body paragraph competes with the H1**
The H1 "Track your GLP-1 shots without giving away your health data" lands. Then a body paragraph repeats the same idea in different words. Cut the paragraph entirely, or replace it with a single sentence: "Free to start. No account required. Works offline."

---

## P1 — Conversion-path improvements

### 6. **Surface the price advantage above the fold**
"$19.99/year, ~60% less than popular GLP-1 trackers" is buried in the second paragraph. Promote it to a one-line callout near the CTAs: **"$19.99/year · ~60% less than Shotsy"**. Specific competitor name in the comparison is risky for trademark (test the wording with legal if pushing further) — a softer "vs popular alternatives" works too.

### 7. **In-app: capture the "first shot" moment**
Right now the user lands on the home tab with a "Log your first shot" empty state. Instrument it:
- Track `first_shot_logged` event with `time_since_install_ms`.
- After the first shot saves, fire a one-time celebratory toast: "First shot logged. We're storing it on this device only — no account required."
- Reinforces the privacy story at the moment of trust commitment.

### 8. **Premium trial start → premium trial end funnel**
We have `start_trial` events, but no "trial ending in 3 days" reminder via the in-app notification system. Most trial conversions happen because users got a heads-up; without it they drift.

**Action**: schedule a local notification on day 11 of the trial: "Your premium trial ends in 3 days. Keep the doctor share, lab tracking, and sync, or we'll switch you back to free automatically." (No card-on-file means no surprise charge — leverage that as a trust message.)

### 9. **Pricing page: add a one-line "what you keep when premium ends"**
Visitors evaluating premium often worry about lock-in. Add: "When your trial ends, you keep all your data. You go back to free with everything you logged still on your device."

### 10. **Add a "real screenshots" carousel**
Today the marketing site shows the OG hero (a clean phone mockup) but no actual product screenshots. Add 3-4 screenshots of the actual app (home with countdown, weight chart, share-card share dialog, achievements grid). Visitors evaluating a tracker want to see the actual UI.

---

## P2 — AEO / discoverability layer (compounding gains)

### 11. **Build out `/features`, `/glossary`, `/compare` as standalone pages**
Each of these is currently a section on the homepage. Splitting them:
- Lets each page rank for narrower long-tail queries ("GLP-1 mixing calculator," "what is lipohypertrophy in injections," "Shotsy vs My GLP Shot").
- Lets the homepage be shorter and more focused.
- Each new page gets its own Schema.org block (Article or FAQPage subset).

### 12. **Add `/blog` with 3-5 evergreen articles**
Specifically targeting the questions people ask LLMs and Google:
- "How to track compounded Tirzepatide privately" — high-intent, low competition.
- "GLP-1 shot rotation: why it matters and how to do it" — educational, links the site to clinical authority.
- "Half-life of Tirzepatide: what your weekly cycle actually looks like" — leverages the level-chart feature.
- "What to bring to your GLP-1 follow-up appointment" — surfaces the doctor-share feature.
- "Why I built My GLP Shot" — founder voice, trust.

Each article: 800-1500 words, BlogPosting schema, internal-linked from FAQ + glossary, surfaced in `/llms-full.txt`.

### 13. **Add `aggregateRating` / `Review` schema once you have real reviews**
Don't fake it. But once even 5 real reviews exist (collect via in-app prompt after 30 days), add the schema — star ratings show up in Google AI Overviews.

### 14. **Submit sitemap to Google Search Console + Bing Webmaster Tools**
If not done yet, takes 5 minutes and starts the indexing clock for the new schemas.

### 15. **Generate `/changelog.html` from git history**
Auto-generated from `git log` filtered to release commits. Updated lastmod in sitemap. Signals to crawlers the site is actively maintained — a small but real ranking signal in 2026.

---

## P3 — Trust & authority signals

### 16. **Founder bio block on the landing page**
A small "Built by" section near the trust block: photo, 2-line bio, link to GitHub profile + LinkedIn. People trust people, especially for health data. The site says "Willhite Strategy Group" but no human name surfaces.

### 17. **Add a "Press / mentions" placeholder**
Even without real press yet, a "Open source on GitHub · Independently audited code (audit yourself)" badge row reinforces credibility. When real mentions land (Hacker News, Reddit r/Tirzepatide, etc.), swap them in.

### 18. **Public security disclosure policy**
`/security.html` page with: how to report a vulnerability, what we promise (acknowledge in 48h, fix critical issues fast, public credit), PGP key. Cheap to ship, signals seriousness.

### 19. **Accept the "no clinical validation" critique honestly on a single page**
Both LLMs flagged the lack of clinical validation. Add `/safety.html`:
- "What this app is" (a journal that helps you communicate with your prescriber)
- "What it is not" (medical advice, dosing guidance, a substitute for clinical monitoring)
- "When to call your doctor, not your tracker" (severe nausea, hypoglycemia symptoms, etc.)
This makes us **more credible**, not less, by being honest about limits. LLMs can cite it confidently.

---

## P4 — In-app polish for retention

### 20. **Onboarding wizard (3 screens, dismissible)**
Right now: brand-new user lands on home tab and has to figure it out. A 3-screen onboarding:
1. "What are you tracking?" → Tirzepatide / Semaglutide / Compounded / Other (pre-fills medication name + half-life)
2. "When was your last shot?" → seeds the cadence chart immediately
3. "What's your starting weight?" (optional) → unlocks the weight-loss achievements

Tracks completion rate, dropoff per screen.

### 21. **Reduce time-to-first-value**
Today: open app → see empty home tab → tap + Log shot → fill modal → save. That's ~30 seconds and 5 taps.

Target: from "open app" to "I see something useful" in 2 taps. After the onboarding wizard sets a medication + last-shot date, the home tab already shows: countdown, level curve estimate, suggested next site. Zero shots logged yet, but the app already feels alive.

### 22. **Achievements as a habit-forming push**
Currently achievements unlock silently and fire confetti. Promote them: when an achievement unlocks, the share-card modal should auto-open with a "Share to Instagram?" / "Share to your group chat?" CTA. The 32 standardized cards are perfect viral assets and they'd drive zero-cost UGC marketing.

### 23. **Day-7 retention nudge**
On day 7 after install, if the user has logged ≥3 shots: an in-app celebration ("You've logged 3 shots — most users who log 3 stick with the app for 6+ months. Want to enable cloud backup so you don't lose this if you switch devices?"). Conversion lever for premium without being pushy.

---

## P5 — Speed, performance, accessibility

### 24. **Hero image: serve WebP with PNG fallback**
The OG image at /og-image.png is 549 KB. Convert to WebP (~80 KB) and serve via `<picture>`. Same on `/twitter-image.png`. Faster mobile first paint.

### 25. **Inline critical CSS, defer the rest**
Currently `landing.css` is ~12 KB external. Inline the above-the-fold styles (hero + glance), load the rest async. Should shave 100-200ms off LCP on slow mobile.

### 26. **Lighthouse pass**
Run a real Lighthouse mobile audit. Target ≥90 on every category. The most likely wins are around image weight + render-blocking CSS.

### 27. **Accessibility check**
- Verify color contrast on the bronze brand strip vs white text (we hand-set #c7915b with white — should be ≥4.5:1, but verify).
- Tab order through the install bottom-sheet.
- ARIA on the FAQ `<details>` collapsible.
- Keyboard navigation through the body diagram in the app.

### 28. **Prefers-reduced-motion**
The install sheet animation, dialog reveals, and confetti all use `transform`/`opacity` transitions. Respect `@media (prefers-reduced-motion: reduce)` — disable animations for users who've opted out.

---

## P6 — Measurement

### 29. **Build a real conversion funnel dashboard**
Umami events already fire across 34 sites in app.js. We're missing the panel that ties them together:

```
landing_view → install_prompt_shown → install_sheet_cta → app_load
  → tried_without_account OR signup_complete
  → first_shot_logged → trial_premium_features_seen
  → trial_ending_soon → premium_paid
```

Each transition is measurable. Build a dashboard (Umami can do funnels) and review weekly. Without this, all the above changes are guesses.

### 30. **Heatmap on the landing page**
Self-host a privacy-friendly heatmap (GoatCounter, Microanalytics, or even a tiny first-party scroll-depth tracker). We'd see if visitors actually reach the FAQ and pricing or bounce at the long features grid.

---

## Recommended sequencing

**Week 1** (P0): fix duplicate compare, "skip for now" auth path, reorder homepage, CTA copy test, body-para cleanup. **Single afternoon of work, biggest immediate impact.**

**Week 2** (P1 + P2 onset): screenshot carousel, premium trial-end notification, founder bio, /security.html. Start /blog with the first 1-2 articles.

**Week 3-4** (P2 + P3): split features/glossary/compare into separate pages, ship onboarding wizard, day-7 retention nudge.

**Ongoing** (P4 + P5 + P6): performance pass, accessibility audit, monthly Umami funnel review.

---

## What this plan does *not* recommend (intentional)

- **A native iOS/Android app**. The PWA is the differentiator. Going native means App Store review, 30% fee, slower iteration, weaker privacy story (Apple Health entitlements are a privacy footgun). Stay PWA.
- **Reviews / ratings inflation**. Wait for real ones; cite GitHub stars + open-source code as the trust signal in the meantime.
- **Pivoting away from GLP-1 specificity**. The whole moat is being purpose-built for one niche. Generic "medication tracker" loses the comparison vs CareClinic. Stay GLP-1.
- **Heavy front-end frameworks**. The site loads in <1 second on 4G with vanilla HTML/CSS/JS. Don't sacrifice that for "developer convenience."

---

## Quick-win checklist (do these even without full plan adoption)

- [ ] Delete duplicate `#compare` cards section (5 minutes)
- [ ] Add "Skip for now → try it" link to auth gate (15 minutes)
- [ ] Move pricing section above features in the homepage flow (10 minutes)
- [ ] Move glossary to its own /glossary page (30 minutes)
- [ ] Convert hero PNGs to WebP (10 minutes)
- [ ] Inline critical CSS (45 minutes)
- [ ] Schedule trial-ending push notification on day 11 (1 hour)
- [ ] Auto-open share-card modal on achievement unlock (30 minutes)
- [ ] /security.html with disclosure policy (1 hour)
- [ ] Submit sitemap to Search Console + Bing (5 minutes)

Total quick-win time: ~5 hours of work for measurable conversion lift.
