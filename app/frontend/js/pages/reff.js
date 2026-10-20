import { getUser, clearSession, requireAuth, api, getToken, toast } from '/js/api.js';
import { mountThemeToggle } from '/js/theme.js';
import { mountAdminNotifications } from '/js/notifications.js';
requireAuth();
mountThemeToggle(document.querySelector('.reff-nav .controls') || document.querySelector('.reff-nav'));
mountAdminNotifications(document.querySelector('.reff-nav .controls'));

// Mesa guard
await fetch('/api/me/permissions', { headers: { Authorization: `Bearer ${getToken()}` } })
  .then(r => r.json())
  .then(p => { if (!(p.mesas || []).includes('reff')) location.href = '/pages/dashboard.html'; })
  .catch(() => {});

const user = getUser() || '';
document.getElementById('userTag').textContent = user;

document.getElementById('brandLogo').addEventListener('click', () => {
  location.href = '/pages/reff-dashboard.html';
});

document.getElementById('backBtn').addEventListener('click', () => {
  location.href = '/pages/reff-dashboard.html';
});

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

const frame = document.getElementById('reffFrame');
const offlineMsg = document.getElementById('offlineMsg');
const statusDot = document.getElementById('statusDot');
const statusLabel = document.getElementById('statusLabel');

async function checkReff() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const r = await fetch('/reff/api/health', { signal: controller.signal });
    clearTimeout(timer);
    if (r.ok) {
      statusDot.className = 'status-dot online';
      statusLabel.textContent = 'Rëff activo';
      offlineMsg.classList.remove('visible');
      frame.style.display = 'block';
      return true;
    }
  } catch {
    clearTimeout(timer);
  }
  statusDot.className = 'status-dot offline';
  statusLabel.textContent = 'Rëff offline';
  offlineMsg.classList.add('visible');
  frame.style.display = 'none';
  return false;
}

document.getElementById('retryBtn').addEventListener('click', () => {
  statusLabel.textContent = 'comprobando...';
  statusDot.className = 'status-dot';
  checkReff();
});

checkReff();
setInterval(checkReff, 30000);
