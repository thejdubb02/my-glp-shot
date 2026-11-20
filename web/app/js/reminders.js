// My GLP Shot: Calendar (ICS) export, local notifications and web push reminders.
'use strict';

// ---------- ICS calendar feed ----------
async function downloadICS() {
  const shots = await getShotsSorted();
  if (!shots.length) { alert('Log a shot first to generate a recurring reminder.'); return; }
  const last = shots[0];
  const next = nextShotDate(last.when);
  const dt = (d) => d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//MyGLPShot//EN',
    'BEGIN:VEVENT',
    `UID:shotclock-${Date.now()}@willhitestrategy.org`,
    `DTSTAMP:${dt(new Date())}`,
    `DTSTART:${dt(next)}`,
    `DTEND:${dt(new Date(next.getTime() + 15 * 60000))}`,
    `SUMMARY:${settings.medication} shot due`,
    `DESCRIPTION:Time for your ${settings.defaultDose}mg ${settings.medication} shot.`,
    `RRULE:FREQ=DAILY;INTERVAL=${settings.cadenceDays || 7}`,
    'BEGIN:VALARM',
    'TRIGGER:-PT30M',
    'ACTION:DISPLAY',
    'DESCRIPTION:Shot reminder',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const blob = new Blob([ics], { type: 'text/calendar' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'shotclock-reminder.ics';
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

// ---------- Notifications ----------
// Strategy:
//   1. Notification Triggers API (Chrome/Edge, esp. installed Android PWA) → real scheduled push, fires when app is closed.
//   2. Fallback: setTimeout while app is open (any browser).
//   3. iOS PWA: requestPermission works on iOS 16.4+ when installed to home screen. Triggers API not supported, but iOS reschedules our SW periodically; we re-schedule in `pageshow` so reminders work when user opens the app.

let notifyTimer = null;
let dailyReminderTimers = [];
const TRIGGERS_SUPPORTED = (typeof window !== 'undefined') && ('Notification' in window) && ('showTrigger' in Notification.prototype || (typeof TimestampTrigger !== 'undefined'));

// One permission question for the browser and the native shell.
async function askNotifyPermission() {
  if (!IS_NATIVE) return typeof Notification !== 'undefined' && (await Notification.requestPermission()) === 'granted';
  try { return (await window.Capacitor.Plugins.LocalNotifications.requestPermissions()).display === 'granted'; }
  catch (_) { return false; }
}

function shotReminderBody() {
  const lead = (settings.notifyLeadMinutes || 0) * 60000;
  return lead > 0
    ? `Your ${settings.medication} shot is due in ${humanLead(lead)}.`
    : `${settings.medication} shot is due now.`;
}

// Native shell: the phone itself holds the schedule, no server involved. Every
// call replaces the whole queue, and calls run one after another so two quick
// settings changes cannot leave a stale reminder behind. Daily check-ins repeat
// on the phone's clock, so they keep firing however long the app stays closed.
let _nativeReminderRun = Promise.resolve();
function scheduleNativeReminders() {
  _nativeReminderRun = _nativeReminderRun.then(async () => {
    const LN = window.Capacitor?.Plugins?.LocalNotifications;
    if (!LN) return;
    const pending = (await LN.getPending()).notifications || [];
    if (pending.length) await LN.cancel({ notifications: pending.map(n => ({ id: n.id })) });
    const cfg = settings.dailyReminders || {};
    const list = [];
    for (const r of DAILY_REMINDERS) {
      const first = cfg[r.key]?.enabled && nextDailyTriggerAt(cfg[r.key].time);
      if (first) list.push({ title: r.title, body: r.body, schedule: { on: { hour: first.getHours(), minute: first.getMinutes() } } });
    }
    for (const r of await computeUpcomingReminders(true)) {
      list.push({ title: 'My GLP Shot', body: shotReminderBody(), schedule: { at: new Date(r.fireAt * 1000) } });
    }
    if (!list.length) return;
    // Reminder settings arrive with sync, so a phone that was never asked can
    // already have reminders switched on. Ask once; a refusal is not asked again.
    let perm = (await LN.checkPermissions()).display;
    if (perm === 'prompt') perm = (await LN.requestPermissions()).display;
    if (perm !== 'granted') return;
    list.forEach((n, i) => { n.id = i + 1; n.schedule.allowWhileIdle = true; });
    await LN.schedule({ notifications: list });
  }).catch(() => {});
  return _nativeReminderRun;
}

async function maybeScheduleNotification() {
  if (IS_NATIVE) return scheduleNativeReminders();
  // Top-level entry: re-plans the shot reminder and every enabled daily reminder.
  // Called on settings change, on pageshow, and after sync pull so changes
  // made on another device land immediately.
  if (notifyTimer) { clearTimeout(notifyTimer); notifyTimer = null; }
  dailyReminderTimers.forEach(t => clearTimeout(t));
  dailyReminderTimers = [];

  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;

  // Re-publish the upcoming fire times whenever the plan changes, so a schedule
  // edited here lands on the server that actually delivers when the app is shut.
  syncPushSchedule().catch(() => {});

  // Clear all scheduled notifications we own (shot-* and daily-*) before re-scheduling.
  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.ready;
      const existing = await reg.getNotifications({ includeTriggered: true });
      existing.forEach(n => {
        if (n.tag && (n.tag.startsWith('shot-') || n.tag.startsWith('daily-'))) n.close();
      });
    } catch (_) {}
  }

  await scheduleShotReminder();
  await scheduleDailyReminders();
}

async function scheduleShotReminder() {
  if (!settings.notify) return;
  const shots = await getShotsSorted();
  if (!shots.length) return;
  const next = nextShotDate(shots[0].when);
  const lead = (settings.notifyLeadMinutes || 0) * 60000;
  const fireAt = new Date(next.getTime() - lead);
  const ms = fireAt - new Date();
  if (ms > 86400000 * 30) return;

  const title = 'My GLP Shot';
  const body = shotReminderBody();
  const tag = `shot-${next.toISOString()}`;

  if (TRIGGERS_SUPPORTED && 'serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.ready;
      if (ms > 0) {
        await reg.showNotification(title, {
          body, tag, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png',
          showTrigger: new TimestampTrigger(fireAt.getTime()),
          data: { url: '/#reminder=shot' },
        });
        return;
      }
    } catch (e) {}
  }

  if (ms <= 0) return;
  if (ms > 86400000 * 14) return;
  notifyTimer = setTimeout(async () => {
    if ('serviceWorker' in navigator) {
      try {
        const reg = await navigator.serviceWorker.ready;
        await reg.showNotification(title, { body, tag, icon: 'icons/icon-192.png', data: { url: '/#reminder=shot' } });
        return;
      } catch (e) {}
    }
    new Notification(title, { body, icon: 'icons/icon-192.png' });
  }, ms);
}

async function scheduleDailyReminders() {
  // Re-planning replaces the whole set, so drop any timers still pending. The
  // roll-over call at the end of a fired reminder re-enters here directly
  // (not via maybeScheduleNotification, which is where clearing used to
  // happen), so without this every fire stacked another full set of timers and
  // a long-lived tab ended up showing the same reminder several times.
  dailyReminderTimers.forEach(t => clearTimeout(t));
  dailyReminderTimers = [];

  const cfg = settings.dailyReminders || {};
  for (const r of DAILY_REMINDERS) {
    const entry = cfg[r.key];
    if (!entry || !entry.enabled) continue;
    const fireAt = nextDailyTriggerAt(entry.time);
    if (!fireAt) continue;
    const ms = fireAt - new Date();
    if (ms <= 0) continue;

    const tag = `daily-${r.key}-${fireAt.toISOString().slice(0,10)}`;
    const opts = {
      body: r.body,
      tag,
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
      data: { url: '/' + r.route },
    };

    // Path 1: real OS-level scheduled trigger (Android/Chrome installed PWA).
    if (TRIGGERS_SUPPORTED && 'serviceWorker' in navigator) {
      try {
        const reg = await navigator.serviceWorker.ready;
        await reg.showNotification(`${r.emoji} ${r.title}`, {
          ...opts,
          showTrigger: new TimestampTrigger(fireAt.getTime()),
        });
        continue;
      } catch (_) { /* fall through */ }
    }

    // Path 2: in-process setTimeout (fires while app is open; on iOS we get
    // a second chance via pageshow re-scheduling on next app open).
    if (ms > 86400000 * 2) continue;
    const t = setTimeout(async () => {
      try {
        if ('serviceWorker' in navigator) {
          const reg = await navigator.serviceWorker.ready;
          await reg.showNotification(`${r.emoji} ${r.title}`, opts);
        } else {
          new Notification(`${r.emoji} ${r.title}`, { body: r.body, icon: 'icons/icon-192.png' });
        }
      } catch (_) {}
      // Roll the timer for tomorrow if the app is still open.
      scheduleDailyReminders();
    }, ms);
    dailyReminderTimers.push(t);
  }
}

// ---------- Web Push reminders ----------
// In-page timers can only fire while the app is open, and Notification Triggers
// is not shipped by any current browser. Push is the only way a reminder reaches
// someone who closed the tab three days ago.
//
// The privacy trade, stated plainly because it is the whole design: the server
// is told WHEN to send and nothing else. Fire times are computed here from the
// local (encrypted, server-unreadable) schedule; the wording is picked by the
// server from a fixed list keyed on `kind`. The medication, dose, sites and
// history never leave the device.
const PUSH_SUPPORTED = !IS_NATIVE && typeof window !== 'undefined'
  && 'serviceWorker' in navigator && 'PushManager' in window;
const PUSH_HORIZON_DAYS = 30;
const PUSH_MAX_QUEUED = 32;

function urlBase64ToUint8Array(b64) {
  const padding = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function getPushSubscription() {
  if (!PUSH_SUPPORTED) return null;
  try {
    // getRegistration, not .ready: .ready never settles without a worker, which
    // would hang sign-out.
    const reg = await navigator.serviceWorker.getRegistration();
    return reg ? await reg.pushManager.getSubscription() : null;
  } catch (_) { return null; }
}

async function enablePushReminders() {
  if (!PUSH_SUPPORTED) throw new Error('This browser cannot receive push reminders.');
  if (!account.user) throw new Error('Sign in first — push reminders need an account.');
  if (Notification.permission !== 'granted') {
    const p = await Notification.requestPermission();
    if (p !== 'granted') throw new Error('Notification permission was not granted.');
  }
  const keyResp = await accountFetch('push/key');
  if (!keyResp.ok) throw new Error('Push is not configured on the server yet.');
  const { publicKey } = await keyResp.json();

  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  // A subscription made against a different VAPID key is dead; replace it.
  if (sub) {
    const existing = sub.options && sub.options.applicationServerKey;
    const want = urlBase64ToUint8Array(publicKey);
    const same = existing && new Uint8Array(existing).length === want.length
      && new Uint8Array(existing).every((b, i) => b === want[i]);
    if (!same) { try { await sub.unsubscribe(); } catch (_) {} sub = null; }
  }
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  }
  const r = await accountFetch('push/subscribe', { method: 'POST', body: JSON.stringify(sub.toJSON()) });
  if (!r.ok) throw new Error('Could not register this device for reminders.');
  await syncPushSchedule();
  track('push_enabled');
  return true;
}

async function disablePushReminders() {
  if (IS_NATIVE) return;
  const sub = await getPushSubscription();
  try {
    await accountFetch('push/unsubscribe', {
      method: 'POST',
      body: JSON.stringify({ endpoint: sub ? sub.endpoint : '' }),
    });
  } catch (_) {}
  if (sub) { try { await sub.unsubscribe(); } catch (_) {} }
  track('push_disabled');
}

// Sign-out: stop this device getting the old account's reminders. Only with a
// real endpoint, since an empty one deletes the account's push on every device.
// Best effort; settings.notify stays, so local reminders and the UI still agree.
async function dropDevicePushOnSignOut() {
  try {
    const sub = await getPushSubscription();
    if (!sub) return;
    if (account.user) {
      try {
        await accountFetch('push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint }) });
      } catch (_) {}
    }
    await sub.unsubscribe();
  } catch (_) {}
}

// Compute the upcoming fire times from local data. Returns only {kind, fireAt}
// pairs — deliberately the least the server can be told and still send on time.
async function computeUpcomingReminders(shotsOnly) {
  const out = [];
  const now = Date.now();
  const horizon = now + PUSH_HORIZON_DAYS * 86400000;

  if (settings.notify) {
    const shots = await getShotsSorted();
    if (shots.length) {
      const lead = (settings.notifyLeadMinutes || 0) * 60000;
      // Project the cadence forward rather than sending only the next one, so a
      // user who doesn't open the app for a month still gets nudged.
      let next = nextShotDate(shots[0].when);
      const cadenceMs = Math.max(1, settings.cadenceDays || 7) * 86400000;
      for (let i = 0; i < 8; i++) {
        const fire = next.getTime() - lead;
        if (fire > now && fire <= horizon) out.push({ kind: 'shot', fireAt: Math.floor(fire / 1000) });
        next = new Date(next.getTime() + cadenceMs);
        if (next.getTime() > horizon) break;
      }
    }
  }

  const cfg = shotsOnly ? {} : settings.dailyReminders || {};
  for (const r of DAILY_REMINDERS) {
    const entry = cfg[r.key];
    if (!entry || !entry.enabled) continue;
    let fireAt = nextDailyTriggerAt(entry.time);
    if (!fireAt) continue;
    for (let d = 0; d < 14; d++) {
      const t = fireAt.getTime() + d * 86400000;
      if (t > now && t <= horizon) out.push({ kind: `daily:${r.key}`, fireAt: Math.floor(t / 1000) });
    }
  }

  out.sort((a, b) => a.fireAt - b.fireAt);
  return out.slice(0, PUSH_MAX_QUEUED);
}

async function syncPushSchedule() {
  if (!account.user) return null;
  const sub = await getPushSubscription();
  if (!sub) return null;                    // nothing registered: nothing to schedule
  try {
    const reminders = await computeUpcomingReminders();
    const r = await accountFetch('push/schedule', { method: 'PUT', body: JSON.stringify({ reminders }) });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    console.warn('[mgs] push schedule sync failed:', e);
    return null;
  }
}

function humanLead(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h !== 1 ? 's' : ''}`;
  const d = Math.round(h / 24);
  return `${d} day${d !== 1 ? 's' : ''}`;
}

// Populate the TZ select with grouped options. Current device TZ at the top.
function populateTimezoneOptions(sel) {
  const all = listSupportedTimezones();
  const deviceTz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (_) { return 'UTC'; } })();
  sel.innerHTML = '';
  const top = document.createElement('option');
  top.value = deviceTz;
  top.textContent = `Device default — ${deviceTz}`;
  sel.appendChild(top);
  for (const tz of all) {
    if (tz === deviceTz) continue;
    const o = document.createElement('option');
    o.value = tz;
    o.textContent = tz.replace(/_/g, ' ');
    sel.appendChild(o);
  }
}

function updateTimezoneStatus() {
  const el = $('#tz-status'); if (!el) return;
  const tz = getUserTz();
  let nowStr = '';
  try {
    nowStr = new Intl.DateTimeFormat(undefined, {
      timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit',
    }).format(new Date());
  } catch (_) {}
  el.textContent = `Current time in ${tz}: ${nowStr}`;
}

function renderDailyReminderRows() {
  const root = $('#daily-reminders-list');
  if (!root) return;
  const cfg = settings.dailyReminders || {};
  root.innerHTML = DAILY_REMINDERS.map(r => {
    const entry = cfg[r.key] || { enabled: false, time: '08:00' };
    const id = `dr-${r.key}`;
    return `
      <div class="daily-reminder-row">
        <label class="row daily-reminder-toggle">
          <input type="checkbox" id="${id}-on" data-rkey="${r.key}" ${entry.enabled ? 'checked' : ''}>
          <span class="daily-reminder-emoji" aria-hidden="true">${r.emoji}</span>
          <span class="daily-reminder-label">${r.label}</span>
        </label>
        <label class="daily-reminder-time">
          <span class="muted small">at</span>
          <input type="time" id="${id}-time" data-rkey="${r.key}" value="${escapeHTML(entry.time || '08:00')}">
        </label>
      </div>`;
  }).join('');
}

// Called on boot AND on pageshow. Reads #reminder=KEY from the URL hash
// (set by the SW notificationclick handler) and snaps the UI to the right
// section. Clears the hash so a refresh doesn't re-trigger.
function handleReminderDeepLink() {
  const m = (location.hash || '').match(/reminder=([a-zA-Z]+)/);
  if (!m) return;
  const key = m[1];
  try { history.replaceState(null, '', location.pathname + location.search); } catch (_) {}
  const tabAndAnchor = {
    weight:       { tab: 'home', scroll: '#weight-card' },
    moodAppetite: { tab: 'home', scroll: '#mood-card' },
    sideEffects:  { tab: 'home', scroll: '#symptoms-card' },
    measurements: { tab: 'more', scroll: '#measurements-card' },
    shot:         { tab: 'home', scroll: null },
  }[key];
  if (!tabAndAnchor) return;
  try {
    showView('home');
    setHomeTab(tabAndAnchor.tab);
  } catch (_) {}
  if (tabAndAnchor.scroll) {
    setTimeout(() => {
      const el = document.querySelector(tabAndAnchor.scroll);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);
  }
  if (key === 'weight') {
    setTimeout(() => { try { openWeightDialog(); } catch (_) {} }, 300);
  } else if (key === 'sideEffects') {
    // The reminder used to scroll to a card that didn't exist, so tapping the
    // notification landed on Home with nothing to do. Open the picker instead.
    setTimeout(() => { const b = document.querySelector('#symptoms-log-btn'); if (b) b.click(); }, 300);
  } else if (key === 'shot') {
    setTimeout(() => { const b = document.querySelector('#log-shot-btn'); if (b) b.click(); }, 300);
  }
}
window.addEventListener('pageshow', () => { try { handleReminderDeepLink(); } catch (_) {} });
if (!IS_NATIVE && 'serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    const data = e.data || {};
    if (data.type !== 'reminder-click' || !data.url) return;
    try {
      const u = new URL(data.url, location.origin);
      location.hash = u.hash;
      handleReminderDeepLink();
    } catch (_) {}
  });
}

function updateNotifyStatus() {
  if (IS_NATIVE) return;
  const el = $('#notify-status');
  if (!el) return;
  const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  if (typeof Notification === 'undefined') {
    el.textContent = 'Notifications not supported in this browser.'; return;
  }
  if (Notification.permission === 'denied') {
    el.textContent = 'Notifications blocked. Enable them in browser settings to receive shot reminders.'; return;
  }
  if (isIOS && !standalone) {
    el.textContent = 'On iOS, install My GLP Shot to your Home Screen first — notifications only work for installed PWAs.'; return;
  }
  if (!settings.notify) {
    el.textContent = PUSH_SUPPORTED && account.user
      ? 'Toggle on for reminders that arrive even when the app is closed.'
      : 'Toggle on to enable reminders.';
    return;
  }
  // Say which delivery path is actually live. Claiming "scheduled" when only an
  // in-page timer is running is how someone ends up missing a dose.
  el.textContent = '✓ Reminders on — checking delivery…';
  getPushSubscription().then(async (sub) => {
    if (sub && account.user) {
      const st = await accountFetch('push/status').then(r => r.ok ? r.json() : null).catch(() => null);
      if (st && st.configured && st.devices > 0) {
        const when = st.nextFireAt ? new Date(st.nextFireAt * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : null;
        el.textContent = when
          ? `✓ Reminders on — delivered even when the app is closed. Next: ${when}.`
          : '✓ Reminders on — delivered even when the app is closed.';
        return;
      }
    }
    if (!account.user) {
      el.textContent = '✓ Reminders on, but only while the app is open. Sign in to get them delivered when it\'s closed.';
    } else {
      el.textContent = '✓ Reminders on, but only while the app is open on this device. Re-toggle to retry background delivery.';
    }
  }).catch(() => {});
}

async function sendTestNotification() {
  if (typeof Notification === 'undefined') { alert('Not supported'); return; }
  if (Notification.permission !== 'granted') {
    const p = await Notification.requestPermission();
    if (p !== 'granted') { alert('Permission not granted'); return; }
  }
  const title = 'My GLP Shot test';
  const body = 'Notifications are working. Real reminders fire before each shot.';
  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification(title, { body, icon: 'icons/icon-192.png', data: { url: '/shotclock/' } });
      return;
    } catch (e) {}
  }
  new Notification(title, { body, icon: 'icons/icon-192.png' });
}
