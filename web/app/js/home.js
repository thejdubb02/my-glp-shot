// My GLP Shot: Home screen: hero card, countdown ring, body diagram, dose timeline.
'use strict';

// ---------- Hero card ----------
async function renderHero(shots, weights) {
  const card = $('#hero-card');
  if (!shots.length && !weights.length) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  const wd = weightDelta(weights, settings.startWeight);
  const deltaEl = $('#hero-weight-delta');
  if (wd) {
    deltaEl.textContent = fmtWeightDelta(wd.delta);
    deltaEl.classList.toggle('gain', wd.delta > 0);
  } else {
    deltaEl.textContent = '—';
  }
  const streak = computeStreak(shots, settings.cadenceDays || 7);
  $('#hero-streak').textContent = streak || '0';
  $('#hero-shots').textContent = shots.length;

  // Goal progress (or maintenance window if mode is on)
  const goal = parseFloat(settings.goalWeight);
  if (settings.maintenanceMode && wd) {
    // In maintenance, show stability around current rather than progress to goal.
    const drift = wd.current - (goal || wd.start);
    $('#hero-goal-fill').style.width = '100%';
    $('#hero-goal-text').textContent = goal
      ? `🎯 Maintenance · ${fmtWeight(wd.current)} (${fmtWeightDelta(drift)} from ${fmtWeight(goal)} goal)`
      : `🎯 Maintenance · staying at ${fmtWeight(wd.current)}`;
    $('#hero-goal-wrap').classList.remove('hidden');
  } else if (wd && goal && goal < wd.start) {
    const total = wd.start - goal;
    const done = wd.start - wd.current;
    const pct = Math.max(0, Math.min(100, (done / total) * 100));
    $('#hero-goal-fill').style.width = pct + '%';
    $('#hero-goal-text').textContent = `Goal: ${fmtWeight(goal)} · ${pct.toFixed(0)}% there (${fmtWeight(wd.current - goal)} to go)`;
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
// Legacy site names get folded onto the matching canonical lower-abdomen dot
// so shots logged before the 4-quadrant split still color the diagram.
const SITE_LEGACY_ALIAS = {
  'Abdomen — Left':  'Abdomen — Lower Left',
  'Abdomen — Right': 'Abdomen — Lower Right',
};
function renderBodyDiagram(shots) {
  const wrap = $('#body-diagram-wrap');
  if (!wrap) return;
  const recencyMs = {};
  const customRecency = {};
  for (const s of shots) {
    if (!s.site) continue;
    const t = new Date(s.when).getTime();
    const canonical = SITE_LEGACY_ALIAS[s.site] || s.site;
    if (CANONICAL_SITES.includes(canonical)) {
      if (!(canonical in recencyMs) || recencyMs[canonical] < t) recencyMs[canonical] = t;
    } else {
      // Custom site — track separately for the chip strip below.
      if (!(s.site in customRecency) || customRecency[s.site] < t) customRecency[s.site] = t;
    }
  }
  const now = Date.now();
  function colorFor(site) {
    if (!(site in recencyMs)) return { fill: 'transparent', stroke: '#0f766e', label: 'unused' };
    const days = (now - recencyMs[site]) / 86400000;
    if (days < 7)  return { fill: '#fb923c', stroke: '#c2410c', label: 'recent' }; // avoid
    if (days < 14) return { fill: '#0d9488', stroke: '#0f766e', label: 'medium' };
    return { fill: '#5eead4', stroke: '#14b8a6', label: 'fresh' };
  }
  // Render only the 8 canonical sites as dots (legacy keys fold into new ones).
  const sites = CANONICAL_SITES.map(name => {
    const pos = SITE_POSITIONS[name];
    const c = colorFor(name);
    const days = recencyMs[name] ? Math.floor((now - recencyMs[name]) / 86400000) : null;
    const tip = days == null ? `${name} · unused` : `${name} · ${days}d ago`;
    return `<g class="body-site" data-site="${name}"><title>${tip}</title>
      <circle cx="${pos.x}" cy="${pos.y}" r="9" fill="${c.fill}" stroke="${c.stroke}" stroke-width="2"></circle>
      <text x="${pos.x}" y="${pos.y + 22}">${pos.short}</text>
    </g>`;
  }).join('');

  // Anatomical front silhouettes — single continuous outline per sex.
  // Both fit viewBox 200x320 so SITE_POSITIONS dots (arms 60/140@y=90, abd 84/116@y=145, thighs 70/130@y=220) land on the body.
  // Male: broad shoulders (~108 wide at y=70), straight torso, narrow hips, straight legs.
  // Hand-authored male anatomical silhouette (CC0). Female version removed 2026-05-03 pending a better draft.
  const bodyPath = "M 100 8 C 110 8 118 17 118 30 C 118 40 114 47 108 50 L 108 58 C 124 60 138 64 146 72 C 152 78 156 86 156 96 L 156 160 C 156 164 152 166 148 164 C 144 162 142 158 142 154 L 142 96 C 142 88 138 82 132 78 C 128 76 124 76 122 80 L 122 158 C 122 168 124 178 126 188 L 130 250 L 132 316 C 132 318 128 318 124 318 L 118 318 C 116 318 114 316 114 314 L 110 250 L 106 200 L 104 188 L 100 188 L 96 188 L 94 200 L 90 250 L 86 314 C 86 316 84 318 82 318 L 76 318 C 72 318 68 318 68 316 L 70 250 L 74 188 C 76 178 78 168 78 158 L 78 80 C 76 76 72 76 68 78 C 62 82 58 88 58 96 L 58 154 C 58 158 56 162 52 164 C 48 166 44 164 44 160 L 44 96 C 44 86 48 78 54 72 C 62 64 76 60 92 58 L 92 50 C 86 47 82 40 82 30 C 82 17 90 8 100 8 Z";
  // Custom-site chips below the diagram (the body-silhouette can't host them positionally).
  const customNames = Object.keys(customRecency);
  const customChips = customNames.length
    ? `<div class="body-custom-chips" aria-label="Custom injection sites used">${
        customNames.map(name => {
          const days = Math.floor((now - customRecency[name]) / 86400000);
          const cls = days < 7 ? 'recent' : days < 14 ? 'medium' : 'fresh';
          return `<button type="button" class="body-custom-chip ${cls}" data-site="${escapeHTML(name)}" title="${escapeHTML(name)} · ${days}d ago">${escapeHTML(name)}</button>`;
        }).join('')
      }</div>`
    : '';
  wrap.innerHTML = `
    <svg class="body-svg" viewBox="0 0 200 320" xmlns="http://www.w3.org/2000/svg" aria-label="Body diagram showing injection sites">
      <path class="body-shape" d="${bodyPath}"/>
      ${sites}
    </svg>
    ${customChips}
  `;
  // Custom-site chip click → mirror the dot click behavior.
  wrap.querySelectorAll('.body-custom-chip').forEach(b => {
    b.addEventListener('click', () => {
      const name = b.getAttribute('data-site');
      $('#site-suggest-label').textContent = `Tap "+ Log" to start a shot at ${name}`;
      window._preferredNextSite = name;
    });
  });
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

// ---------- Dose timeline strip ----------
function renderDoseTimeline(shots) {
  const wrap = $('#dose-timeline-wrap');
  if (!wrap) { return; }
  if (!shots.length) { wrap.innerHTML = ''; return; }
  const sorted = [...shots].sort((a,b) => new Date(a.when) - new Date(b.when));
  const minT = new Date(sorted[0].when).getTime();
  const maxT = Date.now();
  const span = Math.max(maxT - minT, 86400000);
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
  const fmt = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const totalDays = Math.round(span / 86400000);
  const currentDose = sorted[sorted.length - 1].dose;
  const reversed = [...segments].reverse();
  const rows = reversed.map((seg, i) => {
    const days = Math.max(1, Math.round((seg.end - seg.start) / 86400000));
    const isCurrent = i === 0;
    const prev = reversed[i + 1];
    let arrow = '';
    if (prev) {
      if (seg.dose > prev.dose) arrow = `<span class="dose-arrow up">↑ from ${prev.dose} mg</span>`;
      else if (seg.dose < prev.dose) arrow = `<span class="dose-arrow down">↓ from ${prev.dose} mg</span>`;
    }
    return `<li class="dose-row${isCurrent ? ' current' : ''}">
      <span class="dose-mg">${seg.dose} mg</span>
      <span class="dose-when">${fmt(seg.start)}${isCurrent ? ' → today' : ` → ${fmt(seg.end)}`} <span class="muted small">(${days}d)</span></span>
      ${arrow}
    </li>`;
  }).join('');
  wrap.innerHTML = `
    <div class="dose-timeline-head">
      <strong>Dose history</strong>
      <span class="muted small">Currently <strong>${currentDose} mg</strong>${segments.length > 1 ? ` · ${segments.length - 1} change${segments.length === 2 ? '' : 's'} in ${totalDays}d` : ''}</span>
    </div>
    <ol class="dose-history-list">${rows}</ol>
  `;
}
