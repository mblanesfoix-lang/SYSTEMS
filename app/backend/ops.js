/**
 * OPS — Operational Performance System.
 *
 * Sub-interfaz del Cockpit OPHS. Telemetria pura de hardware fisico del nodo
 * S-NFI BioHybrid: presion, caudal de fluidos, temperatura de la canalizacion
 * en "Y" de acero inox, RPM y estado del circuito cerrado industrial.
 *
 * Mismo patron que Finance/FL/M&A/Pactvm: CRUD directo sobre Mongo, sin router
 * TS separado, log inmutable propio (ops_log, hash chain). Lecturas via mock
 * (o ingest real del nodo cuando SYSTEMS_URL este activo) en ops_readings,
 * time-series simple por nodeId.
 */

import crypto from 'node:crypto';
import { appendChained, verifyLog } from './lib/hash-chain.js';

const CIRCUIT_STATES = ['nominal', 'degradado', 'parada', 'mantenimiento'];

export const THRESHOLDS = {
  pressureBar: { min: 1.5, max: 8.5 },
  flowLpm: { min: 20, max: 220 },
  tempC: { min: 15, max: 95 },
  rpm: { min: 0, max: 3200 },
};

function withId(doc) {
  if (!doc) return doc;
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
}

const appendOpsLog = (mongo, entry) => appendChained(mongo, 'ops_log', entry);

export function evalThresholds(reading) {
  const breaches = [];
  for (const [key, { min, max }] of Object.entries(THRESHOLDS)) {
    const v = reading[key];
    if (typeof v !== 'number') continue;
    if (v < min || v > max) breaches.push({ metric: key, value: v, min, max });
  }
  return breaches;
}

export function mountOps(app, { auth, requireMesa, mongo, cibe }) {
  const router = app;
  const guard = [auth, requireMesa('ophs')];
  // comandos criticos (CRUD nodos, estado circuito): firma CIBE del bunker
  const command = [...guard, cibe ? cibe.guard('ophs.command') : (_req, _res, next) => next()];

  /* ---- nodos monitorizados (referencia ligera, el maestro es systems_nodes de Elvi-Ra) ---- */

  router.get('/api/ops/nodes', ...guard, async (req, res) => {
    const rows = await mongo.collection('ops_nodes').find({}).sort({ nodeId: 1 }).toArray();
    res.json(rows.map(withId));
  });

  function parseLatLng(b) {
    if (b.lat === undefined && b.lng === undefined) return { lat: null, lng: null, ok: true };
    const lat = Number(b.lat);
    const lng = Number(b.lng);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) return { ok: false, error: 'lat invalida' };
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) return { ok: false, error: 'lng invalida' };
    return { lat, lng, ok: true };
  }

  router.post('/api/ops/nodes', ...command, async (req, res) => {
    const b = req.body || {};
    const nodeId = String(b.nodeId || '').trim();
    if (!nodeId) return res.status(400).json({ error: 'nodeId requerido' });
    const existing = await mongo.collection('ops_nodes').findOne({ nodeId });
    if (existing) return res.status(409).json({ error: 'nodo ya registrado' });
    const geo = parseLatLng(b);
    if (!geo.ok) return res.status(400).json({ error: geo.error });
    const doc = {
      _id: crypto.randomUUID(),
      nodeId,
      label: typeof b.label === 'string' ? b.label.trim().slice(0, 200) : nodeId,
      lat: geo.lat,
      lng: geo.lng,
      circuitState: 'nominal',
      createdBy: req.user,
      createdAt: new Date().toISOString(),
    };
    await mongo.collection('ops_nodes').insertOne(doc);
    await appendOpsLog(mongo, { action: 'node.register', actorId: req.user, detail: { nodeId } });
    res.status(201).json(withId(doc));
  });

  router.patch('/api/ops/nodes/:nodeId', ...command, async (req, res) => {
    const { nodeId } = req.params;
    const node = await mongo.collection('ops_nodes').findOne({ nodeId });
    if (!node) return res.status(404).json({ error: 'nodo no registrado' });
    const b = req.body || {};
    const $set = {};
    if (b.label !== undefined) {
      const label = String(b.label).trim().slice(0, 200);
      if (!label) return res.status(400).json({ error: 'label no puede estar vacio' });
      $set.label = label;
    }
    if (b.lat !== undefined || b.lng !== undefined) {
      const geo = parseLatLng(b);
      if (!geo.ok) return res.status(400).json({ error: geo.error });
      $set.lat = geo.lat;
      $set.lng = geo.lng;
    }
    if (Object.keys($set).length === 0) return res.status(400).json({ error: 'sin campos validos para editar' });
    await mongo.collection('ops_nodes').updateOne({ nodeId }, { $set });
    await appendOpsLog(mongo, { action: 'node.update', actorId: req.user, detail: { nodeId, $set } });
    const updated = await mongo.collection('ops_nodes').findOne({ nodeId });
    res.json(withId(updated));
  });

  router.delete('/api/ops/nodes/:nodeId', ...command, async (req, res) => {
    const { nodeId } = req.params;
    const result = await mongo.collection('ops_nodes').deleteOne({ nodeId });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'nodo no registrado' });
    const { deletedCount: readingsDeleted } = await mongo.collection('ops_readings').deleteMany({ nodeId });
    await mongo.collection('paia_analyses').deleteMany({ nodeId });
    await appendOpsLog(mongo, { action: 'node.delete', actorId: req.user, detail: { nodeId, readingsDeleted } });
    res.json({ nodeId, deleted: true, readingsDeleted });
  });

  /* ---- lecturas de telemetria (time-series simple) ---- */

  router.get('/api/ops/nodes/:nodeId/readings', ...guard, async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    const rows = await mongo.collection('ops_readings')
      .find({ nodeId: req.params.nodeId })
      .sort({ ts: -1 })
      .limit(limit)
      .toArray();
    res.json(rows.map(withId));
  });

  router.post('/api/ops/nodes/:nodeId/readings', ...guard, async (req, res) => {
    const { nodeId } = req.params;
    const node = await mongo.collection('ops_nodes').findOne({ nodeId });
    if (!node) return res.status(404).json({ error: 'nodo no registrado' });
    const b = req.body || {};

    const reading = {
      pressureBar: Number(b.pressureBar),
      flowLpm: Number(b.flowLpm),
      tempC: Number(b.tempC),
      rpm: Number(b.rpm),
    };
    for (const [key, v] of Object.entries(reading)) {
      if (!Number.isFinite(v)) return res.status(400).json({ error: `${key} invalido` });
    }

    const breaches = evalThresholds(reading);
    const doc = {
      _id: crypto.randomUUID(),
      nodeId,
      ...reading,
      breaches,
      ts: new Date().toISOString(),
    };
    await mongo.collection('ops_readings').insertOne(doc);

    if (breaches.length > 0) {
      const nextState = breaches.length >= 2 ? 'degradado' : node.circuitState;
      if (nextState !== node.circuitState) {
        await mongo.collection('ops_nodes').updateOne({ nodeId }, { $set: { circuitState: nextState } });
      }
      await appendOpsLog(mongo, { action: 'threshold.breach', actorId: 'system', detail: { nodeId, breaches } });
    }

    res.status(201).json(withId(doc));
  });

  router.put('/api/ops/nodes/:nodeId/circuit-state', ...command, async (req, res) => {
    const { nodeId } = req.params;
    const state = req.body?.state;
    if (!CIRCUIT_STATES.includes(state)) return res.status(400).json({ error: 'state invalido' });
    const result = await mongo.collection('ops_nodes').updateOne({ nodeId }, { $set: { circuitState: state } });
    if (result.matchedCount === 0) return res.status(404).json({ error: 'nodo no registrado' });
    await appendOpsLog(mongo, { action: 'circuit_state.set', actorId: req.user, detail: { nodeId, state } });
    res.json({ nodeId, circuitState: state });
  });

  /* ---- resumen KPI (para Cockpit OPHS) ---- */

  router.get('/api/ops/summary', ...guard, async (req, res) => {
    const nodes = await mongo.collection('ops_nodes').find({}).toArray();
    const sinceIso = new Date(Date.now() - 3600000).toISOString();
    const recentBreaches = await mongo.collection('ops_readings')
      .countDocuments({ ts: { $gte: sinceIso }, 'breaches.0': { $exists: true } });
    res.json({
      nodesTotal: nodes.length,
      nodesNominal: nodes.filter((n) => n.circuitState === 'nominal').length,
      nodesDegradado: nodes.filter((n) => n.circuitState === 'degradado').length,
      nodesParada: nodes.filter((n) => n.circuitState === 'parada').length,
      breachesUltimaHora: recentBreaches,
    });
  });

  /* ---- integridad del log ---- */

  router.get('/api/ops/log/verify', ...guard, async (req, res) => {
    res.json(await verifyLog(mongo, 'ops_log'));
  });
}
