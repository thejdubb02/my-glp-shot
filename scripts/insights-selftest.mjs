#!/usr/bin/env node
// Insights engine self-test: runs the shipped insight_* functions and
// computeInsights from web/app/app.js against seeded data.
//
//   node scripts/insights-selftest.mjs
import { loadApp, Assert } from './lib/app-harness.mjs';

const { R } = await loadApp();
const A = new Assert('insights');
const DAY = 86400000;
const iso = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString();
const call = (fn, ctx) => R(`${fn}(${JSON.stringify(ctx)})`);
R(`settings.cadenceDays = 7`);

// ---- site rotation
const sites = (list) => list.map((site, i) => ({ when: iso(i * 7), dose: 2.5, site }));
let r = call('insight_siteRotation', { shots: sites(['Left abdomen', 'Left thigh']) });
A.check('site rotation: <4 sited shots is "not ready"', r.ready === false && /2 more/.test(r.need), JSON.stringify(r));
r = call('insight_siteRotation', { shots: sites(['Left abdomen', 'Left thigh', 'Left abdomen', 'Right thigh']) });
A.check('site rotation: 3 of 4 left says use the right side', r.ready !== false && /left side 3\/4/.test(r.body) && /right side may be/.test(r.body), JSON.stringify(r));
r = call('insight_siteRotation', { shots: sites(['Left abdomen', 'Right abdomen', 'Left thigh', 'Right thigh']) });
A.check('site rotation: balanced sides suppress the card', r === null, JSON.stringify(r));
r = call('insight_siteRotation', { shots: [...sites(['Left abdomen', 'Left thigh', 'Left abdomen', 'Left thigh']), { when: iso(1), dose: 2.5 }] });
A.check('site rotation: shots with no site are ignored', r && /last 4 shots/.test(r.body), JSON.stringify(r));

// ---- cadence drift
const everyN = (n, count, dose = 2.5) => Array.from({ length: count }, (_, i) => ({ when: iso(i * n), dose }));
r = call('insight_cadenceDrift', { shots: everyN(7, 3) });
A.check('cadence: 3 shots is "not ready"', r.ready === false);
r = call('insight_cadenceDrift', { shots: everyN(7, 5) });
A.check('cadence: weekly shots read as on cadence', /right on cadence/.test(r.title), r.title);
r = call('insight_cadenceDrift', { shots: everyN(9, 5) });
A.check('cadence: 9-day gaps read as later, ~2.0 days', /drifted later/.test(r.title) && /2\.0 days later/.test(r.body), JSON.stringify(r));
r = call('insight_cadenceDrift', { shots: everyN(5, 5) });
A.check('cadence: 5-day gaps read as earlier and warn about stacking', /drifted earlier/.test(r.title) && /stack levels/.test(r.body));

// ---- dose hold
r = call('insight_doseHold', { shots: everyN(7, 3), seEntries: [] });
A.check('dose hold: <4 shots is "not ready"', r.ready === false);
r = call('insight_doseHold', { shots: [...everyN(7, 3, 5), { when: iso(28), dose: 2.5 }].reverse(), seEntries: [] });
A.check('dose hold: mixed doses in the last 4 suppress the card', r === null, JSON.stringify(r));
r = call('insight_doseHold', { shots: everyN(7, 4, 5), seEntries: [] });
A.check('dose hold: 4 at one dose, no side effects = holding steady', /Holding steady/.test(r.title) && /5 mg/.test(r.body), JSON.stringify(r));
r = call('insight_doseHold', { shots: everyN(7, 4, 5), seEntries: [{ at: Date.now() - 2 * DAY, se: { nausea: 'severe' } }] });
A.check('dose hold: a severe symptom in the window says discuss first', /discuss before titrating/.test(r.title), r.title);
r = call('insight_doseHold', { shots: everyN(7, 4, 5), seEntries: [{ at: Date.now() - 90 * DAY, se: { nausea: 'severe' } }] });
A.check('dose hold: a severe symptom BEFORE the window is ignored', /Holding steady/.test(r.title), r.title);

// ---- nausea timing: without standalone symptom days, falls back to shot gaps
const nauseaShots = Array.from({ length: 6 }, (_, i) => ({ when: iso(i * 7), dose: 2.5, sideEffects: { nausea: 'mild' } }));
r = call('insight_nauseaDay', { shots: nauseaShots.slice(0, 3), seEntries: [], moods: [], appetites: [], foodNoise: [], weights: [], cycles: [] });
A.check('nausea: 3 nausea shots is "not ready"', r.ready === false);

// ---- computeInsights end to end against IndexedDB
const empty = await R(`computeInsights()`);
A.check('computeInsights on an empty db returns the two lists', Array.isArray(empty.free) && Array.isArray(empty.premium));
A.check('empty db: every card is pending, none claims a finding', [...empty.free, ...empty.premium].every(c => c.ready === false), JSON.stringify(empty));

for (let i = 0; i < 5; i++) {
  await R(`dbPut('shots', ${JSON.stringify({ when: iso(i * 7), dose: 5, site: i % 2 ? 'Right abdomen' : 'Left abdomen' })})`);
}
const full = await R(`computeInsights()`);
const byId = Object.fromEntries([...full.free, ...full.premium].map(c => [c.id, c]));
A.check('seeded db: cadence card is ready from stored shots', byId['cadence-drift'] && byId['cadence-drift'].ready !== false, JSON.stringify(byId['cadence-drift']));
A.check('seeded db: dose-hold card is ready', byId['dose-hold'] && /Holding steady/.test(byId['dose-hold'].title));
A.check('premium insights stay in the premium list', full.premium.every(c => c.premium === true) && full.free.every(c => !c.premium));

// ---- one broken insight must not take the rest down
R(`FREE_INSIGHTS.unshift(function boom() { throw new Error('boom'); })`);
R(`globalThis.__warn = console.warn; console.warn = () => {}`);
const survived = await R(`computeInsights()`);
R(`console.warn = globalThis.__warn`);
A.check('a throwing insight is dropped, the others still compute', survived.free.length === full.free.length, `${survived.free.length} vs ${full.free.length}`);

A.report();
