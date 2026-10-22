// S-EAGLE: pinta la vista de cumplimiento que calcula el servidor (lib/compliance-view.js).
// La comparten la pantalla del inspector, la vista interna de la mesa y la vista previa
// del Admin, para que los tres vean exactamente lo mismo. Solo presenta: el semaforo,
// los motivos y las fechas llegan calculados.
import { escapeHtml as h } from '/js/api.js';

const LEVEL = {
  rojo: { label: 'Incumplimiento', title: 'Incumplimiento', text: 'Al menos una norma está vencida, o una obligatoria de prioridad alta no está vigente.' },
  ambar: { label: 'Atención', title: 'Con avisos', text: 'Hay vencimientos próximos, requisitos pendientes o normas en preparación.' },
  verde: { label: 'En regla', title: 'En regla', text: 'Las normas obligatorias están vigentes, en fecha y con todos sus requisitos cumplidos.' },
  informativo: { label: 'Informativa', title: 'Informativo', text: '' },
  no_aplica: { label: 'No aplica', title: 'No aplica', text: '' },
  sin_datos: { label: 'Sin datos', title: 'Sin datos', text: 'Todavía no hay normas registradas en este alcance.' },
};
const FILTER_ORDER = ['rojo', 'ambar', 'verde', 'informativo', 'no_aplica'];
const STATUS = { no_iniciado: 'Sin iniciar', en_preparacion: 'En preparación', vigente: 'Vigente', no_aplica: 'No aplica' };
const NATURE = { obligatoria: 'Obligatoria', voluntaria: 'Voluntaria', indirecta: 'Indirecta' };
const ZONE_STATUS = { pendiente: 'Pendiente', clasificada: 'Clasificada', protegida: 'Protegida' };
// Mismo criterio que el semaforo del servidor: vencida es rojo; proxima o critica, ambar.
const EXPIRY_LEVEL = { vencido: 'rojo', critico: 'ambar', proximo: 'ambar' };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const RING_R = 80;
const RING_C = 2 * Math.PI * RING_R;

const ICON = {
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l7 3v6c0 4.5-3 8-7 9-4-1-7-4.5-7-9V6z"/><path d="M9 12l2 2 4-4"/></svg>',
  broken: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l7 3v6c0 4.5-3 8-7 9-4-1-7-4.5-7-9V6z"/><path d="M12 8v5M12 16h.01"/></svg>',
  download: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
};

export function formatDate(value) {
  if (!value) return 'Sin fecha';
  const d = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`) : new Date(value);
  if (Number.isNaN(d.getTime())) return 'Sin fecha';
  return d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function daysText(days) {
  if (days === null || days === undefined) return '';
  if (days < 0) return `hace ${Math.abs(days)} d`;
  if (days === 0) return 'hoy';
  return `${days} d`;
}

function sizeText(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const extOf = (name) => (String(name).split('.').pop() || 'doc').slice(0, 4).toUpperCase();

/**
 * Crea la vista dentro de `root` y devuelve { update(data) }. El estado del filtro y la
 * busqueda sobrevive a cada refresco; el anillo y las barras se animan hasta el valor nuevo.
 * onDownload(doc): si se pasa, los documentos compartidos muestran su boton de descarga.
 */
export function createComplianceView(root, { onDownload } = {}) {
  const state = { filter: 'all', q: '', data: null, firstPaint: true };

  root.classList.add('sg-view');
  root.addEventListener('click', (e) => {
    const f = e.target.closest('[data-sg-filter]');
    if (f) { state.filter = f.dataset.sgFilter; paintNorms(); return; }
    const d = e.target.closest('[data-sg-download]');
    if (d && onDownload) {
      const doc = state.data?.documents?.find((x) => x.id === d.dataset.sgDownload);
      if (doc) onDownload(doc, d);
    }
  });
  root.addEventListener('input', (e) => {
    if (e.target.matches('[data-sg-search]')) { state.q = e.target.value; paintNorms(); }
  });

  function skeleton() {
    root.innerHTML = `
      <div class="sg-hero"><div class="sg-skel" style="height:330px"></div><div class="sg-kpis">${'<div class="sg-skel" style="height:124px"></div>'.repeat(6)}</div></div>
      <div class="sg-section"><div class="sg-grid">${'<div class="sg-skel" style="height:230px"></div>'.repeat(3)}</div></div>`;
  }

  function heroHtml(d) {
    const level = d.overall.level;
    const meta = LEVEL[level] ?? LEVEL.sin_datos;
    const pct = d.overall.readiness.total ? d.overall.readiness.pct : 0;
    const by = d.overall.byLevel;
    const shared = d.frameworks.length;
    const barTotal = Math.max(1, shared);
    const next = d.upcoming[0];
    const nextLevel = next ? EXPIRY_LEVEL[next.state] : 'verde';
    const integrityOk = d.integrity?.herzogLaw?.valid !== false && d.integrity?.seagle?.valid !== false;
    const entries = (d.integrity?.herzogLaw?.totalEntries ?? 0) + (d.integrity?.seagle?.totalEntries ?? 0);
    const zones = d.zones;
    const zonesLevel = !zones ? 'no_aplica' : zones.byStatus.pendiente ? 'ambar' : 'verde';
    const applicable = d.frameworks.filter((f) => f.status !== 'no_aplica');
    const inForce = applicable.filter((f) => f.status === 'vigente' && f.expiry?.state !== 'vencido').length;

    return `
      <div class="sg-hero">
        <section class="sg-status sg-lv--${level}" aria-label="Estado global de cumplimiento">
          <div class="sg-ring">
            <div class="sg-ring__sweep" aria-hidden="true"></div>
            <svg viewBox="0 0 188 188" aria-hidden="true">
              <circle class="sg-ring__track" cx="94" cy="94" r="${RING_R}"></circle>
              <circle class="sg-ring__value" cx="94" cy="94" r="${RING_R}" stroke-dasharray="${RING_C.toFixed(2)}" stroke-dashoffset="${RING_C.toFixed(2)}" data-sg-pct="${pct}"></circle>
            </svg>
            <div class="sg-ring__center">
              <span class="sg-ring__pct"><span data-sg-count="${pct}">0</span><small>%</small></span>
              <span class="sg-ring__caption">requisitos cumplidos</span>
            </div>
          </div>
          <h2 class="sg-status__title">${h(meta.title)}</h2>
          <p class="sg-status__text">${h(meta.text)}</p>
        </section>

        <div class="sg-kpis">
          <article class="sg-kpi sg-lv--${by.rojo ? 'rojo' : by.ambar ? 'ambar' : 'verde'}">
            <span class="sg-kpi__label">Normas compartidas</span>
            <span class="sg-kpi__value"><span data-sg-count="${shared}">0</span></span>
            <div class="sg-bars" role="img" aria-label="${by.rojo} en incumplimiento, ${by.ambar} con atención, ${by.verde} en regla">
              <span style="width:${(by.rojo / barTotal) * 100}%;background:var(--accent-red)"></span>
              <span style="width:${(by.ambar / barTotal) * 100}%;background:var(--accent-amber)"></span>
              <span style="width:${(by.verde / barTotal) * 100}%;background:var(--accent-green)"></span>
              <span style="width:${((by.informativo + by.no_aplica) / barTotal) * 100}%;background:var(--text-dim)"></span>
            </div>
            <span class="sg-kpi__sub">${plural(by.rojo, 'incumple', 'incumplen')} · ${by.ambar} con atención · ${by.verde} en regla</span>
          </article>
          <article class="sg-kpi sg-lv--${level === 'sin_datos' ? 'no_aplica' : level}">
            <span class="sg-kpi__label">Requisitos obligatorios</span>
            <span class="sg-kpi__value"><span data-sg-count="${d.overall.readiness.done}">0</span><small> / ${d.overall.readiness.total}</small></span>
            <span class="sg-kpi__sub">${plural(d.overall.obligatoryCounted, 'norma obligatoria cuenta', 'normas obligatorias cuentan')} para el semáforo</span>
          </article>
          <article class="sg-kpi sg-lv--${!applicable.length ? 'no_aplica' : inForce === applicable.length ? 'verde' : 'ambar'}">
            <span class="sg-kpi__label">Normas vigentes</span>
            <span class="sg-kpi__value"><span data-sg-count="${inForce}">0</span><small> / ${applicable.length}</small></span>
            <span class="sg-kpi__sub">Con certificado o cumplimiento en vigor, de las que aplican</span>
          </article>
          <article class="sg-kpi sg-lv--${nextLevel}">
            <span class="sg-kpi__label">Próximo vencimiento</span>
            ${next
              ? `<span class="sg-kpi__value">${h(daysText(next.days))}</span><span class="sg-kpi__sub">${h(next.code)} · ${h(formatDate(next.expiresAt))}</span>`
              : '<span class="sg-kpi__value">Ninguno</span><span class="sg-kpi__sub">Nada vence en los próximos 90 días</span>'}
          </article>
          <article class="sg-kpi sg-lv--${zonesLevel}">
            <span class="sg-kpi__label">Zonas ATEX</span>
            ${zones
              ? `<span class="sg-kpi__value"><span data-sg-count="${zones.total - zones.byStatus.pendiente}">0</span><small> / ${zones.total}</small></span><span class="sg-kpi__sub">${zones.byStatus.pendiente ? plural(zones.byStatus.pendiente, 'pendiente de clasificar', 'pendientes de clasificar') : zones.total ? 'Todas clasificadas' : 'Sin zonas registradas'}</span>`
              : '<span class="sg-kpi__value">No incluidas</span><span class="sg-kpi__sub">Fuera del alcance de esta inspección</span>'}
          </article>
          <article class="sg-kpi sg-lv--${integrityOk ? 'verde' : 'rojo'}">
            <span class="sg-kpi__label">Integridad de registros</span>
            <span class="sg-kpi__value">${integrityOk ? 'Verificada' : 'Alterada'}</span>
            <span class="sg-kpi__sub">${plural(entries, 'entrada encadenada', 'entradas encadenadas')} con SHA-256</span>
          </article>
        </div>
      </div>`;
  }

  function normCard(f, i) {
    const lv = LEVEL[f.level] ?? LEVEL.sin_datos;
    const r = f.readiness;
    const expiry = f.expiresAt ? `${formatDate(f.expiresAt)}${f.expiry?.days !== null && f.expiry?.days !== undefined ? ` · ${daysText(f.expiry.days)}` : ''}` : 'Sin fecha';
    return `
      <article class="sg-norm sg-lv--${f.level}" style="animation-delay:${Math.min(i, 12) * 40}ms">
        <div class="sg-norm__head">
          <span class="sg-norm__code">${h(f.code)}</span>
          <span class="sg-chip">${h(lv.label)}</span>
        </div>
        <h3 class="sg-norm__title">${h(f.title)}</h3>
        <p class="sg-norm__reason">${h(f.reason)}</p>
        <dl class="sg-facts">
          <div><dt>Estado</dt><dd>${h(STATUS[f.status] ?? f.status)}</dd></div>
          <div><dt>Vence</dt><dd>${h(expiry)}</dd></div>
          <div><dt>Certificado</dt><dd>${h(f.certNumber || 'Sin número')}</dd></div>
          <div><dt>Emisor</dt><dd>${h(f.issuer || 'Sin emisor')}</dd></div>
        </dl>
        <div class="sg-progress">
          <span class="sg-progress__track"><span class="sg-progress__fill" style="width:${r.total ? r.pct : 0}%"></span></span>
          <span class="sg-progress__label">${r.done}/${r.total} requisitos</span>
        </div>
        <div class="sg-tags">
          <span class="sg-tag">${h(NATURE[f.nature] ?? f.nature)}</span>
          ${(f.jurisdictions ?? []).map((j) => `<span class="sg-tag">${h(j)}</span>`).join('')}
          ${f.family ? `<span class="sg-tag">${h(f.family)}</span>` : ''}
        </div>
      </article>`;
  }

  function normsSectionHtml(d) {
    const counts = Object.fromEntries(FILTER_ORDER.map((k) => [k, d.frameworks.filter((f) => f.level === k).length]));
    const filters = [['all', 'Todas', d.frameworks.length], ...FILTER_ORDER.filter((k) => counts[k]).map((k) => [k, LEVEL[k].label, counts[k]])];
    return `
      <section class="sg-section" aria-labelledby="sgNormsTitle">
        <div class="sg-section__head">
          <div>
            <span class="sg-eyebrow"><b>01</b> Normas y certificados</span>
            <h2 class="sg-section__title" id="sgNormsTitle">Estado por norma</h2>
          </div>
          <div class="sg-toolbar">
            ${filters.map(([k, label, n]) => `<button type="button" class="sg-filter ${k === 'all' ? '' : `sg-lv--${k}`}" data-sg-filter="${k}" aria-pressed="${state.filter === k}">${h(label)} <span class="sg-filter__n">${n}</span></button>`).join('')}
            <input class="input sg-search" type="search" placeholder="Buscar norma" aria-label="Buscar norma" data-sg-search value="${h(state.q)}">
          </div>
        </div>
        <div class="sg-grid" data-sg-norms></div>
      </section>`;
  }

  function paintNorms() {
    const d = state.data;
    const host = root.querySelector('[data-sg-norms]');
    if (!d || !host) return;
    root.querySelectorAll('[data-sg-filter]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.sgFilter === state.filter)));
    const q = state.q.trim().toLowerCase();
    const list = d.frameworks.filter((f) => (state.filter === 'all' || f.level === state.filter)
      && (!q || `${f.code} ${f.title} ${f.family ?? ''}`.toLowerCase().includes(q)));
    host.innerHTML = list.length
      ? list.map(normCard).join('')
      : `<div class="sg-empty" style="grid-column:1/-1">${d.frameworks.length ? 'Ninguna norma coincide con el filtro.' : 'No hay normas en este alcance.'}</div>`;
  }

  function detailsHtml(d) {
    const upcoming = d.upcoming.length
      ? `<ol class="sg-timeline">${d.upcoming.map((u) => `
          <li class="sg-lv--${EXPIRY_LEVEL[u.state] ?? 'ambar'}">
            <span><span class="sg-timeline__name">${h(u.code)} · ${h(u.title)}</span><span class="sg-timeline__date">${h(formatDate(u.expiresAt))}</span></span>
            <span class="sg-days">${h(u.days < 0 ? `vencida ${daysText(u.days)}` : daysText(u.days))}</span>
          </li>`).join('')}</ol>`
      : '<p class="sg-muted">Ningún certificado vigente vence en los próximos 90 días.</p>';

    const lawOk = d.integrity?.herzogLaw?.valid !== false;
    const seagleOk = d.integrity?.seagle?.valid !== false;
    const sealRow = (ok, name, info) => `
      <div class="sg-seal__row sg-lv--${ok ? 'verde' : 'rojo'}">
        <span class="sg-seal__icon">${ok ? ICON.shield : ICON.broken}</span>
        <span><span class="sg-seal__name">${h(name)}</span>
        <span class="sg-seal__meta">${ok ? 'Cadena íntegra' : `Cadena rota en la entrada ${h(info?.brokenAtSeq)}`} · ${info?.totalEntries ?? 0} entradas</span></span>
      </div>`;

    const zones = d.zones ? `
      <section class="sg-section" aria-labelledby="sgZonesTitle">
        <div class="sg-section__head"><div><span class="sg-eyebrow"><b>03</b> Atmósferas explosivas</span><h2 class="sg-section__title" id="sgZonesTitle">Zonas ATEX</h2></div></div>
        <div class="sg-panel">
          ${d.zones.items.length ? `<div class="sg-table__wrap"><table class="sg-table">
            <thead><tr><th>Zona</th><th>Ubicación</th><th>Tipo</th><th>Clasificación</th><th>Estado</th></tr></thead>
            <tbody>${d.zones.items.map((z) => `<tr>
              <td style="color:var(--text-primary)">${h(z.name)}</td>
              <td>${h(z.location || 'Sin ubicación')}</td>
              <td>${z.kind === 'gas' ? 'Gas' : 'Polvo'}</td>
              <td class="mono">${z.zone === 'sin_clasificar' ? 'Sin clasificar' : `Zona ${h(z.zone)}`}</td>
              <td><span class="sg-chip sg-lv--${z.level}">${h(ZONE_STATUS[z.status] ?? z.status)}</span></td>
            </tr>`).join('')}</tbody></table></div>` : '<p class="sg-muted">No hay zonas ATEX registradas.</p>'}
        </div>
      </section>` : '';

    const docs = d.documents?.length ? `
      <section class="sg-section" aria-labelledby="sgDocsTitle">
        <div class="sg-section__head"><div><span class="sg-eyebrow"><b>04</b> Documentación</span><h2 class="sg-section__title" id="sgDocsTitle">Documentos compartidos</h2></div></div>
        <ul class="sg-docs">${d.documents.map((doc) => `
          <li class="sg-doc">
            <span class="sg-doc__icon">${h(extOf(doc.filename))}</span>
            <span class="sg-doc__name">${h(doc.filename)}<span class="sg-doc__size">${h(sizeText(doc.size))}</span></span>
            ${onDownload ? `<button type="button" class="btn btn--ghost sg-btn-sm" data-sg-download="${h(doc.id)}">${ICON.download} Descargar</button>` : ''}
          </li>`).join('')}</ul>
      </section>` : '';

    return `
      <section class="sg-section">
        <div class="sg-split">
          <div class="sg-panel">
            <span class="sg-eyebrow"><b>02</b> Calendario</span>
            <h2 class="sg-panel__title" style="margin-top:6px">Próximos vencimientos</h2>
            ${upcoming}
          </div>
          <div class="sg-panel">
            <span class="sg-eyebrow">Sello de integridad</span>
            <h2 class="sg-panel__title" style="margin-top:6px">Registros inalterados</h2>
            <div class="sg-seal">
              ${sealRow(lawOk, 'Registro de normativa', d.integrity?.herzogLaw)}
              ${sealRow(seagleOk, 'Registro de accesos de inspección', d.integrity?.seagle)}
              <p class="sg-seal__note">Cada cambio y cada acceso se encadena con una huella criptográfica de la entrada anterior. Si alguien alterase un registro, la cadena se rompería y se vería aquí. Comprobado ${h(formatTime(d.integrity?.checkedAt))}.</p>
            </div>
          </div>
        </div>
      </section>
      ${zones}
      ${docs}`;
  }

  function animateNumbers() {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    root.querySelectorAll('[data-sg-count]').forEach((el) => {
      const target = Number(el.dataset.sgCount) || 0;
      if (reduced || target === 0) { el.textContent = String(target); return; }
      const start = performance.now();
      const step = (t) => {
        const k = Math.min(1, (t - start) / 900);
        el.textContent = String(Math.round(target * (1 - (1 - k) ** 3)));
        if (k < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    root.querySelectorAll('[data-sg-pct]').forEach((ring) => {
      const pct = Number(ring.dataset.sgPct) || 0;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        ring.setAttribute('stroke-dashoffset', (RING_C * (1 - pct / 100)).toFixed(2));
      }));
    });
  }

  function update(data) {
    const prev = state.data;
    state.data = data;
    // Los numeros solo se animan la primera vez o si cambian: un refresco igual no parpadea.
    const changed = !prev || JSON.stringify(prev.overall) !== JSON.stringify(data.overall) || prev.frameworks.length !== data.frameworks.length;
    const focused = document.activeElement?.matches?.('[data-sg-search]');
    // El resplandor del fondo (.sg-stage) toma el color del nivel global.
    (root.closest('.sg-stage') ?? root).style.setProperty('--sg-c', `var(--${({ rojo: 'accent-red', ambar: 'accent-amber', verde: 'accent-green' })[data.overall.level] ?? 'accent-blue'})`);
    root.innerHTML = `${heroHtml(data)}${normsSectionHtml(data)}${detailsHtml(data)}`;
    paintNorms();
    if (focused) {
      const input = root.querySelector('[data-sg-search]');
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
    if (changed || state.firstPaint) animateNumbers();
    else settleNumbers();
    state.firstPaint = false;
    // Una nueva pintura re-dispara la animacion de entrada de las fichas; solo la primera vez.
    if (prev) root.querySelectorAll('.sg-norm').forEach((el) => { el.style.animation = 'none'; });
  }

  function settleNumbers() {
    root.querySelectorAll('[data-sg-count]').forEach((el) => { el.textContent = el.dataset.sgCount; });
    root.querySelectorAll('[data-sg-pct]').forEach((ring) => {
      ring.style.transition = 'none';
      ring.setAttribute('stroke-dashoffset', (RING_C * (1 - (Number(ring.dataset.sgPct) || 0) / 100)).toFixed(2));
    });
  }

  skeleton();
  return { update, skeleton };
}

export function formatTime(iso) {
  if (!iso) return 'ahora';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'ahora';
  return `a las ${d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
}

/** "hace 12 s", "hace 3 min": para el indicador de "en vivo". */
export function agoText(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `hace ${s} s`;
  const m = Math.round(s / 60);
  return `hace ${m} min`;
}

/** Cuenta atras "2 h 14 min" o "38 s" hasta `iso`. */
export function remainingText(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return 'caducada';
  const s = Math.floor(ms / 1000);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  if (hh > 0) return `${hh} h ${mm} min`;
  if (mm > 0) return `${mm} min ${s % 60} s`;
  return `${s} s`;
}
