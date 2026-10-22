/**
 * Vista de cumplimiento de S-EAGLE: convierte los registros de Herzog LaW
 * (marcos normativos y zonas ATEX) en un semaforo por norma y uno global. Es
 * una funcion pura, sin Mongo ni Express: la ruta le pasa los datos.
 *
 * Reglas del semaforo (conservadoras: ante duda, nunca verde):
 *  - Solo las normas obligatorias cuentan para el semaforo global. Las
 *    voluntarias e indirectas se muestran, y solo penalizan si estan vencidas.
 *  - rojo: vencida, o norma obligatoria de prioridad alta que no esta vigente.
 *  - ambar: vencimiento proximo o critico, falta la fecha de una norma que
 *    caduca, en preparacion, sin iniciar, o vigente con requisitos pendientes.
 *  - verde: vigente, con fecha en regla y todos los requisitos cumplidos.
 *  - no aplica: se muestra y no cuenta.
 *  - zona ATEX pendiente de clasificar: ambar.
 */

import { ALERT_RANK, expiryState, readiness } from './law-calc.js';

const LEVEL_RANK = { verde: 0, ambar: 1, rojo: 2 };

function worst(levels) {
  return levels.reduce((acc, l) => (LEVEL_RANK[l] > LEVEL_RANK[acc] ? l : acc), 'verde');
}

/** Nivel de una norma y el motivo en una frase, para que el inspector vea por que. */
export function frameworkLevel(f, expiry, ready) {
  if (f.status === 'no_aplica') return { level: 'no_aplica', reason: 'No aplica a S-NFI' };
  const obligatory = f.nature === 'obligatoria';
  if (expiry.state === 'vencido') return { level: 'rojo', reason: `Vencida hace ${Math.abs(expiry.days)} dias` };
  if (f.status !== 'vigente') {
    if (!obligatory) return { level: 'informativo', reason: 'Norma no obligatoria, sin certificar' };
    if (f.priority === 'alta') return { level: 'rojo', reason: f.status === 'en_preparacion' ? 'Obligatoria de prioridad alta, en preparacion' : 'Obligatoria de prioridad alta, sin iniciar' };
    return { level: 'ambar', reason: f.status === 'en_preparacion' ? 'En preparacion' : 'Sin iniciar' };
  }
  if (ALERT_RANK[expiry.state]) return { level: 'ambar', reason: `Vence en ${expiry.days} dias` };
  if (f.tracksExpiry && expiry.state === 'sin_fecha') return { level: 'ambar', reason: 'Falta la fecha de vencimiento' };
  if (ready.total > 0 && ready.done < ready.total) return { level: 'ambar', reason: `Requisitos pendientes (${ready.done} de ${ready.total})` };
  return { level: 'verde', reason: 'Vigente y en regla' };
}

function frameworkView(f, now) {
  const expiry = expiryState(f.expiresAt, now);
  const ready = readiness(f.requirements);
  const { level, reason } = frameworkLevel(f, expiry, ready);
  return {
    id: f._id,
    code: f.code,
    title: f.title,
    kind: f.kind,
    family: f.family,
    jurisdictions: f.jurisdictions,
    nature: f.nature,
    priority: f.priority,
    status: f.status,
    issuer: f.issuer ?? null,
    certNumber: f.certNumber ?? null,
    issuedAt: f.issuedAt ?? null,
    expiresAt: f.expiresAt ?? null,
    expiry,
    readiness: ready,
    level,
    reason,
  };
}

function zoneView(z) {
  return {
    id: z._id,
    name: z.name,
    location: z.location ?? null,
    kind: z.kind,
    zone: z.zone,
    status: z.status,
    level: z.status === 'pendiente' ? 'ambar' : 'verde',
  };
}

const PRIORITY_ORDER = { alta: 0, media: 1, vigilar: 2 };
const SHOW_ORDER = { rojo: 0, ambar: 1, verde: 2, informativo: 3, no_aplica: 4 };

/**
 * @param {{ frameworks: object[], zones: object[], integrity?: object, now?: Date }} input
 */
export function buildComplianceView({ frameworks = [], zones = [], integrity = {}, now = new Date() }) {
  const items = frameworks
    .map((f) => frameworkView(f, now))
    .sort((a, b) => SHOW_ORDER[a.level] - SHOW_ORDER[b.level]
      || (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9)
      || a.code.localeCompare(b.code, 'es'));
  const zoneItems = zones.map(zoneView);

  const counted = items.filter((i) => i.nature === 'obligatoria' && i.level !== 'no_aplica');
  const levels = [...counted.map((i) => i.level), ...zoneItems.map((z) => z.level)];
  // Una norma no obligatoria vencida tambien penaliza (ver cabecera).
  for (const i of items) if (i.nature !== 'obligatoria' && i.level === 'rojo') levels.push('rojo');
  const level = levels.length ? worst(levels) : 'sin_datos';

  const byLevel = { rojo: 0, ambar: 0, verde: 0, informativo: 0, no_aplica: 0 };
  for (const i of items) byLevel[i.level] += 1;

  // Preparacion global: requisitos cumplidos de las normas obligatorias que aplican.
  const requirements = frameworks.filter((f) => f.nature === 'obligatoria' && f.status !== 'no_aplica').flatMap((f) => f.requirements ?? []);

  const upcoming = items
    .filter((i) => i.status === 'vigente' && ALERT_RANK[i.expiry.state])
    .sort((a, b) => a.expiry.days - b.expiry.days)
    .map(({ id, code, title, expiresAt, expiry }) => ({ id, code, title, expiresAt, state: expiry.state, days: expiry.days }));

  const zonesByStatus = { pendiente: 0, clasificada: 0, protegida: 0 };
  for (const z of zoneItems) zonesByStatus[z.status] = (zonesByStatus[z.status] ?? 0) + 1;

  return {
    generatedAt: now.toISOString(),
    overall: { level, byLevel, readiness: readiness(requirements), obligatoryCounted: counted.length },
    frameworks: items,
    upcoming,
    zones: { total: zoneItems.length, byStatus: zonesByStatus, items: zoneItems },
    integrity,
  };
}
