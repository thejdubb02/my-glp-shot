// My GLP Shot: Sync merge: uids, tombstones, per-store merge, applying a pulled payload.
'use strict';

// ---------- Sync merge ----------
// Records get a stable `uid` on write so the same shot logged on a phone and
// pulled onto a tablet is recognised as one record rather than duplicated.
// Rows written before uids existed fall back to a content key, which is stable
// for the fields that actually identify an entry.
function newUid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return HEX(crypto.getRandomValues(new Uint8Array(16)));
}
// Stable uid for a row that arrived without one: two 32-bit FNV-1a hashes of the
// store and content key, so every device derives the same uid for the same row.
function contentUid(store, ck) {
  let a = 0x811c9dc5, b = 0x050c5d1f;
  for (const ch of `${store}|${ck}`) {
    const c = ch.codePointAt(0);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x01000193) ^ (b >>> 15);
  }
  return `ck-${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`;
}

// Content keys identify a record by the fields a human would call "the same
// entry". They exist because rows written before uids have no other identity —
// and because a uid assigned locally to an old row would otherwise differ from
// the uid the same row got on another device, duplicating it on every pull.
const CONTENT_KEYS = {
  shots: (r) => `s|${String(r.when).slice(0, 16)}|${r.dose}|${r.med || 'Tirzepatide'}`,  // sanitizeShot's default med
  weights: (r) => `w|${r.date}`,
  // These four named fields the records never had (med/openedAt/mg, type,
  // start, from/to), so every supply shared one key, as did every cycle and every
  // med change. A restore or a pull onto a new device then kept only the first
  // of each and dropped the rest as "duplicates". Legacy names kept as fallbacks.
  supplies: (r) => `p|${r.type ?? r.med ?? ''}|${r.opened_at ?? r.openedAt ?? ''}|${r.total_mg ?? r.mg ?? ''}|${r.expires_at || ''}|${r.batch || ''}`,
  measurements: (r) => `m|${r.date}|${r.type}`,
  labs: (r) => `l|${r.date}|${r.type}`,
  expenses: (r) => `e|${r.date}|${r.category ?? r.type ?? ''}|${r.amount}`,
  cycles: (r) => `c|${r.startDate || r.start || r.date || ''}`,
  medChanges: (r) => `x|${r.when || r.date || ''}|${r.medication || r.from || ''}|${r.to || ''}`,
};

// A deletion has to travel between devices, or the other device's next push
// brings the row straight back: merges only ever add. A tombstone records what
// was deleted and when. It rides in the sync payload and removes the row on every
// device that still has it, unless that copy was edited after the delete.
// Rows from before uids existed are tombstoned by content key instead.
const TOMBSTONE_TTL_MS = 180 * 86400000;
function tombstoneKey(store, row) {
  return row && row.uid ? row.uid : `ck|${store}|${CONTENT_KEYS[store](row)}`;
}
async function dbDelSynced(store, id) {
  const row = await dbGet(store, id);
  if (row && UID_STORES.has(store)) {
    await dbPutExact('tombstones', { key: tombstoneKey(store, row), store, deletedAt: Date.now() });
  }
  return dbDel(store, id);
}
async function liveTombstones() {
  const cutoff = Date.now() - TOMBSTONE_TTL_MS;
  const all = (await dbAll('tombstones')) || [];
  const live = [];
  for (const t of all) {
    if (t && t.deletedAt > cutoff) live.push(t);
    else await dbDel('tombstones', t.key);
  }
  return live;
}
// Fold incoming tombstones into ours (latest delete wins) and return every live
// one as a Map for mergeStore.
async function mergeTombstones(incoming) {
  for (const t of Array.isArray(incoming) ? incoming : []) {
    if (!t || typeof t.key !== 'string' || t.key.length > 300 || !(UID_STORES.has(t.store) || DAILY_SYNCED.has(t.store))) continue;
    const at = Number(t.deletedAt);
    if (!Number.isFinite(at) || at <= 0) continue;
    const mine = await dbGet('tombstones', t.key);
    if (!mine || at > mine.deletedAt) await dbPutExact('tombstones', { key: t.key, store: t.store, deletedAt: at });
  }
  return new Map((await liveTombstones()).map(t => [t.key, t]));
}
// A device that last pushed longer ago than TOMBSTONE_TTL_MS can hold rows deleted
// elsewhere whose tombstones are already pruned, and a union merge would bring
// them back (#22). Everything it had at that push reached the cloud then, so a row
// no newer than the push and missing from the cloud now was deleted elsewhere.
// Rows added or edited since are kept. Only when that push wrote the same payload
// version as the cloud copy: an older version may have left whole stores out.
// shortcut: symptoms reconcile per day, not per symptom; a single symptom deleted
// elsewhere can return on such a device. Upgrade if that is ever reported.
async function dropRowsDeletedWhileAway(payload) {
  const pushedAt = Date.parse(settings.syncLastPushAt) || 0;
  if (!pushedAt || Date.now() - pushedAt <= TOMBSTONE_TTL_MS || settings.syncLastPushV !== Number(payload.version)) return;
  for (const store of UID_STORES) {
    const cloud = (Array.isArray(payload[store]) ? payload[store] : []).filter(r => r && typeof r === 'object');
    const uids = new Set(cloud.map(r => r.uid));
    const cks = new Set(cloud.map(r => CONTENT_KEYS[store](r)));
    for (const r of (await dbAll(store)) || []) {
      if (r && rowTs(r) <= pushedAt && !uids.has(r.uid) && !cks.has(CONTENT_KEYS[store](r))) await dbDel(store, r.id);
    }
  }
  for (const store of DAILY_SYNCED) {
    const dates = new Set((Array.isArray(payload[store]) ? payload[store] : []).map(r => r && r.date));
    for (const r of (await dbAll(store)) || []) {
      if (r && rowTs(r) <= pushedAt && !dates.has(r.date)) await dbDel(store, r.date);
    }
  }
}
// UID stores stamp updatedAt in ms, the daily stores as an ISO string.
const rowTs = (row) => Number(row.updatedAt) || Date.parse(row.updatedAt) || 0;
const symTs = (row, k) => Number(row.seAt && row.seAt[k]) || rowTs(row);
const buriedBy = (tombs, key, row) => {
  const t = tombs && tombs.get(key);
  return !!t && t.deletedAt >= rowTs(row);
};
// A legacy row (no uid, or a ck- uid derived from its content) may have been
// tombstoned by content key, and shot tombstones written before the med joined
// the shot key still use the old time|dose form. A device that pulled the row
// gave it the ck- uid derived from its content, so a delete there is keyed by
// that uid, which the uid-less copy on the original device or in a backup lacks.
function rowBuried(tombs, store, r, ck) {
  if (r.uid && buriedBy(tombs, r.uid, r)) return true;
  if (r.uid && !String(r.uid).startsWith('ck-')) return false;
  return buriedBy(tombs, contentUid(store, ck), r) || buriedBy(tombs, `ck|${store}|${ck}`, r) ||
    (store === 'shots' && buriedBy(tombs, `ck|shots|s|${String(r.when).slice(0, 16)}|${r.dose}`, r));
}

// The date-keyed daily stores are tombstoned by store and date. Symptom days
// merge per symptom, so they are tombstoned per symptom: day|symptoms|date|key.
const DAILY_SYNCED = new Set(['notes', 'moods', 'appetites', 'foodNoise', 'symptoms']);
const dayKey = (store, date, k) => `day|${store}|${date}${k ? '|' + k : ''}`;
async function tombstoneDay(store, date, subkeys) {
  const deletedAt = Date.now();
  for (const k of subkeys || [null]) await dbPutExact('tombstones', { key: dayKey(store, date, k), store, deletedAt });
}
async function dbDelDay(store, date) {
  const row = await dbGet(store, date);
  if (row) await tombstoneDay(store, date, store === 'symptoms' ? Object.keys(row.se || {}) : null);
  return dbDel(store, date);
}
// Remove local daily rows (or single symptoms) deleted on another device after
// this copy was last written.
async function pruneDailyRows(tombs) {
  for (const t of tombs.values()) {
    const [kind, store, date, k] = t.key.split('|');
    if (kind !== 'day' || !DAILY_SYNCED.has(store) || !date) continue;
    const row = await dbGet(store, date);
    if (!row || t.deletedAt < (store === 'symptoms' ? symTs(row, k) : rowTs(row))) continue;
    if (store !== 'symptoms') { await dbDel(store, date); continue; }
    if (!k || !row.se || !(k in row.se)) continue;
    const se = { ...row.se }, seAt = { ...row.seAt };
    delete se[k]; delete seAt[k];
    if (Object.keys(se).length) await dbPutExact(store, { ...row, se, seAt });
    else await dbDel(store, date);
  }
}

// Union-merge one auto-increment store: keep every local row, add cloud rows we
// don't already have. Never deletes — a pull can only ever add.
//
// A record matches if its uid is already present, or if its content key is and
// one of the two rows has no uid. Legacy rows still dedupe and a pull stays
// idempotent, while two distinct uid-bearing entries that share a content key
// are both kept.
//
// A row both sides know (same uid) is replaced only by a copy with a newer
// updatedAt, which is how an edit reaches the other device. Before this a known
// uid was always skipped, so edits never propagated and the two devices kept
// flipping the cloud copy between their versions.
async function mergeStore(storeName, incoming, contentKey, tombs) {
  const rows = Array.isArray(incoming) ? incoming : [];
  const existing = (await dbAll(storeName)) || [];
  const byUid = new Map();
  const seenContent = new Set();
  // Content keys of legacy rows: no uid, or a uid derived from the content key.
  const legacyContent = new Set();
  const isLegacy = (r) => !r.uid || String(r.uid).startsWith('ck-');
  let added = 0, updated = 0, skipped = 0, removed = 0;
  for (const r of existing) {
    if (!r) continue;
    // Deleted on another device after this copy was last edited.
    if (rowBuried(tombs, storeName, r, contentKey(r))) { await dbDel(storeName, r.id); removed++; continue; }
    if (r.uid) byUid.set(r.uid, r);
    if (isLegacy(r)) legacyContent.add(contentKey(r));
    seenContent.add(contentKey(r));
  }
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') { skipped++; continue; }
    const rec = { ...raw };
    delete rec.id;                 // local autoincrement ids are device-scoped
    const ck = contentKey(rec);
    if (rowBuried(tombs, storeName, rec, ck)) { skipped++; continue; }
    const mine = rec.uid ? byUid.get(rec.uid) : null;
    if (mine) {
      if ((Number(rec.updatedAt) || 0) > (Number(mine.updatedAt) || 0)) {
        const next = { ...rec, id: mine.id };
        await dbPutExact(storeName, next);
        byUid.set(rec.uid, next);
        seenContent.add(ck);
        updated++;
      } else {
        skipped++;
      }
      continue;
    }
    // A content-key match only means "same entry" when one side is a legacy row.
    // Two rows with their own different uids are two entries (two meds logged
    // the same minute at the same dose), so both are kept.
    if (isLegacy(rec) ? seenContent.has(ck) : legacyContent.has(ck)) { skipped++; continue; }
    if (isLegacy(rec)) legacyContent.add(ck);
    // Derived from the content key, so two devices pulling the same legacy row
    // give it the same uid, and the ck- prefix keeps it deduping by content.
    if (!rec.uid) rec.uid = contentUid(storeName, ck);
    byUid.set(rec.uid, rec);
    seenContent.add(ck);
    await dbAddExact(storeName, rec);
    added++;
  }
  return { added, updated, skipped, removed };
}

// File imports (CSV, old shots+weights backup, Smart Import) add rows through the
// same content-key dedupe a sync pull uses, so importing the same file twice adds
// nothing. mergeStore writes rows as received, so stamp updatedAt like dbAdd does.
// Imported rows keep their old updatedAt, so they are not yet in the cloud even
// though they look older than the last push: forget its version until the next one.
const importRows = async (store, rows) => {
  settings.syncLastPushV = null;
  await saveSettings();
  return mergeStore(store, rows.map(r => ({ ...r, updatedAt: r.updatedAt || Date.now() })), CONTENT_KEYS[store]);
};

// Notes are the one daily store that can't take last-write-wins. Mood is a number
// you can re-tap in a second; a note is sentences someone wrote about their life,
// and a pull that silently replaced it would destroy the only copy. So a note
// only ever loses to a NEWER note, and when both sides have text and neither
// contains the other, both are kept rather than one being thrown away.
async function mergeNotes(incoming) {
  const rows = Array.isArray(incoming) ? incoming : [];
  if (!rows.length) return { added: 0, updated: 0, combined: 0, skipped: 0 };
  const stats = { added: 0, updated: 0, combined: 0, skipped: 0 };
  for (const raw of rows) {
    const rec = sanitizeNote(raw);
    if (!rec) { stats.skipped++; continue; }
    const local = await getNote(rec.date);
    const localText = (local && local.text ? String(local.text) : '').trim();
    if (!localText) { await dbPut('notes', rec); stats.added++; continue; }
    if (localText === rec.text) { stats.skipped++; continue; }

    const localTs = Date.parse(local && local.updatedAt) || 0;
    const cloudTs = Date.parse(rec.updatedAt) || 0;
    // One side is a straight extension of the other (the usual case: the same
    // note edited on two devices). Keep the longer, it already contains the rest.
    if (rec.text.includes(localText)) { await dbPut('notes', rec); stats.updated++; continue; }
    if (localText.includes(rec.text)) { stats.skipped++; continue; }

    // Genuinely divergent text. Newer goes first, older is preserved beneath a
    // marker so the user can see both and tidy up. Never cut to NOTE_MAX (#20):
    // nothing typed is ever lost.
    const [first, second] = cloudTs >= localTs ? [rec.text, localText] : [localText, rec.text];
    const combined = `${first}\n\n— also saved on another device —\n${second}`.slice(0, NOTE_STORE_MAX);
    await dbPut('notes', { date: rec.date, text: combined, updatedAt: new Date().toISOString() });
    stats.combined++;
  }
  return stats;
}

// opts.cloud: this is the account's own cloud copy, not a file or legacy restore.
async function applyPulledPayload(payload, opts) {
  // Refuse newer payloads we can't safely interpret — avoids silent data loss
  // if a stale client pulls a blob written by a future schema.
  const SUPPORTED_PAYLOAD_VERSION = 12;
  const pv = Number(payload && payload.version) || 1;
  if (pv > SUPPORTED_PAYLOAD_VERSION) {
    throw new Error(`This cloud backup was written by a newer version of the app (payload v${pv}). Please update before restoring.`);
  }
  await openDB();

  // A pull ADDS cloud records to what is already here. The old behaviour cleared
  // every store first, which silently destroyed anything logged on this device
  // since its last push — and left the database empty if the tab closed midway.
  const stats = {};
  // A file or legacy restore adds rows with old timestamps the cloud has not seen
  // (see importRows); saved with syncLastPullAt below.
  if (opts && opts.cloud) await dropRowsDeletedWhileAway(payload);
  else settings.syncLastPushV = null;
  const tombs = await mergeTombstones(payload.tombstones);
  stats.shots = await mergeStore(STORES.shots, (payload.shots || []).map(sanitizeShot).filter(Boolean), CONTENT_KEYS.shots, tombs);
  stats.weights = await mergeStore(STORES.weights, (payload.weights || []).map(sanitizeWeight).filter(Boolean), CONTENT_KEYS.weights, tombs);
  stats.supplies = await mergeStore('supplies', payload.supplies, CONTENT_KEYS.supplies, tombs);
  stats.measurements = await mergeStore('measurements', payload.measurements, CONTENT_KEYS.measurements, tombs);
  stats.labs = await mergeStore('labs', payload.labs, CONTENT_KEYS.labs, tombs);
  stats.expenses = await mergeStore('expenses', payload.expenses, CONTENT_KEYS.expenses, tombs);
  stats.cycles = await mergeStore('cycles', payload.cycles, CONTENT_KEYS.cycles, tombs);
  stats.medChanges = await mergeStore('medChanges', payload.medChanges, CONTENT_KEYS.medChanges, tombs);

  // Date-keyed daily stores: last write wins per day by updatedAt, one
  // mood/appetite/food-noise reading per date. A pulled row replaces the local one
  // only when strictly newer; a missing stamp counts as oldest. A day deleted
  // after the pulled copy was written stays deleted.
  await pruneDailyRows(tombs);
  const liveDays = (store, rows) => (Array.isArray(rows) ? rows : []).filter(r => r && r.date && !buriedBy(tombs, dayKey(store, r.date), r));
  const putIfNewer = async (store, r) => {
    const local = await dbGet(store, r.date);
    if (!local || rowTs(r) > rowTs(local)) await dbPut(store, { date: r.date, value: r.value, updatedAt: r.updatedAt });
  };
  for (const s of ['moods', 'appetites', 'foodNoise']) for (const r of liveDays(s, payload[s])) await putIfNewer(s, r);
  // Symptom days merge per-symptom rather than last-write-wins: two devices each
  // adding a symptom on the same day should end up with both, not with whichever
  // pushed last. Severity conflicts on the same symptom resolve to the worse one,
  // which is the safe direction for something a clinician may read.
  const SE_RANK = { mild: 1, moderate: 2, severe: 3 };
  for (const raw of (payload.symptoms || [])) {
    const rec = sanitizeSymptomDay(raw);
    if (!rec) continue;
    for (const k of Object.keys(rec.se)) if (buriedBy(tombs, dayKey('symptoms', rec.date, k), { updatedAt: symTs(rec, k) })) delete rec.se[k];
    if (!Object.keys(rec.se).length) continue;
    const local = await getSymptomDay(rec.date);
    if (!local || !local.se) { await dbPut('symptoms', rec); continue; }
    const merged = { ...local.se }, seAt = {};
    for (const [k, lvl] of Object.entries(rec.se)) {
      if (!merged[k] || (SE_RANK[lvl] || 0) > (SE_RANK[merged[k]] || 0)) merged[k] = lvl;
    }
    // Keep the source times rather than stamping now, or a delete made on another
    // device before this merge but pulled after it would lose to the merged copy.
    for (const k of Object.keys(merged)) seAt[k] = Math.max(k in local.se ? symTs(local, k) : 0, k in rec.se ? symTs(rec, k) : 0);
    await dbPut('symptoms', { date: rec.date, se: merged, seAt, updatedAt: new Date(Math.max(rowTs(local), rowTs(rec))).toISOString() });
  }
  // Notes are the exception to last-write-wins — see mergeNotes.
  stats.notes = await mergeNotes(liveDays('notes', payload.notes));

  window._lastMergeStats = stats;
  if (payload.settings) {
    const preserve = { syncEnabled: settings.syncEnabled, syncUsername: settings.syncUsername, syncLastPushAt: settings.syncLastPushAt, syncLastPushV: settings.syncLastPushV, syncLastPullAt: settings.syncLastPullAt, syncLastUpdatedAt: settings.syncLastUpdatedAt };
    settings = { ...DEFAULT_SETTINGS, ...sanitizeSettings(payload.settings), ...preserve };
    await saveSettings();
    applySettingsToInputs();
  }
  settings.syncLastPullAt = new Date().toISOString();
  await saveSettings();
  // Force-refresh weight-date normalization on every pull (sync payloads may have come
  // from older app versions or other devices that hadn't been migrated).
  _weightDateMigrationDone = false;
  await migrateWeightDatesToCanonical();
  await renderShots();
  await renderWeights();
  // Notes pulled from another device have to reach the card and the journal, or
  // they sit in the database invisible until the next reload.
  try { await refreshDailyCards(); } catch (_) {}
}
