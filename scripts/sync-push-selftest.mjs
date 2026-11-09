#!/usr/bin/env node
// Sync-push self-test: the cloud backup state machine (syncPush in app.js).
//
// Until 2026-11-09 the push state was a loose window._syncDirty flag plus a
// timer id, set and cleared from four places. Three things went wrong:
//   1. The debounce, the tab-hide flush and the 60 s retry could each start a
//      PUT at once. Two in flight can land out of order and leave the cloud
//      holding the older copy.
//   2. Signing out left the debounce armed. It fired after sign-out, failed
//      with "Not unlocked" and showed a backup-failed warning.
//   3. Signed in on a device with no encryption key, every edit was dropped
//      from backup silently.
//
//   run via: bash scripts/run-tests.sh
import { loadApp, Assert } from './lib/app-harness.mjs';

const A = new Assert('sync-push');
const { R } = await loadApp({ domMode: 'stub' });
const tick = () => new Promise((r) => setTimeout(r, 0));

// A fake network push the test controls: it counts overlap and waits until
// released, so "two pushes in flight" is observable.
R(`
  globalThis.__t = { calls: 0, active: 0, maxActive: 0, release: [], fail: false };
  pushToCloud = () => {
    __t.calls++; __t.active++; __t.maxActive = Math.max(__t.maxActive, __t.active);
    return new Promise((res, rej) => __t.release.push(() => {
      __t.active--; __t.fail ? rej(new Error('offline')) : res({ updatedAt: 1 });
    }));
  };
  accountFetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
  account = { user: { id: 1 }, encryptionKey: {} };
`);
const releaseAll = async () => {
  for (let i = 0; i < 10; i++) { R('__t.release.splice(0).forEach((f) => f())'); await tick(); }
};

// ---------- 1. pushes never overlap ----------
const p1 = R('accountSyncPush()');      // debounce fires
await tick();
const p2 = R('accountSyncPush()');      // tab hidden, flush
const p3 = R('accountSyncPush()');      // 60 s retry
A.check('a call made while a push waits shares it', p2 === p3);
await releaseAll();
await Promise.all([p1, p2, p3]);
A.eq('only one push in flight at a time', R('__t.maxActive'), 1);
A.eq('three calls cost two pushes', R('__t.calls'), 2);
A.eq('nothing left running', R('syncPush.running'), null);

// ---------- 2. a failed push stays dirty, a later success clears it ----------
R('__t.fail = true');
const f = R('accountSyncPush()').catch((e) => e.message);
await releaseAll();
A.eq('failure reaches the caller', await f, 'offline');
A.eq('failed push stays dirty for the retry', R('syncPush.dirty'), true);
R('__t.fail = false');
const s = R('accountSyncPush()');
await releaseAll();
await s;
A.eq('success clears dirty', R('syncPush.dirty'), false);

// ---------- 3. an edit made mid-push is not lost ----------
const mid = R('accountSyncPush()');
await tick();
await R('markSyncDirty()');
await releaseAll();
await mid;
A.eq('edit during a push leaves it dirty', R('syncPush.dirty'), true);
A.check('edit during a push arms another push', R('syncPush.timer') !== null);

// ---------- 4. sign-out backs up what is waiting, then disarms ----------
// Sign-out first lets the running and queued pushes finish, so the leaving
// account's edits reach its own cloud. Nothing may push after it.
const running = R('accountSyncPush()');
await tick();
R('accountSyncPush()');                  // waits behind the running push
const before = R('__t.calls');
const out = R('accountLogout()');
await releaseAll();
await out; await running;
A.eq('sign-out waits for the queued push', R('__t.calls'), before + 1);
await R('markSyncDirty()');              // late edit: account is gone
await releaseAll();
A.eq('nothing pushes after sign-out', R('__t.calls'), before + 1);
A.eq('sign-out clears the timer', R('syncPush.timer'), null);

// ---------- 5. signed in without a key says so ----------
R(`account = { user: { id: 1 }, encryptionKey: null }; settings.syncLastError = '';`);
await R('markSyncDirty()');
A.check('missing key is reported, not swallowed', /sign in again/.test(R('settings.syncLastError')));
A.eq('missing key does not arm a push', R('syncPush.timer'), null);

// ---------- 6. changing email never leaves old-key ciphertext in the cloud ----------
// The email is the key salt, so a change re-encrypts the cloud blob. A push
// that encrypted with the old key and lands after POST me/email, or one that
// lands between the GET and the POST and gets overwritten, loses the backup.
// The fake cloud below stores real AES-GCM ciphertext; the check at the end is
// simply whether the new key can open what the cloud holds.
await R(`(async () => {
  const gen = () => crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  __t.oldKey = await gen(); __t.newKey = await gen();
  __t.log = []; __t.getGate = null; __t.calls = 0; __t.release = []; __t.fail = false;
  const seal = async (key, text) => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text));
    return { iv: bytesToBase64(iv), ciphertext: bytesToBase64(ct), text };
  };
  __t.cloud = await seal(__t.oldKey, 'v1');
  resetSyncPush();
  account = { user: { id: 1, email: 'old@example.com' }, encryptionKey: __t.oldKey };
  saveSettings = async () => {};
  rememberSignedIn = async () => {};
  deriveAccountCreds = async (email) => email === 'old@example.com'
    ? { aesKey: __t.oldKey, authToken: 'old' } : { aesKey: __t.newKey, authToken: 'new' };
  pushToCloud = async () => {
    __t.calls++;
    const key = account.encryptionKey;          // read when the push starts, like the real one
    const blob = await seal(key, 'v' + (__t.calls + 1));
    await new Promise((res) => __t.release.push(res));
    __t.cloud = blob; __t.log.push(key === __t.newKey ? 'put:new' : 'put:old');
  };
  accountFetch = async (path, opts = {}) => {
    if (path === 'me/sync' && !opts.method) {
      if (__t.getGate) await __t.getGate;
      const snap = __t.cloud; __t.log.push('get');
      return { ok: true, status: 200, json: async () => ({ exists: true, iv: snap.iv, ciphertext: snap.ciphertext }) };
    }
    if (path === 'me/email') {
      const b = JSON.parse(opts.body);
      __t.cloud = { iv: b.iv, ciphertext: b.ciphertext }; __t.log.push('email');
      return { ok: true, status: 200, json: async () => ({ user: { id: 1, email: b.newEmail } }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  __t.cloudOpensWithNewKey = async () => {
    try {
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(__t.cloud.iv) }, __t.newKey, base64ToBytes(__t.cloud.ciphertext));
      return true;
    } catch (_) { return false; }
  };
})()`);
const settle = async () => { for (let i = 0; i < 30; i++) { R('__t.release.splice(0).forEach((f) => f())'); await tick(); } };

// 6a. a push already running with the old key when the change starts
const inflight = R('accountSyncPush()');
await tick(); await tick();
const change = R(`accountChangeEmail('new@example.com', 'pw')`);
for (let i = 0; i < 10; i++) await tick();  // change gets as far as it can while the push is held
await settle();
await change; await inflight;
A.check('email change waits for a running old-key push', await R('__t.cloudOpensWithNewKey()'),
  'log: ' + R('__t.log.join(",")'));

// 6b. a push asked for while the change is re-encrypting
await R(`(async () => {
  account = { user: { id: 1, email: 'old@example.com' }, encryptionKey: __t.oldKey };
  __t.newKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  __t.cloud = { iv: bytesToBase64(iv), ciphertext: bytesToBase64(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, __t.oldKey, new Uint8Array([1]))) };
  __t.log = []; __t.calls = 0;
  let open; __t.getGate = new Promise((r) => { open = r; }); __t.openGet = open;
})()`);
const change2 = R(`accountChangeEmail('new2@example.com', 'pw')`);
await tick(); await tick();
const during = R('accountSyncPush()').catch(() => {});  // an edit's debounce fires mid-change
await tick(); await tick();
R('__t.openGet()'); R('__t.getGate = null');
await settle();
await change2; await during;
A.eq('a push asked for mid-change runs after it, with the new key', R('__t.log.join(",")'), 'get,email,put:new');
A.check('cloud still opens with the new key', await R('__t.cloudOpensWithNewKey()'));

A.report();
