// Headless contrast tester for the 20 color themes × light/dark modes.
// Loops through each theme, programmatically applies it, samples computed colors of key UI surfaces,
// and verifies WCAG-AA contrast (4.5:1 for normal text, 3:1 for large/UI). Reports failures.
//
// Usage: node /opt/my-glp-shot/scripts/theme-contrast-test.js
// Output: console table + screenshots at /tmp/mgs-theme-test-<ts>/

const puppeteer = require('/tmp/node_modules/puppeteer-core');
const fs = require('fs');
const path = require('path');

const KEYS = JSON.parse(fs.readFileSync('/root/.openclaw/workspace/daily/wsg-api-keys.json', 'utf8'));
const QA_EMAIL = KEYS.mgs_qa_email;
const QA_PASS = KEYS.mgs_qa_password;
const APP_URL = 'https://app.myglpshot.com/?nosw=1';
const OUT = `/tmp/mgs-theme-test-${Date.now()}`;
fs.mkdirSync(OUT, { recursive: true });

// Same theme list as in app.js. Kept in sync manually — script will fetch from page to avoid drift.
function srgbToLin(c) {
  c /= 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function relLuminance([r, g, b]) {
  return 0.2126 * srgbToLin(r) + 0.7152 * srgbToLin(g) + 0.0722 * srgbToLin(b);
}
function contrastRatio(rgb1, rgb2) {
  const l1 = relLuminance(rgb1), l2 = relLuminance(rgb2);
  const [light, dark] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (light + 0.05) / (dark + 0.05);
}
function parseColor(css) {
  // Accepts "rgb(r,g,b)" or "rgba(r,g,b,a)" — anything Chrome's getComputedStyle returns.
  const m = css.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  return m ? [+m[1], +m[2], +m[3]] : null;
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium-browser',
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox',
      '--host-resolver-rules=MAP app.myglpshot.com 187.77.19.181',
      '--ignore-certificate-errors'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 414, height: 900, deviceScaleFactor: 2 });
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem('install.lastShown', String(Date.now())); } catch (_) {}
  });
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise(r => setTimeout(r, 1500));

  // Login as QA premium user.
  await page.evaluate(() => document.querySelector('[data-auth-mode="login"]').click());
  await page.evaluate((e, p) => {
    document.getElementById('auth-email').value = e;
    document.getElementById('auth-pw').value = p;
  }, QA_EMAIL, QA_PASS);
  const navP = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null);
  await page.evaluate(() => document.getElementById('auth-submit').click());
  await navP;
  await page.waitForFunction(
    () => typeof account !== 'undefined' && !!(account && account.user && account.encryptionKey),
    { timeout: 15000 }
  ).catch(() => {});
  await new Promise(r => setTimeout(r, 1500));

  // Fetch theme list directly from the page to avoid drift.
  const themes = await page.evaluate(() => (typeof THEMES !== 'undefined' ? THEMES : []));
  if (!themes.length) {
    console.error('No THEMES exposed on window. Aborting.');
    process.exit(2);
  }

  // Sample points: which UI surfaces matter for legibility.
  const samples = [
    // [label, fg-selector, bg-selector, fg-getter, bg-getter, isLargeText]
    { label: 'body text vs surface',         fgSel: '.card p,.muted',                    bgSel: '.card',                    large: false },
    { label: 'card heading vs surface',       fgSel: '.card h2',                          bgSel: '.card',                    large: true  },
    { label: 'btn-primary text vs bg',        fgSel: '.btn-primary',                      bgSel: '.btn-primary',             large: true,  fgProp: 'color',           bgProp: 'background-color' },
    { label: 'nav-btn label vs nav bg',       fgSel: '#bottom-nav .nav-btn',              bgSel: '#bottom-nav',              large: false },
    { label: 'nav-btn-premium vs nav bg',     fgSel: '#bottom-nav .nav-btn-premium',      bgSel: '#bottom-nav',              large: false },
    { label: 'countdown value vs gradient',   fgSel: '.countdown-value',                  bgSel: '.countdown-card',          large: true  },
    { label: 'lock-pill vs surface',          fgSel: '.lock-pill',                        bgSel: '.lock-pill',               large: false, fgProp: 'color',           bgProp: 'background-color' },
    { label: 'theme-swatch.active border',    fgSel: '.theme-swatch.active .theme-swatch-name', bgSel: '.theme-swatch.active', large: false },
    { label: 'badge.unlocked text',           fgSel: '.badge.unlocked .badge-label',      bgSel: '.badge.unlocked',          large: false, fgProp: 'color',           bgProp: 'background-color' },
  ];

  const results = [];
  for (const mode of ['light', 'dark']) {
    for (const theme of themes) {
      // Apply theme + mode programmatically.
      await page.evaluate((mode, themeId) => {
        settings.theme = mode;
        applyTheme();
        settings.colorTheme = themeId;
        applyColorTheme(themeId);
      }, mode, theme.id);
      await new Promise(r => setTimeout(r, 300));

      // For each sample, fetch computed colors of fg + bg and compute contrast.
      const themeFails = [];
      for (const s of samples) {
        const data = await page.evaluate((sel, fgProp, bgSel, bgProp) => {
          const fgEl = document.querySelector(sel);
          if (!fgEl) return null;
          const fg = getComputedStyle(fgEl)[fgProp || 'color'];
          const bgEl = document.querySelector(bgSel);
          if (!bgEl) return null;
          // Walk up DOM until we find a non-transparent background.
          // Resolve effective bg: try background-color, then look for a gradient in background-image, else walk up.
          function effectiveBg(el) {
            const cs = getComputedStyle(el);
            const c = cs[bgProp || 'background-color'];
            if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return c;
            const img = cs.backgroundImage || '';
            const m = img.match(/(?:linear|radial)-gradient\([^)]*?(rgba?\([^)]*\)|#[0-9a-f]{3,8})/i);
            if (m) {
              if (m[1].startsWith('#')) {
                const h = m[1].replace('#', '');
                const r = parseInt(h.length === 3 ? h[0]+h[0] : h.slice(0,2), 16);
                const g = parseInt(h.length === 3 ? h[1]+h[1] : h.slice(2,4), 16);
                const b = parseInt(h.length === 3 ? h[2]+h[2] : h.slice(4,6), 16);
                return `rgb(${r}, ${g}, ${b})`;
              }
              return m[1];
            }
            return null;
          }
          let cur = bgEl, bg = effectiveBg(cur);
          while (!bg && cur.parentElement) { cur = cur.parentElement; bg = effectiveBg(cur); }
          return { fg, bg };
        }, s.fgSel, s.fgProp, s.bgSel, s.bgProp);
        if (!data) continue;
        const fg = parseColor(data.fg);
        const bg = parseColor(data.bg);
        if (!fg || !bg) continue;
        const ratio = contrastRatio(fg, bg);
        const min = s.large ? 3.0 : 4.5;
        if (ratio < min) {
          themeFails.push({ sample: s.label, ratio: ratio.toFixed(2), min, fg: data.fg, bg: data.bg });
        }
      }

      // Screenshot for visual review.
      const screenshotName = `${theme.id}-${mode}.png`;
      await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach(d => { try { d.close(); } catch (_) {} }));
      await page.screenshot({ path: path.join(OUT, screenshotName), fullPage: false });

      results.push({ theme: theme.id, mode, fails: themeFails });
    }
  }

  await browser.close();

  // Report
  console.log(`\n=== Theme contrast audit ===`);
  console.log(`Output dir (screenshots): ${OUT}`);
  console.log(`Themes tested: ${themes.length} × 2 modes = ${themes.length * 2} variants`);
  let totalFails = 0;
  console.log('\nFailures (contrast below WCAG AA threshold):');
  for (const r of results) {
    if (r.fails.length) {
      totalFails++;
      console.log(`\n  ✗ ${r.theme} (${r.mode}):`);
      for (const f of r.fails) {
        console.log(`      ${f.sample}: ${f.ratio} (need ≥${f.min}) fg=${f.fg} bg=${f.bg}`);
      }
    }
  }
  if (!totalFails) {
    console.log('  ✓ All themes pass.');
  }
  console.log(`\nSummary: ${results.length - totalFails}/${results.length} pass`);

  // Write JSON report.
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(results, null, 2));
  process.exit(totalFails ? 1 : 0);
})().catch(e => { console.error('FATAL:', e.message, e.stack); process.exit(2); });
