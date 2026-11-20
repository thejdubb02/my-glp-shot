// My GLP Shot: Insights engine and the stats helpers it uses.
'use strict';

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
      const firstLb = toLb(first.value, first.unit), lastLb = toLb(last.value, last.unit);
      if (firstLb == null || lastLb == null) return null;
      return (lastLb - firstLb) / (days / 7);  // canonical lb per week
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
    el.addEventListener('click', () => openUpgradeDialog());
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

// Returns canonical POUNDS. settings.startWeight is stored in pounds too, so a
// user switching display units never shifts their own baseline.
function weightDelta(weights, startOverride) {
  const rows = weightsInLb(weights);
  if (!rows.length) return null;
  const override = parseFloat(startOverride);
  const start = Number.isFinite(override) ? override : rows[0].lb;
  const current = rows[rows.length - 1].lb;
  return { start, current, delta: current - start };
}
