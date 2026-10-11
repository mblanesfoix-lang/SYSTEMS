/**
 * S-NFI F&L · utilidades de fecha civil (YYYY-MM-DD) y computo de plazos.
 *
 * Todas las fechas de negocio de la mesa son dias civiles de Espana
 * (Europe/Madrid), sin hora: un vencimiento AEAT o una caducidad de poder no
 * dependen de la zona horaria del contenedor. Por eso se trabaja con cadenas
 * ISO de dia y aritmetica en UTC puro (sin horario de verano de por medio).
 *
 * Computo de plazos (Ley 39/2015, art. 30, verificado contra el texto
 * consolidado BOE-A-2015-10565):
 *   - Dias habiles: se cuentan desde el dia siguiente a la notificacion,
 *     excluyendo sabados, domingos y festivos.
 *   - Meses: desde el dia siguiente; concluye el mismo dia del mes de
 *     vencimiento (o el ultimo dia del mes si no existe ese dia).
 *   - Si el ultimo dia es inhabil, se prorroga al primer dia habil siguiente.
 * Los festivos NO se modelan (no hay calendario oficial conectado): el
 * resultado puede caer antes que el plazo real, nunca despues. Es el lado
 * conservador para un plazo legal.
 *
 * Rechazo presunto de notificaciones electronicas (art. 43.2): diez dias
 * naturales desde la puesta a disposicion sin acceder al contenido.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

export const DIAS_RECHAZO_PRESUNTO = 10;

export function isIsoDate(s) {
  if (typeof s !== 'string' || !ISO_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  const back = new Date(t);
  return back.getUTCFullYear() === y && back.getUTCMonth() === m - 1 && back.getUTCDate() === d;
}

function toUtc(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function fromUtc(t) {
  return new Date(t).toISOString().slice(0, 10);
}

export function isoOf(y, m, d) {
  return fromUtc(Date.UTC(y, m - 1, d));
}

/** Dia civil de hoy en Espana, sea cual sea la zona horaria del proceso. */
export function todayIso(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

export function addDaysIso(iso, n) {
  return fromUtc(toUtc(iso) + n * DAY_MS);
}

/** b - a en dias (positivo si b es posterior). */
export function diffDaysIso(a, b) {
  return Math.round((toUtc(b) - toUtc(a)) / DAY_MS);
}

export function isWeekendIso(iso) {
  const dow = new Date(toUtc(iso)).getUTCDay();
  return dow === 0 || dow === 6;
}

/** El propio dia si es habil; si no, el primer dia habil siguiente (art. 30.5). */
export function nextBusinessDayIso(iso) {
  let cur = iso;
  while (isWeekendIso(cur)) cur = addDaysIso(cur, 1);
  return cur;
}

/** n dias habiles contados desde el dia siguiente a `iso` (art. 30.2 y 30.3). */
export function addBusinessDaysIso(iso, n) {
  let cur = iso;
  let left = n;
  while (left > 0) {
    cur = addDaysIso(cur, 1);
    if (!isWeekendIso(cur)) left -= 1;
  }
  return cur;
}

/** n meses desde `iso`; mismo dia del mes de vencimiento o el ultimo del mes (art. 30.4). */
export function addMonthsIso(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const targetMonth = m - 1 + n;
  const lastDay = new Date(Date.UTC(y, targetMonth + 1, 0)).getUTCDate();
  return fromUtc(Date.UTC(y, targetMonth, Math.min(d, lastDay)));
}

export function lastDayOfMonthIso(y, m) {
  return fromUtc(Date.UTC(y, m, 0));
}

/**
 * Fecha limite de respuesta a una notificacion a partir del acuse.
 * tipo: 'habiles' | 'naturales' | 'meses'. null si no hay plazo.
 */
export function computeFechaLimite(acuseIso, plazo, tipo) {
  if (!isIsoDate(acuseIso) || !Number.isInteger(plazo) || plazo <= 0) return null;
  if (tipo === 'habiles') return addBusinessDaysIso(acuseIso, plazo);
  if (tipo === 'meses') return nextBusinessDayIso(addMonthsIso(acuseIso, plazo));
  if (tipo === 'naturales') return nextBusinessDayIso(addDaysIso(acuseIso, plazo));
  return null;
}

/** Ultimo dia de acceso antes del rechazo presunto (puesta a disposicion + 10 naturales). */
export function fechaRechazoPresunto(puestaIso) {
  return isIsoDate(puestaIso) ? addDaysIso(puestaIso, DIAS_RECHAZO_PRESUNTO) : null;
}
