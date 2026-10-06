#!/usr/bin/env node
// Weight edit / weekly summary self-test.
//
// A user typed 1xx instead of 2xx and the app had no way to view, fix or delete
// a saved weight; the typo also earned a false "100 lb lost" badge. Covers the
// weekly grouping, the typo check, edit-in-place keeping identity, and the
// badge revoke.
//
//   run via: bash scripts/run-tests.sh
import { loadApp, Assert } from './lib/app-harness.mjs';

const A = new Assert('weight-edit');
const { R } = await loadApp({ domMode: 'stub' });
const call = (expr) => R(expr);

// ---------- weekly summary ----------
// 2026-10-04 is a Sunday, 10-05 the Monday after; 09-28 is the Monday before.
const rows = [
  { id: 1, value: 200, unit: 'lb', date: '2026-09-22' }, // week of 09-21
  { id: 2, value: 198, unit: 'lb', date: '2026-09-27' }, // Sunday, same week, later
  { id: 3, value: 90, unit: 'kg', date: '2026-10-04' },  // Sunday, week of 09-28 (198.4 lb)
  { id: 4, value: 195, unit: 'lb', date: '2026-10-05' }, // Monday, new week
  { id: 5, value: 196, unit: 'lb', date: '2026-10-06' },
];
const wk = await call(`weeklyWeightSummary(${JSON.stringify(rows)})`);
A.check('three weeks', wk.length === 3, JSON.stringify(wk.map(w => w.weekStart)));
A.check('newest first, Monday starts', wk.map(w => w.weekStart).join() === '2026-10-05,2026-09-28,2026-09-21');
A.check('Sunday stays in the earlier week', wk[1].entries.length === 1 && wk[1].entries[0].id === 3);
A.check('Monday opens the next week', wk[0].entries.map(e => e.id).join() === '5,4', JSON.stringify(wk[0].entries));
A.check('earliest week change is null', wk[2].changeLb === null);
A.check('earliest week keeps both entries, newest first', wk[2].entries.map(e => e.id).join() === '2,1');
const lbOf90kg = 90 * 2.20462;
A.check('change uses the week-end reading, kg converted', Math.abs(wk[1].changeLb - (lbOf90kg - 198)) < 1e-6, String(wk[1].changeLb));
A.check('latest week change', Math.abs(wk[0].changeLb - (196 - lbOf90kg)) < 1e-6, String(wk[0].changeLb));

// ---------- typo check ----------
A.check('192 vs 182 is fine', call('weightLooksLikeTypo(192, 182)') === false);
A.check('192 vs 92 is a typo', call('weightLooksLikeTypo(192, 92)') === true);
A.check('jump up is flagged too', call('weightLooksLikeTypo(150, 250)') === true);

// ---------- edit keeps identity ----------
await call(`ensureStore(STORES.weights)`);
await call(`withStore(STORES.weights, 'readwrite', s => s.clear())`);
const id = await call(`dbAdd(STORES.weights, { value: 150, unit: 'lb', date: '2026-10-06' })`);
const before = await call(`dbGet(STORES.weights, ${id})`);
A.check('seeded row has a uid', !!before.uid);
await call(`dbPut(STORES.weights, { id: ${id}, value: 250, unit: 'lb', date: '2026-10-06' })`);
const after = await call(`dbAll(STORES.weights)`);
A.check('no duplicate row', after.length === 1, String(after.length));
A.check('value changed', after[0].value === 250);
A.check('uid kept', after[0].uid === before.uid);

// ---------- badge revoke ----------
await call(`settings.achievements = ['lost100', 'first_shot']; settings.achievementDates = { lost100: '2026-10-06', first_shot: '2026-10-01' }`);
const changed = call(`revokeStaleAchievements(['first_shot'])`);
A.check('revoke reports a change', changed === true);
A.check('stale badge removed', call(`settings.achievements`).join() === 'first_shot');
A.check('stale badge date removed', call(`'lost100' in settings.achievementDates`) === false);
A.check('earned badge date kept', call(`settings.achievementDates.first_shot`) === '2026-10-01');
A.check('nothing stale: no change', call(`revokeStaleAchievements(['first_shot'])`) === false);

A.report();
