// My GLP Shot — admin SPA. Vanilla JS, no deps. Token kept in sessionStorage only.
(() => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const TOKEN_KEY = 'mgs_admin_token';
  let token = sessionStorage.getItem(TOKEN_KEY) || '';
  // ?embedded=1 means: opened inside the PWA. Skip the token form entirely
  // and rely solely on session-cookie auth — if the cookie isn't admin, the
  // metrics call fails and we surface a small inline message instead of the
  // legacy token input.
  const EMBEDDED = new URLSearchParams(location.search).has('embedded');
  if (EMBEDDED) document.body && document.body.classList.add('embedded');
  let usersOffset = 0;
  const USERS_LIMIT = 50;

  // ---------- API helper ----------
  // Auth resolution order:
  //   1) Session cookie (sent automatically because credentials: 'include').
  //      Used when admin is opened inside the PWA — user signed in already.
  //   2) Bearer token from the legacy admin-token sign-in screen.
  async function api(path, opts = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const res = await fetch(path, {
      ...opts,
      credentials: 'include',
      headers,
    });
    if (res.status === 401) {
      signOut();
      throw new Error('Unauthorized');
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.message || `HTTP ${res.status}`);
    }
    return res.json();
  }

  // ---------- Auth ----------
  function signIn() {
    const v = $('#auth-token').value.trim();
    if (!v) { return showAuthError('Token required.'); }
    token = v;
    sessionStorage.setItem(TOKEN_KEY, token);
    // Verify by hitting metrics
    api('/api/admin/metrics')
      .then(() => { showApp(); loadAll(); })
      .catch((e) => { showAuthError(e.message); signOut(); });
  }
  function signOut() {
    token = '';
    sessionStorage.removeItem(TOKEN_KEY);
    $('#app').classList.add('hidden');
    $('#auth-screen').classList.remove('hidden');
    $('#auth-token').value = '';
  }
  function showAuthError(msg) {
    const e = $('#auth-error');
    e.textContent = msg;
    e.classList.remove('hidden');
  }
  function showApp() {
    $('#auth-screen').classList.add('hidden');
    $('#app').classList.remove('hidden');
  }

  // ---------- Format helpers ----------
  function fmtDate(ts) {
    if (!ts) return '—';
    const d = new Date(ts * 1000);
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }
  function fmtDateTime(ts) {
    if (!ts) return '—';
    return new Date(ts * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }
  function fmtRelative(ts) {
    if (!ts) return '—';
    const diff = Date.now() / 1000 - ts;
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    if (diff < 86400 * 30) return Math.floor(diff / 86400) + 'd ago';
    return fmtDate(ts);
  }
  function fmtMoney(cents) {
    return '$' + (cents / 100).toFixed(2);
  }
  function fmtBytes(b) {
    if (!b) return '—';
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1024 / 1024).toFixed(2) + ' MB';
  }
  function statusPill(status, isPremium) {
    let cls = status || 'free';
    let label = status || 'free';
    if (status === 'trial' && !isPremium) { cls = 'expired'; label = 'trial expired'; }
    if (status === 'premium' && !isPremium) { cls = 'expired'; label = 'lapsed'; }
    return `<span class="status-pill ${cls}">${label}</span>`;
  }
  function escapeHtml(s) {
    // Forward-safe: also escapes ', `, =, / so future template patterns
    // (single-quoted attrs, unquoted attrs, inline event handlers) stay safe.
    return String(s == null ? '' : s).replace(/[&<>"'`=\/]/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
      "'": '&#39;', '`': '&#96;', '=': '&#61;', '/': '&#47;',
    }[c]));
  }

  // ---------- Toast ----------
  function toast(msg, type = '') {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast ' + type;
    t.classList.remove('hidden');
    setTimeout(() => t.classList.add('hidden'), 2500);
  }

  // ---------- Charts (inline SVG, no deps) ----------
  function renderBarChart(target, data, labelFn, valueFn, color = '#c7915b') {
    const el = typeof target === 'string' ? $(target) : target;
    if (!el || !data.length) { el.innerHTML = '<p class="muted small">No data.</p>'; return; }
    const W = 600, H = 140, P = { l: 28, r: 8, t: 8, b: 22 };
    const max = Math.max(1, ...data.map(valueFn));
    const bw = (W - P.l - P.r) / data.length;
    const bars = data.map((d, i) => {
      const v = valueFn(d);
      const h = ((H - P.t - P.b) * v) / max;
      const x = P.l + i * bw + 1;
      const y = H - P.b - h;
      const lbl = labelFn(d);
      return `<g><rect x="${x}" y="${y}" width="${bw - 2}" height="${h}" fill="${color}" rx="2"><title>${escapeHtml(lbl)}: ${v}</title></rect>${v > 0 ? `<text x="${x + bw / 2 - 1}" y="${y - 2}" text-anchor="middle" fill="#94a3b8" font-size="9">${v}</text>` : ''}</g>`;
    }).join('');
    const xLabels = data.map((d, i) => {
      if (i % Math.ceil(data.length / 6) !== 0) return '';
      const x = P.l + i * bw + bw / 2;
      return `<text x="${x}" y="${H - 6}" text-anchor="middle" fill="#94a3b8" font-size="10">${escapeHtml(labelFn(d))}</text>`;
    }).join('');
    const yLabels = `<text x="4" y="${P.t + 8}" fill="#94a3b8" font-size="9">${max}</text><text x="4" y="${H - P.b - 2}" fill="#94a3b8" font-size="9">0</text>`;
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${bars}${xLabels}${yLabels}</svg>`;
  }

  function renderStatusBars(byStatus) {
    const total = Object.values(byStatus).reduce((a, b) => a + b, 0) || 1;
    const order = ['premium', 'lifetime', 'trial', 'free', 'other'];
    const html = order
      .filter(s => byStatus[s])
      .map(s => {
        const v = byStatus[s];
        const pct = (v / total) * 100;
        return `<div class="status-bar ${s}"><span>${s}</span><div><div class="status-bar-fill" style="width:${pct}%"></div></div><span class="muted">${v}</span></div>`;
      }).join('');
    $('#status-chart').innerHTML = html || '<p class="muted small">No users yet.</p>';
  }

  // ---------- Loaders ----------
  async function loadMetrics() {
    const m = await api('/api/admin/metrics');
    $('#m-users').textContent = m.totals.users;
    $('#m-premium').textContent = m.totals.activePremium;
    $('#m-trial').textContent = m.totals.activeTrial;
    $('#m-mrr').textContent = fmtMoney(m.mrrEstimateCents);
    $('#m-synced').textContent = m.totals.syncedAccounts;
    $('#m-shares').textContent = m.totals.activeShareLinks;
    // env badge
    const badge = $('#env-badge');
    if (m.stripeLiveEnabled && m.stripeTestEnabled) { badge.textContent = 'Stripe live + test'; badge.className = 'badge both'; }
    else if (m.stripeLiveEnabled) { badge.textContent = 'Stripe live'; badge.className = 'badge live'; }
    else if (m.stripeTestEnabled) { badge.textContent = 'Stripe test only'; badge.className = 'badge test'; }
    else { badge.textContent = 'Stripe not configured'; badge.className = 'badge'; }
    // signup chart
    renderBarChart(
      '#signup-chart',
      m.signupCurveWeekly,
      (d) => new Date(d.weekStart * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      (d) => d.count,
      '#c7915b',
    );
    const totalSignups = m.signupCurveWeekly.reduce((a, b) => a + b.count, 0);
    $('#signup-summary').textContent = `${totalSignups} in 13 weeks`;
    // events chart
    renderBarChart(
      '#events-chart',
      m.stripeEventCurveDaily,
      (d) => new Date(d.dayStart * 1000).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' }),
      (d) => d.count,
      '#60a5fa',
    );
    const totalEv = m.stripeEventCurveDaily.reduce((a, b) => a + b.count, 0);
    $('#events-summary').textContent = `${totalEv} in 30 days`;
    // status bars
    renderStatusBars(m.byStatus);
  }

  async function loadUsers() {
    const q = $('#filter-q').value.trim();
    const status = $('#filter-status').value;
    const params = new URLSearchParams({ limit: USERS_LIMIT, offset: usersOffset });
    if (q) params.set('q', q);
    if (status) params.set('status', status);
    const data = await api('/api/admin/users?' + params);
    const tbody = $('#users-body');
    if (!data.users.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="muted center">No users.</td></tr>';
      $('#users-pagination').innerHTML = '';
      return;
    }
    tbody.innerHTML = data.users.map(u => {
      const until = u.subscriptionStatus === 'lifetime' ? '—' :
        u.subscriptionStatus === 'trial' ? fmtDate(u.trialEndsAt) :
        fmtDate(u.premiumUntil);
      const stripe = u.hasStripeCustomer ? `<span class="muted small">${escapeHtml(u.stripeCustomerId.slice(0, 12))}…</span>` : '<span class="muted small">—</span>';
      return `<tr data-uid="${u.id}">
        <td>${escapeHtml(u.email)}</td>
        <td>${statusPill(u.subscriptionStatus, u.isPremium)}</td>
        <td>${fmtDate(u.createdAt)}</td>
        <td>${until}</td>
        <td>${u.syncUpdatedAt ? fmtRelative(u.syncUpdatedAt) : '<span class="muted">never</span>'}</td>
        <td>${u.activeSessions}</td>
        <td>${stripe}</td>
      </tr>`;
    }).join('');
    tbody.querySelectorAll('tr[data-uid]').forEach(tr => {
      tr.addEventListener('click', () => openUserDetail(parseInt(tr.dataset.uid, 10)));
    });
    // pagination
    const pag = $('#users-pagination');
    const total = data.total;
    const showing = `${data.offset + 1}-${Math.min(data.offset + data.users.length, total)} of ${total}`;
    pag.innerHTML = `
      <button class="btn btn-ghost" id="pg-prev" ${usersOffset === 0 ? 'disabled' : ''}>← Prev</button>
      <span class="muted small">${showing}</span>
      <button class="btn btn-ghost" id="pg-next" ${data.offset + data.users.length >= total ? 'disabled' : ''}>Next →</button>
    `;
    $('#pg-prev')?.addEventListener('click', () => { usersOffset = Math.max(0, usersOffset - USERS_LIMIT); loadUsers(); });
    $('#pg-next')?.addEventListener('click', () => { usersOffset += USERS_LIMIT; loadUsers(); });
  }

  async function loadEvents() {
    const data = await api('/api/admin/stripe-events?limit=50');
    const tbody = $('#events-body');
    if (!data.events.length) {
      tbody.innerHTML = '<tr><td colspan="3" class="muted center">No webhook events yet.</td></tr>';
      $('#events-count').textContent = '';
      return;
    }
    tbody.innerHTML = data.events.map(e =>
      `<tr><td><span class="muted small">${escapeHtml(e.id)}</span></td><td>${escapeHtml(e.type)}</td><td>${fmtRelative(e.received_at)}</td></tr>`
    ).join('');
    $('#events-count').textContent = `${data.events.length} most recent`;
  }

  async function loadTraffic() {
    const root = $('#traffic-cards');
    const summary = $('#traffic-summary');
    if (!root) return;
    let data;
    try { data = await api('/api/admin/traffic'); }
    catch (e) { root.innerHTML = `<p class="muted">${escapeHtml(e.message)}</p>`; return; }
    if (!data.configured) {
      root.innerHTML = `<p class="muted">${escapeHtml(data.message || 'Analytics not configured.')}</p>`;
      return;
    }
    if (!data.ok) {
      root.innerHTML = `<p class="muted">${escapeHtml(data.message || 'Could not reach analytics.')}</p>`;
      return;
    }
    summary.textContent = `Updated ${fmtRelative(data.ts)}`;
    root.innerHTML = data.sites.map(renderTrafficCard).join('');
  }

  function renderTrafficCard(s) {
    const r24 = s.ranges['24h'] || {};
    const r7  = s.ranges['7d']  || {};
    const r30 = s.ranges['30d'] || {};
    const cell = (label, n) => `<div class="t-metric"><div class="t-label">${label}</div><div class="t-value">${n}</div></div>`;
    const pageRow = (p) => {
      const path = (p.url || '/').slice(0, 48);
      return `<div class="t-row"><span class="t-row-key">${escapeHtml(path)}</span><span class="t-row-val">${p.views}</span></div>`;
    };
    const refRow = (r) => {
      const src = (r.source || 'Direct').slice(0, 48);
      return `<div class="t-row"><span class="t-row-key">${escapeHtml(src)}</span><span class="t-row-val">${r.visits}</span></div>`;
    };
    const pages = s.topPages.length
      ? s.topPages.map(pageRow).join('')
      : '<div class="t-empty">No pageviews yet</div>';
    const refs = s.topReferrers.length
      ? s.topReferrers.map(refRow).join('')
      : '<div class="t-empty">No referrers yet (direct/bookmark traffic)</div>';
    return `
      <div class="t-card">
        <div class="t-card-head"><strong>${escapeHtml(s.label)}</strong></div>
        <div class="t-ranges">
          <div class="t-range">
            <div class="t-range-label">Last 24h</div>
            <div class="t-metric-row">${cell('Visitors', r24.visitors || 0)}${cell('Views', r24.pageviews || 0)}</div>
          </div>
          <div class="t-range">
            <div class="t-range-label">Last 7 days</div>
            <div class="t-metric-row">${cell('Visitors', r7.visitors || 0)}${cell('Views', r7.pageviews || 0)}</div>
          </div>
          <div class="t-range">
            <div class="t-range-label">Last 30 days</div>
            <div class="t-metric-row">${cell('Visitors', r30.visitors || 0)}${cell('Views', r30.pageviews || 0)}</div>
          </div>
        </div>
        <div class="t-cols">
          <div class="t-col">
            <div class="t-col-head">Top pages (7d)</div>
            ${pages}
          </div>
          <div class="t-col">
            <div class="t-col-head">Top referrers (7d)</div>
            ${refs}
          </div>
        </div>
      </div>`;
  }

  // ---------- User detail dialog ----------
  async function openUserDetail(uid) {
    const dlg = $('#user-detail-dialog');
    $('#ud-body').innerHTML = '<p class="muted center">Loading…</p>';
    dlg.showModal();
    let data;
    try { data = await api('/api/admin/users/' + uid); }
    catch (e) { $('#ud-body').innerHTML = `<p class="error">${escapeHtml(e.message)}</p>`; return; }
    const u = data.user;
    $('#ud-email').textContent = u.email;
    const liveStripeRow = u.stripeCustomerId
      ? `<dt>Live customer</dt><dd><code>${escapeHtml(u.stripeCustomerId)}</code></dd>
         <dt>Live subscription</dt><dd><code>${escapeHtml(u.stripeSubscriptionId || '—')}</code></dd>`
      : '';
    const testStripeRow = u.stripeCustomerIdTest
      ? `<dt>Test customer</dt><dd><code>${escapeHtml(u.stripeCustomerIdTest)}</code> · ${escapeHtml(u.testSubscriptionStatus || '—')}</dd>`
      : '';
    const sessionsRows = data.sessions.map(s =>
      `<tr><td><code>${escapeHtml(s.tokenPrefix)}…</code></td><td>${fmtRelative(s.lastSeen || s.createdAt)}</td><td class="muted small">${escapeHtml((s.userAgent || '').slice(0, 60))}</td></tr>`
    ).join('') || '<tr><td colspan="3" class="muted">No sessions.</td></tr>';
    const sharesRows = data.shareLinks.map(s =>
      `<tr><td><code>${escapeHtml(s.token.slice(0, 8))}…</code></td><td>${fmtRelative(s.created_at)}</td><td>${fmtRelative(s.expires_at)}</td><td>${s.views}</td><td>${escapeHtml(s.label || '—')}</td></tr>`
    ).join('') || '<tr><td colspan="5" class="muted">No share links.</td></tr>';
    const sync = data.sync ? `${fmtBytes(data.sync.size)} · updated ${fmtRelative(data.sync.updatedAt)}` : '<span class="muted">never synced</span>';

    $('#ud-body').innerHTML = `
      <dl class="kv-grid">
        <dt>User ID</dt><dd>${u.id}</dd>
        <dt>Email</dt><dd>${escapeHtml(u.email)}</dd>
        <dt>Signed up</dt><dd>${fmtDateTime(u.createdAt)}</dd>
        <dt>Status</dt><dd>${statusPill(u.subscriptionStatus, u.isPremium)} ${u.isPremium ? '<span class="muted small">(active)</span>' : ''}</dd>
        <dt>Trial ends</dt><dd>${fmtDateTime(u.trialEndsAt)}</dd>
        <dt>Premium until</dt><dd>${fmtDateTime(u.premiumUntil)}</dd>
        <dt>Sync blob</dt><dd>${sync}</dd>
        ${liveStripeRow}
        ${testStripeRow}
      </dl>

      <div class="action-row">
        <button class="btn btn-primary" data-action="grant-lifetime">Grant lifetime</button>
        <button class="btn" data-action="extend-trial">+30 day trial</button>
        <button class="btn" data-action="demote-to-free">Demote to free</button>
        <button class="btn btn-danger" data-action="force-logout">Force logout</button>
        <button class="btn" data-action="test-checkout">Test checkout link</button>
        <button class="btn" data-action="clear-test">Clear test state</button>
        <button class="btn btn-danger" data-action="delete-user">Delete user…</button>
      </div>

      <div class="section-title">Notes</div>
      <textarea id="ud-notes" class="notes-area" rows="3" placeholder="Internal notes — not visible to user.">${escapeHtml(u.notes || '')}</textarea>
      <div class="action-row"><button class="btn" data-action="save-notes">Save notes</button></div>

      <div class="section-title">Recent sessions</div>
      <table class="users-table"><thead><tr><th>Token</th><th>Last seen</th><th>User agent</th></tr></thead><tbody>${sessionsRows}</tbody></table>

      <div class="section-title">Share links</div>
      <table class="users-table"><thead><tr><th>Token</th><th>Created</th><th>Expires</th><th>Views</th><th>Label</th></tr></thead><tbody>${sharesRows}</tbody></table>
    `;
    $('#ud-body').querySelectorAll('button[data-action]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        handleUserAction(uid, btn.dataset.action);
      });
    });
  }

  async function handleUserAction(uid, action) {
    try {
      if (action === 'grant-lifetime') {
        if (!confirm('Grant lifetime access?')) return;
        await api(`/api/admin/users/${uid}/grant-lifetime`, { method: 'POST', body: '{}' });
        toast('Lifetime granted.', 'success');
      } else if (action === 'extend-trial') {
        await api(`/api/admin/users/${uid}/extend-trial`, { method: 'POST', body: JSON.stringify({ days: 30 }) });
        toast('Trial extended by 30 days.', 'success');
      } else if (action === 'force-logout') {
        if (!confirm('Force logout all sessions for this user?')) return;
        await api(`/api/admin/users/${uid}/force-logout`, { method: 'POST', body: '{}' });
        toast('Sessions cleared.', 'success');
      } else if (action === 'test-checkout') {
        const r = await api('/api/admin/billing/test-checkout', { method: 'POST', body: JSON.stringify({ userId: uid, plan: 'yearly' }) });
        try { await navigator.clipboard.writeText(r.url); } catch (_) {}
        window.open(r.url, '_blank', 'noopener,noreferrer');
        toast('Test checkout opened (URL copied; card 4242 4242 4242 4242).', 'success');
      } else if (action === 'clear-test') {
        if (!confirm('Wipe test-mode subscription state for this user?')) return;
        await api(`/api/admin/users/${uid}/clear-test-state`, { method: 'POST', body: '{}' });
        toast('Test state cleared.', 'success');
      } else if (action === 'demote-to-free') {
        if (!confirm('Demote this user to the free tier (trial expired, no premium)? Useful for demo accounts.')) return;
        await api(`/api/admin/users/${uid}/demote-to-free`, { method: 'POST', body: '{}' });
        toast('User demoted to free.', 'success');
      } else if (action === 'delete-user') {
        const u = (await api('/api/admin/users/' + uid)).user;
        const confirmation = prompt(`Type DELETE to permanently remove ${u.email} and all their data.`);
        if (confirmation !== 'DELETE') { toast('Delete canceled.'); return; }
        await api(`/api/admin/users/${uid}`, { method: 'DELETE' });
        toast('User deleted.', 'success');
        $('#user-detail-dialog')?.close();
        loadUsers();
        loadMetrics();
        return;  // skip the openUserDetail re-fetch (user gone)
      } else if (action === 'save-notes') {
        const notes = $('#ud-notes').value;
        await api(`/api/admin/users/${uid}/notes`, { method: 'PUT', body: JSON.stringify({ notes }) });
        toast('Notes saved.', 'success');
      }
      openUserDetail(uid);
      loadUsers();
      loadMetrics();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  // ---------- Wire up ----------
  function loadAll() {
    loadMetrics().catch(e => toast(e.message, 'error'));
    loadTraffic().catch(e => toast(e.message, 'error'));
    loadUsers().catch(e => toast(e.message, 'error'));
    loadEvents().catch(e => toast(e.message, 'error'));
  }

  $('#auth-submit').addEventListener('click', signIn);
  $('#auth-token').addEventListener('keydown', e => { if (e.key === 'Enter') signIn(); });
  $('#logout-btn').addEventListener('click', signOut);
  $('#refresh-btn').addEventListener('click', loadAll);
  let filterTimer;
  $('#filter-q').addEventListener('input', () => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => { usersOffset = 0; loadUsers().catch(e => toast(e.message, 'error')); }, 250);
  });
  $('#filter-status').addEventListener('change', () => { usersOffset = 0; loadUsers().catch(e => toast(e.message, 'error')); });

  // Auto sign-in: first try session cookie (zero-config when embedded in the
  // PWA); fall back to stored bearer token. Either is sufficient — server
  // accepts both via require_admin().
  (async () => {
    try {
      await api('/api/admin/metrics');
      showApp();
      loadAll();
    } catch (_) {
      // Not authorized via session. If we had a token stored, signOut() already
      // ran inside api() on 401. Otherwise, leave the token sign-in form
      // visible for legacy/emergency access.
    }
  })();
})();
