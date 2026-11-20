// My GLP Shot: When a cloud sync runs: dirty marking, flush on hide, pull on return.
'use strict';

async function noteSyncFailure(e) {
  const msg = String((e && e.message) || e || 'Unknown error');
  console.warn('[mgs] sync push failed:', msg);
  settings.syncLastError = msg;
  settings.syncLastErrorAt = new Date().toISOString();
  try { await saveSettings(); } catch (_) {}
  updateBackupLabel();
  if (!_syncFailureWarned) {
    _syncFailureWarned = true;
    toast('Cloud backup failed — your data is still safe on this device.');
  }
}

// Flush pending pushes when the tab loses focus / unloads, and pull fresh data
// when it regains focus (covers the "I switched devices" UX). Without this,
// debounced writes can be silently dropped and the user sees stale data.
function setupSyncFlushAndVisibilityPull() {
  const flush = () => {
    if (!syncPush.dirty) return;
    if (!account.user || !account.encryptionKey) return;
    // Cancel the debounced push and fire one now.
    clearTimeout(syncPush.timer);
    syncPush.timer = null;
    accountSyncPush().catch(noteSyncFailure);
  };
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'hidden') {
      flush();
    } else if (document.visibilityState === 'visible') {
      // Coming back to the tab — pull any remote changes another device pushed
      // while we were away. Skip if we just pushed (within last 10 s) to avoid loops.
      if (!account.user || !account.encryptionKey) return;
      const recentPush = settings.syncLastPushAt && (Date.now() - new Date(settings.syncLastPushAt).getTime() < 10000);
      if (recentPush) return;
      try {
        const result = await accountSyncPull();
        if (result && result.payload) {
          const cloudUpdatedAt = result.updatedAt || 0;
          const lastSeen = settings.syncLastUpdatedAt || 0;
          if (cloudUpdatedAt > lastSeen) {
            await applyPulledPayload(result.payload, { cloud: true });
            track('visibility_pull_applied');
          }
        }
      } catch (e) {
        console.warn('[mgs] visibility pull failed:', e);
      }
    }
  });
  // pagehide is the most reliable event on mobile Safari for "tab is going away."
  window.addEventListener('pagehide', flush);
  // beforeunload is desktop-friendly.
  window.addEventListener('beforeunload', flush);
}

async function markSyncDirty() {
  if (account.user && account.encryptionKey) {
    // Account-based sync: auto-push with a *short* debounce so the cloud copy is
    // always within ~2 s of local. Anything longer means closing the tab can drop
    // a write. visibilitychange + pagehide listeners (registered at boot) flush
    // any still-pending writes when the tab backgrounds or unloads.
    syncPush.dirty = true;
    clearTimeout(syncPush.timer);
    syncPush.timer = setTimeout(() => {
      syncPush.timer = null;
      accountSyncPush().catch(noteSyncFailure);
    }, 1500);
    return;
  }
  if (account.user) {
    // Signed in, but this device holds no encryption key (the remembered key is
    // missing or unreadable). Nothing can be backed up, so say so rather than
    // dropping every change silently. A successful push clears the message.
    if (!settings.syncLastError) noteSyncFailure(new Error('sign in again on this device to turn it back on'));
    return;
  }
  if (!syncCreds || !settings.syncEnabled || !settings.syncAutoPush) return;
  settings.syncDirty = true;
  await saveSettings();
}
