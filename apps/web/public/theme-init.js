// Applies the saved theme before the page paints, so a visitor who chose dark does not see a flash of light.
// A separate file (not inline) because the CSP allows only same-origin scripts. Keep in sync with src/lib/theme.tsx.
try {
  var t = localStorage.getItem('funnel:theme');
  if (t === 'light' || t === 'dark') {
    document.documentElement.setAttribute('data-theme', t);
    var ground = t === 'dark' ? '#111512' : '#f2f3ee';
    document.querySelectorAll('meta[name="theme-color"]').forEach(function (m) {
      m.setAttribute('content', ground);
    });
  }
} catch {
  /* storage blocked: follow the system theme */
}
