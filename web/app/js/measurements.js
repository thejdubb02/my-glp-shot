// My GLP Shot: Body measurements (premium).
'use strict';

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
  // Through dbPut, not a raw put: a raw put skipped uid assignment, so these
  // rows could only be matched across devices by content.
  return dbPut('measurements', m);
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
  // Same trap as weight: each row carries its own unit, so subtracting a cm
  // reading from an inch one produced an unlabelled, wrong trend number.
  // Normalise through inches, then show the trend in the latest row's unit.
  const CM_PER_IN = 2.54;
  const toIn = (m) => {
    const n = parseFloat(m && m.value);
    if (!Number.isFinite(n)) return null;
    return m.unit === 'cm' ? n / CM_PER_IN : n;
  };
  // Show them in the dropdown's head-to-toe order, so bust sits next to high
  // bust rather than wherever each one happened to be logged first.
  const rank = (k) => { const i = MEASUREMENT_TYPES.findIndex(t => t.key === k); return i < 0 ? 99 : i; };
  wrap.innerHTML = Object.entries(byType).sort((a, b) => rank(a[0]) - rank(b[0])).map(([type, vals]) => {
    const latest = vals[vals.length - 1];
    const earliest = vals[0];
    const latestIn = toIn(latest), earliestIn = toIn(earliest);
    const unit = latest.unit === 'cm' ? 'cm' : 'in';
    let trend = '';
    if (vals.length > 1 && latestIn != null && earliestIn != null) {
      const deltaIn = latestIn - earliestIn;
      const shown = unit === 'cm' ? deltaIn * CM_PER_IN : deltaIn;
      const trendCls = deltaIn < 0 ? 'down' : deltaIn > 0 ? 'up' : '';
      trend = `<span class="summary-trend ${trendCls}">${deltaIn < 0 ? '\u2212' : '+'}${Math.abs(shown).toFixed(1)}</span>`;
    }
    return `<div class="summary-pill">
      <span class="summary-label">${MEASUREMENT_LABELS[type] || type}</span>
      <span class="summary-value">${latest.value} ${latest.unit}</span>
      ${trend}
    </div>`;
  }).join('');
}
