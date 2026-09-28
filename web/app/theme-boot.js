// Apply the saved theme before first paint, so a dark-mode user does not get a
// flash of the light theme. Its own file rather than inline: the site's
// Content-Security-Policy (deploy/mgs-security-headers.conf) allows no inline
// script, and the inline copy was silently blocked on every page load.
(function () {
  try {
    var t = localStorage.getItem('theme') || 'system';
    if (t === 'dark' || t === 'light') document.documentElement.setAttribute('data-theme', t);
  } catch (e) {}
})();
