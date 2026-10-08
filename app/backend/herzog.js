/**
 * Herzog (Central) — bunker receptor de TODA la informacion/datos de SYSTEMS.
 * Distinto del Herzog interno de OPHS Framework (bridge de telemetria fisica
 * OPS/PAIA, sin cambios, sigue en elvira-central.js). Este Herzog es
 * transversal: cualquier departamento pide/guarda informacion aqui.
 *
 * 3 bloques (alcance 2026-09-08, primera implementacion real):
 *  1. Metricas: cualquier mesa reporta un numero/estado puntual
 *     (herzog_metrics) via POST directo o via el bus de eventos
 *     (dest:'HERZOG' en /api/bus/emit ya soportado, sin transporte nuevo).
 *  2. Documentos: informes/PDFs/hojas que sube una persona, GridFS bucket
 *     propio 'herzog_documents' (mismo patron raw-upload sin multer que
 *     company_images en Reff).
 *  3. Notas: bitacora de texto libre por persona (registro manual).
 *
 * Solo lectura/escritura dentro de sus propias colecciones — no ejecuta
 * accion sobre otras mesas (Regla de Oro: Herzog almacena, no orquesta).
 */

import crypto from 'node:crypto';
import express from 'express';
import { GridFSBucket, ObjectId } from 'mongodb';
import { runAsTenant } from './db/tenant-context.js';
import { DEFAULT_TENANT_ID } from './db/tenant-registry.js';

const DOCUMENT_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'text/csv',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'];
const MAX_DOCUMENTS = 500;

function withId(doc) {
  if (!doc) return doc;
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
}

function canonical(entry) {
  return JSON.stringify(entry, Object.keys(entry).sort());
}

async function appendHerzogLog(mongo, entry) {
  const col = mongo.collection('herzog_log');
  const tail = await col.find().sort({ seq: -1 }).limit(1).next();
  const seq = tail ? tail.seq + 1 : 1;
  const prevHash = tail ? tail.hash : '0'.repeat(64);
  const canonicalEntry = { ...entry, seq };
  const hash = crypto.createHash('sha256').update(prevHash + canonical(canonicalEntry)).digest('hex');
  const doc = { _id: crypto.randomUUID(), ...entry, seq, prevHash, hash, createdAt: new Date().toISOString() };
  await col.insertOne(doc);
  return doc;
}

function documentsBucket(mongo) {
  return new GridFSBucket(mongo, { bucketName: 'herzog_documents' });
}

function serializeDoc(f) {
  return {
    id: f._id.toString(),
    filename: f.filename,
    contentType: f.metadata?.content_type || 'application/octet-stream',
    size: f.length,
    department: f.metadata?.department || null,
    uploadedBy: f.metadata?.uploaded_by || null,
    uploadedAt: f.metadata?.uploaded_at || f.uploadDate?.toISOString?.() || null,
  };
}

const BASE_POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 min, igual orden de magnitud que refreshMesaStatus del dashboard

/**
 * Variables base: snapshot periodico de las mesas fuente (U2/Finance/OPHS/Pactvm),
 * escrito con source:'auto' en herzog_metrics. No sustituye la fuente de verdad
 * de cada mesa (Herzog solo copia numeros ya calculados alli), pero permite que
 * un departamento consulte el ultimo valor conocido en Herzog aunque la mesa
 * origen este caida en ese momento.
 */
async function pollBaseMetrics(mongo, { getU2Snapshot }) {
  const now = new Date().toISOString();
  const rows = [];

  try {
    const u2 = typeof getU2Snapshot === 'function' ? getU2Snapshot() : null;
    if (u2) {
      rows.push({ department: 'snfiu2', metric: 'precio_actual_eur_mwh', value: u2.precio_actual_eur_mwh ?? null, unit: 'EUR/MWh' });
      rows.push({ department: 'snfiu2', metric: 'exceso_gwh_hoy', value: u2.exceso_gwh_hoy ?? null, unit: 'GWh' });
    }
  } catch { /* mesa origen no disponible, se salta este ciclo */ }

  try {
    const [accounts, movements, assets] = await Promise.all([
      mongo.collection('finance_accounts').find({}).toArray(),
      mongo.collection('finance_movements').find({}).toArray(),
      mongo.collection('finance_assets').find({}).toArray(),
    ]);
    const openingSum = accounts.reduce((sum, a) => sum + (a.openingBalanceCents || 0), 0);
    const totalBalanceCents = openingSum + movements.reduce((sum, m) => sum + m.amountCents, 0);
    rows.push({ department: 'finance', metric: 'total_balance', value: Math.round(totalBalanceCents) / 100, unit: 'EUR' });
    rows.push({ department: 'finance', metric: 'accounts_count', value: accounts.length, unit: null });
    rows.push({ department: 'finance', metric: 'assets_count', value: assets.length, unit: null });
  } catch { /* mesa origen no disponible, se salta este ciclo */ }

  try {
    const opsNodes = await mongo.collection('ops_nodes').find({}).toArray();
    rows.push({ department: 'ophs', metric: 'nodes_total', value: opsNodes.length, unit: null });
    rows.push({ department: 'ophs', metric: 'nodes_nominal', value: opsNodes.filter((n) => n.circuitState === 'nominal').length, unit: null });
    rows.push({ department: 'ophs', metric: 'nodes_degradado', value: opsNodes.filter((n) => n.circuitState === 'degradado').length, unit: null });
  } catch { /* mesa origen no disponible, se salta este ciclo */ }

  try {
    const [cibeAll, countryNodes] = await Promise.all([
      mongo.collection('pactvm_cibe').find({}).toArray(),
      mongo.collection('pactvm_country_nodes').find({}).toArray(),
    ]);
    rows.push({ department: 'pactvm', metric: 'cibe_emitidos', value: cibeAll.filter((c) => c.status === 'emitido').length, unit: null });
    rows.push({ department: 'pactvm', metric: 'nodes_needed_total', value: countryNodes.reduce((sum, c) => sum + (c.nodesNeeded || 0), 0), unit: null });
  } catch { /* mesa origen no disponible, se salta este ciclo */ }

  if (rows.length === 0) return;
  const docs = rows.map((r) => ({
    _id: crypto.randomUUID(),
    ...r,
    source: 'auto',
    note: null,
    reportedBy: 'system',
    createdAt: now,
  }));
  await mongo.collection('herzog_metrics').insertMany(docs);
}

export function mountHerzog(app, { auth, requireMesa, mongo, busEmit, adminNotify, getU2Snapshot }) {
  const router = app;
  const guard = [auth, requireMesa('herzog')];

  // Cron de boot, fuera de cualquier request: corre explicitamente contra el
  // tenant por defecto (runAsTenant), nunca contra el mongo tenant-aware
  // recibido arriba, que exige un request con resolveTenant ya corrido.
  runAsTenant(DEFAULT_TENANT_ID, () => pollBaseMetrics(mongo, { getU2Snapshot }).catch(() => {}));
  // unref: no bloquea salida de proceso en tests/scripts aislados que montan
  // este router sin app.listen() de por vida; en server.js real no cambia
  // nada, el proceso ya lo mantiene vivo el propio listen().
  setInterval(() => runAsTenant(DEFAULT_TENANT_ID, () => pollBaseMetrics(mongo, { getU2Snapshot }).catch(() => {})), BASE_POLL_INTERVAL_MS).unref();

  /* ---- bloque 1: metricas (numero/estado puntual reportado por una mesa) ---- */

  router.get('/api/herzog-central/metrics', ...guard, async (req, res) => {
    const q = {};
    if (req.query.department) q.department = String(req.query.department);
    if (req.query.source) q.source = String(req.query.source); // 'auto' | 'manual'
    const limit = Math.min(Math.max(Number(req.query.limit ?? 200), 1), 1000);
    const rows = await mongo.collection('herzog_metrics').find(q).sort({ createdAt: -1 }).limit(limit).toArray();
    res.json(rows.map(withId));
  });

  router.post('/api/herzog-central/metrics', ...guard, async (req, res) => {
    const b = req.body || {};
    const department = String(b.department || '').trim();
    const metric = String(b.metric || '').trim();
    if (!department) return res.status(400).json({ error: 'department requerido' });
    if (!metric) return res.status(400).json({ error: 'metric requerido' });
    if (b.value === undefined || b.value === null || b.value === '') return res.status(400).json({ error: 'value requerido' });

    const doc = {
      _id: crypto.randomUUID(),
      department,
      metric,
      value: typeof b.value === 'number' ? b.value : String(b.value).slice(0, 300),
      unit: typeof b.unit === 'string' ? b.unit.trim().slice(0, 40) : null,
      note: typeof b.note === 'string' ? b.note.trim().slice(0, 500) : null,
      source: 'manual',
      reportedBy: req.user,
      createdAt: new Date().toISOString(),
    };
    await mongo.collection('herzog_metrics').insertOne(doc);
    await appendHerzogLog(mongo, { action: 'metric.create', actorId: req.user, detail: { metricId: doc._id, department, metric, value: doc.value } });
    res.status(201).json(withId(doc));
  });

  /* ---- bloque 2: documentos (GridFS, upload raw sin multer, mismo patron que company_images) ---- */

  router.get('/api/herzog-central/documents', ...guard, async (req, res) => {
    const q = {};
    if (req.query.department) q['metadata.department'] = String(req.query.department);
    const files = await mongo.collection('herzog_documents.files').find(q).sort({ uploadDate: -1 }).toArray();
    res.json(files.map(serializeDoc));
  });

  router.post('/api/herzog-central/documents', auth, requireMesa('herzog'), express.raw({ type: DOCUMENT_TYPES, limit: '20mb' }), async (req, res) => {
    const contentType = String(req.headers['content-type'] || '');
    if (!DOCUMENT_TYPES.includes(contentType)) {
      return res.status(415).json({ error: 'Formato no permitido. PDF, imagen (JPG/PNG/WebP) o hoja de calculo (CSV/XLS/XLSX).' });
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: 'Archivo vacío o ilegible' });
    }
    const count = await mongo.collection('herzog_documents.files').countDocuments({});
    if (count >= MAX_DOCUMENTS) {
      return res.status(400).json({ error: `Máximo ${MAX_DOCUMENTS} documentos en Herzog` });
    }
    const department = String(req.headers['x-department'] || 'sin-especificar').slice(0, 60);
    let filename = 'archivo';
    try { filename = decodeURIComponent(String(req.headers['x-filename'] || 'archivo')); } catch {}
    filename = filename.slice(0, 180);

    const uploadedAt = new Date().toISOString();
    const upload = documentsBucket(mongo).openUploadStream(filename, {
      metadata: { department, uploaded_by: req.user, uploaded_at: uploadedAt, content_type: contentType },
    });
    upload.on('error', () => {
      if (!res.headersSent) res.status(500).json({ error: 'Error al guardar el documento' });
    });
    upload.on('finish', async () => {
      await appendHerzogLog(mongo, { action: 'document.upload', actorId: req.user, detail: { fileId: upload.id.toString(), filename, department } });
      res.status(201).json({ id: upload.id.toString(), filename, contentType, size: req.body.length, department, uploadedAt });
    });
    upload.end(req.body);
  });

  router.get('/api/herzog-central/documents/:fileId', ...guard, async (req, res) => {
    let oid;
    try { oid = new ObjectId(String(req.params.fileId)); } catch { return res.status(400).json({ error: 'Id de documento inválido' }); }
    const file = await mongo.collection('herzog_documents.files').findOne({ _id: oid });
    if (!file) return res.status(404).json({ error: 'Documento no encontrado' });
    res.setHeader('Content-Type', file.metadata?.content_type || 'application/octet-stream');
    res.setHeader('Content-Length', String(file.length));
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    const stream = documentsBucket(mongo).openDownloadStream(oid);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });

  router.delete('/api/herzog-central/documents/:fileId', ...guard, async (req, res) => {
    let oid;
    try { oid = new ObjectId(String(req.params.fileId)); } catch { return res.status(400).json({ error: 'Id de documento inválido' }); }
    const file = await mongo.collection('herzog_documents.files').findOne({ _id: oid });
    if (!file) return res.status(404).json({ error: 'Documento no encontrado' });
    await documentsBucket(mongo).delete(oid);
    await appendHerzogLog(mongo, { action: 'document.delete', actorId: req.user, detail: { fileId: req.params.fileId, filename: file.filename } });
    res.json({ id: req.params.fileId });
  });

  /* ---- bloque 3: notas (bitacora de texto libre) ---- */

  router.get('/api/herzog-central/notes', ...guard, async (req, res) => {
    const q = {};
    if (req.query.department) q.department = String(req.query.department);
    const rows = await mongo.collection('herzog_notes').find(q).sort({ createdAt: -1 }).limit(200).toArray();
    res.json(rows.map(withId));
  });

  router.post('/api/herzog-central/notes', ...guard, async (req, res) => {
    const b = req.body || {};
    const text = String(b.text || '').trim();
    if (!text) return res.status(400).json({ error: 'text requerido' });
    const doc = {
      _id: crypto.randomUUID(),
      department: typeof b.department === 'string' ? b.department.trim().slice(0, 60) : 'sin-especificar',
      text: text.slice(0, 4000),
      tags: Array.isArray(b.tags) ? b.tags.map((t) => String(t).trim().slice(0, 40)).filter(Boolean).slice(0, 10) : [],
      authorId: req.user,
      createdAt: new Date().toISOString(),
    };
    await mongo.collection('herzog_notes').insertOne(doc);
    await appendHerzogLog(mongo, { action: 'note.create', actorId: req.user, detail: { noteId: doc._id, department: doc.department } });
    res.status(201).json(withId(doc));
  });

  router.delete('/api/herzog-central/notes/:id', ...guard, async (req, res) => {
    const result = await mongo.collection('herzog_notes').deleteOne({ _id: req.params.id });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'nota no encontrada' });
    await appendHerzogLog(mongo, { action: 'note.delete', actorId: req.user, detail: { noteId: req.params.id } });
    res.json({ id: req.params.id });
  });

  /* ---- resumen KPI (health-check dashboard) ---- */

  router.get('/api/herzog-central/summary', ...guard, async (req, res) => {
    const [metricsFacet, documentsCount, notesCount] = await Promise.all([
      mongo.collection('herzog_metrics').aggregate([
        {
          $facet: {
            bySource: [{ $group: { _id: '$source', count: { $sum: 1 } } }],
            departments: [{ $group: { _id: '$department' } }],
            last: [{ $sort: { createdAt: -1 } }, { $limit: 1 }, { $project: { createdAt: 1 } }],
          },
        },
      ]).toArray(),
      mongo.collection('herzog_documents.files').countDocuments({}),
      mongo.collection('herzog_notes').countDocuments({}),
    ]);
    const [{ bySource, departments, last }] = metricsFacet;
    const autoMetricsCount = bySource.find((s) => s._id === 'auto')?.count ?? 0;
    const manualMetricsCount = bySource.find((s) => s._id === 'manual')?.count ?? 0;
    res.json({
      metricsCount: autoMetricsCount + manualMetricsCount,
      autoMetricsCount,
      manualMetricsCount,
      documentsCount,
      notesCount,
      departmentsTracked: departments.length,
      lastMetricAt: last[0]?.createdAt ?? null,
    });
  });

  /* ---- integridad del log ---- */

  router.get('/api/herzog-central/log/verify', ...guard, async (req, res) => {
    const all = await mongo.collection('herzog_log').find({}).sort({ seq: 1 }).toArray();
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
