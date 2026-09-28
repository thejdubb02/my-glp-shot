#!/usr/bin/env node
// Sync-merge self-test.
//
// Everything that moves a user's log between devices (cloud pull, backup
// restore) goes through mergeStore. A 2026-09-28 review found it was quietly
// losing or duplicating data in four ways, none of which threw:
//   1. Four stores had content keys naming fields their records never had, so
//      every supply shared one key (likewise every cycle and med change). A
//      restore onto a new phone kept the first of each and dropped the rest.
//   2. Editing a shot minted a new uid, so the edit looked like a new entry to
//      other devices and both copies were kept.
//   3. The pull-side sanitizers stripped uid and updatedAt, so pulled shots and
//      weights arrived with no identity at all.
//   4. A known uid was always skipped, so an edit never reached the other device.
// Plus: a signed-in user opening the app offline was shown the sign-in screen.
//
//   run via: bash scripts/run-tests.sh
import { loadApp, Assert } from './lib/app-harness.mjs';

const A = new Assert('sync-merge');
// 'stub': applyPulledPayload re-renders the shot list when it finishes.
const { R } = await loadApp({ domMode: 'stub' });
const call = (expr) => R(expr);

const all = (store) => call(`dbAll(${JSON.stringify(store)})`);
const clear = async (store) => { await call(`ensureStore(${JSON.stringify(store)})`); await call(`withStore(${JSON.stringify(store)}, 'readwrite', s => s.clear())`); };
const merge = (store, rows) => call(`mergeStore(${JSON.stringify(store)}, ${JSON.stringify(rows)}, CONTENT_KEYS[${JSON.stringify(store)}])`);

// ---------- 1. distinct rows in every store survive a restore ----------
const distinct = {
  supplies: [
    { type: 'pen', total_mg: 10, opened_at: '2026-08-01', expires_at: '2026-09-01', uid: 'aaaaaaaa-1' },
    { type: 'pen', total_mg: 10, opened_at: '2026-08-29', expires_at: '2026-09-29', uid: 'aaaaaaaa-2' },
    { type: 'vial', total_mg: 30, opened_at: '2026-09-20', expires_at: '2026-10-20', uid: 'aaaaaaaa-3' },
  ],
  cycles: [
    { startDate: '2026-07-01', endDate: '2026-07-05' },
    { startDate: '2026-08-01', endDate: '2026-08-04' },
  ],
  medChanges: [
    { when: '2026-06-01T00:00:00.000Z', medication: 'Semaglutide' },
    { when: '2026-08-01T00:00:00.000Z', medication: 'Tirzepatide' },
  ],
  expenses: [
    { date: '2026-09-01', category: 'medication', amount: 499 },
    { date: '2026-09-01', category: 'supplies', amount: 499 },
  ],
};
for (const [store, rows] of Object.entries(distinct)) {
  await clear(store);
  const res = await merge(store, rows);
  const got = (await all(store)).length;
  A.eq(`${store}: every distinct row survives a restore into an empty device`, got, rows.length);
  A.eq(`${store}: merge reports them all added`, res.added, rows.length);
  const again = await merge(store, rows);
  A.eq(`${store}: restoring the same backup twice adds nothing`, again.added + again.updated, 0);
}

// ---------- 2. editing keeps the row's uid ----------
await clear('shots');
await call(`dbAdd('shots', { when: '2026-09-01T15:00:00.000Z', dose: 2.5, med: 'Tirzepatide' })`);
let [shot] = await all('shots');
A.check('a new shot gets a uid', typeof shot.uid === 'string' && shot.uid.length >= 8, shot.uid);
A.check('a new shot gets updatedAt', Number(shot.updatedAt) > 0, String(shot.updatedAt));
const uid0 = shot.uid;
// Exactly what the shot dialog does: rebuild from fields, attach the id, no uid.
await call(`dbPut('shots', { id: ${shot.id}, when: '2026-09-01T15:00:00.000Z', dose: 5, med: 'Tirzepatide' })`);
[shot] = await all('shots');
A.eq('editing a shot keeps its uid', shot.uid, uid0);
A.eq('the edit landed', shot.dose, 5);

for (const [fn, store, row] of [
  ['saveSupply', 'supplies', { type: 'pen', total_mg: 10 }],
  ['saveMeasurement', 'measurements', { type: 'waist', value: 34, unit: 'in', date: '2026-09-01' }],
  ['saveLab', 'labs', { type: 'a1c', value: 5.4, date: '2026-09-01' }],
  ['saveExpense', 'expenses', { amount: 10, category: 'other', date: '2026-09-02' }],
  ['saveCycle', 'cycles', { startDate: '2026-09-10' }],
  ['saveMedChange', 'medChanges', { when: '2026-09-11T00:00:00.000Z', medication: 'X' }],
]) {
  await clear(store);
  await call(`${fn}(${JSON.stringify(row)})`);
  const [saved] = await all(store);
  A.check(`${fn} gives the row a uid`, saved && typeof saved.uid === 'string', JSON.stringify(saved));
}

// ---------- 3. pulled shots and weights keep their identity ----------
const sShot = call(`sanitizeShot({ when: '2026-09-01T15:00:00.000Z', dose: 5, uid: 'bbbbbbbb-1', updatedAt: 1790000000000, halfLifeDays: 5 })`);
A.eq('sanitizeShot keeps uid', sShot.uid, 'bbbbbbbb-1');
A.eq('sanitizeShot keeps updatedAt', sShot.updatedAt, 1790000000000);
A.eq('sanitizeShot keeps the half-life snapshot', sShot.halfLifeDays, 5);
A.check('sanitizeShot refuses a junk uid', !call(`sanitizeShot({ when: '2026-09-01T15:00:00.000Z', dose: 5, uid: '<script>' })`).uid);
const sW = call(`sanitizeWeight({ date: '2026-09-01', value: 180, uid: 'cccccccc-1', updatedAt: 5 })`);
A.check('sanitizeWeight keeps uid and updatedAt', sW.uid === 'cccccccc-1' && sW.updatedAt === 5, JSON.stringify(sW));

// ---------- 4. an edit reaches the other device; a stale copy does not undo it ----------
await clear('shots');
await merge('shots', [{ when: '2026-09-01T15:00:00.000Z', dose: 2.5, uid: 'dddddddd-1', updatedAt: 100 }]);
const localId = (await all('shots'))[0].id;
let r = await merge('shots', [{ when: '2026-09-01T15:00:00.000Z', dose: 5, uid: 'dddddddd-1', updatedAt: 200 }]);
let rows = await all('shots');
A.eq('newer edit replaces, no duplicate', rows.length, 1);
A.eq('newer edit wins', rows[0].dose, 5);
A.eq('replacement keeps the local id', rows[0].id, localId);
A.eq('merge reports it as updated', r.updated, 1);
r = await merge('shots', [{ when: '2026-09-01T15:00:00.000Z', dose: 2.5, uid: 'dddddddd-1', updatedAt: 100 }]);
rows = await all('shots');
A.eq('an older copy does not undo the edit', rows[0].dose, 5);
A.eq('still one row', rows.length, 1);

// ---------- 5. deletions sync (tombstones) ----------
await clear('shots'); await clear('tombstones');
const deviceB = [
  { when: '2026-09-10T15:00:00.000Z', dose: 5, uid: 'eeeeeeee-1', updatedAt: 100 },
  { when: '2026-09-17T15:00:00.000Z', dose: 5, uid: 'eeeeeeee-2', updatedAt: 100 },
];
await merge('shots', deviceB);
const victim = (await all('shots')).find(r => r.uid === 'eeeeeeee-1');
await call(`dbDelSynced('shots', ${victim.id})`);
let tombs = await all('tombstones');
A.check('deleting records a tombstone', tombs.length === 1 && tombs[0].key === 'eeeeeeee-1', JSON.stringify(tombs));
// Device B has not heard about the delete and pushes the row back.
r = await call(`applyPulledPayload({ version: 11, shots: ${JSON.stringify(deviceB)} })`);
rows = await all('shots');
A.check('a pull that still has the deleted row does not bring it back',
  rows.length === 1 && rows[0].uid === 'eeeeeeee-2', JSON.stringify(rows.map(x => x.uid)));
const payload = await call('buildPayload()');
A.check('full sync payload carries the tombstone', (payload.tombstones || []).some(t => t.key === 'eeeeeeee-1'));
A.eq('payload version is 11', payload.version, 11);
const sharePayload = await call("buildPayload({ range: '90' })");
A.eq('a doctor share carries no tombstones', (sharePayload.tombstones || []).length, 0);

// The other direction: device B receives A's tombstone and drops its copy.
await clear('shots'); await clear('tombstones');
await merge('shots', deviceB);
// Real timestamps: a tombstone dated 1970 is older than 180 days and is pruned.
await call(`applyPulledPayload({ version: 11, shots: [], tombstones: [{ key: 'eeeeeeee-1', store: 'shots', deletedAt: Date.now() }] })`);
rows = await all('shots');
A.check('a pulled tombstone deletes the local copy', rows.length === 1 && rows[0].uid === 'eeeeeeee-2', JSON.stringify(rows.map(x => x.uid)));

// An edit made after the delete wins over it.
await clear('shots'); await clear('tombstones');
await merge('shots', [{ when: '2026-09-10T15:00:00.000Z', dose: 7.5, uid: 'eeeeeeee-1', updatedAt: Date.now() + 60000 }]);
await call(`applyPulledPayload({ version: 11, shots: [], tombstones: [{ key: 'eeeeeeee-1', store: 'shots', deletedAt: Date.now() }] })`);
A.eq('an edit made after the delete survives it', (await all('shots')).length, 1);

// Junk tombstones are ignored.
await clear('tombstones');
await call(`applyPulledPayload({ version: 11, tombstones: [{ key: 'x', store: 'settings', deletedAt: 5 }, { key: 5, store: 'shots', deletedAt: 5 }, { key: 'y', store: 'shots', deletedAt: 'soon' }] })`);
A.eq('tombstones for unknown stores or with bad fields are dropped', (await all('tombstones')).length, 0);

// Rows from before uids existed are tombstoned by content key.
await clear('supplies'); await clear('tombstones');
await call(`withStore('supplies', 'readwrite', s => s.add({ type: 'pen', total_mg: 10, opened_at: '2026-01-01' }))`);
const legacy = (await all('supplies'))[0];
await call(`dbDelSynced('supplies', ${legacy.id})`);
await call(`applyPulledPayload({ version: 11, supplies: [{ type: 'pen', total_mg: 10, opened_at: '2026-01-01' }] })`);
A.eq('a legacy row without a uid stays deleted too', (await all('supplies')).length, 0);

// Old tombstones expire.
await clear('tombstones');
await call(`dbPutExact('tombstones', { key: 'old-1', store: 'shots', deletedAt: Date.now() - 200 * 86400000 })`);
await call('liveTombstones()');
A.eq('tombstones older than 180 days are pruned', (await all('tombstones')).length, 0);

// ---------- 6. offline: a signed-in user stays signed in ----------
const user = { id: 16, email: 'x@example.com', subscriptionStatus: 'premium', isPremium: true };
call(`localStorage.setItem(LAST_USER_KEY, ${JSON.stringify(JSON.stringify(user))})`);
call(`fetch = async () => { throw new TypeError('Failed to fetch'); }`);
let me = await call('accountMe()');
A.check('no network: last confirmed user is used, not the sign-in screen', me && me.id === 16, JSON.stringify(me));
call(`fetch = async () => ({ ok: false, status: 502, json: async () => ({}) })`);
me = await call('accountMe()');
A.check('server error: still signed in', me && me.id === 16, JSON.stringify(me));
call(`fetch = async () => ({ ok: false, status: 401, json: async () => ({}) })`);
me = await call('accountMe()');
A.check('401: really signed out', me === null, JSON.stringify(me));
A.check('401 forgets the cached user', call('cachedAccountUser()') === null);
call(`fetch = async () => ({ ok: true, status: 200, json: async () => ({ user: ${JSON.stringify(user)} }) })`);
me = await call('accountMe()');
A.check('success refreshes the cache', call('cachedAccountUser()')?.id === 16);
await call('accountLogout()');
A.check('sign-out forgets the cached user', call('cachedAccountUser()') === null);

A.report();
