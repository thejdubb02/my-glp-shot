// My GLP Shot: Achievements, the share card and confetti.
'use strict';

// ---------- Achievements ----------
let _badgesExpanded = false;

// Weight milestones carry a second label for kg users; everything else has one.
function badgeLabel(a) {
  if (!a) return '';
  return weightUnit() === 'kg' && a.labelKg ? a.labelKg : a.label;
}
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
    delta,                       // canonical pounds
    deltaKg: delta / LB_PER_KG,
    unit: weightUnit(),
    maxDose: doses.length ? Math.max(...doses) : 0,
    minDose: doses.length ? Math.min(...doses) : 0,
    moodCount: (moods || []).length,
    weightCount: (weights || []).length,
    comeback,
    appDays,
  };
}
// Drop recorded unlocks the data no longer earns (a badge from a mistyped
// weight), so the real unlock later celebrates. Returns true when it changed.
function revokeStaleAchievements(unlockedIds) {
  const keep = new Set(unlockedIds);
  const had = settings.achievements || [];
  if (!had.some(id => !keep.has(id))) return false;
  settings.achievements = [...keep];
  for (const id of had) if (!keep.has(id)) delete (settings.achievementDates || {})[id];
  return true;
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
  const cards = visible.map(a => `<button type="button" class="badge-tile" data-badge-id="${a.id}" aria-label="Share ${escapeHTML(badgeLabel(a))}"><img class="badge-tile-art" src="icons/achievements/${a.id}.webp" alt="" loading="lazy" onerror="this.style.display='none'"><span class="badge-tile-label">${escapeHTML(badgeLabel(a))}</span></button>`).join('');
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

  if (revokeStaleAchievements(unlocked.map(a => a.id))) await saveSettings();

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
  $('#badge-share-title').textContent = `🎉 ${badgeLabel(a)}`;
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
  wrapText(ctx, badgeLabel(a), W / 2, ruleY + 65, W - 160, 70);
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
