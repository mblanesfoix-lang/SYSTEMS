/**
 * S-NFI Finance — CRM de empresas + archivo documental (2026-09-13)
 *
 * Apartado nuevo de la mesa Finance: fichas de empresa (clientes, proveedores,
 * participadas, inversores) con informes y documentacion adjunta ordenada por
 * carpeta, notas de seguimiento y enlace opcional a centros de coste.
 *
 * Modulo separado de finance.js a proposito: finance.js ya son ~900 lineas de
 * aritmetica en centimos + PDF, y este bloque es CRUD + GridFS sin tocar dinero.
 * Comparte guard (requireMesa('finance')) y log inmutable (finance_log), asi que
 * la mesa sigue siendo una sola desde fuera.
 *
 * Colecciones:
 *   finance_companies        ficha de empresa
 *   finance_company_notes    bitacora de seguimiento por empresa
 *   finance_company_docs.*   GridFS (informes, PDFs, hojas, imagenes)
 *
 * Patron de subida: raw sin multer (Content-Type del archivo + cabeceras
 * X-Filename / X-Folder), identico a herzog.js y company_images de Reff.
 */

import crypto from 'node:crypto';
import express from 'express';
import { GridFSBucket, ObjectId } from 'mongodb';

const DOCUMENT_TYPES = [
  'application/pdf',
  'image/jpeg', 'image/png', 'image/webp',
  'text/csv', 'text/plain',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

const MAX_UPLOAD_MB = 24;
const MAX_DOCS_PER_COMPANY = 200;

// Carpetas fijas: el usuario ordena la documentacion sin inventarse taxonomias
// divergentes por empresa. Ampliar aqui si el jefe pide mas categorias.
export const COMPANY_FOLDERS = ['informes', 'contratos', 'facturas', 'fiscal', 'tecnico', 'otros'];

const RELATIONS = ['cliente', 'proveedor', 'participada', 'inversor', 'otro'];
const STATUSES = ['activa', 'prospecto', 'pausada', 'cerrada'];

function withId(doc) {
  if (!doc) return doc;
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
}

function canonical(entry) {
  return JSON.stringify(entry, Object.keys(entry).sort());
}

async function appendFinanceLog(mongo, entry) {
  const col = mongo.collection('finance_log');
  const tail = await col.find().sort({ seq: -1 }).limit(1).next();
  const seq = tail ? tail.seq + 1 : 1;
  const prevHash = tail ? tail.hash : '0'.repeat(64);
  const hash = crypto.createHash('sha256').update(prevHash + canonical({ ...entry, seq })).digest('hex');
  const doc = { _id: crypto.randomUUID(), ...entry, seq, prevHash, hash, createdAt: new Date().toISOString() };
  await col.insertOne(doc);
  return doc;
}

function docsBucket(mongo) {
  return new GridFSBucket(mongo, { bucketName: 'finance_company_docs' });
}

function serializeDoc(f) {
  return {
    id: f._id.toString(),
    companyId: f.metadata?.company_id || null,
    filename: f.filename,
    contentType: f.metadata?.content_type || 'application/octet-stream',
    folder: f.metadata?.folder || 'otros',
    label: f.metadata?.label || null,
    size: f.length,
    uploadedBy: f.metadata?.uploaded_by || null,
    uploadedAt: f.metadata?.uploaded_at || (f.uploadDate ? new Date(f.uploadDate).toISOString() : null),
  };
}

function str(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export function mountFinanceCompanies(app, { auth, requireMesa, mongo }) {
  const router = app;
  const guard = [auth, requireMesa('finance')];

  async function findCompany(id) {
    return mongo.collection('finance_companies').findOne({ _id: String(id) });
  }

  async function docCountFor(companyId) {
    return mongo.collection('finance_company_docs.files').countDocuments({ 'metadata.company_id': companyId });
  }

  /* ---- catalogo estatico para poblar los selects del frontend ---- */

  router.get('/api/finance/companies/meta', ...guard, (req, res) => {
    res.json({ folders: COMPANY_FOLDERS, relations: RELATIONS, statuses: STATUSES, maxUploadMb: MAX_UPLOAD_MB });
  });

  /* ---- empresas ---- */

  router.get('/api/finance/companies', ...guard, async (req, res) => {
    const q = {};
    if (req.query.relation) q.relation = String(req.query.relation);
    if (req.query.status) q.status = String(req.query.status);
    const rows = await mongo.collection('finance_companies').find(q).sort({ name: 1 }).toArray();

    // Conteo de documentos y notas en bloque: evita N+1 al pintar la tabla.
    const ids = rows.map((r) => r._id);
    const [docAgg, noteAgg] = await Promise.all([
      mongo.collection('finance_company_docs.files').aggregate([
        { $match: { 'metadata.company_id': { $in: ids } } },
        { $group: { _id: '$metadata.company_id', n: { $sum: 1 } } },
      ]).toArray(),
      mongo.collection('finance_company_notes').aggregate([
        { $match: { companyId: { $in: ids } } },
        { $group: { _id: '$companyId', n: { $sum: 1 } } },
      ]).toArray(),
    ]);
    const docsBy = new Map(docAgg.map((d) => [d._id, d.n]));
    const notesBy = new Map(noteAgg.map((d) => [d._id, d.n]));

    res.json(rows.map((r) => ({ ...withId(r), documentsCount: docsBy.get(r._id) || 0, notesCount: notesBy.get(r._id) || 0 })));
  });

  router.get('/api/finance/companies/:id', ...guard, async (req, res) => {
    const row = await findCompany(req.params.id);
    if (!row) return res.status(404).json({ error: 'empresa no encontrada' });
    const [documents, notes] = await Promise.all([
      mongo.collection('finance_company_docs.files')
        .find({ 'metadata.company_id': row._id }).sort({ uploadDate: -1 }).toArray(),
      mongo.collection('finance_company_notes')
        .find({ companyId: row._id }).sort({ createdAt: -1 }).limit(200).toArray(),
    ]);
    res.json({ ...withId(row), documents: documents.map(serializeDoc), notes: notes.map(withId) });
  });

  router.post('/api/finance/companies', ...guard, async (req, res) => {
    const b = req.body || {};
    const name = str(b.name, 180);
    if (!name) return res.status(400).json({ error: 'name requerido' });
    const relation = RELATIONS.includes(b.relation) ? b.relation : 'cliente';
    const status = STATUSES.includes(b.status) ? b.status : 'activa';
    const doc = {
      _id: crypto.randomUUID(),
      name,
      relation,
      status,
      taxId: str(b.taxId, 40) || null,
      sector: str(b.sector, 80) || null,
      country: str(b.country, 2).toUpperCase() || null,
      contactName: str(b.contactName, 120) || null,
      contactEmail: str(b.contactEmail, 160) || null,
      contactPhone: str(b.contactPhone, 40) || null,
      costCenterId: str(b.costCenterId, 64) || null,
      notes: str(b.notes, 2000) || null,
      createdBy: req.user,
      createdAt: new Date().toISOString(),
      updatedAt: null,
    };
    await mongo.collection('finance_companies').insertOne(doc);
    await appendFinanceLog(mongo, { action: 'company.create', actorId: req.user, detail: { companyId: doc._id, name, relation } });
    res.status(201).json({ ...withId(doc), documentsCount: 0, notesCount: 0 });
  });

  router.patch('/api/finance/companies/:id', ...guard, async (req, res) => {
    const row = await findCompany(req.params.id);
    if (!row) return res.status(404).json({ error: 'empresa no encontrada' });
    const b = req.body || {};
    const patch = {};
    if (b.name !== undefined) {
      const name = str(b.name, 180);
      if (!name) return res.status(400).json({ error: 'name no puede quedar vacio' });
      patch.name = name;
    }
    if (b.relation !== undefined) {
      if (!RELATIONS.includes(b.relation)) return res.status(400).json({ error: `relation debe ser: ${RELATIONS.join(', ')}` });
      patch.relation = b.relation;
    }
    if (b.status !== undefined) {
      if (!STATUSES.includes(b.status)) return res.status(400).json({ error: `status debe ser: ${STATUSES.join(', ')}` });
      patch.status = b.status;
    }
    for (const [field, max] of [['taxId', 40], ['sector', 80], ['contactName', 120], ['contactEmail', 160], ['contactPhone', 40], ['costCenterId', 64], ['notes', 2000]]) {
      if (b[field] !== undefined) patch[field] = str(b[field], max) || null;
    }
    if (b.country !== undefined) patch.country = str(b.country, 2).toUpperCase() || null;
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'nada que actualizar' });
    patch.updatedAt = new Date().toISOString();
    await mongo.collection('finance_companies').updateOne({ _id: row._id }, { $set: patch });
    await appendFinanceLog(mongo, { action: 'company.update', actorId: req.user, detail: { companyId: row._id, fields: Object.keys(patch) } });
    res.json(withId({ ...row, ...patch }));
  });

  router.delete('/api/finance/companies/:id', ...guard, async (req, res) => {
    const row = await findCompany(req.params.id);
    if (!row) return res.status(404).json({ error: 'empresa no encontrada' });
    // Borrado en cascada: sin esto los ficheros GridFS quedarian huerfanos.
    const files = await mongo.collection('finance_company_docs.files').find({ 'metadata.company_id': row._id }).toArray();
    const bucket = docsBucket(mongo);
    for (const f of files) {
      try { await bucket.delete(f._id); } catch {}
    }
    await mongo.collection('finance_company_notes').deleteMany({ companyId: row._id });
    await mongo.collection('finance_companies').deleteOne({ _id: row._id });
    await appendFinanceLog(mongo, { action: 'company.delete', actorId: req.user, detail: { companyId: row._id, name: row.name, documentsDeleted: files.length } });
    res.json({ id: row._id });
  });

  /* ---- documentos por empresa (GridFS, upload raw sin multer) ---- */

  router.get('/api/finance/companies/:id/documents', ...guard, async (req, res) => {
    const row = await findCompany(req.params.id);
    if (!row) return res.status(404).json({ error: 'empresa no encontrada' });
    const q = { 'metadata.company_id': row._id };
    if (req.query.folder) q['metadata.folder'] = String(req.query.folder);
    const files = await mongo.collection('finance_company_docs.files').find(q).sort({ uploadDate: -1 }).toArray();
    res.json(files.map(serializeDoc));
  });

  router.post(
    '/api/finance/companies/:id/documents',
    auth,
    requireMesa('finance'),
    express.raw({ type: DOCUMENT_TYPES, limit: `${MAX_UPLOAD_MB}mb` }),
    async (req, res) => {
      const row = await findCompany(req.params.id);
      if (!row) return res.status(404).json({ error: 'empresa no encontrada' });
      const contentType = String(req.headers['content-type'] || '').split(';')[0].trim();
      if (!DOCUMENT_TYPES.includes(contentType)) {
        return res.status(415).json({ error: 'Formato no permitido. PDF, Word, hoja de calculo, CSV, TXT o imagen (JPG/PNG/WebP).' });
      }
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: 'Archivo vacio o ilegible' });
      }
      if ((await docCountFor(row._id)) >= MAX_DOCS_PER_COMPANY) {
        return res.status(400).json({ error: `Maximo ${MAX_DOCS_PER_COMPANY} documentos por empresa` });
      }

      const folderRaw = String(req.headers['x-folder'] || 'otros');
      const folder = COMPANY_FOLDERS.includes(folderRaw) ? folderRaw : 'otros';
      let filename = 'archivo';
      try { filename = decodeURIComponent(String(req.headers['x-filename'] || 'archivo')); } catch {}
      filename = filename.slice(0, 180);
      let label = null;
      try { label = req.headers['x-label'] ? decodeURIComponent(String(req.headers['x-label'])).slice(0, 160) : null; } catch {}

      const uploadedAt = new Date().toISOString();
      const upload = docsBucket(mongo).openUploadStream(filename, {
        metadata: { company_id: row._id, folder, label, content_type: contentType, uploaded_by: req.user, uploaded_at: uploadedAt },
      });
      upload.on('error', () => {
        if (!res.headersSent) res.status(500).json({ error: 'Error al guardar el documento' });
      });
      upload.on('finish', async () => {
        await appendFinanceLog(mongo, {
          action: 'company.document.upload',
          actorId: req.user,
          detail: { companyId: row._id, fileId: upload.id.toString(), filename, folder },
        });
        res.status(201).json({
          id: upload.id.toString(), companyId: row._id, filename, contentType,
          folder, label, size: req.body.length, uploadedBy: req.user, uploadedAt,
        });
      });
      upload.end(req.body);
    },
  );

  router.get('/api/finance/companies/documents/:fileId', ...guard, async (req, res) => {
    let oid;
    try { oid = new ObjectId(String(req.params.fileId)); } catch { return res.status(400).json({ error: 'Id de documento invalido' }); }
    const file = await mongo.collection('finance_company_docs.files').findOne({ _id: oid });
    if (!file) return res.status(404).json({ error: 'Documento no encontrado' });
    res.setHeader('Content-Type', file.metadata?.content_type || 'application/octet-stream');
    res.setHeader('Content-Length', String(file.length));
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    const stream = docsBucket(mongo).openDownloadStream(oid);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });

  // Mover un documento de carpeta o renombrar su etiqueta, sin resubirlo.
  router.patch('/api/finance/companies/documents/:fileId', ...guard, async (req, res) => {
    let oid;
    try { oid = new ObjectId(String(req.params.fileId)); } catch { return res.status(400).json({ error: 'Id de documento invalido' }); }
    const file = await mongo.collection('finance_company_docs.files').findOne({ _id: oid });
    if (!file) return res.status(404).json({ error: 'Documento no encontrado' });
    const b = req.body || {};
    const patch = {};
    if (b.folder !== undefined) {
      if (!COMPANY_FOLDERS.includes(b.folder)) return res.status(400).json({ error: `folder debe ser: ${COMPANY_FOLDERS.join(', ')}` });
      patch['metadata.folder'] = b.folder;
    }
    if (b.label !== undefined) patch['metadata.label'] = str(b.label, 160) || null;
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'nada que actualizar' });
    await mongo.collection('finance_company_docs.files').updateOne({ _id: oid }, { $set: patch });
    await appendFinanceLog(mongo, { action: 'company.document.update', actorId: req.user, detail: { fileId: req.params.fileId, fields: Object.keys(patch) } });
    const updated = await mongo.collection('finance_company_docs.files').findOne({ _id: oid });
    res.json(serializeDoc(updated));
  });

  router.delete('/api/finance/companies/documents/:fileId', ...guard, async (req, res) => {
    let oid;
    try { oid = new ObjectId(String(req.params.fileId)); } catch { return res.status(400).json({ error: 'Id de documento invalido' }); }
    const file = await mongo.collection('finance_company_docs.files').findOne({ _id: oid });
    if (!file) return res.status(404).json({ error: 'Documento no encontrado' });
    await docsBucket(mongo).delete(oid);
    await appendFinanceLog(mongo, {
      action: 'company.document.delete',
      actorId: req.user,
      detail: { companyId: file.metadata?.company_id || null, fileId: req.params.fileId, filename: file.filename },
    });
    res.json({ id: req.params.fileId });
  });

  /* ---- notas de seguimiento ---- */

  router.post('/api/finance/companies/:id/notes', ...guard, async (req, res) => {
    const row = await findCompany(req.params.id);
    if (!row) return res.status(404).json({ error: 'empresa no encontrada' });
    const text = str((req.body || {}).text, 4000);
    if (!text) return res.status(400).json({ error: 'text requerido' });
    const doc = {
      _id: crypto.randomUUID(),
      companyId: row._id,
      text,
      authorId: req.user,
      createdAt: new Date().toISOString(),
    };
    await mongo.collection('finance_company_notes').insertOne(doc);
    await appendFinanceLog(mongo, { action: 'company.note.create', actorId: req.user, detail: { companyId: row._id, noteId: doc._id } });
    res.status(201).json(withId(doc));
  });

  router.delete('/api/finance/companies/notes/:noteId', ...guard, async (req, res) => {
    const result = await mongo.collection('finance_company_notes').deleteOne({ _id: String(req.params.noteId) });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'nota no encontrada' });
    await appendFinanceLog(mongo, { action: 'company.note.delete', actorId: req.user, detail: { noteId: req.params.noteId } });
    res.json({ id: req.params.noteId });
  });

  /* ---- resumen KPI del apartado ---- */

  router.get('/api/finance/companies-summary', ...guard, async (req, res) => {
    const [companiesCount, activeCount, documentsCount, notesCount, sizeAgg] = await Promise.all([
      mongo.collection('finance_companies').countDocuments({}),
      mongo.collection('finance_companies').countDocuments({ status: 'activa' }),
      mongo.collection('finance_company_docs.files').countDocuments({}),
      mongo.collection('finance_company_notes').countDocuments({}),
      mongo.collection('finance_company_docs.files')
        .aggregate([{ $group: { _id: null, bytes: { $sum: '$length' } } }]).toArray(),
    ]);
    res.json({
      companiesCount,
      activeCount,
      documentsCount,
      notesCount,
      storageBytes: sizeAgg.length ? sizeAgg[0].bytes : 0,
    });
  });
}
