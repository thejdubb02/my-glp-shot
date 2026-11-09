#!/usr/bin/env node
// Account-switch self-test: claimDevice in app.js (GitHub issue #10).
//
// Two people sharing a phone: A signs out, B signs in. Until 2026-11-09 the
// sign-in pushed A's whole local log into B's cloud and merged it there for
// good. Now a sign-in by a different account erases local data first, while
// the same account, or a device with no recorded owner, keeps its data.
//
//   run via: bash scripts/run-tests.sh
import { loadApp, Assert } from './lib/app-harness.mjs';

const A = new Assert('account-switch');
const { R } = await loadApp({ domMode: 'stub' });
const shots = async () => (await R(`dbAll('shots')`)).length;
const addShot = (id) => R(`dbPut('shots', { id: ${id}, when: '2026-09-01T15:00:00.000Z', dose: 5, med: 'Tirzepatide' })`);

// Fake server: login answers with whichever user the test names, and every
// push records how many shots it would have uploaded.
R(`
  globalThis.__t = { userId: 1, pushedShots: [] };
  accountFetch = async () => ({ ok: true, status: 200, json: async () => ({ user: { id: __t.userId }, token: 't' }) });
  pushToCloud = async () => { __t.pushedShots.push((await dbAll('shots')).length); return { updatedAt: 1 }; };
  accountSyncPull = async () => null;
`);
const login = async (id) => { R(`__t.userId = ${id}`); await R(`accountLogin('a${id}@example.com', 'password123')`); };

// ---------- 1. no recorded owner keeps its data ----------
await addShot(1);
await login(1);
A.eq('first account on an offline device keeps its log', await shots(), 1);
A.eq('owner recorded', R(`localStorage.getItem('mgs_device_owner')`), '1');

// ---------- 2. the same account signing in again keeps its data ----------
await R('accountLogout()');
await login(1);
A.eq('same account keeps its log', await shots(), 1);

// ---------- 3. a different account erases it before anything is pushed ----------
await R(`settings.doseUnit = 'ml'; saveSettings()`);
await R('accountLogout()');
await login(2);
A.eq('other account: shots erased', await shots(), 0);
A.check('other account: settings reset', R('settings.doseUnit') !== 'ml');
await R('accountSyncPush()');
A.eq('nothing of the first account is pushed', R('__t.pushedShots.at(-1)'), 0);

// ---------- 4. the restore path (auth screen reloads into it) also checks ----------
await addShot(2);
R(`accountMe = async () => ({ id: 3 }); account = { user: null, encryptionKey: null };`);
await R('tryRestoreAccount()');
A.eq('restore as another account erases first', await shots(), 0);
A.eq('restore records the new owner', R(`localStorage.getItem('mgs_device_owner')`), '3');

// ---------- 5. sign-out backs up edits still waiting ----------
R(`__t.pushedShots = []; account = { user: { id: 3 }, encryptionKey: {} }; syncPush.dirty = true;`);
await R('accountLogout()');
A.eq('pending edits pushed before sign-out', R('__t.pushedShots.length'), 1);

A.report();
