#!/usr/bin/env node
// Daily-notes self-test.
//
// Loads the real web/app/app.js into a VM context with a stub DOM and a real
// IndexedDB (fake-indexeddb), then exercises the notes store, the sanitiser and
// the merge. It runs the shipped code rather than a copy, so it fails when the
// app changes and the behaviour below stops holding.
//
//   npm install fake-indexeddb        (once, anywhere on NODE_PATH)
//   node scripts/notes-selftest.mjs
//
// Everything the app does at load sits behind DOMContentLoaded, so a no-op
// addEventListener is enough to load the file without booting the UI.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// APP_JS_PATH lets the suite run against a modified copy — used to confirm the
// assertions actually fail when the behaviour they guard is broken.
const APP_JS = process.env.APP_JS_PATH || path.join(HERE, '..', 'web', 'app', 'app.js');

// fake-indexeddb lives wherever it was installed; FAKE_INDEXEDDB_PATH lets this
// run against a scratch install without adding a dependency to the repo. It ships
// as CommonJS, so require() rather than import().
const { createRequire } = await import('node:module');
const req = createRequire(import.meta.url);
let fakeIndexedDB, FDBKeyRange;
try {
  const base = process.env.FAKE_INDEXEDDB_PATH || 'fake-indexeddb';
  const mod = req(base);
  fakeIndexedDB = mod.indexedDB ?? mod.default?.indexedDB ?? mod.default ?? mod;
  FDBKeyRange = mod.IDBKeyRange ?? mod.default?.IDBKeyRange ?? req(`${base}/build/cjs/index.js`).IDBKeyRange;
} catch (e) {
  console.error(`Could not load fake-indexeddb (${e.message}).`);
  console.error(`Install it and re-run, e.g.:\n  npm install fake-indexeddb\n  FAKE_INDEXEDDB_PATH=/abs/path/to/node_modules/fake-indexeddb node ${process.argv[1]}`);
  process.exit(2);
}
if (!fakeIndexedDB || typeof fakeIndexedDB.open !== 'function') {
  console.error('fake-indexeddb loaded but did not expose an indexedDB with .open()');
  process.exit(2);
}

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}
function eq(name, got, want) {
  check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

// ---------- stub DOM ----------
const noopEl = () => ({
  value: '', textContent: '', innerHTML: '', dataset: {}, style: {}, hidden: false,
  classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
  addEventListener(){}, removeEventListener(){}, setAttribute(){}, getAttribute(){ return null; },
  appendChild(){}, closest(){ return null; }, querySelector(){ return null; }, querySelectorAll(){ return []; },
  focus(){}, click(){}, remove(){},
});
const doc = {
  addEventListener(){}, removeEventListener(){},
  querySelector(){ return null; }, querySelectorAll(){ return []; },
  getElementById(){ return null; }, createElement(){ return noopEl(); },
  documentElement: noopEl(), body: noopEl(), head: noopEl(),
  visibilityState: 'visible', activeElement: null, hidden: false,
  // 'loading' keeps every bootstrap path behind the DOMContentLoaded listener,
  // which is a no-op here — so the file loads without booting the UI.
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
  crypto: globalThis.crypto,
  indexedDB: fakeIndexedDB,
  IDBKeyRange: FDBKeyRange,
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
};
// Notification must be a real constructor — app.js probes Notification.prototype
// for scheduled-trigger support at load.
function NotificationStub(){}
NotificationStub.prototype = {};
NotificationStub.permission = 'default';
NotificationStub.requestPermission = async () => 'default';
sandbox.Notification = NotificationStub;
// Chart.js is bundled separately and never loaded here; a stub with the statics
// app.js touches at load is enough.
function ChartStub(){ return { destroy(){}, update(){}, data: {}, options: {} }; }
ChartStub.register = () => {};
ChartStub.defaults = { font: {}, plugins: { legend: {} }, scale: {}, scales: {} };
ChartStub.registry = { getPlugin: () => null };
sandbox.Chart = ChartStub;
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.self = sandbox;

vm.createContext(sandbox);
const src = fs.readFileSync(APP_JS, 'utf8');
try {
  vm.runInContext(src, sandbox, { filename: 'app.js' });
} catch (e) {
  // The stack points at the exact app.js line, which is usually a browser global
  // this sandbox hasn't stubbed yet.
  console.error('app.js failed to load in the test sandbox:', e.message);
  console.error(e.stack);
  process.exit(2);
}

// Pull the functions under test out of the context's lexical scope.
const R = (expr) => vm.runInContext(expr, sandbox);
const sanitizeNote   = R('sanitizeNote');
const mergeNotes     = R('mergeNotes');
const saveNote       = R('saveNote');
const getNote        = R('getNote');
const deleteNote     = R('deleteNote');
const getNotesSorted = R('getNotesSorted');
const noteSnippet    = R('noteSnippet');
const formatNoteDate = R('formatNoteDate');
const escapeHTML     = R('escapeHTML');
const NOTE_MAX       = R('NOTE_MAX');
const todayISODate   = R('todayISODate');
const shiftISODate   = R('shiftISODate');
const buildPayload   = R('buildPayload');

const wipe = async () => {
  for (const n of await getNotesSorted()) await deleteNote(n.date);
};

// ---------- sanitiser ----------
check('sanitizeNote rejects null', sanitizeNote(null) === null);
check('sanitizeNote rejects a string', sanitizeNote('nope') === null);
check('sanitizeNote rejects a missing date', sanitizeNote({ text: 'hi' }) === null);
check('sanitizeNote rejects empty text', sanitizeNote({ date: '2026-03-15', text: '   ' }) === null);
{
  const n = sanitizeNote({ date: '2026-03-15', text: '  house hunting  ' });
  eq('sanitizeNote keeps the date', n && n.date, '2026-03-15');
  eq('sanitizeNote trims the text', n && n.text, 'house hunting');
}
{
  const long = 'x'.repeat(NOTE_MAX + 500);
  const n = sanitizeNote({ date: '2026-03-15', text: long });
  eq('sanitizeNote caps length', n && n.text.length, NOTE_MAX);
}
{
  const n = sanitizeNote({ date: '2026-03-15', text: 'ok', updatedAt: 'not-a-date' });
  check('sanitizeNote drops an unparseable updatedAt', n && !('updatedAt' in n));
}
{
  // A bare YYYY-MM-DD must survive untouched — this is the timezone bug that
  // shifted entries onto the wrong day.
  const n = sanitizeNote({ date: '2026-03-15', text: 'x' });
  eq('sanitizeNote does not shift a bare date', n && n.date, '2026-03-15');
}

// ---------- store roundtrip ----------
await wipe();
await saveNote('2026-03-15', 'unsuccessfully house hunting');
{
  const n = await getNote('2026-03-15');
  eq('saved note reads back', n && n.text, 'unsuccessfully house hunting');
  check('saved note gets an updatedAt', !!(n && Date.parse(n.updatedAt)));
}
await saveNote('2026-03-15', '   ');
eq('clearing a note deletes the day', await getNote('2026-03-15'), undefined);

await wipe();
await saveNote('2026-03-03', 'c');
await saveNote('2026-03-01', 'a');
await saveNote('2026-03-02', 'b');
eq('getNotesSorted is chronological', (await getNotesSorted()).map(n => n.date).join(','), '2026-03-01,2026-03-02,2026-03-03');

{
  const over = 'y'.repeat(NOTE_MAX + 100);
  await saveNote('2026-03-04', over);
  const n = await getNote('2026-03-04');
  eq('saveNote caps at NOTE_MAX', n.text.length, NOTE_MAX);
}

// ---------- merge ----------
await wipe();
{
  const st = await mergeNotes([{ date: '2026-04-01', text: 'from the phone' }]);
  eq('merge adds a note that is not here', st.added, 1);
  eq('merge stored the text', (await getNote('2026-04-01')).text, 'from the phone');
}
{
  const st = await mergeNotes([{ date: '2026-04-01', text: 'from the phone' }]);
  eq('merge skips an identical note', st.skipped, 1);
  eq('merge did not duplicate', (await getNote('2026-04-01')).text, 'from the phone');
}
await wipe();
{
  // Cloud is an extension of local: cloud wins, nothing is lost.
  await saveNote('2026-04-02', 'started the day rough');
  const st = await mergeNotes([{ date: '2026-04-02', text: 'started the day rough, better by lunch' }]);
  eq('merge takes the longer superset', st.updated, 1);
  eq('merge kept the extended text', (await getNote('2026-04-02')).text, 'started the day rough, better by lunch');
}
await wipe();
{
  // Local is an extension of cloud: local is kept, cloud is not written.
  await saveNote('2026-04-03', 'long day at work and then the school run');
  const st = await mergeNotes([{ date: '2026-04-03', text: 'long day at work' }]);
  eq('merge keeps the local superset', st.skipped, 1);
  eq('merge did not shorten the local note', (await getNote('2026-04-03')).text, 'long day at work and then the school run');
}
await wipe();
{
  // Genuinely divergent text — the case that must never destroy either side.
  await saveNote('2026-04-04', 'local words');
  const local = await getNote('2026-04-04');
  const newer = new Date(Date.parse(local.updatedAt) + 60000).toISOString();
  const st = await mergeNotes([{ date: '2026-04-04', text: 'cloud words', updatedAt: newer }]);
  eq('divergent text is combined', st.combined, 1);
  const merged = (await getNote('2026-04-04')).text;
  check('combined keeps the local text', merged.includes('local words'), merged);
  check('combined keeps the cloud text', merged.includes('cloud words'), merged);
  check('newer side is first', merged.indexOf('cloud words') < merged.indexOf('local words'), merged);
}
await wipe();
{
  // Same, with the local side newer — local should lead.
  await saveNote('2026-04-05', 'local newer');
  const older = new Date(Date.now() - 3600_000).toISOString();
  await mergeNotes([{ date: '2026-04-05', text: 'cloud older', updatedAt: older }]);
  const merged = (await getNote('2026-04-05')).text;
  check('older side is second', merged.indexOf('local newer') < merged.indexOf('cloud older'), merged);
}
await wipe();
{
  // A repeated pull must converge, not grow the note every time.
  await saveNote('2026-04-06', 'aaa');
  const cloud = [{ date: '2026-04-06', text: 'bbb', updatedAt: new Date().toISOString() }];
  await mergeNotes(cloud);
  const first = (await getNote('2026-04-06')).text;
  await mergeNotes(cloud);
  await mergeNotes(cloud);
  const third = (await getNote('2026-04-06')).text;
  eq('repeated merges converge', third, first);
}
{
  const st = await mergeNotes([null, 'nope', { date: 'junk', text: 'x' }, { date: '2026-04-07' }]);
  eq('merge skips junk rows', st.skipped, 4);
  eq('merge added nothing from junk', st.added, 0);
}
{
  const st = await mergeNotes(undefined);
  eq('merge tolerates a missing notes array', st.added, 0);
}
{
  // The combined note must still respect the length cap.
  await wipe();
  await saveNote('2026-04-08', 'L'.repeat(NOTE_MAX - 10));
  await mergeNotes([{ date: '2026-04-08', text: 'C'.repeat(NOTE_MAX - 10), updatedAt: new Date().toISOString() }]);
  check('combined note stays within the cap', (await getNote('2026-04-08')).text.length <= NOTE_MAX);
}

// ---------- read cache coherence ----------
// The daily stores are cached per-read and invalidated by withStore's readwrite
// mode. A stale cache would show the user yesterday's data after they typed —
// silent and very hard to spot — so every write path is checked here.
await wipe();
{
  await saveNote('2026-06-01', 'first');
  eq('cache: write is visible immediately',
     (await getNotesSorted()).map(n => n.text).join(','), 'first');

  await saveNote('2026-06-01', 'edited');
  // Indexed defensively: a stale cache returns [], and this suite should report
  // that as a failed assertion rather than dying on a TypeError.
  eq('cache: edit invalidates', ((await getNotesSorted())[0] || {}).text, 'edited');

  await saveNote('2026-06-02', 'second');
  eq('cache: added day appears', (await getNotesSorted()).length, 2);

  await deleteNote('2026-06-01');
  eq('cache: delete invalidates', (await getNotesSorted()).map(n => n.date).join(','), '2026-06-02');

  // mergeNotes writes through dbPut, which must also clear the cache.
  await mergeNotes([{ date: '2026-06-03', text: 'from cloud' }]);
  eq('cache: merge invalidates', (await getNotesSorted()).length, 2);

  // Clearing a note to empty deletes it; the cache must not keep showing it.
  await saveNote('2026-06-02', '');
  eq('cache: cleared note disappears', (await getNotesSorted()).map(n => n.date).join(','), '2026-06-03');
}
await wipe();
eq('cache: wipe leaves nothing behind', (await getNotesSorted()).length, 0);

// ---------- rendering safety ----------
{
  const nasty = '5"><img src=x onerror=alert(1)>';
  const esc = escapeHTML(nasty);
  check('escapeHTML neutralises the quote', !esc.includes('"'), esc);
  check('escapeHTML neutralises the bracket', !esc.includes('<'), esc);
  const attr = `title="${escapeHTML(`2026-04-09: Low — ${noteSnippet(nasty)}`)}"`;
  eq('escaped note cannot break out of a title attribute', (attr.match(/"/g) || []).length, 2);
}
{
  const long = 'word '.repeat(60);
  const s = noteSnippet(long, 80);
  check('noteSnippet truncates', s.length <= 80, `len ${s.length}`);
  check('noteSnippet marks truncation', s.endsWith('…'), s);
  eq('noteSnippet leaves a short note alone', noteSnippet('short one', 80), 'short one');
  eq('noteSnippet collapses newlines', noteSnippet('a\n\nb', 80), 'a b');
}

// ---------- date labelling ----------
{
  const today = todayISODate();
  eq('today reads as Today', formatNoteDate(today), 'Today');
  eq('yesterday reads as Yesterday', formatNoteDate(shiftISODate(today, -1)), 'Yesterday');
  const older = formatNoteDate('2026-03-15');
  check('an older date renders the right day', older.includes('15'), older);
  check('an older date renders the right year', older.includes('2026'), older);
  eq('a junk date does not crash', formatNoteDate('nonsense'), 'nonsense');
}

// ---------- payload ----------
await wipe();
await saveNote('2026-05-01', 'payload note');
{
  const p = await buildPayload({});
  eq('payload version is 9', p.version, 9);
  check('payload carries notes', Array.isArray(p.notes) && p.notes.some(n => n.text === 'payload note'));
}
{
  const p = await buildPayload({ sections: ['shots'] });
  eq('notes are excluded when not selected', (p.notes || []).length, 0);
}

// ---------- report ----------
{
  // Notes must be off unless explicitly ticked — a share dialog default must
  // never put someone's private note in front of their prescriber.
  const html = fs.readFileSync(path.join(HERE, '..', 'web', 'app', 'index.html'), 'utf8');
  const shareLine = html.split('\n').find(l => l.includes('data-section="notes"')) || '';
  check('share dialog offers notes', !!shareLine, 'no data-section="notes" checkbox found');
  check('share notes checkbox is unchecked by default', shareLine && !/data-section="notes"[^>]*checked/.test(shareLine), shareLine.trim());
  const pdfLine = html.split('\n').find(l => l.includes('data-pdf-section="notes"')) || '';
  check('pdf dialog offers notes', !!pdfLine, 'no data-pdf-section="notes" checkbox found');
  check('pdf notes checkbox is unchecked by default', pdfLine && !/data-pdf-section="notes"[^>]*checked/.test(pdfLine), pdfLine.trim());
}

await wipe();

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('All notes assertions passed.');
