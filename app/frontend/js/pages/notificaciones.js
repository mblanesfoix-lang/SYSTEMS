import { api, getUser, getToken, requireAuth, clearSession, toast, escapeHtml } from '/js/api.js';
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
  if (!allowed.has('notificaciones')) location.href = '/pages/dashboard.html';
} catch {}

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

let currentFilter = 'all';

async function loadSummary() {
  try {
    const s = await api.notifCenterSummary();
    document.getElementById('kpiSysTotal').textContent = s.system?.total ?? 0;
    document.getElementById('kpiSysUnread').textContent = s.system?.unread ?? 0;
    document.getElementById('kpiTrafPending').textContent = s.traffic?.pendiente ?? 0;
    document.getElementById('kpiTrafJustif').textContent = s.traffic?.justificacion_requerida ?? 0;
    document.getElementById('kpiTrafApproved').textContent = s.traffic?.aprobada ?? 0;
    document.getElementById('kpiTrafDenied').textContent = s.traffic?.denegada ?? 0;
  } catch (ex) { showError(ex.message || 'Error al cargar resumen'); }
}

function statusPill(item) {
  const map = {
    pendiente: 'Pendiente', justificacion_requerida: 'Justificación req.',
    aprobada: 'Aprobada', denegada: 'Denegada', leida: 'Leída',
  };
  const cls = item.status + (item.source === 'system' ? ' sys' : '');
  return `<span class="status-pill ${item.status}">${escapeHtml(map[item.status] || item.status)}</span>`;
}

function decisionHtml(item) {
  if (item.source === 'system') {
    return item.status === 'pendiente'
      ? `<button class="btn ghost btn--sm sys-read" data-id="${item.id}">Marcar leída</button>`
      : `<button class="btn ghost btn--sm sys-delete" data-id="${item.id}">Eliminar</button>`;
  }
  if (item.status === 'pendiente' || item.status === 'justificacion_requerida') {
    return `<div class="decide-row">
          <input class="input" placeholder="motivo denegación (opcional)" data-note-for="${item.id}">
          <button class="btn sage btn--sm traf-approve" data-id="${item.id}">Aprobar y emitir</button>
          <button class="btn ghost btn--sm traf-deny" data-id="${item.id}">Denegar</button>
          <button class="btn ghost btn--sm traf-justify" data-id="${item.id}">Requerir justificación</button>
        </div>`;
  }
  return `<span class="mono" style="font-size:0.7rem;">${escapeHtml(item.resolvedBy || '')}</span>`;
}

function detailHtml(item) {
  if (item.source === 'system') {
    return `<div class="detail-box"><strong>${escapeHtml(item.label || '')}</strong>${item.detail ? '<br>' + escapeHtml(item.detail) : ''}</div>`;
  }
  return `<div class="detail-box"><strong>${escapeHtml(item.requesterName || '')}</strong> · ${escapeHtml(item.module || '')} / ${escapeHtml(item.resource || '')} / ${escapeHtml(item.action || '')}${item.justification ? '<br>Justificación: ' + escapeHtml(item.justification) : ''}${item.resolutionNote ? '<br>' + escapeHtml(item.resolutionNote) : ''}</div>`;
}

async function loadFeed() {
  const body = document.getElementById('feedBody');
  try {
    let source = null;
    let status = null;
    if (currentFilter === 'system') source = 'system';
    if (currentFilter === 'traffic') source = 'traffic';
    const r = await api.notifCenterFeed(source, status);
    let items = r.items || [];
    if (currentFilter === 'pending') {
      items = items.filter(i => i.status === 'pendiente' || i.status === 'justificacion_requerida');
    }
    if (items.length === 0) { body.innerHTML = '<tr class="empty-row"><td colspan="5">Sin notificaciones.</td></tr>'; return; }
    body.innerHTML = items.map(item => `
          <tr data-id="${item.id}" data-source="${item.source}">
            <td><span class="source-tag">${item.source === 'system' ? (item.origin || 'SISTEMA') : 'TRÁFICO · ' + escapeHtml(item.module || '')}</span></td>
            <td>${detailHtml(item)}</td>
            <td>${statusPill(item)}</td>
            <td class="mono" style="font-size:0.68rem;">${new Date(item.createdAt).toLocaleString('es-ES')}</td>
            <td>${decisionHtml(item)}</td>
          </tr>
        `).join('');

    body.querySelectorAll('.traf-approve, .traf-deny, .traf-justify').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        try {
          if (btn.classList.contains('traf-approve')) {
            await api.notifCenterTrafficApprove(id);
            toast('Solicitud aprobada · puerto abierto 60s');
          } else if (btn.classList.contains('traf-deny')) {
            const noteInput = body.querySelector(`input[data-note-for="${id}"]`);
            await api.notifCenterTrafficDeny(id, noteInput ? noteInput.value.trim() : '');
            toast('Solicitud denegada');
          } else {
            await api.notifCenterTrafficRequireJustification(id);
            toast('Justificación solicitada al usuario');
          }
          loadFeed(); loadSummary();
        } catch (ex) { showError(ex.message || 'Error al procesar la solicitud'); }
      });
    });
    body.querySelectorAll('.sys-read').forEach(btn => {
      btn.addEventListener('click', async () => {
        try { await api.notificationRead(btn.dataset.id); loadFeed(); loadSummary(); }
        catch (ex) { showError(ex.message || 'Error al marcar como leída'); }
      });
    });
    body.querySelectorAll('.sys-delete').forEach(btn => {
      btn.addEventListener('click', async () => {
        try { await api.notificationDelete(btn.dataset.id); loadFeed(); loadSummary(); }
        catch (ex) { showError(ex.message || 'Error al eliminar'); }
      });
    });
  } catch (ex) { showError(ex.message || 'Error al cargar el feed'); }
}

function setFilter(f) {
  currentFilter = f;
  loadFeed();
}
document.getElementById('filterAll').addEventListener('click', () => setFilter('all'));
document.getElementById('filterSystem').addEventListener('click', () => setFilter('system'));
document.getElementById('filterTraffic').addEventListener('click', () => setFilter('traffic'));
document.getElementById('filterPending').addEventListener('click', () => setFilter('pending'));

loadSummary();
loadFeed();
