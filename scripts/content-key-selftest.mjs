#!/usr/bin/env node
// Content-key self-test: mergeStore in app.js (GitHub issue #16).
//
// A pull used to skip any incoming row whose content key was already present,
// even when it carried its own uid, and the shot key left out the med. Two
// different shots logged the same minute at the same dose collapsed into one,
// as did two same-day measurements, labs or expenses. Rows without a uid (old
// data, file imports) must still dedupe by content key.
//
//   run via: bash scripts/run-tests.sh
import { loadApp, Assert } from './lib/app-harness.mjs';

const A = new Assert('content-key');
const { R } = await loadApp({ domMode: 'stub' });
const merge = (store, rows) => R(`mergeStore('${store}', ${JSON.stringify(rows)}, CONTENT_KEYS.${store})`);
const count = async (store) => (await R(`dbAll('${store}')`)).length;
const clear = (store) => R(`withStore('${store}', 'readwrite', (s) => s.clear())`);

// ---------- 1. two meds, same minute, same dose ----------
const when = '2026-09-01T09:00:00.000Z';
let s = await merge('shots', [
  { uid: 'uidaaaa-1', when, dose: 2.5, med: 'Tirzepatide', updatedAt: 1 },
  { uid: 'uidbbbb-2', when, dose: 2.5, med: 'BPC-157', updatedAt: 1 },
]);
A.eq('both shots added', s.added, 2);
A.eq('both shots stored', await count('shots'), 2);
s = await merge('shots', [
  { uid: 'uidaaaa-1', when, dose: 2.5, med: 'Tirzepatide', updatedAt: 1 },
  { uid: 'uidbbbb-2', when, dose: 2.5, med: 'BPC-157', updatedAt: 1 },
]);
A.eq('pull again is idempotent', s.added, 0);
await clear('shots');

// ---------- 2. same content, distinct uids, every content-keyed store ----------
const pairs = {
  measurements: { date: '2026-09-01', type: 'waist', value: 80 },
  labs: { date: '2026-09-01', type: 'a1c', value: 5.5 },
  expenses: { date: '2026-09-01', category: 'pharmacy', amount: 10 },
  weights: { date: '2026-09-01', value: 80 },
};
for (const [store, row] of Object.entries(pairs)) {
  await clear(store);
  s = await merge(store, [{ ...row, uid: `uid${store}-1` }, { ...row, uid: `uid${store}-2` }]);
  A.eq(`${store}: distinct uids both kept`, await count(store), 2);
  await clear(store);
}

// ---------- 3. rows without a uid still dedupe by content key ----------
const legacy = { when, dose: 2.5, med: 'Tirzepatide' };
await merge('shots', [legacy]);
s = await merge('shots', [legacy]);
A.eq('legacy re-import adds nothing', s.added, 0);
s = await merge('shots', [{ ...legacy, uid: 'uidcccc-3', updatedAt: 1 }]);
A.eq('uid row matching a legacy-sourced row is skipped', s.added, 0);
A.eq('still one shot', await count('shots'), 1);
await clear('shots');

// local row with no uid, incoming copy with a uid: same entry
await R(`dbAddExact('shots', ${JSON.stringify(legacy)})`);
s = await merge('shots', [{ ...legacy, uid: 'uiddddd-4', updatedAt: 1 }]);
A.eq('local legacy row dedupes a uid copy', s.added, 0);
await clear('shots');

// ---------- 4. a legacy row gets the same uid on every device ----------
await merge('shots', [legacy]);
const uid1 = (await R(`dbAll('shots')`))[0].uid;
await clear('shots');
await merge('shots', [legacy]);
const uid2 = (await R(`dbAll('shots')`))[0].uid;
A.check('legacy uid is stable across devices', uid1 === uid2 && /^[A-Za-z0-9-]{8,64}$/.test(uid1));
await clear('shots');
await merge('shots', [{ ...legacy, uid: 'uideeee-5', updatedAt: 1 }]);
s = await merge('shots', [{ ...legacy, uid: uid1, updatedAt: 1 }]);
A.eq('a pushed legacy-derived uid still dedupes by content', s.added, 0);
await clear('shots');

// ---------- 5. tombstones written with the old shot key still bury ----------
const oldTomb = `new Map([['ck|shots|s|${when.slice(0, 16)}|2.5', { deletedAt: Date.now() }]])`;
const buried = (rows) => R(`mergeStore('shots', ${JSON.stringify(rows)}, CONTENT_KEYS.shots, ${oldTomb})`);
s = await buried([legacy]);
A.eq('old-format tombstone keeps a deleted legacy shot out', s.added, 0);
await R(`dbAddExact('shots', ${JSON.stringify(legacy)})`);
s = await buried([]);
A.eq('old-format tombstone removes a local legacy shot', s.removed, 1);
s = await buried([{ ...legacy, uid: uid1, updatedAt: 1 }]);
A.eq('old-format tombstone buries a ck- uid copy', s.added, 0);
s = await buried([{ ...legacy, uid: 'uidffff-6', updatedAt: 1 }]);
A.eq('a real uid row is not buried by a content tombstone', s.added, 1);

A.report();
