#!/usr/bin/env node
// Push sign-out self-test: accountLogout in app.js (GitHub issue #14).
//
// Signing out used to leave this device's push subscription on the old
// account, so its reminders kept arriving. Sign-out now deletes the server row
// for this device's endpoint (while the session is still valid) and drops the
// browser subscription, and still signs out when either step fails.
//
//   run via: bash scripts/run-tests.sh
import { loadApp, Assert } from './lib/app-harness.mjs';

const A = new Assert('push-signout');
const { R } = await loadApp({ domMode: 'stub' });

R(`
  globalThis.__t = { calls: [], unsubscribed: 0, failFetch: false, failUnsub: false, sub: null };
  accountFetch = async (p, opts) => {
    __t.calls.push({ p, body: opts && opts.body, signedIn: !!account.user });
    if (__t.failFetch && p === 'push/unsubscribe') throw new Error('offline');
    return { ok: true, status: 200, json: async () => ({}) };
  };
  getPushSubscription = async () => __t.sub;
  globalThis.__mkSub = () => ({ endpoint: 'https://push.example/dev1', unsubscribe: async () => {
    if (__t.failUnsub) throw new Error('unsubscribe failed');
    __t.unsubscribed++; return true;
  } });
`);
const signIn = () => R(`account = { user: { id: 7 }, encryptionKey: {} }; localStorage.setItem('mgs_session_token', 't')`);
const paths = () => R('__t.calls.map(c => c.p)');

// ---------- 1. sign-out unsubscribes this device, before logout ----------
signIn();
R(`__t.sub = __mkSub(); settings.notify = true;`);
await R('accountLogout(true)');
const p1 = paths();
const unsubCall = R(`__t.calls.find(c => c.p === 'push/unsubscribe')`);
A.check('server unsubscribe called', !!unsubCall);
A.eq('only this device endpoint is sent', unsubCall && JSON.parse(unsubCall.body).endpoint, 'https://push.example/dev1');
A.check('unsubscribe happens while still signed in', unsubCall && unsubCall.signedIn);
A.check('unsubscribe precedes logout', p1.indexOf('push/unsubscribe') >= 0 && p1.indexOf('push/unsubscribe') < p1.indexOf('logout'));
A.eq('browser subscription dropped', R('__t.unsubscribed'), 1);
A.eq('signed out', R('account.user'), null);
A.eq('settings.notify kept (local reminders, UI says app-open only)', R('settings.notify'), true);

// ---------- 2. both steps failing does not block sign-out ----------
signIn();
R(`__t.calls = []; __t.sub = __mkSub(); __t.failFetch = true; __t.failUnsub = true;`);
await R('accountLogout(true)');
A.check('still called logout', paths().includes('logout'));
A.eq('signed out despite failures', R('account.user'), null);
A.eq('session token cleared', R(`localStorage.getItem('mgs_session_token')`), null);

// ---------- 3. no subscription on this device: never sends an empty endpoint ----------
signIn();
R(`__t.calls = []; __t.sub = null; __t.failFetch = false; __t.failUnsub = false;`);
await R('accountLogout(true)');
A.check('no unsubscribe call (empty endpoint would wipe every device)', !paths().includes('push/unsubscribe'));
A.eq('signed out', R('account.user'), null);

A.report();
