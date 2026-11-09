#!/usr/bin/env node
// Doctor-share label self-test (issue #25).
//
// The optional share label ("Dr. Smith - April visit") is health context. It
// used to ride next to the ciphertext in plaintext, and GET /api/share/<token>
// handed it to anyone holding the token. This drives the real createShareLink
// and the real view.js and checks:
//   1. the POST body to the server carries no plaintext label;
//   2. the owner's copy is AES-GCM ciphertext that the account key opens;
//   3. the doctor's page still shows the label, read from the encrypted payload,
//      with a server response that has no label field.
//
//   run via: bash scripts/run-tests.sh
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { loadApp, Assert } from './lib/app-harness.mjs';

const A = new Assert('share-label');
const { R } = await loadApp({ domMode: 'stub' });
const LABEL = 'Endocrinologist, diabetes follow-up';

const accountKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
const sandboxGlobal = R('globalThis');
sandboxGlobal.__accountKey = accountKey;
R(`
  globalThis.__sent = [];
  account = { user: { id: 1, email: 'a@example.com' }, encryptionKey: __accountKey };
  accountFetch = async (p, opts) => {
    __sent.push({ path: p, body: opts && opts.body });
    return { ok: true, status: 200, json: async () => ({ token: 'ab'.repeat(16), expiresAt: 4000000000 }) };
  };
`);

const result = await R(`createShareLink(${JSON.stringify(LABEL)}, {})`);
const sent = R('__sent');
A.eq('one request to the server', sent.length, 1);
const raw = sent[0].body;
const body = JSON.parse(raw);

// ---------- 1. no plaintext label leaves the device ----------
A.check('request body has no plaintext label', !raw.includes(LABEL), raw.slice(0, 200));
A.check('request body has no label field', !('label' in body) || body.label == null, JSON.stringify(body.label));

// ---------- 2. owner copy opens with the account key ----------
A.check('owner copy is sent', typeof body.labelEnc === 'string' && body.labelEnc.includes('.'), String(body.labelEnc));
if (typeof body.labelEnc === 'string') {
  const [ivB64, ctB64] = body.labelEnc.split('.');
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: Buffer.from(ivB64, 'base64') }, accountKey, Buffer.from(ctB64, 'base64'));
  A.eq('owner copy decrypts to the label', new TextDecoder().decode(pt), LABEL);
}

// ---------- 3. the doctor's page shows the label ----------
const here = path.dirname(fileURLToPath(import.meta.url));
const viewJs = fs.readFileSync(path.join(here, '..', 'web', 'app', 'view.js'), 'utf8');
const root = { innerHTML: '', textContent: '', appendChild(n) { this.innerHTML += n.textContent; } };
const hash = '#' + result.url.split('#')[1];
const ctx = vm.createContext({
  document: { getElementById: () => root, createElement: () => ({}) },
  location: { hash },
  URLSearchParams, Uint8Array, TextDecoder, Blob, DecompressionStream, Response, crypto, atob,
  // The server's share_fetch answer: iv, ciphertext, expiry. No label.
  fetch: async () => ({ ok: true, status: 200, json: async () => ({ iv: body.iv, ciphertext: body.ciphertext, expiresAt: 4000000000 }) }),
});
vm.runInContext(viewJs, ctx, { filename: 'view.js' });
for (let i = 0; i < 50 && !root.innerHTML; i++) await new Promise((r) => setTimeout(r, 10));
A.check('viewer rendered', root.innerHTML.includes('Patient summary'), root.innerHTML.slice(0, 200));
A.check('viewer shows the label', root.innerHTML.includes(LABEL), root.innerHTML.slice(0, 300));

A.report();
