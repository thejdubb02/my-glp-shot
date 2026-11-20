#!/usr/bin/env node
// Native bundle self-test: runs scripts/build-native-www.sh and checks what
// would ship inside the Android (later iOS) app. F-Droid rules: no tracking, no
// code fetched at run time. The website itself must stay as it is.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHART = path.join(ROOT, 'node_modules', 'chart.js', 'dist', 'chart.umd.js');
if (!fs.existsSync(CHART)) {
  console.log('native-bundle: skipped, run npm ci to test the app bundle');
  process.exit(0);
}
let pass = 0; const failures = [];
const ok = (name, cond) => { if (cond) pass++; else failures.push(name); };

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'mgs-native-www-'));
try {
  execFileSync('bash', [path.join(ROOT, 'scripts', 'build-native-www.sh'), out], { stdio: 'pipe' });
  const has = f => fs.existsSync(path.join(out, f));
  const index = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  const site = fs.readFileSync(path.join(ROOT, 'web', 'app', 'index.html'), 'utf8');

  ok('website still loads its analytics tag', site.includes('analytics.willhitestrategy.org'));
  ok('bundle has no analytics tag', !index.includes('analytics.willhitestrategy.org'));
  ok('bundle has no install manifest link', !/rel="manifest"/.test(index));
  for (const f of ['sw.js', 'manifest.webmanifest', 'view.html', 'reset.html', 'store', 'screenshots']) ok('bundle leaves out ' + f, !has(f));
  for (const f of ['data.js', 'styles.css', 'privacy.html', 'terms.html', 'js/platform.js']) ok('bundle keeps ' + f, has(f));

  const csp = (index.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/) || [])[1] || '';
  ok('bundle carries its own CSP', csp.includes("default-src 'self'"));
  ok('CSP allows scripts from the app only', /script-src 'self'(;|$)/.test(csp));
  ok('CSP names no third-party host', !/stripe|analytics|googleapis/.test(csp));
  ok('CSP lets the app reach an https sync server', /connect-src 'self' https:(;|$)/.test(csp));
  // Old Android WebViews get the native bridge as an inline script placed right
  // after a literal <head>. It must land before the CSP tag or the CSP blocks it
  // and the app quietly runs as a website.
  ok('bridge fallback lands before the CSP', index.includes('<head>') && index.indexOf('<head>') < index.indexOf('Content-Security-Policy'));
  ok('CSP comes before the first script', index.indexOf('Content-Security-Policy') < index.indexOf('<script'));

  const pages = fs.readdirSync(out).filter(f => f.endsWith('.html'));
  for (const page of pages) {
    const html = fs.readFileSync(path.join(out, page), 'utf8');
    const srcs = [...html.matchAll(/<(?:script|link|img|iframe)[^>]+(?:src|href)="([^"]+)"/g)].map(m => m[1]);
    const tags = [...html.matchAll(/<(script|link|img|iframe)[^>]+(?:src|href)="([^"]+)"/g)];
    ok(page + ': loads nothing from the network', !tags.some(m => /^(https?:)?\/\//.test(m[2]) && (m[1] !== 'link' || /rel="(stylesheet|preload|modulepreload)"/.test(m[0]))));
    for (const src of srcs.filter(s => !/^(https?:)?\/\/|^(data|mailto|about):|^#/.test(s))) {
      ok(page + ': ' + src + ' is in the bundle', has(src.split(/[?#]/)[0]));
    }
  }
  // One version everywhere: 0.67.15 in the app is versionName 0.67.15, code 6715.
  const version = (fs.readFileSync(path.join(ROOT, 'web', 'app', 'data.js'), 'utf8').match(/APP_VERSION = '([^']+)'/) || [])[1];
  const gradle = fs.readFileSync(path.join(ROOT, 'android', 'app', 'build.gradle'), 'utf8');
  const [major, minor, patch] = version.split('.').map(Number);
  ok('package.json version matches the app', JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version === version);
  ok('Android versionName matches the app', gradle.includes(`versionName "${version}"`));
  ok('Android versionCode matches the app', gradle.includes(`versionCode ${major * 10000 + minor * 100 + patch}\n`));
  ok('Chart.js is the npm build', fs.readFileSync(path.join(out, 'lib', 'chart.min.js')).equals(fs.readFileSync(CHART)));
} finally {
  fs.rmSync(out, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log('\nFailures:'); failures.forEach(f => console.log(`  ✗ ${f}`)); process.exit(1); }
