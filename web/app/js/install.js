// My GLP Shot: Install-to-home-screen prompt for iOS, Android and desktop.
'use strict';

// ---------- Install prompt (iOS + Android + Desktop) ----------
let deferredInstallPrompt = null;

function detectPlatform() {
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isSafari = isIOS && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
  const isAndroid = /Android/.test(ua);
  const isMobile = isIOS || isAndroid;
  return { isIOS, isSafari, isAndroid, isMobile };
}

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function showInstallDialog() {
  if (IS_NATIVE) return;
  const dlg = $('#install-dialog');
  if (!dlg) return;
  $('#install-ios').classList.add('hidden');
  $('#install-ios-other').classList.add('hidden');
  $('#install-android').classList.add('hidden');
  $('#install-desktop').classList.add('hidden');
  const p = detectPlatform();
  if (p.isIOS && p.isSafari) $('#install-ios').classList.remove('hidden');
  else if (p.isIOS && !p.isSafari) $('#install-ios-other').classList.remove('hidden');
  else if (p.isAndroid) $('#install-android').classList.remove('hidden');
  else $('#install-desktop').classList.remove('hidden');
  dlg.showModal();
  track('install_prompt_shown', { platform: p.isIOS ? 'ios' : p.isAndroid ? 'android' : 'desktop' });
}

function setupInstallBanner() {
  if (IS_NATIVE) return;
  // Capture Android/Chrome/Edge install event whenever it fires.
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
  });
  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    localStorage.setItem('installDismissed', '1');
    const dlg = $('#install-dialog');
    if (dlg && dlg.open) dlg.close();
    const card = $('#install-card');
    if (card) card.classList.add('hidden');
  });

  // Hide the Settings install card if already installed.
  if (isStandalone()) {
    const card = $('#install-card');
    if (card) card.classList.add('hidden');
  }

  // Wire dialog buttons.
  $('#install-dismiss').addEventListener('click', () => {
    localStorage.setItem('installDismissedAt', String(Date.now()));
    $('#install-dialog').close();
  });
  $('#install-android-btn').addEventListener('click', async () => {
    if (!deferredInstallPrompt) {
      // Fallback: tell user to use the menu.
      $('#install-android-btn').disabled = true;
      $('#install-android-btn').textContent = 'Use ⋮ menu → Install app';
      return;
    }
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    if (outcome === 'accepted') $('#install-dialog').close();
  });
  $('#show-install-prompt').addEventListener('click', () => {
    if (isStandalone()) {
      alert('Already installed! 🎉');
      return;
    }
    showInstallDialog();
  });

}

// Auto-show install dialog once per 7 days, after sign-in. Called from onAccountChanged.
function maybeAutoShowInstall() {
  if (IS_NATIVE) return;
  try {
    if (isStandalone()) return;
    if (document.body.classList.contains('auth-active')) return;
    const dismissedAt = parseInt(localStorage.getItem('installDismissedAt') || '0', 10);
    if (dismissedAt && (Date.now() - dismissedAt) < 7 * 86400 * 1000) return;
    const dlg = document.getElementById('install-dialog');
    if (!dlg || dlg.open) return;
    setTimeout(() => {
      if (isStandalone()) return;
      if (document.body.classList.contains('auth-active')) return;
      if (dlg.open) return;
      showInstallDialog();
    }, 5000);
  } catch (_) {}
}

// A backup that fails quietly is worse than no backup — the user believes their
// health history is safe when it isn't. Record the failure, surface it in
// Settings, and warn once per session rather than swallowing the error.
let _syncFailureWarned = false;
