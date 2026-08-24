/**
 * S-NFI F&L (Fiscal & Legal) — custodia legal inexpugnable del Holding.
 *
 * Alcance: NDAs, contratos mercantiles/laborales, estructura de cesion de
 * licencias y expediente tecnico-juridico de base para el Modelo de Utilidad
 * ante la OEPM.
 *
 * Mismo patron que S-NFI Finance: CRUD directo sobre Mongo, sin router TS
 * separado, log inmutable propio (fl_log, hash chain). Documentos (PDF/DOCX)
 * en GridFS bucket 'fl_documents', mismo patron raw upload que company_images
 * en Reff.
 */

import crypto from 'node:crypto';
import { GridFSBucket, ObjectId } from 'mongodb';
import express from 'express';

const DOC_TYPES = ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
const MAX_DOC_SIZE = '16mb';
const MAX_DOCS_PER_ENTITY = 50;

const ENTITY_KINDS = ['nda', 'contract', 'license', 'oepm'];
const NDA_STATUSES = ['activo', 'vencido', 'rescindido'];
const CONTRACT_TYPES = ['mercantil', 'laboral'];
const CONTRACT_STATUSES = ['activo', 'vencido', 'rescindido'];
const OEPM_PIECE_KEYS = ['memoria_descriptiva', 'reivindicaciones', 'planos', 'resumen'];
const OEPM_PIECE_STATUSES = ['pendiente', 'borrador', 'listo'];
const OEPM_STATUSES = ['preparacion', 'presentado', 'en_examen', 'concedido', 'denegado'];

function withId(doc) {
  if (!doc) return doc;
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
}

function canonical(entry) {
  return JSON.stringify(entry, Object.keys(entry).sort());
}

async function appendFlLog(mongo, entry) {
  const col = mongo.collection('fl_log');
  const tail = await col.find().sort({ seq: -1 }).limit(1).next();
  const seq = tail ? tail.seq + 1 : 1;
  const prevHash = tail ? tail.hash : '0'.repeat(64);
  const canonicalEntry = { ...entry, seq };
  const hash = crypto.createHash('sha256').update(prevHash + canonical(canonicalEntry)).digest('hex');
  const doc = { _id: crypto.randomUUID(), ...entry, seq, prevHash, hash, createdAt: new Date().toISOString() };
  await col.insertOne(doc);
  return doc;
}

function docsBucket(db) {
  return new GridFSBucket(db, { bucketName: 'fl_documents' });
}

function serializeDoc(f) {
  return {
    id: f._id.toString(),
    filename: f.filename,
    contentType: f.metadata?.content_type || 'application/octet-stream',
    size: f.length,
    entityKind: f.metadata?.entity_kind || null,
    entityId: f.metadata?.entity_id || null,
    uploadedBy: f.metadata?.uploaded_by || null,
    uploadedAt: f.metadata?.uploaded_at || f.uploadDate?.toISOString?.() || null,
  };
}

function vigenciaEstado(validFrom, validTo, currentStatus) {
  if (currentStatus === 'rescindido') return 'rescindido';
  if (validTo && new Date(validTo).getTime() < Date.now()) return 'vencido';
  return 'activo';
}

export function mountFL(app, { auth, requireMesa, mongo, db }) {
  const router = app;
  const guard = [auth, requireMesa('fl')];
  const bucket = () => docsBucket(db);

  /* ---- NDAs ---- */

  router.get('/api/fl/ndas', ...guard, async (req, res) => {
    const rows = await mongo.collection('fl_ndas').find({}).sort({ _id: -1 }).toArray();
    res.json(rows.map(r => ({ ...withId(r), status: vigenciaEstado(r.validFrom, r.validTo, r.status) })));
  });

  router.post('/api/fl/ndas', ...guard, async (req, res) => {
    const b = req.body || {};
    const counterparty = String(b.counterparty || '').trim();
    if (!counterparty) return res.status(400).json({ error: 'counterparty requerido' });
    if (!b.signedAt || Number.isNaN(Date.parse(b.signedAt))) return res.status(400).json({ error: 'signedAt invalido' });
    if (!b.validFrom || Number.isNaN(Date.parse(b.validFrom))) return res.status(400).json({ error: 'validFrom invalido' });
    if (b.validTo && Number.isNaN(Date.parse(b.validTo))) return res.status(400).json({ error: 'validTo invalido' });

    const doc = {
      _id: crypto.randomUUID(),
      counterparty,
      scope: typeof b.scope === 'string' ? b.scope.trim().slice(0, 1000) : '',
      signedAt: b.signedAt,
      validFrom: b.validFrom,
      validTo: typeof b.validTo === 'string' && b.validTo ? b.validTo : null,
      status: 'activo',
      createdBy: req.user,
      createdAt: new Date().toISOString(),
    };
    await mongo.collection('fl_ndas').insertOne(doc);
    await appendFlLog(mongo, { action: 'nda.create', actorId: req.user, detail: { ndaId: doc._id, counterparty } });
    res.status(201).json(withId(doc));
  });

  router.patch('/api/fl/ndas/:id', ...guard, async (req, res) => {
    const row = await mongo.collection('fl_ndas').findOne({ _id: req.params.id });
    if (!row) return res.status(404).json({ error: 'NDA no encontrado' });
    const b = req.body || {};
    const $set = {};
    if (b.status !== undefined) {
      if (!NDA_STATUSES.includes(b.status)) return res.status(400).json({ error: 'status invalido' });
      $set.status = b.status;
    }
    if (b.validTo !== undefined) {
      if (b.validTo && Number.isNaN(Date.parse(b.validTo))) return res.status(400).json({ error: 'validTo invalido' });
      $set.validTo = b.validTo || null;
    }
    if (Object.keys($set).length > 0) {
      await mongo.collection('fl_ndas').updateOne({ _id: req.params.id }, { $set });
      await appendFlLog(mongo, { action: 'nda.update', actorId: req.user, detail: { ndaId: req.params.id, $set } });
    }
    const updated = await mongo.collection('fl_ndas').findOne({ _id: req.params.id });
    res.json(withId(updated));
  });

  router.delete('/api/fl/ndas/:id', ...guard, async (req, res) => {
    const result = await mongo.collection('fl_ndas').deleteOne({ _id: req.params.id });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'NDA no encontrado' });
    await appendFlLog(mongo, { action: 'nda.delete', actorId: req.user, detail: { ndaId: req.params.id } });
    res.json({ id: req.params.id });
  });

  /* ---- contratos mercantiles/laborales ---- */

  router.get('/api/fl/contracts', ...guard, async (req, res) => {
    const rows = await mongo.collection('fl_contracts').find({}).sort({ _id: -1 }).toArray();
    res.json(rows.map(r => ({ ...withId(r), status: vigenciaEstado(r.validFrom, r.validTo, r.status) })));
  });

  router.post('/api/fl/contracts', ...guard, async (req, res) => {
    const b = req.body || {};
    if (!CONTRACT_TYPES.includes(b.type)) return res.status(400).json({ error: 'type debe ser mercantil o laboral' });
    const parties = String(b.parties || '').trim();
    if (!parties) return res.status(400).json({ error: 'parties requerido' });
    const objectDesc = String(b.objectDesc || '').trim();
    if (!objectDesc) return res.status(400).json({ error: 'objectDesc requerido' });
    if (!b.validFrom || Number.isNaN(Date.parse(b.validFrom))) return res.status(400).json({ error: 'validFrom invalido' });
    if (b.validTo && Number.isNaN(Date.parse(b.validTo))) return res.status(400).json({ error: 'validTo invalido' });

    const doc = {
      _id: crypto.randomUUID(),
      type: b.type,
      parties,
      objectDesc: objectDesc.slice(0, 1000),
      validFrom: b.validFrom,
      validTo: typeof b.validTo === 'string' && b.validTo ? b.validTo : null,
      status: 'activo',
      createdBy: req.user,
      createdAt: new Date().toISOString(),
    };
    await mongo.collection('fl_contracts').insertOne(doc);
    await appendFlLog(mongo, { action: 'contract.create', actorId: req.user, detail: { contractId: doc._id, type: b.type, parties } });
    res.status(201).json(withId(doc));
  });

  router.patch('/api/fl/contracts/:id', ...guard, async (req, res) => {
    const row = await mongo.collection('fl_contracts').findOne({ _id: req.params.id });
    if (!row) return res.status(404).json({ error: 'contrato no encontrado' });
    const b = req.body || {};
    const $set = {};
    if (b.status !== undefined) {
      if (!CONTRACT_STATUSES.includes(b.status)) return res.status(400).json({ error: 'status invalido' });
      $set.status = b.status;
    }
    if (b.validTo !== undefined) {
      if (b.validTo && Number.isNaN(Date.parse(b.validTo))) return res.status(400).json({ error: 'validTo invalido' });
      $set.validTo = b.validTo || null;
    }
    if (Object.keys($set).length > 0) {
      await mongo.collection('fl_contracts').updateOne({ _id: req.params.id }, { $set });
      await appendFlLog(mongo, { action: 'contract.update', actorId: req.user, detail: { contractId: req.params.id, $set } });
    }
    const updated = await mongo.collection('fl_contracts').findOne({ _id: req.params.id });
    res.json(withId(updated));
  });

  router.delete('/api/fl/contracts/:id', ...guard, async (req, res) => {
    const result = await mongo.collection('fl_contracts').deleteOne({ _id: req.params.id });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'contrato no encontrado' });
    await appendFlLog(mongo, { action: 'contract.delete', actorId: req.user, detail: { contractId: req.params.id } });
    res.json({ id: req.params.id });
  });

  /* ---- licencias ---- */

  router.get('/api/fl/licenses', ...guard, async (req, res) => {
    const rows = await mongo.collection('fl_licenses').find({}).sort({ _id: -1 }).toArray();
    res.json(rows.map(r => ({ ...withId(r), status: vigenciaEstado(r.validFrom, r.validTo, r.status) })));
  });

  router.post('/api/fl/licenses', ...guard, async (req, res) => {
    const b = req.body || {};
    const licensor = String(b.licensor || '').trim();
    const licensee = String(b.licensee || '').trim();
    if (!licensor) return res.status(400).json({ error: 'licensor requerido' });
    if (!licensee) return res.status(400).json({ error: 'licensee requerido' });
    if (!b.validFrom || Number.isNaN(Date.parse(b.validFrom))) return res.status(400).json({ error: 'validFrom invalido' });
    if (b.validTo && Number.isNaN(Date.parse(b.validTo))) return res.status(400).json({ error: 'validTo invalido' });

    let contractId = null;
    if (b.contractId) {
      const c = await mongo.collection('fl_contracts').findOne({ _id: String(b.contractId) });
      if (!c) return res.status(400).json({ error: 'contrato vinculado no encontrado' });
      contractId = c._id;
    }

    const doc = {
      _id: crypto.randomUUID(),
      licensor,
      licensee,
      territory: typeof b.territory === 'string' ? b.territory.trim().slice(0, 200) : '',
      exclusive: !!b.exclusive,
      royaltyFee: typeof b.royaltyFee === 'string' ? b.royaltyFee.trim().slice(0, 200) : '',
      contractId,
      validFrom: b.validFrom,
      validTo: typeof b.validTo === 'string' && b.validTo ? b.validTo : null,
      status: 'activo',
      createdBy: req.user,
      createdAt: new Date().toISOString(),
    };
    await mongo.collection('fl_licenses').insertOne(doc);
    await appendFlLog(mongo, { action: 'license.create', actorId: req.user, detail: { licenseId: doc._id, licensor, licensee } });
    res.status(201).json(withId(doc));
  });

  router.patch('/api/fl/licenses/:id', ...guard, async (req, res) => {
    const row = await mongo.collection('fl_licenses').findOne({ _id: req.params.id });
    if (!row) return res.status(404).json({ error: 'licencia no encontrada' });
    const b = req.body || {};
    const $set = {};
    if (b.status !== undefined) {
      if (!CONTRACT_STATUSES.includes(b.status)) return res.status(400).json({ error: 'status invalido' });
      $set.status = b.status;
    }
    if (b.validTo !== undefined) {
      if (b.validTo && Number.isNaN(Date.parse(b.validTo))) return res.status(400).json({ error: 'validTo invalido' });
      $set.validTo = b.validTo || null;
    }
    if (Object.keys($set).length > 0) {
      await mongo.collection('fl_licenses').updateOne({ _id: req.params.id }, { $set });
      await appendFlLog(mongo, { action: 'license.update', actorId: req.user, detail: { licenseId: req.params.id, $set } });
    }
    const updated = await mongo.collection('fl_licenses').findOne({ _id: req.params.id });
    res.json(withId(updated));
  });

  router.delete('/api/fl/licenses/:id', ...guard, async (req, res) => {
    const result = await mongo.collection('fl_licenses').deleteOne({ _id: req.params.id });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'licencia no encontrada' });
    await appendFlLog(mongo, { action: 'license.delete', actorId: req.user, detail: { licenseId: req.params.id } });
    res.json({ id: req.params.id });
  });

  /* ---- expediente OEPM (Modelo de Utilidad) ---- */

  function defaultPieces() {
    const pieces = {};
    for (const key of OEPM_PIECE_KEYS) pieces[key] = { status: 'pendiente', note: '' };
    return pieces;
  }

  router.get('/api/fl/oepm', ...guard, async (req, res) => {
    const rows = await mongo.collection('fl_oepm_files').find({}).sort({ _id: -1 }).toArray();
    res.json(rows.map(withId));
  });

  router.post('/api/fl/oepm', ...guard, async (req, res) => {
    const b = req.body || {};
    const title = String(b.title || '').trim();
    if (!title) return res.status(400).json({ error: 'title requerido' });
    const doc = {
      _id: crypto.randomUUID(),
      title,
      description: typeof b.description === 'string' ? b.description.trim().slice(0, 1000) : '',
      status: 'preparacion',
      pieces: defaultPieces(),
      filingNumber: null,
      filedAt: null,
      createdBy: req.user,
      createdAt: new Date().toISOString(),
    };
    await mongo.collection('fl_oepm_files').insertOne(doc);
    await appendFlLog(mongo, { action: 'oepm.create', actorId: req.user, detail: { oepmId: doc._id, title } });
    res.status(201).json(withId(doc));
  });

  router.patch('/api/fl/oepm/:id', ...guard, async (req, res) => {
    const row = await mongo.collection('fl_oepm_files').findOne({ _id: req.params.id });
    if (!row) return res.status(404).json({ error: 'expediente no encontrado' });
    const b = req.body || {};
    const $set = {};

    if (b.pieceKey !== undefined) {
      if (!OEPM_PIECE_KEYS.includes(b.pieceKey)) return res.status(400).json({ error: 'pieceKey invalido' });
      if (b.pieceStatus !== undefined && !OEPM_PIECE_STATUSES.includes(b.pieceStatus)) {
        return res.status(400).json({ error: 'pieceStatus invalido' });
      }
      const pieces = { ...row.pieces };
      pieces[b.pieceKey] = {
        status: b.pieceStatus !== undefined ? b.pieceStatus : (pieces[b.pieceKey]?.status || 'pendiente'),
        note: b.pieceNote !== undefined ? String(b.pieceNote).slice(0, 500) : (pieces[b.pieceKey]?.note || ''),
      };
      $set.pieces = pieces;
    }
    if (b.status !== undefined) {
      if (!OEPM_STATUSES.includes(b.status)) return res.status(400).json({ error: 'status invalido' });
      $set.status = b.status;
    }
    if (b.filingNumber !== undefined) $set.filingNumber = typeof b.filingNumber === 'string' ? b.filingNumber.trim() || null : null;
    if (b.filedAt !== undefined) {
      if (b.filedAt && Number.isNaN(Date.parse(b.filedAt))) return res.status(400).json({ error: 'filedAt invalido' });
      $set.filedAt = b.filedAt || null;
    }

    if (Object.keys($set).length > 0) {
      await mongo.collection('fl_oepm_files').updateOne({ _id: req.params.id }, { $set });
      await appendFlLog(mongo, { action: 'oepm.update', actorId: req.user, detail: { oepmId: req.params.id, $set } });
    }
    const updated = await mongo.collection('fl_oepm_files').findOne({ _id: req.params.id });
    res.json(withId(updated));
  });

  router.delete('/api/fl/oepm/:id', ...guard, async (req, res) => {
    const result = await mongo.collection('fl_oepm_files').deleteOne({ _id: req.params.id });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'expediente no encontrado' });
    await appendFlLog(mongo, { action: 'oepm.delete', actorId: req.user, detail: { oepmId: req.params.id } });
    res.json({ id: req.params.id });
  });

  /* ---- documentos adjuntos (GridFS, cualquier entidad) ---- */

  router.get('/api/fl/:kind/:id/docs', ...guard, async (req, res) => {
    const { kind, id } = req.params;
    if (!ENTITY_KINDS.includes(kind)) return res.status(400).json({ error: 'kind invalido' });
    const files = await db.collection('fl_documents.files')
      .find({ 'metadata.entity_kind': kind, 'metadata.entity_id': id })
      .sort({ uploadDate: -1 })
      .toArray();
    res.json(files.map(serializeDoc));
  });

  router.post(
    '/api/fl/:kind/:id/docs',
    ...guard,
    express.raw({ type: DOC_TYPES, limit: MAX_DOC_SIZE }),
    async (req, res) => {
      const { kind, id } = req.params;
      if (!ENTITY_KINDS.includes(kind)) return res.status(400).json({ error: 'kind invalido' });

      const contentType = String(req.headers['content-type'] || '');
      if (!DOC_TYPES.includes(contentType)) {
        return res.status(415).json({ error: 'Formato no permitido. Solo PDF o DOCX.' });
      }
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: 'Archivo vacio o ilegible' });
      }
      const count = await db.collection('fl_documents.files')
        .countDocuments({ 'metadata.entity_kind': kind, 'metadata.entity_id': id });
      if (count >= MAX_DOCS_PER_ENTITY) {
        return res.status(400).json({ error: `Maximo ${MAX_DOCS_PER_ENTITY} documentos por registro` });
      }

      let filename = 'documento';
      try { filename = decodeURIComponent(String(req.headers['x-filename'] || 'documento')); } catch {}
      filename = filename.slice(0, 180);

      const uploadedAt = new Date().toISOString();
      const upload = bucket().openUploadStream(filename, {
        metadata: { entity_kind: kind, entity_id: id, uploaded_by: req.user, uploaded_at: uploadedAt, content_type: contentType },
      });
      upload.on('error', () => {
        if (!res.headersSent) res.status(500).json({ error: 'Error al guardar el documento' });
      });
      upload.on('finish', async () => {
        await appendFlLog(mongo, { action: 'doc.upload', actorId: req.user, detail: { kind, entityId: id, filename, docId: upload.id.toString() } });
        res.status(201).json({
          document: { id: upload.id.toString(), filename, contentType, size: req.body.length, uploadedAt },
        });
      });
      upload.end(req.body);
    },
  );

  router.get('/api/fl/docs/:docId/download', ...guard, async (req, res) => {
    let fileId;
    try { fileId = new ObjectId(req.params.docId); } catch { return res.status(400).json({ error: 'id invalido' }); }
    const file = await db.collection('fl_documents.files').findOne({ _id: fileId });
    if (!file) return res.status(404).json({ error: 'documento no encontrado' });
    res.setHeader('Content-Type', file.metadata?.content_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.filename)}"`);
    bucket().openDownloadStream(fileId).on('error', () => {
      if (!res.headersSent) res.status(500).json({ error: 'Error al leer el documento' });
    }).pipe(res);
  });

  router.delete('/api/fl/docs/:docId', ...guard, async (req, res) => {
    let fileId;
    try { fileId = new ObjectId(req.params.docId); } catch { return res.status(400).json({ error: 'id invalido' }); }
    try { await bucket().delete(fileId); } catch { return res.status(404).json({ error: 'documento no encontrado' }); }
    await appendFlLog(mongo, { action: 'doc.delete', actorId: req.user, detail: { docId: req.params.docId } });
    res.json({ id: req.params.docId });
  });

  /* ---- resumen KPI ---- */

  router.get('/api/fl/summary', ...guard, async (req, res) => {
    const [ndas, contracts, licenses, oepmFiles] = await Promise.all([
      mongo.collection('fl_ndas').find({}).toArray(),
      mongo.collection('fl_contracts').find({}).toArray(),
      mongo.collection('fl_licenses').find({}).toArray(),
      mongo.collection('fl_oepm_files').find({}).toArray(),
    ]);
    const soon = Date.now() + 30 * 86400000;
    const expiringSoon = [...ndas, ...contracts, ...licenses].filter((r) => {
      const st = vigenciaEstado(r.validFrom, r.validTo, r.status);
      return st === 'activo' && r.validTo && new Date(r.validTo).getTime() <= soon;
    }).length;
    res.json({
      ndasCount: ndas.length,
      contractsCount: contracts.length,
      licensesCount: licenses.length,
      oepmCount: oepmFiles.length,
      expiringSoon,
    });
  });

  /* ---- integridad del log ---- */

  router.get('/api/fl/log/verify', ...guard, async (req, res) => {
    const all = await mongo.collection('fl_log').find({}).sort({ seq: 1 }).toArray();
    let prev = '0'.repeat(64);
    for (const entry of all) {
      const { _id, seq, prevHash, hash, createdAt, ...rest } = entry;
      const expectedHash = crypto.createHash('sha256').update(prev + canonical({ ...rest, seq })).digest('hex');
      if (expectedHash !== hash || prevHash !== prev) {
        return res.json({ valid: false, totalEntries: all.length, brokenAtSeq: seq });
      }
      prev = hash;
    }
    res.json({ valid: true, totalEntries: all.length, brokenAtSeq: null });
  });
}
