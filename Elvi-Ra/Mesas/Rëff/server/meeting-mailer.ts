import nodemailer, { type Transporter } from 'nodemailer';
import type { Meeting } from './routes/meetings.routes.js';

// Destinatarios fijos de los avisos de reuniones (recordatorio 24h + cancelación/
// reprogramación). Lista pedida directamente por el usuario, no configurable por
// UI hoy — mover a colección/env si hace falta que cambie sin tocar código.
export const MEETING_NOTIFY_RECIPIENTS = [
  'mblanes@s-nficorp.com',
  'gonzalosb@s-nficorp.com',
  'nzaroual@s-nfi.com',
];

// Sin SMTP_HOST configurado, el mailer queda en modo simulado: registra en
// consola qué se habría enviado y no falla la petición HTTP que lo dispara
// (agendar/cancelar una reunión no debe romperse porque el correo no esté
// configurado todavía).
const SMTP_HOST = (process.env.SMTP_HOST || '').trim();
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = process.env.SMTP_SECURE === 'true';
const SMTP_USER = (process.env.SMTP_USER || '').trim();
const SMTP_PASS = (process.env.SMTP_PASS || '').trim();
const MAIL_FROM = (process.env.MAIL_FROM || SMTP_USER || 'reff@s-nficorp.com').trim();

let transporter: Transporter | null = null;
let transporterInitialized = false;

function getTransporter(): Transporter | null {
  if (transporterInitialized) return transporter;
  transporterInitialized = true;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    console.warn('[Rëff][mail] SMTP no configurado (SMTP_HOST/SMTP_USER/SMTP_PASS) — avisos de reunión en modo simulado');
    return null;
  }
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  return transporter;
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString('es-ES', {
    weekday: 'long', day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

interface MailContent {
  subject: string;
  text: string;
}

function reminderContent(meeting: Meeting): MailContent {
  const company = meeting.companyName || `empresa #${meeting.companyId}`;
  return {
    subject: `Recordatorio: reunión con ${company} mañana`,
    text: [
      `Recordatorio de reunión agendada para mañana.`,
      ``,
      `Empresa: ${company}`,
      `Motivo: ${meeting.title}`,
      `Fecha y hora: ${formatWhen(meeting.scheduledAt)}`,
      meeting.durationMin ? `Duración estimada: ${meeting.durationMin} min` : null,
      meeting.location ? `Lugar / enlace: ${meeting.location}` : null,
      meeting.attendees ? `Asistentes: ${meeting.attendees}` : null,
      ``,
      `Registrado en Rëff por ${meeting.createdBy}.`,
    ].filter(Boolean).join('\n'),
  };
}

function cancelledContent(meeting: Meeting): MailContent {
  const company = meeting.companyName || `empresa #${meeting.companyId}`;
  return {
    subject: `Cancelada: reunión con ${company}`,
    text: [
      `Se ha cancelado una reunión agendada.`,
      ``,
      `Empresa: ${company}`,
      `Motivo: ${meeting.title}`,
      `Estaba prevista para: ${formatWhen(meeting.scheduledAt)}`,
      ``,
      `Registrado en Rëff.`,
    ].join('\n'),
  };
}

function rescheduledContent(meeting: Meeting, previousIso: string): MailContent {
  const company = meeting.companyName || `empresa #${meeting.companyId}`;
  return {
    subject: `Reprogramada: reunión con ${company}`,
    text: [
      `Se ha cambiado la fecha de una reunión agendada.`,
      ``,
      `Empresa: ${company}`,
      `Motivo: ${meeting.title}`,
      `Antes: ${formatWhen(previousIso)}`,
      `Ahora: ${formatWhen(meeting.scheduledAt)}`,
      meeting.location ? `Lugar / enlace: ${meeting.location}` : null,
      ``,
      `Registrado en Rëff.`,
    ].filter(Boolean).join('\n'),
  };
}

async function dispatch(content: MailContent): Promise<void> {
  const t = getTransporter();
  if (!t) {
    console.log(`[Rëff][mail] (simulado) "${content.subject}" -> ${MEETING_NOTIFY_RECIPIENTS.join(', ')}`);
    return;
  }
  try {
    await t.sendMail({
      from: MAIL_FROM,
      to: MEETING_NOTIFY_RECIPIENTS,
      subject: content.subject,
      text: content.text,
    });
  } catch (err) {
    // El envío nunca debe tumbar la petición que lo dispara (agendar/cancelar
    // sigue siendo válido aunque el correo falle) — solo se registra el fallo.
    console.error('[Rëff][mail] Error enviando aviso de reunión:', (err as Error).message);
  }
}

export function sendMeetingReminder(meeting: Meeting): Promise<void> {
  return dispatch(reminderContent(meeting));
}

export function sendMeetingCancelled(meeting: Meeting): Promise<void> {
  return dispatch(cancelledContent(meeting));
}

export function sendMeetingRescheduled(meeting: Meeting, previousScheduledAt: string): Promise<void> {
  return dispatch(rescheduledContent(meeting, previousScheduledAt));
}
