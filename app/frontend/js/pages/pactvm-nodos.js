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

// ---- Summary KPIs ----
async function loadSummary() {
  try {
    const s = await api.pactvmSummary();
    document.getElementById('kpiNodesTotalVal').textContent = s.nodesNeededTotal ?? 0;
    document.getElementById('kpiCountriesTrackedVal').textContent = s.countriesTracked ?? 0;
  } catch (ex) { showError(ex.message || 'Error al cargar resumen'); }
}

// ---- Nodos por pais (interfaz geoespacial) ----
const COUNTRY_NODE_STATUSES = {
  estimado: { label: 'Estimado', color: '#8a8a8a' },
  validado: { label: 'Validado', color: '#00a878' },
  en_negociacion: { label: 'En negociación', color: '#c9a84c' },
  activo: { label: 'Activo', color: '#3a7bd5' },
};
// ISO 3166-1 numeric -> alpha-2, solo para los codigos que usamos hoy
// (countries-110m.json identifica features por el numerico).
const ISO_NUMERIC_TO_A2 = { '724': 'ES', '620': 'PT', '250': 'FR', '504': 'MA' };

const UNTRACKED_FILL = '#1a2432';
const UNTRACKED_STROKE = '#2c3a4d';
const TRACKED_STROKE = '#0d1520';

function nodeColor(n) {
  if (!n || n <= 0) return UNTRACKED_FILL;
  if (n < 50) return '#2ecc8f';
  if (n < 200) return '#f2c94c';
  if (n < 500) return '#f2994a';
  return '#eb5757';
}

let cnRowsCache = [];
let mapPaths = null;

async function renderWorldMap() {
  const svg = document.getElementById('worldMap');
  if (mapPaths) return; // solo construir geometria una vez
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
      path.style.cursor = 'default';
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

// proyeccion equirectangular simple, sin dependencias externas
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

function paintMap() {
  if (!mapPaths) return;
  Object.entries(mapPaths).forEach(([a2, path]) => {
    const row = cnRowsCache.find(r => r.code === a2);
    path.setAttribute('fill', row ? nodeColor(row.nodesNeeded) : UNTRACKED_FILL);
    path.setAttribute('stroke', row ? TRACKED_STROKE : UNTRACKED_STROKE);
    path.setAttribute('stroke-width', row ? '1' : '0.6');
    const title = path.querySelector('title');
    if (title && row) title.textContent = `${row.label} — ${row.nodesNeeded} nodos necesarios`;
  });
}

function selectCountry(a2) {
  const row = cnRowsCache.find(r => r.code === a2);
  const box = document.getElementById('mapSelected');
  if (!row) { box.textContent = `${a2}: sin datos registrados.`; return; }
  box.innerHTML = `<b>${escapeHtml(row.label)}</b> (${row.code})<br>` +
    `residuo est.: ${row.wasteEstTDay} T/día<br>` +
    `nodos necesarios: <b>${row.nodesNeeded}</b> ${row.nodesOverride != null ? '(manual)' : '(auto)'}<br>` +
    `estado: ${COUNTRY_NODE_STATUSES[row.status]?.label || row.status}`;
}

function renderLegend() {
  const el = document.getElementById('mapLegend');
  el.innerHTML = [
    ['< 50 nodos', '#2ecc8f'],
    ['50–199 nodos', '#f2c94c'],
    ['200–499 nodos', '#f2994a'],
    ['≥ 500 nodos', '#eb5757'],
    ['sin dato / no trackeado', UNTRACKED_FILL],
  ].map(([label, color]) => `<span style="display:flex; align-items:center; gap:10px;">
        <span style="width:18px; height:18px; border-radius:4px; background:${color}; border:1px solid rgba(255,255,255,0.15); flex-shrink:0;"></span>${label}
      </span>`).join('');
}

async function loadCountryNodes() {
  const body = document.getElementById('cnBody');
  try {
    const rows = await api.pactvmCountryNodesList();
    cnRowsCache = rows;
    paintMap();
    if (rows.length === 0) { body.innerHTML = '<tr class="empty-row"><td colspan="6">Sin países registrados.</td></tr>'; return; }
    body.innerHTML = rows.map(r => `<tr data-id="${r.id}" data-code="${r.code}">
          <td>${escapeHtml(r.label)} <span class="mono" style="color:var(--text-muted);">(${r.code})</span></td>
          <td class="mono"><input class="input cn-waste" style="width:110px;" value="${r.wasteEstTDay}"></td>
          <td class="mono" style="font-weight:700;">
            <input class="input cn-nodes-override" style="width:70px;" value="${r.nodesOverride ?? ''}" placeholder="${r.nodesNeeded}" title="Vacío = automático (ceil(residuo/150)). Rellena para forzar valor manual.">
          </td>
          <td>${selectHtml(COUNTRY_NODE_STATUSES, r.status, 'cn-status')}</td>
          <td style="font-size:0.78rem; max-width:260px;">${escapeHtml(r.source || '')}</td>
          <td><button class="btn ghost btn--sm cn-del">Eliminar</button></td>
        </tr>`).join('');
    body.querySelectorAll('tr[data-id]').forEach(tr => {
      const id = tr.dataset.id;
      tr.addEventListener('click', (e) => { if (!e.target.closest('button,select,input')) selectCountry(tr.dataset.code); });
      tr.querySelector('.cn-waste').addEventListener('change', async (e) => {
        try { await api.pactvmCountryNodePatch(id, { wasteEstTDay: Number(e.target.value) }); loadCountryNodes(); loadSummary(); } catch (ex) { showError(ex.message); }
      });
      tr.querySelector('.cn-nodes-override').addEventListener('change', async (e) => {
        const raw = e.target.value.trim();
        const nodesOverride = raw === '' ? null : Number(raw);
        if (nodesOverride !== null && (!Number.isFinite(nodesOverride) || nodesOverride < 0 || !Number.isInteger(nodesOverride))) {
          return showError('Nodos manual debe ser entero >= 0 (o vacío para automático)');
        }
        try { await api.pactvmCountryNodePatch(id, { nodesOverride }); loadCountryNodes(); loadSummary(); } catch (ex) { showError(ex.message); }
      });
      tr.querySelector('.cn-status').addEventListener('change', async (e) => {
        try { await api.pactvmCountryNodePatch(id, { status: e.target.value }); } catch (ex) { showError(ex.message); }
      });
      tr.querySelector('.cn-del').addEventListener('click', async () => {
        try { await api.pactvmCountryNodeDelete(id); loadCountryNodes(); loadSummary(); } catch (ex) { showError(ex.message); }
      });
    });
  } catch (ex) { showError(ex.message || 'Error al cargar nodos por país'); }
}
document.getElementById('cnAddBtn').addEventListener('click', async () => {
  showError('');
  const code = document.getElementById('cnCode').value.trim().toUpperCase();
  const label = document.getElementById('cnLabel').value.trim();
  const wasteEstTDay = Number(document.getElementById('cnWaste').value.trim());
  const nodesOverrideRaw = document.getElementById('cnNodesOverride').value.trim();
  const nodesOverride = nodesOverrideRaw === '' ? null : Number(nodesOverrideRaw);
  if (!/^[A-Z]{2}$/.test(code)) return showError('Código ISO-2 inválido');
  if (!label) return showError('Indica el país');
  if (!Number.isFinite(wasteEstTDay) || wasteEstTDay < 0) return showError('Residuo estimado inválido');
  if (nodesOverride !== null && (!Number.isFinite(nodesOverride) || nodesOverride < 0 || !Number.isInteger(nodesOverride))) {
    return showError('Nodos manual debe ser entero >= 0 (o vacío para automático)');
  }
  try {
    await api.pactvmCountryNodeAdd({ code, label, wasteEstTDay, nodesOverride, source: document.getElementById('cnSource').value.trim() || null });
    document.getElementById('cnCode').value = '';
    document.getElementById('cnLabel').value = '';
    document.getElementById('cnWaste').value = '';
    document.getElementById('cnNodesOverride').value = '';
    document.getElementById('cnSource').value = '';
    loadCountryNodes(); loadSummary();
  } catch (ex) { showError(ex.message || 'Error al crear país'); }
});

// ---- Init ----
loadSummary();
renderLegend();
renderWorldMap();
loadCountryNodes();
