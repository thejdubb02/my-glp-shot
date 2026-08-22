#!/usr/bin/env node
// Change-email self-test — runs against a live API.
//
// This is the one feature where a partial success is data loss. The account
// email is the PBKDF2 salt, so changing it rotates the encryption key; if the
// address changes but the stored blob is not re-encrypted in the same breath,
// the user is left holding a key that cannot open their own ciphertext.
//
// So the assertions below care less about the happy path than about what
// happens when something goes wrong halfway.
//
//   node scripts/change-email-selftest.mjs --base http://127.0.0.1:5099
import { webcrypto as crypto } from 'node:crypto';

const argBase = process.argv.indexOf('--base');
const BASE = argBase > -1 ? process.argv[argBase + 1] : 'http://127.0.0.1:5099';
const PROTO = 'myglpshot-v1';
const ITERS = 600000;

let pass = 0; const failures = [];
const ok = (name, cond, extra = '') => { if (cond) { pass++; return true; } failures.push(`${name}${extra ? ` — ${extra}` : ''}`); return false; };
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

const b64 = (buf) => Buffer.from(buf).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));

// Mirrors deriveAccountCreds in web/app/app.js. If these ever drift, this
// suite stops testing the real thing — so it also asserts the app's constants.
async function derive(email, password) {
  const enc = new TextEncoder();
  const salt = await crypto.subtle.digest('SHA-256', enc.encode(`${PROTO}:${email.trim().toLowerCase()}`));
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: ITERS, hash: 'SHA-256' }, base, 512));
  const aesKey = await crypto.subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', true, ['encrypt', 'decrypt']);
  const authToken = Array.from(bits.slice(32, 64)).map(b => b.toString(16).padStart(2, '0')).join('');
  return { aesKey, authToken };
}

async function encrypt(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
  return { iv: b64(iv), ciphertext: b64(ct) };
}
async function decrypt(key, iv, ciphertext) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, key, unb64(ciphertext));
  return JSON.parse(new TextDecoder().decode(pt));
}

// This suite needs a live API. Rather than fail the default offline run, it
// reports a skip — but it must never skip silently, or a broken endpoint looks
// like a passing test run.
try {
  const probe = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) });
  if (!probe.ok) throw new Error(`health returned ${probe.status}`);
} catch (e) {
  console.log(`SKIPPED — no API at ${BASE} (${e.message}).`);
  console.log('Start one and re-run:  node scripts/change-email-selftest.mjs --base http://127.0.0.1:5099');
  process.exit(0);
}

let cookie = '';
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (cookie) headers.Cookie = cookie;
  const r = await fetch(`${BASE}/api${path}`, { ...opts, headers });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  let body = null;
  try { body = await r.json(); } catch (_) {}
  return { status: r.status, body };
}

const stamp = Date.now();
const OLD = `chg-old-${stamp}@example.com`;
const NEW = `chg-new-${stamp}@example.com`;
const OTHER = `chg-other-${stamp}@example.com`;
const PW = 'correct horse battery staple';

// ---------- the app and this suite must agree on the derivation ----------
{
  const fs = await import('node:fs');
  const appjs = fs.readFileSync(new URL('../web/app/app.js', import.meta.url), 'utf8');
  ok("suite's protocol string matches app.js", appjs.includes(`ACCOUNT_PROTOCOL = '${PROTO}'`));
  ok("suite's iteration count matches app.js", appjs.includes(`SYNC_PBKDF2_ITERS = ${ITERS}`));
}

// ---------- set up an account with a cloud blob ----------
const oldCreds = await derive(OLD, PW);
{
  const r = await api('/signup', { method: 'POST', body: JSON.stringify({ email: OLD, authToken: oldCreds.authToken }) });
  ok('signup succeeds', r.status === 200, `status ${r.status} ${JSON.stringify(r.body)}`);
}
const SECRET_DATA = { version: 10, shots: [{ when: '2026-05-01T09:00:00Z', dose: 5 }], notes: [{ date: '2026-05-01', text: 'must survive the email change' }] };
{
  const blob = await encrypt(oldCreds.aesKey, SECRET_DATA);
  const r = await api('/me/sync', { method: 'PUT', body: JSON.stringify(blob) });
  ok('cloud blob stored', r.status === 200, `status ${r.status}`);
}

// ---------- refusals, before the happy path ----------
const newCreds = await derive(NEW, PW);
{
  const wrong = await derive(OLD, 'not the password');
  const r = await api('/me/email', { method: 'POST', body: JSON.stringify({
    currentAuthToken: wrong.authToken, newEmail: NEW, newAuthToken: newCreds.authToken, iv: 'x', ciphertext: 'y' }) });
  eq('wrong password is rejected', r.status, 401);
}
{
  const r = await api('/me/email', { method: 'POST', body: JSON.stringify({
    currentAuthToken: oldCreds.authToken, newEmail: 'not-an-email', newAuthToken: newCreds.authToken }) });
  eq('malformed address is rejected', r.status, 400);
}
{
  const r = await api('/me/email', { method: 'POST', body: JSON.stringify({
    currentAuthToken: oldCreds.authToken, newEmail: OLD, newAuthToken: newCreds.authToken }) });
  eq('changing to the same address is rejected', r.status, 400);
}
{
  // THE important one: a blob exists, so omitting the re-encrypted replacement
  // must be refused rather than silently stranding the ciphertext.
  const r = await api('/me/email', { method: 'POST', body: JSON.stringify({
    currentAuthToken: oldCreds.authToken, newEmail: NEW, newAuthToken: newCreds.authToken }) });
  eq('omitting the re-encrypted blob is refused', r.status, 400);
  eq('  ...with the right reason', r.body && r.body.error, 'reencrypted_blob_required');
}
{
  // Nothing above should have changed anything.
  const me = await api('/me');
  eq('a refused attempt leaves the address untouched', me.body && me.body.user && me.body.user.email, OLD);
  const still = await api('/me/sync');
  if (!ok('blob still present after refusals', still.body && still.body.exists === true, JSON.stringify(still.body))) {
    console.log('  debug: /me/sync ->', still.status, JSON.stringify(still.body));
  } else {
    const round = await decrypt(oldCreds.aesKey, still.body.iv, still.body.ciphertext);
    eq('a refused attempt leaves the blob readable with the old key', round.notes[0].text, SECRET_DATA.notes[0].text);
  }
}

// ---------- taken addresses ----------
{
  const otherCookieHolder = cookie;
  cookie = '';
  const otherCreds = await derive(OTHER, PW);
  await api('/signup', { method: 'POST', body: JSON.stringify({ email: OTHER, authToken: otherCreds.authToken }) });
  cookie = otherCookieHolder;
  const blob = await encrypt(newCreds.aesKey, SECRET_DATA);
  const r = await api('/me/email', { method: 'POST', body: JSON.stringify({
    currentAuthToken: oldCreds.authToken, newEmail: OTHER, newAuthToken: (await derive(OTHER, PW)).authToken, ...blob }) });
  eq('an address already in use is rejected', r.status, 409);
}

// ---------- the happy path ----------
{
  const current = await api('/me/sync');
  const plain = await decrypt(oldCreds.aesKey, current.body.iv, current.body.ciphertext);
  const reencrypted = await encrypt(newCreds.aesKey, plain);
  const r = await api('/me/email', { method: 'POST', body: JSON.stringify({
    currentAuthToken: oldCreds.authToken, newEmail: NEW, newAuthToken: newCreds.authToken, ...reencrypted }) });
  ok('email change succeeds', r.status === 200, `status ${r.status} ${JSON.stringify(r.body)}`);
  eq('  ...and reports the new address', r.body && r.body.user && r.body.user.email, NEW);
}

// ---------- and the data survived ----------
{
  const after = await api('/me/sync');
  const round = await decrypt(newCreds.aesKey, after.body.iv, after.body.ciphertext);
  eq('the blob decrypts with the NEW key', round.notes[0].text, SECRET_DATA.notes[0].text);
  eq('  ...and the shots are intact', round.shots[0].dose, 5);

  let oldKeyWorks = true;
  try { await decrypt(oldCreds.aesKey, after.body.iv, after.body.ciphertext); }
  catch (_) { oldKeyWorks = false; }
  ok('the OLD key no longer opens it (the key really rotated)', oldKeyWorks === false);
}

// ---------- sign-in follows the new identity ----------
{
  cookie = '';
  const r = await api('/login', { method: 'POST', body: JSON.stringify({ email: NEW, authToken: newCreds.authToken }) });
  ok('sign-in works with the new address', r.status === 200, `status ${r.status}`);
  cookie = '';
  const old = await api('/login', { method: 'POST', body: JSON.stringify({ email: OLD, authToken: oldCreds.authToken }) });
  eq('sign-in with the old address fails', old.status, 401);
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log('\nFailures:'); failures.forEach(f => console.log(`  ✗ ${f}`)); process.exit(1); }
console.log('Change-email assertions all passed.');
