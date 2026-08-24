/**
 * Pactvm Viridi — guardian doctrinal, cientifico y de cumplimiento bio-ambiental.
 *
 * Alcance: certificado CIBE (sello de estandar circular S-NFI), parametrizacion
 * de politicas medioambientales, condiciones de acceso bajo sello CIBE, y
 * lectura (sin escritura) de las auditorias Herzog para fundamentar el
 * dictamen de cumplimiento.
 *
 * Mismo patron que S-NFI Finance/FL/M&A: CRUD directo sobre Mongo, sin router
 * TS separado, log inmutable propio (pactvm_log, hash chain). Herzog vive en
 * la app Reff (db 'reff', coleccion herzog_audits) — Pactvm Viridi solo lee,
 * nunca escribe ahi ni juzga el veredicto (esa autoridad es de Herzog/Reff).
 */

import crypto from 'node:crypto';

const CIBE_STATUSES = ['pendiente', 'emitido', 'suspendido', 'revocado'];
const POLICY_CATEGORIES = ['quimico', 'circularidad', 'energia', 'residuo', 'otro'];
const ACCESS_SCOPES = ['empresa', 'mesa', 'rol'];
const ACCESS_STATUSES = ['activo', 'suspendido'];

function withId(doc) {
  if (!doc) return doc;
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
}

function canonical(entry) {
  return JSON.stringify(entry, Object.keys(entry).sort());
}

async function appendPactvmLog(mongo, entry) {
  const col = mongo.collection('pactvm_log');
  const tail = await col.find().sort({ seq: -1 }).limit(1).next();
  const seq = tail ? tail.seq + 1 : 1;
  const prevHash = tail ? tail.hash : '0'.repeat(64);
  const canonicalEntry = { ...entry, seq };
  const hash = crypto.createHash('sha256').update(prevHash + canonical(canonicalEntry)).digest('hex');
  const doc = { _id: crypto.randomUUID(), ...entry, seq, prevHash, hash, createdAt: new Date().toISOString() };
  await col.insertOne(doc);
  return doc;
}

export function mountPactvm(app, { auth, requireMesa, mongo, getMongoClient, getU2Snapshot }) {
  const router = app;
  const guard = [auth, requireMesa('pactvm')];
  const herzogAudits = () => getMongoClient().db('reff').collection('herzog_audits');

  /* ---- certificados CIBE ---- */

  router.get('/api/pactvm/cibe', ...guard, async (req, res) => {
    const rows = await mongo.collection('pactvm_cibe').find({}).sort({ _id: -1 }).toArray();
    res.json(rows.map(withId));
  });

  router.post('/api/pactvm/cibe', ...guard, async (req, res) => {
    const b = req.body || {};
    const entityName = String(b.entityName || '').trim();
    if (!entityName) return res.status(400).json({ error: 'entityName requerido' });
    const doc = {
      _id: crypto.randomUUID(),
      entityName,
      sector: typeof b.sector === 'string' ? b.sector.trim().slice(0, 200) : '',
      status: 'pendiente',
      auditF4Date: typeof b.auditF4Date === 'string' && b.auditF4Date && !Number.isNaN(Date.parse(b.auditF4Date)) ? b.auditF4Date : null,
      herzogAuditId: typeof b.herzogAuditId === 'string' && b.herzogAuditId ? b.herzogAuditId : null,
      notes: typeof b.notes === 'string' ? b.notes.trim().slice(0, 1000) : '',
      createdBy: req.user,
      createdAt: new Date().toISOString(),
    };
    await mongo.collection('pactvm_cibe').insertOne(doc);
    await appendPactvmLog(mongo, { action: 'cibe.create', actorId: req.user, detail: { cibeId: doc._id, entityName } });
    res.status(201).json(withId(doc));
  });

  router.patch('/api/pactvm/cibe/:id', ...guard, async (req, res) => {
    const row = await mongo.collection('pactvm_cibe').findOne({ _id: req.params.id });
    if (!row) return res.status(404).json({ error: 'certificado no encontrado' });
    const b = req.body || {};
    const $set = {};
    if (b.status !== undefined) {
      if (!CIBE_STATUSES.includes(b.status)) return res.status(400).json({ error: 'status invalido' });
      $set.status = b.status;
    }
    if (b.auditF4Date !== undefined) {
      if (b.auditF4Date && Number.isNaN(Date.parse(b.auditF4Date))) return res.status(400).json({ error: 'auditF4Date invalido' });
      $set.auditF4Date = b.auditF4Date || null;
    }
    if (b.notes !== undefined) $set.notes = String(b.notes).trim().slice(0, 1000);
    if (Object.keys($set).length > 0) {
      await mongo.collection('pactvm_cibe').updateOne({ _id: req.params.id }, { $set });
      await appendPactvmLog(mongo, { action: 'cibe.update', actorId: req.user, detail: { cibeId: req.params.id, $set } });
    }
    const updated = await mongo.collection('pactvm_cibe').findOne({ _id: req.params.id });
    res.json(withId(updated));
  });

  router.delete('/api/pactvm/cibe/:id', ...guard, async (req, res) => {
    const result = await mongo.collection('pactvm_cibe').deleteOne({ _id: req.params.id });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'certificado no encontrado' });
    await appendPactvmLog(mongo, { action: 'cibe.delete', actorId: req.user, detail: { cibeId: req.params.id } });
    res.json({ id: req.params.id });
  });

  /* ---- politicas medioambientales ---- */

  router.get('/api/pactvm/policies', ...guard, async (req, res) => {
    const rows = await mongo.collection('pactvm_policies').find({}).sort({ category: 1, name: 1 }).toArray();
    res.json(rows.map(withId));
  });

  router.post('/api/pactvm/policies', ...guard, async (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name requerido' });
    if (!POLICY_CATEGORIES.includes(b.category)) return res.status(400).json({ error: 'category invalida' });
    const threshold = b.threshold !== undefined && b.threshold !== null && b.threshold !== '' ? Number(b.threshold) : null;
    if (threshold !== null && !Number.isFinite(threshold)) return res.status(400).json({ error: 'threshold invalido' });
    const doc = {
      _id: crypto.randomUUID(),
      name,
      category: b.category,
      threshold,
      unit: typeof b.unit === 'string' ? b.unit.trim().slice(0, 50) : '',
      description: typeof b.description === 'string' ? b.description.trim().slice(0, 1000) : '',
      active: true,
      version: 1,
      createdBy: req.user,
      createdAt: new Date().toISOString(),
    };
    await mongo.collection('pactvm_policies').insertOne(doc);
    await appendPactvmLog(mongo, { action: 'policy.create', actorId: req.user, detail: { policyId: doc._id, name, category: b.category } });
    res.status(201).json(withId(doc));
  });

  router.patch('/api/pactvm/policies/:id', ...guard, async (req, res) => {
    const row = await mongo.collection('pactvm_policies').findOne({ _id: req.params.id });
    if (!row) return res.status(404).json({ error: 'politica no encontrada' });
    const b = req.body || {};
    const $set = {};
    if (b.threshold !== undefined) {
      const threshold = b.threshold !== null && b.threshold !== '' ? Number(b.threshold) : null;
      if (threshold !== null && !Number.isFinite(threshold)) return res.status(400).json({ error: 'threshold invalido' });
      $set.threshold = threshold;
    }
    if (b.unit !== undefined) $set.unit = String(b.unit).trim().slice(0, 50);
    if (b.description !== undefined) $set.description = String(b.description).trim().slice(0, 1000);
    if (b.active !== undefined) $set.active = !!b.active;
    if (Object.keys($set).length > 0) {
      $set.version = (row.version || 1) + 1;
      await mongo.collection('pactvm_policies').updateOne({ _id: req.params.id }, { $set });
      await appendPactvmLog(mongo, { action: 'policy.update', actorId: req.user, detail: { policyId: req.params.id, $set } });
    }
    const updated = await mongo.collection('pactvm_policies').findOne({ _id: req.params.id });
    res.json(withId(updated));
  });

  router.delete('/api/pactvm/policies/:id', ...guard, async (req, res) => {
    const result = await mongo.collection('pactvm_policies').deleteOne({ _id: req.params.id });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'politica no encontrada' });
    await appendPactvmLog(mongo, { action: 'policy.delete', actorId: req.user, detail: { policyId: req.params.id } });
    res.json({ id: req.params.id });
  });

  /* ---- condiciones de acceso bajo sello CIBE ---- */

  router.get('/api/pactvm/access-rules', ...guard, async (req, res) => {
    const rows = await mongo.collection('pactvm_access_rules').find({}).sort({ _id: -1 }).toArray();
    res.json(rows.map(withId));
  });

  router.post('/api/pactvm/access-rules', ...guard, async (req, res) => {
    const b = req.body || {};
    const subject = String(b.subject || '').trim();
    if (!subject) return res.status(400).json({ error: 'subject requerido' });
    if (!ACCESS_SCOPES.includes(b.scope)) return res.status(400).json({ error: 'scope invalido' });
    const target = String(b.target || '').trim();
    if (!target) return res.status(400).json({ error: 'target requerido' });
    const doc = {
      _id: crypto.randomUUID(),
      subject,
      scope: b.scope,
      target,
      status: 'activo',
      reason: typeof b.reason === 'string' ? b.reason.trim().slice(0, 500) : '',
      createdBy: req.user,
      createdAt: new Date().toISOString(),
    };
    await mongo.collection('pactvm_access_rules').insertOne(doc);
    await appendPactvmLog(mongo, { action: 'access_rule.create', actorId: req.user, detail: { ruleId: doc._id, subject, scope: b.scope, target } });
    res.status(201).json(withId(doc));
  });

  router.patch('/api/pactvm/access-rules/:id', ...guard, async (req, res) => {
    const row = await mongo.collection('pactvm_access_rules').findOne({ _id: req.params.id });
    if (!row) return res.status(404).json({ error: 'regla no encontrada' });
    const b = req.body || {};
    const $set = {};
    if (b.status !== undefined) {
      if (!ACCESS_STATUSES.includes(b.status)) return res.status(400).json({ error: 'status invalido' });
      $set.status = b.status;
    }
    if (b.reason !== undefined) $set.reason = String(b.reason).trim().slice(0, 500);
    if (Object.keys($set).length > 0) {
      await mongo.collection('pactvm_access_rules').updateOne({ _id: req.params.id }, { $set });
      await appendPactvmLog(mongo, { action: 'access_rule.update', actorId: req.user, detail: { ruleId: req.params.id, $set } });
    }
    const updated = await mongo.collection('pactvm_access_rules').findOne({ _id: req.params.id });
    res.json(withId(updated));
  });

  router.delete('/api/pactvm/access-rules/:id', ...guard, async (req, res) => {
    const result = await mongo.collection('pactvm_access_rules').deleteOne({ _id: req.params.id });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'regla no encontrada' });
    await appendPactvmLog(mongo, { action: 'access_rule.delete', actorId: req.user, detail: { ruleId: req.params.id } });
    res.json({ id: req.params.id });
  });

  /* ---- auditorias Herzog (solo lectura, coleccion vive en db 'reff') ---- */

  router.get('/api/pactvm/herzog-audits', ...guard, async (req, res) => {
    const rows = await herzogAudits().find({}).sort({ created_at: -1 }).limit(50).toArray();
    res.json(rows.map((r) => ({
      id: r._id?.toString?.() || r._id,
      companyName: r.company_name,
      classification: r.result_json?.classification || null,
      overall: r.result_json?.overall ?? null,
      summary: r.result_json?.summary || null,
      createdAt: r.created_at,
    })));
  });

  /* ---- resumen KPI ---- */

  router.get('/api/pactvm/summary', ...guard, async (req, res) => {
    const [cibeAll, policiesActive, accessRulesActive, herzogRecent] = await Promise.all([
      mongo.collection('pactvm_cibe').find({}).toArray(),
      mongo.collection('pactvm_policies').countDocuments({ active: true }),
      mongo.collection('pactvm_access_rules').countDocuments({ status: 'activo' }),
      herzogAudits().find({}).sort({ created_at: -1 }).limit(50).toArray(),
    ]);
    const cibeEmitidos = cibeAll.filter((c) => c.status === 'emitido').length;
    const cibePendientes = cibeAll.filter((c) => c.status === 'pendiente').length;
    const herzogNoCandidato = herzogRecent.filter((r) => r.result_json?.classification === 'NO_CANDIDATO').length;
    res.json({
      cibeTotal: cibeAll.length,
      cibeEmitidos,
      cibePendientes,
      policiesActive,
      accessRulesActive,
      herzogAuditsRecent: herzogRecent.length,
      herzogNoCandidatoRecent: herzogNoCandidato,
      u2: typeof getU2Snapshot === 'function' ? getU2Snapshot() : null,
    });
  });

  /* ---- perdidas globales U-2 (solo lectura; unica conexion externa fuera de Herzog) ---- */

  router.get('/api/pactvm/u2-summary', ...guard, async (req, res) => {
    const snapshot = typeof getU2Snapshot === 'function' ? getU2Snapshot() : null;
    res.json({ snapshot });
  });

  /* ---- integridad del log ---- */

  router.get('/api/pactvm/log/verify', ...guard, async (req, res) => {
    const all = await mongo.collection('pactvm_log').find({}).sort({ seq: 1 }).toArray();
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
