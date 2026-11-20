// My GLP Shot: Day/night gradient and pull-to-refresh.
'use strict';

// ---------- Day/night gradient swap ----------
function applyTimeOfDayGradient() {
  const card = document.querySelector('.countdown-card');
  if (!card) return;
  const h = new Date().getHours();
  card.style.setProperty('--grad-hour-shift', (h < 6 || h >= 20) ? '-12%' : '0%');
}

// ---------- Pull-to-refresh ----------
function setupPullToRefresh() {
  let startY = 0, pulling = false, indicator = null;
  document.addEventListener('touchstart', (e) => {
    if (window.scrollY > 0) return;
    startY = e.touches[0].clientY;
    pulling = true;
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (!pulling) return;
    const dy = e.touches[0].clientY - startY;
    if (dy > 60) {
      if (!indicator) {
        indicator = document.createElement('div');
        indicator.className = 'ptr-indicator show';
        indicator.textContent = '↻ Release to sync';
        document.body.appendChild(indicator);
      }
    }
  }, { passive: true });
  document.addEventListener('touchend', async () => {
    if (indicator) {
      indicator.textContent = 'Syncing…';
      try { if (account.user && account.encryptionKey) await accountSyncPush(); } catch (e) { noteSyncFailure(e); }
      setTimeout(() => { indicator?.remove(); indicator = null; }, 600);
    }
    pulling = false;
  });
}
