// My GLP Shot: Plateau detection (premium).
'use strict';

// ----- Plateau detection (premium) -----
function detectPlateau(weights, shots) {
  if (weights.length < 8) return null;
  const recent = weights.slice(-30);
  if (recent.length < 8) return null;
  const fourWeeksAgo = Date.now() - 28 * 86400000;
  const inWindow = recent.filter(w => new Date(w.date).getTime() >= fourWeeksAgo);
  if (inWindow.length < 4) return null;
  const firstLb = toLb(inWindow[0].value, inWindow[0].unit);
  const lastLb = toLb(inWindow[inWindow.length - 1].value, inWindow[inWindow.length - 1].unit);
  if (firstLb == null || lastLb == null) return null;
  const delta = lastLb - firstLb;
  if (Math.abs(delta) > 1) return null; // not a plateau — 1 lb, canonical
  // Check no recent dose increase
  const recentShotsInWindow = shots.filter(s => new Date(s.when).getTime() >= fourWeeksAgo);
  const doses = recentShotsInWindow.map(s => s.dose);
  const allSame = doses.length === 0 || doses.every(d => d === doses[0]);
  if (!allSame) return null;
  const dose = doses[0] || (shots.length ? shots[0].dose : null);
  return { weeks: 4, dose, delta: delta.toFixed(1), deltaLb: delta };
}

async function renderPlateau(weights, shots) {
  const card = $('#plateau-card');
  const body = $('#plateau-body');
  if (!card) return;
  if (!isPremium()) { card.classList.add('hidden'); return; }
  const p = detectPlateau(weights, shots);
  if (!p) { card.classList.add('hidden'); return; }
  // Maintenance mode reframes the same data as a stability win, not a problem to solve.
  if (settings.maintenanceMode) {
    body.innerHTML = `<p>Weight has stayed within ${fmtWeight(1, { dp: weightUnit() === 'kg' ? 1 : 0 })} for ~${p.weeks} weeks at ${p.dose}mg — exactly what maintenance looks like. Holding steady is the goal here, not a plateau to break.</p>
      <p class="muted small">If you ever want to switch back to weight-loss mode, toggle Maintenance off in Settings.</p>`;
  } else {
    body.innerHTML = `<p>Weight has stayed within ${fmtWeight(1, { dp: weightUnit() === 'kg' ? 1 : 0 })} for ~${p.weeks} weeks at ${p.dose}mg.</p>
      <p class="muted small">This is normal — most people experience plateaus during titration. Consider:
      discussing a dose increase with your prescriber, reviewing protein intake (aim for ${weightUnit() === 'kg' ? '2.2g per kg' : '1g per lb'} of goal weight),
      walking 8-10K steps/day, and ensuring you're eating in a sustainable deficit.</p>
      <p class="muted small">Educational only. Not medical advice.</p>`;
  }
  card.classList.remove('hidden');
}
