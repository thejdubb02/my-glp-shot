#!/usr/bin/env node
// Service worker offline self-test: runs the real web/app/sw.js in a VM with a
// fake Cache Storage and a network that is down.
//
// The install step precaches "js/shots.js"; the page asks for
// "js/shots.js?v=N". Unless the offline fallback ignores the query string, a
// phone that goes offline right after installing gets "Offline" for every
// script and the app is a blank page.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'app');
const ORIGIN = 'https://app.example';
let pass = 0; const failures = [];
const ok = (name, cond) => { if (cond) pass++; else failures.push(name); };

const store = new Map();                       // absolute URL -> body
const abs = (u) => new URL(typeof u === 'string' ? u : u.url, ORIGIN + '/').href;
const lookup = (req, opts) => {
  const want = abs(req);
  if (store.has(want)) return store.get(want);
  if (opts && opts.ignoreSearch) {
    const bare = want.split('?')[0];
    for (const [k, v] of store) if (k.split('?')[0] === bare) return v;
  }
  return undefined;
};
const cache = {
  addAll: async (urls) => { for (const u of urls) store.set(abs(u), 'body of ' + u); },
  add: async (u) => { store.set(abs(u), 'body of ' + u); },
  put: async (req, res) => { store.set(abs(req), res); },
  match: async (req, opts) => lookup(req, opts),
};
const listeners = {};
const sandbox = {
  URL, Promise, console,
  Response: class { constructor(body, init) { this.body = body; this.status = (init && init.status) || 200; } },
  caches: { open: async () => cache, keys: async () => [], delete: async () => true, match: async (req, opts) => lookup(req, opts) },
  fetch: async () => { throw new Error('offline'); },
};
sandbox.self = {
  addEventListener: (type, fn) => { listeners[type] = fn; },
  skipWaiting: async () => {},
  clients: { claim: async () => {} },
  location: { origin: ORIGIN },
};
vm.runInNewContext(fs.readFileSync(path.join(APP, 'sw.js'), 'utf8'), sandbox);

let installed;
listeners.install({ waitUntil: (p) => { installed = p; } });
await installed;
ok('install precached the scripts', store.has(ORIGIN + '/js/shots.js'));

async function offlineGet(url, mode) {
  let answer;
  listeners.fetch({ request: { url: ORIGIN + url, method: 'GET', mode }, respondWith: (p) => { answer = p; } });
  return answer;
}

const script = await offlineGet('/js/shots.js?v=999', 'no-cors');
ok('offline: a script asked for with ?v= comes from the precache', script === 'body of js/shots.js');
const data = await offlineGet('/data.js?v=999', 'no-cors');
ok('offline: data.js asked for with ?v= comes from the precache', data === 'body of data.js');
const css = await offlineGet('/styles.css?v=999', 'no-cors');
ok('offline: styles.css asked for with ?v= comes from the precache', css === 'body of styles.css');
const missing = await offlineGet('/js/not-a-real-file.js?v=999', 'no-cors');
ok('offline: an unknown script still gets 503, never the app shell', missing && missing.status === 503);

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log('\nFailures:'); failures.forEach(f => console.log(`  ✗ ${f}`)); process.exit(1); }
