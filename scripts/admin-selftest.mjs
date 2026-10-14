#!/usr/bin/env node
// Admin UI self-test: loads the shipped web/admin/admin.js in a VM with a
// stub DOM and a canned API, then checks what the users table renders.
//
//   node scripts/admin-selftest.mjs
import fs from 'node:fs';
import vm from 'node:vm';
import { Assert } from './lib/app-harness.mjs';

const A = new Assert('admin ui');
const SRC = new URL('../web/admin/admin.js', import.meta.url).pathname;

const nodes = new Map();
const handlers = new Map(); // `${selector}:${event}` -> fn
const nodeFor = (sel) => {
  if (!nodes.has(sel)) {
    nodes.set(sel, {
      sel, value: '', textContent: '', innerHTML: '', className: '', dataset: {},
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      addEventListener(ev, fn) { handlers.set(`${sel}:${ev}`, fn); },
      querySelectorAll: () => [], querySelector: () => null,
    });
  }
  return nodes.get(sel);
};

const NOW = Math.floor(Date.now() / 1000);
const user = (o) => ({ id: 1, email: 'a@example.com', subscriptionStatus: 'free', isPremium: false, createdAt: NOW - 86400 * 40,
  trialEndsAt: null, premiumUntil: null, syncUpdatedAt: null, activeSessions: 0, hasStripeCustomer: false, ...o });
let users = [];
let total = 0;
const calls = [];
const fetchStub = async (url, opts) => {
  calls.push({ url, auth: opts.headers.Authorization });
  if (url.startsWith('/api/admin/users')) return { ok: true, status: 200, json: async () => ({ users, total, offset: 0 }) };
  return { ok: true, status: 200, json: async () => ({}) };
};
const store = new Map();
const sandbox = {
  console, setTimeout: () => 0, clearTimeout() {}, URLSearchParams, Date, Math, JSON, Promise, String, Array, parseInt, Number,
  document: { querySelector: nodeFor, querySelectorAll: () => [], body: nodeFor('body') },
  sessionStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
  location: { search: '' },
  fetch: fetchStub,
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: 'admin.js' });
await new Promise((r) => setImmediate(r)); // let the auto sign-in probe settle

const rows = async () => { await handlers.get('#filter-status:change')(); await new Promise((r) => setImmediate(r)); return nodeFor('#users-body').innerHTML; };

A.check('page probes the admin API on load', calls.some(c => c.url === '/api/admin/metrics'));

// ---- empty list
users = []; total = 0;
let html = await rows();
A.check('empty list says so', /No users\./.test(html));

// ---- the user's own text is escaped (an email is attacker-controlled input)
users = [user({ email: '<img src=x onerror=alert(1)>@evil.test' })]; total = 1;
html = await rows();
A.check('email cannot inject markup', !/<img/.test(html) && /&lt;img/.test(html), html.slice(0, 200));
users = [user({ signupUtmCampaign: '"><script>x</script>' })];
html = await rows();
A.check('campaign cannot inject markup or break out of the title attribute', !/<script>/.test(html) && !/title="[^"]*"><script/.test(html));

// ---- status pills
const pill = async (o) => { users = [user(o)]; return rows(); };
A.check('trial that is still live shows "trial"', /status-pill trial">trial</.test(await pill({ subscriptionStatus: 'trial', isPremium: true })));
A.check('expired trial shows "trial expired"', /status-pill expired">trial expired</.test(await pill({ subscriptionStatus: 'trial', isPremium: false })));
A.check('lapsed premium shows "lapsed"', /status-pill expired">lapsed</.test(await pill({ subscriptionStatus: 'premium', isPremium: false })));
A.check('paying premium shows "premium"', /status-pill premium">premium</.test(await pill({ subscriptionStatus: 'premium', isPremium: true })));

// ---- signup source
A.check('campaign beats referrer', /utm-cmp/.test(await pill({ signupUtmCampaign: 'utm-cmp', signupReferrer: 'google.com' })));
A.check('referrer shown when no campaign', />google\.com</.test(await pill({ signupReferrer: 'google.com' })));
A.check('landing with no referrer reads "direct"', />direct</.test(await pill({ signupLanding: '/' })));
A.check('pre-attribution users read as unknown', /muted small">—</.test(await pill({})));

// ---- sync and stripe cells
A.check('never-synced user shows "never"', />never</.test(await pill({})));
A.check('lifetime user has no expiry', /<td>—<\/td>/.test(await pill({ subscriptionStatus: 'lifetime', isPremium: true })));
A.check('stripe id is truncated to 12 chars', /cus_12345678…/.test(await pill({ hasStripeCustomer: true, stripeCustomerId: 'cus_1234567890ABCDEF' })) );

// ---- pagination
users = Array.from({ length: 50 }, (_, i) => user({ id: i + 1 })); total = 120;
await rows();
const pag = nodeFor('#users-pagination').innerHTML;
A.check('pagination shows range', /1-50 of 120/.test(pag));
A.check('first page: prev disabled, next enabled', /id="pg-prev"\s+disabled/.test(pag) && !/id="pg-next"\s+disabled/.test(pag));
users = [user()]; total = 1;
await rows();
A.check('single page: next disabled', /id="pg-next"\s+disabled/.test(nodeFor('#users-pagination').innerHTML));

// ---- filters reach the API
nodeFor('#filter-q').value = ' bob ';
nodeFor('#filter-status').value = 'trial';
await rows();
const last = calls[calls.length - 1].url;
A.check('search is trimmed and sent', /q=bob(&|$)/.test(last), last);
A.check('status filter is sent', /status=trial/.test(last), last);

A.report();
