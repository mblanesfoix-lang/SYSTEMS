// Dark/light theme toggle, shared across every page.
// Persisted per-browser in localStorage so each user keeps their own choice.
const THEME_KEY = 'systemsTheme';

export function getStoredTheme() {
  try { return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'; }
  catch { return 'dark'; }
}

export function applyStoredTheme() {
  if (getStoredTheme() === 'light') document.documentElement.setAttribute('data-theme', 'light');
  else document.documentElement.removeAttribute('data-theme');
}

// Renders the toggle switch into `container` and wires it up.
// Call after DOM is ready (the theme itself is already applied pre-paint
// by the inline head script — this only mounts the visible control).
// By default the switch is prepended so it lands before sibling controls
// (user-menu, notification bell) added later in the same container.
export function mountThemeToggle(container, { prepend = true } = {}) {
  if (!container || document.getElementById('themeToggle')) return null;
  const btn = document.createElement('button');
  btn.className = 'theme-toggle';
  btn.id = 'themeToggle';
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Cambiar tema claro/oscuro');
  btn.title = 'Cambiar tema claro/oscuro';
  btn.innerHTML = `
    <span class="theme-toggle__label mono">OSCURO</span>
    <span class="theme-toggle__track"><span class="theme-toggle__thumb"></span></span>
    <span class="theme-toggle__label mono">CLARO</span>
  `;
  btn.setAttribute('aria-pressed', String(getStoredTheme() === 'light'));
  btn.addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    try { localStorage.setItem(THEME_KEY, next); } catch {}
    applyStoredTheme();
    btn.setAttribute('aria-pressed', String(next === 'light'));
  });
  if (prepend) container.prepend(btn); else container.appendChild(btn);
  return btn;
}
