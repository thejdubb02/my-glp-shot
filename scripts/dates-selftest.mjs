#!/usr/bin/env node
// Date and ordering self-test.
//
// Pins four bugs a code review found on 2026-09-28, each of which failed
// quietly rather than loudly:
//   1. A shot stored as a UTC timestamp was filed under the UTC date, so any
//      evening shot west of UTC counted toward the next day (side effects,
//      pen usage).
//   2. The daily reminder stepped forward 24 hours instead of one calendar day,
//      and skipped a day across the 23-hour spring-forward day.
//   3. The "Holding steady" badge read the OLDEST four shots, because shots
//      arrive newest first.
//   4. The next-shot (i) panel quoted the first shot ever logged as the last one.
//
//   run via: bash scripts/run-tests.sh
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadApp, Assert } from './lib/app-harness.mjs';

const A = new Assert('dates');
const { R } = await loadApp();

const setTz = (tz) => R(`settings.timezone = ${JSON.stringify(tz)};`);
const toCanonicalDate = R('toCanonicalDate');
const parseDateFlexible = R('parseDateFlexible');

// ---------- 1. shot timestamps bucket by the user's local day ----------
setTz('America/Vancouver');
// 7pm PDT on 27 Sep is 02:00 UTC on 28 Sep.
A.eq('evening Pacific shot stays on its local day',
  toCanonicalDate('2026-09-28T02:00:00.000Z'), '2026-09-27');
A.eq('morning Pacific shot is unchanged',
  toCanonicalDate('2026-09-27T16:00:00.000Z'), '2026-09-27');
setTz('America/New_York');
A.eq('9pm Eastern shot stays on its local day',
  toCanonicalDate('2026-09-28T01:00:00.000Z'), '2026-09-27');
setTz('Asia/Tokyo');
A.eq('east of UTC: early-morning shot lands on the local (later) day',
  toCanonicalDate('2026-09-27T20:00:00.000Z'), '2026-09-28');
A.eq('bare day label passes through untouched', toCanonicalDate('2026-09-27'), '2026-09-27');
A.check('parseDateFlexible no longer treats a full timestamp as a bare day',
  new Date(parseDateFlexible('2026-09-28T02:00:00.000Z')).getHours() !== 12);

// ---------- 2. daily reminder across spring-forward ----------
// US spring-forward 2027: Sunday 14 March, 02:00 -> 03:00 in New York.
setTz('America/New_York');
const RealDate = R('Date');
const nextDaily = (fakeNowIso, hhmm) => R(`(() => {
  const Real = Date, fixed = Real.parse(${JSON.stringify(fakeNowIso)});
  class Fake extends Real { constructor(...a) { a.length ? super(...a) : super(fixed); } static now() { return fixed; } }
  Fake.UTC = Real.UTC; Fake.parse = Real.parse;
  globalThis.Date = Fake;
  try { const d = nextDailyTriggerAt(${JSON.stringify(hhmm)}); return d ? d.toISOString() : null; }
  finally { globalThis.Date = Real; }
})()`);
// Saturday 13 March 23:50 EST (04:50Z on the 14th); reminder at 23:45 has passed.
// Sunday 23:45 EDT is 03:45Z on the 15th. The old code returned Monday.
A.eq('reminder after passing on Saturday night fires Sunday, not Monday',
  nextDaily('2027-03-14T04:50:00.000Z', '23:45'), '2027-03-15T03:45:00.000Z');
A.eq('reminder later today still fires today',
  nextDaily('2027-03-13T14:00:00.000Z', '23:45'), '2027-03-14T04:45:00.000Z');
A.check('Date restored after the fake clock', R('Date') === RealDate);

// ---------- 3. "Holding steady" reads the newest shots ----------
const maintain = R("ACHIEVEMENTS.find(a => a.id === 'maintain')");
const day = (n) => new Date(Date.UTC(2026, 0, 1 + n * 7)).toISOString();
// Four at 2.5mg, then four at 5mg, then holding at 5mg: newest first, as the app passes them.
const ladder = [...Array(4)].map((_, i) => ({ when: day(i), dose: 2.5 }))
  .concat([...Array(6)].map((_, i) => ({ when: day(4 + i), dose: 5 })))
  .reverse();
A.check('holding at the top dose unlocks the badge (newest-first input)',
  maintain.test({ shots: ladder, maxDose: 5 }) === true);
A.check('still titrating does not unlock it',
  maintain.test({ shots: [{ when: day(9), dose: 2.5 }, ...ladder.slice(1)], maxDose: 5 }) === false);

// ---------- 4. next-shot panel quotes the newest shot ----------
const DATA_JS = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'app', 'data.js'), 'utf8');
A.check('next-shot panel takes shots[0] from newest-first getShotsSorted',
  /const latest = shots\.length \? shots\[0\] : null;/.test(DATA_JS));

A.report();
