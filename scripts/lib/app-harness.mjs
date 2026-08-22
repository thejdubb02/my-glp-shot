// Shared test harness: loads the real web/app/app.js into a VM context with a
// stub DOM and a real IndexedDB, and hands back an accessor into its scope.
//
// This exists because notes-selftest and dose-supply-selftest had each grown
// their own ~90-line copy of the same sandbox, and they had already drifted
// apart (different Notification stubs, different globals). A test that fails
// only because its private sandbox is missing a global teaches nothing, so the
// sandbox is defined once here and every suite gets the same one.
//
//   import { loadApp, Assert } from './lib/app-harness.mjs';
//   const { R } = await loadApp();
//   const buildPayload = R('buildPayload');
//
// Everything app.js does at load sits behind DOMContentLoaded, and readyState
// is pinned to 'loading', so the file loads without booting the UI.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_APP_JS = path.join(HERE, '..', '..', 'web', 'app', 'app.js');

function loadFakeIndexedDB(entry) {
  const req = createRequire(import.meta.url);
  const base = entry || process.env.FAKE_INDEXEDDB_PATH || 'fake-indexeddb';
  const mod = req(base);
  const indexedDB = mod.indexedDB ?? mod.default?.indexedDB ?? mod.default ?? mod;
  const IDBKeyRange = mod.IDBKeyRange ?? mod.default?.IDBKeyRange
    ?? req(`${base}/build/cjs/index.js`).IDBKeyRange;
  if (!indexedDB || typeof indexedDB.open !== 'function') {
    throw new Error('fake-indexeddb loaded but exposed no indexedDB with .open()');
  }
  return { indexedDB, IDBKeyRange };
}

const noopEl = () => ({
  value: '', textContent: '', innerHTML: '', dataset: {}, hidden: false, checked: false,
  // Theme code calls style.setProperty for CSS custom properties, which a plain
  // object doesn't have.
  style: { setProperty(){}, removeProperty(){}, getPropertyValue(){ return ''; } },
  // <select> paths read .options and .selectedIndex; <input type=file> reads
  // .files. Present-but-empty is the honest stub — absent throws instead.
  options: [], selectedIndex: -1, files: [], disabled: false, open: false,
  classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
  addEventListener(){}, removeEventListener(){}, setAttribute(){}, getAttribute(){ return null; },
  removeAttribute(){}, appendChild(){}, insertBefore(){}, replaceChildren(){},
  closest(){ return null; }, querySelector(){ return null; }, querySelectorAll(){ return []; },
  focus(){}, blur(){}, click(){}, remove(){}, showModal(){}, close(){}, scrollIntoView(){},
  getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }),
});

// domMode decides what a selector finds:
//   'absent' — every lookup returns null. Closest to a bare page, and what the
//              notes suite was written against; code guarded by `if (!el)
//              return;` short-circuits, so only pure logic runs.
//   'stub'   — every lookup returns a FRESH inert element. Needed by anything
//              that walks a render path (applySettingsToInputs writes straight
//              to .value and throws on null) but does not read its writes back.
//   'sticky' — every lookup returns the SAME element for a given selector, so
//              innerHTML/value/hidden written by app.js can be asserted on.
//              This is what lets a suite test rendering rather than just logic.
// Suites pick explicitly, because the choice changes which branches execute.
export function makeSandbox({ indexedDB, IDBKeyRange }, domMode = 'absent') {
  const nodes = new Map();
  const nodeFor = (sel) => {
    if (!nodes.has(sel)) {
      const n = noopEl();
      n.sel = sel;
      n.querySelector = (child) => nodeFor(`${sel} ${child}`);
      nodes.set(sel, n);
    }
    return nodes.get(sel);
  };
  const find = domMode === 'sticky' ? nodeFor
             : domMode === 'stub'   ? () => noopEl()
             : () => null;
  const byId = domMode === 'sticky' ? (id) => nodeFor('#' + id) : find;
  const doc = {
    addEventListener(){}, removeEventListener(){},
    querySelector: find, querySelectorAll: () => [],
    getElementById: byId, createElement(){ return noopEl(); },
    documentElement: domMode === 'sticky' ? nodeFor(':root') : noopEl(),
    body: domMode === 'sticky' ? nodeFor('body') : noopEl(),
    head: domMode === 'sticky' ? nodeFor('head') : noopEl(),
    visibilityState: 'visible', activeElement: null, hidden: false,
    readyState: 'loading',
  };
  const store = new Map();
  const localStorageStub = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    clear: () => store.clear(),
  };
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    TextEncoder, TextDecoder, URL, URLSearchParams, Promise, Date, Math, JSON,
    atob, btoa, structuredClone, AbortController, Intl,
    CompressionStream: globalThis.CompressionStream,
    DecompressionStream: globalThis.DecompressionStream,
    Response: globalThis.Response, Request: globalThis.Request, Headers: globalThis.Headers,
    Blob: globalThis.Blob,
    crypto: globalThis.crypto,
    indexedDB, IDBKeyRange,
    document: doc,
    localStorage: localStorageStub,
    sessionStorage: localStorageStub,
    navigator: {
      onLine: true, userAgent: 'node',
      serviceWorker: { addEventListener(){}, register: async () => ({ scope: '/' }), ready: new Promise(() => {}), controller: null },
      storage: { persisted: async () => true, persist: async () => true },
    },
    location: { href: 'https://app.myglpshot.com/', hash: '', search: '', origin: 'https://app.myglpshot.com', pathname: '/' },
    fetch: async () => { throw new Error('network disabled in selftest'); },
    alert(){}, confirm(){ return true; }, prompt(){ return null; },
    matchMedia: () => ({ matches: false, addEventListener(){}, addListener(){} }),
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    scrollTo(){}, scrollBy(){}, scroll(){}, focus(){}, open(){ return null; },
    addEventListener(){}, removeEventListener(){}, dispatchEvent(){ return true; },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    history: { pushState(){}, replaceState(){}, back(){} },
    performance: { now: () => 0 },
    URL_createObjectURL: () => 'blob:stub',
  };
  // app.js probes Notification.prototype for scheduled-trigger support at load,
  // so this has to be a real constructor rather than an object literal.
  function NotificationStub(){}
  NotificationStub.prototype = {};
  NotificationStub.permission = 'default';
  NotificationStub.requestPermission = async () => 'default';
  sandbox.Notification = NotificationStub;
  // Chart.js ships separately and is never fetched here; only the statics
  // app.js touches at load need to exist.
  function ChartStub(){ return { destroy(){}, update(){}, data: {}, options: {} }; }
  ChartStub.register = () => {};
  ChartStub.defaults = { font: {}, plugins: { legend: {} }, scale: {}, scales: {} };
  ChartStub.registry = { getPlugin: () => null };
  sandbox.Chart = ChartStub;
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  // Sticky suites assert on rendered output, so they need the same handle on a
  // node that app.js got. Non-enumerable so it can't be mistaken for a global
  // the app itself provides.
  Object.defineProperty(sandbox, '__nodeFor', { value: nodeFor, enumerable: false });
  return sandbox;
}

// Loads app.js and returns { sandbox, R }. R(expr) evaluates an expression in
// the app's own scope, which is how the suites reach functions that are module-
// private (app.js declares everything at top level in a classic script).
export async function loadApp({ appJs, fakeIndexedDBPath, domMode = 'absent' } = {}) {
  const file = appJs || process.env.APP_JS_PATH || DEFAULT_APP_JS;
  let idb;
  try {
    idb = loadFakeIndexedDB(fakeIndexedDBPath);
  } catch (e) {
    console.error(`Could not load fake-indexeddb (${e.message}).`);
    console.error('Install it and re-run, e.g.:\n  npm install fake-indexeddb\n  FAKE_INDEXEDDB_PATH=/abs/path/to/node_modules/fake-indexeddb node <suite>');
    process.exit(2);
  }
  const sandbox = makeSandbox(idb, domMode);
  vm.createContext(sandbox);
  try {
    vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: 'app.js' });
  } catch (e) {
    // The stack points at the exact app.js line, which is nearly always a
    // browser global this sandbox has not stubbed yet.
    console.error('app.js failed to load in the test sandbox:', e.message);
    console.error(e.stack);
    process.exit(2);
  }
  return {
    sandbox,
    R: (expr) => vm.runInContext(expr, sandbox),
    // Only meaningful under domMode:'sticky'; in the other modes each lookup is
    // a different object and asserting on it would prove nothing.
    nodeFor: sandbox.__nodeFor,
  };
}

// Minimal assertion counter shared by the suites, so their output and exit
// codes match and CI can treat them identically.
export class Assert {
  constructor(label) { this.label = label; this.pass = 0; this.fail = 0; this.failures = []; }
  check(name, cond, detail) {
    if (cond) { this.pass++; return true; }
    this.fail++;
    this.failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    return false;
  }
  eq(name, got, want) {
    return this.check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
  report() {
    console.log(`\n${this.pass} passed, ${this.fail} failed`);
    if (this.fail) {
      console.log('\nFailures:');
      for (const f of this.failures) console.log(`  ✗ ${f}`);
      process.exit(1);
    }
    console.log(`${this.label} assertions all passed.`);
  }
}
