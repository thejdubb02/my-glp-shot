#!/usr/bin/env node
// Sync-conflict self-test (issue #23): a cloud push never overwrites a backup
// newer than the one this device last saw.
//
// Until 2026-11-09 every PUT me/sync was last-write-wins. Device B pushes,
// device A (which has not pulled since) pushes a moment later, and B's rows are
// gone from the cloud. Now the push carries baseUpdatedAt; the server answers
// 409 when the cloud moved on, and the client pulls, merges and pushes once more.
//
// The fake server below stores real AES-GCM ciphertext and applies the same
// version rule as api/app.py sync_put.
//
//   run via: bash scripts/run-tests.sh
import { loadApp, Assert } from './lib/app-harness.mjs';

const A = new Assert('sync-conflict');
const { R } = await loadApp({ domMode: 'stub' });

await R(`(async () => {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  account = { user: { id: 1 }, encryptionKey: key };
  globalThis.__s = { cloud: null, puts: [], gets: 0 };
  // Device B's push, already in the cloud: one supply A has never seen.
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bPayload = { version: 12, supplies: [{ type: 'pen', total_mg: 10, opened_at: '2026-10-01', expires_at: '2026-11-01', uid: 'bbbbbbbb-1' }] };
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, await encodePayloadBytes(bPayload));
  __s.cloud = { iv: bytesToBase64(iv), ciphertext: bytesToBase64(ct), updatedAt: 5 };
  __s.cloudSupplyUids = async () => {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(__s.cloud.iv) }, key, base64ToBytes(__s.cloud.ciphertext));
    const p = await decodePayloadBytes(new Uint8Array(pt));
    return (p.supplies || []).map((r) => r.uid).sort().join(',');
  };
  const res = (status, body) => ({ ok: status < 300, status, json: async () => body });
  accountFetch = async (path, opts = {}) => {
    if (path !== 'me/sync') return res(200, {});
    if (!opts.method) {
      __s.gets++;
      return res(200, { exists: true, ...__s.cloud });
    }
    const b = JSON.parse(opts.body);
    __s.puts.push(b.baseUpdatedAt);
    if ('baseUpdatedAt' in b && (b.baseUpdatedAt == null || __s.cloud.updatedAt > b.baseUpdatedAt)) return res(409, { error: 'stale', updatedAt: __s.cloud.updatedAt });
    __s.cloud = { iv: b.iv, ciphertext: b.ciphertext, updatedAt: __s.cloud.updatedAt + 1 };
    return res(200, { updatedAt: __s.cloud.updatedAt });
  };
  // Device A: last saw version 3, then logged its own supply offline.
  await ensureStore('supplies');
  await withStore('supplies', 'readwrite', (s) => s.clear());
  await dbPut('supplies', { type: 'vial', total_mg: 30, opened_at: '2026-10-02', expires_at: '2026-11-02', uid: 'aaaaaaaa-1' });
  settings.syncLastUpdatedAt = 3;
})()`);

// ---------- 1. a stale push pulls, merges and retries once ----------
await R('accountSyncPush()');
A.eq('cloud keeps the other device\'s row and adds ours', await R('__s.cloudSupplyUids()'), 'aaaaaaaa-1,bbbbbbbb-1');
A.eq('first PUT carried the stale base, the retry the pulled one', JSON.stringify(R('__s.puts')), '[3,5]');
A.eq('one pull to resolve the conflict', R('__s.gets'), 1);
A.eq('device now knows the version it wrote', R('settings.syncLastUpdatedAt'), 6);
A.check('merged row also landed locally', (await R(`dbAll('supplies')`)).some((r) => r.uid === 'bbbbbbbb-1'));

// ---------- 2. an up-to-date push goes straight through ----------
await R('accountSyncPush()');
A.eq('no conflict, no pull', R('__s.gets'), 1);
A.eq('base is the version this device wrote', R('__s.puts[2]'), 6);

// ---------- 3. a fresh device (no version seen) cannot wipe the cloud ----------
// It sends baseUpdatedAt: null, which the server refuses while a blob exists.
await R(`(async () => {
  __s.puts = []; __s.gets = 0;
  await withStore('supplies', 'readwrite', (s) => s.clear());
  await dbPut('supplies', { type: 'pen', total_mg: 5, opened_at: '2026-10-03', expires_at: '2026-11-03', uid: 'cccccccc-1' });
  settings.syncLastUpdatedAt = null;
})()`);
await R('accountSyncPush()');
A.eq('fresh device merges before it writes', await R('__s.cloudSupplyUids()'), 'aaaaaaaa-1,bbbbbbbb-1,cccccccc-1');
A.eq('first PUT sent null, the retry the pulled version', JSON.stringify(R('__s.puts')), '[null,7]');

// ---------- 4. the retry is bounded ----------
// A server that keeps saying 409 (another device pushing constantly) must not
// spin: two PUTs, then the push fails and stays dirty for the next retry.
R(`__s.puts = []; __s.cloud.updatedAt = 100; settings.syncLastUpdatedAt = 1;
   const real = accountFetch;
   accountFetch = async (path, opts = {}) => {
     if (path === 'me/sync' && opts.method === 'PUT') { __s.puts.push(1); return { ok: false, status: 409, json: async () => ({ error: 'stale', updatedAt: 999 }) }; }
     return real(path, opts);
   };`);
const err = await R('accountSyncPush()').catch((e) => e.message);
A.check('a second 409 fails the push', /409/.test(String(err)), String(err));
A.eq('exactly one retry', R('__s.puts.length'), 2);
A.eq('failed push stays dirty', R('syncPush.dirty'), true);

A.report();
