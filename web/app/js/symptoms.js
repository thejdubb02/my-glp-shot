// My GLP Shot: Side effects, the daily symptoms card and the mood widget.
'use strict';

// ---------- Side effects ----------
//
// Side effects live in two places, and both are first-class:
//   * shot.sideEffects  — what happened around an injection
//   * the 'symptoms' store — a date-keyed entry for a day with no shot
//
// The second exists because the daily "Side effects check-in" reminder fires
// every evening, and until now the only way to answer it was to log a shot.
// Everything downstream (the 30-day summary, insights, the PDF, the doctor
// share) reads through collectSideEffectEntries so neither source is invisible.

async function getSymptomDaysSorted() {
  return (await readDailySorted('symptoms')).filter(r => r.se && Object.keys(r.se).length);
}
async function getSymptomDay(date) {
  try { return await dbGet('symptoms', date); } catch (_) { return null; }
}
async function saveSymptomDay(date, se) {
  const clean = sanitizeSideEffectMap(se) || {};
  // Drop "None" selections so an all-clear day doesn't masquerade as data.
  for (const k of Object.keys(clean)) if (!clean[k]) delete clean[k];
  if (!Object.keys(clean).length) return deleteSymptomDay(date);
  // An un-ticked symptom needs its own tombstone, or the per-symptom union on
  // the next pull adds it straight back.
  const prev = await getSymptomDay(date);
  await tombstoneDay('symptoms', date, Object.keys((prev && prev.se) || {}).filter(k => !clean[k]));
  // seAt: when each symptom was last set, so a tombstone for one symptom is
  // compared against that symptom and not against edits to the rest of the day.
  const now = Date.now(), seAt = {};
  for (const k of Object.keys(clean)) seAt[k] = prev && prev.se && prev.se[k] === clean[k] ? (symTs(prev, k) || now) : now;
  return dbPut('symptoms', { date, se: clean, seAt, updatedAt: new Date(now).toISOString() });
}
async function deleteSymptomDay(date) {
  return dbDelDay('symptoms', date);
}
function sanitizeSymptomDay(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const date = safeText(raw.date, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const se = sanitizeSideEffectMap(raw.se) || {};
  for (const k of Object.keys(se)) if (!se[k]) delete se[k];
  if (!Object.keys(se).length) return null;
  const seAt = {};
  for (const k of Object.keys(se)) { const at = Number(raw.seAt && raw.seAt[k]); if (at > 0) seAt[k] = at; }
  return { date, se, seAt, updatedAt: safeText(raw.updatedAt, 40) || new Date().toISOString() };
}

// One flat list of every side-effect observation, from either source.
// Each entry: { date: 'YYYY-MM-DD', at: ms, se: {key: level}, fromShot: bool }.
async function collectSideEffectEntries(shots) {
  const rows = Array.isArray(shots) ? shots : ((await dbAll(STORES.shots)) || []);
  const out = [];
  for (const s of rows) {
    if (!s || !s.sideEffects) continue;
    const at = new Date(s.when).getTime();
    if (!Number.isFinite(at)) continue;
    const date = toCanonicalDate(s.when);
    if (!date) continue;
    out.push({ date, at, se: s.sideEffects, fromShot: true });
  }
  let days = [];
  try { days = await getSymptomDaysSorted(); } catch (_) {}
  for (const d of days) {
    const at = new Date(d.date + 'T12:00:00').getTime();
    if (!Number.isFinite(at)) continue;
    out.push({ date: d.date, at, se: d.se, fromShot: false });
  }
  return out.sort((a, b) => a.at - b.at);
}

// Render the grouped severity picker into any container. Used by the shot form,
// the standalone symptoms dialog, and the catch-up dialog — one taxonomy, one
// layout, three entry points. `prefix` namespaces the element ids.
function renderSePicker(wrap, prefix) {
  if (!wrap) return;
  wrap.innerHTML = SE_GROUPS.map(([gid, gname]) => {
    const rows = SIDE_EFFECTS.filter(([, , g]) => g === gid).map(([key, label]) =>
      `<div class="se-row"><label for="${prefix}${key}">${label}</label>
         <select id="${prefix}${key}" data-se="${key}">${SE_LEVELS.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select></div>`
    ).join('');
    if (!rows) return '';
    return `<div class="se-group"><h4 class="se-group-title">${gname}</h4>${rows}</div>`;
  }).join('');
}
function readSePicker(prefix) {
  const obj = {};
  for (const [key] of SIDE_EFFECTS) {
    const v = $('#' + prefix + key)?.value;
    if (v) obj[key] = v;
  }
  return Object.keys(obj).length ? obj : null;
}
function writeSePicker(prefix, se) {
  for (const [key] of SIDE_EFFECTS) {
    const el = $('#' + prefix + key);
    if (el) el.value = (se && se[key]) || '';
  }
}
// A short "Nausea (moderate) · Fatigue (mild)" line for a severity map.
function describeSe(se, max = 3) {
  const labelOf = (k) => (SIDE_EFFECTS.find(x => x[0] === k) || [k, k])[1];
  const rank = { severe: 3, moderate: 2, mild: 1 };
  const list = Object.entries(se || {})
    .filter(([, v]) => v)
    .sort((a, b) => (rank[b[1]] || 0) - (rank[a[1]] || 0));
  if (!list.length) return '';
  const shown = list.slice(0, max).map(([k, v]) => `${labelOf(k)} (${v})`).join(' · ');
  return list.length > max ? `${shown} +${list.length - max} more` : shown;
}

function renderSideEffectsForm() {
  const wrap = $('#shot-side-effects');
  if (!wrap) return;
  renderSePicker(wrap, 'se-');
}
function readSideEffects() { return readSePicker('se-'); }
function writeSideEffects(se) { writeSePicker('se-', se); }
// ---------- Symptoms card (standalone daily entry) ----------
let _symptomsDialogDate = null;

async function renderSymptomsCard() {
  const card = $('#symptoms-card');
  if (!card) return;
  const today = todayISODate();
  const row = await getSymptomDay(today);
  const se = (row && row.se) || null;
  const logged = !!(se && Object.keys(se).length);
  const summary = $('#symptoms-today');
  const btn = $('#symptoms-log-btn');
  card.classList.toggle('logged', logged);
  if (summary) {
    summary.textContent = logged ? describeSe(se) : 'Nothing logged today.';
    summary.classList.toggle('muted', !logged);
  }
  if (btn) btn.textContent = logged ? 'Edit today' : 'Log symptoms';
}

function openSymptomsDialog(date) {
  const dlg = $('#symptoms-dialog');
  if (!dlg) return;
  _symptomsDialogDate = date || todayISODate();
  const dateInput = $('#symptoms-date');
  if (dateInput) { dateInput.value = _symptomsDialogDate; dateInput.max = todayISODate(); }
  renderSePicker($('#symptoms-picker'), 'sym-');
  getSymptomDay(_symptomsDialogDate).then(row => writeSePicker('sym-', row && row.se));
  if (!dlg.open) dlg.showModal();
}

function setupSymptomsUI() {
  renderSePicker($('#symptoms-picker'), 'sym-');
  $('#symptoms-log-btn')?.addEventListener('click', () => openSymptomsDialog(todayISODate()));
  $('#symptoms-cancel')?.addEventListener('click', () => $('#symptoms-dialog')?.close());
  $('#symptoms-date')?.addEventListener('change', (e) => {
    const v = e.target.value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return;
    _symptomsDialogDate = v;
    getSymptomDay(v).then(row => writeSePicker('sym-', row && row.se));
  });
  $('#symptoms-clear')?.addEventListener('click', async () => {
    const date = _symptomsDialogDate || todayISODate();
    await deleteSymptomDay(date);
    markSyncDirty();
    writeSePicker('sym-', null);
    await renderSymptomsCard();
    await renderShots();
    toast('Symptoms cleared for that day.');
    $('#symptoms-dialog')?.close();
  });
  $('#symptoms-save')?.addEventListener('click', async () => {
    const date = _symptomsDialogDate || todayISODate();
    const se = readSePicker('sym-');
    await saveSymptomDay(date, se);
    markSyncDirty();
    await renderSymptomsCard();
    // The 30-day summary and insights both read symptom days now, so they have
    // to be recomputed or the entry looks like it vanished.
    await renderShots();
    toast(se ? 'Symptoms saved.' : 'Symptoms cleared for that day.');
    $('#symptoms-dialog')?.close();
  });
}

async function renderSideEffectsSummary(shots) {
  const cutoff = Date.now() - 30 * 86400000;
  const counts = {};
  const entries = await collectSideEffectEntries(shots);
  for (const e of entries) {
    if (e.at < cutoff) continue;
    for (const [k, lvl] of Object.entries(e.se)) {
      if (!lvl) continue;
      counts[k] = counts[k] || { mild: 0, moderate: 0, severe: 0 };
      if (counts[k][lvl] != null) counts[k][lvl]++;
    }
  }
  const labelOf = (k) => (SIDE_EFFECTS.find(s => s[0] === k) || [k, k])[1];
  const groupOf = (k) => (SIDE_EFFECTS.find(s => s[0] === k) || [k, k, 'other'])[2];
  // Bucket counts by group so each category has its own row of pills.
  const byGroup = {};
  for (const [k, c] of Object.entries(counts)) {
    const g = groupOf(k);
    (byGroup[g] = byGroup[g] || []).push([k, c]);
  }
  const wrap = $('#side-effects-summary');
  const empty = $('#empty-side-effects');
  if (!wrap || !empty) return;
  if (!Object.keys(byGroup).length) { wrap.innerHTML = ''; empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');
  const sortPills = (a, b) => {
    const ts = (c) => c.severe * 4 + c.moderate * 2 + c.mild;
    return ts(b[1]) - ts(a[1]);
  };
  wrap.innerHTML = SE_GROUPS.filter(([gid]) => byGroup[gid]).map(([gid, gname]) => {
    const pills = byGroup[gid].sort(sortPills).map(([k, c]) => {
      const total = c.mild + c.moderate + c.severe;
      const cls = c.severe > 0 ? 'severe' : '';
      const dots = '●'.repeat(Math.min(3, c.severe)) + '◐'.repeat(Math.min(3, c.moderate)) + '○'.repeat(Math.min(3, c.mild));
      // labelOf falls back to the raw key when it isn't in the taxonomy, and
      // keys come from imported files — so this is a sink for attacker-chosen
      // text, not just our own labels.
      return `<span class="se-pill ${escapeHTML(cls)}"><span class="se-count">${escapeHTML(total)}</span>${escapeHTML(labelOf(k))} <span class="muted small">${escapeHTML(dots)}</span></span>`;
    }).join('');
    return `<div class="se-group-row"><h4 class="se-group-title">${gname}</h4><div class="se-pills">${pills}</div></div>`;
  }).join('');
}

// ---------- Mood widget ----------

async function renderMood() {
  const today = todayISODate();
  const moods = await getMoodsSorted();
  const todayMood = moods.find(m => m.date === today);
  $$('#mood-picker .mood-btn').forEach(b => b.classList.toggle('selected', todayMood && +b.dataset.mood === todayMood.value));
  // Collapse the picker once today is logged. User can tap "change" to bring it back.
  const card = $('#mood-card');
  const picker = $('#mood-picker');
  const logged = $('#mood-logged');
  const saved = $('#mood-saved');
  const heading = $('#mood-heading');
  if (todayMood && !card.dataset.editing) {
    picker.classList.add('hidden');
    logged.classList.remove('hidden');
    const loggedSvg = $('#mood-logged-svg');
    loggedSvg.dataset.value = String(todayMood.value);
    const styleId = settings.moodStyle || 'classic';
    if (styleId === 'classic') {
      // Wrap the SVG paths in a fresh <svg>; the wrapper is now a div so we render the SVG ourselves.
      loggedSvg.innerHTML = `<svg viewBox="0 0 32 32" class="mood-svg">${MOOD_SVG[todayMood.value] || ''}</svg>`;
      loggedSvg.classList.remove('mood-emoji-display');
    } else {
      const s = MOOD_STYLES.find(x => x.id === styleId) || MOOD_STYLES[0];
      loggedSvg.innerHTML = `<span class="mood-emoji-big">${s.emojis[todayMood.value - 1] || '🙂'}</span>`;
      loggedSvg.classList.add('mood-emoji-display');
    }
    loggedSvg.classList.toggle('mood-positive', todayMood.value >= 4);
    loggedSvg.classList.toggle('mood-negative', todayMood.value <= 2);
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
  // A low bar on its own invites the wrong conclusion. Where the user wrote down
  // what was going on that day, mark the bar and put the note in the tooltip, so
  // the reason travels with the number instead of sitting in a separate list.
  const noteByDate = new Map((await getNotesSorted()).map(n => [n.date, n.text]));
  const bars = [];
  let sum = 0, count = 0;
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const iso = localISOForInput(d).slice(0, 10);
    const v = byDate.get(iso);
    if (v != null) { sum += v; count++; }
    bars.push({ iso, v, note: noteByDate.get(iso) || '' });
  }
  const html = bars.map(b => {
    const noteCls = b.note ? ' has-note' : '';
    const noteTip = b.note ? ` — ${noteSnippet(b.note)}` : '';
    if (b.v == null) return `<div class="mood-bar empty${noteCls}" data-date="${b.iso}" title="${escapeHTML(`${b.iso}: not logged — tap to fill in${noteTip}`)}"></div>`;
    return `<div class="mood-bar v${b.v}${noteCls}" data-date="${b.iso}" style="height:${20 + b.v * 16}%" title="${escapeHTML(`${b.iso}: ${MOOD_LABELS[b.v]} — tap to edit${noteTip}`)}"></div>`;
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
