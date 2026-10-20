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

// ---- Resumen KPI ----
async function loadSummary() {
  try {
    const s = await api.resilienceSummary();
    document.getElementById('kpiAutonomy').textContent = s.autonomyHours != null ? `${s.autonomyHours} h` : '—';
    document.getElementById('kpiAutonomy').className = 'kpi-val ' + (s.autonomyHours != null && s.autonomyHours < 48 ? 'bad' : 'ok');
    document.getElementById('kpiSoc').textContent = s.socPct != null ? `${s.socPct}%` : '—';
    document.getElementById('kpiSoc').className = 'kpi-val ' + (s.socPct != null && s.socPct < 20 ? 'bad' : s.socPct != null && s.socPct < 40 ? 'warn' : 'ok');
    document.getElementById('kpiNoRedundancy').textContent = s.componentsWithoutRedundancy ?? 0;
    document.getElementById('kpiNoRedundancy').className = 'kpi-val ' + (s.componentsWithoutRedundancy > 0 ? 'warn' : 'ok');
    const backupEl = document.getElementById('kpiBackup');
    backupEl.textContent = s.backupStatus === 'ok' ? 'OK' : s.backupStatus === 'degradado' ? 'Degradado' : 'Crítico';
    backupEl.className = 'kpi-val ' + (s.backupStatus === 'ok' ? 'ok' : s.backupStatus === 'degradado' ? 'warn' : 'bad');
  } catch (ex) { showError(ex.message || 'Error al cargar resumen'); }
}

// ---- Bloque 1: lecturas BSS ----
async function loadBssReadings() {
  const body = document.getElementById('brBody');
  try {
    const rows = await api.resilienceBssReadingsList();
    if (rows.length === 0) { body.innerHTML = '<tr class="empty-row"><td colspan="5">Sin lecturas registradas.</td></tr>'; return; }
    body.innerHTML = rows.map(r => `<tr>
          <td class="mono" style="font-size:0.76rem;">${new Date(r.createdAt).toLocaleString('es-ES')}</td>
          <td class="mono">${r.autonomyHours}</td>
          <td class="mono">${r.socPct}</td>
          <td class="mono">${r.icoPct}</td>
          <td style="font-size:0.78rem;">${escapeHtml(r.source || '')}</td>
        </tr>`).join('');
  } catch (ex) { showError(ex.message || 'Error al cargar lecturas BSS'); }
}
document.getElementById('brAddBtn').addEventListener('click', async () => {
  showError('');
  const autonomyHours = Number(document.getElementById('brAutonomy').value.trim());
  const socPct = Number(document.getElementById('brSoc').value.trim());
  const icoPct = Number(document.getElementById('brIco').value.trim());
  if (!Number.isFinite(autonomyHours) || autonomyHours < 0) return showError('Autonomía inválida');
  if (!Number.isFinite(socPct) || socPct < 0 || socPct > 100) return showError('SoC inválido (0-100)');
  if (!Number.isFinite(icoPct) || icoPct < 0 || icoPct > 100) return showError('ICO inválido (0-100)');
  try {
    await api.resilienceBssReadingAdd({ autonomyHours, socPct, icoPct, source: document.getElementById('brSource').value.trim() || null });
    ['brAutonomy','brSoc','brIco','brSource'].forEach(id => document.getElementById(id).value = '');
    loadBssReadings(); loadSummary();
  } catch (ex) { showError(ex.message || 'Error al registrar lectura'); }
});

// ---- Bloque 1: MODO AISLADO ----
async function loadIsolatedMode() {
  try {
    const s = await api.resilienceIsolatedMode();
    const dot = document.getElementById('isoDot');
    const label = document.getElementById('isoLabel');
    const activateBtn = document.getElementById('isoActivateBtn');
    const deactivateBtn = document.getElementById('isoDeactivateBtn');
    if (s.active) {
      dot.style.background = '#eb5757';
      label.textContent = `MODO AISLADO ACTIVO (simulacro) — desde ${new Date(s.activatedAt).toLocaleString('es-ES')}`;
      activateBtn.style.display = 'none';
      deactivateBtn.style.display = 'inline-block';
    } else {
      dot.style.background = '#2ecc8f';
      label.textContent = 'Comunicaciones normales';
      activateBtn.style.display = 'inline-block';
      deactivateBtn.style.display = 'none';
    }
  } catch (ex) { showError(ex.message || 'Error al leer modo aislado'); }
}
document.getElementById('isoActivateBtn').addEventListener('click', async () => {
  if (!confirm('¿Activar MODO AISLADO? Esto es un simulacro: quedará registrado y se avisará a Elvi-Ra. No conmuta ninguna conexión real todavía.')) return;
  const reason = prompt('Motivo (opcional):') || '';
  try {
    await api.resilienceIsolatedModeActivate({ reason });
    toast('Modo aislado activado (simulacro)');
    loadIsolatedMode();
  } catch (ex) { showError(ex.message || 'Error al activar modo aislado'); }
});
document.getElementById('isoDeactivateBtn').addEventListener('click', async () => {
  try {
    await api.resilienceIsolatedModeDeactivate();
    toast('Modo aislado desactivado');
    loadIsolatedMode();
  } catch (ex) { showError(ex.message || 'Error al desactivar modo aislado'); }
});

// ---- Bloque 2: mapa mundial de proveedores ----
const ISO_NUMERIC_TO_A2 = { '724': 'ES', '620': 'PT', '250': 'FR', '504': 'MA' };
const REGION_COLORS = { 'UE': '#3a7bd5', 'Asia': '#f2994a', 'América': '#2ecc8f', 'África': '#c9a84c' };
const UNTRACKED_FILL = '#1a2432';
const UNTRACKED_STROKE = '#2c3a4d';
const TRACKED_STROKE = '#0d1520';

let spRowsCache = [];
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
      title.textContent = f.properties?.name || a2 || '';
      path.appendChild(title);
      if (a2) {
        path.dataset.code = a2;
        mapPaths[a2] = path;
        path.style.cursor = 'pointer';
        path.addEventListener('mouseenter', () => { path.setAttribute('stroke', '#e8edf5'); path.setAttribute('stroke-width', '1.6'); selectCountry(a2); });
        path.addEventListener('mouseleave', () => { path.setAttribute('stroke', TRACKED_STROKE); path.setAttribute('stroke-width', '1'); });
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

// Aproximacion pais -> region para pintar el mapa (mismo mapeo ES/PT/FR/MA que Pactvm Nodos)
const COUNTRY_REGION = { ES: 'UE', PT: 'UE', FR: 'UE', MA: 'África' };
function paintMap() {
  if (!mapPaths) return;
  Object.entries(mapPaths).forEach(([a2, path]) => {
    const region = COUNTRY_REGION[a2];
    const hasSupplier = region && spRowsCache.some(s => s.region === region);
    path.setAttribute('fill', hasSupplier ? (REGION_COLORS[region] || UNTRACKED_FILL) : UNTRACKED_FILL);
    path.setAttribute('stroke', hasSupplier ? TRACKED_STROKE : UNTRACKED_STROKE);
  });
}
function selectCountry(a2) {
  const region = COUNTRY_REGION[a2];
  const box = document.getElementById('mapSelected');
  if (!region) { box.textContent = `${a2}: región no mapeada.`; return; }
  const suppliers = spRowsCache.filter(s => s.region === region);
  if (suppliers.length === 0) { box.textContent = `${a2} (${region}): sin proveedores registrados.`; return; }
  box.innerHTML = `<b>${a2}</b> — región ${region}<br>` + suppliers.map(s => `${escapeHtml(s.component)}: ${escapeHtml(s.supplierName)} ${s.isPrimary ? '(primario)' : '(alterno)'}`).join('<br>');
}
function renderLegend() {
  const el = document.getElementById('mapLegend');
  el.innerHTML = Object.entries(REGION_COLORS).map(([label, color]) => `<span style="display:flex; align-items:center; gap:10px;">
        <span style="width:18px; height:18px; border-radius:4px; background:${color}; border:1px solid rgba(255,255,255,0.15); flex-shrink:0;"></span>${label}
      </span>`).join('') + `<span style="display:flex; align-items:center; gap:10px;">
        <span style="width:18px; height:18px; border-radius:4px; background:${UNTRACKED_FILL}; border:1px solid rgba(255,255,255,0.15); flex-shrink:0;"></span>sin proveedor
      </span>`;
}

// ---- Bloque 2: CRM proveedores ----
async function loadSuppliers() {
  const body = document.getElementById('spBody');
  try {
    const rows = await api.resilienceSuppliersList();
    spRowsCache = rows;
    paintMap();
    if (rows.length === 0) { body.innerHTML = '<tr class="empty-row"><td colspan="8">Sin proveedores registrados.</td></tr>'; return; }
    body.innerHTML = rows.map(r => `<tr data-id="${r.id}">
          <td>${escapeHtml(r.component)}</td>
          <td>${escapeHtml(r.supplierName)}</td>
          <td class="mono">${escapeHtml(r.region)}</td>
          <td class="mono">${r.leadTimeDays} d</td>
          <td>${r.isPrimary ? '<span class="status-pill">Primario</span>' : '<span class="status-pill">Alterno</span>'}</td>
          <td>${r.status}</td>
          <td style="font-size:0.76rem; max-width:200px;">${escapeHtml(r.source || '')}</td>
          <td><button class="btn ghost btn--sm sp-del">Eliminar</button></td>
        </tr>`).join('');
    body.querySelectorAll('tr[data-id]').forEach(tr => {
      const id = tr.dataset.id;
      tr.querySelector('.sp-del').addEventListener('click', async () => {
        try { await api.resilienceSupplierDelete(id); loadSuppliers(); loadSummary(); } catch (ex) { showError(ex.message); }
      });
    });
  } catch (ex) { showError(ex.message || 'Error al cargar proveedores'); }
}
document.getElementById('spAddBtn').addEventListener('click', async () => {
  showError('');
  const component = document.getElementById('spComponent').value.trim();
  const supplierName = document.getElementById('spName').value.trim();
  const region = document.getElementById('spRegion').value.trim();
  const leadTimeDays = Number(document.getElementById('spLeadTime').value.trim());
  if (!component) return showError('Indica el componente');
  if (!supplierName) return showError('Indica el proveedor');
  if (!region) return showError('Indica la región');
  if (!Number.isFinite(leadTimeDays) || leadTimeDays < 0) return showError('Lead time inválido');
  try {
    await api.resilienceSupplierAdd({
      component, supplierName, region, leadTimeDays,
      isPrimary: document.getElementById('spPrimary').checked,
      source: document.getElementById('spSource').value.trim() || null,
    });
    ['spComponent','spName','spRegion','spLeadTime','spSource'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('spPrimary').checked = false;
    loadSuppliers(); loadSummary();
  } catch (ex) { showError(ex.message || 'Error al crear proveedor'); }
});
document.getElementById('recalcBtn').addEventListener('click', async () => {
  showError('');
  const blockedRegions = document.getElementById('recalcRegions').value.split(',').map(s => s.trim()).filter(Boolean);
  if (blockedRegions.length === 0) return showError('Indica al menos una región bloqueada');
  if (!confirm(`¿Recalcular cadena de suministro bloqueando: ${blockedRegions.join(', ')}?`)) return;
  try {
    const result = await api.resilienceSuppliersRecalculate({ blockedRegions });
    const resultBox = document.getElementById('recalcResult');
    resultBox.style.display = 'block';
    resultBox.innerHTML = result.snapshot.changes.length === 0
      ? 'Ningún componente afectado por esas regiones.'
      : result.snapshot.changes.map(c => `${escapeHtml(c.component)}: ${escapeHtml(c.previousSupplierName)} (${c.previousRegion}) → ${c.resolved ? escapeHtml(c.replacementSupplierName) + ' (' + c.replacementRegion + ')' : '<b>sin alterno disponible</b>'}`).join('<br>');
    loadSuppliers(); loadSummary();
  } catch (ex) { showError(ex.message || 'Error al recalcular cadena'); }
});

// ---- Bloque 3: backup soberanía ----
async function loadBackupStatus() {
  try {
    const s = await api.resilienceBackupStatus();
    document.getElementById('bsDestination').value = s.destination || '';
    document.getElementById('bsRpo').value = s.rpoMinutes ?? '';
    document.getElementById('bsRto').value = s.rtoMinutes ?? '';
    document.getElementById('bsVolume').value = s.dataVolumeGb ?? '';
    document.getElementById('bsStatus').value = s.status || 'critico';
  } catch (ex) { showError(ex.message || 'Error al cargar estado de backup'); }
}
document.getElementById('bsSaveBtn').addEventListener('click', async () => {
  showError('');
  try {
    await api.resilienceBackupStatusPatch({
      destination: document.getElementById('bsDestination').value.trim(),
      rpoMinutes: document.getElementById('bsRpo').value.trim() || null,
      rtoMinutes: document.getElementById('bsRto').value.trim() || null,
      dataVolumeGb: document.getElementById('bsVolume').value.trim() || null,
      status: document.getElementById('bsStatus').value,
    });
    toast('Estado de backup actualizado');
    loadSummary();
  } catch (ex) { showError(ex.message || 'Error al guardar estado de backup'); }
});
document.getElementById('migBtn').addEventListener('click', async () => {
  showError('');
  const destination = document.getElementById('migDestination').value.trim();
  const dataVolumeGb = Number(document.getElementById('migVolume').value.trim());
  if (!destination) return showError('Indica el destino');
  if (!Number.isFinite(dataVolumeGb) || dataVolumeGb < 0) return showError('Volumen inválido');
  if (!confirm(`¿Encriptar y migrar snapshot hacia ${destination}? Fase actual: solo genera snapshot cifrado local, sin transferencia real.`)) return;
  try {
    const result = await api.resilienceSovereigntyMigrate({ destination, dataVolumeGb });
    const box = document.getElementById('migResult');
    box.textContent = `Snapshot cifrado generado: ${result.snapshot.migrationId} · hash ${result.snapshot.payloadHash.slice(0, 16)}… · ${result.snapshot.status}`;
    toast('Snapshot de migración generado');
  } catch (ex) { showError(ex.message || 'Error al generar snapshot de migración'); }
});

// ---- Init ----
loadSummary();
loadBssReadings();
loadIsolatedMode();
renderLegend();
renderWorldMap();
loadSuppliers();
loadBackupStatus();
