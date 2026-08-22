#!/usr/bin/env node
// PWA / Android-readiness self-test.
//
// The Play Store build (Bubblewrap) is generated FROM manifest.webmanifest, so
// a wrong value there becomes a wrong value in a shipped Android app that
// cannot be corrected without a new release. And a manifest can be entirely
// valid JSON while pointing at icons that don't exist or shortcuts wired to
// functions that don't — which is what this catches. The "Insights" launcher
// shortcut called a setTab() that never existed and failed into a silent catch.
//
//   node scripts/pwa-selftest.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, '..', 'web', 'app');

let pass = 0; const failures = [];
const ok = (name, cond, extra = '') => { if (cond) { pass++; return true; } failures.push(`${name}${extra ? ` — ${extra}` : ''}`); return false; };
const eq = (name, a, b) => ok(name, a === b, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

const manifest = JSON.parse(fs.readFileSync(path.join(APP, 'manifest.webmanifest'), 'utf8'));
const appjs = fs.readFileSync(path.join(APP, 'app.js'), 'utf8');
const datajs = fs.readFileSync(path.join(APP, 'data.js'), 'utf8');
const html = fs.readFileSync(path.join(APP, 'index.html'), 'utf8');
const sw = fs.readFileSync(path.join(APP, 'sw.js'), 'utf8');

function pngSize(rel) {
  const f = path.join(APP, rel.replace(/^\.\//, ''));
  if (!fs.existsSync(f)) return null;
  const b = fs.readFileSync(f).subarray(0, 24);
  if (b.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;
  return `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`;
}

// ---------- fields a TWA build depends on ----------
eq('display is standalone', manifest.display, 'standalone');
ok('start_url is set', !!manifest.start_url);
ok('scope is set', !!manifest.scope);
ok('name is set', !!manifest.name);
ok('short_name fits an Android launcher (<= 12 chars)', (manifest.short_name || '').length > 0 && manifest.short_name.length <= 12,
   `"${manifest.short_name}" is ${(manifest.short_name || '').length}`);
ok('theme_color is a hex colour', /^#[0-9a-f]{6}$/i.test(manifest.theme_color || ''), manifest.theme_color);
ok('background_color is a hex colour', /^#[0-9a-f]{6}$/i.test(manifest.background_color || ''), manifest.background_color);
ok('description is set (Play reads it)', !!manifest.description);
ok('an id is set, so the install identity is stable', !!manifest.id);
ok('categories declared', Array.isArray(manifest.categories) && manifest.categories.length > 0);

// theme_color must agree with the page, or the Android status bar and the
// splash disagree with the app.
const metaTheme = (html.match(/<meta name="theme-color" content="([^"]+)"/) || [])[1];
eq('index.html theme-color matches the manifest', metaTheme, manifest.theme_color);

// ---------- icons ----------
{
  const icons = manifest.icons || [];
  const purposes = icons.flatMap(i => String(i.purpose || 'any').split(/\s+/));
  ok('has a maskable icon (Android crops non-maskable ones)', purposes.includes('maskable'));
  ok('has a 192x192 icon', icons.some(i => i.sizes === '192x192'));
  ok('has a 512x512 icon', icons.some(i => i.sizes === '512x512'));
  for (const i of icons) {
    const actual = pngSize(i.src);
    ok(`icon ${i.src} exists and is a PNG`, actual !== null);
    if (actual && i.sizes) eq(`icon ${i.src} is really ${i.sizes}`, actual, i.sizes);
  }
}

// ---------- screenshots (the Play listing and the richer install prompt) ----------
{
  const shots = manifest.screenshots || [];
  ok('has at least 2 screenshots', shots.length >= 2, `${shots.length}`);
  ok('has a wide (desktop) screenshot', shots.some(s => s.form_factor === 'wide'));
  ok('has a narrow (phone) screenshot', shots.some(s => s.form_factor === 'narrow'));
  for (const s of shots) {
    const actual = pngSize(s.src);
    ok(`screenshot ${s.src} exists`, actual !== null);
    if (actual && s.sizes) eq(`screenshot ${s.src} is really ${s.sizes}`, actual, s.sizes);
    ok(`screenshot ${s.src} has a label`, !!s.label);
  }
}

// ---------- shortcuts must actually do something ----------
{
  const shortcuts = manifest.shortcuts || [];
  ok('declares launcher shortcuts', shortcuts.length > 0);
  const handled = { actions: new Set(), tabs: new Set() };
  // The handler enumerates what it accepts; read those lists rather than
  // hard-coding them here, so this tracks the code.
  for (const m of appjs.matchAll(/action === '([a-z-]+)'/g)) handled.actions.add(m[1]);
  const tabList = appjs.match(/\[\s*'home',\s*'insights',\s*'more'\s*\]/);
  ok('the handler enumerates home tabs', !!tabList);
  for (const t of ['home', 'insights', 'more']) handled.tabs.add(t);
  handled.tabs.add('settings');

  for (const sc of shortcuts) {
    ok(`shortcut "${sc.name}" has a url`, !!sc.url);
    const q = new URLSearchParams((sc.url || '').split('?')[1] || '');
    const action = q.get('action'), tab = q.get('tab');
    ok(`shortcut "${sc.name}" carries an action or tab`, !!(action || tab), sc.url);
    if (action) ok(`shortcut "${sc.name}" action "${action}" is handled in app.js`, handled.actions.has(action));
    if (tab) ok(`shortcut "${sc.name}" tab "${tab}" is handled in app.js`, handled.tabs.has(tab));
    for (const i of (sc.icons || [])) ok(`shortcut "${sc.name}" icon exists`, pngSize(i.src) !== null, i.src);
  }
  // Every function the handler calls has to exist, or it fails into a catch.
  for (const fn of ['showView', 'setHomeTab', 'openShotDialog']) {
    ok(`shortcut handler dependency ${fn}() is defined`,
      new RegExp(`function ${fn}\\b`).test(appjs));
  }
  // Comments discuss setTab() by name, so strip them before looking for a call.
  const code = appjs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const callsUndefined = [...code.matchAll(/\b([a-zA-Z_$][\w$]*)\s*\(/g)]
    .map(m => m[1])
    .filter(n => /^(setTab|setActiveTab|gotoTab)$/.test(n))
    .filter(n => !new RegExp(`function ${n}\\b`).test(code));
  ok('the shortcut handler calls no navigation function that is undefined',
    callsUndefined.length === 0, callsUndefined.join(', '));
}

// ---------- offline boot ----------
{
  const crit = (sw.match(/const CRITICAL = \[([\s\S]*?)\]/) || [])[1] || '';
  for (const f of ['index.html', 'styles.css', 'data.js', 'app.js']) {
    ok(`service worker pre-caches ${f}`, crit.includes(f));
  }
  const swCache = (sw.match(/const CACHE = '([^']+)'/) || [])[1] || '';
  const appVersion = (datajs.match(/APP_VERSION = '([^']+)'/) || [])[1] || '';
  ok('service worker cache name carries the app version',
    swCache.includes(appVersion), `cache="${swCache}" version="${appVersion}"`);
}

// ---------- accessibility basics ----------
// Static checks only — tap-target sizes need a real layout and are measured in
// a browser, not here. These three are the ones that silently rot as markup is
// added: a new field without a label reads to a screen reader as "edit, blank".
{
  const controls = [...html.matchAll(/<(input|select|textarea)\b([^>]*)>/g)];
  const unlabelled = [];
  for (const [, tag, attrs] of controls) {
    if (/type="(hidden|submit|button)"/.test(attrs)) continue;
    if (/\bhidden\b/.test(attrs)) continue;            // not in the a11y tree
    if (/aria-label|aria-labelledby/.test(attrs)) continue;
    const id = (attrs.match(/id="([^"]+)"/) || [])[1];
    if (id && html.includes(`for="${id}"`)) continue;
    const at = html.indexOf(attrs);
    const before = html.slice(Math.max(0, at - 200), at);
    if (before.lastIndexOf('<label') > before.lastIndexOf('</label>')) continue;  // wrapped
    unlabelled.push(`${tag}#${id || '(no id)'}`);
  }
  ok('every visible form control has an accessible name', unlabelled.length === 0, unlabelled.join(', '));

  const iconOnly = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
    .filter(([, attrs, inner]) => !inner.replace(/<[^>]+>/g, '').trim() && !/aria-label/.test(attrs))
    .map(([, attrs]) => (attrs.match(/id="([^"]+)"/) || [, '(no id)'])[1]);
  ok('every icon-only button has an aria-label', iconOnly.length === 0, iconOnly.join(', '));

  const noAlt = [...html.matchAll(/<img\b([^>]*)>/g)].filter(([, a]) => !/alt=/.test(a)).length;
  eq('every image has an alt attribute', noAlt, 0);

  ok('the document declares a language', /<html[^>]*\blang="/.test(html));
  ok('the viewport allows zooming (no user-scalable=no)', !/user-scalable\s*=\s*no/.test(html));
  ok('the viewport does not cap zoom below 5x',
    !/maximum-scale\s*=\s*[1-4](\D|$)/.test(html));
}

// ---------- things Play rejects health apps for ----------
{
  ok('a medical disclaimer is visible in the app', /not medical advice/i.test(html));
  ok('the app links a public account-deletion page', /delete-account\.html/.test(html));
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log('\nFailures:'); failures.forEach(f => console.log(`  ✗ ${f}`)); process.exit(1); }
console.log('PWA / Android assertions all passed.');
