import { api, getUser, requireAuth, clearSession, toast, escapeHtml } from '/js/api.js';
import { mountThemeToggle } from '/js/theme.js';
import { mountOfficeBg } from '/js/office-bg.js';
requireAuth();
mountThemeToggle(document.querySelector('nav.nav .row'));
mountOfficeBg();
document.getElementById('userTag').textContent = getUser() || '';
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

function showError(msg) {
  const box = document.getElementById('errorBox');
  box.textContent = msg;
  box.style.display = msg ? 'block' : 'none';
}

function selectHtml(options, current, cls) {
  return `<select class="input ${cls}" style="font-size:0.72rem; padding:4px 6px;">` +
    Object.entries(options).map(([k, v]) => `<option value="${k}" ${k === current ? 'selected' : ''}>${typeof v === 'string' ? v : v.label}</option>`).join('') +
    `</select>`;
}

const ENTRY_RESIDUE_LABELS = { organico_humedo: 'Orgánico húmedo', agroindustrial: 'Agroindustrial', ganadero: 'Ganadero', forestal: 'Forestal', otro: 'Otro' };
const ENTRY_PROCEDENCIA_LABELS = { vertido_propio: 'Vertido propio', vertido_tercero_contratado: 'Vertido tercero contratado', planta_transferencia: 'Planta de transferencia' };
const ENTRY_STATUSES = {
  propuesta: { label: 'Propuesta', color: '#c9a84c' },
  activa: { label: 'Activa', color: '#00a878' },
  suspendida: { label: 'Suspendida', color: '#d80300' },
};

let ecRowsCache = [];

function updateKpis() {
  document.getElementById('kpiTotalVal').textContent = ecRowsCache.length;
  document.getElementById('kpiActiveVal').textContent = ecRowsCache.filter(r => r.status === 'activa').length;
  document.getElementById('kpiBSSVal').textContent = ecRowsCache.filter(r => r.requiresBSS).length;
}

async function loadEntryConditions() {
  const body = document.getElementById('ecBody');
  try {
    const rows = await api.pactvmEntryConditionsList();
    ecRowsCache = rows;
    updateKpis();
    if (rows.length === 0) { body.innerHTML = '<tr class="empty-row"><td colspan="7">Sin condiciones registradas.</td></tr>'; return; }
    body.innerHTML = rows.map(r => `<tr data-id="${r.id}">
          <td>${escapeHtml(r.name)}</td>
          <td>${escapeHtml(ENTRY_RESIDUE_LABELS[r.residueType] || r.residueType)}</td>
          <td>${escapeHtml(ENTRY_PROCEDENCIA_LABELS[r.procedencia] || r.procedencia)}</td>
          <td class="mono">${r.maxHumedadPct != null ? r.maxHumedadPct + '%' : '—'}</td>
          <td>${r.requiresBSS ? '<span class="status-pill"><span class="status-dot-sm" style="background:#3a7bd5;"></span>Sí</span>' : '—'}</td>
          <td>${selectHtml(ENTRY_STATUSES, r.status, 'ec-status')}</td>
          <td><button class="btn ghost btn--sm ec-del">Eliminar</button></td>
        </tr>`).join('');
    body.querySelectorAll('tr[data-id]').forEach(tr => {
      const id = tr.dataset.id;
      tr.querySelector('.ec-status').addEventListener('change', async (e) => {
        try { await api.pactvmEntryConditionPatch(id, { status: e.target.value }); loadEntryConditions(); } catch (ex) { showError(ex.message); }
      });
      tr.querySelector('.ec-del').addEventListener('click', async () => {
        try { await api.pactvmEntryConditionDelete(id); loadEntryConditions(); } catch (ex) { showError(ex.message); }
      });
    });
  } catch (ex) { showError(ex.message || 'Error al cargar condiciones de entrada'); }
}
document.getElementById('ecAddBtn').addEventListener('click', async () => {
  showError('');
  const name = document.getElementById('ecName').value.trim();
  if (!name) return showError('Indica el nombre de la condición');
  const humedadRaw = document.getElementById('ecHumedad').value.trim();
  try {
    await api.pactvmEntryConditionAdd({
      name,
      residueType: document.getElementById('ecResidueType').value,
      procedencia: document.getElementById('ecProcedencia').value,
      maxHumedadPct: humedadRaw ? Number(humedadRaw) : null,
      requiresBSS: document.getElementById('ecBSS').checked,
    });
    document.getElementById('ecName').value = '';
    document.getElementById('ecHumedad').value = '';
    document.getElementById('ecBSS').checked = false;
    loadEntryConditions();
  } catch (ex) { showError(ex.message || 'Error al crear condición'); }
});

// ---- Init ----
loadEntryConditions();
