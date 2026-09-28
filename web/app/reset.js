// Password-reset page logic. A separate file because the site's CSP allows no
// inline script. Inline, it never ran: the form fell back to a plain GET and
// the reset never happened.
(async function(){
  const params = new URLSearchParams(location.hash.slice(1));
  const token = params.get('token');
  if (!token || !/^[a-f0-9]{32,}$/.test(token)) {
    document.getElementById('reset-status').textContent = 'Invalid or missing reset token.';
    return;
  }
  document.getElementById('reset-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('reset-email').value.trim();
    const pw = document.getElementById('reset-pw').value;
    document.getElementById('reset-status').textContent = 'Deriving keys…';
    try {
      const creds = await deriveAccountCreds(email, pw);
      const r = await fetch('/api/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, authToken: creds.authToken }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.message || 'Reset failed');
      document.getElementById('reset-status').textContent = '✓ Password reset. Redirecting…';
      setTimeout(() => location.href = '/', 1500);
    } catch (e) {
      document.getElementById('reset-status').textContent = 'Failed: ' + e.message;
    }
  });
})();
