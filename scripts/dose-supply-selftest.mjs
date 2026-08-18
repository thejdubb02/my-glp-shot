// Runs the shipped app.js in a VM and exercises the two things Lin's second
// email exposed: a dose field that refused 0.25, and a supply card whose mg/mL
// numbers had no feedback and whose progress bar never moved.
//
//   node scripts/dose-supply-selftest.mjs
//   FAKE_INDEXEDDB_PATH=/abs/path/to/fake-indexeddb node scripts/dose-supply-selftest.mjs
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const APP_JS = process.env.APP_JS_PATH || new URL('../web/app/app.js', import.meta.url).pathname;
const INDEX  = process.env.INDEX_HTML_PATH || new URL('../web/app/index.html', import.meta.url).pathname;

const req = createRequire(import.meta.url);
let fidb;
try {
  fidb = req(process.env.FAKE_INDEXEDDB_PATH || 'fake-indexeddb');
} catch (e) {
  console.error(`Could not load fake-indexeddb (${e.message}).\n  npm install fake-indexeddb`);
  process.exit(2);
}

let passed = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) { passed++; return; }
  failures.push(`${name}${extra ? ` — ${extra}` : ''}`);
}
function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

// ---- a DOM stub that returns the SAME node for the same selector, so
// ---- innerHTML/value/hidden written by app.js can be read back.
const nodes = new Map();
function makeNode(sel) {
  const node = {
    sel, value: '', textContent: '', innerHTML: '', hidden: false,
    dataset: {}, style: {},
    classList: { add(){}, remove(){}, toggle(){}, contains: () => false },
    addEventListener(){}, removeEventListener(){}, setAttribute(){},
    getAttribute: () => null, appendChild(){}, focus(){}, click(){},
    closest: () => null, showModal(){}, close(){},
    dispatchEvent: () => true,
    querySelector: () => makeNode(sel + ' *'),
    querySelectorAll: () => [],
  };
  return node;
}
function nodeFor(sel) {
  if (!nodes.has(sel)) nodes.set(sel, makeNode(sel));
  return nodes.get(sel);
}

const doc = {
  addEventListener(){}, removeEventListener(){}, readyState: 'loading',
  querySelector: nodeFor, querySelectorAll: () => [],
  getElementById: (id) => nodeFor('#' + id),
  createElement: () => makeNode('<created>'),
  documentElement: makeNode(':root'), body: makeNode('body'), head: makeNode('head'),
  visibilityState: 'visible', activeElement: null,
};
const store = new Map();
const ls = { getItem: k => store.get(k) ?? null, setItem: (k,v)=>store.set(k,String(v)),
             removeItem: k=>store.delete(k), clear: ()=>store.clear() };

const sandbox = {
  console: { log(){}, warn(){}, error(){}, info(){} },
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval, queueMicrotask,
  TextEncoder, TextDecoder, URL, URLSearchParams, Promise, Date, Math, JSON, Event,
  atob, btoa, Intl, crypto: globalThis.crypto,
  indexedDB: fidb.indexedDB ?? fidb.default, IDBKeyRange: fidb.IDBKeyRange,
  document: doc, localStorage: ls, sessionStorage: ls,
  navigator: { onLine: true, userAgent: 'node',
    serviceWorker: { addEventListener(){}, register: async()=>({}), ready: new Promise(()=>{}) },
    storage: { persisted: async()=>true, persist: async()=>true } },
  location: { href: 'https://app.myglpshot.com/', hash: '', search: '', pathname: '/', hostname: 'app.myglpshot.com' },
  history: { replaceState(){}, pushState(){} },
  fetch: async () => { throw new Error('offline'); },
  alert(){}, confirm: () => true, prompt: () => null,
  matchMedia: () => ({ matches: false, addEventListener(){}, addListener(){} }),
  requestAnimationFrame: fn => setTimeout(fn, 0),
  scrollTo(){}, addEventListener(){}, getComputedStyle: () => ({ getPropertyValue: () => '' }),
  performance: { now: () => 0 },
};
function N(){} N.prototype = {}; N.permission = 'default'; N.requestPermission = async () => 'default';
sandbox.Notification = N;
function ChartStub(){} ChartStub.register = () => {}; ChartStub.defaults = { plugins: {} }; ChartStub.registry = {};
sandbox.Chart = ChartStub;
sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox;

vm.createContext(sandbox);
try {
  vm.runInContext(fs.readFileSync(APP_JS, 'utf8'), sandbox, { filename: 'app.js' });
} catch (e) {
  console.error(`app.js failed to evaluate: ${e.message}`);
  process.exit(2);
}
const run = (src) => vm.runInContext(src, sandbox);

// ===================== 1. The markup that caused the bug =====================
// A step of 0.1 makes 0.25 fail HTML validation outright — that is precisely
// what Lin hit. Assert on the shipped markup, not on a copy of it.
const html = fs.readFileSync(INDEX, 'utf8');
for (const id of ['shot-dose-amt', 'set-dose', 'recon-dose']) {
  const tag = html.match(new RegExp(`<input id="${id}"[^>]*>`));
  ok(`#${id} exists in index.html`, !!tag);
  if (!tag) continue;
  const step = (tag[0].match(/step="([^"]+)"/) || [])[1];
  ok(`#${id} step accepts 0.25`, step === 'any' || (Number(step) > 0 && Math.abs((0.25 / Number(step)) - Math.round(0.25 / Number(step))) < 1e-9),
     `step="${step}" rejects 0.25`);
  ok(`#${id} step accepts 0.125 micro-doses`, step === 'any' || (Number(step) > 0 && Math.abs((0.125 / Number(step)) - Math.round(0.125 / Number(step))) < 1e-9),
     `step="${step}" rejects 0.125`);
  ok(`#${id} offers a decimal keypad`, /inputmode="decimal"/.test(tag[0]));
}
ok('supply mg field says "total"', /Total mg in the whole pen or vial/.test(html));
ok('supply volume field marked optional', /Liquid volume \(mL\).*optional/.test(html));
ok('supply form explains mg\/mL', /mg\/mL/.test(html) && /not the dose you inject/.test(html));

// ===================== 2. Dose ladders =====================
eq('semaglutide ladder starts at 0.25', run(`findMedPreset('Semaglutide').doses[0]`), 0.25);
ok('Ozempic resolves to the semaglutide ladder', run(`findMedPreset('Ozempic').doses.includes(0.25)`));
ok('Wegovy ladder carries 1.7 and 2.4', run(`[1.7,2.4].every(d => findMedPreset('Wegovy').doses.includes(d))`));
eq('tirzepatide ladder', run(`findMedPreset('Mounjaro').doses`), [2.5, 5, 7.5, 10, 12.5, 15]);
ok('every ladder dose is enterable at step 0.001',
   run(`MED_PRESETS.every(p => (p.doses||[]).every(d => Math.abs(d*1000 - Math.round(d*1000)) < 1e-6))`));
ok('every ladder is sorted ascending',
   run(`MED_PRESETS.every(p => (p.doses||[]).every((d,i,a) => i === 0 || d > a[i-1]))`));
ok('retatrutide quotes no ladder (no approved label)', run(`findMedPreset('Retatrutide').doses.length === 0`));

// chips render
run(`$('#shot-dose-amt').value = '0.25'`);
run(`renderDoseChips('#shot-dose-chips', '#shot-dose-amt', 'Ozempic')`);
const chipHtml = nodeFor('#shot-dose-chips').innerHTML;
ok('chips render for a known medication', chipHtml.includes('data-dose="0.25"'), chipHtml.slice(0, 120));
ok('chip row is shown', nodeFor('#shot-dose-chips').hidden === false);
ok('chip row knows which input to fill', nodeFor('#shot-dose-chips').dataset.target === '#shot-dose-amt');
ok('current dose is marked active', /class="dose-chip active" data-dose="0.25"/.test(chipHtml), chipHtml.slice(0, 160));
eq('one chip per ladder step', (chipHtml.match(/data-dose=/g) || []).length, 6);
ok('only the current dose is active', (chipHtml.match(/dose-chip active/g) || []).length === 1);

run(`renderDoseChips('#shot-dose-chips', '#shot-dose-amt', 'Retatrutide')`);
ok('no ladder hides the row', nodeFor('#shot-dose-chips').hidden === true);
eq('no ladder clears the row', nodeFor('#shot-dose-chips').innerHTML, '');
run(`renderDoseChips('#shot-dose-chips', '#shot-dose-amt', 'My Custom Peptide')`);
ok('unknown medication hides the row', nodeFor('#shot-dose-chips').hidden === true);
run(`renderDoseChips('#shot-dose-chips', '#shot-dose-amt', '')`);
ok('blank medication hides the row', nodeFor('#shot-dose-chips').hidden === true);

// ===================== 3. Supply usage attribution =====================
const S = (id, opened, mg) => ({ id, opened_at: opened, total_mg: mg });
const shot = (when, dose) => ({ when, dose });
const usage = (sups, shots) =>
  run(`(() => { const u = supplyUsage(${JSON.stringify(sups)}, ${JSON.stringify(shots)});
       return Object.fromEntries([...u.entries()]); })()`);

let u = usage([S(1, '2026-01-01', 8)], [
  shot('2025-12-30T09:00', 0.25),   // before it was opened
  shot('2026-01-01T09:00', 0.25),   // on the open date — counts
  shot('2026-01-08T09:00', 0.5),
]);
eq('shots before the open date are excluded', u['1'].usedMg, 0.75);
eq('last dose is the most recent shot, not the largest', u['1'].lastDose, 0.5);

u = usage([S(1, '2026-01-01', 8), S(2, '2026-01-15', 8)], [
  shot('2026-01-08T09:00', 0.5),
  shot('2026-01-15T09:00', 1),     // on pen 2's open date — belongs to pen 2
  shot('2026-01-22T09:00', 1),
]);
eq('pen 1 stops at pen 2 opening', u['1'].usedMg, 0.5);
eq('pen 2 owns everything after', u['2'].usedMg, 2);
ok('no shot is counted twice', u['1'].usedMg + u['2'].usedMg === 2.5);

u = usage([S(1, '2026-01-01', 8), S(2, null, 8)], [shot('2026-01-08T09:00', 0.5)]);
ok('an undated supply gets no attribution', u['2'] === undefined);
eq('the dated supply still counts', u['1'].usedMg, 0.5);

u = usage([S(1, '2026-01-01', 8)], []);
eq('no shots means nothing used', u['1'].usedMg, 0);
eq('no shots means no last dose', u['1'].lastDose, null);

// out-of-order supply list must not change the windows
const outOfOrder = usage([S(2, '2026-01-15', 8), S(1, '2026-01-01', 8)], [
  shot('2026-01-08T09:00', 0.5), shot('2026-01-22T09:00', 1),
]);
eq('supply order in the list does not matter (pen 1)', outOfOrder['1'].usedMg, 0.5);
eq('supply order in the list does not matter (pen 2)', outOfOrder['2'].usedMg, 1);

// shots arrive newest-first from getShotsSorted()
const desc = usage([S(1, '2026-01-01', 8)], [
  shot('2026-01-08T09:00', 0.5), shot('2026-01-01T09:00', 0.25),
]);
eq('newest-first shot order still finds the latest dose', desc['1'].lastDose, 0.5);

// a shot with an unparseable date must be skipped, not counted as 0/NaN
const bad = usage([S(1, '2026-01-01', 8)], [shot('not-a-date', 0.5), shot('2026-01-08T09:00', 0.25)]);
eq('an unparseable shot date is skipped', bad['1'].usedMg, 0.25);

// ===================== 4. Supply readout =====================
function readout(mg, ml, defaultDose) {
  nodeFor('#supply-total-mg').value = mg;
  nodeFor('#supply-volume-ml').value = ml;
  run(`settings.defaultDose = ${JSON.stringify(defaultDose)}`);
  run(`updateSupplyReadout()`);
  const el = nodeFor('#supply-readout');
  return { text: el.textContent, hidden: el.hidden };
}
let r = readout('2.1', '3', 0.25);           // Lin's exact numbers
ok('readout shows concentration', r.text.includes('0.7 mg/mL'), r.text);
ok('readout shows dose count', r.text.includes('about 8 doses'), r.text);
ok('readout is visible', r.hidden === false);

r = readout('8', '3', 0.25);
ok('8 mg / 3 mL reads as 2.667 mg/mL', r.text.includes('2.667 mg/mL'), r.text);
ok('32 doses at 0.25 mg', r.text.includes('about 32 doses'), r.text);

r = readout('2.5', '', 2.5);
ok('volume is optional', !r.text.includes('mg/mL') && r.text.includes('about 1 dose'), r.text);
ok('one dose is singular', /about 1 dose\b/.test(r.text) && !/1 doses/.test(r.text), r.text);

r = readout('', '3', 0.25);
ok('no mg means no readout', r.hidden === true && r.text === '');
r = readout('0', '3', 0.25);
ok('zero mg means no readout', r.hidden === true);
r = readout('8', '0', 0.25);
ok('zero volume is ignored, not divided by', !r.text.includes('Infinity') && !r.text.includes('mg/mL'), r.text);
r = readout('0.25', '', 2.5);
ok('a dose larger than the supply reports no dose count', !r.text.includes('dose'), r.text);

// ===================== report =====================
if (failures.length) {
  console.log(`\n${passed} passed, ${failures.length} FAILED`);
  failures.forEach(f => console.log(`  ✗ ${f}`));
  process.exit(1);
}
console.log(`${passed} passed, 0 failed`);
console.log('Dose ladder + supply assertions all passed.');
