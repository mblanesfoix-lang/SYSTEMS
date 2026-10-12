/**
 * HUD de telemetria de la linea BioHybrid sobre el visor 3D de PAIA.
 *
 * Dos piezas, ambas DOM puro (sin three.js, sin framework: el frontend de SYSTEMS es vanilla):
 *   - NodeTelemetryCard: panel flotante de cristal con cabecera (tipo de maquina, nodo, pulso de
 *     estado, huella SHA-256 efimera), insignia del estandar S-NFI 7 % cuando aplica, y rejilla
 *     brutalista de lecturas con sparklines y medidores.
 *   - Marcadores de hotspot: botones posicionados cada frame sobre la pieza 3D que miden. El visor
 *     (machine-viewer.js) proyecta los anclajes a pixeles y los entrega a placeMarkers().
 *
 * Interaccion: pasar el cursor por la maquina o por un marcador resalta las lecturas vinculadas;
 * clic en un marcador lo selecciona (abre el panel y dibuja una linea guia hasta la lectura); clic
 * en la maquina pliega/despliega el panel. Pasar el cursor por un marcador o por el panel retiene la
 * rotacion automatica del visor (onHold) para poder leer sin que todo se mueva.
 *
 * Las lecturas llegan por update() desde una fuente de telemetria (hoy simulada, ver
 * machine-telemetry.js). El HUD no calcula nada de proceso: solo pinta snapshots.
 */
import { NODE_ID, fmt } from './machine-telemetry.js';

const STORAGE_KEY = 'machineHud.expanded';
const SHEET_BREAKPOINT = 760;   // por debajo, el panel pasa de dock lateral a hoja inferior
const EXPAND_MIN_WIDTH = 1000;  // por debajo, el panel arranca plegado si el usuario no eligio
const STATUS_TEXT = { ok: 'NOMINAL', warn: 'ATENCIÓN', crit: 'ALARMA' };
const GOLD_TITLE = 'S-NFI 7% GOLD STANDARD VALIDATED';
const FAIL_TITLE = 'ESTÁNDAR S-NFI 7% FUERA DE LÍMITE';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/**
 * Primer descendiente que cumple `sel`. Los selectores son de este modulo y el marcado lo genera el:
 * el elemento existe por construccion, asi que se tipa como HTMLElement en vez de Element | null.
 * @param {ParentNode} root
 * @param {string} sel
 * @returns {HTMLElement}
 */
const $ = (root, sel) => /** @type {HTMLElement} */ (root.querySelector(sel));

/**
 * Todos los descendientes que cumplen `sel`.
 * @param {ParentNode} root
 * @param {string} sel
 * @returns {HTMLElement[]}
 */
const $$ = (root, sel) => /** @type {HTMLElement[]} */ ([...root.querySelectorAll(sel)]);

function readPref() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === null ? null : v === '1';
  } catch { return null; }
}
function writePref(v) {
  try { localStorage.setItem(STORAGE_KEY, v ? '1' : '0'); } catch { /* sin storage el estado vive en memoria */ }
}

function setText(node, text) {
  if (node && node.textContent !== text) node.textContent = text;
}

const dagger = (m) => (m.source === 'placeholder'
  ? '<sup class="hud-dagger" title="Nominal sin ficha técnica (placeholder)">†</sup>'
  : '');

const ICON_CHEVRON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3.5 6 8 10.5 12.5 6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_SEAL = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 2.5 19.5 5v6.2c0 4.5-3.1 8.2-7.5 10.3-4.4-2.1-7.5-5.8-7.5-10.3V5L12 2.5Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="m8.4 12.1 2.5 2.5 4.7-5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_ALERT = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 3.2 21.5 20H2.5L12 3.2Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M12 9.5v5M12 17.4v.1" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
const ICON_ARROW = '<svg class="hud-flow__arrow" viewBox="0 0 40 12" preserveAspectRatio="none" aria-hidden="true"><path d="M1 6h34M30 1.5 36 6l-6 4.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/* ------------------------------------------------------------ medidores */

const tickDecimals = (m, t) => (Number.isInteger(t) && m.decimals <= 1 ? 0 : 1);

/** Gradiente de zonas (alarma / atencion / nominal / atencion / alarma) sobre la escala de la metrica. */
function zonesGradient(m) {
  const [r0, r1] = m.range;
  const pct = (v) => ((clamp(v, r0, r1) - r0) / (r1 - r0)) * 100;
  const warn = m.warn || m.ok;
  const a = pct(warn[0]);
  const b = pct(m.ok[0]);
  const c = pct(m.ok[1]);
  const d = pct(warn[1]);
  const C = 'var(--hud-crit-soft)';
  const W = 'var(--hud-warn-soft)';
  const O = 'var(--hud-ok-soft)';
  return `linear-gradient(90deg, ${C} 0 ${a}%, ${W} ${a}% ${b}%, ${O} ${b}% ${c}%, ${W} ${c}% ${d}%, ${C} ${d}% 100%)`;
}

/**
 * Medidor con zonas. `markers`: claves de lectura que dibujan una marca; `fill`: ademas rellena
 * como barra de progreso desde el origen de la escala hasta la primera.
 */
function buildMeter(m, { markers, ticks = [], fill = false, segment = false }) {
  const [r0, r1] = m.range;
  const pct = (v) => (clamp(v, r0, r1) - r0) / (r1 - r0) * 100;
  const root = document.createElement('div');
  root.className = 'hud-meter';
  root.dataset.style = fill ? 'fill' : 'band';
  root.style.setProperty('--zones', m.ok ? zonesGradient(m) : 'none');
  root.innerHTML = `
    <div class="hud-meter__track">
      ${fill ? '<i class="hud-meter__fill"></i>' : ''}
      ${segment ? '<i class="hud-meter__seg"></i>' : ''}
      ${ticks.map((t) => `<i class="hud-meter__tick" style="left:${pct(t).toFixed(2)}%"><u>${fmt(t, tickDecimals(m, t))}</u></i>`).join('')}
      ${markers.map((k, i) => `<i class="hud-meter__marker${i ? ' hud-meter__marker--alt' : ''}" data-k="${esc(k)}"></i>`).join('')}
    </div>
    <div class="hud-meter__scale"><span>${fmt(r0, tickDecimals(m, r0))}</span><span>${fmt(r1, tickDecimals(m, r1))}</span></div>`;
  const fillEl = $(root, '.hud-meter__fill');
  const segEl = $(root, '.hud-meter__seg');
  const markerEls = new Map($$(root, '.hud-meter__marker').map((n) => [n.dataset.k, n]));
  return {
    el: root,
    set(values) {
      for (const [k, node] of markerEls) {
        if (values[k] != null) node.style.left = `${pct(values[k]).toFixed(2)}%`;
      }
      if (fillEl) fillEl.style.width = `${pct(values[markers[0]]).toFixed(2)}%`;
      if (segEl && markers.length > 1) {
        const lo = Math.min(pct(values[markers[0]]), pct(values[markers[1]]));
        const hi = Math.max(pct(values[markers[0]]), pct(values[markers[1]]));
        segEl.style.left = `${lo.toFixed(2)}%`;
        segEl.style.width = `${(hi - lo).toFixed(2)}%`;
      }
    },
  };
}

/* --------------------------------------------------------------- celdas */

function cellRoot(cell, index) {
  const el = document.createElement('div');
  el.className = `hud-cell${cell.span === 2 ? ' hud-cell--wide' : ''}`;
  el.style.setProperty('--i', index);
  return el;
}

function trendOf(arr, v) {
  const prev = arr.slice(-11, -1);
  if (prev.length < 3) return { dir: 0, text: '' };
  const mean = prev.reduce((s, x) => s + x, 0) / prev.length;
  if (!mean) return { dir: 0, text: '' };
  const pct = ((v - mean) / Math.abs(mean)) * 100;
  if (Math.abs(pct) < 0.15) return { dir: 0, text: '▬' };
  return { dir: pct > 0 ? 1 : -1, text: `${pct > 0 ? '▲' : '▼'} ${fmt(Math.abs(pct), 1)}%` };
}

function buildSparkCell(spec, cell, index) {
  const m = spec.metrics[cell.key];
  const el = cellRoot(cell, index);
  el.dataset.keys = cell.key;
  el.innerHTML = `
    <div class="hud-cell__top"><span class="hud-cell__label">${esc(m.label)}${dagger(m)}</span><i class="hud-dot"></i></div>
    <div class="hud-cell__value"><b class="hud-val">--</b><span class="hud-unit">${esc(m.unit)}</span><em class="hud-trend"></em></div>
    <svg class="hud-spark" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">
      <polygon class="hud-spark__area"></polygon><polyline class="hud-spark__line"></polyline>
    </svg>
    <div class="hud-cell__note"></div>`;
  const val = $(el, '.hud-val');
  const trend = $(el, '.hud-trend');
  const area = $(el, '.hud-spark__area');
  const line = $(el, '.hud-spark__line');
  const note = $(el, '.hud-cell__note');
  const minSpan = (m.range[1] - m.range[0]) * 0.04; // un ruido minimo no debe parecer una excursion enorme
  return {
    el,
    keys: [cell.key],
    update(snap) {
      const v = snap.values[cell.key];
      const arr = snap.history[cell.key] || [v];
      el.dataset.level = snap.levels[cell.key] || 'ok';
      setText(val, fmt(v, m.decimals));
      const t = trendOf(arr, v);
      setText(trend, t.text);
      trend.dataset.dir = String(t.dir);
      let lo = Infinity;
      let hi = -Infinity;
      for (const x of arr) { if (x < lo) lo = x; if (x > hi) hi = x; }
      const span = Math.max(hi - lo, minSpan);
      const mid = (hi + lo) / 2;
      const n = Math.max(arr.length - 1, 1);
      const pts = arr.map((x, i) => `${((i / n) * 100).toFixed(1)},${(12 - ((x - mid) / span) * 20).toFixed(2)}`);
      line.setAttribute('points', pts.join(' '));
      area.setAttribute('points', `${pts.join(' ')} 100,24 0,24`);
      setText(note, cell.note ? cell.note(snap.values, spec) : '');
    },
  };
}

function buildMeterCell(spec, cell, index) {
  const m = spec.metrics[cell.key];
  const el = cellRoot(cell, index);
  el.dataset.keys = cell.key;
  el.innerHTML = `
    <div class="hud-cell__top"><span class="hud-cell__label">${esc(m.label)}${dagger(m)}</span><i class="hud-dot"></i></div>
    <div class="hud-cell__value"><b class="hud-val">--</b><span class="hud-unit">${esc(m.unit)}</span></div>
    <div class="hud-cell__meter"></div>
    <div class="hud-cell__note"></div>`;
  const meter = buildMeter(m, { markers: [cell.key], ticks: cell.ticks || [], fill: !!cell.fill });
  $(el, '.hud-cell__meter').appendChild(meter.el);
  const val = $(el, '.hud-val');
  const note = $(el, '.hud-cell__note');
  return {
    el,
    keys: [cell.key],
    update(snap) {
      el.dataset.level = snap.levels[cell.key] || 'ok';
      setText(val, fmt(snap.values[cell.key], m.decimals));
      meter.set(snap.values);
      setText(note, cell.note ? cell.note(snap.values, spec) : '');
    },
  };
}

function buildFlowCell(spec, cell, index) {
  const [kin, kout] = cell.keys;
  const mi = spec.metrics[kin];
  const mo = spec.metrics[kout];
  const el = cellRoot(cell, index);
  el.dataset.keys = cell.keys.join(' ');
  el.innerHTML = `
    <div class="hud-cell__top"><span class="hud-cell__label">${esc(cell.title)}</span><i class="hud-dot"></i></div>
    <div class="hud-flow">
      <div class="hud-flow__node"><span class="hud-flow__tag">${esc(mi.short)}</span><b class="hud-val" data-k="in">--</b><span class="hud-unit">${esc(mi.unit)}</span></div>
      ${ICON_ARROW}
      <div class="hud-flow__node hud-flow__node--out"><span class="hud-flow__tag">${esc(mo.short)}</span><b class="hud-val" data-k="out">--</b><span class="hud-unit">${esc(mo.unit)}</span></div>
      <div class="hud-flow__delta"><span>Δ</span><b data-k="delta">--</b></div>
    </div>
    <div class="hud-cell__meter"></div>
    <div class="hud-cell__note"></div>`;
  const meter = buildMeter(mi, { markers: [kin, kout], ticks: cell.ticks || [], segment: true });
  $(el, '.hud-cell__meter').appendChild(meter.el);
  const vin = $(el, '[data-k="in"]');
  const vout = $(el, '[data-k="out"]');
  const vdelta = $(el, '[data-k="delta"]');
  const note = $(el, '.hud-cell__note');
  return {
    el,
    keys: cell.keys,
    update(snap) {
      const a = snap.values[kin];
      const b = snap.values[kout];
      el.dataset.level = snap.levels[kin] === 'crit' || snap.levels[kout] === 'crit' ? 'crit'
        : snap.levels[kin] === 'warn' || snap.levels[kout] === 'warn' ? 'warn' : 'ok';
      setText(vin, fmt(a, mi.decimals));
      setText(vout, fmt(b, mo.decimals));
      setText(vdelta, `${b - a > 0 ? '+' : '−'}${fmt(Math.abs(b - a), 1)} pts`);
      meter.set(snap.values);
      setText(note, cell.note ? cell.note(snap.values, spec) : '');
    },
  };
}

function buildProbesCell(spec, cell, index) {
  const mean = spec.metrics[cell.mean];
  const el = cellRoot(cell, index);
  el.dataset.keys = [...cell.keys, cell.mean].join(' ');
  el.innerHTML = `
    <div class="hud-cell__top"><span class="hud-cell__label">${esc(cell.title)}${dagger(mean)}</span><i class="hud-dot"></i></div>
    <div class="hud-probes">
      ${cell.keys.map((k) => `<div class="hud-probe" data-k="${esc(k)}"><span>${esc(spec.metrics[k].short)}</span><b>--</b><small>${esc(spec.metrics[k].unit)}</small></div>`).join('')}
    </div>
    <div class="hud-cell__meter"></div>
    <div class="hud-cell__note"></div>`;
  const meter = buildMeter(mean, { markers: cell.keys, ticks: [50, 100] });
  $(el, '.hud-cell__meter').appendChild(meter.el);
  const probeEls = new Map($$(el, '.hud-probe').map((n) => [n.dataset.k, n]));
  const note = $(el, '.hud-cell__note');
  return {
    el,
    keys: [...cell.keys, cell.mean],
    update(snap) {
      for (const [k, node] of probeEls) {
        node.dataset.level = snap.levels[k] || 'ok';
        setText($(node, 'b'), fmt(snap.values[k], spec.metrics[k].decimals));
      }
      el.dataset.level = snap.levels[cell.mean] || 'ok';
      meter.set(snap.values);
      setText(note, cell.note ? cell.note(snap.values, spec) : '');
    },
  };
}

const CELL_BUILDERS = { spark: buildSparkCell, meter: buildMeterCell, flow: buildFlowCell, probes: buildProbesCell };

/* ------------------------------------------------------------------ HUD */

/**
 * @param {HTMLElement} stage contenedor posicionado del visor (el HUD se anade como capa superior)
 * @param {{
 *   onLayout?: (insets: {right: number, bottom: number}) => void,
 *   onHold?: (on: boolean) => void,
 *   onFault?: (req: {machineId: string, activate: boolean, fault: any}) => void,
 * }} [opts]
 */
export function mountMachineHud(stage, opts = {}) {
  const layer = document.createElement('div');
  layer.className = 'hud-layer';
  layer.innerHTML = `
    <svg class="hud-lines" aria-hidden="true"><path class="hud-lines__path" d=""></path><circle class="hud-lines__end" r="3" cx="0" cy="0"></circle></svg>
    <div class="hud-markers"></div>
    <aside class="hud-card" role="region" aria-label="Telemetría de máquina" hidden></aside>`;
  stage.appendChild(layer);
  const card = $(layer, '.hud-card');
  const markersBox = $(layer, '.hud-markers');
  const linePath = $(layer, '.hud-lines__path');
  const lineEnd = $(layer, '.hud-lines__end');

  let spec = null;
  let hotspots = [];
  let cells = [];
  let refs = null;
  let markers = new Map();
  let snapshot = null;
  let expanded = readPref();
  let selectedId = null;
  let hoverId = null;
  let holdCount = 0;
  let mode = 'dock';
  let stageW = 1;
  let insetRight = 0;
  let link = null; // extremo de la linea guia sobre el panel, en px del escenario

  /* -- layout -- */

  function isExpanded() { return expanded === null ? stageW >= EXPAND_MIN_WIDTH : expanded; }

  function applyState() {
    const open = isExpanded();
    card.dataset.state = open ? 'expanded' : 'compact';
    const t = $(card, '.hud-toggle');
    if (t) {
      t.setAttribute('aria-expanded', String(open));
      t.setAttribute('aria-label', open ? 'Contraer telemetría' : 'Expandir telemetría');
    }
  }

  function emitInsets() {
    if (!opts.onLayout) return;
    let right = 0;
    let bottom = 0;
    if (spec && !card.hidden) {
      const s = stage.getBoundingClientRect();
      const c = card.getBoundingClientRect();
      if (mode === 'dock') right = Math.max(0, s.right - c.left + 12);
      else bottom = Math.max(0, s.bottom - c.top + 8);
    }
    insetRight = right;
    opts.onLayout({ right, bottom });
  }

  function measure() {
    stageW = stage.clientWidth || 1;
    mode = stageW < SHEET_BREAKPOINT ? 'sheet' : 'dock';
    layer.dataset.layout = mode;
    applyState();
    layoutLink();
    emitInsets();
  }

  /* -- vinculo marcador <-> lecturas -- */

  function activeHotspot() {
    const id = hoverId ?? selectedId;
    return id ? hotspots.find((h) => h.id === id) : null;
  }

  function layoutLink() {
    link = null;
    const hs = activeHotspot();
    if (!hs || !spec || !isExpanded() || mode !== 'dock') return;
    const target = cells.find((c) => c.keys.some((k) => hs.metrics?.includes(k)));
    const body = $(card, '.hud-body');
    if (!target || !body) return;
    const s = stage.getBoundingClientRect();
    const b = body.getBoundingClientRect();
    const r = target.el.getBoundingClientRect();
    link = { x: b.left - s.left, y: clamp(r.top + r.height / 2, b.top + 10, b.bottom - 10) - s.top };
  }

  function refreshLinks() {
    const hs = activeHotspot();
    for (const c of cells) c.el.classList.toggle('is-linked', !!hs && c.keys.some((k) => hs.metrics?.includes(k)));
    for (const [id, rec] of markers) {
      rec.el.classList.toggle('is-selected', id === selectedId);
      rec.el.classList.toggle('is-open', id === selectedId || id === hoverId);
    }
    layoutLink();
    if (!link) { linePath.setAttribute('d', ''); lineEnd.style.opacity = '0'; }
  }

  /* -- construccion de la tarjeta -- */

  function buildCard() {
    const metricsWithDagger = Object.values(spec.metrics).some((m) => m.source === 'placeholder');
    card.setAttribute('aria-label', `Telemetría de ${spec.type}`);
    card.innerHTML = `
      <header class="hud-head">
        <div class="hud-head__row">
          <span class="hud-badge">${esc(spec.type)}</span>
          <span class="hud-status" data-level="ok"><i class="hud-pulse"></i><b class="hud-status__txt" aria-live="polite">NOMINAL</b></span>
          <span class="hud-spacer"></span>
          <button type="button" class="hud-toggle" aria-expanded="true">${ICON_CHEVRON}</button>
        </div>
        <div class="hud-head__meta">
          <span>NODO <b>${esc(NODE_ID)}</b></span>
          <span>UNIDAD <b>${esc(spec.unitTag)}-01</b></span>
          <span><b>×${spec.units}</b> EN PARALELO</span>
        </div>
        <div class="hud-head__hash">
          <span class="hud-chip" title="Sin sensores conectados: todas las lecturas son simuladas">SIMULADO</span>
          <span class="hud-hash" title="Huella SHA-256 local del paquete de lectura (nodo, máquina, instante y valores). No es una firma del nodo."><span class="hud-hash__algo">SHA-256</span><code class="hud-hash__hex">---- ---- ----</code></span>
          <time class="hud-ts">--:--:--</time>
        </div>
        <div class="hud-glance">
          ${spec.glance.map((k) => `<div class="hud-glance__item" data-k="${esc(k)}"><span>${esc(spec.metrics[k].short)}</span><b>--</b><small>${esc(spec.metrics[k].unit)}</small></div>`).join('')}
        </div>
      </header>
      <div class="hud-fold"><div class="hud-fold__inner">
        <div class="hud-body">
          ${spec.standard ? `
          <div class="hud-standard" data-ok="true">
            <span class="hud-standard__icon">${ICON_SEAL}</span>
            <span class="hud-standard__txt"><b class="hud-standard__title">${GOLD_TITLE}</b><span class="hud-standard__detail"></span></span>
          </div>` : ''}
          <div class="hud-groups"></div>
        </div>
        <footer class="hud-foot">
          <span class="hud-foot__legend">${metricsWithDagger ? '† nominal sin ficha técnica (placeholder). ' : ''}Lecturas simuladas, sin sensores conectados.</span>
          ${spec.demoFault ? '<button type="button" class="hud-fault"></button>' : ''}
        </footer>
      </div></div>`;

    const groupsBox = $(card, '.hud-groups');
    cells = [];
    let index = 0;
    for (const group of spec.layout) {
      const section = document.createElement('section');
      section.className = 'hud-group';
      section.innerHTML = `<h4 class="hud-group__title">${esc(group.title)}</h4><div class="hud-grid"></div>`;
      const grid = $(section, '.hud-grid');
      for (const def of group.cells) {
        const built = CELL_BUILDERS[def.view](spec, def, index++);
        cells.push(built);
        grid.appendChild(built.el);
      }
      groupsBox.appendChild(section);
    }

    refs = {
      status: $(card, '.hud-status'),
      statusTxt: $(card, '.hud-status__txt'),
      hashAlgo: $(card, '.hud-hash__algo'),
      hashHex: $(card, '.hud-hash__hex'),
      ts: $(card, '.hud-ts'),
      glance: new Map($$(card, '.hud-glance__item').map((n) => [n.dataset.k, n])),
      standard: $(card, '.hud-standard'),
      standardIcon: $(card, '.hud-standard__icon'),
      standardTitle: $(card, '.hud-standard__title'),
      standardDetail: $(card, '.hud-standard__detail'),
      fault: $(card, '.hud-fault'),
      body: $(card, '.hud-body'),
    };

    $(card, '.hud-toggle').addEventListener('click', () => setExpanded(!isExpanded()));
    refs.fault?.addEventListener('click', () => {
      opts.onFault?.({ machineId: spec.id, activate: !snapshot?.faultActive, fault: spec.demoFault });
    });
    refs.body.addEventListener('scroll', layoutLink, { passive: true });
    applyState();
  }

  /* -- marcadores -- */

  function clearMarkers() {
    markers.clear();
    markersBox.textContent = '';
    linePath.setAttribute('d', '');
    lineEnd.style.opacity = '0';
  }

  function buildMarkers() {
    for (const hs of hotspots) {
      const defs = (hs.metrics || []).map((k) => spec.metrics[k]).filter(Boolean);
      if (!defs.length) continue;
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'hud-marker';
      el.dataset.id = hs.id;
      el.dataset.level = 'ok';
      el.dataset.front = '0';
      el.dataset.visible = '0';
      el.innerHTML = `
        <span class="hud-marker__dot"><i></i></span>
        <span class="hud-marker__tag">
          <span class="hud-marker__name">${esc(hs.label)}</span>
          ${(hs.metrics || []).map((k, i) => `<span class="hud-marker__row${i ? ' hud-marker__row--more' : ''}" data-k="${esc(k)}"><em>${esc(spec.metrics[k].short)}</em><b>--</b><small>${esc(spec.metrics[k].unit)}</small></span>`).join('')}
        </span>`;
      markersBox.appendChild(el);
      const rec = { el, hs, x: -9999, y: -9999, side: 'right', dy: 0, rows: new Map($$(el, '.hud-marker__row').map((n) => [n.dataset.k, n])) };
      markers.set(hs.id, rec);

      el.addEventListener('click', () => select(selectedId === hs.id ? null : hs.id, true));
      el.addEventListener('pointerenter', () => { hoverId = hs.id; hold(+1); refreshLinks(); });
      el.addEventListener('pointerleave', () => { if (hoverId === hs.id) hoverId = null; hold(-1); refreshLinks(); });
      el.addEventListener('focus', () => { hoverId = hs.id; refreshLinks(); });
      el.addEventListener('blur', () => { if (hoverId === hs.id) hoverId = null; refreshLinks(); });
    }
  }

  function hold(delta) {
    const before = holdCount > 0;
    holdCount = Math.max(0, holdCount + delta);
    const after = holdCount > 0;
    if (before !== after) opts.onHold?.(after);
  }

  /** Selecciona (o limpia) un hotspot: abre el panel, vincula sus lecturas y las trae a la vista. */
  function select(id, reveal) {
    selectedId = id;
    if (id && !isExpanded()) setExpanded(true);
    refreshLinks();
    if (id && reveal) {
      const hs = hotspots.find((h) => h.id === id);
      const target = hs && cells.find((c) => c.keys.some((k) => hs.metrics?.includes(k)));
      target?.el.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    }
  }

  function setExpanded(on) {
    expanded = !!on;
    writePref(expanded);
    applyState();
    refreshLinks();
    emitInsets();
  }

  /* -- actualizacion por tick de telemetria -- */

  function update(snapshots) {
    if (!spec) return;
    const snap = snapshots instanceof Map ? snapshots.get(spec.id) : snapshots;
    if (!snap) return;
    snapshot = snap;

    refs.status.dataset.level = snap.status;
    setText(refs.statusTxt, STATUS_TEXT[snap.status] || 'NOMINAL');
    card.dataset.level = snap.status;
    setText(refs.hashAlgo, snap.hash.algo);
    setText(refs.hashHex, snap.hash.hex.replace(/(.{4})(?=.)/g, '$1 '));
    setText(refs.ts, new Date(snap.ts).toLocaleTimeString('es-ES'));

    for (const [k, node] of refs.glance) {
      const m = spec.metrics[k];
      node.dataset.level = snap.levels[k] || 'ok';
      setText($(node, 'b'), fmt(snap.values[k], m.decimals));
    }

    if (refs.standard) {
      const ok = snap.standard?.ok !== false;
      refs.standard.dataset.ok = String(ok);
      if (refs.standardIcon.dataset.ok !== String(ok)) {
        refs.standardIcon.dataset.ok = String(ok);
        refs.standardIcon.innerHTML = ok ? ICON_SEAL : ICON_ALERT;
      }
      setText(refs.standardTitle, ok ? GOLD_TITLE : FAIL_TITLE);
      setText(refs.standardDetail, snap.standard?.detail || '');
    }

    for (const c of cells) c.update(snap);

    if (refs.fault) {
      refs.fault.dataset.active = String(!!snap.faultActive);
      setText(refs.fault, snap.faultActive ? 'Restaurar nominal' : `Simular desviación · ${spec.demoFault.label}`);
    }

    for (const rec of markers.values()) {
      const levels = (rec.hs.metrics || []).map((k) => snap.levels[k]);
      const worst = levels.includes('crit') ? 'crit' : levels.includes('warn') ? 'warn' : 'ok';
      rec.el.dataset.level = worst;
      for (const [k, row] of rec.rows) setText($(row, 'b'), fmt(snap.values[k], spec.metrics[k].decimals));
      const first = rec.hs.metrics[0];
      rec.el.setAttribute('aria-label',
        `${rec.hs.label}: ${spec.metrics[first].label} ${fmt(snap.values[first], spec.metrics[first].decimals)} ${spec.metrics[first].unit}`);
    }
  }

  /* -- posicion de marcadores (una vez por frame, desde el visor) -- */

  /** @param {Array<{id: string, x: number, y: number, facing: number, occluded: boolean, inView: boolean}>} list */
  function placeMarkers(list) {
    if (!spec) return;
    const freeW = stageW - (mode === 'dock' && !card.hidden ? insetRight : 0);
    const shown = [];
    for (const p of list) {
      const rec = markers.get(p.id);
      if (!rec) continue;
      const visible = p.inView;
      const front = p.facing > 0.05 && !p.occluded; // cara oculta o tapado por otra pieza: solo punto atenuado
      if (rec.el.dataset.visible !== (visible ? '1' : '0')) rec.el.dataset.visible = visible ? '1' : '0';
      if (rec.el.dataset.front !== (front ? '1' : '0')) rec.el.dataset.front = front ? '1' : '0';
      if (Math.abs(p.x - rec.x) > 0.15 || Math.abs(p.y - rec.y) > 0.15) {
        rec.x = p.x;
        rec.y = p.y;
        rec.el.style.transform = `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0)`;
      }
      // etiqueta a la derecha del punto salvo cerca del borde derecho del area libre (con histeresis para no parpadear)
      const wantLeft = rec.side === 'left' ? p.x > freeW * 0.6 - 30 : p.x > freeW * 0.6 + 30;
      const side = wantLeft ? 'left' : 'right';
      if (side !== rec.side) { rec.side = side; rec.el.dataset.side = side; }
      if (visible && front) shown.push(rec);
    }
    // separacion vertical simple de etiquetas que se pisan: el punto queda en su sitio, solo baja la etiqueta
    shown.sort((a, b) => a.y - b.y);
    let prev = null;
    for (const rec of shown) {
      let dy = 0;
      if (prev && Math.abs(rec.x - prev.x) < 190) {
        const gap = rec.y - (prev.y + prev.dy); // distancia entre esta etiqueta y la anterior, ya desplazada
        if (gap < 38) dy = 38 - gap;
      }
      if (Math.abs(dy - rec.dy) > 0.5) { rec.dy = dy; rec.el.style.setProperty('--tag-dy', `${dy.toFixed(0)}px`); }
      prev = rec;
    }
    for (const rec of markers.values()) {
      if (!shown.includes(rec) && rec.dy) { rec.dy = 0; rec.el.style.setProperty('--tag-dy', '0px'); }
    }
    drawLine();
  }

  function drawLine() {
    const rec = (hoverId ?? selectedId) ? markers.get(hoverId ?? selectedId) : null;
    if (!rec || !link || rec.el.dataset.visible !== '1') {
      if (lineEnd.style.opacity !== '0') { linePath.setAttribute('d', ''); lineEnd.style.opacity = '0'; }
      return;
    }
    const mid = rec.x + (link.x - rec.x) * 0.55;
    linePath.setAttribute('d', `M${rec.x.toFixed(1)} ${rec.y.toFixed(1)} L${mid.toFixed(1)} ${rec.y.toFixed(1)} L${(mid + 14).toFixed(1)} ${link.y.toFixed(1)} L${link.x.toFixed(1)} ${link.y.toFixed(1)}`);
    lineEnd.setAttribute('cx', link.x.toFixed(1));
    lineEnd.setAttribute('cy', link.y.toFixed(1));
    lineEnd.style.opacity = '1';
  }

  /* -- API -- */

  /**
   * Hotspots de la maquina activa. Dependen de la geometria del modelo cargado, asi que la pagina
   * los entrega cuando el modelo esta en escena (y los vacia mientras carga otro).
   */
  function setHotspots(list = []) {
    hotspots = list || [];
    selectedId = null;
    hoverId = null;
    link = null;
    if (holdCount) { holdCount = 0; opts.onHold?.(false); }
    clearMarkers();
    if (spec) {
      buildMarkers();
      if (snapshot && snapshot.machineId === spec.id) update(snapshot);
    }
    refreshLinks();
  }

  function setMachine(newSpec, newHotspots = []) {
    spec = newSpec;
    if (!spec) {
      setHotspots([]);
      card.hidden = true;
      card.textContent = '';
      cells = [];
      refs = null;
      emitInsets();
      return;
    }
    buildCard();
    setHotspots(newHotspots);
    card.hidden = false;
    card.classList.remove('is-in');
    void card.offsetWidth; // reinicia la animacion de entrada
    card.classList.add('is-in');
    if (snapshot && snapshot.machineId === spec.id) update(snapshot);
    measure();
  }

  const onKey = (e) => { if (e.key === 'Escape' && selectedId) select(null); };
  document.addEventListener('keydown', onKey);
  card.addEventListener('pointerenter', () => hold(+1));
  card.addEventListener('pointerleave', () => hold(-1));

  const ro = new ResizeObserver(() => measure());
  ro.observe(stage);
  ro.observe(card);
  card.addEventListener('transitionend', () => { layoutLink(); });
  measure();

  return {
    setMachine,
    setHotspots,
    update,
    placeMarkers,
    select,
    setExpanded,
    toggleExpanded: () => setExpanded(!isExpanded()),
    /** El cursor entra/sale de la maquina 3D: revela las etiquetas de los hotspots. */
    setMachineHover: (on) => { layer.dataset.hover = on ? '1' : '0'; },
    dispose() {
      document.removeEventListener('keydown', onKey);
      ro.disconnect();
      layer.remove();
    },
  };
}
