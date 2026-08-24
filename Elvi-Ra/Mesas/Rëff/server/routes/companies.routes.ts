import express, { Router, Request, Response } from 'express';
import { GridFSBucket, ObjectId } from 'mongodb';
import { getReffDb, nextSeq } from '../mongo.js';
import { authMiddleware } from '../auth.js';

const router = Router();

router.use(authMiddleware);

export const COMPANY_STATUSES = ['estrategico', 'operativo', 'pendiente', 'no_candidato'] as const;
type CompanyStatus = typeof COMPANY_STATUSES[number];

interface TaskDoc {
  id: number;
  title: string;
  done: boolean;
  due_date: string | null;
  created_at: string;
}

interface CompanyDoc {
  _id: number;
  sheet_id: number;
  name: string;
  country: string;
  city: string;
  lat: number;
  lng: number;
  status: CompanyStatus;
  sector: string | null;
  tonnage_year: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  tasks: TaskDoc[];
}

function serializeCompany(doc: CompanyDoc) {
  return {
    id: doc._id,
    sheetId: doc.sheet_id,
    name: doc.name,
    country: doc.country,
    city: doc.city,
    lat: doc.lat,
    lng: doc.lng,
    status: doc.status,
    sector: doc.sector,
    tonnageYear: doc.tonnage_year,
    notes: doc.notes,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
    tasks: (doc.tasks || []).map((t) => ({
      id: t.id,
      title: t.title,
      done: t.done === true,
      dueDate: t.due_date,
      createdAt: t.created_at,
    })),
  };
}

function validateStatus(status: unknown): status is CompanyStatus {
  return typeof status === 'string' && (COMPANY_STATUSES as readonly string[]).includes(status);
}

async function getUserSheet(sheetId: number, userId: string) {
  return getReffDb().collection('sheets').findOne({ _id: sheetId, user_id: userId } as never);
}

// Devuelve la company solo si su hoja pertenece al usuario que pide
async function getUserCompany(companyId: number, userId: string): Promise<CompanyDoc | null> {
  const db = getReffDb();
  const company = await db.collection<CompanyDoc>('companies').findOne({ _id: companyId });
  if (!company) return null;
  const sheet = await db.collection('sheets').findOne({ _id: company.sheet_id, user_id: userId } as never);
  if (!sheet) return null;
  return company;
}

router.get('/sheets/:sheetId/companies', async (req: Request, res: Response) => {
  const sheetId = Number(req.params.sheetId);
  const sheet = await getUserSheet(sheetId, req.user.id);
  if (!sheet) return res.status(404).json({ error: 'Hoja no encontrada' });

  const rows = await getReffDb().collection<CompanyDoc>('companies')
    .find({ sheet_id: sheetId })
    .sort({ _id: 1 })
    .toArray();
  res.json({ companies: rows.map(serializeCompany) });
});

router.post('/sheets/:sheetId/companies', async (req: Request, res: Response) => {
  const sheetId = Number(req.params.sheetId);
  const sheet = await getUserSheet(sheetId, req.user.id);
  if (!sheet) return res.status(404).json({ error: 'Hoja no encontrada' });

  const { name, country, city, lat, lng, status, sector, tonnageYear, notes } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'El nombre de la empresa es obligatorio' });
  }
  if (!country || typeof country !== 'string' || !city || typeof city !== 'string') {
    return res.status(400).json({ error: 'País y ciudad son obligatorios' });
  }
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    return res.status(400).json({ error: 'Coordenadas (lat/lng) inválidas' });
  }
  const finalStatus: CompanyStatus = validateStatus(status) ? status : 'pendiente';

  const id = await nextSeq('companies');
  const now = new Date().toISOString();
  const doc: CompanyDoc = {
    _id: id,
    sheet_id: sheetId,
    name: name.trim(),
    country,
    city,
    lat,
    lng,
    status: finalStatus,
    sector: typeof sector === 'string' ? sector : null,
    tonnage_year: typeof tonnageYear === 'number' ? tonnageYear : null,
    notes: typeof notes === 'string' ? notes : null,
    created_at: now,
    updated_at: now,
    tasks: [],
  };
  await getReffDb().collection<CompanyDoc>('companies').insertOne(doc);
  res.status(201).json({ company: serializeCompany(doc) });
});

router.patch('/companies/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const row = await getUserCompany(id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Empresa no encontrada' });

  const { name, country, city, lat, lng, status, sector, tonnageYear, notes, sheetId } = req.body || {};
  const $set: Record<string, unknown> = {};

  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'Nombre inválido' });
    $set.name = name.trim();
  }
  if (country !== undefined) $set.country = String(country);
  if (city !== undefined) $set.city = String(city);
  if (lat !== undefined) {
    if (typeof lat !== 'number') return res.status(400).json({ error: 'lat inválida' });
    $set.lat = lat;
  }
  if (lng !== undefined) {
    if (typeof lng !== 'number') return res.status(400).json({ error: 'lng inválida' });
    $set.lng = lng;
  }
  if (status !== undefined) {
    if (!validateStatus(status)) return res.status(400).json({ error: 'Estado inválido' });
    $set.status = status;
  }
  if (sector !== undefined) $set.sector = typeof sector === 'string' ? sector : null;
  if (tonnageYear !== undefined) $set.tonnage_year = typeof tonnageYear === 'number' ? tonnageYear : null;
  if (notes !== undefined) $set.notes = typeof notes === 'string' ? notes : null;
  if (sheetId !== undefined) {
    const targetSheet = await getUserSheet(Number(sheetId), req.user.id);
    if (!targetSheet) return res.status(400).json({ error: 'Hoja destino no encontrada' });
    $set.sheet_id = Number(sheetId);
  }

  if (Object.keys($set).length === 0) {
    return res.json({ company: serializeCompany(row) });
  }

  $set.updated_at = new Date().toISOString();
  await getReffDb().collection<CompanyDoc>('companies').updateOne({ _id: id }, { $set });

  const updated = await getReffDb().collection<CompanyDoc>('companies').findOne({ _id: id }) as CompanyDoc;
  res.json({ company: serializeCompany(updated) });
});

router.delete('/companies/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const row = await getUserCompany(id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Empresa no encontrada' });
  // Purga las imágenes GridFS de la empresa antes de borrar el doc
  const files = await getReffDb().collection('company_images.files')
    .find({ 'metadata.company_id': id }).project({ _id: 1 }).toArray();
  for (const f of files) {
    await imagesBucket().delete(f._id as ObjectId).catch(() => {});
  }
  await getReffDb().collection<CompanyDoc>('companies').deleteOne({ _id: id });
  res.json({ ok: true });
});

/* ---------- imágenes y PDFs por empresa (GridFS, bucket company_images) ---------- */

const FILE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const MAX_FILES_PER_COMPANY = 30;

function imagesBucket(): GridFSBucket {
  return new GridFSBucket(getReffDb(), { bucketName: 'company_images' });
}

interface ImageFileDoc {
  _id: ObjectId;
  filename: string;
  length: number;
  uploadDate: Date;
  metadata?: { company_id?: number; uploaded_by?: string; uploaded_at?: string; content_type?: string };
}

function serializeImage(f: ImageFileDoc) {
  return {
    id: f._id.toString(),
    filename: f.filename,
    contentType: f.metadata?.content_type || 'application/octet-stream',
    size: f.length,
    uploadedAt: f.metadata?.uploaded_at || f.uploadDate?.toISOString?.() || null,
  };
}

router.get('/companies/:id/images', async (req: Request, res: Response) => {
  const companyId = Number(req.params.id);
  const company = await getUserCompany(companyId, req.user.id);
  if (!company) return res.status(404).json({ error: 'Empresa no encontrada' });

  const files = await getReffDb().collection<ImageFileDoc>('company_images.files')
    .find({ 'metadata.company_id': companyId })
    .sort({ uploadDate: -1 })
    .toArray();
  res.json({ images: files.map(serializeImage) });
});

// Subida raw: el cliente hace fetch(url, { body: file }) con Content-Type del
// archivo y X-Filename. Sin multipart, sin multer.
router.post(
  '/companies/:id/images',
  express.raw({ type: FILE_TYPES, limit: '16mb' }),
  async (req: Request, res: Response) => {
    const companyId = Number(req.params.id);
    const company = await getUserCompany(companyId, req.user.id);
    if (!company) return res.status(404).json({ error: 'Empresa no encontrada' });

    const contentType = String(req.headers['content-type'] || '');
    if (!FILE_TYPES.includes(contentType)) {
      return res.status(415).json({ error: 'Formato no permitido. Solo JPG, PNG, WebP o PDF.' });
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: 'Archivo vacío o ilegible' });
    }
    const count = await getReffDb().collection('company_images.files')
      .countDocuments({ 'metadata.company_id': companyId });
    if (count >= MAX_FILES_PER_COMPANY) {
      return res.status(400).json({ error: `Máximo ${MAX_FILES_PER_COMPANY} archivos por empresa` });
    }

    let filename = 'archivo';
    try { filename = decodeURIComponent(String(req.headers['x-filename'] || 'archivo')); } catch {}
    filename = filename.slice(0, 180);

    const uploadedAt = new Date().toISOString();
    const upload = imagesBucket().openUploadStream(filename, {
      metadata: { company_id: companyId, uploaded_by: req.user.id, uploaded_at: uploadedAt, content_type: contentType },
    });
    upload.on('error', () => {
      if (!res.headersSent) res.status(500).json({ error: 'Error al guardar la imagen' });
    });
    upload.on('finish', () => {
      res.status(201).json({
        image: {
          id: upload.id.toString(),
          filename,
          contentType,
          size: (req.body as Buffer).length,
          uploadedAt,
        },
      });
    });
    upload.end(req.body as Buffer);
  },
);

router.get('/images/:fileId', async (req: Request, res: Response) => {
  let oid: ObjectId;
  try { oid = new ObjectId(String(req.params.fileId)); } catch { return res.status(400).json({ error: 'Id de imagen inválido' }); }

  const file = await getReffDb().collection<ImageFileDoc>('company_images.files').findOne({ _id: oid });
  if (!file) return res.status(404).json({ error: 'Imagen no encontrada' });
  const owned = await getUserCompany(Number(file.metadata?.company_id), req.user.id);
  if (!owned) return res.status(403).json({ error: 'Acceso denegado' });

  res.setHeader('Content-Type', file.metadata?.content_type || 'application/octet-stream');
  res.setHeader('Content-Length', String(file.length));
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  const stream = imagesBucket().openDownloadStream(oid);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
});

router.delete('/images/:fileId', async (req: Request, res: Response) => {
  let oid: ObjectId;
  try { oid = new ObjectId(String(req.params.fileId)); } catch { return res.status(400).json({ error: 'Id de imagen inválido' }); }

  const file = await getReffDb().collection<ImageFileDoc>('company_images.files').findOne({ _id: oid });
  if (!file) return res.status(404).json({ error: 'Imagen no encontrada' });
  const owned = await getUserCompany(Number(file.metadata?.company_id), req.user.id);
  if (!owned) return res.status(403).json({ error: 'Acceso denegado' });

  await imagesBucket().delete(oid);
  res.json({ ok: true });
});

/* ---------- tasks (embebidas en companies.tasks[]) ---------- */

router.post('/companies/:id/tasks', async (req: Request, res: Response) => {
  const companyId = Number(req.params.id);
  const company = await getUserCompany(companyId, req.user.id);
  if (!company) return res.status(404).json({ error: 'Empresa no encontrada' });

  const { title, dueDate } = req.body || {};
  if (!title || typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ error: 'El título de la tarea es obligatorio' });
  }
  const taskId = await nextSeq('company_tasks');
  const task: TaskDoc = {
    id: taskId,
    title: title.trim(),
    done: false,
    due_date: typeof dueDate === 'string' ? dueDate : null,
    created_at: new Date().toISOString(),
  };
  await getReffDb().collection<CompanyDoc>('companies').updateOne(
    { _id: companyId },
    { $push: { tasks: task } },
  );
  res.status(201).json({ task: { id: task.id, title: task.title, done: task.done, dueDate: task.due_date, createdAt: task.created_at } });
});

router.patch('/tasks/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const db = getReffDb();
  const company = await db.collection<CompanyDoc>('companies').findOne({ 'tasks.id': id } as never);
  if (!company) return res.status(404).json({ error: 'Tarea no encontrada' });

  // Verifica que la company de la tarea pertenece al usuario que pide
  const owned = await getUserCompany(company._id, req.user.id);
  if (!owned) return res.status(403).json({ error: 'Acceso denegado' });

  const { title, done, dueDate } = req.body || {};
  const $set: Record<string, unknown> = {};
  if (title !== undefined) {
    if (typeof title !== 'string' || !title.trim()) return res.status(400).json({ error: 'Título inválido' });
    $set['tasks.$.title'] = title.trim();
  }
  if (done !== undefined) $set['tasks.$.done'] = Boolean(done);
  if (dueDate !== undefined) $set['tasks.$.due_date'] = typeof dueDate === 'string' ? dueDate : null;

  if (Object.keys($set).length > 0) {
    await db.collection<CompanyDoc>('companies').updateOne({ _id: company._id, 'tasks.id': id } as never, { $set });
  }
  const updatedCompany = await db.collection<CompanyDoc>('companies').findOne({ _id: company._id }) as CompanyDoc;
  const updatedTask = updatedCompany.tasks.find((t) => t.id === id) as TaskDoc;
  res.json({ task: { id: updatedTask.id, title: updatedTask.title, done: updatedTask.done, dueDate: updatedTask.due_date, createdAt: updatedTask.created_at } });
});

router.delete('/tasks/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const db = getReffDb();
  const company = await db.collection<CompanyDoc>('companies').findOne({ 'tasks.id': id } as never);
  if (!company) return res.status(404).json({ error: 'Tarea no encontrada' });

  const owned = await getUserCompany(company._id, req.user.id);
  if (!owned) return res.status(403).json({ error: 'Acceso denegado' });

  await db.collection<CompanyDoc>('companies').updateOne(
    { _id: company._id },
    { $pull: { tasks: { id } } } as never,
  );
  res.json({ ok: true });
});

export default router;
