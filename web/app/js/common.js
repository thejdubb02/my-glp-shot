// My GLP Shot — local-first PWA. All data lives in IndexedDB on this device.
// (DB name, sync protocol, and lookup_id derivation keep the original 'shotclock'
//  identifier so existing accounts and cached data continue working.)
'use strict';


// Umami event tracker. Aggregates only — no PII (no email, no IDs). Safe to call before umami loads.
function track(event, props) {
  try {
    if (typeof window === 'undefined' || typeof window.umami === 'undefined') return;
    if (props && typeof props === 'object') window.umami.track(event, props);
    else window.umami.track(event);
  } catch (_) { /* never let analytics break the app */ }
}

// ---------- Signup attribution ----------

function captureAttribution() {
  try {
    // First touch wins: whatever brought them here the first time is the answer,
    // even if they wander off and come back before creating the account.
    if (localStorage.getItem(ATTRIB_KEY)) { stripAttributionParams(); return; }
    const params = new URLSearchParams(location.search);
    const a = {};

    // mgs_ref is forwarded by the marketing site (attribution.js). Falling back
    // to document.referrer covers anyone who lands on the app directly.
    let ref = params.get('mgs_ref') || '';
    if (!ref && document.referrer) {
      try {
        const h = new URL(document.referrer).hostname.toLowerCase();
        if (h && h !== location.hostname) ref = h.startsWith('www.') ? h.slice(4) : h;
      } catch (_) { /* opaque referrer */ }
    }
    if (ref) a.referrer = ref.slice(0, 80);

    const lp = params.get('mgs_lp') || location.pathname;
    if (lp) a.landing = lp.slice(0, 80);
    for (const k of ATTRIB_UTM) {
      const v = params.get(k);
      if (v) a[k] = v.slice(0, 60);
    }
    if (Object.keys(a).length) localStorage.setItem(ATTRIB_KEY, JSON.stringify(a));
  } catch (_) { /* private mode, storage disabled — attribution is never worth an error */ }
  stripAttributionParams();
}

// Take the tracking params back out of the address bar once they're recorded, so
// a user copying the URL to a friend doesn't pass along someone else's source.
function stripAttributionParams() {
  try {
    const url = new URL(location.href);
    let touched = false;
    for (const k of ['mgs_ref', 'mgs_lp', ...ATTRIB_UTM]) {
      if (url.searchParams.has(k)) { url.searchParams.delete(k); touched = true; }
    }
    if (touched) history.replaceState(null, '', url.pathname + url.search + url.hash);
  } catch (_) {}
}

function getAttribution() {
  try {
    const raw = localStorage.getItem(ATTRIB_KEY);
    if (!raw) return null;
    const a = JSON.parse(raw);
    return (a && typeof a === 'object' && Object.keys(a).length) ? a : null;
  } catch (_) { return null; }
}

captureAttribution();


async function showInfo(key) {
  const topic = INFO_TOPICS[key];
  if (!topic) return;
  document.getElementById('info-dialog-title').textContent = topic.title;
  // body can be a static string or an async function — async lets us pull live values from settings/IDB.
  let body = topic.body;
  if (typeof body === 'function') {
    try { body = await body(); } catch (e) { console.warn('[mgs] info body fn failed:', e); body = topic.fallback || '<p>Could not load details.</p>'; }
  }
  document.getElementById('info-dialog-body').innerHTML = body;
  document.getElementById('info-dialog').showModal();
  track('info_opened', { topic: key });
}

function setupInfoButtons() {
  // Wire all (i) buttons that exist in the DOM. One delegated listener so dynamically-rendered (i) buttons also work.
  document.body.addEventListener('click', (e) => {
    const btn = e.target.closest('.info-btn[data-info]');
    if (!btn) return;
    e.preventDefault();
    showInfo(btn.dataset.info);
  });
  const closeBtn = document.getElementById('info-dialog-close');
  if (closeBtn) closeBtn.addEventListener('click', () => document.getElementById('info-dialog').close());
}


// Render the titration ladder for `medName` as tappable chips into `wrapSel`,
// filling `inputSel` when one is tapped. Hidden entirely when the medication
// has no ladder, so a custom peptide just gets the plain field.
function renderDoseChips(wrapSel, inputSel, medName) {
  const wrap = $(wrapSel);
  const input = $(inputSel);
  if (!wrap || !input) return;
  const preset = findMedPreset(medName);
  const ladder = (preset && preset.doses) || [];
  if (!ladder.length) { wrap.hidden = true; wrap.innerHTML = ''; return; }
  const current = parseFloat(input.value);
  wrap.dataset.target = inputSel;
  wrap.innerHTML = ladder.map(d =>
    `<button type="button" class="dose-chip${d === current ? ' active' : ''}" data-dose="${d}">${d} mg</button>`
  ).join('');
  wrap.hidden = false;
}

// One delegated listener for every chip row — the rows are re-rendered on each
// medication change, so per-button listeners would leak.
function setupDoseChips() {
  document.addEventListener('click', (e) => {
    const chip = e.target.closest ? e.target.closest('.dose-chip') : null;
    if (!chip) return;
    const wrap = chip.parentElement;
    const input = wrap && wrap.dataset.target ? $(wrap.dataset.target) : null;
    if (!input) return;
    input.value = chip.dataset.dose;
    // #set-dose persists on 'change'; the shot form reads the value on submit.
    input.dispatchEvent(new Event('change', { bubbles: true }));
    wrap.querySelectorAll('.dose-chip').forEach(c => c.classList.toggle('active', c === chip));
  });
  const med = $('#shot-med');
  if (med) med.addEventListener('input', () => renderDoseChips('#shot-dose-chips', '#shot-dose-amt', med.value));
}

function findMedPreset(name) {
  if (!name) return null;
  const n = name.trim().toLowerCase();
  return MED_PRESETS.find(p =>
    p.name.toLowerCase() === n ||
    p.brands.some(b => b.toLowerCase() === n)
  ) || null;
}
