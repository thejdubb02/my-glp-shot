#!/usr/bin/env node
// Daily-delete self-test: tombstones for notes, mood, appetite, food noise and
// symptom days (GitHub issue #15).
//
// Deleting one of these used to drop the row with no tombstone, so the next pull
// of a stale cloud copy brought it straight back. Now a delete (or an un-ticked
// symptom) leaves a tombstone that syncs both ways, and a later re-entry still wins.
//
//   run via: bash scripts/run-tests.sh
import { loadApp, Assert } from './lib/app-harness.mjs';

const A = new Assert('daily-delete');
const { R } = await loadApp({ domMode: 'stub' });
const pull = (p) => R('applyPulledPayload')({ version: 11, ...p });
const tick = () => new Promise(r => setTimeout(r, 5));
const OLD = new Date(Date.now() - 3600e3).toISOString();
const D = '2026-11-07';

// ---------- 1. a local delete survives a pull of the stale cloud copy ----------
await R(`saveNote('${D}', 'delete me')`);
await R(`saveMood('${D}', 4)`);
await R(`saveAppetite('${D}', 2)`);
await R(`saveFoodNoise('${D}', 3)`);
await R(`deleteNote('${D}')`);
await R(`deleteMood('${D}')`);
await R(`deleteAppetite('${D}')`);
await R(`deleteFoodNoise('${D}')`);
await pull({
  notes: [{ date: D, text: 'delete me', updatedAt: OLD }],
  moods: [{ date: D, value: 4, updatedAt: OLD }],
  appetites: [{ date: D, value: 2, updatedAt: OLD }],
  foodNoise: [{ date: D, value: 3, updatedAt: OLD }],
});
A.check('deleted note stays deleted', !(await R(`getNote('${D}')`)));
A.check('deleted mood stays deleted', !(await R(`dbGet('moods', '${D}')`)));
A.check('deleted appetite stays deleted', !(await R(`dbGet('appetites', '${D}')`)));
A.check('deleted food noise stays deleted', !(await R(`dbGet('foodNoise', '${D}')`)));

const keys = (await R('buildPayload')()).tombstones.map(t => t.key);
A.check('deletes ride in the payload', ['notes', 'moods', 'appetites', 'foodNoise'].every(s => keys.includes(`day|${s}|${D}`)));

// ---------- 2. an un-ticked symptom stays un-ticked ----------
await R(`saveSymptomDay('${D}', { nausea: 'mild', headache: 'mild' })`);
await tick();
await R(`saveSymptomDay('${D}', { headache: 'mild' })`);
await pull({ symptoms: [{ date: D, se: { nausea: 'mild', headache: 'mild' }, updatedAt: OLD }] });
A.eq('un-ticked symptom not merged back', JSON.stringify((await R(`getSymptomDay('${D}')`)).se), '{"headache":"mild"}');

// ---------- 3. a delete on another device removes the row here ----------
const E = '2026-11-01';
await R(`dbPut('moods', { date: '${E}', value: 5, updatedAt: '${OLD}' })`);
await R(`dbPut('notes', { date: '${E}', text: 'old', updatedAt: '${OLD}' })`);
await R(`dbPut('symptoms', { date: '${E}', se: { nausea: 'mild', fatigue: 'mild' }, updatedAt: '${OLD}' })`);
const now = Date.now();
await pull({ tombstones: [
  { key: `day|moods|${E}`, store: 'moods', deletedAt: now },
  { key: `day|notes|${E}`, store: 'notes', deletedAt: now },
  { key: `day|symptoms|${E}|nausea`, store: 'symptoms', deletedAt: now },
] });
A.check('remote mood delete applied', !(await R(`dbGet('moods', '${E}')`)));
A.check('remote note delete applied', !(await R(`getNote('${E}')`)));
A.eq('remote symptom delete applied', JSON.stringify((await R(`getSymptomDay('${E}')`)).se), '{"fatigue":"mild"}');

// ---------- 4. a re-entry after the delete wins over the tombstone ----------
await tick();
await R(`saveNote('${D}', 'written again')`);
await pull({ tombstones: [{ key: `day|notes|${D}`, store: 'notes', deletedAt: now - 1000 }] });
A.eq('local re-entry survives the tombstone', (await R(`getNote('${D}')`))?.text, 'written again');
await pull({ appetites: [{ date: D, value: 5, updatedAt: new Date(Date.now() + 1000).toISOString() }] });
A.eq('newer remote re-entry wins', (await R(`dbGet('appetites', '${D}')`))?.value, 5);
await R(`saveSymptomDay('${D}', { headache: 'mild', nausea: 'severe' })`);
await pull({});
A.eq('re-ticked symptom survives', (await R(`getSymptomDay('${D}')`)).se.nausea, 'severe');

// ---------- 5. a symptom delete arriving after a stale merge still applies ----------
const F = '2026-10-20', OLD_MS = Date.parse(OLD);
await R(`dbPut('symptoms', { date: '${F}', se: { nausea: 'mild' }, updatedAt: '${OLD}' })`);
await pull({ symptoms: [{ date: F, se: { nausea: 'mild', fatigue: 'mild' }, updatedAt: OLD }] });
await pull({ tombstones: [{ key: `day|symptoms|${F}|nausea`, store: 'symptoms', deletedAt: OLD_MS + 1000 }] });
A.eq('delayed symptom tombstone applies after a merge', JSON.stringify((await R(`getSymptomDay('${F}')`)).se), '{"fatigue":"mild"}');

// ---------- 6. editing another symptom does not revive a deleted one ----------
// Device B never saw the delete of nausea, then changed headache after it.
await R(`saveSymptomDay('${F}', { fatigue: 'mild', headache: 'mild' })`);
await R(`saveSymptomDay('${F}', { headache: 'mild' })`);
const later = Date.now() + 1000;
await pull({ symptoms: [{ date: F, se: { fatigue: 'mild', headache: 'severe' }, seAt: { fatigue: OLD_MS, headache: later }, updatedAt: new Date(later).toISOString() }] });
A.eq('unrelated symptom edit keeps the delete', JSON.stringify((await R(`getSymptomDay('${F}')`)).se), '{"headache":"severe"}');

// ---------- 7. payload version: v12 out, v11 still read, newer refused ----------
A.eq('payload is v12', (await R('buildPayload')()).version, 12);
let refused = false;
try { await R('applyPulledPayload')({ version: 13 }); } catch (_) { refused = true; }
A.check('a newer payload is refused', refused);

A.report();
