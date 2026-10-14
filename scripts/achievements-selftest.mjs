#!/usr/bin/env node
// Achievements self-test: runs the shipped ACHIEVEMENTS table and computeStats
// from web/app/app.js + data.js.
//
//   node scripts/achievements-selftest.mjs
//
// Pins behaviour, not structure: where each badge unlocks, and that the
// "Holding steady" badge reads the NEWEST shots whatever order the array is in
// (it read the oldest until 2026-09-28).
import { loadApp, Assert } from './lib/app-harness.mjs';

const { R } = await loadApp();
const A = new Assert('achievements');
const DAY = 86400000;
const iso = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString();
const shot = (daysAgo, dose) => ({ when: iso(daysAgo), dose });
const ids = (stats) => R(`ACHIEVEMENTS.filter(a => a.test(${JSON.stringify(stats)})).map(a => a.id)`);
const unlocked = (id, stats) => ids(stats).includes(id);
// Real stats object from the real computeStats, so the inputs match production.
const stats = (shots, weights = [], moods = []) =>
  R(`computeStats(${JSON.stringify(shots)}, ${JSON.stringify(weights)}, ${JSON.stringify(moods)})`);

R(`settings.cadenceDays = 7; settings.startWeight = ''; settings.weightUnit = 'lb';`);

// ---- table sanity
A.check('ids are unique', R(`new Set(ACHIEVEMENTS.map(a => a.id)).size === ACHIEVEMENTS.length`));
A.check('nothing unlocks for an empty account', ids(stats([])).length === 0, JSON.stringify(ids(stats([]))));

// ---- shot count ladder: each badge flips exactly at its threshold
const ladder = { first: 1, three: 3, ten: 10, twentyfive: 25, fifty: 50, hundred: 100, twohundred: 200, fivehundred: 500 };
for (const [id, n] of Object.entries(ladder)) {
  A.check(`${id} locked at ${n - 1} shots`, !R(`ACHIEVEMENTS.find(a => a.id === '${id}').test({shots: {length: ${n - 1}}})`));
  A.check(`${id} unlocked at ${n} shots`, R(`ACHIEVEMENTS.find(a => a.id === '${id}').test({shots: {length: ${n}}})`));
}

// ---- streak ladder, driven through the real computeStats/computeStreak
const weekly = (n) => Array.from({ length: n }, (_, i) => shot(i * 7, 2.5));
A.check('4 weekly shots = 4-week streak', unlocked('streak4', stats(weekly(4))) && !unlocked('streak8', stats(weekly(4))));
A.check('12 weekly shots = 12-week streak', unlocked('streak12', stats(weekly(12))));
A.check('a stale last shot kills the streak',
  !unlocked('streak2', stats([shot(30, 2.5), shot(37, 2.5), shot(44, 2.5)])));

// ---- weight ladder, lb and kg
const w = (startLb, nowLb) => [{ date: '2026-01-01', value: startLb, unit: 'lb' }, { date: '2026-02-01', value: nowLb, unit: 'lb' }];
A.check('lost2 locked at 1.9 lb', !unlocked('lost2', stats([], w(200, 198.1))));
A.check('lost2 unlocked at 2 lb', unlocked('lost2', stats([], w(200, 198))));
A.check('lost100 unlocked at 100 lb', unlocked('lost100', stats([], w(300, 200))));
A.check('weight gain unlocks nothing', !ids(stats([], w(200, 210))).some(i => i.startsWith('lost')));
R(`settings.weightUnit = 'kg'`);
A.check('kg user: lost2 needs 1 kg (2.2 lb)', unlocked('lost2', stats([], w(200, 197.7))) && !unlocked('lost2', stats([], w(200, 199.5))));
A.check('kg user gets the kg label', R(`badgeLabel(ACHIEVEMENTS.find(a => a.id === 'lost5'))`) === '2.5 kg lost');
R(`settings.weightUnit = 'lb'`);
A.check('lb user gets the lb label', R(`badgeLabel(ACHIEVEMENTS.find(a => a.id === 'lost5'))`) === '5 lb lost');

// ---- titration
A.check('titrate needs a dose change', !unlocked('titrate', stats([shot(7, 2.5), shot(0, 2.5)])) && unlocked('titrate', stats([shot(7, 2.5), shot(0, 5)])));

// ---- maintain: newest 4 shots at the max dose, in ANY array order
const old4 = [28, 21, 14, 7].map(d => shot(d + 7, 2.5));
const mk = (olderDose, newerDose) => [
  ...[35, 28, 21, 14].map(d => shot(d, olderDose)),
  ...[7, 0, 1, 2].map(d => shot(d, newerDose)),
];
const lowThenHigh = mk(2.5, 5);   // newest 4 at the max
const highThenLow = mk(5, 2.5);   // oldest 4 at the max, newest stepped down
for (const [label, order] of [['oldest first', (a) => a], ['newest first', (a) => [...a].reverse()]]) {
  A.check(`maintain unlocks when newest 4 are at max (${label})`, unlocked('maintain', stats(order(lowThenHigh))));
  A.check(`maintain stays locked when only the OLDEST 4 are at max (${label})`, !unlocked('maintain', stats(order(highThenLow))));
}
A.check('maintain needs 8 shots', !unlocked('maintain', stats(mk(5, 5).slice(0, 7))));

// ---- engagement + special
const moods = (n) => Array.from({ length: n }, (_, i) => ({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, value: 3 }));
A.check('mood7 flips at 7', !unlocked('mood7', stats([], [], moods(6))) && unlocked('mood7', stats([], [], moods(7))));
A.check('mood30 flips at 30', !unlocked('mood30', stats([], [], moods(29))));
A.check('centurion at 100 days since first shot', !unlocked('centurion', stats([shot(99, 2.5)])) && unlocked('centurion', stats([shot(100, 2.5)])));
A.check('comeback: a 4-week lapse then two shots',
  unlocked('comeback', stats([shot(60, 2.5), shot(53, 2.5), shot(14, 2.5), shot(7, 2.5), shot(0, 2.5)])));
A.check('comeback not given for steady weekly shots', !unlocked('comeback', stats(weekly(6))));

// ---- revoke: a badge the data no longer earns is dropped, with its date
R(`settings.achievements = ['lost25','first']; settings.achievementDates = {lost25:'2026-01-01', first:'2026-01-02'};`);
A.check('revokeStaleAchievements reports a change', R(`revokeStaleAchievements(['first'])`) === true);
A.check('stale badge and its date are gone', R(`JSON.stringify([settings.achievements, settings.achievementDates])`) === '[["first"],{"first":"2026-01-02"}]');
A.check('no change when nothing is stale', R(`revokeStaleAchievements(['first'])`) === false);

A.report();
