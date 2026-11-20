// My GLP Shot: Weight unit conversion and formatting (lb, kg, st).
'use strict';

// ---------- Weight units ----------
// Rows are stored exactly as the user entered them, unit included, so a backup
// restores what they typed and a kitchen-scale reading in kg stays a kg reading.
// Every CALCULATION runs on pounds — the canonical unit for achievement
// thresholds, the plateau limit, and settings.startWeight/goalWeight. Display
// converts to settings.weightUnit at the last moment.
//
// Mixing the two was the bug this replaces: weightDelta() subtracted raw
// stored values, so a kg entry minus an lb entry produced a meaningless number
// that every screen then labelled "lb".
const LB_PER_KG = 2.20462;

function toLb(value, unit) {
  const n = parseFloat(value);
  if (!Number.isFinite(n)) return null;
  return unit === 'kg' ? n * LB_PER_KG : n;
}

function fromLb(lb, unit) {
  const n = parseFloat(lb);
  if (!Number.isFinite(n)) return null;
  return unit === 'kg' ? n / LB_PER_KG : n;
}

// The user's chosen display unit. Anything not explicitly 'kg' is pounds, so a
// missing or corrupt setting degrades to the historical behaviour.
function weightUnit() {
  return settings && settings.weightUnit === 'kg' ? 'kg' : 'lb';
}

// Canonical pounds -> a display string in the user's unit, e.g. "182.0 lb".
function fmtWeight(lb, opts) {
  const o = opts || {};
  const u = weightUnit();
  const v = fromLb(lb, u);
  if (v == null) return '\u2014';
  const s = v.toFixed(o.dp != null ? o.dp : 1);
  return o.bare ? s : `${s} ${u}`;
}

// Canonical pounds -> a signed change, e.g. "\u22122.2 lb". Negative is a loss.
function fmtWeightDelta(lb, opts) {
  const o = opts || {};
  const u = weightUnit();
  const v = fromLb(lb, u);
  if (v == null) return '\u2014';
  const s = Math.abs(v).toFixed(o.dp != null ? o.dp : 1);
  return `${v < 0 ? '\u2212' : '+'}${s}${o.bare ? '' : ' ' + u}`;
}

// Stored rows -> the same rows with a canonical `.lb`, dropping unparseable ones.
function weightsInLb(rows) {
  const out = [];
  for (const w of rows || []) {
    const lb = toLb(w && w.value, w && w.unit);
    if (lb != null) out.push({ ...w, lb });
  }
  return out;
}

async function getWeightsSorted() {
  const all = (await dbAll(STORES.weights)) || [];
  return all.sort((a, b) => parseDateFlexible(a.date) - parseDateFlexible(b.date));
}

// Weight rows -> one group per calendar week (Monday start, local), newest week
// first. changeLb is the week's last reading minus the last reading of the
// previous week that has any, in pounds; null for the earliest week.
function weeklyWeightSummary(weights) {
  const weeks = new Map();
  for (const w of weights || []) {
    const day = toCanonicalDate(w.date);
    if (!day || toLb(w.value, w.unit) == null) continue;
    const d = new Date(`${day}T00:00:00`);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    const key = toCanonicalDate(d);
    if (!weeks.has(key)) weeks.set(key, []);
    weeks.get(key).push({ ...w, _day: day });
  }
  const asc = [...weeks.keys()].sort();
  const out = [];
  let prevLast = null;
  for (const weekStart of asc) {
    // Oldest first within the week (id breaks same-day ties), so the last is the latest reading.
    const rows = weeks.get(weekStart).sort((a, b) => a._day.localeCompare(b._day) || (a.id || 0) - (b.id || 0));
    const last = toLb(rows[rows.length - 1].value, rows[rows.length - 1].unit);
    out.push({
      weekStart,
      entries: rows.reverse().map(({ _day, ...w }) => w),
      changeLb: prevLast == null ? null : last - prevLast,
    });
    prevLast = last;
  }
  return out.reverse();
}

// A reading more than 10% away from a neighbouring one is almost always a
// slipped digit (1xx for 2xx), so the form asks before saving it.
function weightLooksLikeTypo(prevLb, newLb) {
  return Math.abs(newLb - prevLb) > 0.1 * prevLb;
}

// One-time normalizer: rewrite any weights row whose .date isn't already canonical
// local YYYY-MM-DD. Idempotent — re-runs on every boot but only writes when needed.
// This unblocks users who have legacy entries from CSV imports or sync round-trips
// that left dates in formats Date.parse interpreted as UTC, drifting them across
// the local-midnight cutoff used by the range filter.
let _weightDateMigrationDone = false;
// eraseLocalData waits on the run in flight, so it cannot write old rows back
// after the erase.
let _weightMigrationRun = Promise.resolve(0);
function migrateWeightDatesToCanonical() {
  if (_weightDateMigrationDone) return _weightMigrationRun;
  _weightDateMigrationDone = true;
  return (_weightMigrationRun = runWeightDateMigration());
}
async function runWeightDateMigration() {
  const all = (await dbAll(STORES.weights)) || [];
  let fixed = 0;
  for (const w of all) {
    const canon = toCanonicalDate(w.date);
    if (canon && canon !== w.date) {
      await dbPut(STORES.weights, { ...w, date: canon });
      fixed++;
    }
  }
  if (fixed) console.log(`[weight-migration] normalized ${fixed} of ${all.length} weight dates to canonical YYYY-MM-DD`);
  return fixed;
}
