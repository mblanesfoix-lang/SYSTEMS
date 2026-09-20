import { getReffDb } from './mongo.js';
import { sendMeetingReminder } from './meeting-mailer.js';
import type { Meeting } from './routes/meetings.routes.js';

// Recordatorio 24h antes de cada reunión agendada. Corre cada 15 min y avisa
// de las reuniones que caen dentro de la ventana [ahora+23h, ahora+25h) — el
// margen de 2h evita que una reunión "se escape" del recordatorio si el cron
// se retrasa o el proceso reinicia justo en el instante exacto de -24h.
const CRON_SCHEDULE = process.env.MEETING_REMINDER_CRON || '*/15 * * * *';
const WINDOW_START_H = 23;
const WINDOW_END_H = 25;

interface MeetingDocLite {
  _id: number;
  company_id: number;
  sheet_id: number;
  title: string;
  kind: string;
  status: string;
  scheduled_at: string;
  duration_min: number | null;
  location: string | null;
  attendees: string | null;
  summary: string | null;
  next_steps: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  reminder_sent_at?: string | null;
}

interface CompanyRef {
  _id: number;
  name: string;
  city: string;
  country: string;
}

function toMeeting(doc: MeetingDocLite, company?: CompanyRef | null): Meeting {
  return {
    id: doc._id,
    companyId: doc.company_id,
    companyName: company?.name ?? null,
    companyCity: company?.city ?? null,
    companyCountry: company?.country ?? null,
    sheetId: doc.sheet_id,
    title: doc.title,
    kind: doc.kind as Meeting['kind'],
    status: doc.status as Meeting['status'],
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

export async function runMeetingReminderCycle(): Promise<void> {
  const db = getReffDb();
  const now = Date.now();
  const from = new Date(now + WINDOW_START_H * 3600_000).toISOString();
  const to = new Date(now + WINDOW_END_H * 3600_000).toISOString();

  const col = db.collection<MeetingDocLite>('company_meetings');
  const due = await col.find({
    status: 'agendada',
    scheduled_at: { $gte: from, $lt: to },
    $or: [{ reminder_sent_at: null }, { reminder_sent_at: { $exists: false } }],
  } as never).toArray();

  if (due.length === 0) return;

  const companyIds = [...new Set(due.map((m) => m.company_id))];
  const companies = await db.collection<CompanyRef>('companies')
    .find({ _id: { $in: companyIds } } as never)
    .toArray();
  const byId = new Map(companies.map((c) => [c._id, c]));

  for (const doc of due) {
    const meeting = toMeeting(doc, byId.get(doc.company_id));
    try {
      await sendMeetingReminder(meeting);
      await col.updateOne({ _id: doc._id }, { $set: { reminder_sent_at: new Date().toISOString() } });
    } catch (err) {
      console.error(`[Rëff][meetings] Recordatorio fallido para reunión #${doc._id}:`, (err as Error).message);
    }
  }
}

let cronStarted = false;

export function startMeetingReminderCron(): void {
  if (cronStarted) return;
  cronStarted = true;

  import('node-cron').then(({ default: cron }) => {
    cron.schedule(CRON_SCHEDULE, () => {
      runMeetingReminderCycle().catch((err) => console.error('[Rëff][meetings] Ciclo de recordatorio falló:', err));
    });
    console.log(`[Rëff][meetings] Recordatorio 24h activo (${CRON_SCHEDULE})`);
  }).catch((err) => {
    console.error('[Rëff][meetings] No se pudo cargar node-cron:', err.message);
  });
}
