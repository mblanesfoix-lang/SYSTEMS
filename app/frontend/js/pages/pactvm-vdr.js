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

let countriesCache = [];

async function loadCountries() {
  try {
    countriesCache = await api.pactvmVdrCountriesList();
    const sel = document.getElementById('vdrCountry');
    sel.innerHTML = countriesCache.map(c => `<option value="${c.code}">${escapeHtml(c.label)} (${c.code})</option>`).join('');
  } catch (ex) { showError(ex.message || 'Error al cargar países'); }
}

function countryLabel(code) {
  const c = countriesCache.find(c => c.code === code);
  return c ? `${c.label} (${c.code})` : code;
}

async function loadSummary() {
  try {
    const s = await api.pactvmVdrSummary();
    document.getElementById('kpiCompaniesTotalVal').textContent = s.companiesTotal ?? 0;
    document.getElementById('kpiCountriesTrackedVal').textContent = s.countriesTracked ?? 0;
    document.getElementById('kpiSpainActivityVal').textContent = s.spainActivityTotal ?? 0;
  } catch (ex) { showError(ex.message || 'Error al cargar resumen'); }
}

// ---- Modelo de despliegue (es-config): un juego de cifras POR PAIS,
// ver pactum-viridi.js DEFAULT_VDR_ES_CONFIG. No todos los paises
// necesitan el mismo numero de nodos (antes un unico doc compartido). ----
let esConfigRows = [];
let editingCountry = null;
const fmtEurPlain = (n) => Number(n || 0).toLocaleString('es-ES', { maximumFractionDigits: 0 });

async function loadEsConfig() {
  const body = document.getElementById('esConfigBody');
  try {
    esConfigRows = await api.pactvmVdrEsConfigAll();
    body.innerHTML = esConfigRows.map(c => `<tr data-country="${c.id}">
          <td>${escapeHtml(countryLabel(c.id))}</td>
          <td class="mono">${c.nodesTargetTotal}</td>
          <td class="mono">${c.nodeAnnualEnergyGwh}</td>
          <td class="mono">${c.biopelletTonsPerNodeYear}</td>
          <td class="mono">${fmtEurPlain(c.biopelletPriceEurPerTon)} €</td>
          <td class="mono">${c.co2ch4AvoidedTonsPerNodeYear}</td>
          <td class="mono">${fmtEurPlain(c.annualLossEur)} €</td>
          <td><button class="btn ghost btn--sm es-edit" data-country="${c.id}">Editar</button></td>
        </tr>`).join('');
    body.querySelectorAll('.es-edit').forEach(btn => {
      btn.addEventListener('click', () => openEsConfigForm(btn.dataset.country));
    });
  } catch (ex) { showError(ex.message || 'Error al cargar el modelo de despliegue'); }
}

function openEsConfigForm(country) {
  const row = esConfigRows.find(c => c.id === country);
  if (!row) return;
  editingCountry = country;
  document.getElementById('ecCountryLabel').textContent = countryLabel(country);
  document.getElementById('ecNodes').value = row.nodesTargetTotal ?? '';
  document.getElementById('ecGwMin').value = row.curtailmentGwTargetMin ?? '';
  document.getElementById('ecGwMax').value = row.curtailmentGwTargetMax ?? '';
  document.getElementById('ecGwh').value = row.nodeAnnualEnergyGwh ?? '';
  document.getElementById('ecPellet').value = row.biopelletTonsPerNodeYear ?? '';
  document.getElementById('ecPrice').value = row.biopelletPriceEurPerTon ?? '';
  document.getElementById('ecCo2').value = row.co2ch4AvoidedTonsPerNodeYear ?? '';
  document.getElementById('ecLoss').value = row.annualLossEur ?? '';
  document.getElementById('ecPpa').value = row.ppaClause ?? '';
  document.getElementById('esConfigForm').hidden = false;
}

document.getElementById('esConfigCancel').addEventListener('click', () => {
  editingCountry = null;
  document.getElementById('esConfigForm').hidden = true;
});

document.getElementById('esConfigSave').addEventListener('click', async () => {
  showError('');
  if (!editingCountry) return;
  const nums = {
    nodesTargetTotal: document.getElementById('ecNodes').value.trim(),
    curtailmentGwTargetMin: document.getElementById('ecGwMin').value.trim(),
    curtailmentGwTargetMax: document.getElementById('ecGwMax').value.trim(),
    nodeAnnualEnergyGwh: document.getElementById('ecGwh').value.trim(),
    biopelletTonsPerNodeYear: document.getElementById('ecPellet').value.trim(),
    biopelletPriceEurPerTon: document.getElementById('ecPrice').value.trim(),
    co2ch4AvoidedTonsPerNodeYear: document.getElementById('ecCo2').value.trim(),
    annualLossEur: document.getElementById('ecLoss').value.trim(),
  };
  const payload = {};
  for (const [key, raw] of Object.entries(nums)) {
    if (raw === '') continue;
    const v = Number(raw);
    if (!Number.isFinite(v) || v < 0) return showError(`Valor inválido en "${key}"`);
    if (key === 'nodesTargetTotal' && !Number.isInteger(v)) return showError('Nodos totales debe ser un número entero');
    payload[key] = v;
  }
  const ppa = document.getElementById('ecPpa').value.trim();
  if (ppa) payload.ppaClause = ppa;
  try {
    await api.pactvmVdrEsConfigPatch(editingCountry, payload);
    toast(`Modelo de despliegue de ${countryLabel(editingCountry)} actualizado`);
    editingCountry = null;
    document.getElementById('esConfigForm').hidden = true;
    await loadEsConfig();
  } catch (ex) { showError(ex.message || 'Error al guardar el modelo de despliegue'); }
});

async function loadCompanies() {
  const body = document.getElementById('vdrBody');
  try {
    const rows = await api.pactvmVdrCompaniesList();
    if (rows.length === 0) { body.innerHTML = '<tr class="empty-row"><td colspan="6">Sin empresas registradas.</td></tr>'; return; }
    body.innerHTML = rows.map(r => `<tr class="company-row" data-id="${r.id}">
          <td>${escapeHtml(r.name)}</td>
          <td>${escapeHtml(countryLabel(r.geoCountry))}</td>
          <td>${escapeHtml(r.geoCity || '—')}</td>
          <td class="mono">${r.geoWeight}</td>
          <td class="mono">${r.spainActivity}</td>
          <td><button class="btn ghost btn--sm vdr-del">Eliminar</button></td>
        </tr>`).join('');
    body.querySelectorAll('tr[data-id]').forEach(tr => {
      const id = tr.dataset.id;
      tr.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        location.href = `/pages/pactvm-vdr-globe.html?id=${id}`;
      });
      tr.querySelector('.vdr-del').addEventListener('click', async (e) => {
        e.stopPropagation();
        try { await api.pactvmVdrCompanyDelete(id); loadCompanies(); loadSummary(); } catch (ex) { showError(ex.message); }
      });
    });
  } catch (ex) { showError(ex.message || 'Error al cargar empresas'); }
}

document.getElementById('vdrAddBtn').addEventListener('click', async () => {
  showError('');
  const name = document.getElementById('vdrName').value.trim();
  const geoCountry = document.getElementById('vdrCountry').value;
  const geoCity = document.getElementById('vdrCity').value.trim();
  const geoWeight = Number(document.getElementById('vdrGeoWeight').value.trim());
  const spainActivity = Number(document.getElementById('vdrSpainActivity').value.trim());
  if (!name) return showError('Indica el nombre de la empresa');
  if (!geoCountry) return showError('Selecciona ubicación geográfica');
  if (!Number.isFinite(geoWeight) || geoWeight < 0) return showError('Ubicación geográfica (num) inválido');
  if (!Number.isFinite(spainActivity) || spainActivity < 0) return showError('Actividad en España (num) inválido');
  try {
    await api.pactvmVdrCompanyAdd({ name, geoCountry, geoCity, geoWeight, spainActivity });
    document.getElementById('vdrName').value = '';
    document.getElementById('vdrCity').value = '';
    document.getElementById('vdrGeoWeight').value = '';
    document.getElementById('vdrSpainActivity').value = '';
    loadCompanies(); loadSummary();
  } catch (ex) { showError(ex.message || 'Error al crear empresa'); }
});

// ---- Init ----
(async () => {
  await loadCountries();
  loadSummary();
  loadCompanies();
  loadEsConfig();
})();
