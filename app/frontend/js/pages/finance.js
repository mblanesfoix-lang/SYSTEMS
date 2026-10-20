import { api, getUser, requireAuth, clearSession, toast, escapeHtml, downloadFinanceExport,
         uploadFinanceCompanyDoc, openFinanceCompanyDoc } from '/js/api.js';
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
function money(n) {
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(n || 0);
}
const todayIso = new Date().toISOString().slice(0, 10);
document.getElementById('expTo').value = todayIso;
document.getElementById('expFrom').value = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

// ================= TABS =================
document.querySelectorAll('.mode-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.mode-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.finance-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`panel-${tab.dataset.panel}`).classList.add('active');
  });
});

// ================= MODAL =================
const overlay = document.getElementById('modalOverlay');
const modalBox = document.getElementById('modalBox');

const MODAL_TEMPLATES = {
  account: () => `
        <div class="modal-box__head"><h3>Nueva cuenta</h3><button class="modal-close" data-close>&times;</button></div>
        <div class="modal-grid">
          <div class="sf full"><label>Nombre</label><input class="input" id="m-accName" placeholder="BBVA Operativa"></div>
          <div class="sf"><label>Tipo</label><select class="input" id="m-accKind"><option value="banco">Banco</option><option value="caja">Caja</option></select></div>
          <div class="sf"><label>IBAN</label><input class="input" id="m-accIban" placeholder="Opcional"></div>
          <div class="sf full"><label>Saldo inicial (EUR)</label><input class="input" type="number" step="0.01" id="m-accOpening" placeholder="0.00"></div>
        </div>
        <div class="modal-actions"><button class="btn ghost" data-close>Cancelar</button><button class="btn sage" id="m-accSubmit">Crear cuenta</button></div>
      `,
  transfer: () => `
        <div class="modal-box__head"><h3>Transferencia entre cuentas</h3><button class="modal-close" data-close>&times;</button></div>
        <div class="modal-grid">
          <div class="sf"><label>Origen</label><select class="input" id="m-trFrom"></select></div>
          <div class="sf"><label>Destino</label><select class="input" id="m-trTo"></select></div>
          <div class="sf"><label>Importe (EUR)</label><input class="input" type="number" step="0.01" id="m-trAmount" placeholder="0.00"></div>
          <div class="sf"><label>Fecha</label><input class="input" type="date" id="m-trDate"></div>
          <div class="sf full"><label>Descripción</label><input class="input" id="m-trDescription" placeholder="Opcional"></div>
        </div>
        <div class="modal-actions"><button class="btn ghost" data-close>Cancelar</button><button class="btn sage" id="m-trSubmit">Transferir</button></div>
      `,
  movement: () => `
        <div class="modal-box__head"><h3>Nuevo movimiento</h3><button class="modal-close" data-close>&times;</button></div>
        <div class="modal-grid">
          <div class="sf"><label>Cuenta</label><select class="input" id="m-mvAccount"></select></div>
          <div class="sf"><label>Centro coste</label><select class="input" id="m-mvCostCenter"><option value="">Ninguno</option></select></div>
          <div class="sf"><label>Categoría</label><select class="input" id="m-mvCategory"><option value="gasto">Salida (gasto)</option><option value="ingreso">Entrada (ingreso)</option></select></div>
          <div class="sf"><label>Importe (EUR)</label><input class="input" type="number" step="0.01" id="m-mvAmount" placeholder="0.00"></div>
          <div class="sf"><label>IVA %</label><input class="input" type="number" step="0.01" id="m-mvVat" value="0"></div>
          <div class="sf"><label>Fecha</label><input class="input" type="date" id="m-mvDate"></div>
          <div class="sf"><label>Referencia</label><input class="input" id="m-mvReference" placeholder="Nº factura"></div>
          <div class="sf full"><label>Descripción</label><input class="input" id="m-mvDescription" placeholder="Concepto"></div>
        </div>
        <div class="modal-actions"><button class="btn ghost" data-close>Cancelar</button><button class="btn sage" id="m-mvSubmit">Registrar</button></div>
      `,
  costcenter: () => `
        <div class="modal-box__head"><h3>Nuevo centro de coste</h3><button class="modal-close" data-close>&times;</button></div>
        <div class="modal-grid">
          <div class="sf full"><label>Nombre</label><input class="input" id="m-ccName" placeholder="Planta Barcelona"></div>
          <div class="sf full"><label>Descripción</label><input class="input" id="m-ccDescription" placeholder="Opcional"></div>
        </div>
        <div class="modal-actions"><button class="btn ghost" data-close>Cancelar</button><button class="btn sage" id="m-ccSubmit">Crear</button></div>
      `,
  asset: () => `
        <div class="modal-box__head"><h3>Nuevo activo</h3><button class="modal-close" data-close>&times;</button></div>
        <div class="modal-grid">
          <div class="sf full"><label>Nombre</label><input class="input" id="m-astName" placeholder="Línea BioGrinder #2"></div>
          <div class="sf"><label>Centro coste</label><select class="input" id="m-astCostCenter"><option value="">Ninguno</option></select></div>
          <div class="sf"><label>Adquisición</label><input class="input" type="date" id="m-astDate"></div>
          <div class="sf"><label>Valor adquisición (EUR)</label><input class="input" type="number" step="0.01" id="m-astValue" placeholder="0.00"></div>
          <div class="sf"><label>Valor residual (EUR)</label><input class="input" type="number" step="0.01" id="m-astResidual" value="0"></div>
          <div class="sf"><label>Vida útil (meses)</label><input class="input" type="number" id="m-astLife" value="60"></div>
        </div>
        <div class="modal-actions"><button class="btn ghost" data-close>Cancelar</button><button class="btn sage" id="m-astSubmit">Añadir activo</button></div>
      `,
  company: () => `
        <div class="modal-box__head"><h3>Nueva empresa</h3><button class="modal-close" data-close>&times;</button></div>
        <div class="modal-grid">
          <div class="sf full"><label>Nombre</label><input class="input" id="m-coName" placeholder="Razón social"></div>
          <div class="sf"><label>Relación</label><select class="input" id="m-coRelation"></select></div>
          <div class="sf"><label>Estado</label><select class="input" id="m-coStatus"></select></div>
          <div class="sf"><label>CIF / NIF</label><input class="input" id="m-coTaxId" placeholder="Opcional"></div>
          <div class="sf"><label>Sector</label><input class="input" id="m-coSector" placeholder="Opcional"></div>
          <div class="sf"><label>País (ISO-2)</label><input class="input" id="m-coCountry" maxlength="2" placeholder="ES"></div>
          <div class="sf"><label>Centro coste</label><select class="input" id="m-coCostCenter"><option value="">Ninguno</option></select></div>
          <div class="sf"><label>Contacto</label><input class="input" id="m-coContactName" placeholder="Opcional"></div>
          <div class="sf"><label>Email</label><input class="input" type="email" id="m-coContactEmail" placeholder="Opcional"></div>
          <div class="sf"><label>Teléfono</label><input class="input" id="m-coContactPhone" placeholder="Opcional"></div>
          <div class="sf full"><label>Notas</label><input class="input" id="m-coNotes" placeholder="Opcional"></div>
        </div>
        <p class="modal-error" id="m-coError" hidden></p>
        <div class="modal-actions"><button class="btn ghost" data-close>Cancelar</button><button class="btn sage" id="m-coSubmit">Crear empresa</button></div>
      `,
};

function fillSelect(sel, rows, placeholder) {
  sel.innerHTML = (placeholder ? `<option value="">${placeholder}</option>` : '') + rows.map(r => `<option value="${r.id}">${escapeHtml(r.name)}</option>`).join('');
}

function openModal(kind) {
  modalBox.innerHTML = MODAL_TEMPLATES[kind]();
  overlay.classList.add('show');
  modalBox.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeModal));

  if (kind === 'account') {
    document.getElementById('m-accSubmit').addEventListener('click', async () => {
      const name = document.getElementById('m-accName').value.trim();
      if (!name) return showError('Indica el nombre de la cuenta');
      try {
        await api.financeAccountAdd({
          name, kind: document.getElementById('m-accKind').value,
          iban: document.getElementById('m-accIban').value.trim() || null,
          openingBalance: document.getElementById('m-accOpening').value || 0,
        });
        closeModal(); toast('Cuenta creada'); loadAccounts(); loadSummary();
      } catch (ex) { showError(ex.message || 'Error al crear cuenta'); }
    });
  } else if (kind === 'transfer') {
    fillSelect(document.getElementById('m-trFrom'), accountsCache, 'Seleccionar…');
    fillSelect(document.getElementById('m-trTo'), accountsCache, 'Seleccionar…');
    document.getElementById('m-trDate').value = todayIso;
    document.getElementById('m-trSubmit').addEventListener('click', async () => {
      const fromAccountId = document.getElementById('m-trFrom').value;
      const toAccountId = document.getElementById('m-trTo').value;
      const amount = Number(document.getElementById('m-trAmount').value);
      if (!fromAccountId || !toAccountId) return showError('Selecciona cuentas origen y destino');
      if (fromAccountId === toAccountId) return showError('Origen y destino deben ser distintos');
      if (!amount || amount <= 0) return showError('Importe inválido');
      try {
        await api.financeTransferAdd({
          fromAccountId, toAccountId, amount,
          valueDate: document.getElementById('m-trDate').value,
          description: document.getElementById('m-trDescription').value.trim(),
        });
        closeModal(); toast('Transferencia realizada');
        loadAccounts(); loadTransfers(); loadSummary(); loadMovements(); loadProjection();
      } catch (ex) { showError(ex.message || 'Error al transferir'); }
    });
  } else if (kind === 'movement') {
    fillSelect(document.getElementById('m-mvAccount'), accountsCache, 'Seleccionar…');
    fillSelect(document.getElementById('m-mvCostCenter'), costCentersCache, 'Ninguno');
    document.getElementById('m-mvDate').value = todayIso;
    document.getElementById('m-mvSubmit').addEventListener('click', async () => {
      const accountId = document.getElementById('m-mvAccount').value;
      const amountRaw = Number(document.getElementById('m-mvAmount').value);
      const category = document.getElementById('m-mvCategory').value;
      if (!accountId) return showError('Selecciona una cuenta');
      if (!amountRaw) return showError('Importe inválido');
      const amount = category === 'gasto' ? -Math.abs(amountRaw) : Math.abs(amountRaw);
      try {
        await api.financeMovementAdd({
          accountId, costCenterId: document.getElementById('m-mvCostCenter').value || null, amount,
          vatRatePct: Number(document.getElementById('m-mvVat').value) || 0,
          reference: document.getElementById('m-mvReference').value.trim(),
          valueDate: document.getElementById('m-mvDate').value,
          description: document.getElementById('m-mvDescription').value.trim(),
          category,
        });
        closeModal(); toast('Movimiento registrado');
        loadMovements(); loadSummary(); loadAccounts(); loadProjection(); loadCostCenters(); loadAnalytics();
      } catch (ex) { showError(ex.message || 'Error al registrar movimiento'); }
    });
  } else if (kind === 'costcenter') {
    document.getElementById('m-ccSubmit').addEventListener('click', async () => {
      const name = document.getElementById('m-ccName').value.trim();
      if (!name) return showError('Indica el nombre del centro de coste');
      try {
        await api.financeCostCenterAdd({ name, description: document.getElementById('m-ccDescription').value.trim() || null });
        closeModal(); toast('Centro de coste creado'); loadCostCenters(); loadAnalytics();
      } catch (ex) { showError(ex.message || 'Error al crear centro de coste'); }
    });
  } else if (kind === 'asset') {
    fillSelect(document.getElementById('m-astCostCenter'), costCentersCache, 'Ninguno');
    document.getElementById('m-astDate').value = todayIso;
    document.getElementById('m-astSubmit').addEventListener('click', async () => {
      const name = document.getElementById('m-astName').value.trim();
      const acquisitionValue = Number(document.getElementById('m-astValue').value);
      if (!name) return showError('Indica el nombre del activo');
      if (!acquisitionValue || acquisitionValue <= 0) return showError('Valor de adquisición inválido');
      try {
        await api.financeAssetAdd({
          name, costCenterId: document.getElementById('m-astCostCenter').value || null,
          acquisitionDate: document.getElementById('m-astDate').value, acquisitionValue,
          residualValue: Number(document.getElementById('m-astResidual').value) || 0,
          usefulLifeMonths: Number(document.getElementById('m-astLife').value) || 60,
        });
        closeModal(); toast('Activo creado'); loadAssets(); loadSummary();
      } catch (ex) { showError(ex.message || 'Error al crear activo'); }
    });
  } else if (kind === 'company') {
    const relSel = document.getElementById('m-coRelation');
    const staSel = document.getElementById('m-coStatus');
    relSel.innerHTML = crmMeta.relations.map(r => `<option value="${r}">${CRM_LABELS[r] || r}</option>`).join('');
    staSel.innerHTML = crmMeta.statuses.map(s => `<option value="${s}">${CRM_LABELS[s] || s}</option>`).join('');
    fillSelect(document.getElementById('m-coCostCenter'), costCentersCache, 'Ninguno');
    // El error se pinta dentro del modal: el #errorBox global queda arriba
    // del todo, fuera de la vista, y un fallo pasaba desapercibido.
    const coErr = document.getElementById('m-coError');
    const coFail = (msg) => { coErr.textContent = msg; coErr.hidden = false; };
    const submitBtn = document.getElementById('m-coSubmit');
    submitBtn.addEventListener('click', async () => {
      coErr.hidden = true;
      const name = document.getElementById('m-coName').value.trim();
      if (!name) return coFail('Indica el nombre de la empresa');
      submitBtn.disabled = true;
      try {
        const created = await api.financeCompanyAdd({
          name,
          relation: relSel.value,
          status: staSel.value,
          taxId: document.getElementById('m-coTaxId').value.trim() || null,
          sector: document.getElementById('m-coSector').value.trim() || null,
          country: document.getElementById('m-coCountry').value.trim() || null,
          costCenterId: document.getElementById('m-coCostCenter').value || null,
          contactName: document.getElementById('m-coContactName').value.trim() || null,
          contactEmail: document.getElementById('m-coContactEmail').value.trim() || null,
          contactPhone: document.getElementById('m-coContactPhone').value.trim() || null,
          notes: document.getElementById('m-coNotes').value.trim() || null,
        });
        closeModal(); toast('Empresa creada');
        await loadCompanies();
        selectCompany(created.id);
      } catch (ex) {
        coFail(ex.message || 'Error al crear empresa');
      } finally {
        submitBtn.disabled = false;
      }
    });
  }
}
function closeModal() { overlay.classList.remove('show'); }
overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
document.querySelectorAll('[data-modal]').forEach(btn => btn.addEventListener('click', () => { showError(''); openModal(btn.dataset.modal); }));

// ================= EDICION INLINE =================
// cell: <td class="editable" data-field="x" data-value="raw"> label </td>
// onSave(id, field, newValue) -> Promise
function bindInlineEdit(tbody, onSave, opts = {}) {
  tbody.addEventListener('click', (e) => {
    const cell = e.target.closest('.editable');
    if (!cell || cell.classList.contains('editing')) return;
    const tr = cell.closest('tr');
    const id = tr.dataset.id;
    const field = cell.dataset.field;
    const raw = cell.dataset.value ?? cell.textContent.trim();
    const type = cell.dataset.type || 'text';
    cell.classList.add('editing');
    const original = cell.innerHTML;

    let inputEl;
    if (type === 'select' && opts.selectOptions) {
      inputEl = document.createElement('select');
      inputEl.innerHTML = opts.selectOptions(tr).map(o => `<option value="${o.value}" ${o.value === raw ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('');
    } else {
      inputEl = document.createElement('input');
      inputEl.type = type === 'number' ? 'number' : (type === 'date' ? 'date' : 'text');
      if (type === 'number') inputEl.step = '0.01';
      inputEl.value = raw;
    }
    cell.innerHTML = '';
    cell.appendChild(inputEl);
    inputEl.focus();
    if (inputEl.select) inputEl.select();

    let done = false;
    async function commit() {
      if (done) return; done = true;
      const newValue = inputEl.value;
      cell.classList.remove('editing');
      if (newValue === raw) { cell.innerHTML = original; return; }
      try {
        await onSave(id, field, newValue, tr);
      } catch (ex) {
        showError(ex.message || 'Error al guardar');
        cell.innerHTML = original;
      }
    }
    function cancel() {
      if (done) return; done = true;
      cell.classList.remove('editing');
      cell.innerHTML = original;
    }
    inputEl.addEventListener('blur', commit);
    inputEl.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); inputEl.blur(); }
      if (ev.key === 'Escape') { ev.preventDefault(); cancel(); }
    });
  });
}

// ================= SUMMARY =================
async function loadSummary() {
  try {
    const s = await api.financeSummary();
    document.getElementById('kpiAccountsVal').textContent = s.accountsCount ?? 0;
    document.getElementById('kpiBalanceVal').textContent = money(s.totalBalance);
    document.getElementById('kpiAssetsVal').textContent = money(s.totalAssetValue);
    document.getElementById('kpiMovementsVal').textContent = s.movementsLast30d ?? 0;
  } catch (ex) { showError(ex.message || 'Error al cargar resumen'); }
}

let accountsCache = [];
let costCentersCache = [];
let movementsCache = [];

// Estado del CRM de empresas. Declarado aqui arriba a proposito: la rama
// 'company' de openModal lee crmMeta/CRM_LABELS, y openModal se define antes
// del bloque CRM. Con let/const mas abajo caian en temporal dead zone y el
// boton "Crear empresa" reventaba con ReferenceError.
const CRM_LABELS = {
  cliente: 'Cliente', proveedor: 'Proveedor', participada: 'Participada', inversor: 'Inversor', otro: 'Otro',
  activa: 'Activa', prospecto: 'Prospecto', pausada: 'Pausada', cerrada: 'Cerrada',
  informes: 'Informes', contratos: 'Contratos', facturas: 'Facturas', fiscal: 'Fiscal', tecnico: 'Técnico', otros: 'Otros',
};
let crmMeta = { folders: ['informes','contratos','facturas','fiscal','tecnico','otros'], relations: ['cliente','proveedor','participada','inversor','otro'], statuses: ['activa','prospecto','pausada','cerrada'], maxUploadMb: 24 };
let companiesCache = [];
let selectedCompanyId = null;
let selectedCompany = null;
let activeFolder = '';

// ================= CUENTAS =================
async function loadAccounts() {
  const body = document.getElementById('accBody');
  try {
    const rows = await api.financeAccountsList();
    accountsCache = rows;
    if (rows.length === 0) { body.innerHTML = '<tr class="empty-row"><td colspan="6">Sin cuentas registradas.</td></tr>'; }
    else {
      body.innerHTML = rows.map(r => `<tr data-id="${r.id}">
            <td class="editable" data-field="name" data-value="${escapeHtml(r.name)}">${escapeHtml(r.name)}</td>
            <td class="editable" data-field="kind" data-type="select" data-value="${r.kind}">${r.kind}</td>
            <td class="editable" data-field="iban" data-value="${escapeHtml(r.iban || '')}">${escapeHtml(r.iban || '—')}</td>
            <td class="mono">${money(r.openingBalance)}</td>
            <td class="mono ${r.balance < 0 ? 'amount-neg' : 'amount-pos'}">${money(r.balance)}</td>
            <td><button class="btn ghost btn--sm acc-del">Eliminar</button></td>
          </tr>`).join('');
      body.querySelectorAll('.acc-del').forEach(btn => btn.addEventListener('click', async (e) => {
        const id = e.target.closest('tr').dataset.id;
        try { await api.financeAccountDelete(id); loadAccounts(); loadSummary(); } catch (ex) { showError(ex.message); }
      }));
    }
    [document.getElementById('projAccount'), document.getElementById('mvFilterAccount')].forEach(sel => {
      const keep = sel.value;
      sel.innerHTML = `<option value="">${sel.id === 'projAccount' ? 'Todas las cuentas' : 'Todas las cuentas'}</option>` + rows.map(r => `<option value="${r.id}">${escapeHtml(r.name)}</option>`).join('');
      sel.value = keep;
    });
  } catch (ex) { showError(ex.message || 'Error al cargar cuentas'); }
}
bindInlineEdit(document.getElementById('accBody'), async (id, field, value) => {
  const payload = {};
  payload[field] = value;
  await api.financeAccountPatch(id, payload);
  loadAccounts();
}, { selectOptions: () => [{ value: 'banco', label: 'banco' }, { value: 'caja', label: 'caja' }] });

// ================= TRANSFERENCIAS =================
async function loadTransfers() {
  const body = document.getElementById('trBody');
  try {
    const rows = await api.financeTransfersList();
    if (rows.length === 0) { body.innerHTML = '<tr class="empty-row"><td colspan="5">Sin transferencias registradas.</td></tr>'; return; }
    const byId = new Map(accountsCache.map(a => [a.id, a.name]));
    body.innerHTML = rows.map(r => `<tr>
          <td class="mono">${escapeHtml(r.valueDate)}</td>
          <td>${escapeHtml(byId.get(r.fromAccountId) || r.fromAccountId)}</td>
          <td>${escapeHtml(byId.get(r.toAccountId) || r.toAccountId)}</td>
          <td class="mono">${money(r.amount)}</td>
          <td>${escapeHtml(r.description || '—')}</td>
        </tr>`).join('');
  } catch (ex) { showError(ex.message || 'Error al cargar transferencias'); }
}

// ================= CENTROS DE COSTE =================
async function loadCostCenters() {
  const body = document.getElementById('ccBody');
  try {
    const rows = await api.financeCostCentersList();
    costCentersCache = rows;
    const movements = await api.financeMovementsList();
    if (rows.length === 0) { body.innerHTML = '<tr class="empty-row"><td colspan="4">Sin centros de coste.</td></tr>'; }
    else {
      body.innerHTML = rows.map(r => {
        const total = movements.filter(m => m.costCenterId === r.id).reduce((sum, m) => sum + m.amount, 0);
        return `<tr data-id="${r.id}">
              <td class="editable" data-field="name" data-value="${escapeHtml(r.name)}">${escapeHtml(r.name)}</td>
              <td class="editable" data-field="description" data-value="${escapeHtml(r.description || '')}">${escapeHtml(r.description || '—')}</td>
              <td class="mono ${total < 0 ? 'amount-neg' : 'amount-pos'}">${money(total)}</td>
              <td><button class="btn ghost btn--sm cc-del">Eliminar</button></td>
            </tr>`;
      }).join('');
      body.querySelectorAll('.cc-del').forEach(btn => btn.addEventListener('click', async (e) => {
        const id = e.target.closest('tr').dataset.id;
        try { await api.financeCostCenterDelete(id); loadCostCenters(); loadAnalytics(); } catch (ex) { showError(ex.message); }
      }));
    }
    renderCcDropTargets(rows, movements);
  } catch (ex) { showError(ex.message || 'Error al cargar centros de coste'); }
}
bindInlineEdit(document.getElementById('ccBody'), async (id, field, value) => {
  const payload = {};
  payload[field] = value;
  await api.financeCostCenterPatch(id, payload);
  loadCostCenters(); loadAnalytics();
});

// ================= MOVIMIENTOS: filtro + inline edit + drag =================
function renderMovements() {
  const body = document.getElementById('mvBody');
  const q = document.getElementById('mvFilter').value.trim().toLowerCase();
  const accFilter = document.getElementById('mvFilterAccount').value;
  const catFilter = document.getElementById('mvFilterCategory').value;
  const byId = new Map(accountsCache.map(a => [a.id, a.name]));

  let rows = movementsCache;
  if (accFilter) rows = rows.filter(m => m.accountId === accFilter);
  if (catFilter) rows = rows.filter(m => m.category === catFilter);
  if (q) rows = rows.filter(m => (m.description || '').toLowerCase().includes(q) || (m.reference || '').toLowerCase().includes(q));

  document.getElementById('mvFilterMeta').textContent = `${rows.length} / ${movementsCache.length}`;

  if (rows.length === 0) { body.innerHTML = '<tr class="empty-row"><td colspan="7">Sin movimientos que coincidan.</td></tr>'; return; }
  body.innerHTML = rows.map(r => `<tr data-id="${r.id}" data-category="${r.category}" draggable="${r.category === 'transferencia' ? 'false' : 'true'}">
        <td class="editable" data-field="valueDate" data-type="date" data-value="${r.valueDate}">${escapeHtml(r.valueDate)}</td>
        <td>${escapeHtml(byId.get(r.accountId) || '—')}</td>
        <td class="editable" data-field="description" data-value="${escapeHtml(r.description || '')}">${escapeHtml(r.description || (r.category === 'transferencia' ? 'Transferencia' : '(sin descripción)'))}</td>
        <td class="editable" data-field="reference" data-value="${escapeHtml(r.reference || '')}">${escapeHtml(r.reference || '—')}</td>
        <td class="mono editable ${r.amount < 0 ? 'amount-neg' : (r.category === 'transferencia' ? 'amount-neutral' : 'amount-pos')}" data-field="amount" data-type="number" data-value="${Math.abs(r.amount)}">${money(r.amount)}</td>
        <td class="mono">${r.vat ? money(r.vat) : '—'}</td>
        <td>${r.category === 'transferencia' ? '' : '<button class="btn ghost btn--sm mv-del">Eliminar</button>'}</td>
      </tr>`).join('');

  body.querySelectorAll('.mv-del').forEach(btn => btn.addEventListener('click', async (e) => {
    const id = e.target.closest('tr').dataset.id;
    try { await api.financeMovementDelete(id); await loadMovements(); loadSummary(); loadProjection(); loadCostCenters(); loadAnalytics(); } catch (ex) { showError(ex.message); }
  }));

  body.querySelectorAll('tr[draggable="true"]').forEach(tr => {
    tr.addEventListener('dragstart', (e) => {
      tr.classList.add('dragging');
      e.dataTransfer.setData('text/plain', tr.dataset.id);
      e.dataTransfer.effectAllowed = 'move';
    });
    tr.addEventListener('dragend', () => tr.classList.remove('dragging'));
  });
}

async function loadMovements() {
  try {
    movementsCache = await api.financeMovementsList();
    renderMovements();
  } catch (ex) { showError(ex.message || 'Error al cargar movimientos'); }
}
bindInlineEdit(document.getElementById('mvBody'), async (id, field, value) => {
  const payload = {};
  if (field === 'amount') {
    const row = movementsCache.find(m => m.id === id);
    payload.amount = row.category === 'gasto' ? -Math.abs(Number(value)) : Math.abs(Number(value));
  } else {
    payload[field] = value;
  }
  await api.financeMovementPatch(id, payload);
  await loadMovements(); loadSummary(); loadProjection(); loadCostCenters(); loadAnalytics();
});
['mvFilter'].forEach(id => document.getElementById(id).addEventListener('input', renderMovements));
['mvFilterAccount', 'mvFilterCategory'].forEach(id => document.getElementById(id).addEventListener('change', renderMovements));

// ---- drag&drop: soltar movimiento sobre centro de coste ----
function renderCcDropTargets(costCenters, movements) {
  const list = document.getElementById('ccDropList');
  const targets = costCenters.map(cc => {
    const total = movements.filter(m => m.costCenterId === cc.id).reduce((s, m) => s + m.amount, 0);
    return { id: cc.id, name: cc.name, total };
  });
  targets.push({ id: null, name: 'Sin centro', total: movements.filter(m => !m.costCenterId).reduce((s, m) => s + m.amount, 0) });
  list.innerHTML = targets.map(t => `<div class="cc-drop-target" data-cc="${t.id ?? ''}">
        <span class="name">${escapeHtml(t.name)}</span><span class="total">${money(t.total)}</span>
      </div>`).join('');
  list.querySelectorAll('.cc-drop-target').forEach(el => {
    el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drag-over'); });
    el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
    el.addEventListener('drop', async (e) => {
      e.preventDefault();
      el.classList.remove('drag-over');
      const movementId = e.dataTransfer.getData('text/plain');
      if (!movementId) return;
      const costCenterId = el.dataset.cc || null;
      try {
        await api.financeMovementPatch(movementId, { costCenterId });
        toast('Movimiento reasignado');
        await loadMovements(); loadCostCenters(); loadAnalytics();
      } catch (ex) { showError(ex.message || 'Error al reasignar'); }
    });
  });
}

// ================= CANVAS: proyeccion, barras, donut =================
function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const cssWidth = rect.width || canvas.parentElement.clientWidth || 400;
  const cssHeight = Number(canvas.getAttribute('height')) || 200;
  canvas.width = cssWidth * dpr;
  canvas.height = cssHeight * dpr;
  canvas.style.height = cssHeight + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width: cssWidth, height: cssHeight };
}

async function loadProjection() {
  try {
    const accountId = document.getElementById('projAccount').value || undefined;
    const horizonDays = Number(document.getElementById('projHorizon').value);
    const { points, currentBalance } = await api.financeProjection(accountId, horizonDays);
    drawLineChart('projectionChart', points, 'balance', '#00a878');
    const last = points[points.length - 1];
    document.getElementById('projectionSummary').textContent =
      `Saldo actual: ${money(currentBalance)} · Proyección ${horizonDays}d → ${last ? money(last.balance) : '—'}`;
  } catch (ex) { showError(ex.message || 'Error al calcular proyección'); }
}
document.getElementById('projAccount').addEventListener('change', loadProjection);
document.getElementById('projHorizon').addEventListener('change', loadProjection);

function drawLineChart(canvasId, points, valueKey, color) {
  const canvas = document.getElementById(canvasId);
  if (!points.length) return;
  const { ctx, width, height } = setupCanvas(canvas);
  const padL = 58, padR = 12, padT = 14, padB = 22;
  const plotW = width - padL - padR, plotH = height - padT - padB;
  const values = points.map(p => p[valueKey]);
  const min = Math.min(0, ...values), max = Math.max(0, ...values);
  const range = (max - min) || 1;

  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = 'rgba(20,24,32,0.08)';
  ctx.fillStyle = 'rgba(90,97,112,0.9)';
  ctx.font = '10px "IBM Plex Mono", monospace';
  ctx.textAlign = 'right';
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const y = padT + (plotH * i) / steps;
    const val = max - (range * i) / steps;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(width - padR, y); ctx.stroke();
    ctx.fillText(Math.round(val).toLocaleString('es-ES'), padL - 8, y + 3);
  }
  if (min < 0 && max > 0) {
    const zeroY = padT + plotH * (max / range);
    ctx.strokeStyle = 'rgba(216,3,0,0.35)';
    ctx.beginPath(); ctx.moveTo(padL, zeroY); ctx.lineTo(width - padR, zeroY); ctx.stroke();
  }

  const toX = (i) => padL + (plotW * i) / (points.length - 1 || 1);
  const toY = (v) => padT + plotH * (1 - (v - min) / range);
  ctx.beginPath();
  ctx.moveTo(toX(0), toY(values[0]));
  values.forEach((v, i) => ctx.lineTo(toX(i), toY(v)));
  ctx.lineTo(toX(values.length - 1), padT + plotH);
  ctx.lineTo(toX(0), padT + plotH);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
  grad.addColorStop(0, color + '33');
  grad.addColorStop(1, color + '02');
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(toX(0), toY(values[0]));
  values.forEach((v, i) => ctx.lineTo(toX(i), toY(v)));
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.textAlign = 'center';
  const labelEvery = Math.max(1, Math.floor(points.length / 6));
  points.forEach((p, i) => {
    if (i % labelEvery !== 0 && i !== points.length - 1) return;
    ctx.fillText(p.date.slice(5), toX(i), height - 4);
  });

  const tooltip = document.getElementById(canvasId.replace('Chart', 'Tooltip'));
  if (tooltip) {
    canvas.onmousemove = (e) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const idx = Math.round(((mx - padL) / plotW) * (points.length - 1));
      const p = points[Math.max(0, Math.min(points.length - 1, idx))];
      if (!p) return;
      tooltip.textContent = `${p.date}: ${money(p[valueKey])}`;
      tooltip.style.left = mx + 'px';
      tooltip.style.top = toY(p[valueKey]) + 'px';
      tooltip.classList.add('show');
    };
    canvas.onmouseleave = () => tooltip.classList.remove('show');
  }
}

async function loadAnalytics() {
  try {
    const { series, costCenterBreakdown } = await api.financeAnalytics(12);
    drawBarChart(series);
    drawDonutChart(costCenterBreakdown);
  } catch (ex) { showError(ex.message || 'Error al cargar analítica'); }
}

function drawBarChart(series) {
  const canvas = document.getElementById('monthlyChart');
  const { ctx, width, height } = setupCanvas(canvas);
  const padL = 56, padR = 10, padT = 10, padB = 20;
  const plotW = width - padL - padR, plotH = height - padT - padB;
  ctx.clearRect(0, 0, width, height);

  const maxAbs = Math.max(1, ...series.map(s => Math.max(s.income, Math.abs(s.expense))));
  ctx.strokeStyle = 'rgba(20,24,32,0.08)';
  ctx.fillStyle = 'rgba(90,97,112,0.9)';
  ctx.font = '9px "IBM Plex Mono", monospace';
  ctx.textAlign = 'right';
  for (let i = 0; i <= 2; i++) {
    const y = padT + (plotH * i) / 2;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(width - padR, y); ctx.stroke();
    ctx.fillText(Math.round(maxAbs - (maxAbs * 2 * i) / 2).toLocaleString('es-ES'), padL - 6, y + 3);
  }
  const zeroY = padT + plotH / 2;
  const groupW = plotW / series.length;
  const barW = Math.min(14, groupW * 0.3);
  const bars = [];
  series.forEach((s) => {
    const cx = padL + groupW * series.indexOf(s) + groupW / 2;
    const incH = (s.income / maxAbs) * (plotH / 2);
    const expH = (Math.abs(s.expense) / maxAbs) * (plotH / 2);
    ctx.fillStyle = '#00a878';
    ctx.fillRect(cx - barW - 2, zeroY - incH, barW, incH);
    ctx.fillStyle = '#d80300';
    ctx.fillRect(cx + 2, zeroY, barW, expH);
    bars.push({ cx, income: s.income, expense: s.expense, month: s.month });
    ctx.fillStyle = 'rgba(90,97,112,0.9)';
    ctx.textAlign = 'center';
    ctx.fillText(s.month.slice(5), cx, height - 4);
  });
  ctx.strokeStyle = 'rgba(20,24,32,0.25)';
  ctx.beginPath(); ctx.moveTo(padL, zeroY); ctx.lineTo(width - padR, zeroY); ctx.stroke();

  const tooltip = document.getElementById('monthlyTooltip');
  canvas.onmousemove = (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const bar = bars.reduce((best, b) => Math.abs(b.cx - mx) < Math.abs((best || { cx: -999 }).cx - mx) ? b : best, null);
    if (!bar || Math.abs(bar.cx - mx) > groupW / 2) { tooltip.classList.remove('show'); return; }
    tooltip.textContent = `${bar.month} · ingresos ${money(bar.income)} · gastos ${money(bar.expense)}`;
    tooltip.style.left = mx + 'px';
    tooltip.style.top = my + 'px';
    tooltip.classList.add('show');
  };
  canvas.onmouseleave = () => tooltip.classList.remove('show');
}

const DONUT_COLORS = ['#00a878', '#0098c7', '#c87a00', '#d80300', '#8a8e96', '#5a5d64', '#008a62', '#6b7280'];
function drawDonutChart(breakdown) {
  const canvas = document.getElementById('donutChart');
  const { ctx, width, height } = setupCanvas(canvas);
  ctx.clearRect(0, 0, width, height);
  const legend = document.getElementById('donutLegend');
  const total = breakdown.reduce((s, b) => s + Math.abs(b.total), 0) || 1;
  const cx = width / 2, cy = height / 2, rOuter = Math.min(width, height) / 2 - 10, rInner = rOuter * 0.6;

  if (!breakdown.length) { legend.innerHTML = '<span class="item">Sin datos en el periodo</span>'; return; }

  let angle = -Math.PI / 2;
  const slices = [];
  breakdown.forEach((b, i) => {
    const frac = Math.abs(b.total) / total;
    const sweep = frac * Math.PI * 2;
    const color = DONUT_COLORS[i % DONUT_COLORS.length];
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, rOuter, angle, angle + sweep);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    slices.push({ start: angle, end: angle + sweep, name: b.name, total: b.total, pct: frac * 100 });
    angle += sweep;
  });
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath(); ctx.arc(cx, cy, rInner, 0, Math.PI * 2); ctx.fill();
  ctx.globalCompositeOperation = 'source-over';

  legend.innerHTML = breakdown.map((b, i) => `<span class="item"><span class="swatch" style="background:${DONUT_COLORS[i % DONUT_COLORS.length]};"></span>${escapeHtml(b.name)} · ${money(b.total)}</span>`).join('');

  const tooltip = document.getElementById('donutTooltip');
  canvas.onmousemove = (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left - cx, my = e.clientY - rect.top - cy;
    const dist = Math.sqrt(mx * mx + my * my);
    if (dist < rInner || dist > rOuter) { tooltip.classList.remove('show'); return; }
    let a = Math.atan2(my, mx);
    if (a < -Math.PI / 2) a += Math.PI * 2;
    const slice = slices.find(s => a >= s.start && a <= s.end);
    if (!slice) { tooltip.classList.remove('show'); return; }
    tooltip.textContent = `${slice.name}: ${money(slice.total)} (${slice.pct.toFixed(1)}%)`;
    tooltip.style.left = (mx + cx) + 'px';
    tooltip.style.top = (my + cy) + 'px';
    tooltip.classList.add('show');
  };
  canvas.onmouseleave = () => tooltip.classList.remove('show');
}

// ================= ACTIVOS =================
let assetsCache = [];
function renderAssets() {
  const body = document.getElementById('astBody');
  const q = document.getElementById('astFilter').value.trim().toLowerCase();
  const rows = q ? assetsCache.filter(r => r.name.toLowerCase().includes(q)) : assetsCache;
  if (rows.length === 0) { body.innerHTML = '<tr class="empty-row"><td colspan="6">Sin activos que coincidan.</td></tr>'; return; }
  body.innerHTML = rows.map(r => `<tr data-id="${r.id}">
        <td class="editable" data-field="name" data-value="${escapeHtml(r.name)}">${escapeHtml(r.name)}</td>
        <td class="mono editable" data-field="acquisitionValue" data-type="number" data-value="${r.acquisitionValue}">${escapeHtml(r.acquisitionDate)} · ${money(r.acquisitionValue)}</td>
        <td class="mono editable" data-field="residualValue" data-type="number" data-value="${r.residualValue}">${money(r.residualValue)}</td>
        <td class="mono editable" data-field="usefulLifeMonths" data-type="number" data-value="${r.usefulLifeMonths}">${r.usefulLifeMonths}m</td>
        <td class="mono">${money(r.currentValue)}</td>
        <td><button class="btn ghost btn--sm ast-del">Eliminar</button></td>
      </tr>`).join('');
  body.querySelectorAll('.ast-del').forEach(btn => btn.addEventListener('click', async (e) => {
    const id = e.target.closest('tr').dataset.id;
    try { await api.financeAssetDelete(id); loadAssets(); loadSummary(); } catch (ex) { showError(ex.message); }
  }));
}
async function loadAssets() {
  try { assetsCache = await api.financeAssetsList(); renderAssets(); }
  catch (ex) { showError(ex.message || 'Error al cargar activos'); }
}
bindInlineEdit(document.getElementById('astBody'), async (id, field, value) => {
  const payload = {};
  payload[field] = field === 'usefulLifeMonths' ? Number(value) : value;
  await api.financeAssetPatch(id, payload);
  loadAssets(); loadSummary();
});
document.getElementById('astFilter').addEventListener('input', renderAssets);

// ================= EMPRESAS · CRM DOCUMENTAL =================
// Listado a la izquierda, ficha con documentacion a la derecha. La subida es
// raw (mismo patron que Herzog): el archivo viaja como body, carpeta y nombre
// en cabeceras, sin multipart.

function fileSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
function docKindLabel(contentType, filename) {
  if (contentType === 'application/pdf') return 'PDF';
  if (contentType.startsWith('image/')) return 'IMG';
  if (contentType.includes('spreadsheet') || contentType.includes('ms-excel') || contentType === 'text/csv') return 'XLS';
  if (contentType.includes('word')) return 'DOC';
  const ext = (filename || '').split('.').pop();
  return (ext && ext.length <= 4 ? ext : 'FILE').toUpperCase();
}

async function loadCrmMeta() {
  try {
    // Si el backend no responde se mantiene el catalogo por defecto ya
    // declarado arriba: los selects y el modal siguen usables.
    crmMeta = await api.financeCompaniesMeta();
  } catch (ex) {
    console.warn('[Finance CRM] meta:', ex.message);
  }
  try {
    const relSel = document.getElementById('coFilterRelation');
    const staSel = document.getElementById('coFilterStatus');
    relSel.innerHTML = '<option value="">Toda relación</option>' + crmMeta.relations.map(r => `<option value="${r}">${CRM_LABELS[r] || r}</option>`).join('');
    staSel.innerHTML = '<option value="">Todo estado</option>' + crmMeta.statuses.map(s => `<option value="${s}">${CRM_LABELS[s] || s}</option>`).join('');
  } catch (ex) { showError(ex.message || 'Error al cargar catálogo de empresas'); }
}

async function loadCrmSummary() {
  try {
    const s = await api.financeCompaniesSummary();
    document.getElementById('crmKpiCompanies').textContent = s.companiesCount;
    document.getElementById('crmKpiActive').textContent = s.activeCount;
    document.getElementById('crmKpiDocs').textContent = s.documentsCount;
    document.getElementById('crmKpiStorage').textContent = fileSize(s.storageBytes);
  } catch (ex) {
    // El KPI no bloquea la mesa, pero un fallo aqui suele significar que el
    // servidor no tiene montadas las rutas del CRM (backend sin reiniciar).
    console.warn('[Finance CRM] summary:', ex.message);
  }
}

function renderCompanies() {
  const list = document.getElementById('coList');
  const q = document.getElementById('coFilter').value.trim().toLowerCase();
  const rows = companiesCache.filter(c => !q
    || c.name.toLowerCase().includes(q)
    || (c.taxId || '').toLowerCase().includes(q)
    || (c.sector || '').toLowerCase().includes(q));
  if (rows.length === 0) {
    list.innerHTML = '<div class="crm-empty">Sin empresas. Crea la primera con “+ Nueva empresa”.</div>';
    return;
  }
  list.innerHTML = rows.map(c => `
        <div class="crm-row ${c.id === selectedCompanyId ? 'selected' : ''}" data-id="${c.id}">
          <div class="crm-row__main">
            <div class="crm-row__name">${escapeHtml(c.name)}</div>
            <div class="crm-row__meta">${CRM_LABELS[c.relation] || c.relation}${c.sector ? ` · ${escapeHtml(c.sector)}` : ''}${c.country ? ` · ${escapeHtml(c.country)}` : ''}</div>
          </div>
          <span class="crm-chip crm-chip--${c.status}">${CRM_LABELS[c.status] || c.status}</span>
          <span class="crm-row__count">${c.documentsCount} doc</span>
        </div>`).join('');
  list.querySelectorAll('.crm-row').forEach(row => row.addEventListener('click', () => selectCompany(row.dataset.id)));
}

async function loadCompanies() {
  try {
    const params = {};
    const rel = document.getElementById('coFilterRelation').value;
    const sta = document.getElementById('coFilterStatus').value;
    if (rel) params.relation = rel;
    if (sta) params.status = sta;
    companiesCache = await api.financeCompaniesList(params);
    renderCompanies();
    loadCrmSummary();
  } catch (ex) { showError(ex.message || 'Error al cargar empresas'); }
}

async function selectCompany(id) {
  selectedCompanyId = id;
  activeFolder = '';
  renderCompanies();
  const panel = document.getElementById('coDetail');
  panel.innerHTML = '<div class="crm-empty">Cargando ficha…</div>';
  try {
    selectedCompany = await api.financeCompanyGet(id);
    renderCompanyDetail();
  } catch (ex) {
    panel.innerHTML = `<div class="crm-empty">${escapeHtml(ex.message || 'Error al cargar la ficha')}</div>`;
  }
}

function renderCompanyDetail() {
  const c = selectedCompany;
  const panel = document.getElementById('coDetail');
  if (!c) { panel.innerHTML = '<div class="crm-empty crm-empty--big">Selecciona una empresa.</div>'; return; }

  const field = (label, fieldName, value, type = 'text') => `
        <div>
          <div class="crm-field__label">${label}</div>
          <div class="crm-field__val editable" data-field="${fieldName}" data-type="${type}" data-value="${escapeHtml(value ?? '')}">${escapeHtml(value || '—')}</div>
        </div>`;

  const ccName = (costCentersCache.find(cc => cc.id === c.costCenterId) || {}).name || null;
  const docs = activeFolder ? c.documents.filter(d => d.folder === activeFolder) : c.documents;

  panel.innerHTML = `
        <div class="crm-detail__head">
          <div style="flex:1;">
            <h3 class="crm-detail__title editable" data-field="name" data-type="text" data-value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</h3>
            <div class="crm-detail__sub">${c.documents.length} documento(s) · ${c.notes.length} nota(s) · alta ${new Date(c.createdAt).toLocaleDateString('es-ES')}</div>
          </div>
          <button class="btn ghost btn--sm" id="coDelete">Eliminar</button>
        </div>

        <div class="crm-fields">
          <div>
            <div class="crm-field__label">Relación</div>
            <div class="crm-field__val editable" data-field="relation" data-type="select" data-options="relations" data-value="${c.relation}">${CRM_LABELS[c.relation] || c.relation}</div>
          </div>
          <div>
            <div class="crm-field__label">Estado</div>
            <div class="crm-field__val editable" data-field="status" data-type="select" data-options="statuses" data-value="${c.status}">${CRM_LABELS[c.status] || c.status}</div>
          </div>
          ${field('CIF / NIF', 'taxId', c.taxId)}
          ${field('Sector', 'sector', c.sector)}
          ${field('País', 'country', c.country)}
          <div>
            <div class="crm-field__label">Centro de coste</div>
            <div class="crm-field__val">${escapeHtml(ccName || '—')}</div>
          </div>
          ${field('Contacto', 'contactName', c.contactName)}
          ${field('Email', 'contactEmail', c.contactEmail)}
          ${field('Teléfono', 'contactPhone', c.contactPhone)}
        </div>

        <div class="crm-section">
          <div class="crm-section__head">
            <span class="crm-section__title">Informes y documentación</span>
            <span class="spacer" style="flex:1;"></span>
            <span class="crm-row__count">máx ${crmMeta.maxUploadMb} MB por archivo</span>
          </div>
          <div class="crm-folders">
            <button class="crm-folder ${activeFolder === '' ? 'active' : ''}" data-folder="">Todo (${c.documents.length})</button>
            ${crmMeta.folders.map(f => `<button class="crm-folder ${activeFolder === f ? 'active' : ''}" data-folder="${f}">${CRM_LABELS[f] || f} (${c.documents.filter(d => d.folder === f).length})</button>`).join('')}
          </div>
          <div class="crm-drop" id="coDrop">
            Arrastra aquí un archivo o haz click para subirlo a
            <strong>${activeFolder ? (CRM_LABELS[activeFolder] || activeFolder) : 'Informes'}</strong>
            <div style="margin-top:4px; font-size:0.66rem;">PDF · Word · Excel/CSV · imágenes</div>
          </div>
          <input type="file" id="coFileInput" hidden>
          <div id="coDocs">
            ${docs.length === 0 ? '<div class="crm-empty">Sin documentos en esta carpeta.</div>' : docs.map(d => `
              <div class="crm-doc" data-id="${d.id}" data-filename="${escapeHtml(d.filename)}">
                <span class="crm-doc__icon">${docKindLabel(d.contentType, d.filename)}</span>
                <div class="crm-doc__main">
                  <div class="crm-doc__name">${escapeHtml(d.label || d.filename)}</div>
                  <div class="crm-doc__meta">${fileSize(d.size)} · ${escapeHtml(d.uploadedBy || '')} · ${d.uploadedAt ? new Date(d.uploadedAt).toLocaleDateString('es-ES') : ''}</div>
                </div>
                <div class="crm-doc__actions">
                  <select class="doc-folder">${crmMeta.folders.map(f => `<option value="${f}" ${f === d.folder ? 'selected' : ''}>${CRM_LABELS[f] || f}</option>`).join('')}</select>
                  <button class="btn ghost btn--sm doc-open">Abrir</button>
                  <button class="btn ghost btn--sm doc-dl">Bajar</button>
                  <button class="btn ghost btn--sm doc-del">×</button>
                </div>
              </div>`).join('')}
          </div>
        </div>

        <div class="crm-section">
          <div class="crm-section__head"><span class="crm-section__title">Seguimiento</span></div>
          <div style="display:flex; gap:8px; margin-bottom:10px;">
            <input class="input" id="coNoteText" placeholder="Añadir nota de seguimiento…" style="flex:1;">
            <button class="btn sage btn--sm" id="coNoteAdd">Añadir</button>
          </div>
          ${c.notes.length === 0 ? '<div class="crm-empty">Sin notas.</div>' : c.notes.map(n => `
            <div class="crm-note" data-id="${n.id}">
              <div class="crm-note__text">${escapeHtml(n.text)}</div>
              <div class="crm-note__meta">${escapeHtml(n.authorId || '')} · ${new Date(n.createdAt).toLocaleString('es-ES')}
                <button class="btn ghost btn--sm note-del" style="margin-left:8px;">Eliminar</button></div>
            </div>`).join('')}
        </div>
      `;

  bindCompanyDetailEvents();
}

function bindCompanyDetailEvents() {
  const c = selectedCompany;
  const panel = document.getElementById('coDetail');

  panel.querySelectorAll('.crm-folder').forEach(btn => btn.addEventListener('click', () => {
    activeFolder = btn.dataset.folder;
    renderCompanyDetail();
  }));

  document.getElementById('coDelete').addEventListener('click', async () => {
    if (!confirm(`Eliminar "${c.name}" y todos sus documentos y notas? Esta accion no se puede deshacer.`)) return;
    try {
      await api.financeCompanyDelete(c.id);
      toast('Empresa eliminada');
      selectedCompanyId = null; selectedCompany = null;
      document.getElementById('coDetail').innerHTML = '<div class="crm-empty crm-empty--big">Selecciona una empresa para ver su ficha, informes y documentación.</div>';
      loadCompanies();
    } catch (ex) { showError(ex.message || 'Error al eliminar empresa'); }
  });

  // Edicion inline de la ficha: click en el valor -> input/select en su sitio.
  panel.querySelectorAll('.editable').forEach(cell => cell.addEventListener('click', () => {
    if (cell.dataset.editing === '1') return;
    cell.dataset.editing = '1';
    const field = cell.dataset.field;
    const raw = cell.dataset.value || '';
    let el;
    if (cell.dataset.type === 'select') {
      el = document.createElement('select');
      const opts = crmMeta[cell.dataset.options] || [];
      el.innerHTML = opts.map(o => `<option value="${o}" ${o === raw ? 'selected' : ''}>${CRM_LABELS[o] || o}</option>`).join('');
    } else {
      el = document.createElement('input');
      el.className = 'input';
      el.value = raw;
    }
    cell.innerHTML = '';
    cell.appendChild(el);
    el.focus();

    let done = false;
    const commit = async () => {
      if (done) return;
      done = true;
      const value = el.value.trim ? el.value.trim() : el.value;
      if (value === raw) { renderCompanyDetail(); return; }
      try {
        await api.financeCompanyPatch(c.id, { [field]: value || null });
        selectedCompany = await api.financeCompanyGet(c.id);
        renderCompanyDetail();
        loadCompanies();
      } catch (ex) { showError(ex.message || 'Error al actualizar'); renderCompanyDetail(); }
    };
    el.addEventListener('blur', commit);
    el.addEventListener('change', () => { if (cell.dataset.type === 'select') commit(); });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit();
      if (e.key === 'Escape') { done = true; renderCompanyDetail(); }
    });
  }));

  // Subida: click o drag & drop sobre la zona.
  const drop = document.getElementById('coDrop');
  const fileInput = document.getElementById('coFileInput');
  drop.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) uploadDoc(fileInput.files[0]); });
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('dragover'); }));
  drop.addEventListener('drop', (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (file) uploadDoc(file);
  });

  async function uploadDoc(file) {
    showError('');
    if (file.size > crmMeta.maxUploadMb * 1024 * 1024) {
      return showError(`El archivo supera ${crmMeta.maxUploadMb} MB`);
    }
    try {
      await uploadFinanceCompanyDoc(c.id, file, activeFolder || 'informes');
      toast('Documento subido');
      selectedCompany = await api.financeCompanyGet(c.id);
      renderCompanyDetail();
      loadCompanies();
    } catch (ex) { showError(ex.message || 'Error al subir el documento'); }
    fileInput.value = '';
  }

  panel.querySelectorAll('.crm-doc').forEach(row => {
    const fileId = row.dataset.id;
    const filename = row.dataset.filename;
    row.querySelector('.doc-open').addEventListener('click', async () => {
      try { await openFinanceCompanyDoc(fileId, filename, false); } catch (ex) { showError(ex.message); }
    });
    row.querySelector('.doc-dl').addEventListener('click', async () => {
      try { await openFinanceCompanyDoc(fileId, filename, true); } catch (ex) { showError(ex.message); }
    });
    row.querySelector('.doc-del').addEventListener('click', async () => {
      if (!confirm(`Eliminar "${filename}"?`)) return;
      try {
        await api.financeCompanyDocDelete(fileId);
        selectedCompany = await api.financeCompanyGet(c.id);
        renderCompanyDetail(); loadCompanies();
      } catch (ex) { showError(ex.message); }
    });
    row.querySelector('.doc-folder').addEventListener('change', async (e) => {
      try {
        await api.financeCompanyDocPatch(fileId, { folder: e.target.value });
        selectedCompany = await api.financeCompanyGet(c.id);
        renderCompanyDetail();
      } catch (ex) { showError(ex.message); }
    });
  });

  document.getElementById('coNoteAdd').addEventListener('click', async () => {
    const input = document.getElementById('coNoteText');
    const text = input.value.trim();
    if (!text) return;
    try {
      await api.financeCompanyNoteAdd(c.id, text);
      selectedCompany = await api.financeCompanyGet(c.id);
      renderCompanyDetail(); loadCompanies();
    } catch (ex) { showError(ex.message || 'Error al añadir la nota'); }
  });
  document.getElementById('coNoteText').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('coNoteAdd').click();
  });

  panel.querySelectorAll('.note-del').forEach(btn => btn.addEventListener('click', async (e) => {
    const noteId = e.target.closest('.crm-note').dataset.id;
    try {
      await api.financeCompanyNoteDelete(noteId);
      selectedCompany = await api.financeCompanyGet(c.id);
      renderCompanyDetail(); loadCompanies();
    } catch (ex) { showError(ex.message); }
  }));
}

document.getElementById('coFilter').addEventListener('input', renderCompanies);
document.getElementById('coFilterRelation').addEventListener('change', loadCompanies);
document.getElementById('coFilterStatus').addEventListener('change', loadCompanies);

// ================= INFORMES =================
let selectedReport = 'tesoreria';
document.querySelectorAll('.report-card').forEach(card => {
  card.addEventListener('click', () => {
    document.querySelectorAll('.report-card').forEach(c => c.classList.remove('selected'));
    card.classList.add('selected');
    selectedReport = card.dataset.report;
  });
});

const REPORT_LABELS = { tesoreria: 'Tesorería', activos: 'Activos', analitica: 'Analítico' };
async function loadExports() {
  const body = document.getElementById('expBody');
  try {
    const rows = await api.financeExportsList();
    if (rows.length === 0) { body.innerHTML = '<tr class="empty-row"><td colspan="5">Sin informes generados.</td></tr>'; return; }
    body.innerHTML = rows.map(r => `<tr data-id="${r.id}" data-type="${r.reportType}">
          <td>${REPORT_LABELS[r.reportType] || r.reportType}</td>
          <td class="mono">${escapeHtml(r.fromDate)} → ${escapeHtml(r.toDate)}</td>
          <td class="mono" style="font-size:0.7rem;">${r.contentHash.slice(0, 16)}…</td>
          <td>${r.expired ? '<span style="color:#d80300;">expirado</span>' : `expira ${new Date(r.expiresAt).toLocaleString('es-ES')}`}</td>
          <td><button class="btn sage btn--sm exp-dl" ${r.expired ? 'disabled' : ''}>Descargar</button></td>
        </tr>`).join('');
    body.querySelectorAll('.exp-dl').forEach(btn => btn.addEventListener('click', async (e) => {
      const tr = e.target.closest('tr');
      try { await downloadFinanceExport(tr.dataset.id, tr.dataset.type); } catch (ex) { showError(ex.message); }
    }));
  } catch (ex) { showError(ex.message || 'Error al cargar informes'); }
}
document.getElementById('expAddBtn').addEventListener('click', async () => {
  showError('');
  const fromDate = document.getElementById('expFrom').value;
  const toDate = document.getElementById('expTo').value;
  if (!fromDate || !toDate) return showError('Indica el rango de fechas');
  try {
    await api.financeExportCreate(fromDate, toDate, selectedReport);
    toast('Informe generado');
    loadExports();
  } catch (ex) { showError(ex.message || 'Error al generar informe'); }
});

window.addEventListener('resize', () => { loadProjection(); loadAnalytics(); });

// ================= INIT =================
loadSummary();
loadAccounts().then(() => {
  loadCostCenters().then(loadMovements);
  loadProjection();
  loadTransfers();
  loadAnalytics();
});
loadAssets();
loadExports();
loadCrmMeta().then(loadCompanies);
