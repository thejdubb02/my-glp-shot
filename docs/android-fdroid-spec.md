# My GLP Shot: Android app for F-Droid

Status: proposed, 2026-11-20. Research on F-Droid rules was fetched the same day
(inclusion policy, anti-features list, fdroiddata build recipes for other
Capacitor apps, IzzyOnDroid requirements). Items marked "not verified" were not
confirmed from a primary source.

This is separate from the Play Store plan (`docs/android-play-store-plan.md`,
issue #2). That plan is a Trusted Web Activity, which is a thin shell around
Chrome showing the live site. F-Droid will not take that shape of app, so the
F-Droid build is a different package built a different way.

## Summary

- Build a Capacitor app that carries a copy of `web/app/` inside the APK. Same
  shell the iOS spec uses (`docs/ios-app-spec.md`), so one wrapper serves both.
- The app must work with no Google services, no tracking and no code fetched at
  run time. Four things in today's web app break that and need a build switch:
  analytics, web push, Smart Import and the relative API address.
- Fastest way into testers' hands is our own F-Droid repo (hours). IzzyOnDroid is
  days. The official F-Droid catalogue is weeks (median 41 days to merge when
  checked, 495 merge requests open).
- Nothing here is built yet. Section 6 lists the work in order.

## 1. Why not reuse the Play Store TWA

| Shape | F-Droid verdict |
|---|---|
| TWA (Bubblewrap) | Depends on Chrome and loads the app from our server on every start. The APK holds no app code to review. Not accepted. No explicit ruling was found (not verified), but it fails the "built from source, no remote code" rule on its face. |
| Capacitor with `server.url` pointing at the site | Same problem: remote code. Rejected. |
| Capacitor with bundled assets | Accepted pattern. Several Capacitor apps are in fdroiddata today. |

## 2. What must change in the app for this build

The web app stays as it is. These are switches for the native build, set once
in a small platform file loaded before the feature scripts.

| Today | Problem for F-Droid | F-Droid build |
|---|---|---|
| Umami script tag in `index.html`, `track()` in `js/common.js` | Tracking. IzzyOnDroid requires none at all for health apps. | Script tag left out of the bundled `index.html`. `track()` already does nothing when Umami is absent. |
| Web push through `js/reminders.js` and `api/push_send.py` | On Android, web push in a WebView needs Google's FCM. Play Services are not allowed. | `@capacitor/local-notifications`, scheduled on the phone from `computeUpcomingReminders()`. No server involved, which also suits the privacy promise. |
| `ACCOUNT_API = 'api'` in `js/account.js`, plus the direct `/api/signup` and `/api/login` calls in `js/boot.js` | Relative addresses do not resolve inside the app. A hard-wired server also earns the "tethered network service" label. | One API base setting, default `https://app.myglpshot.com/api`, editable under Settings. Bearer token auth, no cookies. Needs CORS on the API for the app's origin (same change the iOS spec lists). |
| Smart Import (`js/import-export.js`, `api`) | Sends file text to our server and on to OpenRouter. Conflicts with the listing's privacy claims. | Hidden in this build. |
| Chart.js copied into `web/app/lib/chart.min.js` (v4.4.6) | A minified file with no recorded source is flagged by the scanner (handling not verified). | Take `chart.js@4.4.6` from npm at build time with a lockfile. Until then, record the checksum (`9653a081...f1d1`) in the build recipe. |
| Service worker, install banner, stale-bundle check (`js/setup-ui.js`) | Pointless inside an APK and can fight the bundled files. | Skipped when running natively. |
| Stripe checkout | No rule against it on F-Droid (treatment not verified). An in-app purchase screen that loads Stripe's scripts would count as remote code. | "Upgrade" opens `app.myglpshot.com` in the system browser. Neutral wording, no Stripe script in the app. |
| Doctor share link built from `location.origin` (`js/pdf-report.js`) | Inside the app the origin is not our domain. | Always `https://app.myglpshot.com`. |

The 2026-11-20 split of `app.js` into `web/app/js/` is what makes these switches
small: each one touches a single feature file.

## 3. Repo layout to add

```
android/                      Capacitor Android project (generated, committed)
capacitor.config.json         webDir = build/native-www, no server.url
package.json, package-lock.json   pinned Capacitor, plugins, chart.js
scripts/build-native-www.sh   copies web/app into build/native-www and applies section 2
fastlane/metadata/android/en-US/   title, short and full description, screenshots, changelogs
```

`web/app/` stays build-free for the website. The copy step is the only build,
and it runs for the native app alone.

Package name: `com.myglpshot.app`. An app signed by F-Droid and the same package
signed by us (Play, our own repo) cannot update each other, so users of one
cannot move to the other without reinstalling. See decisions in section 7.

## 4. F-Droid build recipe (shape)

Other Capacitor apps in fdroiddata use this pattern:

```yaml
Builds:
  - versionName: 0.68.0
    versionCode: 6800
    commit: v0.68.0
    subdir: android/app
    sudo:
      - apt-get update
      - apt-get install -y nodejs npm
    init: cd ../.. && npm ci
    prebuild: cd ../.. && bash scripts/build-native-www.sh && npx cap sync android
    scandelete:
      - node_modules
    gradle:
      - yes
```

Requirements that follow from it: every dependency is free software, `npm ci`
works from the lockfile alone, releases are git tags, and the licence file is in
the repo root. The repo is already public on GitHub under the MIT licence, so
that part is done.

## 5. Three ways to release, fastest first

| Route | Time to first install | What it needs |
|---|---|---|
| Our own F-Droid repo (a static folder on our server, added in the F-Droid app by address) | Hours once the APK builds | Our signing key. No review. Testers add the repo once. |
| IzzyOnDroid | Days (onboarding time not verified). Updates appear within about 24 hours. | Public source, a signed APK attached to each tagged GitHub release, under 30 MB, zero tracking. |
| Official F-Droid | Weeks | A merge request to fdroiddata with the recipe above, reviewer back-and-forth, then their build server. |

Recommended: start with our own repo for testing, apply to IzzyOnDroid at the
same time, and open the official merge request once the build has settled.

## 6. Work in order

1. Platform switch file and the changes in section 2, each behind a "running
   natively" check, each with a selftest. Web behaviour must not change.
2. API: CORS for the app origin and Bearer-only auth for native requests.
3. Capacitor project, copy script, local notifications. Runs on an emulator.
4. Fastlane metadata and screenshots.
5. Signed APK from a tagged release, built on the cezar1 runner.
6. Our own F-Droid repo, then IzzyOnDroid, then the fdroiddata merge request.

Acceptance for step 3: the app opens with the network off, logs a shot, fires a
reminder with the app closed, signs in and syncs against production, and makes
no request to any host other than the API.

## 7. Owner decisions

- Which release route first (section 5)?
- Same package name as the Play Store app, or a separate one? Sharing a name
  means the two builds collide on one phone.
- Signing: let F-Droid sign (simplest, but locks users to F-Droid's key), or
  sign ourselves with reproducible builds (more work, users can switch sources).
- Analytics: off completely in this build (recommended), or opt-in.
- Smart Import: hidden in this build (recommended), or kept behind a clear
  warning.

## Not verified

An explicit F-Droid ruling on TWAs, web push support in the Android WebView,
Capacitor's default Android scheme, how the scanner treats minified JavaScript,
exact-alarm permission handling for reminders, F-Droid's treatment of Stripe
links, and IzzyOnDroid onboarding time.
