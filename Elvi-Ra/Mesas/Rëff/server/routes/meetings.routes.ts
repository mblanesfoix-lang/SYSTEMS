import { Router, Request, Response } from 'express';
import { getReffDb, nextSeq } from '../mongo.js';
import { authMiddleware } from '../auth.js';
import { sendMeetingCancelled, sendMeetingRescheduled } from '../meeting-mailer.js';

const router = Router();

router.use(authMiddleware);

export const MEETING_KINDS = ['presencial', 'videollamada', 'llamada', 'visita_planta', 'otro'] as const;
export const MEETING_STATUSES = ['agendada', 'realizada', 'cancelada'] as const;

type MeetingKind = typeof MEETING_KINDS[number];
type MeetingStatus = typeof MEETING_STATUSES[number];

// Reunión con una empresa del CRM. scheduled_at es ISO completo (fecha + hora
// en UTC); la UI la traduce a hora local. summary/next_steps se rellenan al
// marcar la reunión como realizada: es el registro de lo que se habló.
interface MeetingDoc {
  _id: number;
  company_id: number;
  sheet_id: number;
  user_id: string;
  title: string;
  kind: MeetingKind;
  status: MeetingStatus;
  scheduled_at: string;
  duration_min: number | null;
  location: string | null;
  attendees: string | null;
  summary: string | null;
  next_steps: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  // Marca del recordatorio 24h ya enviado (evita reenviarlo si el cron corre
  // varias veces sobre la misma reunión, mismo patrón que fl-expediente.js).
  reminder_sent_at?: string | null;
}

interface CompanyRef {
  _id: number;
  sheet_id: number;
  name: string;
  city: string;
  country: string;
}

// Forma serializada de una reunión (camelCase), compartida con meeting-mailer.ts
// / meeting-reminders.ts para no repetir el shape de doc -> DTO en cada sitio.
export interface Meeting {
  id: number;
  companyId: number;
  companyName: string | null;
  companyCity: string | null;
  companyCountry: string | null;
  sheetId: number;
  title: string;
  kind: MeetingKind;
  status: MeetingStatus;
  scheduledAt: string;
  durationMin: number | null;
  location: string | null;
  attendees: string | null;
  summary: string | null;
  nextSteps: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

function serialize(doc: MeetingDoc, company?: CompanyRef | null): Meeting {
  return {
    id: doc._id,
    companyId: doc.company_id,
    companyName: company?.name ?? null,
    companyCity: company?.city ?? null,
    companyCountry: company?.country ?? null,
    sheetId: doc.sheet_id,
    title: doc.title,
    kind: doc.kind,
    status: doc.status,
    scheduledAt: doc.scheduled_at,
    durationMin: doc.duration_min,
    location: doc.location,
    attendees: doc.attendees,
    summary: doc.summary,
    nextSteps: doc.next_steps,
    createdBy: doc.created_by,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

function validKind(v: unknown): v is MeetingKind {
  return typeof v === 'string' && (MEETING_KINDS as readonly string[]).includes(v);
}

function validStatus(v: unknown): v is MeetingStatus {
  return typeof v === 'string' && (MEETING_STATUSES as readonly string[]).includes(v);
}

// Normaliza a ISO. Acepta lo que manda <input type="datetime-local"> (sin zona,
// se interpreta como hora local del navegador que la envió) y un ISO completo.
function parseDate(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

// Misma regla de propiedad que companies.routes.ts: la empresa es del usuario
// solo si su hoja lo es. Sin esto, cualquier usuario agendaría sobre empresas ajenas.
async function getUserCompany(companyId: number, userId: string): Promise<CompanyRef | null> {
  const db = getReffDb();
  const company = await db.collection<CompanyRef>('companies').findOne({ _id: companyId });
  if (!company) return null;
  const sheet = await db.collection('sheets').findOne({ _id: company.sheet_id, user_id: userId } as never);
  if (!sheet) return null;
  return company;
}

async function getUserMeeting(meetingId: number, userId: string): Promise<MeetingDoc | null> {
  const meeting = await getReffDb().collection<MeetingDoc>('company_meetings').findOne({ _id: meetingId });
  if (!meeting) return null;
  const owned = await getUserCompany(meeting.company_id, userId);
  if (!owned) return null;
  return meeting;
}

// Resuelve nombres de empresa en bloque para no hacer N+1 al pintar el calendario.
async function attachCompanies(rows: MeetingDoc[]) {
  if (rows.length === 0) return [];
  const ids = [...new Set(rows.map((r) => r.company_id))];
  const companies = await getReffDb().collection<CompanyRef>('companies')
    .find({ _id: { $in: ids } } as never)
    .toArray();
  const byId = new Map(companies.map((c) => [c._id, c]));
  return rows.map((r) => serialize(r, byId.get(r.company_id)));
}

/* ---------- listado y calendario ---------- */

// Feed general del calendario. Filtros opcionales: rango (from/to en ISO o
// YYYY-MM-DD), hoja, empresa y estado.
router.get('/meetings', async (req: Request, res: Response) => {
  const { from, to, sheetId, companyId, status } = req.query;

  const db = getReffDb();
  const sheets = await db.collection('sheets').find({ user_id: req.user.id } as never).project({ _id: 1 }).toArray();
  const sheetIds = sheets.map((s) => s._id as number);
  if (sheetIds.length === 0) return res.json({ meetings: [] });

  const filter: Record<string, unknown> = { sheet_id: { $in: sheetIds } };

  if (typeof sheetId === 'string' && sheetId) {
    const wanted = Number(sheetId);
    if (!sheetIds.includes(wanted)) return res.status(404).json({ error: 'Hoja no encontrada' });
    filter.sheet_id = wanted;
  }
  if (typeof companyId === 'string' && companyId) {
    const owned = await getUserCompany(Number(companyId), req.user.id);
    if (!owned) return res.status(404).json({ error: 'Empresa no encontrada' });
    filter.company_id = Number(companyId);
  }
  if (typeof status === 'string' && status) {
    if (!validStatus(status)) return res.status(400).json({ error: 'Estado inválido' });
    filter.status = status;
  }

  const range: Record<string, string> = {};
  const fromIso = parseDate(from);
  const toIso = parseDate(to);
  if (fromIso) range.$gte = fromIso;
  if (toIso) range.$lte = toIso;
  if (Object.keys(range).length > 0) filter.scheduled_at = range;

  const rows = await db.collection<MeetingDoc>('company_meetings')
    .find(filter as never)
    .sort({ scheduled_at: 1 })
    .limit(500)
    .toArray();

  res.json({ meetings: await attachCompanies(rows) });
});

// KPIs de cabecera del calendario: próximas, realizadas y pendientes de acta
// (realizadas sin resumen escrito — reuniones que quedaron sin registrar).
router.get('/meetings/summary', async (req: Request, res: Response) => {
  const db = getReffDb();
  const sheets = await db.collection('sheets').find({ user_id: req.user.id } as never).project({ _id: 1 }).toArray();
  const sheetIds = sheets.map((s) => s._id as number);
  if (sheetIds.length === 0) {
    return res.json({ upcoming: 0, next7Days: 0, held: 0, pendingMinutes: 0, nextMeeting: null });
  }

  const nowIso = new Date().toISOString();
  const in7Iso = new Date(Date.now() + 7 * 86400_000).toISOString();
  const col = db.collection<MeetingDoc>('company_meetings');
  const base = { sheet_id: { $in: sheetIds } };

  const [upcoming, next7Days, held, pendingMinutes, nextRow] = await Promise.all([
    col.countDocuments({ ...base, status: 'agendada', scheduled_at: { $gte: nowIso } } as never),
    col.countDocuments({ ...base, status: 'agendada', scheduled_at: { $gte: nowIso, $lte: in7Iso } } as never),
    col.countDocuments({ ...base, status: 'realizada' } as never),
    col.countDocuments({ ...base, status: 'realizada', $or: [{ summary: null }, { summary: '' }] } as never),
    col.find({ ...base, status: 'agendada', scheduled_at: { $gte: nowIso } } as never)
      .sort({ scheduled_at: 1 }).limit(1).toArray(),
  ]);

  const next = nextRow[0]
    ? (await attachCompanies(nextRow as MeetingDoc[]))[0]
    : null;

  res.json({ upcoming, next7Days, held, pendingMinutes, nextMeeting: next });
});

// Historial de reuniones de una empresa concreta (ficha del CRM).
router.get('/companies/:id/meetings', async (req: Request, res: Response) => {
  const companyId = Number(req.params.id);
  const company = await getUserCompany(companyId, req.user.id);
  if (!company) return res.status(404).json({ error: 'Empresa no encontrada' });

  const rows = await getReffDb().collection<MeetingDoc>('company_meetings')
    .find({ company_id: companyId })
    .sort({ scheduled_at: -1 })
    .toArray();
  res.json({ meetings: rows.map((r) => serialize(r, company)) });
});

/* ---------- alta, edición y borrado ---------- */

router.post('/companies/:id/meetings', async (req: Request, res: Response) => {
  const companyId = Number(req.params.id);
  const company = await getUserCompany(companyId, req.user.id);
  if (!company) return res.status(404).json({ error: 'Empresa no encontrada' });

  const { title, kind, status, scheduledAt, durationMin, location, attendees, summary, nextSteps } = req.body || {};

  if (!title || typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ error: 'El título de la reunión es obligatorio' });
  }
  const scheduled = parseDate(scheduledAt);
  if (!scheduled) return res.status(400).json({ error: 'Fecha y hora de la reunión inválidas' });
  if (kind !== undefined && !validKind(kind)) return res.status(400).json({ error: 'Tipo de reunión inválido' });
  if (status !== undefined && !validStatus(status)) return res.status(400).json({ error: 'Estado inválido' });
  if (durationMin !== undefined && durationMin !== null && (typeof durationMin !== 'number' || durationMin <= 0)) {
    return res.status(400).json({ error: 'Duración inválida' });
  }

  const id = await nextSeq('company_meetings');
  const now = new Date().toISOString();
  const doc: MeetingDoc = {
    _id: id,
    company_id: companyId,
    sheet_id: company.sheet_id,
    user_id: req.user.id,
    title: title.trim(),
    kind: validKind(kind) ? kind : 'videollamada',
    status: validStatus(status) ? status : 'agendada',
    scheduled_at: scheduled,
    duration_min: typeof durationMin === 'number' ? durationMin : 60,
    location: typeof location === 'string' && location.trim() ? location.trim() : null,
    attendees: typeof attendees === 'string' && attendees.trim() ? attendees.trim() : null,
    summary: typeof summary === 'string' && summary.trim() ? summary.trim() : null,
    next_steps: typeof nextSteps === 'string' && nextSteps.trim() ? nextSteps.trim() : null,
    created_by: req.user.displayName,
    created_at: now,
    updated_at: now,
  };

  await getReffDb().collection<MeetingDoc>('company_meetings').insertOne(doc);
  res.status(201).json({ meeting: serialize(doc, company) });
});

router.patch('/meetings/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const row = await getUserMeeting(id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Reunión no encontrada' });

  const { title, kind, status, scheduledAt, durationMin, location, attendees, summary, nextSteps, companyId } = req.body || {};
  const $set: Record<string, unknown> = {};

  if (title !== undefined) {
    if (typeof title !== 'string' || !title.trim()) return res.status(400).json({ error: 'Título inválido' });
    $set.title = title.trim();
  }
  if (kind !== undefined) {
    if (!validKind(kind)) return res.status(400).json({ error: 'Tipo de reunión inválido' });
    $set.kind = kind;
  }
  if (status !== undefined) {
    if (!validStatus(status)) return res.status(400).json({ error: 'Estado inválido' });
    $set.status = status;
  }
  if (scheduledAt !== undefined) {
    const parsed = parseDate(scheduledAt);
    if (!parsed) return res.status(400).json({ error: 'Fecha y hora inválidas' });
    $set.scheduled_at = parsed;
    // Cambiar la fecha reabre la ventana del recordatorio 24h para la nueva fecha.
    $set.reminder_sent_at = null;
  }
  if (durationMin !== undefined) {
    if (durationMin !== null && (typeof durationMin !== 'number' || durationMin <= 0)) {
      return res.status(400).json({ error: 'Duración inválida' });
    }
    $set.duration_min = durationMin;
  }
  if (location !== undefined) $set.location = typeof location === 'string' && location.trim() ? location.trim() : null;
  if (attendees !== undefined) $set.attendees = typeof attendees === 'string' && attendees.trim() ? attendees.trim() : null;
  if (summary !== undefined) $set.summary = typeof summary === 'string' && summary.trim() ? summary.trim() : null;
  if (nextSteps !== undefined) $set.next_steps = typeof nextSteps === 'string' && nextSteps.trim() ? nextSteps.trim() : null;

  // Mover la reunión a otra empresa (p. ej. se agendó en la ficha equivocada):
  // arrastra también sheet_id para que el filtro por hoja siga siendo correcto.
  if (companyId !== undefined) {
    const target = await getUserCompany(Number(companyId), req.user.id);
    if (!target) return res.status(400).json({ error: 'Empresa destino no encontrada' });
    $set.company_id = target._id;
    $set.sheet_id = target.sheet_id;
  }

  if (Object.keys($set).length === 0) {
    const company = await getUserCompany(row.company_id, req.user.id);
    return res.json({ meeting: serialize(row, company) });
  }

  // Detecta cancelación y reprogramación ANTES de escribir, para comparar
  // contra el estado/fecha previos (row, ya cargado por getUserMeeting).
  const willCancel = $set.status === 'cancelada' && row.status !== 'cancelada';
  const newScheduledAt = typeof $set.scheduled_at === 'string' ? $set.scheduled_at : null;
  const willReschedule = newScheduledAt !== null && newScheduledAt !== row.scheduled_at && !willCancel
    && (($set.status as MeetingStatus | undefined) ?? row.status) === 'agendada';
  const previousScheduledAt = row.scheduled_at;

  $set.updated_at = new Date().toISOString();
  const db = getReffDb();
  await db.collection<MeetingDoc>('company_meetings').updateOne({ _id: id }, { $set });

  const updated = await db.collection<MeetingDoc>('company_meetings').findOne({ _id: id }) as MeetingDoc;
  const company = await getUserCompany(updated.company_id, req.user.id);
  const serialized = serialize(updated, company);
  res.json({ meeting: serialized });

  // Aviso por correo tras responder: nunca debe retrasar ni tumbar la
  // petición HTTP que agenda/edita la reunión.
  if (willCancel) {
    sendMeetingCancelled(serialized).catch(() => {});
  } else if (willReschedule) {
    sendMeetingRescheduled(serialized, previousScheduledAt).catch(() => {});
  }
});

router.delete('/meetings/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const row = await getUserMeeting(id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Reunión no encontrada' });

  await getReffDb().collection<MeetingDoc>('company_meetings').deleteOne({ _id: id });
  res.json({ ok: true });
});

export default router;
