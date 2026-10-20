import { api, getUser, getRole, getToken, requireAuth, clearSession, toast, escapeHtml } from '/js/api.js';
import { mountThemeToggle } from '/js/theme.js';
import { mountOfficeBg } from '/js/office-bg.js';
requireAuth();
mountThemeToggle(document.querySelector('nav.nav .row'));
mountOfficeBg();
document.getElementById('userTag').textContent = getUser() || '';

try {
  const perms = await fetch('/api/me/permissions', {
    headers: { Authorization: `Bearer ${getToken()}` }
  }).then(r => r.json());
  const allowed = new Set(perms.mesas || []);
  if (!allowed.has('gateway')) location.href = '/pages/dashboard.html';
} catch {}

const isAdmin = getRole() === 'admin';

document.getElementById('logoutBtn').addEventListener('click', async () => {
  try { await api.logout(); } catch {}
  clearSession();
  location.href = '/pages/login.html';
});

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

function showError(msg) {
  const box = document.getElementById('errorBox');
  box.textContent = msg;
  box.style.display = msg ? 'block' : 'none';
}

let currentFilter = null;

async function loadSummary() {
  try {
    const s = await api.gatewaySummary();
    document.getElementById('kpiTotalVal').textContent = s.total ?? 0;
    document.getElementById('kpiPendingVal').textContent = s.pending ?? 0;
    document.getElementById('kpiApprovedVal').textContent = s.approved ?? 0;
    document.getElementById('kpiDeniedVal').textContent = s.denied ?? 0;
  } catch (ex) { showError(ex.message || 'Error al cargar resumen'); }
}

function statusPill(status) {
  const map = { PENDING_MASTER_APPROVAL: ['pending', 'Pendiente'], APPROVED: ['approved', 'Aprobada'], DENIED: ['denied', 'Denegada'] };
  const [cls, label] = map[status] || ['pending', status];
  return `<span class="status-pill ${cls}">${label}</span>`;
}

async function loadRequests() {
  const body = document.getElementById('reqBody');
  try {
    const rows = await api.gatewayRequestsList(currentFilter);
    if (rows.length === 0) { body.innerHTML = '<tr class="empty-row"><td colspan="5">Sin solicitudes.</td></tr>'; return; }
    body.innerHTML = rows.map(r => {
      const payload = { request_id: r.request_id, timestamp: r.timestamp, user: r.user, source_port: r.source_port, target_port: r.target_port, data_requested: r.data_requested, status: r.status, risk_score: r.risk_score, risk_flags: r.risk_flags };
      const canDecide = isAdmin && r.status === 'PENDING_MASTER_APPROVAL';
      const decisionHtml = r.status === 'PENDING_MASTER_APPROVAL'
        ? (canDecide
            ? `<div class="decide-row">
                     <input class="input" placeholder="motivo (opcional)" data-reason-for="${r.id}">
                     <button class="btn sage btn--sm gw-approve" data-id="${r.id}">Aprobar</button>
                     <button class="btn ghost btn--sm gw-deny" data-id="${r.id}">Denegar</button>
                   </div>`
            : '<span class="mono" style="font-size:0.7rem;color:var(--text-muted);">solo Admin decide</span>')
        : `<span class="mono" style="font-size:0.7rem;">${escapeHtml(r.decidedBy || '')}${r.decisionReason ? ' · ' + escapeHtml(r.decisionReason) : ''}</span>`;
      return `<tr data-id="${r.id}">
            <td class="mono">${escapeHtml(r.request_id)}</td>
            <td class="mono">${escapeHtml(r.source_port)} → ${escapeHtml(r.target_port)}</td>
            <td><pre class="payload-box">${escapeHtml(JSON.stringify(payload, null, 2))}</pre></td>
            <td>${statusPill(r.status)}</td>
            <td>${decisionHtml}</td>
          </tr>`;
    }).join('');
    body.querySelectorAll('.gw-approve, .gw-deny').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const decision = btn.classList.contains('gw-approve') ? 'APPROVED' : 'DENIED';
        const reasonInput = body.querySelector(`input[data-reason-for="${id}"]`);
        const reason = reasonInput ? reasonInput.value.trim() : '';
        try {
          await api.gatewayRequestDecide(id, decision, reason);
          toast(decision === 'APPROVED' ? 'Solicitud aprobada' : 'Solicitud denegada');
          loadRequests(); loadSummary();
        } catch (ex) { showError(ex.message || 'Error al decidir'); }
      });
    });
  } catch (ex) { showError(ex.message || 'Error al cargar solicitudes'); }
}

document.getElementById('filterAll').addEventListener('click', () => { currentFilter = null; loadRequests(); });
document.getElementById('filterPending').addEventListener('click', () => { currentFilter = 'PENDING_MASTER_APPROVAL'; loadRequests(); });
document.getElementById('filterApproved').addEventListener('click', () => { currentFilter = 'APPROVED'; loadRequests(); });
document.getElementById('filterDenied').addEventListener('click', () => { currentFilter = 'DENIED'; loadRequests(); });

document.getElementById('verifyBtn').addEventListener('click', async () => {
  const el = document.getElementById('verifyResult');
  el.textContent = 'verificando…';
  try {
    const r = await api.gatewayLogVerify();
    el.textContent = r.valid ? `cadena íntegra · ${r.totalEntries} entradas` : `¡ROTA! en seq ${r.brokenAtSeq}`;
    el.style.color = r.valid ? 'var(--accent-green2)' : '#d80300';
  } catch (ex) { el.textContent = ex.message || 'error'; el.style.color = '#d80300'; }
});

loadSummary();
loadRequests();
