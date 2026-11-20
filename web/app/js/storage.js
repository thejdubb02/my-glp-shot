// My GLP Shot: IndexedDB helpers, settings load/save, base64, payload compression, date helpers.
'use strict';

// ---------- IndexedDB helpers ----------
let _dbPromise = null;
function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    // An open that needs to upgrade is blocked until every other tab holding
    // the old version closes its connection. Without this handler the promise
    // never settles, every `await openDB()` hangs, and the app just sits there
    // — no error, no spinner, nothing to report. Tell the user what to do.
    req.onblocked = () => {
      console.warn('[mgs] database upgrade blocked by another open tab');
      toast('My GLP Shot is open in another tab. Close it so the update can finish.');
    };
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORES.shots)) {
        const s = db.createObjectStore(STORES.shots, { keyPath: 'id', autoIncrement: true });
        s.createIndex('when', 'when');
      }
      if (!db.objectStoreNames.contains(STORES.weights)) {
        const s = db.createObjectStore(STORES.weights, { keyPath: 'id', autoIncrement: true });
        s.createIndex('date', 'date');
      }
      if (!db.objectStoreNames.contains(STORES.settings)) {
        db.createObjectStore(STORES.settings, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORES.moods)) {
        db.createObjectStore(STORES.moods, { keyPath: 'date' });
      }
      if (!db.objectStoreNames.contains(STORES.supplies)) {
        db.createObjectStore(STORES.supplies, { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('measurements')) {
        db.createObjectStore('measurements', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('labs')) {
        db.createObjectStore('labs', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('expenses')) {
        db.createObjectStore('expenses', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('appetites')) {
        db.createObjectStore('appetites', { keyPath: 'date' });
      }
      if (!db.objectStoreNames.contains('foodNoise')) {
        db.createObjectStore('foodNoise', { keyPath: 'date' });
      }
      if (!db.objectStoreNames.contains('cycles')) {
        db.createObjectStore('cycles', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('medChanges')) {
        db.createObjectStore('medChanges', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('notes')) {
        db.createObjectStore('notes', { keyPath: 'date' });
      }
      if (!db.objectStoreNames.contains('symptoms')) {
        db.createObjectStore('symptoms', { keyPath: 'date' });
      }
      if (!db.objectStoreNames.contains('tombstones')) {
        db.createObjectStore('tombstones', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // The mirror of onblocked: if another tab loads a newer version, hold the
      // connection open and we become the thing blocking it. Close and stand
      // aside, then force the next openDB() to reconnect.
      db.onversionchange = () => {
        console.warn('[mgs] newer version opened elsewhere — closing this connection');
        try { db.close(); } catch (_) {}
        _dbPromise = null;
        toast('My GLP Shot updated in another tab. Reload this one to continue.');
      };
      // A connection closed underneath us (browser eviction, "clear site data")
      // must not leave a dead handle cached for the rest of the session.
      db.onclose = () => { _dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { _dbPromise = null; reject(req.error); };
  });
  return _dbPromise;
}
// The date-keyed daily stores get read several times per refresh — once per
// trend strip, again for the card, again for the notes journal. Measured over
// two years of history that was 8 full store scans and ~5,800 rows for a single
// refreshDailyCards(), with `notes` alone scanned four times.
//
// They are small, and they only change on an explicit write, so one read per
// refresh is enough. Invalidation hangs off withStore's readwrite mode rather
// than off each save/delete helper: that is the single choke point every write
// passes through, including the direct dbPut calls in applyPulledPayload, so a
// new write path cannot forget to clear it.
const DAILY_CACHED = new Set(['moods', 'appetites', 'foodNoise', 'notes', 'symptoms']);
const _dailyCache = new Map();

async function readDailySorted(store) {
  const hit = _dailyCache.get(store);
  if (hit) return hit;
  const rows = ((await dbAll(store)) || [])
    .filter(r => r && r.date)
    .sort((a, b) => a.date.localeCompare(b.date));
  _dailyCache.set(store, rows);
  return rows;
}

async function withStore(store, mode, fn) {
  if (mode === 'readwrite' && DAILY_CACHED.has(store)) _dailyCache.delete(store);
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    const req = fn(s);
    if (req && 'onsuccess' in req) {
      req.onsuccess = () => { result = req.result; };
      req.onerror = () => reject(req.error);
    }
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
// Auto-increment ids are device-local, so they can't identify a record across
// devices. Every new row in these stores gets a stable `uid` at the single point
// where rows are written — that is what lets a cloud pull merge rather than
// clobber. (newUid is a hoisted function declaration defined with the sync code.)
const UID_STORES = new Set(['shots', 'weights', 'supplies', 'measurements', 'labs', 'expenses', 'cycles', 'medChanges']);
const withUid = (store, val) =>
  (UID_STORES.has(store) && val && typeof val === 'object' && !val.uid)
    ? { ...val, uid: newUid() }
    : val;
// updatedAt (ms) is what lets an edit on one device win over the older copy on
// another; see mergeStore. Local writes stamp it. Merges write the incoming row
// exactly as received (dbAddExact/dbPutExact), because restamping a received row
// with this device's clock would make a stale copy look newer than a real edit.
const syncedRow = (store, val) => UID_STORES.has(store) && val && typeof val === 'object';
const dbAdd = (store, val) => withStore(store, 'readwrite', s => s.add(withUid(store,
  syncedRow(store, val) && !val.updatedAt ? { ...val, updatedAt: Date.now() } : val)));
async function dbPut(store, val) {
  if (syncedRow(store, val)) {
    val = { ...val, updatedAt: Date.now() };
    // Edit forms rebuild the record from their fields, so it arrives with its id
    // but without the uid the row already had. Minting a fresh uid made every
    // edited entry look brand new to other devices, which then kept both copies.
    if (!val.uid && val.id != null) {
      const prev = await withStore(store, 'readonly', s => s.get(val.id));
      if (prev && prev.uid) val.uid = prev.uid;
    }
  }
  return withStore(store, 'readwrite', s => s.put(withUid(store, val)));
}
const dbAddExact = (store, val) => withStore(store, 'readwrite', s => s.add(val));
const dbPutExact = (store, val) => withStore(store, 'readwrite', s => s.put(val));
const dbDel = (store, id) => withStore(store, 'readwrite', s => s.delete(id));
const dbAll = (store) => withStore(store, 'readonly', s => s.getAll());
const dbGet = (store, key) => withStore(store, 'readonly', s => s.get(key));

// ---------- Settings ----------
let settings = { ...DEFAULT_SETTINGS };
async function loadSettings() {
  const row = await dbGet(STORES.settings, SETTINGS_KEY);
  if (row && row.value) settings = { ...DEFAULT_SETTINGS, ...row.value };
}
async function saveSettings() {
  await dbPut(STORES.settings, { key: SETTINGS_KEY, value: settings });
}

// ---------- Binary <-> base64 ----------
// `btoa(String.fromCharCode(...bytes))` spreads every byte as a function argument,
// which blows the JS call stack at ~124 KB. That silently killed cloud sync and
// doctor share links for anyone with real history — the push threw, the caller
// swallowed it, and the user was told nothing. Chunk it so size is never a cliff.
const B64_CHUNK = 0x8000; // 32 KB per call, far below any engine's argument limit
function bytesToBase64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i += B64_CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + B64_CHUNK));
  }
  return btoa(binary);
}
function base64ToBytes(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------- Payload compression ----------
// Tracker JSON is highly repetitive and compresses ~8-10x. Compressing before
// encryption keeps heavy accounts under the server's blob cap and cuts sync
// bandwidth on mobile. Blobs written before this change are plain JSON, so the
// reader sniffs for the magic header and falls back.
const GZIP_MAGIC = 'MGSZ1:';
const GZIP_SUPPORTED = typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

async function encodePayloadBytes(payload) {
  const json = JSON.stringify(payload);
  const raw = new TextEncoder().encode(json);
  if (!GZIP_SUPPORTED) return raw;
  try {
    const cs = new CompressionStream('gzip');
    const stream = new Blob([raw]).stream().pipeThrough(cs);
    const gz = new Uint8Array(await new Response(stream).arrayBuffer());
    const magic = new TextEncoder().encode(GZIP_MAGIC);
    const out = new Uint8Array(magic.length + gz.length);
    out.set(magic, 0);
    out.set(gz, magic.length);
    // Only worth it if it actually shrank (tiny payloads can grow).
    return out.length < raw.length ? out : raw;
  } catch (e) {
    console.warn('[mgs] compression unavailable, sending uncompressed:', e);
    return raw;
  }
}

async function decodePayloadBytes(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const head = new TextDecoder().decode(view.subarray(0, GZIP_MAGIC.length));
  if (head !== GZIP_MAGIC) return JSON.parse(new TextDecoder().decode(view));
  const body = view.subarray(GZIP_MAGIC.length);
  const ds = new DecompressionStream('gzip');
  const stream = new Blob([body]).stream().pipeThrough(ds);
  const raw = await new Response(stream).arrayBuffer();
  return JSON.parse(new TextDecoder().decode(raw));
}

// ---------- Utilities ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const fmtDate = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const fmtDateShort = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
// ---------- Timezone-aware date helpers ----------
// Single source of truth: getUserTz(). All "today"/"now" math passes through
// these so the app honors settings.timezone everywhere — streaks, charts,
// input defaults, and reminder fire times.
function getUserTz() {
  try {
    if (typeof settings !== 'undefined' && settings && settings.timezone) return settings.timezone;
  } catch (_) {}
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (_) { return 'UTC'; }
}
// 'en-CA' yields YYYY-MM-DD / HH:MM in ISO-friendly order regardless of locale.
function _tzParts(d, tz) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const out = {};
  for (const p of fmt.formatToParts(d)) if (p.type !== 'literal') out[p.type] = p.value;
  // Intl can yield "24" for midnight in some engines — normalize.
  if (out.hour === '24') out.hour = '00';
  return out;
}
const localISOForInput = (d = new Date()) => {
  const p = _tzParts(d, getUserTz());
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
};
const todayISODate = () => {
  const p = _tzParts(new Date(), getUserTz());
  return `${p.year}-${p.month}-${p.day}`;
};
// Wall-clock time {YYYY-MM-DD, HH, MM} in a given IANA TZ → UTC Date.
// Iteratively converges: works across DST (spring-forward / fall-back) because
// we measure the offset by formatting the guess back in tz and correcting.
function zonedWallToUtc(tz, ymd, hh, mm) {
  const wantIso = `${ymd}T${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:00`;
  const want = Date.parse(wantIso + 'Z');
  let guess = new Date(want);
  for (let i = 0; i < 3; i++) {
    const p = _tzParts(guess, tz);
    const seen = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second || '00'}Z`);
    const drift = want - seen;
    if (drift === 0) return guess;
    guess = new Date(guess.getTime() + drift);
  }
  return guess;
}
// Next UTC instant when wall-clock in user TZ equals HH:MM. Returns Date in future.
function nextDailyTriggerAt(hhmm) {
  if (!hhmm || !/^\d{2}:\d{2}$/.test(hhmm)) return null;
  const [hh, mm] = hhmm.split(':').map(Number);
  const tz = getUserTz();
  const now = new Date();
  // Step by calendar day. Adding 24 hours instead skipped a day across the
  // 23-hour spring-forward day: late Saturday plus 24h is already Monday.
  const t0 = _tzParts(now, tz);
  for (let offset = 0; offset < 2; offset++) {
    const day = new Date(Date.UTC(+t0.year, +t0.month - 1, +t0.day + offset)).toISOString().slice(0, 10);
    const fire = zonedWallToUtc(tz, day, hh, mm);
    if (fire.getTime() - now.getTime() > 30000) return fire;
  }
  return null;
}
// Common TZ list for the picker. Prefer Intl.supportedValuesOf when available
// (modern browsers), else a curated list that covers the user base.
function listSupportedTimezones() {
  try {
    if (typeof Intl.supportedValuesOf === 'function') return Intl.supportedValuesOf('timeZone');
  } catch (_) {}
  return [
    'UTC',
    'America/New_York','America/Chicago','America/Denver','America/Phoenix','America/Los_Angeles',
    'America/Anchorage','Pacific/Honolulu','America/Toronto','America/Vancouver','America/Mexico_City',
    'America/Sao_Paulo','Europe/London','Europe/Dublin','Europe/Paris','Europe/Berlin','Europe/Madrid',
    'Europe/Rome','Europe/Amsterdam','Europe/Stockholm','Europe/Athens','Europe/Istanbul','Europe/Moscow',
    'Africa/Cairo','Africa/Johannesburg','Asia/Dubai','Asia/Karachi','Asia/Kolkata','Asia/Bangkok',
    'Asia/Singapore','Asia/Hong_Kong','Asia/Shanghai','Asia/Tokyo','Asia/Seoul',
    'Australia/Perth','Australia/Sydney','Pacific/Auckland',
  ];
}
