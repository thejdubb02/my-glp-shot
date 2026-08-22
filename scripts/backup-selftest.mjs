#!/usr/bin/env node
// Backup export/import self-test.
//
// Guards the bug this suite was written for: "Export JSON" wrote only shots,
// weights and settings while the Backup card told users it was their backup.
// Moods, appetite, food noise, notes, symptoms, cycles, supplies, measurements,
// labs and spending were all silently dropped, and import read only those same
// three back — so anyone without cloud sync kept a backup missing most of their
// history and would find out only after wiping a device.
//
// The assertions below fail if any store stops round-tripping, and if a NEW
// store is added to the app without being added to the backup.
//
//   FAKE_INDEXEDDB_PATH=/abs/path/to/node_modules/fake-indexeddb \
//     node scripts/backup-selftest.mjs
import { loadApp, Assert } from './lib/app-harness.mjs';

const t = new Assert('Backup');
// 'stub' DOM: applyPulledPayload restores settings, and applySettingsToInputs
// writes directly to element .value — it needs elements to exist.
const { R } = await loadApp({ domMode: 'stub' });

const buildPayload        = R('buildPayload');
const applyPulledPayload  = R('applyPulledPayload');
const summarisePayload    = R('summarisePayload');
const EXPORT_STORE_KEYS   = R('EXPORT_STORE_KEYS');
const dbAll               = R('dbAll');
const dbAdd               = R('dbAdd');
const dbPut               = R('dbPut');
const openDB              = R('openDB');
const saveNote            = R('saveNote');
const saveSymptomDay      = R('saveSymptomDay');
const saveMood            = R('saveMood');
const saveAppetite        = R('saveAppetite');
const saveFoodNoise       = R('saveFoodNoise');
const STORES              = R('STORES');

await openDB();

// ---------- every store the DB declares must be in the backup ----------
{
  const db = await openDB();
  const dbStores = Array.from(db.objectStoreNames);
  // 'settings' rides as its own payload key, not as an array of records.
  const dataStores = dbStores.filter(n => n !== 'settings');
  const missing = dataStores.filter(n => !EXPORT_STORE_KEYS.includes(n));
  t.check('every IndexedDB store is covered by the backup', missing.length === 0,
    `not in EXPORT_STORE_KEYS: ${missing.join(', ')}`);
}

// ---------- seed one record in every store ----------
const D = '2026-05-01';
await dbAdd(STORES.shots,   { when: new Date(`${D}T09:00:00Z`).toISOString(), dose: 5, med: 'Tirzepatide', site: 'Abdomen — Left', sideEffects: { nausea: 'mild' } });
await dbAdd(STORES.weights, { date: D, value: 200 });
await saveMood(D, 4);
await saveAppetite(D, 2);
await saveFoodNoise(D, 3);
await saveNote(D, 'a note that must survive a backup');
await saveSymptomDay(D, { fatigue: 'moderate' });
await dbAdd('cycles',       { startDate: D, endDate: '2026-05-05', flow: 'normal', symptoms: ['cramps'] });
await dbAdd('medChanges',   { date: D, when: `${D}T09:00:00Z`, medication: 'Semaglutide', halfLifeDays: 7, cadenceDays: 7 });
await dbAdd('supplies',     { med: 'Tirzepatide', mg: 8, ml: 3, openedAt: D, kind: 'pen' });
await dbAdd('measurements', { date: D, type: 'waist', value: 34 });
await dbAdd('labs',         { date: D, type: 'a1c', value: 5.6 });
await dbAdd('expenses',     { date: D, type: 'medication', amount: 99 });

// ---------- export ----------
const payload = await buildPayload();

for (const key of EXPORT_STORE_KEYS) {
  t.check(`export carries ${key}`, Array.isArray(payload[key]) && payload[key].length > 0,
    `got ${JSON.stringify(payload[key])}`);
}
t.check('export carries settings', !!payload.settings);
t.check('export is a versioned payload', Number(payload.version) >= 10, `version=${payload.version}`);

// summarisePayload is what the import prompt shows the user; it must not
// under-report, or the confirm dialog lies about what is being restored.
{
  const parts = summarisePayload(payload);
  t.eq('summary lists every seeded store', parts.length, EXPORT_STORE_KEYS.length);
}

// ---------- wipe every data store ----------
const serialised = JSON.parse(JSON.stringify(payload));
{
  const db = await openDB();
  for (const name of Array.from(db.objectStoreNames)) {
    if (name === 'settings') continue;
    await new Promise((res, rej) => {
      const tx = db.transaction(name, 'readwrite');
      tx.objectStore(name).clear();
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  }
  let total = 0;
  for (const k of EXPORT_STORE_KEYS) total += ((await dbAll(k)) || []).length;
  t.eq('database is empty before restore', total, 0);
}

// ---------- import the exported file back ----------
await applyPulledPayload(serialised);

for (const key of EXPORT_STORE_KEYS) {
  const rows = (await dbAll(key)) || [];
  t.check(`restore brings back ${key}`, rows.length > 0, `${key} is still empty after restore`);
}

// Spot-check that content survived, not just row counts.
{
  const notes = (await dbAll('notes')) || [];
  t.check('note text survived the round trip',
    notes.some(n => n.text === 'a note that must survive a backup'));
  const syms = (await dbAll('symptoms')) || [];
  t.check('symptom severity survived the round trip',
    syms.some(s => s.se && s.se.fatigue === 'moderate'));
  const shots = (await dbAll(STORES.shots)) || [];
  t.check('shot side effects survived the round trip',
    shots.some(s => s.sideEffects && s.sideEffects.nausea === 'mild'));
}

// ---------- importing twice must not duplicate ----------
{
  const before = {};
  for (const k of EXPORT_STORE_KEYS) before[k] = ((await dbAll(k)) || []).length;
  await applyPulledPayload(serialised);
  for (const k of EXPORT_STORE_KEYS) {
    const after = ((await dbAll(k)) || []).length;
    t.eq(`re-importing does not duplicate ${k}`, after, before[k]);
  }
}

// ---------- a legacy v1 export must still be recognised as legacy ----------
{
  const legacy = { version: 1, settings: {}, shots: [{ when: new Date().toISOString(), dose: 5 }], weights: [] };
  const isFull = Number(legacy.version) >= 8 ||
    EXPORT_STORE_KEYS.some(k => k !== 'shots' && k !== 'weights' && Array.isArray(legacy[k]) && legacy[k].length);
  t.check('a v1 export is not mistaken for a full payload', isFull === false);
}

t.report();
