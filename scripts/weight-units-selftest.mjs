#!/usr/bin/env node
// Weight-unit self-test.
//
// The app stores each weight exactly as the user typed it, unit and all, but
// every calculation runs on POUNDS and only converts at the moment of display.
// Before that split existed, weightDelta() subtracted raw stored values — so a
// kg entry minus an lb entry produced a meaningless number, and every screen
// then confidently labelled it "lb".
//
// These assertions exist because that bug is invisible: nothing throws, the
// numbers just quietly mean nothing. The rules being pinned are:
//   1. maths is always canonical pounds, whatever the rows say
//   2. display is always settings.weightUnit, whatever the rows say
//   3. switching units changes no stored value and moves no milestone
//
//   node scripts/weight-units-selftest.mjs
import { loadApp, Assert } from './lib/app-harness.mjs';

const A = new Assert('weight-units');
const { R, sandbox } = await loadApp();

const LB_PER_KG    = R('LB_PER_KG');
const toLb         = R('toLb');
const fromLb       = R('fromLb');
const weightUnit   = R('weightUnit');
const fmtWeight    = R('fmtWeight');
const fmtWeightDelta = R('fmtWeightDelta');
const weightsInLb  = R('weightsInLb');
const weightDelta  = R('weightDelta');
const detectPlateau = R('detectPlateau');
const computeStats = R('computeStats');
const sanitizeWeight = R('sanitizeWeight');
const ACHIEVEMENTS = R('ACHIEVEMENTS');
const badgeLabel   = R('badgeLabel');

const setUnit = (u) => R(`settings.weightUnit = ${JSON.stringify(u)};`);
const setStart = (v) => R(`settings.startWeight = ${v === null ? 'null' : v};`);
const near = (a, b, tol = 0.05) => Math.abs(a - b) <= tol;

// ---------- conversion primitives ----------
A.check('LB_PER_KG is the real ratio', near(LB_PER_KG, 2.20462, 0.00001), String(LB_PER_KG));
A.check('toLb passes pounds through', toLb(180, 'lb') === 180);
A.check('toLb converts kg', near(toLb(100, 'kg'), 220.462));
A.check('toLb treats a missing unit as pounds', toLb(180, undefined) === 180);
A.check('toLb rejects junk', toLb('abc', 'lb') === null);
A.check('toLb rejects empty', toLb('', 'lb') === null);
A.check('fromLb round-trips kg', near(fromLb(toLb(82.5, 'kg'), 'kg'), 82.5));
A.check('fromLb round-trips lb', fromLb(toLb(181, 'lb'), 'lb') === 181);

// ---------- display unit ----------
setUnit('lb');
A.check('default display unit is lb', weightUnit() === 'lb');
A.check('fmtWeight in lb', fmtWeight(180) === '180.0 lb', fmtWeight(180));
A.check('fmtWeightDelta negative is a loss', fmtWeightDelta(-2.2) === '−2.2 lb', fmtWeightDelta(-2.2));
A.check('fmtWeightDelta positive is a gain', fmtWeightDelta(1.5) === '+1.5 lb', fmtWeightDelta(1.5));
A.check('fmtWeight bare drops the unit', fmtWeight(180, { bare: true }) === '180.0');
A.check('fmtWeight handles null', fmtWeight(null) === '—', fmtWeight(null));

setUnit('kg');
A.check('kg display unit sticks', weightUnit() === 'kg');
A.check('fmtWeight converts to kg', fmtWeight(220.462) === '100.0 kg', fmtWeight(220.462));
A.check('fmtWeightDelta converts to kg', fmtWeightDelta(-22.0462) === '−10.0 kg', fmtWeightDelta(-22.0462));
A.check('1 lb threshold reads as kg', fmtWeight(1, { dp: 1 }) === '0.5 kg', fmtWeight(1, { dp: 1 }));

R("settings.weightUnit = 'nonsense';");
A.check('a corrupt unit degrades to lb', weightUnit() === 'lb');
setUnit('lb');

// ---------- the original bug: mixed-unit rows ----------
const mixed = [
  { date: '2026-01-01', value: 100, unit: 'kg' },   // 220.462 lb
  { date: '2026-02-01', value: 210,  unit: 'lb' },
];
const rows = weightsInLb(mixed);
A.check('weightsInLb attaches canonical pounds', near(rows[0].lb, 220.462) && rows[1].lb === 210);
A.check('weightsInLb preserves the original value', rows[0].value === 100 && rows[0].unit === 'kg');
A.check('weightsInLb drops unparseable rows',
  weightsInLb([{ date: 'x', value: 'abc', unit: 'lb' }, { date: 'y', value: 5, unit: 'lb' }]).length === 1);

setStart(null);
const wdMixed = weightDelta(mixed, null);
A.check('mixed-unit delta is computed in pounds', near(wdMixed.delta, -10.462),
  `got ${wdMixed && wdMixed.delta}`);
A.check('mixed-unit delta is a LOSS, not a +110 gain', wdMixed.delta < 0,
  `got ${wdMixed && wdMixed.delta} — this is the exact regression this file exists for`);

// ---------- start weight is canonical pounds ----------
setStart(250);
const wd = weightDelta([{ date: '2026-02-01', value: 100, unit: 'kg' }], 250);
A.check('startWeight is treated as pounds', near(wd.delta, -29.538), `got ${wd.delta}`);
A.check('weightDelta ignores a blank startWeight override',
  weightDelta([{ date: '2026-01-01', value: 200, unit: 'lb' }, { date: '2026-02-01', value: 190, unit: 'lb' }], '') ?.delta === -10);
A.check('weightDelta returns null with no usable rows', weightDelta([], null) === null);
A.check('weightDelta returns null when every row is junk',
  weightDelta([{ date: 'a', value: null, unit: 'lb' }], null) === null);
setStart(null);

// ---------- switching units must not move anything ----------
const series = [
  { date: '2026-01-01', value: 100, unit: 'kg' },
  { date: '2026-03-01', value: 90,  unit: 'kg' },
];
setUnit('lb');
const inLb = weightDelta(series, null);
setUnit('kg');
const inKg = weightDelta(series, null);
A.check('the underlying delta does not change with the display unit', inLb.delta === inKg.delta,
  `${inLb.delta} vs ${inKg.delta}`);
A.check('but the rendering does', fmtWeightDelta(inKg.delta) === '−10.0 kg', fmtWeightDelta(inKg.delta));
setUnit('lb');
A.check('...and reads as pounds again', fmtWeightDelta(inLb.delta) === '−22.0 lb', fmtWeightDelta(inLb.delta));

// ---------- plateau threshold is 1 POUND, not 1 of whatever ----------
// 28 days of kg readings drifting 0.9 kg (~2 lb) is NOT flat, even though the
// raw numbers differ by less than 1.
const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const kgDrifting = [];
for (let i = 0; i < 10; i++) {
  kgDrifting.push({ date: day(27 - i * 3), value: 100 - i * 0.1, unit: 'kg' });
}
const shotsFlat = kgDrifting.map(w => ({ when: w.date + 'T09:00:00', dose: 5 }));
A.check('0.9 kg of drift is not a plateau (it is ~2 lb)',
  detectPlateau(kgDrifting, shotsFlat) === null,
  'a kg series was being compared against a 1 lb threshold');

const kgFlat = [];
for (let i = 0; i < 10; i++) kgFlat.push({ date: day(27 - i * 3), value: 100 - i * 0.01, unit: 'kg' });
const flatShots = kgFlat.map(w => ({ when: w.date + 'T09:00:00', dose: 5 }));
A.check('0.09 kg of drift IS a plateau', detectPlateau(kgFlat, flatShots) !== null);

// ---------- achievements ----------
setUnit('lb');
const statsLb = computeStats([], [{ date: '2026-01-01', value: 200, unit: 'lb' }, { date: '2026-06-01', value: 190, unit: 'lb' }], []);
A.check('stats delta is pounds', near(statsLb.delta, -10), String(statsLb.delta));
A.check('stats carries the kg equivalent', near(statsLb.deltaKg, -4.5359), String(statsLb.deltaKg));
A.check('stats carries the display unit', statsLb.unit === 'lb');
const unlockedLb = ACHIEVEMENTS.filter(a => a.test(statsLb)).map(a => a.id);
A.check('10 lb lost unlocks the 10 lb badge', unlockedLb.includes('lost10'), unlockedLb.join(','));
A.check('...but not the 15 lb badge', !unlockedLb.includes('lost15'));

setUnit('kg');
const statsKg = computeStats([], [{ date: '2026-01-01', value: 100, unit: 'kg' }, { date: '2026-06-01', value: 95, unit: 'kg' }], []);
A.check('5 kg lost unlocks the 5 kg badge', ACHIEVEMENTS.filter(a => a.test(statsKg)).map(a => a.id).includes('lost10'));
A.check('kg users see the kg label', badgeLabel(ACHIEVEMENTS.find(a => a.id === 'lost10')) === '5 kg lost',
  badgeLabel(ACHIEVEMENTS.find(a => a.id === 'lost10')));
setUnit('lb');
A.check('lb users see the lb label', badgeLabel(ACHIEVEMENTS.find(a => a.id === 'lost10')) === '10 lb lost');
A.check('non-weight badges have one label in both units',
  badgeLabel(ACHIEVEMENTS.find(a => !a.labelKg)) === ACHIEVEMENTS.find(a => !a.labelKg).label);

// Every weight badge must carry a kg label, or a kg user sees a stray "lb".
for (const a of ACHIEVEMENTS.filter(x => /^lost/.test(x.id))) {
  A.check(`${a.id} has a kg label`, typeof a.labelKg === 'string' && /kg/.test(a.labelKg), a.labelKg);
  A.check(`${a.id} kg label has no lb in it`, !/\blbs?\b/.test(a.labelKg), a.labelKg);
}
// The two ladders must stay in the same order, or badge tiers cross over.
const kgThresholds = [];
for (const a of ACHIEVEMENTS.filter(x => /^lost/.test(x.id))) {
  let t = null;
  for (let v = 0.5; v <= 60; v += 0.5) {
    if (a.test({ delta: 0, deltaKg: -v, unit: 'kg' })) { t = v; break; }
  }
  kgThresholds.push([a.id, t]);
}
A.check('every weight badge is reachable in kg', kgThresholds.every(([, t]) => t != null),
  JSON.stringify(kgThresholds));
A.check('the kg ladder ascends like the lb one',
  kgThresholds.every(([, t], i) => i === 0 || t > kgThresholds[i - 1][1]),
  JSON.stringify(kgThresholds));

// ---------- storage keeps what was typed ----------
const s1 = sanitizeWeight({ date: '2026-01-01', value: 82.5, unit: 'kg' });
A.check('sanitizeWeight keeps kg as kg', s1.unit === 'kg' && s1.value === 82.5, JSON.stringify(s1));
const s2 = sanitizeWeight({ date: '2026-01-01', value: 180, unit: 'stone' });
A.check('an unknown unit falls back to lb', s2.unit === 'lb', JSON.stringify(s2));

// ---------- settings plumbing ----------
const DEFAULT_SETTINGS = R('DEFAULT_SETTINGS');
A.check('weightUnit has a default', DEFAULT_SETTINGS.weightUnit === 'lb');
const sanitizeSettings = R('sanitizeSettings');
A.check('weightUnit survives a sync round-trip',
  sanitizeSettings({ weightUnit: 'kg' }).weightUnit === 'kg');

A.report();
