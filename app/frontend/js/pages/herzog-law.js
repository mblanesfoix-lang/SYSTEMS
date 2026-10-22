import { api, getUser, requireAuth, clearSession, toast, escapeHtml, uploadHerzogLawDocument, openAuthenticatedFile } from '/js/api.js';
import { mountThemeToggle } from '/js/theme.js';
import { mountAdminNotifications } from '/js/notifications.js';
import {
  $, $$, showError, fmtDay, fmtBytes, STATUS_LABEL, PRIORITY_LABEL, NATURE_LABEL, KIND_LABEL, JURISDICTION_LABEL,
  expiryPill, statusPill, priorityMark, progressBar,
} from './herzog-law-common.js';
import { initCbam } from './herzog-law-cbam.js';
import { initAtex } from './herzog-law-atex.js';
import { initActivity } from './herzog-law-activity.js';

requireAuth();
mountThemeToggle(document.querySelector('nav.nav .row'));
document.getElementById('userTag').textContent = getUser() || '';
mountAdminNotifications(document.querySelector('nav.nav .row'));

/* ---------- menu de usuario ---------- */
const trigger = document.getElementById('userTag');
const dropdown = document.getElementById('userDropdown');
trigger.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = !dropdown.hidden;
  dropdown.hidden = open;
  trigger.setAttribute('aria-expanded', String(!open));
});
document.addEventListener('click', (e) => {
  if (!document.getElementById('userMenu').contains(e.target)) {
    dropdown.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
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
    dropdown.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    ['pwdCurrent', 'pwdNew', 'pwdConfirm'].forEach((id) => { document.getElementById(id).value = ''; });
  } catch (ex) {
    errEl.textContent = ex.message || 'Error al cambiar contraseña';
    errEl.hidden = false;
  }
});
document.getElementById('logoutBtn').addEventListener('click', async () => {
  try { await api.logout(); } catch { /* la sesion se limpia igualmente */ }
  clearSession();
  location.href = '/pages/login.html';
});

/* ---------- estado ---------- */
const state = {
  frameworks: [],
  summary: null,
  zones: [],
  filters: { kind: '', priority: '', status: '', query: '' },
  openId: null,
  docs: [],
};

const FAMILY_ORDER = ['Seguridad y explosiones', 'Aduanas y carbono', 'Argelia', 'Producto y combustible', 'Carbono y clima', 'Gestión', 'Datos e IA', 'Integridad', 'Títulos del Estado', 'Otros'];
const KIND_ORDER = ['iso', 'ue', 'local', 'titulo', 'otro'];
const ALLOWED_UPLOADS = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_ATTENTION = 7;

const byId = (id) => state.frameworks.find((f) => f.id === id);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function groupByFamily(list) {
  const groups = new Map();
  for (const f of list) {
    if (!groups.has(f.family)) groups.set(f.family, []);
    groups.get(f.family).push(f);
  }
  const rank = (name) => { const i = FAMILY_ORDER.indexOf(name); return i === -1 ? FAMILY_ORDER.length : i; };
  return [...groups.entries()].sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0], 'es'));
}

/* ---------- carga ---------- */
async function loadAll() {
  try {
    const [summary, frameworks, zones] = await Promise.all([api.herzogLawSummary(), api.herzogLawFrameworks(), api.herzogLawZones()]);
    Object.assign(state, { summary, frameworks, zones });
    showError('');
    renderAll();
  } catch (ex) {
    showError(ex.message || 'No se pudo cargar Herzog LaW');
  }
}

async function refreshSummary() {
  try {
    state.summary = await api.herzogLawSummary();
    renderHero();
    renderKpis();
    renderOverview();
  } catch (ex) {
    showError(ex.message || 'No se pudo actualizar el resumen');
  }
}

/** Sustituye un marco por su version del servidor y repinta todo lo que lo muestra. */
function applyFramework(updated) {
  const i = state.frameworks.findIndex((f) => f.id === updated.id);
  if (i === -1) state.frameworks.push(updated); else state.frameworks[i] = updated;
  renderFrameworks();
  renderOverview();
  renderDrawer();
  updateTabCounts();
  refreshSummary();
}

async function reloadZones() {
  state.zones = await api.herzogLawZones();
  renderKpis();
  renderOverview();
  updateTabCounts();
  atex?.render();
  refreshSummary();
}

function renderAll() {
  renderHero();
  renderKpis();
  renderOverview();
  renderFrameworks();
  renderDrawer();
  updateTabCounts();
  atex?.render();
}

function updateTabCounts() {
  document.getElementById('tabFrameworksCount').textContent = state.frameworks.length || '';
  document.getElementById('tabZonesCount').textContent = state.zones.length || '';
}

/* ---------- hero y KPIs ---------- */
const RING_LENGTH = 2 * Math.PI * 60;
const ringBar = document.getElementById('ringBar');
ringBar.style.strokeDasharray = String(RING_LENGTH);
ringBar.style.strokeDashoffset = String(RING_LENGTH);

function renderHero() {
  const { done, total, pct } = state.summary.highPriority.readiness;
  requestAnimationFrame(() => { ringBar.style.strokeDashoffset = String(RING_LENGTH * (1 - pct / 100)); });
  document.getElementById('ringPct').textContent = `${pct}%`;
  document.getElementById('ringCaption').textContent = total
    ? `${done} de ${total} requisitos de los marcos de prioridad alta`
    : 'Sin requisitos de prioridad alta registrados';
}

function setKpi(id, value, tone, sub) {
  const el = document.getElementById(id);
  el.textContent = value;
  el.className = `law-kpi__value${tone ? ` is-${tone}` : ''}`;
  document.getElementById(`${id}Sub`).textContent = sub;
}

function renderKpis() {
  const { byStatus, upcoming, zones } = state.summary;
  setKpi('kpiFrameworks', state.summary.frameworksCount, '', `${byStatus.vigente || 0} vigentes · ${byStatus.en_preparacion || 0} en preparación`);

  const openHigh = state.frameworks.filter((f) => f.priority === 'alta' && f.status !== 'vigente' && f.status !== 'no_aplica').length;
  setKpi('kpiHigh', openHigh, openHigh ? 'warn' : 'ok', `de ${plural(state.summary.highPriority.frameworks, 'marco de prioridad alta', 'marcos de prioridad alta')}`);

  const dated = state.frameworks.filter((f) => f.status === 'vigente' && f.expiresAt).length;
  if (upcoming.length) {
    const urgent = upcoming.some((u) => u.state !== 'proximo');
    const first = upcoming[0];
    const when = first.state === 'vencido' ? `venció hace ${Math.abs(first.days)} d` : `en ${first.days} d`;
    setKpi('kpiExpiry', upcoming.length, urgent ? 'bad' : 'warn', `${first.code} · ${when}`);
  } else {
    setKpi('kpiExpiry', 0, dated ? 'ok' : '', dated ? 'Todo en plazo' : 'Aún no hay fechas registradas');
  }

  const classified = zones.total - (zones.byStatus.pendiente || 0);
  setKpi('kpiZones', zones.total ? `${classified}/${zones.total}` : '0', '', zones.total ? `${plural(zones.byStatus.pendiente || 0, 'pendiente', 'pendientes')} de clasificar` : 'Aún no hay zonas registradas');
}

/* ---------- panorama ---------- */
function attentionItems() {
  const items = [];
  for (const f of state.frameworks) {
    if (f.status === 'vigente' && ['vencido', 'critico', 'proximo'].includes(f.expiry.state)) {
      const when = f.expiry.state === 'vencido' ? `venció hace ${Math.abs(f.expiry.days)} días` : f.expiry.days === 0 ? 'vence hoy' : `vence en ${f.expiry.days} días`;
      items.push({ rank: f.expiry.state === 'proximo' ? 2 : 0, days: f.expiry.days, tone: f.expiry.state === 'proximo' ? 'is-warn' : 'is-bad', title: `${f.code}: ${when}`, sub: `${f.title} · ${fmtDay(f.expiresAt)}`, open: f.id });
    }
  }
  const pendingZones = state.zones.filter((z) => z.status === 'pendiente').length;
  if (pendingZones) {
    items.push({ rank: 3, days: 0, tone: 'is-warn', title: plural(pendingZones, 'zona ATEX sin clasificar', 'zonas ATEX sin clasificar'), sub: 'Clasifícalas para poder elegir la categoría de equipo de cada una', tab: 'atex' });
  }
  for (const f of state.frameworks) {
    if (f.priority === 'alta' && f.status === 'no_iniciado') {
      items.push({ rank: 4, days: 0, tone: 'is-info', title: `${f.code}: prioridad alta sin iniciar`, sub: f.title, open: f.id });
    }
    if (f.status === 'en_preparacion' && f.readiness.total > 0 && f.readiness.pct === 100) {
      items.push({ rank: 5, days: 0, tone: 'is-ok', title: `${f.code}: requisitos completos`, sub: 'Falta registrar el certificado y marcarlo como vigente', open: f.id });
    }
  }
  return items.sort((a, b) => a.rank - b.rank || a.days - b.days);
}

function renderAttention() {
  const list = document.getElementById('attnList');
  const items = attentionItems();
  if (!items.length) {
    list.innerHTML = '<li class="law-empty">Todo al día: no hay certificados por caducar ni marcos de prioridad alta sin iniciar.</li>';
    return;
  }
  const shown = items.slice(0, MAX_ATTENTION);
  list.innerHTML = shown.map((it) => `<li><button type="button" class="law-attn__item ${it.tone}" ${it.open ? `data-open="${escapeHtml(it.open)}"` : `data-tab="${it.tab}"`}>
      <span class="law-attn__main"><span class="law-attn__title">${escapeHtml(it.title)}</span><span class="law-attn__sub">${escapeHtml(it.sub)}</span></span>
      <span class="law-attn__arrow" aria-hidden="true">›</span>
    </button></li>`).join('') + (items.length > MAX_ATTENTION
    ? `<li><button type="button" class="law-link-btn" data-tab="frameworks">Ver los ${items.length - MAX_ATTENTION} restantes en Normativa</button></li>` : '');
}

function renderState() {
  const { byStatus, byKind, frameworksCount } = state.summary;
  const segments = [['vigente', 'is-ok'], ['en_preparacion', 'is-warn'], ['no_iniciado', 'is-dim'], ['no_aplica', 'is-na']];
  document.getElementById('stateStack').innerHTML = segments
    .filter(([key]) => byStatus[key])
    .map(([key, tone]) => `<div class="law-stack__seg ${tone}" style="flex-basis:${(byStatus[key] / frameworksCount) * 100}%"></div>`).join('');
  document.getElementById('stateLegend').innerHTML = segments
    .map(([key, tone]) => `<li><span class="law-swatch ${tone}"></span>${escapeHtml(STATUS_LABEL[key])}<b>${byStatus[key] || 0}</b></li>`).join('');
  const split = (title, labels, countOf) => `<h3 class="law-split-title">${title}</h3>${Object.entries(labels).map(([key, label]) => {
    const n = countOf(key);
    return `<div class="law-split"><span>${escapeHtml(label)}</span>${progressBar(Math.round((n / frameworksCount) * 100))}<b>${n}</b></div>`;
  }).join('')}`;
  const count = (pick) => (key) => state.frameworks.filter((f) => pick(f, key)).length;
  document.getElementById('kindBreakdown').innerHTML = [
    split('Por ámbito', JURISDICTION_LABEL, count((f, key) => f.jurisdictions.includes(key))),
    split('Por naturaleza', NATURE_LABEL, count((f, key) => f.nature === key)),
    split('Por tipo', Object.fromEntries(KIND_ORDER.filter((k) => byKind[k]).map((k) => [k, KIND_LABEL[k]])), count((f, key) => f.kind === key)),
  ].join('');
}

function renderMap() {
  document.getElementById('readinessMap').innerHTML = groupByFamily(state.frameworks).map(([family, list]) => `
    <div class="law-map-family">
      <div class="law-map-family__name">${escapeHtml(family)}</div>
      <div class="law-map-cells">${list.map((f) => `
        <button type="button" class="law-cell is-${escapeHtml(f.status)}" data-open="${escapeHtml(f.id)}" title="${escapeHtml(f.title)}">
          <span class="law-cell__code">${escapeHtml(f.code)}</span>
          <span class="law-cell__state">${escapeHtml(STATUS_LABEL[f.status])} · ${f.readiness.pct}%</span>
          <span class="law-cell__fill" style="width:${f.readiness.pct}%"></span>
        </button>`).join('')}
      </div>
    </div>`).join('');
}

function renderOverview() {
  renderAttention();
  renderState();
  renderMap();
}

/* ---------- normativa ---------- */
function filteredFrameworks() {
  const { kind, priority, status, query } = state.filters;
  const q = query.trim().toLowerCase();
  return state.frameworks.filter((f) => (!kind || f.kind === kind)
    && (!priority || f.priority === priority)
    && (!status || f.status === status)
    && (!q || `${f.code} ${f.title} ${f.summary || ''}`.toLowerCase().includes(q)));
}

function renderKindFilters() {
  const counts = state.frameworks.reduce((acc, f) => ({ ...acc, [f.kind]: (acc[f.kind] || 0) + 1 }), {});
  const chips = [['', 'Todos', state.frameworks.length], ...KIND_ORDER.filter((k) => counts[k] || k === 'titulo').map((k) => [k, KIND_LABEL[k], counts[k] || 0])];
  document.getElementById('kindFilters').innerHTML = chips
    .map(([value, label, n]) => `<button type="button" class="law-filter" data-kind="${value}" aria-pressed="${state.filters.kind === value}">${escapeHtml(label)}<span class="law-filter__n">${n}</span></button>`).join('');
}

function frameworkCard(f) {
  const tags = [
    `<span class="law-pill is-info">${escapeHtml(NATURE_LABEL[f.nature] || f.nature)}</span>`,
    expiryPill(f.expiry),
    ...f.jurisdictions.map((j) => `<span class="law-chip">${escapeHtml(JURISDICTION_LABEL[j] || j)}</span>`),
  ].filter(Boolean).join('');
  return `<button type="button" class="law-card${f.status === 'no_aplica' ? ' is-na' : ''}" data-open="${escapeHtml(f.id)}">
      <div class="law-card__top"><span class="law-card__code">${escapeHtml(f.code)}</span>${priorityMark(f.priority)}</div>
      <h3 class="law-card__title">${escapeHtml(f.title)}</h3>
      <div class="law-card__tags">${statusPill(f.status)}${tags}</div>
      <div class="law-card__progress">${progressBar(f.readiness.pct)}<span>${f.readiness.done} de ${f.readiness.total}</span></div>
    </button>`;
}

function renderFrameworks() {
  renderKindFilters();
  document.getElementById('familyOptions').innerHTML = [...new Set([...FAMILY_ORDER, ...state.frameworks.map((f) => f.family)])]
    .map((name) => `<option value="${escapeHtml(name)}"></option>`).join('');

  const list = filteredFrameworks();
  const host = document.getElementById('frameworkList');
  if (!list.length) {
    const forTitles = state.filters.kind === 'titulo' && !state.filters.query && !state.filters.priority && !state.filters.status;
    host.innerHTML = forTitles
      ? `<div class="law-empty">Aún no hay títulos del Estado registrados.<br><br><button type="button" class="btn sage" data-add-kind="titulo">Registrar un título del Estado</button></div>`
      : '<div class="law-empty">Ningún marco coincide con los filtros.</div>';
    return;
  }
  host.innerHTML = groupByFamily(list).map(([family, items]) => `
    <section class="law-family">
      <div class="law-family__head"><h2 class="law-family__name">${escapeHtml(family)}</h2><span class="law-family__n">${items.length}</span></div>
      <div class="law-cards">${items.map(frameworkCard).join('')}</div>
    </section>`).join('');
}

document.getElementById('kindFilters').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-kind]');
  if (!btn) return;
  state.filters.kind = btn.dataset.kind;
  renderFrameworks();
});
document.getElementById('searchInput').addEventListener('input', (e) => { state.filters.query = e.target.value; renderFrameworks(); });
document.getElementById('priorityFilter').addEventListener('change', (e) => { state.filters.priority = e.target.value; renderFrameworks(); });
document.getElementById('statusFilter').addEventListener('change', (e) => { state.filters.status = e.target.value; renderFrameworks(); });

/* ---------- cajon de detalle ---------- */
const drawer = document.getElementById('drawer');
const overlay = document.getElementById('overlay');
drawer.setAttribute('inert', '');
let lastFocus = null;

async function openDrawer(id) {
  if (!byId(id)) return;
  lastFocus = document.activeElement;
  state.openId = id;
  state.docs = [];
  drawer.removeAttribute('inert');
  drawer.setAttribute('aria-hidden', 'false');
  drawer.classList.add('is-open');
  overlay.classList.add('is-open');
  renderDrawer();
  drawer.querySelector('[data-close]')?.focus();
  await loadDocs(id);
}

function closeDrawer() {
  state.openId = null;
  drawer.classList.remove('is-open');
  overlay.classList.remove('is-open');
  drawer.setAttribute('aria-hidden', 'true');
  drawer.setAttribute('inert', '');
  if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
}

async function loadDocs(id) {
  try {
    state.docs = await api.herzogLawDocuments(id);
  } catch (ex) {
    showDrawerError(ex.message || 'No se pudieron cargar los documentos');
  }
  if (state.openId === id) renderDrawer();
}

function showDrawerError(message) {
  const box = drawer.querySelector('#drawerError');
  if (!box) return;
  box.textContent = message || '';
  box.style.display = message ? 'block' : 'none';
}

const dateValue = (v) => escapeHtml(v || '');

function renderDrawer() {
  const f = state.openId ? byId(state.openId) : null;
  if (!f) { drawer.innerHTML = ''; return; }
  const scroll = drawer.querySelector('.law-drawer__body')?.scrollTop ?? 0;
  const options = (labels, current) => Object.entries(labels).map(([value, label]) => `<option value="${value}"${value === current ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('');
  const docRows = state.docs.map((d) => `<div class="law-doc" data-doc="${escapeHtml(d.id)}">
      <div><button type="button" class="law-doc__name" data-doc-open="${escapeHtml(d.id)}" data-name="${escapeHtml(d.filename)}">${escapeHtml(d.filename)}</button>
      <span class="law-doc__meta">${fmtBytes(d.size)} · ${escapeHtml(d.uploadedBy || '–')} · ${escapeHtml(fmtDay((d.uploadedAt || '').slice(0, 10)))}</span></div>
      <button type="button" class="law-link-btn is-danger" data-doc-del="${escapeHtml(d.id)}">Eliminar</button>
    </div>`).join('');
  const reqRows = f.requirements.map((r) => `<li class="law-req${r.done ? ' is-done' : ''}">
      <input type="checkbox" data-req="${escapeHtml(r.id)}" id="req-${escapeHtml(r.id)}"${r.done ? ' checked' : ''} aria-label="Marcar como cumplido">
      <label class="law-req__text" for="req-${escapeHtml(r.id)}">${escapeHtml(r.text)}
        ${r.done ? `<span class="law-req__meta">Cumplido por ${escapeHtml(r.doneBy || '–')} · ${escapeHtml(fmtDay((r.doneAt || '').slice(0, 10)))}</span>` : (r.custom ? '<span class="law-req__meta">Requisito propio</span>' : '')}
      </label>
      ${r.custom ? `<button type="button" class="law-req__del" data-req-del="${escapeHtml(r.id)}" aria-label="Quitar requisito" title="Quitar requisito">&times;</button>` : ''}
    </li>`).join('');
  const refs = f.references.map((r) => `<li><a href="${escapeHtml(r.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(r.label)} ↗</a></li>`).join('');

  drawer.innerHTML = `
    <div class="law-drawer__head">
      <div><span class="law-drawer__code">${escapeHtml(f.code)}</span><h2 class="law-drawer__title" id="drawerTitle">${escapeHtml(f.title)}</h2></div>
      <button type="button" class="law-drawer__close" data-close aria-label="Cerrar">&times;</button>
    </div>
    <div class="law-drawer__body">
      <p class="law-error" id="drawerError" role="alert"></p>
      <div class="law-drawer__tags">
        ${statusPill(f.status)}${expiryPill(f.expiry)}
        <span class="law-pill is-info">${escapeHtml(NATURE_LABEL[f.nature] || f.nature)}</span>
        ${priorityMark(f.priority)}
        ${f.jurisdictions.map((j) => `<span class="law-chip">${escapeHtml(JURISDICTION_LABEL[j] || j)}</span>`).join('')}
      </div>
      ${f.summary ? `<div class="law-sec"><h3 class="law-sec__title">Qué es</h3><p>${escapeHtml(f.summary)}</p></div>` : ''}
      ${f.appliesWhen ? `<div class="law-sec"><div class="law-callout"><b>Cuándo aplica.</b> ${escapeHtml(f.appliesWhen)}</div></div>` : ''}
      ${f.why ? `<div class="law-sec"><h3 class="law-sec__title">Por qué importa a S-NFI</h3><p>${escapeHtml(f.why)}</p></div>` : ''}

      <div class="law-sec">
        <h3 class="law-sec__title">Estado y certificado</h3>
        <form id="certForm" class="law-form" novalidate>
          <div><label for="cfStatus">Estado</label><select id="cfStatus">${options(STATUS_LABEL, f.status)}</select></div>
          <div><label for="cfPriority">Prioridad</label><select id="cfPriority">${options(PRIORITY_LABEL, f.priority)}</select></div>
          <div><label for="cfOwner">Responsable</label><input class="input" id="cfOwner" maxlength="120" value="${escapeHtml(f.owner || '')}" placeholder="Persona o área"></div>
          <div><label for="cfIssuer">Entidad emisora</label><input class="input" id="cfIssuer" maxlength="160" value="${escapeHtml(f.issuer || '')}" placeholder="Quién lo concede"></div>
          <div><label for="cfNumber">Número de certificado</label><input class="input" id="cfNumber" maxlength="80" value="${escapeHtml(f.certNumber || '')}"></div>
          <div><label for="cfIssued">Fecha de emisión</label><input class="input" type="date" id="cfIssued" value="${dateValue(f.issuedAt)}"></div>
          <div class="is-wide"><label for="cfExpires">Fecha de vencimiento</label><input class="input" type="date" id="cfExpires" value="${dateValue(f.expiresAt)}"><span class="law-help">Con el estado «Vigente» y una fecha, Herzog avisa al Admin cuando falten 90 y 30 días, y si vence.</span></div>
          <div class="is-wide"><label for="cfNotes">Notas</label><textarea class="input" id="cfNotes" maxlength="4000" rows="3">${escapeHtml(f.notes || '')}</textarea></div>
          <div class="is-wide law-form__actions"><button type="submit" class="btn sage">Guardar</button></div>
        </form>
      </div>

      <div class="law-sec">
        <h3 class="law-sec__title"><span>Requisitos</span><span class="mono">${f.readiness.done} de ${f.readiness.total}</span></h3>
        <div style="margin-bottom:14px;">${progressBar(f.readiness.pct)}</div>
        <ul class="law-reqs">${reqRows || '<li class="law-empty">Aún no hay requisitos. Añade el primero.</li>'}</ul>
        <form id="reqForm" class="law-add" novalidate>
          <input class="input" id="reqText" maxlength="300" placeholder="Añadir un requisito propio" aria-label="Nuevo requisito">
          <button type="submit" class="btn ghost">Añadir</button>
        </form>
      </div>

      <div class="law-sec">
        <h3 class="law-sec__title">Certificados y documentos</h3>
        <div class="law-docs">${docRows || '<div class="law-empty">Aún no hay documentos. Sube aquí el certificado o la evidencia.</div>'}</div>
        <label class="btn ghost" for="docInput" style="cursor:pointer;">Subir documento</label>
        <input type="file" id="docInput" accept=".pdf,.jpg,.jpeg,.png,.webp,.docx" hidden>
        <span class="law-help">PDF, imagen (JPG, PNG, WebP) o Word (DOCX), hasta 20 MB.</span>
      </div>

      ${refs ? `<div class="law-sec"><h3 class="law-sec__title">Fuentes</h3><ul class="law-refs">${refs}</ul></div>` : ''}

      ${f.seed ? '' : `<div class="law-sec"><h3 class="law-sec__title">Marco propio</h3>
        <div class="law-form__actions" style="justify-content:flex-start;">
          <button type="button" class="btn ghost" data-edit-framework>Editar datos</button>
          <button type="button" class="btn ghost" style="color:var(--amg-red);" data-delete-framework>Eliminar marco</button>
        </div></div>`}
    </div>`;
  const body = drawer.querySelector('.law-drawer__body');
  if (body) body.scrollTop = scroll;
}

async function mutate(action, okMessage) {
  showDrawerError('');
  try {
    const result = await action();
    if (okMessage) toast(okMessage);
    return result;
  } catch (ex) {
    showDrawerError(ex.message || 'No se pudo completar la acción');
    return null;
  }
}

drawer.addEventListener('click', async (e) => {
  const id = state.openId;
  if (e.target.closest('[data-close]')) return closeDrawer();

  const reqDel = e.target.closest('[data-req-del]');
  if (reqDel) {
    const updated = await mutate(() => api.herzogLawRequirementDelete(id, reqDel.dataset.reqDel));
    if (updated) applyFramework(updated);
    return;
  }
  const docOpen = e.target.closest('[data-doc-open]');
  if (docOpen) {
    await mutate(() => openAuthenticatedFile(`/api/herzog-law/documents/${docOpen.dataset.docOpen}`, docOpen.dataset.name));
    return;
  }
  const docDel = e.target.closest('[data-doc-del]');
  if (docDel) {
    if (!confirm('¿Eliminar este documento? Quedará registrado en el log.')) return;
    const ok = await mutate(() => api.herzogLawDocumentDelete(docDel.dataset.docDel), 'Documento eliminado');
    if (ok) { await loadDocs(id); refreshSummary(); }
    return;
  }
  if (e.target.closest('[data-edit-framework]')) return openFrameworkDialog(byId(id));
  if (e.target.closest('[data-delete-framework]')) {
    const f = byId(id);
    if (!confirm(`¿Eliminar «${f.code}» y sus documentos? Quedará registrado en el log.`)) return;
    const ok = await mutate(() => api.herzogLawFrameworkDelete(id), 'Marco eliminado');
    if (ok) { closeDrawer(); await loadAll(); }
  }
});

drawer.addEventListener('change', async (e) => {
  const id = state.openId;
  const checkbox = e.target.closest('[data-req]');
  if (checkbox) {
    const updated = await mutate(() => api.herzogLawRequirementSet(id, checkbox.dataset.req, checkbox.checked));
    if (updated) applyFramework(updated); else renderDrawer();
    return;
  }
  if (e.target.id === 'docInput') {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (!ALLOWED_UPLOADS.includes(file.type)) return showDrawerError('Formato no permitido. Usa PDF, imagen o DOCX.');
    if (file.size > MAX_UPLOAD_BYTES) return showDrawerError('El archivo supera los 20 MB.');
    const ok = await mutate(() => uploadHerzogLawDocument(file, id), 'Documento subido');
    if (ok) { await loadDocs(id); refreshSummary(); }
  }
});

drawer.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = state.openId;
  if (e.target.id === 'certForm') {
    const value = (field) => drawer.querySelector(field).value;
    const updated = await mutate(() => api.herzogLawFrameworkUpdate(id, {
      status: value('#cfStatus'),
      priority: value('#cfPriority'),
      owner: value('#cfOwner'),
      issuer: value('#cfIssuer'),
      certNumber: value('#cfNumber'),
      issuedAt: value('#cfIssued'),
      expiresAt: value('#cfExpires'),
      notes: value('#cfNotes'),
    }), 'Cambios guardados');
    if (updated) applyFramework(updated);
  } else if (e.target.id === 'reqForm') {
    const input = drawer.querySelector('#reqText');
    if (!input.value.trim()) return showDrawerError('Escribe el requisito');
    const updated = await mutate(() => api.herzogLawRequirementAdd(id, input.value.trim()), 'Requisito añadido');
    if (updated) applyFramework(updated);
  }
});

overlay.addEventListener('click', closeDrawer);

/* ---------- dialogo de marco ---------- */
const fwDialog = document.getElementById('frameworkDialog');
const fwError = document.getElementById('fwError');
let editingId = null;

function openFrameworkDialog(framework, presetKind) {
  editingId = framework ? framework.id : null;
  fwError.style.display = 'none';
  document.getElementById('fwDialogTitle').textContent = framework ? 'Editar marco' : 'Añadir marco o título';
  document.getElementById('fwCode').value = framework?.code ?? '';
  document.getElementById('fwTitle').value = framework?.title ?? '';
  document.getElementById('fwKind').value = framework?.kind ?? presetKind ?? 'titulo';
  document.getElementById('fwNature').value = framework?.nature ?? 'obligatoria';
  document.getElementById('fwPriority').value = framework?.priority ?? 'media';
  document.getElementById('fwFamily').value = framework?.family ?? '';
  document.getElementById('fwSummary').value = framework?.summary ?? '';
  document.getElementById('fwReqs').value = '';
  document.getElementById('fwReqsWrap').hidden = Boolean(framework);
  $$('#fwJuris input').forEach((box) => { box.checked = Boolean(framework?.jurisdictions.includes(box.value)); });
  fwDialog.showModal();
  document.getElementById('fwCode').focus();
}

document.getElementById('addFrameworkBtn').addEventListener('click', () => openFrameworkDialog(null));
document.getElementById('fwCancel').addEventListener('click', () => fwDialog.close());
document.getElementById('frameworkList').addEventListener('click', (e) => {
  const add = e.target.closest('[data-add-kind]');
  if (add) openFrameworkDialog(null, add.dataset.addKind);
});

document.getElementById('frameworkForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = document.getElementById('fwCode').value.trim();
  const title = document.getElementById('fwTitle').value.trim();
  const fail = (message) => { fwError.textContent = message; fwError.style.display = 'block'; };
  if (!code) return fail('Indica el código');
  if (!title) return fail('Indica el título');
  const payload = {
    code,
    title,
    kind: document.getElementById('fwKind').value,
    nature: document.getElementById('fwNature').value,
    priority: document.getElementById('fwPriority').value,
    family: document.getElementById('fwFamily').value.trim(),
    summary: document.getElementById('fwSummary').value.trim(),
    jurisdictions: $$('#fwJuris input').filter((box) => box.checked).map((box) => box.value),
  };
  try {
    if (editingId) {
      applyFramework(await api.herzogLawFrameworkUpdate(editingId, payload));
      toast('Marco actualizado');
    } else {
      payload.requirements = document.getElementById('fwReqs').value.split('\n').map((l) => l.trim()).filter(Boolean);
      const created = await api.herzogLawFrameworkCreate(payload);
      toast('Marco añadido');
      fwDialog.close();
      state.filters.kind = '';
      await loadAll();
      await openDrawer(created.id);
      return;
    }
    fwDialog.close();
  } catch (ex) {
    fail(ex.message || 'No se pudo guardar');
  }
});

/* ---------- navegacion por pestanas ---------- */
const TABS = ['overview', 'frameworks', 'cbam', 'atex', 'activity'];
let cbam = null;
let atex = null;
let activity = null;

const ctx = {
  getZones: () => state.zones,
  getFrameworkCode: (id) => byId(id)?.code ?? id,
  reloadZones,
  openFramework: (id) => { openDrawer(id); },
  toast,
  showError,
};

function showTab(name) {
  const tab = TABS.includes(name) ? name : 'overview';
  $$('.law-tab').forEach((btn) => {
    const selected = btn.dataset.tab === tab;
    btn.setAttribute('aria-selected', String(selected));
    btn.tabIndex = selected ? 0 : -1;
  });
  $$('.law-panel').forEach((panel) => { panel.hidden = panel.id !== `panel-${tab}`; });
  if (tab === 'cbam' && !cbam) cbam = initCbam($('#panel-cbam'), ctx);
  if (tab === 'atex' && !atex) { atex = initAtex($('#panel-atex'), ctx); atex.render(); }
  if (tab === 'activity') {
    if (!activity) activity = initActivity($('#panel-activity'), ctx);
    activity.refresh();
  }
}

function goTo(tab) {
  if (location.hash.slice(1) === tab) showTab(tab); else location.hash = tab;
}

$('.law-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-tab]');
  if (btn) goTo(btn.dataset.tab);
});
$('.law-tabs').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  const current = TABS.indexOf(document.querySelector('.law-tab[aria-selected="true"]').dataset.tab);
  const next = TABS[(current + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
  goTo(next);
  document.getElementById(`tab-${next}`).focus();
});
window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));

/* Delegacion comun: celdas, tarjetas y avisos abren un marco o cambian de pestana. */
document.querySelector('main').addEventListener('click', (e) => {
  const open = e.target.closest('[data-open]');
  if (open) return openDrawer(open.dataset.open);
  const tab = e.target.closest('[data-tab]:not(.law-tab)');
  if (tab) goTo(tab.dataset.tab);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && drawer.classList.contains('is-open') && !fwDialog.open) closeDrawer();
});

showTab(location.hash.slice(1));
loadAll();
