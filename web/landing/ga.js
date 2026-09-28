// Shared GA4 loader for the marketing site (myglpshot.com). One copy instead of
// 16 duplicated inline snippets, and skips loading entirely when the visitor
// sends Global Privacy Control (SEN-53). Umami is not used on this domain.
if (!navigator.globalPrivacyControl) {
  window.dataLayer = window.dataLayer || [];
  function gtag() { dataLayer.push(arguments); }
  gtag('js', new Date());
  gtag('config', 'G-T4T8XH6XLN');
  var s = document.createElement('script');
  s.async = true;
  s.src = 'https://www.googletagmanager.com/gtag/js?id=G-T4T8XH6XLN';
  document.head.appendChild(s);
}
