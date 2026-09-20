/**
 * Puerto Maestro (Master Gateway) — Arquitectura de Interconexión por Puertos.
 *
 * Doctrina: Rëff, Elvi-Ra y OPHS operan en contenedores lógica y
 * criptográficamente separados (I/O Ports aislados, sin base de datos
 * compartida directa). El Puerto Maestro es el único switch capaz de rutear
 * una solicitud entre puertos. Cualquier perfil restreñido (ej. PhD) que pida
 * datos cruzados entre sistemas genera un payload firmado con estado
 * PENDING_MASTER_APPROVAL hasta que un Admin decide (Regla de Oro: el ser
 * humano autoriza, el ser humano supervisa).
 *
 * Payload de solicitud (forma fija, ver CLAUDE.md):
 * {
 *   request_id, timestamp,
 *   user: { id, role, trust_score },
 *   source_port, target_port,
 *   data_requested: { scope, range },
 *   status
 * }
 *
 * risk_score / risk_flags quedan reservados en el esquema para la próxima
 * iteración (variables de detección de acción peligrosa, aún no definidas).
 *
 * Mismo patrón que Pactvm Viridi/Finance: CRUD directo sobre Mongo, log
 * inmutable propio (gateway_log, hash chain).
 */

import crypto from 'node:crypto';

const PORTS = ['REFF_LAB_MODULE', 'REFF_CRM', 'REFF_U2', 'ELVIRA_ANALYTICS', 'ELVIRA_CENTRAL', 'OPHS_COCKPIT', 'OPHS_GRID'];
const DECISIONS = ['APPROVED', 'DENIED'];

function withId(doc) {
  if (!doc) return doc;
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
}

function canonical(entry) {
  return JSON.stringify(entry, Object.keys(entry).sort());
}

async function appendGatewayLog(mongo, entry) {
  const col = mongo.collection('gateway_log');
  const tail = await col.find().sort({ seq: -1 }).limit(1).next();
  const seq = tail ? tail.seq + 1 : 1;
  const prevHash = tail ? tail.hash : '0'.repeat(64);
  const canonicalEntry = { ...entry, seq };
  const hash = crypto.createHash('sha256').update(prevHash + canonical(canonicalEntry)).digest('hex');
  const doc = { _id: crypto.randomUUID(), ...entry, seq, prevHash, hash, createdAt: new Date().toISOString() };
  await col.insertOne(doc);
  return doc;
}

export function mountMasterGateway(app, { auth, requireMesa, requireAdmin, mongo }) {
  const guard = [auth, requireMesa('gateway')];

  /* ---- solicitudes de tráfico inter-puertos ----
   * Cualquier mesa con acceso al Puerto Maestro puede CREAR una solicitud
   * (payload firmado, queda PENDING_MASTER_APPROVAL). Solo Admin decide
   * (aprobar/denegar) — sin excepción de rol ni trust_score, hasta que se
   * definan las reglas de auto-aprobación por riesgo. */

  app.get('/api/gateway/requests', ...guard, async (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : null;
    const query = status ? { status } : {};
    const rows = await mongo.collection('gateway_requests').find(query).sort({ createdAt: -1 }).limit(200).toArray();
    res.json(rows.map(withId));
  });

  app.post('/api/gateway/requests', ...guard, async (req, res) => {
    const b = req.body || {};
    const sourcePort = String(b.sourcePort || '').trim();
    const targetPort = String(b.targetPort || '').trim();
    if (!PORTS.includes(sourcePort)) return res.status(400).json({ error: `sourcePort invalido (${PORTS.join(', ')})` });
    if (!PORTS.includes(targetPort)) return res.status(400).json({ error: `targetPort invalido (${PORTS.join(', ')})` });
    if (sourcePort === targetPort) return res.status(400).json({ error: 'sourcePort y targetPort no pueden coincidir' });
    const scope = String(b.scope || '').trim();
    if (!scope) return res.status(400).json({ error: 'scope requerido' });
    const range = typeof b.range === 'string' ? b.range.trim().slice(0, 100) : '';
    const trustScore = b.trustScore !== undefined && b.trustScore !== null ? Number(b.trustScore) : null;
    if (trustScore !== null && (!Number.isFinite(trustScore) || trustScore < 0 || trustScore > 1)) {
      return res.status(400).json({ error: 'trustScore invalido (0-1)' });
    }

    const requestId = `REQ-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomInt(1000, 9999)}`;
    const payload = {
      request_id: requestId,
      timestamp: new Date().toISOString(),
      user: { id: req.user, role: req.role, trust_score: trustScore },
      source_port: sourcePort,
      target_port: targetPort,
      data_requested: { scope, range: range || null },
      status: 'PENDING_MASTER_APPROVAL',
    };
    const doc = {
      _id: crypto.randomUUID(),
      ...payload,
      risk_score: null,
      risk_flags: [],
      decidedBy: null,
      decidedAt: null,
      decisionReason: '',
      createdAt: new Date().toISOString(),
    };
    await mongo.collection('gateway_requests').insertOne(doc);
    await appendGatewayLog(mongo, {
      action: 'request.create', actorId: req.user,
      detail: { requestId, sourcePort, targetPort, scope, range: range || null, trustScore },
    });
    res.status(201).json(withId(doc));
  });

  app.post('/api/gateway/requests/:id/decide', auth, requireMesa('gateway'), requireAdmin, async (req, res) => {
    const row = await mongo.collection('gateway_requests').findOne({ _id: req.params.id });
    if (!row) return res.status(404).json({ error: 'solicitud no encontrada' });
    if (row.status !== 'PENDING_MASTER_APPROVAL') return res.status(409).json({ error: `solicitud ya resuelta (status=${row.status})` });
    const b = req.body || {};
    if (!DECISIONS.includes(b.decision)) return res.status(400).json({ error: `decision invalida (${DECISIONS.join(', ')})` });
    const reason = typeof b.reason === 'string' ? b.reason.trim().slice(0, 500) : '';
    const $set = {
      status: b.decision,
      decidedBy: req.user,
      decidedAt: new Date().toISOString(),
      decisionReason: reason,
    };
    await mongo.collection('gateway_requests').updateOne({ _id: req.params.id }, { $set });
    await appendGatewayLog(mongo, {
      action: 'request.decide', actorId: req.user,
      detail: { requestId: row.request_id, decision: b.decision, reason },
    });
    const updated = await mongo.collection('gateway_requests').findOne({ _id: req.params.id });
    res.json(withId(updated));
  });

  /* ---- resumen KPI ---- */

  app.get('/api/gateway/summary', ...guard, async (req, res) => {
    const rows = await mongo.collection('gateway_requests').find({}).toArray();
    const pending = rows.filter((r) => r.status === 'PENDING_MASTER_APPROVAL').length;
    const approved = rows.filter((r) => r.status === 'APPROVED').length;
    const denied = rows.filter((r) => r.status === 'DENIED').length;
    const byPort = {};
    for (const r of rows) {
      const key = `${r.source_port}->${r.target_port}`;
      byPort[key] = (byPort[key] || 0) + 1;
    }
    res.json({ total: rows.length, pending, approved, denied, byPort });
  });

  /* ---- integridad del log ---- */

  app.get('/api/gateway/log/verify', ...guard, async (req, res) => {
    const all = await mongo.collection('gateway_log').find({}).sort({ seq: 1 }).toArray();
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

  app.get('/api/gateway/log', ...guard, async (req, res) => {
    const rows = await mongo.collection('gateway_log').find({}).sort({ seq: -1 }).limit(200).toArray();
    res.json(rows.map(withId));
  });
}
