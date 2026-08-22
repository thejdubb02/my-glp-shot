# Deep code review — My GLP Shot

Paste everything below the line into another LLM CLI, run from the repository
root. It is written to be handed to a reviewer who has never seen this codebase.

Repo root assumed: `/root/ventures/my-glp-shot`

---

You are doing an adversarial code review of **My GLP Shot**, a privacy-first
GLP-1 / peptide injection tracker. It is a live product with real users logging
real health data. Treat data loss and silent corruption as the most serious
class of bug — more serious than a crash, because a crash is visible and a
silently dropped record is not.

Your job is to find **real defects that survive scrutiny**, not to produce a
list of style opinions. A finding that cannot be traced to a concrete failure —
specific inputs or state, leading to a specific wrong outcome — is not a
finding. Discard it yourself rather than making the reader discard it.

## 1. Orient yourself first

Do this before forming any opinion.

```bash
cat README.md
cat web/app/README.md            # architecture + invariants, short and load-bearing
sed -n '1,40p' web/app/data.js   # explains why this is NOT ES modules
sed -n '1,30p' api/app.py        # the crypto model, in the module docstring
git log --oneline -25
```

Then run the existing gate, so you know the baseline is green before you change
anything and can tell your breakage from pre-existing breakage:

```bash
./scripts/run-tests.sh           # no args; installs its one test dep itself
```

Expect roughly 265 assertions across 5 offline suites, plus one suite that
skips unless a live API is reachable. **If anything fails before you touch the
code, say so and stop** — that is itself the top finding.

## 2. The shape of the thing

| Path | Lines | What it is |
|---|---|---|
| `web/app/app.js` | ~7,500 | The entire client. Vanilla JS, no framework, no build step |
| `web/app/data.js` | ~620 | Pure data tables, loaded as a classic script *before* app.js |
| `web/app/index.html` | ~1,260 | All markup and every dialog |
| `web/app/sw.js` | ~130 | Service worker; offline is a product promise, not a nicety |
| `web/app/view.html` | ~130 | Doctor-share viewer (standalone page) |
| `api/app.py` | ~2,400 | Flask + SQLite, 46 routes |
| `api/push_dispatch.py`, `push_send.py` | ~150 | Server-sent reminders |
| `web/admin/` | ~610 | Admin SPA |
| `web/landing/` | 16 pages | Marketing + legal |

**Two things about the architecture that look like mistakes and are not.**
Do not "fix" either without arguing the case explicitly:

1. **`data.js` and `app.js` are classic scripts sharing one global scope, not
   ES modules.** `settings` has ~200 references and is reassigned during
   settings-load and cloud-restore; `account`, `syncCreds` and `_dbPromise` are
   reassigned too. Under ES module semantics an imported binding is read-only,
   so those reassignments become runtime TypeErrors on the sync and restore
   paths — the paths that touch user data. Load order is enforced by
   `run-tests.sh`.
2. **No build step, on purpose.** Anything requiring bundling, transpiling or a
   package manager at runtime is out of scope. Test-only dependencies are fine.

## 3. The crypto and data model — read this before reviewing anything else

The email address is the PBKDF2 salt:

```
salt      = SHA-256("myglpshot-v1:" + lowercased email)
bits      = PBKDF2-SHA-256(password, salt, 600_000) -> 512 bits
aesKey    = bits[0:256]     never leaves the browser
authToken = bits[256:512]   sent to the server, stored bcrypt(cost 12)
```

Consequences you must hold in your head throughout:

- The server stores ciphertext it genuinely cannot read. Any code path that
  would let the server see plaintext health data is a **critical** finding.
- **Changing the email changes the encryption key.** `POST /api/me/email` and
  `accountChangeEmail()` in app.js must swap address, password hash and
  re-encrypted blob atomically. A partial success strands the user's data.
- Cloud payloads are versioned (`buildPayload` writes `version: 10`;
  `applyPulledPayload` refuses anything newer). Adding a store to the payload
  without bumping that version lets an older client silently drop it on the next
  push. **Check this invariant holds for every store.**
- The one deliberate plaintext exception is Smart Import (`/api/import/parse`),
  which sends an uploaded file to an LLM. It is disclosed in both privacy
  policies. If you find any *other* plaintext egress, that is critical.

## 4. Where to look, in priority order

### Tier 1 — no automated coverage at all. Start here.
This is the highest-yield ground; everything below it has at least some tests.

- `api/push_dispatch.py`, `api/push_send.py` — reminder scheduling and delivery.
  Look for: timezone and DST correctness, duplicate or missed sends, what
  happens when a push subscription is expired/410, whether a failure for one
  user blocks the rest, and whether any personal content reaches the push
  payload (it is supposed to be chosen server-side from a fixed list).
- `web/app/view.html` — the doctor-share viewer. It renders data decrypted from
  a URL fragment. Look hard for XSS: is anything from the payload written via
  `innerHTML` without escaping?
- The insights engine in `app.js` (search `FREE_INSIGHTS`, `PREMIUM_INSIGHTS`,
  `computeInsights`) — pure functions over user data, so cheap to test and
  currently untested. Look for divide-by-zero, empty-array reduces, off-by-one
  in day bucketing, and insights that would assert a pattern from 2 data points.
- PDF export (`runPdfExport`) and the achievements/badges code.
- `web/admin/` — the admin SPA.

### Tier 2 — partially covered, still worth probing
- Sync merge: `mergeStore`, `mergeNotes`, `applyPulledPayload`, `CONTENT_KEYS`.
  Probe for: a pull that duplicates records, a merge that loses a concurrent
  edit, and whether the content keys can collide across genuinely different
  records.
- Timezone handling: `_tzParts`, `todayISODate`, `toCanonicalDate`,
  `zonedWallToUtc`, `nextDailyTriggerAt`. Probe across DST boundaries and with
  a device timezone that differs from the configured one.
- Input sanitising at the door: `sanitizeShot`, `sanitizeWeight`,
  `sanitizeSettings`, `sanitizeSideEffectMap`, `sanitizeNote`,
  `sanitizeSymptomDay`. Everything downstream assumes these ran. Find a path
  that reaches a renderer without passing one.
- The service worker: cache invalidation on version bump, and whether a failed
  update can leave a half-old bundle.

### Tier 3 — recently audited, so only report something genuinely new
Do not spend your budget re-deriving these. They were checked on 2026-08-22:
manifest correctness and asset sizes, launcher shortcuts, offline cold start,
WCAG AA contrast across all 20 themes (zero failures), security headers and CSP,
admin API authorization, accessibility labels, touch-target sizing, and the
backup export/import round trip.

## 5. How to probe — the tooling already exists

**Run the real client code in Node.** `scripts/lib/app-harness.mjs` loads the
shipped `data.js` + `app.js` into a VM with a stub DOM and a real IndexedDB, and
hands you an accessor into the app's own scope. This is how to unit-test
anything in `app.js` without a browser:

```js
import { loadApp } from './lib/app-harness.mjs';
const { R } = await loadApp();               // domMode: 'absent' | 'stub' | 'sticky'
const buildPayload = R('buildPayload');      // reach any top-level function
```

`domMode` matters and changes which branches execute — read the comment in the
harness before choosing. Copy `scripts/backup-selftest.mjs` as a template.

**Run the API locally** (never test destructively against production):

```bash
python3 -m venv /tmp/apienv && /tmp/apienv/bin/pip install -q Flask bcrypt stripe requests pywebpush PyJWT
MGS_DB_PATH=/tmp/test.db MGS_SECRET=test /tmp/apienv/bin/python -c \
  "import sys; sys.path.insert(0,'api'); import app; app.app.run(port=5099)"
python3 scripts/api-selftest.py --base http://127.0.0.1:5099
```

**Drive a real browser** if you need layout or service-worker behaviour. A
headless Chrome is at
`/root/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell`.
Serve the app with `python3 -m http.server 8791 --bind 127.0.0.1` from
`web/app/`.

**Prove each finding.** For anything you report, either write a failing
assertion against the real code, or give the exact reproduction steps. A
reviewer who cannot make the bug happen has a hypothesis, not a finding.

**Mutation-test any new assertion you add.** Break the code deliberately,
confirm your test fails, restore. A test that cannot fail is worse than no test
because it manufactures confidence.

## 6. Specific questions worth answering

Concrete, and each one is either a bug or a clean bill of health:

1. Add a new IndexedDB store and trace it end to end. Does it reach the backup,
   the cloud payload, the merge, the PDF, and the doctor share? Which of those
   would silently skip it? (`backup-selftest.mjs` guards the first; check the rest.)
2. Two devices edit the same day offline, then both sync. What is lost?
3. A user changes their email while a push reminder is scheduled. Does the
   reminder still fire, and to the right person?
4. A doctor-share link is created, then the user changes their email or deletes
   their account. Does the link keep working? Should it?
5. What happens on a device whose clock is wrong by a day? By a year?
6. An import file with 50,000 rows, or deeply nested JSON, or a 2 MB single
   note. Where does it fall over, and does it fail cleanly?
7. Someone reinstalls, restores a backup, and *then* signs in to a cloud account
   that also has data. What is the merged result?
8. Free-tier gating: is any premium feature enforced only in the UI
   (`applyPremiumGates`) rather than on the server?

## 7. Rules

- **Do not commit, push, or deploy anything.** Leave the working tree clean, or
  clearly describe uncommitted changes you made.
- **Never run destructive tests against production** (`app.myglpshot.com`).
  `change-email-selftest.mjs` is safe to point anywhere because it cleans up
  after itself; nothing else is guaranteed to be.
- **Never print or commit a secret.** Credentials come from the environment.
  `docker/api.env*` contains live keys — do not read them into your output.
- The test suite must be green when you finish. If you break something and
  cannot fix it, say so plainly.
- If you disagree with an architectural decision above, argue it explicitly with
  the tradeoff; do not silently work around it.

## 8. What to hand back

Ranked by severity, most serious first. For each finding:

- **File and line**, and a one-sentence statement of the defect
- **The failure**: concrete inputs or state → the wrong outcome
- **Why it is real** — how you confirmed it (failing test, reproduction, or trace)
- **Confidence**: confirmed, or plausible-but-unverified (say which; do not blur)
- **The smallest fix** you would make

Then, separately and briefly: anything you checked and found genuinely sound.
That is useful — it tells the next reviewer where not to spend their budget.

Do not pad the list. Five real bugs beat forty observations.
