// My GLP Shot — local-first PWA. All data lives in IndexedDB on this device.
// (DB name, sync protocol, and lookup_id derivation keep the original 'shotclock'
//  identifier so existing accounts and cached data continue working.)
'use strict';

const DB_NAME = 'shotclock';
// v6 bump: 'appetites' store added — daily appetite check-in alongside mood (GLP-1 mechanism is appetite suppression).
// v7 bump: 'foodNoise' store added — 1-10 daily slider for the mental chatter about food, distinct from physical appetite.
// v8 bump: 'cycles' store added — opt-in menstrual cycle tracking (period start/end, flow, symptoms).
// v9 bump: 'medChanges' store added — medication switches as discrete events so charts stay readable across drug changes.
// v10 bump: 'notes' store added — a free-text line per day, so a number in a chart can carry the reason behind it.
// v11 bump: 'symptoms' store added — side effects for a day you didn't inject. They
//   used to live only on a shot record, which meant the daily side-effect reminder
//   asked for something the app had nowhere to put.
const DB_VERSION = 11;
const APP_VERSION = '0.54.0';

// Umami event tracker. Aggregates only — no PII (no email, no IDs). Safe to call before umami loads.
function track(event, props) {
  try {
    if (typeof window === 'undefined' || typeof window.umami === 'undefined') return;
    if (props && typeof props === 'object') window.umami.track(event, props);
    else window.umami.track(event);
  } catch (_) { /* never let analytics break the app */ }
}
const STORES = { shots: 'shots', weights: 'weights', settings: 'settings', moods: 'moods', supplies: 'supplies' };

// ---------- Signup attribution ----------
// Answers "where did this user come from?" at the only moment it is knowable.
// Server logs can't: the marketing site is served from Cloudflare's edge, so the
// origin never sees the original referrer, and by the time anyone asks, the logs
// have rotated. Captured first-touch, sent once at signup, never on login.
//
// Only a referrer HOST is ever stored or sent — never the full referring URL,
// which for a search engine contains the query someone typed.
const ATTRIB_KEY = 'mgs_attrib';
const ATTRIB_UTM = ['utm_source', 'utm_medium', 'utm_campaign'];

function captureAttribution() {
  try {
    // First touch wins: whatever brought them here the first time is the answer,
    // even if they wander off and come back before creating the account.
    if (localStorage.getItem(ATTRIB_KEY)) { stripAttributionParams(); return; }
    const params = new URLSearchParams(location.search);
    const a = {};

    // mgs_ref is forwarded by the marketing site (attribution.js). Falling back
    // to document.referrer covers anyone who lands on the app directly.
    let ref = params.get('mgs_ref') || '';
    if (!ref && document.referrer) {
      try {
        const h = new URL(document.referrer).hostname.toLowerCase();
        if (h && h !== location.hostname) ref = h.startsWith('www.') ? h.slice(4) : h;
      } catch (_) { /* opaque referrer */ }
    }
    if (ref) a.referrer = ref.slice(0, 80);

    const lp = params.get('mgs_lp') || location.pathname;
    if (lp) a.landing = lp.slice(0, 80);
    for (const k of ATTRIB_UTM) {
      const v = params.get(k);
      if (v) a[k] = v.slice(0, 60);
    }
    if (Object.keys(a).length) localStorage.setItem(ATTRIB_KEY, JSON.stringify(a));
  } catch (_) { /* private mode, storage disabled — attribution is never worth an error */ }
  stripAttributionParams();
}

// Take the tracking params back out of the address bar once they're recorded, so
// a user copying the URL to a friend doesn't pass along someone else's source.
function stripAttributionParams() {
  try {
    const url = new URL(location.href);
    let touched = false;
    for (const k of ['mgs_ref', 'mgs_lp', ...ATTRIB_UTM]) {
      if (url.searchParams.has(k)) { url.searchParams.delete(k); touched = true; }
    }
    if (touched) history.replaceState(null, '', url.pathname + url.search + url.hash);
  } catch (_) {}
}

function getAttribution() {
  try {
    const raw = localStorage.getItem(ATTRIB_KEY);
    if (!raw) return null;
    const a = JSON.parse(raw);
    return (a && typeof a === 'object' && Object.keys(a).length) ? a : null;
  } catch (_) { return null; }
}

captureAttribution();

// Info-tooltip topics keyed by `data-info` on the (i) button. Plain-language explanations + formulas.
const INFO_TOPICS = {
  'next-shot': {
    title: 'Next shot countdown',
    body: async () => {
      const shots = await getShotsSorted();
      const latest = shots.length ? shots[shots.length - 1] : null;
      const med = settings.medication || 'Tirzepatide';
      const cadence = settings.cadenceDays || 7;
      let yourLine = '';
      if (latest) {
        const next = new Date(new Date(latest.when).getTime() + cadence * 86400000);
        const ms = next.getTime() - Date.now();
        const sign = ms < 0 ? 'overdue by' : 'due in';
        const days = Math.abs(Math.round(ms / 86400000));
        yourLine = `<p><strong>For you right now:</strong> last shot was ${escapeHTML(latest.dose + 'mg ' + med)} on ${new Date(latest.when).toLocaleDateString()}, so your next shot is <strong>${sign} ${days} day${days === 1 ? '' : 's'}</strong>.</p>`;
      } else {
        yourLine = `<p><strong>For you right now:</strong> no shots logged yet — log your first to start the countdown.</p>`;
      }
      return `<p>The big number shows how long until your next scheduled shot.</p>
        ${yourLine}
        <h3>How it's calculated</h3>
        <div class="formula">next shot = last shot + ${cadence} days</div>
        <p>Change cadence in <strong>Settings → Medication</strong>. If a shot is overdue, the card turns orange.</p>`;
    },
  },
  'progress-stats': {
    title: 'Your progress',
    body: async () => {
      const weights = await getWeightsSorted();
      const shots = await getShotsSorted();
      const start = settings.startWeight ?? (weights[0] && weights[0].value);
      const latest = weights.length ? weights[weights.length - 1].value : null;
      const lost = (start != null && latest != null) ? (start - latest).toFixed(1) : null;
      const firstShot = shots.length ? new Date(shots[0].when) : null;
      const weeks = firstShot ? Math.floor((Date.now() - firstShot.getTime()) / (7 * 86400000)) : 0;
      let yourLine = '<p><strong>For you right now:</strong> ';
      if (start != null && latest != null) yourLine += `you've gone from <strong>${escapeHTML(start)} lb</strong> to <strong>${escapeHTML(latest)} lb</strong> = <strong>${escapeHTML(lost > 0 ? lost + ' lb lost' : Math.abs(lost) + ' lb gained')}</strong>`;
      else yourLine += `log your starting weight in Settings + at least one weight entry to see your progress`;
      yourLine += `, ${weeks} week${weeks === 1 ? '' : 's'} since first shot, ${shots.length} shot${shots.length === 1 ? '' : 's'} logged.</p>`;
      return `<p>Three numbers across the top of the home screen tell you the big picture.</p>
        ${yourLine}
        <h3>Lost so far</h3>
        <div class="formula">lost = start_weight − latest_weight</div>
        <p>Set start in Settings → Weight goals, or it auto-detects from your first weight entry.</p>
        <h3>Weeks on track</h3>
        <p>How many full weeks since your very first logged shot.</p>
        <h3>Shots taken</h3>
        <p>Total number of shots logged across all time.</p>`;
    },
  },
  'todays-mood': {
    title: 'Daily mood',
    body: `<p>Tap a face to log how you're feeling today. One mood per day; tap "change" to update it.</p>
      <p>Tracking mood alongside doses helps you spot patterns — for example, if you tend to feel low in the days right after a higher dose.</p>
      <p>Change the emoji style on the <strong>Premium</strong> tab.</p>`,
  },
  'daily-note': {
    title: 'Today\'s note',
    body: `<p>A line about what was actually going on today. It saves as you type — there's no button to press.</p>
      <h3>Why it matters</h3>
      <p>Mood, appetite and food noise tell you <em>what</em> a day was like. They can't tell you <em>why</em>. A rough week in the middle of a house move looks identical to a rough week caused by a dose increase — until you read it back six months later and have no idea which it was.</p>
      <p>Anything is worth writing: a stressful week at work, a bad night's sleep, a holiday, a new dose, a bug going round the family.</p>
      <h3>Where it comes back</h3>
      <ul>
        <li>Days with a note get a dot under the bar on every trend strip, and the note shows in the tooltip.</li>
        <li>The <strong>Notes</strong> section on the Insights tab lists them all newest-first, each with that day's mood, and is searchable.</li>
        <li>Tap any entry — or any trend bar — to edit that day.</li>
      </ul>
      <h3>Privacy</h3>
      <p>Notes are encrypted on this device with everything else, and are <strong>never</strong> included in a doctor share or PDF unless you tick "Daily notes" yourself. They're off by default because a note about your life isn't a clinical record.</p>`,
  },
  'appetite': {
    title: 'Daily appetite',
    body: `<p>One of the clearest signals that GLP-1 medication is working is appetite suppression. Logging this every day shows you whether your dose is still doing its job.</p>
      <h3>The five levels</h3>
      <ul>
        <li>🚫 <strong>None</strong> — completely uninterested in food, may need to remind yourself to eat</li>
        <li>🤏 <strong>Low</strong> — small portions feel filling, easy to eat below maintenance</li>
        <li>🍽️ <strong>Normal</strong> — typical hunger signals</li>
        <li>😋 <strong>Hungry</strong> — wanting more than usual</li>
        <li>😅 <strong>Ravenous</strong> — strong cravings, hard to feel satisfied</li>
      </ul>
      <p>Use this to spot when appetite returns toward the end of your dose cycle (often a sign you're due for your shot) or when a higher dose is needed for continued suppression.</p>`,
  },
  'appetite-trend': {
    title: 'Appetite trend',
    body: `<p>The last 30 days of daily appetite, one bar per day.</p>
      <p>Lower bars (teal) = stronger suppression = medication working. Higher bars (orange) = appetite returning. Empty bars = no log that day.</p>
      <p>Compare against your dose schedule (Insights → How much is in your system) to see whether bumps line up with shot timing.</p>`,
  },
  'mixing-calc': {
    title: 'Mixing calculator',
    body: async () => {
      // Pull the user's current calc inputs so the formula is shown with their numbers.
      const v = parseFloat(($('#recon-vial') || {}).value) || 0;
      const w = parseFloat(($('#recon-water') || {}).value) || 0;
      const d = parseFloat(($('#recon-dose') || {}).value) || 0;
      let yourLine = '';
      if (v > 0 && w > 0 && d > 0) {
        const conc = v / w;
        const drawMl = d / conc;
        const units = (drawMl * 100).toFixed(1);
        const doses = Math.floor(v / d);
        yourLine = `<p><strong>For your current numbers:</strong> ${v}mg in ${w}mL = <strong>${conc.toFixed(2)} mg/mL</strong>. To get a ${d}mg dose, draw to <strong>${units} units</strong> (${doses} dose${doses === 1 ? '' : 's'} per vial).</p>`;
      }
      return `<p>If you're reconstituting your own peptide (mixing powder with bacteriostatic water), this tells you how many units to draw into a U-100 insulin syringe.</p>
        ${yourLine}
        <h3>How it's calculated</h3>
        <div class="formula">concentration = vial_mg ÷ water_mL<br>draw_volume_mL = your_dose_mg ÷ concentration<br>units = draw_volume_mL × 100</div>
        <p>"Doses in this vial" is <code>vial_mg ÷ your_dose_mg</code>, rounded down.</p>
        <p>Always double-check with your prescriber. This is a math helper, not medical advice.</p>`;
    },
  },
  'achievements': {
    title: 'Achievements',
    body: `<p>Small badges that unlock as you hit milestones.</p>
      <ul>
        <li><strong>First shot logged</strong> — once you log your first dose</li>
        <li><strong>10 / 50 / 100 shots</strong> — total shots logged</li>
        <li><strong>4-week streak</strong> — four shots in a row at your scheduled cadence</li>
        <li><strong>5 / 10 / 25 lb lost</strong> — weight change from your starting weight</li>
        <li><strong>Dose graduation</strong> — you've increased your dose at least once (typical titration)</li>
      </ul>
      <p>Locked badges are dimmed; unlocked ones are colored.</p>`,
  },
  'inject-sites': {
    title: 'Where you inject',
    body: `<p>The body diagram shows the six common shot sites — arms, abdomen, thighs. Each circle is colored by how recently you used that site:</p>
      <ul>
        <li><span style="color:#fb923c">●</span> <strong>This week</strong> — avoid; let it rest</li>
        <li><span style="color:#0d9488">●</span> <strong>1–2 weeks</strong> — used recently</li>
        <li><span style="color:#5eead4">●</span> <strong>2+ weeks</strong> — fresh, fine to reuse</li>
        <li><span>○</span> <strong>Unused</strong> — never injected here</li>
      </ul>
      <p>Tap a site to suggest it for your next shot. Rotating sites helps prevent lipohypertrophy (lumps under the skin).</p>`,
  },
  'insights': {
    title: 'Patterns',
    body: `<p>Plain-language observations about your data. We compute on-device — your data never leaves your browser to make these.</p>
      <p>Each pattern is descriptive ("most often", "tended to") rather than statistical, and each card links to the underlying chart so you can verify it yourself. We avoid any "% increase" or causal language because patterns don't equal causes — your prescriber is the right person for medical interpretation.</p>
      <p>If a pattern doesn't have enough data yet, it shows <em>"Need N more shots to compute"</em>. As you log more, more patterns surface.</p>
      <p>Some patterns require multiple data types (weight + dose, food noise + cycle position, etc.) and are part of the Premium tier; basic single-data patterns are free for everyone.</p>`,
  },
  'cycle-tracking': {
    title: 'Cycle tracking',
    body: `<p>Opt-in tracking for menstrual cycle start, end, flow, and symptoms. Useful because GLP-1 medications can change cycle length, flow, and symptom profile.</p>
      <p>Privacy: tracked locally like everything else, end-to-end encrypted if you sync. Toggling cycle tracking off in Settings <strong>hides the UI but preserves your data</strong> — nothing is deleted unless you tap "Delete all cycle entries."</p>
      <p>Log a period when it starts; come back and add the end date when it finishes. Symptoms are optional and additive across the cycle.</p>`,
  },
  'food-noise': {
    title: 'Food noise',
    body: `<p>"Food noise" is the mental chatter about food — intrusive thoughts, obsessing over the next meal, feeling like food is always on your mind. It's distinct from physical hunger.</p>
      <p>For many GLP-1 users, the food noise going quiet is the single most life-changing effect. It can quiet down even when appetite is normal, and it can come back as the dose wears off across the cycle.</p>
      <p>Logging it daily helps you spot the pattern: when the noise comes back relative to your shot, and how it tracks with dose changes.</p>
      <ul>
        <li><strong>1-2 (Quiet):</strong> "I forgot to eat."</li>
        <li><strong>3-4 (Mild):</strong> Aware of food but not preoccupied.</li>
        <li><strong>5-6 (Moderate):</strong> Some food thoughts; manageable.</li>
        <li><strong>7-8 (Loud):</strong> Frequent intrusive thoughts about food.</li>
        <li><strong>9-10 (Constant):</strong> Can't stop thinking about food.</li>
      </ul>`,
  },
  'weight-chart': {
    title: 'Weight tracking',
    body: `<p>Line chart of your logged weight entries over time.</p>
      <p>Use the <strong>1M / 3M / 6M / 1Y / All</strong> buttons to zoom into a specific window.</p>
      <p>Tap <strong>+ Add</strong> to log a new weight (lb or kg). Frequency doesn't matter — once a week, once a day, whatever fits your routine.</p>`,
  },
  'mood-trend': {
    title: 'Mood trend',
    body: `<p>The last 30 days of your daily moods, one bar per day.</p>
      <p>Taller bar = better mood (1 = awful, 5 = great). Days you didn't log show as gaps.</p>
      <p>Helps you see whether your dose changes correlate with how you feel.</p>`,
  },
  'level-chart': {
    title: 'How much is in your system',
    body: async () => {
      const halfLife = settings.halfLifeDays || 5;
      const med = settings.medication || 'Tirzepatide';
      const shots = await getShotsSorted();
      const decay = Math.log(2) / halfLife;
      let levelNow = 0;
      for (const s of shots) {
        const days = (Date.now() - new Date(s.when).getTime()) / 86400000;
        if (days >= 0) levelNow += (s.dose || 0) * Math.exp(-decay * days);
      }
      const yourLine = shots.length
        ? `<p><strong>For you right now:</strong> with a ${halfLife}-day half-life setting, your estimated active level is <strong>${levelNow.toFixed(1)} mg-equivalent</strong> across ${shots.length} logged shot${shots.length === 1 ? '' : 's'}.</p>`
        : `<p><strong>For you right now:</strong> log your first shot to see your active level estimate.</p>`;
      return `<p>Estimates how much ${escapeHTML(med)} is still active in your body, based on every shot you've logged and the half-life you set in <strong>Settings → Medication</strong>.</p>
        ${yourLine}
        <h3>How it's calculated</h3>
        <p>Each shot decays exponentially. The total is the sum of every past shot's remaining contribution at each point in time.</p>
        <div class="formula">level(t) = Σ dose × e^(-ln(2) × days_since / half_life)</div>
        <p>Common half-lives — Tirzepatide ≈ 5 days, Semaglutide ≈ 7 days. Yours is set to <strong>${halfLife} days</strong>.</p>
        <p><strong>Not a clinical measurement</strong> — this is a learning tool to help you visualize the rhythm of your dosing.</p>`;
    },
  },
  'plateau': {
    title: 'Plateau detection',
    body: async () => {
      const weights = await getWeightsSorted();
      const cutoff = Date.now() - 28 * 86400000;
      const inWindow = weights.filter(w => new Date(w.date).getTime() >= cutoff);
      let yourLine = '';
      if (inWindow.length >= 2) {
        const first = inWindow[0].value;
        const last = inWindow[inWindow.length - 1].value;
        const delta = (last - first).toFixed(1);
        yourLine = `<p><strong>For you right now:</strong> ${inWindow.length} weight entries in the last 28 days, total change <strong>${delta} lb</strong>. ${Math.abs(delta) < 1 ? '⚠️ This would currently flag as a plateau.' : 'No plateau — keep going.'}</p>`;
      } else {
        yourLine = `<p><strong>For you right now:</strong> need at least 4 weight entries in the last 28 days to detect a plateau (you have ${inWindow.length}).</p>`;
      }
      return `<p>Flags when your weight has been mostly flat for 4+ weeks at the same dose.</p>
        ${yourLine}
        <h3>Triggers when ALL are true</h3>
        <ul>
          <li>4+ weight entries in the last 28 days</li>
          <li>Total change less than 1 lb</li>
          <li>No dose increase during that window</li>
        </ul>
        <p>Plateaus are normal. The card just gives you a heads-up that it might be time to talk to your provider about a dose adjustment, diet/exercise tweaks, or just patience.</p>`;
    },
  },
  'supplies': {
    title: 'Pens & vials',
    body: `<p>Track every pen or vial you have on hand: pharmacy, lot number, total mg, expiration date, cost.</p>
      <p>Enter the <strong>total</strong> mg in the whole pen or vial, not the dose you inject — both numbers are on the box, usually printed together as mg/mL.</p>
      <p>The progress bar fills as you log shots. A supply counts the shots from the day you opened it until the day you opened the next one, so each shot is charged to exactly one pen. Set the "Date opened" or there's nothing to count from.</p>
      <p>You'll see a warning when a pen is within 7 days of expiring or has gone past expiration.</p>`,
  },
  'measurements': {
    title: 'Body measurements',
    body: `<p>Track waist, hips, chest, thighs, arms, neck. Useful when the scale isn't moving but you're losing inches.</p>
      <p>Each card shows the latest value plus the change from your earliest entry.</p>`,
  },
  'labs': {
    title: 'Lab numbers',
    body: `<p>Log lab results so you can show your doctor a trend over time: A1c, fasting glucose, blood pressure, cholesterol panel, ALT.</p>
      <p>Each lab shows your latest value with a green/yellow/red marker based on standard reference ranges.</p>`,
  },
  'spending': {
    title: 'Spending',
    body: async () => {
      let supplies = [], expenses = [];
      try { supplies = await getSupplies(); } catch (_) {}
      try { expenses = await getExpenses(); } catch (_) {}
      const supTotal = supplies.reduce((s, r) => s + (parseFloat(r.cost) || 0), 0);
      const expTotal = expenses.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);
      const total = supTotal + expTotal;
      const weights = await getWeightsSorted();
      const start = settings.startWeight ?? (weights[0] && weights[0].value);
      const latest = weights.length ? weights[weights.length - 1].value : null;
      const lost = (start != null && latest != null && latest < start) ? (start - latest) : 0;
      let yourLine = '';
      if (total > 0) {
        const perLb = lost > 0 ? `<strong>$${(total / lost).toFixed(2)} per lb lost</strong>` : '';
        yourLine = `<p><strong>For you right now:</strong> $${supTotal.toFixed(2)} in supplies + $${expTotal.toFixed(2)} in expenses = <strong>$${total.toFixed(2)} total</strong>. ${perLb}</p>`;
      } else {
        yourLine = `<p><strong>For you right now:</strong> no spending tracked yet — add a pen/vial cost or an expense to get started.</p>`;
      }
      return `<p>Adds up everything you've spent on the program — pens, vials, copays, pharmacy fees, labs, insurance, supplies, shipping.</p>
        ${yourLine}
        <h3>How "$ per lb lost" is calculated</h3>
        <div class="formula">$ per lb = total_spent ÷ pounds_lost</div>
        <p>Includes both supply costs (entered when you add a pen/vial) and ad-hoc expenses (entered with the <strong>+ Add</strong> button on this card).</p>`;
    },
  },
  'theme': {
    title: 'App theme',
    body: `<p>Pick from 20 color palettes. The theme covers the entire app — buttons, charts, calendar, badges, gradients — and applies to both light and dark mode.</p>
      <p>Every theme is contrast-tested to stay readable.</p>`,
  },
  'emoji-style': {
    title: 'Mood emoji style',
    body: `<p>5 emoji sets for the daily mood picker:</p>
      <ul>
        <li><strong>Classic</strong> — hand-drawn smileys, themed to match your color theme</li>
        <li><strong>Simple</strong> — plain emoji faces</li>
        <li><strong>Weather</strong> — storm to sunny</li>
        <li><strong>Hearts</strong> — broken to whole</li>
        <li><strong>Energy</strong> — depleted to charged</li>
      </ul>
      <p>Updates picker buttons + today's mood card.</p>`,
  },
  'appetite-style': {
    title: 'Appetite emoji style',
    body: `<p>4 emoji sets for the daily appetite picker:</p>
      <ul>
        <li><strong>Classic</strong> — none → ravenous</li>
        <li><strong>Plates</strong> — empty plate → full meal</li>
        <li><strong>Faces</strong> — uninterested → drooling</li>
        <li><strong>Gauge</strong> — green/yellow/orange/red traffic-light style</li>
      </ul>`,
  },
  'pdf-export': {
    title: 'PDF report for your doctor',
    body: `<p>Generates a printable summary of the last 90 days: every shot, weight trend, mood overview, side effects.</p>
      <p>Great for appointments — gives your provider the full picture in one page.</p>`,
  },
  'doctor-share': {
    title: 'Doctor share link',
    body: `<p>Creates a private, read-only link you can text or email to your provider.</p>
      <p>The link expires in 24 hours. The data is end-to-end encrypted; the server can't read it. The link itself contains the decryption key, so anyone with the link can view it during the 24-hour window.</p>`,
  },
};

async function showInfo(key) {
  const topic = INFO_TOPICS[key];
  if (!topic) return;
  document.getElementById('info-dialog-title').textContent = topic.title;
  // body can be a static string or an async function — async lets us pull live values from settings/IDB.
  let body = topic.body;
  if (typeof body === 'function') {
    try { body = await body(); } catch (e) { console.warn('[mgs] info body fn failed:', e); body = topic.fallback || '<p>Could not load details.</p>'; }
  }
  document.getElementById('info-dialog-body').innerHTML = body;
  document.getElementById('info-dialog').showModal();
  track('info_opened', { topic: key });
}

function setupInfoButtons() {
  // Wire all (i) buttons that exist in the DOM. One delegated listener so dynamically-rendered (i) buttons also work.
  document.body.addEventListener('click', (e) => {
    const btn = e.target.closest('.info-btn[data-info]');
    if (!btn) return;
    e.preventDefault();
    showInfo(btn.dataset.info);
  });
  const closeBtn = document.getElementById('info-dialog-close');
  if (closeBtn) closeBtn.addEventListener('click', () => document.getElementById('info-dialog').close());
}

// 20 color themes. Each defines a light-mode and dark-mode variant so the app stays readable in both.
// Tokens overridden: --bronze (primary), --bronze-dk (darker primary, used for hover/active text), --bronze-lt (subtle tint background), --grad (hero/countdown gradient).
// Light mode: primary mid-saturation, dark = darker primary, tint = very pale primary.
// Dark mode: primary slightly lighter (for contrast on dark bg), dark = even lighter (used as link/highlighted text on dark surfaces), tint = deep dark version of the hue.
const THEMES = [
  { id: 'teal',        name: 'Teal',         light: { primary: '#14b8a6', dark: '#0f766e', tint: '#ccfbf1', grad2: '#0d9488' }, dark: { primary: '#2dd4bf', dark: '#5eead4', tint: '#134e4a', grad2: '#0d9488' } },
  { id: 'bronze',      name: 'Bronze',       light: { primary: '#c7915b', dark: '#83542e', tint: '#f5ebe3', grad2: '#a16d3a' }, dark: { primary: '#d4a574', dark: '#e7c8a0', tint: '#3d2a18', grad2: '#a16d3a' } },
  { id: 'purple',      name: 'Royal Purple', light: { primary: '#8b5cf6', dark: '#6d28d9', tint: '#ede9fe', grad2: '#7c3aed' }, dark: { primary: '#a78bfa', dark: '#c4b5fd', tint: '#2e1065', grad2: '#7c3aed' } },
  { id: 'pink',        name: 'Hot Pink',     light: { primary: '#ec4899', dark: '#be185d', tint: '#fce7f3', grad2: '#db2777' }, dark: { primary: '#f472b6', dark: '#fbcfe8', tint: '#500724', grad2: '#db2777' } },
  { id: 'coral',       name: 'Coral',        light: { primary: '#fb7185', dark: '#be123c', tint: '#ffe4e6', grad2: '#e11d48' }, dark: { primary: '#fda4af', dark: '#fecdd3', tint: '#4c0519', grad2: '#e11d48' } },
  { id: 'forest',      name: 'Forest',       light: { primary: '#22c55e', dark: '#15803d', tint: '#dcfce7', grad2: '#16a34a' }, dark: { primary: '#4ade80', dark: '#86efac', tint: '#14532d', grad2: '#16a34a' } },
  { id: 'sky',         name: 'Sky Blue',     light: { primary: '#0ea5e9', dark: '#0369a1', tint: '#e0f2fe', grad2: '#0284c7' }, dark: { primary: '#38bdf8', dark: '#7dd3fc', tint: '#0c4a6e', grad2: '#0284c7' } },
  { id: 'lavender',    name: 'Lavender',     light: { primary: '#a78bfa', dark: '#7c3aed', tint: '#f3e8ff', grad2: '#9333ea' }, dark: { primary: '#c4b5fd', dark: '#ddd6fe', tint: '#3b0764', grad2: '#9333ea' } },
  { id: 'sunset',      name: 'Sunset',       light: { primary: '#f97316', dark: '#c2410c', tint: '#ffedd5', grad2: '#ea580c' }, dark: { primary: '#fb923c', dark: '#fdba74', tint: '#431407', grad2: '#ea580c' } },
  { id: 'cherry',      name: 'Cherry Red',   light: { primary: '#dc2626', dark: '#991b1b', tint: '#fee2e2', grad2: '#b91c1c' }, dark: { primary: '#ef4444', dark: '#fca5a5', tint: '#450a0a', grad2: '#b91c1c' } },
  { id: 'mint',        name: 'Mint',         light: { primary: '#34d399', dark: '#047857', tint: '#d1fae5', grad2: '#059669' }, dark: { primary: '#6ee7b7', dark: '#a7f3d0', tint: '#022c22', grad2: '#059669' } },
  { id: 'indigo',      name: 'Indigo',       light: { primary: '#6366f1', dark: '#3730a3', tint: '#e0e7ff', grad2: '#4f46e5' }, dark: { primary: '#818cf8', dark: '#a5b4fc', tint: '#1e1b4b', grad2: '#4f46e5' } },
  { id: 'rose',        name: 'Rose Gold',    light: { primary: '#f43f5e', dark: '#9f1239', tint: '#ffe4e6', grad2: '#e11d48' }, dark: { primary: '#fb7185', dark: '#fda4af', tint: '#4c0519', grad2: '#e11d48' } },
  { id: 'slate',       name: 'Slate',        light: { primary: '#64748b', dark: '#334155', tint: '#f1f5f9', grad2: '#475569' }, dark: { primary: '#94a3b8', dark: '#cbd5e1', tint: '#0f172a', grad2: '#475569' } },
  { id: 'emerald',     name: 'Emerald',      light: { primary: '#10b981', dark: '#065f46', tint: '#d1fae5', grad2: '#059669' }, dark: { primary: '#34d399', dark: '#6ee7b7', tint: '#022c22', grad2: '#059669' } },
  { id: 'plum',        name: 'Plum',         light: { primary: '#a855f7', dark: '#6b21a8', tint: '#f3e8ff', grad2: '#9333ea' }, dark: { primary: '#c084fc', dark: '#d8b4fe', tint: '#3b0764', grad2: '#9333ea' } },
  { id: 'sand',        name: 'Sand',         light: { primary: '#d97706', dark: '#78350f', tint: '#fef3c7', grad2: '#b45309' }, dark: { primary: '#f59e0b', dark: '#fcd34d', tint: '#451a03', grad2: '#b45309' } },
  { id: 'ocean',       name: 'Ocean',        light: { primary: '#2563eb', dark: '#1e3a8a', tint: '#dbeafe', grad2: '#1d4ed8' }, dark: { primary: '#60a5fa', dark: '#93c5fd', tint: '#1e3a8a', grad2: '#1d4ed8' } },
  { id: 'terracotta',  name: 'Terracotta',   light: { primary: '#b45309', dark: '#78350f', tint: '#fef3c7', grad2: '#92400e' }, dark: { primary: '#d97706', dark: '#fbbf24', tint: '#451a03', grad2: '#92400e' } },
  { id: 'charcoal',    name: 'Charcoal',     light: { primary: '#374151', dark: '#111827', tint: '#f3f4f6', grad2: '#1f2937' }, dark: { primary: '#9ca3af', dark: '#d1d5db', tint: '#030712', grad2: '#1f2937' } },
];

// Mood styles — 5 clear sets with unambiguous low→high progression. (Reduced from 10; ambiguous packs removed.)
// 'classic' uses the hand-drawn SVG faces (handled separately in applyMoodStyle).
const MOOD_STYLES = [
  { id: 'classic', name: 'Classic',  emojis: ['😣', '😕', '😐', '🙂', '😄'] }, // SVG faces in main UI; emojis are picker preview only
  { id: 'animals', name: 'Animals',  emojis: ['🐢', '🐌', '🐱', '🐶', '🦁'] },
  { id: 'weather', name: 'Weather',  emojis: ['⛈️', '🌧️', '☁️', '⛅', '☀️'] },
  { id: 'hearts',  name: 'Hearts',   emojis: ['💔', '🤍', '💛', '💚', '❤️'] },
  { id: 'energy',  name: 'Energy',   emojis: ['🪫', '😴', '😶', '😊', '⚡'] },
];

// Appetite emoji packs — 4 simple sets, unambiguous low→high (suppressed → ravenous).
const APPETITE_STYLES = [
  { id: 'classic', name: 'Classic', emojis: ['🚫', '🤏', '🍽️', '😋', '😅'] },
  { id: 'plates',  name: 'Plates',  emojis: ['🚫', '🥄', '🍽️', '🍔', '🍕'] },
  { id: 'faces',   name: 'Faces',   emojis: ['😶', '🙂', '😐', '😋', '🤤'] },
  { id: 'gauge',   name: 'Gauge',   emojis: ['🟢', '🟢', '🟡', '🟠', '🔴'] },
];
const SETTINGS_KEY = 'app';
const DEFAULT_SETTINGS = {
  medication: 'Tirzepatide',
  defaultDose: 5,
  cadenceDays: 7,
  halfLifeDays: 5,
  notify: false,
  notifyLeadMinutes: 60,
  theme: 'system',
  lastBackup: null,
  startWeight: null,
  goalWeight: null,
  achievements: [],
  syncEnabled: false,
  syncUsername: null,
  syncLastPushAt: null,
  syncLastPullAt: null,
  syncLastUpdatedAt: null,
  syncLastError: '',
  syncLastErrorAt: null,
  syncAutoPush: true,
  syncDirty: false,
  bodySex: 'male',
  colorTheme: 'teal',
  moodStyle: 'classic',
  appetiteStyle: 'classic',
  customSites: [],
  cycleEnabled: false,
  cycleSeenOptIn: false,
  // The mixing calculator only applies to people reconstituting their own
  // peptide. It used to be a permanent card on Home for everyone, including
  // pen users who will never need it. Off by default; opt in from Settings.
  showMixingCalc: false,
  maintenanceMode: false,
  // Timezone: IANA name (e.g. "America/Chicago"). When unset, falls back to the
  // device timezone at runtime. Once a user sets one explicitly it overrides
  // device TZ everywhere — "today", streaks, charts, and reminder fire times.
  timezone: null,
  // Per-section daily reminders. Each entry: { enabled: bool, time: 'HH:MM' (24h, user TZ) }.
  // Shot reminder ("notify"/"notifyLeadMinutes" above) is dose-driven and lives separately.
  dailyReminders: {
    weight:       { enabled: false, time: '08:00' },
    moodAppetite: { enabled: false, time: '20:00' },
    sideEffects:  { enabled: false, time: '20:00' },
    measurements: { enabled: false, time: '07:30' },
  },
};

// Daily reminder catalog. Order = render order in settings UI.
// `route` is the URL hash the SW opens on notification click → main() reads it
// and snaps to the right tab + card.
const DAILY_REMINDERS = [
  { key: 'weight',       label: 'Weight',           emoji: '⚖️',  title: 'Log your weight', body: 'Quick daily weigh-in keeps your chart honest.',                 route: '#reminder=weight' },
  { key: 'moodAppetite', label: 'Mood & appetite',  emoji: '😊', title: 'How are you feeling?', body: 'Tap to log mood, appetite, and food-noise for today.',     route: '#reminder=moodAppetite' },
  { key: 'sideEffects',  label: 'Side effects',     emoji: '🩺', title: 'Side effects check-in', body: 'Anything to report today? Logging helps spot patterns.', route: '#reminder=sideEffects' },
  { key: 'measurements', label: 'Body measurements', emoji: '📏', title: 'Body measurements', body: 'Time to log waist, hips, and any other tracked sites.',      route: '#reminder=measurements' },
];

// Side-effect taxonomy. Each entry: [key, label, group]. Adding new keys is
// purely additive — existing shot.sideEffects rows untouched.
// Groups surface as section headers in the picker and as per-category trends.
const SIDE_EFFECTS = [
  // Digestive
  ['nausea',          'Nausea',                   'digestive'],
  ['heartburn',       'Heartburn',                'digestive'],
  ['indigestion',     'Indigestion',              'digestive'],
  ['stomachPain',     'Stomach pain',             'digestive'],
  ['constipation',    'Constipation',             'digestive'],
  ['diarrhea',        'Diarrhea',                 'digestive'],
  ['refluxGerd',      'Reflux / GERD',            'digestive'],
  ['sulfurBurps',     'Sulfur burps',             'digestive'],
  ['metallicTaste',   'Metallic taste',           'digestive'],
  // Energy & temperature
  ['fatigue',         'Fatigue',                  'energy'],
  ['chills',          'Chills',                   'energy'],
  ['hotFlashes',      'Hot flashes',              'energy'],
  ['nightSweats',     'Night sweats',             'energy'],
  ['sleepDisrupted',  'Sleep disruption',         'energy'],
  // Mood
  ['lowMood',         'Low mood',                 'mood'],
  ['anxiety',         'Anxiety',                  'mood'],
  ['irritability',    'Irritability',             'mood'],
  ['moodSwings',      'Mood swings',              'mood'],
  // GLP-1 specific / other
  ['foodNoiseReturned','Food noise returned',     'glp1'],
  ['headache',        'Headache',                 'other'],
  ['injSiteReaction', 'Injection site reaction',  'other'],
  ['hairLoss',        'Hair loss',                'other'],
];
const SE_GROUPS = [
  ['digestive', 'Digestive'],
  ['energy',    'Energy & temperature'],
  ['mood',      'Mood'],
  ['glp1',      'GLP-1 specific'],
  ['other',     'Other'],
];
const SE_LEVELS = [['', 'None'], ['mild', 'Mild'], ['moderate', 'Moderate'], ['severe', 'Severe']];

// Medication presets — half-life values are pulled from FDA labels and
// published pharmacokinetics. Half-life remains user-editable; presets just
// suggest sensible defaults. ER (extended-release) variants like exenatide
// once-weekly have a much longer effective half-life than the daily IR form.
// `doses` is the labelled titration ladder, offered as one-tap chips next to
// the dose field. It exists because the dose box used to step in 0.1s, so
// 0.25 mg — the semaglutide starting dose almost everyone begins on — was
// rejected outright and users rounded it to 0.2. The step is fixed; the chips
// mean the right number is a tap away rather than something to get right by
// hand. Doses are the union of the brand labels for that molecule. An empty
// ladder means no approved label to quote (retatrutide is trial-stage), and
// the field still accepts any value.
const MED_PRESETS = [
  { id: 'tirzepatide',  name: 'Tirzepatide',  halfLifeDays: 5,    defaultDose: 5,    cadenceDays: 7, brands: ['Mounjaro', 'Zepbound'], doses: [2.5, 5, 7.5, 10, 12.5, 15] },
  { id: 'semaglutide',  name: 'Semaglutide',  halfLifeDays: 7,    defaultDose: 1,    cadenceDays: 7, brands: ['Ozempic', 'Wegovy'],    doses: [0.25, 0.5, 1, 1.7, 2, 2.4] },
  { id: 'liraglutide',  name: 'Liraglutide',  halfLifeDays: 0.55, defaultDose: 1.8,  cadenceDays: 1, brands: ['Saxenda', 'Victoza'],   doses: [0.6, 1.2, 1.8, 2.4, 3] },
  { id: 'dulaglutide',  name: 'Dulaglutide',  halfLifeDays: 5,    defaultDose: 1.5,  cadenceDays: 7, brands: ['Trulicity'],            doses: [0.75, 1.5, 3, 4.5] },
  { id: 'exenatide-er', name: 'Exenatide ER', halfLifeDays: 14,   defaultDose: 2,    cadenceDays: 7, brands: ['Bydureon'],             doses: [2] },  // microsphere release ~2 weeks
  { id: 'exenatide',    name: 'Exenatide',    halfLifeDays: 0.1,  defaultDose: 0.01, cadenceDays: 1, brands: ['Byetta'],               doses: [0.005, 0.01] },  // ~2.4h half-life
  { id: 'retatrutide',  name: 'Retatrutide',  halfLifeDays: 6,    defaultDose: 4,    cadenceDays: 7, brands: [], doses: [] },
];
// Render the titration ladder for `medName` as tappable chips into `wrapSel`,
// filling `inputSel` when one is tapped. Hidden entirely when the medication
// has no ladder, so a custom peptide just gets the plain field.
function renderDoseChips(wrapSel, inputSel, medName) {
  const wrap = $(wrapSel);
  const input = $(inputSel);
  if (!wrap || !input) return;
  const preset = findMedPreset(medName);
  const ladder = (preset && preset.doses) || [];
  if (!ladder.length) { wrap.hidden = true; wrap.innerHTML = ''; return; }
  const current = parseFloat(input.value);
  wrap.dataset.target = inputSel;
  wrap.innerHTML = ladder.map(d =>
    `<button type="button" class="dose-chip${d === current ? ' active' : ''}" data-dose="${d}">${d} mg</button>`
  ).join('');
  wrap.hidden = false;
}

// One delegated listener for every chip row — the rows are re-rendered on each
// medication change, so per-button listeners would leak.
function setupDoseChips() {
  document.addEventListener('click', (e) => {
    const chip = e.target.closest ? e.target.closest('.dose-chip') : null;
    if (!chip) return;
    const wrap = chip.parentElement;
    const input = wrap && wrap.dataset.target ? $(wrap.dataset.target) : null;
    if (!input) return;
    input.value = chip.dataset.dose;
    // #set-dose persists on 'change'; the shot form reads the value on submit.
    input.dispatchEvent(new Event('change', { bubbles: true }));
    wrap.querySelectorAll('.dose-chip').forEach(c => c.classList.toggle('active', c === chip));
  });
  const med = $('#shot-med');
  if (med) med.addEventListener('input', () => renderDoseChips('#shot-dose-chips', '#shot-dose-amt', med.value));
}

function findMedPreset(name) {
  if (!name) return null;
  const n = name.trim().toLowerCase();
  return MED_PRESETS.find(p =>
    p.name.toLowerCase() === n ||
    p.brands.some(b => b.toLowerCase() === n)
  ) || null;
}

// Canonical 8-site set (4 abdomen quadrants + 2 thighs + 2 arms) + legacy keys
// kept so shots logged before the split still anchor to a sensible dot. The
// dropdown only surfaces the canonical 8 + any custom sites the user adds.
const SITE_POSITIONS = {
  'Upper arm — Left':           { x: 60,  y: 90,  short: 'L Arm' },
  'Upper arm — Right':          { x: 140, y: 90,  short: 'R Arm' },
  'Abdomen — Upper Left':       { x: 86,  y: 132, short: 'UL Abd' },
  'Abdomen — Upper Right':      { x: 114, y: 132, short: 'UR Abd' },
  'Abdomen — Lower Left':       { x: 86,  y: 162, short: 'LL Abd' },
  'Abdomen — Lower Right':      { x: 114, y: 162, short: 'LR Abd' },
  'Thigh — Left':               { x: 70,  y: 220, short: 'L Thigh' },
  'Thigh — Right':              { x: 130, y: 220, short: 'R Thigh' },
  // Legacy (pre-quadrant split). Mapped to lower abdomen since most users
  // injected lower-abdomen by default.
  'Abdomen — Left':             { x: 86,  y: 162, short: 'L Abd' },
  'Abdomen — Right':            { x: 114, y: 162, short: 'R Abd' },
};
// Sites surfaced in the dropdown (legacy keys hidden).
const CANONICAL_SITES = [
  'Abdomen — Upper Left', 'Abdomen — Upper Right',
  'Abdomen — Lower Left', 'Abdomen — Lower Right',
  'Thigh — Left', 'Thigh — Right',
  'Upper arm — Left', 'Upper arm — Right',
];

const ACHIEVEMENTS = [
  // Shot count milestones — covers the full journey, with early wins to keep momentum
  { id: 'first',     icon: '💉', label: 'First shot logged',           test: ({shots}) => shots.length >= 1 },
  { id: 'three',     icon: '3️⃣', label: '3 shots taken',                test: ({shots}) => shots.length >= 3 },
  { id: 'ten',       icon: '🔟', label: '10 shots',                     test: ({shots}) => shots.length >= 10 },
  { id: 'twentyfive',icon: '🎯', label: '25 shots',                     test: ({shots}) => shots.length >= 25 },
  { id: 'fifty',     icon: '✋', label: '50 shots',                     test: ({shots}) => shots.length >= 50 },
  { id: 'hundred',   icon: '💯', label: '100 shots',                    test: ({shots}) => shots.length >= 100 },
  { id: 'twohundred',icon: '🎖️', label: '200 shots',                    test: ({shots}) => shots.length >= 200 },
  { id: 'fivehundred',icon: '🏅', label: '500 shots — veteran',         test: ({shots}) => shots.length >= 500 },
  // On-cadence streaks — every week you hit your scheduled shot
  { id: 'streak2',   icon: '✨', label: '2-week streak',                test: ({streak}) => streak >= 2 },
  { id: 'streak4',   icon: '🔥', label: '4-week streak',                test: ({streak}) => streak >= 4 },
  { id: 'streak8',   icon: '⚡', label: '8-week streak',                test: ({streak}) => streak >= 8 },
  { id: 'streak12',  icon: '🚀', label: '12-week streak',               test: ({streak}) => streak >= 12 },
  { id: 'streak26',  icon: '🏆', label: '6-month streak',               test: ({streak}) => streak >= 26 },
  { id: 'streak52',  icon: '👑', label: '1-year streak',                test: ({streak}) => streak >= 52 },
  { id: 'streak104', icon: '💎', label: '2-year streak',                test: ({streak}) => streak >= 104 },
  // Weight loss tiers — all measured against starting weight
  { id: 'lost2',     icon: '🌱', label: 'First 2 lb lost',              test: ({delta}) => delta <= -2 },
  { id: 'lost5',     icon: '⭐', label: '5 lb lost',                    test: ({delta}) => delta <= -5 },
  { id: 'lost10',    icon: '🌟', label: '10 lb lost',                   test: ({delta}) => delta <= -10 },
  { id: 'lost15',    icon: '💚', label: '15 lb lost',                   test: ({delta}) => delta <= -15 },
  { id: 'lost25',    icon: '💫', label: '25 lb lost',                   test: ({delta}) => delta <= -25 },
  { id: 'lost40',    icon: '🌠', label: '40 lb lost',                   test: ({delta}) => delta <= -40 },
  { id: 'lost50',    icon: '✨', label: '50 lb lost',                   test: ({delta}) => delta <= -50 },
  { id: 'lost75',    icon: '🦋', label: '75 lb lost',                   test: ({delta}) => delta <= -75 },
  { id: 'lost100',   icon: '🏔️', label: '100 lb lost — life-changing', test: ({delta}) => delta <= -100 },
  // Dose ladder — recognizes the titration journey
  { id: 'titrate',   icon: '📈', label: 'First dose increase',          test: ({maxDose, minDose, shots}) => shots.length >= 2 && maxDose > minDose },
  { id: 'maintain',  icon: '⚖️', label: 'Holding steady',               test: ({shots, maxDose}) => shots.length >= 8 && shots.slice(-4).every(s => s.dose === maxDose) },
  // Engagement — rewards using the tracker
  { id: 'mood7',     icon: '😊', label: 'Mood tracked 7 days',          test: ({moodCount}) => moodCount >= 7 },
  { id: 'mood30',    icon: '💭', label: 'Mood tracked 30 days',         test: ({moodCount}) => moodCount >= 30 },
  { id: 'weight10',  icon: '📊', label: '10 weights logged',            test: ({weightCount}) => weightCount >= 10 },
  { id: 'weight50',  icon: '📉', label: '50 weights logged',            test: ({weightCount}) => weightCount >= 50 },
  // Special / milestone
  { id: 'comeback',  icon: '🌅', label: 'Comeback — back on track',     test: ({comeback}) => comeback === true },
  { id: 'centurion', icon: '🛡️', label: '100 days in the app',         test: ({appDays}) => appDays >= 100 },
];

// ---------- IndexedDB helpers ----------
let _dbPromise = null;
function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    // An open that needs to upgrade is blocked until every other tab holding
    // the old version closes its connection. Without this handler the promise
    // never settles, every `await openDB()` hangs, and the app just sits there
    // — no error, no spinner, nothing to report. Tell the user what to do.
    req.onblocked = () => {
      console.warn('[mgs] database upgrade blocked by another open tab');
      toast('My GLP Shot is open in another tab. Close it so the update can finish.');
    };
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORES.shots)) {
        const s = db.createObjectStore(STORES.shots, { keyPath: 'id', autoIncrement: true });
        s.createIndex('when', 'when');
      }
      if (!db.objectStoreNames.contains(STORES.weights)) {
        const s = db.createObjectStore(STORES.weights, { keyPath: 'id', autoIncrement: true });
        s.createIndex('date', 'date');
      }
      if (!db.objectStoreNames.contains(STORES.settings)) {
        db.createObjectStore(STORES.settings, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORES.moods)) {
        db.createObjectStore(STORES.moods, { keyPath: 'date' });
      }
      if (!db.objectStoreNames.contains(STORES.supplies)) {
        db.createObjectStore(STORES.supplies, { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('measurements')) {
        db.createObjectStore('measurements', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('labs')) {
        db.createObjectStore('labs', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('expenses')) {
        db.createObjectStore('expenses', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('appetites')) {
        db.createObjectStore('appetites', { keyPath: 'date' });
      }
      if (!db.objectStoreNames.contains('foodNoise')) {
        db.createObjectStore('foodNoise', { keyPath: 'date' });
      }
      if (!db.objectStoreNames.contains('cycles')) {
        db.createObjectStore('cycles', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('medChanges')) {
        db.createObjectStore('medChanges', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('notes')) {
        db.createObjectStore('notes', { keyPath: 'date' });
      }
      if (!db.objectStoreNames.contains('symptoms')) {
        db.createObjectStore('symptoms', { keyPath: 'date' });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // The mirror of onblocked: if another tab loads a newer version, hold the
      // connection open and we become the thing blocking it. Close and stand
      // aside, then force the next openDB() to reconnect.
      db.onversionchange = () => {
        console.warn('[mgs] newer version opened elsewhere — closing this connection');
        try { db.close(); } catch (_) {}
        _dbPromise = null;
        toast('My GLP Shot updated in another tab. Reload this one to continue.');
      };
      // A connection closed underneath us (browser eviction, "clear site data")
      // must not leave a dead handle cached for the rest of the session.
      db.onclose = () => { _dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { _dbPromise = null; reject(req.error); };
  });
  return _dbPromise;
}
// The date-keyed daily stores get read several times per refresh — once per
// trend strip, again for the card, again for the notes journal. Measured over
// two years of history that was 8 full store scans and ~5,800 rows for a single
// refreshDailyCards(), with `notes` alone scanned four times.
//
// They are small, and they only change on an explicit write, so one read per
// refresh is enough. Invalidation hangs off withStore's readwrite mode rather
// than off each save/delete helper: that is the single choke point every write
// passes through, including the direct dbPut calls in applyPulledPayload, so a
// new write path cannot forget to clear it.
const DAILY_CACHED = new Set(['moods', 'appetites', 'foodNoise', 'notes', 'symptoms']);
const _dailyCache = new Map();

async function readDailySorted(store) {
  const hit = _dailyCache.get(store);
  if (hit) return hit;
  const rows = ((await dbAll(store)) || [])
    .filter(r => r && r.date)
    .sort((a, b) => a.date.localeCompare(b.date));
  _dailyCache.set(store, rows);
  return rows;
}

async function withStore(store, mode, fn) {
  if (mode === 'readwrite' && DAILY_CACHED.has(store)) _dailyCache.delete(store);
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    const req = fn(s);
    if (req && 'onsuccess' in req) {
      req.onsuccess = () => { result = req.result; };
      req.onerror = () => reject(req.error);
    }
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
// Auto-increment ids are device-local, so they can't identify a record across
// devices. Every new row in these stores gets a stable `uid` at the single point
// where rows are written — that is what lets a cloud pull merge rather than
// clobber. (newUid is a hoisted function declaration defined with the sync code.)
const UID_STORES = new Set(['shots', 'weights', 'supplies', 'measurements', 'labs', 'expenses', 'cycles', 'medChanges']);
const withUid = (store, val) =>
  (UID_STORES.has(store) && val && typeof val === 'object' && !val.uid)
    ? { ...val, uid: newUid() }
    : val;
const dbAdd = (store, val) => withStore(store, 'readwrite', s => s.add(withUid(store, val)));
const dbPut = (store, val) => withStore(store, 'readwrite', s => s.put(withUid(store, val)));
const dbDel = (store, id) => withStore(store, 'readwrite', s => s.delete(id));
const dbAll = (store) => withStore(store, 'readonly', s => s.getAll());
const dbGet = (store, key) => withStore(store, 'readonly', s => s.get(key));

// ---------- Settings ----------
let settings = { ...DEFAULT_SETTINGS };
async function loadSettings() {
  const row = await dbGet(STORES.settings, SETTINGS_KEY);
  if (row && row.value) settings = { ...DEFAULT_SETTINGS, ...row.value };
}
async function saveSettings() {
  await dbPut(STORES.settings, { key: SETTINGS_KEY, value: settings });
}

// ---------- Binary <-> base64 ----------
// `btoa(String.fromCharCode(...bytes))` spreads every byte as a function argument,
// which blows the JS call stack at ~124 KB. That silently killed cloud sync and
// doctor share links for anyone with real history — the push threw, the caller
// swallowed it, and the user was told nothing. Chunk it so size is never a cliff.
const B64_CHUNK = 0x8000; // 32 KB per call, far below any engine's argument limit
function bytesToBase64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i += B64_CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + B64_CHUNK));
  }
  return btoa(binary);
}
function base64ToBytes(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------- Payload compression ----------
// Tracker JSON is highly repetitive and compresses ~8-10x. Compressing before
// encryption keeps heavy accounts under the server's blob cap and cuts sync
// bandwidth on mobile. Blobs written before this change are plain JSON, so the
// reader sniffs for the magic header and falls back.
const GZIP_MAGIC = 'MGSZ1:';
const GZIP_SUPPORTED = typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

async function encodePayloadBytes(payload) {
  const json = JSON.stringify(payload);
  const raw = new TextEncoder().encode(json);
  if (!GZIP_SUPPORTED) return raw;
  try {
    const cs = new CompressionStream('gzip');
    const stream = new Blob([raw]).stream().pipeThrough(cs);
    const gz = new Uint8Array(await new Response(stream).arrayBuffer());
    const magic = new TextEncoder().encode(GZIP_MAGIC);
    const out = new Uint8Array(magic.length + gz.length);
    out.set(magic, 0);
    out.set(gz, magic.length);
    // Only worth it if it actually shrank (tiny payloads can grow).
    return out.length < raw.length ? out : raw;
  } catch (e) {
    console.warn('[mgs] compression unavailable, sending uncompressed:', e);
    return raw;
  }
}

async function decodePayloadBytes(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const head = new TextDecoder().decode(view.subarray(0, GZIP_MAGIC.length));
  if (head !== GZIP_MAGIC) return JSON.parse(new TextDecoder().decode(view));
  const body = view.subarray(GZIP_MAGIC.length);
  const ds = new DecompressionStream('gzip');
  const stream = new Blob([body]).stream().pipeThrough(ds);
  const raw = await new Response(stream).arrayBuffer();
  return JSON.parse(new TextDecoder().decode(raw));
}

// ---------- Utilities ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const fmtDate = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const fmtDateShort = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
// ---------- Timezone-aware date helpers ----------
// Single source of truth: getUserTz(). All "today"/"now" math passes through
// these so the app honors settings.timezone everywhere — streaks, charts,
// input defaults, and reminder fire times.
function getUserTz() {
  try {
    if (typeof settings !== 'undefined' && settings && settings.timezone) return settings.timezone;
  } catch (_) {}
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (_) { return 'UTC'; }
}
// 'en-CA' yields YYYY-MM-DD / HH:MM in ISO-friendly order regardless of locale.
function _tzParts(d, tz) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const out = {};
  for (const p of fmt.formatToParts(d)) if (p.type !== 'literal') out[p.type] = p.value;
  // Intl can yield "24" for midnight in some engines — normalize.
  if (out.hour === '24') out.hour = '00';
  return out;
}
const localISOForInput = (d = new Date()) => {
  const p = _tzParts(d, getUserTz());
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
};
const todayISODate = () => {
  const p = _tzParts(new Date(), getUserTz());
  return `${p.year}-${p.month}-${p.day}`;
};
// Wall-clock time {YYYY-MM-DD, HH, MM} in a given IANA TZ → UTC Date.
// Iteratively converges: works across DST (spring-forward / fall-back) because
// we measure the offset by formatting the guess back in tz and correcting.
function zonedWallToUtc(tz, ymd, hh, mm) {
  const wantIso = `${ymd}T${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:00`;
  const want = Date.parse(wantIso + 'Z');
  let guess = new Date(want);
  for (let i = 0; i < 3; i++) {
    const p = _tzParts(guess, tz);
    const seen = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second || '00'}Z`);
    const drift = want - seen;
    if (drift === 0) return guess;
    guess = new Date(guess.getTime() + drift);
  }
  return guess;
}
// Next UTC instant when wall-clock in user TZ equals HH:MM. Returns Date in future.
function nextDailyTriggerAt(hhmm) {
  if (!hhmm || !/^\d{2}:\d{2}$/.test(hhmm)) return null;
  const [hh, mm] = hhmm.split(':').map(Number);
  const tz = getUserTz();
  const now = new Date();
  for (let offset = 0; offset < 2; offset++) {
    const base = new Date(now.getTime() + offset * 86400000);
    const p = _tzParts(base, tz);
    const fire = zonedWallToUtc(tz, `${p.year}-${p.month}-${p.day}`, hh, mm);
    if (fire.getTime() - now.getTime() > 30000) return fire;
  }
  return null;
}
// Common TZ list for the picker. Prefer Intl.supportedValuesOf when available
// (modern browsers), else a curated list that covers the user base.
function listSupportedTimezones() {
  try {
    if (typeof Intl.supportedValuesOf === 'function') return Intl.supportedValuesOf('timeZone');
  } catch (_) {}
  return [
    'UTC',
    'America/New_York','America/Chicago','America/Denver','America/Phoenix','America/Los_Angeles',
    'America/Anchorage','Pacific/Honolulu','America/Toronto','America/Vancouver','America/Mexico_City',
    'America/Sao_Paulo','Europe/London','Europe/Dublin','Europe/Paris','Europe/Berlin','Europe/Madrid',
    'Europe/Rome','Europe/Amsterdam','Europe/Stockholm','Europe/Athens','Europe/Istanbul','Europe/Moscow',
    'Africa/Cairo','Africa/Johannesburg','Asia/Dubai','Asia/Karachi','Asia/Kolkata','Asia/Bangkok',
    'Asia/Singapore','Asia/Hong_Kong','Asia/Shanghai','Asia/Tokyo','Asia/Seoul',
    'Australia/Perth','Australia/Sydney','Pacific/Auckland',
  ];
}

// ---------- Views ----------
function showView(name) {
  $$('.view').forEach(v => v.classList.remove('active'));
  $('#view-' + name).classList.add('active');
  window.scrollTo(0, 0);
}

// Direct-manipulation tab filter. Hide/show sections by data-tab attr without
// relying on CSS class specificity (which has bitten us across SW cache + theme combos).
function setHomeTab(tab) {
  const home = document.getElementById('view-home');
  if (home) {
    home.querySelectorAll('[data-tab]').forEach(el => {
      el.style.display = (el.getAttribute('data-tab') === tab) ? '' : 'none';
    });
  }
  document.body.classList.remove('tab-home', 'tab-insights', 'tab-more');
  document.body.classList.add('tab-' + tab);
  const nav = document.getElementById('bottom-nav');
  if (nav) {
    nav.querySelectorAll('.nav-btn').forEach(b => {
      b.classList.toggle('active', b.getAttribute('data-nav-tab') === tab);
    });
  }
  window.scrollTo(0, 0);
}

// ---------- Data getters ----------
async function getShotsSorted() {
  const all = (await dbAll(STORES.shots)) || [];
  return all.sort((a, b) => new Date(b.when) - new Date(a.when));
}
// Parse a stored date that might be 'YYYY-MM-DD', 'YYYY-MM-DDTHH:MM[:SSZ]', a Date, a number, or
// the various locale formats older imports may have left behind. Returns ms since epoch (or NaN).
// Bare YYYY-MM-DD is anchored to local midnight so day-bucket comparisons line up with the user's calendar.
function parseDateFlexible(d) {
  if (d == null) return NaN;
  if (d instanceof Date) return d.getTime();
  if (typeof d === 'number') return d > 1e12 ? d : d * 1000; // accept seconds or ms
  const s = String(d).trim();
  if (!s) return NaN;
  // Pure numeric string — treat as epoch.
  if (/^\d{10,13}$/.test(s)) {
    const n = parseInt(s, 10);
    return n > 1e12 ? n : n * 1000;
  }
  // YYYY-MM-DD (bare): a calendar-day label, not an instant. Anchor to local
  // NOON, not midnight. A midnight anchor sits within a few hours of the day
  // boundary, so re-reading it in any other timezone — the user's configured
  // one, or their device's after they travel — lands on the previous or next
  // day. Noon has ~12 hours of slack in both directions, which no real offset
  // crosses, so the day label survives the round trip.
  const ymd = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (ymd) {
    const t = new Date(+ymd[1], +ymd[2] - 1, +ymd[3], 12, 0, 0).getTime();
    return Number.isFinite(t) ? t : NaN;
  }
  // M/D/YYYY or D/M/YYYY (best-effort: assume month-first US format, then fall through to Date.parse).
  const slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (slash) {
    let yr = +slash[3]; if (yr < 100) yr += 2000;
    const t = new Date(yr, +slash[1] - 1, +slash[2]).getTime();
    if (Number.isFinite(t)) return t;
  }
  // Final fallback — let the engine try, then re-anchor to local midnight so cutoff
  // comparisons line up with the user's calendar (an ISO-with-Z parsed in UTC could
  // otherwise read as the previous day for users west of UTC).
  const tParsed = Date.parse(s);
  if (!Number.isFinite(tParsed)) return NaN;
  const dParsed = new Date(tParsed);
  return new Date(dParsed.getFullYear(), dParsed.getMonth(), dParsed.getDate()).getTime();
}

// Convert any flexible date input to a canonical local YYYY-MM-DD string.
// Returns null if unparseable.
function toCanonicalDate(d) {
  // A bare YYYY-MM-DD is already a calendar day — it has no timezone to
  // interpret. Round-tripping it through a timestamp shifts it: anchoring at
  // local noon then reformatting in a zone 14 hours away (Pacific/Kiritimati,
  // say) lands on the next day. Return it as-is.
  if (typeof d === 'string') {
    const bare = d.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (bare) return `${bare[1]}-${bare[2]}-${bare[3]}`;
  }
  const t = parseDateFlexible(d);
  if (!Number.isFinite(t)) return null;
  // Bucket by the user's configured timezone, the same basis todayISODate()
  // uses. These used to disagree — this read the device clock while "today"
  // read the setting — so anyone whose device timezone differed from their
  // setting could log an entry and have it filed under a different day than
  // the one the app was calling today.
  const p = _tzParts(new Date(t), getUserTz());
  return `${p.year}-${p.month}-${p.day}`;
}

async function getWeightsSorted() {
  const all = (await dbAll(STORES.weights)) || [];
  return all.sort((a, b) => parseDateFlexible(a.date) - parseDateFlexible(b.date));
}

// One-time normalizer: rewrite any weights row whose .date isn't already canonical
// local YYYY-MM-DD. Idempotent — re-runs on every boot but only writes when needed.
// This unblocks users who have legacy entries from CSV imports or sync round-trips
// that left dates in formats Date.parse interpreted as UTC, drifting them across
// the local-midnight cutoff used by the range filter.
let _weightDateMigrationDone = false;
async function migrateWeightDatesToCanonical() {
  if (_weightDateMigrationDone) return 0;
  _weightDateMigrationDone = true;
  const all = (await dbAll(STORES.weights)) || [];
  let fixed = 0;
  for (const w of all) {
    const canon = toCanonicalDate(w.date);
    if (canon && canon !== w.date) {
      await dbPut(STORES.weights, { ...w, date: canon });
      fixed++;
    }
  }
  if (fixed) console.log(`[weight-migration] normalized ${fixed} of ${all.length} weight dates to canonical YYYY-MM-DD`);
  return fixed;
}

// ---------- Countdown / next shot ----------
function nextShotDate(lastWhen) {
  if (!lastWhen) return null;
  const d = new Date(lastWhen);
  d.setDate(d.getDate() + (settings.cadenceDays || 7));
  return d;
}
function renderCountdown(shots) {
  const card = document.querySelector('.countdown-card');
  const val = $('#countdown-value');
  const sub = $('#countdown-sub');
  if (!shots.length) {
    val.textContent = 'Log first';
    sub.textContent = 'Tap below to start';
    card.classList.remove('due');
    return;
  }
  const last = shots[0];
  const next = nextShotDate(last.when);
  const diff = next - new Date();
  if (diff <= 0) {
    const overdueMs = -diff;
    const days = Math.floor(overdueMs / 86400000);
    val.textContent = days > 0 ? `${days}d overdue` : 'Due now';
    sub.textContent = `Last: ${fmtDate(last.when)} · ${last.dose}mg`;
    card.classList.add('due');
    updateAppBadge(1);
  } else {
    const days = Math.floor(diff / 86400000);
    const hours = Math.floor((diff % 86400000) / 3600000);
    val.textContent = days > 0 ? `${days}d ${hours}h` : `${hours}h`;
    sub.textContent = `Due ${next.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
    card.classList.remove('due');
    updateAppBadge(0);
  }
}

// PWA Badge API — show a "1" on the installed-app icon when a shot is overdue.
// Silently no-ops on browsers that don't support it (Safari iOS as of 17.x).
function updateAppBadge(count) {
  try {
    if (count > 0 && 'setAppBadge' in navigator) {
      navigator.setAppBadge(count).catch(() => {});
    } else if ('clearAppBadge' in navigator) {
      navigator.clearAppBadge().catch(() => {});
    }
  } catch (e) { /* best-effort */ }
}

// ---------- Shot list rendering ----------
function shotItem(shot) {
  const li = document.createElement('li');
  li.dataset.id = shot.id;
  // Color intensity by dose: 1=<5, 2=5–7.4, 3=7.5–9.9, 4=10+
  let intensity = 1;
  if (shot.dose >= 10) intensity = 4;
  else if (shot.dose >= 7.5) intensity = 3;
  else if (shot.dose >= 5) intensity = 2;
  li.dataset.intensity = intensity;
  li.innerHTML = `
    <div>
      <div class="dose">${escapeHTML(shot.dose)} mg <span class="muted small">· ${escapeHTML(shot.med)}</span></div>
      <div class="meta">${escapeHTML(fmtDate(shot.when))}${shot.site ? ' · ' + escapeHTML(shot.site) : ''}</div>
    </div>
    <span class="meta">›</span>
  `;
  li.addEventListener('click', () => openShotDialog(shot));
  return li;
}
function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
async function renderShots() {
  const shots = await getShotsSorted();
  const weights = await getWeightsSorted();
  const recent = $('#recent-shots');
  const full = $('#full-history');
  recent.innerHTML = '';
  full.innerHTML = '';
  if (!shots.length) {
    $('#empty-shots').classList.remove('hidden');
  } else {
    $('#empty-shots').classList.add('hidden');
    shots.slice(0, 5).forEach(s => recent.appendChild(shotItem(s)));
    shots.forEach(s => full.appendChild(shotItem(s)));
  }
  renderCountdown(shots);
  renderCountdownRing(shots);
  // Deliberately not awaited: this now fetches the chart library on first use,
  // and the rest of the shot list should not wait on a network round-trip.
  renderLevelChart(shots).catch(e => console.warn('level chart failed', e));
  renderBodyDiagram(shots);
  renderDoseTimeline(shots);
  await renderSideEffectsSummary(shots);
  await renderHero(shots, weights);
  await renderBadges(shots, weights);
  try { await renderSupplies(shots); } catch (e) {}
  try { await renderCost(weights); } catch (e) {}
  try { await renderPlateau(weights, shots); } catch (e) {}
  try { await renderInsights(); } catch (e) {}
  try { await evaluateGuidanceTriggers(); } catch (e) {}
  return shots;
}

// ---------- Site rotation suggestion ----------
function suggestSite(shots) {
  const sites = ['Abdomen — Left', 'Abdomen — Right', 'Thigh — Left', 'Thigh — Right', 'Upper arm — Left', 'Upper arm — Right'];
  const used = {};
  for (const s of shots) {
    if (s.site && !(s.site in used)) used[s.site] = new Date(s.when);
  }
  let best = sites[0], bestTime = Infinity;
  for (const site of sites) {
    const t = used[site] ? used[site].getTime() : 0;
    if (t < bestTime) { bestTime = t; best = site; }
  }
  return best;
}

// ---------- Shot dialog ----------
function refreshCustomSiteOptgroup() {
  const grp = $('#shot-site-custom-group');
  if (!grp) return;
  const sel = $('#shot-site');
  // Strip prior options on re-open.
  Array.from(grp.querySelectorAll('option')).forEach(o => o.remove());
  const list = (settings.customSites || []).slice(-10);
  if (!list.length) { grp.hidden = true; return; }
  grp.hidden = false;
  for (const name of list) {
    const o = document.createElement('option');
    o.textContent = name;
    o.value = name;
    grp.appendChild(o);
  }
  sel.appendChild(grp);  // ensure it stays before __custom even if HTML order shifts
}

function setCustomRowVisible(visible) {
  const row = $('#shot-site-custom-row');
  if (!row) return;
  row.classList.toggle('hidden', !visible);
}

async function openShotDialog(shot) {
  const isEdit = !!shot;
  $('#shot-form-title').textContent = isEdit ? 'Edit Shot' : 'Log Shot';
  $('#shot-id').value = isEdit ? shot.id : '';
  $('#shot-med').value = shot ? shot.med : settings.medication;
  $('#shot-dose-amt').value = shot ? shot.dose : settings.defaultDose;
  renderDoseChips('#shot-dose-chips', '#shot-dose-amt', $('#shot-med').value);
  $('#shot-when').value = shot ? localISOForInput(new Date(shot.when)) : localISOForInput();
  refreshCustomSiteOptgroup();
  const initialSite = shot ? (shot.site || '') : (window._preferredNextSite || '');
  // If the saved site is neither a canonical option nor a remembered custom one, treat it as a freeform custom name.
  const sel = $('#shot-site');
  const knownInDropdown = !!initialSite && Array.from(sel.querySelectorAll('option')).some(o => o.value === initialSite || o.textContent === initialSite);
  if (initialSite && !knownInDropdown) {
    sel.value = '__custom';
    $('#shot-site-custom').value = initialSite;
    setCustomRowVisible(true);
  } else {
    sel.value = initialSite;
    $('#shot-site-custom').value = '';
    setCustomRowVisible(false);
  }
  $('#shot-notes').value = shot ? (shot.notes || '') : '';
  $('#shot-delete').classList.toggle('hidden', !isEdit);
  writeSideEffects(shot ? shot.sideEffects : null);
  if (!isEdit) window._preferredNextSite = null;

  const shots = await getShotsSorted();
  if (!isEdit) {
    const suggest = suggestSite(shots);
    $('#site-suggestion').textContent = `Suggested next site: ${suggest}`;
    if (!sel.value) sel.value = suggest;
  } else {
    $('#site-suggestion').textContent = '';
  }

  $('#shot-dialog').showModal();
}

// Critical UI listeners that must be attached even if IndexedDB / settings / SW init fail or hang.
// Wire these synchronously at script load time so bottom-nav and modal closes always work.
// Auth form state (used by both wireCriticalUI and the auth form handler).
let _authMode = 'signup';
function setAuthMode(m) {
  _authMode = m;
  document.querySelectorAll('#view-auth .auth-toggle-btn').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-auth-mode') === m);
  });
  const submit = document.getElementById('auth-submit');
  const help = document.getElementById('auth-help');
  const pw = document.getElementById('auth-pw');
  if (m === 'signup') {
    if (submit) submit.textContent = 'Create account & start free trial';
    if (help) help.textContent = 'Use a strong password. We encrypt your data with it before it ever leaves your device — if you forget it, your cloud copy is gone (data on each device is preserved).';
    if (pw) { pw.setAttribute('autocomplete', 'new-password'); pw.setAttribute('minlength', '8'); }
  } else {
    if (submit) submit.textContent = 'Sign in';
    if (help) help.textContent = 'Welcome back. Sign in to sync this device with your data.';
    if (pw) { pw.setAttribute('autocomplete', 'current-password'); pw.removeAttribute('minlength'); }
  }
  const err = document.getElementById('auth-err');
  if (err) err.textContent = '';
}

function wireCriticalUI() {
  // Bottom nav
  document.querySelectorAll('#bottom-nav .nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.getAttribute('data-nav-tab');
      track('nav_tab_click', { tab });
      if (tab === 'settings') {
        showView('settings');
        document.querySelectorAll('#bottom-nav .nav-btn').forEach(b => b.classList.toggle('active', b === btn));
      } else {
        showView('home');
        setHomeTab(tab);
      }
    });
  });
  setHomeTab('home');
  // Back buttons in sub-views
  document.querySelectorAll('[data-back]').forEach(b => {
    b.addEventListener('click', () => { showView('home'); setHomeTab('home'); });
  });
  // Manual install-prompt trigger from Settings — wire synchronously so it works
  // even if setupInstallBanner hasn't run yet.
  const showInstall = document.getElementById('show-install-prompt');
  if (showInstall) {
    showInstall.addEventListener('click', () => {
      if (typeof isStandalone === 'function' && isStandalone()) {
        alert('Already installed! 🎉');
        return;
      }
      if (typeof showInstallDialog === 'function') showInstallDialog();
    });
  }
  const dismissInstall = document.getElementById('install-dismiss');
  if (dismissInstall) {
    dismissInstall.addEventListener('click', () => {
      try { localStorage.setItem('installDismissedAt', String(Date.now())); } catch (_) {}
      const d = document.getElementById('install-dialog');
      if (d && d.open) d.close();
    });
  }

  // Auth gate — show by default. tryRestoreAccount can hide it if a session restores.
  // Doing this synchronously in wireCriticalUI guarantees the user always sees the
  // sign-in form even if every other init step fails.
  // Honor the "skip for now" local-only mode: if the user previously chose to try without an account,
  // boot straight into the home view instead of forcing the auth gate.
  const _skippedAuth = (() => { try { return localStorage.getItem('mglp_skip_auth') === '1'; } catch (e) { return false; } })();
  if (!_skippedAuth) {
    document.body.classList.add('auth-active');
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    const authViewEl = document.getElementById('view-auth');
    if (authViewEl) authViewEl.classList.add('active');
  } else {
    document.body.classList.remove('auth-active');
    const authViewEl = document.getElementById('view-auth');
    if (authViewEl) authViewEl.classList.remove('active');
    const homeEl = document.getElementById('view-home');
    if (homeEl) homeEl.classList.add('active');
  }

  document.querySelectorAll('#view-auth .auth-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => setAuthMode(btn.getAttribute('data-auth-mode')));
  });
  setAuthMode('signup');
  const authForgot = document.getElementById('auth-forgot');
  if (authForgot) {
    authForgot.addEventListener('click', (e) => {
      e.preventDefault();
      const dlg = document.getElementById('forgot-dialog');
      if (dlg && dlg.showModal) dlg.showModal();
    });
  }
  const authSkip = document.getElementById('auth-skip-link');
  if (authSkip) {
    authSkip.addEventListener('click', (e) => {
      e.preventDefault();
      try { localStorage.setItem('mglp_skip_auth', '1'); } catch (err) {}
      try { track('tried_without_account'); } catch (err) {}
      document.body.classList.remove('auth-active');
      const av = document.getElementById('view-auth');
      if (av) av.classList.remove('active');
      const home = document.getElementById('view-home');
      if (home) home.classList.add('active');
      if (typeof maybeAutoShowInstall === 'function') { try { maybeAutoShowInstall(); } catch (err) {} }
    });
  }
  async function handleAuthSubmit() {
    const email = (document.getElementById('auth-email') || {}).value || '';
    const pw = (document.getElementById('auth-pw') || {}).value || '';
    const errEl = document.getElementById('auth-err');
    const submit = document.getElementById('auth-submit');
    if (errEl) errEl.textContent = '';
    if (!email.trim() || !pw) {
      if (errEl) errEl.textContent = 'Email and password are required.';
      return;
    }
    if (_authMode === 'signup' && pw.length < 8) {
      if (errEl) errEl.textContent = 'Password must be at least 8 characters.';
      return;
    }
    if (submit) submit.disabled = true;
    const original = submit ? submit.textContent : '';
    if (submit) submit.textContent = _authMode === 'signup' ? 'Working…' : 'Signing in…';
    try {
      // Self-contained: derive auth token + AES key inline so we don't depend on accountSignup/Login being in scope.
      const cleanEmail = email.trim().toLowerCase();
      const enc = new TextEncoder();
      const saltBuf = await crypto.subtle.digest('SHA-256', enc.encode('myglpshot-v1:' + cleanEmail));
      const baseKey = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
      const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt: saltBuf, iterations: 600000, hash: 'SHA-256' },
        baseKey, 512
      );
      const buf = new Uint8Array(bits);
      const aesKey = await crypto.subtle.importKey('raw', buf.slice(0, 32), 'AES-GCM', true, ['encrypt', 'decrypt']);
      const authToken = Array.from(buf.slice(32, 64)).map(b => b.toString(16).padStart(2, '0')).join('');
      // Smart fallback: signup with existing email → auto-try login; login with no account → auto-try signup.
      // Same email/password works either way — server uses authToken (PBKDF2 of pw+email) so wrong pw on existing account fails both paths.
      async function callAuth(mode) {
        const payload = { email: cleanEmail, authToken };
        // Only ever sent on signup — attribution is a property of how someone
        // arrived, and re-sending it on every login would just overwrite the
        // original answer with wherever they happened to be today.
        if (mode === 'signup') {
          const a = getAttribution();
          if (a) payload.attribution = a;
        }
        const resp = await fetch(mode === 'signup' ? '/api/signup' : '/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          credentials: 'include',
        });
        let body = {}; try { body = await resp.json(); } catch (_) {}
        return { resp, body };
      }
      let { resp: r, body: j } = await callAuth(_authMode);
      let actualMode = _authMode;
      if (!r.ok && _authMode === 'signup' && j.error === 'email_in_use') {
        // Account already exists — silently log in instead.
        track('signup_fallback_to_login');
        ({ resp: r, body: j } = await callAuth('login'));
        actualMode = 'login';
      } else if (!r.ok && _authMode === 'login' && j.error === 'invalid_credentials') {
        // Could be no-account-yet OR wrong password. Try signup.
        track('login_fallback_to_signup');
        const sg = await callAuth('signup');
        if (sg.resp.ok) { r = sg.resp; j = sg.body; actualMode = 'signup'; }
        else if (sg.body.error === 'email_in_use') {
          // Account exists; password was wrong.
          throw new Error('Email or password is incorrect. Try again or use "Forgot password".');
        } else {
          throw new Error(sg.body.message || 'Could not sign up.');
        }
      }
      if (!r.ok) {
        throw new Error(j.message || `${actualMode === 'signup' ? 'Signup' : 'Login'} failed (${r.status}).`);
      }
      // Persist session token + AES key (NOT password).
      try {
        localStorage.setItem('mgs_session_token', j.token);
        const raw = await crypto.subtle.exportKey('raw', aesKey);
        const b64 = bytesToBase64(raw);
        localStorage.setItem('account.cred', JSON.stringify({ email: cleanEmail, k: b64, v: 2 }));
      } catch (_) {}
      track(_authMode === 'signup' ? 'signup_success' : 'login_success');
      // Reload to fully bootstrap the signed-in state. This is the simplest, most reliable
      // way to pick up the new session everywhere without juggling state.
      window.location.reload();
    } catch (ex) {
      if (errEl) errEl.textContent = (ex && ex.message) || 'Something went wrong.';
      track(_authMode === 'signup' ? 'signup_failed' : 'login_failed');
      console.error('[mgs] auth submit failed:', ex);
      if (submit) {
        submit.disabled = false;
        submit.textContent = original || (_authMode === 'signup' ? 'Create account & start free trial' : 'Sign in');
      }
    }
  }

  const authForm = document.getElementById('auth-form');
  if (authForm) {
    authForm.addEventListener('submit', (e) => {
      e.preventDefault();
      handleAuthSubmit();
    });
  }
  const authSubmitBtn = document.getElementById('auth-submit');
  if (authSubmitBtn) {
    // Belt-and-suspenders: also bind click directly (some iOS Safari builds drop submit events).
    authSubmitBtn.addEventListener('click', (e) => {
      e.preventDefault();
      handleAuthSubmit();
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wireCriticalUI, { once: true });
} else {
  wireCriticalUI();
}

// Kick off session restore as early as possible (independent of the heavy DOMContentLoaded
// init pipeline) so a user with an existing cookie sees the home view in <1s.
function bootstrapSession() {
  if (typeof tryRestoreAccount !== 'function') {
    setTimeout(bootstrapSession, 50);
    return;
  }
  tryRestoreAccount()
    .then(() => onAccountChanged())
    .catch((e) => { console.error('[mgs] session restore failed:', e); onAccountChanged(); });
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrapSession, { once: true });
} else {
  bootstrapSession();
}

document.addEventListener('DOMContentLoaded', async () => {
  // Surround everything async in try/catch so a single failure doesn't kill all later listener bindings.
  try { await loadSettings(); } catch (e) { console.error('loadSettings failed:', e); }
  try { applySettingsToInputs(); } catch (e) { console.error(e); }
  try { await renderShots(); } catch (e) { console.error(e); }
  try { await migrateWeightDatesToCanonical(); } catch (e) { console.error('weight migration failed:', e); }
  try { await renderWeights(); } catch (e) { console.error(e); }
  try { setInterval(async () => renderCountdown(await getShotsSorted()), 60000); } catch (e) {}
  try { handleReminderDeepLink(); } catch (e) { console.error('reminder deep link failed:', e); }

  // (Listeners that don't depend on IDB/data — attach defensively.)
  const logBtn = $('#log-shot-btn');
  if (logBtn) logBtn.addEventListener('click', () => openShotDialog());
  const viewAll = $('#view-all-history');
  if (viewAll) viewAll.addEventListener('click', (e) => { e.preventDefault(); showView('history'); });

  // Admin: lazy-load iframe on first open. Same-origin → session cookie
  // travels automatically; admin SPA detects the session and skips its own
  // sign-in. Reload on each open so changes from prior session aren't stale.
  // Belt-and-suspenders gate: even if a non-admin somehow reaches the button,
  // hit /api/me first; the server will not return isAdmin=true for them.
  // (The card is hidden client-side too; this is defense in depth.)
  const openAdmin = $('#open-admin');
  if (openAdmin) openAdmin.addEventListener('click', async () => {
    let allowed = !!(account && account.user && account.user.isAdmin);
    if (!allowed) {
      try {
        const me = await accountMe();
        allowed = !!(me && me.isAdmin);
        if (me) account.user = me;
      } catch (_) {}
    }
    if (!allowed) {
      alert('Admin access is required to open this section.');
      const card = $('#admin-card'); if (card) card.classList.add('hidden');
      return;
    }
    const frame = $('#admin-frame');
    if (frame) frame.src = '/admin/?embedded=1&t=' + Date.now();
    showView('admin');
  });
  const adminRefresh = $('#admin-refresh');
  if (adminRefresh) adminRefresh.addEventListener('click', () => {
    const frame = $('#admin-frame');
    if (!frame) return;
    // Re-set src with a fresh cache buster — works across browsers without
    // poking into iframe.contentWindow (which can throw under strict CSP).
    frame.src = '/admin/?embedded=1&t=' + Date.now();
  });

  $('#shot-cancel').addEventListener('click', () => $('#shot-dialog').close());
  // Show / hide the custom-site text input based on dropdown selection.
  $('#shot-site').addEventListener('change', () => {
    const v = $('#shot-site').value;
    setCustomRowVisible(v === '__custom');
    if (v === '__custom') $('#shot-site-custom').focus();
  });
  $('#shot-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const id = $('#shot-id').value;
      const whenStr = $('#shot-when').value;
      const whenDate = whenStr ? new Date(whenStr) : null;
      if (!whenDate || isNaN(whenDate.getTime())) {
        alert('Please pick a valid date and time for this shot.');
        return;
      }
      const dose = parseFloat($('#shot-dose-amt').value);
      if (!Number.isFinite(dose) || dose <= 0) {
        alert('Please enter a dose in mg (e.g. 5).');
        return;
      }
      // Resolve site: '__custom' selection means use the freeform input.
      let resolvedSite = $('#shot-site').value || null;
      if (resolvedSite === '__custom') {
        resolvedSite = ($('#shot-site-custom').value || '').trim().slice(0, 60) || null;
        if (!resolvedSite) {
          alert('Please enter a name for the custom site (or pick a different site).');
          return;
        }
        // Remember up to 10 most-recent custom names so the user can re-select them next time.
        const existing = settings.customSites || [];
        const dedup = existing.filter(n => n !== resolvedSite);
        dedup.push(resolvedSite);
        settings.customSites = dedup.slice(-10);
        await saveSettings();
      }
      // Snapshot half-life on new shots only; preserve the original on edits.
      let snapshotHalfLife = settings.halfLifeDays || null;
      if (id) {
        try {
          const existing = await dbGet(STORES.shots, parseInt(id, 10));
          if (existing && existing.halfLifeDays) snapshotHalfLife = existing.halfLifeDays;
        } catch (_) {}
      }
      const data = {
        med: $('#shot-med').value.trim() || 'Tirzepatide',
        dose,
        when: whenDate.toISOString(),
        site: resolvedSite,
        notes: $('#shot-notes').value.trim() || null,
        sideEffects: readSideEffects(),
        halfLifeDays: snapshotHalfLife,
      };
      if (id) data.id = parseInt(id, 10);
      await dbPut(STORES.shots, data);
      await ensurePersisted();
      $('#shot-dialog').close();
      // Re-render every dependent surface (charts, hero stats, badges, heatmap, body diagram, etc.) so backfilled shots immediately show.
      await renderShots();
      maybeScheduleNotification();
      markSyncDirty();
      track(id ? 'shot_edited' : 'shot_logged', { has_site: !!data.site, has_notes: !!data.notes, backdate_days: Math.max(0, Math.round((Date.now() - whenDate.getTime()) / 86400000)) });
    } catch (ex) {
      console.error('[mgs] shot save failed:', ex);
      alert('Could not save this shot: ' + (ex && ex.message ? ex.message : 'unknown error') + '. Please try again or screenshot this and send it.');
    }
  });
  $('#shot-delete').addEventListener('click', async () => {
    const id = parseInt($('#shot-id').value, 10);
    if (!id) return;
    if (!confirm('Delete this shot?')) return;
    await dbDel(STORES.shots, id);
    $('#shot-dialog').close();
    await renderShots();
    markSyncDirty();
  });

  $('#add-weight-btn').addEventListener('click', async () => {
    $('#weight-val').value = '';
    $('#weight-unit').value = (await getLastWeightUnit()) || 'lb';
    $('#weight-date').value = todayISODate();
    $('#weight-dialog').showModal();
  });
  $('#weight-cancel').addEventListener('click', () => $('#weight-dialog').close());
  $('#weight-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    await dbAdd(STORES.weights, {
      value: parseFloat($('#weight-val').value),
      unit: $('#weight-unit').value,
      date: $('#weight-date').value,
    });
    await ensurePersisted();
    $('#weight-dialog').close();
    await renderWeights();
    markSyncDirty();
    track('weight_logged', { unit: $('#weight-unit').value });
  });

  $('#set-med').addEventListener('change', async (e) => {
    settings.medication = e.target.value.trim() || 'Tirzepatide';
    // Keep the preset dropdown in sync if the typed name matches a known preset.
    const matched = findMedPreset(settings.medication);
    if (matched) $('#set-med-preset').value = matched.id;
    else $('#set-med-preset').value = 'custom';
    renderDoseChips('#set-dose-chips', '#set-dose', settings.medication);
    await saveSettings(); markSyncDirty();
  });
  $('#set-med-preset').addEventListener('change', async (e) => {
    const id = e.target.value;
    const preset = MED_PRESETS.find(p => p.id === id);
    if (!preset) return;  // 'custom' — leave the user's values alone
    // Apply preset defaults; the user can still override any field.
    settings.medication = preset.name;
    settings.halfLifeDays = preset.halfLifeDays;
    settings.defaultDose = preset.defaultDose;
    settings.cadenceDays = preset.cadenceDays;
    $('#set-med').value = preset.name;
    $('#set-halflife').value = preset.halfLifeDays;
    $('#set-dose').value = preset.defaultDose;
    renderDoseChips('#set-dose-chips', '#set-dose', preset.name);
    $('#set-cadence').value = preset.cadenceDays;
    await saveSettings();
    markSyncDirty();
    await renderShots();
  });
  $('#set-dose').addEventListener('change', async (e) => { settings.defaultDose = parseFloat(e.target.value) || 0; await saveSettings(); markSyncDirty(); });
  $('#set-cadence').addEventListener('change', async (e) => { settings.cadenceDays = parseInt(e.target.value, 10) || 7; await saveSettings(); markSyncDirty(); await renderShots(); });
  $('#set-halflife').addEventListener('change', async (e) => { settings.halfLifeDays = parseFloat(e.target.value) || 5; await saveSettings(); markSyncDirty(); await renderShots(); });
  $('#set-notify').addEventListener('change', async (e) => {
    if (e.target.checked) {
      const perm = await Notification.requestPermission();
      settings.notify = perm === 'granted';
      e.target.checked = settings.notify;
      // Register for push where we can. Failing here is not fatal — the in-page
      // timer still works while the app is open — so it must not block the
      // toggle, only downgrade what the status line promises.
      if (settings.notify && PUSH_SUPPORTED && account.user) {
        try { await enablePushReminders(); }
        catch (err) { console.warn('[mgs] push enable failed:', err); }
      }
    } else {
      settings.notify = false;
      try { await disablePushReminders(); } catch (_) {}
    }
    await saveSettings();
    markSyncDirty();
    updateNotifyStatus();
    maybeScheduleNotification();
  });
  $('#set-lead').addEventListener('change', async (e) => {
    settings.notifyLeadMinutes = parseInt(e.target.value, 10) || 0;
    await saveSettings();
    markSyncDirty();
    maybeScheduleNotification();
  });
  $('#set-theme').addEventListener('change', async (e) => {
    settings.theme = e.target.value;
    await saveSettings();
    markSyncDirty();
    applyTheme();
  });
  $('#test-notify').addEventListener('click', sendTestNotification);

  // Timezone picker — changing TZ rewrites "today" everywhere, so we re-render
  // shots/weights/moods and re-plan reminders.
  const tzSel = $('#set-timezone');
  if (tzSel) {
    populateTimezoneOptions(tzSel);
    tzSel.addEventListener('change', async (e) => {
      settings.timezone = e.target.value || null;
      await saveSettings();
      markSyncDirty();
      updateTimezoneStatus();
      try { await renderShots(); } catch (_) {}
      try { await renderMood(); } catch (_) {}
      try { await renderAppetite(); } catch (_) {}
      maybeScheduleNotification();
    });
  }

  // Daily reminder rows are built dynamically so DAILY_REMINDERS is the only
  // place that knows the section list.
  renderDailyReminderRows();
  const dailyList = $('#daily-reminders-list');
  if (dailyList) {
    dailyList.addEventListener('change', async (e) => {
      const t = e.target;
      const key = t.getAttribute('data-rkey');
      if (!key) return;
      const cfg = settings.dailyReminders = { ...(settings.dailyReminders || {}) };
      const entry = cfg[key] = { ...(cfg[key] || { enabled: false, time: '08:00' }) };
      if (t.matches('input[type="checkbox"]')) {
        if (t.checked) {
          // Enabling any daily reminder requires notification permission once.
          if (typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
            const perm = await Notification.requestPermission();
            if (perm !== 'granted') { t.checked = false; return; }
          }
          entry.enabled = true;
        } else {
          entry.enabled = false;
        }
      } else if (t.matches('input[type="time"]')) {
        entry.time = t.value || '08:00';
      }
      await saveSettings();
      markSyncDirty();
      maybeScheduleNotification();
    });
  }

  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  }
  window.addEventListener('pageshow', () => maybeScheduleNotification());

  $('#set-start-weight').addEventListener('change', async (e) => { settings.startWeight = e.target.value ? parseFloat(e.target.value) : null; await saveSettings(); markSyncDirty(); await renderShots(); });
  $('#set-goal-weight').addEventListener('change', async (e) => { settings.goalWeight = e.target.value ? parseFloat(e.target.value) : null; await saveSettings(); markSyncDirty(); await renderShots(); });
  $('#set-maintenance')?.addEventListener('change', async (e) => {
    settings.maintenanceMode = !!e.target.checked;
    await saveSettings();
    markSyncDirty();
    await renderShots();
  });

  // Explicit Save buttons (medication, weight goals, reminders).
  // Auto-save on `change` already runs; these buttons re-read the inputs (in case user typed without blurring),
  // immediately push to the account if signed in, and show ✓ Saved confirmation.
  async function flushSaveGroup(group) {
    if (group === 'medication') {
      settings.medication = ($('#set-med').value || '').trim() || 'Tirzepatide';
      settings.defaultDose = parseFloat($('#set-dose').value) || 0;
      settings.cadenceDays = parseInt($('#set-cadence').value, 10) || 7;
      settings.halfLifeDays = parseFloat($('#set-halflife').value) || 5;
    } else if (group === 'weight') {
      settings.startWeight = $('#set-start-weight').value ? parseFloat($('#set-start-weight').value) : null;
      settings.goalWeight = $('#set-goal-weight').value ? parseFloat($('#set-goal-weight').value) : null;
    } else if (group === 'reminders') {
      settings.notifyLeadMinutes = parseInt($('#set-lead').value, 10) || 0;
    }
    await saveSettings();
    if (group === 'medication' || group === 'weight') await renderShots();
    if (group === 'reminders') maybeScheduleNotification();
  }
  $$('[data-save-group]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const group = btn.dataset.saveGroup;
      const status = document.querySelector(`[data-save-status="${group}"]`);
      btn.disabled = true;
      const origText = btn.textContent;
      btn.textContent = 'Saving…';
      try {
        await flushSaveGroup(group);
        if (account.user && account.encryptionKey) {
          try { await accountSyncPush(); status.textContent = '✓ Saved & synced'; }
          catch (e) { status.textContent = '✓ Saved locally (sync will retry)'; markSyncDirty(); }
        } else {
          status.textContent = '✓ Saved on this device';
        }
        status.classList.add('ok');
        setTimeout(() => { status.textContent = ''; status.classList.remove('ok'); }, 3500);
      } catch (e) {
        status.textContent = 'Save failed: ' + (e && e.message ? e.message : 'unknown');
      } finally {
        btn.disabled = false;
        btn.textContent = origText;
      }
    });
  });

  // Mood picker. Scoped to the home card — the catch-up dialog reuses .mood-btn
  // for its styling and must not inherit the today-only click handler.
  $$('#mood-picker .mood-btn').forEach(btn => btn.addEventListener('click', async () => {
    const v = parseInt(btn.dataset.mood, 10);
    await saveMood(todayISODate(), v);
    delete $('#mood-card').dataset.editing;
    await renderMood();
    markSyncDirty();
    track('mood_logged', { value: v });
  }));
  $('#mood-change').addEventListener('click', (e) => {
    e.preventDefault();
    $('#mood-card').dataset.editing = '1';
    renderMood();
  });

  renderSideEffectsForm();

  $('#export-btn').addEventListener('click', exportData);
  $('#import-btn').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', importData);
  const smartBtn = $('#smart-import-btn');
  if (smartBtn) {
    smartBtn.addEventListener('click', () => $('#smart-import-file').click());
    $('#smart-import-file').addEventListener('change', smartImport);
  }
  $('#wipe-btn').addEventListener('click', wipeAll);
  const delAcctBtn = $('#delete-account-btn');
  if (delAcctBtn) {
    delAcctBtn.addEventListener('click', async () => {
      if (!account.user) {
        alert('Not signed in.');
        return;
      }
      const typed = prompt('This permanently deletes your account, cancels any active subscription, and erases your cloud copy. Type DELETE to confirm:');
      if (typed !== 'DELETE') return;
      try {
        const r = await accountFetch('me', { method: 'DELETE' });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j.message || `Failed (${r.status})`);
        }
        clearRememberedSignIn();
        alert('Account deleted. Local data on this device is still here — use "Erase all data on this device" to wipe it too.');
        account = { user: null, encryptionKey: null };
        await onAccountChanged();
      } catch (e) {
        alert('Could not delete account: ' + (e.message || e));
      }
    });
  }
  // Surface app version (and SW cache name) in Settings + footer.
  (async function showVersion() {
    let swInfo = '';
    try {
      if ('caches' in window) {
        const keys = await caches.keys();
        const mglp = keys.find(k => k.startsWith('mglp-'));
        if (mglp) swInfo = ' · sw ' + mglp;
      }
    } catch (_) {}
    const line = $('#app-version-line');
    if (line) line.textContent = `App v${APP_VERSION}${swInfo}`;
    const foot = $('#app-version-footer');
    if (foot) foot.textContent = `v${APP_VERSION}`;
  })();

  $('#force-update-btn').addEventListener('click', async () => {
    try {
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
      }
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(r => r.unregister()));
      }
    } catch (e) { /* ignore */ }
    window.location.reload();
  });
  $('#download-ics').addEventListener('click', downloadICS);

  setupInstallBanner();
  registerSW();
  checkForStaleBundle();
  await ensurePersisted();
  updateBackupLabel();
  maybeScheduleNotification();
  initSyncUI();
  await renderMood();
  await renderAppetite();
  setupAppetiteUI();
  await renderFoodNoise();
  setupFoodNoiseUI();
  await renderNote();
  setupNoteUI();
  setupCatchupUI();
  setupSymptomsUI();
  await renderSymptomsCard();
  setupCycleUI();
  await renderCycleCard();
  setupMixingCalcUI();
  applyMixingCalcVisibility();
  setupMedChangeUI();
  await renderMedChanges();
  $('#guidance-close')?.addEventListener('click', () => $('#guidance-dialog').close());
  $('#guidance-done')?.addEventListener('click', () => $('#guidance-dialog').close());
  await renderInsights();
  applyTimeOfDayGradient();
  setInterval(applyTimeOfDayGradient, 5 * 60 * 1000);
  setupPullToRefresh();
  setupAccountUI();
  setupReconCalc();
  setupDoseChips();
  setupSupplyUI();
  setupMeasurementUI();
  setupLabUI();
  setupExpenseUI();
  setupWeightRangeButtons();
  setupBenchmarkSelector();
  setupBodyToggle();
  renderThemeGrid();
  renderEmojiStyleGrid();
  renderAppetiteStyleGrid();
  setupInfoButtons();
  setupShareUI();
  setupBadgeShareDialog();
  setupSyncFlushAndVisibilityPull();

  // (Session restore now happens via bootstrapSession() at script load — independent of this pipeline.)

  // Refresh premium-gated cards' rendering
  await renderSupplies(await getShotsSorted());
  await renderMeasurements();
  await renderLabs();
  await renderCost(await getWeightsSorted());
  await renderPlateau(await getWeightsSorted(), await getShotsSorted());
});

function applySettingsToInputs() {
  $('#set-med').value = settings.medication;
  // Sync preset dropdown to current medication name (snap to preset if matched, else 'custom').
  const presetSel = $('#set-med-preset');
  if (presetSel) {
    const matched = findMedPreset(settings.medication);
    presetSel.value = matched ? matched.id : 'custom';
  }
  $('#set-dose').value = settings.defaultDose;
  renderDoseChips('#set-dose-chips', '#set-dose', settings.medication);
  $('#set-cadence').value = settings.cadenceDays;
  $('#set-halflife').value = settings.halfLifeDays;
  if ($('#set-start-weight')) $('#set-start-weight').value = settings.startWeight ?? '';
  if ($('#set-goal-weight'))  $('#set-goal-weight').value = settings.goalWeight ?? '';
  if ($('#set-maintenance'))  $('#set-maintenance').checked = !!settings.maintenanceMode;
  if ($('#set-mixing-calc'))  $('#set-mixing-calc').checked = !!settings.showMixingCalc;
  applyMixingCalcVisibility();
  $('#set-notify').checked = !!settings.notify && (typeof Notification !== 'undefined' && Notification.permission === 'granted');
  $('#set-lead').value = String(settings.notifyLeadMinutes ?? 60);
  const tzSel = $('#set-timezone');
  if (tzSel) {
    if (!tzSel.options.length) populateTimezoneOptions(tzSel);
    tzSel.value = settings.timezone || getUserTz();
  }
  updateTimezoneStatus();
  renderDailyReminderRows();
  $('#set-theme').value = settings.theme || 'system';
  applyTheme();
  applyColorTheme(settings.colorTheme || 'teal');
  applyMoodStyle(settings.moodStyle || 'classic');
  applyAppetiteStyle(settings.appetiteStyle || 'classic');
  // Refresh the picker grids so their "active" class reflects the current setting (matters after cross-device pull).
  try { if (typeof renderThemeGrid === 'function') renderThemeGrid(); } catch (_) {}
  try { if (typeof renderEmojiStyleGrid === 'function') renderEmojiStyleGrid(); } catch (_) {}
  try { if (typeof renderAppetiteStyleGrid === 'function') renderAppetiteStyleGrid(); } catch (_) {}
  updateNotifyStatus();
}

function applyTheme() {
  const t = settings.theme || 'system';
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem('theme', t); } catch(e){}
  // Re-apply the color theme so its tint flips to the right light/dark variant.
  if (typeof applyColorTheme === 'function') applyColorTheme(settings.colorTheme || 'teal');
}

async function getLastWeightUnit() {
  const ws = await getWeightsSorted();
  return ws.length ? ws[ws.length - 1].unit : null;
}

// ---------- Charts ----------
let weightChart, levelChart;
let _weightRangeDays = 'all'; // 'all' | 30 | 90 | 180 | 365
async function renderWeights() {
  const wsAll = await getWeightsSorted();
  const shots = await getShotsSorted();
  await renderHero(shots, wsAll);
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
  const data = ws.map(w => w.value);
  const unit = (ws[0] && ws[0].unit) || 'lb';
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

// ---------- Export / Import ----------
async function exportData() {
  const shots = (await dbAll(STORES.shots)) || [];
  const weights = (await dbAll(STORES.weights)) || [];
  const blob = new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), settings, shots, weights }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `shotclock-${todayISODate()}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  settings.lastBackup = new Date().toISOString();
  await saveSettings();
  updateBackupLabel();
  track('export_json', { shots: shots.length, weights: weights.length });
}
async function smartImport(e) {
  const file = e.target.files[0];
  if (!file) return;
  const btn = $('#smart-import-btn');
  const orig = btn.textContent;
  try {
    if (file.size > 1500 * 1024) {
      throw new Error('File is over 1.5 MB. Trim it down or split into chunks.');
    }
    const text = await file.text();
    if (!account.user) {
      throw new Error('Sign in first — Smart Import sends the file to our server for AI parsing.');
    }
    if (!confirm(`Use AI to parse "${file.name}" (${file.size} bytes)?\n\nThis sends the FILE TEXT to our server for parsing only. The parsed shots/weights are then merged into your local data.`)) {
      return;
    }
    btn.disabled = true;
    btn.textContent = '✨ Parsing with AI…';
    track('smart_import_started', { size_bytes: file.size });
    const r = await accountFetch('import/parse', {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      track('smart_import_failed', { status: r.status });
      throw new Error(j.message || `Failed (${r.status})`);
    }
    const j = await r.json();
    // The parser is an LLM reading a user-supplied file: treat its output as
    // untrusted. sanitizeShot/Weight drop anything with an unusable date or
    // dose rather than letting one bad row abort a 2000-row import.
    const shots = (Array.isArray(j.shots) ? j.shots : [])
      .map(s => sanitizeShot({ ...s, med: s && s.med ? s.med : (settings.medication || 'Tirzepatide') }))
      .filter(Boolean);
    const weights = (Array.isArray(j.weights) ? j.weights : []).map((w) => {
      const clean = sanitizeWeight(w);
      if (clean && clean.unit === 'kg') return { ...clean, value: Number((clean.value * 2.20462).toFixed(2)), unit: 'lb' };
      return clean;
    }).filter(Boolean);
    if (!shots.length && !weights.length) {
      alert('AI did not find any shots or weights in this file.');
      return;
    }
    if (!confirm(`Found ${shots.length} shots and ${weights.length} weight entries. Import them now?`)) return;
    for (const s of shots) await dbAdd(STORES.shots, s);
    for (const w of weights) await dbAdd(STORES.weights, { value: w.value, date: w.date });
    await renderShots();
    await renderWeights();
    markSyncDirty();
    track('smart_import_success', { shots: shots.length, weights: weights.length });
    alert(`✓ Imported ${shots.length} shots and ${weights.length} weights.`);
  } catch (ex) {
    alert('Smart import failed: ' + (ex.message || ex));
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
    e.target.value = '';
  }
}

// ---------- Import sanitising ----------
// Imported files (and LLM-parsed exports) are untrusted input that ends up in
// innerHTML sinks. Coercing types at the door is the only place this has to be
// got right — every renderer downstream then gets a number where it expects one.
const MAX_TEXT_FIELD = 500;

// Real exports write "7.5", "7.5 mg", "180 lb". They do not write prose, and
// they certainly do not write markup. Stripping every non-digit was too
// forgiving: it turned an injected string into a plausible-looking number and
// imported it as a dose. Match a number with an optional unit, reject the rest.
const NUMERIC_RE = /^\s*(-?\d+(?:[.,]\d+)?)\s*(mg|mcg|ml|cc|units?|iu|u|lbs?|kgs?|kilos?|pounds?|%)?\s*$/i;

function safeNum(v, { min = -1e9, max = 1e9, dp = 4 } = {}) {
  let n;
  if (typeof v === 'number') {
    n = v;
  } else {
    const m = NUMERIC_RE.exec(String(v ?? ''));
    if (!m) return null;
    n = parseFloat(m[1].replace(',', '.'));
  }
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Number(n.toFixed(dp))));
}

function safeText(v, max = MAX_TEXT_FIELD) {
  if (v == null) return '';
  return String(v).slice(0, max);
}

function safeISO(v) {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function sanitizeShot(s) {
  if (!s || typeof s !== 'object') return null;
  const when = safeISO(s.when);
  const dose = safeNum(s.dose, { min: 0, max: 1000, dp: 3 });
  if (!when || dose == null) return null;
  const out = {
    when,
    dose,
    med: safeText(s.med, 80) || 'Tirzepatide',
    site: safeText(s.site, 80),
    notes: safeText(s.notes, 2000),
  };
  const se = sanitizeSideEffectMap(s.sideEffects);
  if (se) out.sideEffects = se;
  return out;
}

// Shared by shot records and standalone symptom days. Keys are rendered as
// labels when they aren't in our taxonomy, so restrict them to a safe charset
// rather than merely truncating. Values must be one of the four severity levels.
function sanitizeSideEffectMap(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const LEVELS = new Set(SE_LEVELS.map(l => l[0]));
  const se = {};
  for (const [k, v] of Object.entries(raw).slice(0, 40)) {
    const key = String(k).slice(0, 40).replace(/[^A-Za-z0-9 _-]/g, '');
    if (!key) continue;
    const val = String(v ?? '').toLowerCase();
    se[key] = LEVELS.has(val) ? val : '';
  }
  return se;
}

function sanitizeWeight(w) {
  if (!w || typeof w !== 'object') return null;
  const value = safeNum(w.value, { min: 0, max: 2000, dp: 2 });
  const date = toCanonicalDate(w.date);
  if (value == null || !date) return null;
  return { date, value, unit: w.unit === 'kg' ? 'kg' : 'lb' };
}

// A note is free text, so it is never interpreted — only length-capped and, at
// every render site, escaped. `updatedAt` is kept because the merge needs it to
// decide which side of a conflict is newer.
function sanitizeNote(n) {
  if (!n || typeof n !== 'object') return null;
  const date = toCanonicalDate(n.date);
  const text = safeText(n.text, NOTE_MAX).trim();
  if (!date || !text) return null;
  const out = { date, text };
  const ts = Date.parse(n.updatedAt);
  if (Number.isFinite(ts)) out.updatedAt = new Date(ts).toISOString();
  return out;
}

// Settings from a file may only overwrite keys we know about, with the type we
// expect. Anything else — including sync credentials — is ignored.
function sanitizeSettings(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const SYNC_KEYS = new Set(['syncEnabled', 'syncUsername', 'syncLastPushAt', 'syncLastPullAt', 'syncLastUpdatedAt', 'syncLastError']);
  const out = {};
  for (const [k, def] of Object.entries(DEFAULT_SETTINGS)) {
    if (SYNC_KEYS.has(k) || !(k in raw)) continue;
    const v = raw[k];
    if (typeof def === 'number') { const n = safeNum(v); if (n != null) out[k] = n; }
    else if (typeof def === 'boolean') { if (typeof v === 'boolean') out[k] = v; }
    else if (typeof def === 'string') out[k] = safeText(v, 200);
    else if (Array.isArray(def) && Array.isArray(v)) out[k] = v.slice(0, 50);
    else if (k === 'dailyReminders') { const dr = sanitizeDailyReminders(v); if (dr) out[k] = dr; }
    else if (def && typeof def === 'object' && v && typeof v === 'object') out[k] = v;
  }
  return out;
}

// dailyReminders was the one nested object passed through untouched, and its
// `time` is interpolated straight into a value="" attribute. An imported file
// could close the attribute and add an event handler from there.
function sanitizeDailyReminders(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out = {};
  for (const r of DAILY_REMINDERS) {
    const e = v[r.key];
    if (!e || typeof e !== 'object') continue;
    const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(e.time || '')) ? String(e.time) : '08:00';
    out[r.key] = { enabled: e.enabled === true, time };
  }
  return out;
}

async function importData(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const isCSV = /\.csv$/i.test(file.name) || (!text.trim().startsWith('{') && text.includes(','));
    if (isCSV) {
      await importShotsyCSV(text);
    } else {
      const parsed = JSON.parse(text);
      if (!parsed || !Array.isArray(parsed.shots)) throw new Error('Invalid JSON file');
      const shots = parsed.shots.map(sanitizeShot).filter(Boolean);
      const weights = (Array.isArray(parsed.weights) ? parsed.weights : []).map(sanitizeWeight).filter(Boolean);
      const dropped = (parsed.shots.length - shots.length) + ((parsed.weights || []).length - weights.length);
      const warn = dropped > 0 ? `\n\n${dropped} row(s) will be skipped — missing or unreadable date/value.` : '';
      if (!confirm(`Import ${shots.length} shots and ${weights.length} weight entries? This will MERGE with existing data.${warn}`)) return;
      for (const s of shots) await dbAdd(STORES.shots, s);
      for (const w of weights) await dbAdd(STORES.weights, w);
      if (parsed.settings) {
        settings = { ...settings, ...sanitizeSettings(parsed.settings) };
        await saveSettings();
        applySettingsToInputs();
      }
      await renderShots();
      await renderWeights();
      alert(`Imported ${shots.length} shots and ${weights.length} weight entries.`);
    }
  } catch (err) {
    alert('Import failed: ' + err.message);
  }
  e.target.value = '';
}

// ---------- Shotsy CSV import ----------
// Parses CSV with full RFC-4180 quoting (handles embedded newlines and double-quote escapes).
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++;
    } else {
      if (c === '"') { inQuotes = true; i++; continue; }
      if (c === ',') { row.push(field); field = ''; i++; continue; }
      if (c === '\r') { i++; continue; }
      if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
      field += c; i++;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Maps Shotsy site labels to My GLP Shot site labels.
function mapShotsySite(s) {
  if (!s) return null;
  const t = s.trim().toLowerCase();
  const map = {
    'left arm': 'Upper arm — Left',
    'right arm': 'Upper arm — Right',
    'upper arm left': 'Upper arm — Left',
    'upper arm right': 'Upper arm — Right',
    'left thigh': 'Thigh — Left',
    'right thigh': 'Thigh — Right',
    'left abdomen': 'Abdomen — Left',
    'right abdomen': 'Abdomen — Right',
    'abdomen left': 'Abdomen — Left',
    'abdomen right': 'Abdomen — Right',
    'left stomach': 'Abdomen — Left',
    'right stomach': 'Abdomen — Right',
  };
  return map[t] || s.trim();
}

// Parses Shotsy "Shot" cell, e.g. "Tirzepatide 5.0 mg" → { med: 'Tirzepatide', dose: 5.0 }
function parseShotCell(s) {
  if (!s || !s.trim()) return null;
  const m = s.trim().match(/^(.+?)\s+([\d.]+)\s*mg\b/i);
  if (!m) return { med: s.trim(), dose: 0 };
  return { med: m[1].trim(), dose: parseFloat(m[2]) };
}

async function importShotsyCSV(text) {
  const rows = parseCSV(text);
  if (rows.length < 2) throw new Error('CSV is empty or malformed');
  const header = rows[0].map(h => h.trim().toLowerCase());
  const colIdx = (name) => header.indexOf(name.toLowerCase());
  const cDate = colIdx('date');
  const cShot = colIdx('shot');
  const cTime = colIdx('time');
  const cSite = colIdx('site');
  const cShotNotes = colIdx('shot notes');
  const cPain = colIdx('pain level');
  const cWeight = header.findIndex(h => h.startsWith('recorded weight'));
  const cDayNotes = colIdx('day notes');
  if (cDate < 0) throw new Error('CSV missing required "Date" column — is this a tracker export?');

  const shotsToAdd = [];
  const weightsToAdd = [];
  // Shotsy's "Day notes" is a note about the day, not about the injection. It used
  // to be appended to the first shot's notes, which buried it and dropped it
  // entirely on days with no shot. It now lands in the notes store where it belongs.
  const dayNotesToAdd = new Map();

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length === 0) continue;
    const date = (row[cDate] || '').trim();
    if (!date) continue;

    // Shot cells can contain multiple shots separated by newlines (multi-shot day in Shotsy export)
    const shotCells = (cShot >= 0 ? (row[cShot] || '').split('\n') : []).map(s => s.trim()).filter(Boolean);
    const timeCells = (cTime >= 0 ? (row[cTime] || '').split('\n') : []).map(s => s.trim());
    const siteCells = (cSite >= 0 ? (row[cSite] || '').split('\n') : []).map(s => s.trim());
    const notesCells = (cShotNotes >= 0 ? (row[cShotNotes] || '').split('\n') : []).map(s => s.trim());
    const painCells = (cPain >= 0 ? (row[cPain] || '').split('\n') : []).map(s => s.trim());

    for (let k = 0; k < shotCells.length; k++) {
      const parsed = parseShotCell(shotCells[k]);
      if (!parsed) continue;
      const time = timeCells[k] || timeCells[0] || '00:00';
      const when = new Date(`${date}T${time.length === 5 ? time : (time.padStart(5, '0'))}:00`);
      if (isNaN(when.getTime())) continue;
      const noteParts = [];
      if (notesCells[k]) noteParts.push(notesCells[k]);
      const pain = painCells[k] || painCells[0];
      if (pain && parseFloat(pain) > 0) noteParts.push(`Pain: ${pain}/10`);
      shotsToAdd.push({
        med: parsed.med,
        dose: parsed.dose,
        when: when.toISOString(),
        site: mapShotsySite(siteCells[k] || siteCells[0]),
        notes: noteParts.join(' · ') || null,
      });
    }

    if (cWeight >= 0) {
      const w = (row[cWeight] || '').trim();
      if (w && !isNaN(parseFloat(w))) {
        const canon = toCanonicalDate(date);
        if (canon) weightsToAdd.push({ value: parseFloat(w), unit: 'lb', date: canon });
      }
    }

    // Collected per row, not per shot, so a note on a day with no injection
    // survives the import instead of being silently dropped.
    if (cDayNotes >= 0) {
      const dayNote = (row[cDayNotes] || '').trim();
      const canon = dayNote ? toCanonicalDate(date) : null;
      if (canon) {
        const prev = dayNotesToAdd.get(canon);
        // Two rows can share a date in a multi-shot export; keep both lines.
        dayNotesToAdd.set(canon, prev && prev !== dayNote ? `${prev}\n${dayNote}` : dayNote);
      }
    }
  }

  // Dedupe: identical when+med+dose collapsed to a single record (Shotsy's export sometimes lists a shot twice).
  const seen = new Set();
  const dedupedShots = shotsToAdd.filter(s => {
    const k = `${s.when}|${s.med}|${s.dose}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const seenW = new Set();
  const dedupedWeights = weightsToAdd.filter(w => {
    const k = `${w.date}|${w.value}|${w.unit}`;
    if (seenW.has(k)) return false;
    seenW.add(k);
    return true;
  });

  if (!dedupedShots.length && !dedupedWeights.length && !dayNotesToAdd.size) {
    throw new Error('No shots, weight entries or notes found in CSV');
  }
  const notePart = dayNotesToAdd.size ? ` and ${dayNotesToAdd.size} daily notes` : '';
  if (!confirm(`Import ${dedupedShots.length} shots, ${dedupedWeights.length} weight entries${notePart}? This will MERGE with existing data.`)) return;

  // A CSV is untrusted input like any other file, so it goes through the same
  // door as the JSON and LLM paths rather than straight into the database.
  for (const s of dedupedShots) { const c = sanitizeShot(s); if (c) await dbAdd(STORES.shots, c); }
  for (const w of dedupedWeights) { const c = sanitizeWeight(w); if (c) await dbAdd(STORES.weights, c); }
  // Imported notes go through the same merge as a sync pull, so re-importing the
  // same file doesn't duplicate text and an existing note is never overwritten.
  let notesImported = 0;
  if (dayNotesToAdd.size) {
    const rows = [...dayNotesToAdd].map(([date, text]) => ({ date, text, updatedAt: new Date(0).toISOString() }));
    const st = await mergeNotes(rows);
    notesImported = st.added + st.updated + st.combined;
  }
  await ensurePersisted();
  await renderShots();
  await renderWeights();
  if (notesImported) { try { await refreshDailyCards(); } catch (_) {} }
  alert(`Imported ${dedupedShots.length} shots, ${dedupedWeights.length} weight entries${notesImported ? ` and ${notesImported} daily notes` : ''}.`);
}
function updateBackupLabel() {
  const el = $('#last-backup');
  if (!el) return;
  if (settings.lastBackup) {
    const d = new Date(settings.lastBackup);
    const days = Math.floor((Date.now() - d) / 86400000);
    el.textContent = `Last backup: ${d.toLocaleDateString()} (${days}d ago)` + (days > 14 ? ' — consider exporting again' : '');
  } else {
    el.textContent = 'No backup yet — export to download a JSON file.';
  }
  // A failing cloud sync must be visible, not just logged to a console nobody opens.
  const errEl = $('#sync-error-banner');
  if (errEl) {
    if (settings.syncLastError) {
      errEl.textContent = `Cloud backup is failing: ${settings.syncLastError}. Your data is safe on this device — export a copy to be sure.`;
      errEl.hidden = false;
    } else {
      errEl.textContent = '';
      errEl.hidden = true;
    }
  }
}

// ---------- Wipe ----------
async function wipeAll() {
  if (!confirm('This will delete ALL shots, weights, and settings on this device. Are you sure?')) return;
  if (!confirm('Really erase everything? This cannot be undone.')) return;
  _dbPromise = null;
  indexedDB.deleteDatabase(DB_NAME);
  setTimeout(() => location.reload(), 300);
}

// ---------- ICS calendar feed ----------
async function downloadICS() {
  const shots = await getShotsSorted();
  if (!shots.length) { alert('Log a shot first to generate a recurring reminder.'); return; }
  const last = shots[0];
  const next = nextShotDate(last.when);
  const dt = (d) => d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//MyGLPShot//EN',
    'BEGIN:VEVENT',
    `UID:shotclock-${Date.now()}@willhitestrategy.org`,
    `DTSTAMP:${dt(new Date())}`,
    `DTSTART:${dt(next)}`,
    `DTEND:${dt(new Date(next.getTime() + 15 * 60000))}`,
    `SUMMARY:${settings.medication} shot due`,
    `DESCRIPTION:Time for your ${settings.defaultDose}mg ${settings.medication} shot.`,
    `RRULE:FREQ=DAILY;INTERVAL=${settings.cadenceDays || 7}`,
    'BEGIN:VALARM',
    'TRIGGER:-PT30M',
    'ACTION:DISPLAY',
    'DESCRIPTION:Shot reminder',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const blob = new Blob([ics], { type: 'text/calendar' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'shotclock-reminder.ics';
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

// ---------- Notifications ----------
// Strategy:
//   1. Notification Triggers API (Chrome/Edge, esp. installed Android PWA) → real scheduled push, fires when app is closed.
//   2. Fallback: setTimeout while app is open (any browser).
//   3. iOS PWA: requestPermission works on iOS 16.4+ when installed to home screen. Triggers API not supported, but iOS reschedules our SW periodically; we re-schedule in `pageshow` so reminders work when user opens the app.

let notifyTimer = null;
let dailyReminderTimers = [];
const TRIGGERS_SUPPORTED = (typeof window !== 'undefined') && ('Notification' in window) && ('showTrigger' in Notification.prototype || (typeof TimestampTrigger !== 'undefined'));

async function maybeScheduleNotification() {
  // Top-level entry: re-plans the shot reminder and every enabled daily reminder.
  // Called on settings change, on pageshow, and after sync pull so changes
  // made on another device land immediately.
  if (notifyTimer) { clearTimeout(notifyTimer); notifyTimer = null; }
  dailyReminderTimers.forEach(t => clearTimeout(t));
  dailyReminderTimers = [];

  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;

  // Re-publish the upcoming fire times whenever the plan changes, so a schedule
  // edited here lands on the server that actually delivers when the app is shut.
  syncPushSchedule().catch(() => {});

  // Clear all scheduled notifications we own (shot-* and daily-*) before re-scheduling.
  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.ready;
      const existing = await reg.getNotifications({ includeTriggered: true });
      existing.forEach(n => {
        if (n.tag && (n.tag.startsWith('shot-') || n.tag.startsWith('daily-'))) n.close();
      });
    } catch (_) {}
  }

  await scheduleShotReminder();
  await scheduleDailyReminders();
}

async function scheduleShotReminder() {
  if (!settings.notify) return;
  const shots = await getShotsSorted();
  if (!shots.length) return;
  const next = nextShotDate(shots[0].when);
  const lead = (settings.notifyLeadMinutes || 0) * 60000;
  const fireAt = new Date(next.getTime() - lead);
  const ms = fireAt - new Date();
  if (ms > 86400000 * 30) return;

  const title = 'My GLP Shot';
  const body = lead > 0
    ? `Your ${settings.medication} shot is due in ${humanLead(lead)}.`
    : `${settings.medication} shot is due now.`;
  const tag = `shot-${next.toISOString()}`;

  if (TRIGGERS_SUPPORTED && 'serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.ready;
      if (ms > 0) {
        await reg.showNotification(title, {
          body, tag, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png',
          showTrigger: new TimestampTrigger(fireAt.getTime()),
          data: { url: '/#reminder=shot' },
        });
        return;
      }
    } catch (e) {}
  }

  if (ms <= 0) return;
  if (ms > 86400000 * 14) return;
  notifyTimer = setTimeout(async () => {
    if ('serviceWorker' in navigator) {
      try {
        const reg = await navigator.serviceWorker.ready;
        await reg.showNotification(title, { body, tag, icon: 'icons/icon-192.png', data: { url: '/#reminder=shot' } });
        return;
      } catch (e) {}
    }
    new Notification(title, { body, icon: 'icons/icon-192.png' });
  }, ms);
}

async function scheduleDailyReminders() {
  // Re-planning replaces the whole set, so drop any timers still pending. The
  // roll-over call at the end of a fired reminder re-enters here directly
  // (not via maybeScheduleNotification, which is where clearing used to
  // happen), so without this every fire stacked another full set of timers and
  // a long-lived tab ended up showing the same reminder several times.
  dailyReminderTimers.forEach(t => clearTimeout(t));
  dailyReminderTimers = [];

  const cfg = settings.dailyReminders || {};
  for (const r of DAILY_REMINDERS) {
    const entry = cfg[r.key];
    if (!entry || !entry.enabled) continue;
    const fireAt = nextDailyTriggerAt(entry.time);
    if (!fireAt) continue;
    const ms = fireAt - new Date();
    if (ms <= 0) continue;

    const tag = `daily-${r.key}-${fireAt.toISOString().slice(0,10)}`;
    const opts = {
      body: r.body,
      tag,
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
      data: { url: '/' + r.route },
    };

    // Path 1: real OS-level scheduled trigger (Android/Chrome installed PWA).
    if (TRIGGERS_SUPPORTED && 'serviceWorker' in navigator) {
      try {
        const reg = await navigator.serviceWorker.ready;
        await reg.showNotification(`${r.emoji} ${r.title}`, {
          ...opts,
          showTrigger: new TimestampTrigger(fireAt.getTime()),
        });
        continue;
      } catch (_) { /* fall through */ }
    }

    // Path 2: in-process setTimeout (fires while app is open; on iOS we get
    // a second chance via pageshow re-scheduling on next app open).
    if (ms > 86400000 * 2) continue;
    const t = setTimeout(async () => {
      try {
        if ('serviceWorker' in navigator) {
          const reg = await navigator.serviceWorker.ready;
          await reg.showNotification(`${r.emoji} ${r.title}`, opts);
        } else {
          new Notification(`${r.emoji} ${r.title}`, { body: r.body, icon: 'icons/icon-192.png' });
        }
      } catch (_) {}
      // Roll the timer for tomorrow if the app is still open.
      scheduleDailyReminders();
    }, ms);
    dailyReminderTimers.push(t);
  }
}

// ---------- Web Push reminders ----------
// In-page timers can only fire while the app is open, and Notification Triggers
// is not shipped by any current browser. Push is the only way a reminder reaches
// someone who closed the tab three days ago.
//
// The privacy trade, stated plainly because it is the whole design: the server
// is told WHEN to send and nothing else. Fire times are computed here from the
// local (encrypted, server-unreadable) schedule; the wording is picked by the
// server from a fixed list keyed on `kind`. The medication, dose, sites and
// history never leave the device.
const PUSH_SUPPORTED = typeof window !== 'undefined'
  && 'serviceWorker' in navigator && 'PushManager' in window;
const PUSH_HORIZON_DAYS = 30;
const PUSH_MAX_QUEUED = 32;

function urlBase64ToUint8Array(b64) {
  const padding = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function getPushSubscription() {
  if (!PUSH_SUPPORTED) return null;
  try {
    const reg = await navigator.serviceWorker.ready;
    return await reg.pushManager.getSubscription();
  } catch (_) { return null; }
}

async function enablePushReminders() {
  if (!PUSH_SUPPORTED) throw new Error('This browser cannot receive push reminders.');
  if (!account.user) throw new Error('Sign in first — push reminders need an account.');
  if (Notification.permission !== 'granted') {
    const p = await Notification.requestPermission();
    if (p !== 'granted') throw new Error('Notification permission was not granted.');
  }
  const keyResp = await accountFetch('push/key');
  if (!keyResp.ok) throw new Error('Push is not configured on the server yet.');
  const { publicKey } = await keyResp.json();

  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  // A subscription made against a different VAPID key is dead; replace it.
  if (sub) {
    const existing = sub.options && sub.options.applicationServerKey;
    const want = urlBase64ToUint8Array(publicKey);
    const same = existing && new Uint8Array(existing).length === want.length
      && new Uint8Array(existing).every((b, i) => b === want[i]);
    if (!same) { try { await sub.unsubscribe(); } catch (_) {} sub = null; }
  }
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  }
  const r = await accountFetch('push/subscribe', { method: 'POST', body: JSON.stringify(sub.toJSON()) });
  if (!r.ok) throw new Error('Could not register this device for reminders.');
  await syncPushSchedule();
  track('push_enabled');
  return true;
}

async function disablePushReminders() {
  const sub = await getPushSubscription();
  try {
    await accountFetch('push/unsubscribe', {
      method: 'POST',
      body: JSON.stringify({ endpoint: sub ? sub.endpoint : '' }),
    });
  } catch (_) {}
  if (sub) { try { await sub.unsubscribe(); } catch (_) {} }
  track('push_disabled');
}

// Compute the upcoming fire times from local data. Returns only {kind, fireAt}
// pairs — deliberately the least the server can be told and still send on time.
async function computeUpcomingReminders() {
  const out = [];
  const now = Date.now();
  const horizon = now + PUSH_HORIZON_DAYS * 86400000;

  if (settings.notify) {
    const shots = await getShotsSorted();
    if (shots.length) {
      const lead = (settings.notifyLeadMinutes || 0) * 60000;
      // Project the cadence forward rather than sending only the next one, so a
      // user who doesn't open the app for a month still gets nudged.
      let next = nextShotDate(shots[0].when);
      const cadenceMs = Math.max(1, settings.cadenceDays || 7) * 86400000;
      for (let i = 0; i < 8; i++) {
        const fire = next.getTime() - lead;
        if (fire > now && fire <= horizon) out.push({ kind: 'shot', fireAt: Math.floor(fire / 1000) });
        next = new Date(next.getTime() + cadenceMs);
        if (next.getTime() > horizon) break;
      }
    }
  }

  const cfg = settings.dailyReminders || {};
  for (const r of DAILY_REMINDERS) {
    const entry = cfg[r.key];
    if (!entry || !entry.enabled) continue;
    let fireAt = nextDailyTriggerAt(entry.time);
    if (!fireAt) continue;
    for (let d = 0; d < 14; d++) {
      const t = fireAt.getTime() + d * 86400000;
      if (t > now && t <= horizon) out.push({ kind: `daily:${r.key}`, fireAt: Math.floor(t / 1000) });
    }
  }

  out.sort((a, b) => a.fireAt - b.fireAt);
  return out.slice(0, PUSH_MAX_QUEUED);
}

async function syncPushSchedule() {
  if (!account.user) return null;
  const sub = await getPushSubscription();
  if (!sub) return null;                    // nothing registered: nothing to schedule
  try {
    const reminders = await computeUpcomingReminders();
    const r = await accountFetch('push/schedule', { method: 'PUT', body: JSON.stringify({ reminders }) });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    console.warn('[mgs] push schedule sync failed:', e);
    return null;
  }
}

function humanLead(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h !== 1 ? 's' : ''}`;
  const d = Math.round(h / 24);
  return `${d} day${d !== 1 ? 's' : ''}`;
}

// Populate the TZ select with grouped options. Current device TZ at the top.
function populateTimezoneOptions(sel) {
  const all = listSupportedTimezones();
  const deviceTz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (_) { return 'UTC'; } })();
  sel.innerHTML = '';
  const top = document.createElement('option');
  top.value = deviceTz;
  top.textContent = `Device default — ${deviceTz}`;
  sel.appendChild(top);
  for (const tz of all) {
    if (tz === deviceTz) continue;
    const o = document.createElement('option');
    o.value = tz;
    o.textContent = tz.replace(/_/g, ' ');
    sel.appendChild(o);
  }
}

function updateTimezoneStatus() {
  const el = $('#tz-status'); if (!el) return;
  const tz = getUserTz();
  let nowStr = '';
  try {
    nowStr = new Intl.DateTimeFormat(undefined, {
      timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit',
    }).format(new Date());
  } catch (_) {}
  el.textContent = `Current time in ${tz}: ${nowStr}`;
}

function renderDailyReminderRows() {
  const root = $('#daily-reminders-list');
  if (!root) return;
  const cfg = settings.dailyReminders || {};
  root.innerHTML = DAILY_REMINDERS.map(r => {
    const entry = cfg[r.key] || { enabled: false, time: '08:00' };
    const id = `dr-${r.key}`;
    return `
      <div class="daily-reminder-row">
        <label class="row daily-reminder-toggle">
          <input type="checkbox" id="${id}-on" data-rkey="${r.key}" ${entry.enabled ? 'checked' : ''}>
          <span class="daily-reminder-emoji" aria-hidden="true">${r.emoji}</span>
          <span class="daily-reminder-label">${r.label}</span>
        </label>
        <label class="daily-reminder-time">
          <span class="muted small">at</span>
          <input type="time" id="${id}-time" data-rkey="${r.key}" value="${escapeHTML(entry.time || '08:00')}">
        </label>
      </div>`;
  }).join('');
}

// Called on boot AND on pageshow. Reads #reminder=KEY from the URL hash
// (set by the SW notificationclick handler) and snaps the UI to the right
// section. Clears the hash so a refresh doesn't re-trigger.
function handleReminderDeepLink() {
  const m = (location.hash || '').match(/reminder=([a-zA-Z]+)/);
  if (!m) return;
  const key = m[1];
  try { history.replaceState(null, '', location.pathname + location.search); } catch (_) {}
  const tabAndAnchor = {
    weight:       { tab: 'home', scroll: '#weight-chart' },
    moodAppetite: { tab: 'home', scroll: '#mood-card' },
    sideEffects:  { tab: 'home', scroll: '#symptoms-card' },
    measurements: { tab: 'more', scroll: '#measurements-card' },
    shot:         { tab: 'home', scroll: null },
  }[key];
  if (!tabAndAnchor) return;
  try {
    showView('home');
    setHomeTab(tabAndAnchor.tab);
  } catch (_) {}
  if (tabAndAnchor.scroll) {
    setTimeout(() => {
      const el = document.querySelector(tabAndAnchor.scroll);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);
  }
  if (key === 'weight') {
    setTimeout(() => { const b = document.querySelector('#add-weight-btn'); if (b) b.click(); }, 300);
  } else if (key === 'sideEffects') {
    // The reminder used to scroll to a card that didn't exist, so tapping the
    // notification landed on Home with nothing to do. Open the picker instead.
    setTimeout(() => { const b = document.querySelector('#symptoms-log-btn'); if (b) b.click(); }, 300);
  } else if (key === 'shot') {
    setTimeout(() => { const b = document.querySelector('#log-shot-btn'); if (b) b.click(); }, 300);
  }
}
window.addEventListener('pageshow', () => { try { handleReminderDeepLink(); } catch (_) {} });
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    const data = e.data || {};
    if (data.type !== 'reminder-click' || !data.url) return;
    try {
      const u = new URL(data.url, location.origin);
      location.hash = u.hash;
      handleReminderDeepLink();
    } catch (_) {}
  });
}

function updateNotifyStatus() {
  const el = $('#notify-status');
  if (!el) return;
  const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  if (typeof Notification === 'undefined') {
    el.textContent = 'Notifications not supported in this browser.'; return;
  }
  if (Notification.permission === 'denied') {
    el.textContent = 'Notifications blocked. Enable them in browser settings to receive shot reminders.'; return;
  }
  if (isIOS && !standalone) {
    el.textContent = 'On iOS, install My GLP Shot to your Home Screen first — notifications only work for installed PWAs.'; return;
  }
  if (!settings.notify) {
    el.textContent = PUSH_SUPPORTED && account.user
      ? 'Toggle on for reminders that arrive even when the app is closed.'
      : 'Toggle on to enable reminders.';
    return;
  }
  // Say which delivery path is actually live. Claiming "scheduled" when only an
  // in-page timer is running is how someone ends up missing a dose.
  el.textContent = '✓ Reminders on — checking delivery…';
  getPushSubscription().then(async (sub) => {
    if (sub && account.user) {
      const st = await accountFetch('push/status').then(r => r.ok ? r.json() : null).catch(() => null);
      if (st && st.configured && st.devices > 0) {
        const when = st.nextFireAt ? new Date(st.nextFireAt * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : null;
        el.textContent = when
          ? `✓ Reminders on — delivered even when the app is closed. Next: ${when}.`
          : '✓ Reminders on — delivered even when the app is closed.';
        return;
      }
    }
    if (!account.user) {
      el.textContent = '✓ Reminders on, but only while the app is open. Sign in to get them delivered when it\'s closed.';
    } else {
      el.textContent = '✓ Reminders on, but only while the app is open on this device. Re-toggle to retry background delivery.';
    }
  }).catch(() => {});
}

async function sendTestNotification() {
  if (typeof Notification === 'undefined') { alert('Not supported'); return; }
  if (Notification.permission !== 'granted') {
    const p = await Notification.requestPermission();
    if (p !== 'granted') { alert('Permission not granted'); return; }
  }
  const title = 'My GLP Shot test';
  const body = 'Notifications are working. Real reminders fire before each shot.';
  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification(title, { body, icon: 'icons/icon-192.png', data: { url: '/shotclock/' } });
      return;
    } catch (e) {}
  }
  new Notification(title, { body, icon: 'icons/icon-192.png' });
}

// ---------- Install prompt (iOS + Android + Desktop) ----------
let deferredInstallPrompt = null;

function detectPlatform() {
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isSafari = isIOS && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
  const isAndroid = /Android/.test(ua);
  const isMobile = isIOS || isAndroid;
  return { isIOS, isSafari, isAndroid, isMobile };
}

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function showInstallDialog() {
  const dlg = $('#install-dialog');
  if (!dlg) return;
  $('#install-ios').classList.add('hidden');
  $('#install-ios-other').classList.add('hidden');
  $('#install-android').classList.add('hidden');
  $('#install-desktop').classList.add('hidden');
  const p = detectPlatform();
  if (p.isIOS && p.isSafari) $('#install-ios').classList.remove('hidden');
  else if (p.isIOS && !p.isSafari) $('#install-ios-other').classList.remove('hidden');
  else if (p.isAndroid) $('#install-android').classList.remove('hidden');
  else $('#install-desktop').classList.remove('hidden');
  dlg.showModal();
  track('install_prompt_shown', { platform: p.isIOS ? 'ios' : p.isAndroid ? 'android' : 'desktop' });
}

function setupInstallBanner() {
  // Capture Android/Chrome/Edge install event whenever it fires.
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
  });
  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    localStorage.setItem('installDismissed', '1');
    const dlg = $('#install-dialog');
    if (dlg && dlg.open) dlg.close();
    const card = $('#install-card');
    if (card) card.classList.add('hidden');
  });

  // Hide the Settings install card if already installed.
  if (isStandalone()) {
    const card = $('#install-card');
    if (card) card.classList.add('hidden');
  }

  // Wire dialog buttons.
  $('#install-dismiss').addEventListener('click', () => {
    localStorage.setItem('installDismissedAt', String(Date.now()));
    $('#install-dialog').close();
  });
  $('#install-android-btn').addEventListener('click', async () => {
    if (!deferredInstallPrompt) {
      // Fallback: tell user to use the menu.
      $('#install-android-btn').disabled = true;
      $('#install-android-btn').textContent = 'Use ⋮ menu → Install app';
      return;
    }
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    if (outcome === 'accepted') $('#install-dialog').close();
  });
  $('#show-install-prompt').addEventListener('click', () => {
    if (isStandalone()) {
      alert('Already installed! 🎉');
      return;
    }
    showInstallDialog();
  });

}

// Auto-show install dialog once per 7 days, after sign-in. Called from onAccountChanged.
function maybeAutoShowInstall() {
  try {
    if (isStandalone()) return;
    if (document.body.classList.contains('auth-active')) return;
    const dismissedAt = parseInt(localStorage.getItem('installDismissedAt') || '0', 10);
    if (dismissedAt && (Date.now() - dismissedAt) < 7 * 86400 * 1000) return;
    const dlg = document.getElementById('install-dialog');
    if (!dlg || dlg.open) return;
    setTimeout(() => {
      if (isStandalone()) return;
      if (document.body.classList.contains('auth-active')) return;
      if (dlg.open) return;
      showInstallDialog();
    }, 5000);
  } catch (_) {}
}

// A backup that fails quietly is worse than no backup — the user believes their
// health history is safe when it isn't. Record the failure, surface it in
// Settings, and warn once per session rather than swallowing the error.
let _syncFailureWarned = false;
async function noteSyncFailure(e) {
  const msg = String((e && e.message) || e || 'Unknown error');
  console.warn('[mgs] sync push failed:', msg);
  settings.syncLastError = msg;
  settings.syncLastErrorAt = new Date().toISOString();
  try { await saveSettings(); } catch (_) {}
  updateBackupLabel();
  if (!_syncFailureWarned) {
    _syncFailureWarned = true;
    toast('Cloud backup failed — your data is still safe on this device.');
  }
}

// Flush pending pushes when the tab loses focus / unloads, and pull fresh data
// when it regains focus (covers the "I switched devices" UX). Without this,
// debounced writes can be silently dropped and the user sees stale data.
function setupSyncFlushAndVisibilityPull() {
  const flush = () => {
    if (!window._syncDirty) return;
    if (!account.user || !account.encryptionKey) return;
    // Cancel the debounced push and fire one synchronously-initiated push now.
    clearTimeout(window._syncDebounce);
    window._syncDirty = false;
    accountSyncPush().catch((e) => { window._syncDirty = true; noteSyncFailure(e); });
  };
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'hidden') {
      flush();
    } else if (document.visibilityState === 'visible') {
      // Coming back to the tab — pull any remote changes another device pushed
      // while we were away. Skip if we just pushed (within last 10 s) to avoid loops.
      if (!account.user || !account.encryptionKey) return;
      const recentPush = settings.syncLastPushAt && (Date.now() - new Date(settings.syncLastPushAt).getTime() < 10000);
      if (recentPush) return;
      try {
        const result = await accountSyncPull();
        if (result && result.payload) {
          const cloudUpdatedAt = result.updatedAt || 0;
          const lastSeen = settings.syncLastUpdatedAt || 0;
          if (cloudUpdatedAt > lastSeen) {
            await applyPulledPayload(result.payload);
            track('visibility_pull_applied');
          }
        }
      } catch (e) {
        console.warn('[mgs] visibility pull failed:', e);
      }
    }
  });
  // pagehide is the most reliable event on mobile Safari for "tab is going away."
  window.addEventListener('pagehide', flush);
  // beforeunload is desktop-friendly.
  window.addEventListener('beforeunload', flush);
}

async function markSyncDirty() {
  if (account.user && account.encryptionKey) {
    // Account-based sync: auto-push with a *short* debounce so the cloud copy is
    // always within ~2 s of local. Anything longer means closing the tab can drop
    // a write. visibilitychange + pagehide listeners (registered at boot) flush
    // any still-pending writes when the tab backgrounds or unloads.
    window._syncDirty = true;
    clearTimeout(window._syncDebounce);
    window._syncDebounce = setTimeout(() => {
      window._syncDirty = false;
      accountSyncPush().catch((e) => { window._syncDirty = true; noteSyncFailure(e); });
    }, 1500);
    return;
  }
  if (!syncCreds || !settings.syncEnabled || !settings.syncAutoPush) return;
  settings.syncDirty = true;
  await saveSettings();
}

// ----- Setup helpers -----
function setupAccountUI() {
  $('#show-signup').addEventListener('click', () => openAccountDialog('signup'));
  $('#show-login').addEventListener('click', () => openAccountDialog('login'));
  $('#acct-banner-cta').addEventListener('click', () => openAccountDialog('signup'));
  $('#acct-banner-dismiss').addEventListener('click', () => {
    localStorage.setItem('acct.banner.dismissed', '1');
    $('#account-banner').classList.add('hidden');
  });
  const tebDismiss = document.getElementById('trial-end-dismiss');
  if (tebDismiss) tebDismiss.addEventListener('click', () => {
    try { localStorage.setItem('mglp_trial_end_dismissed', todayISODate()); } catch (e) {}
    document.getElementById('trial-end-banner')?.classList.add('hidden');
    track('trial_end_banner_dismissed');
  });
  const tebCta = document.getElementById('trial-end-cta');
  if (tebCta) tebCta.addEventListener('click', () => {
    track('trial_end_banner_clicked');
    document.getElementById('upgrade-cta')?.click();
  });
  $('#account-form').addEventListener('submit', handleAccountSubmit);

  // (Auth form + toggle wired in wireCriticalUI() so it works even if init hangs.)
  $('#account-cancel').addEventListener('click', () => $('#account-dialog').close());
  $('#show-forgot').addEventListener('click', (e) => { e.preventDefault(); $('#account-dialog').close(); $('#forgot-dialog').showModal(); });
  $('#forgot-cancel').addEventListener('click', () => $('#forgot-dialog').close());
  $('#forgot-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('#forgot-email').value.trim();
    $('#forgot-status').textContent = 'Sending…';
    try {
      await accountForgot(email);
      $('#forgot-status').textContent = 'If that email has an account, a reset link is on the way.';
      setTimeout(() => $('#forgot-dialog').close(), 2500);
    } catch (e) {
      $('#forgot-status').textContent = 'Failed: ' + e.message;
    }
  });
  $('#signout-btn').addEventListener('click', async () => {
    if (!confirm('Sign out? Local data is preserved.')) return;
    await accountLogout(true);
    onAccountChanged();
  });
  $('#upgrade-cta').addEventListener('click', () => { $('#upgrade-error').textContent = ''; $('#upgrade-dialog').showModal(); });
  // Premium hero buttons reuse the same dialogs as the Settings card.
  const heroUp = document.getElementById('premium-hero-upgrade');
  if (heroUp) heroUp.addEventListener('click', () => { $('#upgrade-error').textContent = ''; $('#upgrade-dialog').showModal(); });
  const heroMan = document.getElementById('premium-hero-manage');
  if (heroMan) heroMan.addEventListener('click', () => $('#manage-billing-cta').click());
  $('#upgrade-cancel').addEventListener('click', () => $('#upgrade-dialog').close());
  $('#upgrade-confirm').addEventListener('click', async () => {
    const btn = $('#upgrade-confirm');
    const err = $('#upgrade-error');
    err.textContent = '';
    const plan = (document.querySelector('input[name="plan"]:checked') || {}).value || 'yearly';
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = 'Redirecting to Stripe…';
    try {
      track('billing_checkout_clicked', { plan });
      const r = await accountFetch('billing/checkout', { method: 'POST', body: JSON.stringify({ plan }) });
      const j = await r.json();
      if (!r.ok || !j.url) throw new Error(j.message || 'Checkout failed.');
      window.location.assign(j.url);
    } catch (ex) {
      err.textContent = ex.message || 'Could not start checkout.';
      btn.disabled = false;
      btn.textContent = orig;
    }
  });
  $('#manage-billing-cta').addEventListener('click', async () => {
    const btn = $('#manage-billing-cta');
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = 'Opening…';
    try {
      const r = await accountFetch('billing/portal', { method: 'POST' });
      const j = await r.json();
      if (!r.ok || !j.url) throw new Error(j.message || 'Could not open billing portal.');
      window.location.assign(j.url);
    } catch (ex) {
      alert(ex.message || 'Could not open billing portal.');
      btn.disabled = false;
      btn.textContent = orig;
    }
  });

  // PWA shortcut deep-links: ?action=log-shot / ?action=log-weight / ?tab=insights.
  (function handleShortcutAction() {
    const sp = new URLSearchParams(window.location.search);
    const action = sp.get('action');
    const tab = sp.get('tab');
    if (action || tab) {
      sp.delete('action'); sp.delete('tab');
      const cleanUrl = window.location.pathname + (sp.toString() ? '?' + sp.toString() : '') + window.location.hash;
      window.history.replaceState({}, '', cleanUrl);
    }
    if (tab && ['home', 'insights', 'more', 'settings'].includes(tab)) {
      try { setTab(tab); } catch (e) {}
    }
    if (action === 'log-shot') setTimeout(() => { try { openShotDialog(); } catch (e) {} }, 250);
    else if (action === 'log-weight') setTimeout(() => { try { $('#add-weight-btn')?.click(); } catch (e) {} }, 250);
  })();

  // Handle Stripe Checkout return.
  (function handleBillingReturn() {
    const sp = new URLSearchParams(window.location.search);
    const billing = sp.get('billing');
    if (!billing) return;
    sp.delete('billing'); sp.delete('session_id');
    const cleanUrl = window.location.pathname + (sp.toString() ? '?' + sp.toString() : '') + window.location.hash;
    window.history.replaceState({}, '', cleanUrl);
    if (billing === 'success') {
      // Webhook is async — give it a moment then refresh /me.
      setTimeout(() => accountMe().then(onAccountChanged).catch(() => {}), 1500);
      setTimeout(() => alert('🎉 Welcome to Premium! Your 14-day trial just started.'), 100);
    } else if (billing === 'canceled') {
      // No-op; user backed out.
    }
  })();
  $('#show-acct-sync').addEventListener('click', async () => {
    $('#acct-sync-status').textContent = 'Syncing…';
    try { await accountSyncPush(); $('#acct-sync-status').textContent = '✓ Synced'; setTimeout(() => $('#acct-sync-status').textContent = '', 2500); }
    catch (e) { $('#acct-sync-status').textContent = 'Failed: ' + e.message; }
  });
  $('#show-export-pdf').addEventListener('click', exportPDFReport);
  // Premium tab has duplicate button (-more suffix) — wire it to the same handler.
  const exportMore = document.getElementById('show-export-pdf-more');
  if (exportMore) exportMore.addEventListener('click', exportPDFReport);
  const shareMore = document.getElementById('show-share-more');
  if (shareMore) shareMore.addEventListener('click', () => {
    if (!isPremium()) { $('#upgrade-dialog').showModal(); return; }
    document.getElementById('show-share').click();
  });
  const pdfDlg = document.getElementById('pdf-dialog');
  if (pdfDlg) {
    document.getElementById('pdf-cancel')?.addEventListener('click', () => pdfDlg.close());
    document.getElementById('pdf-generate')?.addEventListener('click', async () => {
      const sections = Array.from(pdfDlg.querySelectorAll('[data-pdf-section]:checked')).map(el => el.dataset.pdfSection);
      const range = document.getElementById('pdf-range').value;
      pdfDlg.close();
      try { await runPdfExport({ range, sections }); track('pdf_export_created'); }
      catch (e) { track('pdf_export_failed'); alert('Failed: ' + e.message); }
    });
  }
}

function setupSupplyUI() {
  $('#add-supply-btn').addEventListener('click', () => {
    if (!isPremium() && account.user) { $('#upgrade-dialog').showModal(); return; }
    openSupplyDialog(null);
  });
  $('#supply-cancel').addEventListener('click', () => $('#supply-dialog').close());
  ['#supply-total-mg', '#supply-volume-ml'].forEach(sel => {
    const el = $(sel);
    if (el) el.addEventListener('input', updateSupplyReadout);
  });
  $('#supply-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = $('#supply-id').value;
    const supply = {
      type: $('#supply-type').value,
      total_mg: parseFloat($('#supply-total-mg').value),
      volume_ml: parseFloat($('#supply-volume-ml').value) || null,
      pharmacy: $('#supply-pharmacy').value.trim() || null,
      batch: $('#supply-batch').value.trim() || null,
      cost: parseFloat($('#supply-cost').value) || null,
      opened_at: $('#supply-opened').value || null,
      expires_at: $('#supply-expires').value || null,
      // No stored used_mg: usage is derived from the shot log by supplyUsage(),
      // so it can't drift out of date the way a written-once field did.
    };
    if (id) supply.id = parseInt(id, 10);
    await saveSupply(supply);
    $('#supply-dialog').close();
    await renderSupplies(await getShotsSorted());
    await renderCost(await getWeightsSorted());
    markSyncDirty();
  });
  $('#supply-delete').addEventListener('click', async () => {
    const id = parseInt($('#supply-id').value, 10);
    if (!id) return;
    if (!confirm('Delete this supply?')) return;
    await deleteSupply(id);
    $('#supply-dialog').close();
    await renderSupplies(await getShotsSorted());
    await renderCost(await getWeightsSorted());
    markSyncDirty();
  });
}

function setupMeasurementUI() {
  $('#add-measurement-btn').addEventListener('click', () => {
    if (!isPremium() && account.user) { $('#upgrade-dialog').showModal(); return; }
    $('#measurement-value').value = '';
    $('#measurement-date').value = todayISODate();
    $('#measurement-dialog').showModal();
  });
  $('#measurement-cancel').addEventListener('click', () => $('#measurement-dialog').close());
  $('#measurement-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    await saveMeasurement({
      type: $('#measurement-type').value,
      value: parseFloat($('#measurement-value').value),
      unit: $('#measurement-unit').value,
      date: $('#measurement-date').value,
    });
    $('#measurement-dialog').close();
    await renderMeasurements();
    markSyncDirty();
  });
}

function setupExpenseUI() {
  const btn = $('#add-expense-btn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    if (!isPremium() && account.user) { $('#upgrade-dialog').showModal(); return; }
    openExpenseDialog(null);
  });
  $('#expense-cancel').addEventListener('click', () => $('#expense-dialog').close());
  $('#expense-delete').addEventListener('click', async () => {
    const id = parseInt($('#expense-id').value, 10);
    if (!id) return;
    if (!confirm('Delete this expense?')) return;
    await deleteExpense(id);
    $('#expense-dialog').close();
    await renderCost(await getWeightsSorted());
    markSyncDirty();
    track('expense_deleted');
  });
  $('#expense-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const idVal = $('#expense-id').value;
    const data = {
      amount: parseFloat($('#expense-amount').value),
      category: $('#expense-category').value,
      date: $('#expense-date').value,
      notes: $('#expense-notes').value.trim() || null,
    };
    if (idVal) data.id = parseInt(idVal, 10);
    await saveExpense(data);
    $('#expense-dialog').close();
    await renderCost(await getWeightsSorted());
    markSyncDirty();
    track(idVal ? 'expense_edited' : 'expense_logged', { category: data.category });
  });
}

function setupLabUI() {
  $('#add-lab-btn').addEventListener('click', () => {
    if (!isPremium() && account.user) { $('#upgrade-dialog').showModal(); return; }
    $('#lab-value').value = '';
    $('#lab-date').value = todayISODate();
    $('#lab-notes').value = '';
    $('#lab-dialog').showModal();
  });
  $('#lab-cancel').addEventListener('click', () => $('#lab-dialog').close());
  $('#lab-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    await saveLab({
      type: $('#lab-type').value,
      value: parseFloat($('#lab-value').value),
      date: $('#lab-date').value,
      notes: $('#lab-notes').value.trim() || null,
    });
    $('#lab-dialog').close();
    await renderLabs();
    markSyncDirty();
  });
}

function setupShareUI() {
  $('#show-share').addEventListener('click', () => {
    if (!isPremium()) { $('#upgrade-dialog').showModal(); return; }
    $('#share-result').classList.add('hidden');
    $('#share-label').value = '';
    $('#share-dialog').showModal();
  });
  $('#share-cancel').addEventListener('click', () => $('#share-dialog').close());
  $('#share-create').addEventListener('click', async () => {
    try {
      const sections = Array.from(document.querySelectorAll('#share-dialog [data-section]:checked')).map(el => el.dataset.section);
      const range = $('#share-range').value;
      const result = await createShareLink($('#share-label').value.trim(), { range, sections });
      $('#share-url-display').textContent = result.url;
      $('#share-result').classList.remove('hidden');
      track('doctor_share_created');
    } catch (e) {
      track('doctor_share_failed');
      alert('Failed: ' + e.message);
    }
  });
  $('#share-copy').addEventListener('click', () => {
    const url = $('#share-url-display').textContent;
    navigator.clipboard.writeText(url).then(() => {
      $('#share-copy').textContent = 'Copied ✓';
      setTimeout(() => { $('#share-copy').textContent = 'Copy link'; }, 1500);
    });
  });
}

async function ensurePersisted() {
  if (navigator.storage && navigator.storage.persist) {
    try { await navigator.storage.persist(); } catch (e) {}
  }
}

async function checkForStaleBundle() {
  // Fetch the live HTML (no-store), parse the app.js?v=N param, compare to ours.
  // If the server is serving a newer ?v= than we shipped with, the loaded JS is stale -> nuke and reload.
  try {
    const r = await fetch('/index.html', { cache: 'no-store' });
    if (!r.ok) return;
    const html = await r.text();
    const m = html.match(/app\.js\?v=(\d+)/);
    if (!m) return;
    const liveV = parseInt(m[1], 10);
    const myMatch = (document.currentScript && document.currentScript.src || '').match(/app\.js\?v=(\d+)/);
    const myV = myMatch ? parseInt(myMatch[1], 10) : null;
    // Fallback: scrape the actual <script> tag we came from.
    const tagSrc = (document.querySelector('script[src*="app.js"]') || {}).src || '';
    const tagMatch = tagSrc.match(/app\.js\?v=(\d+)/);
    const effective = myV != null ? myV : (tagMatch ? parseInt(tagMatch[1], 10) : null);
    if (effective != null && liveV > effective) {
      console.log(`[mgs] stale bundle (v${effective} -> v${liveV}); force-refresh`);
      try {
        if ('caches' in window) {
          const keys = await caches.keys();
          await Promise.all(keys.map(k => caches.delete(k)));
        }
        if ('serviceWorker' in navigator) {
          const regs = await navigator.serviceWorker.getRegistrations();
          await Promise.all(regs.map(r => r.unregister()));
        }
      } catch (_) {}
      window.location.reload();
    }
  } catch (_) {}
}

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  let reloading = false;
  // Reload as soon as a new SW takes control so the user is on the latest code.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
  navigator.serviceWorker.register('sw.js').then(reg => {
    // Check for updates on every page load + when tab regains focus + every 30 min.
    reg.update().catch(() => {});
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
    });
    setInterval(() => reg.update().catch(() => {}), 30 * 60 * 1000);
  }).catch(() => {});
}

// ============================================================================
// Visuals — hero, ring, body diagram, heatmap, dose timeline, side effects,
// mood, achievements, confetti, polish.
// ============================================================================

// ---------- Mood store (daily) ----------
async function getMoodsSorted() {
  return readDailySorted(STORES.moods);
}
async function saveMood(date, value) {
  await dbPut(STORES.moods, { date, value });
}

// ---------- Appetite store (daily) ----------
const APPETITE_LABELS = { 1: 'No appetite', 2: 'Low', 3: 'Normal', 4: 'Hungry', 5: 'Ravenous' };
const APPETITE_EMOJIS = { 1: '🚫', 2: '🤏', 3: '🍽️', 4: '😋', 5: '😅' };
async function getAppetitesSorted() {
  return readDailySorted('appetites');
}
// Routed through dbPut rather than a hand-rolled transaction so the write goes
// past withStore, which is what clears the cached read.
async function saveAppetite(date, value) {
  await dbPut('appetites', { date, value });
}

async function renderAppetite() {
  const today = todayISODate();
  const appetites = await getAppetitesSorted();
  const todayAppetite = appetites.find(a => a.date === today);
  const card = $('#appetite-card');
  const picker = $('#appetite-picker');
  const logged = $('#appetite-logged');
  const saved = $('#appetite-saved');
  const heading = $('#appetite-heading');
  $$('#appetite-picker .appetite-btn').forEach(b => b.classList.toggle('selected', todayAppetite && +b.dataset.appetite === todayAppetite.value));
  if (todayAppetite && !card.dataset.editing) {
    picker.classList.add('hidden');
    logged.classList.remove('hidden');
    const styleId = settings.appetiteStyle || 'classic';
    const s = APPETITE_STYLES.find(x => x.id === styleId) || APPETITE_STYLES[0];
    const lg = $('#appetite-logged-graphic');
    lg.dataset.value = String(todayAppetite.value);
    lg.innerHTML = `<span class="mood-emoji-big">${s.emojis[todayAppetite.value - 1] || '🍽️'}</span>`;
    lg.classList.add('mood-emoji-display');
    $('#appetite-logged-label').textContent = APPETITE_LABELS[todayAppetite.value] || 'Logged';
    // Restore the heading text (it was preserved as innerHTML so the (i) button stays).
    if (heading) heading.firstChild && (heading.childNodes[0].textContent = "Today's appetite ");
    if (saved) saved.textContent = '';
  } else {
    picker.classList.remove('hidden');
    logged.classList.add('hidden');
    if (heading) heading.childNodes[0] && (heading.childNodes[0].textContent = "How's your appetite today? ");
    if (saved) saved.textContent = todayAppetite ? '✓ saved' : '';
  }
  await renderAppetiteTrend(appetites);
}

async function renderAppetiteTrend(appetites) {
  const card = $('#appetite-trend-card');
  if (!card) return;
  if (!appetites || appetites.length === 0) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  const days = 30;
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - (days - 1));
  const cutoffKey = cutoff.toISOString().slice(0, 10);
  const inWindow = appetites.filter(a => a.date >= cutoffKey);
  const wrap = $('#appetite-trend-bars');
  if (!wrap) return;
  const byDate = {};
  inWindow.forEach(a => { byDate[a.date] = a.value; });
  const noteByDate = new Map((await getNotesSorted()).map(n => [n.date, n.text]));
  const bars = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const v = byDate[key];
    const note = noteByDate.get(key) || '';
    const noteCls = note ? ' has-note' : '';
    const noteTip = note ? ` — ${noteSnippet(note)}` : '';
    if (v) {
      // Color by suppression: 1-2 = strong (good for GLP-1) = teal, 3 = mid = grey, 4-5 = elevated = warning
      const cls = v <= 2 ? 'good' : v === 3 ? 'mid' : 'high';
      bars.push(`<div class="mood-bar ${cls}${noteCls}" data-date="${key}" style="height:${v * 18}%" title="${escapeHTML(`${key}: ${APPETITE_LABELS[v]} — tap to edit${noteTip}`)}"></div>`);
    } else {
      bars.push(`<div class="mood-bar empty${noteCls}" data-date="${key}" title="${escapeHTML(`${key}: not logged — tap to fill in${noteTip}`)}"></div>`);
    }
  }
  wrap.innerHTML = bars.join('');
  const avg = inWindow.reduce((s, a) => s + a.value, 0) / inWindow.length;
  const summary = $('#appetite-trend-summary');
  if (summary) summary.textContent = `Avg ${avg.toFixed(1)} · ${inWindow.length}/${days} days logged`;
}

function setupAppetiteUI() {
  // Scoped to the home card — see the mood picker note; the catch-up dialog
  // reuses .appetite-btn purely for styling.
  $$('#appetite-picker .appetite-btn').forEach(btn => btn.addEventListener('click', async () => {
    const v = parseInt(btn.dataset.appetite, 10);
    await saveAppetite(todayISODate(), v);
    delete $('#appetite-card').dataset.editing;
    await renderAppetite();
    markSyncDirty();
    track('appetite_logged', { value: v });
  }));
  const change = $('#appetite-change');
  if (change) change.addEventListener('click', (e) => {
    e.preventDefault();
    $('#appetite-card').dataset.editing = '1';
    renderAppetite();
  });
}

// ---------- Food noise (1-10 daily) ----------
// Distinct from appetite: tracks the *mental* chatter about food (intrusive
// thoughts, food obsession). Many GLP-1 users describe this quieting down
// independent of physical hunger. Lower = quieter = generally better on GLP-1.
function foodNoiseDescriptor(v) {
  if (v <= 2) return 'quiet';
  if (v <= 4) return 'mild';
  if (v <= 6) return 'moderate';
  if (v <= 8) return 'loud';
  return 'constant';
}
async function getFoodNoiseSorted() {
  return readDailySorted('foodNoise');
}
async function saveFoodNoise(date, value) {
  await dbPut('foodNoise', { date, value });
}
async function renderFoodNoise() {
  const today = todayISODate();
  const all = await getFoodNoiseSorted();
  const todayEntry = all.find(a => a.date === today);
  const card = $('#foodnoise-card');
  if (!card) return;
  const picker = $('#foodnoise-picker');
  const logged = $('#foodnoise-logged');
  const saved = $('#foodnoise-saved');
  const slider = $('#foodnoise-slider');
  const valEl = $('#foodnoise-value');
  const descEl = $('#foodnoise-descriptor');
  if (todayEntry && !card.dataset.editing) {
    picker.classList.add('hidden');
    logged.classList.remove('hidden');
    $('#foodnoise-logged-value').textContent = String(todayEntry.value);
    $('#foodnoise-logged-label').textContent = `${todayEntry.value}/10 — ${foodNoiseDescriptor(todayEntry.value)}`;
    if (saved) saved.textContent = '';
  } else {
    picker.classList.remove('hidden');
    logged.classList.add('hidden');
    if (todayEntry) {
      slider.value = String(todayEntry.value);
      valEl.textContent = String(todayEntry.value);
      descEl.textContent = foodNoiseDescriptor(todayEntry.value);
    }
    if (saved) saved.textContent = todayEntry ? '✓ saved' : '';
  }
  await renderFoodNoiseTrend(all);
}
async function renderFoodNoiseTrend(entries) {
  const card = $('#foodnoise-trend-card');
  if (!card) return;
  if (!entries || entries.length === 0) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  const days = 30;
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - (days - 1));
  const cutoffKey = cutoff.toISOString().slice(0, 10);
  const inWindow = entries.filter(a => a.date >= cutoffKey);
  const wrap = $('#foodnoise-trend-bars');
  if (!wrap) return;
  const byDate = {};
  inWindow.forEach(a => { byDate[a.date] = a.value; });
  const noteByDate = new Map((await getNotesSorted()).map(n => [n.date, n.text]));
  const bars = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const v = byDate[key];
    const note = noteByDate.get(key) || '';
    const noteCls = note ? ' has-note' : '';
    const noteTip = note ? ` — ${noteSnippet(note)}` : '';
    if (v) {
      // Color by quietness: 1-3 = good (quiet), 4-6 = mid, 7-10 = high (loud)
      const cls = v <= 3 ? 'good' : v <= 6 ? 'mid' : 'high';
      bars.push(`<div class="mood-bar ${cls}${noteCls}" data-date="${key}" style="height:${v * 9}%" title="${escapeHTML(`${key}: ${v}/10 — ${foodNoiseDescriptor(v)} — tap to edit${noteTip}`)}"></div>`);
    } else {
      bars.push(`<div class="mood-bar empty${noteCls}" data-date="${key}" title="${escapeHTML(`${key}: not logged — tap to fill in${noteTip}`)}"></div>`);
    }
  }
  wrap.innerHTML = bars.join('');
  const avg = inWindow.reduce((s, a) => s + a.value, 0) / inWindow.length;
  const summary = $('#foodnoise-trend-summary');
  if (summary) summary.textContent = `Avg ${avg.toFixed(1)}/10 · ${inWindow.length}/${days} days logged`;
}
function setupFoodNoiseUI() {
  const slider = $('#foodnoise-slider');
  const valEl = $('#foodnoise-value');
  const descEl = $('#foodnoise-descriptor');
  if (!slider) return;
  slider.addEventListener('input', () => {
    const v = parseInt(slider.value, 10);
    valEl.textContent = String(v);
    descEl.textContent = foodNoiseDescriptor(v);
  });
  $('#foodnoise-save').addEventListener('click', async () => {
    const v = parseInt(slider.value, 10);
    if (!Number.isFinite(v) || v < 1 || v > 10) return;
    await saveFoodNoise(todayISODate(), v);
    delete $('#foodnoise-card').dataset.editing;
    await renderFoodNoise();
    markSyncDirty();
    track('food_noise_logged', { value: v });
  });
  const change = $('#foodnoise-change');
  if (change) change.addEventListener('click', (e) => {
    e.preventDefault();
    $('#foodnoise-card').dataset.editing = '1';
    renderFoodNoise();
  });
}

// ---------- Daily notes (free text) ----------
// Mood, appetite and food noise record *what* a day was like. None of them record
// *why*, so a run of low days reads as a medication signal when it may have been
// a house move. A note is the context line that stops the numbers being misread
// months later, and it is the only free text in the daily check-in — so it is
// merged rather than overwritten (see mergeNotes) and never shared by default.
const NOTE_MAX = 2000;
const NOTE_AUTOSAVE_MS = 700;

async function getNotesSorted() {
  return (await readDailySorted('notes')).filter(n => n.text);
}
async function getNote(date) {
  try { return await dbGet('notes', date); } catch (_) { return null; }
}
// Clearing the box deletes the day rather than storing an empty string, so an
// emptied note doesn't linger as a blank row in the journal or the export.
async function saveNote(date, text) {
  const clean = String(text == null ? '' : text).slice(0, NOTE_MAX).trim();
  if (!clean) return deleteNote(date);
  return dbPut('notes', { date, text: clean, updatedAt: new Date().toISOString() });
}
async function deleteNote(date) { return withStore('notes', 'readwrite', s => s.delete(date)); }

// The set of days that have a note, for the trend strips to mark.
async function noteDateSet() {
  try { return new Set((await getNotesSorted()).map(n => n.date)); } catch (_) { return new Set(); }
}

function noteSnippet(text, max = 80) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

let _noteSaveTimer = null;
let _noteLastSaved = '';

async function renderNote() {
  const card = $('#note-card');
  if (!card) return;
  const box = $('#note-text');
  const saved = $('#note-saved');
  const count = $('#note-count');
  if (!box) return;
  const existing = await getNote(todayISODate());
  const text = (existing && existing.text) || '';
  // Never stomp on what someone is mid-sentence into. A re-render can be
  // triggered by a sync pull or a tab switch while the box has focus.
  if (document.activeElement !== box) box.value = text;
  _noteLastSaved = text;
  if (saved) saved.textContent = text ? '✓ saved' : '';
  if (count) count.textContent = `${box.value.length}/${NOTE_MAX}`;
  await renderNoteJournal();
}

// Commit whatever is in the box. Safe to call repeatedly — a no-op when the text
// hasn't changed, so blur-after-autosave doesn't write twice.
async function flushNote(reason) {
  const box = $('#note-text');
  if (!box) return;
  const val = box.value.slice(0, NOTE_MAX).trim();
  if (val === _noteLastSaved) return;
  await saveNote(todayISODate(), val);
  _noteLastSaved = val;
  const saved = $('#note-saved');
  if (saved) saved.textContent = val ? '✓ saved' : '';
  markSyncDirty();
  track('note_saved', { via: reason || 'auto', length: val.length });
  await renderNoteJournal();
  await renderMood();
}

function setupNoteUI() {
  const box = $('#note-text');
  if (!box) return;
  box.setAttribute('maxlength', String(NOTE_MAX));

  box.addEventListener('input', () => {
    const count = $('#note-count');
    if (count) count.textContent = `${box.value.length}/${NOTE_MAX}`;
    const saved = $('#note-saved');
    if (saved) saved.textContent = 'saving…';
    clearTimeout(_noteSaveTimer);
    _noteSaveTimer = setTimeout(() => flushNote('auto'), NOTE_AUTOSAVE_MS);
  });

  // Belt and braces: leaving the field, backgrounding the tab, or closing it all
  // commit immediately. An autosave timer that never fires because the phone was
  // locked would otherwise lose the note.
  box.addEventListener('blur', () => { clearTimeout(_noteSaveTimer); flushNote('blur'); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { clearTimeout(_noteSaveTimer); flushNote('hide'); }
  });

  const journal = $('#note-journal');
  if (journal) {
    journal.addEventListener('click', (e) => {
      const row = e.target.closest('[data-note-date]');
      if (row && row.dataset.noteDate) openCatchup(row.dataset.noteDate);
    });
  }
  const search = $('#note-search');
  if (search) search.addEventListener('input', () => renderNoteJournal());
}

// The looking-back half of the feature. A note is only worth writing if it comes
// back to you next to the day it belongs to, so each entry carries that day's
// mood alongside it.
async function renderNoteJournal() {
  const card = $('#note-journal-card');
  if (!card) return;
  const notes = (await getNotesSorted()).slice().reverse();
  if (!notes.length) {
    card.classList.add('hidden');
    return;
  }
  card.classList.remove('hidden');
  const q = ($('#note-search')?.value || '').trim().toLowerCase();
  const shown = q ? notes.filter(n => n.text.toLowerCase().includes(q)) : notes;
  const moods = await getMoodsSorted();
  const moodByDate = {};
  moods.forEach(m => { moodByDate[m.date] = m.value; });
  const styleId = settings.moodStyle || 'classic';
  const style = (MOOD_STYLES || []).find(x => x.id === styleId) || (MOOD_STYLES || [])[0];

  const summary = $('#note-journal-summary');
  if (summary) {
    summary.textContent = q
      ? `${shown.length} of ${notes.length} ${notes.length === 1 ? 'note' : 'notes'}`
      : `${notes.length} ${notes.length === 1 ? 'note' : 'notes'}`;
  }

  const wrap = $('#note-journal');
  if (!wrap) return;
  if (!shown.length) {
    wrap.innerHTML = `<p class="empty small">No notes match "${escapeHTML(q)}".</p>`;
    return;
  }
  wrap.innerHTML = shown.slice(0, 200).map(n => {
    const mv = moodByDate[n.date];
    const emoji = mv && style && style.emojis ? (style.emojis[mv - 1] || '') : '';
    const moodBit = mv
      ? `<span class="note-mood" title="Mood that day: ${escapeHTML(MOOD_LABELS[mv] || '')}">${emoji || ''}<span class="muted small">${escapeHTML(MOOD_LABELS[mv] || '')}</span></span>`
      : '';
    return `<button type="button" class="note-entry" data-note-date="${escapeHTML(n.date)}">
      <div class="note-entry-head"><strong>${escapeHTML(formatNoteDate(n.date))}</strong>${moodBit}</div>
      <div class="note-entry-text">${escapeHTML(n.text)}</div>
    </button>`;
  }).join('');
}

// "Sat 15 Mar 2026" reads better in a journal than a bare key, and a bare key is
// parsed as UTC midnight by Date — which is the timezone bug fixed elsewhere. So
// build the date from its parts and never let a timezone near it.
function formatNoteDate(key) {
  const [y, m, d] = String(key || '').split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return String(key || '');
  const dt = new Date(y, m - 1, d, 12, 0, 0);
  const today = todayISODate();
  if (key === today) return 'Today';
  if (key === shiftISODate(today, -1)) return 'Yesterday';
  try {
    return dt.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  } catch (_) { return String(key); }
}

// ---------- Catch-up: mood / appetite / food noise / note for a past day ----------
// The three home cards are today-only on purpose — one tap, no date picker, so
// the daily check-in stays a two-second job. This dialog is the escape hatch for
// the day you forgot, and doubles as the edit path for a day you got wrong.
// Reached from the home-tab link, by tapping any bar in the 30-day trend strips,
// or by tapping an entry in the notes journal.
const CATCHUP_MAX_AGE_DAYS = 730;

// Pure day-key arithmetic. Both ends are wall-clock day keys, so this deliberately
// works in UTC and never touches the user's timezone — the anchor comes from
// todayISODate(), which is already tz-aware.
function shiftISODate(key, deltaDays) {
  const [y, m, d] = (key || '').split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return key;
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().slice(0, 10);
}

async function deleteMood(date)      { return withStore(STORES.moods, 'readwrite', s => s.delete(date)); }
async function deleteAppetite(date)  { return withStore('appetites', 'readwrite', s => s.delete(date)); }
async function deleteFoodNoise(date) { return withStore('foodNoise', 'readwrite', s => s.delete(date)); }

// null = "leave this one alone"; a number = write it. Saving only touches the
// stores the user actually set, so filling in mood never wipes an existing
// appetite entry for the same day.
// `note` is '' rather than null when untouched: an empty string is a real edit
// (the user cleared the box), so it has to be distinguishable from "not loaded".
// `noteOriginal` is what was on disk when the day was loaded. Clearing a note the
// user had written is a real edit that must be saved, and without the original
// there is no way to tell "left the empty box alone" from "deleted the text".
const catchupDraft = { mood: null, appetite: null, foodNoise: null, note: '', noteOriginal: '', symptoms: null, symptomsOriginal: '' };

function catchupPaint() {
  $$('#catchup-mood-picker .mood-btn').forEach(b =>
    b.classList.toggle('selected', +b.dataset.mood === catchupDraft.mood));
  $$('#catchup-appetite-picker .appetite-btn').forEach(b =>
    b.classList.toggle('selected', +b.dataset.appetite === catchupDraft.appetite));

  const moodState = $('#catchup-mood-state');
  if (moodState) moodState.textContent = catchupDraft.mood ? MOOD_LABELS[catchupDraft.mood] : 'not logged';
  const appState = $('#catchup-appetite-state');
  if (appState) appState.textContent = catchupDraft.appetite ? APPETITE_LABELS[catchupDraft.appetite] : 'not logged';

  const fnState = $('#catchup-foodnoise-state');
  const fnVal = $('#catchup-foodnoise-value');
  const fnDesc = $('#catchup-foodnoise-descriptor');
  const slider = $('#catchup-foodnoise');
  if (catchupDraft.foodNoise) {
    if (slider) slider.value = String(catchupDraft.foodNoise);
    if (fnVal) fnVal.textContent = String(catchupDraft.foodNoise);
    if (fnDesc) fnDesc.textContent = foodNoiseDescriptor(catchupDraft.foodNoise);
    if (fnState) fnState.textContent = `${catchupDraft.foodNoise}/10`;
  } else {
    if (slider) slider.value = '5';
    if (fnVal) fnVal.textContent = '—';
    if (fnDesc) fnDesc.textContent = 'drag to set';
    if (fnState) fnState.textContent = 'not logged';
  }

  const symState = $('#catchup-symptoms-state');
  if (symState) {
    const desc = describeSe(catchupDraft.symptoms, 2);
    symState.textContent = desc || 'not logged';
  }

  const noteBox = $('#catchup-note');
  const noteState = $('#catchup-note-state');
  // Same rule as the home card: never overwrite text that is being typed.
  if (noteBox && document.activeElement !== noteBox) noteBox.value = catchupDraft.note || '';
  if (noteState) noteState.textContent = (catchupDraft.note || '').trim() ? 'written' : 'not written';
}

// Pull whatever is already stored for `date` into the draft, so the dialog opens
// as an edit of that day rather than a blank form.
async function catchupLoadDay(date) {
  const [moods, appetites, foodNoise, note] = await Promise.all([
    getMoodsSorted(), getAppetitesSorted(), getFoodNoiseSorted(), getNote(date),
  ]);
  catchupDraft.mood = (moods.find(m => m.date === date) || {}).value || null;
  catchupDraft.appetite = (appetites.find(a => a.date === date) || {}).value || null;
  catchupDraft.foodNoise = (foodNoise.find(f => f.date === date) || {}).value || null;
  catchupDraft.note = (note && note.text) || '';
  catchupDraft.noteOriginal = catchupDraft.note;
  const symRow = await getSymptomDay(date);
  catchupDraft.symptoms = (symRow && symRow.se) || null;
  catchupDraft.symptomsOriginal = JSON.stringify(catchupDraft.symptoms || {});
  writeSePicker('csym-', catchupDraft.symptoms);
  catchupPaint();
}

async function openCatchup(date) {
  const dlg = $('#catchup-dialog');
  if (!dlg) return;
  const today = todayISODate();
  const input = $('#catchup-date');
  input.max = today;
  input.min = shiftISODate(today, -CATCHUP_MAX_AGE_DAYS);
  input.value = date && date <= today ? date : shiftISODate(today, -1);
  $('#catchup-status').textContent = '';
  await catchupLoadDay(input.value);
  dlg.showModal();
}

function setupCatchupUI() {
  const dlg = $('#catchup-dialog');
  if (!dlg) return;

  $('#catchup-open')?.addEventListener('click', (e) => {
    e.preventDefault();
    openCatchup(shiftISODate(todayISODate(), -1));
  });

  // Every bar in the three trend strips is a handle on that day.
  ['#mood-trend-bars', '#appetite-trend-bars', '#foodnoise-trend-bars'].forEach(sel => {
    const wrap = $(sel);
    if (!wrap) return;
    wrap.addEventListener('click', (e) => {
      const bar = e.target.closest('.mood-bar');
      if (bar && bar.dataset.date) openCatchup(bar.dataset.date);
    });
  });

  $('#catchup-date').addEventListener('change', async (e) => {
    $('#catchup-status').textContent = '';
    await catchupLoadDay(e.target.value);
  });

  $$('#catchup-mood-picker .mood-btn').forEach(btn => btn.addEventListener('click', () => {
    const v = parseInt(btn.dataset.mood, 10);
    catchupDraft.mood = catchupDraft.mood === v ? null : v;  // tap again to unset
    catchupPaint();
  }));
  $$('#catchup-appetite-picker .appetite-btn').forEach(btn => btn.addEventListener('click', () => {
    const v = parseInt(btn.dataset.appetite, 10);
    catchupDraft.appetite = catchupDraft.appetite === v ? null : v;
    catchupPaint();
  }));
  const catchupNote = $('#catchup-note');
  if (catchupNote) {
    catchupNote.setAttribute('maxlength', String(NOTE_MAX));
    catchupNote.addEventListener('input', (e) => {
      catchupDraft.note = e.target.value.slice(0, NOTE_MAX);
      const state = $('#catchup-note-state');
      if (state) state.textContent = catchupDraft.note.trim() ? 'written' : 'not written';
    });
  }

  $('#catchup-foodnoise').addEventListener('input', (e) => {
    catchupDraft.foodNoise = parseInt(e.target.value, 10);
    catchupPaint();
  });

  renderSePicker($('#catchup-symptoms-picker'), 'csym-');
  $('#catchup-symptoms-picker')?.addEventListener('change', () => {
    catchupDraft.symptoms = readSePicker('csym-');
    catchupPaint();
  });

  $('#catchup-cancel').addEventListener('click', () => dlg.close());

  $('#catchup-clear').addEventListener('click', async () => {
    const date = $('#catchup-date').value;
    if (!date) return;
    // Spell out that a written note goes too. The other three are one tap to
    // re-enter; a paragraph about your week is not.
    const warning = catchupDraft.noteOriginal
      ? `Remove the mood, appetite, food-noise, side effects AND the written note for ${date}? The note can't be recovered.`
      : `Remove the mood, appetite, food-noise and side-effect entries for ${date}?`;
    if (!confirm(warning)) return;
    await Promise.all([deleteMood(date), deleteAppetite(date), deleteFoodNoise(date), deleteNote(date), deleteSymptomDay(date)]);
    catchupDraft.mood = catchupDraft.appetite = catchupDraft.foodNoise = null;
    catchupDraft.note = catchupDraft.noteOriginal = '';
    catchupDraft.symptoms = null;
    catchupDraft.symptomsOriginal = '{}';
    writeSePicker('csym-', null);
    catchupPaint();
    await refreshDailyCards();
    try { await renderShots(); } catch (_) {}
    markSyncDirty();
    dlg.close();
    toast(`Cleared ${date}`);
    track('catchup_cleared', {});
  });

  $('#catchup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const status = $('#catchup-status');
    const date = $('#catchup-date').value;
    const today = todayISODate();
    if (!date) { status.textContent = 'Pick a day first.'; return; }
    if (date > today) { status.textContent = "That day hasn't happened yet."; return; }
    if (date < shiftISODate(today, -CATCHUP_MAX_AGE_DAYS)) {
      status.textContent = 'That day is too far back.';
      return;
    }
    const noteChanged = (catchupDraft.note || '').trim() !== (catchupDraft.noteOriginal || '').trim();
    const symptomsChanged = JSON.stringify(catchupDraft.symptoms || {}) !== (catchupDraft.symptomsOriginal || '{}');
    if (!catchupDraft.mood && !catchupDraft.appetite && !catchupDraft.foodNoise && !noteChanged && !symptomsChanged) {
      status.textContent = 'Nothing to save — set a mood, appetite, food-noise level, side effects, or write a note.';
      return;
    }
    const writes = [];
    if (catchupDraft.mood) writes.push(saveMood(date, catchupDraft.mood));
    if (catchupDraft.appetite) writes.push(saveAppetite(date, catchupDraft.appetite));
    if (catchupDraft.foodNoise) writes.push(saveFoodNoise(date, catchupDraft.foodNoise));
    // saveNote deletes the day when the text is empty, so this handles both
    // writing a new note and clearing an existing one.
    if (noteChanged) writes.push(saveNote(date, catchupDraft.note));
    // saveSymptomDay deletes the day when nothing is selected, so clearing every
    // dropdown back to "None" removes the entry rather than storing an empty one.
    if (symptomsChanged) writes.push(saveSymptomDay(date, catchupDraft.symptoms));
    try {
      await Promise.all(writes);
      await ensurePersisted();
    } catch (ex) {
      status.textContent = 'Could not save: ' + (ex && ex.message ? ex.message : 'unknown error');
      return;
    }
    await refreshDailyCards();
    // The side-effect summary and insights are rebuilt by renderShots, so a
    // backdated symptom would otherwise not appear until the next reload.
    if (symptomsChanged) { try { await renderShots(); } catch (_) {} }
    markSyncDirty();
    dlg.close();
    toast(date === today ? 'Saved for today' : `Saved for ${date}`);
    track('catchup_saved', {
      backdated: date !== today,
      fields: [
        catchupDraft.mood ? 'mood' : null,
        catchupDraft.appetite ? 'appetite' : null,
        catchupDraft.foodNoise ? 'foodNoise' : null,
        noteChanged ? 'note' : null,
        symptomsChanged ? 'symptoms' : null,
      ].filter(Boolean).join('+'),
    });
  });
}

// Re-render the four daily cards and their trend strips together — a catch-up
// write can land on today (which changes the cards) or on any past day (which
// only changes the strips and the journal), and the caller shouldn't have to
// know which.
async function refreshDailyCards() {
  try { await renderMood(); } catch (_) {}
  try { await renderAppetite(); } catch (_) {}
  try { await renderFoodNoise(); } catch (_) {}
  try { await renderNote(); } catch (_) {}
  try { await renderSymptomsCard(); } catch (_) {}
}

// ---------- Cycle tracking (opt-in) ----------
// Privacy posture: data is stored on-device and travels through the same E2EE
// sync pipeline as everything else. The settings toggle only hides the UI —
// entries persist so a user who accidentally disables doesn't lose history.
const CYCLE_SYMPTOMS = [
  'cramps', 'bloating', 'breastTenderness', 'backPain',
  'lowMood', 'anxiety', 'irritability', 'fatigue',
  'headache', 'acne', 'foodCravings', 'sleepDisrupted',
];
const CYCLE_SYMPTOM_LABELS = {
  cramps: 'Cramps', bloating: 'Bloating', breastTenderness: 'Breast tenderness', backPain: 'Back pain',
  lowMood: 'Low mood', anxiety: 'Anxiety', irritability: 'Irritability', fatigue: 'Fatigue',
  headache: 'Headache', acne: 'Acne', foodCravings: 'Food cravings', sleepDisrupted: 'Sleep disrupted',
};
const CYCLE_FLOW_LABELS = {
  spotting: 'Spotting', light: 'Light', normal: 'Normal', heavy: 'Heavy', '': 'Not specified',
};
async function getCyclesSorted() {
  const all = (await dbAll('cycles')) || [];
  return all.sort((a, b) => (b.startDate || '').localeCompare(a.startDate || ''));  // newest first
}
async function saveCycle(c) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction('cycles', 'readwrite');
    t.objectStore('cycles').put(c);
    t.oncomplete = () => resolve(); t.onerror = () => reject(t.error);
  });
}
async function deleteCycle(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction('cycles', 'readwrite');
    t.objectStore('cycles').delete(id);
    t.oncomplete = resolve; t.onerror = () => reject(t.error);
  });
}
async function clearAllCycles() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction('cycles', 'readwrite');
    t.objectStore('cycles').clear();
    t.oncomplete = resolve; t.onerror = () => reject(t.error);
  });
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
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction('medChanges', 'readwrite');
    t.objectStore('medChanges').put(entry);
    t.oncomplete = () => resolve(); t.onerror = () => reject(t.error);
  });
}
async function deleteMedChange(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction('medChanges', 'readwrite');
    t.objectStore('medChanges').delete(id);
    t.oncomplete = resolve; t.onerror = () => reject(t.error);
  });
}
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

// ---------- Insights engine ----------
// Each insight is a function returning either:
//   null                                      → not applicable, suppress
//   { id, title, ready: false, need, premium } → not enough data yet (show grayed card)
//   { id, title, body, scrollTo, premium }    → ready, render full card
// Tone rule: descriptive, not statistical. "Most often", "tended to" — not "X% increase".
//
// Free insights operate on a single data type (shots alone, or shots+sideEffects, etc.).
// Premium insights cross multiple data types (weight × dose changes, food noise × dose decay).

function _siteCanonical(s) {
  return SITE_LEGACY_ALIAS[s] || s;
}
function _shotsByMostRecent(shots) {
  return [...shots].sort((a, b) => new Date(b.when) - new Date(a.when));
}
function _daysBetween(a, b) {
  return Math.floor((new Date(b) - new Date(a)) / 86400000);
}

// F1: Site rotation imbalance — last 6 shots, surface overdue side.
function insight_siteRotation(ctx) {
  const recent = _shotsByMostRecent(ctx.shots).filter(s => s.site).slice(0, 6);
  if (recent.length < 4) {
    return { id: 'site-rotation', title: 'Site rotation', ready: false, need: `Need ${4 - recent.length} more shots with sites logged.` };
  }
  // Group canonical sites by side.
  const sides = { Left: 0, Right: 0, Other: 0 };
  for (const s of recent) {
    const c = _siteCanonical(s.site);
    if (/Left/i.test(c)) sides.Left++;
    else if (/Right/i.test(c)) sides.Right++;
    else sides.Other++;
  }
  const dom = sides.Left > sides.Right ? 'Left' : sides.Right > sides.Left ? 'Right' : null;
  if (!dom) return null;
  const overdue = dom === 'Left' ? 'right' : 'left';
  const ratio = `${sides[dom]}/${recent.length}`;
  return {
    id: 'site-rotation',
    title: 'Site rotation looks one-sided',
    body: `Your last ${recent.length} shots used the ${dom.toLowerCase()} side ${ratio}. The ${overdue} side may be the freshest pick next.`,
    scrollTo: '#body-diagram-wrap',
    premium: false,
  };
}

// The measured version of the nausea-timing insight: for each standalone symptom
// day that reported the target effect, count the days since the last shot before
// it. Returns null when there isn't enough of that data to beat the heuristic.
function insight_nauseaDayFromDailyLogs(ctx, targetSE) {
  const standalone = (ctx.seEntries || []).filter(e => !e.fromShot && e.se[targetSE]);
  if (standalone.length < 4) return null;
  const shotTimes = ctx.shots
    .map(s => new Date(s.when).getTime())
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (shotTimes.length < 2) return null;
  const cadence = settings.cadenceDays || 7;
  const buckets = [];
  for (const e of standalone) {
    let prev = null;
    for (const t of shotTimes) { if (t <= e.at) prev = t; else break; }
    if (prev == null) continue;
    const days = Math.floor((e.at - prev) / 86400000);
    // Beyond a cycle-and-a-bit the "days since shot" number stops meaning
    // anything — that's a missed shot, not a late-cycle symptom.
    if (days >= 0 && days <= cadence + 2) buckets.push(days);
  }
  if (buckets.length < 4) return null;
  const counts = {};
  for (const d of buckets) counts[d] = (counts[d] || 0) + 1;
  let peakDay = null, peakN = 0;
  for (const [d, n] of Object.entries(counts)) if (n > peakN) { peakN = n; peakDay = Number(d); }
  const avg = buckets.reduce((a, b) => a + b, 0) / buckets.length;
  const dayLabel = peakDay === 0 ? 'the day of your shot'
                 : peakDay === 1 ? 'the day after your shot'
                 : `day ${peakDay} after your shot`;
  return {
    id: 'nausea-day',
    title: 'When nausea tends to show up',
    body: `Across ${buckets.length} days where you logged nausea, it landed most often on <strong>${dayLabel}</strong> (${peakN} of ${buckets.length}), averaging ${avg.toFixed(1)} days after a shot.`,
    scrollTo: '#side-effects-summary',
    premium: false,
  };
}

// F2: Nausea timing relative to shot — which day-since-shot has the most nausea.
//
// Two modes. Standalone symptom days carry a real date, so when enough of them
// exist we can measure the actual day-since-shot the nausea landed on. Before
// that store existed the only signal was the shot record itself, which is dated
// to the injection — so the old heuristic below inferred cycle position from the
// gap between shots. That fallback stays for anyone whose history predates
// per-day logging.
function insight_nauseaDay(ctx) {
  const targetSE = 'nausea';
  const real = insight_nauseaDayFromDailyLogs(ctx, targetSE);
  if (real) return real;
  const eligible = ctx.shots.filter(s => s.sideEffects && s.sideEffects[targetSE]);
  if (eligible.length < 4) {
    return { id: 'nausea-day', title: 'Nausea timing', ready: false, need: `Need ${4 - eligible.length} more shots with nausea logged to spot a pattern.` };
  }
  const cadence = settings.cadenceDays || 7;
  const gaps = [];
  const sorted = [...ctx.shots].sort((a, b) => new Date(a.when) - new Date(b.when));
  for (let i = 0; i < sorted.length; i++) {
    if (!sorted[i].sideEffects || !sorted[i].sideEffects[targetSE]) continue;
    if (i === 0) continue;
    const gap = _daysBetween(sorted[i - 1].when, sorted[i].when);
    if (gap > 0 && gap <= cadence + 3) gaps.push(gap);
  }
  if (gaps.length < 3) {
    return { id: 'nausea-day', title: 'Nausea timing', ready: false, need: `Need ${3 - gaps.length} more shots with nausea logged.` };
  }
  const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const phase = avgGap <= cadence * 0.4 ? 'early in your cycle (shortly after a shot)'
              : avgGap <= cadence * 0.75 ? 'in the middle of your cycle'
              : 'late in your cycle (closer to the next shot)';
  return {
    id: 'nausea-day',
    title: 'When nausea tends to show up',
    body: `Across ${gaps.length} shots where you logged nausea, it most often appeared <strong>${phase}</strong>. (Heuristic based on gaps between shots — about ${avgGap.toFixed(1)} days into the cycle on average.)`,
    scrollTo: '#side-effects-summary',
    premium: false,
  };
}

// F3: Mood trend by day-since-shot — when do you feel best?
function insight_moodByDay(ctx) {
  if (!ctx.moods || ctx.moods.length < 8) {
    return { id: 'mood-day', title: 'Mood across the dose cycle', ready: false, need: `Need ${Math.max(0, 8 - (ctx.moods?.length || 0))} more days of mood logging.` };
  }
  const cadence = settings.cadenceDays || 7;
  // For each mood entry, find the most recent shot before it; bucket by days-since.
  const sortedShots = [...ctx.shots].sort((a, b) => new Date(a.when) - new Date(b.when));
  const buckets = {};  // dayBucket → [moodValues]
  for (const m of ctx.moods) {
    const md = new Date(m.date);
    let lastShot = null;
    for (const s of sortedShots) {
      if (new Date(s.when) <= md) lastShot = s; else break;
    }
    if (!lastShot) continue;
    const days = _daysBetween(lastShot.when, m.date);
    if (days < 0 || days > cadence + 1) continue;
    const bucket = days <= 1 ? 'early' : days < cadence - 1 ? 'middle' : 'late';
    (buckets[bucket] = buckets[bucket] || []).push(m.value);
  }
  if (Object.keys(buckets).length < 2) {
    return { id: 'mood-day', title: 'Mood across the dose cycle', ready: false, need: `Need a few more mood entries spanning the dose cycle.` };
  }
  const avgs = Object.entries(buckets).map(([k, vs]) => [k, vs.reduce((a, b) => a + b, 0) / vs.length]);
  avgs.sort((a, b) => b[1] - a[1]);
  const bestK = avgs[0][0];
  const phaseLabel = bestK === 'early' ? 'in the first day or two after a shot' : bestK === 'late' ? 'late in your dose cycle' : 'in the middle of your cycle';
  return {
    id: 'mood-day',
    title: 'When you tend to feel best',
    body: `Looking at ${ctx.moods.length} mood entries, your mood has been highest <strong>${phaseLabel}</strong> on average. This is descriptive — many things affect mood, not just the medication.`,
    scrollTo: '#mood-trend-card',
    premium: false,
  };
}

// F4: Food noise pattern — when does it return relative to the shot?
function insight_foodNoiseReturn(ctx) {
  const fn = ctx.foodNoise || [];
  if (fn.length < 8) {
    return { id: 'foodnoise-return', title: 'Food noise return point', ready: false, need: `Need ${Math.max(0, 8 - fn.length)} more food noise entries.` };
  }
  const cadence = settings.cadenceDays || 7;
  const sortedShots = [...ctx.shots].sort((a, b) => new Date(a.when) - new Date(b.when));
  // For each food noise reading, find day-since-last-shot.
  const buckets = Array(cadence + 1).fill(null).map(() => []);
  for (const f of fn) {
    const fd = new Date(f.date);
    let lastShot = null;
    for (const s of sortedShots) {
      if (new Date(s.when) <= fd) lastShot = s; else break;
    }
    if (!lastShot) continue;
    const days = _daysBetween(lastShot.when, f.date);
    if (days >= 0 && days <= cadence) buckets[days].push(f.value);
  }
  // Find the first day where average crosses the "loud" line (>= 6/10).
  const avgs = buckets.map(vs => vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : null);
  const returnDay = avgs.findIndex((v, i) => i > 0 && v != null && v >= 6);
  if (returnDay < 0) {
    return {
      id: 'foodnoise-return',
      title: 'Food noise stays quiet across your cycle',
      body: `Across ${fn.length} food-noise entries, the average has stayed at or below 5/10 throughout the dose cycle — the medication is keeping the noise quiet for the full week.`,
      scrollTo: '#foodnoise-trend-card',
      premium: false,
    };
  }
  return {
    id: 'foodnoise-return',
    title: 'Food noise tends to return mid-cycle',
    body: `Your food noise has tended to climb past <strong>5/10 around day ${returnDay}</strong> after a shot. This is the day to watch if it keeps repeating.`,
    scrollTo: '#foodnoise-trend-card',
    premium: false,
  };
}

// F6: Cadence drift — average gap between recent shots vs scheduled cadence.
function insight_cadenceDrift(ctx) {
  if (ctx.shots.length < 4) {
    return { id: 'cadence-drift', title: 'Cadence drift', ready: false, need: `Need ${4 - ctx.shots.length} more shots.` };
  }
  const cadence = settings.cadenceDays || 7;
  const sorted = [...ctx.shots].sort((a, b) => new Date(a.when) - new Date(b.when));
  const recent = sorted.slice(-5);  // last 5 chronologically
  const gaps = [];
  for (let i = 1; i < recent.length; i++) {
    const g = (new Date(recent[i].when) - new Date(recent[i - 1].when)) / 86400000;
    if (g > 0 && g < 60) gaps.push(g);
  }
  if (gaps.length < 3) return null;
  const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const drift = avg - cadence;
  // Flag if drifted more than 1 day in either direction.
  if (Math.abs(drift) < 1) {
    return {
      id: 'cadence-drift',
      title: 'You\'re right on cadence',
      body: `Your last ${gaps.length + 1} shots have averaged <strong>${avg.toFixed(1)} days apart</strong> — within a day of your scheduled ${cadence}-day cadence.`,
      scrollTo: '#dose-timeline-wrap',
      premium: false,
    };
  }
  const direction = drift > 0 ? 'later' : 'earlier';
  return {
    id: 'cadence-drift',
    title: `Recent shots have drifted ${direction} than scheduled`,
    body: `Your last ${gaps.length + 1} shots have averaged <strong>${avg.toFixed(1)} days apart</strong> vs your scheduled ${cadence}-day cadence — about <strong>${Math.abs(drift).toFixed(1)} days ${direction}</strong> on average. ${drift > 0 ? 'If this is unintentional, set a stronger reminder.' : 'Going early can stack levels — worth checking with your prescriber.'}`,
    scrollTo: '#dose-timeline-wrap',
    premium: false,
  };
}

// F5: Dose-hold prompt — last several shots at the same max dose, with side-effects settled.
function insight_doseHold(ctx) {
  if (ctx.shots.length < 4) {
    return { id: 'dose-hold', title: 'Dose pattern', ready: false, need: `Need ${4 - ctx.shots.length} more shots.` };
  }
  const recent = _shotsByMostRecent(ctx.shots).slice(0, 4);
  const doses = recent.map(s => s.dose);
  const allSame = doses.every(d => d === doses[0]);
  if (!allSame) return null;
  // Count "severe" tags since the oldest of those 4 shots — including symptoms
  // logged on days without an injection.
  const windowStart = Math.min(...recent.map(s => new Date(s.when).getTime()));
  const severeCount = (ctx.seEntries || [])
    .filter(e => e.at >= windowStart)
    .reduce((acc, e) => acc + Object.values(e.se).filter(v => v === 'severe').length, 0);
  if (severeCount > 0) {
    return {
      id: 'dose-hold',
      title: 'Side effects to discuss before titrating',
      body: `Your last 4 shots have all been at <strong>${doses[0]} mg</strong>, and you've logged severe side effects in that window. Some users hold or step down; your prescriber is the right person to plan the next move.`,
      scrollTo: '#side-effects-summary',
      premium: false,
    };
  }
  return {
    id: 'dose-hold',
    title: 'Holding steady at this dose',
    body: `Your last 4 shots have been at <strong>${doses[0]} mg</strong> with no severe side effects logged. If your weight progress and prescriber agree, you're in a stable patch.`,
    scrollTo: '#dose-timeline-wrap',
    premium: false,
  };
}

// PREMIUM I1: Weight loss × dose changes — does loss accelerate after dose increases?
function insight_weightAfterDose(ctx) {
  const weights = (ctx.weights || []).slice().sort((a, b) => new Date(a.date) - new Date(b.date));
  const shots = ctx.shots.slice().sort((a, b) => new Date(a.when) - new Date(b.when));
  if (weights.length < 8 || shots.length < 4) {
    return { id: 'weight-x-dose', title: 'Weight loss after dose increases', ready: false, need: `Need at least 8 weights and 4 shots.`, premium: true };
  }
  // Find dose-increase events.
  const increases = [];
  for (let i = 1; i < shots.length; i++) {
    if (shots[i].dose > shots[i - 1].dose) increases.push(shots[i]);
  }
  if (!increases.length) return null;
  // For each increase, look at average weekly slope before vs after (28d window).
  const slopeAround = (anchorDate) => {
    const window = 28 * 86400000;
    const before = weights.filter(w => {
      const t = new Date(w.date).getTime();
      return t >= anchorDate.getTime() - window && t < anchorDate.getTime();
    });
    const after = weights.filter(w => {
      const t = new Date(w.date).getTime();
      return t > anchorDate.getTime() && t <= anchorDate.getTime() + window;
    });
    const slope = (rows) => {
      if (rows.length < 2) return null;
      const first = rows[0], last = rows[rows.length - 1];
      const days = (new Date(last.date) - new Date(first.date)) / 86400000;
      if (days < 7) return null;
      return (last.value - first.value) / (days / 7);  // lb per week
    };
    return { before: slope(before), after: slope(after) };
  };
  const slopes = increases.map(s => slopeAround(new Date(s.when))).filter(s => s.before != null && s.after != null);
  if (slopes.length < 2) {
    return { id: 'weight-x-dose', title: 'Weight loss after dose increases', ready: false, need: `Need more weight entries around dose-increase events.`, premium: true };
  }
  const avgBefore = slopes.reduce((a, b) => a + b.before, 0) / slopes.length;
  const avgAfter = slopes.reduce((a, b) => a + b.after, 0) / slopes.length;
  const direction = avgAfter < avgBefore ? 'faster' : avgAfter > avgBefore ? 'slower' : 'similar';
  if (direction === 'similar') return null;
  return {
    id: 'weight-x-dose',
    title: 'Weight loss tends to be ' + direction + ' after dose increases',
    body: `Across ${slopes.length} dose increases, your weight trend in the 4 weeks after has been <strong>${direction}</strong> than the 4 weeks before, on average. Past patterns ≠ future, and many factors affect weight — this is descriptive, not predictive.`,
    scrollTo: '#weight-chart',
    premium: true,
  };
}

// PREMIUM I2: Cycle × side effects — symptom prevalence on cycle days 1-3 vs other days.
function insight_cycleSideEffects(ctx) {
  if (!settings.cycleEnabled) return null;
  const cycles = ctx.cycles || [];
  if (cycles.length < 3) {
    return { id: 'cycle-x-se', title: 'Cycle × side effects', ready: false, need: `Need ${3 - cycles.length} more logged cycles.`, premium: true };
  }
  // Days that fall within cycle days 1-3 (inclusive of start date).
  const inEarlyCycle = (when) => {
    const d = new Date(when);
    return cycles.some(c => {
      const start = new Date(c.startDate);
      const diff = Math.floor((d - start) / 86400000);
      return diff >= 0 && diff <= 2;
    });
  };
  // For each side-effect tag, count occurrence inside vs outside cycle days 1-3.
  const totals = {};
  let earlyDays = 0, otherDays = 0;
  // One observation per day, from either source — otherwise a day with both a
  // shot and a standalone entry would be double-counted.
  const byDay = new Map();
  for (const e of (ctx.seEntries || [])) {
    const prev = byDay.get(e.date);
    byDay.set(e.date, prev ? { ...prev, ...e.se } : { ...e.se });
  }
  for (const [date, se] of byDay) {
    const inEarly = inEarlyCycle(date + 'T12:00:00');
    if (inEarly) earlyDays++; else otherDays++;
    for (const [k, lvl] of Object.entries(se)) {
      if (!lvl) continue;
      totals[k] = totals[k] || { early: 0, other: 0 };
      if (inEarly) totals[k].early++; else totals[k].other++;
    }
  }
  if (earlyDays < 2 || otherDays < 4) {
    return { id: 'cycle-x-se', title: 'Cycle × side effects', ready: false, need: `Need more days logged across both cycle phases.`, premium: true };
  }
  // Find the symptom with the largest relative bump on cycle days 1-3.
  let bestK = null, bestRatio = 1;
  for (const [k, c] of Object.entries(totals)) {
    if (c.early < 1) continue;
    const earlyRate = c.early / earlyDays;
    const otherRate = c.other / Math.max(1, otherDays);
    const ratio = earlyRate / Math.max(0.01, otherRate);
    if (ratio > bestRatio) { bestRatio = ratio; bestK = k; }
  }
  if (!bestK || bestRatio < 1.4) {
    return {
      id: 'cycle-x-se',
      title: 'No clear cycle pattern in side effects yet',
      body: `Across ${cycles.length} logged cycles, side-effect rates on cycle days 1-3 look similar to other days. We'll keep watching as you log more.`,
      scrollTo: '#cycle-card',
      premium: true,
    };
  }
  const label = (SIDE_EFFECTS.find(s => s[0] === bestK) || [bestK, bestK])[1];
  return {
    id: 'cycle-x-se',
    title: `${label} has shown up more on cycle days 1-3`,
    body: `In your last ${cycles.length} cycles, <strong>${label}</strong> was logged more often on cycle days 1-3 than on other days. Worth raising with your prescriber if it's bothering you.`,
    scrollTo: '#cycle-card',
    premium: true,
  };
}

// PREMIUM I3: Food noise return × dose decay — does food noise return as the level drops below 50%?
function insight_foodNoiseDecay(ctx) {
  const fn = ctx.foodNoise || [];
  if (fn.length < 12 || ctx.shots.length < 4) {
    return { id: 'foodnoise-decay', title: 'Food noise vs dose decay', ready: false, need: `Need at least 12 food noise entries and 4 shots.`, premium: true };
  }
  const halfLife = settings.halfLifeDays || 5;
  const sortedShots = [...ctx.shots].sort((a, b) => new Date(a.when) - new Date(b.when));
  const samples = [];
  for (const f of fn) {
    const fd = new Date(f.date);
    let lastShot = null;
    for (const s of sortedShots) {
      if (new Date(s.when) <= fd) lastShot = s; else break;
    }
    if (!lastShot) continue;
    const days = _daysBetween(lastShot.when, f.date);
    if (days < 0 || days > 14) continue;
    const fraction = Math.pow(0.5, days / halfLife);  // remaining fraction of last dose
    samples.push({ frac: fraction, noise: f.value });
  }
  if (samples.length < 8) {
    return { id: 'foodnoise-decay', title: 'Food noise vs dose decay', ready: false, need: `Need more overlapping food-noise + shot entries.`, premium: true };
  }
  // Compare avg noise above vs below the 50% level mark.
  const above = samples.filter(s => s.frac >= 0.5);
  const below = samples.filter(s => s.frac < 0.5);
  if (above.length < 3 || below.length < 3) return null;
  const avgAbove = above.reduce((a, b) => a + b.noise, 0) / above.length;
  const avgBelow = below.reduce((a, b) => a + b.noise, 0) / below.length;
  const diff = avgBelow - avgAbove;
  if (Math.abs(diff) < 1) {
    return {
      id: 'foodnoise-decay',
      title: 'Food noise is steady across the dose cycle',
      body: `Whether the medication is at peak (≥50% of last dose) or fading (<50%), your food noise scores have averaged about the same. The medication appears to keep noise quiet for the full week.`,
      scrollTo: '#level-chart',
      premium: true,
    };
  }
  if (diff > 0) {
    return {
      id: 'foodnoise-decay',
      title: 'Food noise rises as the medication fades',
      body: `When the active medication is above ~50% of your last dose, food noise has averaged <strong>${avgAbove.toFixed(1)}/10</strong>. Once it drops below 50%, the average is <strong>${avgBelow.toFixed(1)}/10</strong>. That gap (~${diff.toFixed(1)} points) is consistent with the dose's pharmacokinetic decay.`,
      scrollTo: '#level-chart',
      premium: true,
    };
  }
  return null;
}

const FREE_INSIGHTS = [insight_siteRotation, insight_cadenceDrift, insight_nauseaDay, insight_moodByDay, insight_foodNoiseReturn, insight_doseHold];
const PREMIUM_INSIGHTS = [insight_weightAfterDose, insight_cycleSideEffects, insight_foodNoiseDecay];

async function computeInsights() {
  const shots = await getShotsSorted();
  const moods = await getMoodsSorted();
  const appetites = await getAppetitesSorted();
  const foodNoise = await getFoodNoiseSorted();
  const weights = await getWeightsSorted();
  const cycles = await getCyclesSorted();
  // Side effects come from shots AND standalone symptom days; insights read the
  // merged list so a symptom logged on a rest day still counts.
  const seEntries = await collectSideEffectEntries(shots);
  const ctx = { shots, moods, appetites, foodNoise, weights, cycles, seEntries };
  const free = FREE_INSIGHTS.map(fn => { try { return fn(ctx); } catch (e) { console.warn('insight error', e); return null; } }).filter(Boolean);
  const premium = PREMIUM_INSIGHTS.map(fn => { try { return fn(ctx); } catch (e) { console.warn('insight error', e); return null; } }).filter(Boolean);
  return { free, premium };
}

async function renderInsights() {
  const list = $('#insights-list');
  const empty = $('#insights-empty');
  const summary = $('#insights-summary');
  if (!list) return;
  const { free, premium } = await computeInsights();
  const all = [...free, ...premium];
  if (!all.length) { list.innerHTML = ''; empty.classList.remove('hidden'); summary.textContent = ''; return; }
  empty.classList.add('hidden');
  const ready = all.filter(i => !('ready' in i) || i.ready !== false).length;
  summary.textContent = `${ready}/${all.length} ready`;
  const renderCard = (i) => {
    const isPremiumCard = !!i.premium;
    const locked = isPremiumCard && !isPremium();
    if ('ready' in i && i.ready === false) {
      return `<div class="insight-card pending${isPremiumCard ? ' is-premium' : ''}">
        <div class="insight-head"><strong>${escapeHTML(i.title)}</strong>${isPremiumCard ? '<span class="lock-pill">Premium</span>' : ''}</div>
        <p class="muted small">${escapeHTML(i.need || 'Not enough data yet.')}</p>
      </div>`;
    }
    if (locked) {
      // Use a stable generic title — the dynamic title can leak the finding
      // itself ("Food noise rises as the medication fades"), defeating the gate.
      const LOCKED_TITLES = {
        'weight-x-dose': 'Weight loss after dose increases',
        'cycle-x-se':    'Cycle × side effects',
        'foodnoise-decay': 'Food noise vs dose decay',
      };
      const lockedTitle = LOCKED_TITLES[i.id] || 'Premium pattern';
      return `<button type="button" class="insight-card locked is-premium" data-insight-locked="1">
        <div class="insight-head"><strong>${escapeHTML(lockedTitle)}</strong><span class="lock-pill">Premium</span></div>
        <p class="muted small">A pattern was detected in your data. Unlock cross-data patterns (weight × dose, food noise × dose decay, cycle × side effects) with Premium.</p>
      </button>`;
    }
    const scrollAttr = i.scrollTo ? ` data-insight-scroll="${escapeHTML(i.scrollTo)}"` : '';
    return `<button type="button" class="insight-card${isPremiumCard ? ' is-premium' : ''}"${scrollAttr}>
      <div class="insight-head"><strong>${escapeHTML(i.title)}</strong>${isPremiumCard ? '<span class="lock-pill">Premium</span>' : ''}</div>
      <p>${i.body}</p>
    </button>`;
  };
  list.innerHTML = all.map(renderCard).join('');
  // Wire interactions.
  list.querySelectorAll('[data-insight-scroll]').forEach(el => {
    el.addEventListener('click', () => {
      const target = document.querySelector(el.getAttribute('data-insight-scroll'));
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  });
  list.querySelectorAll('[data-insight-locked]').forEach(el => {
    el.addEventListener('click', () => {
      const dlg = document.getElementById('upgrade-dialog');
      if (dlg) dlg.showModal();
    });
  });
}

// ---------- Stats helpers ----------
function computeStreak(shots, cadenceDays) {
  // Count consecutive cadence cycles from latest backwards. A "cycle" = a shot
  // logged within cadenceDays + 2 grace days of the previous one.
  if (!shots || !shots.length) return 0;
  const sorted = [...shots].sort((a,b) => new Date(b.when) - new Date(a.when));
  const grace = (cadenceDays + 2) * 86400000;
  // First, ensure most recent shot is within grace of now
  if (new Date() - new Date(sorted[0].when) > grace) return 0;
  let streak = 1;
  for (let i = 1; i < sorted.length; i++) {
    const gap = new Date(sorted[i-1].when) - new Date(sorted[i].when);
    if (gap <= grace) streak++;
    else break;
  }
  return streak;
}

function weightDelta(weights, startOverride) {
  if (!weights || weights.length < 1) return null;
  const start = startOverride != null ? parseFloat(startOverride) : weights[0].value;
  const current = weights[weights.length - 1].value;
  return { start, current, delta: current - start };
}

// ---------- Hero card ----------
async function renderHero(shots, weights) {
  const card = $('#hero-card');
  if (!shots.length && !weights.length) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  const wd = weightDelta(weights, settings.startWeight);
  const deltaEl = $('#hero-weight-delta');
  if (wd) {
    const sign = wd.delta < 0 ? '−' : '+';
    deltaEl.textContent = `${sign}${Math.abs(wd.delta).toFixed(1)} lb`;
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
      ? `🎯 Maintenance · ${wd.current.toFixed(1)} lb (${drift >= 0 ? '+' : ''}${drift.toFixed(1)} from ${goal} lb goal)`
      : `🎯 Maintenance · staying at ${wd.current.toFixed(1)} lb`;
    $('#hero-goal-wrap').classList.remove('hidden');
  } else if (wd && goal && goal < wd.start) {
    const total = wd.start - goal;
    const done = wd.start - wd.current;
    const pct = Math.max(0, Math.min(100, (done / total) * 100));
    $('#hero-goal-fill').style.width = pct + '%';
    $('#hero-goal-text').textContent = `Goal: ${goal} lb · ${pct.toFixed(0)}% there (${(wd.current - goal).toFixed(1)} lb to go)`;
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

// ---------- Side effects ----------
//
// Side effects live in two places, and both are first-class:
//   * shot.sideEffects  — what happened around an injection
//   * the 'symptoms' store — a date-keyed entry for a day with no shot
//
// The second exists because the daily "Side effects check-in" reminder fires
// every evening, and until now the only way to answer it was to log a shot.
// Everything downstream (the 30-day summary, insights, the PDF, the doctor
// share) reads through collectSideEffectEntries so neither source is invisible.

async function getSymptomDaysSorted() {
  return (await readDailySorted('symptoms')).filter(r => r.se && Object.keys(r.se).length);
}
async function getSymptomDay(date) {
  try { return await dbGet('symptoms', date); } catch (_) { return null; }
}
async function saveSymptomDay(date, se) {
  const clean = sanitizeSideEffectMap(se) || {};
  // Drop "None" selections so an all-clear day doesn't masquerade as data.
  for (const k of Object.keys(clean)) if (!clean[k]) delete clean[k];
  if (!Object.keys(clean).length) return deleteSymptomDay(date);
  return dbPut('symptoms', { date, se: clean, updatedAt: new Date().toISOString() });
}
async function deleteSymptomDay(date) {
  return withStore('symptoms', 'readwrite', s => s.delete(date));
}
function sanitizeSymptomDay(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const date = safeText(raw.date, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const se = sanitizeSideEffectMap(raw.se) || {};
  for (const k of Object.keys(se)) if (!se[k]) delete se[k];
  if (!Object.keys(se).length) return null;
  return { date, se, updatedAt: safeText(raw.updatedAt, 40) || new Date().toISOString() };
}

// One flat list of every side-effect observation, from either source.
// Each entry: { date: 'YYYY-MM-DD', at: ms, se: {key: level}, fromShot: bool }.
async function collectSideEffectEntries(shots) {
  const rows = Array.isArray(shots) ? shots : ((await dbAll(STORES.shots)) || []);
  const out = [];
  for (const s of rows) {
    if (!s || !s.sideEffects) continue;
    const at = new Date(s.when).getTime();
    if (!Number.isFinite(at)) continue;
    const date = toCanonicalDate(s.when);
    if (!date) continue;
    out.push({ date, at, se: s.sideEffects, fromShot: true });
  }
  let days = [];
  try { days = await getSymptomDaysSorted(); } catch (_) {}
  for (const d of days) {
    const at = new Date(d.date + 'T12:00:00').getTime();
    if (!Number.isFinite(at)) continue;
    out.push({ date: d.date, at, se: d.se, fromShot: false });
  }
  return out.sort((a, b) => a.at - b.at);
}

// Render the grouped severity picker into any container. Used by the shot form,
// the standalone symptoms dialog, and the catch-up dialog — one taxonomy, one
// layout, three entry points. `prefix` namespaces the element ids.
function renderSePicker(wrap, prefix) {
  if (!wrap) return;
  wrap.innerHTML = SE_GROUPS.map(([gid, gname]) => {
    const rows = SIDE_EFFECTS.filter(([, , g]) => g === gid).map(([key, label]) =>
      `<div class="se-row"><label for="${prefix}${key}">${label}</label>
         <select id="${prefix}${key}" data-se="${key}">${SE_LEVELS.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select></div>`
    ).join('');
    if (!rows) return '';
    return `<div class="se-group"><h4 class="se-group-title">${gname}</h4>${rows}</div>`;
  }).join('');
}
function readSePicker(prefix) {
  const obj = {};
  for (const [key] of SIDE_EFFECTS) {
    const v = $('#' + prefix + key)?.value;
    if (v) obj[key] = v;
  }
  return Object.keys(obj).length ? obj : null;
}
function writeSePicker(prefix, se) {
  for (const [key] of SIDE_EFFECTS) {
    const el = $('#' + prefix + key);
    if (el) el.value = (se && se[key]) || '';
  }
}
// A short "Nausea (moderate) · Fatigue (mild)" line for a severity map.
function describeSe(se, max = 3) {
  const labelOf = (k) => (SIDE_EFFECTS.find(x => x[0] === k) || [k, k])[1];
  const rank = { severe: 3, moderate: 2, mild: 1 };
  const list = Object.entries(se || {})
    .filter(([, v]) => v)
    .sort((a, b) => (rank[b[1]] || 0) - (rank[a[1]] || 0));
  if (!list.length) return '';
  const shown = list.slice(0, max).map(([k, v]) => `${labelOf(k)} (${v})`).join(' · ');
  return list.length > max ? `${shown} +${list.length - max} more` : shown;
}

function renderSideEffectsForm() {
  const wrap = $('#shot-side-effects');
  if (!wrap) return;
  renderSePicker(wrap, 'se-');
}
function readSideEffects() { return readSePicker('se-'); }
function writeSideEffects(se) { writeSePicker('se-', se); }
// ---------- Symptoms card (standalone daily entry) ----------
let _symptomsDialogDate = null;

async function renderSymptomsCard() {
  const card = $('#symptoms-card');
  if (!card) return;
  const today = todayISODate();
  const row = await getSymptomDay(today);
  const se = (row && row.se) || null;
  const logged = !!(se && Object.keys(se).length);
  const summary = $('#symptoms-today');
  const btn = $('#symptoms-log-btn');
  card.classList.toggle('logged', logged);
  if (summary) {
    summary.textContent = logged ? describeSe(se) : 'Nothing logged today.';
    summary.classList.toggle('muted', !logged);
  }
  if (btn) btn.textContent = logged ? 'Edit today' : 'Log symptoms';
}

function openSymptomsDialog(date) {
  const dlg = $('#symptoms-dialog');
  if (!dlg) return;
  _symptomsDialogDate = date || todayISODate();
  const dateInput = $('#symptoms-date');
  if (dateInput) { dateInput.value = _symptomsDialogDate; dateInput.max = todayISODate(); }
  renderSePicker($('#symptoms-picker'), 'sym-');
  getSymptomDay(_symptomsDialogDate).then(row => writeSePicker('sym-', row && row.se));
  if (!dlg.open) dlg.showModal();
}

function setupSymptomsUI() {
  renderSePicker($('#symptoms-picker'), 'sym-');
  $('#symptoms-log-btn')?.addEventListener('click', () => openSymptomsDialog(todayISODate()));
  $('#symptoms-cancel')?.addEventListener('click', () => $('#symptoms-dialog')?.close());
  $('#symptoms-date')?.addEventListener('change', (e) => {
    const v = e.target.value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return;
    _symptomsDialogDate = v;
    getSymptomDay(v).then(row => writeSePicker('sym-', row && row.se));
  });
  $('#symptoms-clear')?.addEventListener('click', async () => {
    const date = _symptomsDialogDate || todayISODate();
    await deleteSymptomDay(date);
    markSyncDirty();
    writeSePicker('sym-', null);
    await renderSymptomsCard();
    await renderShots();
    toast('Symptoms cleared for that day.');
    $('#symptoms-dialog')?.close();
  });
  $('#symptoms-save')?.addEventListener('click', async () => {
    const date = _symptomsDialogDate || todayISODate();
    const se = readSePicker('sym-');
    await saveSymptomDay(date, se);
    markSyncDirty();
    await renderSymptomsCard();
    // The 30-day summary and insights both read symptom days now, so they have
    // to be recomputed or the entry looks like it vanished.
    await renderShots();
    toast(se ? 'Symptoms saved.' : 'Symptoms cleared for that day.');
    $('#symptoms-dialog')?.close();
  });
}

async function renderSideEffectsSummary(shots) {
  const cutoff = Date.now() - 30 * 86400000;
  const counts = {};
  const entries = await collectSideEffectEntries(shots);
  for (const e of entries) {
    if (e.at < cutoff) continue;
    for (const [k, lvl] of Object.entries(e.se)) {
      if (!lvl) continue;
      counts[k] = counts[k] || { mild: 0, moderate: 0, severe: 0 };
      if (counts[k][lvl] != null) counts[k][lvl]++;
    }
  }
  const labelOf = (k) => (SIDE_EFFECTS.find(s => s[0] === k) || [k, k])[1];
  const groupOf = (k) => (SIDE_EFFECTS.find(s => s[0] === k) || [k, k, 'other'])[2];
  // Bucket counts by group so each category has its own row of pills.
  const byGroup = {};
  for (const [k, c] of Object.entries(counts)) {
    const g = groupOf(k);
    (byGroup[g] = byGroup[g] || []).push([k, c]);
  }
  const wrap = $('#side-effects-summary');
  const empty = $('#empty-side-effects');
  if (!wrap || !empty) return;
  if (!Object.keys(byGroup).length) { wrap.innerHTML = ''; empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');
  const sortPills = (a, b) => {
    const ts = (c) => c.severe * 4 + c.moderate * 2 + c.mild;
    return ts(b[1]) - ts(a[1]);
  };
  wrap.innerHTML = SE_GROUPS.filter(([gid]) => byGroup[gid]).map(([gid, gname]) => {
    const pills = byGroup[gid].sort(sortPills).map(([k, c]) => {
      const total = c.mild + c.moderate + c.severe;
      const cls = c.severe > 0 ? 'severe' : '';
      const dots = '●'.repeat(Math.min(3, c.severe)) + '◐'.repeat(Math.min(3, c.moderate)) + '○'.repeat(Math.min(3, c.mild));
      // labelOf falls back to the raw key when it isn't in the taxonomy, and
      // keys come from imported files — so this is a sink for attacker-chosen
      // text, not just our own labels.
      return `<span class="se-pill ${escapeHTML(cls)}"><span class="se-count">${escapeHTML(total)}</span>${escapeHTML(labelOf(k))} <span class="muted small">${escapeHTML(dots)}</span></span>`;
    }).join('');
    return `<div class="se-group-row"><h4 class="se-group-title">${gname}</h4><div class="se-pills">${pills}</div></div>`;
  }).join('');
}

// ---------- Mood widget ----------
const MOOD_LABELS = { 1: 'Awful', 2: 'Low', 3: 'Okay', 4: 'Good', 5: 'Great' };
const MOOD_SVG = {
  1: '<circle cx="16" cy="16" r="14" class="mood-bg"/><circle cx="11" cy="13" r="1.5" class="mood-eye"/><circle cx="21" cy="13" r="1.5" class="mood-eye"/><path d="M10 22 Q16 17 22 22" fill="none" class="mood-mouth"/>',
  2: '<circle cx="16" cy="16" r="14" class="mood-bg"/><circle cx="11" cy="13" r="1.5" class="mood-eye"/><circle cx="21" cy="13" r="1.5" class="mood-eye"/><path d="M11 21 Q16 18 21 21" fill="none" class="mood-mouth"/>',
  3: '<circle cx="16" cy="16" r="14" class="mood-bg"/><circle cx="11" cy="13" r="1.5" class="mood-eye"/><circle cx="21" cy="13" r="1.5" class="mood-eye"/><line x1="11" y1="20" x2="21" y2="20" class="mood-mouth"/>',
  4: '<circle cx="16" cy="16" r="14" class="mood-bg"/><circle cx="11" cy="13" r="1.5" class="mood-eye"/><circle cx="21" cy="13" r="1.5" class="mood-eye"/><path d="M10 19 Q16 24 22 19" fill="none" class="mood-mouth"/>',
  5: '<circle cx="16" cy="16" r="14" class="mood-bg"/><path d="M9 12 Q11 11 13 12" fill="none" class="mood-eye-arc"/><path d="M19 12 Q21 11 23 12" fill="none" class="mood-eye-arc"/><path d="M9 18 Q16 26 23 18 Z" class="mood-mouth-fill"/>',
};

async function renderMood() {
  const today = todayISODate();
  const moods = await getMoodsSorted();
  const todayMood = moods.find(m => m.date === today);
  $$('#mood-picker .mood-btn').forEach(b => b.classList.toggle('selected', todayMood && +b.dataset.mood === todayMood.value));
  // Collapse the picker once today is logged. User can tap "change" to bring it back.
  const card = $('#mood-card');
  const picker = $('#mood-picker');
  const logged = $('#mood-logged');
  const saved = $('#mood-saved');
  const heading = $('#mood-heading');
  if (todayMood && !card.dataset.editing) {
    picker.classList.add('hidden');
    logged.classList.remove('hidden');
    const loggedSvg = $('#mood-logged-svg');
    loggedSvg.dataset.value = String(todayMood.value);
    const styleId = settings.moodStyle || 'classic';
    if (styleId === 'classic') {
      // Wrap the SVG paths in a fresh <svg>; the wrapper is now a div so we render the SVG ourselves.
      loggedSvg.innerHTML = `<svg viewBox="0 0 32 32" class="mood-svg">${MOOD_SVG[todayMood.value] || ''}</svg>`;
      loggedSvg.classList.remove('mood-emoji-display');
    } else {
      const s = MOOD_STYLES.find(x => x.id === styleId) || MOOD_STYLES[0];
      loggedSvg.innerHTML = `<span class="mood-emoji-big">${s.emojis[todayMood.value - 1] || '🙂'}</span>`;
      loggedSvg.classList.add('mood-emoji-display');
    }
    loggedSvg.classList.toggle('mood-positive', todayMood.value >= 4);
    loggedSvg.classList.toggle('mood-negative', todayMood.value <= 2);
    $('#mood-logged-label').textContent = MOOD_LABELS[todayMood.value] || 'Logged';
    heading.textContent = "Today's mood";
    saved.textContent = '';
  } else {
    picker.classList.remove('hidden');
    logged.classList.add('hidden');
    heading.textContent = 'How are you feeling today?';
    saved.textContent = todayMood ? '✓ saved' : '';
  }
  await renderMoodTrend(moods);
}

async function renderMoodTrend(moods) {
  const card = $('#mood-trend-card');
  if (!card) return;
  if (!moods || moods.length === 0) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  const days = 30;
  const today = new Date();
  const byDate = new Map(moods.map(m => [m.date, m.value]));
  // A low bar on its own invites the wrong conclusion. Where the user wrote down
  // what was going on that day, mark the bar and put the note in the tooltip, so
  // the reason travels with the number instead of sitting in a separate list.
  const noteByDate = new Map((await getNotesSorted()).map(n => [n.date, n.text]));
  const bars = [];
  let sum = 0, count = 0;
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const iso = localISOForInput(d).slice(0, 10);
    const v = byDate.get(iso);
    if (v != null) { sum += v; count++; }
    bars.push({ iso, v, note: noteByDate.get(iso) || '' });
  }
  const html = bars.map(b => {
    const noteCls = b.note ? ' has-note' : '';
    const noteTip = b.note ? ` — ${noteSnippet(b.note)}` : '';
    if (b.v == null) return `<div class="mood-bar empty${noteCls}" data-date="${b.iso}" title="${escapeHTML(`${b.iso}: not logged — tap to fill in${noteTip}`)}"></div>`;
    return `<div class="mood-bar v${b.v}${noteCls}" data-date="${b.iso}" style="height:${20 + b.v * 16}%" title="${escapeHTML(`${b.iso}: ${MOOD_LABELS[b.v]} — tap to edit${noteTip}`)}"></div>`;
  }).join('');
  $('#mood-trend-bars').innerHTML = html;
  const avg = count ? (sum / count) : null;
  if (avg != null) {
    const lab = avg >= 4.2 ? 'mostly great' : avg >= 3.5 ? 'mostly good' : avg >= 2.5 ? 'mixed' : avg >= 1.6 ? 'mostly low' : 'tough stretch';
    $('#mood-trend-summary').textContent = `${count} of last ${days} days · ${lab}`;
  } else {
    $('#mood-trend-summary').textContent = '';
  }
}

// ---------- Achievements ----------
let _badgesExpanded = false;
function computeStats(shots, weights, moods) {
  const wd = weightDelta(weights, settings.startWeight);
  const delta = wd ? wd.delta : 0;
  const streak = computeStreak(shots, settings.cadenceDays || 7);
  const doses = shots.map(s => s.dose).filter(d => d > 0);
  // Comeback: detect a gap of >2 cadence intervals followed by 2+ on-cadence shots.
  let comeback = false;
  if (shots.length >= 4) {
    const sorted = [...shots].sort((a,b) => new Date(a.when) - new Date(b.when));
    const cad = (settings.cadenceDays || 7) * 86400000;
    for (let i = 1; i < sorted.length - 1; i++) {
      const gap = new Date(sorted[i].when) - new Date(sorted[i-1].when);
      if (gap > cad * 2.5) {
        // there was a lapse — check that we have 2+ shots after this point on cadence
        const tail = sorted.slice(i);
        if (tail.length >= 2) { comeback = true; break; }
      }
    }
  }
  // Days since first shot, used for "centurion" engagement badge
  const firstShot = shots.length ? new Date([...shots].sort((a,b) => new Date(a.when) - new Date(b.when))[0].when) : null;
  const appDays = firstShot ? Math.floor((Date.now() - firstShot.getTime()) / 86400000) : 0;
  return {
    shots,
    streak,
    delta,
    maxDose: doses.length ? Math.max(...doses) : 0,
    minDose: doses.length ? Math.min(...doses) : 0,
    moodCount: (moods || []).length,
    weightCount: (weights || []).length,
    comeback,
    appDays,
  };
}
async function renderBadges(shots, weights) {
  const moods = (await dbAll(STORES.moods)) || [];
  const stats = computeStats(shots, weights, moods);
  const card = $('#badges-card');
  const list = $('#badges-list');
  const unlocked = ACHIEVEMENTS.filter(a => a.test(stats));
  if (!unlocked.length && !shots.length) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  // Backfill earned-dates so "most recent" is meaningful for legacy unlocks.
  // Anything without a stamped date gets `today`, in current unlock order so they
  // tie-break consistently rather than collapsing to one big group.
  settings.achievementDates = settings.achievementDates || {};
  let backfilled = false;
  const todayIso = todayISODate();
  unlocked.forEach((a, i) => {
    if (!settings.achievementDates[a.id]) {
      // synthetic order: today, today-1ms, today-2ms (string-sortable as ISO)
      settings.achievementDates[a.id] = todayIso;
      backfilled = true;
    }
  });
  if (backfilled) await saveSettings();
  const dates = settings.achievementDates;
  // Sort newest-first by earned date; on ties (e.g. legacy backfills that all share today),
  // fall back to reverse-canonical order so higher-tier / later-defined achievements appear first.
  const idx = new Map(ACHIEVEMENTS.map((a, i) => [a.id, i]));
  const ordered = [...unlocked].sort((a, b) => {
    const cmp = (dates[b.id] || '').localeCompare(dates[a.id] || '');
    if (cmp !== 0) return cmp;
    return (idx.get(b.id) ?? 0) - (idx.get(a.id) ?? 0);
  });
  const collapsed = !_badgesExpanded && ordered.length > 6;
  const visible = collapsed ? ordered.slice(0, 6) : ordered;
  const cards = visible.map(a => `<button type="button" class="badge-tile" data-badge-id="${a.id}" aria-label="Share ${escapeHTML(a.label)}"><img class="badge-tile-art" src="icons/achievements/${a.id}.webp" alt="" loading="lazy" onerror="this.style.display='none'"><span class="badge-tile-label">${escapeHTML(a.label)}</span></button>`).join('');
  const toggleBtn = ordered.length > 6
    ? `<button type="button" id="badges-toggle" class="btn-ghost badges-toggle">${_badgesExpanded ? 'Show fewer' : `Show all (${ordered.length})`}</button>`
    : '';
  list.innerHTML = cards + toggleBtn;
  list.querySelectorAll('.badge-tile[data-badge-id]').forEach(el => {
    el.addEventListener('click', () => openBadgeShare(el.dataset.badgeId));
  });
  const tg = $('#badges-toggle');
  if (tg) tg.addEventListener('click', async () => {
    _badgesExpanded = !_badgesExpanded;
    await renderBadges(shots, weights);
  });

  // Detect newly unlocked → confetti + stamp earned date
  const prev = new Set(settings.achievements || []);
  const newly = unlocked.filter(a => !prev.has(a.id));
  if (newly.length) {
    settings.achievements = unlocked.map(a => a.id);
    settings.achievementDates = settings.achievementDates || {};
    const today = todayISODate();
    for (const a of newly) {
      if (!settings.achievementDates[a.id]) settings.achievementDates[a.id] = today;
    }
    await saveSettings();
    fireConfetti();
    // Auto-open the share-card modal on a fresh unlock — pick the highest-tier new achievement
    // (last in the canonical ACHIEVEMENTS order). One pop-up per render cycle, never on first load.
    try {
      const seenInitial = settings._achievementsInitialized;
      if (seenInitial) {
        const order = ACHIEVEMENTS.map(a => a.id);
        const top = newly.slice().sort((a, b) => order.indexOf(b.id) - order.indexOf(a.id))[0];
        if (top) setTimeout(() => { try { openBadgeShare(top.id); } catch (e) {} }, 600);
      } else {
        settings._achievementsInitialized = true;
        await saveSettings();
      }
    } catch (e) {}
  } else if (!settings._achievementsInitialized) {
    settings._achievementsInitialized = true;
    try { await saveSettings(); } catch (e) {}
  }
}

// ---------- Achievement share-card ----------
async function openBadgeShare(badgeId) {
  const a = ACHIEVEMENTS.find(x => x.id === badgeId);
  if (!a) return;
  const dlg = $('#badge-share-dialog');
  if (!dlg) return;
  const earned = (settings.achievementDates && settings.achievementDates[badgeId]) || todayISODate();
  if (!settings.achievementDates) settings.achievementDates = {};
  if (!settings.achievementDates[badgeId]) {
    settings.achievementDates[badgeId] = earned;
    await saveSettings();
  }
  $('#badge-share-title').textContent = `🎉 ${a.label}`;
  await renderBadgeShareCanvas(a, earned);
  dlg.showModal();
  track('badge_share_opened', { id: badgeId });
}

function loadAchievementImage(badgeId) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = `icons/achievements/${badgeId}.webp`;
  });
}

async function renderBadgeShareCanvas(a, earnedISO) {
  const c = $('#badge-share-canvas');
  const ctx = c.getContext('2d');
  const W = c.width, H = c.height;
  // Deep navy radial gradient (matches the AI art backgrounds for a seamless look).
  const bg = ctx.createRadialGradient(W/2, H*0.4, 50, W/2, H*0.4, W*0.85);
  bg.addColorStop(0, '#1f2a4a');
  bg.addColorStop(1, '#0a0f24');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  // Gold rays
  ctx.save();
  ctx.translate(W/2, H*0.45);
  for (let i = 0; i < 24; i++) {
    ctx.rotate(Math.PI / 12);
    const ray = ctx.createLinearGradient(0, 0, 0, -W*0.7);
    ray.addColorStop(0, 'rgba(253,224,138,0.20)');
    ray.addColorStop(1, 'rgba(253,224,138,0)');
    ctx.fillStyle = ray;
    ctx.beginPath();
    ctx.moveTo(-22, 0); ctx.lineTo(22, 0); ctx.lineTo(0, -W*0.7); ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
  // Gilt header
  ctx.fillStyle = '#fde68a';
  ctx.font = 'bold 38px -apple-system, "Helvetica Neue", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('★  ACHIEVEMENT UNLOCKED  ★', W / 2, 120);
  // Hero image, drop-shadow for lift. Smaller to leave clear room for label + date.
  const heroImg = await loadAchievementImage(a.id);
  const heroSize = 600;
  const cx = W / 2, cy = H * 0.42;
  if (heroImg) {
    // Circular clip hides the dark square frame baked into the WebP source.
    // Step 1: draw a solid disk with shadow so the badge still has lift.
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = 50;
    ctx.shadowOffsetY = 14;
    ctx.fillStyle = '#0a0f24';
    ctx.beginPath();
    ctx.arc(cx, cy, heroSize / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    // Step 2: clip to the disk and draw the hero on top — corners of the WebP are masked off.
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, heroSize / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(heroImg, cx - heroSize/2, cy - heroSize/2, heroSize, heroSize);
    ctx.restore();
    // Step 3: gilt ring around the circular badge.
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, heroSize / 2 - 2, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(253,224,138,0.55)';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.restore();
  } else {
    ctx.font = '320px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",system-ui';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fde68a';
    ctx.fillText(a.icon, cx, cy);
    ctx.textBaseline = 'alphabetic';
  }
  // Decorative gold rule
  const ruleY = cy + heroSize/2 + 20;
  const rule = ctx.createLinearGradient(W*0.2, 0, W*0.8, 0);
  rule.addColorStop(0, 'rgba(253,224,138,0)');
  rule.addColorStop(0.5, 'rgba(253,224,138,0.85)');
  rule.addColorStop(1, 'rgba(253,224,138,0)');
  ctx.fillStyle = rule;
  ctx.fillRect(W*0.2, ruleY, W*0.6, 2);
  // Label — large and confident
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 60px -apple-system, "Helvetica Neue", system-ui, sans-serif';
  wrapText(ctx, a.label, W / 2, ruleY + 65, W - 160, 70);
  // Date — small caps style
  const dateStr = new Date(earnedISO + 'T00:00:00').toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  ctx.fillStyle = 'rgba(253,224,138,0.92)';
  ctx.font = '28px -apple-system, "Helvetica Neue", system-ui, sans-serif';
  ctx.fillText(dateStr.toUpperCase(), W / 2, ruleY + 130);
  // Footer brand bar — gilt strip on dark
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(0, H - 120, W, 120);
  ctx.fillStyle = '#fde68a';
  ctx.fillRect(0, H - 122, W, 2);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 40px -apple-system, "Helvetica Neue", system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('💉 My GLP Shot', 60, H - 60);
  ctx.font = '30px -apple-system, "Helvetica Neue", system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.78)';
  ctx.textAlign = 'right';
  ctx.fillText('myglpshot.com', W - 60, H - 60);
  ctx.textAlign = 'center';
}

function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = w; }
    else line = test;
  }
  if (line) lines.push(line);
  const startY = y - ((lines.length - 1) * lineHeight) / 2;
  lines.forEach((ln, i) => ctx.fillText(ln, x, startY + i * lineHeight));
}

function setupBadgeShareDialog() {
  const dlg = $('#badge-share-dialog');
  if (!dlg) return;
  $('#badge-share-close')?.addEventListener('click', () => dlg.close());
  $('#badge-share-download')?.addEventListener('click', () => {
    const c = $('#badge-share-canvas');
    const a = document.createElement('a');
    a.href = c.toDataURL('image/png');
    a.download = `myglpshot-achievement-${todayISODate()}.png`;
    document.body.appendChild(a); a.click(); a.remove();
    track('badge_share_downloaded');
  });
  $('#badge-share-native')?.addEventListener('click', async () => {
    const c = $('#badge-share-canvas');
    c.toBlob(async (blob) => {
      if (!blob) return;
      const file = new File([blob], `myglpshot-achievement.png`, { type: 'image/png' });
      try {
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: 'My GLP Shot achievement', text: 'Just unlocked an achievement on My GLP Shot 💉' });
          track('badge_share_native');
        } else {
          $('#badge-share-download').click();
        }
      } catch (e) {
        if (e.name !== 'AbortError') alert('Share failed: ' + e.message);
      }
    }, 'image/png');
  });
}

// ---------- Confetti ----------
function fireConfetti() {
  const colors = ['#14b8a6', '#0f766e', '#5eead4', '#fb923c', '#fde68a'];
  const root = document.body;
  for (let i = 0; i < 36; i++) {
    const piece = document.createElement('div');
    piece.className = 'confetti-piece';
    piece.style.background = colors[i % colors.length];
    piece.style.left = (50 + (Math.random() - 0.5) * 30) + 'vw';
    piece.style.top = '40vh';
    piece.style.setProperty('--x', ((Math.random() - 0.5) * 320) + 'px');
    piece.style.animationDelay = (Math.random() * 0.2) + 's';
    root.appendChild(piece);
    setTimeout(() => piece.remove(), 2200);
  }
}

// ---------- Day/night gradient swap ----------
function applyTimeOfDayGradient() {
  const card = document.querySelector('.countdown-card');
  if (!card) return;
  const h = new Date().getHours();
  card.style.setProperty('--grad-hour-shift', (h < 6 || h >= 20) ? '-12%' : '0%');
}

// ---------- Pull-to-refresh ----------
function setupPullToRefresh() {
  let startY = 0, pulling = false, indicator = null;
  document.addEventListener('touchstart', (e) => {
    if (window.scrollY > 0) return;
    startY = e.touches[0].clientY;
    pulling = true;
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (!pulling) return;
    const dy = e.touches[0].clientY - startY;
    if (dy > 60) {
      if (!indicator) {
        indicator = document.createElement('div');
        indicator.className = 'ptr-indicator show';
        indicator.textContent = '↻ Release to sync';
        document.body.appendChild(indicator);
      }
    }
  }, { passive: true });
  document.addEventListener('touchend', async () => {
    if (indicator) {
      indicator.textContent = 'Syncing…';
      try { if (account.user && account.encryptionKey) await accountSyncPush(); } catch (e) { noteSyncFailure(e); }
      setTimeout(() => { indicator?.remove(); indicator = null; }, 600);
    }
    pulling = false;
  });
}

// ============================================================================
// Cloud Sync — end-to-end encrypted blob storage.
// All cryptography runs in the browser. The server stores opaque ciphertext
// keyed by an HMAC-style lookup_id derived from username + passphrase. The
// server never sees: username, passphrase, encryption key, or plaintext.
// ============================================================================

const SYNC_API = 'api/sync';
const ACCOUNT_API = 'api';
const SYNC_PBKDF2_ITERS = 600000;
const SYNC_PROTOCOL = 'shotclock-v1';
const ACCOUNT_PROTOCOL = 'myglpshot-v1';

// ============================================================================
// Email/password account system. Bitwarden-style dual-hash:
//   PBKDF2(password, salt=hash(ACCOUNT_PROTOCOL+email), 600k) → 512 bits
//   First 256 = AES-GCM key (NEVER sent)
//   Last 256 = authToken (sent to server, server bcrypts before storing)
// Server cannot derive password OR encryption key from authToken.
// ============================================================================

let account = { user: null, encryptionKey: null };
const HEX = (buf) => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');

async function deriveAccountCreds(email, password) {
  const e = (email || '').trim().toLowerCase();
  const p = password || '';
  if (!e || !p) throw new Error('Email and password required');
  const enc = new TextEncoder();
  const saltBuf = await crypto.subtle.digest('SHA-256', enc.encode(ACCOUNT_PROTOCOL + ':' + e));
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(p), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBuf, iterations: SYNC_PBKDF2_ITERS, hash: 'SHA-256' },
    baseKey, 512
  );
  const buf = new Uint8Array(bits);
  // Extractable so we can persist the raw AES key locally (instead of the password) for session restore.
  const aesKey = await crypto.subtle.importKey('raw', buf.slice(0, 32), 'AES-GCM', true, ['encrypt', 'decrypt']);
  const authToken = HEX(buf.slice(32, 64));
  return { aesKey, authToken, email: e };
}

async function accountFetch(path, opts = {}) {
  opts.headers = Object.assign({ 'Content-Type': 'application/json', 'Accept': 'application/json' }, opts.headers || {});
  // Send Bearer token from localStorage as a fallback for PWAs / environments where cookies are flaky.
  try {
    const tok = localStorage.getItem('mgs_session_token');
    if (tok && !opts.headers.Authorization) opts.headers.Authorization = 'Bearer ' + tok;
  } catch (_) {}
  opts.credentials = 'same-origin';
  return fetch(`${ACCOUNT_API}/${path}`, opts);
}

async function accountSignup(email, password) {
  const creds = await deriveAccountCreds(email, password);
  const r = await accountFetch('signup', { method: 'POST', body: JSON.stringify({ email: creds.email, authToken: creds.authToken }) });
  if (!r.ok) {
    const j = await r.json().catch(() => ({ message: 'Signup failed' }));
    throw new Error(j.message || 'Signup failed');
  }
  const j = await r.json();
  account = { user: j.user, encryptionKey: creds.aesKey };
  rememberSignedIn(creds.email, creds.aesKey);
  if (j.token) try { localStorage.setItem('mgs_session_token', j.token); } catch (_) {}
  return j.user;
}

async function accountLogin(email, password) {
  const creds = await deriveAccountCreds(email, password);
  const r = await accountFetch('login', { method: 'POST', body: JSON.stringify({ email: creds.email, authToken: creds.authToken }) });
  if (!r.ok) {
    const j = await r.json().catch(() => ({ message: 'Login failed' }));
    throw new Error(j.message || 'Login failed');
  }
  const j = await r.json();
  account = { user: j.user, encryptionKey: creds.aesKey };
  rememberSignedIn(creds.email, creds.aesKey);
  if (j.token) try { localStorage.setItem('mgs_session_token', j.token); } catch (_) {}
  return j.user;
}

async function accountLogout(forgetDevice) {
  try { await accountFetch('logout', { method: 'POST' }); } catch (e) {}
  account = { user: null, encryptionKey: null };
  try { localStorage.removeItem('mgs_session_token'); } catch (_) {}
  if (forgetDevice) clearRememberedSignIn();
}

async function accountForgot(email) {
  const r = await accountFetch('forgot', { method: 'POST', body: JSON.stringify({ email }) });
  return r.ok;
}

async function accountMe() {
  const r = await accountFetch('me');
  if (!r.ok) return null;
  const j = await r.json();
  return j.user;
}

function isPremium() {
  return !!(account.user && account.user.isPremium);
}

// Persist the derived AES encryption key (NOT the password) for session restore.
// XSS can still steal this key, but it can't steal a password the user may have reused elsewhere.
// The auth_token (server-side bcrypt-hashed) is never persisted; the session cookie is the auth credential.
async function rememberSignedIn(email, aesKey) {
  try {
    const raw = await crypto.subtle.exportKey('raw', aesKey);
    const b64 = bytesToBase64(raw);
    localStorage.setItem('account.cred', JSON.stringify({ email, k: b64, v: 2 }));
    // Migrate away from any old plaintext-password entries on this device.
    localStorage.removeItem('account.cred.legacy');
  } catch (e) {}
}
function getRememberedSignIn() {
  try {
    const raw = JSON.parse(localStorage.getItem('account.cred') || 'null');
    if (!raw) return null;
    if (raw.v === 2 && raw.email && raw.k) return raw;
    // Old format had plaintext password. Discard it — user will need to sign in again on this device.
    localStorage.removeItem('account.cred');
    return null;
  } catch (e) { return null; }
}
function clearRememberedSignIn() {
  try { localStorage.removeItem('account.cred'); } catch (e) {}
}

async function importStoredAesKey(b64) {
  return crypto.subtle.importKey('raw', base64ToBytes(b64), 'AES-GCM', true, ['encrypt', 'decrypt']);
}

async function tryRestoreAccount() {
  const user = await accountMe();
  if (!user) return false;
  account.user = user;
  const remembered = getRememberedSignIn();
  if (remembered && remembered.email && remembered.k) {
    try {
      account.encryptionKey = await importStoredAesKey(remembered.k);
    } catch (e) {}
  }
  // Auto-sync on every login: pull, merge, push the union back.
  //
  // This used to compare timestamps and pick a winner, which meant whichever
  // side "lost" had its records discarded — a device that logged shots offline
  // lost them the moment another device pushed. Because a pull now merges
  // instead of replacing, there is no winner to pick: both sides' records
  // survive, and pushing the union afterwards converges every device.
  if (account.encryptionKey) {
    try {
      const result = await accountSyncPull();
      if (result && result.payload) {
        await applyPulledPayload(result.payload);
        track('cross_device_auto_pull', {
          shots: (result.payload.shots || []).length,
          merged: (window._lastMergeStats && window._lastMergeStats.shots) || null,
        });
      }
      await accountSyncPush();
      settings.syncLastError = '';
      await saveSettings();
    } catch (e) {
      console.warn('[mgs] auto-sync on login failed (non-fatal):', e);
      settings.syncLastError = String(e && e.message || e);
      try { await saveSettings(); } catch (_) {}
    }
  }
  return true;
}

async function accountSyncPush() {
  if (!account.user || !account.encryptionKey) throw new Error('Not unlocked');
  const payload = await buildPayload();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = await encodePayloadBytes(payload);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, account.encryptionKey, plaintext);
  const body = { iv: bytesToBase64(iv), ciphertext: bytesToBase64(ct) };
  const r = await accountFetch('me/sync', { method: 'PUT', body: JSON.stringify(body) });
  if (r.status === 413) throw new Error('Your data is too large to back up. Export a copy and contact support.');
  if (!r.ok) throw new Error('Sync failed: ' + r.status);
  const j = await r.json();
  settings.syncLastPushAt = new Date().toISOString();
  settings.syncLastUpdatedAt = j.updatedAt;
  settings.syncLastError = '';
  await saveSettings();
  return j;
}

async function accountSyncPull() {
  if (!account.user || !account.encryptionKey) throw new Error('Not unlocked');
  const r = await accountFetch('me/sync');
  if (!r.ok) throw new Error('Pull failed: ' + r.status);
  const j = await r.json();
  if (!j.exists) return null;
  const iv = base64ToBytes(j.iv);
  const ct = base64ToBytes(j.ciphertext);
  let pt;
  try {
    pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, account.encryptionKey, ct);
  } catch (e) {
    throw new Error('Decryption failed — wrong password');
  }
  return { payload: await decodePayloadBytes(new Uint8Array(pt)), updatedAt: j.updatedAt };
}

async function accountSyncDelete() {
  if (!account.user) return;
  const r = await accountFetch('me/sync', { method: 'DELETE' });
  // Callers tell the user the cloud copy is gone. Make that true before they do.
  if (!r.ok) throw new Error(`Could not delete the cloud copy (${r.status}).`);
}

// ----- Doctor share link (premium) -----
// ----- Account UI -----
function setAccountMode(mode) {
  $('#account-mode').value = mode;
  if (mode === 'signup') {
    $('#account-form-title').textContent = 'Sign up free';
    $('#account-form-sub').textContent = 'Free, takes 5 seconds. 14-day premium trial included.';
    $('#account-submit').textContent = 'Sign up';
    $('#account-pw-input').autocomplete = 'new-password';
    $('#account-switch').innerHTML = 'Already have an account? <a href="#" id="switch-mode-link">Sign in</a>';
  } else {
    $('#account-form-title').textContent = 'Sign in';
    $('#account-form-sub').textContent = 'Welcome back.';
    $('#account-submit').textContent = 'Sign in';
    $('#account-pw-input').autocomplete = 'current-password';
    $('#account-switch').innerHTML = "Don't have an account? <a href=\"#\" id=\"switch-mode-link\">Sign up free</a>";
  }
  $('#switch-mode-link').addEventListener('click', (e) => { e.preventDefault(); setAccountMode(mode === 'signup' ? 'login' : 'signup'); });
  $('#account-error').textContent = '';
}

function openAccountDialog(mode) {
  setAccountMode(mode || 'signup');
  $('#account-email-input').value = '';
  $('#account-pw-input').value = '';
  $('#account-error').textContent = '';
  $('#account-dialog').showModal();
}

async function handleAccountSubmit(ev) {
  ev.preventDefault();
  const mode = $('#account-mode').value;
  const email = $('#account-email-input').value.trim();
  const password = $('#account-pw-input').value;
  const errEl = $('#account-error');
  errEl.textContent = '';
  if (password.length < 8) { errEl.textContent = 'Password must be at least 8 characters.'; return; }
  $('#account-submit').disabled = true;
  $('#account-submit').textContent = 'Working…';
  try {
    if (mode === 'signup') {
      await accountSignup(email, password);
    } else {
      await accountLogin(email, password);
    }
    $('#account-dialog').close();
    await onAccountChanged();
    // After signup or login, prompt to push local data if any exists
    const shots = (await dbAll(STORES.shots)) || [];
    if (shots.length && account.encryptionKey) {
      try { await accountSyncPush(); } catch (e) {}
    }
    // After login, attempt pull
    if (mode === 'login' && account.encryptionKey) {
      try {
        const result = await accountSyncPull();
        if (result && shots.length === 0) {
          await applyPulledPayload(result.payload);
        } else if (result && shots.length > 0) {
          if (confirm(`Cloud copy has ${(result.payload.shots || []).length} shots. Replace local data with cloud copy?`)) {
            await applyPulledPayload(result.payload);
          }
        }
      } catch (e) {}
    }
  } catch (e) {
    errEl.textContent = e.message || 'Failed';
  } finally {
    $('#account-submit').disabled = false;
    $('#account-submit').textContent = mode === 'signup' ? 'Sign up' : 'Sign in';
  }
}

async function onAccountChanged() {
  const u = account.user;
  const banner = $('#account-banner');
  const pill = $('#hdr-account-pill');
  // Auth gate: require signup/login on every fresh device. Once signed in, app unlocks.
  // (Old jdubb-style legacy sync bypass removed — everyone uses the email/password account flow.)
  const skippedAuth = (() => { try { return localStorage.getItem('mglp_skip_auth') === '1'; } catch (e) { return false; } })();
  if (!u && !skippedAuth) {
    document.body.classList.add('auth-active');
    $$('.view').forEach(v => v.classList.remove('active'));
    $('#view-auth').classList.add('active');
  } else {
    if (u) { try { localStorage.removeItem('mglp_skip_auth'); } catch (e) {} }
    document.body.classList.remove('auth-active');
    if ($('#view-auth').classList.contains('active')) {
      $('#view-auth').classList.remove('active');
      $('#view-home').classList.add('active');
    }
    if (typeof maybeAutoShowInstall === 'function') maybeAutoShowInstall();
  }
  // Surface the embedded Admin entry only for accounts with is_admin=1.
  // /api/me returns isAdmin: bool — same field the admin SPA uses for cookie
  // auth. Default to hidden; never show without an explicit positive signal.
  const adminCard = $('#admin-card');
  if (adminCard) adminCard.classList.toggle('hidden', !(u && u.isAdmin === true));
  // If view-admin happens to be active for a non-admin (e.g. stale tab state
  // after sign-out / account switch), force back to home so the iframe can't
  // linger.
  if (!(u && u.isAdmin === true) && $('#view-admin')?.classList.contains('active')) {
    showView('home');
    const f = $('#admin-frame'); if (f) f.src = 'about:blank';
  }
  if (u) {
    banner.classList.add('hidden');
    $('#account-signed-out').classList.add('hidden');
    $('#account-signed-in').classList.remove('hidden');
    $('#account-email').textContent = u.email;
    pill.classList.remove('hidden');
    pill.classList.remove('premium', 'trial');
    if (u.subscriptionStatus === 'lifetime' || (u.subscriptionStatus === 'premium' && u.isPremium)) {
      pill.textContent = 'Premium';
      pill.classList.add('premium');
    } else if (u.subscriptionStatus === 'trial' && u.isPremium) {
      const daysLeft = Math.max(0, Math.ceil((u.trialEndsAt - Date.now() / 1000) / 86400));
      pill.textContent = `Trial · ${daysLeft}d`;
      pill.classList.add('trial');
    } else {
      pill.textContent = 'Free';
    }
    $('#account-sub-status').textContent = subscriptionStatusText(u);
    if (u.subscriptionStatus === 'trial' && u.trialEndsAt) {
      const total = 14 * 86400;
      const remaining = Math.max(0, u.trialEndsAt - Date.now() / 1000);
      $('#account-trial-fill').style.width = (100 * (1 - remaining / total)) + '%';
      $('#account-trial-bar').classList.remove('hidden');
    } else {
      $('#account-trial-bar').classList.add('hidden');
    }
    // Trial-ending banner: show when 3 or fewer days remain on a free trial. Dismissible per-day.
    try {
      const teb = $('#trial-end-banner');
      if (teb) {
        const isTrial = u.subscriptionStatus === 'trial' && u.isPremium && u.trialEndsAt;
        const daysLeft = isTrial ? Math.max(0, Math.ceil((u.trialEndsAt - Date.now() / 1000) / 86400)) : null;
        const todayKey = todayISODate();
        const dismissedKey = (() => { try { return localStorage.getItem('mglp_trial_end_dismissed') || ''; } catch (e) { return ''; } })();
        if (isTrial && daysLeft !== null && daysLeft <= 3 && daysLeft > 0 && dismissedKey !== todayKey) {
          $('#trial-end-days').textContent = String(daysLeft);
          teb.classList.remove('hidden');
        } else {
          teb.classList.add('hidden');
        }
      }
    } catch (e) {}
    $('#upgrade-cta').classList.toggle('hidden', isPremium());
    $('#manage-billing-cta').classList.toggle('hidden', !u.hasStripeCustomer);
    const legacySync = $('#legacy-cloud-sync-card');
    if (legacySync) legacySync.classList.add('hidden');
    // Premium hero card on the Premium tab — mirrors upgrade/manage state and shows clear status text.
    const phUp = $('#premium-hero-upgrade');
    const phMan = $('#premium-hero-manage');
    const phTitle = $('#premium-hero-title');
    const phSub = $('#premium-hero-sub');
    if (phUp) phUp.classList.toggle('hidden', isPremium());
    if (phMan) phMan.classList.toggle('hidden', !u.hasStripeCustomer);
    if (phTitle && phSub) {
      if (u.subscriptionStatus === 'lifetime') {
        phTitle.textContent = '⭐ Lifetime Premium';
        phSub.textContent = 'You have full access. Thanks for being a founding supporter.';
      } else if (u.subscriptionStatus === 'premium' && u.isPremium) {
        phTitle.textContent = '⭐ Premium';
        phSub.textContent = 'You have full access to all premium features.';
      } else if (u.subscriptionStatus === 'trial' && u.isPremium) {
        const daysLeft = Math.max(0, Math.ceil((u.trialEndsAt - Date.now() / 1000) / 86400));
        phTitle.textContent = `⭐ Trial · ${daysLeft} day${daysLeft === 1 ? '' : 's'} left`;
        phSub.textContent = 'Try every premium feature free. Subscribe before the trial ends to keep access.';
      } else {
        phTitle.textContent = 'Premium';
        phSub.textContent = 'Unlock supplies, measurements, labs, spend tracking, AI import, PDF reports, and doctor share links.';
      }
    }
  } else {
    $('#account-signed-out').classList.remove('hidden');
    $('#account-signed-in').classList.add('hidden');
    pill.classList.add('hidden');
    const legacySync = $('#legacy-cloud-sync-card');
    if (legacySync) legacySync.classList.remove('hidden');
    if (localStorage.getItem('acct.banner.dismissed') !== '1') {
      banner.classList.remove('hidden');
    }
  }
  applyPremiumGates();
}

function subscriptionStatusText(u) {
  if (!u) return '';
  if (u.subscriptionStatus === 'lifetime') return '⭐ Lifetime Premium — thank you for being a founding supporter!';
  if (u.subscriptionStatus === 'premium' && u.premiumUntil) {
    const d = new Date(u.premiumUntil * 1000).toLocaleDateString();
    return `Premium until ${d}`;
  }
  if (u.subscriptionStatus === 'trial' && u.trialEndsAt) {
    const days = Math.max(0, Math.ceil((u.trialEndsAt - Date.now() / 1000) / 86400));
    return days > 0 ? `Premium trial — ${days} day${days === 1 ? '' : 's'} remaining` : 'Trial ended';
  }
  return 'Free tier — upgrade for sync, supply tracking, and more';
}

function applyPremiumGates() {
  const premium = isPremium();
  // Toggle .lock-pill on premium feature cards. Tapping the pill opens the upgrade modal.
  ['#supply-lock', '#measurements-lock', '#labs-lock', '#cost-lock'].forEach(sel => {
    const el = document.querySelector(sel);
    if (!el) return;
    el.classList.toggle('unlocked', premium);
    if (!premium && !el._wired) {
      el.addEventListener('click', () => $('#upgrade-dialog').showModal());
      el._wired = true;
    }
  });
  // No blur, no paywall overlay. Cards stay fully usable; the pill labels the tier.
}

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
  const db = await openDB();
  return new Promise((res, rej) => {
    const t = db.transaction('supplies', 'readwrite');
    t.objectStore('supplies').put(s);
    t.oncomplete = res;
    t.onerror = () => rej(t.error);
  });
}

async function deleteSupply(id) {
  const db = await openDB();
  return new Promise((res) => {
    const t = db.transaction('supplies', 'readwrite');
    t.objectStore('supplies').delete(id);
    t.oncomplete = res;
  });
}

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

// ----- Body measurements (premium) -----
async function getMeasurements() {
  await ensureStore('measurements');
  return new Promise((res) => {
    openDB().then(db => {
      const t = db.transaction('measurements', 'readonly');
      const r = t.objectStore('measurements').getAll();
      r.onsuccess = () => res((r.result || []).sort((a, b) => a.date.localeCompare(b.date)));
      r.onerror = () => res([]);
    });
  });
}

async function saveMeasurement(m) {
  await ensureStore('measurements');
  const db = await openDB();
  return new Promise((res, rej) => {
    const t = db.transaction('measurements', 'readwrite');
    t.objectStore('measurements').put(m);
    t.oncomplete = res; t.onerror = () => rej(t.error);
  });
}

async function renderMeasurements() {
  const wrap = $('#measurement-summary');
  const empty = $('#measurements-empty');
  if (!wrap) return;
  const ms = await getMeasurements();
  if (!ms.length) { wrap.innerHTML = ''; empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');
  // Group by type → latest + delta from oldest
  const byType = {};
  for (const m of ms) {
    if (!byType[m.type]) byType[m.type] = [];
    byType[m.type].push(m);
  }
  const labels = { waist: 'Waist', hips: 'Hips', chest: 'Chest', thigh: 'Thigh', arm: 'Arm', neck: 'Neck' };
  wrap.innerHTML = Object.entries(byType).map(([type, vals]) => {
    const latest = vals[vals.length - 1];
    const earliest = vals[0];
    const delta = latest.value - earliest.value;
    const trendCls = delta < 0 ? 'down' : delta > 0 ? 'up' : '';
    const sign = delta < 0 ? '−' : '+';
    return `<div class="summary-pill">
      <span class="summary-label">${labels[type] || type}</span>
      <span class="summary-value">${latest.value} ${latest.unit}</span>
      ${vals.length > 1 ? `<span class="summary-trend ${trendCls}">${sign}${Math.abs(delta).toFixed(1)}</span>` : ''}
    </div>`;
  }).join('');
}

// ----- Lab tracking (premium) -----
const LAB_LABELS = {
  a1c: ['A1c', '%', { good_max: 5.7, watch_max: 6.5 }],
  glucose_fasting: ['Fasting glucose', 'mg/dL', { good_max: 100, watch_max: 126 }],
  bp_systolic: ['BP systolic', 'mmHg', { good_max: 120, watch_max: 140 }],
  bp_diastolic: ['BP diastolic', 'mmHg', { good_max: 80, watch_max: 90 }],
  cholesterol_total: ['Total chol.', 'mg/dL', { good_max: 200, watch_max: 240 }],
  cholesterol_hdl: ['HDL', 'mg/dL', null],
  cholesterol_ldl: ['LDL', 'mg/dL', { good_max: 100, watch_max: 160 }],
  triglycerides: ['Triglycerides', 'mg/dL', { good_max: 150, watch_max: 200 }],
  alt: ['ALT', 'U/L', { good_max: 40 }],
};

async function getLabs() {
  await ensureStore('labs');
  return new Promise((res) => {
    openDB().then(db => {
      const t = db.transaction('labs', 'readonly');
      const r = t.objectStore('labs').getAll();
      r.onsuccess = () => res((r.result || []).sort((a, b) => a.date.localeCompare(b.date)));
      r.onerror = () => res([]);
    });
  });
}

async function saveLab(l) {
  await ensureStore('labs');
  const db = await openDB();
  return new Promise((res, rej) => {
    const t = db.transaction('labs', 'readwrite');
    t.objectStore('labs').put(l);
    t.oncomplete = res; t.onerror = () => rej(t.error);
  });
}

async function renderLabs() {
  const wrap = $('#lab-summary');
  const empty = $('#labs-empty');
  if (!wrap) return;
  const ls = await getLabs();
  if (!ls.length) { wrap.innerHTML = ''; empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');
  const byType = {};
  for (const l of ls) {
    if (!byType[l.type]) byType[l.type] = [];
    byType[l.type].push(l);
  }
  wrap.innerHTML = Object.entries(byType).map(([type, vals]) => {
    const latest = vals[vals.length - 1];
    const earliest = vals[0];
    const delta = latest.value - earliest.value;
    const [label, unit] = LAB_LABELS[type] || [type, ''];
    const trendCls = delta < 0 ? 'down' : delta > 0 ? 'up' : '';
    const sign = delta < 0 ? '−' : '+';
    return `<div class="summary-pill">
      <span class="summary-label">${label}</span>
      <span class="summary-value">${latest.value} ${unit}</span>
      ${vals.length > 1 ? `<span class="summary-trend ${trendCls}">${sign}${Math.abs(delta).toFixed(1)}</span>` : ''}
    </div>`;
  }).join('');
}

// ----- App theme + emoji style (premium cosmetic settings) -----
function isDarkModeActive() {
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'dark') return true;
  if (attr === 'light') return false;
  // 'system' or unset → use OS preference
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

// Reads a CSS custom property from :root as a hex/rgb string. Used by Chart.js datasets so they honor the active theme.
function getThemeColor(varName) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  return v || '#0f766e';
}
function getThemeColorAlpha(varName, alpha) {
  const c = getThemeColor(varName);
  // Convert #rgb / #rrggbb to rgba; pass through rgb()/rgba() with alpha override.
  if (c.startsWith('#')) {
    const h = c.replace('#', '');
    const r = parseInt(h.length === 3 ? h[0]+h[0] : h.slice(0,2), 16);
    const g = parseInt(h.length === 3 ? h[1]+h[1] : h.slice(2,4), 16);
    const b = parseInt(h.length === 3 ? h[2]+h[2] : h.slice(4,6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  const m = c.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (m) return `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${alpha})`;
  return c;
}

function applyColorTheme(themeId) {
  const t = THEMES.find(x => x.id === themeId) || THEMES[0];
  const variant = isDarkModeActive() ? t.dark : t.light;
  const root = document.documentElement;
  root.style.setProperty('--bronze', variant.primary);
  root.style.setProperty('--bronze-dk', variant.dark);
  root.style.setProperty('--bronze-lt', variant.tint);
  // Gradient runs from the medium-dark to the dark stop (NOT the bright primary).
  // White text always sits on the gradient (countdown card etc.); using primary as start drops contrast below 3:1 for many themes.
  root.style.setProperty('--grad', `linear-gradient(135deg, ${t.light.grad2} 0%, ${t.light.dark} 100%)`);
  // iOS address-bar tint — always use the light-mode dark color so the bar reads as the brand.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = t.light.dark;
}

// Re-apply theme whenever light/dark mode flips so tints stay correct.
function reapplyCurrentColorTheme() {
  applyColorTheme(settings.colorTheme || 'teal');
}

function applyMoodStyle(styleId) {
  const s = MOOD_STYLES.find(x => x.id === styleId) || MOOD_STYLES[0];
  const MOOD_LABELS = ['Awful', 'Low', 'Okay', 'Good', 'Great'];
  // Replace each mood picker button's inner SVG with a big emoji.
  // Default 'classic' keeps the hand-drawn smileys (which are SVG-based for theming) by NOT replacing — restore SVGs from MOOD_SVG.
  document.querySelectorAll('.mood-btn').forEach(btn => {
    const v = parseInt(btn.dataset.mood, 10);
    if (!Number.isFinite(v)) return;
    const label = MOOD_LABELS[v - 1] || '';
    if (styleId === 'classic') {
      btn.innerHTML = `<svg viewBox="0 0 32 32" class="mood-svg">${MOOD_SVG[v] || ''}</svg><span class="mood-label">${label}</span>`;
    } else {
      btn.innerHTML = `<span class="mood-emoji">${s.emojis[v - 1] || '🙂'}</span><span class="mood-label">${label}</span>`;
    }
  });
  // Logged-state mood display (parent div, not raw <svg>, so HTML children render).
  const loggedSvgEl = document.getElementById('mood-logged-svg');
  if (loggedSvgEl) {
    const v = parseInt(loggedSvgEl.dataset.value || '0', 10);
    if (v > 0) {
      if (styleId === 'classic') {
        loggedSvgEl.innerHTML = `<svg viewBox="0 0 32 32" class="mood-svg">${MOOD_SVG[v] || ''}</svg>`;
        loggedSvgEl.classList.remove('mood-emoji-display');
      } else {
        loggedSvgEl.innerHTML = `<span class="mood-emoji-big">${s.emojis[v - 1] || '🙂'}</span>`;
        loggedSvgEl.classList.add('mood-emoji-display');
      }
    }
  }
}

function renderThemeGrid() {
  const grid = $('#theme-grid');
  if (!grid) return;
  const current = settings.colorTheme || 'teal';
  grid.innerHTML = THEMES.map(t => `
    <button type="button" class="theme-swatch ${t.id === current ? 'active' : ''}" data-theme-id="${t.id}" aria-label="${t.name}">
      <span class="theme-swatch-dot" style="background:linear-gradient(135deg,${t.light.primary} 0%,${t.light.grad2} 100%)"></span>
      <span class="theme-swatch-name">${t.name}</span>
    </button>
  `).join('');
  grid.querySelectorAll('.theme-swatch').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!isPremium() && account.user) { $('#upgrade-dialog').showModal(); return; }
      const id = btn.dataset.themeId;
      settings.colorTheme = id;
      await saveSettings();
      applyColorTheme(id);
      grid.querySelectorAll('.theme-swatch').forEach(b => b.classList.toggle('active', b === btn));
      // Rebuild charts with new colors. (CSS-driven elements like heatmap/badges retint automatically via custom properties.)
      try { await renderShots(); } catch (_) {}
      markSyncDirty();
      track('theme_changed', { theme: id });
    });
  });
}

function applyAppetiteStyle(styleId) {
  const s = APPETITE_STYLES.find(x => x.id === styleId) || APPETITE_STYLES[0];
  const APPETITE_LABELS = ['None', 'Low', 'Normal', 'Hungry', 'Ravenous'];
  document.querySelectorAll('.appetite-btn').forEach(btn => {
    const v = parseInt(btn.dataset.appetite, 10);
    if (!Number.isFinite(v)) return;
    const label = APPETITE_LABELS[v - 1] || '';
    btn.innerHTML = `<span class="appetite-emoji">${s.emojis[v - 1] || '🍽️'}</span><span class="mood-label">${label}</span>`;
  });
  // Logged graphic (parent div, supports HTML children).
  const loggedEl = document.getElementById('appetite-logged-graphic');
  if (loggedEl && loggedEl.dataset.value) {
    const v = parseInt(loggedEl.dataset.value, 10);
    loggedEl.innerHTML = `<span class="mood-emoji-big">${s.emojis[v - 1] || '🍽️'}</span>`;
  }
}

function renderAppetiteStyleGrid() {
  const grid = $('#appetite-style-grid');
  if (!grid) return;
  const current = settings.appetiteStyle || 'classic';
  grid.innerHTML = APPETITE_STYLES.map(s => `
    <button type="button" class="emoji-style-swatch ${s.id === current ? 'active' : ''}" data-style-id="${s.id}" aria-label="${s.name}">
      <span class="emoji-row">${s.emojis.map(e => `<span>${e}</span>`).join('')}</span>
      <span class="emoji-style-name">${s.name}</span>
    </button>
  `).join('');
  grid.querySelectorAll('.emoji-style-swatch').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!isPremium() && account.user) { $('#upgrade-dialog').showModal(); return; }
      const id = btn.dataset.styleId;
      settings.appetiteStyle = id;
      await saveSettings();
      applyAppetiteStyle(id);
      grid.querySelectorAll('.emoji-style-swatch').forEach(b => b.classList.toggle('active', b === btn));
      try { renderAppetite(); } catch (_) {}
      markSyncDirty();
      track('appetite_style_changed', { style: id });
    });
  });
}

function renderEmojiStyleGrid() {
  const grid = $('#emoji-style-grid');
  if (!grid) return;
  const current = settings.moodStyle || 'classic';
  grid.innerHTML = MOOD_STYLES.map(s => `
    <button type="button" class="emoji-style-swatch ${s.id === current ? 'active' : ''}" data-style-id="${s.id}" aria-label="${s.name}">
      <span class="emoji-row">${s.emojis.map(e => `<span>${e}</span>`).join('')}</span>
      <span class="emoji-style-name">${s.name}</span>
    </button>
  `).join('');
  grid.querySelectorAll('.emoji-style-swatch').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!isPremium() && account.user) { $('#upgrade-dialog').showModal(); return; }
      const id = btn.dataset.styleId;
      settings.moodStyle = id;
      await saveSettings();
      applyMoodStyle(id);
      grid.querySelectorAll('.emoji-style-swatch').forEach(b => b.classList.toggle('active', b === btn));
      // Re-render mood card so the chosen style shows immediately on home view.
      try { renderMood(); } catch (_) {}
      markSyncDirty();
      track('mood_style_changed', { style: id });
    });
  });
}

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
  const db = await openDB();
  return new Promise((res, rej) => {
    const t = db.transaction('expenses', 'readwrite');
    t.objectStore('expenses').put(e);
    t.oncomplete = res; t.onerror = () => rej(t.error);
  });
}

async function deleteExpense(id) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const t = db.transaction('expenses', 'readwrite');
    t.objectStore('expenses').delete(id);
    t.oncomplete = res; t.onerror = () => rej(t.error);
  });
}

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
  const dollarsPerLb = lostLb > 0 ? (totalCost / lostLb).toFixed(2) : null;

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
    ${dollarsPerLb ? `<div class="summary-pill"><span class="summary-label">$ per lb lost</span><span class="summary-value">$${dollarsPerLb}</span></div>` : ''}
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

// ----- Plateau detection (premium) -----
function detectPlateau(weights, shots) {
  if (weights.length < 8) return null;
  const recent = weights.slice(-30);
  if (recent.length < 8) return null;
  const fourWeeksAgo = Date.now() - 28 * 86400000;
  const inWindow = recent.filter(w => new Date(w.date).getTime() >= fourWeeksAgo);
  if (inWindow.length < 4) return null;
  const first = inWindow[0].value;
  const last = inWindow[inWindow.length - 1].value;
  const delta = last - first;
  if (Math.abs(delta) > 1) return null; // not a plateau
  // Check no recent dose increase
  const recentShotsInWindow = shots.filter(s => new Date(s.when).getTime() >= fourWeeksAgo);
  const doses = recentShotsInWindow.map(s => s.dose);
  const allSame = doses.length === 0 || doses.every(d => d === doses[0]);
  if (!allSame) return null;
  const dose = doses[0] || (shots.length ? shots[0].dose : null);
  return { weeks: 4, dose, delta: delta.toFixed(1) };
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
    body.innerHTML = `<p>Weight has stayed within 1 lb for ~${p.weeks} weeks at ${p.dose}mg — exactly what maintenance looks like. Holding steady is the goal here, not a plateau to break.</p>
      <p class="muted small">If you ever want to switch back to weight-loss mode, toggle Maintenance off in Settings.</p>`;
  } else {
    body.innerHTML = `<p>Weight has stayed within 1 lb for ~${p.weeks} weeks at ${p.dose}mg.</p>
      <p class="muted small">This is normal — most people experience plateaus during titration. Consider:
      discussing a dose increase with your prescriber, reviewing protein intake (aim for 1g per lb of goal weight),
      walking 8-10K steps/day, and ensuring you're eating in a sustainable deficit.</p>
      <p class="muted small">Educational only. Not medical advice.</p>`;
  }
  card.classList.remove('hidden');
}

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
      ${inc('weights') && wd ? `<div class="stat"><strong>${wd.delta < 0 ? '−' : '+'}${Math.abs(wd.delta).toFixed(1)} lb</strong><span>since start</span></div>` : ''}
      ${inc('weights') && wd ? `<div class="stat"><strong>${wd.current.toFixed(1)} lb</strong><span>current weight</span></div>` : ''}
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
    ${measurements.map(m => `<tr><td>${m.date}</td><td>${m.type}</td><td>${m.value} ${m.unit}</td></tr>`).join('')}
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
  // Generate per-share random key, embed in URL fragment
  const shareKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const rawKey = await crypto.subtle.exportKey('raw', shareKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, shareKey, await encodePayloadBytes(payload));
  const body = { iv: bytesToBase64(iv), ciphertext: bytesToBase64(ct), label: label || null };
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
  const filterByWhen = (rows) => rows.filter(r => new Date(r.when || r.date) >= since);
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
    version: 10,
    exportedAt: new Date().toISOString(),
    range: opts && opts.range ? opts.range : 'all',
    settings,
    shots, weights, moods, appetites, foodNoise, cycles, medChanges, notes, symptoms,
    supplies, measurements, labs, expenses,
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


// ---------- Sync merge ----------
// Records get a stable `uid` on write so the same shot logged on a phone and
// pulled onto a tablet is recognised as one record rather than duplicated.
// Rows written before uids existed fall back to a content key, which is stable
// for the fields that actually identify an entry.
function newUid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return HEX(crypto.getRandomValues(new Uint8Array(16)));
}

// Content keys identify a record by the fields a human would call "the same
// entry". They exist because rows written before uids have no other identity —
// and because a uid assigned locally to an old row would otherwise differ from
// the uid the same row got on another device, duplicating it on every pull.
const CONTENT_KEYS = {
  shots: (r) => `s|${String(r.when).slice(0, 16)}|${r.dose}`,
  weights: (r) => `w|${r.date}`,
  supplies: (r) => `p|${r.med || ''}|${r.openedAt || ''}|${r.mg || ''}`,
  measurements: (r) => `m|${r.date}|${r.type}`,
  labs: (r) => `l|${r.date}|${r.type}`,
  expenses: (r) => `e|${r.date}|${r.type}|${r.amount}`,
  cycles: (r) => `c|${r.start || r.date || ''}`,
  medChanges: (r) => `x|${r.date}|${r.from || ''}|${r.to || ''}`,
};

// Union-merge one auto-increment store: keep every local row, add cloud rows we
// don't already have. Never deletes — a pull can only ever add.
//
// A record matches if EITHER its uid or its content key is already present, so
// uid-bearing and legacy rows both dedupe correctly and a pull is idempotent.
async function mergeStore(storeName, incoming, contentKey) {
  const rows = Array.isArray(incoming) ? incoming : [];
  if (!rows.length) return { added: 0, skipped: 0 };
  const existing = (await dbAll(storeName)) || [];
  const seenUid = new Set();
  const seenContent = new Set();
  for (const r of existing) {
    if (r && r.uid) seenUid.add(r.uid);
    if (r) seenContent.add(contentKey(r));
  }
  let added = 0, skipped = 0;
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') { skipped++; continue; }
    const rec = { ...raw };
    delete rec.id;                 // local autoincrement ids are device-scoped
    const ck = contentKey(rec);
    if ((rec.uid && seenUid.has(rec.uid)) || seenContent.has(ck)) { skipped++; continue; }
    if (!rec.uid) rec.uid = newUid();
    seenUid.add(rec.uid);
    seenContent.add(ck);
    await dbAdd(storeName, rec);
    added++;
  }
  return { added, skipped };
}

// Notes are the one daily store that can't take last-write-wins. Mood is a number
// you can re-tap in a second; a note is sentences someone wrote about their life,
// and a pull that silently replaced it would destroy the only copy. So a note
// only ever loses to a NEWER note, and when both sides have text and neither
// contains the other, both are kept rather than one being thrown away.
async function mergeNotes(incoming) {
  const rows = Array.isArray(incoming) ? incoming : [];
  if (!rows.length) return { added: 0, updated: 0, combined: 0, skipped: 0 };
  const stats = { added: 0, updated: 0, combined: 0, skipped: 0 };
  for (const raw of rows) {
    const rec = sanitizeNote(raw);
    if (!rec) { stats.skipped++; continue; }
    const local = await getNote(rec.date);
    const localText = (local && local.text ? String(local.text) : '').trim();
    if (!localText) { await dbPut('notes', rec); stats.added++; continue; }
    if (localText === rec.text) { stats.skipped++; continue; }

    const localTs = Date.parse(local && local.updatedAt) || 0;
    const cloudTs = Date.parse(rec.updatedAt) || 0;
    // One side is a straight extension of the other (the usual case: the same
    // note edited on two devices). Keep the longer, it already contains the rest.
    if (rec.text.includes(localText)) { await dbPut('notes', rec); stats.updated++; continue; }
    if (localText.includes(rec.text)) { stats.skipped++; continue; }

    // Genuinely divergent text. Newer goes first, older is preserved beneath a
    // marker so the user can see both and tidy up — nothing typed is ever lost.
    const [first, second] = cloudTs >= localTs ? [rec.text, localText] : [localText, rec.text];
    const combined = `${first}\n\n— also saved on another device —\n${second}`.slice(0, NOTE_MAX);
    await dbPut('notes', { date: rec.date, text: combined, updatedAt: new Date().toISOString() });
    stats.combined++;
  }
  return stats;
}

async function applyPulledPayload(payload) {
  // Refuse newer payloads we can't safely interpret — avoids silent data loss
  // if a stale client pulls a blob written by a future schema.
  const SUPPORTED_PAYLOAD_VERSION = 10;
  const pv = Number(payload && payload.version) || 1;
  if (pv > SUPPORTED_PAYLOAD_VERSION) {
    throw new Error(`This cloud backup was written by a newer version of the app (payload v${pv}). Please update before restoring.`);
  }
  await openDB();

  // A pull ADDS cloud records to what is already here. The old behaviour cleared
  // every store first, which silently destroyed anything logged on this device
  // since its last push — and left the database empty if the tab closed midway.
  const stats = {};
  stats.shots = await mergeStore(STORES.shots, (payload.shots || []).map(sanitizeShot).filter(Boolean), CONTENT_KEYS.shots);
  stats.weights = await mergeStore(STORES.weights, (payload.weights || []).map(sanitizeWeight).filter(Boolean), CONTENT_KEYS.weights);
  stats.supplies = await mergeStore('supplies', payload.supplies, CONTENT_KEYS.supplies);
  stats.measurements = await mergeStore('measurements', payload.measurements, CONTENT_KEYS.measurements);
  stats.labs = await mergeStore('labs', payload.labs, CONTENT_KEYS.labs);
  stats.expenses = await mergeStore('expenses', payload.expenses, CONTENT_KEYS.expenses);
  stats.cycles = await mergeStore('cycles', payload.cycles, CONTENT_KEYS.cycles);
  stats.medChanges = await mergeStore('medChanges', payload.medChanges, CONTENT_KEYS.medChanges);

  // Date-keyed daily stores: last write wins per day, which is the intent — one
  // mood/appetite/food-noise reading per date.
  for (const m of (payload.moods || [])) if (m && m.date) await dbPut(STORES.moods, m);
  for (const a of (payload.appetites || [])) if (a && a.date) await saveAppetite(a.date, a.value);
  for (const f of (payload.foodNoise || [])) if (f && f.date) await saveFoodNoise(f.date, f.value);
  // Symptom days merge per-symptom rather than last-write-wins: two devices each
  // adding a symptom on the same day should end up with both, not with whichever
  // pushed last. Severity conflicts on the same symptom resolve to the worse one,
  // which is the safe direction for something a clinician may read.
  const SE_RANK = { mild: 1, moderate: 2, severe: 3 };
  for (const raw of (payload.symptoms || [])) {
    const rec = sanitizeSymptomDay(raw);
    if (!rec) continue;
    const local = await getSymptomDay(rec.date);
    if (!local || !local.se) { await dbPut('symptoms', rec); continue; }
    const merged = { ...local.se };
    for (const [k, lvl] of Object.entries(rec.se)) {
      if (!merged[k] || (SE_RANK[lvl] || 0) > (SE_RANK[merged[k]] || 0)) merged[k] = lvl;
    }
    await dbPut('symptoms', { date: rec.date, se: merged, updatedAt: new Date().toISOString() });
  }
  // Notes are the exception to last-write-wins — see mergeNotes.
  stats.notes = await mergeNotes(payload.notes);

  window._lastMergeStats = stats;
  if (payload.settings) {
    const preserve = { syncEnabled: settings.syncEnabled, syncUsername: settings.syncUsername, syncLastPushAt: settings.syncLastPushAt, syncLastPullAt: settings.syncLastPullAt, syncLastUpdatedAt: settings.syncLastUpdatedAt };
    settings = { ...DEFAULT_SETTINGS, ...sanitizeSettings(payload.settings), ...preserve };
    await saveSettings();
    applySettingsToInputs();
  }
  settings.syncLastPullAt = new Date().toISOString();
  await saveSettings();
  // Force-refresh weight-date normalization on every pull (sync payloads may have come
  // from older app versions or other devices that hadn't been migrated).
  _weightDateMigrationDone = false;
  await migrateWeightDatesToCanonical();
  await renderShots();
  await renderWeights();
  // Notes pulled from another device have to reach the card and the journal, or
  // they sit in the database invisible until the next reload.
  try { await refreshDailyCards(); } catch (_) {}
}

// ---------- Sync UI ----------
function syncStatus(el, msg, kind) {
  const e = $(el);
  if (!e) return;
  e.textContent = msg || '';
  e.classList.remove('ok','err');
  if (kind) e.classList.add(kind);
}

function renderSyncUI() {
  const enabled = !!(settings.syncEnabled && syncCreds);
  $('#sync-enabled-view').classList.toggle('hidden', !enabled);
  $('#sync-disabled-view').classList.toggle('hidden', enabled);
  if (enabled) {
    $('#sync-current-user').textContent = settings.syncUsername || syncCreds.username;
    const last = settings.syncLastPushAt || settings.syncLastPullAt;
    $('#sync-last').textContent = last ? `Last sync: ${new Date(last).toLocaleString()}` : 'No sync yet.';
  }
}

async function attemptUnlockFromStored() {
  // Auto-unlock if we previously persisted creds (per-device convenience).
  try {
    const stored = localStorage.getItem('sync.creds');
    if (!stored) return false;
    const { u, p } = JSON.parse(stored);
    if (!u || !p) return false;
    syncCreds = await deriveSyncCreds(u, p);
    return true;
  } catch (e) { return false; }
}

function persistCreds(u, p) {
  try { localStorage.setItem('sync.creds', JSON.stringify({ u, p })); } catch (e) {}
}
function clearStoredCreds() {
  try { localStorage.removeItem('sync.creds'); } catch (e) {}
}


async function handleRestoreSync() {
  const u = $('#sync-user').value.trim();
  const p = $('#sync-pass').value;
  if (!u || !p) { syncStatus('#sync-setup-status', 'Username and passphrase are required.', 'err'); return; }
  syncStatus('#sync-setup-status', 'Deriving keys (this takes a few seconds)…');
  try {
    const creds = await deriveSyncCreds(u, p);
    syncStatus('#sync-setup-status', 'Pulling from cloud…');
    syncCreds = creds;
    const result = await syncPullNow();
    if (!result) {
      syncCreds = null;
      syncStatus('#sync-setup-status', 'No cloud copy found for those credentials.', 'err');
      return;
    }
    if (!confirm(`Found ${(result.payload.shots || []).length} shots in your legacy backup. Bring them across? They are merged in — nothing already on this device is removed.`)) {
      syncCreds = null;
      syncStatus('#sync-setup-status', 'Cancelled.');
      return;
    }
    await applyPulledPayload(result.payload);
    settings.syncEnabled = true;
    settings.syncUsername = creds.username;
    await saveSettings();
    // Deliberately NOT persisting the passphrase: this is a one-off recovery
    // path now, and keeping a passphrase in localStorage is exactly what the
    // account system moved away from.
    syncStatus('#sync-setup-status', '');
    renderSyncUI();
    const st = (window._lastMergeStats && window._lastMergeStats.shots) || null;
    alert(st ? `Restored. ${st.added} entries added, ${st.skipped} already here.` : 'Restored — your legacy entries have been merged in.');
  } catch (e) {
    syncCreds = null;
    syncStatus('#sync-setup-status', 'Failed: ' + e.message, 'err');
  }
}


async function handleSyncPull() {
  if (!syncCreds) return;
  if (!confirm('Pull your legacy backup across? Entries are merged in — nothing on this device is removed.')) return;
  syncStatus('#sync-status', 'Pulling…');
  try {
    const result = await syncPullNow();
    if (!result) { syncStatus('#sync-status', 'No cloud copy found.', 'err'); return; }
    await applyPulledPayload(result.payload);
    renderSyncUI();
    syncStatus('#sync-status', '✓ Pulled', 'ok');
    setTimeout(() => syncStatus('#sync-status', ''), 2500);
  } catch (e) {
    syncStatus('#sync-status', 'Failed: ' + e.message, 'err');
  }
}

async function handleSyncDisable() {
  if (!confirm('Forget the legacy backup on this device? Your local data is kept, and the backup itself is untouched.')) return;
  syncCreds = null;
  settings.syncEnabled = false;
  await saveSettings();
  clearStoredCreds();
  renderSyncUI();
}


async function initSyncUI() {
  // Pre-fill known username if we've used sync before
  if (settings.syncUsername) $('#sync-user').value = settings.syncUsername;

  // Legacy sync is recovery-only since 2026-08-09: the server rejects writes to
  // it, because the lookup id travelled in the URL and was the only credential.
  // The enable / push / delete controls are gone from the markup, so bind
  // defensively rather than assuming they exist.
  const on = (sel, fn) => { const el = $(sel); if (el) el.addEventListener('click', fn); };
  on('#sync-restore', handleRestoreSync);
  on('#sync-pull', handleSyncPull);
  on('#sync-disable', handleSyncDisable);

  if (settings.syncEnabled) {
    const ok = await attemptUnlockFromStored();
    if (!ok) {
      // creds not found locally — user needs to re-enter
      settings.syncEnabled = false;
      await saveSettings();
    }
  }
  renderSyncUI();

  // Safety net for account sync: markSyncDirty debounces a push after each
  // change, but a push that failed (offline, server blip) would otherwise sit
  // unretried until the next edit. Legacy sync no longer pushes at all.
  setInterval(async () => {
    if (!window._syncDirty) return;
    if (!account.user || !account.encryptionKey) return;
    try {
      await accountSyncPush();
      window._syncDirty = false;
    } catch (e) {
      noteSyncFailure(e);
    }
  }, 60000);
}
