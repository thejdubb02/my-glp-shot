// My GLP Shot: Account: key derivation, login, signup, session restore, premium and trial state.
'use strict';

// ============================================================================
// Cloud Sync — end-to-end encrypted blob storage.
// All cryptography runs in the browser. The server stores opaque ciphertext
// keyed by an HMAC-style lookup_id derived from username + passphrase. The
// server never sees: username, passphrase, encryption key, or plaintext.
// ============================================================================

const SYNC_API = 'api/sync';
const ACCOUNT_API = 'api';
const SYNC_PBKDF2_ITERS = 600000;
const SYNC_PROTOCOL = 'shotclock-v1';
const ACCOUNT_PROTOCOL = 'myglpshot-v1';

// ============================================================================
// Email/password account system. Bitwarden-style dual-hash:
//   PBKDF2(password, salt=hash(ACCOUNT_PROTOCOL+email), 600k) → 512 bits
//   First 256 = AES-GCM key (NEVER sent)
//   Last 256 = authToken (sent to server, server bcrypts before storing)
// Server cannot derive password OR encryption key from authToken.
// ============================================================================

let account = { user: null, encryptionKey: null };
const HEX = (buf) => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');

async function deriveAccountCreds(email, password) {
  const e = (email || '').trim().toLowerCase();
  const p = password || '';
  if (!e || !p) throw new Error('Email and password required');
  const enc = new TextEncoder();
  const saltBuf = await crypto.subtle.digest('SHA-256', enc.encode(ACCOUNT_PROTOCOL + ':' + e));
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(p), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBuf, iterations: SYNC_PBKDF2_ITERS, hash: 'SHA-256' },
    baseKey, 512
  );
  const buf = new Uint8Array(bits);
  // Extractable so we can persist the raw AES key locally (instead of the password) for session restore.
  const aesKey = await crypto.subtle.importKey('raw', buf.slice(0, 32), 'AES-GCM', true, ['encrypt', 'decrypt']);
  const authToken = HEX(buf.slice(32, 64));
  return { aesKey, authToken, email: e };
}

async function accountFetch(path, opts = {}) {
  opts.headers = Object.assign({ 'Content-Type': 'application/json', 'Accept': 'application/json' }, opts.headers || {});
  // Send Bearer token from localStorage as a fallback for PWAs / environments where cookies are flaky.
  try {
    const tok = localStorage.getItem('mgs_session_token');
    if (tok && !opts.headers.Authorization) opts.headers.Authorization = 'Bearer ' + tok;
  } catch (_) {}
  opts.credentials = 'same-origin';
  return fetch(`${ACCOUNT_API}/${path}`, opts);
}

async function accountSignup(email, password) {
  const creds = await deriveAccountCreds(email, password);
  const r = await accountFetch('signup', { method: 'POST', body: JSON.stringify({ email: creds.email, authToken: creds.authToken }) });
  if (!r.ok) {
    const j = await r.json().catch(() => ({ message: 'Signup failed' }));
    throw new Error(j.message || 'Signup failed');
  }
  const j = await r.json();
  await claimDevice(j.user);
  account = { user: j.user, encryptionKey: creds.aesKey };
  rememberSignedIn(creds.email, creds.aesKey);
  if (j.token) try { localStorage.setItem('mgs_session_token', j.token); } catch (_) {}
  if (j.user) try { localStorage.setItem(LAST_USER_KEY, JSON.stringify(j.user)); } catch (_) {}
  return j.user;
}

async function accountLogin(email, password) {
  const creds = await deriveAccountCreds(email, password);
  const r = await accountFetch('login', { method: 'POST', body: JSON.stringify({ email: creds.email, authToken: creds.authToken }) });
  if (!r.ok) {
    const j = await r.json().catch(() => ({ message: 'Login failed' }));
    throw new Error(j.message || 'Login failed');
  }
  const j = await r.json();
  await claimDevice(j.user);
  account = { user: j.user, encryptionKey: creds.aesKey };
  rememberSignedIn(creds.email, creds.aesKey);
  if (j.token) try { localStorage.setItem('mgs_session_token', j.token); } catch (_) {}
  if (j.user) try { localStorage.setItem(LAST_USER_KEY, JSON.stringify(j.user)); } catch (_) {}
  return j.user;
}

// Back up edits still waiting (or a push in flight) while this account's key
// and session are still here. False means some edits are only on this device.
async function flushBeforeSignOut() {
  if (!(syncPush.dirty || syncPush.running) || !account.user || !account.encryptionKey) return true;
  try { await accountSyncPush(); return true; } catch (e) { return false; }
}

async function accountLogout(forgetDevice) {
  await flushBeforeSignOut();
  await dropDevicePushOnSignOut();
  try { await accountFetch('logout', { method: 'POST' }); } catch (e) {}
  account = { user: null, encryptionKey: null };
  resetSyncPush();
  try { localStorage.removeItem('mgs_session_token'); } catch (_) {}
  forgetCachedAccountUser();
  if (forgetDevice) clearRememberedSignIn();
}

async function accountForgot(email) {
  const r = await accountFetch('forgot', { method: 'POST', body: JSON.stringify({ email }) });
  return r.ok;
}

// The last account the server confirmed, so a signed-in user who opens the app
// with no signal (or while the API is down) still gets their own data. Before
// this, a failed /api/me meant "not signed in", and the auth screen covered a
// paying user's entire log until the network came back. Only a 401/403 from the
// server means the session is really gone.
const LAST_USER_KEY = 'mgs_last_user';
function cachedAccountUser() {
  try { return JSON.parse(localStorage.getItem(LAST_USER_KEY) || 'null'); } catch (_) { return null; }
}
function forgetCachedAccountUser() {
  try { localStorage.removeItem(LAST_USER_KEY); } catch (_) {}
}
async function accountMe() {
  let r;
  try { r = await accountFetch('me'); }
  catch (e) { return cachedAccountUser(); }            // offline
  if (r.status === 401 || r.status === 403) { forgetCachedAccountUser(); return null; }
  if (!r.ok) return cachedAccountUser();                // server trouble, not a sign-out
  const j = await r.json();
  try { localStorage.setItem(LAST_USER_KEY, JSON.stringify(j.user)); } catch (_) {}
  return j.user;
}

function isPremium() {
  // isPremium can be a stale cached copy (offline, or app left open), so also
  // check the end date the server sent, same rule as is_premium_now() (#30).
  const u = account.user;
  if (!u || !u.isPremium) return false;
  const now = Date.now() / 1000;
  if (u.subscriptionStatus === 'trial') return !!u.trialEndsAt && u.trialEndsAt > now;
  if (u.subscriptionStatus === 'premium') return !!u.premiumUntil && u.premiumUntil > now;
  return true;
}

// Someone on the free trial IS premium — isPremium() is true for them — but they
// have not paid, and the trial copy spends the whole fortnight telling them to
// subscribe before it runs out. Gating the Upgrade buttons on isPremium() therefore
// hid the only way to act on that: until v0.62.0 a trial user saw "Subscribe before
// the trial ends to keep access" above an empty button row, and the sole escape was
// a banner that did not appear until 3 days were left. Hide the button only once
// there is an actual paid plan behind the access.
function hasPaidPlan() {
  const u = account.user;
  if (!u) return false;
  const st = u.subscriptionStatus;
  if (st === 'lifetime') return true;
  if (st === 'premium' && !!u.isPremium) return true;
  // Subscribing mid-trial does not end the trial — the account stays 'trial' until
  // the days already promised run out. Lin subscribed with 4 days left and the app
  // went on telling her to subscribe, because status alone cannot tell a paid trial
  // from an unpaid one.
  return st === 'trial' && !!u.hasSubscription;
}

// What to tell someone who has just come back from Stripe. Read off the refreshed
// account rather than assumed, because the two cases differ in the one detail that
// matters to them: whether they have been charged.
function billingSuccessMessage() {
  const u = account.user;
  if (u && u.subscriptionStatus === 'trial' && trialSecondsLeft() > 0) {
    return "🎉 You're subscribed, thank you!\n\nYour trial carries on as normal until "
      + trialEndDateText().replace(/^on /, '')
      + ", so nothing is charged until then. It renews automatically after that, "
      + 'and you can cancel any time from Settings.';
  }
  return "🎉 You're subscribed, thank you! Premium is active on your account, "
    + 'and you can manage or cancel it any time from Settings.';
}

// Paid, but still inside the trial they had before they paid.
function isSubscribedInTrial() {
  const u = account.user;
  return !!(u && u.subscriptionStatus === 'trial' && u.hasSubscription);
}

// True while the introductory trial is still running. The checkout call is identical
// either way — the server refuses a second trial via _has_used_trial — but the copy
// must not promise "start free trial" to someone whose card will be charged today.
// Cancelled in the billing portal: the subscription runs to the end of what is
// already paid (or the trial) and then stops. Checkout must stay hidden, because a
// second checkout would start a second subscription; resuming happens in the portal.
function isCancelling() {
  const u = account.user;
  return !!(u && u.hasSubscription && u.cancelAtPeriodEnd);
}
function accessUntilText() {
  const u = account.user;
  const ts = u && (u.subscriptionStatus === 'trial' ? u.trialEndsAt : u.premiumUntil);
  if (!ts) return 'the end of the current period';
  try { return new Date(ts * 1000).toLocaleDateString(); } catch (e) { return 'the end of the current period'; }
}

function isOnTrial() {
  const u = account.user;
  return !!(u && u.subscriptionStatus === 'trial' && u.isPremium && !u.hasSubscription);
}

function trialSecondsLeft() {
  const u = account.user;
  if (!u || !u.trialEndsAt) return 0;
  return Math.max(0, u.trialEndsAt - Date.now() / 1000);
}

// Stripe's own floor, mirrored here so the copy and the charge agree.
function trialEndsWithin48h() { return trialSecondsLeft() < 2 * 86400; }

function trialEndDateText() {
  const u = account.user;
  if (!u || !u.trialEndsAt) return 'when your trial ends';
  try { return `on ${new Date(u.trialEndsAt * 1000).toLocaleDateString()}`; }
  catch (e) { return 'when your trial ends'; }
}

// Keep every "buy" surface honest about which of the two it is: a first purchase,
// or converting a trial that is already counting down.
function refreshUpgradeCopy() {
  const trial = isOnTrial();
  const cta = document.getElementById('upgrade-cta');
  if (cta) cta.textContent = trial ? '\u2b50 Subscribe to keep Premium' : '\u2b50 Upgrade to Premium';
  const hero = document.getElementById('premium-hero-upgrade');
  if (hero) hero.textContent = trial ? '\u2b50 Subscribe' : '\u2b50 Upgrade';
  const title = document.getElementById('upgrade-title');
  if (title) title.textContent = trial ? 'Keep Premium' : 'Upgrade to Premium';
  const sub = document.getElementById('upgrade-sub');
  if (sub) {
    // Mirror what the server will actually do. Subscribing mid-trial hands Stripe the
    // trial_end already on the account, so the remaining days are kept and nothing is
    // charged until then — but Stripe refuses a trial_end under 48h out, so inside the
    // last two days the card really is charged today. Promising the wrong one of those
    // is how a first charge becomes a support email.
    sub.textContent = trial
      ? (trialEndsWithin48h()
          ? 'Billed today (your trial ends within 48 hours) \u00b7 cancel anytime \u00b7 no Apple/Google fee'
          : `You keep the rest of your trial, first charge ${trialEndDateText()} \u00b7 cancel anytime \u00b7 no Apple/Google fee`)
      : '14-day free trial \u00b7 cancel anytime \u00b7 no Apple/Google fee';
  }
  const confirm = document.getElementById('upgrade-confirm');
  if (confirm && !confirm.disabled) confirm.textContent = trial ? 'Subscribe \u2192' : 'Start free trial \u2192';
}

// Persist the derived AES encryption key (NOT the password) for session restore.
// XSS can still steal this key, but it can't steal a password the user may have reused elsewhere.
// The auth_token (server-side bcrypt-hashed) is never persisted; the session cookie is the auth credential.
async function rememberSignedIn(email, aesKey) {
  try {
    const raw = await crypto.subtle.exportKey('raw', aesKey);
    const b64 = bytesToBase64(raw);
    localStorage.setItem('account.cred', JSON.stringify({ email, k: b64, v: 2 }));
    // Migrate away from any old plaintext-password entries on this device.
    localStorage.removeItem('account.cred.legacy');
  } catch (e) {}
}
function getRememberedSignIn() {
  try {
    const raw = JSON.parse(localStorage.getItem('account.cred') || 'null');
    if (!raw) return null;
    if (raw.v === 2 && raw.email && raw.k) return raw;
    // Old format had plaintext password. Discard it — user will need to sign in again on this device.
    localStorage.removeItem('account.cred');
    return null;
  } catch (e) { return null; }
}
function clearRememberedSignIn() {
  try { localStorage.removeItem('account.cred'); } catch (e) {}
}

// Device owner: the account whose data this device holds. Two people can share
// a phone. Before this, B signing in after A signed out pushed A's whole log
// into B's cloud and merged it there for good. Now a sign-in by a different
// account first erases the local data, so nothing of A's can reach B.
// No recorded owner (offline use, or a device from before this) keeps its data:
// that is someone creating their first account, not a switch.
// Called by every sign-in path before anything is pushed.
const DEVICE_OWNER_KEY = 'mgs_device_owner';
async function claimDevice(user) {
  if (!user || user.id == null) return false;
  let owner = null;
  try { owner = localStorage.getItem(DEVICE_OWNER_KEY); } catch (_) {}
  const switched = owner != null && owner !== String(user.id);
  if (switched) await eraseLocalData();
  try { localStorage.setItem(DEVICE_OWNER_KEY, String(user.id)); } catch (_) {}
  return switched;
}
async function eraseLocalData() {
  resetSyncPush();
  await _weightMigrationRun.catch(() => {});
  const db = await openDB();
  for (const name of Array.from(db.objectStoreNames)) {
    await withStore(name, 'readwrite', (s) => s.clear());
  }
  settings = { ...DEFAULT_SETTINGS };
  try { applySettingsToInputs(); await renderShots(); await renderWeights(); await refreshDailyCards(); } catch (_) {}
}

async function importStoredAesKey(b64) {
  return crypto.subtle.importKey('raw', base64ToBytes(b64), 'AES-GCM', true, ['encrypt', 'decrypt']);
}

async function tryRestoreAccount() {
  const user = await accountMe();
  if (!user) return false;
  await claimDevice(user);
  account.user = user;
  const remembered = getRememberedSignIn();
  const sameEmail = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
  if (remembered && remembered.email && remembered.k) {
    if (sameEmail(remembered.email, user.email)) {
      try {
        account.encryptionKey = await importStoredAesKey(remembered.k);
      } catch (e) {}
    } else {
      // Another account's key (sign-in interrupted before it was replaced):
      // never use it, stay signed in but locked until the password is entered.
      clearRememberedSignIn();
      settings.syncLastError = 'Sign in again to unlock your cloud backup.';
      try { await saveSettings(); } catch (_) {}
    }
  }
  // Auto-sync on every login: pull, merge, push the union back.
  //
  // This used to compare timestamps and pick a winner, which meant whichever
  // side "lost" had its records discarded — a device that logged shots offline
  // lost them the moment another device pushed. Because a pull now merges
  // instead of replacing, there is no winner to pick: both sides' records
  // survive, and pushing the union afterwards converges every device.
  if (account.encryptionKey) {
    try {
      const result = await accountSyncPull();
      if (result && result.payload) {
        await applyPulledPayload(result.payload, { cloud: true });
        track('cross_device_auto_pull', {
          shots: (result.payload.shots || []).length,
          merged: (window._lastMergeStats && window._lastMergeStats.shots) || null,
        });
      }
      await accountSyncPush();
      settings.syncLastError = '';
      await saveSettings();
    } catch (e) {
      console.warn('[mgs] auto-sync on login failed (non-fatal):', e);
      settings.syncLastError = String(e && e.message || e);
      try { await saveSettings(); } catch (_) {}
    }
  }
  return true;
}
