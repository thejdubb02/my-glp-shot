// My GLP Shot: Supply tracking (premium).
'use strict';

// ----- Supply tracking (premium) -----
// 'supplies' store is now created in openDB()'s onupgradeneeded at DB_VERSION=3.
// This shim is kept as a no-op so the rest of the supply code can call it without changes.
async function ensureStore(_name, _opts) { await openDB(); }

async function getSupplies() {
  await ensureStore('supplies');
  const all = await new Promise((res) => {
    openDB().then(db => {
      const t = db.transaction('supplies', 'readonly');
      const r = t.objectStore('supplies').getAll();
      r.onsuccess = () => res(r.result || []);
      r.onerror = () => res([]);
    });
  });
  return all.sort((a, b) => (a.expires_at || '').localeCompare(b.expires_at || ''));
}

async function saveSupply(s) {
  await ensureStore('supplies');
  // Through dbPut, not a raw put: a raw put skipped uid assignment, so these
  // rows could only be matched across devices by content.
  return dbPut('supplies', s);
}

async function deleteSupply(id) { return dbDelSynced('supplies', id); }

// How much of each supply has been used. The rule is the one people actually
// follow: you open a pen, finish it, then open the next — so a supply owns
// every shot from the day it was opened until the day the following supply was
// opened. That keeps each shot counted against exactly one supply. Supplies
// with no opened date sit outside the attribution entirely rather than
// swallowing shots that belong to a dated one.
function supplyUsage(supplies, shots) {
  const usage = new Map();
  const dated = supplies
    .filter(s => s.opened_at)
    .sort((a, b) => String(a.opened_at).localeCompare(String(b.opened_at)));
  dated.forEach((s, i) => {
    const from = String(s.opened_at);
    const until = dated[i + 1] ? String(dated[i + 1].opened_at) : null;
    let usedMg = 0, lastDose = null, lastWhen = null;
    for (const shot of shots) {
      const day = toCanonicalDate(shot.when);
      if (!day || day < from) continue;
      if (until && day >= until) continue;
      usedMg += shot.dose || 0;
      if (lastWhen == null || String(shot.when) > lastWhen) { lastWhen = String(shot.when); lastDose = shot.dose || null; }
    }
    usage.set(s.id, { usedMg, lastDose });
  });
  return usage;
}

async function renderSupplies(shots) {
  const list = $('#supply-list');
  const empty = $('#supply-empty');
  if (!list) return;
  const supplies = await getSupplies();
  if (!supplies.length) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  const usage = supplyUsage(supplies, shots);
  list.innerHTML = supplies.map(s => {
    const use = usage.get(s.id) || { usedMg: 0, lastDose: null };
    const today = new Date(); today.setHours(0,0,0,0);
    const exp = s.expires_at ? new Date(s.expires_at) : null;
    const daysToExpire = exp ? Math.floor((exp - today) / 86400000) : null;
    const perDose = use.lastDose || parseFloat(settings.defaultDose) || null;
    const remaining = Math.max(0, (s.total_mg || 0) - use.usedMg);
    const dosesLeft = (perDose && s.total_mg) ? Math.floor(remaining / perDose) : null;
    const pctUsed = s.total_mg ? Math.min(100, (use.usedMg / s.total_mg) * 100) : 0;
    let cls = '';
    if (daysToExpire != null) {
      if (daysToExpire < 0) cls = 'expired';
      else if (daysToExpire < 7) cls = 'expiring';
    }
    const expireText = daysToExpire != null
      ? (daysToExpire < 0 ? `⚠️ Expired ${Math.abs(daysToExpire)}d ago` : `Expires in ${daysToExpire}d`)
      : 'No expiration set';
    return `<li class="${cls}" data-id="${s.id}">
      <div class="supply-name">${escapeHTML(s.type === 'pen' ? '💉 Pen' : '🧪 Vial')} · ${s.total_mg} mg ${s.volume_ml ? '· ' + s.volume_ml + ' mL' : ''}</div>
      <div class="supply-meta">${escapeHTML(s.pharmacy || 'Unknown source')}${s.batch ? ' · Lot ' + escapeHTML(s.batch) : ''}${s.cost ? ' · $' + s.cost : ''}</div>
      <div class="supply-meta">${expireText}${s.opened_at && s.total_mg ? ` · ${+use.usedMg.toFixed(2)} of ${s.total_mg} mg used` : ''}${dosesLeft != null && s.opened_at ? ' · ~' + dosesLeft + ' doses left' : ''}</div>
      <div class="supply-progress"><div class="supply-fill" style="width:${pctUsed.toFixed(0)}%"></div></div>
    </li>`;
  }).join('');
  list.querySelectorAll('li').forEach(li => {
    li.addEventListener('click', () => openSupplyDialog(supplies.find(x => x.id == li.dataset.id)));
  });
}

// Reads the two numbers back in plain language while they're being typed.
// "2.1 mg and 3 mL" is easy to enter from a box and hard to sanity-check;
// "0.7 mg/mL - about 8 doses at 0.25 mg" is not.
function updateSupplyReadout() {
  const el = $('#supply-readout');
  if (!el) return;
  const mg = parseFloat($('#supply-total-mg').value);
  const ml = parseFloat($('#supply-volume-ml').value);
  if (!Number.isFinite(mg) || mg <= 0) { el.hidden = true; el.textContent = ''; return; }
  const parts = [];
  if (Number.isFinite(ml) && ml > 0) parts.push(`${+(mg / ml).toFixed(3)} mg/mL`);
  const dose = parseFloat(settings.defaultDose);
  if (Number.isFinite(dose) && dose > 0 && dose <= mg) {
    const n = Math.floor(mg / dose);
    parts.push(`about ${n} dose${n === 1 ? '' : 's'} at your ${dose} mg dose`);
  }
  el.textContent = parts.length ? `Reads as: ${parts.join(' · ')}` : '';
  el.hidden = !parts.length;
}

function openSupplyDialog(s) {
  const isEdit = !!s;
  $('#supply-form-title').textContent = isEdit ? 'Edit supply' : 'Add supply';
  $('#supply-id').value = isEdit ? s.id : '';
  $('#supply-type').value = s ? s.type : 'vial';
  $('#supply-total-mg').value = s ? s.total_mg : '';
  $('#supply-volume-ml').value = s ? (s.volume_ml || '') : '';
  $('#supply-pharmacy').value = s ? (s.pharmacy || '') : '';
  $('#supply-batch').value = s ? (s.batch || '') : '';
  $('#supply-cost').value = s ? (s.cost || '') : '';
  $('#supply-opened').value = s ? (s.opened_at || '') : todayISODate();
  $('#supply-expires').value = s ? (s.expires_at || '') : '';
  $('#supply-delete').classList.toggle('hidden', !isEdit);
  updateSupplyReadout();
  $('#supply-dialog').showModal();
}
