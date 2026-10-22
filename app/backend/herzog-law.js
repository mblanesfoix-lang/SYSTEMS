/**
 * Herzog LaW: registro de marcos normativos (ISO, directivas y reglamentos de la
 * UE, marco local de Argelia, titulos del Estado) con su estado, requisitos,
 * certificados, documentos y vencimientos, mas el registro de zonas ATEX y un
 * simulador orientativo de CBAM.
 *
 * Herzog guarda y avisa, no decide: el estado de cada marco lo declara una
 * persona. Todo cambio queda en herzog_law_log (cadena de hashes). Comparte la
 * mesa 'herzog' con Herzog PG, asi que hereda sus permisos.
 *
 * El catalogo inicial se siembra de forma perezosa en el primer acceso de cada
 * tenant; solo inserta los marcos que faltan y nunca pisa lo ya editado.
 */

import crypto from 'node:crypto';
import express from 'express';
import { GridFSBucket, ObjectId } from 'mongodb';
import { runAsTenant, tenantContext } from './db/tenant-context.js';
import { DEFAULT_TENANT_ID } from './db/tenant-registry.js';
import { appendChained, verifyLog } from './lib/hash-chain.js';
import { SEED_VERSION, FRAMEWORK_SEED, CBAM_REFERENCE, ZONE_REFERENCE } from './herzog-law-data.js';
import {
  ALERT_RANK, expiryState, readiness, parseDateOnly, zoneCategory, validZonesFor, parseCbamInput, estimateCbam,
} from './lib/law-calc.js';

const KINDS = ['iso', 'ue', 'local', 'titulo', 'otro'];
const NATURES = ['obligatoria', 'voluntaria', 'indirecta'];
const PRIORITIES = ['alta', 'media', 'vigilar'];
const STATUSES = ['no_iniciado', 'en_preparacion', 'vigente', 'no_aplica'];
const JURISDICTIONS = ['UE', 'ES', 'DZ', 'INT'];
const ZONE_KINDS = ['polvo', 'gas'];
const ZONE_STATUSES = ['pendiente', 'clasificada', 'protegida'];
const UNCLASSIFIED = 'sin_clasificar';
const PRIORITY_ORDER = { alta: 0, media: 1, vigilar: 2 };

const DOCUMENT_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
const MAX_DOCUMENTS = 300;
const MAX_FRAMEWORKS = 200;
const MAX_ZONES = 200;
const MAX_REQUIREMENTS = 40;
const EXPIRY_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;

/* Campos de texto del marco: solo se editan en los creados a mano, no en los del catalogo. */
const OWN_TEXT_FIELDS = ['code', 'title', 'summary', 'why', 'appliesWhen', 'family', 'kind', 'nature', 'jurisdictions'];

const LOG = 'herzog_law_log';
const appendLawLog = (mongo, entry) => appendChained(mongo, LOG, entry);

const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const textOrNull = (value, max) => text(value, max) || null;

/* Devuelve el valor si esta permitido, el valor por defecto si no se envio y null si es invalido. */
function oneOf(value, allowed, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return allowed.includes(value) ? value : null;
}

function frameworkView(doc, now) {
  const { _id, ...rest } = doc;
  return { id: _id, ...rest, readiness: readiness(doc.requirements), expiry: expiryState(doc.expiresAt, now) };
}

function zoneView(doc) {
  const { _id, ...rest } = doc;
  return { id: _id, ...rest, requiredCategory: zoneCategory(doc.kind, doc.zone) };
}

function documentView(f) {
  return {
    id: f._id.toString(),
    filename: f.filename,
    contentType: f.metadata?.content_type || 'application/octet-stream',
    size: f.length,
    frameworkId: f.metadata?.framework_id || null,
    uploadedBy: f.metadata?.uploaded_by || null,
    uploadedAt: f.metadata?.uploaded_at || f.uploadDate?.toISOString?.() || null,
  };
}

const documentsBucket = (mongo) => new GridFSBucket(mongo, { bucketName: 'herzog_law_documents' });

function seedDoc(f, now) {
  return {
    _id: f.id,
    code: f.code,
    title: f.title,
    kind: f.kind,
    family: f.family,
    jurisdictions: f.jurisdictions,
    nature: f.nature,
    appliesWhen: f.appliesWhen ?? null,
    priority: f.priority,
    summary: f.summary,
    why: f.why,
    requirements: f.requirements.map((t, i) => ({ id: `r${i + 1}`, text: t, done: false, doneAt: null, doneBy: null, custom: false })),
    references: f.references ?? [],
    status: 'no_iniciado',
    issuer: null,
    certNumber: null,
    issuedAt: null,
    expiresAt: null,
    owner: null,
    notes: null,
    alert: null,
    seed: true,
    createdAt: now,
    updatedAt: now,
    updatedBy: 'system',
  };
}

async function applySeed(mongo) {
  const meta = mongo.collection('herzog_law_meta');
  const current = await meta.findOne({ _id: 'seed' });
  if (current && current.version >= SEED_VERSION) return;
  const now = new Date().toISOString();
  let inserted = 0;
  try {
    const result = await mongo.collection('herzog_law_frameworks').bulkWrite(
      FRAMEWORK_SEED.map((f) => ({ updateOne: { filter: { _id: f.id }, update: { $setOnInsert: seedDoc(f, now) }, upsert: true } })),
      { ordered: false },
    );
    inserted = result.upsertedCount;
  } catch (err) {
    // Otro proceso sembro a la vez y choco en el upsert del mismo _id: lo que falta ya lo inserto el.
    if (err?.code !== 11000) throw err;
    inserted = err.result?.upsertedCount ?? 0;
  }
  await meta.updateOne({ _id: 'seed' }, { $set: { version: SEED_VERSION, appliedAt: now } }, { upsert: true });
  if (inserted > 0) {
    await appendLawLog(mongo, { action: 'catalog.seed', actorId: 'system', detail: { version: SEED_VERSION, inserted } });
  }
}

/* Una sola siembra en vuelo por tenant: las peticiones simultaneas de la primera carga la comparten. */
const seedsInFlight = new Map();
function ensureSeed(mongo) {
  const tenant = tenantContext.getStore()?.tenantId ?? 'default';
  if (!seedsInFlight.has(tenant)) {
    seedsInFlight.set(tenant, applySeed(mongo).finally(() => seedsInFlight.delete(tenant)));
  }
  return seedsInFlight.get(tenant);
}

/**
 * Avisa al Admin una vez por cada empeoramiento de un vencimiento (proximo, critico,
 * vencido). El nivel avisado se guarda en el marco y se reinicia al cambiar la fecha.
 */
async function checkExpiries(mongo, adminNotify) {
  const col = mongo.collection('herzog_law_frameworks');
  const rows = await col.find({ status: 'vigente', expiresAt: { $type: 'string' } }).toArray();
  const now = new Date();
  for (const row of rows) {
    const { state, days } = expiryState(row.expiresAt, now);
    const rank = ALERT_RANK[state];
    if (!rank || rank <= (ALERT_RANK[row.alert?.level] ?? 0)) continue;
    const when = state === 'vencido' ? `venció hace ${Math.abs(days)} días` : `vence en ${days} días`;
    adminNotify?.({
      origin: 'HERZOG',
      severity: 'warning',
      label: `Herzog LaW · ${row.code} ${when}`,
      detail: `${row.title}. Fecha de vencimiento: ${row.expiresAt}. Renovarlo o actualizar la fecha en Herzog LaW.`,
    });
    await col.updateOne({ _id: row._id }, { $set: { alert: { level: state, at: now.toISOString() } } });
  }
}

/** Valida el cuerpo de una zona ATEX completada con la zona actual; devuelve { value } o { error }. */
function resolveZone(body, current) {
  const b = body || {};
  const name = 'name' in b ? text(b.name, 120) : current?.name ?? '';
  if (!name) return { error: 'name requerido' };
  const kind = oneOf(b.kind, ZONE_KINDS, current?.kind ?? 'polvo');
  if (kind === null) return { error: 'kind no valido' };

  const zone = 'zone' in b ? String(b.zone ?? '') : current?.zone ?? UNCLASSIFIED;
  if (zone !== UNCLASSIFIED && !validZonesFor(kind).includes(zone)) {
    return { error: `La zona ${zone} no corresponde a ${kind}. Válidas: ${validZonesFor(kind).join(', ')} o ${UNCLASSIFIED}` };
  }
  // Sin estado explicito, el estado sigue a la zona: clasificar la marca como clasificada.
  const zoneChanged = !current || zone !== current.zone;
  const fallbackStatus = zone === UNCLASSIFIED ? 'pendiente' : (zoneChanged || current.status === 'pendiente' ? 'clasificada' : current.status);
  const status = oneOf(b.status, ZONE_STATUSES, fallbackStatus);
  if (status === null) return { error: 'status no valido' };
  if (zone === UNCLASSIFIED && status !== 'pendiente') return { error: 'Una zona sin clasificar solo puede estar pendiente' };
  if (zone !== UNCLASSIFIED && status === 'pendiente') return { error: 'Una zona clasificada no puede estar pendiente' };

  return {
    value: {
      name,
      location: 'location' in b ? textOrNull(b.location, 160) : current?.location ?? null,
      kind,
      substance: 'substance' in b ? textOrNull(b.substance, 200) : current?.substance ?? null,
      zone,
      status,
      equipment: 'equipment' in b ? textOrNull(b.equipment, 300) : current?.equipment ?? null,
      notes: 'notes' in b ? textOrNull(b.notes, 2000) : current?.notes ?? null,
    },
  };
}

export function mountHerzogLaw(app, { auth, requireMesa, mongo, adminNotify }) {
  const router = app;
  const guard = [auth, requireMesa('herzog')];
  const frameworks = () => mongo.collection('herzog_law_frameworks');
  const zones = () => mongo.collection('herzog_law_zones');

  const withSeed = async (req, res, next) => {
    try { await ensureSeed(mongo); next(); } catch (err) { next(err); }
  };
  const seeded = [...guard, withSeed];

  // Cron de arranque, fuera de cualquier request: corre contra el tenant por defecto.
  // unref para no mantener vivo un proceso de pruebas o scripts aislados.
  const runExpiryCheck = () => runAsTenant(DEFAULT_TENANT_ID, () => checkExpiries(mongo, adminNotify)
    .catch((err) => console.error('[herzog-law] vencimientos:', err.message)));
  runExpiryCheck();
  setInterval(runExpiryCheck, EXPIRY_CHECK_INTERVAL_MS).unref();

  /* ---- marcos normativos ---- */

  router.get('/api/herzog-law/frameworks', ...seeded, async (req, res) => {
    const q = {};
    for (const key of ['kind', 'priority', 'status']) if (req.query[key]) q[key] = String(req.query[key]);
    const rows = await frameworks().find(q).toArray();
    rows.sort((a, b) => (PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]) || a.code.localeCompare(b.code, 'es'));
    const now = new Date();
    res.json(rows.map((r) => frameworkView(r, now)));
  });

  router.get('/api/herzog-law/frameworks/:id', ...seeded, async (req, res) => {
    const doc = await frameworks().findOne({ _id: req.params.id });
    if (!doc) return res.status(404).json({ error: 'Marco no encontrado' });
    res.json(frameworkView(doc, new Date()));
  });

  router.post('/api/herzog-law/frameworks', ...seeded, async (req, res) => {
    const b = req.body || {};
    const code = text(b.code, 60);
    const title = text(b.title, 200);
    if (!code) return res.status(400).json({ error: 'code requerido' });
    if (!title) return res.status(400).json({ error: 'title requerido' });
    const kind = oneOf(b.kind, KINDS, 'otro');
    const nature = oneOf(b.nature, NATURES, 'voluntaria');
    const priority = oneOf(b.priority, PRIORITIES, 'media');
    if (kind === null) return res.status(400).json({ error: 'kind no valido' });
    if (nature === null) return res.status(400).json({ error: 'nature no valido' });
    if (priority === null) return res.status(400).json({ error: 'priority no valido' });
    const jurisdictions = b.jurisdictions === undefined ? [] : b.jurisdictions;
    if (!Array.isArray(jurisdictions) || jurisdictions.some((j) => !JURISDICTIONS.includes(j))) {
      return res.status(400).json({ error: `jurisdictions debe ser una lista de: ${JURISDICTIONS.join(', ')}` });
    }
    const requirementTexts = Array.isArray(b.requirements) ? b.requirements.map((t) => text(t, 300)).filter(Boolean).slice(0, MAX_REQUIREMENTS) : [];
    if (await frameworks().countDocuments({}) >= MAX_FRAMEWORKS) {
      return res.status(400).json({ error: `Máximo ${MAX_FRAMEWORKS} marcos` });
    }

    const now = new Date().toISOString();
    const doc = {
      _id: `custom-${crypto.randomUUID()}`,
      code,
      title,
      kind,
      family: textOrNull(b.family, 60) || (kind === 'titulo' ? 'Títulos del Estado' : 'Otros'),
      jurisdictions: [...new Set(jurisdictions)],
      nature,
      appliesWhen: textOrNull(b.appliesWhen, 500),
      priority,
      summary: textOrNull(b.summary, 800),
      why: textOrNull(b.why, 800),
      requirements: requirementTexts.map((t, i) => ({ id: `c${i + 1}`, text: t, done: false, doneAt: null, doneBy: null, custom: true })),
      references: [],
      status: 'no_iniciado',
      issuer: null,
      certNumber: null,
      issuedAt: null,
      expiresAt: null,
      owner: null,
      notes: null,
      alert: null,
      seed: false,
      createdAt: now,
      updatedAt: now,
      updatedBy: req.user,
    };
    await frameworks().insertOne(doc);
    await appendLawLog(mongo, { action: 'framework.create', actorId: req.user, detail: { frameworkId: doc._id, code, kind } });
    res.status(201).json(frameworkView(doc, new Date()));
  });

  router.patch('/api/herzog-law/frameworks/:id', ...seeded, async (req, res) => {
    const current = await frameworks().findOne({ _id: req.params.id });
    if (!current) return res.status(404).json({ error: 'Marco no encontrado' });
    const b = req.body || {};
    if (current.seed && OWN_TEXT_FIELDS.some((k) => k in b)) {
      return res.status(400).json({ error: 'Los textos de un marco del catálogo no se pueden editar' });
    }

    const set = {};
    if ('status' in b) {
      if (!STATUSES.includes(b.status)) return res.status(400).json({ error: 'status no valido' });
      set.status = b.status;
    }
    if ('priority' in b) {
      if (!PRIORITIES.includes(b.priority)) return res.status(400).json({ error: 'priority no valido' });
      set.priority = b.priority;
    }
    if ('issuer' in b) set.issuer = textOrNull(b.issuer, 160);
    if ('owner' in b) set.owner = textOrNull(b.owner, 120);
    if ('certNumber' in b) set.certNumber = textOrNull(b.certNumber, 80);
    if ('notes' in b) set.notes = textOrNull(b.notes, 4000);
    for (const key of ['issuedAt', 'expiresAt']) {
      if (!(key in b)) continue;
      if (b[key] === null || b[key] === '') { set[key] = null; continue; }
      const date = parseDateOnly(b[key]);
      if (!date) return res.status(400).json({ error: `${key} debe ser una fecha AAAA-MM-DD válida` });
      set[key] = date;
    }
    if (!current.seed) {
      if ('code' in b) { set.code = text(b.code, 60); if (!set.code) return res.status(400).json({ error: 'code requerido' }); }
      if ('title' in b) { set.title = text(b.title, 200); if (!set.title) return res.status(400).json({ error: 'title requerido' }); }
      for (const [key, max] of [['summary', 800], ['why', 800], ['appliesWhen', 500]]) if (key in b) set[key] = textOrNull(b[key], max);
      if ('family' in b) set.family = textOrNull(b.family, 60) || 'Otros';
      if ('kind' in b) { if (!KINDS.includes(b.kind)) return res.status(400).json({ error: 'kind no valido' }); set.kind = b.kind; }
      if ('nature' in b) { if (!NATURES.includes(b.nature)) return res.status(400).json({ error: 'nature no valido' }); set.nature = b.nature; }
      if ('jurisdictions' in b) {
        if (!Array.isArray(b.jurisdictions) || b.jurisdictions.some((j) => !JURISDICTIONS.includes(j))) {
          return res.status(400).json({ error: `jurisdictions debe ser una lista de: ${JURISDICTIONS.join(', ')}` });
        }
        set.jurisdictions = [...new Set(b.jurisdictions)];
      }
    }
    if (Object.keys(set).length === 0) return res.status(400).json({ error: 'Nada que actualizar' });

    const issuedAt = 'issuedAt' in set ? set.issuedAt : current.issuedAt;
    const expiresAt = 'expiresAt' in set ? set.expiresAt : current.expiresAt;
    if (issuedAt && expiresAt && expiresAt < issuedAt) {
      return res.status(400).json({ error: 'expiresAt no puede ser anterior a issuedAt' });
    }

    const changed = Object.keys(set).filter((k) => JSON.stringify(set[k]) !== JSON.stringify(current[k]));
    if (changed.length === 0) return res.json(frameworkView(current, new Date()));

    if (changed.includes('expiresAt')) set.alert = null;
    set.updatedAt = new Date().toISOString();
    set.updatedBy = req.user;
    await frameworks().updateOne({ _id: current._id }, { $set: set });

    const values = {};
    for (const k of changed) if (k !== 'notes' && k !== 'jurisdictions') values[k] = set[k];
    await appendLawLog(mongo, { action: 'framework.update', actorId: req.user, detail: { frameworkId: current._id, code: current.code, changed, values } });
    res.json(frameworkView(await frameworks().findOne({ _id: current._id }), new Date()));
  });

  router.delete('/api/herzog-law/frameworks/:id', ...seeded, async (req, res) => {
    const current = await frameworks().findOne({ _id: req.params.id });
    if (!current) return res.status(404).json({ error: 'Marco no encontrado' });
    if (current.seed) return res.status(409).json({ error: 'Un marco del catálogo no se borra: márcalo como «No aplica»' });

    const files = await mongo.collection('herzog_law_documents.files').find({ 'metadata.framework_id': current._id }).toArray();
    for (const f of files) await documentsBucket(mongo).delete(f._id);
    await frameworks().deleteOne({ _id: current._id });
    await appendLawLog(mongo, { action: 'framework.delete', actorId: req.user, detail: { frameworkId: current._id, code: current.code, documents: files.length } });
    res.json({ id: current._id });
  });

  /* ---- requisitos de un marco ---- */

  router.post('/api/herzog-law/frameworks/:id/requirements', ...seeded, async (req, res) => {
    const requirementText = text(req.body?.text, 300);
    if (!requirementText) return res.status(400).json({ error: 'text requerido' });
    const exists = await frameworks().findOne({ _id: req.params.id }, { projection: { _id: 1 } });
    if (!exists) return res.status(404).json({ error: 'Marco no encontrado' });

    const requirement = { id: `c${crypto.randomUUID().slice(0, 8)}`, text: requirementText, done: false, doneAt: null, doneBy: null, custom: true };
    // El filtro sobre el indice MAX-1 hace atomico el tope de requisitos por marco.
    const result = await frameworks().updateOne(
      { _id: req.params.id, [`requirements.${MAX_REQUIREMENTS - 1}`]: { $exists: false } },
      { $push: { requirements: requirement }, $set: { updatedAt: new Date().toISOString(), updatedBy: req.user } },
    );
    if (result.matchedCount === 0) return res.status(400).json({ error: `Máximo ${MAX_REQUIREMENTS} requisitos por marco` });
    await appendLawLog(mongo, { action: 'requirement.add', actorId: req.user, detail: { frameworkId: req.params.id, requirementId: requirement.id } });
    res.status(201).json(frameworkView(await frameworks().findOne({ _id: req.params.id }), new Date()));
  });

  router.patch('/api/herzog-law/frameworks/:id/requirements/:reqId', ...seeded, async (req, res) => {
    if (typeof req.body?.done !== 'boolean') return res.status(400).json({ error: 'done debe ser true o false' });
    const done = req.body.done;
    const now = new Date().toISOString();
    const result = await frameworks().updateOne(
      { _id: req.params.id, 'requirements.id': req.params.reqId },
      { $set: { 'requirements.$.done': done, 'requirements.$.doneAt': done ? now : null, 'requirements.$.doneBy': done ? req.user : null, updatedAt: now, updatedBy: req.user } },
    );
    if (result.matchedCount === 0) return res.status(404).json({ error: 'Requisito no encontrado' });
    await appendLawLog(mongo, { action: 'requirement.toggle', actorId: req.user, detail: { frameworkId: req.params.id, requirementId: req.params.reqId, done } });
    res.json(frameworkView(await frameworks().findOne({ _id: req.params.id }), new Date()));
  });

  router.delete('/api/herzog-law/frameworks/:id/requirements/:reqId', ...seeded, async (req, res) => {
    const current = await frameworks().findOne({ _id: req.params.id });
    if (!current) return res.status(404).json({ error: 'Marco no encontrado' });
    const target = current.requirements.find((r) => r.id === req.params.reqId);
    if (!target) return res.status(404).json({ error: 'Requisito no encontrado' });
    if (!target.custom) return res.status(409).json({ error: 'Los requisitos del catálogo no se pueden borrar' });
    await frameworks().updateOne(
      { _id: current._id },
      { $pull: { requirements: { id: target.id, custom: true } }, $set: { updatedAt: new Date().toISOString(), updatedBy: req.user } },
    );
    await appendLawLog(mongo, { action: 'requirement.delete', actorId: req.user, detail: { frameworkId: current._id, requirementId: target.id } });
    res.json(frameworkView(await frameworks().findOne({ _id: current._id }), new Date()));
  });

  /* ---- documentos (certificados y evidencias) ---- */

  router.get('/api/herzog-law/documents', ...guard, async (req, res) => {
    const q = req.query.frameworkId ? { 'metadata.framework_id': String(req.query.frameworkId) } : {};
    const files = await mongo.collection('herzog_law_documents.files').find(q).sort({ uploadDate: -1 }).toArray();
    res.json(files.map(documentView));
  });

  router.post('/api/herzog-law/documents', auth, requireMesa('herzog'), express.raw({ type: DOCUMENT_TYPES, limit: '20mb' }), async (req, res, next) => {
    const contentType = String(req.headers['content-type'] || '');
    if (!DOCUMENT_TYPES.includes(contentType)) {
      return res.status(415).json({ error: 'Formato no permitido. PDF, imagen (JPG/PNG/WebP) o documento Word (DOCX).' });
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: 'Archivo vacío o ilegible' });
    }
    const frameworkId = String(req.headers['x-framework'] || '');
    if (!frameworkId) return res.status(400).json({ error: 'Cabecera X-Framework requerida' });
    const exists = await frameworks().findOne({ _id: frameworkId }, { projection: { _id: 1 } });
    if (!exists) return res.status(404).json({ error: 'Marco no encontrado' });
    if (await mongo.collection('herzog_law_documents.files').countDocuments({}) >= MAX_DOCUMENTS) {
      return res.status(400).json({ error: `Máximo ${MAX_DOCUMENTS} documentos en Herzog LaW` });
    }
    let filename = 'archivo';
    try { filename = decodeURIComponent(String(req.headers['x-filename'] || 'archivo')); } catch { /* nombre ilegible: se queda el generico */ }
    filename = filename.slice(0, 180);

    const uploadedAt = new Date().toISOString();
    const upload = documentsBucket(mongo).openUploadStream(filename, {
      metadata: { framework_id: frameworkId, uploaded_by: req.user, uploaded_at: uploadedAt, content_type: contentType },
    });
    upload.on('error', () => {
      if (!res.headersSent) res.status(500).json({ error: 'Error al guardar el documento' });
    });
    // Escucha de un evento: su fallo no vuelve a la ruta, se pasa a mano al manejador de errores.
    upload.on('finish', async () => {
      try {
        await appendLawLog(mongo, { action: 'document.upload', actorId: req.user, detail: { fileId: upload.id.toString(), filename, frameworkId } });
        res.status(201).json({ id: upload.id.toString(), filename, contentType, size: req.body.length, frameworkId, uploadedBy: req.user, uploadedAt });
      } catch (err) {
        next(err);
      }
    });
    upload.end(req.body);
  });

  router.get('/api/herzog-law/documents/:fileId', ...guard, async (req, res) => {
    let oid;
    try { oid = new ObjectId(String(req.params.fileId)); } catch { return res.status(400).json({ error: 'Id de documento inválido' }); }
    const file = await mongo.collection('herzog_law_documents.files').findOne({ _id: oid });
    if (!file) return res.status(404).json({ error: 'Documento no encontrado' });
    res.setHeader('Content-Type', file.metadata?.content_type || 'application/octet-stream');
    res.setHeader('Content-Length', String(file.length));
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    const stream = documentsBucket(mongo).openDownloadStream(oid);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });

  router.delete('/api/herzog-law/documents/:fileId', ...guard, async (req, res) => {
    let oid;
    try { oid = new ObjectId(String(req.params.fileId)); } catch { return res.status(400).json({ error: 'Id de documento inválido' }); }
    const file = await mongo.collection('herzog_law_documents.files').findOne({ _id: oid });
    if (!file) return res.status(404).json({ error: 'Documento no encontrado' });
    await documentsBucket(mongo).delete(oid);
    await appendLawLog(mongo, { action: 'document.delete', actorId: req.user, detail: { fileId: req.params.fileId, filename: file.filename, frameworkId: file.metadata?.framework_id ?? null } });
    res.json({ id: req.params.fileId });
  });

  /* ---- registro de zonas ATEX ---- */

  router.get('/api/herzog-law/zones/reference', ...guard, (req, res) => {
    res.json(ZONE_REFERENCE);
  });

  router.get('/api/herzog-law/zones', ...guard, async (req, res) => {
    const rows = await zones().find({}).sort({ createdAt: 1 }).toArray();
    res.json(rows.map(zoneView));
  });

  router.post('/api/herzog-law/zones', ...guard, async (req, res) => {
    const parsed = resolveZone(req.body, null);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    if (await zones().countDocuments({}) >= MAX_ZONES) return res.status(400).json({ error: `Máximo ${MAX_ZONES} zonas` });
    const now = new Date().toISOString();
    const doc = { _id: crypto.randomUUID(), ...parsed.value, createdAt: now, updatedAt: now, updatedBy: req.user };
    await zones().insertOne(doc);
    await appendLawLog(mongo, { action: 'zone.create', actorId: req.user, detail: { zoneId: doc._id, name: doc.name, kind: doc.kind, zone: doc.zone } });
    res.status(201).json(zoneView(doc));
  });

  router.patch('/api/herzog-law/zones/:id', ...guard, async (req, res) => {
    const current = await zones().findOne({ _id: req.params.id });
    if (!current) return res.status(404).json({ error: 'Zona no encontrada' });
    const parsed = resolveZone(req.body, current);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const update = { ...parsed.value, updatedAt: new Date().toISOString(), updatedBy: req.user };
    await zones().updateOne({ _id: current._id }, { $set: update });
    await appendLawLog(mongo, { action: 'zone.update', actorId: req.user, detail: { zoneId: current._id, name: update.name, kind: update.kind, zone: update.zone, status: update.status } });
    res.json(zoneView({ ...current, ...update }));
  });

  router.delete('/api/herzog-law/zones/:id', ...guard, async (req, res) => {
    const current = await zones().findOne({ _id: req.params.id });
    if (!current) return res.status(404).json({ error: 'Zona no encontrada' });
    await zones().deleteOne({ _id: current._id });
    await appendLawLog(mongo, { action: 'zone.delete', actorId: req.user, detail: { zoneId: current._id, name: current.name } });
    res.json({ id: current._id });
  });

  /* ---- CBAM ---- */

  router.get('/api/herzog-law/cbam/reference', ...guard, (req, res) => {
    res.json(CBAM_REFERENCE);
  });

  router.post('/api/herzog-law/cbam/estimate', ...guard, (req, res) => {
    const parsed = parseCbamInput(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    res.json({ input: parsed.value, ...estimateCbam(parsed.value) });
  });

  /* ---- resumen y actividad ---- */

  router.get('/api/herzog-law/summary', ...seeded, async (req, res) => {
    const [rows, zoneRows, documentsCount] = await Promise.all([
      frameworks().find({}).toArray(),
      zones().find({}).toArray(),
      mongo.collection('herzog_law_documents.files').countDocuments({}),
    ]);
    const now = new Date();
    const count = (list, key) => list.reduce((acc, item) => ({ ...acc, [item[key]]: (acc[item[key]] ?? 0) + 1 }), {});

    // Preparacion de los marcos de prioridad alta que aplican: requisitos cumplidos sobre el total.
    const high = rows.filter((r) => r.priority === 'alta' && r.status !== 'no_aplica');
    const highRequirements = high.flatMap((r) => r.requirements);

    const upcoming = rows
      .filter((r) => r.status === 'vigente')
      .map((r) => ({ id: r._id, code: r.code, title: r.title, expiresAt: r.expiresAt, ...expiryState(r.expiresAt, now) }))
      .filter((r) => ALERT_RANK[r.state])
      .sort((a, b) => a.days - b.days);

    res.json({
      frameworksCount: rows.length,
      byStatus: count(rows, 'status'),
      byKind: count(rows, 'kind'),
      highPriority: { frameworks: high.length, readiness: readiness(highRequirements) },
      upcoming,
      zones: { total: zoneRows.length, byStatus: count(zoneRows, 'status') },
      documentsCount,
    });
  });

  router.get('/api/herzog-law/activity', ...guard, async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 20), 1), 100);
    const rows = await mongo.collection(LOG).find({}).sort({ seq: -1 }).limit(limit).toArray();
    res.json(rows.map(({ _id, seq, action, actorId, detail, createdAt }) => ({ id: _id, seq, action, actorId, detail, createdAt })));
  });

  /* ---- integridad del log ---- */

  router.get('/api/herzog-law/log/verify', ...guard, async (req, res) => {
    res.json(await verifyLog(mongo, LOG));
  });
}
