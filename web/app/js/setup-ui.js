// My GLP Shot: One-time wiring for account, supply, measurement, expense, lab and share UI; service worker registration.
'use strict';

// ----- Setup helpers -----
function setupAccountUI() {
  $('#show-signup').addEventListener('click', () => openAccountDialog('signup'));
  $('#show-login').addEventListener('click', () => openAccountDialog('login'));
  $('#acct-banner-cta').addEventListener('click', () => openAccountDialog('signup'));
  $('#acct-banner-dismiss').addEventListener('click', () => {
    localStorage.setItem('acct.banner.dismissed', '1');
    $('#account-banner').classList.add('hidden');
  });
  const tebDismiss = document.getElementById('trial-end-dismiss');
  if (tebDismiss) tebDismiss.addEventListener('click', () => {
    try { localStorage.setItem('mglp_trial_end_dismissed', todayISODate()); } catch (e) {}
    document.getElementById('trial-end-banner')?.classList.add('hidden');
    track('trial_end_banner_dismissed');
  });
  const tebCta = document.getElementById('trial-end-cta');
  if (tebCta) tebCta.addEventListener('click', () => {
    track('trial_end_banner_clicked');
    // Open the dialog directly rather than synthesising a click on a button that
    // may be hidden or absent — the same trap that broke the weight deep link.
    const err = document.getElementById('upgrade-error');
    if (err) err.textContent = '';
    refreshUpgradeCopy();
    document.getElementById('upgrade-dialog')?.showModal();
  });
  $('#account-form').addEventListener('submit', handleAccountSubmit);

  // (Auth form + toggle wired in wireCriticalUI() so it works even if init hangs.)
  $('#account-cancel').addEventListener('click', () => $('#account-dialog').close());
  $('#show-forgot').addEventListener('click', (e) => { e.preventDefault(); $('#account-dialog').close(); $('#forgot-dialog').showModal(); });
  $('#forgot-cancel').addEventListener('click', () => $('#forgot-dialog').close());
  $('#forgot-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('#forgot-email').value.trim();
    $('#forgot-status').textContent = 'Sending…';
    try {
      await accountForgot(email);
      $('#forgot-status').textContent = 'If that email has an account, a reset link is on the way.';
      setTimeout(() => $('#forgot-dialog').close(), 2500);
    } catch (e) {
      $('#forgot-status').textContent = 'Failed: ' + e.message;
    }
  });
  $('#signout-btn').addEventListener('click', async () => {
    if (!confirm('Sign out? Local data is preserved.')) return;
    if (!(await flushBeforeSignOut()) && !confirm('Your latest changes are not backed up yet (no connection?). If a different account signs in on this device, they will be erased. Sign out anyway?')) return;
    await accountLogout(true);
    onAccountChanged();
  });
  $('#upgrade-cta').addEventListener('click', () => { $('#upgrade-error').textContent = ''; refreshUpgradeCopy(); $('#upgrade-dialog').showModal(); });
  // Premium hero buttons reuse the same dialogs as the Settings card.
  const heroUp = document.getElementById('premium-hero-upgrade');
  if (heroUp) heroUp.addEventListener('click', () => { $('#upgrade-error').textContent = ''; refreshUpgradeCopy(); $('#upgrade-dialog').showModal(); });
  const heroMan = document.getElementById('premium-hero-manage');
  if (heroMan) heroMan.addEventListener('click', () => $('#manage-billing-cta').click());
  $('#upgrade-cancel').addEventListener('click', () => $('#upgrade-dialog').close());
  $('#upgrade-confirm').addEventListener('click', async () => {
    const btn = $('#upgrade-confirm');
    const err = $('#upgrade-error');
    err.textContent = '';
    const plan = (document.querySelector('input[name="plan"]:checked') || {}).value || 'yearly';
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = 'Redirecting to Stripe…';
    try {
      track('billing_checkout_clicked', { plan });
      const r = await accountFetch('billing/checkout', { method: 'POST', body: JSON.stringify({ plan }) });
      const j = await r.json();
      if (!r.ok || !j.url) throw new Error(j.message || 'Checkout failed.');
      window.location.assign(j.url);
    } catch (ex) {
      err.textContent = ex.message || 'Could not start checkout.';
      btn.disabled = false;
      btn.textContent = orig;
    }
  });
  $('#manage-billing-cta').addEventListener('click', async () => {
    const btn = $('#manage-billing-cta');
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = 'Opening…';
    try {
      const r = await accountFetch('billing/portal', { method: 'POST' });
      const j = await r.json();
      if (!r.ok || !j.url) throw new Error(j.message || 'Could not open billing portal.');
      window.location.assign(j.url);
    } catch (ex) {
      alert(ex.message || 'Could not open billing portal.');
      btn.disabled = false;
      btn.textContent = orig;
    }
  });

  // PWA shortcut deep-links: ?action=log-shot / ?action=log-weight / ?tab=insights.
  (function handleShortcutAction() {
    const sp = new URLSearchParams(window.location.search);
    const action = sp.get('action');
    const tab = sp.get('tab');
    if (action || tab) {
      sp.delete('action'); sp.delete('tab');
      const cleanUrl = window.location.pathname + (sp.toString() ? '?' + sp.toString() : '') + window.location.hash;
      window.history.replaceState({}, '', cleanUrl);
    }
    // Navigation is two levels: showView() picks the screen, setHomeTab() picks
    // a tab WITHIN the home screen. This used to call a setTab() that has never
    // existed, so the launcher's "Insights" shortcut threw into a silent catch
    // and just opened the app — the one long-press shortcut users would notice
    // was broken doing nothing at all.
    const runShortcut = () => {
      // Don't fight the auth gate. A shortcut tapped while signed out should
      // land on the sign-in screen, not force the home view behind it.
      if (document.body.classList.contains('auth-active')) return;
      if (tab === 'settings') {
        try { showView('settings'); } catch (e) {}
      } else if (tab && ['home', 'insights', 'more'].includes(tab)) {
        try { showView('home'); setHomeTab(tab); } catch (e) {}
      }
      if (action === 'log-shot') { try { openShotDialog(); } catch (e) {} }
      else if (action === 'log-weight') { try { openWeightDialog(); } catch (e) {} }
    };
    if (action || tab) setTimeout(runShortcut, 250);
  })();

  // Handle Stripe Checkout return.
  (function handleBillingReturn() {
    const sp = new URLSearchParams(window.location.search);
    const billing = sp.get('billing');
    if (!billing) return;
    sp.delete('billing'); sp.delete('session_id');
    const cleanUrl = window.location.pathname + (sp.toString() ? '?' + sp.toString() : '') + window.location.hash;
    window.history.replaceState({}, '', cleanUrl);
    if (billing === 'success') {
      // The old code fired a hardcoded "your 14-day trial just started" 100ms in,
      // before /me had been refreshed. It was wrong for everyone converting mid-trial:
      // Lin subscribed with 4 days left and was told she had been handed 14 new ones.
      // Say the true thing, which means waiting for the webhook to land first.
      try { toast('🎉 Subscribed, thank you!'); } catch (e) {}
      setTimeout(async () => {
        // accountMe() only returns the fresh user; it does not set account.user (#26).
        try { const me = await accountMe(); if (me) account.user = me; await onAccountChanged(); } catch (e) {}
        alert(billingSuccessMessage());
      }, 1500);
    } else if (billing === 'canceled') {
      // No-op; user backed out.
    }
  })();
  $('#show-acct-sync').addEventListener('click', async () => {
    $('#acct-sync-status').textContent = 'Syncing…';
    try { await accountSyncPush(); $('#acct-sync-status').textContent = '✓ Synced'; setTimeout(() => $('#acct-sync-status').textContent = '', 2500); }
    catch (e) { $('#acct-sync-status').textContent = 'Failed: ' + e.message; }
  });
  $('#show-export-pdf').addEventListener('click', exportPDFReport);
  // Premium tab has duplicate button (-more suffix) — wire it to the same handler.
  const exportMore = document.getElementById('show-export-pdf-more');
  if (exportMore) exportMore.addEventListener('click', exportPDFReport);
  const shareMore = document.getElementById('show-share-more');
  if (shareMore) shareMore.addEventListener('click', () => {
    if (!isPremium()) { $('#upgrade-dialog').showModal(); return; }
    document.getElementById('show-share').click();
  });
  const pdfDlg = document.getElementById('pdf-dialog');
  if (pdfDlg) {
    document.getElementById('pdf-cancel')?.addEventListener('click', () => pdfDlg.close());
    document.getElementById('pdf-generate')?.addEventListener('click', async () => {
      const sections = Array.from(pdfDlg.querySelectorAll('[data-pdf-section]:checked')).map(el => el.dataset.pdfSection);
      const range = document.getElementById('pdf-range').value;
      pdfDlg.close();
      try { await runPdfExport({ range, sections }); track('pdf_export_created'); }
      catch (e) { track('pdf_export_failed'); alert('Failed: ' + e.message); }
    });
  }
}

function setupSupplyUI() {
  $('#add-supply-btn').addEventListener('click', () => {
    if (!isPremium() && account.user) { $('#upgrade-dialog').showModal(); return; }
    openSupplyDialog(null);
  });
  $('#supply-cancel').addEventListener('click', () => $('#supply-dialog').close());
  ['#supply-total-mg', '#supply-volume-ml'].forEach(sel => {
    const el = $(sel);
    if (el) el.addEventListener('input', updateSupplyReadout);
  });
  $('#supply-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = $('#supply-id').value;
    const supply = {
      type: $('#supply-type').value,
      total_mg: parseFloat($('#supply-total-mg').value),
      volume_ml: parseFloat($('#supply-volume-ml').value) || null,
      pharmacy: $('#supply-pharmacy').value.trim() || null,
      batch: $('#supply-batch').value.trim() || null,
      cost: parseFloat($('#supply-cost').value) || null,
      opened_at: $('#supply-opened').value || null,
      expires_at: $('#supply-expires').value || null,
      // No stored used_mg: usage is derived from the shot log by supplyUsage(),
      // so it can't drift out of date the way a written-once field did.
    };
    if (id) supply.id = parseInt(id, 10);
    await saveSupply(supply);
    $('#supply-dialog').close();
    await renderSupplies(await getShotsSorted());
    await renderCost(await getWeightsSorted());
    markSyncDirty();
  });
  $('#supply-delete').addEventListener('click', async () => {
    const id = parseInt($('#supply-id').value, 10);
    if (!id) return;
    if (!confirm('Delete this supply?')) return;
    await deleteSupply(id);
    $('#supply-dialog').close();
    await renderSupplies(await getShotsSorted());
    await renderCost(await getWeightsSorted());
    markSyncDirty();
  });
}

function setupMeasurementUI() {
  const sel = $('#measurement-type');
  const hint = $('#measurement-hint');
  if (sel) {
    sel.innerHTML = MEASUREMENT_TYPES
      .map(t => `<option value="${t.key}">${t.label}</option>`).join('');
    // Nobody is born knowing where a "high bust" is measured, and a tape held in
    // the wrong place makes every later reading meaningless.
    const showHint = () => {
      if (!hint) return;
      const t = MEASUREMENT_TYPES.find(x => x.key === sel.value);
      hint.textContent = t ? t.hint : '';
    };
    sel.addEventListener('change', showHint);
    showHint();
  }
  $('#add-measurement-btn').addEventListener('click', () => {
    if (!isPremium() && account.user) { $('#upgrade-dialog').showModal(); return; }
    $('#measurement-value').value = '';
    $('#measurement-date').value = todayISODate();
    $('#measurement-dialog').showModal();
  });
  $('#measurement-cancel').addEventListener('click', () => $('#measurement-dialog').close());
  $('#measurement-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    await saveMeasurement({
      type: $('#measurement-type').value,
      value: parseFloat($('#measurement-value').value),
      unit: $('#measurement-unit').value,
      date: $('#measurement-date').value,
    });
    $('#measurement-dialog').close();
    await renderMeasurements();
    markSyncDirty();
  });
}

function setupExpenseUI() {
  const btn = $('#add-expense-btn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    if (!isPremium() && account.user) { $('#upgrade-dialog').showModal(); return; }
    openExpenseDialog(null);
  });
  $('#expense-cancel').addEventListener('click', () => $('#expense-dialog').close());
  $('#expense-delete').addEventListener('click', async () => {
    const id = parseInt($('#expense-id').value, 10);
    if (!id) return;
    if (!confirm('Delete this expense?')) return;
    await deleteExpense(id);
    $('#expense-dialog').close();
    await renderCost(await getWeightsSorted());
    markSyncDirty();
    track('expense_deleted');
  });
  $('#expense-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const idVal = $('#expense-id').value;
    const data = {
      amount: parseFloat($('#expense-amount').value),
      category: $('#expense-category').value,
      date: $('#expense-date').value,
      notes: $('#expense-notes').value.trim() || null,
    };
    if (idVal) data.id = parseInt(idVal, 10);
    await saveExpense(data);
    $('#expense-dialog').close();
    await renderCost(await getWeightsSorted());
    markSyncDirty();
    track(idVal ? 'expense_edited' : 'expense_logged', { category: data.category });
  });
}

function setupLabUI() {
  $('#add-lab-btn').addEventListener('click', () => {
    if (!isPremium() && account.user) { $('#upgrade-dialog').showModal(); return; }
    $('#lab-value').value = '';
    $('#lab-date').value = todayISODate();
    $('#lab-notes').value = '';
    $('#lab-dialog').showModal();
  });
  $('#lab-cancel').addEventListener('click', () => $('#lab-dialog').close());
  $('#lab-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    await saveLab({
      type: $('#lab-type').value,
      value: parseFloat($('#lab-value').value),
      date: $('#lab-date').value,
      notes: $('#lab-notes').value.trim() || null,
    });
    $('#lab-dialog').close();
    await renderLabs();
    markSyncDirty();
  });
}

function setupShareUI() {
  $('#show-share').addEventListener('click', () => {
    if (!isPremium()) { $('#upgrade-dialog').showModal(); return; }
    $('#share-result').classList.add('hidden');
    $('#share-label').value = '';
    $('#share-dialog').showModal();
  });
  $('#share-cancel').addEventListener('click', () => $('#share-dialog').close());
  $('#share-create').addEventListener('click', async () => {
    try {
      const sections = Array.from(document.querySelectorAll('#share-dialog [data-section]:checked')).map(el => el.dataset.section);
      const range = $('#share-range').value;
      const result = await createShareLink($('#share-label').value.trim(), { range, sections });
      $('#share-url-display').textContent = result.url;
      $('#share-result').classList.remove('hidden');
      track('doctor_share_created');
    } catch (e) {
      track('doctor_share_failed');
      alert('Failed: ' + e.message);
    }
  });
  $('#share-copy').addEventListener('click', () => {
    const url = $('#share-url-display').textContent;
    navigator.clipboard.writeText(url).then(() => {
      $('#share-copy').textContent = 'Copied ✓';
      setTimeout(() => { $('#share-copy').textContent = 'Copy link'; }, 1500);
    });
  });
}

async function ensurePersisted() {
  if (navigator.storage && navigator.storage.persist) {
    try { await navigator.storage.persist(); } catch (e) {}
  }
}

async function checkForStaleBundle() {
  // Fetch the live HTML (no-store), parse the data.js?v=N param (every script tag shares one number), compare to ours.
  // If the server is serving a newer ?v= than we shipped with, the loaded JS is stale -> nuke and reload.
  try {
    const r = await fetch('/index.html', { cache: 'no-store' });
    if (!r.ok) return;
    const html = await r.text();
    const m = html.match(/data\.js\?v=(\d+)/);
    if (!m) return;
    const liveV = parseInt(m[1], 10);
    const myMatch = (document.currentScript && document.currentScript.src || '').match(/data\.js\?v=(\d+)/);
    const myV = myMatch ? parseInt(myMatch[1], 10) : null;
    // Fallback: scrape the actual <script> tag we came from.
    const tagSrc = (document.querySelector('script[src*="data.js"]') || {}).src || '';
    const tagMatch = tagSrc.match(/data\.js\?v=(\d+)/);
    const effective = myV != null ? myV : (tagMatch ? parseInt(tagMatch[1], 10) : null);
    if (effective != null && liveV > effective) {
      console.log(`[mgs] stale bundle (v${effective} -> v${liveV}); force-refresh`);
      await dropCachesAndReload();
    }
  } catch (_) {}
}

// Throw away every cached file and the service worker, then reload from the
// network. Used by the stale-bundle check and the "Force update" button.
async function dropCachesAndReload() {
  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
  } catch (_) {}
  window.location.reload();
}

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  let reloading = false;
  // Reload as soon as a new SW takes control so the user is on the latest code.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
  navigator.serviceWorker.register('sw.js').then(reg => {
    // Check for updates on every page load + when tab regains focus + every 30 min.
    reg.update().catch(() => {});
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
    });
    setInterval(() => reg.update().catch(() => {}), 30 * 60 * 1000);
  }).catch(() => {});
}
