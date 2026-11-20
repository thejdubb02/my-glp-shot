// My GLP Shot: Doctor PDF report, built client-side for print.
'use strict';

// ----- PDF report (client-side print) -----
async function exportPDFReport() {
  if (!isPremium()) { $('#upgrade-dialog').showModal(); return; }
  const dlg = $('#pdf-dialog');
  if (dlg) { dlg.showModal(); return; }
  await runPdfExport({ range: '90', sections: ['shots','weights','measurements','labs','sideEffects'] });
}

function rangeCutoff(range) {
  if (range === 'all') return new Date(0);
  const days = parseInt(range, 10);
  if (!Number.isFinite(days) || days <= 0) return new Date(0);
  const c = new Date(); c.setDate(c.getDate() - days); return c;
}
function rangeLabel(range) {
  return range === 'all' ? 'All-time' : `Last ${range} days`;
}

async function runPdfExport(opts) {
  const inc = (k) => opts.sections.includes(k);
  const w = window.open('', '_blank');
  if (!w) { alert('Please allow popups to generate the PDF.'); return; }
  const since = rangeCutoff(opts.range);
  const shotsAll = await getShotsSorted();
  const weightsAll = await getWeightsSorted();
  const measurements = inc('measurements') ? (await getMeasurements()).filter(m => new Date(m.date) >= since) : [];
  const labs = inc('labs') ? (await getLabs()).filter(l => new Date(l.date) >= since) : [];
  const moodsAll = inc('moods') ? (await dbAll(STORES.moods) || []).filter(m => new Date(m.date) >= since).sort((a,b) => new Date(b.date)-new Date(a.date)) : [];
  const appetitesAll = inc('appetites') ? (await getAppetitesSorted()).filter(a => new Date(a.date) >= since) : [];
  // Off unless explicitly ticked in the share dialog. A day note is about the
  // rest of someone's life, not their treatment, and it should never reach a
  // clinician because a checkbox happened to default on.
  const notesAll = inc('notes') ? (await getNotesSorted()).filter(n => new Date(n.date) >= since).reverse() : [];
  const foodNoiseAll = inc('foodNoise') ? (await getFoodNoiseSorted()).filter(f => new Date(f.date) >= since) : [];
  const cyclesAll = (inc('cycles') && settings.cycleEnabled) ? (await getCyclesSorted()).filter(c => new Date(c.startDate) >= since) : [];
  const wd = weightDelta(weightsAll, settings.startWeight);
  const rShots = inc('shots') ? shotsAll.filter(s => new Date(s.when) >= since) : [];
  const rWeights = inc('weights') ? weightsAll.filter(w2 => new Date(w2.date) >= since) : [];
  // Counts every side-effect observation in range, whether it was recorded with
  // a shot or on its own day — a clinician reading this needs both.
  const seEntriesAll = inc('sideEffects') ? await collectSideEffectEntries(shotsAll) : [];
  const sideEffectCounts = (() => {
    if (!inc('sideEffects')) return [];
    const counts = {};
    for (const e of seEntriesAll) {
      if (e.at < since.getTime()) continue;
      for (const [k, lvl] of Object.entries(e.se)) {
        if (!lvl) continue;
        counts[k] = counts[k] || { mild: 0, moderate: 0, severe: 0 };
        if (counts[k][lvl] != null) counts[k][lvl]++;
      }
    }
    const labelOf = (k) => (SIDE_EFFECTS.find(s => s[0] === k) || [k, k])[1];
    return Object.entries(counts).sort((a,b) => (b[1].severe*4+b[1].moderate*2+b[1].mild) - (a[1].severe*4+a[1].moderate*2+a[1].mild)).map(([k,c]) => ({ label: labelOf(k), ...c, total: c.mild+c.moderate+c.severe }));
  })();
  // A dated log of the standalone entries, so "3 × moderate nausea" can be
  // traced to actual days rather than sitting as an unattributed total.
  const symptomDaysAll = inc('sideEffects')
    ? seEntriesAll.filter(e => !e.fromShot && e.at >= since.getTime()).slice().reverse()
    : [];
  const MOOD_TXT = { 1:'Awful',2:'Low',3:'Okay',4:'Good',5:'Great' };
  const APP_TXT = { 1:'None',2:'Low',3:'Normal',4:'Hungry',5:'Ravenous' };
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>My GLP Shot Report</title>
    <style>
      body{font-family:-apple-system,Arial,sans-serif;color:#0f172a;margin:30px;line-height:1.5}
      h1,h2{color:#0f766e;margin-bottom:6px}
      .meta{color:#64748b;font-size:.85rem;margin-bottom:18px}
      table{border-collapse:collapse;width:100%;margin:10px 0;font-size:.9rem}
      th,td{text-align:left;padding:6px 10px;border-bottom:1px solid #e2e8f0}
      th{background:#f0fdfa}
      .stat{display:inline-block;margin-right:18px}
      .stat strong{color:#0f766e;font-size:1.4rem;display:block}
      .stat span{color:#64748b;font-size:.78rem;text-transform:uppercase;letter-spacing:.5px}
      @media print { body{margin:14mm} }
    </style></head><body>
    <h1>My GLP Shot — ${escapeHTML(rangeLabel(opts.range))} Report</h1>
    <p class="meta">Generated ${new Date().toLocaleString()} for ${escapeHTML(account.user?.email || '(local)')}</p>

    <h2>Summary</h2>
    <div>
      ${inc('shots') ? `<div class="stat"><strong>${rShots.length}</strong><span>shots</span></div>` : ''}
      ${inc('weights') && wd ? `<div class="stat"><strong>${fmtWeightDelta(wd.delta)}</strong><span>since start</span></div>` : ''}
      ${inc('weights') && wd ? `<div class="stat"><strong>${fmtWeight(wd.current)}</strong><span>current weight</span></div>` : ''}
    </div>
    <p class="meta">Medication: ${escapeHTML(settings.medication)} · Cadence: every ${settings.cadenceDays} day${settings.cadenceDays === 1 ? '' : 's'}</p>

    ${inc('shots') ? `<h2>Shots (${rShots.length})</h2>
    <table><thead><tr><th>Date</th><th>Dose</th><th>Site</th><th>Notes</th></tr></thead><tbody>
    ${rShots.slice(0, 200).map(s => `<tr><td>${new Date(s.when).toLocaleString()}</td><td>${s.dose} mg</td><td>${escapeHTML(s.site || '')}</td><td>${escapeHTML(s.notes || '')}</td></tr>`).join('')}
    </tbody></table>` : ''}

    ${inc('weights') && rWeights.length ? `<h2>Weight</h2><table><thead><tr><th>Date</th><th>Weight</th></tr></thead><tbody>
    ${rWeights.slice(-60).map(w => `<tr><td>${w.date}</td><td>${w.value} ${w.unit}</td></tr>`).join('')}
    </tbody></table>` : ''}

    ${inc('labs') && labs.length ? `<h2>Labs</h2><table><thead><tr><th>Date</th><th>Test</th><th>Value</th><th>Notes</th></tr></thead><tbody>
    ${labs.map(l => { const [label, unit] = LAB_LABELS[l.type] || [l.type, '']; return `<tr><td>${l.date}</td><td>${label}</td><td>${l.value} ${unit}</td><td>${escapeHTML(l.notes || '')}</td></tr>`; }).join('')}
    </tbody></table>` : ''}

    ${inc('measurements') && measurements.length ? `<h2>Body measurements</h2><table><thead><tr><th>Date</th><th>Type</th><th>Value</th></tr></thead><tbody>
    ${measurements.map(m => `<tr><td>${m.date}</td><td>${MEASUREMENT_LABELS[m.type] || m.type}</td><td>${m.value} ${m.unit}</td></tr>`).join('')}
    </tbody></table>` : ''}

    ${inc('moods') && moodsAll.length ? `<h2>Mood log</h2><table><thead><tr><th>Date</th><th>Mood</th></tr></thead><tbody>
    ${moodsAll.map(m => `<tr><td>${m.date}</td><td>${MOOD_TXT[m.value] || m.value}</td></tr>`).join('')}
    </tbody></table>` : ''}

    ${inc('appetites') && appetitesAll.length ? `<h2>Appetite log</h2><table><thead><tr><th>Date</th><th>Appetite</th></tr></thead><tbody>
    ${appetitesAll.map(a => `<tr><td>${a.date}</td><td>${APP_TXT[a.value] || a.value}</td></tr>`).join('')}
    </tbody></table>` : ''}

    ${inc('foodNoise') && foodNoiseAll.length ? `<h2>Food noise log</h2><p class="meta">Daily 1-10 self-rating of mental food chatter (1 = quiet, 10 = constant).</p><table><thead><tr><th>Date</th><th>Score</th><th>Descriptor</th></tr></thead><tbody>
    ${foodNoiseAll.map(f => `<tr><td>${f.date}</td><td>${f.value}/10</td><td>${foodNoiseDescriptor(f.value)}</td></tr>`).join('')}
    </tbody></table>` : ''}

    ${inc('notes') && notesAll.length ? `<h2>Daily notes</h2><p class="meta">The patient's own notes on what was happening each day — context for the mood and appetite entries above.</p><table><thead><tr><th>Date</th><th>Note</th></tr></thead><tbody>
    ${notesAll.map(n => `<tr><td>${escapeHTML(n.date)}</td><td>${escapeHTML(n.text).replace(/\n/g, '<br>')}</td></tr>`).join('')}
    </tbody></table>` : ''}

    ${cyclesAll.length ? `<h2>Cycle log</h2><table><thead><tr><th>Start</th><th>End</th><th>Days</th><th>Flow</th><th>Symptoms</th></tr></thead><tbody>
    ${cyclesAll.map(c => {
      const dur = c.endDate ? Math.max(1, Math.round((new Date(c.endDate) - new Date(c.startDate)) / 86400000) + 1) : '—';
      return `<tr><td>${escapeHTML(c.startDate)}</td><td>${escapeHTML(c.endDate || 'ongoing')}</td><td>${dur}</td><td>${escapeHTML(CYCLE_FLOW_LABELS[c.flow || ''] || '')}</td><td>${escapeHTML((c.symptoms || []).map(k => CYCLE_SYMPTOM_LABELS[k] || k).join(', '))}</td></tr>`;
    }).join('')}
    </tbody></table>` : ''}

    ${inc('sideEffects') && sideEffectCounts.length ? `<h2>Side-effect summary</h2><table><thead><tr><th>Symptom</th><th>Total</th><th>Mild</th><th>Moderate</th><th>Severe</th></tr></thead><tbody>
    ${sideEffectCounts.map(s => `<tr><td>${escapeHTML(s.label)}</td><td>${s.total}</td><td>${s.mild}</td><td>${s.moderate}</td><td>${s.severe}</td></tr>`).join('')}
    </tbody></table>` : ''}

    ${symptomDaysAll.length ? `<h2>Symptom days (no injection)</h2><p class="meta">Side effects the patient recorded on days they did not inject.</p><table><thead><tr><th>Date</th><th>Reported</th></tr></thead><tbody>
    ${symptomDaysAll.map(e => `<tr><td>${escapeHTML(e.date)}</td><td>${escapeHTML(describeSe(e.se, 99))}</td></tr>`).join('')}
    </tbody></table>` : ''}

    <p class="meta">This report is for personal/clinical reference. Not medical advice.</p>
    <script>window.print()</script>
    </body></html>`;
  w.document.write(html);
  w.document.close();
}

async function createShareLink(label, opts) {
  if (!account.user || !account.encryptionKey) throw new Error('Not unlocked');
  const payload = await buildPayload(opts);
  // The label is health context, so it never travels in the clear (issue #25):
  // the doctor reads it from inside the encrypted payload, and the server keeps
  // only a copy sealed with the account key for the owner.
  if (label) payload.shareLabel = label;
  // Generate per-share random key, embed in URL fragment
  const shareKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const rawKey = await crypto.subtle.exportKey('raw', shareKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, shareKey, await encodePayloadBytes(payload));
  let labelEnc = null;
  if (label) {
    const liv = crypto.getRandomValues(new Uint8Array(12));
    const lct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: liv }, account.encryptionKey, new TextEncoder().encode(label));
    labelEnc = bytesToBase64(liv) + '.' + bytesToBase64(lct);
  }
  const body = { iv: bytesToBase64(iv), ciphertext: bytesToBase64(ct), labelEnc };
  const r = await accountFetch('share', { method: 'POST', body: JSON.stringify(body) });
  if (r.status === 402) throw new Error('Doctor share is a Premium feature.');
  if (!r.ok) throw new Error('Share creation failed.');
  const j = await r.json();
  const keyHex = HEX(rawKey);
  const url = `${location.origin}/view.html#t=${j.token}&k=${keyHex}`;
  return { url, expiresAt: j.expiresAt };
}

// Session-only credential cache. Cleared on tab close. Persisted creds (so the
// user doesn't have to retype every session) live in localStorage as username
// + passphrase — same threat model as a logged-in browser session, mitigated
// by the fact that local data is already in IndexedDB on the same device.
let syncCreds = null; // { username, aesKey, lookupId }

const b64 = {
  enc: (buf) => bytesToBase64(buf),
  dec: (s) => base64ToBytes(s),
};

async function deriveSyncCreds(username, passphrase) {
  if (!username || !passphrase) throw new Error('Username and passphrase required');
  const enc = new TextEncoder();
  const saltBuf = await crypto.subtle.digest('SHA-256', enc.encode(SYNC_PROTOCOL + ':' + username.trim().toLowerCase()));
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBuf, iterations: SYNC_PBKDF2_ITERS, hash: 'SHA-256' },
    baseKey,
    512  // 64 bytes
  );
  const buf = new Uint8Array(bits);
  const aesKey = await crypto.subtle.importKey('raw', buf.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const lookupBytes = buf.slice(32, 64);
  const lookupId = Array.from(lookupBytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return { username: username.trim(), aesKey, lookupId };
}


async function syncDecrypt(creds, iv_b64, ct_b64) {
  const iv = b64.dec(iv_b64);
  const ct = b64.dec(ct_b64);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, creds.aesKey, ct);
  return JSON.parse(new TextDecoder().decode(plaintext));
}


async function buildPayload(opts) {
  const all = !opts || !opts.sections || !opts.sections.length;
  const inc = (k) => all || opts.sections.includes(k);
  const since = opts && opts.range ? rangeCutoff(opts.range) : new Date(0);
  // parseDateFlexible, not new Date(): a bare 'YYYY-MM-DD' parses as UTC midnight,
  // which is the previous evening west of UTC, so a ranged export dropped the
  // entry on its first day.
  const filterByWhen = (rows) => rows.filter(r => parseDateFlexible(r.when || r.date) >= since.getTime());
  const shots = inc('shots') ? filterByWhen((await dbAll(STORES.shots)) || []) : [];
  const weights = inc('weights') ? filterByWhen((await dbAll(STORES.weights)) || []) : [];
  const moods = inc('moods') ? filterByWhen((await dbAll(STORES.moods)) || []) : [];
  // Notes are the most personal thing in the app, so they follow the same rule as
  // everything else here: included in the encrypted blob, excluded from a share
  // unless explicitly ticked (see the share dialog).
  const notes = inc('notes') ? filterByWhen((await getNotesSorted()) || []) : [];
  let supplies = [], measurements = [], labs = [], expenses = [], appetites = [], foodNoise = [], cycles = [];
  if (inc('supplies')) { try { supplies = await getSupplies(); } catch (e) {} }
  if (inc('measurements')) { try { measurements = filterByWhen(await getMeasurements()); } catch (e) {} }
  if (inc('labs')) { try { labs = filterByWhen(await getLabs()); } catch (e) {} }
  if (inc('expenses')) { try { expenses = filterByWhen(await getExpenses()); } catch (e) {} }
  if (inc('appetites')) { try { appetites = filterByWhen(await getAppetitesSorted()); } catch (e) {} }
  if (inc('foodNoise')) { try { foodNoise = filterByWhen(await getFoodNoiseSorted()); } catch (e) {} }
  // Cycles always sync if the user has any entries — toggling visibility off in
  // settings doesn't drop the data from the encrypted blob.
  if (inc('cycles')) { try { cycles = (await dbAll('cycles')) || []; } catch (e) {} }
  let medChanges = [];
  if (inc('medChanges')) { try { medChanges = (await dbAll('medChanges')) || []; } catch (e) {} }
  // Standalone symptom days ride with 'shots': they are the same clinical data
  // as shot.sideEffects, just recorded on a day without an injection.
  let symptoms = [];
  if (inc('shots')) { try { symptoms = filterByWhen(await getSymptomDaysSorted()); } catch (e) {} }
  return {
    // v8 adds stable per-record `uid`s so pulls can merge instead of replace.
    // v9 adds `notes` — free text, merged rather than overwritten on pull.
    // v10 adds `symptoms` — side-effect entries for days with no shot. Bumped
    //     rather than added silently: a v9 client would drop them on the next
    //     push, which is exactly the data loss the version guard exists to stop.
    // v11 adds `tombstones` — deletions, so they sync. Bumped for the same reason:
    //     a v10 client would drop them and bring deleted rows back.
    // v12 adds day tombstones (notes, moods, appetites, foodNoise, symptoms) and
    //     per-symptom seAt times. A v11 client would drop them and bring
    //     deleted days back.
    version: 12,
    exportedAt: new Date().toISOString(),
    range: opts && opts.range ? opts.range : 'all',
    settings,
    shots, weights, moods, appetites, foodNoise, cycles, medChanges, notes, symptoms,
    supplies, measurements, labs, expenses,
    // Full syncs and backups only. A doctor share or ranged export is a
    // snapshot for a reader, and has no use for a list of what was deleted.
    tombstones: opts ? [] : await liveTombstones(),
  };
}


async function syncPullNow() {
  if (!syncCreds) throw new Error('Not signed in to sync');
  const res = await fetch(`${SYNC_API}/${syncCreds.lookupId}`, { headers: { 'Accept': 'application/json' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Sync server returned ${res.status}`);
  const { iv, ciphertext, updated_at } = await res.json();
  let payload;
  try {
    payload = await syncDecrypt(syncCreds, iv, ciphertext);
  } catch (e) {
    throw new Error('Decryption failed — wrong username or passphrase');
  }
  return { payload, updatedAt: updated_at };
}
