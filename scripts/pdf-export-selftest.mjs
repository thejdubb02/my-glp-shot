#!/usr/bin/env node
// PDF export self-test: runs the shipped runPdfExport against seeded
// IndexedDB data and inspects the HTML it writes to the print window.
//
//   node scripts/pdf-export-selftest.mjs
import { loadApp, Assert } from './lib/app-harness.mjs';

const { sandbox, R } = await loadApp();
const A = new Assert('pdf export');
const DAY = 86400000;
const iso = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString();
const dateOnly = (daysAgo) => iso(daysAgo).slice(0, 10);

// Capture what the app writes to the print window.
let written = null;
let alerts = [];
sandbox.open = () => ({ document: { write(h) { written = h; }, close() {} } });
sandbox.alert = (m) => alerts.push(m);
const run = async (opts) => { written = null; await R(`runPdfExport(${JSON.stringify(opts)})`); return written; };

R(`settings.medication = 'Ozempic'; settings.cadenceDays = 7; settings.cycleEnabled = false`);
await R(`dbPut('shots', ${JSON.stringify({ when: iso(3), dose: 0.5, site: 'Left thigh', notes: '<b>recent</b>' })})`);
await R(`dbPut('shots', ${JSON.stringify({ when: iso(200), dose: 0.25, site: 'Ancient site' })})`);
await R(`dbPut('weights', ${JSON.stringify({ date: dateOnly(3), value: 190, unit: 'lb' })})`);
await R(`saveNote(${JSON.stringify(dateOnly(2))}, 'private <script>alert(1)</script> note')`);

// ---- basic report
let html = await run({ range: '90', sections: ['shots', 'weights'] });
A.check('writes a document', typeof html === 'string' && html.startsWith('<!doctype html>'));
A.check('title carries the range', /Last 90 days Report/.test(html));
A.check('summary shows the medication and cadence', /Medication: Ozempic/.test(html) && /every 7 days/.test(html));
A.check('in-range shot is listed', /Left thigh/.test(html) && /0\.5 mg/.test(html));
A.check('shot beyond the range is left out', !/Ancient site/.test(html));
A.check('shot count reflects the range', /<strong>1<\/strong><span>shots<\/span>/.test(html));
A.check('weight section present', /<h2>Weight<\/h2>/.test(html) && /190 lb/.test(html));
A.check('free text is escaped', /&lt;b&gt;recent&lt;\/b&gt;/.test(html) && !/<b>recent<\/b>/.test(html));
A.check('page asks the browser to print', /window\.print\(\)/.test(html));

// ---- range
html = await run({ range: 'all', sections: ['shots'] });
A.check('"all" range includes the old shot', /Ancient site/.test(html) && /All-time Report/.test(html));

// ---- sections: unticked means absent
html = await run({ range: '90', sections: ['shots'] });
A.check('weights omitted when not ticked', !/<h2>Weight<\/h2>/.test(html));
html = await run({ range: '90', sections: ['weights'] });
A.check('shots omitted when not ticked', !/<h2>Shots/.test(html) && !/Left thigh/.test(html));

// ---- notes are private unless ticked
html = await run({ range: '90', sections: ['shots', 'weights'] });
A.check('notes never appear unless ticked', !/Daily notes/.test(html) && !/private/.test(html));
html = await run({ range: '90', sections: ['notes'] });
A.check('ticked notes appear', /Daily notes/.test(html) && /private/.test(html));
A.check('note text is escaped', !/<script>alert\(1\)<\/script>/.test(html.replace(/<script>window\.print\(\)<\/script>/, '')) && /&lt;script&gt;/.test(html));

// ---- popup blocked: tell the user, do not throw, do not write
sandbox.open = () => null;
alerts = [];
let threw = false;
try { await R(`runPdfExport({range:'90', sections:['shots']})`); } catch { threw = true; }
A.check('blocked popup does not throw', !threw);
A.check('blocked popup tells the user', alerts.some(m => /popups/i.test(m)), JSON.stringify(alerts));

// ---- range helpers
A.check('rangeCutoff("all") is the epoch', R(`rangeCutoff('all').getTime()`) === 0);
A.check('rangeCutoff of junk degrades to everything', R(`rangeCutoff('abc').getTime()`) === 0 && R(`rangeCutoff('-5').getTime()`) === 0);
A.check('rangeCutoff("30") is ~30 days ago', Math.abs(R(`Date.now() - rangeCutoff('30').getTime()`) - 30 * DAY) < 2 * 3600 * 1000);

A.report();
