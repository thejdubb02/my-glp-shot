// My GLP Shot: Weight and dose charts; Chart.js loaded on demand.
'use strict';

// ---------- Charts ----------
let weightChart, levelChart;
let _weightRangeDays = 'all'; // 'all' | 30 | 90 | 180 | 365
async function renderWeights() {
  const wsAll = await getWeightsSorted();
  const shots = await getShotsSorted();
  await renderHero(shots, wsAll);
  renderWeightCard(wsAll);
  renderWeightHistory(wsAll);
  const empty = $('#empty-weight');
  const ctx = $('#weight-chart');
  if (!wsAll.length) {
    empty.classList.remove('hidden');
    ctx.style.display = 'none';
    if (weightChart) { weightChart.destroy(); weightChart = null; }
    return;
  }
  // Apply selected range filter (default = all). Day-precision cutoff at local midnight.
  let ws = wsAll;
  let unparseable = 0;
  if (_weightRangeDays !== 'all') {
    const days = parseInt(_weightRangeDays, 10);
    const cutoff = new Date(); cutoff.setHours(0,0,0,0); cutoff.setDate(cutoff.getDate() - days);
    const cutoffMs = cutoff.getTime();
    ws = wsAll.filter(w => {
      const t = parseDateFlexible(w.date);
      if (!Number.isFinite(t)) { unparseable++; console.warn('[weight-chart] unparseable date, skipping:', w.date, w); return false; }
      return t >= cutoffMs;
    });
    console.log(`[weight-chart] range=${days}d cutoff=${new Date(cutoffMs).toISOString().slice(0,10)} total=${wsAll.length} kept=${ws.length} unparseable=${unparseable}`);
  }
  empty.classList.add('hidden');
  ctx.style.display = 'block';
  if (!ws.length) {
    if (weightChart) { weightChart.destroy(); weightChart = null; }
    ctx.style.display = 'none';
    const detail = wsAll.length
      ? `<br><span class="muted small">${wsAll.length} entries on file${unparseable ? `, ${unparseable} with unrecognized date format` : ''}. Most recent: ${wsAll[wsAll.length-1]?.date || '?'}</span>`
      : '';
    empty.innerHTML = `<span class="empty-illus">⚖</span><br>No weight entries in this range. Try a wider time window.${detail}`;
    empty.classList.remove('hidden');
    return;
  }
  const labels = ws.map(w => fmtDateShort(w.date));
  const unit = weightUnit();
  // Normalise through pounds so a series with mixed entry units plots as one
  // continuous line instead of a cliff at the point the user switched scales.
  const data = ws.map(w => Number(fromLb(toLb(w.value, w.unit), unit).toFixed(1)));
  // Compute padded Y-axis bounds. If weights cluster within a small range (very common
  // for short windows like 1M), Chart.js's auto-scale produces a near-flat line at the
  // top of the canvas, which reads as "broken." Force at least a sensible visible range.
  const minVal = Math.min(...data);
  const maxVal = Math.max(...data);
  const observedSpread = maxVal - minVal;
  const minSpread = unit === 'kg' ? 4 : 8; // ~8 lb / 4 kg minimum on screen
  const pad = Math.max((minSpread - observedSpread) / 2, observedSpread * 0.15);
  const yMin = Math.max(0, Math.floor(minVal - pad));
  const yMax = Math.ceil(maxVal + pad);
  // Compute event markers — vertical dashed lines on the weight chart for
  // dose-increase events and medication-switch events. Indexes are the weight
  // entry whose date is closest to (and ≤) the event date.
  const eventMarkers = [];
  try {
    const allShots = await getShotsSorted();
    const sortedShotsAsc = [...allShots].sort((a, b) => new Date(a.when) - new Date(b.when));
    const findClosestIdx = (eventDate) => {
      const t = new Date(eventDate).getTime();
      let bestIdx = -1, bestDelta = Infinity;
      for (let i = 0; i < ws.length; i++) {
        const wt = parseDateFlexible(ws[i].date);
        if (!Number.isFinite(wt) || wt > t) continue;
        const d = t - wt;
        if (d < bestDelta) { bestDelta = d; bestIdx = i; }
      }
      // 30-day window so markers don't drift too far from their event.
      return bestDelta <= 30 * 86400000 ? bestIdx : -1;
    };
    // Dose-increase events
    for (let i = 1; i < sortedShotsAsc.length; i++) {
      if (sortedShotsAsc[i].dose > sortedShotsAsc[i - 1].dose) {
        const idx = findClosestIdx(sortedShotsAsc[i].when);
        if (idx >= 0) eventMarkers.push({ index: idx, label: `↑${sortedShotsAsc[i].dose}mg`, color: '#10b981' });
      }
    }
    // Medication-switch events
    const medChanges = await getMedChangesSorted();
    for (const m of medChanges) {
      const idx = findClosestIdx(m.when);
      if (idx >= 0) eventMarkers.push({ index: idx, label: '🔄', color: '#a855f7' });
    }
  } catch (e) { console.warn('event markers compute failed', e); }

  // Optional clinical-trial benchmark overlay (premium). Anchored to the user's
  // first shot date (or first weight entry if no shots) and their starting weight.
  const datasets = [{ label: `Weight (${unit})`, data, borderColor: getThemeColor('--bronze-dk'), backgroundColor: getThemeColorAlpha('--bronze', .2), tension: .3, fill: true, pointRadius: 3, pointHoverRadius: 6, pointHitRadius: 18 }];
  if (isPremium() && _benchmarkChoice && TRIAL_CURVES[_benchmarkChoice]) {
    try {
      const allShots = await getShotsSorted();
      const firstShotDate = allShots.length ? new Date([...allShots].sort((a,b) => new Date(a.when)-new Date(b.when))[0].when) : new Date(parseDateFlexible(ws[0].date));
      const startWeight = data[0];  // user's first visible weight
      const trial = TRIAL_CURVES[_benchmarkChoice];
      const benchData = ws.map(w => {
        const t = parseDateFlexible(w.date);
        const week = Math.max(0, (t - firstShotDate.getTime()) / (7 * 86400000));
        const pct = trialPctAtWeek(_benchmarkChoice, week);
        return pct == null ? null : +(startWeight * (1 + pct / 100)).toFixed(1);
      });
      datasets.push({
        label: trial.name,
        data: benchData,
        borderColor: trial.color,
        borderDash: [5, 4],
        backgroundColor: 'transparent',
        tension: .3,
        fill: false,
        pointRadius: 0,
        pointHoverRadius: 4,
      });
    } catch (e) { console.warn('benchmark overlay failed', e); }
  }
  if (!await ensureChart()) return;
  if (weightChart) weightChart.destroy();
  weightChart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      // Headroom for event-marker labels rendered above the plot area.
      layout: { padding: { top: eventMarkers.length ? 18 : 0 } },
      interaction: { mode: 'index', intersect: false, axis: 'x' },
      hover: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: datasets.length > 1, position: 'bottom', labels: { boxWidth: 18, font: { size: 11 } } },
        tooltip: {
          mode: 'index', intersect: false,
          callbacks: {
            title: (items) => items.length ? ws[items[0].dataIndex].date : '',
            label: (ctx2) => `${ctx2.dataset.label}: ${ctx2.parsed.y == null ? 'n/a' : ctx2.parsed.y + ' ' + unit}`,
          },
        },
        eventMarkers: { markers: eventMarkers },
      },
      scales: { y: { beginAtZero: false, suggestedMin: yMin, suggestedMax: yMax } },
    },
  });
}

// ---------- Chart.js, loaded on demand ----------
// 68 KB gzipped that only the Insights tab needs. It used to be a blocking
// <script> in index.html, so every visitor paid for it on first paint even if
// they never opened a chart. Now it is fetched the first time a chart is drawn.
//
// The plugin below MUST be registered by this loader rather than at module
// scope: with the library deferred, a module-scope `typeof Chart !== 'undefined'`
// check runs before the library exists, silently skips, and the dose-increase
// markers never appear again.
let _chartPromise = null;

function ensureChart() {
  if (typeof Chart !== 'undefined') { registerChartPlugins(); return Promise.resolve(true); }
  if (_chartPromise) return _chartPromise;
  _chartPromise = new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = 'lib/chart.min.js';
    s.async = true;
    s.onload = () => { registerChartPlugins(); resolve(true); };
    s.onerror = () => {
      // Let a later attempt retry rather than caching the failure forever —
      // this is usually a flaky connection, not a missing file.
      _chartPromise = null;
      console.warn('[mgs] chart library failed to load');
      resolve(false);
    };
    document.head.appendChild(s);
  });
  return _chartPromise;
}

// Chart.js plugin — draws dashed vertical markers at given indexes with a
// short label above the chart. Used on the weight chart to flag dose increases
// and medication-switch events. Registered once, after the library is present.
function registerChartPlugins() {
  if (typeof Chart === 'undefined' || Chart._mgsEventMarkersRegistered) return;
  Chart.register({
    id: 'eventMarkers',
    afterDatasetsDraw(chart) {
      const opts = chart.options.plugins && chart.options.plugins.eventMarkers;
      if (!opts || !opts.markers || !opts.markers.length) return;
      const x = chart.scales.x, y = chart.scales.y;
      if (!x || !y) return;
      const ctx = chart.ctx;
      ctx.save();
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.font = 'bold 10px -apple-system, system-ui, sans-serif';
      ctx.textAlign = 'center';
      // De-dup label collisions: if two markers share the same index, stack labels.
      const seen = {};
      for (const m of opts.markers) {
        if (m.index == null || m.index < 0) continue;
        const px = x.getPixelForValue(m.index);
        ctx.strokeStyle = m.color || 'rgba(120,120,120,0.6)';
        ctx.beginPath();
        ctx.moveTo(px, y.top);
        ctx.lineTo(px, y.bottom);
        ctx.stroke();
        const stack = (seen[m.index] = (seen[m.index] || 0) + 1);
        ctx.fillStyle = m.color || '#888';
        ctx.fillText(m.label || '', px, y.top - 2 - (stack - 1) * 11);
      }
      ctx.restore();
    },
  });
  Chart._mgsEventMarkersRegistered = true;
}


// Clinical-trial benchmark curves — approximate published average-completer
// curves, expressed as % weight loss vs week of treatment. Anchored to the
// user's first shot date and the unit/scale of their first weight entry.
// Sources are FDA labels and the trial publications; a small cleanup-week
// table is interpolated linearly between known points.
const TRIAL_CURVES = {
  surmount1: {
    name: 'SURMOUNT-1 — Tirzepatide 15 mg',
    color: '#0ea5e9',
    points: [[0,0],[4,-3],[12,-8],[24,-15],[40,-19],[60,-21.5],[72,-22.5]],
  },
  step1: {
    name: 'STEP-1 — Semaglutide 2.4 mg',
    color: '#a855f7',
    points: [[0,0],[4,-2],[12,-5],[24,-9],[40,-12],[60,-14],[68,-14.9]],
  },
  scale: {
    name: 'SCALE — Liraglutide 3 mg',
    color: '#10b981',
    points: [[0,0],[12,-4],[24,-6],[40,-7.5],[56,-8]],
  },
};
function trialPctAtWeek(curveId, week) {
  const c = TRIAL_CURVES[curveId]; if (!c) return null;
  const pts = c.points;
  if (week <= pts[0][0]) return pts[0][1];
  if (week >= pts[pts.length-1][0]) return pts[pts.length-1][1];
  for (let i = 1; i < pts.length; i++) {
    if (week <= pts[i][0]) {
      const [w0, p0] = pts[i-1], [w1, p1] = pts[i];
      const f = (week - w0) / (w1 - w0);
      return p0 + (p1 - p0) * f;
    }
  }
  return null;
}
let _benchmarkChoice = '';

function setupBenchmarkSelector() {
  const sel = $('#benchmark-select');
  const lock = $('#benchmark-lock');
  if (!sel) return;
  // Hide the lock pill if user is premium.
  if (lock) lock.classList.toggle('hidden', isPremium());
  sel.addEventListener('change', async (e) => {
    if (!isPremium() && e.target.value) {
      e.target.value = '';
      $('#upgrade-dialog').showModal();
      return;
    }
    _benchmarkChoice = e.target.value;
    settings._benchmarkChoice = _benchmarkChoice;  // soft-persist (not synced)
    await saveSettings();
    await renderWeights();
  });
  // Restore prior selection if premium.
  if (isPremium() && settings._benchmarkChoice) {
    _benchmarkChoice = settings._benchmarkChoice;
    sel.value = _benchmarkChoice;
  }
}

function setupWeightRangeButtons() {
  document.querySelectorAll('.range-btn[data-range]').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.range-btn[data-range]').forEach(b => b.classList.toggle('active', b === btn));
      _weightRangeDays = btn.dataset.range === 'all' ? 'all' : btn.dataset.range;
      track('weight_range_changed', { range: _weightRangeDays });
      await renderWeights();
    });
  });
}

// Body sex toggle removed 2026-05-03 — only the male silhouette is anatomically right; female version was deferred.
function setupBodyToggle() { /* no-op */ }

async function renderLevelChart(shots) {
  const ctx = $('#level-chart');
  if (!shots.length) {
    if (levelChart) { levelChart.destroy(); levelChart = null; }
    return;
  }
  // Per-shot half-life: shots logged on or after v0.45.2 carry their own
  // halfLifeDays snapshot. Fallback to settings for older shots.
  const settingsHL = settings.halfLifeDays || 5;
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
      const hl = (s.halfLifeDays && s.halfLifeDays > 0) ? s.halfLifeDays : settingsHL;
      const decay = Math.log(2) / hl;
      const days = (d - sd) / 86400000;
      level += s.dose * Math.exp(-decay * days);
    }
    data.push(parseFloat(level.toFixed(2)));
  }
  if (!await ensureChart()) return;
  if (levelChart) levelChart.destroy();
  levelChart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets: [{ data, borderColor: getThemeColor('--bronze'), backgroundColor: getThemeColorAlpha('--bronze', .25), tension: .35, fill: true, pointRadius: 0 }] },
    options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, title: { display: true, text: 'mg-equivalent' } } } }
  });
}
