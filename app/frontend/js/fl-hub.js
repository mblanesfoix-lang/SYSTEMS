/**
 * S-NFI F&L · Hub fiscal y legal: interfaz de fl.html.
 *
 * Una sola carga (GET /api/fl/hub) alimenta las cinco vistas del Hub; cada
 * accion (acuse, cambio de estado, alta, edicion, archivo) va al backend,
 * queda en fl_log y recarga los datos. Plazos legales y KPIs llegan
 * calculados del servidor: aqui solo se presentan y se animan las cuentas
 * atras. La sexta pestaña (Expediente Fiscal y Juridico) y la septima
 * (Registros oficiales) las sigue pintando el script propio de fl.html;
 * este modulo solo las muestra u oculta.
 */
import { api, toast, escapeHtml as h, fetchFlFichaPdf } from '/js/api.js';
import * as L from '/js/fl-hub-logic.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const TABS = ['overview', 'fiscal', 'gobtech', 'corporativo', 'clm', 'expediente', 'registros'];
// Expediente y Registros oficiales los pinta fl.js: este modulo solo los muestra u oculta.
const HUB_TABS = TABS.filter((t) => t !== 'expediente' && t !== 'registros');
const REFRESCO_MS = 5 * 60 * 1000;
const FILAS_FISCAL = 15;

const ICONOS = {
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  bell: '<path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 12h4"/>',
  external: '<path d="M7 17L17 7"/><path d="M8 7h9v9"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  left: '<path d="M15 6l-6 6 6 6"/>',
  right: '<path d="M9 6l6 6-6 6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  download: '<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 21h14"/>',
  sign: '<path d="M3 17c3 0 4-8 7-8s1 8 4 8 3-4 5-4"/><path d="M3 21h18"/>',
  shield: '<path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6l7-3z"/><path d="M9 12l2 2 4-4"/>',
};
const icon = (name, size = 15) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONOS[name]}</svg>`;

const pill = (texto, tono = 'muted') => `<span class="flh-pill flh-pill--${tono}">${h(texto)}</span>`;
const DEMO = '<span class="flh-pill flh-pill--demo" title="Dato de demostración pendiente de confirmar">DEMO</span>';

const TONO_MODELO = { pendiente: 'warn', en_auditoria: 'info', liquidado: 'ok' };
const TONO_NOTIF = { pendiente: 'warn', asignada: 'info', respondida: 'ok', archivada: 'muted' };
// El estado de una notificacion lo gobierna el flujo (acuse/asignar/responder), no el esquema editable.
const ESTADO_NOTIF = { pendiente: 'Pendiente', asignada: 'Asignada a abogado', respondida: 'Respondida', archivada: 'Archivada' };
const ESTADO_ALERTA = { nueva: 'Nueva', revisada: 'Revisada', descartada: 'Descartada' };
// Campos que la ficha ya muestra en su bloque superior.
const EXCLUIR_FICHA = { modelos: ['estado'], juntas: ['estado'], checklist: ['estado'] };
const TONO_CONTRATO = { borrador: 'muted', negociacion: 'info', vigente: 'ok', vencido: 'bad', rescindido: 'muted' };
const SITUACION_PODER = { vigente: ['Vigente', 'ok'], por_caducar: ['Por caducar', 'warn'], caducado: ['Caducado', 'bad'], revocado: ['Revocado', 'muted'] };
const RELEVANCIA = { alta: ['Relevancia alta', 'bad'], media: ['Relevancia media', 'warn'], baja: ['Relevancia baja', 'muted'] };
const ROL = { holding: ['Sociedad dominante', 'gold'], filial: ['Filial', 'info'], spv: ['SPV', 'info'] };
const TIPOS_EVENTO = [
  ['fiscal', 'Fiscal'], ['societario', 'Societario'], ['notificacion', 'Notificaciones'],
  ['contrato', 'Contratos'], ['poder', 'Poderes'], ['legal', 'Hitos legales'],
];
const ADMIN_CORTA = { AEAT: 'AEAT', HFN: 'H. Foral Navarra', DFG: 'DF Gipuzkoa', DFB: 'DF Bizkaia', DFA: 'DF Álava' };
const PORTAL_CANAL = { dehu: 'dehu', sede_aeat: 'aeat', sede_tgss: 'tgss', sede_navarra: 'hfn' };
const ACCIONES_LOG = {
  create: 'Alta del registro', update: 'Modificación', archive: 'Archivado', confirm_real: 'Confirmado como dato real',
  acuse: 'Acuse de recepción registrado', estado: 'Cambio de estado', 'download': 'Ficha PDF consultada',
};

/* ------------------------------------------------------------------------
   Estado
   ------------------------------------------------------------------------ */
const S = {
  data: null,
  soc: new Map(),
  byId: {},
  indice: [],
  tab: 'overview',
  sucio: new Set(HUB_TABS),
  cal: { year: null, month: null, vista: 'mes', tipos: new Set(TIPOS_EVENTO.map(([k]) => k)), estado: 'todos', dia: null },
  fiscal: { sociedad: '', ejercicio: '', administracion: '', estado: '', q: '' },
  fiscalTodos: false,
  normasQ: '',
  gob: { estado: 'abiertas', emisor: '', sociedad: '', q: '' },
  corp: { sociedad: '' },
  clm: { vista: 'grid', tipo: '', estado: 'activos', sociedad: '', orden: 'vencimiento', q: '' },
  alertas: { relevancia: 'alta_media', fuente: '', estado: 'nueva', q: '' },
};
let opciones = {};

const opt = (entidad, campo, valor) => S.data?.meta.esquemas[entidad]?.campos.find((c) => c.key === campo)?.opciones?.find((o) => o.v === valor)?.l ?? valor ?? '—';
const nombreSoc = (id) => S.soc.get(id)?.nombre_corto ?? '—';
const hoy = () => S.data?.hoy ?? L.isoDeFecha(new Date());
const fmtPct = (n) => `${Number(n).toLocaleString('es-ES', { maximumFractionDigits: 1 })} %`;

function horaCorta(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const mismoDia = L.isoDeFecha(d) === L.isoDeFecha(new Date());
  const hora = d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  return mismoDia ? hora : `${L.fmtFecha(L.isoDeFecha(d), { corta: true })} ${hora}`;
}

function tituloDe(entidad, d) {
  switch (entidad) {
    case 'sociedades': return d.denominacion;
    case 'modelos': return `Modelo ${d.modelo} · ${d.periodo} ${d.ejercicio}`;
    case 'notificaciones': return d.asunto;
    case 'juntas': return `${opt('juntas', 'organo', d.organo)} · ${L.fmtFecha(d.fecha)}`;
    case 'apoderamientos': return d.apoderado;
    case 'contratos': return d.titulo;
    case 'checklist': return `${d.nia} · ${d.titulo}`;
    default: return '';
  }
}

function mostrarError(msg) {
  const box = $('#errorBox');
  box.textContent = msg || '';
  box.style.display = msg ? 'block' : 'none';
}

function editando() {
  const a = document.activeElement;
  return !!a && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName) && !!a.closest('main');
}

/* ------------------------------------------------------------------------
   Carga de datos
   ------------------------------------------------------------------------ */
async function cargar({ silencioso = false } = {}) {
  try {
    const data = await api.flHub();
    S.data = data;
    S.soc = new Map(data.sociedades.map((s) => [s.id, s]));
    S.byId = {};
    for (const e of ['sociedades', 'modelos', 'notificaciones', 'juntas', 'apoderamientos', 'contratos', 'checklist']) {
      S.byId[e] = new Map(data[e].map((d) => [d.id, d]));
    }
    S.byId.alertas = new Map(data.alertas.map((a) => [a.id, a]));
    S.indice = L.construirIndice(data);
    if (S.cal.year === null) {
      S.cal.year = Number(data.hoy.slice(0, 4));
      S.cal.month = Number(data.hoy.slice(5, 7)) - 1;
    }
    mostrarError('');
    renderCabecera();
    S.sucio = new Set(HUB_TABS);
    renderSiSucio(S.tab);
  } catch (ex) {
    if (!silencioso || !S.data) mostrarError(`No se pudo cargar la mesa F&L: ${ex.message || ex}`);
  }
}

/* ------------------------------------------------------------------------
   Cabecera y pestañas
   ------------------------------------------------------------------------ */
function renderCabecera() {
  const { kpis, conectores, demo } = S.data;
  const badge = $('#flhBellBadge');
  badge.hidden = !kpis.notificaciones.sin_acuse;
  badge.textContent = kpis.notificaciones.sin_acuse;

  const b = conectores.boletines;
  const tono = b.estado === 'ok' ? 'ok' : b.estado === 'error' ? 'bad' : 'warn';
  const texto = b.sincronizando ? 'BOE · BORME · sincronizando'
    : b.estado === 'ok' ? `BOE · BORME · ${horaCorta(b.ultimo_ok)}`
      : b.estado === 'pendiente' ? 'BOE · BORME · sin sincronizar'
        : b.estado === 'degradado' ? 'BOE · BORME · parcial' : 'BOE · BORME · error';
  const sig = $('#flhSignalBoe');
  sig.innerHTML = `<span class="flh-dot flh-dot--${tono}"></span>${h(texto)}`;
  sig.title = b.error ? `Último error: ${b.error}` : 'Boletines sincronizados desde la API de datos abiertos del BOE';

  $('#flhDemo').hidden = !demo.registros;
  $('#flhDemoCount').textContent = demo.registros;

  const badgeTab = (tab, n) => {
    const el = $(`[data-badge="${tab}"]`);
    if (!el) return;
    el.hidden = !n;
    el.textContent = n;
  };
  badgeTab('fiscal', kpis.fiscal.vencidos_pendientes);
  badgeTab('gobtech', kpis.notificaciones.sin_acuse);
  badgeTab('corporativo', S.data.apoderamientos.filter((p) => ['por_caducar', 'caducado'].includes(p.calc.situacion)).length + kpis.societario.depositos_vencidos);
  badgeTab('clm', kpis.renovaciones.contratos);
}

function activarTab(tab) {
  S.tab = tab;
  for (const t of TABS) {
    const btn = $(`#tab-${t}`);
    if (!btn) continue;
    btn.setAttribute('aria-selected', String(t === tab));
    btn.tabIndex = t === tab ? 0 : -1;
    $(`#panel-${t}`).classList.toggle('is-active', t === tab);
  }
  renderSiSucio(tab);
  opciones.onTab?.(tab);
}

function irATab(tab) {
  if (!TABS.includes(tab) || $(`#tab-${tab}`)?.hidden) return;
  activarTab(tab);
  history.replaceState(null, '', `#${tab}`);
}

const RENDER = {
  overview: () => renderOverview(),
  fiscal: () => renderFiscal(),
  gobtech: () => renderGobtech(),
  corporativo: () => renderCorporativo(),
  clm: () => renderClm(),
};

function renderSiSucio(tab) {
  if (!S.data || !RENDER[tab] || !S.sucio.has(tab)) return;
  RENDER[tab]();
  S.sucio.delete(tab);
  tick();
}

function rerender(tab) {
  S.sucio.add(tab);
  renderSiSucio(tab);
}

function skeletons() {
  const sk = (alto) => `<div class="flh-skel" style="height:${alto}px;margin-bottom:14px"></div>`;
  for (const t of HUB_TABS) {
    $(`#panel-${t}`).innerHTML = t === 'overview'
      ? `<div class="flh-kpis">${[1, 2, 3, 4].map(() => '<div class="flh-skel" style="height:132px"></div>').join('')}</div>${sk(520)}`
      : `${sk(44)}${sk(420)}`;
  }
}

/* ------------------------------------------------------------------------
   Cuentas atras (un solo reloj para toda la pagina)
   ------------------------------------------------------------------------ */
function tick() {
  const ahora = Date.now();
  for (const el of $$('[data-deadline]')) {
    const ms = Number(el.dataset.deadline) - ahora;
    el.textContent = `${el.dataset.prefix || ''}${L.fmtCuentaAtras(ms)}`;
    const sev = L.severidadPlazo(ms);
    el.classList.add('flh-count');
    el.classList.toggle('flh-count--bad', sev === 'bad');
    el.classList.toggle('flh-count--warn', sev === 'warn');
  }
  const reloj = $('#flhClock');
  if (reloj) {
    reloj.textContent = new Date().toLocaleString('es-ES', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
}

function cuentaAtras(fechaIso, prefijo = '', titulo = '') {
  return `<span class="flh-count" data-deadline="${L.finDeDiaMs(fechaIso)}" data-prefix="${h(prefijo)}" title="${h(titulo)}"></span>`;
}

/* Plazo de una notificacion: acceso (rechazo presunto) o respuesta. */
function plazoNotif(n, { compacto = false } = {}) {
  const c = n.calc;
  if (c.urgencia === 'cerrada') {
    return n.respuesta ? `<span class="flh-muted">Respondida el ${h(L.fmtFecha(n.respuesta.fecha))}</span>` : '<span class="flh-muted">Cerrada</span>';
  }
  const sev = c.urgencia === 'critica' ? 'bad' : c.urgencia === 'alta' ? 'warn' : '';
  if (!n.acuse) {
    if (c.rechazo_presunto) return `${pill('Rechazo presunto', 'bad')}${compacto ? '' : `<span class="flh-cell-sub">Desde el ${h(L.fmtFecha(L.addDias(c.fecha_rechazo_presunto, 1)))}</span>`}`;
    const barra = `<div class="flh-progress${sev ? ` flh-progress--${sev}` : ''}"><i style="width:${c.progreso_pct ?? 0}%"></i></div>`;
    return compacto ? cuentaAtras(c.fecha_rechazo_presunto, '', 'Acceso antes del rechazo presunto')
      : `<div class="flh-plazo">${barra}${cuentaAtras(c.fecha_rechazo_presunto, 'Acceso: ', 'Tiempo para acceder antes del rechazo presunto (art. 43.2 Ley 39/2015)')}<span class="flh-cell-sub">Rechazo presunto tras el ${h(L.fmtFecha(c.fecha_rechazo_presunto))}</span></div>`;
  }
  if (n.fecha_limite_respuesta) {
    const barra = `<div class="flh-progress${sev ? ` flh-progress--${sev}` : ''}"><i style="width:${c.progreso_pct ?? 0}%"></i></div>`;
    return compacto ? cuentaAtras(n.fecha_limite_respuesta, '', 'Plazo de respuesta')
      : `<div class="flh-plazo">${barra}${cuentaAtras(n.fecha_limite_respuesta, 'Responder: ', 'Tiempo hasta el fin del plazo de respuesta')}<span class="flh-cell-sub">Límite ${h(L.fmtFecha(n.fecha_limite_respuesta))} · ${n.plazo_respuesta} ${h(opt('notificaciones', 'plazo_tipo', n.plazo_tipo).toLowerCase())}</span></div>`;
  }
  return '<span class="flh-muted">Sin plazo de respuesta</span>';
}

/* ------------------------------------------------------------------------
   1 · Centro de mando
   ------------------------------------------------------------------------ */
function renderOverview() {
  $('#panel-overview').innerHTML = `
    <div class="flh-kpis">${kpisHtml()}</div>
    <div class="flh-split">
      <section class="flh-card" id="flhCal" aria-label="Calendario fiscal y societario"></section>
      <aside class="flh-side">
        <section class="flh-card" id="flhBoletines" aria-label="Boletines oficiales"></section>
        <section class="flh-card" aria-label="Notificaciones urgentes">${urgentesHtml()}</section>
        <section class="flh-card" aria-label="Portales oficiales">${portalesHtml()}</section>
      </aside>
    </div>`;
  renderCalendario();
  renderBoletinesFeed();
}

function kpisHtml() {
  const { fiscal: f, notificaciones: n, boletines: b, renovaciones: r } = S.data.kpis;
  const prox = f.proximo;
  const nv = n.proximo_vencimiento;
  const tonoProx = prox ? (prox.dias <= 5 ? 'bad' : prox.dias <= 15 ? 'warn' : 'gold') : 'ok';
  return `
    <button type="button" class="flh-kpi${f.vencidos_pendientes ? ' flh-kpi--bad' : ''}" data-act="ir-tab" data-tab="fiscal" data-preset="fiscal-pendientes">
      <span class="flh-kpi__label">Cumplimiento fiscal</span>
      <span class="flh-kpi__value">${f.cumplimiento_pct === null ? '—' : h(fmtPct(f.cumplimiento_pct))}<small>en plazo</small></span>
      <span class="flh-kpi__sub">${f.pendientes} modelos pendientes · ${f.en_auditoria} en auditoría${f.vencidos_pendientes ? ` · <b>${f.vencidos_pendientes} vencidos</b>` : ''}</span>
      <span class="flh-kpi__foot">${prox ? pill(`Próximo: modelo ${prox.modelo} · ${prox.periodo} · ${L.fmtRelDias(prox.dias)} (${L.fmtFecha(prox.fecha_limite, { corta: true })})`, tonoProx) : pill('Sin vencimientos próximos', 'ok')}</span>
    </button>
    <button type="button" class="flh-kpi${n.criticas ? ' flh-kpi--bad' : n.pendientes ? ' flh-kpi--warn' : ''}" data-act="ir-tab" data-tab="gobtech" data-preset="gob-sin-acuse">
      <span class="flh-kpi__label">Notificaciones pendientes · DEHú</span>
      <span class="flh-kpi__value">${n.pendientes}<small>por revisar</small></span>
      <span class="flh-kpi__sub">${n.sin_acuse} sin acuse · ${n.criticas} críticas</span>
      <span class="flh-kpi__foot">${nv ? cuentaAtras(nv.fecha, nv.tipo === 'acceso' ? 'Rechazo presunto en ' : 'Respuesta en ') : pill('Sin plazos abiertos', 'ok')}</span>
    </button>
    <button type="button" class="flh-kpi${b.alta_7d ? ' flh-kpi--warn' : ''}" data-act="alertas">
      <span class="flh-kpi__label">Alertas BOE · BORME</span>
      <span class="flh-kpi__value">${b.nuevas_7d}<small>nuevas · 7 días</small></span>
      <span class="flh-kpi__sub">${b.alta_7d} de relevancia alta · ${b.borme_grupo_90d} publicaciones BORME del grupo</span>
      <span class="flh-kpi__foot">${pill(b.ultimo_ok ? `Sincronizado ${horaCorta(b.ultimo_ok)}` : 'Pendiente de sincronizar', b.error ? 'warn' : b.ultimo_ok ? 'ok' : 'muted')}${pill('Motor de reglas', 'muted')}</span>
    </button>
    <button type="button" class="flh-kpi${r.caducados ? ' flh-kpi--bad' : r.total ? ' flh-kpi--warn' : ''}" data-act="ir-tab" data-tab="clm">
      <span class="flh-kpi__label">Contratos y poderes por renovar</span>
      <span class="flh-kpi__value">${r.total}<small>&lt; 30 días</small></span>
      <span class="flh-kpi__sub">${r.contratos} contratos · ${r.poderes} poderes</span>
      <span class="flh-kpi__foot">${r.caducados ? pill(`${r.caducados} caducado${r.caducados > 1 ? 's' : ''}`, 'bad') : pill('Nada caducado', 'ok')}</span>
    </button>`;
}

function segmento(grupo, valor, items) {
  return `<div class="flh-seg" role="group" data-seg="${grupo}">${items.map(([v, l, n]) => `<button type="button" data-v="${h(v)}" aria-pressed="${String(v === valor)}">${h(l)}${n !== undefined ? `<span class="flh-seg__n">${n}</span>` : ''}</button>`).join('')}</div>`;
}

function renderCalendario() {
  const c = S.cal;
  const el = $('#flhCal');
  if (!el) return;
  const mesLabel = `${L.MESES[c.month]} ${c.year}`;
  el.innerHTML = `
    <div class="flh-card__head">
      <div><h2 class="flh-h">Calendario fiscal y societario</h2><p class="flh-sub">Modelos tributarios, juntas y depósitos, plazos de notificaciones, contratos y poderes.</p></div>
      <div class="flh-inline">
        ${segmento('cal.vista', c.vista, [['mes', 'Mes'], ['agenda', 'Agenda']])}
        ${c.vista === 'mes' ? `<div class="flh-cal__nav">
          <button type="button" class="flh-btn flh-btn--icon" data-act="cal-prev" aria-label="Mes anterior">${icon('left')}</button>
          <span class="flh-cal__month">${h(mesLabel)}</span>
          <button type="button" class="flh-btn flh-btn--icon" data-act="cal-next" aria-label="Mes siguiente">${icon('right')}</button>
          <button type="button" class="flh-btn flh-btn--sm" data-act="cal-hoy">Hoy</button>
        </div>` : '<span class="flh-tag">Próximos 60 días</span>'}
      </div>
    </div>
    <div class="flh-cal__filters">
      <div class="flh-chips">${TIPOS_EVENTO.map(([k, l]) => `<button type="button" class="flh-chip" data-act="cal-tipo" data-v="${k}" aria-pressed="${String(c.tipos.has(k))}"><span class="flh-dot" style="background:var(--flh-c-${k})"></span>${h(l)}</button>`).join('')}</div>
      ${segmento('cal.estado', c.estado, [['todos', 'Todos'], ['pendientes', 'Pendientes'], ['vencidos', 'Vencidos'], ['completados', 'Completados']])}
    </div>
    ${c.vista === 'mes' ? mesHtml() : agendaHtml()}`;
}

function mesHtml() {
  const c = S.cal;
  const d0 = hoy();
  const mapa = L.agruparEventos(S.data.calendario, { tipos: c.tipos, estado: c.estado });
  const celdas = L.mesGrid(c.year, c.month).map((iso) => {
    const evs = mapa.get(iso) || [];
    const cls = ['flh-cal__cell'];
    if (Number(iso.slice(5, 7)) - 1 !== c.month) cls.push('is-out');
    if (L.esFinDeSemana(iso)) cls.push('is-weekend');
    if (iso === d0) cls.push('is-today');
    if (iso === c.dia) cls.push('is-selected');
    const pills = evs.slice(0, 3).map((e) => `<span class="flh-ev flh-ev--${e.tipo}${e.estado === 'completado' ? ' is-done' : ''}${e.estado === 'vencido' ? ' is-late' : ''}" title="${h(`${e.titulo} · ${e.sub}`)}">${h(e.titulo)}</span>`).join('');
    const dots = evs.slice(0, 8).map((e) => `<i style="--ev:var(--flh-c-${e.tipo})"></i>`).join('');
    return `<button type="button" class="${cls.join(' ')}" data-act="cal-dia" data-fecha="${iso}" aria-label="${h(`${L.fmtFechaLarga(iso)}: ${evs.length} eventos`)}"><span class="flh-cal__day">${Number(iso.slice(8))}</span>${pills}${evs.length > 3 ? `<span class="flh-cal__more">+${evs.length - 3} más</span>` : ''}<span class="flh-cal__dots">${dots}</span></button>`;
  }).join('');
  return `<div class="flh-cal__grid">${L.DIAS_SEMANA.map((d) => `<div class="flh-cal__dow">${d}</div>`).join('')}${celdas}</div>${diaPanelHtml(mapa)}`;
}

function filaEvento(e, { conFecha = false } = {}) {
  const ref = e.ref ? `data-act="evento" data-entidad="${e.ref.entidad}" data-id="${h(e.ref.id)}"` : 'disabled';
  const estado = e.estado === 'vencido' ? pill('Vencido', 'bad') : e.estado === 'completado' ? pill('Completado', 'ok') : e.estado === 'informativo' ? pill('Recordatorio', 'muted') : pill('Pendiente', 'warn');
  return `<button type="button" class="flh-evrow" style="--ev:var(--flh-c-${e.tipo})" ${ref}><span class="flh-evrow__dot"></span><span style="min-width:0"><span class="flh-evrow__t">${h(e.titulo)}</span><span class="flh-evrow__s">${conFecha ? `${h(L.fmtFecha(e.fecha))} · ` : ''}${h(e.sub || '')}</span></span>${estado}</button>`;
}

function diaPanelHtml(mapa) {
  const c = S.cal;
  if (c.dia) {
    const evs = mapa.get(c.dia) || [];
    return `<div class="flh-cal__daypanel"><div class="flh-inline" style="justify-content:space-between;margin-bottom:8px"><h3 class="flh-h">${h(L.fmtFechaLarga(c.dia))}</h3><button type="button" class="flh-btn flh-btn--sm" data-act="cal-dia" data-fecha="">Ver próximos</button></div>${evs.length ? evs.map((e) => filaEvento(e)).join('') : '<p class="flh-muted" style="margin:0;font-size:0.8rem">Sin eventos este día con los filtros activos.</p>'}</div>`;
  }
  const d0 = hoy();
  const proximos = S.data.calendario
    .filter((e) => c.tipos.has(e.tipo) && e.fecha >= d0 && e.estado !== 'completado' && e.estado !== 'informativo')
    .slice(0, 6);
  return `<div class="flh-cal__daypanel"><h3 class="flh-h" style="margin-bottom:8px">Próximos vencimientos</h3>${proximos.length ? proximos.map((e) => filaEvento(e, { conFecha: true })).join('') : '<p class="flh-muted" style="margin:0;font-size:0.8rem">Nada pendiente en el horizonte con los filtros activos.</p>'}</div>`;
}

function agendaHtml() {
  const c = S.cal;
  const d0 = hoy();
  const hasta = L.addDias(d0, 60);
  const mapa = L.agruparEventos(S.data.calendario, { tipos: c.tipos, estado: c.estado });
  const vencidos = [...mapa.entries()].filter(([f]) => f < d0).flatMap(([, evs]) => evs.filter((e) => e.estado === 'vencido'));
  const dias = [...mapa.keys()].filter((f) => f >= d0 && f <= hasta).sort();
  const bloqueVencidos = vencidos.length ? `<div class="flh-agenda__day"><div class="flh-agenda__date"><b style="color:var(--flh-bad-text)">Vencidos</b>sin resolver</div><div>${vencidos.map((e) => filaEvento(e, { conFecha: true })).join('')}</div></div>` : '';
  if (!dias.length && !vencidos.length) return '<div class="flh-empty">Sin eventos en los próximos 60 días con los filtros activos.</div>';
  return `<div class="flh-agenda">${bloqueVencidos}${dias.map((f) => `<div class="flh-agenda__day"><div class="flh-agenda__date"><b>${h(L.fmtFecha(f, { corta: true }))}</b>${h(L.fmtRelDias(L.diffDias(d0, f)))}</div><div>${mapa.get(f).map((e) => filaEvento(e)).join('')}</div></div>`).join('')}</div>`;
}

function alertasPriorizadas() {
  const peso = { alta: 0, media: 1, baja: 2 };
  return [...S.data.alertas]
    .filter((a) => a.estado !== 'descartada')
    .sort((a, b) => Number(a.estado !== 'nueva') - Number(b.estado !== 'nueva')
      || (peso[a.relevancia] - peso[b.relevancia])
      || b.fecha_publicacion.localeCompare(a.fecha_publicacion));
}

function itemAlerta(a) {
  const [rl, rt] = RELEVANCIA[a.relevancia] ?? ['—', 'muted'];
  const soc = a.sociedad_id ? pill(nombreSoc(a.sociedad_id), 'gold') : '';
  return `<li><button type="button" class="flh-feeditem" data-act="alerta" data-id="${h(a.id)}">
    <span class="flh-feeditem__meta">${pill(a.fuente, a.fuente === 'BORME' ? 'gold' : 'info')}${pill(rl, rt)}${soc}<span class="flh-tag">${h(L.fmtFecha(a.fecha_publicacion, { corta: true }))}</span>${a.estado !== 'nueva' ? pill(a.estado === 'revisada' ? 'Revisada' : 'Descartada', 'muted') : ''}</span>
    <span class="flh-feeditem__title">${h(a.titulo)}</span>
    <span class="flh-feeditem__sub">${h(a.acto || a.departamento || a.seccion_nombre || '')}</span>
  </button></li>`;
}

function renderBoletinesFeed() {
  const el = $('#flhBoletines');
  if (!el) return;
  const b = S.data.conectores.boletines;
  const todas = alertasPriorizadas();
  const lista = todas.filter((a) => a.relevancia !== 'baja').slice(0, 6);
  const relleno = lista.length < 6 ? todas.filter((a) => a.relevancia === 'baja').slice(0, 6 - lista.length) : [];
  const items = [...lista, ...relleno];
  el.innerHTML = `
    <div class="flh-card__head">
      <h2 class="flh-h"><span class="flh-dot ${b.estado === 'ok' ? 'flh-dot--live' : b.estado === 'error' ? 'flh-dot--bad' : 'flh-dot--warn'}"></span>Boletines oficiales <small>BOE · BORME</small></h2>
      <button type="button" class="flh-btn flh-btn--icon" data-act="sync" title="Sincronizar ahora" aria-label="Sincronizar boletines">${icon('refresh')}</button>
    </div>
    ${items.length ? `<ul class="flh-feed">${items.map(itemAlerta).join('')}</ul>`
      : `<div class="flh-feed__empty">${b.ultimo_ok ? 'Sin coincidencias en los últimos 60 días: ninguna disposición del BOE supera las reglas de relevancia y el BORME no publica nada de las sociedades del grupo.' : 'Aún no se ha sincronizado con el BOE. La primera sincronización se lanza al arrancar el servidor y luego cada 6 horas.'}</div>`}
    <div class="flh-card__foot"><span class="flh-tag">${b.ultimo_ok ? `Última sincronización ${h(horaCorta(b.ultimo_ok))}` : 'Sin sincronizar'}</span><button type="button" class="flh-btn flh-btn--sm" data-act="alertas">Ver todas (${S.data.alertas.length})</button></div>`;
}

function urgentesHtml() {
  const peso = { critica: 0, alta: 1, normal: 2 };
  const abiertas = S.data.notificaciones.filter((n) => n.calc.urgencia !== 'cerrada')
    .sort((a, b) => (peso[a.calc.urgencia] - peso[b.calc.urgencia])
      || String(a.calc.fecha_rechazo_presunto && !a.acuse ? a.calc.fecha_rechazo_presunto : a.fecha_limite_respuesta || '9999')
        .localeCompare(String(b.calc.fecha_rechazo_presunto && !b.acuse ? b.calc.fecha_rechazo_presunto : b.fecha_limite_respuesta || '9999')))
    .slice(0, 5);
  const items = abiertas.map((n) => `<li><button type="button" class="flh-feeditem" data-act="abrir" data-entidad="notificaciones" data-id="${h(n.id)}">
    <span class="flh-urgent"><span class="flh-code${n.calc.urgencia === 'critica' ? '' : ' flh-code--gold'}">${h(n.emisor_siglas || 'AA.PP.')}</span>
    <span class="flh-urgent__body"><span class="flh-urgent__title">${h(n.asunto)}</span><span class="flh-feeditem__sub">${h(nombreSoc(n.sociedad_id))} · ${n.acuse ? 'acuse registrado' : 'sin acuse'}${n.placeholder ? ' · demo' : ''}</span></span>
    ${plazoNotif(n, { compacto: true })}</span></button></li>`).join('');
  return `<div class="flh-card__head"><h2 class="flh-h">Notificaciones urgentes <small>DEHú y sedes</small></h2><button type="button" class="flh-btn flh-btn--sm" data-act="ir-tab" data-tab="gobtech">GobTech</button></div>
    ${items ? `<ul class="flh-feed">${items}</ul>` : '<div class="flh-feed__empty">Ninguna notificación abierta.</div>'}`;
}

function portalesHtml() {
  return `<div class="flh-card__head"><h2 class="flh-h">Accesos oficiales</h2><span class="flh-tag">Se abren en pestaña nueva</span></div>
    <div class="flh-portals">${S.data.meta.portales.map((p) => `<a class="flh-portal" href="${h(p.url)}" target="_blank" rel="noopener noreferrer"><span>${h(p.label)}</span>${icon('external', 12)}</a>`).join('')}</div>`;
}

/* ------------------------------------------------------------------------
   2 · Fiscalidad y auditoria
   ------------------------------------------------------------------------ */
function opcionesSociedad(sel, todas) {
  return `${todas ? `<option value="">${h(todas)}</option>` : ''}${S.data.sociedades.map((s) => `<option value="${h(s.id)}"${s.id === sel ? ' selected' : ''}>${h(s.nombre_corto)}</option>`).join('')}`;
}

function renderFiscal() {
  const f = S.fiscal;
  const ejercicios = [...new Set(S.data.modelos.map((m) => m.ejercicio))].sort((a, b) => b - a);
  const admins = [...new Set(S.data.modelos.map((m) => m.administracion))];
  $('#panel-fiscal').innerHTML = `
    <div class="flh-toolbar">
      <select class="flh-select" data-filtro="fiscal.sociedad" aria-label="Sociedad">${opcionesSociedad(f.sociedad, 'Todas las sociedades')}</select>
      <select class="flh-select" data-filtro="fiscal.ejercicio" aria-label="Ejercicio"><option value="">Todos los ejercicios</option>${ejercicios.map((y) => `<option value="${y}"${String(y) === String(f.ejercicio) ? ' selected' : ''}>Ejercicio ${y}</option>`).join('')}</select>
      <select class="flh-select" data-filtro="fiscal.administracion" aria-label="Administración"><option value="">Todas las administraciones</option>${admins.map((a) => `<option value="${h(a)}"${a === f.administracion ? ' selected' : ''}>${h(opt('modelos', 'administracion', a))}</option>`).join('')}</select>
      ${segmento('fiscal.estado', f.estado, [['', 'Todos'], ['pendiente', 'Pendiente'], ['vencido', 'Vencido'], ['en_auditoria', 'En auditoría'], ['liquidado', 'Liquidado']])}
      <input class="flh-input flh-input--search flh-grow" type="search" placeholder="Modelo, concepto o justificante" data-filtro="fiscal.q" value="${h(f.q)}" aria-label="Buscar modelos">
      <button type="button" class="flh-btn flh-btn--gold" data-act="nuevo" data-entidad="modelos">${icon('plus', 14)}Nuevo modelo</button>
    </div>
    <div id="flhFiscalRes"></div>
    <div class="flh-grid-2 flh-section">
      <section class="flh-card" id="flhChecklist" aria-label="Checklist NIA-ES"></section>
      <section class="flh-card" id="flhNormas" aria-label="Consulta normativa"></section>
    </div>`;
  renderFiscalResultados();
  renderChecklist();
  renderNormas();
}

function renderFiscalResultados() {
  const lista = L.filtrarModelos(S.data.modelos, S.fiscal).sort((a, b) => {
    const pa = a.estado === 'pendiente' ? 0 : 1;
    const pb = b.estado === 'pendiente' ? 0 : 1;
    if (pa !== pb) return pa - pb;
    return pa === 0 ? a.fecha_limite.localeCompare(b.fecha_limite) : b.fecha_limite.localeCompare(a.fecha_limite);
  });
  const cuenta = (fn) => lista.filter(fn).length;
  const aIngresar = lista.filter((m) => m.estado === 'pendiente' && m.resultado === 'a_ingresar').reduce((acc, m) => acc + (m.importe_cents || 0), 0);
  const vencidos = cuenta((m) => m.calc.vencido);
  const visibles = S.fiscalTodos ? lista : lista.slice(0, FILAS_FISCAL);
  const filas = visibles.map((m) => {
    const d = m.calc.dias;
    const sub = m.estado === 'pendiente'
      ? `<span class="flh-cell-sub" style="color:var(--flh-${m.calc.vencido || d <= 5 ? 'bad' : d <= 15 ? 'warn' : 'info'}-text)">${h(L.fmtRelDias(d))}</span>`
      : `<span class="flh-cell-sub">${m.presentado_at ? `Presentado ${h(L.fmtFecha(m.presentado_at, { corta: true }))}` : 'Presentado'}${m.calc.fuera_plazo ? ' · <b style="color:var(--flh-bad-text)">fuera de plazo</b>' : ''}</span>`;
    return `<tr class="is-click" data-act="abrir" data-entidad="modelos" data-id="${h(m.id)}">
      <td class="nowrap"><span class="flh-code flh-code--gold">${h(m.modelo)}</span> <span class="flh-tag">${h(ADMIN_CORTA[m.administracion] || m.administracion)}</span></td>
      <td><span class="flh-cell-main">${h(m.concepto)}</span><span class="flh-cell-sub">${h(nombreSoc(m.sociedad_id))}${m.placeholder ? ' · demo' : ''}</span></td>
      <td class="nowrap mono">${h(m.periodo)} ${m.ejercicio}</td>
      <td class="nowrap">${h(L.fmtFecha(m.fecha_limite))}${sub}</td>
      <td>${m.calc.vencido ? pill('Vencido', 'bad') : pill(opt('modelos', 'estado', m.estado), TONO_MODELO[m.estado])}</td>
      <td class="r mono nowrap">${m.importe_cents !== null && m.importe_cents !== undefined ? h(L.fmtEur(m.importe_cents)) : '—'}<span class="flh-cell-sub">${h(m.resultado ? opt('modelos', 'resultado', m.resultado) : '')}</span></td>
      <td class="r"><span class="flh-actions">
        <button type="button" class="flh-btn flh-btn--icon" data-act="pdf" data-entidad="modelos" data-id="${h(m.id)}" title="Ficha PDF del modelo">${icon('file')}</button>
        <button type="button" class="flh-btn flh-btn--icon" data-act="historial" data-entidad="modelos" data-id="${h(m.id)}" title="Audit trail (fl_log)">${icon('history')}</button>
      </span></td>
    </tr>`;
  }).join('');
  $('#flhFiscalRes').innerHTML = `
    <div class="flh-stats">
      <div class="flh-stat"><div class="flh-stat__l">Modelos</div><div class="flh-stat__v">${lista.length}</div></div>
      <div class="flh-stat"><div class="flh-stat__l">Pendientes</div><div class="flh-stat__v${cuenta((m) => m.estado === 'pendiente') ? ' is-warn' : ''}">${cuenta((m) => m.estado === 'pendiente')}</div></div>
      <div class="flh-stat"><div class="flh-stat__l">Vencidos</div><div class="flh-stat__v${vencidos ? ' is-bad' : ''}">${vencidos}</div></div>
      <div class="flh-stat"><div class="flh-stat__l">En auditoría</div><div class="flh-stat__v">${cuenta((m) => m.estado === 'en_auditoria')}</div></div>
      <div class="flh-stat"><div class="flh-stat__l">Liquidados</div><div class="flh-stat__v">${cuenta((m) => m.estado === 'liquidado')}</div></div>
      <div class="flh-stat"><div class="flh-stat__l">A ingresar (pendiente)</div><div class="flh-stat__v mono">${h(L.fmtEur(aIngresar))}</div></div>
    </div>
    <section class="flh-card">
      <div class="flh-tablewrap"><table class="flh-table">
        <thead><tr><th>Modelo</th><th>Concepto · sociedad</th><th>Periodo</th><th>Vencimiento</th><th>Estado</th><th class="r">Importe</th><th class="r">Docs</th></tr></thead>
        <tbody>${filas || '<tr><td colspan="7" class="flh-empty">Ningún modelo con estos filtros.</td></tr>'}</tbody>
      </table></div>
      ${lista.length > FILAS_FISCAL ? `<div class="flh-more"><button type="button" class="flh-btn flh-btn--sm" data-act="fiscal-todos">${S.fiscalTodos ? 'Mostrar solo los primeros' : `Mostrar los ${lista.length - FILAS_FISCAL} restantes`}</button></div>` : ''}
    </section>`;
}

const CICLO_CHECK = { pendiente: 'en_curso', en_curso: 'completado', completado: 'pendiente', no_aplica: 'pendiente' };

function renderChecklist() {
  const el = $('#flhChecklist');
  const lista = [...S.data.checklist].sort((a, b) => String(a.fecha_objetivo || '9999').localeCompare(String(b.fecha_objetivo || '9999')));
  const k = S.data.kpis.auditoria;
  const ejercicio = lista[0]?.ejercicio ?? '—';
  el.innerHTML = `
    <div class="flh-card__head">
      <div class="flh-inline" style="gap:12px">
        <div class="flh-ring" style="--p:${k.pct ?? 0}"><span>${k.pct ?? 0}%</span></div>
        <div><h2 class="flh-h">Checklist NIA-ES <small>auditoría externa</small></h2><p class="flh-sub">Ejercicio ${h(ejercicio)} · ${k.completados}/${k.total} completados${k.atrasados ? ` · <b style="color:var(--flh-bad-text)">${k.atrasados} atrasados</b>` : ''}</p></div>
      </div>
      <button type="button" class="flh-btn flh-btn--sm" data-act="nuevo" data-entidad="checklist">${icon('plus', 13)}Punto</button>
    </div>
    <div>${lista.map((p) => `
      <div class="flh-check">
        <button type="button" class="flh-check__btn" data-act="check-ciclo" data-id="${h(p.id)}" data-estado="${h(p.estado)}" title="${h(`${opt('checklist', 'estado', p.estado)} · pulsa para pasar a ${opt('checklist', 'estado', CICLO_CHECK[p.estado])}`)}" aria-label="Cambiar estado">${p.estado === 'completado' ? icon('check', 13) : ''}</button>
        <div style="min-width:0;cursor:pointer" data-act="abrir" data-entidad="checklist" data-id="${h(p.id)}">
          <div class="flh-check__title${p.estado === 'completado' ? ' is-done' : ''}"><span class="flh-code">${h(p.nia)}</span> ${h(p.titulo)}</div>
          <p class="flh-check__req">${h(p.requerimiento || '')}</p>
        </div>
        <div class="flh-check__meta">${h(p.responsable || '')}<br>${p.fecha_objetivo ? h(`${L.fmtFecha(p.fecha_objetivo, { corta: true })} · ${L.fmtRelDias(p.calc.dias)}`) : ''}${p.calc.atrasado ? `<br>${pill('Atrasado', 'bad')}` : ''}</div>
      </div>`).join('') || '<div class="flh-empty">Sin puntos de auditoría.</div>'}</div>`;
}

function normasFiltradas() {
  const q = L.normalizar(S.normasQ).trim();
  if (!q) return S.data.meta.normas;
  const terminos = q.split(/\s+/);
  return S.data.meta.normas.filter((n) => {
    const texto = L.normalizar([n.ref, n.titulo, n.ambito, n.id, ...n.articulos.map((a) => `art ${a.art} art. ${a.art} ${a.tema}`)].join(' '));
    return terminos.every((t) => texto.includes(t));
  });
}

function renderNormas() {
  const el = $('#flhNormas');
  el.innerHTML = `
    <div class="flh-card__head"><div><h2 class="flh-h">Consulta normativa</h2><p class="flh-sub">Textos consolidados del BOE con los artículos de referencia del grupo.</p></div></div>
    <div class="flh-card__body" style="padding-bottom:8px"><input class="flh-input flh-input--search" style="width:100%" type="search" placeholder="Norma, artículo o materia (operaciones vinculadas, art. 43…)" data-filtro="normasQ" value="${h(S.normasQ)}" aria-label="Buscar normativa"></div>
    <div id="flhNormasLista">${normasListaHtml()}</div>
    <div class="flh-dgt">
      <h3 class="flh-h">Doctrina de la DGT <small>consultas vinculantes</small></h3>
      <p class="flh-sub">Con número de consulta (p. ej. V1366-24) se abre directamente; con una materia se abre el buscador oficial, donde se completa la búsqueda.</p>
      <form data-form="dgt"><input class="flh-input" name="q" placeholder="Número de consulta o materia" aria-label="Consulta DGT"><button type="submit" class="flh-btn flh-btn--gold">Consultar DGT ${icon('external', 13)}</button></form>
    </div>`;
}

function normasListaHtml() {
  const lista = normasFiltradas();
  if (!lista.length) return '<div class="flh-empty">Ninguna norma del índice coincide. Prueba en el buscador de la DGT o en boe.es.</div>';
  return lista.map((n) => `
    <div class="flh-norma">
      <div class="flh-norma__head"><span class="flh-code flh-code--gold">${h(n.ref)}</span>${pill(n.ambito, 'muted')}${n.id ? `<span class="flh-tag">${h(n.id)}</span>` : ''}</div>
      <p class="flh-norma__title">${h(n.titulo)}</p>
      ${n.articulos.length ? `<ul class="flh-norma__arts">${n.articulos.map((a) => `<li><a href="${h(a.url)}" target="_blank" rel="noopener noreferrer"><b>Art. ${h(a.art)}</b>${h(a.tema)}</a></li>`).join('')}</ul>` : ''}
      <div style="margin-top:6px">${n.url ? `<a class="flh-link" href="${h(n.url)}" target="_blank" rel="noopener noreferrer">Texto consolidado (BOE) ${icon('external', 11)}</a>` : `<span class="flh-tag">${h(n.fuente || '')}</span>`}</div>
    </div>`).join('');
}

function consultarDgt(q) {
  const base = S.data.meta.dgt_url;
  const t = q.trim();
  const num = t.toUpperCase().replace(/\s+/g, '');
  const url = /^[VR]?\d{3,5}-\d{2}$/.test(num) ? `${base}?num_consulta=${encodeURIComponent(num)}` : base;
  window.open(url, '_blank', 'noopener');
  if (t && url === base) toast('Buscador de la DGT abierto: introduce allí la materia');
}

/* ------------------------------------------------------------------------
   3 · GobTech · notificaciones de las AA.PP.
   ------------------------------------------------------------------------ */
function renderGobtech() {
  const g = S.gob;
  const lista = S.data.notificaciones;
  const n = (fn) => lista.filter(fn).length;
  const emisores = [...new Set(lista.map((x) => x.emisor_siglas || x.emisor))].sort();
  const portal = (key) => S.data.meta.portales.find((p) => p.key === key);
  const sinAcuse = n((x) => !x.acuse && x.estado !== 'archivada');
  $('#panel-gobtech').innerHTML = `
    <div class="flh-stats">
      <div class="flh-stat"><div class="flh-stat__l">Sin acuse</div><div class="flh-stat__v${sinAcuse ? ' is-bad' : ''}">${sinAcuse}</div></div>
      <div class="flh-stat"><div class="flh-stat__l">Pendientes</div><div class="flh-stat__v${n((x) => x.estado === 'pendiente') ? ' is-warn' : ''}">${n((x) => x.estado === 'pendiente')}</div></div>
      <div class="flh-stat"><div class="flh-stat__l">Asignadas a abogado</div><div class="flh-stat__v">${n((x) => x.estado === 'asignada')}</div></div>
      <div class="flh-stat"><div class="flh-stat__l">Respondidas</div><div class="flh-stat__v">${n((x) => x.estado === 'respondida')}</div></div>
      <div class="flh-stat"><div class="flh-stat__l">Archivadas</div><div class="flh-stat__v">${n((x) => x.estado === 'archivada')}</div></div>
    </div>
    <div class="flh-note">${icon('info', 16)}<span><b>Sin conector con la DEHú.</b> Registra cada notificación al verla en la DEHú o en la sede: la mesa calcula el rechazo presunto a los diez días naturales (art. 43.2 Ley 39/2015) y el plazo de respuesta desde el acuse (art. 30, sin festivos: cómputo conservador). La comparecencia legal se hace siempre en la sede, con el certificado de la sociedad.
      <span class="flh-inline" style="margin-top:8px">${['dehu', 'aeat', 'tgss', 'hfn'].map((k) => portal(k)).filter(Boolean).map((p) => `<a class="flh-btn flh-btn--sm" href="${h(p.url)}" target="_blank" rel="noopener noreferrer">${h(p.label.split(' · ')[0])} ${icon('external', 11)}</a>`).join('')}</span></span></div>
    <div class="flh-toolbar">
      ${segmento('gob.estado', g.estado, [['abiertas', 'Abiertas'], ['sin_acuse', 'Sin acuse', sinAcuse], ['pendiente', 'Pendientes'], ['asignada', 'Asignadas'], ['respondida', 'Respondidas'], ['archivada', 'Archivadas'], ['todas', 'Todas']])}
      <select class="flh-select" data-filtro="gob.emisor" aria-label="Emisor"><option value="">Todos los emisores</option>${emisores.map((e) => `<option value="${h(e)}"${e === g.emisor ? ' selected' : ''}>${h(e)}</option>`).join('')}</select>
      <select class="flh-select" data-filtro="gob.sociedad" aria-label="Receptor">${opcionesSociedad(g.sociedad, 'Todos los receptores')}</select>
      <input class="flh-input flh-input--search flh-grow" type="search" placeholder="Expediente, asunto u organismo" data-filtro="gob.q" value="${h(g.q)}" aria-label="Buscar notificaciones">
      <button type="button" class="flh-btn flh-btn--gold" data-act="nuevo" data-entidad="notificaciones">${icon('plus', 14)}Registrar notificación</button>
    </div>
    <section class="flh-card"><div class="flh-tablewrap" id="flhGobRes"></div></section>`;
  renderGobtechResultados();
}

function renderGobtechResultados() {
  const lista = L.filtrarNotificaciones(S.data.notificaciones, S.gob);
  const filas = lista.map((n) => {
    const abierta = n.calc.urgencia !== 'cerrada';
    const firmar = abierta && !n.acuse;
    return `<tr class="is-click" data-act="abrir" data-entidad="notificaciones" data-id="${h(n.id)}">
      <td><span class="flh-cell-main">${h(nombreSoc(n.sociedad_id))}</span><span class="flh-cell-sub">${h(opt('notificaciones', 'canal', n.canal))}</span></td>
      <td><span class="flh-code${n.calc.urgencia === 'critica' ? '' : ' flh-code--gold'}">${h(n.emisor_siglas || 'AA.PP.')}</span><span class="flh-cell-sub flh-cell-clamp" style="max-width:220px">${h(n.emisor)}</span></td>
      <td><span class="flh-cell-sub mono">${h(n.expediente)}</span><span class="flh-cell-main flh-cell-clamp">${h(n.asunto)}</span></td>
      <td>${plazoNotif(n)}</td>
      <td><span class="flh-inline" style="gap:4px">${pill(ESTADO_NOTIF[n.estado] || n.estado, TONO_NOTIF[n.estado])}${n.placeholder ? DEMO : ''}</span>${n.abogado_asignado ? `<span class="flh-cell-sub">${h(n.abogado_asignado)}</span>` : ''}</td>
      <td class="r"><button type="button" class="flh-btn flh-btn--sm${firmar ? ' flh-btn--gold' : ''}" data-act="abrir" data-entidad="notificaciones" data-id="${h(n.id)}">${firmar ? `${icon('sign', 14)}Ver / firmar recepción` : 'Ver notificación'}</button></td>
    </tr>`;
  }).join('');
  $('#flhGobRes').innerHTML = `<table class="flh-table">
    <thead><tr><th>Receptor</th><th>Emisor</th><th>Expediente · asunto</th><th>Plazo</th><th>Estado</th><th class="r">Acción</th></tr></thead>
    <tbody>${filas || '<tr><td colspan="6" class="flh-empty">Ninguna notificación con estos filtros.</td></tr>'}</tbody>
  </table>`;
}

/* ------------------------------------------------------------------------
   4 · Gobierno corporativo y mercantil
   ------------------------------------------------------------------------ */
function renderCorporativo() {
  const d = S.data;
  const watch = d.sociedades.reduce((acc, s) => acc + 1 + (s.borme_alias?.length || 0), 0);
  const borme = d.alertas.filter((a) => a.fuente === 'BORME' && a.sociedad_id);
  $('#panel-corporativo').innerHTML = `
    <div class="flh-inline" style="justify-content:space-between;margin-bottom:12px">
      <div><h2 class="flh-h">Registro societario del grupo</h2><p class="flh-sub">Ficha mercantil de cada sociedad, vigilada a diario en el BORME por su denominación social (el BORME no indexa por NIF).</p></div>
      <button type="button" class="flh-btn flh-btn--gold" data-act="nuevo" data-entidad="sociedades">${icon('plus', 14)}Nueva sociedad</button>
    </div>
    <div class="flh-entities">${d.sociedades.map(fichaSociedad).join('') || '<div class="flh-empty">Sin sociedades registradas.</div>'}</div>

    <section class="flh-card flh-section" aria-label="Libro de actas y juntas">
      <div class="flh-card__head">
        <div><h2 class="flh-h">Libro de actas y juntas</h2><p class="flh-sub">Convocatoria, celebración, acta y formalización; plazo de depósito de cuentas (art. 279 LSC).</p></div>
        <div class="flh-inline"><select class="flh-select" data-filtro="corp.sociedad" aria-label="Sociedad">${opcionesSociedad(S.corp.sociedad, 'Todas las sociedades')}</select><button type="button" class="flh-btn flh-btn--gold" data-act="nuevo" data-entidad="juntas">${icon('plus', 14)}Nueva junta</button></div>
      </div>
      <div class="flh-tablewrap" id="flhJuntasRes"></div>
    </section>

    <section class="flh-card flh-section" aria-label="Matriz de apoderamientos">
      <div class="flh-card__head">
        <div><h2 class="flh-h">Matriz de apoderamientos y poderes notariales</h2><p class="flh-sub">Límites cuantitativos de firma, régimen de actuación y caducidad.</p></div>
        <button type="button" class="flh-btn flh-btn--gold" data-act="nuevo" data-entidad="apoderamientos">${icon('plus', 14)}Nuevo poder</button>
      </div>
      <div class="flh-tablewrap">${tablaPoderes()}</div>
    </section>

    <section class="flh-card flh-section" aria-label="Publicaciones BORME">
      <div class="flh-card__head"><div><h2 class="flh-h"><span class="flh-dot flh-dot--live"></span>Publicaciones BORME del grupo <small>datos reales</small></h2><p class="flh-sub">Sección primera (actos inscritos, vía índice alfabético diario) y segunda (anuncios). ${watch} denominaciones vigiladas.</p></div>
      <a class="flh-btn flh-btn--sm" href="https://www.boe.es/diario_borme/" target="_blank" rel="noopener noreferrer">BORME de hoy ${icon('external', 11)}</a></div>
      ${borme.length ? `<ul class="flh-feed">${borme.map(itemAlerta).join('')}</ul>` : '<div class="flh-feed__empty">Sin publicaciones de las sociedades del grupo en los últimos 60 días.</div>'}
    </section>`;
  renderJuntas();
}

function fichaSociedad(s) {
  const [rl, rt] = ROL[s.rol] ?? [s.rol, 'muted'];
  const borme = S.data.alertas.filter((a) => a.fuente === 'BORME' && a.sociedad_id === s.id).length;
  const fila = (dt, dd) => (dd ? `<dt>${dt}</dt><dd>${dd}</dd>` : '');
  return `<article class="flh-entity">
    <div class="flh-entity__top">${pill(rl, rt)}<span class="flh-inline" style="gap:4px">${s.placeholder ? DEMO : ''}${s.estado !== 'activa' ? pill(opt('sociedades', 'estado', s.estado), 'warn') : ''}</span></div>
    <h3 class="flh-entity__name">${h(s.nombre_corto)}</h3>
    <p class="flh-entity__legal">${h(s.denominacion)}</p>
    <dl>
      ${fila('NIF', s.nif ? `<span class="flh-nif">${h(s.nif)}<button type="button" class="flh-copy" data-act="copiar" data-texto="${h(s.nif)}" aria-label="Copiar NIF">${icon('copy', 12)}</button></span>` : '—')}
      ${fila('Forma', h(`${s.forma || '—'} · ${opt('sociedades', 'administracion', s.administracion)}`))}
      ${fila('Domicilio', h(s.domicilio || ''))}
      ${fila('Registro', h([s.registro_mercantil, s.datos_registrales].filter(Boolean).join(' · ')))}
      ${fila('Órgano', h([s.organo_administracion ? opt('sociedades', 'organo_administracion', s.organo_administracion) : null, s.administradores].filter(Boolean).join(': ')))}
      ${fila('Socio', h(s.socio_unico ? `${s.socio_unico}${s.participacion_pct ? ` (${String(s.participacion_pct).replace('.', ',')} %)` : ''}` : ''))}
      ${fila('Capital', s.capital_social_cents ? `<span class="mono">${h(L.fmtEur(s.capital_social_cents))}</span>` : '')}
    </dl>
    <div class="flh-entity__foot"><span class="flh-tag">${borme ? `${borme} publicaci${borme > 1 ? 'ones' : 'ón'} BORME` : 'BORME sin publicaciones'}</span>
      <span class="flh-actions"><button type="button" class="flh-btn flh-btn--icon" data-act="pdf" data-entidad="sociedades" data-id="${h(s.id)}" title="Ficha PDF">${icon('file')}</button><button type="button" class="flh-btn flh-btn--sm" data-act="abrir" data-entidad="sociedades" data-id="${h(s.id)}">Ficha</button></span></div>
  </article>`;
}

function stepper(estado) {
  const paso = L.pasoJunta(estado);
  return `<span class="flh-stepper" aria-label="${h(opt('juntas', 'estado', estado))}">${L.PASOS_JUNTA.map((_, i) => `${i ? `<b class="${i <= paso ? 'is-done' : ''}"></b>` : ''}<i class="${i < paso ? 'is-done' : i === paso ? (paso === 3 ? 'is-done' : 'is-current') : ''}"></i>`).join('')}</span>`;
}

function renderJuntas() {
  const lista = S.data.juntas.filter((j) => !S.corp.sociedad || j.sociedad_id === S.corp.sociedad);
  const filas = lista.map((j) => {
    const c = j.calc;
    const deposito = c.deposito_vencido ? pill('Depósito fuera de plazo', 'bad')
      : c.deposito_limite && j.estado !== 'formalizada' ? pill(`Depósito antes del ${L.fmtFecha(c.deposito_limite, { corta: true })}`, 'warn') : '';
    return `<tr class="is-click" data-act="abrir" data-entidad="juntas" data-id="${h(j.id)}">
      <td class="nowrap">${h(L.fmtFecha(j.fecha))}<span class="flh-cell-sub">${h([j.hora, L.fmtRelDias(c.dias)].filter(Boolean).join(' · '))}</span></td>
      <td class="nowrap">${h(nombreSoc(j.sociedad_id))}${j.placeholder ? ` ${DEMO}` : ''}</td>
      <td><span class="flh-cell-main">${h(opt('juntas', 'organo', j.organo))}</span><span class="flh-cell-sub">${h(j.caracter ? opt('juntas', 'caracter', j.caracter) : '')}</span></td>
      <td><span class="flh-cell-clamp">${h(j.orden_del_dia?.[0] || '—')}</span>${(j.orden_del_dia?.length || 0) > 1 ? `<span class="flh-cell-sub">+${j.orden_del_dia.length - 1} puntos</span>` : ''}</td>
      <td class="nowrap">${stepper(j.estado)}<span class="flh-steplabel">${h(opt('juntas', 'estado', j.estado))}</span>${deposito}</td>
    </tr>`;
  }).join('');
  $('#flhJuntasRes').innerHTML = `<table class="flh-table"><thead><tr><th>Fecha</th><th>Sociedad</th><th>Órgano</th><th>Orden del día</th><th>Estado</th></tr></thead>
    <tbody>${filas || '<tr><td colspan="5" class="flh-empty">Sin juntas registradas.</td></tr>'}</tbody></table>`;
}

function tablaPoderes() {
  const filas = S.data.apoderamientos.map((p) => {
    const [sl, st] = SITUACION_PODER[p.calc.situacion] ?? ['—', 'muted'];
    const fac = p.facultades || [];
    return `<tr class="is-click" data-act="abrir" data-entidad="apoderamientos" data-id="${h(p.id)}">
      <td class="w-persona"><span class="flh-cell-main">${h(p.apoderado)}</span><span class="flh-cell-sub">${h(p.cargo || '')}${p.placeholder ? ' · demo' : ''}</span></td>
      <td class="nowrap">${h(nombreSoc(p.sociedad_id))}</td>
      <td>${h(opt('apoderamientos', 'tipo', p.tipo))}</td>
      <td>${h(opt('apoderamientos', 'regimen', p.regimen))}${p.mancomunado_con ? `<span class="flh-cell-sub">con ${h(p.mancomunado_con)}</span>` : ''}</td>
      <td><div class="flh-chips">${fac.slice(0, 2).map((f) => pill(f, 'muted')).join('')}${fac.length > 2 ? pill(`+${fac.length - 2}`, 'muted') : ''}</div></td>
      <td class="r mono nowrap">${p.limite_cents ? h(L.fmtEur(p.limite_cents)) : 'Sin límite'}</td>
      <td class="nowrap">${p.fecha_caducidad ? h(L.fmtFecha(p.fecha_caducidad)) : 'Indefinido'}<span class="flh-cell-sub">${pill(sl, st)}${p.calc.dias_caducidad !== null && p.calc.situacion !== 'vigente' ? ` <span class="flh-muted">${h(L.fmtRelDias(p.calc.dias_caducidad))}</span>` : ''}</span></td>
      <td>${p.inscrito_rm ? pill('Inscrito', 'ok') : pill('Sin inscribir', 'warn')}</td>
    </tr>`;
  }).join('');
  return `<table class="flh-table"><thead><tr><th>Apoderado</th><th>Sociedad</th><th>Tipo</th><th>Régimen</th><th>Facultades</th><th class="r">Límite de firma</th><th>Caducidad</th><th>RM</th></tr></thead>
    <tbody>${filas || '<tr><td colspan="8" class="flh-empty">Sin apoderamientos registrados.</td></tr>'}</tbody></table>`;
}

/* ------------------------------------------------------------------------
   5 · CLM · gestor contractual
   ------------------------------------------------------------------------ */
function textoAlertaContrato(c) {
  const k = c.calc;
  if (k.alerta === 'preaviso') return `Preaviso de no renovación: decidir antes del ${L.fmtFecha(k.fecha_limite_preaviso)} (${L.fmtRelDias(k.dias_preaviso)})`;
  if (k.alerta === 'vence') return `Vence el ${L.fmtFecha(c.fecha_vencimiento)} (${L.fmtRelDias(k.dias_vencimiento)}) sin prórroga automática`;
  if (k.alerta === 'vencido') return `Venció el ${L.fmtFecha(c.fecha_vencimiento)} y sigue marcado como vigente`;
  return '';
}

function renderClm() {
  const c = S.clm;
  const conAlerta = S.data.contratos.filter((k) => k.calc.alerta);
  const tipos = S.data.meta.esquemas.contratos.campos.find((x) => x.key === 'tipo').opciones;
  const presentes = new Set(S.data.contratos.map((k) => k.tipo));
  $('#panel-clm').innerHTML = `
    ${conAlerta.length ? `<div class="flh-renew">${conAlerta.map((k) => `<button type="button" class="flh-renew__item${k.calc.alerta === 'vencido' ? ' is-bad' : ''}" data-act="abrir" data-entidad="contratos" data-id="${h(k.id)}"><b>${h(k.titulo)}</b><span>${h(textoAlertaContrato(k))}</span></button>`).join('')}</div>` : ''}
    <div class="flh-toolbar">
      <input class="flh-input flh-input--search flh-grow" type="search" placeholder="Título, contraparte, NIF o cláusula" data-filtro="clm.q" value="${h(c.q)}" aria-label="Buscar contratos">
      <select class="flh-select" data-filtro="clm.estado" aria-label="Estado">${[['activos', 'Activos'], ['vigente', 'Vigentes'], ['negociacion', 'En negociación'], ['borrador', 'Borradores'], ['cerrados', 'Vencidos y rescindidos'], ['todos', 'Todos']].map(([v, l]) => `<option value="${v}"${v === c.estado ? ' selected' : ''}>${l}</option>`).join('')}</select>
      <select class="flh-select" data-filtro="clm.sociedad" aria-label="Sociedad">${opcionesSociedad(c.sociedad, 'Todas las sociedades')}</select>
      <select class="flh-select" data-filtro="clm.orden" aria-label="Orden">${[['vencimiento', 'Por vencimiento'], ['riesgo', 'Por riesgo'], ['valor', 'Por valor'], ['titulo', 'Por título']].map(([v, l]) => `<option value="${v}"${v === c.orden ? ' selected' : ''}>${l}</option>`).join('')}</select>
      <div class="flh-seg" role="group" data-seg="clm.vista"><button type="button" data-v="grid" aria-pressed="${String(c.vista === 'grid')}" aria-label="Vista en tarjetas">${icon('grid', 14)}</button><button type="button" data-v="lista" aria-pressed="${String(c.vista === 'lista')}" aria-label="Vista en lista">${icon('list', 14)}</button></div>
      <button type="button" class="flh-btn flh-btn--gold" data-act="nuevo" data-entidad="contratos">${icon('plus', 14)}Nuevo contrato</button>
    </div>
    <div class="flh-chips" style="margin-bottom:14px">
      <button type="button" class="flh-chip" data-act="clm-tipo" data-v="" aria-pressed="${String(!c.tipo)}">Todos</button>
      ${tipos.filter((t) => presentes.has(t.v)).map((t) => `<button type="button" class="flh-chip" data-act="clm-tipo" data-v="${h(t.v)}" aria-pressed="${String(c.tipo === t.v)}">${h(t.l)}</button>`).join('')}
    </div>
    <div id="flhClmRes"></div>`;
  renderClmResultados();
}

function gauge(r) {
  if (!Number.isInteger(r)) return '<span class="flh-tag">Riesgo sin evaluar</span>';
  const nivel = L.nivelRiesgo(r);
  const tono = { bajo: 'ok', medio: 'warn', alto: 'bad' }[nivel];
  const arco = Math.PI * 22;
  return `<span class="flh-gauge" title="Riesgo de contraparte ${r}/100"><svg width="58" height="34" viewBox="0 0 58 34" aria-hidden="true">
    <path d="M7 31 A22 22 0 0 1 51 31" fill="none" stroke="var(--border-mid)" stroke-width="6" stroke-linecap="round"/>
    <path d="M7 31 A22 22 0 0 1 51 31" fill="none" stroke="var(--flh-${tono})" stroke-width="6" stroke-linecap="round" stroke-dasharray="${((r / 100) * arco).toFixed(1)} 200"/>
  </svg><span class="flh-gauge__v">${r}</span><span class="flh-gauge__l">riesgo ${nivel}</span></span>`;
}

function vigencia(c) {
  const k = c.calc;
  if (c.fecha_inicio && c.fecha_vencimiento) {
    const p = k.progreso_vigencia_pct ?? 0;
    return `<div class="flh-term"><div class="flh-term__bar"><i style="width:${p}%"></i><s style="left:calc(${p}% - 1px)"></s></div>
      <div class="flh-term__labels"><span>${h(L.fmtFecha(c.fecha_inicio, { corta: true }))} ${c.fecha_inicio.slice(0, 4)}</span><span>${h(L.fmtFecha(c.fecha_vencimiento))} · ${h(L.fmtRelDias(k.dias_vencimiento))}</span></div></div>`;
  }
  if (c.fecha_vencimiento) return `<div class="flh-term__labels"><span>Vence ${h(L.fmtFecha(c.fecha_vencimiento))}</span><span>${h(L.fmtRelDias(k.dias_vencimiento))}</span></div>`;
  return '<div class="flh-term__labels"><span>Sin fechas de vigencia todavía</span></div>';
}

function renderClmResultados() {
  const lista = L.filtrarContratos(S.data.contratos, S.clm);
  const el = $('#flhClmRes');
  if (!lista.length) {
    el.innerHTML = '<section class="flh-card"><div class="flh-empty">Ningún contrato con estos filtros.</div></section>';
    return;
  }
  const valor = (c) => (c.valor_cents !== null && c.valor_cents !== undefined ? h(L.fmtEur(c.valor_cents, { compacto: true })) : '—');
  const alertaPill = (c) => (c.calc.alerta ? pill({ preaviso: 'Preaviso abierto', vence: 'Vence pronto', vencido: 'Vencido' }[c.calc.alerta], c.calc.alerta === 'preaviso' ? 'warn' : 'bad') : '');
  if (S.clm.vista === 'lista') {
    el.innerHTML = `<section class="flh-card"><div class="flh-tablewrap"><table class="flh-table">
      <thead><tr><th>Tipo</th><th>Contrato · contraparte</th><th>Sociedad</th><th class="r">Valor</th><th>Vencimiento</th><th>Renovación</th><th>Riesgo</th><th>Estado</th><th class="r">Ficha</th></tr></thead>
      <tbody>${lista.map((c) => `<tr class="is-click" data-act="abrir" data-entidad="contratos" data-id="${h(c.id)}">
        <td>${pill(opt('contratos', 'tipo', c.tipo), 'gold')}</td>
        <td><span class="flh-cell-main flh-cell-clamp">${h(c.titulo)}</span><span class="flh-cell-sub">${h(c.contraparte)}${c.placeholder ? ' · demo' : ''}</span></td>
        <td>${h(nombreSoc(c.sociedad_id))}</td>
        <td class="r mono nowrap">${valor(c)}<span class="flh-cell-sub">${c.valor_cents ? h(opt('contratos', 'valor_periodicidad', c.valor_periodicidad)) : ''}</span></td>
        <td class="nowrap">${c.fecha_vencimiento ? h(L.fmtFecha(c.fecha_vencimiento)) : '—'}<span class="flh-cell-sub">${h(c.fecha_vencimiento ? L.fmtRelDias(c.calc.dias_vencimiento) : '')}</span></td>
        <td>${c.renovacion_automatica ? pill(`Automática${c.preaviso_dias ? ` · ${c.preaviso_dias} d` : ''}`, 'info') : '<span class="flh-muted">No</span>'} ${alertaPill(c)}</td>
        <td class="mono">${Number.isInteger(c.riesgo_contraparte) ? `${c.riesgo_contraparte} · ${L.nivelRiesgo(c.riesgo_contraparte)}` : '—'}</td>
        <td>${pill(opt('contratos', 'estado', c.estado), TONO_CONTRATO[c.estado])}</td>
        <td class="r"><button type="button" class="flh-btn flh-btn--icon" data-act="pdf" data-entidad="contratos" data-id="${h(c.id)}" title="Descargar ficha">${icon('download')}</button></td>
      </tr>`).join('')}</tbody></table></div></section>`;
    return;
  }
  el.innerHTML = `<div class="flh-contracts">${lista.map((c) => `
    <article class="flh-contract">
      <div class="flh-contract__top"><span class="flh-inline" style="gap:4px">${pill(opt('contratos', 'tipo', c.tipo), 'gold')}${c.placeholder ? DEMO : ''}</span>${pill(opt('contratos', 'estado', c.estado), TONO_CONTRATO[c.estado])}</div>
      <h3 class="flh-contract__title" data-act="abrir" data-entidad="contratos" data-id="${h(c.id)}">${h(c.titulo)}</h3>
      <p class="flh-contract__party">${h(c.contraparte)} <span class="flh-muted">· ${h(nombreSoc(c.sociedad_id))}</span></p>
      <div class="flh-contract__row"><div class="flh-contract__value">${valor(c)}<small>${c.valor_cents ? h(opt('contratos', 'valor_periodicidad', c.valor_periodicidad)) : 'sin valor fijado'}</small></div>${gauge(c.riesgo_contraparte)}</div>
      ${vigencia(c)}
      <div class="flh-chips">${c.renovacion_automatica ? pill('Renovación automática', 'info') : ''}${c.preaviso_dias ? pill(`Preaviso ${c.preaviso_dias} días`, 'muted') : ''}${alertaPill(c)}</div>
      <div class="flh-contract__foot"><button type="button" class="flh-btn flh-btn--sm flh-btn--gold" data-act="pdf" data-entidad="contratos" data-id="${h(c.id)}">${icon('download', 13)}Descargar ficha</button><button type="button" class="flh-btn flh-btn--sm" data-act="abrir" data-entidad="contratos" data-id="${h(c.id)}">Ver contrato</button></div>
    </article>`).join('')}</div>`;
}

/* ------------------------------------------------------------------------
   Dialogo generico
   ------------------------------------------------------------------------ */
const M = {
  el: null,
  onAct: null,
  onInput: null,
  onClose: null,
  init() {
    this.el = $('#flhModal');
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) { this.cerrar(); return; }
      const seg = e.target.closest('[data-seg] button');
      if (seg && this.el.contains(seg)) { this.onAct?.('seg', seg, e); return; }
      const t = e.target.closest('[data-act]');
      if (!t || !this.el.contains(t) || t.tagName === 'A') return;
      if (t.dataset.act === 'cerrar') { this.cerrar(); return; }
      this.onAct?.(t.dataset.act, t, e);
    });
    this.el.addEventListener('input', (e) => this.onInput?.(e));
    this.el.addEventListener('submit', (e) => { e.preventDefault(); this.onAct?.('submit', e.target, e); });
    this.el.addEventListener('close', () => {
      const fn = this.onClose;
      this.onClose = null;
      this.onAct = null;
      this.onInput = null;
      fn?.();
    });
  },
  abrir({ size = 'md', kicker = '', titulo = '', tabs = '', cuerpo = '', pie = '', onAct = null, onInput = null, onClose = null }) {
    if (this.el.open) {
      const fn = this.onClose;
      this.onClose = null;
      fn?.();
    }
    this.el.className = `flh-dialog${size !== 'md' ? ` flh-dialog--${size}` : ''}`;
    this.el.innerHTML = `
      <header class="flh-dialog__head"><div style="min-width:0"><div class="flh-dialog__kicker">${kicker}</div><h2 class="flh-dialog__title">${titulo}</h2></div>
        <button type="button" class="flh-btn flh-btn--icon" data-act="cerrar" aria-label="Cerrar">${icon('x')}</button></header>
      ${tabs}
      <div class="flh-dialog__body">${cuerpo}</div>
      ${pie ? `<footer class="flh-dialog__foot">${pie}</footer>` : ''}`;
    this.onAct = onAct;
    this.onInput = onInput;
    this.onClose = onClose;
    if (!this.el.open) this.el.showModal();
    tick();
  },
  cuerpo() { return $('.flh-dialog__body', this.el); },
  pie() { return $('.flh-dialog__foot', this.el); },
  cerrar() { if (this.el.open) this.el.close(); },
};

/* ------------------------------------------------------------------------
   Ficha de detalle de cualquier entidad
   ------------------------------------------------------------------------ */
function valorCampo(c, v) {
  if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)) return null;
  switch (c.tipo) {
    case 'date': return `${h(L.fmtFecha(v))} <span class="flh-muted">· ${h(L.fmtRelDias(L.diffDias(hoy(), v)))}</span>`;
    case 'cents': return `<span class="mono">${h(L.fmtEur(v))}</span>`;
    case 'bool': return v ? 'Sí' : 'No';
    case 'enum': return h(c.opciones.find((o) => o.v === v)?.l ?? v);
    case 'pct': return `${h(String(v).replace('.', ','))} %`;
    case 'ref': return h(S.soc.get(v)?.denominacion ?? v);
    case 'list': return `<ul>${v.map((x) => `<li>${h(x)}</li>`).join('')}</ul>`;
    case 'nif': return `<span class="mono">${h(v)}</span>`;
    default: return h(v);
  }
}

function camposHtml(entidad, d, excluir = []) {
  const campos = S.data.meta.esquemas[entidad].campos.filter((c) => !excluir.includes(c.key));
  const items = campos.map((c) => {
    const v = valorCampo(c, d[c.key]);
    if (v === null) return '';
    const full = c.tipo === 'text' || c.tipo === 'list' || (c.tipo === 'str' && c.max > 160);
    return `<div class="flh-field${full ? ' flh-field--full' : ''}"><dt>${h(c.label)}</dt><dd>${v}</dd></div>`;
  }).join('');
  return `<dl class="flh-fields">${items}</dl>`;
}

function segEstados(act, entidad, actual) {
  const opciones2 = S.data.meta.esquemas[entidad].campos.find((c) => c.key === 'estado').opciones;
  return `<div class="flh-seg" role="group">${opciones2.map((o) => `<button type="button" data-act="${act}" data-v="${h(o.v)}" aria-pressed="${String(o.v === actual)}">${h(o.l)}</button>`).join('')}</div>`;
}

function bloqueNotificacion(n) {
  const c = n.calc;
  const portal = S.data.meta.portales.find((p) => p.key === PORTAL_CANAL[n.canal]);
  const partes = [];
  if (!n.acuse && n.estado !== 'archivada') {
    partes.push(`<div class="flh-block ${c.urgencia === 'critica' ? 'flh-block--bad' : 'flh-block--warn'}">
      <h4 class="flh-h">${icon('sign', 14)} Acuse de recepción pendiente</h4>
      <p>Puesta a disposición el ${h(L.fmtFecha(n.puesta_disposicion))}. ${c.rechazo_presunto
        ? `<b>Plazo de acceso agotado:</b> se entiende rechazada desde el ${h(L.fmtFecha(L.addDias(c.fecha_rechazo_presunto, 1)))} y el procedimiento sigue su curso (art. 43.2 Ley 39/2015). Registra igualmente el acceso si ya se ha producido.`
        : `Si no se accede al contenido antes del fin del ${h(L.fmtFecha(c.fecha_rechazo_presunto))}, se entiende rechazada y el procedimiento sigue su curso (art. 43.2 Ley 39/2015).`}</p>
      ${c.rechazo_presunto ? '' : `<p>${cuentaAtras(c.fecha_rechazo_presunto, 'Tiempo para acceder: ')}</p>`}
      <label class="flh-check-label"><input type="checkbox" data-f="declaracion"> Confirmo que he accedido al contenido en ${h(opt('notificaciones', 'canal', n.canal))} con el certificado de la sociedad. SYSTEMS no comparece en nombre de nadie: registra el acuse en su log inmutable.</label>
      <div class="flh-inline">
        <label class="flh-inline" style="margin:0;gap:6px">Fecha de acceso <input class="flh-input" type="date" data-f="fecha_acuse" value="${hoy()}" min="${h(n.puesta_disposicion)}" max="${hoy()}"></label>
        <button type="button" class="flh-btn flh-btn--gold" data-act="acuse">${icon('sign', 14)}Firmar recepción</button>
        ${portal ? `<a class="flh-btn" href="${h(portal.url)}" target="_blank" rel="noopener noreferrer">${h(portal.label.split(' · ')[0])} ${icon('external', 12)}</a>` : ''}
      </div>
    </div>`);
  } else if (n.acuse) {
    partes.push(`<div class="flh-block flh-block--ok"><h4 class="flh-h">${icon('shield', 14)} Acuse registrado</h4>
      <p>Acceso el ${h(L.fmtFecha(n.acuse.fecha))}, registrado por ${h(n.acuse.registrado_por)}. ${n.fecha_limite_respuesta ? `Plazo de respuesta hasta el ${h(L.fmtFecha(n.fecha_limite_respuesta))} (${n.plazo_respuesta} ${h(opt('notificaciones', 'plazo_tipo', n.plazo_tipo).toLowerCase())}, sin festivos: cómputo conservador).` : 'El acto no fija plazo de respuesta.'}</p>
      ${n.fecha_limite_respuesta && c.urgencia !== 'cerrada' ? `<div class="flh-plazo" style="max-width:340px"><div class="flh-progress${c.urgencia === 'critica' ? ' flh-progress--bad' : c.urgencia === 'alta' ? ' flh-progress--warn' : ''}"><i style="width:${c.progreso_pct ?? 0}%"></i></div>${cuentaAtras(n.fecha_limite_respuesta, 'Responder: ')}</div>` : ''}
    </div>`);
  }
  if (n.estado === 'pendiente' || n.estado === 'asignada') {
    partes.push(`<div class="flh-block"><h4 class="flh-h">Asignación</h4>
      <div class="flh-inline"><input class="flh-input" style="flex:1;min-width:200px" data-f="abogado" placeholder="Abogado o responsable" value="${h(n.abogado_asignado || '')}">
      <button type="button" class="flh-btn${n.estado === 'pendiente' ? ' flh-btn--gold' : ''}" data-act="asignar">${n.estado === 'pendiente' ? 'Asignar a abogado' : 'Reasignar'}</button>
      ${n.estado === 'asignada' ? '<button type="button" class="flh-btn" data-act="devolver">Devolver a pendiente</button>' : ''}</div></div>`);
  }
  if (n.estado === 'asignada' && n.acuse) {
    partes.push(`<div class="flh-block"><h4 class="flh-h">Registrar respuesta</h4>
      <div class="flh-inline" style="margin-bottom:8px"><input class="flh-input" type="date" data-f="resp_fecha" value="${hoy()}" min="${h(n.acuse.fecha)}" aria-label="Fecha de respuesta"><input class="flh-input" style="flex:1;min-width:180px" data-f="resp_ref" placeholder="Nº de registro de entrada / referencia"></div>
      <textarea class="flh-input" style="width:100%;height:64px;padding:8px 10px" data-f="resp_nota" placeholder="Qué se ha presentado (alegaciones, documentación...)"></textarea>
      <div class="flh-inline" style="margin-top:8px"><button type="button" class="flh-btn flh-btn--gold" data-act="responder">Marcar como respondida</button></div></div>`);
  }
  if (n.respuesta) {
    partes.push(`<div class="flh-block"><h4 class="flh-h">Respuesta</h4><p>${h(L.fmtFecha(n.respuesta.fecha))} · ${h(n.respuesta.referencia || 'sin referencia')}${n.respuesta.nota ? ` · ${h(n.respuesta.nota)}` : ''}</p></div>`);
  }
  return partes.join('');
}

function bloqueDetalle(entidad, d) {
  const c = d.calc || {};
  switch (entidad) {
    case 'notificaciones': return bloqueNotificacion(d);
    case 'modelos': return `<div class="flh-block${c.vencido ? ' flh-block--bad' : ''}">
      <div class="flh-inline" style="justify-content:space-between;align-items:flex-start">
        <div><span class="flh-tag">Estado</span><div style="margin-top:6px">${segEstados('estado-modelo', 'modelos', d.estado)}</div></div>
        <div style="text-align:right"><span class="flh-tag">Fecha límite</span><div class="flh-kpi__value" style="font-size:1.25rem;justify-content:flex-end">${h(L.fmtFecha(d.fecha_limite))}</div>
        <span class="flh-muted" style="font-size:0.74rem">${d.estado === 'pendiente' ? h(L.fmtRelDias(c.dias)) : d.presentado_at ? `Presentado el ${h(L.fmtFecha(d.presentado_at))}` : ''}${c.fuera_plazo ? ' · <b style="color:var(--flh-bad-text)">fuera de plazo</b>' : ''}</span></div>
      </div></div>`;
    case 'juntas': {
      const paso = L.pasoJunta(d.estado);
      const siguiente = L.PASOS_JUNTA[paso + 1];
      return `<div class="flh-block${c.deposito_vencido ? ' flh-block--bad' : ''}">
        <div class="flh-inline" style="justify-content:space-between">${stepper(d.estado)}<span class="flh-muted" style="font-size:0.76rem">${h(opt('juntas', 'estado', d.estado))}</span>
        ${siguiente ? `<button type="button" class="flh-btn flh-btn--gold flh-btn--sm" data-act="avanzar" data-v="${siguiente}">Pasar a «${h(opt('juntas', 'estado', siguiente))}»</button>` : ''}</div>
        ${c.deposito_limite ? `<p style="margin:10px 0 0">${c.deposito_vencido ? '<b style="color:var(--flh-bad-text)">Depósito de cuentas fuera de plazo.</b> ' : ''}Las cuentas aprobadas deben depositarse en el Registro Mercantil dentro del mes siguiente a la aprobación (art. 279 LSC): límite ${h(L.fmtFecha(c.deposito_limite))}.</p>` : ''}
      </div>`;
    }
    case 'apoderamientos': {
      const [sl, st] = SITUACION_PODER[c.situacion] ?? ['—', 'muted'];
      return `<div class="flh-block${st === 'bad' ? ' flh-block--bad' : st === 'warn' ? ' flh-block--warn' : ''}"><div class="flh-inline" style="justify-content:space-between">
        <span>${pill(sl, st)} ${d.fecha_caducidad ? `<span class="flh-muted" style="font-size:0.76rem">${h(c.dias_caducidad < 0 ? `caducó ${L.fmtRelDias(c.dias_caducidad)}` : `caduca ${L.fmtRelDias(c.dias_caducidad)}`)}</span>` : '<span class="flh-muted" style="font-size:0.76rem">Sin caducidad</span>'}</span>
        <span class="flh-kpi__value" style="font-size:1.2rem">${d.limite_cents ? h(L.fmtEur(d.limite_cents)) : 'Sin límite'}<small>límite de firma</small></span>
      </div></div>`;
    }
    case 'contratos': return `<div class="flh-block${c.alerta === 'vencido' ? ' flh-block--bad' : c.alerta ? ' flh-block--warn' : ''}">
      <div class="flh-contract__row" style="margin-bottom:10px"><div class="flh-contract__value">${d.valor_cents ? h(L.fmtEur(d.valor_cents)) : '—'}<small>${d.valor_cents ? h(opt('contratos', 'valor_periodicidad', d.valor_periodicidad)) : 'sin valor fijado'}</small></div>${gauge(d.riesgo_contraparte)}</div>
      ${vigencia(d)}${c.alerta ? `<p style="margin:10px 0 0"><b>${h(textoAlertaContrato(d))}</b></p>` : ''}</div>`;
    case 'checklist': return `<div class="flh-block"><span class="flh-tag">Estado</span><div style="margin-top:6px">${segEstados('estado-check', 'checklist', d.estado)}</div>${d.completado_at ? `<p style="margin:8px 0 0">Completado por ${h(d.completado_por)} el ${h(L.fmtFecha(d.completado_at.slice(0, 10)))}</p>` : ''}</div>`;
    case 'sociedades': {
      const pubs = S.data.alertas.filter((a) => a.fuente === 'BORME' && a.sociedad_id === d.id);
      return `<div class="flh-block"><h4 class="flh-h">Vigilancia BORME</h4><p>Denominaciones vigiladas: ${h([d.denominacion, ...(d.borme_alias || [])].join(' · '))}</p>
        ${pubs.length ? `<ul class="flh-feed" style="margin:0 -16px">${pubs.map(itemAlerta).join('')}</ul>` : '<p style="margin:0">Sin publicaciones en los últimos 60 días.</p>'}</div>`;
    }
    default: return '';
  }
}

function abrirDetalle(entidad, id, { pestana = 'detalle' } = {}) {
  const d = S.byId[entidad]?.get(id);
  if (!d) { toast('El registro ya no está disponible'); return; }
  const esq = S.data.meta.esquemas[entidad];
  const excluir = EXCLUIR_FICHA[entidad] ?? [];
  const cuerpoDetalle = () => `${d.placeholder ? `<div class="flh-note">${icon('info', 16)}<span>Registro de demostración (PLACEHOLDER): no refleja un dato real confirmado. Corrígelo con «Editar» y márcalo como dato real, o retíralo junto al resto de la demostración.</span></div>` : ''}${bloqueDetalle(entidad, d)}${camposHtml(entidad, S.byId[entidad].get(id) || d, excluir)}`;
  const tabs = `<nav class="flh-dialog__tabs" role="tablist">
    <button type="button" role="tab" data-act="dtab" data-v="detalle" aria-selected="${String(pestana === 'detalle')}">Detalle</button>
    <button type="button" role="tab" data-act="dtab" data-v="historial" aria-selected="${String(pestana === 'historial')}">Audit trail · fl_log</button></nav>`;
  const pie = `<div><button type="button" class="flh-btn" data-act="pdf">${icon('file')} Ficha PDF</button></div>
    <div>${d.placeholder ? '<button type="button" class="flh-btn" data-act="confirmar">Marcar como dato real</button>' : ''}
      <button type="button" class="flh-btn flh-btn--danger" data-act="archivar">${icon('archive')} Archivar</button>
      <button type="button" class="flh-btn flh-btn--gold" data-act="editar">${icon('edit')} Editar</button></div>`;
  M.abrir({
    size: entidad === 'notificaciones' || entidad === 'contratos' ? 'lg' : 'md',
    kicker: `${h(esq.label)}${d.placeholder ? ` ${DEMO}` : ''}${d.sociedad_id ? ` · ${h(nombreSoc(d.sociedad_id))}` : ''}`,
    titulo: h(tituloDe(entidad, d)),
    tabs,
    cuerpo: pestana === 'historial' ? '' : cuerpoDetalle(),
    pie,
    onAct: (act, el) => accionDetalle(entidad, d, act, el, cuerpoDetalle),
  });
  if (pestana === 'historial') cargarHistorial(entidad, id);
}

async function cargarHistorial(entidad, id) {
  const cuerpo = M.cuerpo();
  cuerpo.innerHTML = '<div class="flh-skel" style="height:180px"></div>';
  try {
    const [entradas, cadena] = await Promise.all([api.flHistorial(entidad, id), api.flLogVerify()]);
    const d = S.byId[entidad]?.get(id);
    const items = entradas.map((e) => {
      const tipo = e.action.split('.').pop();
      const det = Object.entries(e.detail || {})
        .filter(([, v]) => v !== null && v !== undefined && !(Array.isArray(v) && !v.length))
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join(' · ');
      return `<li><div class="flh-timeline__t">${h(ACCIONES_LOG[tipo] || e.action)} · <b>${h(e.actorId)}</b></div>
        <div class="flh-timeline__m">${h(new Date(e.createdAt).toLocaleString('es-ES'))} · #${e.seq} · ${h(e.hash.slice(0, 16))}…${det ? ` · ${h(det)}` : ''}</div></li>`;
    }).join('');
    const origen = d?.createdBy === 'system' && d?.placeholder
      ? `<li><div class="flh-timeline__t">Sembrado como dato de demostración</div><div class="flh-timeline__m">${h(new Date(d.createdAt).toLocaleString('es-ES'))} · entrada hub.seed del log</div></li>` : '';
    cuerpo.innerHTML = `
      <div class="flh-block ${cadena.valid ? 'flh-block--ok' : 'flh-block--bad'}"><div class="flh-inline">${icon('shield', 16)}<span style="font-size:0.8rem">${cadena.valid
        ? `Cadena fl_log íntegra: ${cadena.totalEntries} entradas verificadas con SHA-256.`
        : `<b>Cadena fl_log rota en la entrada #${cadena.brokenAtSeq}.</b> Avisa a Dirección: el registro ha sido manipulado fuera de la aplicación.`}</span></div></div>
      ${items || origen ? `<ul class="flh-timeline">${items}${origen}</ul>` : '<div class="flh-empty">Sin entradas en el log para este registro.</div>'}`;
  } catch (ex) {
    cuerpo.innerHTML = `<div class="flh-error">${h(ex.message || 'No se pudo cargar el historial')}</div>`;
  }
}

async function tras(promesa, mensaje, entidad, id, opts) {
  try {
    await promesa;
    if (mensaje) toast(mensaje);
    await cargar({ silencioso: true });
    if (entidad && id && S.byId[entidad]?.has(id)) abrirDetalle(entidad, id, opts);
    else M.cerrar();
  } catch (ex) {
    toast(ex.message || 'No se pudo completar la acción');
  }
}

function accionDetalle(entidad, d, act, el, cuerpoDetalle) {
  const val = (f) => $(`[data-f="${f}"]`, M.el)?.value ?? '';
  switch (act) {
    case 'dtab': {
      $$('.flh-dialog__tabs [data-act="dtab"]', M.el).forEach((b) => b.setAttribute('aria-selected', String(b === el)));
      if (el.dataset.v === 'historial') cargarHistorial(entidad, d.id);
      else { M.cuerpo().innerHTML = cuerpoDetalle(); tick(); }
      return;
    }
    case 'pdf': abrirPdf(entidad, d.id); return;
    case 'editar': abrirFormulario(entidad, d); return;
    case 'confirmar':
      tras(api.flConfirmarReal(entidad, d.id), 'Registro marcado como dato real', entidad, d.id);
      return;
    case 'archivar':
      M.pie().innerHTML = `<div><span style="font-size:0.78rem;color:var(--text-secondary)">¿Archivar este registro? Sale de las vistas pero se conserva en Mongo y en fl_log; no se borra.</span></div>
        <div><button type="button" class="flh-btn" data-act="no-archivar">Cancelar</button><button type="button" class="flh-btn flh-btn--danger" data-act="si-archivar">${icon('archive')} Archivar</button></div>`;
      return;
    case 'no-archivar': abrirDetalle(entidad, d.id); return;
    case 'si-archivar': tras(api.flArchivar(entidad, d.id), 'Registro archivado'); return;
    case 'estado-modelo': tras(api.flActualizar('modelos', d.id, { estado: el.dataset.v }), 'Estado del modelo actualizado', 'modelos', d.id); return;
    case 'estado-check': tras(api.flActualizar('checklist', d.id, { estado: el.dataset.v }), 'Punto de auditoría actualizado', 'checklist', d.id); return;
    case 'avanzar': tras(api.flActualizar('juntas', d.id, { estado: el.dataset.v }), 'Junta actualizada', 'juntas', d.id); return;
    case 'acuse': {
      if (!$('[data-f="declaracion"]', M.el)?.checked) { toast('Marca la confirmación de acceso antes de firmar'); return; }
      tras(api.flAcuse(d.id, { declaracion: true, fecha: val('fecha_acuse') || hoy() }), 'Acuse de recepción registrado en fl_log', 'notificaciones', d.id);
      return;
    }
    case 'asignar': {
      const abogado = val('abogado').trim();
      if (!abogado) { toast('Indica el abogado o responsable'); return; }
      if (d.estado === 'asignada') tras(api.flActualizar('notificaciones', d.id, { abogado_asignado: abogado }), 'Notificación reasignada', 'notificaciones', d.id);
      else tras(api.flNotifEstado(d.id, { estado: 'asignada', abogado_asignado: abogado }), 'Notificación asignada', 'notificaciones', d.id);
      return;
    }
    case 'devolver': tras(api.flNotifEstado(d.id, { estado: 'pendiente' }), 'Notificación devuelta a pendiente', 'notificaciones', d.id); return;
    case 'responder':
      tras(api.flNotifEstado(d.id, { estado: 'respondida', respuesta: { fecha: val('resp_fecha'), referencia: val('resp_ref'), nota: val('resp_nota') } }), 'Respuesta registrada', 'notificaciones', d.id);
      return;
    default:
      accionComun(act, el);
  }
}

/* ------------------------------------------------------------------------
   Formulario de alta y edicion (generado desde el esquema del backend)
   ------------------------------------------------------------------------ */
function valoresPorDefecto(entidad) {
  const out = {};
  for (const c of S.data.meta.esquemas[entidad].campos) if (c.defecto !== undefined) out[c.key] = c.defecto;
  const primera = S.data.sociedades[0]?.id;
  if (primera) out.sociedad_id = primera;
  const y = Number(hoy().slice(0, 4));
  if (entidad === 'modelos' || entidad === 'checklist') out.ejercicio = y;
  if (entidad === 'notificaciones') Object.assign(out, { puesta_disposicion: hoy(), plazo_respuesta: 10 });
  if (entidad === 'juntas') out.fecha = hoy();
  return out;
}

function campoForm(c, v) {
  const id = `flhf_${c.key}`;
  const req = c.requerido ? ' class="is-required"' : '';
  const ayuda = c.ayuda ? `<span class="flh-help">${h(c.ayuda)}</span>` : '';
  // Ancho completo para textos largos; en int/cents `max` es un valor, no una longitud.
  const full = ['text', 'list'].includes(c.tipo) || (c.tipo === 'str' && c.max > 120);
  // class="input": los <input> no heredan el estilo del sistema por selector de elemento (select/textarea si).
  const attrs = `id="${id}" name="${c.key}"${c.requerido ? ' required' : ''}${c.tipo === 'bool' ? '' : ' class="input"'}`;
  let input;
  switch (c.tipo) {
    case 'text': input = `<textarea ${attrs} maxlength="${c.max}">${h(v ?? '')}</textarea>`; break;
    case 'list': input = `<textarea ${attrs} rows="3">${h((v || []).join('\n'))}</textarea>`; break;
    case 'enum': input = `<select ${attrs}>${c.requerido ? '' : '<option value="">—</option>'}${c.opciones.map((o) => `<option value="${h(o.v)}"${o.v === v ? ' selected' : ''}>${h(o.l)}</option>`).join('')}</select>`; break;
    case 'ref': input = `<select ${attrs}>${S.data.sociedades.map((s) => `<option value="${h(s.id)}"${s.id === v ? ' selected' : ''}>${h(s.nombre_corto)} · ${h(s.denominacion)}</option>`).join('')}</select>`; break;
    case 'date': input = `<input ${attrs} type="date" value="${h(v ?? '')}">`; break;
    case 'time': input = `<input ${attrs} type="time" value="${h(v ?? '')}">`; break;
    case 'int': input = `<input ${attrs} type="number" step="1" min="${c.min}" max="${c.max}" value="${v ?? ''}">`; break;
    case 'pct': input = `<input ${attrs} type="number" step="0.01" min="0" max="100" value="${v ?? ''}">`; break;
    case 'cents': input = `<input ${attrs} type="text" inputmode="decimal" placeholder="0,00 €" value="${h(L.centsAEurTexto(v))}">`; break;
    case 'bool': return `<div class="flh-field${full ? ' flh-field--full' : ''}"><label class="flh-check-label" for="${id}" style="margin-top:22px"><input ${attrs} type="checkbox"${v ? ' checked' : ''}> ${h(c.label)}</label>${ayuda}</div>`;
    case 'nif': input = `<input ${attrs} type="text" maxlength="12" style="text-transform:uppercase" value="${h(v ?? '')}">`; break;
    default: input = `<input ${attrs} type="text" maxlength="${c.max || 200}" value="${h(v ?? '')}">`;
  }
  return `<div class="flh-field${full ? ' flh-field--full' : ''}"><label for="${id}"${req}>${h(c.label)}</label>${input}${ayuda}</div>`;
}

function leerFormulario(form, esq, doc) {
  const payload = {};
  const errores = [];
  for (const c of esq.campos) {
    const el = form.elements[c.key];
    if (!el) continue;
    let v;
    switch (c.tipo) {
      case 'bool': v = el.checked; break;
      case 'int': v = el.value === '' ? null : Number(el.value); if (v !== null && !Number.isInteger(v)) errores.push(`${c.label}: número entero`); break;
      case 'pct': v = el.value === '' ? null : Number(el.value); break;
      case 'cents': v = L.parseEurACents(el.value); if (Number.isNaN(v)) { errores.push(`${c.label}: importe no válido`); v = undefined; } break;
      case 'list': v = el.value.split('\n').map((s) => s.trim()).filter(Boolean); break;
      default: v = el.value.trim() === '' ? null : el.value.trim();
    }
    if (v === undefined) continue;
    if (c.requerido && (v === null || v === '')) { errores.push(`${c.label}: obligatorio`); continue; }
    if (doc) {
      const antes = doc[c.key] ?? (c.tipo === 'list' ? [] : c.tipo === 'bool' ? false : null);
      if (JSON.stringify(antes) === JSON.stringify(v)) continue;
    } else if (v === null || (Array.isArray(v) && !v.length)) continue;
    payload[c.key] = v;
  }
  return { payload, errores };
}

function abrirFormulario(entidad, doc) {
  const esq = S.data.meta.esquemas[entidad];
  const nuevo = !doc;
  const valores = nuevo ? valoresPorDefecto(entidad) : doc;
  M.abrir({
    size: 'lg',
    kicker: `${nuevo ? 'Alta' : 'Edición'} · ${h(esq.label)}`,
    titulo: nuevo ? `Nuevo registro · ${h(esq.label.toLowerCase())}` : h(tituloDe(entidad, doc)),
    cuerpo: `<form class="flh-form" id="flhForm" novalidate>${esq.campos.map((c) => campoForm(c, valores[c.key])).join('')}<p class="flh-formerror" id="flhFormError" hidden></p></form>`,
    pie: `<div><span class="flh-tag">* obligatorio · el cambio queda en fl_log</span></div>
      <div><button type="button" class="flh-btn" data-act="${nuevo ? 'cerrar' : 'volver'}">Cancelar</button><button type="button" class="flh-btn flh-btn--gold" data-act="guardar">${nuevo ? 'Crear registro' : 'Guardar cambios'}</button></div>`,
    onAct: async (act) => {
      if (act === 'volver') { abrirDetalle(entidad, doc.id); return; }
      if (act !== 'guardar' && act !== 'submit') return;
      const form = $('#flhForm', M.el);
      const errBox = $('#flhFormError', M.el);
      const { payload, errores } = leerFormulario(form, esq, doc);
      if (errores.length) { errBox.textContent = errores.join(' · '); errBox.hidden = false; return; }
      if (!nuevo && !Object.keys(payload).length) { abrirDetalle(entidad, doc.id); return; }
      try {
        const r = nuevo ? await api.flCrear(entidad, payload) : await api.flActualizar(entidad, doc.id, payload);
        toast(nuevo ? 'Registro creado' : 'Cambios guardados');
        await cargar({ silencioso: true });
        abrirDetalle(entidad, r.id);
      } catch (ex) {
        errBox.textContent = ex.message || 'No se pudo guardar';
        errBox.hidden = false;
      }
    },
  });
}

/* ------------------------------------------------------------------------
   Ficha PDF (previsualizacion; cada apertura queda registrada en fl_log)
   ------------------------------------------------------------------------ */
async function abrirPdf(entidad, id) {
  const d = S.byId[entidad]?.get(id);
  const titulo = d ? tituloDe(entidad, d) : 'Ficha';
  M.abrir({
    size: 'xl',
    kicker: `Ficha PDF · ${h(S.data.meta.esquemas[entidad].label)} · acceso registrado en fl_log`,
    titulo: h(titulo),
    cuerpo: '<div class="flh-skel" style="height:60vh"></div>',
    pie: '<div><span class="flh-tag">Generada por SYSTEMS · no sustituye al justificante oficial</span></div><div id="flhPdfAcciones"></div>',
    onAct: (act) => { if (act === 'volver-detalle') abrirDetalle(entidad, id); },
  });
  try {
    const blob = await fetchFlFichaPdf(entidad, id);
    const url = URL.createObjectURL(blob);
    M.onClose = () => URL.revokeObjectURL(url);
    const nombre = `ficha-${entidad}-${L.normalizar(titulo).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'registro'}.pdf`;
    M.cuerpo().innerHTML = `<iframe class="flh-pdf" src="${url}" title="Ficha PDF"></iframe>`;
    $('#flhPdfAcciones', M.el).innerHTML = `${d ? '<button type="button" class="flh-btn" data-act="volver-detalle">Volver a la ficha</button>' : ''}
      <a class="flh-btn" href="${url}" target="_blank" rel="noopener">Abrir en pestaña ${icon('external', 12)}</a>
      <a class="flh-btn flh-btn--gold" href="${url}" download="${h(nombre)}">${icon('download', 14)}Descargar</a>`;
  } catch (ex) {
    M.cuerpo().innerHTML = `<div class="flh-error">${h(ex.message || 'No se pudo generar la ficha')}</div>`;
  }
}

/* ------------------------------------------------------------------------
   Boletines: listado completo, detalle y sincronizacion
   ------------------------------------------------------------------------ */
function alertasFiltradas() {
  const f = S.alertas;
  const q = L.normalizar(f.q).trim();
  return alertasPriorizadas().concat(S.data.alertas.filter((a) => a.estado === 'descartada'))
    .filter((a) => (f.relevancia !== 'alta_media' || a.relevancia !== 'baja')
      && (!f.fuente || a.fuente === f.fuente)
      && (f.estado === 'todas' || a.estado === f.estado)
      && (!q || L.normalizar(`${a.titulo} ${a.id} ${a.departamento || ''} ${(a.categorias || []).join(' ')}`).includes(q)));
}

function abrirAlertas() {
  const f = S.alertas;
  const b = S.data.conectores.boletines;
  M.abrir({
    size: 'lg',
    kicker: 'Boletines oficiales · API de datos abiertos del BOE',
    titulo: 'Alertas BOE y BORME',
    cuerpo: `
      <div class="flh-note">${icon('info', 16)}<span>BOE: secciones I, III y V-B puntuadas por un motor de reglas sobre el título (energía, residuos, clima, fiscal, fondos PRTR, mercantil, datos e IA). No es un modelo de IA: revisa siempre la disposición. BORME: actos inscritos y anuncios de las sociedades del grupo, por denominación social.</span></div>
      <div class="flh-toolbar">
        ${segmento('alertas.relevancia', f.relevancia, [['alta_media', 'Alta y media'], ['todas', 'Todas']])}
        ${segmento('alertas.fuente', f.fuente, [['', 'BOE y BORME'], ['BOE', 'BOE'], ['BORME', 'BORME']])}
        ${segmento('alertas.estado', f.estado, [['nueva', 'Nuevas'], ['revisada', 'Revisadas'], ['descartada', 'Descartadas'], ['todas', 'Todas']])}
        <input class="flh-input flh-input--search flh-grow" type="search" placeholder="Título, referencia o materia" data-filtro="alertas.q" value="${h(f.q)}">
      </div>
      <section class="flh-card" id="flhAlertasLista"></section>`,
    pie: `<div><span class="flh-tag">${b.ultimo_ok ? `Última sincronización correcta ${h(horaCorta(b.ultimo_ok))}` : 'Sin sincronizar todavía'}${b.error ? ` · último error: ${h(b.error)}` : ''}</span></div>
      <div><button type="button" class="flh-btn flh-btn--gold" data-act="sync">${icon('refresh', 14)}Sincronizar ahora</button></div>`,
    onAct: (act, el) => {
      if (act === 'seg') { aplicarSegmento(el); renderListaAlertas(); return; }
      if (act === 'revisar' || act === 'descartar' || act === 'reabrir') {
        const estado = { revisar: 'revisada', descartar: 'descartada', reabrir: 'nueva' }[act];
        api.flAlertaEstado(el.dataset.id, estado)
          .then(() => cargar({ silencioso: true }))
          .then(() => { renderListaAlertas(); toast(estado === 'nueva' ? 'Alerta reabierta' : `Alerta ${estado}`); })
          .catch((ex) => toast(ex.message));
        return;
      }
      accionComun(act, el);
    },
    onInput: (e) => {
      if (e.target.dataset.filtro === 'alertas.q') { S.alertas.q = e.target.value; renderListaAlertas(); }
    },
  });
  renderListaAlertas();
}

function renderListaAlertas() {
  const el = $('#flhAlertasLista', M.el);
  if (!el) return;
  const lista = alertasFiltradas();
  el.innerHTML = lista.length ? `<ul class="flh-feed">${lista.map((a) => {
    const [rl, rt] = RELEVANCIA[a.relevancia] ?? ['—', 'muted'];
    return `<li><div class="flh-feeditem" style="cursor:default">
      <span class="flh-feeditem__meta">${pill(a.fuente, a.fuente === 'BORME' ? 'gold' : 'info')}${pill(rl, rt)}${a.sociedad_id ? pill(nombreSoc(a.sociedad_id), 'gold') : ''}<span class="flh-tag">${h(a.id)} · ${h(L.fmtFecha(a.fecha_publicacion))}</span></span>
      <span class="flh-feeditem__title" style="-webkit-line-clamp:3">${h(a.titulo)}</span>
      <span class="flh-feeditem__sub">${h([a.departamento, a.acto && a.acto !== a.departamento ? a.acto : null, (a.categorias || []).join(', ')].filter(Boolean).join(' · '))}</span>
      <span class="flh-inline" style="margin-top:4px">
        ${a.url_html ? `<a class="flh-btn flh-btn--sm" href="${h(a.url_html)}" target="_blank" rel="noopener noreferrer">Abrir en boe.es ${icon('external', 11)}</a>` : ''}
        ${a.url_pdf ? `<a class="flh-btn flh-btn--sm" href="${h(a.url_pdf)}" target="_blank" rel="noopener noreferrer">PDF ${icon('external', 11)}</a>` : ''}
        ${a.estado === 'nueva' ? `<button type="button" class="flh-btn flh-btn--sm" data-act="revisar" data-id="${h(a.id)}">${icon('check', 12)}Revisada</button><button type="button" class="flh-btn flh-btn--sm" data-act="descartar" data-id="${h(a.id)}">Descartar</button>` : `<button type="button" class="flh-btn flh-btn--sm" data-act="reabrir" data-id="${h(a.id)}">Reabrir</button>`}
      </span></div></li>`;
  }).join('')}</ul>` : '<div class="flh-empty">Ninguna alerta con estos filtros en los últimos 60 días.</div>';
}

function abrirAlerta(id) {
  const a = S.byId.alertas?.get(id);
  if (!a) { toast('Alerta no disponible'); return; }
  const [rl, rt] = RELEVANCIA[a.relevancia] ?? ['—', 'muted'];
  const fila = (dt, dd, full) => (dd ? `<div class="flh-field${full ? ' flh-field--full' : ''}"><dt>${dt}</dt><dd>${dd}</dd></div>` : '');
  M.abrir({
    kicker: `${h(a.fuente)} · ${h(a.seccion_nombre || '')}`,
    titulo: `<span class="flh-serif">${h(a.titulo)}</span>`,
    cuerpo: `<div class="flh-inline" style="margin-bottom:14px">${pill(rl, rt)}${(a.categorias || []).map((c) => pill(S.data.meta.categorias.find((x) => x.key === c)?.label ?? c, 'muted')).join('')}${pill(ESTADO_ALERTA[a.estado] || a.estado, a.estado === 'nueva' ? 'gold' : 'muted')}</div>
      <dl class="flh-fields">
        ${fila('Identificador', `<span class="mono">${h(a.id)}</span>`)}
        ${fila('Publicación', h(L.fmtFechaLarga(a.fecha_publicacion)))}
        ${fila(a.fuente === 'BORME' ? 'Apartado / provincia' : 'Departamento', h(a.departamento || ''))}
        ${fila('Puntuación', a.puntuacion ? `${a.puntuacion} (${h(rl.toLowerCase())})` : '')}
        ${fila('Sociedad del grupo', a.sociedad_id ? h(S.soc.get(a.sociedad_id)?.denominacion ?? '') : '')}
        ${fila('Acto inscrito', a.acto && a.seccion === 'A' ? h(a.acto) : '', true)}
        ${fila('Revisión', a.revisada_por ? h(`${a.revisada_por} · ${new Date(a.revisada_at).toLocaleString('es-ES')}`) : '')}
      </dl>`,
    pie: `<div>${a.url_html ? `<a class="flh-btn" href="${h(a.url_html)}" target="_blank" rel="noopener noreferrer">Abrir en boe.es ${icon('external', 12)}</a>` : ''}${a.url_pdf ? `<a class="flh-btn" href="${h(a.url_pdf)}" target="_blank" rel="noopener noreferrer">PDF ${icon('external', 12)}</a>` : ''}</div>
      <div>${a.estado === 'nueva' ? `<button type="button" class="flh-btn" data-act="descartar" data-id="${h(a.id)}">Descartar</button><button type="button" class="flh-btn flh-btn--gold" data-act="revisar" data-id="${h(a.id)}">${icon('check', 14)}Marcar revisada</button>` : `<button type="button" class="flh-btn" data-act="reabrir" data-id="${h(a.id)}">Reabrir</button>`}</div>`,
    onAct: (act, el) => {
      const estado = { revisar: 'revisada', descartar: 'descartada', reabrir: 'nueva' }[act];
      if (!estado) return;
      api.flAlertaEstado(el.dataset.id, estado)
        .then(() => cargar({ silencioso: true }))
        .then(() => { toast(estado === 'nueva' ? 'Alerta reabierta' : `Alerta ${estado}`); abrirAlerta(id); })
        .catch((ex) => toast(ex.message));
    },
  });
}

async function sincronizar(boton) {
  if (boton) { boton.disabled = true; }
  toast('Sincronizando con el BOE…');
  try {
    const r = await api.flBoletinesSync();
    toast(r.errores?.length ? `Sincronización parcial: ${r.nuevas} nuevas, ${r.errores.length} errores` : `${r.nuevas} alertas nuevas`);
    await cargar({ silencioso: true });
    if (M.el.open && $('#flhAlertasLista', M.el)) abrirAlertas();
  } catch (ex) {
    toast(ex.message || 'No se pudo sincronizar');
  } finally {
    if (boton) boton.disabled = false;
  }
}

/* ------------------------------------------------------------------------
   Otros dialogos
   ------------------------------------------------------------------------ */
function abrirInfoDehu() {
  const dehu = S.data.meta.portales.find((p) => p.key === 'dehu');
  M.abrir({
    kicker: 'Estado del conector',
    titulo: 'DEHú · sin conector configurado',
    cuerpo: `<div class="flh-block flh-block--warn"><p>SYSTEMS no está enlazado con la Dirección Electrónica Habilitada única: no recibe notificaciones automáticamente ni comparece en nombre de la sociedad. Conectarla exige un acuerdo con la Administración y un certificado de la sociedad custodiado en el servidor.</p>
      <p>Mientras tanto, registra cada notificación en GobTech al verla en la DEHú o en la sede. La mesa calcula el rechazo presunto a los diez días naturales de la puesta a disposición (art. 43.2 Ley 39/2015) y el plazo de respuesta desde el acuse, y avisa al Admin cuando quedan tres días.</p></div>`,
    pie: `<div>${dehu ? `<a class="flh-btn" href="${h(dehu.url)}" target="_blank" rel="noopener noreferrer">Abrir la DEHú ${icon('external', 12)}</a>` : ''}</div><div><button type="button" class="flh-btn flh-btn--gold" data-act="ir-gobtech">Ir a GobTech</button></div>`,
    onAct: (act) => { if (act === 'ir-gobtech') { M.cerrar(); irATab('gobtech'); } },
  });
}

function confirmarRetirarDemo() {
  M.abrir({
    kicker: 'Datos de demostración',
    titulo: 'Retirar los datos de demostración',
    cuerpo: `<div class="flh-block flh-block--warn"><p>Se archivan los <b>${S.data.demo.registros}</b> registros marcados como DEMO (sociedades, modelos, notificaciones, juntas, poderes, contratos y checklist). No se borran: quedan en Mongo y la operación se anota en fl_log.</p>
      <p>Los registros corregidos y marcados como dato real, y las alertas BOE/BORME (que son reales), no se tocan.</p></div>`,
    pie: '<div></div><div><button type="button" class="flh-btn" data-act="cerrar">Cancelar</button><button type="button" class="flh-btn flh-btn--danger" data-act="retirar">Retirar demostración</button></div>',
    onAct: (act) => {
      if (act !== 'retirar') return;
      tras(api.flRetirarDemo(), 'Datos de demostración archivados');
    },
  });
}

/* ------------------------------------------------------------------------
   Command bar (Ctrl/⌘ K)
   ------------------------------------------------------------------------ */
const P = { el: null, input: null, lista: null, res: [], activo: 0 };

function initPaleta() {
  P.el = $('#flhPalette');
  P.el.innerHTML = `<input class="flh-palette__input" type="search" placeholder="Buscar NIF, referencia BOE, contrato, modelo, expediente…" aria-label="Buscar en S-NFI F&L" autocomplete="off" spellcheck="false">
    <ul class="flh-palette__list" role="listbox" aria-label="Resultados"></ul>
    <div class="flh-palette__foot"><span><kbd class="flh-kbd">↑</kbd> <kbd class="flh-kbd">↓</kbd> navegar</span><span><kbd class="flh-kbd">Enter</kbd> abrir</span><span><kbd class="flh-kbd">Esc</kbd> cerrar</span></div>`;
  P.input = $('input', P.el);
  P.lista = $('ul', P.el);
  P.input.addEventListener('input', () => { P.activo = 0; actualizarPaleta(); });
  P.input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); P.activo = Math.min(P.res.length - 1, P.activo + 1); pintarPaleta(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); P.activo = Math.max(0, P.activo - 1); pintarPaleta(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (P.res[P.activo]) seleccionarResultado(P.res[P.activo]); }
  });
  P.el.addEventListener('click', (e) => {
    if (e.target === P.el) { P.el.close(); return; }
    const li = e.target.closest('[data-i]');
    if (li) seleccionarResultado(P.res[Number(li.dataset.i)]);
  });
}

function abrirPaleta() {
  if (!S.data) return;
  if (M.el.open) M.cerrar();
  P.input.value = '';
  P.activo = 0;
  actualizarPaleta();
  P.el.showModal();
  P.input.focus();
}

function actualizarPaleta() {
  const q = P.input.value;
  const encontrados = L.buscar(S.indice, q, 16);
  const grupos = [];
  for (const r of encontrados) if (!grupos.includes(r.grupo)) grupos.push(r.grupo);
  P.res = grupos.flatMap((g) => encontrados.filter((r) => r.grupo === g));
  pintarPaleta();
}

function pintarPaleta() {
  const q = P.input.value.trim();
  if (!q) {
    P.lista.innerHTML = '<li class="flh-palette__empty">Prueba con <b>B00000003</b>, <b>modelo 200</b>, <b>DEHú AEAT</b>, <b>BOE-A</b>, <b>PPA</b> o <b>art. 43</b>.</li>';
    return;
  }
  if (!P.res.length) {
    P.lista.innerHTML = `<li class="flh-palette__empty">Sin resultados para «${h(q)}».</li>`;
    return;
  }
  let grupo = null;
  P.lista.innerHTML = P.res.map((r, i) => {
    const cab = r.grupo !== grupo ? `<li class="flh-palette__group" role="presentation">${h(r.grupo)}</li>` : '';
    grupo = r.grupo;
    return `${cab}<li class="flh-palette__item${i === P.activo ? ' is-active' : ''}" role="option" aria-selected="${String(i === P.activo)}" data-i="${i}">
      <span class="flh-code${r.entidad === 'modelos' || r.entidad === 'normas' ? ' flh-code--gold' : ''}">${h(String(r.codigo || '').slice(0, 12))}</span>
      <span style="min-width:0"><span class="t">${h(r.titulo)}</span><span class="s">${h(r.sub || '')}</span></span>
      <span class="flh-tag">${h(r.tab === 'overview' ? 'Centro de mando' : r.tab)}</span></li>`;
  }).join('');
  $('.is-active', P.lista)?.scrollIntoView({ block: 'nearest' });
}

function seleccionarResultado(r) {
  P.el.close();
  if (r.entidad === 'normas') {
    S.normasQ = r.titulo;
    irATab('fiscal');
    rerender('fiscal');
    $('#flhNormas')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (r.entidad === 'alertas') { abrirAlerta(r.id); return; }
  irATab(r.tab);
  abrirDetalle(r.entidad, r.id);
}

/* ------------------------------------------------------------------------
   Delegacion de eventos de las vistas
   ------------------------------------------------------------------------ */
function aplicarSegmento(btn) {
  const grupo = btn.closest('[data-seg]').dataset.seg;
  const [sec, campo] = grupo.split('.');
  S[sec][campo] = btn.dataset.v;
  $$('button', btn.closest('[data-seg]')).forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
  return { sec, campo };
}

function accionComun(act, el) {
  switch (act) {
    case 'abrir': case 'evento': abrirDetalle(el.dataset.entidad, el.dataset.id); return true;
    case 'historial': abrirDetalle(el.dataset.entidad, el.dataset.id, { pestana: 'historial' }); return true;
    case 'pdf': abrirPdf(el.dataset.entidad, el.dataset.id); return true;
    case 'nuevo': abrirFormulario(el.dataset.entidad, null); return true;
    case 'alerta': abrirAlerta(el.dataset.id); return true;
    case 'alertas': abrirAlertas(); return true;
    case 'sync': sincronizar(el); return true;
    case 'copiar':
      navigator.clipboard?.writeText(el.dataset.texto).then(() => toast('Copiado al portapapeles'), () => toast('No se pudo copiar'));
      return true;
    case 'ir-tab':
      if (el.dataset.preset === 'gob-sin-acuse') S.gob.estado = 'sin_acuse';
      if (el.dataset.preset === 'fiscal-pendientes') S.fiscal.estado = 'pendiente';
      S.sucio.add(el.dataset.tab);
      irATab(el.dataset.tab);
      return true;
    default: return false;
  }
}

const PARCIAL = {
  fiscal: () => renderFiscalResultados(),
  gob: () => renderGobtechResultados(),
  clm: () => renderClmResultados(),
  corp: () => renderJuntas(),
  cal: () => renderCalendario(),
};

function onClickPanel(e) {
  const segBtn = e.target.closest('[data-seg] button');
  if (segBtn) {
    const { sec } = aplicarSegmento(segBtn);
    PARCIAL[sec]?.();
    tick();
    return;
  }
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const act = el.dataset.act;
  const c = S.cal;
  switch (act) {
    case 'cal-prev': case 'cal-next': {
      const delta = act === 'cal-prev' ? -1 : 1;
      const m = c.month + delta;
      c.year += Math.floor(m / 12);
      c.month = ((m % 12) + 12) % 12;
      c.dia = null;
      renderCalendario();
      return;
    }
    case 'cal-hoy':
      c.year = Number(hoy().slice(0, 4));
      c.month = Number(hoy().slice(5, 7)) - 1;
      c.dia = hoy();
      renderCalendario();
      return;
    case 'cal-dia':
      c.dia = el.dataset.fecha && el.dataset.fecha !== c.dia ? el.dataset.fecha : null;
      renderCalendario();
      return;
    case 'cal-tipo': {
      const t = el.dataset.v;
      if (c.tipos.has(t)) c.tipos.delete(t); else c.tipos.add(t);
      renderCalendario();
      return;
    }
    case 'check-ciclo': {
      const p = S.byId.checklist.get(el.dataset.id);
      if (!p) return;
      el.disabled = true;
      api.flActualizar('checklist', p.id, { estado: CICLO_CHECK[p.estado] })
        .then(() => cargar({ silencioso: true }))
        .catch((ex) => { toast(ex.message); el.disabled = false; });
      return;
    }
    case 'fiscal-todos':
      S.fiscalTodos = !S.fiscalTodos;
      renderFiscalResultados();
      return;
    case 'clm-tipo':
      S.clm.tipo = el.dataset.v;
      $$('[data-act="clm-tipo"]', $('#panel-clm')).forEach((b) => b.setAttribute('aria-pressed', String(b === el)));
      renderClmResultados();
      return;
    default:
      accionComun(act, el);
  }
}

function onFiltro(e) {
  const k = e.target.dataset.filtro;
  if (!k) return;
  if (k === 'normasQ') {
    S.normasQ = e.target.value;
    $('#flhNormasLista').innerHTML = normasListaHtml();
    return;
  }
  const [sec, campo] = k.split('.');
  S[sec][campo] = e.target.value;
  PARCIAL[sec]?.();
  tick();
}

function onSubmitPanel(e) {
  const form = e.target.closest('[data-form]');
  if (!form) return;
  e.preventDefault();
  if (form.dataset.form === 'dgt') consultarDgt(form.elements.q.value);
}

/* ------------------------------------------------------------------------
   Arranque
   ------------------------------------------------------------------------ */
export function initFlHub(opts = {}) {
  opciones = opts;
  M.init();
  initPaleta();

  const tabs = $('#flhTabs');
  tabs.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) irATab(b.dataset.tab);
  });
  tabs.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const visibles = TABS.filter((t) => !$(`#tab-${t}`).hidden);
    const i = visibles.indexOf(S.tab);
    const sig = visibles[(i + (e.key === 'ArrowRight' ? 1 : -1) + visibles.length) % visibles.length];
    irATab(sig);
    $(`#tab-${sig}`).focus();
  });

  for (const t of HUB_TABS) {
    const panel = $(`#panel-${t}`);
    panel.addEventListener('click', onClickPanel);
    // Los <select> tambien emiten 'input' al cambiar: un solo oyente para todos los filtros.
    panel.addEventListener('input', onFiltro);
    panel.addEventListener('submit', onSubmitPanel);
  }

  $('#flhCmd').addEventListener('click', abrirPaleta);
  $('#flhKbd').textContent = /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘ K' : 'Ctrl K';
  $('#flhBell').addEventListener('click', () => { S.gob.estado = 'sin_acuse'; S.sucio.add('gobtech'); irATab('gobtech'); });
  $('#flhSignalDehu').addEventListener('click', () => S.data && abrirInfoDehu());
  $('#flhSignalBoe').addEventListener('click', () => S.data && abrirAlertas());
  $('#flhDemoRetirar').addEventListener('click', () => S.data && confirmarRetirarDemo());

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); abrirPaleta(); return; }
    if (e.key === '/' && !editando() && !M.el.open && !P.el.open) { e.preventDefault(); abrirPaleta(); }
  });

  const inicial = location.hash.slice(1);
  activarTab(TABS.includes(inicial) && !$(`#tab-${inicial}`)?.hidden ? inicial : 'overview');
  // Atras/adelante del navegador o enlace con #pestaña.
  window.addEventListener('hashchange', () => {
    const t = location.hash.slice(1);
    if (TABS.includes(t) && t !== S.tab && !$(`#tab-${t}`)?.hidden) activarTab(t);
  });
  skeletons();
  setInterval(tick, 1000);
  setInterval(() => { if (document.visibilityState === 'visible' && !editando() && !M.el.open) cargar({ silencioso: true }); }, REFRESCO_MS);
  cargar();
  return { irATab };
}
