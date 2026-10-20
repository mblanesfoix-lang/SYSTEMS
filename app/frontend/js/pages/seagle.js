import { api, getUser, getToken, clearSession, requireAuth, toast } from '/js/api.js';
import { mountThemeToggle } from '/js/theme.js';
import { mountOfficeBg } from '/js/office-bg.js';
import { mountAdminNotifications } from '/js/notifications.js';
requireAuth();
mountThemeToggle(document.querySelector('nav.nav .row'));
mountOfficeBg();
document.getElementById('userTag').textContent = getUser() || '';
mountAdminNotifications(document.querySelector('nav.nav'));

// Apply mesa permissions — redirect if no access to the domain at all
try {
  const perms = await fetch('/api/me/permissions', {
    headers: { Authorization: `Bearer ${getToken()}` }
  }).then(r => r.json());
  const allowed = new Set(perms.mesas || []);
  if (!allowed.has('seagle')) {
    location.href = '/pages/dashboard.html';
  }
} catch {}

document.getElementById('logoutBtn').addEventListener('click', async () => {
  try { await api.logout(); } catch {}
  clearSession();
  location.href = '/pages/login.html';
});

// User menu dropdown
const userMenuTrigger = document.getElementById('userTag');
const userMenuDropdown = document.getElementById('userDropdown');
userMenuTrigger.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = !userMenuDropdown.hidden;
  userMenuDropdown.hidden = open;
  userMenuTrigger.setAttribute('aria-expanded', String(!open));
});
document.addEventListener('click', (e) => {
  if (!document.getElementById('userMenu').contains(e.target)) {
    userMenuDropdown.hidden = true;
    userMenuTrigger.setAttribute('aria-expanded', 'false');
  }
});
document.getElementById('pwdSubmit').addEventListener('click', async () => {
  const cur = document.getElementById('pwdCurrent').value;
  const neu = document.getElementById('pwdNew').value;
  const con = document.getElementById('pwdConfirm').value;
  const errEl = document.getElementById('pwdError');
  errEl.hidden = true;
  if (!cur || !neu || !con) { errEl.textContent = 'Rellena todos los campos'; errEl.hidden = false; return; }
  if (neu !== con) { errEl.textContent = 'Las contraseñas no coinciden'; errEl.hidden = false; return; }
  try {
    await api.changePassword(cur, neu);
    toast('Contraseña actualizada');
    userMenuDropdown.hidden = true;
    userMenuTrigger.setAttribute('aria-expanded', 'false');
    ['pwdCurrent','pwdNew','pwdConfirm'].forEach(id => document.getElementById(id).value = '');
  } catch (ex) {
    errEl.textContent = ex.message || 'Error al cambiar contraseña';
    errEl.hidden = false;
  }
});

// ---- Health check ----
function setMesaStatus(mesa, state, label, detail, error) {
  const card = document.querySelector(`.mesa-status-card[data-mesa="${mesa}"]`);
  if (!card) return;
  const dot = card.querySelector('.mesa-status-dot');
  const lbl = card.querySelector('.mesa-status-label');
  const det = card.querySelector('.mesa-status-detail');
  const err = card.querySelector('.mesa-status-error');
  dot.className = `mesa-status-dot ${state}`;
  lbl.className = `mesa-status-label ${state}`;
  lbl.textContent = label;
  det.textContent = detail || '';
  err.textContent = error || '';
}

async function checkMesa(mesa, url, { okLabel = 'operativo', parse } = {}) {
  const t0 = performance.now();
  try {
    const headers = {};
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = await fetch(url, { headers });
    const ms = Math.round(performance.now() - t0);
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try { const j = await r.json(); if (j.error) msg = j.error; } catch {}
      setMesaStatus(mesa, 'bad', 'error', `${url} · ${ms} ms`, msg);
      return;
    }
    const data = await r.json().catch(() => ({}));
    const extra = parse ? parse(data) : '';
    setMesaStatus(mesa, 'ok', okLabel, `${ms} ms${extra ? ' · ' + extra : ''}`, '');
  } catch (ex) {
    const ms = Math.round(performance.now() - t0);
    setMesaStatus(mesa, 'bad', 'sin conexión', `${url} · ${ms} ms`, ex.message || 'fallo de red');
  }
}

function refreshMesaStatus() {
  // El mapa no tiene endpoint propio (frontend puro reusando Gob Share) — el health
  // check golpea /api/seagle/summary igualmente para confirmar que la mesa responde.
  checkMesa('seagle-mapa', '/api/seagle/summary', {
    parse: () => 'directorio Gob Share'
  });
  checkMesa('seagle-hconexion', '/api/seagle/summary', {
    parse: d => `${d.reviewsTotal ?? 0} revisiones`
  });
}

refreshMesaStatus();
setInterval(refreshMesaStatus, 30000);
