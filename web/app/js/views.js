// My GLP Shot: Tab switching and the shared data getters every screen reads.
'use strict';

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
// Parse a stored date that might be 'YYYY-MM-DD', 'YYYY-MM-DDTHH:MM[:SSZ]', a Date, a number, or
// the various locale formats older imports may have left behind. Returns ms since epoch (or NaN).
// Bare YYYY-MM-DD is anchored to local midnight so day-bucket comparisons line up with the user's calendar.
function parseDateFlexible(d) {
  if (d == null) return NaN;
  if (d instanceof Date) return d.getTime();
  if (typeof d === 'number') return d > 1e12 ? d : d * 1000; // accept seconds or ms
  const s = String(d).trim();
  if (!s) return NaN;
  // Pure numeric string — treat as epoch.
  if (/^\d{10,13}$/.test(s)) {
    const n = parseInt(s, 10);
    return n > 1e12 ? n : n * 1000;
  }
  // YYYY-MM-DD (bare): a calendar-day label, not an instant. Anchor to local
  // NOON, not midnight. A midnight anchor sits within a few hours of the day
  // boundary, so re-reading it in any other timezone — the user's configured
  // one, or their device's after they travel — lands on the previous or next
  // day. Noon has ~12 hours of slack in both directions, which no real offset
  // crosses, so the day label survives the round trip.
  // Anchored at both ends. Without the $, a full timestamp like a shot's
  // '2026-09-28T02:00:00.000Z' matched here, lost its time, and was filed under
  // the UTC date: any evening shot west of UTC landed on the next day.
  const ymd = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (ymd) {
    const t = new Date(+ymd[1], +ymd[2] - 1, +ymd[3], 12, 0, 0).getTime();
    return Number.isFinite(t) ? t : NaN;
  }
  // M/D/YYYY or D/M/YYYY (best-effort: assume month-first US format, then fall through to Date.parse).
  const slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (slash) {
    let yr = +slash[3]; if (yr < 100) yr += 2000;
    const t = new Date(yr, +slash[1] - 1, +slash[2]).getTime();
    if (Number.isFinite(t)) return t;
  }
  // Final fallback — let the engine try, then re-anchor to local midnight so cutoff
  // comparisons line up with the user's calendar (an ISO-with-Z parsed in UTC could
  // otherwise read as the previous day for users west of UTC).
  const tParsed = Date.parse(s);
  if (!Number.isFinite(tParsed)) return NaN;
  const dParsed = new Date(tParsed);
  return new Date(dParsed.getFullYear(), dParsed.getMonth(), dParsed.getDate()).getTime();
}

// Convert any flexible date input to a canonical local YYYY-MM-DD string.
// Returns null if unparseable.
function toCanonicalDate(d) {
  // A bare YYYY-MM-DD is already a calendar day — it has no timezone to
  // interpret. Round-tripping it through a timestamp shifts it: anchoring at
  // local noon then reformatting in a zone 14 hours away (Pacific/Kiritimati,
  // say) lands on the next day. Return it as-is.
  if (typeof d === 'string') {
    const bare = d.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (bare) return `${bare[1]}-${bare[2]}-${bare[3]}`;
  }
  // A timestamp with a time of day is one instant: bucket it directly. Going
  // through parseDateFlexible would re-anchor it to device-local midnight first,
  // which is a day off whenever the device and the setting disagree.
  const instant = (typeof d === 'string' && /T\d{2}:\d{2}/.test(d)) ? Date.parse(d) : NaN;
  const t = Number.isFinite(instant) ? instant : parseDateFlexible(d);
  if (!Number.isFinite(t)) return null;
  // Bucket by the user's configured timezone, the same basis todayISODate()
  // uses. These used to disagree — this read the device clock while "today"
  // read the setting — so anyone whose device timezone differed from their
  // setting could log an entry and have it filed under a different day than
  // the one the app was calling today.
  const p = _tzParts(new Date(t), getUserTz());
  return `${p.year}-${p.month}-${p.day}`;
}
