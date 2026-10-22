/**
 * Reglas puras de las invitaciones de inspeccion de S-EAGLE: validacion de lo
 * que pide el Admin al crearlas y estado de una invitacion en un momento
 * dado. Sin Mongo ni Express para poder probarlas sin infraestructura.
 */

export const INVITE_DEFAULT_HOURS = 8;
export const INVITE_MAX_HOURS = 72;
export const INVITE_MAX_EMAILS = 10;
export const INVITE_MAX_DOCUMENTS = 50;
// Fallos de codigo o de correo que una invitacion aguanta en total, desde cualquier IP,
// antes de bloquearse para siempre: el Admin emite otra. Los limitadores por IP frenan
// antes; este tope cierra el ataque lento y distribuido.
export const INVITE_MAX_FAILURES = 10;
// Una sesion de inspector no dura mas que esto aunque la invitacion siga viva: el
// inspector vuelve a introducir el codigo.
export const SESSION_MAX_HOURS = 12;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const textOf = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

function uniqueStrings(list) {
  return [...new Set(list.map((v) => String(v).trim()).filter(Boolean))];
}

/**
 * Valida el cuerpo de una invitacion nueva contra lo que existe hoy.
 * `knownFrameworks` y `knownDocuments`: Set de ids validos en el tenant.
 * Devuelve { value } o { error }.
 */
export function parseInvitationInput(body, { knownFrameworks, knownDocuments }) {
  const b = body && typeof body === 'object' ? body : {};

  const label = textOf(b.label, 120);
  if (label.length < 3) return { error: 'Indica el organismo o el motivo de la inspección (mínimo 3 caracteres)' };

  if (!Array.isArray(b.emails)) return { error: 'emails debe ser una lista de correos' };
  const emails = uniqueStrings(b.emails.map((e) => String(e).toLowerCase()));
  if (emails.length === 0) return { error: 'Indica al menos un correo autorizado' };
  if (emails.length > INVITE_MAX_EMAILS) return { error: `Máximo ${INVITE_MAX_EMAILS} correos por invitación` };
  const invalid = emails.find((e) => !EMAIL_RE.test(e) || e.length > 200);
  if (invalid) return { error: `Correo no válido: ${invalid.slice(0, 60)}` };

  const hours = b.hours === undefined || b.hours === null || b.hours === '' ? INVITE_DEFAULT_HOURS : Number(b.hours);
  if (!Number.isFinite(hours) || hours < 1 || hours > INVITE_MAX_HOURS) {
    return { error: `La duración debe estar entre 1 y ${INVITE_MAX_HOURS} horas` };
  }

  // null: todas las normas que existan en cada momento; lista: solo esas.
  let frameworkIds = null;
  if (b.frameworkIds !== undefined && b.frameworkIds !== null) {
    if (!Array.isArray(b.frameworkIds)) return { error: 'frameworkIds debe ser una lista o null' };
    frameworkIds = uniqueStrings(b.frameworkIds);
    if (frameworkIds.length === 0) return { error: 'Elige al menos una norma o comparte todas' };
    const unknown = frameworkIds.find((id) => !knownFrameworks.has(id));
    if (unknown) return { error: `Norma desconocida: ${unknown.slice(0, 60)}` };
  }

  let documentIds = [];
  if (b.documentIds !== undefined && b.documentIds !== null) {
    if (!Array.isArray(b.documentIds)) return { error: 'documentIds debe ser una lista' };
    documentIds = uniqueStrings(b.documentIds);
    if (documentIds.length > INVITE_MAX_DOCUMENTS) return { error: `Máximo ${INVITE_MAX_DOCUMENTS} documentos por invitación` };
    const unknown = documentIds.find((id) => !knownDocuments.has(id));
    if (unknown) return { error: `Documento desconocido: ${unknown.slice(0, 60)}` };
  }

  for (const key of ['includeZones', 'demo']) {
    if (b[key] !== undefined && typeof b[key] !== 'boolean') return { error: `${key} debe ser verdadero o falso` };
  }

  return {
    value: {
      label,
      emails,
      hours,
      scope: { frameworkIds, includeZones: b.includeZones ?? true, documentIds },
      // Ante duda, demostracion: el Admin la desmarca cuando los datos son los reales.
      demo: b.demo ?? true,
    },
  };
}

/** Estado de una invitacion: ok o el motivo por el que ya no abre. */
export function invitationState(row, now = new Date()) {
  if (!row) return { ok: false, reason: 'NOT_FOUND' };
  if (row.revoked) return { ok: false, reason: 'REVOKED' };
  if ((row.failedAttempts ?? 0) >= INVITE_MAX_FAILURES) return { ok: false, reason: 'LOCKED' };
  if (new Date(row.expiresAt).getTime() <= now.getTime()) return { ok: false, reason: 'EXPIRED' };
  return { ok: true, reason: 'ACTIVE' };
}

/** Fin de una sesion nueva: el primero entre el tope de sesion y el fin de la invitacion. */
export function sessionExpiry(invitationExpiresAt, now = new Date()) {
  const cap = now.getTime() + SESSION_MAX_HOURS * 3600 * 1000;
  return new Date(Math.min(cap, new Date(invitationExpiresAt).getTime()));
}
