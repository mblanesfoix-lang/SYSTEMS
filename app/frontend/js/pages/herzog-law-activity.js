// Herzog LaW · pestana de actividad: ultimos movimientos del log inmutable y su verificacion.
import { api, escapeHtml } from '/js/api.js';
import { $, fmtNum, timeAgo } from './herzog-law-common.js';

const FEED_LIMIT = 40;

const FIELD_LABEL = {
  status: 'estado', priority: 'prioridad', owner: 'responsable', issuer: 'entidad emisora', certNumber: 'número de certificado',
  issuedAt: 'fecha de emisión', expiresAt: 'vencimiento', notes: 'notas', code: 'código', title: 'título', summary: 'descripción',
  why: 'motivo', appliesWhen: 'cuándo aplica', family: 'familia', kind: 'tipo', nature: 'naturaleza', jurisdictions: 'ámbito',
};

/* Frase corta por accion; `d` es el detalle que guardo la entrada. */
const SENTENCES = {
  'catalog.seed': (d) => `Se cargó el catálogo: ${[d.inserted && `${d.inserted} marcos`, d.titles && `${d.titles} títulos del Estado`].filter(Boolean).join(' y ')}`,
  'framework.create': (d) => `Se añadió el marco ${d.code}`,
  'framework.update': (d, code) => `Se actualizó ${code(d.frameworkId)}${d.changed?.length ? ` (${d.changed.map((k) => FIELD_LABEL[k] || k).join(', ')})` : ''}`,
  'framework.delete': (d) => `Se eliminó el marco ${d.code}`,
  'requirement.add': (d, code) => `Se añadió un requisito propio a ${code(d.frameworkId)}`,
  'requirement.toggle': (d, code) => `${d.done ? 'Se cumplió' : 'Se reabrió'} un requisito de ${code(d.frameworkId)}`,
  'requirement.delete': (d, code) => `Se quitó un requisito propio de ${code(d.frameworkId)}`,
  'document.upload': (d, code) => `Se subió «${d.filename}» a ${code(d.frameworkId)}`,
  'document.delete': (d, code) => `Se eliminó «${d.filename}»${d.frameworkId ? ` de ${code(d.frameworkId)}` : ''}`,
  'zone.create': (d) => `Se añadió la zona «${d.name}»`,
  'zone.update': (d) => `Se actualizó la zona «${d.name}»`,
  'zone.delete': (d) => `Se eliminó la zona «${d.name}»`,
};

const dotClass = (action) => (action.endsWith('.delete') ? ' is-del' : action === 'requirement.toggle' || action === 'catalog.seed' ? ' is-ok' : '');

export function initActivity(root, ctx) {
  root.innerHTML = `
    <div class="law-integrity">
      <div id="integrityText"><b>Integridad del log</b><div class="law-help" style="margin-top:2px;">Cada movimiento se encadena con el anterior mediante un hash: alterar uno rompe la cadena.</div></div>
      <button type="button" class="btn ghost" id="verifyBtn">Verificar ahora</button>
    </div>
    <div class="card law-block">
      <span class="law-block__eyebrow">Registro</span>
      <h2 class="law-block__title">Actividad reciente</h2>
      <p class="law-block__desc">Quién hizo qué y cuándo, del más reciente al más antiguo.</p>
      <ul class="law-feed" id="feed"><li class="law-empty">Cargando…</li></ul>
    </div>`;

  const feed = $('#feed', root);
  const integrity = $('#integrityText', root);

  async function verify() {
    try {
      const v = await api.herzogLawLogVerify();
      integrity.innerHTML = v.valid
        ? `<span class="law-pill is-ok">Cadena íntegra</span> <span class="law-help">${fmtNum(v.totalEntries, 0)} entradas verificadas</span>`
        : `<span class="law-pill is-bad">Cadena rota</span> <span class="law-help">Primera entrada alterada: nº ${v.brokenAtSeq}</span>`;
    } catch (ex) {
      integrity.innerHTML = `<span class="law-pill is-bad">No se pudo verificar</span> <span class="law-help">${escapeHtml(ex.message || '')}</span>`;
    }
  }

  async function refresh() {
    try {
      const rows = await api.herzogLawActivity(FEED_LIMIT);
      feed.innerHTML = rows.length
        ? rows.map((r) => {
          const d = r.detail || {};
          const sentence = (SENTENCES[r.action] || (() => r.action))(d, ctx.getFrameworkCode);
          return `<li class="law-feed__item"><span class="law-feed__dot${dotClass(r.action)}"></span>
            <div><div>${escapeHtml(sentence)}</div><div class="law-feed__who">${escapeHtml(r.actorId || 'sistema')}</div></div>
            <span class="law-feed__time" title="${escapeHtml(r.createdAt)}">${escapeHtml(timeAgo(r.createdAt))}</span></li>`;
        }).join('')
        : '<li class="law-empty">Aún no hay actividad.</li>';
    } catch (ex) {
      feed.innerHTML = `<li class="law-empty">${escapeHtml(ex.message || 'No se pudo cargar la actividad')}</li>`;
    }
    verify();
  }

  $('#verifyBtn', root).addEventListener('click', verify);
  return { refresh };
}
