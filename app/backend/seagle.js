/**
 * S-EAGLE — Rëff Core Engine, mesa 5. Revisa la informacion que Herzog
 * (bunker central, ver herzog.js) retiene: filtra, corrige y alerta errores
 * de documentacion para que todo departamento entregue su informacion en
 * regla. No sustituye a Herzog (que solo almacena) ni ejecuta accion fuera
 * de sus propias colecciones — Regla de Oro: S-EAGLE señala, el humano
 * corrige/aprueba.
 *
 * 2 apartados (alcance 2026-09-08, primera implementacion real):
 *  1. Mapa mundi + portales Gob Share — sin backend propio, el frontend
 *     reutiliza directamente GOB_SHARE_NODES/gob-share-map.js (mismo dataset
 *     que gob-share.html), solo lectura.
 *  2. H-CONEXION — conexion directa con Herzog Central: lee metricas/
 *     documentos/notas de herzog_* (misma db, sin duplicar dato), permite
 *     marcar cada item como verificado/corregido/con error (seagle_reviews)
 *     y compartir una nota de correccion de vuelta a Herzog (herzog_notes,
 *     tag origin:seagle) para que quede en el bunker central.
 *
 * Metricas/variables propias de S-EAGLE: pendiente de definir (placeholder
 * explicito en el summary), como pide el alcance actual.
 */

import crypto from 'node:crypto';
import { appendChained, verifyLog } from './lib/hash-chain.js';

const REVIEW_STATUSES = ['pendiente', 'verificado', 'corregido', 'error'];
const SOURCE_TYPES = ['metric', 'document', 'note'];

function withId(doc) {
  if (!doc) return doc;
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
}

const appendSeagleLog = (mongo, entry) => appendChained(mongo, 'seagle_log', entry);

export function mountSeagle(app, { auth, requireMesa, mongo }) {
  const router = app;
  const guard = [auth, requireMesa('seagle')];

  /* ---- H-CONEXION: feed de lectura Herzog + estado de revision S-EAGLE ---- */

  router.get('/api/seagle/herzog/feed', ...guard, async (req, res) => {
    const department = req.query.department ? String(req.query.department) : null;
    const metricQ = department ? { department } : {};
    const docQ = department ? { 'metadata.department': department } : {};
    const noteQ = department ? { department } : {};

    const [metrics, documents, notes, reviews] = await Promise.all([
      mongo.collection('herzog_metrics').find(metricQ).sort({ createdAt: -1 }).limit(100).toArray(),
      mongo.collection('herzog_documents.files').find(docQ).sort({ uploadDate: -1 }).limit(100).toArray(),
      mongo.collection('herzog_notes').find(noteQ).sort({ createdAt: -1 }).limit(100).toArray(),
      mongo.collection('seagle_reviews').find({}).toArray(),
    ]);

    const reviewByKey = new Map(reviews.map((r) => [`${r.sourceType}:${r.sourceId}`, r]));
    const attachReview = (sourceType, id) => {
      const r = reviewByKey.get(`${sourceType}:${id}`);
      return r ? { status: r.status, note: r.note || null, reviewedBy: r.reviewedBy, reviewedAt: r.updatedAt } : { status: 'pendiente', note: null, reviewedBy: null, reviewedAt: null };
    };

    res.json({
      metrics: metrics.map((m) => ({ ...withId(m), review: attachReview('metric', m._id) })),
      documents: documents.map((f) => ({
        id: f._id.toString(),
        filename: f.filename,
        contentType: f.metadata?.content_type || 'application/octet-stream',
        size: f.length,
        department: f.metadata?.department || null,
        uploadedBy: f.metadata?.uploaded_by || null,
        uploadedAt: f.metadata?.uploaded_at || f.uploadDate?.toISOString?.() || null,
        review: attachReview('document', f._id.toString()),
      })),
      notes: notes.map((n) => ({ ...withId(n), review: attachReview('note', n._id) })),
    });
  });

  router.post('/api/seagle/herzog/review', ...guard, async (req, res) => {
    const b = req.body || {};
    const sourceType = String(b.sourceType || '');
    const sourceId = String(b.sourceId || '');
    const status = String(b.status || '');
    if (!SOURCE_TYPES.includes(sourceType)) return res.status(400).json({ error: 'sourceType invalido (metric|document|note)' });
    if (!sourceId) return res.status(400).json({ error: 'sourceId requerido' });
    if (!REVIEW_STATUSES.includes(status)) return res.status(400).json({ error: 'status invalido (pendiente|verificado|corregido|error)' });
    const note = typeof b.note === 'string' ? b.note.trim().slice(0, 1000) : null;

    const now = new Date().toISOString();
    const _id = `${sourceType}:${sourceId}`;
    await mongo.collection('seagle_reviews').updateOne(
      { _id },
      { $set: { sourceType, sourceId, status, note, reviewedBy: req.user, updatedAt: now }, $setOnInsert: { createdAt: now } },
      { upsert: true },
    );
    await appendSeagleLog(mongo, { action: 'review.set', actorId: req.user, detail: { sourceType, sourceId, status, note } });

    const updated = await mongo.collection('seagle_reviews').findOne({ _id });
    res.status(201).json(withId(updated));
  });

  /* ---- compartir correccion de vuelta al bunker Herzog ----
   * Escribe directo en herzog_notes (misma db, mismo esquema que herzog.js) con
   * tag origin:seagle — Herzog solo almacena, no valida el origen de la nota. */

  router.post('/api/seagle/herzog/share', ...guard, async (req, res) => {
    const b = req.body || {};
    const text = String(b.text || '').trim();
    if (!text) return res.status(400).json({ error: 'text requerido' });
    const department = typeof b.department === 'string' ? b.department.trim().slice(0, 60) : 'sin-especificar';
    const sourceType = SOURCE_TYPES.includes(b.sourceType) ? b.sourceType : null;
    const sourceId = typeof b.sourceId === 'string' ? b.sourceId : null;

    const doc = {
      _id: crypto.randomUUID(),
      department,
      text: text.slice(0, 4000),
      tags: ['origin:seagle', ...(sourceType ? [`ref:${sourceType}`] : [])],
      authorId: req.user,
      createdAt: new Date().toISOString(),
    };
    await mongo.collection('herzog_notes').insertOne(doc);
    await appendSeagleLog(mongo, { action: 'herzog.share', actorId: req.user, detail: { noteId: doc._id, department, sourceType, sourceId } });

    if (sourceType && sourceId) {
      const _id = `${sourceType}:${sourceId}`;
      const now = new Date().toISOString();
      await mongo.collection('seagle_reviews').updateOne(
        { _id },
        { $set: { sourceType, sourceId, status: 'corregido', note: text.slice(0, 1000), reviewedBy: req.user, updatedAt: now }, $setOnInsert: { createdAt: now } },
        { upsert: true },
      );
    }

    res.status(201).json(withId(doc));
  });

  /* ---- resumen (health-check dashboard) ---- */

  router.get('/api/seagle/summary', ...guard, async (req, res) => {
    const [reviews, sharedCount] = await Promise.all([
      mongo.collection('seagle_reviews').find({}).toArray(),
      mongo.collection('herzog_notes').countDocuments({ tags: 'origin:seagle' }),
    ]);
    const byStatus = { pendiente: 0, verificado: 0, corregido: 0, error: 0 };
    for (const r of reviews) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    res.json({
      reviewsTotal: reviews.length,
      byStatus,
      sharedToHerzog: sharedCount,
      metricsOwn: null, // placeholder — variables/metricas propias de S-EAGLE, por desarrollar
    });
  });

  /* ---- integridad del log ---- */

  router.get('/api/seagle/log/verify', ...guard, async (req, res) => {
    res.json(await verifyLog(mongo, 'seagle_log'));
  });
}
