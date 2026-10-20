import { api, getUser, getToken, clearSession, requireAuth, toast } from '/js/api.js';
import { mountThemeToggle } from '/js/theme.js';
import { mountAdminNotifications } from '/js/notifications.js';
import { mountOfficeBg, mountSphereBg } from '/js/office-bg.js';
requireAuth();
mountThemeToggle(document.querySelector('nav.nav .row'));
mountOfficeBg();
mountSphereBg();
const user = getUser() || '';
document.getElementById('userTag').textContent = user;
mountAdminNotifications(document.querySelector('nav.nav .row'));

// Apply mesa permissions — hide tiles + health cards not accessible; redirect if no access at all
try {
  const perms = await fetch('/api/me/permissions', {
    headers: { Authorization: `Bearer ${getToken()}` }
  }).then(r => r.json());
  const allowed = new Set(perms.mesas || []);
  const domainMesas = ['elvira'];
  if (!domainMesas.some(m => allowed.has(m))) {
    location.href = '/pages/dashboard.html';
  }
  document.querySelectorAll('.tile[data-mesa]').forEach(el => {
    if (!allowed.has(el.dataset.mesa)) el.style.display = 'none';
  });
  document.querySelectorAll('.mesa-status-card[data-mesa]').forEach(el => {
    if (!allowed.has(el.dataset.mesa)) el.style.display = 'none';
  });
} catch {}

// User menu dropdown
const trigger = document.getElementById('userTag');
const dropdown = document.getElementById('userDropdown');
trigger.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = !dropdown.hidden;
  dropdown.hidden = open;
  trigger.setAttribute('aria-expanded', String(!open));
});
document.addEventListener('click', (e) => {
  if (!document.getElementById('userMenu').contains(e.target)) {
    dropdown.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  }
});

// Change password
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
    dropdown.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    ['pwdCurrent','pwdNew','pwdConfirm'].forEach(id => document.getElementById(id).value = '');
  } catch (ex) {
    errEl.textContent = ex.message || 'Error al cambiar contraseña';
    errEl.hidden = false;
  }
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  try { await api.logout(); } catch {}
  clearSession();
  location.href = '/pages/login.html';
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
  checkMesa('elvira', '/api/elvira/overview', {
    parse: d => `${d.metrics?.totalCompanies ?? 0} empresas`
  });
}

refreshMesaStatus();
setInterval(refreshMesaStatus, 30000);
