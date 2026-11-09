#!/usr/bin/env node
// Legacy-delete self-test: deleting a row that arrived without a uid (GitHub issue #21).
//
// A pulled row with no uid gets a ck- uid derived from its content, and deleting
// it tombstones that ck- uid. The original device, or an old backup file, still
// has the row with no uid, so its next push or restore must not bring it back,
// and the original device must drop its own uid-less copy.
//
//   run via: bash scripts/run-tests.sh
import { loadApp, Assert } from './lib/app-harness.mjs';

const A = new Assert('legacy-delete');
const { R } = await loadApp({ domMode: 'stub' });
const OLD = Date.now() - 3600e3;
const ROWS = {
  shots: { when: '2025-01-01T09:00:00.000Z', dose: 2.5, med: 'Tirzepatide', updatedAt: OLD },
  weights: { date: '2025-01-01', value: 80, updatedAt: OLD },
  supplies: { type: 'Tirzepatide', opened_at: '2025-01-01', total_mg: 10, updatedAt: OLD },
  measurements: { date: '2025-01-01', type: 'waist', value: 80, updatedAt: OLD },
  labs: { date: '2025-01-01', type: 'a1c', value: 5.5, updatedAt: OLD },
  expenses: { date: '2025-01-01', category: 'pharmacy', amount: 10, updatedAt: OLD },
  cycles: { startDate: '2025-01-01', updatedAt: OLD },
  medChanges: { when: '2025-01-01', medication: 'Tirzepatide', updatedAt: OLD },
};
const merge = (store, rows) => R(`(async () => mergeStore('${store}', ${JSON.stringify(rows)}, CONTENT_KEYS.${store}, await mergeTombstones([])))()`);
const all = (store) => R(`dbAll('${store}')`);

for (const [store, row] of Object.entries(ROWS)) {
  // ---------- device B: pull the uid-less row, delete it, pull it again ----------
  await merge(store, [row]);
  const [got] = await all(store);
  await R(`dbDelSynced('${store}', ${got.id})`);
  const again = await merge(store, [row]);
  A.eq(`${store}: deleted legacy row not re-added by a pull`, again.added, 0);
  A.eq(`${store}: store still empty`, (await all(store)).length, 0);

  // ---------- old backup file restored through the pull path ----------
  await R('applyPulledPayload')({ version: 12, [store]: [row] });
  A.eq(`${store}: old backup does not bring it back`, (await all(store)).length, 0);

  // ---------- device A: still holds the uid-less copy, receives B's tombstone ----------
  const tombs = (await R('buildPayload')()).tombstones.filter(t => t.store === store);
  await R(`withStore('tombstones', 'readwrite', (s) => s.clear())`);
  await R(`dbAddExact('${store}', ${JSON.stringify(row)})`);
  const res = await R(`(async () => mergeStore('${store}', [], CONTENT_KEYS.${store}, await mergeTombstones(${JSON.stringify(tombs)})))()`);
  A.eq(`${store}: device A drops its uid-less copy`, res.removed, 1);
  A.eq(`${store}: device A store empty`, (await all(store)).length, 0);
  await R(`withStore('tombstones', 'readwrite', (s) => s.clear())`);
}

// ---------- a re-entry after the delete still wins ----------
await merge('weights', [ROWS.weights]);
const [w] = await all('weights');
await R(`dbDelSynced('weights', ${w.id})`);
const fresh = await merge('weights', [{ ...ROWS.weights, updatedAt: Date.now() + 1000 }]);
A.eq('newer uid-less re-entry is kept', fresh.added, 1);

A.report();
