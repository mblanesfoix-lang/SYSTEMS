// Classic script loaded in <head>: applies the stored theme before first paint.
// js/theme.js is a module (deferred), so it would apply it too late and flash.
(function () {
  try {
    var t = localStorage.getItem('systemsTheme');
    if (t === 'light') document.documentElement.setAttribute('data-theme', 'light');
  } catch (e) {}
})();
