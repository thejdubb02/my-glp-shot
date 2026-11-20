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
  // The clear r=16 circle is the tap target; the visible dot is r=11.
  const sites = CANONICAL_SITES.map(name => {
    const pos = SITE_POSITIONS[name];
    const c = colorFor(name);
    const days = recencyMs[name] ? Math.floor((now - recencyMs[name]) / 86400000) : null;
    const tip = days == null ? `${name} · unused` : `${name} · ${days}d ago`;
    return `<g class="body-site" data-site="${name}" role="button" tabindex="0" aria-label="${tip}"><title>${tip}</title>
      <circle cx="${pos.x}" cy="${pos.y}" r="16" fill="transparent"></circle>
      <circle class="body-dot" cx="${pos.x}" cy="${pos.y}" r="11" fill="${c.fill}" stroke="${c.stroke}" stroke-width="2.5"></circle>
      <text x="${pos.x}" y="${pos.y + 23}">${pos.short}</text>
    </g>`;
  }).join('');

  // Front-view figure drawn from rounded shapes, head to knee (every site is
  // above the knee). viewBox 240x300; SITE_POSITIONS in data.js sit on it.
  const figure = `<g class="body-fig">
      <circle cx="120" cy="30" r="20"/>
      <rect x="111" y="46" width="18" height="16"/>
      <path d="M 92 58 L 148 58 Q 170 58 170 78 L 160 128 Q 158 150 164 172 Q 164 188 148 188 L 92 188 Q 76 188 76 172 Q 82 150 80 128 L 70 78 Q 70 58 92 58 Z"/>
      <line x1="64" y1="74" x2="46" y2="166" stroke-width="22"/>
      <line x1="176" y1="74" x2="194" y2="166" stroke-width="22"/>
      <line x1="98" y1="182" x2="94" y2="276" stroke-width="38"/>
      <line x1="142" y1="182" x2="146" y2="276" stroke-width="38"/>
    </g>`;
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
    <svg class="body-svg" viewBox="0 0 240 300" xmlns="http://www.w3.org/2000/svg" aria-label="Body diagram showing injection sites">
      ${figure}
      ${sites}
    </svg>
    ${customChips}
  `;
  // Custom-site chip click → mirror the dot click behavior.
  wrap.querySelectorAll('.body-custom-chip').forEach(b => {
    b.addEventListener('click', () => {
      const name = b.getAttribute('data-site');
      $('#site-suggest-label').textContent = `Tap "+ Log" to start a shot at ${name.replace(" \u2014 ", ", ")}`;
      window._preferredNextSite = name;
    });
  });
  // Site click → suggest as next shot site if user opens dialog
  wrap.querySelectorAll('.body-site').forEach(g => {
    const pick = () => {
      const name = g.getAttribute('data-site');
      $('#site-suggest-label').textContent = `Tap "+ Log" to start a shot at ${name.replace(" \u2014 ", ", ")}`;
      window._preferredNextSite = name;
      wrap.querySelectorAll('.body-site').forEach(o => o.classList.toggle('picked', o === g));
    };
    g.addEventListener('click', pick);
    g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
  });
  // Legend
  $('#site-legend').innerHTML = `
    <span><span class="swatch unused"></span>Unused</span>
    <span><span class="swatch fresh"></span>2+ weeks</span>
    <span><span class="swatch medium"></span>1 to 2 weeks</span>
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
