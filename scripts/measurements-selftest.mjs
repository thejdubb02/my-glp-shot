#!/usr/bin/env node
// Body-measurement self-test.
//
// The measurement types used to be written out four times: as <option> tags in
// index.html, as a `labels` object in renderMeasurements, as a raw key in the
// PDF export, and as a raw key in the doctor-share page. Three of those four
// were already wrong the moment a type was added, and nothing failed loudly:
// the PDF just printed "high_hip" at a doctor.
//
// MEASUREMENT_TYPES in data.js is now the one list, and these assertions pin
// the things that would silently drift away from it again:
//   1. every stored key has a human label, including the six legacy ones
//   2. the dropdown is built from the list, not hardcoded in the HTML
//   3. view.html's private copy (it has to have one: it renders with no app
//      scripts) still agrees with data.js
//
//   node scripts/measurements-selftest.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadApp, Assert } from './lib/app-harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(HERE, '..', 'web', 'app');
const INDEX_HTML = fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8');
const VIEW_HTML = fs.readFileSync(path.join(APP_DIR, 'view.html'), 'utf8');
const APP_JS = fs.readFileSync(path.join(APP_DIR, 'app.js'), 'utf8');

const A = new Assert('measurements');
const { R } = await loadApp({ domMode: 'sticky' });

const TYPES = R('MEASUREMENT_TYPES');
const LABELS = R('MEASUREMENT_LABELS');

// ---------- the table itself ----------
A.check('MEASUREMENT_TYPES is a non-empty list', Array.isArray(TYPES) && TYPES.length >= 9,
  String(TYPES && TYPES.length));
for (const t of TYPES) {
  A.check(`${t.key} has a label`, typeof t.label === 'string' && t.label.length > 0);
  A.check(`${t.key} has a hint saying where the tape goes`,
    typeof t.hint === 'string' && t.hint.length > 10, t.hint);
  A.check(`${t.key} is a stable storage key`, /^[a-z][a-z_]*$/.test(t.key), t.key);
  A.check(`${t.key} hint has no em dash`, !/[—–…]/.test(t.hint), t.hint);
}
const keys = TYPES.map(t => t.key);
A.check('no duplicate keys', new Set(keys).size === keys.length, keys.join(','));

// Anything already in someone's IndexedDB must keep its label. Dropping one of
// these does not throw, it just shows a raw key on the card and in the PDF.
for (const legacy of ['waist', 'hips', 'chest', 'thigh', 'arm', 'neck']) {
  A.check(`legacy key "${legacy}" still has a label`, !!LABELS[legacy], LABELS[legacy]);
}

// What Lin actually asked for on 2026-09-19.
for (const added of ['bust', 'high_bust', 'high_hip']) {
  A.check(`"${added}" is offered`, keys.includes(added));
}
A.check('high bust is offered above bust', keys.indexOf('high_bust') < keys.indexOf('bust'));
A.check('high hip is offered above hips', keys.indexOf('high_hip') < keys.indexOf('hips'));
A.check('waist is still the default (first) option', keys[0] === 'waist', keys[0]);

A.check('MEASUREMENT_LABELS covers every type',
  keys.every(k => LABELS[k] === TYPES.find(t => t.key === k).label));

// ---------- the dropdown is generated, not hardcoded ----------
A.check('index.html no longer hardcodes measurement options',
  !/<select id="measurement-type">\s*<option/.test(INDEX_HTML));
A.check('index.html has the hint line', /id="measurement-hint"/.test(INDEX_HTML));

R('setupMeasurementUI()');
const optionsHTML = R("document.querySelector('#measurement-type').innerHTML");
for (const t of TYPES) {
  A.check(`dropdown offers ${t.label}`,
    optionsHTML.includes(`<option value="${t.key}">${t.label}</option>`));
}
// Re-running the setup is how this stub DOM simulates picking a type: the
// element keeps its .value, and showHint() runs again over it.
R("document.querySelector('#measurement-type').value = 'high_bust';");
R('setupMeasurementUI()');
A.eq('picking high bust shows where the tape goes',
  R("document.querySelector('#measurement-hint').textContent"),
  TYPES.find(t => t.key === 'high_bust').hint);

// ---------- everywhere a stored row is shown ----------
A.check('the summary pill uses the shared labels',
  /MEASUREMENT_LABELS\[type\] \|\| type/.test(APP_JS));
A.check('the PDF export uses the shared labels',
  /MEASUREMENT_LABELS\[m\.type\] \|\| m\.type/.test(APP_JS));
A.check('renderMeasurements no longer carries its own labels object',
  !/const labels = \{ waist:/.test(APP_JS));

// view.html decrypts and renders with none of the app's scripts loaded, so it
// keeps its own copy. That is the copy most likely to rot.
const viewMap = VIEW_HTML.match(/const M_LABELS = \{([\s\S]*?)\};/);
A.check('view.html has a measurement label map', !!viewMap);
if (viewMap) {
  const pairs = [...viewMap[1].matchAll(/(\w+):\s*'([^']+)'/g)];
  const viewLabels = Object.fromEntries(pairs.map(m => [m[1], m[2]]));
  A.check('view.html knows every type data.js offers',
    keys.every(k => viewLabels[k] === LABELS[k]),
    keys.filter(k => viewLabels[k] !== LABELS[k]).join(',') || 'all match');
  A.check('view.html adds nothing data.js does not have',
    Object.keys(viewLabels).every(k => !!LABELS[k]),
    Object.keys(viewLabels).filter(k => !LABELS[k]).join(','));
}
A.check('view.html labels measurement rows', /M_LABELS\[m\.type\] \|\| m\.type/.test(VIEW_HTML));
A.check('view.html labels lab rows', /L_LABELS\[l\.type\] \|\| l\.type/.test(VIEW_HTML));

A.report();
