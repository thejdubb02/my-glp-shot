// My GLP Shot: Reconstitution (mixing) calculator.
'use strict';

// ----- Reconstitution calculator -----
function renderReconCalc() {
  const vial = parseFloat($('#recon-vial').value);
  const water = parseFloat($('#recon-water').value);
  const dose = parseFloat($('#recon-dose').value);
  const out = $('#recon-output');
  out.classList.remove('error');
  if (!vial || !water || !dose || vial <= 0 || water <= 0 || dose <= 0) {
    out.classList.add('error');
    out.textContent = 'Enter vial total, water volume, and desired dose.';
    return;
  }
  if (dose > vial) {
    out.classList.add('error');
    out.textContent = `Desired dose (${dose} mg) exceeds vial total (${vial} mg).`;
    return;
  }
  const concentration = vial / water;
  const drawMl = dose / concentration;
  const dosesInVial = Math.floor(vial / dose);
  const syringe = ($('#recon-syringe')?.value) || '0.5';
  const SYRINGES = {
    '0.3':     { capMl: 0.3, kind: 'insulin' },
    '0.5':     { capMl: 0.5, kind: 'insulin' },
    '1.0':     { capMl: 1.0, kind: 'insulin' },
    '0.5_u40': { capMl: 0.5, kind: 'insulin40' },
    '1.0_u40': { capMl: 1.0, kind: 'insulin40' },
    '0.3tb':   { capMl: 0.3, kind: 'tb' },
    '0.5tb':   { capMl: 0.5, kind: 'tb' },
    '1.0tb':   { capMl: 1.0, kind: 'tb' },
    '3.0tb':   { capMl: 3.0, kind: 'tb' },
    '5.0tb':   { capMl: 5.0, kind: 'tb' },
    '10.0tb':  { capMl: 10.0, kind: 'tb' },
  };
  let sy;
  if (syringe === 'custom') {
    const customMl = parseFloat($('#recon-custom-ml')?.value);
    const customKind = $('#recon-custom-kind')?.value || 'insulin';
    if (!customMl || customMl <= 0) {
      out.classList.add('error'); out.textContent = 'Enter a valid custom syringe capacity.'; return;
    }
    sy = { capMl: customMl, kind: customKind };
  } else {
    sy = SYRINGES[syringe] || SYRINGES['0.5'];
  }
  const unitsPerMl = sy.kind === 'insulin' ? 100 : (sy.kind === 'insulin40' ? 40 : null);
  let drawToHtml;
  let warning = '';
  if (drawMl > sy.capMl + 1e-9) {
    warning = `<div class="recon-warn">⚠ Draw volume (${drawMl.toFixed(3)} mL) exceeds this syringe's ${sy.capMl} mL capacity. Pick a larger syringe or reconstitute with more water.</div>`;
    drawToHtml = `<div class="recon-result big"><span>Draw to</span><strong>—</strong></div>`;
  } else if (unitsPerMl) {
    const units = drawMl * unitsPerMl;
    const roundedUnits = Math.round(units * 2) / 2;
    const capUnits = Math.round(sy.capMl * unitsPerMl);
    const scaleNote = unitsPerMl === 40 ? 'U-40 scale' : `${capUnits}u line`;
    drawToHtml = `<div class="recon-result big"><span>Draw to</span><strong>${roundedUnits} u <span class="recon-sub">(${scaleNote} · ${drawMl.toFixed(3)} mL)</span></strong></div>`;
  } else {
    drawToHtml = `<div class="recon-result big"><span>Draw to</span><strong>${drawMl.toFixed(2)} mL <span class="recon-sub">(read mL marks)</span></strong></div>`;
  }
  out.innerHTML = `
    ${drawToHtml}
    ${warning}
    <div class="recon-row">
      <div class="recon-result"><span>Concentration</span><strong>${concentration.toFixed(2)} mg/mL</strong></div>
      <div class="recon-result"><span>Draw volume</span><strong>${drawMl.toFixed(3)} mL</strong></div>
      <div class="recon-result"><span>Doses in vial</span><strong>${dosesInVial}</strong></div>
    </div>
  `;
  try { localStorage.setItem('recon.preset', JSON.stringify({ vial, water, dose, syringe })); } catch (e) {}
}

function setupReconCalc() {
  // Restore preset
  try {
    const p = JSON.parse(localStorage.getItem('recon.preset') || 'null');
    if (p) {
      if (p.vial != null) $('#recon-vial').value = p.vial;
      if (p.water != null) $('#recon-water').value = p.water;
      if (p.dose != null) $('#recon-dose').value = p.dose;
      if (p.syringe && $('#recon-syringe')) $('#recon-syringe').value = p.syringe;
    }
  } catch (e) {}
  ['#recon-vial', '#recon-water', '#recon-dose', '#recon-syringe', '#recon-custom-ml', '#recon-custom-kind'].forEach(sel => {
    const el = $(sel); if (!el) return;
    el.addEventListener('input', renderReconCalc);
    el.addEventListener('change', renderReconCalc);
  });
  const sy = $('#recon-syringe'), customWrap = $('#recon-custom');
  const toggleCustom = () => { if (customWrap) customWrap.classList.toggle('hidden', sy?.value !== 'custom'); };
  if (sy) sy.addEventListener('change', toggleCustom);
  toggleCustom();
  renderReconCalc();
}
