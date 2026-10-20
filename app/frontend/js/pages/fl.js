import { api, getUser, getToken, requireAuth, clearSession, toast, escapeHtml, uploadFlExpedienteDoc, openFlExpedienteDoc } from '/js/api.js';
import { mountThemeToggle } from '/js/theme.js';
import { mountOfficeBg } from '/js/office-bg.js';
import { initFlHub } from '/js/fl-hub.js';
requireAuth();
mountThemeToggle(document.querySelector('nav.nav .row'));
mountOfficeBg();
document.getElementById('userTag').textContent = getUser() || '';
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

// ---- Expediente Fiscal y Juridico Impecable (CRM documental) ----
const EXP_ESTADOS_LBL = {
  pendiente: 'Pendiente', en_tramite: 'En trámite', vigente: 'Vigente',
  por_caducar: 'Por caducar', caducado: 'Caducado', no_aplica: 'No aplica',
};
const EXP_REGIMEN_LBL = {
  si: 'Caduca (entra en alerta)',
  no: 'Perpetuo (sin caducidad)',
  revision: 'Revisión periódica',
};

let expMeta = null;       // catalogo de carpetas/estados/regimenes
let expDocs = [];         // cache plana de documentos cargados
let expSelId = null;      // documento abierto en la ficha
let expCreando = false;   // ficha en modo alta
let expDetallesAbiertos = false; // plegado de fechas/emisor/notas en la ficha

function expFmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

async function loadExpedienteMeta() {
  if (expMeta) return expMeta;
  expMeta = await api.flExpedienteMeta();
  const selB = document.getElementById('expFiltroBloque');
  expMeta.bloques.forEach(b => {
    const o = document.createElement('option');
    o.value = b.key; o.textContent = b.label;
    selB.appendChild(o);
  });
  const selE = document.getElementById('expFiltroEstado');
  expMeta.estados.forEach(e => {
    const o = document.createElement('option');
    o.value = e; o.textContent = EXP_ESTADOS_LBL[e] || e;
    selE.appendChild(o);
  });
  return expMeta;
}

async function loadExpedienteSummary() {
  try {
    const s = await api.flExpedienteSummary();
    document.getElementById('expKpiCompletitud').textContent = `${s.completitudPct ?? 0}%`;
    document.getElementById('expKpiTotal').textContent = s.totalDocumentos ?? 0;
    document.getElementById('expKpiVigentes').textContent = s.vigentes ?? 0;
    document.getElementById('expKpiPorCaducar').textContent = s.porCaducar ?? 0;
    document.getElementById('expKpiPorCaducarCell').classList.toggle('alert', (s.porCaducar ?? 0) > 0);
    document.getElementById('expKpiPorCaducar').classList.toggle('warn', (s.porCaducar ?? 0) > 0);
    document.getElementById('expKpiCaducados').textContent = s.caducados ?? 0;
    document.getElementById('expKpiCaducadosCell').classList.toggle('alert', (s.caducados ?? 0) > 0);
    document.getElementById('expKpiCaducados').classList.toggle('warn', (s.caducados ?? 0) > 0);
    document.getElementById('expKpiFaltantes').textContent = s.faltantes ?? 0;
    document.getElementById('expKpiFaltantesCell').classList.toggle('alert', (s.faltantes ?? 0) > 0);
  } catch (ex) { showError(ex.message || 'Error al cargar resumen del expediente'); }
}

async function loadExpedienteAlertas() {
  const box = document.getElementById('expAlertas');
  try {
    const { alertas } = await api.flExpedienteAlertas();
    if (!alertas.length) {
      box.innerHTML = '<div class="exp-alert-box"><h4>ALERTAS ACTIVAS</h4><div style="font-size:0.8rem; color:var(--text-muted);">Sin avisos: todos los documentos están aportados y en plazo.</div></div>';
      return;
    }
    box.innerHTML = `
          <div class="exp-alert-box">
            <h4>ALERTAS ACTIVAS · ${alertas.length}</h4>
            ${alertas.map(a => `
              <div class="exp-alert-item" data-goto="${escapeHtml(a.docId)}" style="cursor:pointer;">
                <span class="sev ${a.severity}"></span>
                <span class="slot">${escapeHtml(a.bloque)}</span>
                <span>${escapeHtml(a.mensaje)}</span>
              </div>`).join('')}
          </div>`;
  } catch (ex) { box.innerHTML = ''; showError(ex.message || 'Error al cargar alertas'); }
}

function expRowMeta(doc) {
  if (doc.alerta?.tipo === 'caducado') return { txt: `caducado hace ${Math.abs(doc.diasRestantes)} d`, cls: 'bad' };
  if (doc.alerta?.tipo === 'por_caducar') return { txt: `caduca en ${doc.diasRestantes} d`, cls: doc.diasRestantes <= 15 ? 'bad' : 'warn' };
  if (doc.alerta?.tipo === 'faltante') return { txt: 'sin archivo', cls: 'warn' };
  if (doc.fecha_caducidad) return { txt: `vence ${doc.fecha_caducidad}`, cls: '' };
  return { txt: EXP_ESTADOS_LBL[doc.estado] || doc.estado, cls: '' };
}

async function loadExpediente() {
  const cont = document.getElementById('expBloques');
  const filtros = {
    bloque: document.getElementById('expFiltroBloque').value,
    estado: document.getElementById('expFiltroEstado').value,
    q: document.getElementById('expSearch').value.trim(),
  };
  try {
    const { bloques } = await api.flExpediente(filtros);
    expDocs = bloques.flatMap(b => b.documentos);
    cont.innerHTML = bloques.map(b => `
          <div class="exp-bloque">
            <h3>${escapeHtml(b.label)}<span class="exp-bloque__count">${b.documentos.length} doc.</span></h3>
            <p class="desc">${escapeHtml(b.descripcion)}</p>
            ${b.documentos.length
          ? b.documentos.map(d => {
              const m = expRowMeta(d);
              return `
                    <div class="exp-row${d.id === expSelId ? ' selected' : ''}" data-doc="${escapeHtml(d.id)}">
                      <span class="exp-row__clip">${d.file_id ? '●' : '○'}</span>
                      <span class="exp-row__name">${escapeHtml(d.nombre)}</span>
                      <span class="exp-state exp-state-${escapeHtml(d.estado)}">${escapeHtml(EXP_ESTADOS_LBL[d.estado] || d.estado)}</span>
                      <span class="exp-row__meta ${m.cls}">${escapeHtml(m.txt)}</span>
                    </div>`;
            }).join('')
          : '<div class="exp-bloque__empty">Sin documentos en esta carpeta.</div>'}
          </div>`).join('');
  } catch (ex) {
    cont.innerHTML = '<p class="empty-state">No se pudo cargar el expediente.</p>';
    showError(ex.message || 'Error al cargar el expediente');
  }
}

// Ficha lateral: alta (doc null) o edicion de un documento existente.
function expRenderFicha(doc) {
  const ficha = document.getElementById('expFicha');
  if (!doc && !expCreando) {
    ficha.innerHTML = '<p class="empty-state">Selecciona un documento de la lista, o crea uno nuevo.</p>';
    return;
  }
  const d = doc || { bloque: expMeta?.bloques?.[0]?.key || 'A', regimen: 'si', estado: 'pendiente', dias_alerta: 60 };
  const nuevo = !doc;
  const carpeta = (expMeta?.bloques || []).find(b => b.key === d.bloque);

  // Los detalles (fechas, emisor, referencia, estado, regimen, notas) van
  // plegados: el uso normal es "veo el titulo y suelto el PDF". Se rellenan
  // mas tarde, cuando el humano tenga los datos.
  const detalles = `
        <div class="exp-detalles" ${expDetallesAbiertos || nuevo ? '' : 'hidden'}>
          ${nuevo ? `
            <div class="sf"><label>Nombre del documento</label>
              <input class="input" data-f="nombre" value="${escapeHtml(d.nombre || '')}" placeholder="Ej. Certificado de Codigo DUNS">
            </div>` : `
            <div class="sf"><label>Nombre del documento</label>
              <input class="input" data-f="nombre" value="${escapeHtml(d.nombre || '')}">
            </div>`}
          <div class="sf"><label>Carpeta</label>
            <select class="input" data-f="bloque">
              ${(expMeta?.bloques || []).map(b => `<option value="${b.key}"${b.key === d.bloque ? ' selected' : ''}>${escapeHtml(b.label)}</option>`).join('')}
            </select>
          </div>
          <div class="sf"><label>Descripción / qué acredita</label>
            <textarea class="input" data-f="descripcion" placeholder="Opcional">${escapeHtml(d.descripcion || '')}</textarea>
          </div>
          <div class="exp-ficha__grid2">
            <div class="sf"><label>Estado</label>
              <select class="input" data-f="estado">
                ${(expMeta?.estados || []).map(e => `<option value="${e}"${e === d.estado ? ' selected' : ''}>${escapeHtml(EXP_ESTADOS_LBL[e] || e)}</option>`).join('')}
              </select>
            </div>
            <div class="sf"><label>Régimen</label>
              <select class="input" data-f="regimen">
                ${(expMeta?.regimenes || []).map(r => `<option value="${r}"${r === d.regimen ? ' selected' : ''}>${escapeHtml(EXP_REGIMEN_LBL[r] || r)}</option>`).join('')}
              </select>
            </div>
            <div class="sf"><label>Emisión</label><input class="input" type="date" data-f="fecha_emision" value="${d.fecha_emision || ''}"></div>
            <div class="sf"><label>Caducidad</label><input class="input" type="date" data-f="fecha_caducidad" value="${d.fecha_caducidad || ''}"></div>
            <div class="sf"><label>Días de aviso</label><input class="input" type="number" min="0" data-f="dias_alerta" value="${d.dias_alerta ?? 60}"></div>
            <div class="sf"><label>Emisor</label><input class="input" data-f="emisor" value="${escapeHtml(d.emisor || '')}" placeholder="Notaría, OEPM…"></div>
          </div>
          <div class="sf"><label>Referencia</label>
            <input class="input" data-f="referencia" value="${escapeHtml(d.referencia || '')}" placeholder="Nº protocolo / expediente">
          </div>
          <div class="sf"><label>Notas</label>
            <textarea class="input" data-f="notas" placeholder="Opcional">${escapeHtml(d.notas || '')}</textarea>
          </div>
          <div class="exp-ficha__actions">
            <button class="btn sage" data-act="${nuevo ? 'create' : 'save'}">${nuevo ? 'Crear documento' : 'Guardar cambios'}</button>
            ${nuevo
          ? '<button class="btn" data-act="cancel">Cancelar</button>'
          : '<button class="btn" data-act="del-doc" style="color:#d80300;">Eliminar</button>'}
          </div>
        </div>`;

  if (nuevo) {
    ficha.innerHTML = `
          <h3>Nuevo documento</h3>
          <p class="exp-ficha__hint">Ponle nombre y elige carpeta. El PDF se adjunta después, desde su ficha.</p>
          ${detalles}`;
    return;
  }

  // Aviso del documento (caducidad o falta de archivo), si lo hay.
  const av = d.alerta
    ? `<div class="exp-ficha__alerta ${d.alerta.severity}">${escapeHtml(d.alerta.mensaje)}</div>`
    : '';

  ficha.innerHTML = `
        <div class="exp-ficha__carpeta">${escapeHtml(carpeta?.label || d.bloque)}</div>
        <h3 class="exp-ficha__titulo">${escapeHtml(d.nombre)}</h3>
        ${d.descripcion ? `<p class="exp-ficha__desc">${escapeHtml(d.descripcion)}</p>` : ''}
        ${av}

        <div class="exp-ficha__pdf">
          ${d.file_id ? `
            <div class="exp-file">
              <span class="exp-file__name">${escapeHtml(d.file_name || 'documento')}</span>
              <span class="exp-file__meta">${expFmtBytes(d.file_size)}</span>
              <button class="exp-file__act" data-act="open">Abrir</button>
              <button class="exp-file__act" data-act="download">Descargar</button>
              <button class="exp-file__act danger" data-act="del-file">Quitar</button>
            </div>` : ''}
          <div class="exp-drop${d.file_id ? '' : ' exp-drop--vacio'}" data-act="drop">
            ${d.file_id ? 'Sustituir archivo: arrastra aquí o haz clic' : 'Arrastra el PDF aquí o haz clic para subirlo'}
          </div>
          <input type="file" hidden data-f="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png,.webp">
        </div>

        <div class="exp-ficha__resumen">
          <span>${escapeHtml(EXP_ESTADOS_LBL[d.estado] || d.estado)}</span>
          <span>${d.fecha_caducidad ? `caduca ${escapeHtml(d.fecha_caducidad)}` : 'sin fecha de caducidad'}</span>
        </div>

        <button class="exp-toggle" data-act="toggle-detalles">
          ${expDetallesAbiertos ? 'Ocultar detalles' : 'Editar detalles (fechas, emisor, notas…)'}
        </button>
        ${detalles}`;
}

function expSeleccionar(id) {
  // Cambiar de documento cierra los detalles: se vuelve a la vista simple
  // (titulo + PDF). Al refrescar el MISMO documento se conserva abierto.
  if (id !== expSelId) expDetallesAbiertos = false;
  expCreando = false;
  expSelId = id;
  document.querySelectorAll('#expBloques .exp-row').forEach(r => r.classList.toggle('selected', r.dataset.doc === id));
  expRenderFicha(expDocs.find(d => d.id === id) || null);
}

function expLeerFicha() {
  const ficha = document.getElementById('expFicha');
  const val = (f) => ficha.querySelector(`[data-f="${f}"]`)?.value ?? '';
  return {
    nombre: val('nombre').trim(),
    bloque: val('bloque'),
    descripcion: val('descripcion').trim() || null,
    estado: val('estado'),
    regimen: val('regimen'),
    fecha_emision: val('fecha_emision') || null,
    fecha_caducidad: val('fecha_caducidad') || null,
    dias_alerta: Number(val('dias_alerta')) || 0,
    emisor: val('emisor').trim() || null,
    referencia: val('referencia').trim() || null,
    notas: val('notas').trim(),
  };
}

async function expRefrescar(selId) {
  await loadExpediente();
  loadExpedienteSummary();
  loadExpedienteAlertas();
  if (selId) expSeleccionar(selId);
}

async function expSubirArchivo(docId, file) {
  if (!file) return;
  try {
    await uploadFlExpedienteDoc(docId, file);
    toast('Archivo subido');
    await expRefrescar(docId);
  } catch (ex) { showError(ex.message || 'Error al subir el archivo'); }
}

// ---- Eventos: lista ----
document.getElementById('expBloques').addEventListener('click', (e) => {
  const row = e.target.closest('.exp-row');
  if (row) expSeleccionar(row.dataset.doc);
});

document.getElementById('expAlertas').addEventListener('click', (e) => {
  const item = e.target.closest('[data-goto]');
  if (item) expSeleccionar(item.dataset.goto);
});

// ---- Eventos: ficha (delegacion, se repinta entera en cada recarga) ----
const expFichaEl = document.getElementById('expFicha');

expFichaEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  const doc = expDocs.find(d => d.id === expSelId);

  if (act === 'cancel') { expCreando = false; expRenderFicha(doc || null); return; }
  if (act === 'drop') { expFichaEl.querySelector('[data-f="file"]').click(); return; }

  // Plegar/desplegar sin repintar: conserva lo que el humano este escribiendo.
  if (act === 'toggle-detalles') {
    expDetallesAbiertos = !expDetallesAbiertos;
    expFichaEl.querySelector('.exp-detalles').hidden = !expDetallesAbiertos;
    btn.textContent = expDetallesAbiertos ? 'Ocultar detalles' : 'Editar detalles (fechas, emisor, notas…)';
    return;
  }

  if (act === 'open' || act === 'download') {
    if (!doc?.file_id) return;
    try { await openFlExpedienteDoc(doc.file_id, doc.file_name, act === 'download'); }
    catch (ex) { showError(ex.message || 'Error al abrir el archivo'); }
    return;
  }

  if (act === 'del-file') {
    if (!doc || !confirm('¿Quitar el archivo adjunto de este documento?')) return;
    try {
      await api.flExpedienteArchivoDel(doc.id);
      toast('Archivo eliminado');
      await expRefrescar(doc.id);
    } catch (ex) { showError(ex.message || 'Error al quitar el archivo'); }
    return;
  }

  if (act === 'del-doc') {
    if (!doc || !confirm(`¿Eliminar "${doc.nombre}" del expediente? También se borra su archivo adjunto.`)) return;
    try {
      await api.flExpedienteDocDelete(doc.id);
      toast('Documento eliminado');
      expSelId = null;
      expRenderFicha(null);
      await expRefrescar(null);
    } catch (ex) { showError(ex.message || 'Error al eliminar el documento'); }
    return;
  }

  if (act === 'create') {
    const payload = expLeerFicha();
    if (!payload.nombre) return showError('Indica el nombre del documento');
    try {
      const creado = await api.flExpedienteDocAdd(payload);
      toast('Documento creado');
      expCreando = false;
      await expRefrescar(creado.id);
    } catch (ex) { showError(ex.message || 'Error al crear el documento'); }
    return;
  }

  if (act === 'save') {
    if (!doc) return;
    const payload = expLeerFicha();
    if (!payload.nombre) return showError('El nombre no puede quedar vacío');
    try {
      await api.flExpedienteDocPatch(doc.id, payload);
      toast('Documento actualizado');
      await expRefrescar(doc.id);
    } catch (ex) { showError(ex.message || 'Error al guardar el documento'); }
  }
});

expFichaEl.addEventListener('change', (e) => {
  if (e.target.matches('[data-f="file"]') && expSelId) {
    expSubirArchivo(expSelId, e.target.files[0]);
    e.target.value = '';
  }
});

expFichaEl.addEventListener('dragover', (e) => {
  const drop = e.target.closest('[data-act="drop"]');
  if (!drop) return;
  e.preventDefault();
  drop.classList.add('dragover');
});
expFichaEl.addEventListener('dragleave', (e) => {
  e.target.closest('[data-act="drop"]')?.classList.remove('dragover');
});
expFichaEl.addEventListener('drop', (e) => {
  const drop = e.target.closest('[data-act="drop"]');
  if (!drop) return;
  e.preventDefault();
  drop.classList.remove('dragover');
  if (expSelId) expSubirArchivo(expSelId, e.dataTransfer.files[0]);
});

// ---- Eventos: barra superior ----
document.getElementById('expNuevoBtn').addEventListener('click', () => {
  expCreando = true;
  expSelId = null;
  document.querySelectorAll('#expBloques .exp-row').forEach(r => r.classList.remove('selected'));
  expRenderFicha(null);
});

document.getElementById('expRevisarBtn').addEventListener('click', async () => {
  try {
    const r = await api.flExpedienteRevisar();
    toast(r.total ? `${r.total} aviso(s) activo(s)` : 'Expediente al día');
    await expRefrescar(expSelId);
  } catch (ex) { showError(ex.message || 'Error al revisar el expediente'); }
});

let expSearchTimer = null;
document.getElementById('expSearch').addEventListener('input', () => {
  clearTimeout(expSearchTimer);
  expSearchTimer = setTimeout(loadExpediente, 250);
});
document.getElementById('expFiltroBloque').addEventListener('change', loadExpediente);
document.getElementById('expFiltroEstado').addEventListener('change', loadExpediente);

// El expediente se carga al abrir su pestaña por primera vez (guard propio
// fl_expediente: sin ese permiso no se piden sus datos).
let expCargado = false;
async function cargarExpediente() {
  if (expCargado) return;
  expCargado = true;
  try {
    await loadExpedienteMeta();
  } catch (ex) {
    expCargado = false;
    showError(ex.message || 'No se pudo cargar el expediente');
    return;
  }
  loadExpediente();
  loadExpedienteSummary();
  loadExpedienteAlertas();
}

// ---- Init: Hub fiscal y legal (cinco vistas) + Expediente ----
const hub = initFlHub({ onTab: (tab) => { if (tab === 'expediente') cargarExpediente(); } });

// Sin la mesa fl_expediente, la pestaña del Expediente no se ofrece.
fetch('/api/me/permissions', { headers: { Authorization: `Bearer ${getToken()}` } })
  .then(r => (r.ok ? r.json() : null))
  .then(p => {
    if (!p || (p.mesas || []).includes('fl_expediente')) return;
    document.getElementById('tab-expediente').hidden = true;
    if (location.hash === '#expediente') hub.irATab('overview');
  })
  .catch(() => {});
