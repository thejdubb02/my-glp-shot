// My GLP Shot: Push saved settings into the settings form; light/dark theme.
'use strict';

function applySettingsToInputs() {
  $('#set-med').value = settings.medication;
  // Sync preset dropdown to current medication name (snap to preset if matched, else 'custom').
  const presetSel = $('#set-med-preset');
  if (presetSel) {
    const matched = findMedPreset(settings.medication);
    presetSel.value = matched ? matched.id : 'custom';
  }
  $('#set-dose').value = settings.defaultDose;
  renderDoseChips('#set-dose-chips', '#set-dose', settings.medication);
  $('#set-cadence').value = settings.cadenceDays;
  $('#set-halflife').value = settings.halfLifeDays;
  const wu = weightUnit();
  if ($('#set-weight-unit')) $('#set-weight-unit').value = wu;
  $$('.weight-unit-label').forEach(el => { el.textContent = wu; });
  // Stored in pounds, shown in the user's unit.
  if ($('#set-start-weight')) $('#set-start-weight').value = settings.startWeight != null ? fmtWeight(settings.startWeight, { bare: true }) : '';
  if ($('#set-goal-weight'))  $('#set-goal-weight').value  = settings.goalWeight  != null ? fmtWeight(settings.goalWeight,  { bare: true }) : '';
  if ($('#set-maintenance'))  $('#set-maintenance').checked = !!settings.maintenanceMode;
  if ($('#set-mixing-calc'))  $('#set-mixing-calc').checked = !!settings.showMixingCalc;
  applyMixingCalcVisibility();
  $('#set-notify').checked = !!settings.notify && (typeof Notification !== 'undefined' && Notification.permission === 'granted');
  $('#set-lead').value = String(settings.notifyLeadMinutes ?? 60);
  const tzSel = $('#set-timezone');
  if (tzSel) {
    if (!tzSel.options.length) populateTimezoneOptions(tzSel);
    tzSel.value = settings.timezone || getUserTz();
  }
  updateTimezoneStatus();
  renderDailyReminderRows();
  $('#set-theme').value = settings.theme || 'system';
  applyTheme();
  applyColorTheme(settings.colorTheme || 'teal');
  applyMoodStyle(settings.moodStyle || 'classic');
  applyAppetiteStyle(settings.appetiteStyle || 'classic');
  // Refresh the picker grids so their "active" class reflects the current setting (matters after cross-device pull).
  try { if (typeof renderThemeGrid === 'function') renderThemeGrid(); } catch (_) {}
  try { if (typeof renderEmojiStyleGrid === 'function') renderEmojiStyleGrid(); } catch (_) {}
  try { if (typeof renderAppetiteStyleGrid === 'function') renderAppetiteStyleGrid(); } catch (_) {}
  updateNotifyStatus();
}

function applyTheme() {
  const t = settings.theme || 'system';
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem('theme', t); } catch(e){}
  // Re-apply the color theme so its tint flips to the right light/dark variant.
  if (typeof applyColorTheme === 'function') applyColorTheme(settings.colorTheme || 'teal');
}

let _editingWeightId = null; // null = logging a new weight

function setupNativeSettings() {
  if (!IS_NATIVE) return;
  document.querySelectorAll('[data-web-only]').forEach(el => el.classList.add('hidden'));
  const card = $('#native-server-settings');
  if (!card) return;
  const input = $('#native-server-address');
  const status = $('#native-server-status');
  function save(url) {
    // The session token belongs to the server that issued it. Never let it
    // travel to another address.
    let token = null;
    try { token = localStorage.getItem('mgs_session_token'); } catch (_) {}
    if (account.user || token) {
      status.textContent = 'Sign out before changing the server address.';
      return;
    }
    try {
      setApiBase(url);
      input.value = apiBase();
      status.textContent = 'Server address saved. Signing in to a different server replaces the data on this phone.';
    } catch (e) {
      status.textContent = e.message;
    }
  }
  input.value = apiBase();
  $('#native-server-save').addEventListener('click', () => save(input.value));
  $('#native-server-reset').addEventListener('click', () => save(''));
  card.classList.remove('hidden');
}
