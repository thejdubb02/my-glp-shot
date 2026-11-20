// My GLP Shot: Expenses and the cost tracker (premium).
'use strict';

// ----- Expenses (premium) -----
async function getExpenses() {
  return new Promise((res) => {
    openDB().then(db => {
      const t = db.transaction('expenses', 'readonly');
      const r = t.objectStore('expenses').getAll();
      r.onsuccess = () => res((r.result || []).sort((a, b) => (b.date || '').localeCompare(a.date || '')));
      r.onerror = () => res([]);
    });
  });
}

async function saveExpense(e) {
  // Through dbPut, not a raw put: a raw put skipped uid assignment, so these
  // rows could only be matched across devices by content.
  return dbPut('expenses', e);
}

async function deleteExpense(id) { return dbDelSynced('expenses', id); }

const EXPENSE_LABELS = {
  medication: '💊 Medication',
  pharmacy:   '🏥 Pharmacy fee',
  copay:      '👨‍⚕️ Doctor copay',
  labs:       '🧪 Lab work',
  insurance:  '📋 Insurance',
  supplies:   '🧴 Supplies',
  shipping:   '📦 Shipping',
  other:      '💵 Other',
};

// ----- Cost tracker (premium) -----
async function renderCost(weights) {
  const wrap = $('#cost-summary');
  const list = $('#expense-list');
  const empty = $('#expense-empty');
  if (!wrap) return;
  const supplies = await getSupplies();
  const expenses = await getExpenses();
  const supplyCost = supplies.reduce((sum, s) => sum + (parseFloat(s.cost) || 0), 0);
  const expenseCost = expenses.reduce((sum, e) => sum + (parseFloat(e.amount) || 0), 0);
  const totalCost = supplyCost + expenseCost;
  const earliest = [
    ...supplies.map(s => s.opened_at || s.date).filter(Boolean),
    ...expenses.map(e => e.date).filter(Boolean),
  ].sort()[0];
  const monthsSinceFirst = earliest ? Math.max(1, Math.ceil((Date.now() - new Date(earliest)) / (30 * 86400000))) : 0;
  const wd = weightDelta(weights, settings.startWeight);
  const lostLb = wd && wd.delta < 0 ? Math.abs(wd.delta) : 0;
  // Cost per unit has to be divided in the unit being displayed, not in pounds.
  const lostShown = lostLb > 0 ? fromLb(lostLb, weightUnit()) : 0;
  const dollarsPerLb = lostShown > 0 ? (totalCost / lostShown).toFixed(2) : null;

  if (!totalCost) {
    wrap.innerHTML = '';
    if (list) list.innerHTML = '';
    if (empty) empty.classList.remove('hidden');
    return;
  }
  if (empty) empty.classList.add('hidden');
  wrap.innerHTML = `
    <div class="summary-pill"><span class="summary-label">Total spent</span><span class="summary-value">$${totalCost.toFixed(2)}</span></div>
    ${monthsSinceFirst ? `<div class="summary-pill"><span class="summary-label">Per month</span><span class="summary-value">$${(totalCost / monthsSinceFirst).toFixed(2)}</span></div>` : ''}
    ${dollarsPerLb ? `<div class="summary-pill"><span class="summary-label">$ per ${weightUnit()} lost</span><span class="summary-value">$${dollarsPerLb}</span></div>` : ''}
  `;
  if (list) {
    list.innerHTML = expenses.slice(0, 12).map(e => `
      <li data-id="${e.id}">
        <div class="expense-row">
          <span class="expense-cat">${EXPENSE_LABELS[e.category] || e.category}</span>
          <span class="expense-amount">$${(parseFloat(e.amount) || 0).toFixed(2)}</span>
        </div>
        <div class="expense-meta muted small">${e.date}${e.notes ? ' · ' + escapeHTML(e.notes) : ''}</div>
      </li>
    `).join('');
    list.querySelectorAll('li').forEach(li => {
      li.addEventListener('click', () => openExpenseDialog(parseInt(li.dataset.id, 10)));
    });
  }
}

function openExpenseDialog(id) {
  const isEdit = !!id;
  $('#expense-form-title').textContent = isEdit ? 'Edit expense' : 'Add expense';
  $('#expense-id').value = id || '';
  $('#expense-delete').classList.toggle('hidden', !isEdit);
  if (!isEdit) {
    $('#expense-amount').value = '';
    $('#expense-category').value = 'medication';
    $('#expense-date').value = todayISODate();
    $('#expense-notes').value = '';
  } else {
    getExpenses().then(arr => {
      const e = arr.find(x => x.id === id);
      if (!e) return;
      $('#expense-amount').value = e.amount;
      $('#expense-category').value = e.category || 'other';
      $('#expense-date').value = e.date;
      $('#expense-notes').value = e.notes || '';
    });
  }
  $('#expense-dialog').showModal();
}
