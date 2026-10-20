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

// ---- Tabs ----
document.querySelectorAll('.mode-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.mode-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.pactvm-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`panel-${tab.dataset.panel}`).classList.add('active');
  });
});

// ---- Summary KPIs ----
async function loadSummary() {
  try {
    const s = await api.pactvmSummary();
    document.getElementById('kpiCibeEmitidosVal').textContent = s.cibeEmitidos ?? 0;
    document.getElementById('kpiCibePendientesVal').textContent = s.cibePendientes ?? 0;
    document.getElementById('kpiPoliciesVal').textContent = s.policiesActive ?? 0;
    document.getElementById('kpiHerzogNcVal').textContent = s.herzogNoCandidatoRecent ?? 0;
    document.getElementById('kpiCibePendientes').classList.toggle('alert', (s.cibePendientes ?? 0) > 0);
    document.getElementById('kpiHerzogNc').classList.toggle('alert', (s.herzogNoCandidatoRecent ?? 0) > 0);
    document.getElementById('kpiHerzogNcVal').classList.toggle('warn', (s.herzogNoCandidatoRecent ?? 0) > 0);
  } catch (ex) { showError(ex.message || 'Error al cargar resumen'); }
}

const CIBE_STATUSES = {
  pendiente: { label: 'Pendiente', color: '#c9a84c' },
  emitido: { label: 'Emitido', color: '#00a878' },
  suspendido: { label: 'Suspendido', color: '#d80300' },
  revocado: { label: 'Revocado', color: '#d80300' },
};
const ACCESS_STATUSES = {
  activo: { label: 'Activo', color: '#00a878' },
  suspendido: { label: 'Suspendido', color: '#d80300' },
};

function selectHtml(options, current, cls) {
  return `<select class="input ${cls}" style="font-size:0.72rem; padding:4px 6px;">` +
    Object.entries(options).map(([k, v]) => `<option value="${k}" ${k === current ? 'selected' : ''}>${typeof v === 'string' ? v : v.label}</option>`).join('') +
    `</select>`;
}
function pill(label, color) {
  return `<span class="status-pill"><span class="status-dot-sm" style="background:${color};"></span>${escapeHtml(label)}</span>`;
}

// ---- CIBE ----
async function loadCibe() {
  const body = document.getElementById('cibeBody');
  try {
    const rows = await api.pactvmCibeList();
    if (rows.length === 0) { body.innerHTML = '<tr class="empty-row"><td colspan="6">Sin certificados registrados.</td></tr>'; return; }
    body.innerHTML = rows.map(r => `<tr data-id="${r.id}">
          <td>${escapeHtml(r.entityName)}</td>
          <td>${escapeHtml(r.sector || '—')}</td>
          <td>${selectHtml(CIBE_STATUSES, r.status, 'cibe-status')}</td>
          <td class="mono">${escapeHtml(r.auditF4Date || '—')}</td>
          <td style="font-size:0.8rem;">${escapeHtml(r.notes || '')}</td>
          <td style="white-space:nowrap;">
            <button class="btn ghost btn--sm cibe-key" title="Asignar/rotar la tokenKey del búnker CIBE (solo certificados emitidos)">TokenKey</button>
            <button class="btn ghost btn--sm cibe-del">Eliminar</button>
          </td>
        </tr>`).join('');
    body.querySelectorAll('tr[data-id]').forEach(tr => {
      const id = tr.dataset.id;
      tr.querySelector('.cibe-status').addEventListener('change', async (e) => {
        try { await api.pactvmCibePatch(id, { status: e.target.value }); loadSummary(); } catch (ex) { showError(ex.message); }
      });
      tr.querySelector('.cibe-key').addEventListener('click', async () => {
        showError('');
        try {
          const r = await api.pactvmCibeTokenKey(id);
          prompt(`tokenKey de "${r.entityName}" — se muestra UNA sola vez, cópiala ahora:`, r.tokenKey);
          toast('tokenKey asignada. El sujeto externo ya puede pedir tokens CIBE.');
        } catch (ex) { showError(ex.message); }
      });
      tr.querySelector('.cibe-del').addEventListener('click', async () => {
        try { await api.pactvmCibeDelete(id); loadCibe(); loadSummary(); } catch (ex) { showError(ex.message); }
      });
    });
  } catch (ex) { showError(ex.message || 'Error al cargar certificados CIBE'); }
}
document.getElementById('cibeAddBtn').addEventListener('click', async () => {
  showError('');
  const entityName = document.getElementById('cibeEntityName').value.trim();
  if (!entityName) return showError('Indica la empresa/nodo');
  try {
    await api.pactvmCibeAdd({
      entityName,
      sector: document.getElementById('cibeSector').value.trim() || null,
      auditF4Date: document.getElementById('cibeAuditDate').value || null,
    });
    document.getElementById('cibeEntityName').value = '';
    document.getElementById('cibeSector').value = '';
    document.getElementById('cibeAuditDate').value = '';
    loadCibe(); loadSummary();
  } catch (ex) { showError(ex.message || 'Error al crear certificado'); }
});

// ---- Politicas ----
async function loadPolicies() {
  const body = document.getElementById('polBody');
  try {
    const rows = await api.pactvmPoliciesList();
    if (rows.length === 0) { body.innerHTML = '<tr class="empty-row"><td colspan="6">Sin políticas registradas.</td></tr>'; return; }
    body.innerHTML = rows.map(r => `<tr data-id="${r.id}">
          <td>${escapeHtml(r.name)}</td>
          <td>${escapeHtml(r.category)}</td>
          <td class="mono">${r.threshold ?? '—'} ${escapeHtml(r.unit || '')}</td>
          <td><input type="checkbox" class="pol-active" ${r.active ? 'checked' : ''}></td>
          <td class="mono">v${r.version}</td>
          <td><button class="btn ghost btn--sm pol-del">Eliminar</button></td>
        </tr>`).join('');
    body.querySelectorAll('tr[data-id]').forEach(tr => {
      const id = tr.dataset.id;
      tr.querySelector('.pol-active').addEventListener('change', async (e) => {
        try { await api.pactvmPolicyPatch(id, { active: e.target.checked }); loadSummary(); } catch (ex) { showError(ex.message); }
      });
      tr.querySelector('.pol-del').addEventListener('click', async () => {
        try { await api.pactvmPolicyDelete(id); loadPolicies(); loadSummary(); } catch (ex) { showError(ex.message); }
      });
    });
  } catch (ex) { showError(ex.message || 'Error al cargar políticas'); }
}
document.getElementById('polAddBtn').addEventListener('click', async () => {
  showError('');
  const name = document.getElementById('polName').value.trim();
  if (!name) return showError('Indica el nombre de la política');
  try {
    const thresholdRaw = document.getElementById('polThreshold').value.trim();
    await api.pactvmPolicyAdd({
      name,
      category: document.getElementById('polCategory').value,
      threshold: thresholdRaw ? Number(thresholdRaw) : null,
      unit: document.getElementById('polUnit').value.trim() || null,
    });
    document.getElementById('polName').value = '';
    document.getElementById('polThreshold').value = '';
    document.getElementById('polUnit').value = '';
    loadPolicies(); loadSummary();
  } catch (ex) { showError(ex.message || 'Error al crear política'); }
});

// ---- Condiciones de acceso ----
async function loadAccessRules() {
  const body = document.getElementById('accBody');
  try {
    const rows = await api.pactvmAccessRulesList();
    if (rows.length === 0) { body.innerHTML = '<tr class="empty-row"><td colspan="6">Sin reglas registradas.</td></tr>'; return; }
    body.innerHTML = rows.map(r => `<tr data-id="${r.id}">
          <td>${escapeHtml(r.subject)}</td>
          <td>${escapeHtml(r.scope)}</td>
          <td>${escapeHtml(r.target)}</td>
          <td>${selectHtml(ACCESS_STATUSES, r.status, 'acc-status')}</td>
          <td style="font-size:0.8rem;">${escapeHtml(r.reason || '')}</td>
          <td><button class="btn ghost btn--sm acc-del">Eliminar</button></td>
        </tr>`).join('');
    body.querySelectorAll('tr[data-id]').forEach(tr => {
      const id = tr.dataset.id;
      tr.querySelector('.acc-status').addEventListener('change', async (e) => {
        try { await api.pactvmAccessRulePatch(id, { status: e.target.value }); } catch (ex) { showError(ex.message); }
      });
      tr.querySelector('.acc-del').addEventListener('click', async () => {
        try { await api.pactvmAccessRuleDelete(id); loadAccessRules(); } catch (ex) { showError(ex.message); }
      });
    });
  } catch (ex) { showError(ex.message || 'Error al cargar condiciones de acceso'); }
}
document.getElementById('accAddBtn').addEventListener('click', async () => {
  showError('');
  const subject = document.getElementById('accSubject').value.trim();
  const target = document.getElementById('accTarget').value.trim();
  if (!subject) return showError('Indica el sujeto');
  if (!target) return showError('Indica el objetivo');
  try {
    await api.pactvmAccessRuleAdd({
      subject,
      scope: document.getElementById('accScope').value,
      target,
      reason: document.getElementById('accReason').value.trim() || null,
    });
    document.getElementById('accSubject').value = '';
    document.getElementById('accTarget').value = '';
    document.getElementById('accReason').value = '';
    loadAccessRules();
  } catch (ex) { showError(ex.message || 'Error al crear regla'); }
});

// ---- Herzog (solo lectura) ----
async function loadHerzog() {
  const body = document.getElementById('herzogBody');
  try {
    const rows = await api.pactvmHerzogAudits();
    if (rows.length === 0) { body.innerHTML = '<tr class="empty-row"><td colspan="5">Sin auditorías Herzog registradas.</td></tr>'; return; }
    body.innerHTML = rows.map(r => {
      const cls = r.classification || '—';
      const color = cls === 'ESTRATEGICO' ? '#00a878' : cls === 'OPERATIVO' ? '#c9a84c' : cls === 'NO_CANDIDATO' ? '#d80300' : '#8a8a8a';
      return `<tr>
            <td>${escapeHtml(r.companyName || '—')}</td>
            <td>${pill(cls, color)}</td>
            <td class="mono">${r.overall ?? '—'}</td>
            <td style="font-size:0.8rem; max-width:360px;">${escapeHtml(r.summary || '')}</td>
            <td class="mono">${r.createdAt ? new Date(r.createdAt).toLocaleString('es-ES') : '—'}</td>
          </tr>`;
    }).join('');
  } catch (ex) { showError(ex.message || 'Error al cargar auditorías Herzog'); }
}

// ---- Bunker CIBE (Volumen 3: tokens firmados Ed25519) ----
async function loadBunker() {
  try {
    const s = await api.cibeBunkerStatus();
    document.getElementById('bkMode').textContent = s.mode;
    document.getElementById('bkKid').textContent = s.kid || '—';
    document.getElementById('bkIssued').textContent = s.counters.issued;
    document.getElementById('bkAuto').textContent = s.counters.autoIssued;
    document.getElementById('bkRefused').textContent = s.counters.refused;
    document.getElementById('bkRevoked').textContent = s.revokedCount;
    document.getElementById('bkKeySource').textContent = s.keySource;
    const body = document.getElementById('bkRefusalsBody');
    const rows = s.recentRefusals || [];
    if (!rows.length) { body.innerHTML = '<tr class="empty-row"><td colspan="6">Sin Auth-Refusals registrados. La puerta no ha rechazado a nadie todavía.</td></tr>'; return; }
    body.innerHTML = rows.map(r => `<tr>
          <td class="mono">${r.seq}</td>
          <td>${escapeHtml(r.actorId || '—')}</td>
          <td>${pill(r.detail?.code || '—', '#d80300')}</td>
          <td class="mono" style="font-size:0.7rem;">${escapeHtml(r.detail?.method || '')} ${escapeHtml(r.detail?.path || '—')}</td>
          <td class="mono">${escapeHtml(r.detail?.scope || '—')}</td>
          <td class="mono">${r.createdAt ? new Date(r.createdAt).toLocaleString('es-ES') : '—'}</td>
        </tr>`).join('');
  } catch (ex) { showError(ex.message || 'Error al cargar el búnker CIBE'); }
}
document.getElementById('bkRevokeBtn').addEventListener('click', async () => {
  showError('');
  const jti = document.getElementById('bkRevokeJti').value.trim();
  if (!jti) return showError('Indica el jti del token a revocar');
  try {
    await api.cibeBunkerRevoke(jti);
    document.getElementById('bkRevokeJti').value = '';
    toast('Token revocado.');
    loadBunker();
  } catch (ex) { showError(ex.message); }
});
document.getElementById('bkVerifyBtn').addEventListener('click', async () => {
  const msg = document.getElementById('bkVerifyMsg');
  msg.textContent = 'verificando…';
  try {
    const r = await api.cibeBunkerLogVerify();
    msg.textContent = r.valid ? `íntegro · ${r.totalEntries} entradas` : `ROTO en seq ${r.brokenAtSeq}`;
    msg.style.color = r.valid ? '#00a878' : '#d80300';
  } catch (ex) { msg.textContent = ex.message; msg.style.color = '#d80300'; }
});

// ---- Init ----
loadSummary();
loadCibe();
loadPolicies();
loadAccessRules();
loadHerzog();
loadBunker();
setInterval(loadBunker, 30000);
