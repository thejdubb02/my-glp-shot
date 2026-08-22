// Headless screenshot generator for marketing assets.
// Logs in as the QA premium user, seeds realistic demo data into IndexedDB,
// then takes labeled screenshots of every major view in iPhone-sized + tablet sizes.
//
// Output: /opt/my-glp-shot/web/landing/screenshots/   (publicly servable under /screenshots/)
// Run:    node /opt/my-glp-shot/scripts/marketing-screenshots.js

const puppeteer = require('/tmp/node_modules/puppeteer-core');
const fs = require('fs');
const path = require('path');

// From OpenBao via my-glp-shot's own AppRole (migrated 2026-08-22). keyward_client is
// Python, so it is invoked rather than reimplemented for a third Node script. Arg array,
// not a shell string, so nothing is interpolated into a shell.
const { execFileSync } = require('child_process');
let KEYS = {};
try {
  KEYS = JSON.parse(execFileSync('python3', ['-c',
    'import sys, json; sys.path.insert(0, "/opt/keyward"); ' +
    'from keyward_client import get; ' +
    'out = {}\n' +
    'for n in ("mgs_qa_email", "mgs_qa_password"):\n' +
    '    try: out[n] = get("shared/" + n)\n' +
    '    except Exception: pass\n' +
    'print(json.dumps(out))'],
    { env: { ...process.env, KEYWARD_ENV: '/etc/keyward/my-glp-shot.env' },
      encoding: 'utf8', timeout: 20000 }));
} catch (e) {
  console.error('could not reach OpenBao for QA credentials:', e.message);
}
if (!KEYS.mgs_qa_email || !KEYS.mgs_qa_password) {
  // Refuse rather than type "undefined" into a login form and blame the app.
  console.error('\nQA credentials are not configured.');
  console.error('  mgs_qa_email    : ' + (KEYS.mgs_qa_email ? 'ok' : 'MISSING'));
  console.error('  mgs_qa_password : ' + (KEYS.mgs_qa_password ? 'ok' : 'MISSING'));
  console.error('\nNeither has ever existed in the credential store. Create a QA account for');
  console.error('My GLP Shot, add both to OpenBao under secret/shared/, and re-run.\n');
  process.exit(2);
}
const QA_EMAIL = KEYS.mgs_qa_email;
const QA_PASS  = KEYS.mgs_qa_password;
const APP_URL  = 'https://app.myglpshot.com/?nosw=1';
const OUT      = '/opt/my-glp-shot/web/landing/screenshots';

fs.mkdirSync(OUT, { recursive: true });

// --- Demo data --- realistic, last 12 weeks of weekly Tirzepatide tracking.
function buildDemo() {
  const now = Date.now();
  const day = 86400000;
  const shots = [];
  const weights = [];
  const moods = [];
  const sites = ['left abdomen', 'right abdomen', 'left thigh', 'right thigh', 'left arm', 'right arm'];
  const startWeight = 218.4;
  for (let i = 11; i >= 0; i--) {
    const when = new Date(now - i * 7 * day - 4 * 3600000); // each shot at ~6pm
    shots.push({
      med: 'Tirzepatide',
      dose: i >= 8 ? 2.5 : i >= 5 ? 5 : i >= 2 ? 7.5 : 10,
      when: when.toISOString(),
      site: sites[i % sites.length],
      notes: i === 11 ? 'First dose' : (i === 8 ? 'Bumped to 5mg' : null),
      sideEffects: i % 3 === 0 ? { nausea: 'mild' } : null,
    });
  }
  for (let i = 12; i >= 0; i--) {
    const date = new Date(now - i * 7 * day);
    const w = startWeight - (12 - i) * 1.7 - (Math.random() * 0.6 - 0.3);
    weights.push({ value: Math.round(w * 10) / 10, unit: 'lb', date: date.toISOString().slice(0, 10) });
  }
  // Last 14 days of moods
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now - i * day).toISOString().slice(0, 10);
    moods.push({ date: d, value: 3 + (i % 3 === 0 ? 1 : 0) });
  }
  return { shots, weights, moods };
}

async function seedDemo(page, demo) {
  // Wipe + repopulate IDB stores via in-page JS.
  return await page.evaluate(async (data) => {
    const wipe = (storeName) => new Promise((res, rej) => {
      const req = indexedDB.open('shotclock');
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(storeName)) { db.close(); res(); return; }
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).clear();
        tx.oncomplete = () => { db.close(); res(); };
        tx.onerror = () => rej(tx.error);
      };
      req.onerror = () => rej(req.error);
    });
    const addAll = (storeName, rows) => new Promise((res, rej) => {
      const req = indexedDB.open('shotclock');
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(storeName, 'readwrite');
        const s = tx.objectStore(storeName);
        for (const r of rows) s.add(r);
        tx.oncomplete = () => { db.close(); res(); };
        tx.onerror = () => rej(tx.error);
      };
    });
    await wipe('shots'); await wipe('weights'); await wipe('moods');
    await addAll('shots', data.shots);
    await addAll('weights', data.weights);
    await addAll('moods', data.moods);
    // Seed sensible settings.
    await new Promise((res, rej) => {
      const req = indexedDB.open('shotclock');
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('settings', 'readwrite');
        tx.objectStore('settings').put({
          key: 'app',
          value: {
            medication: 'Tirzepatide', defaultDose: 10, cadenceDays: 7, halfLifeDays: 5,
            notify: false, notifyLeadMinutes: 60, theme: 'light',
            startWeight: 218.4, goalWeight: 180,
          },
        });
        tx.oncomplete = () => { db.close(); res(); };
      };
    });
  }, demo);
}

async function shotIt(page, name) {
  // Aggressively close any open install/upgrade dialogs before snapping.
  await page.evaluate(() => {
    document.querySelectorAll('dialog[open]').forEach(d => { try { d.close(); } catch (_) {} });
  });
  await new Promise(r => setTimeout(r, 200));
  const file = path.join(OUT, name);
  await page.screenshot({ path: file, fullPage: false });
  return file;
}

async function captureViewport(browser, viewport, suffix) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  // Pre-dismiss the install nudge so it doesn't cover screenshots.
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem('install.lastShown', String(Date.now())); } catch (_) {}
  });
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

  // Seed demo data, then re-render by switching tabs.
  await seedDemo(page, buildDemo());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => typeof account !== 'undefined' && !!(account && account.user),
    { timeout: 15000 }
  ).catch(() => {});
  await new Promise(r => setTimeout(r, 2500)); // let charts render

  // 1. Home tab
  await page.evaluate(() => document.querySelector('#bottom-nav .nav-btn[data-nav-tab="home"]').click());
  await new Promise(r => setTimeout(r, 1500));
  await shotIt(page, `home-${suffix}.png`);

  // 2. Insights tab
  await page.evaluate(() => document.querySelector('#bottom-nav .nav-btn[data-nav-tab="insights"]').click());
  await new Promise(r => setTimeout(r, 2000));
  await shotIt(page, `insights-${suffix}.png`);

  // 3. Premium tab
  await page.evaluate(() => document.querySelector('#bottom-nav .nav-btn[data-nav-tab="more"]').click());
  await new Promise(r => setTimeout(r, 1500));
  await shotIt(page, `premium-${suffix}.png`);

  // 4. Settings tab
  await page.evaluate(() => document.querySelector('#bottom-nav .nav-btn[data-nav-tab="settings"]').click());
  await new Promise(r => setTimeout(r, 1000));
  await shotIt(page, `settings-${suffix}.png`);

  // 5. Log-shot dialog open (back to home first)
  await page.evaluate(() => document.querySelector('#bottom-nav .nav-btn[data-nav-tab="home"]').click());
  await new Promise(r => setTimeout(r, 500));
  await page.evaluate(() => document.getElementById('log-shot-btn').click());
  await new Promise(r => setTimeout(r, 800));
  await shotIt(page, `log-shot-dialog-${suffix}.png`);
  await page.evaluate(() => document.getElementById('shot-cancel').click());
  await new Promise(r => setTimeout(r, 300));

  await page.close();
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium-browser',
    headless: 'new',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--host-resolver-rules=MAP app.myglpshot.com 187.77.19.181',
      '--ignore-certificate-errors',
    ],
  });

  // iPhone 14 Pro size — primary marketing visual
  await captureViewport(browser, { width: 393, height: 852, deviceScaleFactor: 3, isMobile: true, hasTouch: true }, 'iphone');
  // iPad
  await captureViewport(browser, { width: 820, height: 1180, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, 'ipad');
  // Desktop browser (e.g. for full-bleed sections)
  await captureViewport(browser, { width: 1280, height: 800, deviceScaleFactor: 2 }, 'desktop');

  await browser.close();

  const files = fs.readdirSync(OUT).filter(f => f.endsWith('.png')).sort();
  console.log('=== Marketing screenshots ===');
  console.log(`Output: ${OUT}`);
  files.forEach(f => {
    const size = fs.statSync(path.join(OUT, f)).size;
    console.log(`  ${f.padEnd(35)} ${(size / 1024).toFixed(0)} KB`);
  });
})().catch(e => { console.error('FAIL:', e.message, e.stack); process.exit(1); });
