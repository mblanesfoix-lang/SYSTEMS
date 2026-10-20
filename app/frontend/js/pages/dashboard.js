import { api, getUser, getToken, clearSession, requireAuth, toast } from '/js/api.js';
import { mountAdminNotifications } from '/js/notifications.js';
import { mountOfficeBg, mountSphereBg, playSystemsEntry } from '/js/office-bg.js';
import { mountThemeToggle } from '/js/theme.js';
requireAuth();
mountOfficeBg();
mountSphereBg();
playSystemsEntry();
const user = getUser() || '';
document.getElementById('userTag').textContent = user;
mountThemeToggle(document.getElementById('navControls'));
mountAdminNotifications(document.querySelector('nav.nav .row'));

// Apply domain permissions — hide domain tiles + health cards not accessible
try {
  const perms = await fetch('/api/me/permissions', {
    headers: { Authorization: `Bearer ${getToken()}` }
  }).then(r => r.json());
  const allowed = new Set(perms.mesas || []);
  const domainMesas = { ophs: ['ophs'], reff: ['reff', 'snfiu2'], elvira: ['elvira', 'sentinel'], pactvm: ['pactvm'] };
  // Domain tiles: visible if at least one mesa of the domain is allowed
  document.querySelectorAll('.tile[data-domain]').forEach(el => {
    const mesas = domainMesas[el.dataset.domain] || [];
    if (!mesas.some(m => allowed.has(m))) el.style.display = 'none';
  });
  // Transversal tiles / enlaces (mesa directa, sin dominio) — ej. Puerto Maestro, Herzog
  document.querySelectorAll('main [data-mesa]').forEach(el => {
    if (!allowed.has(el.dataset.mesa)) el.style.display = 'none';
  });
  // Health check cards
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

// Load overview (sessions + companies)
try {
  const ov = await api.elviraOverview();
  const sessions = ov.metrics?.activeSessions ?? '—';
  document.getElementById('sessMain').textContent = sessions;
  document.getElementById('sessSub').textContent =
    `${ov.metrics?.totalCompanies ?? 0} empresas · ${ov.metrics?.totalUsers ?? 0} usuarios`;
} catch {}

// T'Controler — solo admin
try {
  const tc = await api.tcontroler();
  const g = tc.global;
  const totalK = ((g.totalTokens || 0) / 1000).toFixed(1);
  const cap = tc.tokensCap ? `${(tc.tokensCap / 1000).toFixed(0)}k` : '∞';
  document.getElementById('tcMain').textContent = `${totalK}k / ${cap}`;
  const costStr = `€${(g.costTotalEUR || 0).toFixed(3)} · ${g.calls} llamadas IA`;
  const byUserStr = (tc.byUser || [])
    .map(u => `${u.user.split(' ')[0]}: €${(u.costTotalEUR || 0).toFixed(3)}`)
    .join(' · ');
  document.getElementById('tcSub').textContent = byUserStr ? `${costStr} — ${byUserStr}` : costStr;
} catch {
  document.getElementById('tcMain').textContent = '— / —';
  document.getElementById('tcSub').textContent = 'solo visible para Admin';
}

// ---- Estado de las Mesas (health check) ----
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
  checkMesa('reff', '/api/reff-health', {
    parse: d => d.service ? `service: ${d.service}` : ''
  });
  checkMesa('snfiu2', '/api/snfi-u2/live', {
    parse: d => d.snapshot?.precio_actual_eur_mwh != null ? `${d.snapshot.precio_actual_eur_mwh} EUR/MWh` : ''
  });
  checkMesa('ophs', '/api/ophs-cockpit/summary', {
    parse: d => `${d.ops?.nodesTotal ?? 0} nodos ØPS · ${d.sentinel?.colaRevisionPendiente ?? 0} en cola Sentinel`
  });
  checkMesa('sentinel', '/api/sentinel/ip-stats', {
    parse: d => `${Array.isArray(d) ? d.length : 0} IPs monitorizadas`
  });
  checkMesa('pactvm', '/api/pactvm/summary', {
    parse: d => `${d.cibeEmitidos ?? 0} CIBE emitidos`
  });
  checkMesa('gateway', '/api/gateway/summary', {
    parse: d => `${d.pending ?? 0} pendientes de aprobación`
  });
  checkMesa('notificaciones', '/api/notif-center/summary', {
    parse: d => `${d.system?.unread ?? 0} sistema sin leer · ${d.traffic?.pendiente ?? 0} tráfico pendiente`
  });
  checkMesa('herzog', '/api/herzog-central/summary', {
    parse: d => `${d.metricsCount ?? 0} métricas · ${d.documentsCount ?? 0} docs · ${d.notesCount ?? 0} notas`
  });
}

refreshMesaStatus();
setInterval(refreshMesaStatus, 30000);
