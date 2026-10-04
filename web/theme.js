// Applies the saved light/dark choice before the page paints, so there is no flash of the wrong theme.
// A separate file (not an inline script) so the Content-Security-Policy can keep forbidding inline scripts.
(function () {
  try {
    var t = localStorage.getItem('fp:theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) {
    /* storage blocked: follow the device setting */
  }
})();
