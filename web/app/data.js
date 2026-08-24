// My GLP Shot — static data tables and configuration.
//
// Split out of app.js purely for navigability: this file is 100% declarations
// with no behaviour, so it is the part of the codebase you read to answer "what
// are the valid X" rather than "what happens when Y".
//
// Loaded as a CLASSIC script before app.js, NOT an ES module, and deliberately
// so. app.js reassigns shared module-level state (`settings` alone has ~200
// references and is reassigned during settings-load and cloud-restore); with
// ES module bindings those reassignments become a TypeError at runtime, on the
// exact paths that touch a user's data. Same global scope keeps the split a
// pure move with no semantic change. Revisit once test coverage is broad
// enough to make a real encapsulation pass safe.
//
// Anything added here must stay free of behaviour — no DOM, no IndexedDB, no
// functions. If it needs those, it belongs in app.js.
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

const APP_VERSION = '0.61.0';

const STORES = { shots: 'shots', weights: 'weights', settings: 'settings', moods: 'moods', supplies: 'supplies' };

// Answers "where did this user come from?" at the only moment it is knowable.
// Server logs can't: the marketing site is served from Cloudflare's edge, so the
// origin never sees the original referrer, and by the time anyone asks, the logs
// have rotated. Captured first-touch, sent once at signup, never on login.
//
// Only a referrer HOST is ever stored or sent — never the full referring URL,
// which for a search engine contains the query someone typed.
const ATTRIB_KEY = 'mgs_attrib';

const ATTRIB_UTM = ['utm_source', 'utm_medium', 'utm_campaign'];

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
      const rows = weightsInLb(weights);
      const start = settings.startWeight ?? (rows[0] && rows[0].lb);
      const latest = rows.length ? rows[rows.length - 1].lb : null;
      const lost = (start != null && latest != null) ? (start - latest) : null;
      const firstShot = shots.length ? new Date(shots[0].when) : null;
      const weeks = firstShot ? Math.floor((Date.now() - firstShot.getTime()) / (7 * 86400000)) : 0;
      let yourLine = '<p><strong>For you right now:</strong> ';
      if (start != null && latest != null) yourLine += `you've gone from <strong>${fmtWeight(start)}</strong> to <strong>${fmtWeight(latest)}</strong> = <strong>${fmtWeight(Math.abs(lost))} ${lost > 0 ? 'lost' : 'gained'}</strong>`;
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
    body: () => `<p>Small badges that unlock as you hit milestones.</p>
      <ul>
        <li><strong>First shot logged</strong> — once you log your first dose</li>
        <li><strong>10 / 50 / 100 shots</strong> — total shots logged</li>
        <li><strong>4-week streak</strong> — four shots in a row at your scheduled cadence</li>
        <li><strong>${weightUnit() === 'kg' ? '2.5 / 5 / 10 kg' : '5 / 10 / 25 lb'} lost</strong> — weight change from your starting weight</li>
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
        const rows = weightsInLb(inWindow);
        const deltaLb = rows.length >= 2 ? rows[rows.length - 1].lb - rows[0].lb : 0;
        yourLine = `<p><strong>For you right now:</strong> ${inWindow.length} weight entries in the last 28 days, total change <strong>${fmtWeightDelta(deltaLb)}</strong>. ${Math.abs(deltaLb) < 1 ? '⚠️ This would currently flag as a plateau.' : 'No plateau — keep going.'}</p>`;
      } else {
        yourLine = `<p><strong>For you right now:</strong> need at least 4 weight entries in the last 28 days to detect a plateau (you have ${inWindow.length}).</p>`;
      }
      return `<p>Flags when your weight has been mostly flat for 4+ weeks at the same dose.</p>
        ${yourLine}
        <h3>Triggers when ALL are true</h3>
        <ul>
          <li>4+ weight entries in the last 28 days</li>
          <li>Total change less than ${fmtWeight(1, { dp: weightUnit() === 'kg' ? 1 : 0 })}</li>
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
      const rows = weightsInLb(weights);
      const start = settings.startWeight ?? (rows[0] && rows[0].lb);
      const latest = rows.length ? rows[rows.length - 1].lb : null;
      const lostLb = (start != null && latest != null && latest < start) ? (start - latest) : 0;
      const lost = lostLb > 0 ? fromLb(lostLb, weightUnit()) : 0;
      let yourLine = '';
      if (total > 0) {
        const perLb = lost > 0 ? `<strong>$${(total / lost).toFixed(2)} per ${weightUnit()} lost</strong>` : '';
        yourLine = `<p><strong>For you right now:</strong> $${supTotal.toFixed(2)} in supplies + $${expTotal.toFixed(2)} in expenses = <strong>$${total.toFixed(2)} total</strong>. ${perLb}</p>`;
      } else {
        yourLine = `<p><strong>For you right now:</strong> no spending tracked yet — add a pen/vial cost or an expense to get started.</p>`;
      }
      return `<p>Adds up everything you've spent on the program — pens, vials, copays, pharmacy fees, labs, insurance, supplies, shipping.</p>
        ${yourLine}
        <h3>How "$ per ${weightUnit()} lost" is calculated</h3>
        <div class="formula">$ per ${weightUnit()} = total_spent ÷ ${weightUnit() === 'kg' ? 'kilos' : 'pounds'}_lost</div>
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
  // Display unit for every weight on screen. Storage and all internal maths stay
  // in pounds regardless, so switching this never moves a goal or a milestone.
  weightUnit: 'lb',
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
  ['dizziness',       'Dizziness / light-headed', 'energy'],
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
  // Weight milestones run on their own ladder per unit so both read as round
  // numbers. Showing a kg user "0.9 kg lost" (the literal conversion of the 2 lb
  // tier) was the alternative, and it reads as a rounding error rather than an
  // achievement. `delta` is canonical pounds; `deltaKg` is the same figure in kg.
  { id: 'lost2',     icon: '🌱', label: 'First 2 lb lost',              labelKg: 'First 1 kg lost',             test: (s) => s.unit === 'kg' ? s.deltaKg <= -1  : s.delta <= -2 },
  { id: 'lost5',     icon: '⭐', label: '5 lb lost',                    labelKg: '2.5 kg lost',                 test: (s) => s.unit === 'kg' ? s.deltaKg <= -2.5 : s.delta <= -5 },
  { id: 'lost10',    icon: '🌟', label: '10 lb lost',                   labelKg: '5 kg lost',                   test: (s) => s.unit === 'kg' ? s.deltaKg <= -5  : s.delta <= -10 },
  { id: 'lost15',    icon: '💚', label: '15 lb lost',                   labelKg: '7 kg lost',                   test: (s) => s.unit === 'kg' ? s.deltaKg <= -7  : s.delta <= -15 },
  { id: 'lost25',    icon: '💫', label: '25 lb lost',                   labelKg: '10 kg lost',                  test: (s) => s.unit === 'kg' ? s.deltaKg <= -10 : s.delta <= -25 },
  { id: 'lost40',    icon: '🌠', label: '40 lb lost',                   labelKg: '18 kg lost',                  test: (s) => s.unit === 'kg' ? s.deltaKg <= -18 : s.delta <= -40 },
  { id: 'lost50',    icon: '✨', label: '50 lb lost',                   labelKg: '23 kg lost',                  test: (s) => s.unit === 'kg' ? s.deltaKg <= -23 : s.delta <= -50 },
  { id: 'lost75',    icon: '🦋', label: '75 lb lost',                   labelKg: '34 kg lost',                  test: (s) => s.unit === 'kg' ? s.deltaKg <= -34 : s.delta <= -75 },
  { id: 'lost100',   icon: '🏔️', label: '100 lb lost — life-changing', labelKg: '45 kg lost — life-changing', test: (s) => s.unit === 'kg' ? s.deltaKg <= -45 : s.delta <= -100 },
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

// Every array key buildPayload emits. Used for the export summary and to decide
// whether an imported file is a full payload or a legacy shots+weights one.
const EXPORT_STORE_KEYS = [
  'shots', 'weights', 'moods', 'appetites', 'foodNoise', 'notes', 'symptoms',
  'cycles', 'medChanges', 'supplies', 'measurements', 'labs', 'expenses',
];

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

const MOOD_LABELS = { 1: 'Awful', 2: 'Low', 3: 'Okay', 4: 'Good', 5: 'Great' };

const MOOD_SVG = {
  1: '<circle cx="16" cy="16" r="14" class="mood-bg"/><circle cx="11" cy="13" r="1.5" class="mood-eye"/><circle cx="21" cy="13" r="1.5" class="mood-eye"/><path d="M10 22 Q16 17 22 22" fill="none" class="mood-mouth"/>',
  2: '<circle cx="16" cy="16" r="14" class="mood-bg"/><circle cx="11" cy="13" r="1.5" class="mood-eye"/><circle cx="21" cy="13" r="1.5" class="mood-eye"/><path d="M11 21 Q16 18 21 21" fill="none" class="mood-mouth"/>',
  3: '<circle cx="16" cy="16" r="14" class="mood-bg"/><circle cx="11" cy="13" r="1.5" class="mood-eye"/><circle cx="21" cy="13" r="1.5" class="mood-eye"/><line x1="11" y1="20" x2="21" y2="20" class="mood-mouth"/>',
  4: '<circle cx="16" cy="16" r="14" class="mood-bg"/><circle cx="11" cy="13" r="1.5" class="mood-eye"/><circle cx="21" cy="13" r="1.5" class="mood-eye"/><path d="M10 19 Q16 24 22 19" fill="none" class="mood-mouth"/>',
  5: '<circle cx="16" cy="16" r="14" class="mood-bg"/><path d="M9 12 Q11 11 13 12" fill="none" class="mood-eye-arc"/><path d="M19 12 Q21 11 23 12" fill="none" class="mood-eye-arc"/><path d="M9 18 Q16 26 23 18 Z" class="mood-mouth-fill"/>',
};
