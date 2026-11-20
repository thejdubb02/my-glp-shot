// My GLP Shot: Backup export, file import, import sanitising, Shotsy CSV import, wipe.
'use strict';

// ---------- Export / Import ----------
//
// This is the ONLY backup a user without cloud sync has, and the Backup card
// tells them to "export regularly". It used to write shots, weights and
// settings and nothing else — moods, appetite, food noise, notes, cycles,
// symptoms, supplies, measurements, labs and spending were all silently left
// out, and the import side only read those same three back. Someone following
// the app's own advice kept a backup missing most of their history and would
// only discover it after wiping a device.
//
// It now writes the same complete payload the cloud sync uses, so "export" and
// "back up" finally mean the same thing. Old files still import (see below).
async function exportData() {
  const payload = await buildPayload();
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `myglpshot-backup-${todayISODate()}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  settings.lastBackup = new Date().toISOString();
  await saveSettings();
  updateBackupLabel();
  track('export_json', {
    shots: (payload.shots || []).length,
    weights: (payload.weights || []).length,
    stores: EXPORT_STORE_KEYS.filter(k => (payload[k] || []).length).length,
  });
}


// A human count of what a payload actually contains, for the import confirm
// prompt. Without this the user is asked to approve a merge sight-unseen.
function summarisePayload(p) {
  const LABELS = {
    shots: 'shots', weights: 'weight entries', moods: 'mood days',
    appetites: 'appetite days', foodNoise: 'food-noise days', notes: 'notes',
    symptoms: 'symptom days', cycles: 'cycle entries', medChanges: 'medication changes',
    supplies: 'pens/vials', measurements: 'measurements', labs: 'lab results',
    expenses: 'spending entries',
  };
  return EXPORT_STORE_KEYS
    .filter(k => Array.isArray(p[k]) && p[k].length)
    .map(k => `${p[k].length} ${LABELS[k]}`);
}
async function smartImport(e) {
  const file = e.target.files[0];
  if (!file) return;
  const btn = $('#smart-import-btn');
  const orig = btn.textContent;
  try {
    if (file.size > 1500 * 1024) {
      throw new Error('File is over 1.5 MB. Trim it down or split into chunks.');
    }
    const text = await file.text();
    if (!account.user) {
      throw new Error('Sign in first — Smart Import sends the file to our server for AI parsing.');
    }
    if (!confirm(`Use AI to parse "${file.name}" (${file.size} bytes)?\n\nThis sends the FILE TEXT to our server for parsing only. The parsed shots/weights are then merged into your local data.`)) {
      return;
    }
    btn.disabled = true;
    btn.textContent = '✨ Parsing with AI…';
    track('smart_import_started', { size_bytes: file.size });
    const r = await accountFetch('import/parse', {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      track('smart_import_failed', { status: r.status });
      throw new Error(j.message || `Failed (${r.status})`);
    }
    const j = await r.json();
    // The parser is an LLM reading a user-supplied file: treat its output as
    // untrusted. sanitizeShot/Weight drop anything with an unusable date or
    // dose rather than letting one bad row abort a 2000-row import.
    const shots = (Array.isArray(j.shots) ? j.shots : [])
      .map(s => sanitizeShot({ ...s, med: s && s.med ? s.med : (settings.medication || 'Tirzepatide') }))
      .filter(Boolean);
    // kg rows used to be flattened to lb here because kg was not really
    // supported anywhere downstream. It is now — display converts on the way
    // out — so keep the reading the user actually recorded.
    const weights = (Array.isArray(j.weights) ? j.weights : []).map(sanitizeWeight).filter(Boolean);
    if (!shots.length && !weights.length) {
      alert('AI did not find any shots or weights in this file.');
      return;
    }
    if (!confirm(`Found ${shots.length} shots and ${weights.length} weight entries. Import them now?`)) return;
    await importRows(STORES.shots, shots);
    await importRows(STORES.weights, weights.map(w => ({ value: w.value, date: w.date })));
    await renderShots();
    await renderWeights();
    markSyncDirty();
    track('smart_import_success', { shots: shots.length, weights: weights.length });
    alert(`✓ Imported ${shots.length} shots and ${weights.length} weights.`);
  } catch (ex) {
    alert('Smart import failed: ' + (ex.message || ex));
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
    e.target.value = '';
  }
}

// ---------- Import sanitising ----------
// Imported files (and LLM-parsed exports) are untrusted input that ends up in
// innerHTML sinks. Coercing types at the door is the only place this has to be
// got right — every renderer downstream then gets a number where it expects one.
const MAX_TEXT_FIELD = 500;

// Real exports write "7.5", "7.5 mg", "180 lb". They do not write prose, and
// they certainly do not write markup. Stripping every non-digit was too
// forgiving: it turned an injected string into a plausible-looking number and
// imported it as a dose. Match a number with an optional unit, reject the rest.
const NUMERIC_RE = /^\s*(-?\d+(?:[.,]\d+)?)\s*(mg|mcg|ml|cc|units?|iu|u|lbs?|kgs?|kilos?|pounds?|%)?\s*$/i;

function safeNum(v, { min = -1e9, max = 1e9, dp = 4 } = {}) {
  let n;
  if (typeof v === 'number') {
    n = v;
  } else {
    const m = NUMERIC_RE.exec(String(v ?? ''));
    if (!m) return null;
    n = parseFloat(m[1].replace(',', '.'));
  }
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Number(n.toFixed(dp))));
}

function safeText(v, max = MAX_TEXT_FIELD) {
  if (v == null) return '';
  return String(v).slice(0, max);
}

function safeISO(v) {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function sanitizeShot(s) {
  if (!s || typeof s !== 'object') return null;
  const when = safeISO(s.when);
  const dose = safeNum(s.dose, { min: 0, max: 1000, dp: 3 });
  if (!when || dose == null) return null;
  const out = {
    when,
    dose,
    med: safeText(s.med, 80) || 'Tirzepatide',
    site: safeText(s.site, 80),
    notes: safeText(s.notes, 2000),
  };
  const se = sanitizeSideEffectMap(s.sideEffects);
  if (se) out.sideEffects = se;
  const hl = safeNum(s.halfLifeDays, { min: 0.01, max: 60, dp: 3 });
  if (hl != null) out.halfLifeDays = hl;
  return keepSyncIdentity(s, out);
}

// uid and updatedAt are how a synced row is recognised and how an edit wins.
// The sanitizers used to rebuild records without them, so every pulled shot and
// weight arrived as a stranger and an edited one came in as a second entry.
function keepSyncIdentity(src, out) {
  if (typeof src.uid === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(src.uid)) out.uid = src.uid;
  const ua = Number(src.updatedAt);
  if (Number.isFinite(ua) && ua > 0) out.updatedAt = ua;
  return out;
}

// Shared by shot records and standalone symptom days. Keys are rendered as
// labels when they aren't in our taxonomy, so restrict them to a safe charset
// rather than merely truncating. Values must be one of the four severity levels.
function sanitizeSideEffectMap(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const LEVELS = new Set(SE_LEVELS.map(l => l[0]));
  const se = {};
  for (const [k, v] of Object.entries(raw).slice(0, 40)) {
    const key = String(k).slice(0, 40).replace(/[^A-Za-z0-9 _-]/g, '');
    if (!key) continue;
    const val = String(v ?? '').toLowerCase();
    se[key] = LEVELS.has(val) ? val : '';
  }
  return se;
}

function sanitizeWeight(w) {
  if (!w || typeof w !== 'object') return null;
  const value = safeNum(w.value, { min: 0, max: 2000, dp: 2 });
  const date = toCanonicalDate(w.date);
  if (value == null || !date) return null;
  return keepSyncIdentity(w, { date, value, unit: w.unit === 'kg' ? 'kg' : 'lb' });
}

// A note is free text, so it is never interpreted — only length-capped and, at
// every render site, escaped. `updatedAt` is kept because the merge needs it to
// decide which side of a conflict is newer.
function sanitizeNote(n) {
  if (!n || typeof n !== 'object') return null;
  const date = toCanonicalDate(n.date);
  const text = safeText(n.text, NOTE_STORE_MAX).trim();
  if (!date || !text) return null;
  const out = { date, text };
  const ts = Date.parse(n.updatedAt);
  if (Number.isFinite(ts)) out.updatedAt = new Date(ts).toISOString();
  return out;
}

// Settings from a file may only overwrite keys we know about, with the type we
// expect. Anything else — including sync credentials — is ignored.
function sanitizeSettings(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const SYNC_KEYS = new Set(['syncEnabled', 'syncUsername', 'syncLastPushAt', 'syncLastPullAt', 'syncLastUpdatedAt', 'syncLastError']);
  const out = {};
  for (const [k, def] of Object.entries(DEFAULT_SETTINGS)) {
    if (SYNC_KEYS.has(k) || !(k in raw)) continue;
    const v = raw[k];
    if (typeof def === 'number') { const n = safeNum(v); if (n != null) out[k] = n; }
    else if (typeof def === 'boolean') { if (typeof v === 'boolean') out[k] = v; }
    else if (typeof def === 'string') out[k] = safeText(v, 200);
    else if (Array.isArray(def) && Array.isArray(v)) out[k] = v.slice(0, 50);
    else if (k === 'dailyReminders') { const dr = sanitizeDailyReminders(v); if (dr) out[k] = dr; }
    else if (def && typeof def === 'object' && v && typeof v === 'object') out[k] = v;
  }
  return out;
}

// dailyReminders was the one nested object passed through untouched, and its
// `time` is interpolated straight into a value="" attribute. An imported file
// could close the attribute and add an event handler from there.
function sanitizeDailyReminders(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out = {};
  for (const r of DAILY_REMINDERS) {
    const e = v[r.key];
    if (!e || typeof e !== 'object') continue;
    const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(e.time || '')) ? String(e.time) : '08:00';
    out[r.key] = { enabled: e.enabled === true, time };
  }
  return out;
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
      if (!parsed || typeof parsed !== 'object') throw new Error('Invalid JSON file');
      // A full payload (v8+, or anything carrying a store beyond shots/weights)
      // goes through the same merge the cloud pull uses — it dedupes by uid and
      // content key, never deletes, and knows how to handle notes and symptoms.
      // Older exports only ever had shots + weights, so they keep the simple path.
      const isFullPayload = Number(parsed.version) >= 8 ||
        EXPORT_STORE_KEYS.some(k => k !== 'shots' && k !== 'weights' && Array.isArray(parsed[k]) && parsed[k].length);

      if (isFullPayload) {
        const parts = summarisePayload(parsed);
        const body = parts.length ? parts.join('\n  • ') : 'nothing recognisable';
        if (!confirm(`Restore this backup?\n\n  • ${body}\n\nThis MERGES with what's already here — nothing is deleted.`)) return;
        await applyPulledPayload(parsed);
        // Deliberately not a record count: only the auto-increment stores report
        // merge stats, so a total would silently omit the date-keyed ones (moods,
        // appetites, food noise, symptoms) and understate what was restored.
        alert(`Backup restored:\n\n  • ${parts.join('\n  • ')}\n\nExisting entries were kept — nothing was overwritten or deleted.`);
      } else {
        if (!Array.isArray(parsed.shots)) throw new Error('Invalid JSON file');
        const shots = parsed.shots.map(sanitizeShot).filter(Boolean);
        const weights = (Array.isArray(parsed.weights) ? parsed.weights : []).map(sanitizeWeight).filter(Boolean);
        const dropped = (parsed.shots.length - shots.length) + ((parsed.weights || []).length - weights.length);
        const warn = dropped > 0 ? `\n\n${dropped} row(s) will be skipped — missing or unreadable date/value.` : '';
        if (!confirm(`Import ${shots.length} shots and ${weights.length} weight entries? This will MERGE with existing data.${warn}`)) return;
        const shotStats = await importRows(STORES.shots, shots);
        const weightStats = await importRows(STORES.weights, weights);
        if (parsed.settings) {
          settings = { ...settings, ...sanitizeSettings(parsed.settings) };
          await saveSettings();
          applySettingsToInputs();
        }
        await renderShots();
        await renderWeights();
        alert(`Imported ${shotStats.added} shots and ${weightStats.added} weight entries.`);
      }
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
  const csvWeightUnit = (cWeight >= 0 && /\bkgs?\b|kilogram/i.test(header[cWeight] || '')) ? 'kg' : 'lb';
  const cDayNotes = colIdx('day notes');
  if (cDate < 0) throw new Error('CSV missing required "Date" column — is this a tracker export?');

  const shotsToAdd = [];
  const weightsToAdd = [];
  // Shotsy's "Day notes" is a note about the day, not about the injection. It used
  // to be appended to the first shot's notes, which buried it and dropped it
  // entirely on days with no shot. It now lands in the notes store where it belongs.
  const dayNotesToAdd = new Map();

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
        const canon = toCanonicalDate(date);
        if (canon) weightsToAdd.push({ value: parseFloat(w), unit: csvWeightUnit, date: canon });
      }
    }

    // Collected per row, not per shot, so a note on a day with no injection
    // survives the import instead of being silently dropped.
    if (cDayNotes >= 0) {
      const dayNote = (row[cDayNotes] || '').trim();
      const canon = dayNote ? toCanonicalDate(date) : null;
      if (canon) {
        const prev = dayNotesToAdd.get(canon);
        // Two rows can share a date in a multi-shot export; keep both lines.
        dayNotesToAdd.set(canon, prev && prev !== dayNote ? `${prev}\n${dayNote}` : dayNote);
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

  if (!dedupedShots.length && !dedupedWeights.length && !dayNotesToAdd.size) {
    throw new Error('No shots, weight entries or notes found in CSV');
  }
  const notePart = dayNotesToAdd.size ? ` and ${dayNotesToAdd.size} daily notes` : '';
  if (!confirm(`Import ${dedupedShots.length} shots, ${dedupedWeights.length} weight entries${notePart}? This will MERGE with existing data.`)) return;

  // A CSV is untrusted input like any other file, so it goes through the same
  // door as the JSON and LLM paths rather than straight into the database.
  const shotStats = await importRows(STORES.shots, dedupedShots.map(sanitizeShot).filter(Boolean));
  const weightStats = await importRows(STORES.weights, dedupedWeights.map(sanitizeWeight).filter(Boolean));
  // Imported notes go through the same merge as a sync pull, so re-importing the
  // same file doesn't duplicate text and an existing note is never overwritten.
  let notesImported = 0;
  if (dayNotesToAdd.size) {
    const rows = [...dayNotesToAdd].map(([date, text]) => ({ date, text, updatedAt: new Date(0).toISOString() }));
    const st = await mergeNotes(rows);
    notesImported = st.added + st.updated + st.combined;
  }
  await ensurePersisted();
  await renderShots();
  await renderWeights();
  if (notesImported) { try { await refreshDailyCards(); } catch (_) {} }
  alert(`Imported ${shotStats.added} shots, ${weightStats.added} weight entries${notesImported ? ` and ${notesImported} daily notes` : ''}.`);
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
  // A failing cloud sync must be visible, not just logged to a console nobody opens.
  const errEl = $('#sync-error-banner');
  if (errEl) {
    if (settings.syncLastError) {
      errEl.textContent = `Cloud backup is failing: ${settings.syncLastError}. Your data is safe on this device — export a copy to be sure.`;
      errEl.hidden = false;
    } else {
      errEl.textContent = '';
      errEl.hidden = true;
    }
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
