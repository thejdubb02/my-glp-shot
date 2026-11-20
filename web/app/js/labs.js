// My GLP Shot: Lab tracking (premium).
'use strict';

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
  // Through dbPut, not a raw put: a raw put skipped uid assignment, so these
  // rows could only be matched across devices by content.
  return dbPut('labs', l);
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
