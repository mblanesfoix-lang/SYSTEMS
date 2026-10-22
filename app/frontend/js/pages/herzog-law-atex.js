// Herzog LaW · pestana de zonas ATEX: guia de zonas y registro con categoria de equipo exigida.
import { api, escapeHtml } from '/js/api.js';
import { $, zoneTone } from './herzog-law-common.js';

const ZONE_STATUS_LABEL = { pendiente: 'Pendiente de estudio', clasificada: 'Clasificada', protegida: 'Protegida' };
const ZONE_STATUS_TONE = { pendiente: 'is-warn', clasificada: 'is-info', protegida: 'is-ok' };
const ATMOSPHERE_LABEL = { polvo: 'Polvo', gas: 'Gas o vapor' };
const UNCLASSIFIED = 'sin_clasificar';

function scaleHtml(reference) {
  const row = (kind, label) => `
    <div class="law-scale__name">${label}</div>
    <div class="law-scale__row">${reference[kind].map((z) => `
      <div class="law-zone-card ${zoneTone(z.zone)}">
        <div class="law-zone-card__head"><span class="law-zone-card__zone">Zona ${escapeHtml(z.zone)}</span><span class="law-zone-card__cat">Categoría ${escapeHtml(z.category)}</span></div>
        <p>${escapeHtml(z.meaning)}</p>
      </div>`).join('')}</div>`;
  return `<div class="law-scale">${row('polvo', 'Polvo')}${row('gas', 'Gas o vapor')}</div>`;
}

export function initAtex(root, ctx) {
  let reference = null;
  const dialog = document.getElementById('zoneDialog');
  const form = document.getElementById('zoneForm');
  const errorBox = document.getElementById('znError');
  let editingId = null;

  root.innerHTML = `
    <div class="card law-block">
      <span class="law-block__eyebrow">Guía</span>
      <h2 class="law-block__title">Qué es una zona ATEX</h2>
      <p class="law-block__desc">Una zona ATEX es un área donde puede formarse aire explosivo (polvo, gas o vapor). Cuanto más probable es, más estricta es la zona y más exigente debe ser el equipo que se instale en ella.</p>
      <div id="atexScale"><div class="law-empty">Cargando…</div></div>
      <div class="law-callout is-warn" style="margin-top:18px;"><b>Para S-NFI.</b> El polvo que generan la trituración y el secado de residuo orgánico es el riesgo principal. Antes de fijar zonas hay que ensayar el polvo real en un laboratorio. La clasificación definitiva debe hacerla un técnico competente; este registro la recoge y la enlaza con los equipos.</div>
      <div class="law-form__actions" style="justify-content:flex-start; margin-top:16px;">
        <button type="button" class="btn ghost" data-open-fw="atex-2014-34">Ver ATEX de producto</button>
        <button type="button" class="btn ghost" data-open-fw="atex-1999-92">Ver ATEX de lugares de trabajo</button>
      </div>
    </div>
    <div class="card law-block">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:16px; flex-wrap:wrap;">
        <div>
          <span class="law-block__eyebrow">Registro</span>
          <h2 class="law-block__title">Zonas clasificadas</h2>
          <p class="law-block__desc" style="margin-bottom:0;">Cada zona con su sustancia, su categoría de equipo exigida y su estado. Es la base del documento de protección contra explosiones.</p>
        </div>
        <button type="button" class="btn sage" data-add-zone>Añadir zona</button>
      </div>
      <div class="law-table-wrap" id="zoneTable" style="margin-top:20px;"></div>
    </div>`;

  const ready = api.herzogLawZonesReference().then((ref) => {
    reference = ref;
    $('#atexScale', root).innerHTML = scaleHtml(ref);
  }).catch((ex) => {
    $('#atexScale', root).innerHTML = `<div class="law-empty">${escapeHtml(ex.message || 'No se pudo cargar la guía de zonas')}</div>`;
  });

  function render() {
    const zones = ctx.getZones();
    const host = $('#zoneTable', root);
    if (!zones.length) {
      host.innerHTML = '<div class="law-empty">Aún no hay zonas registradas. Empieza por las áreas donde se tritura, se seca o se almacena material seco.</div>';
      return;
    }
    host.innerHTML = `<table class="tbl">
      <thead><tr><th>Zona</th><th>Nombre y ubicación</th><th>Sustancia</th><th>Categoría exigida</th><th>Estado</th><th>Equipos</th><th></th></tr></thead>
      <tbody>${zones.map((z) => `<tr>
        <td><span class="law-zone-badge ${zoneTone(z.zone)}">${z.zone === UNCLASSIFIED ? '–' : escapeHtml(z.zone)}</span><div class="mono" style="margin-top:4px;">${escapeHtml(z.zone === UNCLASSIFIED ? 'Sin clasificar' : ATMOSPHERE_LABEL[z.kind])}</div></td>
        <td><b>${escapeHtml(z.name)}</b>${z.location ? `<div class="mono">${escapeHtml(z.location)}</div>` : ''}</td>
        <td>${escapeHtml(z.substance || '–')}</td>
        <td>${z.requiredCategory ? `<span class="law-chip">${escapeHtml(z.requiredCategory)}</span>` : '<span class="law-muted">Pendiente</span>'}</td>
        <td><span class="law-pill ${ZONE_STATUS_TONE[z.status]}">${escapeHtml(ZONE_STATUS_LABEL[z.status])}</span></td>
        <td>${escapeHtml(z.equipment || '–')}</td>
        <td class="law-actions-cell"><button type="button" class="law-link-btn" data-edit-zone="${escapeHtml(z.id)}">Editar</button><button type="button" class="law-link-btn is-danger" data-del-zone="${escapeHtml(z.id)}">Eliminar</button></td>
      </tr>`).join('')}</tbody></table>`;
  }

  /* ---- dialogo ---- */
  const field = (id) => document.getElementById(id);

  function fillZoneOptions(kind, selected) {
    const options = [`<option value="${UNCLASSIFIED}">Sin clasificar</option>`,
      ...(reference?.[kind] ?? []).map((z) => `<option value="${escapeHtml(z.zone)}">Zona ${escapeHtml(z.zone)} · categoría ${escapeHtml(z.category)}</option>`)];
    field('znZone').innerHTML = options.join('');
    field('znZone').value = [...field('znZone').options].some((o) => o.value === selected) ? selected : UNCLASSIFIED;
  }

  /* Una zona sin clasificar solo puede estar pendiente; una clasificada, no. */
  function syncStatus() {
    const unclassified = field('znZone').value === UNCLASSIFIED;
    for (const option of field('znStatus').options) option.disabled = unclassified ? option.value !== 'pendiente' : option.value === 'pendiente';
    if (unclassified) field('znStatus').value = 'pendiente';
    else if (field('znStatus').value === 'pendiente') field('znStatus').value = 'clasificada';
  }

  async function openDialog(zone) {
    await ready;
    editingId = zone ? zone.id : null;
    errorBox.style.display = 'none';
    field('znDialogTitle').textContent = zone ? 'Editar zona' : 'Añadir zona';
    field('znName').value = zone?.name ?? '';
    field('znLocation').value = zone?.location ?? '';
    field('znKind').value = zone?.kind ?? 'polvo';
    field('znSubstance').value = zone?.substance ?? '';
    fillZoneOptions(field('znKind').value, zone?.zone);
    field('znStatus').value = zone?.status ?? 'pendiente';
    syncStatus();
    field('znEquipment').value = zone?.equipment ?? '';
    field('znNotes').value = zone?.notes ?? '';
    dialog.showModal();
    field('znName').focus();
  }

  field('znKind').addEventListener('change', () => { fillZoneOptions(field('znKind').value, UNCLASSIFIED); syncStatus(); });
  field('znZone').addEventListener('change', syncStatus);
  field('znCancel').addEventListener('click', () => dialog.close());

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fail = (message) => { errorBox.textContent = message; errorBox.style.display = 'block'; };
    const name = field('znName').value.trim();
    if (!name) return fail('Indica el nombre de la zona');
    const payload = {
      name,
      location: field('znLocation').value.trim(),
      kind: field('znKind').value,
      substance: field('znSubstance').value.trim(),
      zone: field('znZone').value,
      status: field('znStatus').value,
      equipment: field('znEquipment').value.trim(),
      notes: field('znNotes').value.trim(),
    };
    try {
      if (editingId) await api.herzogLawZoneUpdate(editingId, payload); else await api.herzogLawZoneCreate(payload);
      dialog.close();
      ctx.toast(editingId ? 'Zona actualizada' : 'Zona añadida');
      await ctx.reloadZones();
    } catch (ex) {
      fail(ex.message || 'No se pudo guardar la zona');
    }
  });

  root.addEventListener('click', async (e) => {
    const open = e.target.closest('[data-open-fw]');
    if (open) return ctx.openFramework(open.dataset.openFw);
    if (e.target.closest('[data-add-zone]')) return openDialog(null);
    const edit = e.target.closest('[data-edit-zone]');
    if (edit) return openDialog(ctx.getZones().find((z) => z.id === edit.dataset.editZone));
    const del = e.target.closest('[data-del-zone]');
    if (del) {
      const zone = ctx.getZones().find((z) => z.id === del.dataset.delZone);
      if (!zone || !confirm(`¿Eliminar la zona «${zone.name}»? Quedará registrado en el log.`)) return;
      try {
        await api.herzogLawZoneDelete(zone.id);
        ctx.toast('Zona eliminada');
        await ctx.reloadZones();
      } catch (ex) {
        ctx.showError(ex.message || 'No se pudo eliminar la zona');
      }
    }
  });

  return { render };
}
