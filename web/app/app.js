// My GLP Shot — local-first PWA. All data lives in IndexedDB on this device.
// (DB name, sync protocol, and lookup_id derivation keep the original 'shotclock'
//  identifier so existing accounts and cached data continue working.)
'use strict';

const DB_NAME = 'shotclock';
const DB_VERSION = 2;
const APP_VERSION = '0.16.0';
const STORES = { shots: 'shots', weights: 'weights', settings: 'settings', moods: 'moods' };
const SETTINGS_KEY = 'app';
const DEFAULT_SETTINGS = {
  medication: 'Tirzepatide',
  defaultDose: 5,
  cadenceDays: 7,
  halfLifeDays: 5,
  notify: false,
  notifyLeadMinutes: 60,
  theme: 'system',
  lastBackup: null,
  startWeight: null,
  goalWeight: null,
  achievements: [],
  syncEnabled: false,
  syncUsername: null,
  syncLastPushAt: null,
  syncLastPullAt: null,
  syncLastUpdatedAt: null,
  syncAutoPush: true,
  syncDirty: false,
};

const SIDE_EFFECTS = [
  ['nausea', 'Nausea'],
  ['heartburn', 'Heartburn'],
  ['fatigue', 'Fatigue'],
  ['headache', 'Headache'],
  ['constipation', 'Constipation'],
  ['diarrhea', 'Diarrhea'],
  ['injSiteReaction', 'Injection site reaction'],
  ['stomachPain', 'Stomach pain'],
  ['indigestion', 'Indigestion'],
  ['metallicTaste', 'Metallic taste'],
  ['moodSwings', 'Mood swings'],
  ['hairLoss', 'Hair loss'],
];
const SE_LEVELS = [['', 'None'], ['mild', 'Mild'], ['moderate', 'Moderate'], ['severe', 'Severe']];

const SITE_POSITIONS = {
  // x, y in viewBox 200x320; label
  'Upper arm — Left':  { x: 60,  y: 90,  short: 'L Arm' },
  'Upper arm — Right': { x: 140, y: 90,  short: 'R Arm' },
  'Abdomen — Left':    { x: 84,  y: 145, short: 'L Abd' },
  'Abdomen — Right':   { x: 116, y: 145, short: 'R Abd' },
  'Thigh — Left':      { x: 84,  y: 220, short: 'L Thigh' },
  'Thigh — Right':     { x: 116, y: 220, short: 'R Thigh' },
};

const ACHIEVEMENTS = [
  { id: 'first',     icon: '💉', label: 'First shot logged',          test: ({shots}) => shots.length >= 1 },
  { id: 'ten',       icon: '🔟', label: '10 shots',                    test: ({shots}) => shots.length >= 10 },
  { id: 'fifty',     icon: '✋', label: '50 shots',                    test: ({shots}) => shots.length >= 50 },
  { id: 'hundred',   icon: '💯', label: '100 shots',                   test: ({shots}) => shots.length >= 100 },
  { id: 'streak4',   icon: '🔥', label: '4-week streak',               test: ({streak}) => streak >= 4 },
  { id: 'streak12',  icon: '🚀', label: '12-week streak',              test: ({streak}) => streak >= 12 },
  { id: 'streak26',  icon: '🏆', label: '6-month streak',              test: ({streak}) => streak >= 26 },
  { id: 'streak52',  icon: '👑', label: '1-year streak',               test: ({streak}) => streak >= 52 },
  { id: 'lost5',     icon: '⭐', label: '5 lb lost',                   test: ({delta}) => delta <= -5 },
  { id: 'lost10',    icon: '🌟', label: '10 lb lost',                  test: ({delta}) => delta <= -10 },
  { id: 'lost25',    icon: '💫', label: '25 lb lost',                  test: ({delta}) => delta <= -25 },
  { id: 'lost50',    icon: '✨', label: '50 lb lost',                  test: ({delta}) => delta <= -50 },
  { id: 'titrate',   icon: '📈', label: 'Dose graduation',             test: ({maxDose, minDose}) => maxDose > minDose },
];

// ---------- IndexedDB helpers ----------
let _dbPromise = null;
function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORES.shots)) {
        const s = db.createObjectStore(STORES.shots, { keyPath: 'id', autoIncrement: true });
        s.createIndex('when', 'when');
      }
      if (!db.objectStoreNames.contains(STORES.weights)) {
        const s = db.createObjectStore(STORES.weights, { keyPath: 'id', autoIncrement: true });
        s.createIndex('date', 'date');
      }
      if (!db.objectStoreNames.contains(STORES.settings)) {
        db.createObjectStore(STORES.settings, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORES.moods)) {
        db.createObjectStore(STORES.moods, { keyPath: 'date' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}
async function withStore(store, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    const req = fn(s);
    if (req && 'onsuccess' in req) {
      req.onsuccess = () => { result = req.result; };
      req.onerror = () => reject(req.error);
    }
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
const dbAdd = (store, val) => withStore(store, 'readwrite', s => s.add(val));
const dbPut = (store, val) => withStore(store, 'readwrite', s => s.put(val));
const dbDel = (store, id) => withStore(store, 'readwrite', s => s.delete(id));
const dbAll = (store) => withStore(store, 'readonly', s => s.getAll());
const dbGet = (store, key) => withStore(store, 'readonly', s => s.get(key));

// ---------- Settings ----------
let settings = { ...DEFAULT_SETTINGS };
async function loadSettings() {
  const row = await dbGet(STORES.settings, SETTINGS_KEY);
  if (row && row.value) settings = { ...DEFAULT_SETTINGS, ...row.value };
}
async function saveSettings() {
  await dbPut(STORES.settings, { key: SETTINGS_KEY, value: settings });
}

// ---------- Utilities ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const fmtDate = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const fmtDateShort = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const localISOForInput = (d = new Date()) => {
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d - tz).toISOString().slice(0, 16);
};
const todayISODate = () => {
  const d = new Date();
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d - tz).toISOString().slice(0, 10);
};

// ---------- Views ----------
function showView(name) {
  $$('.view').forEach(v => v.classList.remove('active'));
  $('#view-' + name).classList.add('active');
  window.scrollTo(0, 0);
}

// Direct-manipulation tab filter. Hide/show sections by data-tab attr without
// relying on CSS class specificity (which has bitten us across SW cache + theme combos).
function setHomeTab(tab) {
  const home = document.getElementById('view-home');
  if (home) {
    home.querySelectorAll('[data-tab]').forEach(el => {
      el.style.display = (el.getAttribute('data-tab') === tab) ? '' : 'none';
    });
  }
  document.body.classList.remove('tab-home', 'tab-insights', 'tab-more');
  document.body.classList.add('tab-' + tab);
  const nav = document.getElementById('bottom-nav');
  if (nav) {
    nav.querySelectorAll('.nav-btn').forEach(b => {
      b.classList.toggle('active', b.getAttribute('data-nav-tab') === tab);
    });
  }
  window.scrollTo(0, 0);
}

// ---------- Data getters ----------
async function getShotsSorted() {
  const all = (await dbAll(STORES.shots)) || [];
  return all.sort((a, b) => new Date(b.when) - new Date(a.when));
}
async function getWeightsSorted() {
  const all = (await dbAll(STORES.weights)) || [];
  return all.sort((a, b) => new Date(a.date) - new Date(b.date));
}

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
  } else {
    const days = Math.floor(diff / 86400000);
    const hours = Math.floor((diff % 86400000) / 3600000);
    val.textContent = days > 0 ? `${days}d ${hours}h` : `${hours}h`;
    sub.textContent = `Due ${next.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
    card.classList.remove('due');
  }
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
      <div class="dose">${shot.dose} mg <span class="muted small">· ${escapeHTML(shot.med)}</span></div>
      <div class="meta">${fmtDate(shot.when)}${shot.site ? ' · ' + escapeHTML(shot.site) : ''}</div>
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
  renderLevelChart(shots);
  renderBodyDiagram(shots);
  renderHeatmap(shots);
  renderDoseTimeline(shots);
  renderSideEffectsSummary(shots);
  await renderHero(shots, weights);
  await renderBadges(shots, weights);
  try { await renderSupplies(shots); } catch (e) {}
  try { await renderCost(weights); } catch (e) {}
  try { await renderPlateau(weights, shots); } catch (e) {}
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
async function openShotDialog(shot) {
  const isEdit = !!shot;
  $('#shot-form-title').textContent = isEdit ? 'Edit Shot' : 'Log Shot';
  $('#shot-id').value = isEdit ? shot.id : '';
  $('#shot-med').value = shot ? shot.med : settings.medication;
  $('#shot-dose-amt').value = shot ? shot.dose : settings.defaultDose;
  $('#shot-when').value = shot ? localISOForInput(new Date(shot.when)) : localISOForInput();
  $('#shot-site').value = shot ? (shot.site || '') : (window._preferredNextSite || '');
  $('#shot-notes').value = shot ? (shot.notes || '') : '';
  $('#shot-delete').classList.toggle('hidden', !isEdit);
  writeSideEffects(shot ? shot.sideEffects : null);
  if (!isEdit) window._preferredNextSite = null;

  const shots = await getShotsSorted();
  if (!isEdit) {
    const suggest = suggestSite(shots);
    $('#site-suggestion').textContent = `Suggested next site: ${suggest}`;
    if (!$('#shot-site').value) $('#shot-site').value = suggest;
  } else {
    $('#site-suggestion').textContent = '';
  }

  $('#shot-dialog').showModal();
}

document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  applySettingsToInputs();
  await renderShots();
  await renderWeights();
  setInterval(async () => renderCountdown(await getShotsSorted()), 60000);

  $('#log-shot-btn').addEventListener('click', () => openShotDialog());
  $('#view-all-history').addEventListener('click', (e) => { e.preventDefault(); showView('history'); });
  $$('[data-back]').forEach(b => b.addEventListener('click', () => { showView('home'); setHomeTab('home'); }));

  // Bottom nav
  $$('#bottom-nav .nav-btn').forEach(btn => btn.addEventListener('click', () => {
    const tab = btn.getAttribute('data-nav-tab');
    if (tab === 'settings') {
      showView('settings');
      $$('#bottom-nav .nav-btn').forEach(b => b.classList.toggle('active', b === btn));
    } else {
      showView('home');
      setHomeTab(tab);
    }
  }));
  setHomeTab('home');

  $('#shot-cancel').addEventListener('click', () => $('#shot-dialog').close());
  $('#shot-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = $('#shot-id').value;
    const data = {
      med: $('#shot-med').value.trim() || 'Tirzepatide',
      dose: parseFloat($('#shot-dose-amt').value),
      when: new Date($('#shot-when').value).toISOString(),
      site: $('#shot-site').value || null,
      notes: $('#shot-notes').value.trim() || null,
      sideEffects: readSideEffects(),
    };
    if (id) data.id = parseInt(id, 10);
    await dbPut(STORES.shots, data);
    await ensurePersisted();
    $('#shot-dialog').close();
    await renderShots();
    maybeScheduleNotification();
    markSyncDirty();
  });
  $('#shot-delete').addEventListener('click', async () => {
    const id = parseInt($('#shot-id').value, 10);
    if (!id) return;
    if (!confirm('Delete this shot?')) return;
    await dbDel(STORES.shots, id);
    $('#shot-dialog').close();
    await renderShots();
    markSyncDirty();
  });

  $('#add-weight-btn').addEventListener('click', async () => {
    $('#weight-val').value = '';
    $('#weight-unit').value = (await getLastWeightUnit()) || 'lb';
    $('#weight-date').value = todayISODate();
    $('#weight-dialog').showModal();
  });
  $('#weight-cancel').addEventListener('click', () => $('#weight-dialog').close());
  $('#weight-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    await dbAdd(STORES.weights, {
      value: parseFloat($('#weight-val').value),
      unit: $('#weight-unit').value,
      date: $('#weight-date').value,
    });
    await ensurePersisted();
    $('#weight-dialog').close();
    await renderWeights();
    markSyncDirty();
  });

  $('#set-med').addEventListener('change', async (e) => { settings.medication = e.target.value.trim() || 'Tirzepatide'; await saveSettings(); });
  $('#set-dose').addEventListener('change', async (e) => { settings.defaultDose = parseFloat(e.target.value) || 0; await saveSettings(); });
  $('#set-cadence').addEventListener('change', async (e) => { settings.cadenceDays = parseInt(e.target.value, 10) || 7; await saveSettings(); await renderShots(); });
  $('#set-halflife').addEventListener('change', async (e) => { settings.halfLifeDays = parseFloat(e.target.value) || 5; await saveSettings(); await renderShots(); });
  $('#set-notify').addEventListener('change', async (e) => {
    if (e.target.checked) {
      const perm = await Notification.requestPermission();
      settings.notify = perm === 'granted';
      e.target.checked = settings.notify;
    } else {
      settings.notify = false;
    }
    await saveSettings();
    updateNotifyStatus();
    maybeScheduleNotification();
  });
  $('#set-lead').addEventListener('change', async (e) => {
    settings.notifyLeadMinutes = parseInt(e.target.value, 10) || 0;
    await saveSettings();
    maybeScheduleNotification();
  });
  $('#set-theme').addEventListener('change', async (e) => {
    settings.theme = e.target.value;
    await saveSettings();
    applyTheme();
  });
  $('#test-notify').addEventListener('click', sendTestNotification);
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  }
  window.addEventListener('pageshow', () => maybeScheduleNotification());

  $('#set-start-weight').addEventListener('change', async (e) => { settings.startWeight = e.target.value ? parseFloat(e.target.value) : null; await saveSettings(); await renderShots(); });
  $('#set-goal-weight').addEventListener('change', async (e) => { settings.goalWeight = e.target.value ? parseFloat(e.target.value) : null; await saveSettings(); await renderShots(); });

  // Mood picker
  $$('.mood-btn').forEach(btn => btn.addEventListener('click', async () => {
    const v = parseInt(btn.dataset.mood, 10);
    await saveMood(todayISODate(), v);
    delete $('#mood-card').dataset.editing;
    await renderMood();
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
  $('#wipe-btn').addEventListener('click', wipeAll);
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
  applyTimeOfDayGradient();
  setInterval(applyTimeOfDayGradient, 5 * 60 * 1000);
  setupPullToRefresh();
  setupAccountUI();
  setupReconCalc();
  setupSupplyUI();
  setupMeasurementUI();
  setupLabUI();
  setupShareUI();

  // Account restore on launch
  tryRestoreAccount().then(() => onAccountChanged()).catch(() => onAccountChanged());

  // Refresh premium-gated cards' rendering
  await renderSupplies(await getShotsSorted());
  await renderMeasurements();
  await renderLabs();
  await renderCost(await getWeightsSorted());
  await renderPlateau(await getWeightsSorted(), await getShotsSorted());
});

function applySettingsToInputs() {
  $('#set-med').value = settings.medication;
  $('#set-dose').value = settings.defaultDose;
  $('#set-cadence').value = settings.cadenceDays;
  $('#set-halflife').value = settings.halfLifeDays;
  if ($('#set-start-weight')) $('#set-start-weight').value = settings.startWeight ?? '';
  if ($('#set-goal-weight'))  $('#set-goal-weight').value = settings.goalWeight ?? '';
  $('#set-notify').checked = !!settings.notify && (typeof Notification !== 'undefined' && Notification.permission === 'granted');
  $('#set-lead').value = String(settings.notifyLeadMinutes ?? 60);
  $('#set-theme').value = settings.theme || 'system';
  applyTheme();
  updateNotifyStatus();
}

function applyTheme() {
  const t = settings.theme || 'system';
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem('theme', t); } catch(e){}
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    const dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    meta.setAttribute('content', dark ? '#0b1220' : '#0f766e');
  }
}

async function getLastWeightUnit() {
  const ws = await getWeightsSorted();
  return ws.length ? ws[ws.length - 1].unit : null;
}

// ---------- Charts ----------
let weightChart, levelChart;
async function renderWeights() {
  const ws = await getWeightsSorted();
  const shots = await getShotsSorted();
  await renderHero(shots, ws);
  const empty = $('#empty-weight');
  const ctx = $('#weight-chart');
  if (!ws.length) {
    empty.classList.remove('hidden');
    ctx.style.display = 'none';
    if (weightChart) { weightChart.destroy(); weightChart = null; }
    return;
  }
  empty.classList.add('hidden');
  ctx.style.display = 'block';
  const labels = ws.map(w => fmtDateShort(w.date));
  const data = ws.map(w => w.value);
  if (weightChart) weightChart.destroy();
  weightChart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets: [{ data, borderColor: '#0f766e', backgroundColor: 'rgba(20,184,166,.2)', tension: .3, fill: true, pointRadius: 3 }] },
    options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: false } } }
  });
}

function renderLevelChart(shots) {
  const ctx = $('#level-chart');
  if (!shots.length) {
    if (levelChart) { levelChart.destroy(); levelChart = null; }
    return;
  }
  const halfLife = settings.halfLifeDays || 5;
  const decay = Math.log(2) / halfLife;
  const now = new Date();
  const start = new Date(now); start.setDate(start.getDate() - 21);
  const end = new Date(now); end.setDate(end.getDate() + 7);
  const labels = [];
  const data = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    labels.push(d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
    let level = 0;
    for (const s of shots) {
      const sd = new Date(s.when);
      if (sd > d) continue;
      const days = (d - sd) / 86400000;
      level += s.dose * Math.exp(-decay * days);
    }
    data.push(parseFloat(level.toFixed(2)));
  }
  if (levelChart) levelChart.destroy();
  levelChart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets: [{ data, borderColor: '#14b8a6', backgroundColor: 'rgba(20,184,166,.25)', tension: .35, fill: true, pointRadius: 0 }] },
    options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, title: { display: true, text: 'mg-equivalent' } } } }
  });
}

// ---------- Export / Import ----------
async function exportData() {
  const shots = (await dbAll(STORES.shots)) || [];
  const weights = (await dbAll(STORES.weights)) || [];
  const blob = new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), settings, shots, weights }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `shotclock-${todayISODate()}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  settings.lastBackup = new Date().toISOString();
  await saveSettings();
  updateBackupLabel();
}
async function importData(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const isCSV = /\.csv$/i.test(file.name) || (!text.trim().startsWith('{') && text.includes(','));
    if (isCSV) {
      await importShotsyCSV(text);
    } else {
      const parsed = JSON.parse(text);
      if (!parsed || !Array.isArray(parsed.shots)) throw new Error('Invalid JSON file');
      if (!confirm(`Import ${parsed.shots.length} shots and ${(parsed.weights || []).length} weight entries? This will MERGE with existing data.`)) return;
      for (const s of parsed.shots) { delete s.id; await dbAdd(STORES.shots, s); }
      for (const w of (parsed.weights || [])) { delete w.id; await dbAdd(STORES.weights, w); }
      if (parsed.settings) { settings = { ...settings, ...parsed.settings }; await saveSettings(); applySettingsToInputs(); }
      await renderShots();
      await renderWeights();
      alert('Imported.');
    }
  } catch (err) {
    alert('Import failed: ' + err.message);
  }
  e.target.value = '';
}

// ---------- Shotsy CSV import ----------
// Parses CSV with full RFC-4180 quoting (handles embedded newlines and double-quote escapes).
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++;
    } else {
      if (c === '"') { inQuotes = true; i++; continue; }
      if (c === ',') { row.push(field); field = ''; i++; continue; }
      if (c === '\r') { i++; continue; }
      if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
      field += c; i++;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Maps Shotsy site labels to My GLP Shot site labels.
function mapShotsySite(s) {
  if (!s) return null;
  const t = s.trim().toLowerCase();
  const map = {
    'left arm': 'Upper arm — Left',
    'right arm': 'Upper arm — Right',
    'upper arm left': 'Upper arm — Left',
    'upper arm right': 'Upper arm — Right',
    'left thigh': 'Thigh — Left',
    'right thigh': 'Thigh — Right',
    'left abdomen': 'Abdomen — Left',
    'right abdomen': 'Abdomen — Right',
    'abdomen left': 'Abdomen — Left',
    'abdomen right': 'Abdomen — Right',
    'left stomach': 'Abdomen — Left',
    'right stomach': 'Abdomen — Right',
  };
  return map[t] || s.trim();
}

// Parses Shotsy "Shot" cell, e.g. "Tirzepatide 5.0 mg" → { med: 'Tirzepatide', dose: 5.0 }
function parseShotCell(s) {
  if (!s || !s.trim()) return null;
  const m = s.trim().match(/^(.+?)\s+([\d.]+)\s*mg\b/i);
  if (!m) return { med: s.trim(), dose: 0 };
  return { med: m[1].trim(), dose: parseFloat(m[2]) };
}

async function importShotsyCSV(text) {
  const rows = parseCSV(text);
  if (rows.length < 2) throw new Error('CSV is empty or malformed');
  const header = rows[0].map(h => h.trim().toLowerCase());
  const colIdx = (name) => header.indexOf(name.toLowerCase());
  const cDate = colIdx('date');
  const cShot = colIdx('shot');
  const cTime = colIdx('time');
  const cSite = colIdx('site');
  const cShotNotes = colIdx('shot notes');
  const cPain = colIdx('pain level');
  const cWeight = header.findIndex(h => h.startsWith('recorded weight'));
  const cDayNotes = colIdx('day notes');
  if (cDate < 0) throw new Error('CSV missing required "Date" column — is this a tracker export?');

  const shotsToAdd = [];
  const weightsToAdd = [];

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length === 0) continue;
    const date = (row[cDate] || '').trim();
    if (!date) continue;

    // Shot cells can contain multiple shots separated by newlines (multi-shot day in Shotsy export)
    const shotCells = (cShot >= 0 ? (row[cShot] || '').split('\n') : []).map(s => s.trim()).filter(Boolean);
    const timeCells = (cTime >= 0 ? (row[cTime] || '').split('\n') : []).map(s => s.trim());
    const siteCells = (cSite >= 0 ? (row[cSite] || '').split('\n') : []).map(s => s.trim());
    const notesCells = (cShotNotes >= 0 ? (row[cShotNotes] || '').split('\n') : []).map(s => s.trim());
    const painCells = (cPain >= 0 ? (row[cPain] || '').split('\n') : []).map(s => s.trim());

    for (let k = 0; k < shotCells.length; k++) {
      const parsed = parseShotCell(shotCells[k]);
      if (!parsed) continue;
      const time = timeCells[k] || timeCells[0] || '00:00';
      const when = new Date(`${date}T${time.length === 5 ? time : (time.padStart(5, '0'))}:00`);
      if (isNaN(when.getTime())) continue;
      const noteParts = [];
      if (notesCells[k]) noteParts.push(notesCells[k]);
      const dayNote = cDayNotes >= 0 ? (row[cDayNotes] || '').trim() : '';
      if (dayNote && k === 0) noteParts.push(dayNote);
      const pain = painCells[k] || painCells[0];
      if (pain && parseFloat(pain) > 0) noteParts.push(`Pain: ${pain}/10`);
      shotsToAdd.push({
        med: parsed.med,
        dose: parsed.dose,
        when: when.toISOString(),
        site: mapShotsySite(siteCells[k] || siteCells[0]),
        notes: noteParts.join(' · ') || null,
      });
    }

    if (cWeight >= 0) {
      const w = (row[cWeight] || '').trim();
      if (w && !isNaN(parseFloat(w))) {
        weightsToAdd.push({ value: parseFloat(w), unit: 'lb', date });
      }
    }
  }

  // Dedupe: identical when+med+dose collapsed to a single record (Shotsy's export sometimes lists a shot twice).
  const seen = new Set();
  const dedupedShots = shotsToAdd.filter(s => {
    const k = `${s.when}|${s.med}|${s.dose}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const seenW = new Set();
  const dedupedWeights = weightsToAdd.filter(w => {
    const k = `${w.date}|${w.value}|${w.unit}`;
    if (seenW.has(k)) return false;
    seenW.add(k);
    return true;
  });

  if (!dedupedShots.length && !dedupedWeights.length) {
    throw new Error('No shots or weight entries found in CSV');
  }
  if (!confirm(`Import ${dedupedShots.length} shots and ${dedupedWeights.length} weight entries? This will MERGE with existing data.`)) return;

  for (const s of dedupedShots) await dbAdd(STORES.shots, s);
  for (const w of dedupedWeights) await dbAdd(STORES.weights, w);
  await ensurePersisted();
  await renderShots();
  await renderWeights();
  alert(`Imported ${shotsToAdd.length} shots and ${weightsToAdd.length} weight entries.`);
}
function updateBackupLabel() {
  const el = $('#last-backup');
  if (!el) return;
  if (settings.lastBackup) {
    const d = new Date(settings.lastBackup);
    const days = Math.floor((Date.now() - d) / 86400000);
    el.textContent = `Last backup: ${d.toLocaleDateString()} (${days}d ago)` + (days > 14 ? ' — consider exporting again' : '');
  } else {
    el.textContent = 'No backup yet — export to download a JSON file.';
  }
}

// ---------- Wipe ----------
async function wipeAll() {
  if (!confirm('This will delete ALL shots, weights, and settings on this device. Are you sure?')) return;
  if (!confirm('Really erase everything? This cannot be undone.')) return;
  _dbPromise = null;
  indexedDB.deleteDatabase(DB_NAME);
  setTimeout(() => location.reload(), 300);
}

// ---------- ICS calendar feed ----------
async function downloadICS() {
  const shots = await getShotsSorted();
  if (!shots.length) { alert('Log a shot first to generate a recurring reminder.'); return; }
  const last = shots[0];
  const next = nextShotDate(last.when);
  const dt = (d) => d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//MyGLPShot//EN',
    'BEGIN:VEVENT',
    `UID:shotclock-${Date.now()}@willhitestrategy.org`,
    `DTSTAMP:${dt(new Date())}`,
    `DTSTART:${dt(next)}`,
    `DTEND:${dt(new Date(next.getTime() + 15 * 60000))}`,
    `SUMMARY:${settings.medication} shot due`,
    `DESCRIPTION:Time for your ${settings.defaultDose}mg ${settings.medication} shot.`,
    `RRULE:FREQ=DAILY;INTERVAL=${settings.cadenceDays || 7}`,
    'BEGIN:VALARM',
    'TRIGGER:-PT30M',
    'ACTION:DISPLAY',
    'DESCRIPTION:Shot reminder',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const blob = new Blob([ics], { type: 'text/calendar' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'shotclock-reminder.ics';
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

// ---------- Notifications ----------
// Strategy:
//   1. Notification Triggers API (Chrome/Edge, esp. installed Android PWA) → real scheduled push, fires when app is closed.
//   2. Fallback: setTimeout while app is open (any browser).
//   3. iOS PWA: requestPermission works on iOS 16.4+ when installed to home screen. Triggers API not supported, but iOS reschedules our SW periodically; we re-schedule in `pageshow` so reminders work when user opens the app.

let notifyTimer = null;
const TRIGGERS_SUPPORTED = (typeof window !== 'undefined') && ('Notification' in window) && ('showTrigger' in Notification.prototype || (typeof TimestampTrigger !== 'undefined'));

async function maybeScheduleNotification() {
  if (notifyTimer) { clearTimeout(notifyTimer); notifyTimer = null; }
  if (!settings.notify) return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;

  const shots = await getShotsSorted();
  if (!shots.length) return;
  const next = nextShotDate(shots[0].when);
  const lead = (settings.notifyLeadMinutes || 0) * 60000;
  const fireAt = new Date(next.getTime() - lead);
  const ms = fireAt - new Date();
  if (ms > 86400000 * 30) return; // don't schedule more than 30d out

  const title = 'My GLP Shot';
  const body = lead > 0
    ? `Your ${settings.medication} shot is due in ${humanLead(lead)}.`
    : `${settings.medication} shot is due now.`;
  const tag = `shot-${next.toISOString()}`;

  // Path 1: Notification Triggers API via service worker
  if (TRIGGERS_SUPPORTED && 'serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.ready;
      // Clear prior scheduled to avoid duplicates
      const existing = await reg.getNotifications({ includeTriggered: true });
      existing.forEach(n => { if (n.tag && n.tag.startsWith('shot-')) n.close(); });
      if (ms > 0) {
        await reg.showNotification(title, {
          body, tag, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png',
          showTrigger: new TimestampTrigger(fireAt.getTime()),
          data: { url: '/shotclock/' },
        });
        return;
      }
    } catch (e) { /* fall through to setTimeout */ }
  }

  // Path 2: setTimeout (works while app is open)
  if (ms <= 0) return;
  if (ms > 86400000 * 14) return;
  notifyTimer = setTimeout(async () => {
    if ('serviceWorker' in navigator) {
      try {
        const reg = await navigator.serviceWorker.ready;
        await reg.showNotification(title, { body, tag, icon: 'icons/icon-192.png', data: { url: '/shotclock/' } });
        return;
      } catch (e) {}
    }
    new Notification(title, { body, icon: 'icons/icon-192.png' });
  }, ms);
}

function humanLead(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h !== 1 ? 's' : ''}`;
  const d = Math.round(h / 24);
  return `${d} day${d !== 1 ? 's' : ''}`;
}

function updateNotifyStatus() {
  const el = $('#notify-status');
  if (!el) return;
  const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  if (typeof Notification === 'undefined') {
    el.textContent = 'Notifications not supported in this browser.'; return;
  }
  if (Notification.permission === 'denied') {
    el.textContent = 'Notifications blocked. Enable them in browser settings to receive shot reminders.'; return;
  }
  if (isIOS && !standalone) {
    el.textContent = 'On iOS, install My GLP Shot to your Home Screen first — notifications only work for installed PWAs.'; return;
  }
  if (TRIGGERS_SUPPORTED) {
    el.textContent = settings.notify ? '✓ Reminders scheduled (work when app is closed).' : 'Toggle on for scheduled push reminders.';
  } else {
    el.textContent = settings.notify ? '✓ Reminders enabled. Open the app at least once between shots so it can re-schedule.' : 'Toggle on to enable reminders.';
  }
}

async function sendTestNotification() {
  if (typeof Notification === 'undefined') { alert('Not supported'); return; }
  if (Notification.permission !== 'granted') {
    const p = await Notification.requestPermission();
    if (p !== 'granted') { alert('Permission not granted'); return; }
  }
  const title = 'My GLP Shot test';
  const body = 'Notifications are working. Real reminders fire before each shot.';
  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification(title, { body, icon: 'icons/icon-192.png', data: { url: '/shotclock/' } });
      return;
    } catch (e) {}
  }
  new Notification(title, { body, icon: 'icons/icon-192.png' });
}

// ---------- Install prompt (iOS + Android + Desktop) ----------
let deferredInstallPrompt = null;

function detectPlatform() {
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isSafari = isIOS && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
  const isAndroid = /Android/.test(ua);
  const isMobile = isIOS || isAndroid;
  return { isIOS, isSafari, isAndroid, isMobile };
}

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function showInstallDialog() {
  const dlg = $('#install-dialog');
  if (!dlg) return;
  $('#install-ios').classList.add('hidden');
  $('#install-ios-other').classList.add('hidden');
  $('#install-android').classList.add('hidden');
  $('#install-desktop').classList.add('hidden');
  const p = detectPlatform();
  if (p.isIOS && p.isSafari) $('#install-ios').classList.remove('hidden');
  else if (p.isIOS && !p.isSafari) $('#install-ios-other').classList.remove('hidden');
  else if (p.isAndroid) $('#install-android').classList.remove('hidden');
  else $('#install-desktop').classList.remove('hidden');
  dlg.showModal();
}

function setupInstallBanner() {
  // Capture Android/Chrome/Edge install event whenever it fires.
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
  });
  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    localStorage.setItem('installDismissed', '1');
    const dlg = $('#install-dialog');
    if (dlg && dlg.open) dlg.close();
    const card = $('#install-card');
    if (card) card.classList.add('hidden');
  });

  // Hide the Settings install card if already installed.
  if (isStandalone()) {
    const card = $('#install-card');
    if (card) card.classList.add('hidden');
  }

  // Wire dialog buttons.
  $('#install-dismiss').addEventListener('click', () => {
    localStorage.setItem('installDismissedAt', String(Date.now()));
    $('#install-dialog').close();
  });
  $('#install-android-btn').addEventListener('click', async () => {
    if (!deferredInstallPrompt) {
      // Fallback: tell user to use the menu.
      $('#install-android-btn').disabled = true;
      $('#install-android-btn').textContent = 'Use ⋮ menu → Install app';
      return;
    }
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    if (outcome === 'accepted') $('#install-dialog').close();
  });
  $('#show-install-prompt').addEventListener('click', () => {
    if (isStandalone()) {
      alert('Already installed! 🎉');
      return;
    }
    showInstallDialog();
  });

  // Auto-show once: after user is signed in and has logged at least one shot or 30 seconds in.
  // Skip if: standalone, dismissed within last 7 days, or auth gate is active.
  const dismissedAt = parseInt(localStorage.getItem('installDismissedAt') || '0', 10);
  const dismissedRecently = dismissedAt && (Date.now() - dismissedAt) < 7 * 86400 * 1000;
  if (!isStandalone() && !dismissedRecently && !document.body.classList.contains('auth-active')) {
    setTimeout(() => {
      if (isStandalone()) return;
      if (document.body.classList.contains('auth-active')) return;
      if (document.querySelector('#install-dialog').open) return;
      showInstallDialog();
    }, 8000);
  }
}

async function markSyncDirty() {
  if (account.user && account.encryptionKey) {
    // Account-based sync: auto-push debounced
    clearTimeout(window._syncDebounce);
    window._syncDebounce = setTimeout(() => { accountSyncPush().catch(() => {}); }, 30000);
    return;
  }
  if (!syncCreds || !settings.syncEnabled || !settings.syncAutoPush) return;
  settings.syncDirty = true;
  await saveSettings();
}

// ----- Setup helpers -----
function setupAccountUI() {
  $('#show-signup').addEventListener('click', () => openAccountDialog('signup'));
  $('#show-login').addEventListener('click', () => openAccountDialog('login'));
  $('#acct-banner-cta').addEventListener('click', () => openAccountDialog('signup'));
  $('#acct-banner-dismiss').addEventListener('click', () => {
    localStorage.setItem('acct.banner.dismissed', '1');
    $('#account-banner').classList.add('hidden');
  });
  $('#legacy-migrate-cta').addEventListener('click', () => openAccountDialog('signup'));
  $('#legacy-migrate-dismiss').addEventListener('click', () => $('#legacy-migrate-banner').classList.add('hidden'));
  $('#account-form').addEventListener('submit', handleAccountSubmit);

  // Fullscreen auth gate (shown when no account on device)
  let authMode = 'signup';
  const setAuthMode = (m) => {
    authMode = m;
    $$('#view-auth .auth-toggle-btn').forEach(b => b.classList.toggle('active', b.getAttribute('data-auth-mode') === m));
    const pwInput = $('#auth-pw');
    if (m === 'signup') {
      $('#auth-submit').textContent = 'Create account & start free trial';
      $('#auth-help').textContent = 'Use a strong password. We encrypt your data with it before it ever leaves your device — if you forget it, your cloud copy is gone (data on each device is preserved).';
      pwInput.setAttribute('autocomplete', 'new-password');
      pwInput.setAttribute('minlength', '8');
    } else {
      $('#auth-submit').textContent = 'Sign in';
      $('#auth-help').textContent = 'Welcome back. Sign in to sync this device with your data.';
      pwInput.setAttribute('autocomplete', 'current-password');
      pwInput.removeAttribute('minlength');
    }
    $('#auth-err').textContent = '';
  };
  $$('#view-auth .auth-toggle-btn').forEach(btn => btn.addEventListener('click', () => setAuthMode(btn.getAttribute('data-auth-mode'))));
  $('#auth-forgot').addEventListener('click', (e) => { e.preventDefault(); $('#forgot-dialog').showModal(); });
  $('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('#auth-email').value.trim();
    const pw = $('#auth-pw').value;
    const err = $('#auth-err');
    const submit = $('#auth-submit');
    err.textContent = '';
    submit.disabled = true;
    submit.textContent = authMode === 'signup' ? 'Creating account…' : 'Signing in…';
    try {
      if (authMode === 'signup') await accountSignup(email, pw);
      else await accountLogin(email, pw);
      await onAccountChanged();
      // Pull cloud data on login (signup uploads local, login fetches remote)
      if (authMode === 'login') {
        try { await accountSyncPull(); } catch(e) { /* fresh account / no remote yet */ }
      } else {
        try { await accountSyncPush(); } catch(e) { /* tolerate */ }
      }
      await renderShots();
      await renderWeights();
      setHomeTab('home');
    } catch (ex) {
      err.textContent = ex.message || 'Something went wrong.';
    } finally {
      submit.disabled = false;
      setAuthMode(authMode);
    }
  });
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
    await accountLogout(true);
    onAccountChanged();
  });
  $('#upgrade-cta').addEventListener('click', () => { $('#upgrade-error').textContent = ''; $('#upgrade-dialog').showModal(); });
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

  // Handle Stripe Checkout return.
  (function handleBillingReturn() {
    const sp = new URLSearchParams(window.location.search);
    const billing = sp.get('billing');
    if (!billing) return;
    sp.delete('billing'); sp.delete('session_id');
    const cleanUrl = window.location.pathname + (sp.toString() ? '?' + sp.toString() : '') + window.location.hash;
    window.history.replaceState({}, '', cleanUrl);
    if (billing === 'success') {
      // Webhook is async — give it a moment then refresh /me.
      setTimeout(() => accountMe().then(onAccountChanged).catch(() => {}), 1500);
      setTimeout(() => alert('🎉 Welcome to Premium! Your 14-day trial just started.'), 100);
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
}

function setupSupplyUI() {
  $('#add-supply-btn').addEventListener('click', () => {
    if (!isPremium() && account.user) { $('#upgrade-dialog').showModal(); return; }
    openSupplyDialog(null);
  });
  $('#supply-cancel').addEventListener('click', () => $('#supply-dialog').close());
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
      used_mg: 0,
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
      const result = await createShareLink($('#share-label').value.trim());
      $('#share-url-display').textContent = result.url;
      $('#share-result').classList.remove('hidden');
    } catch (e) {
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
  // Fetch the live HTML (no-store), parse the app.js?v=N param, compare to ours.
  // If the server is serving a newer ?v= than we shipped with, the loaded JS is stale -> nuke and reload.
  try {
    const r = await fetch('/index.html', { cache: 'no-store' });
    if (!r.ok) return;
    const html = await r.text();
    const m = html.match(/app\.js\?v=(\d+)/);
    if (!m) return;
    const liveV = parseInt(m[1], 10);
    const myMatch = (document.currentScript && document.currentScript.src || '').match(/app\.js\?v=(\d+)/);
    const myV = myMatch ? parseInt(myMatch[1], 10) : null;
    // Fallback: scrape the actual <script> tag we came from.
    const tagSrc = (document.querySelector('script[src*="app.js"]') || {}).src || '';
    const tagMatch = tagSrc.match(/app\.js\?v=(\d+)/);
    const effective = myV != null ? myV : (tagMatch ? parseInt(tagMatch[1], 10) : null);
    if (effective != null && liveV > effective) {
      console.log(`[mgs] stale bundle (v${effective} -> v${liveV}); force-refresh`);
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
  } catch (_) {}
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

// ============================================================================
// Visuals — hero, ring, body diagram, heatmap, dose timeline, side effects,
// mood, achievements, confetti, polish.
// ============================================================================

// ---------- Mood store (daily) ----------
async function getMoodsSorted() {
  const all = (await dbAll(STORES.moods)) || [];
  return all.sort((a, b) => a.date.localeCompare(b.date));
}
async function saveMood(date, value) {
  await dbPut(STORES.moods, { date, value });
}

// ---------- Stats helpers ----------
function computeStreak(shots, cadenceDays) {
  // Count consecutive cadence cycles from latest backwards. A "cycle" = a shot
  // logged within cadenceDays + 2 grace days of the previous one.
  if (!shots || !shots.length) return 0;
  const sorted = [...shots].sort((a,b) => new Date(b.when) - new Date(a.when));
  const grace = (cadenceDays + 2) * 86400000;
  // First, ensure most recent shot is within grace of now
  if (new Date() - new Date(sorted[0].when) > grace) return 0;
  let streak = 1;
  for (let i = 1; i < sorted.length; i++) {
    const gap = new Date(sorted[i-1].when) - new Date(sorted[i].when);
    if (gap <= grace) streak++;
    else break;
  }
  return streak;
}

function weightDelta(weights, startOverride) {
  if (!weights || weights.length < 1) return null;
  const start = startOverride != null ? parseFloat(startOverride) : weights[0].value;
  const current = weights[weights.length - 1].value;
  return { start, current, delta: current - start };
}

// ---------- Hero card ----------
async function renderHero(shots, weights) {
  const card = $('#hero-card');
  if (!shots.length && !weights.length) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  const wd = weightDelta(weights, settings.startWeight);
  const deltaEl = $('#hero-weight-delta');
  if (wd) {
    const sign = wd.delta < 0 ? '−' : '+';
    deltaEl.textContent = `${sign}${Math.abs(wd.delta).toFixed(1)} lb`;
    deltaEl.classList.toggle('gain', wd.delta > 0);
  } else {
    deltaEl.textContent = '—';
  }
  const streak = computeStreak(shots, settings.cadenceDays || 7);
  $('#hero-streak').textContent = streak || '0';
  $('#hero-shots').textContent = shots.length;

  // Goal progress
  const goal = parseFloat(settings.goalWeight);
  if (wd && goal && goal < wd.start) {
    const total = wd.start - goal;
    const done = wd.start - wd.current;
    const pct = Math.max(0, Math.min(100, (done / total) * 100));
    $('#hero-goal-fill').style.width = pct + '%';
    $('#hero-goal-text').textContent = `Goal: ${goal} lb · ${pct.toFixed(0)}% there (${(wd.current - goal).toFixed(1)} lb to go)`;
    $('#hero-goal-wrap').classList.remove('hidden');
  } else {
    $('#hero-goal-wrap').classList.add('hidden');
  }
}

// ---------- Countdown ring ----------
function renderCountdownRing(shots) {
  const ring = $('.countdown-ring-progress');
  if (!ring) return;
  const C = 2 * Math.PI * 28; // ~175.93
  if (!shots.length) { ring.style.strokeDashoffset = C; return; }
  const last = new Date(shots[0].when);
  const next = nextShotDate(shots[0].when);
  const now = new Date();
  const total = next - last;
  const elapsed = Math.max(0, Math.min(total, now - last));
  const frac = total > 0 ? elapsed / total : 0;
  ring.style.strokeDashoffset = C * (1 - frac);
}

// ---------- Body diagram ----------
function renderBodyDiagram(shots) {
  const wrap = $('#body-diagram-wrap');
  if (!wrap) return;
  const recencyMs = {};
  for (const s of shots) {
    if (!s.site) continue;
    const t = new Date(s.when).getTime();
    if (!(s.site in recencyMs) || recencyMs[s.site] < t) recencyMs[s.site] = t;
  }
  const now = Date.now();
  function colorFor(site) {
    if (!(site in recencyMs)) return { fill: 'transparent', stroke: '#0f766e', label: 'unused' };
    const days = (now - recencyMs[site]) / 86400000;
    if (days < 7)  return { fill: '#fb923c', stroke: '#c2410c', label: 'recent' }; // avoid
    if (days < 14) return { fill: '#0d9488', stroke: '#0f766e', label: 'medium' };
    return { fill: '#5eead4', stroke: '#14b8a6', label: 'fresh' };
  }
  // Build SVG: simplified front silhouette, viewBox 200x320
  const sites = Object.entries(SITE_POSITIONS).map(([name, pos]) => {
    const c = colorFor(name);
    const days = recencyMs[name] ? Math.floor((now - recencyMs[name]) / 86400000) : null;
    const tip = days == null ? `${name} · unused` : `${name} · ${days}d ago`;
    return `<g class="body-site" data-site="${name}"><title>${tip}</title>
      <circle cx="${pos.x}" cy="${pos.y}" r="9" fill="${c.fill}" stroke="${c.stroke}" stroke-width="2"></circle>
      <text x="${pos.x}" y="${pos.y + 22}">${pos.short}</text>
    </g>`;
  }).join('');

  wrap.innerHTML = `
    <svg class="body-svg" viewBox="0 0 200 320" xmlns="http://www.w3.org/2000/svg">
      <!-- head -->
      <ellipse class="body-shape" cx="100" cy="32" rx="22" ry="26" />
      <!-- neck -->
      <rect class="body-shape" x="92" y="55" width="16" height="10" rx="3" />
      <!-- torso -->
      <path class="body-shape" d="M 70 65 Q 70 60 78 60 L 122 60 Q 130 60 130 65 L 138 130 Q 140 175 130 200 L 70 200 Q 60 175 62 130 Z" />
      <!-- left arm -->
      <path class="body-shape" d="M 70 70 L 50 75 Q 42 78 40 90 L 38 145 Q 38 160 46 162 L 56 160 Q 62 155 64 145 L 70 95 Z" />
      <!-- right arm -->
      <path class="body-shape" d="M 130 70 L 150 75 Q 158 78 160 90 L 162 145 Q 162 160 154 162 L 144 160 Q 138 155 136 145 L 130 95 Z" />
      <!-- left leg -->
      <path class="body-shape" d="M 78 200 L 70 290 Q 70 300 78 302 L 92 302 Q 98 300 98 290 L 95 200 Z" />
      <!-- right leg -->
      <path class="body-shape" d="M 122 200 L 130 290 Q 130 300 122 302 L 108 302 Q 102 300 102 290 L 105 200 Z" />
      ${sites}
    </svg>
  `;
  // Site click → suggest as next shot site if user opens dialog
  wrap.querySelectorAll('.body-site').forEach(g => {
    g.addEventListener('click', () => {
      const name = g.getAttribute('data-site');
      $('#site-suggest-label').textContent = `Tap "+ Log" to start a shot at ${name}`;
      window._preferredNextSite = name;
    });
  });
  // Legend
  $('#site-legend').innerHTML = `
    <span><span class="swatch unused"></span>Unused</span>
    <span><span class="swatch fresh"></span>2+ weeks</span>
    <span><span class="swatch medium"></span>1–2 weeks</span>
    <span><span class="swatch recent"></span>This week</span>
  `;
}

// ---------- Calendar heatmap ----------
function renderHeatmap(shots) {
  const wrap = $('#heatmap-wrap');
  if (!wrap) return;
  // Build day → max dose map for last 365 days
  const byDay = {};
  for (const s of shots) {
    const d = new Date(s.when);
    const tz = d.getTimezoneOffset() * 60000;
    const key = new Date(d - tz).toISOString().slice(0, 10);
    byDay[key] = Math.max(byDay[key] || 0, s.dose || 0);
  }
  const today = new Date();
  const todayKey = todayISODate();
  // Start 53 weeks back, anchor to Sunday
  const startDay = new Date(today);
  startDay.setDate(startDay.getDate() - 365);
  // Adjust to nearest prior Sunday
  startDay.setDate(startDay.getDate() - startDay.getDay());
  const cells = [];
  const cur = new Date(startDay);
  let totalShots = 0;
  while (cur <= today) {
    const tz = cur.getTimezoneOffset() * 60000;
    const key = new Date(cur - tz).toISOString().slice(0, 10);
    const dose = byDay[key] || 0;
    let lvl = '';
    if (dose > 0) totalShots++;
    if (dose >= 12.5) lvl = 'l4';
    else if (dose >= 7.5) lvl = 'l3';
    else if (dose >= 5)   lvl = 'l2';
    else if (dose > 0)    lvl = 'l1';
    const today_attr = key === todayKey ? ' today' : '';
    cells.push(`<div class="heatmap-cell ${lvl}${today_attr}" title="${key}${dose ? ' · ' + dose + ' mg' : ''}"></div>`);
    cur.setDate(cur.getDate() + 1);
  }
  wrap.innerHTML = `<div class="heatmap-grid">${cells.join('')}</div>`;
  $('#heatmap-summary').textContent = `${totalShots} shots in 12 months`;
}

// ---------- Dose timeline strip ----------
function renderDoseTimeline(shots) {
  const wrap = $('#dose-timeline-wrap');
  if (!wrap) { return; }
  if (!shots.length) { wrap.innerHTML = ''; return; }
  const sorted = [...shots].sort((a,b) => new Date(a.when) - new Date(b.when));
  const minT = new Date(sorted[0].when).getTime();
  const maxT = Date.now();
  const span = Math.max(maxT - minT, 86400000);
  // Build segments per dose run
  const segments = [];
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i];
    const end = i + 1 < sorted.length ? new Date(sorted[i+1].when).getTime() : maxT;
    const start = new Date(s.when).getTime();
    const last = segments[segments.length - 1];
    if (last && last.dose === s.dose) { last.end = end; }
    else { segments.push({ dose: s.dose, start, end }); }
  }
  const maxDose = Math.max(...segments.map(s => s.dose), 1);
  wrap.innerHTML = segments.map(seg => {
    const left = ((seg.start - minT) / span) * 100;
    const width = Math.max(2, ((seg.end - seg.start) / span) * 100);
    const intensity = 0.4 + 0.6 * (seg.dose / maxDose);
    return `<div class="dose-segment" style="left:${left}%;width:${width}%;opacity:${intensity}" title="${seg.dose} mg">${seg.dose}</div>`;
  }).join('') + `<div class="muted small" style="position:absolute;left:0;bottom:-2px;font-size:.7rem">Dose timeline</div>`;
}

// ---------- Side effects ----------
function renderSideEffectsForm() {
  const wrap = $('#shot-side-effects');
  if (!wrap) return;
  wrap.innerHTML = SIDE_EFFECTS.map(([key, label]) =>
    `<div class="se-row"><label for="se-${key}">${label}</label>
       <select id="se-${key}" data-se="${key}">${SE_LEVELS.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select></div>`
  ).join('');
}
function readSideEffects() {
  const obj = {};
  for (const [key] of SIDE_EFFECTS) {
    const v = $('#se-' + key)?.value;
    if (v) obj[key] = v;
  }
  return Object.keys(obj).length ? obj : null;
}
function writeSideEffects(se) {
  for (const [key] of SIDE_EFFECTS) {
    const el = $('#se-' + key);
    if (el) el.value = (se && se[key]) || '';
  }
}
function renderSideEffectsSummary(shots) {
  const cutoff = Date.now() - 30 * 86400000;
  const counts = {};
  for (const s of shots) {
    if (new Date(s.when).getTime() < cutoff) continue;
    if (!s.sideEffects) continue;
    for (const [k, lvl] of Object.entries(s.sideEffects)) {
      counts[k] = counts[k] || { mild: 0, moderate: 0, severe: 0 };
      if (counts[k][lvl] != null) counts[k][lvl]++;
    }
  }
  const entries = Object.entries(counts).sort((a, b) => {
    const ts = (c) => c.severe * 4 + c.moderate * 2 + c.mild;
    return ts(b[1]) - ts(a[1]);
  });
  const labelOf = (k) => (SIDE_EFFECTS.find(s => s[0] === k) || [k, k])[1];
  const wrap = $('#side-effects-summary');
  const empty = $('#empty-side-effects');
  if (!entries.length) { wrap.innerHTML = ''; empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');
  wrap.innerHTML = entries.map(([k, c]) => {
    const total = c.mild + c.moderate + c.severe;
    const cls = c.severe > 0 ? 'severe' : '';
    const dots = '●'.repeat(Math.min(3, c.severe)) + '◐'.repeat(Math.min(3, c.moderate)) + '○'.repeat(Math.min(3, c.mild));
    return `<span class="se-pill ${cls}"><span class="se-count">${total}</span>${labelOf(k)} <span class="muted small">${dots}</span></span>`;
  }).join('');
}

// ---------- Mood widget ----------
const MOOD_LABELS = { 1: 'Awful', 2: 'Low', 3: 'Okay', 4: 'Good', 5: 'Great' };
const MOOD_SVG = {
  1: '<circle cx="16" cy="16" r="14" class="mood-bg"/><circle cx="11" cy="13" r="1.5" class="mood-eye"/><circle cx="21" cy="13" r="1.5" class="mood-eye"/><path d="M10 22 Q16 17 22 22" fill="none" class="mood-mouth"/>',
  2: '<circle cx="16" cy="16" r="14" class="mood-bg"/><circle cx="11" cy="13" r="1.5" class="mood-eye"/><circle cx="21" cy="13" r="1.5" class="mood-eye"/><path d="M11 21 Q16 18 21 21" fill="none" class="mood-mouth"/>',
  3: '<circle cx="16" cy="16" r="14" class="mood-bg"/><circle cx="11" cy="13" r="1.5" class="mood-eye"/><circle cx="21" cy="13" r="1.5" class="mood-eye"/><line x1="11" y1="20" x2="21" y2="20" class="mood-mouth"/>',
  4: '<circle cx="16" cy="16" r="14" class="mood-bg"/><circle cx="11" cy="13" r="1.5" class="mood-eye"/><circle cx="21" cy="13" r="1.5" class="mood-eye"/><path d="M10 19 Q16 24 22 19" fill="none" class="mood-mouth"/>',
  5: '<circle cx="16" cy="16" r="14" class="mood-bg"/><path d="M9 12 Q11 11 13 12" fill="none" class="mood-eye-arc"/><path d="M19 12 Q21 11 23 12" fill="none" class="mood-eye-arc"/><path d="M9 18 Q16 26 23 18 Z" class="mood-mouth-fill"/>',
};

async function renderMood() {
  const today = todayISODate();
  const moods = await getMoodsSorted();
  const todayMood = moods.find(m => m.date === today);
  $$('.mood-btn').forEach(b => b.classList.toggle('selected', todayMood && +b.dataset.mood === todayMood.value));
  // Collapse the picker once today is logged. User can tap "change" to bring it back.
  const card = $('#mood-card');
  const picker = $('#mood-picker');
  const logged = $('#mood-logged');
  const saved = $('#mood-saved');
  const heading = $('#mood-heading');
  if (todayMood && !card.dataset.editing) {
    picker.classList.add('hidden');
    logged.classList.remove('hidden');
    $('#mood-logged-svg').innerHTML = MOOD_SVG[todayMood.value] || '';
    $('#mood-logged-svg').classList.toggle('mood-positive', todayMood.value >= 4);
    $('#mood-logged-svg').classList.toggle('mood-negative', todayMood.value <= 2);
    $('#mood-logged-label').textContent = MOOD_LABELS[todayMood.value] || 'Logged';
    heading.textContent = "Today's mood";
    saved.textContent = '';
  } else {
    picker.classList.remove('hidden');
    logged.classList.add('hidden');
    heading.textContent = 'How are you feeling today?';
    saved.textContent = todayMood ? '✓ saved' : '';
  }
  await renderMoodTrend(moods);
}

async function renderMoodTrend(moods) {
  const card = $('#mood-trend-card');
  if (!card) return;
  if (!moods || moods.length === 0) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  const days = 30;
  const today = new Date();
  const byDate = new Map(moods.map(m => [m.date, m.value]));
  const bars = [];
  let sum = 0, count = 0;
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const tz = d.getTimezoneOffset() * 60000;
    const iso = new Date(d - tz).toISOString().slice(0, 10);
    const v = byDate.get(iso);
    if (v != null) { sum += v; count++; }
    bars.push({ iso, v });
  }
  const html = bars.map(b => {
    if (b.v == null) return `<div class="mood-bar empty" title="${b.iso}: not logged"></div>`;
    return `<div class="mood-bar v${b.v}" style="height:${20 + b.v * 16}%" title="${b.iso}: ${MOOD_LABELS[b.v]}"></div>`;
  }).join('');
  $('#mood-trend-bars').innerHTML = html;
  const avg = count ? (sum / count) : null;
  if (avg != null) {
    const lab = avg >= 4.2 ? 'mostly great' : avg >= 3.5 ? 'mostly good' : avg >= 2.5 ? 'mixed' : avg >= 1.6 ? 'mostly low' : 'tough stretch';
    $('#mood-trend-summary').textContent = `${count} of last ${days} days · ${lab}`;
  } else {
    $('#mood-trend-summary').textContent = '';
  }
}

// ---------- Achievements ----------
function computeStats(shots, weights) {
  const wd = weightDelta(weights, settings.startWeight);
  const delta = wd ? wd.delta : 0;
  const streak = computeStreak(shots, settings.cadenceDays || 7);
  const doses = shots.map(s => s.dose).filter(d => d > 0);
  return {
    shots,
    streak,
    delta,
    maxDose: doses.length ? Math.max(...doses) : 0,
    minDose: doses.length ? Math.min(...doses) : 0,
  };
}
async function renderBadges(shots, weights) {
  const stats = computeStats(shots, weights);
  const card = $('#badges-card');
  const list = $('#badges-list');
  const unlocked = ACHIEVEMENTS.filter(a => a.test(stats));
  if (!unlocked.length && !shots.length) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  list.innerHTML = unlocked.map(a => `<div class="badge unlocked"><span class="badge-icon">${a.icon}</span><span class="badge-label">${a.label}</span></div>`).join('');

  // Detect newly unlocked → confetti
  const prev = new Set(settings.achievements || []);
  const newly = unlocked.filter(a => !prev.has(a.id));
  if (newly.length) {
    settings.achievements = unlocked.map(a => a.id);
    await saveSettings();
    fireConfetti();
  }
}

// ---------- Confetti ----------
function fireConfetti() {
  const colors = ['#14b8a6', '#0f766e', '#5eead4', '#fb923c', '#fde68a'];
  const root = document.body;
  for (let i = 0; i < 36; i++) {
    const piece = document.createElement('div');
    piece.className = 'confetti-piece';
    piece.style.background = colors[i % colors.length];
    piece.style.left = (50 + (Math.random() - 0.5) * 30) + 'vw';
    piece.style.top = '40vh';
    piece.style.setProperty('--x', ((Math.random() - 0.5) * 320) + 'px');
    piece.style.animationDelay = (Math.random() * 0.2) + 's';
    root.appendChild(piece);
    setTimeout(() => piece.remove(), 2200);
  }
}

// ---------- Day/night gradient swap ----------
function applyTimeOfDayGradient() {
  const card = document.querySelector('.countdown-card');
  if (!card) return;
  const h = new Date().getHours();
  const isNight = h < 6 || h >= 20;
  card.style.setProperty('--grad-hour-shift', isNight ? '-12%' : '0%');
  // night-mode countdown card gets a deeper tint
  if (isNight) card.classList.add('night'); else card.classList.remove('night');
}

// ---------- Pull-to-refresh ----------
function setupPullToRefresh() {
  let startY = 0, pulling = false, indicator = null;
  document.addEventListener('touchstart', (e) => {
    if (window.scrollY > 0) return;
    startY = e.touches[0].clientY;
    pulling = true;
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (!pulling) return;
    const dy = e.touches[0].clientY - startY;
    if (dy > 60) {
      if (!indicator) {
        indicator = document.createElement('div');
        indicator.className = 'ptr-indicator show';
        indicator.textContent = '↻ Release to sync';
        document.body.appendChild(indicator);
      }
    }
  }, { passive: true });
  document.addEventListener('touchend', async () => {
    if (indicator) {
      indicator.textContent = 'Syncing…';
      try { if (syncCreds && settings.syncEnabled) await syncPushNow(); } catch (e) {}
      setTimeout(() => { indicator?.remove(); indicator = null; }, 600);
    }
    pulling = false;
  });
}

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
  account = { user: j.user, encryptionKey: creds.aesKey };
  rememberSignedIn(creds.email, creds.aesKey);
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
  account = { user: j.user, encryptionKey: creds.aesKey };
  rememberSignedIn(creds.email, creds.aesKey);
  return j.user;
}

async function accountLogout(forgetDevice) {
  try { await accountFetch('logout', { method: 'POST' }); } catch (e) {}
  account = { user: null, encryptionKey: null };
  if (forgetDevice) clearRememberedSignIn();
}

async function accountForgot(email) {
  const r = await accountFetch('forgot', { method: 'POST', body: JSON.stringify({ email }) });
  return r.ok;
}

async function accountMe() {
  const r = await accountFetch('me');
  if (!r.ok) return null;
  const j = await r.json();
  return j.user;
}

function isPremium() {
  return !!(account.user && account.user.isPremium);
}

// Persist the derived AES encryption key (NOT the password) for session restore.
// XSS can still steal this key, but it can't steal a password the user may have reused elsewhere.
// The auth_token (server-side bcrypt-hashed) is never persisted; the session cookie is the auth credential.
async function rememberSignedIn(email, aesKey) {
  try {
    const raw = await crypto.subtle.exportKey('raw', aesKey);
    const b64 = btoa(String.fromCharCode(...new Uint8Array(raw)));
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

async function importStoredAesKey(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', true, ['encrypt', 'decrypt']);
}

async function tryRestoreAccount() {
  const user = await accountMe();
  if (!user) return false;
  account.user = user;
  const remembered = getRememberedSignIn();
  if (remembered && remembered.email && remembered.k) {
    try {
      account.encryptionKey = await importStoredAesKey(remembered.k);
    } catch (e) {}
  }
  return true;
}

async function accountSyncPush() {
  if (!account.user || !account.encryptionKey) throw new Error('Not unlocked');
  const payload = await buildPayload();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, account.encryptionKey, new TextEncoder().encode(JSON.stringify(payload)));
  const body = { iv: btoa(String.fromCharCode(...iv)), ciphertext: btoa(String.fromCharCode(...new Uint8Array(ct))) };
  const r = await accountFetch('me/sync', { method: 'PUT', body: JSON.stringify(body) });
  if (!r.ok) throw new Error('Sync failed: ' + r.status);
  const j = await r.json();
  settings.syncLastPushAt = new Date().toISOString();
  settings.syncLastUpdatedAt = j.updatedAt;
  await saveSettings();
  return j;
}

async function accountSyncPull() {
  if (!account.user || !account.encryptionKey) throw new Error('Not unlocked');
  const r = await accountFetch('me/sync');
  if (!r.ok) throw new Error('Pull failed: ' + r.status);
  const j = await r.json();
  if (!j.exists) return null;
  const iv = Uint8Array.from(atob(j.iv), c => c.charCodeAt(0));
  const ct = Uint8Array.from(atob(j.ciphertext), c => c.charCodeAt(0));
  let pt;
  try {
    pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, account.encryptionKey, ct);
  } catch (e) {
    throw new Error('Decryption failed — wrong password');
  }
  return { payload: JSON.parse(new TextDecoder().decode(pt)), updatedAt: j.updatedAt };
}

async function accountSyncDelete() {
  if (account.user) await accountFetch('me/sync', { method: 'DELETE' });
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
    // After signup or login, prompt to push local data if any exists
    const shots = (await dbAll(STORES.shots)) || [];
    if (shots.length && account.encryptionKey) {
      try { await accountSyncPush(); } catch (e) {}
    }
    // After login, attempt pull
    if (mode === 'login' && account.encryptionKey) {
      try {
        const result = await accountSyncPull();
        if (result && shots.length === 0) {
          await applyPulledPayload(result.payload);
        } else if (result && shots.length > 0) {
          if (confirm(`Cloud copy has ${(result.payload.shots || []).length} shots. Replace local data with cloud copy?`)) {
            await applyPulledPayload(result.payload);
          }
        }
      } catch (e) {}
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
  // Legacy users (with old `sync.creds`) bypass the gate so we don't lock them out — they can use the migrate banner to upgrade.
  const hasLegacyCreds = !!localStorage.getItem('sync.creds');
  if (!u && !hasLegacyCreds) {
    document.body.classList.add('auth-active');
    $$('.view').forEach(v => v.classList.remove('active'));
    $('#view-auth').classList.add('active');
  } else {
    document.body.classList.remove('auth-active');
    if ($('#view-auth').classList.contains('active')) {
      $('#view-auth').classList.remove('active');
      $('#view-home').classList.add('active');
    }
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
    $('#upgrade-cta').classList.toggle('hidden', isPremium());
    $('#manage-billing-cta').classList.toggle('hidden', !u.hasStripeCustomer);
  } else {
    $('#account-signed-out').classList.remove('hidden');
    $('#account-signed-in').classList.add('hidden');
    pill.classList.add('hidden');
    if (localStorage.getItem('acct.banner.dismissed') !== '1') {
      banner.classList.remove('hidden');
    }
  }
  // Show legacy migration banner if user has legacy creds and isn't signed in to new account
  const hasLegacy = !!localStorage.getItem('sync.creds');
  $('#legacy-migrate-banner').classList.toggle('hidden', !hasLegacy || !!u);
  applyPremiumGates();
}

function subscriptionStatusText(u) {
  if (!u) return '';
  if (u.subscriptionStatus === 'lifetime') return '⭐ Lifetime Premium — thank you for being a founding supporter!';
  if (u.subscriptionStatus === 'premium' && u.premiumUntil) {
    const d = new Date(u.premiumUntil * 1000).toLocaleDateString();
    return `Premium until ${d}`;
  }
  if (u.subscriptionStatus === 'trial' && u.trialEndsAt) {
    const days = Math.max(0, Math.ceil((u.trialEndsAt - Date.now() / 1000) / 86400));
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

// ----- Reconstitution calculator -----
function renderReconCalc() {
  const vial = parseFloat($('#recon-vial').value);
  const water = parseFloat($('#recon-water').value);
  const dose = parseFloat($('#recon-dose').value);
  const out = $('#recon-output');
  out.classList.remove('error');
  if (!vial || !water || !dose || vial <= 0 || water <= 0 || dose <= 0) {
    out.classList.add('error');
    out.textContent = 'Enter vial total, water volume, and desired dose.';
    return;
  }
  if (dose > vial) {
    out.classList.add('error');
    out.textContent = `Desired dose (${dose} mg) exceeds vial total (${vial} mg).`;
    return;
  }
  const concentration = vial / water;        // mg/mL
  const drawMl = dose / concentration;       // mL to draw
  const drawUnits100 = drawMl * 100;         // units on 100u/1mL syringe
  const drawUnits50 = drawMl * 100;          // 50u syringe = same units, just smaller scale
  const dosesInVial = Math.floor(vial / dose);
  out.innerHTML = `
    <div class="recon-result"><span>Concentration</span><strong>${concentration.toFixed(2)} mg/mL</strong></div>
    <div class="recon-result"><span>Draw volume</span><strong>${drawMl.toFixed(3)} mL</strong></div>
    <div class="recon-result"><span>Units (100u syringe)</span><strong>${drawUnits100.toFixed(0)} u</strong></div>
    <div class="recon-result"><span>Doses in this vial</span><strong>${dosesInVial}</strong></div>
  `;
  // Save preset
  try { localStorage.setItem('recon.preset', JSON.stringify({ vial, water, dose })); } catch (e) {}
}

function setupReconCalc() {
  // Restore preset
  try {
    const p = JSON.parse(localStorage.getItem('recon.preset') || 'null');
    if (p) {
      if (p.vial != null) $('#recon-vial').value = p.vial;
      if (p.water != null) $('#recon-water').value = p.water;
      if (p.dose != null) $('#recon-dose').value = p.dose;
    }
  } catch (e) {}
  ['#recon-vial', '#recon-water', '#recon-dose'].forEach(sel => {
    $(sel).addEventListener('input', renderReconCalc);
  });
  renderReconCalc();
}

// ----- Supply tracking (premium) -----
async function ensureStore(name, opts) {
  const db = await openDB();
  if (!db.objectStoreNames.contains(name)) {
    db.close();
    _dbPromise = null;
    await new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, db.version + 1);
      r.onupgradeneeded = (e) => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains(name)) d.createObjectStore(name, opts || { keyPath: 'id', autoIncrement: true });
      };
      r.onsuccess = () => { r.result.close(); resolve(); };
      r.onerror = () => reject(r.error);
    });
  }
}

async function getSupplies() {
  await ensureStore('supplies');
  const all = await new Promise((res) => {
    openDB().then(db => {
      const t = db.transaction('supplies', 'readonly');
      const r = t.objectStore('supplies').getAll();
      r.onsuccess = () => res(r.result || []);
      r.onerror = () => res([]);
    });
  });
  return all.sort((a, b) => (a.expires_at || '').localeCompare(b.expires_at || ''));
}

async function saveSupply(s) {
  await ensureStore('supplies');
  const db = await openDB();
  return new Promise((res, rej) => {
    const t = db.transaction('supplies', 'readwrite');
    t.objectStore('supplies').put(s);
    t.oncomplete = res;
    t.onerror = () => rej(t.error);
  });
}

async function deleteSupply(id) {
  const db = await openDB();
  return new Promise((res) => {
    const t = db.transaction('supplies', 'readwrite');
    t.objectStore('supplies').delete(id);
    t.oncomplete = res;
  });
}

async function renderSupplies(shots) {
  const list = $('#supply-list');
  const empty = $('#supply-empty');
  if (!list) return;
  const supplies = await getSupplies();
  if (!supplies.length) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  // Compute usage from shots
  const usedMg = shots.reduce((sum, s) => sum + (s.dose || 0), 0);
  list.innerHTML = supplies.map(s => {
    const today = new Date(); today.setHours(0,0,0,0);
    const exp = s.expires_at ? new Date(s.expires_at) : null;
    const daysToExpire = exp ? Math.floor((exp - today) / 86400000) : null;
    const dosesLeft = s.last_dose_mg ? Math.floor((s.total_mg - s.used_mg) / s.last_dose_mg) : null;
    const pctUsed = s.total_mg ? Math.min(100, (s.used_mg / s.total_mg) * 100) : 0;
    let cls = '';
    if (daysToExpire != null) {
      if (daysToExpire < 0) cls = 'expired';
      else if (daysToExpire < 7) cls = 'expiring';
    }
    const expireText = daysToExpire != null
      ? (daysToExpire < 0 ? `⚠️ Expired ${Math.abs(daysToExpire)}d ago` : `Expires in ${daysToExpire}d`)
      : 'No expiration set';
    return `<li class="${cls}" data-id="${s.id}">
      <div class="supply-name">${escapeHTML(s.type === 'pen' ? '💉 Pen' : '🧪 Vial')} · ${s.total_mg} mg ${s.volume_ml ? '· ' + s.volume_ml + ' mL' : ''}</div>
      <div class="supply-meta">${escapeHTML(s.pharmacy || 'Unknown source')}${s.batch ? ' · Lot ' + escapeHTML(s.batch) : ''}${s.cost ? ' · $' + s.cost : ''}</div>
      <div class="supply-meta">${expireText}${dosesLeft != null ? ' · ~' + dosesLeft + ' doses left' : ''}</div>
      <div class="supply-progress"><div class="supply-fill" style="width:${pctUsed.toFixed(0)}%"></div></div>
    </li>`;
  }).join('');
  list.querySelectorAll('li').forEach(li => {
    li.addEventListener('click', () => openSupplyDialog(supplies.find(x => x.id == li.dataset.id)));
  });
}

function openSupplyDialog(s) {
  const isEdit = !!s;
  $('#supply-form-title').textContent = isEdit ? 'Edit supply' : 'Add supply';
  $('#supply-id').value = isEdit ? s.id : '';
  $('#supply-type').value = s ? s.type : 'vial';
  $('#supply-total-mg').value = s ? s.total_mg : '';
  $('#supply-volume-ml').value = s ? (s.volume_ml || '') : '';
  $('#supply-pharmacy').value = s ? (s.pharmacy || '') : '';
  $('#supply-batch').value = s ? (s.batch || '') : '';
  $('#supply-cost').value = s ? (s.cost || '') : '';
  $('#supply-opened').value = s ? (s.opened_at || '') : todayISODate();
  $('#supply-expires').value = s ? (s.expires_at || '') : '';
  $('#supply-delete').classList.toggle('hidden', !isEdit);
  $('#supply-dialog').showModal();
}

// ----- Body measurements (premium) -----
async function getMeasurements() {
  await ensureStore('measurements');
  return new Promise((res) => {
    openDB().then(db => {
      const t = db.transaction('measurements', 'readonly');
      const r = t.objectStore('measurements').getAll();
      r.onsuccess = () => res((r.result || []).sort((a, b) => a.date.localeCompare(b.date)));
      r.onerror = () => res([]);
    });
  });
}

async function saveMeasurement(m) {
  await ensureStore('measurements');
  const db = await openDB();
  return new Promise((res, rej) => {
    const t = db.transaction('measurements', 'readwrite');
    t.objectStore('measurements').put(m);
    t.oncomplete = res; t.onerror = () => rej(t.error);
  });
}

async function renderMeasurements() {
  const wrap = $('#measurement-summary');
  const empty = $('#measurements-empty');
  if (!wrap) return;
  const ms = await getMeasurements();
  if (!ms.length) { wrap.innerHTML = ''; empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');
  // Group by type → latest + delta from oldest
  const byType = {};
  for (const m of ms) {
    if (!byType[m.type]) byType[m.type] = [];
    byType[m.type].push(m);
  }
  const labels = { waist: 'Waist', hips: 'Hips', chest: 'Chest', thigh: 'Thigh', arm: 'Arm', neck: 'Neck' };
  wrap.innerHTML = Object.entries(byType).map(([type, vals]) => {
    const latest = vals[vals.length - 1];
    const earliest = vals[0];
    const delta = latest.value - earliest.value;
    const trendCls = delta < 0 ? 'down' : delta > 0 ? 'up' : '';
    const sign = delta < 0 ? '−' : '+';
    return `<div class="summary-pill">
      <span class="summary-label">${labels[type] || type}</span>
      <span class="summary-value">${latest.value} ${latest.unit}</span>
      ${vals.length > 1 ? `<span class="summary-trend ${trendCls}">${sign}${Math.abs(delta).toFixed(1)}</span>` : ''}
    </div>`;
  }).join('');
}

// ----- Lab tracking (premium) -----
const LAB_LABELS = {
  a1c: ['A1c', '%', { good_max: 5.7, watch_max: 6.5 }],
  glucose_fasting: ['Fasting glucose', 'mg/dL', { good_max: 100, watch_max: 126 }],
  bp_systolic: ['BP systolic', 'mmHg', { good_max: 120, watch_max: 140 }],
  bp_diastolic: ['BP diastolic', 'mmHg', { good_max: 80, watch_max: 90 }],
  cholesterol_total: ['Total chol.', 'mg/dL', { good_max: 200, watch_max: 240 }],
  cholesterol_hdl: ['HDL', 'mg/dL', null],
  cholesterol_ldl: ['LDL', 'mg/dL', { good_max: 100, watch_max: 160 }],
  triglycerides: ['Triglycerides', 'mg/dL', { good_max: 150, watch_max: 200 }],
  alt: ['ALT', 'U/L', { good_max: 40 }],
};

async function getLabs() {
  await ensureStore('labs');
  return new Promise((res) => {
    openDB().then(db => {
      const t = db.transaction('labs', 'readonly');
      const r = t.objectStore('labs').getAll();
      r.onsuccess = () => res((r.result || []).sort((a, b) => a.date.localeCompare(b.date)));
      r.onerror = () => res([]);
    });
  });
}

async function saveLab(l) {
  await ensureStore('labs');
  const db = await openDB();
  return new Promise((res, rej) => {
    const t = db.transaction('labs', 'readwrite');
    t.objectStore('labs').put(l);
    t.oncomplete = res; t.onerror = () => rej(t.error);
  });
}

async function renderLabs() {
  const wrap = $('#lab-summary');
  const empty = $('#labs-empty');
  if (!wrap) return;
  const ls = await getLabs();
  if (!ls.length) { wrap.innerHTML = ''; empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');
  const byType = {};
  for (const l of ls) {
    if (!byType[l.type]) byType[l.type] = [];
    byType[l.type].push(l);
  }
  wrap.innerHTML = Object.entries(byType).map(([type, vals]) => {
    const latest = vals[vals.length - 1];
    const earliest = vals[0];
    const delta = latest.value - earliest.value;
    const [label, unit] = LAB_LABELS[type] || [type, ''];
    const trendCls = delta < 0 ? 'down' : delta > 0 ? 'up' : '';
    const sign = delta < 0 ? '−' : '+';
    return `<div class="summary-pill">
      <span class="summary-label">${label}</span>
      <span class="summary-value">${latest.value} ${unit}</span>
      ${vals.length > 1 ? `<span class="summary-trend ${trendCls}">${sign}${Math.abs(delta).toFixed(1)}</span>` : ''}
    </div>`;
  }).join('');
}

// ----- Cost tracker (premium) -----
async function renderCost(weights) {
  const wrap = $('#cost-summary');
  if (!wrap) return;
  const supplies = await getSupplies();
  const totalCost = supplies.reduce((sum, s) => sum + (parseFloat(s.cost) || 0), 0);
  const monthsSinceFirst = supplies.length ? Math.max(1, Math.ceil((Date.now() - new Date(supplies[supplies.length - 1].opened_at || Date.now())) / (30 * 86400000))) : 0;
  const wd = weightDelta(weights, settings.startWeight);
  const lostLb = wd && wd.delta < 0 ? Math.abs(wd.delta) : 0;
  const dollarsPerLb = lostLb > 0 ? (totalCost / lostLb).toFixed(2) : '—';
  if (!supplies.length || !totalCost) {
    wrap.innerHTML = '<p class="muted small">Add supplies with cost to track spending and $/lb lost.</p>';
    return;
  }
  wrap.innerHTML = `
    <div class="summary-pill"><span class="summary-label">Total spent</span><span class="summary-value">$${totalCost.toFixed(2)}</span></div>
    ${monthsSinceFirst ? `<div class="summary-pill"><span class="summary-label">Per month</span><span class="summary-value">$${(totalCost / monthsSinceFirst).toFixed(2)}</span></div>` : ''}
    ${lostLb > 0 ? `<div class="summary-pill"><span class="summary-label">$ per lb lost</span><span class="summary-value">$${dollarsPerLb}</span></div>` : ''}
  `;
}

// ----- Plateau detection (premium) -----
function detectPlateau(weights, shots) {
  if (weights.length < 8) return null;
  const recent = weights.slice(-30);
  if (recent.length < 8) return null;
  const fourWeeksAgo = Date.now() - 28 * 86400000;
  const inWindow = recent.filter(w => new Date(w.date).getTime() >= fourWeeksAgo);
  if (inWindow.length < 4) return null;
  const first = inWindow[0].value;
  const last = inWindow[inWindow.length - 1].value;
  const delta = last - first;
  if (Math.abs(delta) > 1) return null; // not a plateau
  // Check no recent dose increase
  const recentShotsInWindow = shots.filter(s => new Date(s.when).getTime() >= fourWeeksAgo);
  const doses = recentShotsInWindow.map(s => s.dose);
  const allSame = doses.length === 0 || doses.every(d => d === doses[0]);
  if (!allSame) return null;
  const dose = doses[0] || (shots.length ? shots[0].dose : null);
  return { weeks: 4, dose, delta: delta.toFixed(1) };
}

async function renderPlateau(weights, shots) {
  const card = $('#plateau-card');
  const body = $('#plateau-body');
  if (!card) return;
  if (!isPremium()) { card.classList.add('hidden'); return; }
  const p = detectPlateau(weights, shots);
  if (!p) { card.classList.add('hidden'); return; }
  body.innerHTML = `<p>Weight has stayed within 1 lb for ~${p.weeks} weeks at ${p.dose}mg.</p>
    <p class="muted small">This is normal — most people experience plateaus during titration. Consider:
    discussing a dose increase with your prescriber, reviewing protein intake (aim for 1g per lb of goal weight),
    walking 8-10K steps/day, and ensuring you're eating in a sustainable deficit.</p>
    <p class="muted small">Educational only. Not medical advice.</p>`;
  card.classList.remove('hidden');
}

// ----- PDF report (client-side print) -----
async function exportPDFReport() {
  if (!isPremium()) { $('#upgrade-dialog').showModal(); return; }
  const w = window.open('', '_blank');
  if (!w) { alert('Please allow popups to generate the PDF.'); return; }
  const shots = await getShotsSorted();
  const weights = await getWeightsSorted();
  const measurements = await getMeasurements();
  const labs = await getLabs();
  const wd = weightDelta(weights, settings.startWeight);
  const since = new Date(); since.setDate(since.getDate() - 90);
  const rShots = shots.filter(s => new Date(s.when) >= since);
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>My GLP Shot Report</title>
    <style>
      body{font-family:-apple-system,Arial,sans-serif;color:#0f172a;margin:30px;line-height:1.5}
      h1,h2{color:#0f766e;margin-bottom:6px}
      .meta{color:#64748b;font-size:.85rem;margin-bottom:18px}
      table{border-collapse:collapse;width:100%;margin:10px 0;font-size:.9rem}
      th,td{text-align:left;padding:6px 10px;border-bottom:1px solid #e2e8f0}
      th{background:#f0fdfa}
      .stat{display:inline-block;margin-right:18px}
      .stat strong{color:#0f766e;font-size:1.4rem;display:block}
      .stat span{color:#64748b;font-size:.78rem;text-transform:uppercase;letter-spacing:.5px}
      @media print { body{margin:14mm} }
    </style></head><body>
    <h1>My GLP Shot — 90-Day Report</h1>
    <p class="meta">Generated ${new Date().toLocaleString()} for ${escapeHTML(account.user?.email || '(local)')}</p>

    <h2>Summary</h2>
    <div>
      <div class="stat"><strong>${rShots.length}</strong><span>shots (90d)</span></div>
      ${wd ? `<div class="stat"><strong>${wd.delta < 0 ? '−' : '+'}${Math.abs(wd.delta).toFixed(1)} lb</strong><span>since start</span></div>` : ''}
      ${wd ? `<div class="stat"><strong>${wd.current.toFixed(1)} lb</strong><span>current weight</span></div>` : ''}
    </div>
    <p class="meta">Medication: ${escapeHTML(settings.medication)} · Cadence: every ${settings.cadenceDays} day${settings.cadenceDays === 1 ? '' : 's'}</p>

    <h2>Recent shots (${rShots.length})</h2>
    <table><thead><tr><th>Date</th><th>Dose</th><th>Site</th><th>Notes</th></tr></thead><tbody>
    ${rShots.slice(0, 60).map(s => `<tr><td>${new Date(s.when).toLocaleString()}</td><td>${s.dose} mg</td><td>${escapeHTML(s.site || '')}</td><td>${escapeHTML(s.notes || '')}</td></tr>`).join('')}
    </tbody></table>

    ${weights.length ? `<h2>Weight</h2><table><thead><tr><th>Date</th><th>Weight</th></tr></thead><tbody>
    ${weights.slice(-30).map(w => `<tr><td>${w.date}</td><td>${w.value} ${w.unit}</td></tr>`).join('')}
    </tbody></table>` : ''}

    ${labs.length ? `<h2>Labs</h2><table><thead><tr><th>Date</th><th>Test</th><th>Value</th><th>Notes</th></tr></thead><tbody>
    ${labs.map(l => { const [label, unit] = LAB_LABELS[l.type] || [l.type, '']; return `<tr><td>${l.date}</td><td>${label}</td><td>${l.value} ${unit}</td><td>${escapeHTML(l.notes || '')}</td></tr>`; }).join('')}
    </tbody></table>` : ''}

    ${measurements.length ? `<h2>Body measurements</h2><table><thead><tr><th>Date</th><th>Type</th><th>Value</th></tr></thead><tbody>
    ${measurements.map(m => `<tr><td>${m.date}</td><td>${m.type}</td><td>${m.value} ${m.unit}</td></tr>`).join('')}
    </tbody></table>` : ''}

    <p class="meta">This report is for personal/clinical reference. Not medical advice.</p>
    <script>window.print()</script>
    </body></html>`;
  w.document.write(html);
  w.document.close();
}

async function createShareLink(label) {
  if (!account.user || !account.encryptionKey) throw new Error('Not unlocked');
  const payload = await buildPayload();
  // Generate per-share random key, embed in URL fragment
  const shareKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const rawKey = await crypto.subtle.exportKey('raw', shareKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, shareKey, new TextEncoder().encode(JSON.stringify(payload)));
  const body = { iv: btoa(String.fromCharCode(...iv)), ciphertext: btoa(String.fromCharCode(...new Uint8Array(ct))), label: label || null };
  const r = await accountFetch('share', { method: 'POST', body: JSON.stringify(body) });
  if (r.status === 402) throw new Error('Doctor share is a Premium feature.');
  if (!r.ok) throw new Error('Share creation failed.');
  const j = await r.json();
  const keyHex = HEX(rawKey);
  const url = `${location.origin}/view.html#t=${j.token}&k=${keyHex}`;
  return { url, expiresAt: j.expiresAt };
}

// Session-only credential cache. Cleared on tab close. Persisted creds (so the
// user doesn't have to retype every session) live in localStorage as username
// + passphrase — same threat model as a logged-in browser session, mitigated
// by the fact that local data is already in IndexedDB on the same device.
let syncCreds = null; // { username, aesKey, lookupId }

const b64 = {
  enc: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))),
  dec: (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0)),
};

async function deriveSyncCreds(username, passphrase) {
  if (!username || !passphrase) throw new Error('Username and passphrase required');
  const enc = new TextEncoder();
  const saltBuf = await crypto.subtle.digest('SHA-256', enc.encode(SYNC_PROTOCOL + ':' + username.trim().toLowerCase()));
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBuf, iterations: SYNC_PBKDF2_ITERS, hash: 'SHA-256' },
    baseKey,
    512  // 64 bytes
  );
  const buf = new Uint8Array(bits);
  const aesKey = await crypto.subtle.importKey('raw', buf.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const lookupBytes = buf.slice(32, 64);
  const lookupId = Array.from(lookupBytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return { username: username.trim(), aesKey, lookupId };
}

async function syncEncrypt(creds, payload) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, creds.aesKey, plaintext);
  return { iv: b64.enc(iv), ciphertext: b64.enc(ct) };
}

async function syncDecrypt(creds, iv_b64, ct_b64) {
  const iv = b64.dec(iv_b64);
  const ct = b64.dec(ct_b64);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, creds.aesKey, ct);
  return JSON.parse(new TextDecoder().decode(plaintext));
}

function suggestPassphrase() {
  // 4 groups of 4 base32-style chars (excluding ambiguous 0/O/1/I/L) ≈ 80 bits.
  const alpha = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const buf = crypto.getRandomValues(new Uint8Array(16));
  let out = '';
  for (let i = 0; i < 16; i++) {
    out += alpha[buf[i] % alpha.length];
    if (i % 4 === 3 && i < 15) out += '-';
  }
  return out;
}

async function buildPayload() {
  const shots = (await dbAll(STORES.shots)) || [];
  const weights = (await dbAll(STORES.weights)) || [];
  const moods = (await dbAll(STORES.moods)) || [];
  let supplies = [], measurements = [], labs = [];
  try { supplies = await getSupplies(); } catch (e) {}
  try { measurements = await getMeasurements(); } catch (e) {}
  try { labs = await getLabs(); } catch (e) {}
  return {
    version: 2,
    exportedAt: new Date().toISOString(),
    settings,
    shots, weights, moods,
    supplies, measurements, labs,
  };
}

async function syncPushNow() {
  if (!syncCreds) throw new Error('Not signed in to sync');
  const payload = await buildPayload();
  const { iv, ciphertext } = await syncEncrypt(syncCreds, payload);
  const res = await fetch(`${SYNC_API}/${syncCreds.lookupId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ iv, ciphertext }),
  });
  if (!res.ok) throw new Error(`Sync server returned ${res.status}`);
  const j = await res.json();
  settings.syncLastPushAt = new Date().toISOString();
  settings.syncLastUpdatedAt = j.updated_at;
  await saveSettings();
  return j;
}

async function syncPullNow() {
  if (!syncCreds) throw new Error('Not signed in to sync');
  const res = await fetch(`${SYNC_API}/${syncCreds.lookupId}`, { headers: { 'Accept': 'application/json' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Sync server returned ${res.status}`);
  const { iv, ciphertext, updated_at } = await res.json();
  let payload;
  try {
    payload = await syncDecrypt(syncCreds, iv, ciphertext);
  } catch (e) {
    throw new Error('Decryption failed — wrong username or passphrase');
  }
  return { payload, updatedAt: updated_at };
}

async function syncCloudExists(creds) {
  const res = await fetch(`${SYNC_API}/${creds.lookupId}/exists`);
  if (!res.ok) return { exists: false };
  return res.json();
}

async function applyPulledPayload(payload) {
  // Ensure premium stores exist before clearing
  await ensureStore('supplies'); await ensureStore('measurements'); await ensureStore('labs');
  // Replace local data with cloud copy. Settings merge (preserve local sync creds).
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const stores = [STORES.shots, STORES.weights, STORES.moods, 'supplies', 'measurements', 'labs'];
    const t = db.transaction(stores, 'readwrite');
    stores.forEach(s => t.objectStore(s).clear());
    t.oncomplete = resolve; t.onerror = () => reject(t.error);
  });
  for (const s of (payload.shots || [])) { delete s.id; await dbAdd(STORES.shots, s); }
  for (const w of (payload.weights || [])) { delete w.id; await dbAdd(STORES.weights, w); }
  for (const m of (payload.moods || [])) await dbPut(STORES.moods, m);
  for (const s of (payload.supplies || [])) { delete s.id; await saveSupply(s); }
  for (const m of (payload.measurements || [])) { delete m.id; await saveMeasurement(m); }
  for (const l of (payload.labs || [])) { delete l.id; await saveLab(l); }
  if (payload.settings) {
    const preserve = { syncEnabled: settings.syncEnabled, syncUsername: settings.syncUsername, syncLastPushAt: settings.syncLastPushAt, syncLastPullAt: settings.syncLastPullAt, syncLastUpdatedAt: settings.syncLastUpdatedAt };
    settings = { ...DEFAULT_SETTINGS, ...payload.settings, ...preserve };
    await saveSettings();
    applySettingsToInputs();
  }
  settings.syncLastPullAt = new Date().toISOString();
  await saveSettings();
  await renderShots();
  await renderWeights();
}

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

function persistCreds(u, p) {
  try { localStorage.setItem('sync.creds', JSON.stringify({ u, p })); } catch (e) {}
}
function clearStoredCreds() {
  try { localStorage.removeItem('sync.creds'); } catch (e) {}
}

async function handleEnableSync() {
  const u = $('#sync-user').value.trim();
  const p = $('#sync-pass').value;
  if (!u || !p) { syncStatus('#sync-setup-status', 'Username and passphrase are required.', 'err'); return; }
  if (p.length < 12) { syncStatus('#sync-setup-status', 'Passphrase must be at least 12 characters.', 'err'); return; }
  syncStatus('#sync-setup-status', 'Deriving keys (this takes a few seconds)…');
  try {
    const creds = await deriveSyncCreds(u, p);
    const exists = await syncCloudExists(creds);
    if (exists.exists) {
      syncStatus('#sync-setup-status', 'An account with this username + passphrase already exists. Use "Restore from cloud" to pull its data, or sign in to overwrite.', 'err');
      // Allow continuing as enable+overwrite via confirm
      if (!confirm('A cloud copy already exists for this account. Continue and OVERWRITE it with your local data? Choose Cancel and use Restore instead if you want to pull the cloud copy down.')) return;
    }
    syncCreds = creds;
    settings.syncEnabled = true;
    settings.syncUsername = creds.username;
    await saveSettings();
    persistCreds(u, p);
    syncStatus('#sync-setup-status', 'Encrypting and uploading…');
    await syncPushNow();
    syncStatus('#sync-setup-status', '');
    renderSyncUI();
    alert('Sync enabled. Your local data has been encrypted and uploaded.');
  } catch (e) {
    syncStatus('#sync-setup-status', 'Failed: ' + e.message, 'err');
  }
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
    if (!confirm(`Cloud copy found (${(result.payload.shots || []).length} shots). REPLACE local data with cloud copy?`)) {
      syncCreds = null;
      syncStatus('#sync-setup-status', 'Cancelled.');
      return;
    }
    await applyPulledPayload(result.payload);
    settings.syncEnabled = true;
    settings.syncUsername = creds.username;
    await saveSettings();
    persistCreds(u, p);
    syncStatus('#sync-setup-status', '');
    renderSyncUI();
    alert('Restored. Your local data now matches the cloud copy.');
  } catch (e) {
    syncCreds = null;
    syncStatus('#sync-setup-status', 'Failed: ' + e.message, 'err');
  }
}

async function handleSyncNow() {
  if (!syncCreds) return;
  syncStatus('#sync-status', 'Syncing…');
  try {
    await syncPushNow();
    renderSyncUI();
    syncStatus('#sync-status', '✓ Pushed', 'ok');
    setTimeout(() => syncStatus('#sync-status', ''), 2500);
  } catch (e) {
    syncStatus('#sync-status', 'Failed: ' + e.message, 'err');
  }
}

async function handleSyncPull() {
  if (!syncCreds) return;
  if (!confirm('Pull cloud copy and REPLACE your local data?')) return;
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
  if (!confirm('Sign out of sync on this device? Local data is kept. Cloud copy is NOT deleted.')) return;
  syncCreds = null;
  settings.syncEnabled = false;
  await saveSettings();
  clearStoredCreds();
  renderSyncUI();
}

async function handleSyncDeleteCloud() {
  if (!syncCreds) return;
  if (!confirm('Permanently delete the encrypted cloud copy? This cannot be undone. Your local data is kept.')) return;
  if (!confirm('Are you absolutely sure?')) return;
  try {
    await fetch(`${SYNC_API}/${syncCreds.lookupId}`, { method: 'DELETE' });
    syncStatus('#sync-status', '✓ Cloud copy deleted', 'ok');
  } catch (e) {
    syncStatus('#sync-status', 'Failed: ' + e.message, 'err');
  }
}

async function initSyncUI() {
  // Pre-fill known username if we've used sync before
  if (settings.syncUsername) $('#sync-user').value = settings.syncUsername;

  $('#sync-suggest-pass').addEventListener('click', () => {
    const pp = suggestPassphrase();
    $('#sync-pass').value = pp;
    const dis = $('#sync-suggested');
    dis.textContent = pp;
    dis.classList.remove('hidden');
  });
  $('#sync-enable').addEventListener('click', handleEnableSync);
  $('#sync-restore').addEventListener('click', handleRestoreSync);
  $('#sync-now').addEventListener('click', handleSyncNow);
  $('#sync-pull').addEventListener('click', handleSyncPull);
  $('#sync-disable').addEventListener('click', handleSyncDisable);
  $('#sync-delete-cloud').addEventListener('click', handleSyncDeleteCloud);

  if (settings.syncEnabled) {
    const ok = await attemptUnlockFromStored();
    if (!ok) {
      // creds not found locally — user needs to re-enter
      settings.syncEnabled = false;
      await saveSettings();
    }
  }
  renderSyncUI();

  // Auto-push debounced after each shot/weight change. Hook is in the form
  // submit handlers; here we just register a passive interval as a safety net.
  setInterval(async () => {
    if (!syncCreds || !settings.syncEnabled) return;
    if (!settings.syncAutoPush) return;
    if (!settings.syncDirty) return;
    try { await syncPushNow(); settings.syncDirty = false; await saveSettings(); renderSyncUI(); } catch (e) {}
  }, 60000);
}
