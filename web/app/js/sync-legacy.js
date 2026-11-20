// My GLP Shot: Legacy passphrase sync UI (restore only).
'use strict';

// ---------- Sync UI ----------
function syncStatus(el, msg, kind) {
  const e = $(el);
  if (!e) return;
  e.textContent = msg || '';
  e.classList.remove('ok','err');
  if (kind) e.classList.add(kind);
}

function renderSyncUI() {
  const enabled = !!(settings.syncEnabled && syncCreds);
  $('#sync-enabled-view').classList.toggle('hidden', !enabled);
  $('#sync-disabled-view').classList.toggle('hidden', enabled);
  if (enabled) {
    $('#sync-current-user').textContent = settings.syncUsername || syncCreds.username;
    const last = settings.syncLastPushAt || settings.syncLastPullAt;
    $('#sync-last').textContent = last ? `Last sync: ${new Date(last).toLocaleString()}` : 'No sync yet.';
  }
}

async function attemptUnlockFromStored() {
  // Auto-unlock if we previously persisted creds (per-device convenience).
  try {
    const stored = localStorage.getItem('sync.creds');
    if (!stored) return false;
    const { u, p } = JSON.parse(stored);
    if (!u || !p) return false;
    syncCreds = await deriveSyncCreds(u, p);
    return true;
  } catch (e) { return false; }
}

function clearStoredCreds() {
  try { localStorage.removeItem('sync.creds'); } catch (e) {}
}


async function handleRestoreSync() {
  const u = $('#sync-user').value.trim();
  const p = $('#sync-pass').value;
  if (!u || !p) { syncStatus('#sync-setup-status', 'Username and passphrase are required.', 'err'); return; }
  syncStatus('#sync-setup-status', 'Deriving keys (this takes a few seconds)…');
  try {
    const creds = await deriveSyncCreds(u, p);
    syncStatus('#sync-setup-status', 'Pulling from cloud…');
    syncCreds = creds;
    const result = await syncPullNow();
    if (!result) {
      syncCreds = null;
      syncStatus('#sync-setup-status', 'No cloud copy found for those credentials.', 'err');
      return;
    }
    if (!confirm(`Found ${(result.payload.shots || []).length} shots in your legacy backup. Bring them across? They are merged in — nothing already on this device is removed.`)) {
      syncCreds = null;
      syncStatus('#sync-setup-status', 'Cancelled.');
      return;
    }
    await applyPulledPayload(result.payload);
    settings.syncEnabled = true;
    settings.syncUsername = creds.username;
    await saveSettings();
    // Deliberately NOT persisting the passphrase: this is a one-off recovery
    // path now, and keeping a passphrase in localStorage is exactly what the
    // account system moved away from.
    syncStatus('#sync-setup-status', '');
    renderSyncUI();
    const st = (window._lastMergeStats && window._lastMergeStats.shots) || null;
    alert(st ? `Restored. ${st.added} entries added, ${st.skipped} already here.` : 'Restored — your legacy entries have been merged in.');
  } catch (e) {
    syncCreds = null;
    syncStatus('#sync-setup-status', 'Failed: ' + e.message, 'err');
  }
}


async function handleSyncPull() {
  if (!syncCreds) return;
  if (!confirm('Pull your legacy backup across? Entries are merged in — nothing on this device is removed.')) return;
  syncStatus('#sync-status', 'Pulling…');
  try {
    const result = await syncPullNow();
    if (!result) { syncStatus('#sync-status', 'No cloud copy found.', 'err'); return; }
    await applyPulledPayload(result.payload);
    renderSyncUI();
    syncStatus('#sync-status', '✓ Pulled', 'ok');
    setTimeout(() => syncStatus('#sync-status', ''), 2500);
  } catch (e) {
    syncStatus('#sync-status', 'Failed: ' + e.message, 'err');
  }
}

async function handleSyncDisable() {
  if (!confirm('Forget the legacy backup on this device? Your local data is kept, and the backup itself is untouched.')) return;
  syncCreds = null;
  settings.syncEnabled = false;
  await saveSettings();
  clearStoredCreds();
  renderSyncUI();
}


async function initSyncUI() {
  // Pre-fill known username if we've used sync before
  if (settings.syncUsername) $('#sync-user').value = settings.syncUsername;

  // Legacy sync is recovery-only since 2026-08-09: the server rejects writes to
  // it, because the lookup id travelled in the URL and was the only credential.
  // The enable / push / delete controls are gone from the markup, so bind
  // defensively rather than assuming they exist.
  const on = (sel, fn) => { const el = $(sel); if (el) el.addEventListener('click', fn); };
  on('#sync-restore', handleRestoreSync);
  on('#sync-pull', handleSyncPull);
  on('#sync-disable', handleSyncDisable);

  if (settings.syncEnabled) {
    const ok = await attemptUnlockFromStored();
    if (!ok) {
      // creds not found locally — user needs to re-enter
      settings.syncEnabled = false;
      await saveSettings();
    }
  }
  renderSyncUI();

  // Safety net for account sync: markSyncDirty debounces a push after each
  // change, but a push that failed (offline, server blip) would otherwise sit
  // unretried until the next edit. Legacy sync no longer pushes at all.
  setInterval(async () => {
    if (!syncPush.dirty) return;
    if (!account.user || !account.encryptionKey) return;
    try {
      await accountSyncPush();
    } catch (e) {
      noteSyncFailure(e);
    }
  }, 60000);
}
