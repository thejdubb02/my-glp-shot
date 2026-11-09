#!/usr/bin/env node
// Daily last-write-wins self-test: a pull must not overwrite a newer local mood,
// appetite or food-noise reading with an older cloud one (GitHub issue #19).
//
//   run via: bash scripts/run-tests.sh
import { loadApp, Assert } from './lib/app-harness.mjs';

const A = new Assert('daily-lww');
const { R } = await loadApp({ domMode: 'stub' });
const pull = (p) => R('applyPulledPayload')({ version: 12, ...p });
const OLD = new Date(Date.now() - 3600e3).toISOString();
const NEW = new Date(Date.now() + 3600e3).toISOString();
const D = '2026-11-09';
const val = async (s) => (await R(`dbGet('${s}', '${D}')`))?.value;

// 1. newer local reading survives an older pulled one
await R(`saveMood('${D}', 5)`);
await R(`saveAppetite('${D}', 4)`);
await R(`saveFoodNoise('${D}', 3)`);
await pull({
  moods: [{ date: D, value: 1, updatedAt: OLD }],
  appetites: [{ date: D, value: 1, updatedAt: OLD }],
  foodNoise: [{ date: D, value: 1, updatedAt: OLD }],
});
A.eq('newer local mood kept', await val('moods'), 5);
A.eq('newer local appetite kept', await val('appetites'), 4);
A.eq('newer local food noise kept', await val('foodNoise'), 3);

// 2. a pulled row with no stamp (old data) loses to a stamped local row
await pull({ moods: [{ date: D, value: 2 }], appetites: [{ date: D, value: 2 }], foodNoise: [{ date: D, value: 2 }] });
A.eq('unstamped pulled mood loses', await val('moods'), 5);
A.eq('unstamped pulled appetite loses', await val('appetites'), 4);
A.eq('unstamped pulled food noise loses', await val('foodNoise'), 3);

// 3. a newer pulled reading still wins
await pull({
  moods: [{ date: D, value: 2, updatedAt: NEW }],
  appetites: [{ date: D, value: 2, updatedAt: NEW }],
  foodNoise: [{ date: D, value: 2, updatedAt: NEW }],
});
A.eq('newer pulled mood wins', await val('moods'), 2);
A.eq('newer pulled appetite wins', await val('appetites'), 2);
A.eq('newer pulled food noise wins', await val('foodNoise'), 2);

// 4. a day with no local row takes the pulled one, stamped or not
const E = '2026-11-02';
await pull({ moods: [{ date: E, value: 3 }] });
A.eq('pulled mood fills an empty day', (await R(`dbGet('moods', '${E}')`))?.value, 3);

A.report();
