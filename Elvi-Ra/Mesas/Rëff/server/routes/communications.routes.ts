import express, { Router, Request, Response } from 'express';
import { GridFSBucket, ObjectId } from 'mongodb';
import { getReffDb, nextSeq } from '../mongo.js';
import { authMiddleware } from '../auth.js';

const router = Router();

router.use(authMiddleware);

export const COMM_CHANNELS = ['email', 'llamada', 'whatsapp', 'reunion', 'carta', 'otro'] as const;
export const COMM_DIRECTIONS = ['saliente', 'entrante'] as const;

type CommChannel = typeof COMM_CHANNELS[number];
type CommDirection = typeof COMM_DIRECTIONS[number];

// Registro de una comunicación con una empresa (email enviado, llamada, wasap...).
// Independiente de company_meetings: una reunión es un evento agendado con acta;
// una comunicación es la prueba/constancia de un contacto puntual (con o sin
// adjunto). occurred_at es cuándo pasó de verdad, created_at cuándo se registró
// en el sistema — pueden no coincidir si se documenta a posteriori.
interface CommDoc {
  _id: number;
  company_id: number;
  sheet_id: number;
  channel: CommChannel;
  direction: CommDirection;
  subject: string;
  notes: string | null;
  occurred_at: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface CompanyRef {
  _id: number;
  sheet_id: number;
  name: string;
  city: string;
  country: string;
}

export interface Communication {
  id: number;
  companyId: number;
  companyName: string | null;
  companyCity: string | null;
  companyCountry: string | null;
  sheetId: number;
  channel: CommChannel;
  direction: CommDirection;
  subject: string;
  notes: string | null;
  occurredAt: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  attachmentCount: number;
}

function serialize(doc: CommDoc, company: CompanyRef | null | undefined, attachmentCount: number): Communication {
  return {
    id: doc._id,
    companyId: doc.company_id,
    companyName: company?.name ?? null,
    companyCity: company?.city ?? null,
    companyCountry: company?.country ?? null,
    sheetId: doc.sheet_id,
    channel: doc.channel,
    direction: doc.direction,
    subject: doc.subject,
    notes: doc.notes,
    occurredAt: doc.occurred_at,
    createdBy: doc.created_by,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
    attachmentCount,
  };
}

function validChannel(v: unknown): v is CommChannel {
  return typeof v === 'string' && (COMM_CHANNELS as readonly string[]).includes(v);
}

function validDirection(v: unknown): v is CommDirection {
  return typeof v === 'string' && (COMM_DIRECTIONS as readonly string[]).includes(v);
}

function parseDate(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

// Misma regla de propiedad que companies.routes.ts / meetings.routes.ts: la
// empresa es del usuario solo si su hoja lo es.
async function getUserCompany(companyId: number, userId: string): Promise<CompanyRef | null> {
  const db = getReffDb();
  const company = await db.collection<CompanyRef>('companies').findOne({ _id: companyId });
  if (!company) return null;
  const sheet = await db.collection('sheets').findOne({ _id: company.sheet_id, user_id: userId } as never);
  if (!sheet) return null;
  return company;
}

async function getUserComm(commId: number, userId: string): Promise<CommDoc | null> {
  const comm = await getReffDb().collection<CommDoc>('company_communications').findOne({ _id: commId });
  if (!comm) return null;
  const owned = await getUserCompany(comm.company_id, userId);
  if (!owned) return null;
  return comm;
}

// Resuelve nombres de empresa y conteo de adjuntos en bloque para no hacer N+1.
async function attachExtras(rows: CommDoc[]): Promise<Communication[]> {
  if (rows.length === 0) return [];
  const db = getReffDb();
  const companyIds = [...new Set(rows.map((r) => r.company_id))];
  const commIds = rows.map((r) => r._id);
  const [companies, counts] = await Promise.all([
    db.collection<CompanyRef>('companies').find({ _id: { $in: companyIds } } as never).toArray(),
    db.collection('company_comm_files.files').aggregate([
      { $match: { 'metadata.comm_id': { $in: commIds } } },
      { $group: { _id: '$metadata.comm_id', n: { $sum: 1 } } },
    ]).toArray(),
  ]);
  const byCompany = new Map(companies.map((c) => [c._id, c]));
  const byCount = new Map(counts.map((c: any) => [c._id, c.n as number]));
  return rows.map((r) => serialize(r, byCompany.get(r.company_id), byCount.get(r._id) ?? 0));
}

/* ---------- listado, búsqueda y dashboard ---------- */

// Feed general con búsqueda de texto (asunto/notas), filtros por empresa,
// hoja, canal, dirección y rango de fechas; orden configurable.
router.get('/communications', async (req: Request, res: Response) => {
  const { q, sheetId, companyId, channel, direction, from, to, sort, limit } = req.query;

  const db = getReffDb();
  const sheets = await db.collection('sheets').find({ user_id: req.user.id } as never).project({ _id: 1 }).toArray();
  const sheetIds = sheets.map((s) => s._id as number);
  if (sheetIds.length === 0) return res.json({ communications: [] });

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
  if (typeof channel === 'string' && channel) {
    if (!validChannel(channel)) return res.status(400).json({ error: 'Canal inválido' });
    filter.channel = channel;
  }
  if (typeof direction === 'string' && direction) {
    if (!validDirection(direction)) return res.status(400).json({ error: 'Dirección inválida' });
    filter.direction = direction;
  }

  const range: Record<string, string> = {};
  const fromIso = parseDate(from);
  const toIso = parseDate(to);
  if (fromIso) range.$gte = fromIso;
  if (toIso) range.$lte = toIso;
  if (Object.keys(range).length > 0) filter.occurred_at = range;

  if (typeof q === 'string' && q.trim()) {
    const rx = new RegExp(q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ subject: rx }, { notes: rx }];
  }

  const sortDir = sort === 'oldest' ? 1 : -1; // newest (default) o oldest
  const cap = Math.min(Math.max(Number(limit) || 200, 1), 500);

  const rows = await db.collection<CommDoc>('company_communications')
    .find(filter as never)
    .sort({ occurred_at: sortDir })
    .limit(cap)
    .toArray();

  res.json({ communications: await attachExtras(rows) });
});

// KPIs del dashboard: total, últimos 30 días, sin adjunto, empresas con contacto.
router.get('/communications/summary', async (req: Request, res: Response) => {
  const db = getReffDb();
  const sheets = await db.collection('sheets').find({ user_id: req.user.id } as never).project({ _id: 1 }).toArray();
  const sheetIds = sheets.map((s) => s._id as number);
  if (sheetIds.length === 0) {
    return res.json({ total: 0, last30Days: 0, withoutAttachment: 0, companiesContacted: 0 });
  }

  const col = db.collection<CommDoc>('company_communications');
  const base = { sheet_id: { $in: sheetIds } };
  const since30Iso = new Date(Date.now() - 30 * 86400_000).toISOString();

  const [total, last30Days, rows, distinctCompanies] = await Promise.all([
    col.countDocuments(base as never),
    col.countDocuments({ ...base, occurred_at: { $gte: since30Iso } } as never),
    col.find(base as never).project({ _id: 1 }).toArray(),
    col.distinct('company_id', base as never),
  ]);

  const commIds = rows.map((r) => r._id as number);
  const withAttachment = commIds.length > 0
    ? await db.collection('company_comm_files.files').distinct('metadata.comm_id', { 'metadata.comm_id': { $in: commIds } } as never)
    : [];

  res.json({
    total,
    last30Days,
    withoutAttachment: total - withAttachment.length,
    companiesContacted: distinctCompanies.length,
  });
});

// Historial de comunicaciones de una empresa concreta (ficha del CRM), más
// reciente primero.
router.get('/companies/:id/communications', async (req: Request, res: Response) => {
  const companyId = Number(req.params.id);
  const company = await getUserCompany(companyId, req.user.id);
  if (!company) return res.status(404).json({ error: 'Empresa no encontrada' });

  const rows = await getReffDb().collection<CommDoc>('company_communications')
    .find({ company_id: companyId })
    .sort({ occurred_at: -1 })
    .toArray();
  res.json({ communications: await attachExtras(rows) });
});

/* ---------- alta, edición y borrado ---------- */

router.post('/companies/:id/communications', async (req: Request, res: Response) => {
  const companyId = Number(req.params.id);
  const company = await getUserCompany(companyId, req.user.id);
  if (!company) return res.status(404).json({ error: 'Empresa no encontrada' });

  const { channel, direction, subject, notes, occurredAt } = req.body || {};

  if (!subject || typeof subject !== 'string' || !subject.trim()) {
    return res.status(400).json({ error: 'El asunto de la comunicación es obligatorio' });
  }
  if (!validChannel(channel)) return res.status(400).json({ error: 'Canal inválido' });
  if (!validDirection(direction)) return res.status(400).json({ error: 'Dirección inválida' });
  const occurred = occurredAt !== undefined ? parseDate(occurredAt) : new Date().toISOString();
  if (!occurred) return res.status(400).json({ error: 'Fecha inválida' });

  const id = await nextSeq('company_communications');
  const now = new Date().toISOString();
  const doc: CommDoc = {
    _id: id,
    company_id: companyId,
    sheet_id: company.sheet_id,
    channel,
    direction,
    subject: subject.trim(),
    notes: typeof notes === 'string' && notes.trim() ? notes.trim() : null,
    occurred_at: occurred,
    created_by: req.user.displayName,
    created_at: now,
    updated_at: now,
  };

  await getReffDb().collection<CommDoc>('company_communications').insertOne(doc);
  res.status(201).json({ communication: serialize(doc, company, 0) });
});

router.patch('/communications/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const row = await getUserComm(id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Comunicación no encontrada' });

  const { channel, direction, subject, notes, occurredAt } = req.body || {};
  const $set: Record<string, unknown> = {};

  if (channel !== undefined) {
    if (!validChannel(channel)) return res.status(400).json({ error: 'Canal inválido' });
    $set.channel = channel;
  }
  if (direction !== undefined) {
    if (!validDirection(direction)) return res.status(400).json({ error: 'Dirección inválida' });
    $set.direction = direction;
  }
  if (subject !== undefined) {
    if (typeof subject !== 'string' || !subject.trim()) return res.status(400).json({ error: 'Asunto inválido' });
    $set.subject = subject.trim();
  }
  if (notes !== undefined) $set.notes = typeof notes === 'string' && notes.trim() ? notes.trim() : null;
  if (occurredAt !== undefined) {
    const parsed = parseDate(occurredAt);
    if (!parsed) return res.status(400).json({ error: 'Fecha inválida' });
    $set.occurred_at = parsed;
  }

  if (Object.keys($set).length === 0) {
    const company = await getUserCompany(row.company_id, req.user.id);
    const count = await getReffDb().collection('company_comm_files.files').countDocuments({ 'metadata.comm_id': id } as never);
    return res.json({ communication: serialize(row, company, count) });
  }

  $set.updated_at = new Date().toISOString();
  const db = getReffDb();
  await db.collection<CommDoc>('company_communications').updateOne({ _id: id }, { $set });

  const updated = await db.collection<CommDoc>('company_communications').findOne({ _id: id }) as CommDoc;
  const company = await getUserCompany(updated.company_id, req.user.id);
  const count = await db.collection('company_comm_files.files').countDocuments({ 'metadata.comm_id': id } as never);
  res.json({ communication: serialize(updated, company, count) });
});

router.delete('/communications/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const row = await getUserComm(id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Comunicación no encontrada' });

  // Purga los adjuntos GridFS antes de borrar el doc.
  const files = await getReffDb().collection('company_comm_files.files')
    .find({ 'metadata.comm_id': id } as never).project({ _id: 1 }).toArray();
  for (const f of files) {
    await attachmentsBucket().delete(f._id as ObjectId).catch(() => {});
  }
  await getReffDb().collection<CommDoc>('company_communications').deleteOne({ _id: id });
  res.json({ ok: true });
});

/* ---------- adjuntos (GridFS, bucket company_comm_files) ---------- */

const FILE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const MAX_FILE_SIZE = '16mb';
const MAX_FILES_PER_COMM = 20;

function attachmentsBucket(): GridFSBucket {
  return new GridFSBucket(getReffDb(), { bucketName: 'company_comm_files' });
}

interface AttachmentFileDoc {
  _id: ObjectId;
  filename: string;
  length: number;
  uploadDate: Date;
  metadata?: { comm_id?: number; company_id?: number; uploaded_by?: string; uploaded_at?: string; content_type?: string };
}

function serializeAttachment(f: AttachmentFileDoc) {
  return {
    id: f._id.toString(),
    filename: f.filename,
    contentType: f.metadata?.content_type || 'application/octet-stream',
    size: f.length,
    uploadedAt: f.metadata?.uploaded_at || f.uploadDate?.toISOString?.() || null,
  };
}

router.get('/communications/:id/attachments', async (req: Request, res: Response) => {
  const commId = Number(req.params.id);
  const comm = await getUserComm(commId, req.user.id);
  if (!comm) return res.status(404).json({ error: 'Comunicación no encontrada' });

  const files = await getReffDb().collection<AttachmentFileDoc>('company_comm_files.files')
    .find({ 'metadata.comm_id': commId } as never)
    .sort({ uploadDate: -1 })
    .toArray();
  res.json({ attachments: files.map(serializeAttachment) });
});

// Subida raw: mismo patrón que companies.routes.ts (Content-Type del archivo + X-Filename).
router.post(
  '/communications/:id/attachments',
  express.raw({ type: FILE_TYPES, limit: MAX_FILE_SIZE }),
  async (req: Request, res: Response) => {
    const commId = Number(req.params.id);
    const comm = await getUserComm(commId, req.user.id);
    if (!comm) return res.status(404).json({ error: 'Comunicación no encontrada' });

    const contentType = String(req.headers['content-type'] || '');
    if (!FILE_TYPES.includes(contentType)) {
      return res.status(415).json({ error: 'Formato no permitido. Solo JPG, PNG, WebP o PDF.' });
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: 'Archivo vacío o ilegible' });
    }
    const count = await getReffDb().collection('company_comm_files.files')
      .countDocuments({ 'metadata.comm_id': commId } as never);
    if (count >= MAX_FILES_PER_COMM) {
      return res.status(400).json({ error: `Máximo ${MAX_FILES_PER_COMM} adjuntos por comunicación` });
    }

    let filename = 'archivo';
    try { filename = decodeURIComponent(String(req.headers['x-filename'] || 'archivo')); } catch {}
    filename = filename.slice(0, 180);

    const uploadedAt = new Date().toISOString();
    const upload = attachmentsBucket().openUploadStream(filename, {
      metadata: {
        comm_id: commId,
        company_id: comm.company_id,
        uploaded_by: req.user.id,
        uploaded_at: uploadedAt,
        content_type: contentType,
      },
    });
    upload.on('error', () => {
      if (!res.headersSent) res.status(500).json({ error: 'Error al guardar el adjunto' });
    });
    upload.on('finish', () => {
      res.status(201).json({
        attachment: { id: upload.id.toString(), filename, contentType, size: (req.body as Buffer).length, uploadedAt },
      });
    });
    upload.end(req.body as Buffer);
  },
);

router.get('/communications/attachments/:fileId', async (req: Request, res: Response) => {
  let oid: ObjectId;
  try { oid = new ObjectId(String(req.params.fileId)); } catch { return res.status(400).json({ error: 'Id de adjunto inválido' }); }

  const file = await getReffDb().collection<AttachmentFileDoc>('company_comm_files.files').findOne({ _id: oid });
  if (!file) return res.status(404).json({ error: 'Adjunto no encontrado' });
  const owned = await getUserCompany(Number(file.metadata?.company_id), req.user.id);
  if (!owned) return res.status(403).json({ error: 'Acceso denegado' });

  res.setHeader('Content-Type', file.metadata?.content_type || 'application/octet-stream');
  res.setHeader('Content-Length', String(file.length));
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  const stream = attachmentsBucket().openDownloadStream(oid);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
});

router.delete('/communications/attachments/:fileId', async (req: Request, res: Response) => {
  let oid: ObjectId;
  try { oid = new ObjectId(String(req.params.fileId)); } catch { return res.status(400).json({ error: 'Id de adjunto inválido' }); }

  const file = await getReffDb().collection<AttachmentFileDoc>('company_comm_files.files').findOne({ _id: oid });
  if (!file) return res.status(404).json({ error: 'Adjunto no encontrado' });
  const owned = await getUserCompany(Number(file.metadata?.company_id), req.user.id);
  if (!owned) return res.status(403).json({ error: 'Acceso denegado' });

  await attachmentsBucket().delete(oid);
  res.json({ ok: true });
});

export default router;
