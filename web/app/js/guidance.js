// My GLP Shot: Cycle tracking, mixing calculator visibility, reference guidance, medication change log.
'use strict';

// ---------- Cycle tracking (opt-in) ----------
async function getCyclesSorted() {
  const all = (await dbAll('cycles')) || [];
  return all.sort((a, b) => (b.startDate || '').localeCompare(a.startDate || ''));  // newest first
}
async function saveCycle(c) {
  // Through dbPut, not a raw put: a raw put skipped uid assignment, so these
  // rows could only be matched across devices by content.
  return dbPut('cycles', c);
}
async function deleteCycle(id) { return dbDelSynced('cycles', id); }
async function clearAllCycles() {
  // One tombstone per row, so the clear reaches other devices too.
  for (const c of (await dbAll('cycles')) || []) await dbDelSynced('cycles', c.id);
}
function renderCycleSymptomsForm(checked) {
  const wrap = $('#cycle-symptoms');
  if (!wrap) return;
  const set = new Set(checked || []);
  wrap.innerHTML = CYCLE_SYMPTOMS.map(k =>
    `<label class="check-row small"><input type="checkbox" data-cycle-symptom="${k}" ${set.has(k) ? 'checked' : ''}> ${CYCLE_SYMPTOM_LABELS[k]}</label>`
  ).join('');
}
function readCycleSymptoms() {
  return Array.from(document.querySelectorAll('#cycle-symptoms input[data-cycle-symptom]:checked'))
    .map(el => el.getAttribute('data-cycle-symptom'));
}
async function openCycleDialog(cycle) {
  const isEdit = !!cycle;
  $('#cycle-form-title').textContent = isEdit ? 'Edit period' : 'Log period';
  $('#cycle-id').value = isEdit ? String(cycle.id) : '';
  $('#cycle-start').value = cycle && cycle.startDate ? cycle.startDate : todayISODate();
  $('#cycle-end').value = cycle && cycle.endDate ? cycle.endDate : '';
  $('#cycle-flow').value = (cycle && cycle.flow) || '';
  $('#cycle-notes').value = (cycle && cycle.notes) || '';
  renderCycleSymptomsForm(cycle ? cycle.symptoms : []);
  $('#cycle-delete').classList.toggle('hidden', !isEdit);
  $('#cycle-dialog').showModal();
}
async function renderCycleCard() {
  const card = $('#cycle-card');
  if (!card) return;
  if (!settings.cycleEnabled) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  const cycles = await getCyclesSorted();
  const list = $('#cycle-list');
  const empty = $('#cycle-empty');
  if (!cycles.length) { list.innerHTML = ''; empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');
  list.innerHTML = cycles.map(c => {
    const dur = c.endDate ? Math.max(1, Math.round((new Date(c.endDate) - new Date(c.startDate)) / 86400000) + 1) : null;
    const symStr = (c.symptoms || []).map(k => CYCLE_SYMPTOM_LABELS[k] || k).join(' · ') || '<span class="muted small">no symptoms logged</span>';
    return `<button type="button" class="cycle-row" data-cycle-id="${c.id}">
      <div class="cycle-row-head">
        <strong>${escapeHTML(c.startDate)}${c.endDate ? ' → ' + escapeHTML(c.endDate) : ' (ongoing)'}</strong>
        <span class="muted small">${dur ? dur + 'd' : ''} · ${escapeHTML(CYCLE_FLOW_LABELS[c.flow || ''] || 'Not specified')}</span>
      </div>
      <div class="cycle-row-symptoms">${symStr}</div>
      ${c.notes ? `<div class="cycle-row-notes muted small">${escapeHTML(c.notes)}</div>` : ''}
    </button>`;
  }).join('');
  list.querySelectorAll('.cycle-row[data-cycle-id]').forEach(el => {
    el.addEventListener('click', async () => {
      const id = parseInt(el.getAttribute('data-cycle-id'), 10);
      const target = cycles.find(x => x.id === id);
      if (target) openCycleDialog(target);
    });
  });
}
// ---------- Mixing calculator visibility ----------
// Hidden unless the user says they mix their own peptide. Toggling only affects
// the card; the calculator itself is unchanged and keeps no data.
function applyMixingCalcVisibility() {
  const card = $('#recon-card');
  if (card) card.classList.toggle('hidden', !settings.showMixingCalc);
}
function setupMixingCalcUI() {
  const cb = $('#set-mixing-calc');
  if (!cb) return;
  cb.checked = !!settings.showMixingCalc;
  cb.addEventListener('change', async (e) => {
    settings.showMixingCalc = !!e.target.checked;
    await saveSettings();
    markSyncDirty();
    applyMixingCalcVisibility();
    if (settings.showMixingCalc) {
      $('#recon-card')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });
}

function setupCycleUI() {
  const enabledCheckbox = $('#set-cycle-enabled');
  const extras = $('#cycle-settings-extras');
  if (enabledCheckbox) {
    enabledCheckbox.checked = !!settings.cycleEnabled;
    extras.classList.toggle('hidden', !settings.cycleEnabled);
    enabledCheckbox.addEventListener('change', async (e) => {
      settings.cycleEnabled = !!e.target.checked;
      settings.cycleSeenOptIn = true;
      await saveSettings();
      markSyncDirty();
      extras.classList.toggle('hidden', !settings.cycleEnabled);
      await renderCycleCard();
    });
  }
  $('#cycle-data-clear')?.addEventListener('click', async () => {
    if (!confirm('Permanently delete ALL cycle entries? This cannot be undone.')) return;
    await clearAllCycles();
    markSyncDirty();
    await renderCycleCard();
    toast('All cycle entries deleted.');
  });
  $('#cycle-add-btn')?.addEventListener('click', () => openCycleDialog());
  $('#cycle-cancel')?.addEventListener('click', () => $('#cycle-dialog').close());
  $('#cycle-delete')?.addEventListener('click', async () => {
    const id = parseInt($('#cycle-id').value, 10);
    if (!Number.isFinite(id)) return;
    if (!confirm('Delete this period entry?')) return;
    await deleteCycle(id);
    $('#cycle-dialog').close();
    markSyncDirty();
    await renderCycleCard();
  });
  $('#cycle-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const idStr = $('#cycle-id').value;
    const startDate = $('#cycle-start').value;
    const endDate = $('#cycle-end').value || null;
    if (!startDate) { alert('Please pick a start date.'); return; }
    if (endDate && endDate < startDate) { alert('End date cannot be before start date.'); return; }
    const data = {
      startDate,
      endDate,
      flow: $('#cycle-flow').value || null,
      symptoms: readCycleSymptoms(),
      notes: ($('#cycle-notes').value || '').trim().slice(0, 1000) || null,
      updatedAt: new Date().toISOString(),
    };
    if (idStr) data.id = parseInt(idStr, 10);
    await saveCycle(data);
    $('#cycle-dialog').close();
    markSyncDirty();
    await renderCycleCard();
    track(idStr ? 'cycle_edited' : 'cycle_logged');
  });
}
function toast(msg) {
  // Best-effort toast — uses an existing element if present, otherwise alert().
  const el = document.getElementById('app-toast');
  if (el) {
    el.textContent = msg;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 2200);
  } else {
    alert(msg);
  }
}

// ---------- Reference guidance content ----------
// Plain-language reference snippets surfaced contextually. Hand-written, not
// AI-generated, not personalized. Every section redirects to the prescriber
// for any actual decision. Free, never gated.
//
// Tone rules (informed by the user's "educational but we are not a medical
// doctor" stance):
//   - Inform, don't prescribe. No "you should take X mg."
//   - Use "some users", "the FDA label", "your prescriber" — not "you must."
//   - Provide questions to ask the prescriber, not answers.
const GUIDANCE = {
  missed_lt48h: {
    title: 'Missed shot — within ~48 hours',
    body: `<p>If you're inside roughly 48 hours of when your shot was supposed to happen and your prescriber hasn't told you otherwise, the FDA labels for tirzepatide and semaglutide both note that the dose can be administered as soon as remembered, then the regular weekly schedule resumed.</p>
      <p>Outside of that window — see the next section. And whenever in doubt, your prescriber is the right person to call.</p>`,
    actions: [
      'Take it now if your prescriber\'s plan allows it.',
      'Set a reminder for next week\'s normal day.',
      'If unsure, message your prescriber before injecting.',
    ],
  },
  missed_gt48h: {
    title: 'Missed shot — more than ~48 hours',
    body: `<p>The FDA labels generally say to skip the missed dose and resume on your next scheduled day if you are <em>more than ~48 hours</em> past your scheduled time, but practice varies. Some prescribers ask you to call before re-starting; some adjust the dose down; some have you wait for the next scheduled week.</p>
      <p>This is the right time to message your prescriber rather than guess.</p>`,
    actions: [
      'Don\'t double up.',
      'Message your prescriber and describe how many days late you are.',
      'Ask whether to inject now, skip and resume next week, or step back to a lower dose.',
    ],
    questions: [
      'Is it safe for me to take this dose now, or should I skip to next week?',
      'If I skip, do I restart at the same dose or step down?',
      'What side effects should I watch for if I do inject late?',
    ],
  },
  side_effects_high: {
    title: 'Side effects on the higher side',
    body: `<p>Severe side effects on multiple consecutive shots — especially nausea, vomiting, or persistent stomach pain — are worth flagging. Some prescribers respond by holding at the current dose; others step down to the previous dose for a cycle or two; some adjust how the medication is taken (timing, food, hydration).</p>
      <p>This is descriptive, not advice. The right move depends on which symptoms, how severe, and your medical history.</p>`,
    actions: [
      'Open the symptoms summary on the Insights tab — share the picture with your prescriber.',
      'Note any pattern: does it happen day 1 after the shot? Mid-cycle? Always after eating?',
      'Stop and call urgently for: severe abdominal pain, signs of dehydration, or signs of pancreatitis (severe persistent upper-abdominal pain radiating to the back).',
    ],
    questions: [
      'Should I hold at this dose or step down?',
      'Are these symptoms expected at this dose, or do they suggest something else?',
      'Are there OTC options (anti-nausea, fiber, electrolytes) you\'d recommend trying first?',
    ],
  },
  dose_increase: {
    title: 'Just bumped up the dose',
    body: `<p>The first 1-3 shots after a dose increase are when most users see a return of side effects — often nausea or fatigue — even if the previous dose felt easy. The FDA labels describe a typical settling period of one or two cycles before the new dose feels routine.</p>
      <p>What's "expected" varies; severe or persistent symptoms are always worth calling about.</p>`,
    actions: [
      'Hydrate more than you think you need to.',
      'Eat smaller, more frequent meals through the first couple of days.',
      'Plan meals with protein first, fiber second, fat third.',
      'Log side effects on each shot so the pattern is visible if it persists.',
    ],
    questions: [
      'How long is normal for side effects to settle at this new dose?',
      'When should I call you if they don\'t?',
      'Anything specific about meals, timing, or other meds I should change?',
    ],
  },
  titration_overview: {
    title: 'Titration — the general picture',
    body: `<p>Most GLP-1 medications use a step-up titration: the prescriber starts you at a low dose to let the body adjust, then steps up every 4 weeks (the FDA-labeled minimum for tirzepatide and semaglutide) toward a target dose. Many users hold at intermediate doses for longer if it's working or side effects are settling.</p>
      <p>"Where to land" is a conversation between you and your prescriber, informed by weight progress, side effects, labs, and goals.</p>`,
    actions: [
      'Track shots, weight, and side effects so the picture is data-backed.',
      'Don\'t self-titrate. Step-ups should be discussed with your prescriber.',
      'If progress stalls, the answer isn\'t always a higher dose — sleep, protein, walking, and patience are usually first.',
    ],
  },
};

function renderGuidance(sectionId) {
  const g = GUIDANCE[sectionId];
  if (!g) return '';
  const actions = g.actions ? `<ul class="guidance-actions">${g.actions.map(a => `<li>${a}</li>`).join('')}</ul>` : '';
  const questions = g.questions ? `<h4>Questions to ask your prescriber</h4><ul class="guidance-questions">${g.questions.map(q => `<li>${q}</li>`).join('')}</ul>` : '';
  return `<h3>${g.title}</h3>${g.body}${actions}${questions}<p class="muted small guidance-disclaimer">This is reference information, not medical advice. My GLP Shot is a tracker — your prescriber is the right person for any dosing decision.</p>`;
}

function openGuidance(sectionId) {
  const dlg = $('#guidance-dialog');
  if (!dlg) return;
  $('#guidance-body').innerHTML = renderGuidance(sectionId);
  dlg.showModal();
  track('guidance_opened', { section: sectionId });
}

// Triggers that surface the right guidance link on the home screen.
async function evaluateGuidanceTriggers() {
  const shots = await getShotsSorted();  // newest first
  const latest = shots[0];
  const hint = $('#guidance-hint');
  if (!hint) return;
  const cadence = settings.cadenceDays || 7;
  let target = null, label = '';
  if (latest) {
    const next = nextShotDate(latest.when);
    const lateMs = Date.now() - next.getTime();
    const lateHours = lateMs / 3600000;
    if (lateHours > 0 && lateHours <= 48) {
      target = 'missed_lt48h';
      label = `Inside the 48-hour window — what your prescriber may want you to do`;
    } else if (lateHours > 48) {
      target = 'missed_gt48h';
      label = `Past 48 hours late — questions to ask before injecting again`;
    } else if (shots.length >= 2 && shots[0].dose > shots[1].dose) {
      // Most recent shot is a dose increase — show only for ~3 days post-shot.
      const sinceShotDays = (Date.now() - new Date(shots[0].when).getTime()) / 86400000;
      if (sinceShotDays <= 3) { target = 'dose_increase'; label = 'Just bumped up — what to expect this cycle'; }
    } else {
      // Severe side-effects on >=2 separate days across the last 3 shots' span.
      // Counts standalone symptom days too — severe nausea on a rest day is the
      // same signal as severe nausea on shot day.
      const last3 = shots.slice(0, 3);
      const windowStart = last3.length ? new Date(last3[last3.length - 1].when).getTime() : 0;
      let severeDays = 0;
      try {
        const entries = await collectSideEffectEntries(shots);
        const days = new Set();
        for (const e of entries) {
          if (e.at < windowStart) continue;
          if (Object.values(e.se).includes('severe')) days.add(e.date);
        }
        severeDays = days.size;
      } catch (_) {}
      if (severeDays >= 2) { target = 'side_effects_high'; label = 'Side effects looking high — questions to bring to your prescriber'; }
    }
  }
  if (target) {
    hint.classList.remove('hidden');
    hint.innerHTML = `<a href="#" data-guidance="${target}">${escapeHTML(label)} →</a>`;
    hint.querySelector('a').addEventListener('click', (e) => { e.preventDefault(); openGuidance(target); });
  } else {
    hint.classList.add('hidden');
    hint.innerHTML = '';
  }
}

// ---------- Medication change log ----------
// First-class log of "you switched drugs" events so the dose timeline and
// future per-shot half-life lookups can stay accurate across switches.
async function getMedChangesSorted() {
  const all = (await dbAll('medChanges')) || [];
  return all.sort((a, b) => (a.when || '').localeCompare(b.when || ''));
}
async function saveMedChange(entry) {
  // Through dbPut, not a raw put: a raw put skipped uid assignment, so these
  // rows could only be matched across devices by content.
  return dbPut('medChanges', entry);
}
async function deleteMedChange(id) { return dbDelSynced('medChanges', id); }
async function renderMedChanges() {
  const wrap = $('#medchanges-list');
  if (!wrap) return;
  const list = await getMedChangesSorted();
  if (!list.length) { wrap.innerHTML = '<p class="muted small">No medication changes logged. Tap "+ Log change" if you switch medications.</p>'; return; }
  wrap.innerHTML = list.slice().reverse().map(c => `
    <div class="medchange-row">
      <div><strong>${escapeHTML(c.medication || '?')}</strong> <span class="muted small">${escapeHTML(c.when ? new Date(c.when).toLocaleDateString() : '')}</span></div>
      ${c.notes ? `<div class="muted small">${escapeHTML(c.notes)}</div>` : ''}
      <div class="muted small">half-life ${c.halfLifeDays ?? '—'}d · cadence ${c.cadenceDays ?? '—'}d</div>
      <button type="button" class="btn-ghost small" data-medchange-del="${c.id}">Delete</button>
    </div>
  `).join('');
  wrap.querySelectorAll('[data-medchange-del]').forEach(b => {
    b.addEventListener('click', async () => {
      if (!confirm('Delete this medication-change entry?')) return;
      await deleteMedChange(parseInt(b.getAttribute('data-medchange-del'), 10));
      markSyncDirty();
      await renderMedChanges();
    });
  });
}
function setupMedChangeUI() {
  $('#medchange-log-btn')?.addEventListener('click', async () => {
    const dt = prompt('When did the change happen? (YYYY-MM-DD, blank = today)', '');
    const when = (dt || todayISODate()) + 'T00:00:00';
    const entry = {
      when: new Date(when).toISOString(),
      medication: settings.medication,
      halfLifeDays: settings.halfLifeDays,
      defaultDose: settings.defaultDose,
      cadenceDays: settings.cadenceDays,
      notes: prompt('Notes (optional, e.g. "switched from Mounjaro to Zepbound")', '') || null,
    };
    await saveMedChange(entry);
    markSyncDirty();
    await renderMedChanges();
    track('med_change_logged');
  });
}
