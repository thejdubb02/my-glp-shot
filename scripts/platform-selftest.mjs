#!/usr/bin/env node
import { loadApp, Assert } from './lib/app-harness.mjs';

const A = new Assert('platform');
const hosted = 'https://app.myglpshot.com';

for (const mode of ['web', 'capacitor-web', 'native-android', 'native-ios']) {
  const native = mode.startsWith('native-');
  const origin = {
    'native-android': 'https://localhost',
    'native-ios': 'capacitor://localhost',
  }[mode] || 'https://web.example';
  const requests = [];
  const opened = [];
  const registrations = [];
  const phone = { calls: 0, permission: 'granted', cancelled: [], scheduled: [] };
  const { sandbox, R, nodeFor } = await loadApp({
    domMode: 'sticky',
    configureSandbox(sandbox) {
      if (mode !== 'web') sandbox.Capacitor = { isNativePlatform: () => native, Plugins: { LocalNotifications: {
        getPending: async () => { phone.calls++; return { notifications: [{ id: 99 }] }; },
        cancel: async arg => { phone.cancelled.push(...arg.notifications.map(n => n.id)); },
        checkPermissions: async () => ({ display: phone.permission }),
        requestPermissions: async () => { phone.calls++; return { display: phone.permission }; },
        schedule: async arg => { phone.scheduled.push(...arg.notifications); },
      } } };
      sandbox.location.origin = origin;
      sandbox.location.assign = url => opened.push([url]);
      sandbox.open = (...args) => opened.push(args);
      sandbox.setInterval = () => {};
      sandbox.PushManager = function () {};
      sandbox.navigator.serviceWorker.register = async url => {
        registrations.push(url);
        return { update: async () => {} };
      };
      sandbox.fetch = async (url, opts) => {
        requests.push({ url, opts });
        return { ok: true, json: async () => ({ token: 'doctor-token', url: 'https://billing.example' }) };
      };
    },
  });

  const base = native ? hosted + '/api' : 'api';
  A.eq(mode + ': default API base', R('apiBase()'), base);
  A.eq(mode + ': app origin', R('APP_ORIGIN'), native ? hosted : origin);
  A.eq(mode + ': track without Umami returns quietly', R("track('test_event', { count: 1 })"), undefined);
  const events = [];
  sandbox.umami = { track: (...args) => events.push(args) };
  R("track('test_event')");
  A.eq(mode + ': web tracker receives event when available', events[0]?.[0], 'test_event');
  delete sandbox.umami;

  R('registerSW()');
  await R('checkForStaleBundle()');
  A.eq(mode + ': service worker registration', registrations.join(','), native ? '' : 'sw.js');
  A.eq(mode + ': stale-bundle request', requests.shift()?.url, native ? undefined : '/index.html');
  A.eq(mode + ': web push support', R('PUSH_SUPPORTED'), !native);

  const windowEvents = [];
  sandbox.addEventListener = event => windowEvents.push(event);
  R('setupInstallBanner()');
  A.eq(mode + ': listens for web install prompts', windowEvents.includes('beforeinstallprompt'), !native);
  let installs = 0;
  nodeFor('#install-dialog').showModal = () => { installs++; };
  R('showInstallDialog()');
  A.eq(mode + ': install dialog is web only', installs, native ? 0 : 1);

  const webOnly = { classList: { add: name => { webOnly.hidden = name === 'hidden'; } } };
  sandbox.document.querySelectorAll = selector => selector === '[data-web-only]' ? [webOnly] : [];
  const handlers = new Map();
  let input0;
  const wire = id => {
    nodeFor('#' + id).addEventListener = (_, handler) => handlers.set(id, handler);
  };
  for (const id of ['native-server-save', 'native-server-reset', 'upgrade-cta', 'upgrade-confirm', 'manage-billing-cta']) wire(id);
  R('setupNativeSettings()');
  A.eq(mode + ': hides web-only entries', Boolean(webOnly.hidden), native);
  A.eq(mode + ': wires server settings only on native', handlers.has('native-server-save'), native);
  if (native) {
    const input = nodeFor('#native-server-address');
    input0 = input;
    A.eq('native: settings show default', input.value, base);
    input.value = '  https://sync.example/custom/api///  ';
    handlers.get('native-server-save')();
    A.eq('native: settings save trimmed HTTPS override', R('apiBase()'), 'https://sync.example/custom/api');
    for (const value of ['http://sync.example/api', '/api', 'https://', 'https://sync.example/api?test', 'https://user@sync.example']) {
      let rejected = false;
      try { R('setApiBase(' + JSON.stringify(value) + ')'); } catch (_) { rejected = true; }
      A.check('native: rejects ' + value, rejected);
    }
    A.eq('native: rejected override leaves prior value', R('apiBase()'), 'https://sync.example/custom/api');
  } else {
    R("setApiBase('https://sync.example/api')");
    A.eq(mode + ': web ignores saved override', R('apiBase()'), base);
  }

  if (native) {
    R("account.user = { id: 1 }");
    input0.value = 'https://other.example/api';
    handlers.get('native-server-save')();
    A.eq('native: signed-in save leaves the address alone', R('apiBase()'), 'https://sync.example/custom/api');
    R('account.user = null');
    const custom = await R("(async () => { localStorage.setItem('mgs_device_owner', '1'); let erased = 0; const real = eraseLocalData; eraseLocalData = async () => { erased++; }; await claimDevice({ id: 1 }); eraseLocalData = real; return erased + ':' + localStorage.getItem('mgs_device_owner'); })()");
    A.eq('native: same user id on another server is a different owner', custom, '1:https://sync.example/custom/api#1');
    R("account.user = { id: 1 }; account.encryptionKey = {}; buildPayload = async () => ({})");
    const customShare = await R("createShareLink('', {})");
    A.eq('native: doctor link follows a custom server', new URL(customShare.url).origin, 'https://sync.example');
    requests.length = 0;
    R('account.user = null');
  }
  sandbox.localStorage.setItem('mgs_session_token', 'session');
  await R("accountFetch('me')");
  const me = requests.shift();
  A.eq(mode + ': live account API URL', me.url, (native ? 'https://sync.example/custom/api' : 'api') + '/me');
  A.eq(mode + ': account credentials mode', me.opts.credentials, native ? 'omit' : 'same-origin');
  A.eq(mode + ': sends Bearer token', me.opts.headers.Authorization, 'Bearer session');
  if (native) {
    sandbox.localStorage.removeItem('mgs_session_token');
    handlers.get('native-server-reset')();
    A.eq('native: settings reset clears override', R('apiBase()'), base);
    sandbox.localStorage.setItem('mgs_api_base', 'http://invalid.example');
    A.eq('native: invalid stored address uses default', R('apiBase()'), base);
  }

  R("account.user = { id: 1 }; account.encryptionKey = {}; buildPayload = async () => ({})");
  const share = await R("createShareLink('', {})");
  A.eq(mode + ': doctor link origin', new URL(share.url).origin, native ? hosted : origin);
  A.eq(mode + ': share POST URL', requests.shift()?.url, base + '/share');

  let fileReads = 0;
  sandbox.confirm = () => false;
  await R('smartImport')({ target: { files: [{
    name: 'test.csv', size: 3, text: async () => { fileReads++; return 'csv'; },
  }] } });
  A.eq(mode + ': Smart Import can read a file only on web', fileReads, native ? 0 : 1);

  let modals = 0;
  nodeFor('#upgrade-dialog').showModal = () => { modals++; };
  R('setupAccountUI()');
  handlers.get('upgrade-cta')();
  A.eq(mode + ': upgrade modal', modals, native ? 0 : 1);
  A.eq(mode + ': upgrade opens system browser', JSON.stringify(opened.shift()), native ? JSON.stringify([hosted, '_system']) : undefined);
  A.eq(mode + ': upgrade entry itself makes no API request', requests.length, 0);
  for (const [id, endpoint] of [['upgrade-confirm', 'checkout'], ['manage-billing-cta', 'portal']]) {
    await handlers.get(id)();
    A.eq(mode + ': ' + endpoint + ' request', requests.shift()?.url, native ? undefined : base + '/billing/' + endpoint);
    A.eq(mode + ': ' + endpoint + ' destination', JSON.stringify(opened.shift()),
      JSON.stringify(native ? [hosted, '_system'] : ['https://billing.example']));
  }

  // Reminders: the phone's own scheduler on native, never touched on the web.
  R("settings.notify = false; settings.dailyReminders = { [DAILY_REMINDERS[0].key]: { enabled: true, time: '09:00' } }");
  await R('maybeScheduleNotification()');
  A.eq(mode + ': reminders use the phone scheduler only on native', phone.calls > 0, native);
  if (native) {
    const now = Date.now();
    A.eq('native: old reminders are cleared first', phone.cancelled.join(','), '99');
    A.eq('native: one repeating entry per daily reminder', phone.scheduled.length, 1);
    A.eq('native: daily reminder repeats at its time', JSON.stringify(phone.scheduled[0].schedule.on), '{"hour":9,"minute":0}');
    A.eq('native: reminder carries the daily text', phone.scheduled[0].title, R('DAILY_REMINDERS[0].title'));
    // Shot reminders ride alongside and are never crowded out by the dailies.
    phone.scheduled.length = 0;
    R("settings.notify = true; settings.cadenceDays = 7; settings.medication = 'TestMed'; settings.dailyReminders = Object.fromEntries(DAILY_REMINDERS.map(d => [d.key, { enabled: true, time: '08:30' }])); getShotsSorted = async () => [{ when: new Date(Date.now() - 86400000).toISOString() }]");
    await R('maybeScheduleNotification()');
    const shots = phone.scheduled.filter(n => n.schedule.at);
    A.eq('native: every daily reminder is queued', phone.scheduled.length - shots.length, R('DAILY_REMINDERS.length'));
    A.check('native: several shot reminders are queued ahead', shots.length >= 3);
    A.check('native: every shot reminder is in the future', shots.every(n => n.schedule.at.getTime() > now));
    A.check('native: shot reminder names the medication', shots[0].body.includes('TestMed'));
    A.eq('native: reminder ids are unique', new Set(phone.scheduled.map(n => n.id)).size, phone.scheduled.length);
    A.check('native: reminders may wake an idle phone', phone.scheduled.every(n => n.schedule.allowWhileIdle));
    R('settings.notify = false');
    A.eq('native: permission granted', await R('askNotifyPermission()'), true);
    phone.permission = 'denied';
    phone.scheduled.length = 0;
    await R('maybeScheduleNotification()');
    A.eq('native: nothing queued without permission', phone.scheduled.length, 0);
    A.eq('native: permission refused', await R('askNotifyPermission()'), false);
    R('settings.dailyReminders = {}');
    phone.permission = 'granted';
    await R('maybeScheduleNotification()');
    A.eq('native: nothing queued with reminders off', phone.scheduled.length, 0);
  }
}

A.report();
