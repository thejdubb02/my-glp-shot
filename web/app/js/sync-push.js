// My GLP Shot: Cloud push state machine and encrypted pull (see docs/state-machines.md).
'use strict';

// ---------- Cloud push: the sync state machine ----------
// All cloud backup state lives in syncPush, and every push goes through
// accountSyncPush. States:
//   idle     dirty=false, nothing running
//   pending  dirty=true, timer set (markSyncDirty debounces 1.5 s)
//   pushing  running set; dirty is cleared when the push starts reading data,
//            so an edit made mid-push marks it dirty again and pushes again
//   failed   dirty=true, no timer; flush on tab hide and the 60 s retry pick it up
// Pushes run one at a time. Before this, the debounce, the tab-hide flush and
// the 60 s retry could each start a PUT, and two in flight can land out of
// order, leaving the cloud holding the older copy. A call made while a push is
// waiting to start shares that push, since it will read the newest data anyway.
const syncPush = { dirty: false, timer: null, running: null, queued: null, epoch: 0 };

// Sign-out: drop the pending push, and any push still queued behind a running
// one (the epoch check skips it), so nothing fires for an account that is gone.
function resetSyncPush() {
  syncPush.epoch++;
  syncPush.queued = null;
  clearTimeout(syncPush.timer);
  syncPush.timer = null;
  syncPush.dirty = false;
}

function accountSyncPush() {
  if (syncPush.queued) return syncPush.queued;
  const prev = syncPush.running || Promise.resolve();
  const epoch = syncPush.epoch;
  const p = prev.catch(() => {}).then(() => {
    if (epoch !== syncPush.epoch) return null;
    syncPush.queued = null;
    syncPush.running = p;
    syncPush.dirty = false;
    return pushToCloud().catch((e) => { syncPush.dirty = true; throw e; });
  }).finally(() => { if (syncPush.running === p) syncPush.running = null; });
  syncPush.queued = p;
  return p;
}

// Email change rotates the key. Let every push already running or queued land
// first (they used the old key), then hold the queue while fn runs: a push asked
// for meanwhile waits behind it and encrypts with whichever key is current then.
async function withSyncPushHeld(fn) {
  while (syncPush.queued || syncPush.running) await (syncPush.queued || syncPush.running).catch(() => {});
  let release;
  const hold = new Promise((r) => { release = r; });
  syncPush.running = hold;
  try { return await fn(); } finally {
    if (syncPush.running === hold) syncPush.running = null;
    release();
  }
}

async function pushToCloud() {
  if (!account.user || !account.encryptionKey) throw new Error('Not unlocked');
  // startedAt is taken before reading the data, so an edit made mid-push counts as newer.
  let startedAt, pushedV;
  const put = async (baseUpdatedAt) => {
    startedAt = new Date().toISOString();
    const payload = await buildPayload();
    pushedV = payload.version;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = await encodePayloadBytes(payload);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, account.encryptionKey, plaintext);
    const body = { iv: bytesToBase64(iv), ciphertext: bytesToBase64(ct), baseUpdatedAt };
    return accountFetch('me/sync', { method: 'PUT', body: JSON.stringify(body) });
  };
  let r = await put(settings.syncLastUpdatedAt ?? null);
  if (r.status === 409) {
    // Another device pushed since we last saw the cloud. Merge its rows in,
    // then push the union once on top of the version we just pulled.
    const pulled = await accountSyncPull();
    if (pulled && pulled.payload) await applyPulledPayload(pulled.payload, { cloud: true });
    r = await put(pulled ? pulled.updatedAt : null);
  }
  if (r.status === 413) throw new Error('Your data is too large to back up. Export a copy and contact support.');
  if (!r.ok) throw new Error('Sync failed: ' + r.status);
  const j = await r.json();
  settings.syncLastPushAt = startedAt;
  settings.syncLastPushV = pushedV;
  settings.syncLastUpdatedAt = j.updatedAt;
  settings.syncLastError = '';
  await saveSettings();
  return j;
}

async function accountSyncPull() {
  if (!account.user || !account.encryptionKey) throw new Error('Not unlocked');
  const r = await accountFetch('me/sync');
  if (!r.ok) throw new Error('Pull failed: ' + r.status);
  const j = await r.json();
  if (!j.exists) return null;
  const iv = base64ToBytes(j.iv);
  const ct = base64ToBytes(j.ciphertext);
  let pt;
  try {
    pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, account.encryptionKey, ct);
  } catch (e) {
    throw new Error('Decryption failed — wrong password');
  }
  return { payload: await decodePayloadBytes(new Uint8Array(pt)), updatedAt: j.updatedAt };
}
