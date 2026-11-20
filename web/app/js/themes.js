// My GLP Shot: App themes and emoji style (premium cosmetics).
'use strict';

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
      if (!isPremium() && account.user) { openUpgradeDialog(); return; }
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
      if (!isPremium() && account.user) { openUpgradeDialog(); return; }
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
      if (!isPremium() && account.user) { openUpgradeDialog(); return; }
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
