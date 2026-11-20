// My GLP Shot: Weight entry dialog, history list and weight card.
'use strict';

async function openWeightDialog() {
  _editingWeightId = null;
  $('#weight-dialog h2').textContent = 'Log Weight';
  $('#weight-delete').classList.add('hidden');
  $('#weight-val').value = '';
  // The explicit Settings preference wins over the last-logged unit. Otherwise
  // someone who has just switched to kg opens this dialog, sees "lb" preselected,
  // types their kg number and silently stores a reading 2.2x too heavy.
  // The per-entry selector is still here for a one-off in the other unit.
  $('#weight-unit').value = weightUnit();
  $('#weight-date').value = todayISODate();
  $('#weight-dialog').showModal();
}

async function openWeightEdit(id) {
  const w = await dbGet(STORES.weights, id);
  if (!w) return;
  _editingWeightId = id;
  $('#weight-dialog h2').textContent = 'Edit Weight';
  $('#weight-delete').classList.remove('hidden');
  $('#weight-val').value = w.value;
  $('#weight-unit').value = w.unit === 'kg' ? 'kg' : 'lb';
  $('#weight-date').value = toCanonicalDate(w.date) || todayISODate();
  $('#weight-dialog').showModal();
}

// Insights weight card: every entry (tap to edit or delete) grouped by week,
// with how much each week moved.
function renderWeightHistory(wsAll) {
  const box = $('#weight-history');
  const list = $('#weight-history-list');
  if (!box || !list) return;
  const weeks = weeklyWeightSummary(wsAll);
  box.classList.toggle('hidden', !weeks.length);
  list.innerHTML = weeks.map(wk => {
    let change = '';
    if (wk.changeLb != null) {
      // Round in the display unit first so a 0.04 kg move doesn't claim a direction.
      const shown = parseFloat(fmtWeightDelta(wk.changeLb, { bare: true }));
      change = `<span class="weight-week-change${shown > 0 ? ' gain' : ''}">${escapeHTML(fmtWeightDelta(wk.changeLb))}</span>`;
    }
    const rows = wk.entries.map(w => `<button type="button" class="weight-entry" data-weight-id="${Number(w.id)}"><span>${escapeHTML(fmtDateShort(`${toCanonicalDate(w.date)}T00:00:00`))}</span><span>${escapeHTML(fmtWeight(toLb(w.value, w.unit)))}</span></button>`).join('');
    return `<div class="weight-week"><div class="weight-week-head"><span>Week of ${escapeHTML(fmtDateShort(`${wk.weekStart}T00:00:00`))}</span>${change}</div>${rows}</div>`;
  }).join('');
  list.querySelectorAll('.weight-entry[data-weight-id]').forEach(el => {
    el.addEventListener('click', () => openWeightEdit(parseInt(el.dataset.weightId, 10)));
  });
}

// Home-tab weight card. The Weight card with the chart lives on the Insights
// tab, so a user who does their daily logging on Home had no visible way to
// record a weigh-in — and the daily weight reminder pointed at a card on a tab
// it never switched to. This is the entry point; Insights keeps the chart.
function renderWeightCard(weights) {
  const card = $('#weight-card');
  if (!card) return;
  const todayEl = $('#weight-log-today');
  const changeEl = $('#weight-log-change');
  const ws = Array.isArray(weights) ? weights : [];
  if (changeEl) { changeEl.textContent = ''; changeEl.classList.remove('gain'); }
  if (!ws.length) {
    card.classList.remove('logged');
    if (todayEl) todayEl.textContent = 'No weight logged yet.';
    return;
  }
  const rows = weightsInLb(ws);
  if (!rows.length) {
    card.classList.remove('logged');
    if (todayEl) todayEl.textContent = 'No weight logged yet.';
    return;
  }
  const latest = rows[rows.length - 1];
  const loggedToday = toCanonicalDate(latest.date) === todayISODate();
  card.classList.toggle('logged', loggedToday);
  if (todayEl) {
    todayEl.textContent = loggedToday
      ? `Today: ${fmtWeight(latest.lb)}`
      : `Last: ${fmtWeight(latest.lb)} on ${fmtDateShort(latest.date)}`;
  }
  const prev = rows.length > 1 ? rows[rows.length - 2] : null;
  if (changeEl && prev) {
    const d = latest.lb - prev.lb;
    // Round in the display unit before testing for "no change", so a 0.04 kg
    // difference that renders as 0.0 doesn't claim to be a change.
    const shown = fmtWeightDelta(d, { bare: true });
    changeEl.textContent = parseFloat(shown) === 0
      ? 'no change since last'
      : `${fmtWeightDelta(d)} since last`;
    changeEl.classList.toggle('gain', d > 0);
  }
}
