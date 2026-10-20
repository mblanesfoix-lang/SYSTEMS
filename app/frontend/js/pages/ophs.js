import { getUser, clearSession, requireAuth, api, getToken, toast } from '/js/api.js';
import { mountThemeToggle } from '/js/theme.js';
import { mountAdminNotifications } from '/js/notifications.js';
requireAuth();
mountThemeToggle(document.querySelector('.op-nav .controls') || document.querySelector('.op-nav'));
mountAdminNotifications(document.querySelector('.op-nav .controls'));

// Mesa guard: OPHS es dominio propio (mesa 'ophs')
await fetch('/api/me/permissions', { headers: { Authorization: `Bearer ${getToken()}` } })
  .then(r => r.json())
  .then(p => { if (!(p.mesas || []).includes('ophs')) location.href = '/pages/dashboard.html'; })
  .catch(() => {});

document.getElementById('userTag').textContent = getUser() || '';
document.getElementById('brandLogo').addEventListener('click', () => location.href = '/pages/dashboard.html');
document.getElementById('backBtn').addEventListener('click', () => location.href = '/pages/dashboard.html');
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

const authHeaders = () => ({ Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/json' });
async function jfetch(url, init = {}) {
  const r = await fetch(url, { ...init, headers: { ...authHeaders(), ...(init.headers || {}) } });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

/* ============================================================
   COCKPIT · hub de 4 mesas OPHS. Solo tiles estáticos: PAIA abre su
   sección (#paia, visor 3D), Sentinel enlaza a su mesa propia, OPS y
   Herzog "próximamente". La navegación entre vistas vive en ROUTER (final).
   ============================================================ */

/* ============================================================
   GRID INTERLINK · redes electricas transnacionales (Volumen 3)
   Un worker sandboxed por pais: chaos aqui demuestra que el
   colapso de un TSO no toca a los demas. Reflejo PAIA = solo
   aviso Admin, ninguna accion automatica sobre nodos.
   ============================================================ */
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
let gridVisible = false;

/* ============================================================
   VISOR DE MAQUINARIA 3D (modelos .glb optimizados con app/assets-src a
   partir de los .skp). Hoy vive en la sección PAIA (#paia) de OPHS; los
   identificadores son neutros (machine*): el visor no depende de la sección
   que lo aloja. Se entra desde el tile PAIA del Cockpit; tiene URL propia
   (ophs.html#paia), no es tab de nivel superior. El ROUTER (final del script)
   decide cuándo se ve.
   Carga perezosa del modulo three.js: solo pesa si se abre la sección.
   Selector de maquina en fila inferior (Bio-Grinder / Bio-Dehydrator /
   Bio-Pelletizator), estilo referencia airsup.ai/lab. Cada entrada del
   manifest puede no tener .glb subido todavia: en ese caso se muestra un
   estado vacio claro en vez de dejar el spinner colgado o un error de red crudo.
   ============================================================ */
let machineViewer = null;
let machineManifest = [];
let machineActiveIdx = -1;
let machineLoadedFile = null; // archivo cargado con exito ahora mismo en el visor, evita recargas redundantes
let machineWireframe = false;
let machineSelectToken = 0; // descarta selecciones de maquina obsoletas si el usuario cambia rapido
let machineOpening = false; // evita dos openMachineViewer() en paralelo (doble clic en el tile, Atrás/Adelante rápido)
// HUD de telemetría (js/machine-hud.js) sobre el visor. Hoy las lecturas son SIMULADAS (js/machine-telemetry.js):
// no hay sensores conectados. La fuente real sustituye a createTelemetryFeed() sin tocar el HUD.
let machineSpecs = {};        // MACHINE_SPECS: métricas, límites y layout de cada máquina
let machineFeed = null;       // fuente de telemetría
let machineHud = null;        // panel flotante + marcadores de hotspot
let machineLastSnaps = null;  // último snapshot de las 3 máquinas, para repintar los pulsos del selector

function setMachineLoading(visible, pct = 0, label = 'Cargando modelo…') {
  const overlay = document.getElementById('machineLoading');
  overlay.classList.toggle('is-hidden', !visible);
  document.getElementById('machineLoadingFill').style.width = `${Math.round(pct * 100)}%`;
  document.getElementById('machineLoadingLabel').textContent = label;
}

function setMachineEmpty(visible, detail = '', title = 'Sin modelo 3D todavía') {
  document.getElementById('machineEmpty').hidden = !visible;
  document.getElementById('machineEmptyTitle').textContent = title;
  document.getElementById('machineEmptyDetail').textContent = detail;
}

function renderMachineName(entry) {
  const nameBox = document.getElementById('machineName');
  nameBox.innerHTML = entry ? `
        <div class="n-label">${esc(entry.label)}</div>
        <div class="n-sub">${esc(entry.subtitle || '')}</div>
      ` : '';
}

function renderMachineSelector() {
  const bar = document.getElementById('machineSelector');
  bar.innerHTML = machineManifest.map((m, i) => `
        <button class="machine-btn${i === machineActiveIdx ? ' is-active' : ''}" data-idx="${i}">
          <span class="m-index">MÁQUINA ${String(i + 1).padStart(2, '0')}<i class="m-pulse" data-pulse="${esc(m.id)}" data-level="ok"></i></span>
          <span class="m-name">${esc(m.label)}</span>
          <span class="m-sub">${esc(m.subtitle || '')}</span>
          <span class="m-bar"></span>
        </button>
      `).join('');
  bar.querySelectorAll('.machine-btn').forEach((btn) => {
    btn.addEventListener('click', () => selectMachine(Number(btn.dataset.idx)));
  });
  if (machineLastSnaps) updateSelectorPulses(machineLastSnaps);
}

// Estado de las 3 máquinas de la línea en el selector, aunque solo una esté en pantalla.
function updateSelectorPulses(snaps) {
  machineLastSnaps = snaps;
  document.querySelectorAll('.m-pulse').forEach((el) => {
    const snap = snaps.get(el.dataset.pulse);
    if (snap && el.dataset.level !== snap.status) el.dataset.level = snap.status;
  });
}

async function selectMachine(idx) {
  const entry = machineManifest[idx];
  if (!entry || !machineViewer) return;

  machineActiveIdx = idx;
  renderMachineSelector();
  renderMachineName(entry);

  // El panel de telemetría no depende del modelo 3D: aparece ya. Los marcadores de hotspot sí
  // dependen de su geometría y se anclan cuando el modelo está en escena.
  const hotspots = entry.hotspots || [];
  machineHud.setMachine(machineSpecs[entry.id] || null, []);

  // Si ya es el archivo activo y cargado con exito, no volver a descargar ni a parsear:
  // evita repetir la carga solo por reabrir el panel o re-clicar la misma pestana
  // ya seleccionada.
  if (machineLoadedFile === entry.file) {
    setMachineEmpty(false);
    machineViewer.setAnchors(hotspots);
    machineHud.setHotspots(hotspots);
    return;
  }

  const myToken = ++machineSelectToken; // invalida cualquier seleccion anterior en vuelo
  machineLoadedFile = null;
  setMachineEmpty(false);
  document.getElementById('machineScaleNote').textContent = '';
  setMachineLoading(true, 0);

  // Carga directa, sin HEAD previo: un fetch HEAD por separado antes de loadModel()
  // podia dar falso negativo (cache del navegador, lentitud del server con un .glb
  // grande en vuelo) y pisaba un modelo que en realidad ya estaba bien cargado.
  // loadModel() ya distingue el 404 real (err.status) de otros fallos.
  try {
    // entry.focus acota el encuadre a la máquina cuando el .glb trae figuras de escala o piezas lejanas;
    // entry.zoom (< 1 acerca) afina la distancia en naves largas y planas
    const { meta } = await machineViewer.loadModel(`/vendor/models/${entry.file}`, { focus: entry.focus, zoom: entry.zoom });
    if (myToken !== machineSelectToken) return; // el usuario ya selecciono otra maquina mientras esta cargaba
    machineLoadedFile = entry.file;
    if (window.__machine) window.__machine.meta = meta; // ?debug3d: bbox nativo, para fijar focus y hotspots
    if (machineWireframe) machineViewer.setWireframe(true);
    document.getElementById('machineScaleNote').textContent =
      `${meta.size.x.toFixed(2)} × ${meta.size.y.toFixed(2)} × ${meta.size.z.toFixed(2)} m · ${meta.triangles.toLocaleString('es-ES')} triángulos`;
    machineViewer.setAnchors(hotspots);
    machineHud.setHotspots(hotspots);
    setMachineLoading(false, 1);
  } catch (err) {
    if (myToken !== machineSelectToken) return;
    machineViewer.clearModel();
    machineHud.setHotspots([]);
    setMachineLoading(false);
    if (err?.code === 'MODEL_TOO_HEAVY') {
      // .glb crudo de SketchUp: se rechaza antes de parsear para no colgar la pestaña
      setMachineEmpty(true, err.message, 'Modelo demasiado pesado');
      return;
    }
    const is404 = err?.status === 404 || /404|not ?found/i.test(String(err?.message || err));
    setMachineEmpty(true, is404
      ? `Falta subir /vendor/models/${entry.file}. En cuanto se añada el archivo, esta vista lo carga automáticamente.`
      : `Error al cargar el modelo: ${err.message || err}`);
  }
}

async function loadMachineManifest() {
  try {
    const r = await fetch('/vendor/models/manifest.json', { cache: 'no-store' });
    machineManifest = r.ok ? await r.json() : [];
  } catch { machineManifest = []; }
}

// Monta el visor y carga la maquina activa. La visibilidad del panel la gestiona showView() (ROUTER).
async function openMachineViewer() {
  // Guard de reentrada: doble clic en el tile PAIA o Atrás/Adelante rápido dispararían dos
  // aperturas en paralelo, y sus llamadas a setMachineEmpty()/selectMachine() se entrelazarían.
  if (machineOpening) return;
  machineOpening = true;
  try {
    // Motor three.js: se monta una sola vez por sesion de pestana (import + WebGL context son caros).
    if (!machineViewer) {
      const [{ mountMachineViewer }, telemetry, { mountMachineHud }] = await Promise.all([
        import('/js/machine-viewer.js'),
        import('/js/machine-telemetry.js'),
        import('/js/machine-hud.js'),
      ]);
      machineSpecs = telemetry.MACHINE_SPECS;
      machineFeed = telemetry.createTelemetryFeed();
      machineHud = mountMachineHud(document.getElementById('machineStage'), {
        // el panel ocupa un lado del visor: el modelo se re-centra en el área que queda libre
        onLayout: (inset) => machineViewer?.setViewInset(inset),
        // cursor sobre un marcador o el panel: la rotación automática se frena para poder leer
        onHold: (on) => machineViewer?.setHold(on),
        // "Simular desviación": desvía una lectura de la simulación para ver las alertas (solo demo, nada real cambia)
        onFault: ({ machineId, activate, fault }) => {
          if (activate) machineFeed.injectFault(machineId, fault.key, fault.delta);
          else machineFeed.clearFaults(machineId);
        },
      });
      machineViewer = mountMachineViewer(document.getElementById('machineCanvas'), {
        onProgress: (pct) => setMachineLoading(true, pct, pct >= 1 ? 'Procesando escena…' : 'Cargando modelo…'),
        onAutoRotate: (on) => document.getElementById('machineRotateBtn').classList.toggle('is-active', on),
        // GPU/driver tumba el contexto WebGL: el canvas queda congelado hasta que el navegador lo restaura (three.js re-sube los recursos solo)
        onContextChange: (lost) => setMachineLoading(lost, 0, lost ? 'Contexto gráfico perdido, recuperando…' : ''),
        onAnchors: (list) => machineHud.placeMarkers(list),
        onHover: (on) => machineHud.setMachineHover(on),
        onClick: ({ hit }) => { if (hit) machineHud.toggleExpanded(); },
      });
      machineFeed.subscribe((snaps) => { machineHud.update(snaps); updateSelectorPulses(snaps); });
      // el usuario pudo salir de PAIA mientras se importaba three.js
      machineViewer.setActive(currentView === 'paia');
      machineFeed.setActive(currentView === 'paia');

      // Autoría de hotspots: con ?debug3d, clic en la máquina escribe en consola el punto y la normal de
      // superficie (coordenadas nativas del .glb) listos para pegar en vendor/models/manifest.json.
      if (new URLSearchParams(location.search).has('debug3d')) {
        window.__machine = { viewer: machineViewer, hud: machineHud, feed: machineFeed };
        document.getElementById('machineCanvas').addEventListener('click', (e) => {
          const p = machineViewer.pick(e.clientX, e.clientY);
          if (p) console.info('[hotspot]', JSON.stringify({ position: p.position, normal: p.normal }));
        });
      }
    }

    // Manifest si: recargar cada vez que se abre el panel, no solo la primera,
    // para que anadir/renombrar modelos se vea sin recargar toda la pagina.
    await loadMachineManifest();
    renderMachineSelector();

    if (!machineManifest.length) {
      renderMachineName(null);
      machineHud.setMachine(null);
      setMachineLoading(false);
      setMachineEmpty(true, 'No hay máquinas definidas en /vendor/models/manifest.json.');
      return;
    }
    const keepIdx = machineActiveIdx >= 0 && machineActiveIdx < machineManifest.length ? machineActiveIdx : 0;
    await selectMachine(keepIdx);
  } finally {
    machineOpening = false;
  }
}

document.getElementById('machineResetBtn').addEventListener('click', () => machineViewer && machineViewer.resetView());
// El estado visual del botón lo sincroniza el visor vía onAutoRotate (también cuando arrastrar apaga la rotación).
document.getElementById('machineRotateBtn').addEventListener('click', () => machineViewer && machineViewer.toggleAutoRotate());
document.getElementById('machineWireBtn').addEventListener('click', (e) => {
  if (!machineViewer) return;
  machineWireframe = !machineWireframe;
  machineViewer.setWireframe(machineWireframe);
  e.currentTarget.classList.toggle('is-active', machineWireframe);
});

function gcStateClass(state) {
  if (state === 'activo') return 'activo';
  if (state.startsWith('caido') || state.startsWith('error')) return 'caido';
  if (state.includes('congelado') || state.includes('señal')) return 'congelado';
  return 'parado';
}

async function refreshGrid() {
  const box = document.getElementById('gridCards');
  try {
    const s = await jfetch('/api/grid/status');
    document.getElementById('gridMeta').textContent =
      `${s.countries.length} países · autostart ${s.autostart ? 'ON' : 'OFF'} · actualizado ${new Date(s.generatedAt).toLocaleTimeString('es-ES')}`;
    if (!s.countries.length) { box.innerHTML = '<p class="cockpit-empty">Sin países registrados.</p>'; return; }
    box.innerHTML = s.countries.map(c => {
      const last = c.lastSignal;
      const freq = last?.frequencyHz;
      const alert = last?.alertLevel || 'sin_dato';
      return `<div class="grid-card" data-code="${esc(c.code)}">
            <div class="gc-head">
              <div>
                <div class="gc-country">${esc(c.code)} · ${esc(c.tso)}</div>
                <div class="gc-tso">${esc(c.label || '')} · modo ${esc(c.mode)}</div>
              </div>
              <span class="gc-state ${gcStateClass(c.workerState)}">${esc(c.workerState)}</span>
            </div>
            <div class="gc-freq ${alert === 'critico' ? 'critico' : alert === 'alerta' ? 'alerta' : ''}">
              ${freq != null ? freq.toFixed(3) : '—'} <small>Hz · ${esc(alert)}</small>
            </div>
            <div class="gc-rows">
              demanda <b>${last?.demandMw != null ? last.demandMw.toLocaleString('es-ES') + ' MW' : '—'}</b> ·
              gen <b>${last?.generationMw != null ? last.generationMw.toLocaleString('es-ES') + ' MW' : '—'}</b><br>
              renovable <b>${last?.renewablePct != null ? last.renewablePct + '%' : '—'}</b> ·
              precio <b>${last?.priceEurMwh != null ? last.priceEurMwh + ' €/MWh' : '—'}</b><br>
              reinicios <b>${c.restarts}</b> · última señal <b>${c.lastSignalAt ? new Date(c.lastSignalAt).toLocaleTimeString('es-ES') : '—'}</b><br>
              sandbox <b>${c.sandbox.maxOldGenerationSizeMb} MB</b> heap
            </div>
            <div class="gc-actions">
              <button class="cockpit-btn cockpit-btn--ghost gc-restart" style="padding:6px 10px; font-size:0.6rem;">Reiniciar</button>
              <button class="cockpit-btn cockpit-btn--ghost gc-chaos" data-mode="crash" style="padding:6px 10px; font-size:0.6rem; color:#d80300; border-color:rgba(216,3,0,0.35);">Chaos crash</button>
              <button class="cockpit-btn cockpit-btn--ghost gc-chaos" data-mode="stall" style="padding:6px 10px; font-size:0.6rem; color:#a87605; border-color:rgba(217,154,6,0.4);">Stall</button>
              <button class="cockpit-btn cockpit-btn--ghost gc-chaos" data-mode="flood" style="padding:6px 10px; font-size:0.6rem; color:#a87605; border-color:rgba(217,154,6,0.4);">Flood</button>
            </div>
          </div>`;
    }).join('');
    box.querySelectorAll('.grid-card').forEach(card => {
      const code = card.dataset.code;
      card.querySelector('.gc-restart').addEventListener('click', async () => {
        try { await jfetch(`/api/grid/countries/${encodeURIComponent(code)}/restart`, { method: 'POST' }); refreshGrid(); }
        catch (ex) { document.getElementById('gridMsg').textContent = `Error: ${ex.message}`; }
      });
      card.querySelectorAll('.gc-chaos').forEach(btn => {
        btn.addEventListener('click', async () => {
          const mode = btn.dataset.mode;
          if (!confirm(`Inyectar colapso "${mode}" en ${code}? Solo cae ese país; verifica que el resto sigue emitiendo.`)) return;
          try {
            const r = await jfetch(`/api/grid/countries/${encodeURIComponent(code)}/chaos`, { method: 'POST', body: JSON.stringify({ mode }) });
            document.getElementById('gridMsg').textContent = r.note || `Chaos ${mode} inyectado en ${code}.`;
            setTimeout(refreshGrid, 1500);
          } catch (ex) { document.getElementById('gridMsg').textContent = `Error: ${ex.message}`; }
        });
      });
    });
  } catch (ex) {
    box.innerHTML = `<p class="cockpit-empty">Grid Interlink sin conexión: ${esc(ex.message)}</p>`;
  }
}

document.getElementById('gcAddBtn').addEventListener('click', async () => {
  const msg = document.getElementById('gridMsg');
  const code = document.getElementById('gcNewCode').value.trim().toUpperCase();
  const tso = document.getElementById('gcNewTso').value.trim();
  if (!code || !tso) { msg.textContent = 'code ISO-2 y TSO requeridos.'; return; }
  try {
    await jfetch('/api/grid/countries', {
      method: 'POST',
      body: JSON.stringify({
        code, tso,
        label: document.getElementById('gcNewLabel').value.trim() || undefined,
        url: document.getElementById('gcNewUrl').value.trim() || undefined,
      }),
    });
    ['gcNewCode', 'gcNewTso', 'gcNewLabel', 'gcNewUrl'].forEach(id => document.getElementById(id).value = '');
    msg.textContent = `País ${code} registrado.`;
    refreshGrid();
  } catch (ex) { msg.textContent = `Error: ${ex.message}`; }
});

setInterval(() => { if (gridVisible) refreshGrid(); }, 4000);

/* ============================================================
   ROUTER · vistas de OPHS por hash, sin recarga:
     (vacío) | #cockpit   hub de 4 tiles
     #paia                sección PAIA (visor de maquinaria 3D)
     #grid                Grid Interlink
   PAIA tiene URL propia: recarga, enlace directo y botón Atrás funcionan.
   Cualquier otro hash (p.ej. el antiguo #ops) cae al hub.
   Va al final del script: showView() necesita todos los let de arriba ya declarados.
   ============================================================ */
const VIEW_LABEL = { paia: 'PAIA', grid: 'Grid Interlink' };
let currentView = 'cockpit';

function viewFromHash() {
  const h = location.hash.slice(1);
  return h === 'paia' || h === 'grid' ? h : 'cockpit';
}

function renderBreadcrumb(view) {
  const tail = VIEW_LABEL[view];
  document.getElementById('opBreadcrumb').innerHTML =
    '<a href="/pages/dashboard.html">Systems</a><span class="sep">/</span>'
    + (tail
      ? `<a href="#cockpit">ØPHS</a><span class="sep">/</span><span class="active">${tail}</span>`
      : '<span class="active">ØPHS</span>');
  document.title = tail ? `SYSTEMS · ØPHS · ${tail}` : 'SYSTEMS · ØPHS';
}

function showView(view) {
  currentView = view;
  gridVisible = view === 'grid';
  document.getElementById('panelCockpit').hidden = view !== 'cockpit';
  document.getElementById('panelGrid').hidden = view !== 'grid';
  document.getElementById('panelPaia').hidden = view !== 'paia';
  // PAIA es una sección del Cockpit: su pestaña sigue activa mientras se está dentro.
  const activeTab = view === 'grid' ? 'grid' : 'cockpit';
  document.querySelectorAll('.op-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === activeTab));
  renderBreadcrumb(view);
  if (machineViewer) machineViewer.setActive(view === 'paia'); // panel fuera de vista: no se gasta GPU renderizando
  if (machineFeed) machineFeed.setActive(view === 'paia');     // ni se simula telemetría que nadie ve
  if (view === 'grid') refreshGrid();
  if (view === 'paia') openMachineViewer();
}

document.querySelectorAll('.op-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    if (viewFromHash() !== tab.dataset.tab) location.hash = tab.dataset.tab;
  });
});
window.addEventListener('hashchange', () => showView(viewFromHash()));
showView(viewFromHash());
