// My GLP Shot: Daily tracking: mood, appetite, food noise, notes and past-day catch-up.
'use strict';

// ============================================================================
// Visuals — hero, ring, body diagram, heatmap, dose timeline, side effects,
// mood, achievements, confetti, polish.
// ============================================================================

// ---------- Mood store (daily) ----------
async function getMoodsSorted() {
  return readDailySorted(STORES.moods);
}
async function saveMood(date, value) {
  await dbPut(STORES.moods, { date, value, updatedAt: new Date().toISOString() });
}

// ---------- Appetite store (daily) ----------
const APPETITE_LABELS = { 1: 'No appetite', 2: 'Low', 3: 'Normal', 4: 'Hungry', 5: 'Ravenous' };
const APPETITE_EMOJIS = { 1: '🚫', 2: '🤏', 3: '🍽️', 4: '😋', 5: '😅' };
async function getAppetitesSorted() {
  return readDailySorted('appetites');
}
// Routed through dbPut rather than a hand-rolled transaction so the write goes
// past withStore, which is what clears the cached read.
async function saveAppetite(date, value) {
  await dbPut('appetites', { date, value, updatedAt: new Date().toISOString() });
}

async function renderAppetite() {
  const today = todayISODate();
  const appetites = await getAppetitesSorted();
  const todayAppetite = appetites.find(a => a.date === today);
  const card = $('#appetite-card');
  const picker = $('#appetite-picker');
  const logged = $('#appetite-logged');
  const saved = $('#appetite-saved');
  const heading = $('#appetite-heading');
  $$('#appetite-picker .appetite-btn').forEach(b => b.classList.toggle('selected', todayAppetite && +b.dataset.appetite === todayAppetite.value));
  if (todayAppetite && !card.dataset.editing) {
    picker.classList.add('hidden');
    logged.classList.remove('hidden');
    const styleId = settings.appetiteStyle || 'classic';
    const s = APPETITE_STYLES.find(x => x.id === styleId) || APPETITE_STYLES[0];
    const lg = $('#appetite-logged-graphic');
    lg.dataset.value = String(todayAppetite.value);
    lg.innerHTML = `<span class="mood-emoji-big">${s.emojis[todayAppetite.value - 1] || '🍽️'}</span>`;
    lg.classList.add('mood-emoji-display');
    $('#appetite-logged-label').textContent = APPETITE_LABELS[todayAppetite.value] || 'Logged';
    // Restore the heading text (it was preserved as innerHTML so the (i) button stays).
    if (heading) heading.firstChild && (heading.childNodes[0].textContent = "Today's appetite ");
    if (saved) saved.textContent = '';
  } else {
    picker.classList.remove('hidden');
    logged.classList.add('hidden');
    if (heading) heading.childNodes[0] && (heading.childNodes[0].textContent = "How's your appetite today? ");
    if (saved) saved.textContent = todayAppetite ? '✓ saved' : '';
  }
  await renderAppetiteTrend(appetites);
}

async function renderAppetiteTrend(appetites) {
  const card = $('#appetite-trend-card');
  if (!card) return;
  if (!appetites || appetites.length === 0) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  const days = 30;
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - (days - 1));
  const cutoffKey = cutoff.toISOString().slice(0, 10);
  const inWindow = appetites.filter(a => a.date >= cutoffKey);
  const wrap = $('#appetite-trend-bars');
  if (!wrap) return;
  const byDate = {};
  inWindow.forEach(a => { byDate[a.date] = a.value; });
  const noteByDate = new Map((await getNotesSorted()).map(n => [n.date, n.text]));
  const bars = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const v = byDate[key];
    const note = noteByDate.get(key) || '';
    const noteCls = note ? ' has-note' : '';
    const noteTip = note ? ` — ${noteSnippet(note)}` : '';
    if (v) {
      // Color by suppression: 1-2 = strong (good for GLP-1) = teal, 3 = mid = grey, 4-5 = elevated = warning
      const cls = v <= 2 ? 'good' : v === 3 ? 'mid' : 'high';
      bars.push(`<div class="mood-bar ${cls}${noteCls}" data-date="${key}" style="height:${v * 18}%" title="${escapeHTML(`${key}: ${APPETITE_LABELS[v]} — tap to edit${noteTip}`)}"></div>`);
    } else {
      bars.push(`<div class="mood-bar empty${noteCls}" data-date="${key}" title="${escapeHTML(`${key}: not logged — tap to fill in${noteTip}`)}"></div>`);
    }
  }
  wrap.innerHTML = bars.join('');
  const avg = inWindow.reduce((s, a) => s + a.value, 0) / inWindow.length;
  const summary = $('#appetite-trend-summary');
  if (summary) summary.textContent = `Avg ${avg.toFixed(1)} · ${inWindow.length}/${days} days logged`;
}

function setupAppetiteUI() {
  // Scoped to the home card — see the mood picker note; the catch-up dialog
  // reuses .appetite-btn purely for styling.
  $$('#appetite-picker .appetite-btn').forEach(btn => btn.addEventListener('click', async () => {
    const v = parseInt(btn.dataset.appetite, 10);
    await saveAppetite(todayISODate(), v);
    delete $('#appetite-card').dataset.editing;
    await renderAppetite();
    markSyncDirty();
    track('appetite_logged', { value: v });
  }));
  const change = $('#appetite-change');
  if (change) change.addEventListener('click', (e) => {
    e.preventDefault();
    $('#appetite-card').dataset.editing = '1';
    renderAppetite();
  });
}

// ---------- Food noise (1-10 daily) ----------
// Distinct from appetite: tracks the *mental* chatter about food (intrusive
// thoughts, food obsession). Many GLP-1 users describe this quieting down
// independent of physical hunger. Lower = quieter = generally better on GLP-1.
function foodNoiseDescriptor(v) {
  if (v <= 2) return 'quiet';
  if (v <= 4) return 'mild';
  if (v <= 6) return 'moderate';
  if (v <= 8) return 'loud';
  return 'constant';
}
async function getFoodNoiseSorted() {
  return readDailySorted('foodNoise');
}
async function saveFoodNoise(date, value) {
  await dbPut('foodNoise', { date, value, updatedAt: new Date().toISOString() });
}
async function renderFoodNoise() {
  const today = todayISODate();
  const all = await getFoodNoiseSorted();
  const todayEntry = all.find(a => a.date === today);
  const card = $('#foodnoise-card');
  if (!card) return;
  const picker = $('#foodnoise-picker');
  const logged = $('#foodnoise-logged');
  const saved = $('#foodnoise-saved');
  const slider = $('#foodnoise-slider');
  const valEl = $('#foodnoise-value');
  const descEl = $('#foodnoise-descriptor');
  if (todayEntry && !card.dataset.editing) {
    picker.classList.add('hidden');
    logged.classList.remove('hidden');
    $('#foodnoise-logged-value').textContent = String(todayEntry.value);
    $('#foodnoise-logged-label').textContent = `${todayEntry.value}/10 — ${foodNoiseDescriptor(todayEntry.value)}`;
    if (saved) saved.textContent = '';
  } else {
    picker.classList.remove('hidden');
    logged.classList.add('hidden');
    if (todayEntry) {
      slider.value = String(todayEntry.value);
      valEl.textContent = String(todayEntry.value);
      descEl.textContent = foodNoiseDescriptor(todayEntry.value);
    }
    if (saved) saved.textContent = todayEntry ? '✓ saved' : '';
  }
  await renderFoodNoiseTrend(all);
}
async function renderFoodNoiseTrend(entries) {
  const card = $('#foodnoise-trend-card');
  if (!card) return;
  if (!entries || entries.length === 0) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  const days = 30;
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - (days - 1));
  const cutoffKey = cutoff.toISOString().slice(0, 10);
  const inWindow = entries.filter(a => a.date >= cutoffKey);
  const wrap = $('#foodnoise-trend-bars');
  if (!wrap) return;
  const byDate = {};
  inWindow.forEach(a => { byDate[a.date] = a.value; });
  const noteByDate = new Map((await getNotesSorted()).map(n => [n.date, n.text]));
  const bars = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const v = byDate[key];
    const note = noteByDate.get(key) || '';
    const noteCls = note ? ' has-note' : '';
    const noteTip = note ? ` — ${noteSnippet(note)}` : '';
    if (v) {
      // Color by quietness: 1-3 = good (quiet), 4-6 = mid, 7-10 = high (loud)
      const cls = v <= 3 ? 'good' : v <= 6 ? 'mid' : 'high';
      bars.push(`<div class="mood-bar ${cls}${noteCls}" data-date="${key}" style="height:${v * 9}%" title="${escapeHTML(`${key}: ${v}/10 — ${foodNoiseDescriptor(v)} — tap to edit${noteTip}`)}"></div>`);
    } else {
      bars.push(`<div class="mood-bar empty${noteCls}" data-date="${key}" title="${escapeHTML(`${key}: not logged — tap to fill in${noteTip}`)}"></div>`);
    }
  }
  wrap.innerHTML = bars.join('');
  const avg = inWindow.reduce((s, a) => s + a.value, 0) / inWindow.length;
  const summary = $('#foodnoise-trend-summary');
  if (summary) summary.textContent = `Avg ${avg.toFixed(1)}/10 · ${inWindow.length}/${days} days logged`;
}
function setupFoodNoiseUI() {
  const slider = $('#foodnoise-slider');
  const valEl = $('#foodnoise-value');
  const descEl = $('#foodnoise-descriptor');
  if (!slider) return;
  slider.addEventListener('input', () => {
    const v = parseInt(slider.value, 10);
    valEl.textContent = String(v);
    descEl.textContent = foodNoiseDescriptor(v);
  });
  $('#foodnoise-save').addEventListener('click', async () => {
    const v = parseInt(slider.value, 10);
    if (!Number.isFinite(v) || v < 1 || v > 10) return;
    await saveFoodNoise(todayISODate(), v);
    delete $('#foodnoise-card').dataset.editing;
    await renderFoodNoise();
    markSyncDirty();
    track('food_noise_logged', { value: v });
  });
  const change = $('#foodnoise-change');
  if (change) change.addEventListener('click', (e) => {
    e.preventDefault();
    $('#foodnoise-card').dataset.editing = '1';
    renderFoodNoise();
  });
}

// ---------- Daily notes (free text) ----------
// Mood, appetite and food noise record *what* a day was like. None of them record
// *why*, so a run of low days reads as a medication signal when it may have been
// a house move. A note is the context line that stops the numbers being misread
// months later, and it is the only free text in the daily check-in — so it is
// merged rather than overwritten (see mergeNotes) and never shared by default.
const NOTE_MAX = 2000;
// The editor stops typing at NOTE_MAX, but a note merged from two devices holds
// both texts and can run past it. Storage, sync and saves use this larger cap so
// a merged note is never cut. shortcut: ~10 full divergent merges on one day would
// still hit it; switch to an overflow row if that ever shows up.
const NOTE_STORE_MAX = 20000;
const NOTE_AUTOSAVE_MS = 700;

async function getNotesSorted() {
  return (await readDailySorted('notes')).filter(n => n.text);
}
async function getNote(date) {
  try { return await dbGet('notes', date); } catch (_) { return null; }
}
// Clearing the box deletes the day rather than storing an empty string, so an
// emptied note doesn't linger as a blank row in the journal or the export.
async function saveNote(date, text) {
  const clean = String(text == null ? '' : text).slice(0, NOTE_STORE_MAX).trim();
  if (!clean) return deleteNote(date);
  return dbPut('notes', { date, text: clean, updatedAt: new Date().toISOString() });
}
async function deleteNote(date) { return dbDelDay('notes', date); }


function noteSnippet(text, max = 80) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

let _noteSaveTimer = null;
let _noteLastSaved = '';

async function renderNote() {
  const card = $('#note-card');
  if (!card) return;
  const box = $('#note-text');
  const saved = $('#note-saved');
  const count = $('#note-count');
  if (!box) return;
  const existing = await getNote(todayISODate());
  const text = (existing && existing.text) || '';
  // Never stomp on what someone is mid-sentence into. A re-render can be
  // triggered by a sync pull or a tab switch while the box has focus.
  if (document.activeElement !== box) box.value = text;
  _noteLastSaved = text;
  if (saved) saved.textContent = text ? '✓ saved' : '';
  if (count) count.textContent = `${box.value.length}/${NOTE_MAX}`;
  await renderNoteJournal();
}

// Commit whatever is in the box. Safe to call repeatedly — a no-op when the text
// hasn't changed, so blur-after-autosave doesn't write twice.
async function flushNote(reason) {
  const box = $('#note-text');
  if (!box) return;
  const val = box.value.slice(0, NOTE_STORE_MAX).trim();
  if (val === _noteLastSaved) return;
  await saveNote(todayISODate(), val);
  _noteLastSaved = val;
  const saved = $('#note-saved');
  if (saved) saved.textContent = val ? '✓ saved' : '';
  markSyncDirty();
  track('note_saved', { via: reason || 'auto', length: val.length });
  await renderNoteJournal();
  await renderMood();
}

function setupNoteUI() {
  const box = $('#note-text');
  if (!box) return;
  box.setAttribute('maxlength', String(NOTE_MAX));

  box.addEventListener('input', () => {
    const count = $('#note-count');
    if (count) count.textContent = `${box.value.length}/${NOTE_MAX}`;
    const saved = $('#note-saved');
    if (saved) saved.textContent = 'saving…';
    clearTimeout(_noteSaveTimer);
    _noteSaveTimer = setTimeout(() => flushNote('auto'), NOTE_AUTOSAVE_MS);
  });

  // Belt and braces: leaving the field, backgrounding the tab, or closing it all
  // commit immediately. An autosave timer that never fires because the phone was
  // locked would otherwise lose the note.
  box.addEventListener('blur', () => { clearTimeout(_noteSaveTimer); flushNote('blur'); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { clearTimeout(_noteSaveTimer); flushNote('hide'); }
  });

  const journal = $('#note-journal');
  if (journal) {
    journal.addEventListener('click', (e) => {
      const row = e.target.closest('[data-note-date]');
      if (row && row.dataset.noteDate) openCatchup(row.dataset.noteDate);
    });
  }
  const search = $('#note-search');
  if (search) search.addEventListener('input', () => renderNoteJournal());
}

// The looking-back half of the feature. A note is only worth writing if it comes
// back to you next to the day it belongs to, so each entry carries that day's
// mood alongside it.
async function renderNoteJournal() {
  const card = $('#note-journal-card');
  if (!card) return;
  const notes = (await getNotesSorted()).slice().reverse();
  if (!notes.length) {
    card.classList.add('hidden');
    return;
  }
  card.classList.remove('hidden');
  const q = ($('#note-search')?.value || '').trim().toLowerCase();
  const shown = q ? notes.filter(n => n.text.toLowerCase().includes(q)) : notes;
  const moods = await getMoodsSorted();
  const moodByDate = {};
  moods.forEach(m => { moodByDate[m.date] = m.value; });
  const styleId = settings.moodStyle || 'classic';
  const style = (MOOD_STYLES || []).find(x => x.id === styleId) || (MOOD_STYLES || [])[0];

  const summary = $('#note-journal-summary');
  if (summary) {
    summary.textContent = q
      ? `${shown.length} of ${notes.length} ${notes.length === 1 ? 'note' : 'notes'}`
      : `${notes.length} ${notes.length === 1 ? 'note' : 'notes'}`;
  }

  const wrap = $('#note-journal');
  if (!wrap) return;
  if (!shown.length) {
    wrap.innerHTML = `<p class="empty small">No notes match "${escapeHTML(q)}".</p>`;
    return;
  }
  wrap.innerHTML = shown.slice(0, 200).map(n => {
    const mv = moodByDate[n.date];
    const emoji = mv && style && style.emojis ? (style.emojis[mv - 1] || '') : '';
    const moodBit = mv
      ? `<span class="note-mood" title="Mood that day: ${escapeHTML(MOOD_LABELS[mv] || '')}">${emoji || ''}<span class="muted small">${escapeHTML(MOOD_LABELS[mv] || '')}</span></span>`
      : '';
    return `<button type="button" class="note-entry" data-note-date="${escapeHTML(n.date)}">
      <div class="note-entry-head"><strong>${escapeHTML(formatNoteDate(n.date))}</strong>${moodBit}</div>
      <div class="note-entry-text">${escapeHTML(n.text)}</div>
    </button>`;
  }).join('');
}

// "Sat 15 Mar 2026" reads better in a journal than a bare key, and a bare key is
// parsed as UTC midnight by Date — which is the timezone bug fixed elsewhere. So
// build the date from its parts and never let a timezone near it.
function formatNoteDate(key) {
  const [y, m, d] = String(key || '').split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return String(key || '');
  const dt = new Date(y, m - 1, d, 12, 0, 0);
  const today = todayISODate();
  if (key === today) return 'Today';
  if (key === shiftISODate(today, -1)) return 'Yesterday';
  try {
    return dt.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  } catch (_) { return String(key); }
}

// ---------- Catch-up: mood / appetite / food noise / note for a past day ----------
// The three home cards are today-only on purpose — one tap, no date picker, so
// the daily check-in stays a two-second job. This dialog is the escape hatch for
// the day you forgot, and doubles as the edit path for a day you got wrong.
// Reached from the home-tab link, by tapping any bar in the 30-day trend strips,
// or by tapping an entry in the notes journal.
const CATCHUP_MAX_AGE_DAYS = 730;

// Pure day-key arithmetic. Both ends are wall-clock day keys, so this deliberately
// works in UTC and never touches the user's timezone — the anchor comes from
// todayISODate(), which is already tz-aware.
function shiftISODate(key, deltaDays) {
  const [y, m, d] = (key || '').split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return key;
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().slice(0, 10);
}

async function deleteMood(date)      { return dbDelDay(STORES.moods, date); }
async function deleteAppetite(date)  { return dbDelDay('appetites', date); }
async function deleteFoodNoise(date) { return dbDelDay('foodNoise', date); }

// null = "leave this one alone"; a number = write it. Saving only touches the
// stores the user actually set, so filling in mood never wipes an existing
// appetite entry for the same day.
// `note` is '' rather than null when untouched: an empty string is a real edit
// (the user cleared the box), so it has to be distinguishable from "not loaded".
// `noteOriginal` is what was on disk when the day was loaded. Clearing a note the
// user had written is a real edit that must be saved, and without the original
// there is no way to tell "left the empty box alone" from "deleted the text".
const catchupDraft = { mood: null, appetite: null, foodNoise: null, note: '', noteOriginal: '', symptoms: null, symptomsOriginal: '' };

function catchupPaint() {
  $$('#catchup-mood-picker .mood-btn').forEach(b =>
    b.classList.toggle('selected', +b.dataset.mood === catchupDraft.mood));
  $$('#catchup-appetite-picker .appetite-btn').forEach(b =>
    b.classList.toggle('selected', +b.dataset.appetite === catchupDraft.appetite));

  const moodState = $('#catchup-mood-state');
  if (moodState) moodState.textContent = catchupDraft.mood ? MOOD_LABELS[catchupDraft.mood] : 'not logged';
  const appState = $('#catchup-appetite-state');
  if (appState) appState.textContent = catchupDraft.appetite ? APPETITE_LABELS[catchupDraft.appetite] : 'not logged';

  const fnState = $('#catchup-foodnoise-state');
  const fnVal = $('#catchup-foodnoise-value');
  const fnDesc = $('#catchup-foodnoise-descriptor');
  const slider = $('#catchup-foodnoise');
  if (catchupDraft.foodNoise) {
    if (slider) slider.value = String(catchupDraft.foodNoise);
    if (fnVal) fnVal.textContent = String(catchupDraft.foodNoise);
    if (fnDesc) fnDesc.textContent = foodNoiseDescriptor(catchupDraft.foodNoise);
    if (fnState) fnState.textContent = `${catchupDraft.foodNoise}/10`;
  } else {
    if (slider) slider.value = '5';
    if (fnVal) fnVal.textContent = '—';
    if (fnDesc) fnDesc.textContent = 'drag to set';
    if (fnState) fnState.textContent = 'not logged';
  }

  const symState = $('#catchup-symptoms-state');
  if (symState) {
    const desc = describeSe(catchupDraft.symptoms, 2);
    symState.textContent = desc || 'not logged';
  }

  const noteBox = $('#catchup-note');
  const noteState = $('#catchup-note-state');
  // Same rule as the home card: never overwrite text that is being typed.
  if (noteBox && document.activeElement !== noteBox) noteBox.value = catchupDraft.note || '';
  if (noteState) noteState.textContent = (catchupDraft.note || '').trim() ? 'written' : 'not written';
}

// Pull whatever is already stored for `date` into the draft, so the dialog opens
// as an edit of that day rather than a blank form.
async function catchupLoadDay(date) {
  const [moods, appetites, foodNoise, note] = await Promise.all([
    getMoodsSorted(), getAppetitesSorted(), getFoodNoiseSorted(), getNote(date),
  ]);
  catchupDraft.mood = (moods.find(m => m.date === date) || {}).value || null;
  catchupDraft.appetite = (appetites.find(a => a.date === date) || {}).value || null;
  catchupDraft.foodNoise = (foodNoise.find(f => f.date === date) || {}).value || null;
  catchupDraft.note = (note && note.text) || '';
  catchupDraft.noteOriginal = catchupDraft.note;
  const symRow = await getSymptomDay(date);
  catchupDraft.symptoms = (symRow && symRow.se) || null;
  catchupDraft.symptomsOriginal = JSON.stringify(catchupDraft.symptoms || {});
  writeSePicker('csym-', catchupDraft.symptoms);
  catchupPaint();
}

async function openCatchup(date) {
  const dlg = $('#catchup-dialog');
  if (!dlg) return;
  const today = todayISODate();
  const input = $('#catchup-date');
  input.max = today;
  input.min = shiftISODate(today, -CATCHUP_MAX_AGE_DAYS);
  input.value = date && date <= today ? date : shiftISODate(today, -1);
  $('#catchup-status').textContent = '';
  await catchupLoadDay(input.value);
  dlg.showModal();
}

function setupCatchupUI() {
  const dlg = $('#catchup-dialog');
  if (!dlg) return;

  $('#catchup-open')?.addEventListener('click', (e) => {
    e.preventDefault();
    openCatchup(shiftISODate(todayISODate(), -1));
  });

  // Every bar in the three trend strips is a handle on that day.
  ['#mood-trend-bars', '#appetite-trend-bars', '#foodnoise-trend-bars'].forEach(sel => {
    const wrap = $(sel);
    if (!wrap) return;
    wrap.addEventListener('click', (e) => {
      const bar = e.target.closest('.mood-bar');
      if (bar && bar.dataset.date) openCatchup(bar.dataset.date);
    });
  });

  $('#catchup-date').addEventListener('change', async (e) => {
    $('#catchup-status').textContent = '';
    await catchupLoadDay(e.target.value);
  });

  $$('#catchup-mood-picker .mood-btn').forEach(btn => btn.addEventListener('click', () => {
    const v = parseInt(btn.dataset.mood, 10);
    catchupDraft.mood = catchupDraft.mood === v ? null : v;  // tap again to unset
    catchupPaint();
  }));
  $$('#catchup-appetite-picker .appetite-btn').forEach(btn => btn.addEventListener('click', () => {
    const v = parseInt(btn.dataset.appetite, 10);
    catchupDraft.appetite = catchupDraft.appetite === v ? null : v;
    catchupPaint();
  }));
  const catchupNote = $('#catchup-note');
  if (catchupNote) {
    catchupNote.setAttribute('maxlength', String(NOTE_MAX));
    catchupNote.addEventListener('input', (e) => {
      catchupDraft.note = e.target.value.slice(0, NOTE_STORE_MAX);
      const state = $('#catchup-note-state');
      if (state) state.textContent = catchupDraft.note.trim() ? 'written' : 'not written';
    });
  }

  $('#catchup-foodnoise').addEventListener('input', (e) => {
    catchupDraft.foodNoise = parseInt(e.target.value, 10);
    catchupPaint();
  });

  renderSePicker($('#catchup-symptoms-picker'), 'csym-');
  $('#catchup-symptoms-picker')?.addEventListener('change', () => {
    catchupDraft.symptoms = readSePicker('csym-');
    catchupPaint();
  });

  $('#catchup-cancel').addEventListener('click', () => dlg.close());

  $('#catchup-clear').addEventListener('click', async () => {
    const date = $('#catchup-date').value;
    if (!date) return;
    // Spell out that a written note goes too. The other three are one tap to
    // re-enter; a paragraph about your week is not.
    const warning = catchupDraft.noteOriginal
      ? `Remove the mood, appetite, food-noise, side effects AND the written note for ${date}? The note can't be recovered.`
      : `Remove the mood, appetite, food-noise and side-effect entries for ${date}?`;
    if (!confirm(warning)) return;
    await Promise.all([deleteMood(date), deleteAppetite(date), deleteFoodNoise(date), deleteNote(date), deleteSymptomDay(date)]);
    catchupDraft.mood = catchupDraft.appetite = catchupDraft.foodNoise = null;
    catchupDraft.note = catchupDraft.noteOriginal = '';
    catchupDraft.symptoms = null;
    catchupDraft.symptomsOriginal = '{}';
    writeSePicker('csym-', null);
    catchupPaint();
    await refreshDailyCards();
    try { await renderShots(); } catch (_) {}
    markSyncDirty();
    dlg.close();
    toast(`Cleared ${date}`);
    track('catchup_cleared', {});
  });

  $('#catchup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const status = $('#catchup-status');
    const date = $('#catchup-date').value;
    const today = todayISODate();
    if (!date) { status.textContent = 'Pick a day first.'; return; }
    if (date > today) { status.textContent = "That day hasn't happened yet."; return; }
    if (date < shiftISODate(today, -CATCHUP_MAX_AGE_DAYS)) {
      status.textContent = 'That day is too far back.';
      return;
    }
    const noteChanged = (catchupDraft.note || '').trim() !== (catchupDraft.noteOriginal || '').trim();
    const symptomsChanged = JSON.stringify(catchupDraft.symptoms || {}) !== (catchupDraft.symptomsOriginal || '{}');
    if (!catchupDraft.mood && !catchupDraft.appetite && !catchupDraft.foodNoise && !noteChanged && !symptomsChanged) {
      status.textContent = 'Nothing to save — set a mood, appetite, food-noise level, side effects, or write a note.';
      return;
    }
    const writes = [];
    if (catchupDraft.mood) writes.push(saveMood(date, catchupDraft.mood));
    if (catchupDraft.appetite) writes.push(saveAppetite(date, catchupDraft.appetite));
    if (catchupDraft.foodNoise) writes.push(saveFoodNoise(date, catchupDraft.foodNoise));
    // saveNote deletes the day when the text is empty, so this handles both
    // writing a new note and clearing an existing one.
    if (noteChanged) writes.push(saveNote(date, catchupDraft.note));
    // saveSymptomDay deletes the day when nothing is selected, so clearing every
    // dropdown back to "None" removes the entry rather than storing an empty one.
    if (symptomsChanged) writes.push(saveSymptomDay(date, catchupDraft.symptoms));
    try {
      await Promise.all(writes);
      await ensurePersisted();
    } catch (ex) {
      status.textContent = 'Could not save: ' + (ex && ex.message ? ex.message : 'unknown error');
      return;
    }
    await refreshDailyCards();
    // The side-effect summary and insights are rebuilt by renderShots, so a
    // backdated symptom would otherwise not appear until the next reload.
    if (symptomsChanged) { try { await renderShots(); } catch (_) {} }
    markSyncDirty();
    dlg.close();
    toast(date === today ? 'Saved for today' : `Saved for ${date}`);
    track('catchup_saved', {
      backdated: date !== today,
      fields: [
        catchupDraft.mood ? 'mood' : null,
        catchupDraft.appetite ? 'appetite' : null,
        catchupDraft.foodNoise ? 'foodNoise' : null,
        noteChanged ? 'note' : null,
        symptomsChanged ? 'symptoms' : null,
      ].filter(Boolean).join('+'),
    });
  });
}

// Re-render the four daily cards and their trend strips together — a catch-up
// write can land on today (which changes the cards) or on any past day (which
// only changes the strips and the journal), and the caller shouldn't have to
// know which.
async function refreshDailyCards() {
  try { await renderMood(); } catch (_) {}
  try { await renderAppetite(); } catch (_) {}
  try { await renderFoodNoise(); } catch (_) {}
  try { await renderNote(); } catch (_) {}
  try { await renderSymptomsCard(); } catch (_) {}
}
