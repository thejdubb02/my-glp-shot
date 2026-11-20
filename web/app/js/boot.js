// My GLP Shot: App start: early UI wiring, session bootstrap and the DOMContentLoaded handler.
'use strict';

function wireCriticalUI() {
  // Bottom nav
  document.querySelectorAll('#bottom-nav .nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.getAttribute('data-nav-tab');
      track('nav_tab_click', { tab });
      if (tab === 'settings') {
        showView('settings');
        document.querySelectorAll('#bottom-nav .nav-btn').forEach(b => b.classList.toggle('active', b === btn));
      } else {
        showView('home');
        setHomeTab(tab);
      }
    });
  });
  setHomeTab('home');
  // Back buttons in sub-views
  document.querySelectorAll('[data-back]').forEach(b => {
    b.addEventListener('click', () => { showView('home'); setHomeTab('home'); });
  });
  // Manual install-prompt trigger from Settings — wire synchronously so it works
  // even if setupInstallBanner hasn't run yet.
  const showInstall = document.getElementById('show-install-prompt');
  if (showInstall) {
    showInstall.addEventListener('click', () => {
      if (typeof isStandalone === 'function' && isStandalone()) {
        alert('Already installed! 🎉');
        return;
      }
      if (typeof showInstallDialog === 'function') showInstallDialog();
    });
  }
  const dismissInstall = document.getElementById('install-dismiss');
  if (dismissInstall) {
    dismissInstall.addEventListener('click', () => {
      try { localStorage.setItem('installDismissedAt', String(Date.now())); } catch (_) {}
      const d = document.getElementById('install-dialog');
      if (d && d.open) d.close();
    });
  }

  // Auth gate — show by default. tryRestoreAccount can hide it if a session restores.
  // Doing this synchronously in wireCriticalUI guarantees the user always sees the
  // sign-in form even if every other init step fails.
  // Honor the "skip for now" local-only mode: if the user previously chose to try without an account,
  // boot straight into the home view instead of forcing the auth gate.
  const _skippedAuth = (() => { try { return localStorage.getItem('mglp_skip_auth') === '1'; } catch (e) { return false; } })();
  if (!_skippedAuth) {
    document.body.classList.add('auth-active');
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    const authViewEl = document.getElementById('view-auth');
    if (authViewEl) authViewEl.classList.add('active');
  } else {
    document.body.classList.remove('auth-active');
    const authViewEl = document.getElementById('view-auth');
    if (authViewEl) authViewEl.classList.remove('active');
    const homeEl = document.getElementById('view-home');
    if (homeEl) homeEl.classList.add('active');
  }

  document.querySelectorAll('#view-auth .auth-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => setAuthMode(btn.getAttribute('data-auth-mode')));
  });
  setAuthMode('signup');
  const authForgot = document.getElementById('auth-forgot');
  if (authForgot) {
    authForgot.addEventListener('click', (e) => {
      e.preventDefault();
      const dlg = document.getElementById('forgot-dialog');
      if (dlg && dlg.showModal) dlg.showModal();
    });
  }
  const authSkip = document.getElementById('auth-skip-link');
  if (authSkip) {
    authSkip.addEventListener('click', (e) => {
      e.preventDefault();
      try { localStorage.setItem('mglp_skip_auth', '1'); } catch (err) {}
      try { track('tried_without_account'); } catch (err) {}
      document.body.classList.remove('auth-active');
      const av = document.getElementById('view-auth');
      if (av) av.classList.remove('active');
      const home = document.getElementById('view-home');
      if (home) home.classList.add('active');
      if (typeof maybeAutoShowInstall === 'function') { try { maybeAutoShowInstall(); } catch (err) {} }
    });
  }
  async function handleAuthSubmit() {
    const email = (document.getElementById('auth-email') || {}).value || '';
    const pw = (document.getElementById('auth-pw') || {}).value || '';
    const errEl = document.getElementById('auth-err');
    const submit = document.getElementById('auth-submit');
    if (errEl) errEl.textContent = '';
    if (!email.trim() || !pw) {
      if (errEl) errEl.textContent = 'Email and password are required.';
      return;
    }
    if (_authMode === 'signup' && pw.length < 8) {
      if (errEl) errEl.textContent = 'Password must be at least 8 characters.';
      return;
    }
    if (submit) submit.disabled = true;
    const original = submit ? submit.textContent : '';
    if (submit) submit.textContent = _authMode === 'signup' ? 'Working…' : 'Signing in…';
    try {
      // Self-contained: derive auth token + AES key inline so we don't depend on accountSignup/Login being in scope.
      const cleanEmail = email.trim().toLowerCase();
      const enc = new TextEncoder();
      const saltBuf = await crypto.subtle.digest('SHA-256', enc.encode('myglpshot-v1:' + cleanEmail));
      const baseKey = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
      const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt: saltBuf, iterations: 600000, hash: 'SHA-256' },
        baseKey, 512
      );
      const buf = new Uint8Array(bits);
      const aesKey = await crypto.subtle.importKey('raw', buf.slice(0, 32), 'AES-GCM', true, ['encrypt', 'decrypt']);
      const authToken = Array.from(buf.slice(32, 64)).map(b => b.toString(16).padStart(2, '0')).join('');
      // Smart fallback: signup with existing email → auto-try login; login with no account → auto-try signup.
      // Same email/password works either way — server uses authToken (PBKDF2 of pw+email) so wrong pw on existing account fails both paths.
      async function callAuth(mode) {
        const payload = { email: cleanEmail, authToken };
        // Only ever sent on signup — attribution is a property of how someone
        // arrived, and re-sending it on every login would just overwrite the
        // original answer with wherever they happened to be today.
        if (mode === 'signup') {
          const a = getAttribution();
          if (a) payload.attribution = a;
        }
        const resp = await fetch(mode === 'signup' ? '/api/signup' : '/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          credentials: 'include',
        });
        let body = {}; try { body = await resp.json(); } catch (_) {}
        return { resp, body };
      }
      let { resp: r, body: j } = await callAuth(_authMode);
      let actualMode = _authMode;
      if (!r.ok && _authMode === 'signup' && j.error === 'email_in_use') {
        // Account already exists — silently log in instead.
        track('signup_fallback_to_login');
        ({ resp: r, body: j } = await callAuth('login'));
        actualMode = 'login';
      } else if (!r.ok && _authMode === 'login' && j.error === 'invalid_credentials') {
        // Could be no-account-yet OR wrong password. Try signup.
        track('login_fallback_to_signup');
        const sg = await callAuth('signup');
        if (sg.resp.ok) { r = sg.resp; j = sg.body; actualMode = 'signup'; }
        else if (sg.body.error === 'email_in_use') {
          // Account exists; password was wrong.
          throw new Error('Email or password is incorrect. Try again or use "Forgot password".');
        } else {
          throw new Error(sg.body.message || 'Could not sign up.');
        }
      }
      if (!r.ok) {
        throw new Error(j.message || `${actualMode === 'signup' ? 'Signup' : 'Login'} failed (${r.status}).`);
      }
      // Persist session token + AES key (NOT password).
      try {
        localStorage.setItem('mgs_session_token', j.token);
        const raw = await crypto.subtle.exportKey('raw', aesKey);
        const b64 = bytesToBase64(raw);
        localStorage.setItem('account.cred', JSON.stringify({ email: cleanEmail, k: b64, v: 2 }));
      } catch (_) {}
      track(_authMode === 'signup' ? 'signup_success' : 'login_success');
      // Reload to fully bootstrap the signed-in state. This is the simplest, most reliable
      // way to pick up the new session everywhere without juggling state.
      window.location.reload();
    } catch (ex) {
      if (errEl) errEl.textContent = (ex && ex.message) || 'Something went wrong.';
      track(_authMode === 'signup' ? 'signup_failed' : 'login_failed');
      console.error('[mgs] auth submit failed:', ex);
      if (submit) {
        submit.disabled = false;
        submit.textContent = original || (_authMode === 'signup' ? 'Create account & start free trial' : 'Sign in');
      }
    }
  }

  const authForm = document.getElementById('auth-form');
  if (authForm) {
    authForm.addEventListener('submit', (e) => {
      e.preventDefault();
      handleAuthSubmit();
    });
  }
  const authSubmitBtn = document.getElementById('auth-submit');
  if (authSubmitBtn) {
    // Belt-and-suspenders: also bind click directly (some iOS Safari builds drop submit events).
    authSubmitBtn.addEventListener('click', (e) => {
      e.preventDefault();
      handleAuthSubmit();
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wireCriticalUI, { once: true });
} else {
  wireCriticalUI();
}

// Kick off session restore as early as possible (independent of the heavy DOMContentLoaded
// init pipeline) so a user with an existing cookie sees the home view in <1s.
function bootstrapSession() {
  if (typeof tryRestoreAccount !== 'function') {
    setTimeout(bootstrapSession, 50);
    return;
  }
  tryRestoreAccount()
    .then(() => onAccountChanged())
    .catch((e) => { console.error('[mgs] session restore failed:', e); onAccountChanged(); });
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrapSession, { once: true });
} else {
  bootstrapSession();
}

document.addEventListener('DOMContentLoaded', async () => {
  // Surround everything async in try/catch so a single failure doesn't kill all later listener bindings.
  try { await loadSettings(); } catch (e) { console.error('loadSettings failed:', e); }
  try { applySettingsToInputs(); } catch (e) { console.error(e); }
  try { await renderShots(); } catch (e) { console.error(e); }
  try { await migrateWeightDatesToCanonical(); } catch (e) { console.error('weight migration failed:', e); }
  try { await renderWeights(); } catch (e) { console.error(e); }
  try { setInterval(async () => renderCountdown(await getShotsSorted()), 60000); } catch (e) {}
  try { handleReminderDeepLink(); } catch (e) { console.error('reminder deep link failed:', e); }

  // (Listeners that don't depend on IDB/data — attach defensively.)
  const logBtn = $('#log-shot-btn');
  if (logBtn) logBtn.addEventListener('click', () => openShotDialog());
  const viewAll = $('#view-all-history');
  if (viewAll) viewAll.addEventListener('click', (e) => { e.preventDefault(); showView('history'); });

  // Admin: lazy-load iframe on first open. Same-origin → session cookie
  // travels automatically; admin SPA detects the session and skips its own
  // sign-in. Reload on each open so changes from prior session aren't stale.
  // Belt-and-suspenders gate: even if a non-admin somehow reaches the button,
  // hit /api/me first; the server will not return isAdmin=true for them.
  // (The card is hidden client-side too; this is defense in depth.)
  const openAdmin = $('#open-admin');
  if (openAdmin) openAdmin.addEventListener('click', async () => {
    let allowed = !!(account && account.user && account.user.isAdmin);
    if (!allowed) {
      try {
        const me = await accountMe();
        allowed = !!(me && me.isAdmin);
        if (me) account.user = me;
      } catch (_) {}
    }
    if (!allowed) {
      alert('Admin access is required to open this section.');
      const card = $('#admin-card'); if (card) card.classList.add('hidden');
      return;
    }
    const frame = $('#admin-frame');
    if (frame) frame.src = '/admin/?embedded=1&t=' + Date.now();
    showView('admin');
  });
  const adminRefresh = $('#admin-refresh');
  if (adminRefresh) adminRefresh.addEventListener('click', () => {
    const frame = $('#admin-frame');
    if (!frame) return;
    // Re-set src with a fresh cache buster — works across browsers without
    // poking into iframe.contentWindow (which can throw under strict CSP).
    frame.src = '/admin/?embedded=1&t=' + Date.now();
  });

  $('#shot-cancel').addEventListener('click', () => $('#shot-dialog').close());
  // Show / hide the custom-site text input based on dropdown selection.
  $('#shot-site').addEventListener('change', () => {
    const v = $('#shot-site').value;
    setCustomRowVisible(v === '__custom');
    if (v === '__custom') $('#shot-site-custom').focus();
  });
  $('#shot-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const id = $('#shot-id').value;
      const whenStr = $('#shot-when').value;
      const whenDate = whenStr ? new Date(whenStr) : null;
      if (!whenDate || isNaN(whenDate.getTime())) {
        alert('Please pick a valid date and time for this shot.');
        return;
      }
      const dose = parseFloat($('#shot-dose-amt').value);
      if (!Number.isFinite(dose) || dose <= 0) {
        alert('Please enter a dose in mg (e.g. 5).');
        return;
      }
      // Resolve site: '__custom' selection means use the freeform input.
      let resolvedSite = $('#shot-site').value || null;
      if (resolvedSite === '__custom') {
        resolvedSite = ($('#shot-site-custom').value || '').trim().slice(0, 60) || null;
        if (!resolvedSite) {
          alert('Please enter a name for the custom site (or pick a different site).');
          return;
        }
        // Remember up to 10 most-recent custom names so the user can re-select them next time.
        const existing = settings.customSites || [];
        const dedup = existing.filter(n => n !== resolvedSite);
        dedup.push(resolvedSite);
        settings.customSites = dedup.slice(-10);
        await saveSettings();
      }
      // Snapshot half-life on new shots only; preserve the original on edits.
      let snapshotHalfLife = settings.halfLifeDays || null;
      if (id) {
        try {
          const existing = await dbGet(STORES.shots, parseInt(id, 10));
          if (existing && existing.halfLifeDays) snapshotHalfLife = existing.halfLifeDays;
        } catch (_) {}
      }
      const data = {
        med: $('#shot-med').value.trim() || 'Tirzepatide',
        dose,
        when: whenDate.toISOString(),
        site: resolvedSite,
        notes: $('#shot-notes').value.trim() || null,
        sideEffects: readSideEffects(),
        halfLifeDays: snapshotHalfLife,
      };
      if (id) data.id = parseInt(id, 10);
      await dbPut(STORES.shots, data);
      await ensurePersisted();
      $('#shot-dialog').close();
      // Re-render every dependent surface (charts, hero stats, badges, heatmap, body diagram, etc.) so backfilled shots immediately show.
      await renderShots();
      maybeScheduleNotification();
      markSyncDirty();
      track(id ? 'shot_edited' : 'shot_logged', { has_site: !!data.site, has_notes: !!data.notes, backdate_days: Math.max(0, Math.round((Date.now() - whenDate.getTime()) / 86400000)) });
    } catch (ex) {
      console.error('[mgs] shot save failed:', ex);
      alert('Could not save this shot: ' + (ex && ex.message ? ex.message : 'unknown error') + '. Please try again or screenshot this and send it.');
    }
  });
  $('#shot-delete').addEventListener('click', async () => {
    const id = parseInt($('#shot-id').value, 10);
    if (!id) return;
    if (!confirm('Delete this shot?')) return;
    await dbDelSynced(STORES.shots, id);
    $('#shot-dialog').close();
    await renderShots();
    markSyncDirty();
  });

  $('#add-weight-btn').addEventListener('click', openWeightDialog);
  $('#weight-log-btn')?.addEventListener('click', openWeightDialog);
  $('#weight-cancel').addEventListener('click', () => $('#weight-dialog').close());
  $('#weight-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const row = {
      value: parseFloat($('#weight-val').value),
      unit: $('#weight-unit').value,
      date: $('#weight-date').value,
    };
    // Typo guard: compare with the nearest other weigh-in on or before this
    // date (else the nearest after) and ask before saving a big jump.
    const others = (await getWeightsSorted()).filter(w => w.id !== _editingWeightId && toCanonicalDate(w.date) && toLb(w.value, w.unit) != null);
    const day = toCanonicalDate(row.date);
    const near = others.filter(w => toCanonicalDate(w.date) <= day).pop() || others.find(w => toCanonicalDate(w.date) > day);
    const newLb = toLb(row.value, row.unit);
    if (near && newLb != null && weightLooksLikeTypo(toLb(near.value, near.unit), newLb)) {
      const nearLb = toLb(near.value, near.unit);
      if (!confirm(`That's ${fmtWeightDelta(newLb - nearLb)} from your weigh-in on ${fmtDateShort(`${toCanonicalDate(near.date)}T00:00:00`)} (${fmtWeight(nearLb)}). Save anyway?`)) return;
    }
    if (_editingWeightId != null) await dbPut(STORES.weights, { id: _editingWeightId, ...row });
    else await dbAdd(STORES.weights, row);
    await ensurePersisted();
    $('#weight-dialog').close();
    await renderWeights();
    markSyncDirty();
    track(_editingWeightId != null ? 'weight_edited' : 'weight_logged', { unit: $('#weight-unit').value });
  });
  $('#weight-delete').addEventListener('click', async () => {
    if (_editingWeightId == null) return;
    if (!confirm('Delete this weight entry?')) return;
    await dbDelSynced(STORES.weights, _editingWeightId);
    $('#weight-dialog').close();
    await renderWeights();
    markSyncDirty();
  });

  $('#set-med').addEventListener('change', async (e) => {
    settings.medication = e.target.value.trim() || 'Tirzepatide';
    // Keep the preset dropdown in sync if the typed name matches a known preset.
    const matched = findMedPreset(settings.medication);
    if (matched) $('#set-med-preset').value = matched.id;
    else $('#set-med-preset').value = 'custom';
    renderDoseChips('#set-dose-chips', '#set-dose', settings.medication);
    await saveSettings(); markSyncDirty();
  });
  $('#set-med-preset').addEventListener('change', async (e) => {
    const id = e.target.value;
    const preset = MED_PRESETS.find(p => p.id === id);
    if (!preset) return;  // 'custom' — leave the user's values alone
    // Apply preset defaults; the user can still override any field.
    settings.medication = preset.name;
    settings.halfLifeDays = preset.halfLifeDays;
    settings.defaultDose = preset.defaultDose;
    settings.cadenceDays = preset.cadenceDays;
    $('#set-med').value = preset.name;
    $('#set-halflife').value = preset.halfLifeDays;
    $('#set-dose').value = preset.defaultDose;
    renderDoseChips('#set-dose-chips', '#set-dose', preset.name);
    $('#set-cadence').value = preset.cadenceDays;
    await saveSettings();
    markSyncDirty();
    await renderShots();
  });
  $('#set-dose').addEventListener('change', async (e) => { settings.defaultDose = parseFloat(e.target.value) || 0; await saveSettings(); markSyncDirty(); });
  $('#set-cadence').addEventListener('change', async (e) => { settings.cadenceDays = parseInt(e.target.value, 10) || 7; await saveSettings(); markSyncDirty(); await renderShots(); });
  $('#set-halflife').addEventListener('change', async (e) => { settings.halfLifeDays = parseFloat(e.target.value) || 5; await saveSettings(); markSyncDirty(); await renderShots(); });
  $('#set-notify').addEventListener('change', async (e) => {
    if (e.target.checked) {
      const perm = await Notification.requestPermission();
      settings.notify = perm === 'granted';
      e.target.checked = settings.notify;
      // Register for push where we can. Failing here is not fatal — the in-page
      // timer still works while the app is open — so it must not block the
      // toggle, only downgrade what the status line promises.
      if (settings.notify && PUSH_SUPPORTED && account.user) {
        try { await enablePushReminders(); }
        catch (err) { console.warn('[mgs] push enable failed:', err); }
      }
    } else {
      settings.notify = false;
      try { await disablePushReminders(); } catch (_) {}
    }
    await saveSettings();
    markSyncDirty();
    updateNotifyStatus();
    maybeScheduleNotification();
  });
  $('#set-lead').addEventListener('change', async (e) => {
    settings.notifyLeadMinutes = parseInt(e.target.value, 10) || 0;
    await saveSettings();
    markSyncDirty();
    maybeScheduleNotification();
  });
  $('#set-theme').addEventListener('change', async (e) => {
    settings.theme = e.target.value;
    await saveSettings();
    markSyncDirty();
    applyTheme();
  });
  $('#test-notify').addEventListener('click', sendTestNotification);

  // Timezone picker — changing TZ rewrites "today" everywhere, so we re-render
  // shots/weights/moods and re-plan reminders.
  const tzSel = $('#set-timezone');
  if (tzSel) {
    populateTimezoneOptions(tzSel);
    tzSel.addEventListener('change', async (e) => {
      settings.timezone = e.target.value || null;
      await saveSettings();
      markSyncDirty();
      updateTimezoneStatus();
      try { await renderShots(); } catch (_) {}
      try { await renderMood(); } catch (_) {}
      try { await renderAppetite(); } catch (_) {}
      maybeScheduleNotification();
    });
  }

  // Daily reminder rows are built dynamically so DAILY_REMINDERS is the only
  // place that knows the section list.
  renderDailyReminderRows();
  const dailyList = $('#daily-reminders-list');
  if (dailyList) {
    dailyList.addEventListener('change', async (e) => {
      const t = e.target;
      const key = t.getAttribute('data-rkey');
      if (!key) return;
      const cfg = settings.dailyReminders = { ...(settings.dailyReminders || {}) };
      const entry = cfg[key] = { ...(cfg[key] || { enabled: false, time: '08:00' }) };
      if (t.matches('input[type="checkbox"]')) {
        if (t.checked) {
          // Enabling any daily reminder requires notification permission once.
          if (typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
            const perm = await Notification.requestPermission();
            if (perm !== 'granted') { t.checked = false; return; }
          }
          entry.enabled = true;
        } else {
          entry.enabled = false;
        }
      } else if (t.matches('input[type="time"]')) {
        entry.time = t.value || '08:00';
      }
      await saveSettings();
      markSyncDirty();
      maybeScheduleNotification();
    });
  }

  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  }
  window.addEventListener('pageshow', () => maybeScheduleNotification());

  // Typed in the display unit, stored in pounds.
  const readWeightInput = (el) => (el && el.value !== '' ? toLb(el.value, weightUnit()) : null);
  $('#set-start-weight').addEventListener('change', async (e) => { settings.startWeight = readWeightInput(e.target); await saveSettings(); markSyncDirty(); await renderShots(); });
  $('#set-goal-weight').addEventListener('change', async (e) => { settings.goalWeight = readWeightInput(e.target); await saveSettings(); markSyncDirty(); await renderShots(); });
  const unitSel = $('#set-weight-unit');
  if (unitSel) unitSel.addEventListener('change', async (e) => {
    settings.weightUnit = e.target.value === 'kg' ? 'kg' : 'lb';
    await saveSettings();
    markSyncDirty();
    // Nothing stored changes — only how it reads — but every weight on screen
    // has to be redrawn, including the settings inputs we are standing in.
    applySettingsToInputs();
    try { await renderShots(); } catch (_) {}
    try { await renderWeights(); } catch (_) {}
  });
  $('#set-maintenance')?.addEventListener('change', async (e) => {
    settings.maintenanceMode = !!e.target.checked;
    await saveSettings();
    markSyncDirty();
    await renderShots();
  });

  // Explicit Save buttons (medication, weight goals, reminders).
  // Auto-save on `change` already runs; these buttons re-read the inputs (in case user typed without blurring),
  // immediately push to the account if signed in, and show ✓ Saved confirmation.
  async function flushSaveGroup(group) {
    if (group === 'medication') {
      settings.medication = ($('#set-med').value || '').trim() || 'Tirzepatide';
      settings.defaultDose = parseFloat($('#set-dose').value) || 0;
      settings.cadenceDays = parseInt($('#set-cadence').value, 10) || 7;
      settings.halfLifeDays = parseFloat($('#set-halflife').value) || 5;
    } else if (group === 'weight') {
      settings.startWeight = $('#set-start-weight').value !== '' ? toLb($('#set-start-weight').value, weightUnit()) : null;
      settings.goalWeight  = $('#set-goal-weight').value  !== '' ? toLb($('#set-goal-weight').value,  weightUnit()) : null;
    } else if (group === 'reminders') {
      settings.notifyLeadMinutes = parseInt($('#set-lead').value, 10) || 0;
    }
    await saveSettings();
    if (group === 'medication' || group === 'weight') await renderShots();
    if (group === 'reminders') maybeScheduleNotification();
  }
  $$('[data-save-group]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const group = btn.dataset.saveGroup;
      const status = document.querySelector(`[data-save-status="${group}"]`);
      btn.disabled = true;
      const origText = btn.textContent;
      btn.textContent = 'Saving…';
      try {
        await flushSaveGroup(group);
        if (account.user && account.encryptionKey) {
          try { await accountSyncPush(); status.textContent = '✓ Saved & synced'; }
          catch (e) { status.textContent = '✓ Saved locally (sync will retry)'; markSyncDirty(); }
        } else {
          status.textContent = '✓ Saved on this device';
        }
        status.classList.add('ok');
        setTimeout(() => { status.textContent = ''; status.classList.remove('ok'); }, 3500);
      } catch (e) {
        status.textContent = 'Save failed: ' + (e && e.message ? e.message : 'unknown');
      } finally {
        btn.disabled = false;
        btn.textContent = origText;
      }
    });
  });

  // Mood picker. Scoped to the home card — the catch-up dialog reuses .mood-btn
  // for its styling and must not inherit the today-only click handler.
  $$('#mood-picker .mood-btn').forEach(btn => btn.addEventListener('click', async () => {
    const v = parseInt(btn.dataset.mood, 10);
    await saveMood(todayISODate(), v);
    delete $('#mood-card').dataset.editing;
    await renderMood();
    markSyncDirty();
    track('mood_logged', { value: v });
  }));
  $('#mood-change').addEventListener('click', (e) => {
    e.preventDefault();
    $('#mood-card').dataset.editing = '1';
    renderMood();
  });

  renderSideEffectsForm();

  $('#export-btn').addEventListener('click', exportData);
  $('#import-btn').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', importData);
  const smartBtn = $('#smart-import-btn');
  if (smartBtn) {
    smartBtn.addEventListener('click', () => $('#smart-import-file').click());
    $('#smart-import-file').addEventListener('change', smartImport);
  }
  $('#wipe-btn').addEventListener('click', wipeAll);
  const delAcctBtn = $('#delete-account-btn');
  if (delAcctBtn) {
    delAcctBtn.addEventListener('click', async () => {
      if (!account.user) {
        alert('Not signed in.');
        return;
      }
      const typed = prompt('This permanently deletes your account, cancels any active subscription, and erases your cloud copy. Type DELETE to confirm:');
      if (typed !== 'DELETE') return;
      try {
        const r = await accountFetch('me', { method: 'DELETE' });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j.message || `Failed (${r.status})`);
        }
        clearRememberedSignIn();
        forgetCachedAccountUser();
        alert('Account deleted. Local data on this device is still here — use "Erase all data on this device" to wipe it too.');
        account = { user: null, encryptionKey: null };
        resetSyncPush();
        await onAccountChanged();
      } catch (e) {
        alert('Could not delete account: ' + (e.message || e));
      }
    });
  }
  // Surface app version (and SW cache name) in Settings + footer.
  (async function showVersion() {
    let swInfo = '';
    try {
      if ('caches' in window) {
        const keys = await caches.keys();
        const mglp = keys.find(k => k.startsWith('mglp-'));
        if (mglp) swInfo = ' · sw ' + mglp;
      }
    } catch (_) {}
    const line = $('#app-version-line');
    if (line) line.textContent = `App v${APP_VERSION}${swInfo}`;
    const foot = $('#app-version-footer');
    if (foot) foot.textContent = `v${APP_VERSION}`;
  })();

  $('#force-update-btn').addEventListener('click', async () => {
    try {
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
      }
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(r => r.unregister()));
      }
    } catch (e) { /* ignore */ }
    window.location.reload();
  });
  $('#download-ics').addEventListener('click', downloadICS);

  setupInstallBanner();
  registerSW();
  checkForStaleBundle();
  await ensurePersisted();
  updateBackupLabel();
  maybeScheduleNotification();
  initSyncUI();
  await renderMood();
  await renderAppetite();
  setupAppetiteUI();
  await renderFoodNoise();
  setupFoodNoiseUI();
  await renderNote();
  setupNoteUI();
  setupCatchupUI();
  setupSymptomsUI();
  await renderSymptomsCard();
  setupCycleUI();
  await renderCycleCard();
  setupMixingCalcUI();
  applyMixingCalcVisibility();
  setupMedChangeUI();
  await renderMedChanges();
  $('#guidance-close')?.addEventListener('click', () => $('#guidance-dialog').close());
  $('#guidance-done')?.addEventListener('click', () => $('#guidance-dialog').close());
  await renderInsights();
  applyTimeOfDayGradient();
  setInterval(applyTimeOfDayGradient, 5 * 60 * 1000);
  setupPullToRefresh();
  setupAccountUI();
  setupChangeEmailUI();
  setupReconCalc();
  setupDoseChips();
  setupSupplyUI();
  setupMeasurementUI();
  setupLabUI();
  setupExpenseUI();
  setupWeightRangeButtons();
  setupBenchmarkSelector();
  setupBodyToggle();
  renderThemeGrid();
  renderEmojiStyleGrid();
  renderAppetiteStyleGrid();
  setupInfoButtons();
  setupShareUI();
  setupBadgeShareDialog();
  setupSyncFlushAndVisibilityPull();

  // (Session restore now happens via bootstrapSession() at script load — independent of this pipeline.)

  // Refresh premium-gated cards' rendering
  await renderSupplies(await getShotsSorted());
  await renderMeasurements();
  await renderLabs();
  await renderCost(await getWeightsSorted());
  await renderPlateau(await getWeightsSorted(), await getShotsSorted());
});
