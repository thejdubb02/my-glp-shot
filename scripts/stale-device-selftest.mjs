#!/usr/bin/env node
// Stale-device self-test (GitHub issue #22).
//
// Tombstones are pruned after 180 days. A device that last synced before a delete
// and comes back after the tombstone is gone used to merge its old copy back in,
// and the next push put the deleted row on every device. Now a cloud pull on a
// device whose last push is older than the prune window drops rows it had at that
// push which the cloud no longer holds. Rows added since, file imports and
// devices that synced recently keep the plain union merge.
//
//   run via: bash scripts/run-tests.sh
import { loadApp, Assert } from './lib/app-harness.mjs';

const A = new Assert('stale-device');
const { R } = await loadApp({ domMode: 'stub' });
R('openBadgeShare = () => {}'); // a first-shot badge would try to draw on a stub canvas
const DAY = 86400000;
const ago = (d) => Date.now() - d * DAY;
const iso = (ms) => new Date(ms).toISOString();

async function reset({ pushedDaysAgo, pushedV = 12 }) {
  for (const s of ['shots', 'moods', 'tombstones']) await R(`withStore('${s}', 'readwrite', st => st.clear())`);
  R(`settings.syncLastPushAt = ${JSON.stringify(iso(ago(pushedDaysAgo)))}; settings.syncLastPushV = ${pushedV};`);
  // Deleted elsewhere 181 days ago, after this device's last push: tombstone pruned.
  await R(`dbAddExact('shots', { uid: 'gone', when: '2026-03-01T09:00', dose: 1, updatedAt: ${ago(210)} })`);
  await R(`dbPut('moods', { date: '2026-03-01', value: 3, updatedAt: '${iso(ago(210))}' })`);
  // Still in the cloud.
  await R(`dbAddExact('shots', { uid: 'kept', when: '2026-03-02T09:00', dose: 1, updatedAt: ${ago(210)} })`);
  // Logged on this device after its last push, never reached the cloud.
  await R(`dbAddExact('shots', { uid: 'new', when: '2026-03-03T09:00', dose: 1, updatedAt: ${ago(1)} })`);
  await R(`dbAddExact('tombstones', { key: 'old', store: 'shots', deletedAt: ${ago(181)} })`);
}
const cloud = { version: 12, shots: [{ uid: 'kept', when: '2026-03-02T09:00', dose: 1, updatedAt: ago(210) }], tombstones: [] };
const uids = async () => ((await R(`dbAll('shots')`)) || []).map(s => s.uid).sort().join(',');
const mood = () => R(`dbGet('moods', '2026-03-01')`);

// ---------- 1. the bug: a device away longer than the prune window ----------
await reset({ pushedDaysAgo: 200 });
await R('applyPulledPayload')(cloud, { cloud: true });
A.eq('row deleted elsewhere does not come back', await uids(), 'kept,new');
A.check('day deleted elsewhere does not come back', !(await mood()));
A.check('prune window still applies to tombstones', !(await R(`dbGet('tombstones', 'old')`)));

// ---------- 2. a device that synced recently keeps the union merge ----------
await reset({ pushedDaysAgo: 30 });
await R('applyPulledPayload')(cloud, { cloud: true });
A.eq('recent device keeps its rows', await uids(), 'gone,kept,new');

// ---------- 3. a file restore never deletes ----------
await reset({ pushedDaysAgo: 200 });
await R('applyPulledPayload')(cloud);
A.eq('file restore keeps local rows', await uids(), 'gone,kept,new');
A.check('file restore keeps local days', !!(await mood()));

// ---------- 4. a last push in an older payload version may have left stores out ----------
await reset({ pushedDaysAgo: 200, pushedV: 11 });
await R('applyPulledPayload')(cloud, { cloud: true });
A.eq('older pushed version keeps rows', await uids(), 'gone,kept,new');
await reset({ pushedDaysAgo: 200, pushedV: 'undefined' });
await R('applyPulledPayload')(cloud, { cloud: true });
A.eq('no recorded version keeps rows', await uids(), 'gone,kept,new');

// ---------- 5. rows imported since the last push keep their old stamps but never reached the cloud ----------
const empty = { version: 12, tombstones: [] };
await reset({ pushedDaysAgo: 200 });
await R('importRows')('shots', [{ uid: 'csv', when: '2026-02-01T09:00', dose: 1, updatedAt: ago(300) }]);
await R('applyPulledPayload')(empty, { cloud: true });
A.check('imported old shot survives a cloud pull', (await uids()).includes('csv'));
await reset({ pushedDaysAgo: 200 });
await R('applyPulledPayload')({ version: 12, notes: [{ date: '2026-02-01', text: 'from a backup', updatedAt: iso(ago(300)) }] });
await R('applyPulledPayload')(empty, { cloud: true });
A.check('restored old note survives a cloud pull', !!(await R(`getNote('2026-02-01')`)));
A.check('restored old shot survives a cloud pull', (await uids()).includes('gone'));

A.report();
