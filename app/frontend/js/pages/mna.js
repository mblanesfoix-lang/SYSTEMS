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

let deals = [];
let selectedDealId = null;

// ---- Tabs ----
document.querySelectorAll('.mode-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    if (tab.disabled) return;
    document.querySelectorAll('.mode-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.mna-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`panel-${tab.dataset.panel}`).classList.add('active');
  });
});

function refreshDealTabsState() {
  const hasDeals = deals.length > 0;
  document.getElementById('tabValuation').disabled = !hasDeals;
  document.getElementById('tabDiligence').disabled = !hasDeals;
}

function syncDealSelects() {
  const options = deals.map(d => `<option value="${d.id}">${escapeHtml(d.targetName)}</option>`).join('');
  ['valDealSelect', 'ddDealSelect'].forEach(selId => {
    const sel = document.getElementById(selId);
    const prev = sel.value;
    sel.innerHTML = options || '<option value="">Sin candidatos</option>';
    if (deals.some(d => d.id === prev)) sel.value = prev;
    else if (deals[0]) sel.value = deals[0].id;
  });
  selectedDealId = document.getElementById('valDealSelect').value || null;
}

// ---- Summary KPIs ----
async function loadSummary() {
  try {
    const s = await api.mnaSummary();
    document.getElementById('kpiActiveVal').textContent = s.activeDeals ?? 0;
    document.getElementById('kpiDdVal').textContent = s.inDiligence ?? 0;
    document.getElementById('kpiPipelineVal').textContent = `€${(s.totalPipelineValue ?? 0).toLocaleString('es-ES')}`;
    document.getElementById('kpiRiskVal').textContent = s.dealsAtRisk ?? 0;
    document.getElementById('kpiRisk').classList.toggle('alert', (s.dealsAtRisk ?? 0) > 0);
    document.getElementById('kpiRiskVal').classList.toggle('warn', (s.dealsAtRisk ?? 0) > 0);
  } catch (ex) { showError(ex.message || 'Error al cargar resumen'); }
}

const DEAL_TYPES = { adquisicion: 'Adquisición', fusion: 'Fusión', jv: 'Joint Venture' };
const DEAL_STAGES = { screening: 'Screening', nda: 'NDA', dd: 'Due Diligence', loi: 'LOI', cierre: 'Cierre' };
const DD_STATUSES = {
  pendiente: { label: 'Pendiente', color: '#8a8a8a' },
  en_curso: { label: 'En curso', color: '#0071e3' },
  ok: { label: 'OK', color: '#00a878' },
  riesgo: { label: 'Riesgo', color: '#d80300' },
};

function selectHtml(options, current, cls) {
  return `<select class="input ${cls}" style="font-size:0.72rem; padding:4px 6px;">` +
    Object.entries(options).map(([k, v]) => `<option value="${k}" ${k === current ? 'selected' : ''}>${typeof v === 'string' ? v : v.label}</option>`).join('') +
    `</select>`;
}
function pill(label, color) {
  return `<span class="status-pill"><span class="status-dot-sm" style="background:${color};"></span>${escapeHtml(label)}</span>`;
}

// ---- Pipeline ----
async function loadDeals() {
  const body = document.getElementById('dealBody');
  try {
    deals = await api.mnaDealsList();
    refreshDealTabsState();
    syncDealSelects();
    if (deals.length === 0) { body.innerHTML = '<tr class="empty-row"><td colspan="7">Sin candidatos registrados.</td></tr>'; return; }
    body.innerHTML = deals.map(d => `<tr data-id="${d.id}">
          <td>${escapeHtml(d.targetName)}</td>
          <td>${escapeHtml(d.sector || '—')} / ${escapeHtml(d.location || '—')}</td>
          <td>${DEAL_TYPES[d.dealType] || d.dealType}</td>
          <td>${selectHtml(DEAL_STAGES, d.stage, 'deal-stage')}</td>
          <td class="mono">${d.ophsScore != null ? d.ophsScore : '—'}</td>
          <td style="color:#d80300; font-size:0.8rem;">${escapeHtml(d.blockerNote || '')}</td>
          <td><button class="btn ghost btn--sm deal-del">Eliminar</button></td>
        </tr>`).join('');
    body.querySelectorAll('tr[data-id]').forEach(tr => {
      const id = tr.dataset.id;
      tr.querySelector('.deal-stage').addEventListener('change', async (e) => {
        try { await api.mnaDealPatch(id, { stage: e.target.value }); loadSummary(); loadDeals(); } catch (ex) { showError(ex.message); }
      });
      tr.querySelector('.deal-del').addEventListener('click', async () => {
        if (!confirm('¿Eliminar candidato? Se borrará valoración, sinergias y due diligence asociada.')) return;
        try { await api.mnaDealDelete(id); loadDeals(); loadSummary(); } catch (ex) { showError(ex.message); }
      });
    });
  } catch (ex) { showError(ex.message || 'Error al cargar pipeline'); }
}
document.getElementById('dealAddBtn').addEventListener('click', async () => {
  showError('');
  const targetName = document.getElementById('dealTarget').value.trim();
  if (!targetName) return showError('Indica la empresa objetivo');
  try {
    await api.mnaDealAdd({
      targetName,
      sector: document.getElementById('dealSector').value.trim() || null,
      location: document.getElementById('dealLocation').value.trim() || null,
      dealType: document.getElementById('dealType').value,
      owner: document.getElementById('dealOwner').value.trim() || null,
    });
    document.getElementById('dealTarget').value = '';
    document.getElementById('dealSector').value = '';
    document.getElementById('dealLocation').value = '';
    document.getElementById('dealOwner').value = '';
    loadDeals(); loadSummary();
  } catch (ex) { showError(ex.message || 'Error al crear candidato'); }
});

// ---- Valoracion ----
async function loadValuation() {
  const dealId = document.getElementById('valDealSelect').value;
  if (!dealId) return;
  try {
    const v = await api.mnaValuationGet(dealId);
    if (v) {
      document.getElementById('valEbitda').value = v.ebitda;
      document.getElementById('valMultiple').value = v.multipleUsed;
      document.getElementById('valGrowth').value = v.growthRate;
      document.getElementById('valWacc').value = v.wacc;
      document.getElementById('valTerminalGrowth').value = v.terminalGrowthRate;
      document.getElementById('valHorizon').value = v.horizonYears;
      document.getElementById('valCashPct').value = v.structure?.cashPct ?? '';
      document.getElementById('valStockPct').value = v.structure?.stockPct ?? '';
      document.getElementById('valEarnoutPct').value = v.structure?.earnoutPct ?? '';
      document.getElementById('valEarnoutHorizon').value = v.structure?.earnoutHorizonMonths ?? '';
      document.getElementById('valEarnoutConditions').value = v.structure?.earnoutConditions ?? '';
      document.getElementById('valMultiplesResult').textContent = `€${v.impliedValueMultiples.toLocaleString('es-ES')}`;
      document.getElementById('valDcfResult').textContent = `€${v.impliedValueDCF.toLocaleString('es-ES')}`;
    } else {
      ['valEbitda','valMultiple','valGrowth','valWacc','valTerminalGrowth','valHorizon','valCashPct','valStockPct','valEarnoutPct','valEarnoutHorizon','valEarnoutConditions'].forEach(id => document.getElementById(id).value = '');
      document.getElementById('valMultiplesResult').textContent = '—';
      document.getElementById('valDcfResult').textContent = '—';
    }
  } catch (ex) { showError(ex.message || 'Error al cargar valoración'); }

  try {
    const s = await api.mnaSynergiesGet(dealId);
    if (s) {
      document.getElementById('synCost').value = s.costSynergiesAnnual;
      document.getElementById('synRevenue').value = s.revenueSynergiesAnnual;
      document.getElementById('synOneOff').value = s.oneOffIntegrationCost;
      document.getElementById('synPayback').textContent = s.paybackMonths != null ? `Payback: ${s.paybackMonths} meses` : 'Sin payback calculable (sinergias anuales = 0)';
    } else {
      document.getElementById('synCost').value = '';
      document.getElementById('synRevenue').value = '';
      document.getElementById('synOneOff').value = '';
      document.getElementById('synPayback').textContent = '';
    }
  } catch (ex) { showError(ex.message || 'Error al cargar sinergias'); }
}
document.getElementById('valDealSelect').addEventListener('change', loadValuation);

document.getElementById('valSaveBtn').addEventListener('click', async () => {
  showError('');
  const dealId = document.getElementById('valDealSelect').value;
  if (!dealId) return showError('Selecciona un deal');
  try {
    const v = await api.mnaValuationSet(dealId, {
      ebitda: Number(document.getElementById('valEbitda').value),
      multipleUsed: Number(document.getElementById('valMultiple').value),
      growthRate: Number(document.getElementById('valGrowth').value),
      wacc: Number(document.getElementById('valWacc').value),
      terminalGrowthRate: Number(document.getElementById('valTerminalGrowth').value),
      horizonYears: Number(document.getElementById('valHorizon').value) || 5,
      cashPct: Number(document.getElementById('valCashPct').value) || 0,
      stockPct: Number(document.getElementById('valStockPct').value) || 0,
      earnoutPct: Number(document.getElementById('valEarnoutPct').value) || 0,
      earnoutHorizonMonths: Number(document.getElementById('valEarnoutHorizon').value) || null,
      earnoutConditions: document.getElementById('valEarnoutConditions').value.trim() || null,
    });
    document.getElementById('valMultiplesResult').textContent = `€${v.impliedValueMultiples.toLocaleString('es-ES')}`;
    document.getElementById('valDcfResult').textContent = `€${v.impliedValueDCF.toLocaleString('es-ES')}`;
    toast('Valoración guardada');
    loadSummary();
  } catch (ex) { showError(ex.message || 'Error al guardar valoración'); }
});

document.getElementById('synSaveBtn').addEventListener('click', async () => {
  showError('');
  const dealId = document.getElementById('valDealSelect').value;
  if (!dealId) return showError('Selecciona un deal');
  try {
    const s = await api.mnaSynergiesSet(dealId, {
      costSynergiesAnnual: Number(document.getElementById('synCost').value) || 0,
      revenueSynergiesAnnual: Number(document.getElementById('synRevenue').value) || 0,
      oneOffIntegrationCost: Number(document.getElementById('synOneOff').value) || 0,
    });
    document.getElementById('synPayback').textContent = s.paybackMonths != null ? `Payback: ${s.paybackMonths} meses` : 'Sin payback calculable (sinergias anuales = 0)';
    toast('Sinergias guardadas');
  } catch (ex) { showError(ex.message || 'Error al guardar sinergias'); }
});

// ---- Due diligence ----
async function loadDiligenceCategories() {
  const dealId = document.getElementById('ddDealSelect').value;
  const catSelect = document.getElementById('ddItemCategory');
  if (!dealId) { catSelect.innerHTML = '<option value="">Sin categoría</option>'; return; }
  try {
    const cats = await api.mnaDiligenceCategoriesList(dealId);
    catSelect.innerHTML = '<option value="">Sin categoría</option>' + cats.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  } catch (ex) { showError(ex.message || 'Error al cargar categorías'); }
}

async function loadDiligenceItems() {
  const dealId = document.getElementById('ddDealSelect').value;
  const body = document.getElementById('ddBody');
  if (!dealId) { body.innerHTML = '<tr class="empty-row"><td colspan="5">Selecciona un deal.</td></tr>'; return; }
  try {
    const [items, cats] = await Promise.all([api.mnaDiligenceItemsList(dealId), api.mnaDiligenceCategoriesList(dealId)]);
    const catName = new Map(cats.map(c => [c.id, c.name]));
    if (items.length === 0) { body.innerHTML = '<tr class="empty-row"><td colspan="5">Sin ítems de due diligence.</td></tr>'; return; }
    body.innerHTML = items.map(i => `<tr data-id="${i.id}">
          <td>${escapeHtml(i.item)}</td>
          <td>${escapeHtml(catName.get(i.categoryId) || '—')}</td>
          <td>${selectHtml(DD_STATUSES, i.status, 'dd-status')}</td>
          <td>${escapeHtml(i.auditor || '—')}</td>
          <td><button class="btn ghost btn--sm dd-del">Eliminar</button></td>
        </tr>`).join('');
    body.querySelectorAll('tr[data-id]').forEach(tr => {
      const id = tr.dataset.id;
      tr.querySelector('.dd-status').addEventListener('change', async (e) => {
        try { await api.mnaDiligenceItemPatch(id, { status: e.target.value }); loadSummary(); } catch (ex) { showError(ex.message); }
      });
      tr.querySelector('.dd-del').addEventListener('click', async () => {
        try { await api.mnaDiligenceItemDelete(id); loadDiligenceItems(); loadSummary(); } catch (ex) { showError(ex.message); }
      });
    });
  } catch (ex) { showError(ex.message || 'Error al cargar due diligence'); }
}

document.getElementById('ddDealSelect').addEventListener('change', () => { loadDiligenceCategories(); loadDiligenceItems(); });

document.getElementById('ddCategoryAddBtn').addEventListener('click', async () => {
  showError('');
  const dealId = document.getElementById('ddDealSelect').value;
  const name = document.getElementById('ddCategoryName').value.trim();
  if (!dealId) return showError('Selecciona un deal');
  if (!name) return showError('Indica el nombre de la categoría');
  try {
    await api.mnaDiligenceCategoryAdd(dealId, { name });
    document.getElementById('ddCategoryName').value = '';
    loadDiligenceCategories();
  } catch (ex) { showError(ex.message || 'Error al crear categoría'); }
});

document.getElementById('ddItemAddBtn').addEventListener('click', async () => {
  showError('');
  const dealId = document.getElementById('ddDealSelect').value;
  const item = document.getElementById('ddItemText').value.trim();
  if (!dealId) return showError('Selecciona un deal');
  if (!item) return showError('Indica el ítem');
  try {
    await api.mnaDiligenceItemAdd(dealId, {
      item,
      categoryId: document.getElementById('ddItemCategory').value || null,
      auditor: document.getElementById('ddItemAuditor').value.trim() || null,
    });
    document.getElementById('ddItemText').value = '';
    document.getElementById('ddItemAuditor').value = '';
    loadDiligenceItems(); loadSummary();
  } catch (ex) { showError(ex.message || 'Error al crear ítem'); }
});

// ---- Init ----
(async () => {
  await loadDeals();
  loadSummary();
  if (deals.length > 0) {
    loadValuation();
    loadDiligenceCategories();
    loadDiligenceItems();
  }
})();
