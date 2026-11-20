// My GLP Shot: Next-shot countdown, shot list, site rotation and the shot dialog.
'use strict';

// ---------- Countdown / next shot ----------
function nextShotDate(lastWhen) {
  if (!lastWhen) return null;
  const d = new Date(lastWhen);
  d.setDate(d.getDate() + (settings.cadenceDays || 7));
  return d;
}
function renderCountdown(shots) {
  const card = document.querySelector('.countdown-card');
  const val = $('#countdown-value');
  const sub = $('#countdown-sub');
  if (!shots.length) {
    val.textContent = 'Log first';
    sub.textContent = 'Tap below to start';
    card.classList.remove('due');
    return;
  }
  const last = shots[0];
  const next = nextShotDate(last.when);
  const diff = next - new Date();
  if (diff <= 0) {
    const overdueMs = -diff;
    const days = Math.floor(overdueMs / 86400000);
    val.textContent = days > 0 ? `${days}d overdue` : 'Due now';
    sub.textContent = `Last: ${fmtDate(last.when)} · ${last.dose}mg`;
    card.classList.add('due');
    updateAppBadge(1);
  } else {
    const days = Math.floor(diff / 86400000);
    const hours = Math.floor((diff % 86400000) / 3600000);
    val.textContent = days > 0 ? `${days}d ${hours}h` : `${hours}h`;
    sub.textContent = `Due ${next.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
    card.classList.remove('due');
    updateAppBadge(0);
  }
}

// PWA Badge API — show a "1" on the installed-app icon when a shot is overdue.
// Silently no-ops on browsers that don't support it (Safari iOS as of 17.x).
function updateAppBadge(count) {
  try {
    if (count > 0 && 'setAppBadge' in navigator) {
      navigator.setAppBadge(count).catch(() => {});
    } else if ('clearAppBadge' in navigator) {
      navigator.clearAppBadge().catch(() => {});
    }
  } catch (e) { /* best-effort */ }
}

// ---------- Shot list rendering ----------
function shotItem(shot) {
  const li = document.createElement('li');
  li.dataset.id = shot.id;
  // Color intensity by dose: 1=<5, 2=5–7.4, 3=7.5–9.9, 4=10+
  let intensity = 1;
  if (shot.dose >= 10) intensity = 4;
  else if (shot.dose >= 7.5) intensity = 3;
  else if (shot.dose >= 5) intensity = 2;
  li.dataset.intensity = intensity;
  li.innerHTML = `
    <div>
      <div class="dose">${escapeHTML(shot.dose)} mg <span class="muted small">· ${escapeHTML(shot.med)}</span></div>
      <div class="meta">${escapeHTML(fmtDate(shot.when))}${shot.site ? ' · ' + escapeHTML(shot.site) : ''}</div>
    </div>
    <span class="meta">›</span>
  `;
  li.addEventListener('click', () => openShotDialog(shot));
  return li;
}
function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
async function renderShots() {
  const shots = await getShotsSorted();
  const weights = await getWeightsSorted();
  const recent = $('#recent-shots');
  const full = $('#full-history');
  recent.innerHTML = '';
  full.innerHTML = '';
  if (!shots.length) {
    $('#empty-shots').classList.remove('hidden');
  } else {
    $('#empty-shots').classList.add('hidden');
    shots.slice(0, 5).forEach(s => recent.appendChild(shotItem(s)));
    shots.forEach(s => full.appendChild(shotItem(s)));
  }
  renderCountdown(shots);
  renderCountdownRing(shots);
  // Deliberately not awaited: this now fetches the chart library on first use,
  // and the rest of the shot list should not wait on a network round-trip.
  renderLevelChart(shots).catch(e => console.warn('level chart failed', e));
  renderBodyDiagram(shots);
  renderDoseTimeline(shots);
  await renderSideEffectsSummary(shots);
  await renderHero(shots, weights);
  await renderBadges(shots, weights);
  try { await renderSupplies(shots); } catch (e) {}
  try { await renderCost(weights); } catch (e) {}
  try { await renderPlateau(weights, shots); } catch (e) {}
  try { await renderInsights(); } catch (e) {}
  try { await evaluateGuidanceTriggers(); } catch (e) {}
  return shots;
}

// ---------- Site rotation suggestion ----------
function suggestSite(shots) {
  const sites = ['Abdomen — Left', 'Abdomen — Right', 'Thigh — Left', 'Thigh — Right', 'Upper arm — Left', 'Upper arm — Right'];
  const used = {};
  for (const s of shots) {
    if (s.site && !(s.site in used)) used[s.site] = new Date(s.when);
  }
  let best = sites[0], bestTime = Infinity;
  for (const site of sites) {
    const t = used[site] ? used[site].getTime() : 0;
    if (t < bestTime) { bestTime = t; best = site; }
  }
  return best;
}

// ---------- Shot dialog ----------
function refreshCustomSiteOptgroup() {
  const grp = $('#shot-site-custom-group');
  if (!grp) return;
  const sel = $('#shot-site');
  // Strip prior options on re-open.
  Array.from(grp.querySelectorAll('option')).forEach(o => o.remove());
  const list = (settings.customSites || []).slice(-10);
  if (!list.length) { grp.hidden = true; return; }
  grp.hidden = false;
  for (const name of list) {
    const o = document.createElement('option');
    o.textContent = name;
    o.value = name;
    grp.appendChild(o);
  }
  sel.appendChild(grp);  // ensure it stays before __custom even if HTML order shifts
}

function setCustomRowVisible(visible) {
  const row = $('#shot-site-custom-row');
  if (!row) return;
  row.classList.toggle('hidden', !visible);
}

async function openShotDialog(shot) {
  const isEdit = !!shot;
  $('#shot-form-title').textContent = isEdit ? 'Edit Shot' : 'Log Shot';
  $('#shot-id').value = isEdit ? shot.id : '';
  $('#shot-med').value = shot ? shot.med : settings.medication;
  $('#shot-dose-amt').value = shot ? shot.dose : settings.defaultDose;
  renderDoseChips('#shot-dose-chips', '#shot-dose-amt', $('#shot-med').value);
  $('#shot-when').value = shot ? localISOForInput(new Date(shot.when)) : localISOForInput();
  refreshCustomSiteOptgroup();
  const initialSite = shot ? (shot.site || '') : (window._preferredNextSite || '');
  // If the saved site is neither a canonical option nor a remembered custom one, treat it as a freeform custom name.
  const sel = $('#shot-site');
  const knownInDropdown = !!initialSite && Array.from(sel.querySelectorAll('option')).some(o => o.value === initialSite || o.textContent === initialSite);
  if (initialSite && !knownInDropdown) {
    sel.value = '__custom';
    $('#shot-site-custom').value = initialSite;
    setCustomRowVisible(true);
  } else {
    sel.value = initialSite;
    $('#shot-site-custom').value = '';
    setCustomRowVisible(false);
  }
  $('#shot-notes').value = shot ? (shot.notes || '') : '';
  $('#shot-delete').classList.toggle('hidden', !isEdit);
  writeSideEffects(shot ? shot.sideEffects : null);
  if (!isEdit) window._preferredNextSite = null;

  const shots = await getShotsSorted();
  if (!isEdit) {
    const suggest = suggestSite(shots);
    $('#site-suggestion').textContent = `Suggested next site: ${suggest}`;
    if (!sel.value) sel.value = suggest;
  } else {
    $('#site-suggestion').textContent = '';
  }

  $('#shot-dialog').showModal();
}

// Critical UI listeners that must be attached even if IndexedDB / settings / SW init fail or hang.
// Wire these synchronously at script load time so bottom-nav and modal closes always work.
// Auth form state (used by both wireCriticalUI and the auth form handler).
let _authMode = 'signup';
function setAuthMode(m) {
  _authMode = m;
  document.querySelectorAll('#view-auth .auth-toggle-btn').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-auth-mode') === m);
  });
  const submit = document.getElementById('auth-submit');
  const help = document.getElementById('auth-help');
  const pw = document.getElementById('auth-pw');
  if (m === 'signup') {
    if (submit) submit.textContent = 'Create account & start free trial';
    if (help) help.textContent = 'Use a strong password. We encrypt your data with it before it ever leaves your device — if you forget it, your cloud copy is gone (data on each device is preserved).';
    if (pw) { pw.setAttribute('autocomplete', 'new-password'); pw.setAttribute('minlength', '8'); }
  } else {
    if (submit) submit.textContent = 'Sign in';
    if (help) help.textContent = 'Welcome back. Sign in to sync this device with your data.';
    if (pw) { pw.setAttribute('autocomplete', 'current-password'); pw.removeAttribute('minlength'); }
  }
  const err = document.getElementById('auth-err');
  if (err) err.textContent = '';
}
