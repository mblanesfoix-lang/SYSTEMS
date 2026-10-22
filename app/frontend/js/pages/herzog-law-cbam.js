// Herzog LaW · pestana CBAM y Argelia: explicacion, calendario y simulador orientativo.
import { api, escapeHtml } from '/js/api.js';
import { $, fmtDay, fmtEur, fmtNum } from './herzog-law-common.js';

const FIELDS = [
  { key: 'tonnes', label: 'Toneladas exportadas a la UE al año', unit: 't', help: 'Del producto CBAM del cliente: fertilizante, acero, cemento u otro.', required: true },
  { key: 'embeddedPerTonne', label: 'Emisiones incorporadas', unit: 'tCO2e por tonelada', help: 'Las calcula el verificador del cliente con datos medidos.', required: true },
  { key: 'freeAllocationPerTonne', label: 'Deducción por asignación gratuita', unit: 'tCO2e por tonelada', help: 'La fija la Comisión para cada producto. Si no la conoces, déjala en 0: el coste saldrá más alto.', initial: '0' },
  { key: 'certificatePrice', label: 'Precio del certificado', unit: 'EUR por tCO2e', help: 'Introduce el precio vigente del certificado CBAM.', required: true },
  { key: 'originCarbonPrice', label: 'Carbono ya pagado en origen', unit: 'EUR por tCO2e', help: 'Se descuenta del coste. Confirma con el cliente qué paga realmente en Argelia.', initial: '0' },
  { key: 'fuelSharePct', label: 'Emisiones debidas al combustible térmico', unit: '%', help: 'Parte de las emisiones que viene de quemar combustible en hornos o calderas.', initial: '0' },
  { key: 'substitutionPct', label: 'Combustible sustituido por biopellet', unit: '%', help: 'Solo cuenta si el biopellet cumple los criterios de sostenibilidad.', initial: '0' },
];

const STEPS = [
  ['Residuo', 'Residuo orgánico del cliente'],
  ['Proceso', 'Módulos BioHybrid lo convierten en biopellet'],
  ['Sustitución', 'El biopellet reemplaza combustible fósil en su horno o caldera'],
  ['Emisiones', 'Su producto lleva menos CO2 incorporado'],
  ['Objetivo', 'Menor coste CBAM al exportar a la UE'],
];

const SIM_DEBOUNCE_MS = 250;

function timeline(events) {
  const today = new Date().toISOString().slice(0, 10);
  const firstFuture = events.findIndex((e) => e.date > today);
  return `<div class="law-time">${events.map((e, i) => `
    <div class="law-time__item ${e.date <= today ? 'is-past' : i === firstFuture ? 'is-next' : ''}">
      <div class="law-time__date">${escapeHtml(fmtDay(e.date))}</div>
      <div class="law-time__label">${escapeHtml(e.label)}</div>
      <div class="law-time__detail">${escapeHtml(e.detail)}</div>
    </div>`).join('')}</div>`;
}

function factorChart(rows) {
  const last = rows[rows.length - 1].year;
  const now = Math.min(new Date().getFullYear(), last);
  return `<div class="law-years" role="img" aria-label="Porcentaje de asignación gratuita que se retira cada año, de ${rows[0].pct} % en ${rows[0].year} a ${rows[rows.length - 1].pct} % en ${last}">${rows.map((r) => `
    <div class="law-year${r.year === now ? ' is-now' : ''}">
      <span class="law-year__pct">${fmtNum(r.pct, 1)}%</span>
      <div class="law-year__bar" style="height:calc((100% - 40px) * ${r.pct / 100})"></div>
      <span class="law-year__y">${r.year}</span>
    </div>`).join('')}</div>`;
}

function simulatorForm() {
  return FIELDS.map((f) => `
    <div>
      <label for="sim-${f.key}">${escapeHtml(f.label)} <span class="law-muted">· ${escapeHtml(f.unit)}</span></label>
      <input class="input" id="sim-${f.key}" data-sim="${f.key}" type="number" min="0" step="any" inputmode="decimal" value="${escapeHtml(f.initial ?? '')}" placeholder="${f.required ? 'Obligatorio' : '0'}">
      <span class="law-help">${escapeHtml(f.help)}</span>
    </div>`).join('');
}

function resultsHtml(r) {
  const avoided = r.baseline.embeddedEmissions - r.withBiomass.embeddedEmissions;
  const max = Math.max(r.baseline.cost, r.withBiomass.cost, 1);
  const bar = (label, cost, tone) => `<div class="law-sim__cmp-row"><span>${label}</span><div class="law-bar"><div class="law-bar__fill${tone}" style="width:${(cost / max) * 100}%"></div></div><b>${fmtEur(cost)}</b></div>`;
  const noCost = r.baseline.chargeableEmissions === 0
    ? '<p class="law-callout">Con estos datos la deducción por asignación gratuita cubre todas las emisiones, así que no hay coste CBAM. Revisa la deducción con el verificador.</p>' : '';
  return `
    <div class="law-sim__hero"><div class="law-sim__label">Coste CBAM estimado al año, sin biopellet</div><div class="law-sim__big">${fmtEur(r.baseline.cost)}</div></div>
    <div class="law-sim__hero"><div class="law-sim__label">Con biopellet, si cumple los criterios de sostenibilidad</div><div class="law-sim__big is-ok">${fmtEur(r.withBiomass.cost)}</div></div>
    <div class="law-sim__row">
      <div class="law-sim__hero"><div class="law-sim__label">Ahorro estimado</div><div class="law-sim__big is-ok" style="font-size:1.4rem;">${fmtEur(r.saving)}</div></div>
      <div class="law-sim__hero"><div class="law-sim__label">Emisiones evitadas</div><div class="law-sim__big" style="font-size:1.4rem;">${fmtNum(avoided, 1)} t</div><div class="law-help">${fmtNum(r.emissionsReductionPct, 1)} % menos</div></div>
    </div>
    <div class="law-sim__cmp">${bar('Sin biopellet', r.baseline.cost, '')}${bar('Con biopellet', r.withBiomass.cost, ' is-done')}</div>
    ${noCost}`;
}

export function initCbam(root, ctx) {
  root.innerHTML = '<div class="law-empty">Cargando…</div>';

  api.herzogLawCbamReference().then((ref) => {
    const factor = ref.factorByYear;
    const sources = [...ref.sources, ...ref.algeria.sources].filter((s, i, all) => all.findIndex((o) => o.url === s.url) === i);

    root.innerHTML = `
      <div class="law-trio">
        <div class="law-trio__card"><span class="law-trio__num">01 · QUÉ ES</span><h3 class="law-trio__title">Una tasa de carbono en la frontera de la UE</h3>
          <p>Quien importa ${ref.sectors.map((s) => s.toLowerCase()).join(', ')} paga por el CO2 emitido al fabricarlos, igual que pagaría un fabricante europeo. Es un reglamento, no una directiva: se aplica directamente.</p></div>
        <div class="law-trio__card"><span class="law-trio__num">02 · A QUIÉN AFECTA</span><h3 class="law-trio__title">Al importador y, por arrastre, a su proveedor</h3>
          <p>El importador europeo declara las emisiones y entrega certificados. Su proveedor de fuera de la UE, por ejemplo una industria argelina, debe facilitarle esas emisiones verificadas. Por debajo de ${ref.thresholdTonnes} toneladas netas al año por importador no se aplica.</p></div>
        <div class="law-trio__card"><span class="law-trio__num">03 · PARA S-NFI EN ARGELIA</span><h3 class="law-trio__title">No obliga a S-NFI, pero abre una ventaja</h3>
          <p>S-NFI no vende bienes CBAM, así que no está obligada. Sus clientes industriales que exporten a la UE sí lo están. Un biopellet que sustituya combustible fósil puede bajar sus emisiones y su coste.</p></div>
      </div>

      <div class="card law-block">
        <span class="law-block__eyebrow">Ventaja</span>
        <h2 class="law-block__title">Cómo reduce S-NFI el coste CBAM de un cliente</h2>
        <p class="law-block__desc">El camino que seguiría un cliente industrial en Argelia que exporta a la UE.</p>
        <ol class="law-steps">${STEPS.map(([tag, text], i) => `<li class="law-step${i === STEPS.length - 1 ? ' is-goal' : ''}"><b>${escapeHtml(tag.toUpperCase())}</b>${escapeHtml(text)}</li>`).join('')}</ol>
        <div class="law-callout is-warn"><b>Condición.</b> ${escapeHtml(ref.biomass)} Sin esa prueba, la Comisión cuenta el biopellet como cualquier otro combustible y no hay ahorro.</div>
        <div class="law-form__actions" style="justify-content:flex-start; margin-top:16px;">
          <button type="button" class="btn ghost" data-open-fw="cbam">Ver requisitos de CBAM</button>
          <button type="button" class="btn ghost" data-open-fw="eu-red">Ver requisitos de sostenibilidad (RED)</button>
        </div>
      </div>

      <div class="card law-block">
        <span class="law-block__eyebrow">Calendario</span>
        <h2 class="law-block__title">Fechas clave</h2>
        <p class="law-block__desc">Fechas de la Comisión Europea. Confírmalas en su guía oficial antes de actuar.</p>
        ${timeline(ref.timeline)}
      </div>

      <div class="law-grid-2">
        <div class="card law-block" style="margin-bottom:0;">
          <span class="law-block__eyebrow">Ritmo</span>
          <h2 class="law-block__title">Asignación gratuita que se retira</h2>
          <p class="law-block__desc">Cada año se retira más asignación gratuita a los productores europeos y el coste CBAM se acerca al coste real del carbono.</p>
          ${factorChart(factor)}
        </div>
        <div class="card law-block" style="margin-bottom:0;">
          <span class="law-block__eyebrow">Argelia</span>
          <h2 class="law-block__title">Qué sectores cubre CBAM</h2>
          <p class="law-block__desc">${escapeHtml(ref.algeria.note)}</p>
          <div class="law-card__tags">${ref.sectors.map((s) => `<span class="law-chip">${escapeHtml(s)}</span>`).join('')}</div>
        </div>
      </div>

      <div style="height:20px;"></div>

      <div class="card law-block">
        <span class="law-block__eyebrow">Simulador</span>
        <h2 class="law-block__title">Cuánto puede costar y cuánto se puede ahorrar</h2>
        <p class="law-block__desc">Estimación orientativa para un cliente exportador. Rellena los tres datos obligatorios y el resultado aparece solo. Los datos no se guardan.</p>
        <div class="law-sim">
          <form class="law-form" id="simForm" novalidate>${simulatorForm()}</form>
          <div class="law-sim__results" id="simResults"><div class="law-sim__empty">Indica las toneladas, las emisiones incorporadas y el precio del certificado para ver la estimación.</div></div>
        </div>
        <details class="law-details">
          <summary>Cómo se calcula</summary>
          <p>Emisiones con coste = <code>(emisiones incorporadas − deducción por asignación gratuita) × toneladas</code>, sin bajar de cero.<br>
          Precio neto = <code>precio del certificado − carbono pagado en origen</code>, sin bajar de cero.<br>
          Coste = <code>emisiones con coste × precio neto</code>.<br>
          Con biopellet, las emisiones incorporadas bajan en <code>parte del combustible × parte sustituida</code>.<br>
          Es una estimación: la deducción la fija la Comisión y el cálculo oficial lo hace el declarante con datos verificados.</p>
        </details>
      </div>

      <div class="card law-block">
        <span class="law-block__eyebrow">Fuentes</span>
        <h2 class="law-block__title">De dónde salen los datos</h2>
        <ul class="law-refs" style="margin-top:12px;">${sources.map((s) => `<li><a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.label)} ↗</a></li>`).join('')}</ul>
      </div>`;

    root.addEventListener('click', (e) => {
      const open = e.target.closest('[data-open-fw]');
      if (open) ctx.openFramework(open.dataset.openFw);
    });

    const results = $('#simResults', root);
    let timer = null;
    let seq = 0;
    const readInput = () => Object.fromEntries(FIELDS.map((f) => [f.key, $(`#sim-${f.key}`, root).value.trim()]));

    async function estimate() {
      const input = readInput();
      if (FIELDS.some((f) => f.required && input[f.key] === '')) {
        results.innerHTML = '<div class="law-sim__empty">Indica las toneladas, las emisiones incorporadas y el precio del certificado para ver la estimación.</div>';
        return;
      }
      const mine = ++seq;
      try {
        const r = await api.herzogLawCbamEstimate(input);
        if (mine === seq) results.innerHTML = resultsHtml(r);
      } catch (ex) {
        if (mine === seq) results.innerHTML = `<div class="law-sim__empty">${escapeHtml(ex.message || 'No se pudo calcular')}</div>`;
      }
    }

    $('#simForm', root).addEventListener('submit', (e) => e.preventDefault());
    $('#simForm', root).addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(estimate, SIM_DEBOUNCE_MS);
    });
  }).catch((ex) => {
    root.innerHTML = `<div class="law-empty">${escapeHtml(ex.message || 'No se pudo cargar CBAM')}</div>`;
  });

  return {};
}
