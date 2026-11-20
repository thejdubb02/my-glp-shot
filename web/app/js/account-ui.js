// My GLP Shot: Change email, account dialog, account-changed handling and premium gates.
'use strict';

// ----- Change the account email -----
//
// The email is the PBKDF2 salt (see deriveAccountCreds), so changing it changes
// the encryption key as well as the auth token. That makes this a key rotation
// wearing a settings-field costume, and the order matters:
//
//   1. derive creds under BOTH the old and the new address, from the password
//      the user just typed — we never store the password, only the derived key,
//      so it has to be re-entered
//   2. if there is a cloud blob, pull and decrypt it with the OLD key and
//      re-encrypt it under the NEW one
//   3. send old auth token (proof), new auth token, and the re-encrypted blob
//      together, so the server can swap all three atomically
//
// If a blob exists and we skipped step 2, the account would end up with a key
// that cannot decrypt its own ciphertext — which for the user is data loss.
// The server refuses that combination too; this is belt and braces.
async function accountChangeEmail(newEmail, password) {
  if (!account.user) throw new Error('Not signed in.');
  const target = (newEmail || '').trim().toLowerCase();
  if (!target || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(target)) throw new Error('Please enter a valid email address.');
  if (target === (account.user.email || '').toLowerCase()) throw new Error('That is already your email address.');
  if (!password) throw new Error('Enter your password to confirm.');
  return withSyncPushHeld(() => changeEmailAndKey(target, password));
}

async function changeEmailAndKey(target, password) {
  const cur = await deriveAccountCreds(account.user.email, password);
  const next = await deriveAccountCreds(target, password);

  // Re-encrypt whatever is already in the cloud, rather than pushing the local
  // database. A user who never turned on cloud backup must not acquire one as a
  // side effect of changing their email.
  let iv = '', ciphertext = '';
  const existing = await accountFetch('me/sync');
  if (existing.ok) {
    const j = await existing.json();
    if (j && j.exists) {
      let pt;
      try {
        pt = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: base64ToBytes(j.iv) },
          cur.aesKey,
          base64ToBytes(j.ciphertext),
        );
      } catch (_) {
        // The old key cannot open the blob, so re-encrypting is impossible and
        // going ahead would strand the data. Stop before anything changes.
        throw new Error('Password incorrect — your backup could not be unlocked.');
      }
      const newIv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: newIv }, next.aesKey, new Uint8Array(pt));
      iv = bytesToBase64(newIv);
      ciphertext = bytesToBase64(ct);
    }
  }

  const r = await accountFetch('me/email', {
    method: 'POST',
    body: JSON.stringify({
      currentAuthToken: cur.authToken,
      newEmail: target,
      newAuthToken: next.authToken,
      iv, ciphertext,
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || 'Could not change your email address.');

  // Only now is the new key the real one. Swap it in and re-persist the
  // device's remembered sign-in, or the next reload unlocks with a stale key.
  account.encryptionKey = next.aesKey;
  account.user = j.user || account.user;
  try { await rememberSignedIn(target, next.aesKey); } catch (_) {}
  settings.syncUsername = target;
  await saveSettings();
  return j.user;
}

function setupChangeEmailUI() {
  const openBtn = $('#change-email-btn');
  const dlg = $('#change-email-dialog');
  if (!openBtn || !dlg) return;
  const status = $('#change-email-status');
  openBtn.addEventListener('click', () => {
    if (!account.user) { toast('Sign in first.'); return; }
    $('#change-email-current').textContent = account.user.email || '';
    $('#change-email-new').value = '';
    $('#change-email-password').value = '';
    if (status) { status.textContent = ''; status.classList.remove('err', 'ok'); }
    dlg.showModal();
  });
  $('#change-email-cancel')?.addEventListener('click', () => dlg.close());
  $('#change-email-save')?.addEventListener('click', async () => {
    const btn = $('#change-email-save');
    const original = btn.textContent;
    if (status) { status.textContent = 'Re-encrypting your data…'; status.classList.remove('err', 'ok'); }
    btn.disabled = true; btn.textContent = 'Working…';
    try {
      const user = await accountChangeEmail($('#change-email-new').value, $('#change-email-password').value);
      if (status) { status.textContent = `Done — your email is now ${user.email}.`; status.classList.add('ok'); }
      await onAccountChanged();
      toast('Email address updated.');
      setTimeout(() => dlg.close(), 1400);
    } catch (e) {
      if (status) { status.textContent = e.message || 'Could not change your email address.'; status.classList.add('err'); }
    } finally {
      btn.disabled = false; btn.textContent = original;
    }
  });
}

// ----- Doctor share link (premium) -----
// ----- Account UI -----
function setAccountMode(mode) {
  $('#account-mode').value = mode;
  if (mode === 'signup') {
    $('#account-form-title').textContent = 'Sign up free';
    $('#account-form-sub').textContent = 'Free, takes 5 seconds. 14-day premium trial included.';
    $('#account-submit').textContent = 'Sign up';
    $('#account-pw-input').autocomplete = 'new-password';
    $('#account-switch').innerHTML = 'Already have an account? <a href="#" id="switch-mode-link">Sign in</a>';
  } else {
    $('#account-form-title').textContent = 'Sign in';
    $('#account-form-sub').textContent = 'Welcome back.';
    $('#account-submit').textContent = 'Sign in';
    $('#account-pw-input').autocomplete = 'current-password';
    $('#account-switch').innerHTML = "Don't have an account? <a href=\"#\" id=\"switch-mode-link\">Sign up free</a>";
  }
  $('#switch-mode-link').addEventListener('click', (e) => { e.preventDefault(); setAccountMode(mode === 'signup' ? 'login' : 'signup'); });
  $('#account-error').textContent = '';
}

function openAccountDialog(mode) {
  setAccountMode(mode || 'signup');
  $('#account-email-input').value = '';
  $('#account-pw-input').value = '';
  $('#account-error').textContent = '';
  $('#account-dialog').showModal();
}

async function handleAccountSubmit(ev) {
  ev.preventDefault();
  const mode = $('#account-mode').value;
  const email = $('#account-email-input').value.trim();
  const password = $('#account-pw-input').value;
  const errEl = $('#account-error');
  errEl.textContent = '';
  if (password.length < 8) { errEl.textContent = 'Password must be at least 8 characters.'; return; }
  $('#account-submit').disabled = true;
  $('#account-submit').textContent = 'Working…';
  try {
    if (mode === 'signup') {
      await accountSignup(email, password);
    } else {
      await accountLogin(email, password);
    }
    $('#account-dialog').close();
    await onAccountChanged();
    // Pull and merge first, then push the union. The server keeps one copy and
    // the last write wins, so pushing first replaced the cloud copy with this
    // device's data and dropped every record only the cloud had.
    if (account.encryptionKey) {
      try {
        const result = mode === 'login' ? await accountSyncPull() : null;
        if (result && result.payload) await applyPulledPayload(result.payload, { cloud: true });
        await accountSyncPush();
      } catch (e) { noteSyncFailure(e); }
    }
  } catch (e) {
    errEl.textContent = e.message || 'Failed';
  } finally {
    $('#account-submit').disabled = false;
    $('#account-submit').textContent = mode === 'signup' ? 'Sign up' : 'Sign in';
  }
}

async function onAccountChanged() {
  const u = account.user;
  const banner = $('#account-banner');
  const pill = $('#hdr-account-pill');
  // Auth gate: require signup/login on every fresh device. Once signed in, app unlocks.
  // (Old jdubb-style legacy sync bypass removed — everyone uses the email/password account flow.)
  const skippedAuth = (() => { try { return localStorage.getItem('mglp_skip_auth') === '1'; } catch (e) { return false; } })();
  if (!u && !skippedAuth) {
    document.body.classList.add('auth-active');
    $$('.view').forEach(v => v.classList.remove('active'));
    $('#view-auth').classList.add('active');
  } else {
    if (u) { try { localStorage.removeItem('mglp_skip_auth'); } catch (e) {} }
    document.body.classList.remove('auth-active');
    if ($('#view-auth').classList.contains('active')) {
      $('#view-auth').classList.remove('active');
      $('#view-home').classList.add('active');
    }
    if (typeof maybeAutoShowInstall === 'function') maybeAutoShowInstall();
  }
  // Surface the embedded Admin entry only for accounts with is_admin=1.
  // /api/me returns isAdmin: bool — same field the admin SPA uses for cookie
  // auth. Default to hidden; never show without an explicit positive signal.
  const adminCard = $('#admin-card');
  if (adminCard) adminCard.classList.toggle('hidden', !(u && u.isAdmin === true));
  // If view-admin happens to be active for a non-admin (e.g. stale tab state
  // after sign-out / account switch), force back to home so the iframe can't
  // linger.
  if (!(u && u.isAdmin === true) && $('#view-admin')?.classList.contains('active')) {
    showView('home');
    const f = $('#admin-frame'); if (f) f.src = 'about:blank';
  }
  if (u) {
    banner.classList.add('hidden');
    $('#account-signed-out').classList.add('hidden');
    $('#account-signed-in').classList.remove('hidden');
    $('#account-email').textContent = u.email;
    pill.classList.remove('hidden');
    pill.classList.remove('premium', 'trial');
    if (u.subscriptionStatus === 'lifetime' || (u.subscriptionStatus === 'premium' && u.isPremium)) {
      pill.textContent = 'Premium';
      pill.classList.add('premium');
    } else if (u.subscriptionStatus === 'trial' && u.isPremium && u.hasSubscription) {
      // Paid, just not billed yet. "Trial · 4d" made Lin think her payment had not
      // registered at all.
      pill.textContent = 'Premium';
      pill.classList.add('premium');
    } else if (u.subscriptionStatus === 'trial' && u.isPremium) {
      const daysLeft = Math.max(0, Math.ceil((u.trialEndsAt - Date.now() / 1000) / 86400));
      pill.textContent = `Trial · ${daysLeft}d`;
      pill.classList.add('trial');
    } else {
      pill.textContent = 'Free';
    }
    $('#account-sub-status').textContent = subscriptionStatusText(u);
    if (u.subscriptionStatus === 'trial' && u.trialEndsAt) {
      const total = 14 * 86400;
      const remaining = Math.max(0, u.trialEndsAt - Date.now() / 1000);
      $('#account-trial-fill').style.width = (100 * (1 - remaining / total)) + '%';
      $('#account-trial-bar').classList.remove('hidden');
    } else {
      $('#account-trial-bar').classList.add('hidden');
    }
    // Trial-ending banner: show when 3 or fewer days remain on a free trial. Dismissible per-day.
    try {
      const teb = $('#trial-end-banner');
      if (teb) {
        // A subscriber inside their trial is not "ending" anything — they already did
        // the thing this banner asks for.
        const isTrial = u.subscriptionStatus === 'trial' && u.isPremium && u.trialEndsAt
          && !u.hasSubscription;
        const daysLeft = isTrial ? Math.max(0, Math.ceil((u.trialEndsAt - Date.now() / 1000) / 86400)) : null;
        const todayKey = todayISODate();
        const dismissedKey = (() => { try { return localStorage.getItem('mglp_trial_end_dismissed') || ''; } catch (e) { return ''; } })();
        if (isTrial && daysLeft !== null && daysLeft <= 3 && daysLeft > 0 && dismissedKey !== todayKey) {
          $('#trial-end-days').textContent = String(daysLeft);
          teb.classList.remove('hidden');
        } else {
          teb.classList.add('hidden');
        }
      }
    } catch (e) {}
    $('#upgrade-cta').classList.toggle('hidden', hasPaidPlan());
    $('#manage-billing-cta').classList.toggle('hidden', !u.hasStripeCustomer);
    $('#manage-billing-cta').textContent = isCancelling() ? 'Resume subscription' : 'Manage subscription';
    const legacySync = $('#legacy-cloud-sync-card');
    if (legacySync) legacySync.classList.add('hidden');
    // Premium hero card on the Premium tab — mirrors upgrade/manage state and shows clear status text.
    const phUp = $('#premium-hero-upgrade');
    const phMan = $('#premium-hero-manage');
    const phTitle = $('#premium-hero-title');
    const phSub = $('#premium-hero-sub');
    if (phUp) phUp.classList.toggle('hidden', hasPaidPlan());
    if (phMan) {
      phMan.classList.toggle('hidden', !u.hasStripeCustomer);
      phMan.textContent = isCancelling() ? 'Resume subscription' : 'Manage subscription';
    }
    refreshUpgradeCopy();
    if (phTitle && phSub) {
      if (isCancelling() && u.isPremium) {
        phTitle.textContent = '⭐ Premium, cancelled';
        phSub.textContent = `Your plan stays active until ${accessUntilText()} and will not renew, so nothing more `
          + 'is charged. Changed your mind? Resume it any time before then, with no new trial or second charge.';
      } else if (u.subscriptionStatus === 'lifetime') {
        phTitle.textContent = '⭐ Lifetime Premium';
        phSub.textContent = 'You have full access. Thanks for being a founding supporter.';
      } else if (u.subscriptionStatus === 'premium' && u.isPremium) {
        phTitle.textContent = '⭐ Premium';
        phSub.textContent = 'You have full access to all premium features.';
      } else if (u.subscriptionStatus === 'trial' && u.isPremium && u.hasSubscription) {
        phTitle.textContent = '⭐ Premium, subscribed';
        phSub.textContent = `You're all set. Your trial runs to ${trialEndDateText().replace(/^on /, '')}, `
          + 'so nothing is charged until then. It renews automatically after that, and you can cancel any time.';
      } else if (u.subscriptionStatus === 'trial' && u.isPremium) {
        const daysLeft = Math.max(0, Math.ceil((u.trialEndsAt - Date.now() / 1000) / 86400));
        phTitle.textContent = `⭐ Trial · ${daysLeft} day${daysLeft === 1 ? '' : 's'} left`;
        phSub.textContent = 'Try every premium feature free. Subscribe before the trial ends to keep access.';
      } else {
        phTitle.textContent = 'Premium';
        phSub.textContent = 'Unlock supplies, measurements, labs, spend tracking, AI import, PDF reports, and doctor share links.';
      }
    }
  } else {
    $('#account-signed-out').classList.remove('hidden');
    $('#account-signed-in').classList.add('hidden');
    pill.classList.add('hidden');
    const legacySync = $('#legacy-cloud-sync-card');
    if (legacySync) legacySync.classList.remove('hidden');
    if (localStorage.getItem('acct.banner.dismissed') !== '1') {
      banner.classList.remove('hidden');
    }
  }
  applyPremiumGates();
}

function subscriptionStatusText(u) {
  if (!u) return '';
  if (u.subscriptionStatus === 'lifetime') return '⭐ Lifetime Premium — thank you for being a founding supporter!';
  if (u.hasSubscription && u.cancelAtPeriodEnd) {
    return `Cancelled. Access until ${accessUntilText()}, nothing more will be charged`;
  }
  if (u.subscriptionStatus === 'premium' && u.premiumUntil) {
    const d = new Date(u.premiumUntil * 1000).toLocaleDateString();
    return u.hasSubscription ? `Premium, renews ${d}` : `Premium until ${d}`;
  }
  if (u.subscriptionStatus === 'trial' && u.trialEndsAt) {
    const days = Math.max(0, Math.ceil((u.trialEndsAt - Date.now() / 1000) / 86400));
    if (u.hasSubscription) {
      return days > 0
        ? `Subscribed. First payment ${trialEndDateText()}, nothing charged until then`
        : 'Subscribed';
    }
    return days > 0 ? `Premium trial — ${days} day${days === 1 ? '' : 's'} remaining` : 'Trial ended';
  }
  return 'Free tier — upgrade for sync, supply tracking, and more';
}

function applyPremiumGates() {
  const premium = isPremium();
  // Toggle .lock-pill on premium feature cards. Tapping the pill opens the upgrade modal.
  ['#supply-lock', '#measurements-lock', '#labs-lock', '#cost-lock'].forEach(sel => {
    const el = document.querySelector(sel);
    if (!el) return;
    el.classList.toggle('unlocked', premium);
    if (!premium && !el._wired) {
      el.addEventListener('click', () => $('#upgrade-dialog').showModal());
      el._wired = true;
    }
  });
  // No blur, no paywall overlay. Cards stay fully usable; the pill labels the tier.
}
