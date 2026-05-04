# MGS Launch Plans

Tactical briefs for the two highest-leverage one-shot launches. Each can only be fired once. Get them right.

---

## 1. Show HN (Hacker News)

**Why this is the strongest fit for MGS:** the privacy-first crypto-in-the-browser angle is exactly the kind of build HN celebrates. Open source, end-to-end encrypted, built solo, privacy-respecting in a niche dominated by data-hungry apps. This is HN bait in the best sense.

### Title format

Strict format. HN auto-detags posts that don't match.

```
Show HN: My GLP Shot – Privacy-first GLP-1 medication tracker (E2E encrypted, open source)
```

Notes:
- "Show HN:" prefix is required
- En dash (`–`) between name and tagline. Not an em dash. Use a regular hyphen if unsure.
- Keep under 80 chars total.

### URL

`https://myglpshot.com`

### First comment (post immediately after submission, before anyone else comments)

```
Hey HN. Family member started a GLP-1 medication a while back, looked at the existing tracker apps, and was unsettled. Most either sell health data through "anonymous research partnerships" or charge $10/mo just to log a weekly injection. So I built one that doesn't.

Some technical notes I think this crowd will care about:

* Pure PWA. No app store, installs from browser, IndexedDB for storage.
* Local-first by default. Your shots, weights, mood logs never leave your device unless you opt into cloud sync.
* If you do turn on cloud sync, password runs through PBKDF2-SHA-256 with 600,000 iterations in the browser to derive an AES-256-GCM key. The auth token sent to the server is derived from a separate output of the same KDF. Server stores opaque ciphertext. We have no key material.
* Doctor-share links place the per-share AES key in the URL fragment (after #). Fragments aren't sent to servers, so the share key never reaches us either.
* Crypto code is in a single file (~200 lines) using only the platform SubtleCrypto API. No third-party crypto libraries.

Source: https://github.com/thejdubb02/my-glp-shot

Free for the basics, $19.99/year flat (no monthly tier on purpose) for premium features like lab tracking and PDF doctor exports.

Threat model is documented honestly at https://myglpshot.com/security.html. We are NOT protecting against compromised devices, compromised browsers, or attacks on browser SubtleCrypto itself.

Happy to answer questions about the architecture, the threat model, or the niche.
```

### Optimal timing

- **Best day:** Tuesday or Wednesday
- **Best time:** 9:00am to 11:00am Eastern (peak HN traffic)
- **Avoid:** Mondays (busy news days), Fridays (lower engagement), weekends
- **Avoid major news days:** if there's a big tech-news event, defer to next week

### Day-of checklist

1. **Before posting:** verify the site loads quickly under load. HN can drive 1k–20k visitors in the first hour. The PWA is static-served by nginx so it should be fine, but watch the VPS dashboard.
2. **Post.** Submit on https://news.ycombinator.com/submit
3. **Add the first comment within 60 seconds.** This sets the tone and answers the obvious questions before they get asked.
4. **Refresh every 5 minutes for the first hour.** If the post is stuck on `/show` page after 30 minutes with no upvotes, it's not catching. If it gets to the front page (top 30 of `/news`), traffic floods in.
5. **Reply to every comment within 10 minutes** for the first 4 hours. HN values OP engagement and ranks posts partly on it.
6. **Don't argue.** Privacy-skeptic comments will appear ("but how do I trust your crypto code?", "what if the server is compromised?"). Answer technically and honestly. If a question reveals a real issue, acknowledge it. Don't get defensive.
7. **Don't beg for upvotes.** No "please upvote", no asking friends to upvote (HN's vote-ring detection is notoriously aggressive and will shadow-ban your post).
8. **Track traffic.** Open Umami in another tab to watch live visitor count. The shape of the spike tells you whether the post is sticking.

### Common questions to prep answers for

- "Why a PWA instead of a native app?" → Privacy-by-design (no app store data collection), one codebase for all platforms, no store review process gating updates, and PWA crypto APIs are now mature.
- "How do I trust the encryption is implemented correctly?" → Source is public, crypto is one auditable file, all primitives are platform SubtleCrypto. No custom crypto.
- "What stops you from pushing a malicious JS update that exfiltrates the key?" → That's the inherent trust model of any web app. The mitigation is the public source, version pinning via Service Worker cache, and the option to install the PWA from a specific point-in-time and never auto-update.
- "Why $19.99/year flat instead of monthly?" → GLP-1 is a multi-month or multi-year routine. Flat annual respects that. Monthly subscription is the wrong shape for the use case.
- "How does this handle compounded medications?" → Custom dose schedules and ingredient tracking. Same data model as branded.
- "Is this medical advice?" → No. It's a tracking tool. The app says so prominently and the privacy policy reinforces it.

### Things that hurt the post

- Slow site under load (have the VPS warm before posting)
- Posting then disappearing (engagement signal matters)
- Defensiveness in replies
- Mentioning Reddit promotion in the same week (HN regulars cross-check)
- Generic marketing copy in the post body

### Things that help the post

- Specific technical detail (exact KDF iterations, exact crypto primitive, exact line counts)
- Honest acknowledgment of what the app does NOT protect against
- Real personal motivation (family member, not "we identified a market gap")
- Public source code with commit history that shows iteration
- Direct answers to crypto and threat-model questions

---

## 2. Product Hunt

**Why this works for MGS:** Product Hunt audience skews tech-curious + early-adopter + privacy-aware. PH launches drive 1k-5k visitors in 24h plus 50-200 backlinks (DR boost for SEO).

### Pre-launch (do 7 days before)

1. **Pick the launch date.** Tuesday or Wednesday. NOT Monday (overcrowded) or Friday (lower engagement).
2. **Build a "Coming Soon" page on Product Hunt.** Go to https://www.producthunt.com/posts/new and select "Coming soon" instead of "Launch now". This collects emails of interested users before launch day. Use those emails for the day-of email blast.
3. **Build the maker profile.** Real photo, real bio, link to https://myglpshot.com and the GitHub repo. PH heavily weights "Hunter" and "Maker" reputation.
4. **Recruit 5-10 supporters.** Friends, family, or anyone who knows about the product who has a Product Hunt account. Ask them to upvote and comment in the first 30 minutes. PH ranking heavily weights early velocity.

### Launch day assets

PH requires:

| Asset | Specs |
|---|---|
| Tagline | Up to 60 characters |
| Description | Up to 260 characters |
| Topics | Pick 3 (Health & Fitness, Privacy, Web Apps recommended) |
| Gallery (1-8 images) | First image is the thumbnail. 1270x760 recommended. |
| GIF or video | Optional but increases engagement. 30-60 sec demo. |
| Maker comment | Posted immediately after launch as the first comment |

### Tagline options (pick one)

```
Privacy-first GLP-1 tracker, free, no account needed
```

```
Track GLP-1 shots without selling your health data
```

```
The GLP-1 tracker that runs entirely in your browser
```

### Description (260 char max)

```
Track Mounjaro, Ozempic, Wegovy, Zepbound, and other GLP-1 medications in a privacy-first PWA. Local-first by default. Optional cloud sync is end-to-end encrypted in your browser. Open source. Free tier covers most users; $19.99/year flat for premium.
```

(That's 257 chars. Verify before submitting. PH counts strict.)

### Maker comment (post immediately after launch)

```
Hey Product Hunt!

Family member started a GLP-1 medication and the existing tracker apps were a privacy nightmare. Explicit "we share with health-data partners" clauses, monthly subscriptions just to log a weekly shot, account-required everywhere. Built My GLP Shot to be the opposite.

What it does:
* Track shots, doses, weights, mood, appetite, body measurements, lab values, photos, side effects
* Visualize active medication concentration across the week (peak vs trough)
* Custom dosing schedules for microdosing or non-standard cadences
* Generate doctor-friendly PDF reports

What's different:
* Default mode requires no account at all. Data stays on your device.
* Optional cloud sync is end-to-end encrypted in your browser before upload. Server stores ciphertext only. We have no key material, even under subpoena.
* Source code is on GitHub. Crypto is in a single file using only platform SubtleCrypto.
* Free tier is fully usable. Premium is $19.99/year flat. No monthly subscription.

Try it: https://myglpshot.com

Source: https://github.com/thejdubb02/my-glp-shot

Comparison pages: vs Shotsy, vs CareClinic, vs MyFitnessPal

Happy to answer questions about the crypto, the threat model, or the niche.
```

### Day-of checklist

1. **00:01 PT (3:01am ET):** PH launches roll over at midnight Pacific. Submit at 00:01 PT for full 24-hour exposure.
2. **First 30 minutes:** Make sure your 5-10 supporters upvote and comment. This drives initial momentum that determines top-of-day ranking.
3. **First 4 hours:** Reply to every comment within 10 minutes. PH algorithm rewards maker engagement.
4. **Email the "Coming Soon" list** with the launch link as soon as you go live.
5. **Cross-post:** post to your Twitter/LinkedIn with the PH link. PH allows external traffic and counts upvotes from external users equally.
6. **Watch the leaderboard.** PH shows daily top 10 by upvotes. Goal: top 5 of the day. Top 1 is exceptional and unlikely on a first launch without an established audience.

### What NOT to do

- Don't artificially inflate upvotes (PH detects vote rings)
- Don't mention competitors' names in negative framing in the maker comment (against PH community guidelines)
- Don't hide the pricing or the freemium gate (PH community is sensitive to misleading "free" claims)
- Don't post the same comment template across multiple PH launches over time

---

## 3. Sequencing

Don't fire both on the same day. The cross-platform engagement looks like astroturfing and traffic from one cannibalizes the other.

**Recommended order:**

1. **Show HN first.** HN traffic is more technical and privacy-aware. Higher-quality early signal.
2. **Wait 2-4 weeks.** Let HN traffic settle, capture any early users, gather feedback.
3. **Product Hunt second.** Use HN-driven anecdotes ("we shipped to HN and got X feedback, here's what changed") in the PH maker comment. This makes the PH launch feel like a substantial v2 not a first cold-launch.

The opposite order also works (PH first, HN later) but tends to produce a less crisp launch on each platform. HN-first is the recommended sequence for technical builds.

### Backup option if Show HN doesn't catch

If the Show HN post doesn't reach the front page (gets <30 upvotes in the first hour), don't repost. HN explicitly bans reposts and tracks them at the user level. Wait 4-6 weeks and try a "Show HN: " on a different angle (maybe focus on the doctor-share crypto specifically, or the open-source aspect).

---

## 4. Trackable success criteria

After the Show HN:

- Front page (top 30) reached: yes/no
- Total visitors during 24h post-submission: target 5,000+
- Premium signups in 7 days post-launch: target 20+
- New GitHub stars: target 100+

After the Product Hunt:

- Daily ranking: target top 5
- Total visitors during 24h: target 3,000+
- Premium signups in 7 days post-launch: target 30+
- Email signups (from "Coming Soon"): target 200+
