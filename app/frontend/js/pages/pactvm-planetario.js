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

function fmt(n, decimals = 0) {
  return Number(n || 0).toLocaleString('es-ES', { maximumFractionDigits: decimals });
}
function fmtEur(n) {
  return `${fmt(n)} €`;
}

// ---- Config global ----
let latestConfig = null;
async function loadConfig() {
  try {
    const c = await api.pactvmPlanetaryConfig();
    latestConfig = c;
    document.getElementById('cfgNodesMax').value = c.nodesMax ?? '';
    document.getElementById('cfgNodesActive').value = c.nodesActive ?? '';
    document.getElementById('cfgTicket').value = c.unitTicketEur ?? '';
    document.getElementById('cfgCapacity').value = c.nodeAnnualCapacityTYear ?? '';
    document.getElementById('cfgCarbonPrice').value = c.carbonCreditPriceUsd ?? '';
    document.getElementById('cfgSource').value = c.source ?? '';
  } catch (ex) { showError(ex.message || 'Error al cargar configuración'); }
}
document.getElementById('cfgSaveBtn').addEventListener('click', async () => {
  showError('');
  try {
    await api.pactvmPlanetaryConfigPatch({
      nodesMax: Number(document.getElementById('cfgNodesMax').value),
      nodesActive: Number(document.getElementById('cfgNodesActive').value),
      unitTicketEur: Number(document.getElementById('cfgTicket').value),
      nodeAnnualCapacityTYear: Number(document.getElementById('cfgCapacity').value),
      carbonCreditPriceUsd: Number(document.getElementById('cfgCarbonPrice').value),
      source: document.getElementById('cfgSource').value.trim(),
    });
    toast('Parámetros actualizados');
    loadSummary(); loadConfig();
  } catch (ex) { showError(ex.message || 'Error al guardar configuración'); }
});

// ---- Summary KPIs ----
async function loadSummary() {
  try {
    const s = await api.pactvmPlanetarySummary();
    document.getElementById('kpiNodesMax').textContent = fmt(s.nodesMax);
    document.getElementById('kpiNodesActiveSub').textContent = `Activos: ${fmt(s.nodesActive)} / ${fmt(s.nodesMax)} (${fmt(s.deployPct, 1)}%)`;
    document.getElementById('kpiInfraValue').textContent = fmtEur(s.totalInfraValueEur);
    document.getElementById('kpiTicketSub').textContent = `Ticket: ${fmtEur(s.unitTicketEur)}/unidad`;
    document.getElementById('kpiProcessing').textContent = `${fmt(s.globalProcessingTYear)} T/año`;
    document.getElementById('kpiCapacitySub').textContent = `${fmt(s.countriesTracked)} países trackeados · ${fmt(s.nodesTargetSum)} nodos objetivo`;
  } catch (ex) { showError(ex.message || 'Error al cargar resumen'); }
}

// ---- Mapa mundial (mismo patron que pactvm-nodos.html) ----
const ISO_NUMERIC_TO_A2 = { '724': 'ES', '620': 'PT', '250': 'FR', '504': 'MA', '484': 'MX', '276': 'DE' };
const UNTRACKED_FILL = '#1a2432';
const UNTRACKED_STROKE = '#2c3a4d';
const TRACKED_STROKE = '#0d1520';

function intensityColor(pct) {
  if (pct <= 0) return UNTRACKED_FILL;
  if (pct < 25) return '#2ecc8f';
  if (pct < 50) return '#f2c94c';
  if (pct < 75) return '#f2994a';
  return '#eb5757';
}

let pcRowsCache = [];
let mapPaths = null;

async function renderWorldMap() {
  const svg = document.getElementById('worldMap');
  if (mapPaths) return;
  try {
    const topology = await fetch('/vendor/countries-110m.json').then(r => r.json());
    const geo = topojson.feature(topology, topology.objects.countries);
    const proj = equirectangular(960, 500);
    mapPaths = {};
    const frag = document.createDocumentFragment();
    geo.features.forEach(f => {
      const d = pathFromGeometry(f.geometry, proj);
      if (!d) return;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      path.setAttribute('fill', UNTRACKED_FILL);
      path.setAttribute('stroke', UNTRACKED_STROKE);
      path.setAttribute('stroke-width', '0.6');
      path.style.transition = 'fill 0.12s, stroke 0.12s';
      const a2 = ISO_NUMERIC_TO_A2[String(f.id)];
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = a2 ? (f.properties?.name || a2) : (f.properties?.name || '');
      path.appendChild(title);
      if (a2) {
        path.dataset.code = a2;
        mapPaths[a2] = path;
        path.style.cursor = 'pointer';
        path.addEventListener('mouseenter', () => { path.setAttribute('stroke', '#e8edf5'); path.setAttribute('stroke-width', '1.6'); selectCountry(a2); });
        path.addEventListener('mouseleave', () => { path.setAttribute('stroke', TRACKED_STROKE); path.setAttribute('stroke-width', '1'); });
        path.addEventListener('click', () => selectCountry(a2));
      }
      frag.appendChild(path);
    });
    svg.appendChild(frag);
    paintMap();
  } catch (ex) { showError('No se pudo cargar el mapa (vendor/countries-110m.json)'); }
}

function equirectangular(w, h) {
  return ([lon, lat]) => [ (lon + 180) * (w / 360), (90 - lat) * (h / 180) ];
}
function pathFromGeometry(geom, proj) {
  if (!geom) return null;
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : null;
  if (!polys) return null;
  let d = '';
  polys.forEach(poly => {
    poly.forEach(ring => {
      ring.forEach(([lon, lat], i) => {
        const [x, y] = proj([lon, lat]);
        d += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1) + ' ';
      });
      d += 'Z ';
    });
  });
  return d.trim();
}

function maxTargetTYear() {
  return pcRowsCache.reduce((max, r) => Math.max(max, r.wasteEstTYear || 0), 1);
}

function paintMap() {
  if (!mapPaths) return;
  const max = maxTargetTYear();
  Object.entries(mapPaths).forEach(([a2, path]) => {
    const row = pcRowsCache.find(r => r.code === a2);
    const pct = row ? (row.wasteEstTYear / max) * 100 : 0;
    path.setAttribute('fill', row ? intensityColor(pct) : UNTRACKED_FILL);
    path.setAttribute('stroke', row ? TRACKED_STROKE : UNTRACKED_STROKE);
    path.setAttribute('stroke-width', row ? '1' : '0.6');
    const title = path.querySelector('title');
    if (title && row) title.textContent = `${row.label} — ${fmt(row.wasteEstTYear)} T/año objetivo`;
  });
}

function selectCountry(a2) {
  const row = pcRowsCache.find(r => r.code === a2);
  const box = document.getElementById('mapSelected');
  if (!row) { box.textContent = `${a2}: sin datos registrados.`; return; }
  box.innerHTML = `<b>${escapeHtml(row.label)}</b> (${row.code})<br>` +
    `objetivo: ${fmt(row.wasteEstTYear)} T/año<br>` +
    `nodos objetivo: <b>${fmt(row.nodesTarget)}</b><br>` +
    `fuente: ${escapeHtml(row.source || '—')}`;
}

function renderCountryBars() {
  const el = document.getElementById('countryBars');
  if (pcRowsCache.length === 0) { el.innerHTML = '<p class="mono" style="font-size:0.76rem; color:var(--text-muted);">Sin países registrados.</p>'; return; }
  const max = maxTargetTYear();
  el.innerHTML = pcRowsCache.map(r => {
    const pct = Math.max(4, Math.min(100, (r.wasteEstTYear / max) * 100));
    return `<div class="country-bar-row">
          <div class="country-bar-name">${escapeHtml(r.label)}</div>
          <div class="country-bar-track"><div class="country-bar-fill" style="width:${pct}%;"></div></div>
          <div class="country-bar-meta">${fmt(r.wasteEstTYear)} T/año<br>${fmt(r.nodesTarget)} nodos</div>
        </div>`;
  }).join('');
}

async function loadCountries() {
  const body = document.getElementById('pcBody');
  try {
    const rows = await api.pactvmPlanetaryCountriesList();
    pcRowsCache = rows;
    paintMap();
    renderCountryBars();
    if (rows.length === 0) { body.innerHTML = '<tr class="empty-row"><td colspan="5">Sin países registrados.</td></tr>'; return; }
    body.innerHTML = rows.map(r => `<tr data-id="${r.id}" data-code="${r.code}">
          <td>${escapeHtml(r.label)} <span class="mono" style="color:var(--text-muted);">(${r.code})</span></td>
          <td class="mono"><input class="input pc-waste" style="width:150px;" value="${r.wasteEstTYear}"></td>
          <td class="mono" style="font-weight:700;">${fmt(r.nodesTarget)}</td>
          <td style="font-size:0.78rem; max-width:260px;">${escapeHtml(r.source || '')}</td>
          <td><button class="btn ghost btn--sm pc-del">Eliminar</button></td>
        </tr>`).join('');
    body.querySelectorAll('tr[data-id]').forEach(tr => {
      const id = tr.dataset.id;
      tr.addEventListener('click', (e) => { if (!e.target.closest('button,input')) selectCountry(tr.dataset.code); });
      tr.querySelector('.pc-waste').addEventListener('change', async (e) => {
        try { await api.pactvmPlanetaryCountryPatch(id, { wasteEstTYear: Number(e.target.value) }); loadCountries(); loadSummary(); } catch (ex) { showError(ex.message); }
      });
      tr.querySelector('.pc-del').addEventListener('click', async () => {
        try { await api.pactvmPlanetaryCountryDelete(id); loadCountries(); loadSummary(); } catch (ex) { showError(ex.message); }
      });
    });
  } catch (ex) { showError(ex.message || 'Error al cargar países'); }
}
document.getElementById('pcAddBtn').addEventListener('click', async () => {
  showError('');
  const code = document.getElementById('pcCode').value.trim().toUpperCase();
  const label = document.getElementById('pcLabel').value.trim();
  const wasteEstTYear = Number(document.getElementById('pcWaste').value.trim());
  if (!/^[A-Z]{2}$/.test(code)) return showError('Código ISO-2 inválido');
  if (!label) return showError('Indica el país');
  if (!Number.isFinite(wasteEstTYear) || wasteEstTYear < 0) return showError('Objetivo T/año inválido');
  try {
    await api.pactvmPlanetaryCountryAdd({ code, label, wasteEstTYear, source: document.getElementById('pcSource').value.trim() || null });
    document.getElementById('pcCode').value = '';
    document.getElementById('pcLabel').value = '';
    document.getElementById('pcWaste').value = '';
    document.getElementById('pcSource').value = '';
    loadCountries(); loadSummary();
  } catch (ex) { showError(ex.message || 'Error al crear país'); }
});

// ---- Telemetria CUDA-Bio (simulada, refresco periodico) ----
async function loadTelemetry() {
  try {
    const t = await api.pactvmPlanetaryTelemetry();
    document.getElementById('cudaOccupancy').textContent = fmt(t.bioCoreOccupancyPct, 1);
    document.getElementById('cudaBandwidth').textContent = fmt(t.massTransferBandwidthTMin, 1);
    document.getElementById('cudaMethane').textContent = fmt(t.thermalMethaneYieldPct, 1);
    document.getElementById('cudaMinting').textContent = fmt(t.carbonCreditMintingRateTokensSec, 1);
    document.getElementById('cudaPrice').textContent = fmt(t.carbonCreditPriceUsd, 2);
    document.getElementById('cudaCompute').textContent = fmt(t.bioComputeBandwidthTbEquivalent, 2);
    document.getElementById('cudaNote').textContent = t.note || '';
  } catch (ex) { showError(ex.message || 'Error al cargar telemetría'); }
}

// ---- Init ----
loadConfig();
loadSummary();
renderWorldMap();
loadCountries();
loadTelemetry();
setInterval(loadTelemetry, 5000);
