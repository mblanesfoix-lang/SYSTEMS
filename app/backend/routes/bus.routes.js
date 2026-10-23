/**
 * EVENT BUS · Bus de eventos central
 * Flujo: Emisor → busEmit / POST /api/bus/emit → bus_events (Mongo) → change stream → SSE de cada réplica
 *
 * Estados de paquete:
 *   PENDING | ROUTING | VALIDATING | BLOCKED | APPROVED | COMPLETED
 *
 * busEvents/busEmit/busEmitAlert son dependencia compartida: casi todos los demas
 * modulos de mesa (finance, rack-state, grid-interlink, elvira-central, cnmc, u2-ree, ...)
 * reciben busEmit/busEmitAlert en su objeto de deps y los llaman como funciones simples,
 * sin esperar. Este modulo los crea y los devuelve al bootstrap (server.js).
 *
 * Persistencia: coleccion bus_events de la base por defecto, global y no por tenant, como
 * los avisos al Admin: muchos eventos nacen fuera de una peticion. Cada evento recibe un
 * `seq` global (contador en Mongo) que es tambien su id SSE, asi un cliente que reconecta
 * con Last-Event-ID recibe lo que le falte. Caducan por indice TTL sobre `expiresAt`
 * (BUS_RETENTION_DAYS). TTL y no coleccion acotada: la retencion es por tiempo, no por
 * tamaño, y el PATCH de estado actualiza eventos ya guardados, algo que una coleccion
 * acotada restringe. busEmit no espera a Mongo: encola y escribe por lotes en segundo plano.
 *
 * Difusion: con replica set, cada replica escucha bus_events con un change stream y empuja
 * a sus clientes SSE lo que escriba cualquiera, tambien lo suyo. Con Mongo standalone no hay
 * change streams: cada replica empuja solo lo suyo (aviso en bootVerification). busEvents es
 * la ventana en memoria de los ultimos eventos (/events y /stats); con change streams reune
 * los de todas las replicas.
 */

import crypto from 'node:crypto';
import { migrateJsonOnce, insertIgnoringDuplicates } from '../lib/json-migration.js';
import { createChangeFeed, supportsChangeStreams } from '../lib/change-feed.js';

export const BUS_COLLECTION = 'bus_events';
const COUNTERS = 'counters';
const COUNTER_ID = 'bus_events';
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 90;
const MAX_BUS_EVENTS = 500;
const SSE_BACKLOG = 100;
// Un cliente que vuelve tras un corte recibe como mucho los ultimos MAX_REPLAY que se perdio.
const MAX_REPLAY = 500;
const WRITE_BATCH = 100;
const DELIVERED_MEMORY = 2000;
const ERROR_LOG_INTERVAL_MS = 60_000;

const ORIGINS = ['ELVI-RA', 'REFF', 'OPHS', 'SENTINEL', 'HERZOG', 'TCONTROLER', 'SYSTEM'];
const STATES = ['PENDING', 'ROUTING', 'VALIDATING', 'BLOCKED', 'APPROVED', 'COMPLETED'];

export function busRetentionMs(env = process.env) {
  const days = Number(env.BUS_RETENTION_DAYS);
  return (Number.isInteger(days) && days > 0 ? days : DEFAULT_RETENTION_DAYS) * DAY_MS;
}

export async function ensureBusIndexes(db) {
  const col = db.collection(BUS_COLLECTION);
  await col.createIndex({ seq: 1 }, { unique: true });
  await col.createIndex({ createdAt: -1 });
  await col.createIndex({ origin: 1, state: 1, type: 1 });
  await col.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
}

/** Reserva `n` numeros consecutivos de la secuencia global; devuelve el primero. */
async function reserveSeq(db, n) {
  const counter = await db.collection(COUNTERS).findOneAndUpdate(
    { _id: COUNTER_ID },
    { $inc: { value: n } },
    { upsert: true, returnDocument: 'after' },
  );
  return counter.value - n + 1;
}

function toDoc(event, retentionMs, createdMs = Date.parse(event.ts)) {
  const { id, _type, ...rest } = event;
  const ms = Number.isFinite(createdMs) ? createdMs : Date.now();
  return { _id: id, ...rest, createdAt: new Date(ms), expiresAt: new Date(ms + retentionMs) };
}

const toEvent = ({ _id, createdAt, expiresAt, ...rest }) => ({ id: _id, ...rest });

const frame = (event, withId = true) =>
  `${withId && event.seq ? `id: ${event.seq}\n` : ''}data: ${JSON.stringify(event)}\n\n`;

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function intParam(value, fallback, min, max) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Math.min(Math.max(Number.isFinite(n) ? n : fallback, min), max);
}

function dateParam(value) {
  if (!value) return null;
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Importa data/bus_history.json una sola vez, en orden cronologico y sin lo ya caducado. */
export function migrateBusHistoryFile(db, file, { retentionMs = busRetentionMs() } = {}) {
  return migrateJsonOnce(db, 'bus_history.json', file, async (data) => {
    const now = Date.now();
    const list = (Array.isArray(data) ? data : [])
      .filter((ev) => ev && typeof ev === 'object' && !ev._type)
      .map((ev) => ({ ev, ms: Date.parse(ev.ts ?? ev.at) }))
      .filter(({ ms }) => Number.isFinite(ms) && ms + retentionMs > now)
      .sort((a, b) => a.ms - b.ms);
    if (list.length === 0) return 0;
    const first = await reserveSeq(db, list.length);
    const docs = list.map(({ ev, ms }, i) => toDoc({
      ...ev,
      // Los pocos eventos antiguos sin id reciben uno estable: reimportar no los duplica.
      id: ev.id ? String(ev.id) : crypto.createHash('sha256').update(JSON.stringify(ev)).digest('hex').slice(0, 32),
      ts: ev.ts ?? new Date(ms).toISOString(),
      seq: first + i,
    }, retentionMs, ms));
    return insertIgnoringDuplicates(db.collection(BUS_COLLECTION), docs);
  });
}

export async function mountBus(app, { auth, mongo, adminNotify, retentionMs = busRetentionMs(), crossReplica, logger = console }) {
  const col = () => mongo.collection(BUS_COLLECTION);
  const busEvents = [];
  const byId = new Map();
  const sseClients = new Set();
  const delivered = new Set();
  let lastSeq = 0;
  let lastErrorLog = 0;

  function logError(context, err) {
    const now = Date.now();
    if (now - lastErrorLog < ERROR_LOG_INTERVAL_MS) return;
    lastErrorLog = now;
    logger.error(`[bus] ${context}:`, err?.message || err);
  }

  /* Ventana en memoria, mas reciente primero. Un evento ya conocido se actualiza en su sitio. */
  function remember(event) {
    const known = byId.get(event.id);
    if (known) return Object.assign(known, event);
    busEvents.unshift(event);
    byId.set(event.id, event);
    while (busEvents.length > MAX_BUS_EVENTS) byId.delete(busEvents.pop().id);
    return event;
  }

  /* `eventId` solo en eventos nuevos: sirve para no repetir lo que ya fue en el historial inicial. */
  function send(client, text, eventId = null) {
    if (client.pending) { client.pending.push({ text, eventId }); return; }
    try {
      // write() devuelve false con el buffer lleno (cliente lento): Node ya encola, no es error.
      client.res.write(text);
    } catch { sseClients.delete(client); }
  }

  function broadcast(text, eventId = null) {
    for (const client of sseClients) send(client, text, eventId);
  }

  /* Entrega a los clientes de esta replica, una sola vez por evento. */
  function deliver(event) {
    if (delivered.has(event.id)) return;
    delivered.add(event.id);
    if (delivered.size > DELIVERED_MEMORY) delivered.delete(delivered.values().next().value);
    if (event.seq > lastSeq) lastSeq = event.seq;
    broadcast(frame(event), event.id);
  }

  async function backfill() {
    const docs = await col().find({ seq: { $gt: lastSeq } }).sort({ seq: -1 }).limit(MAX_REPLAY).toArray();
    for (const doc of docs.reverse()) deliver(remember(toEvent(doc)));
  }

  /* ---- Modo de difusion: change streams si Mongo los admite ---- */
  let feed = null;
  let modeDetail;
  let useFeed = crossReplica;
  if (useFeed === undefined) {
    try { useFeed = await supportsChangeStreams(mongo); }
    catch (err) { useFeed = false; modeDetail = `no se pudo consultar el tipo de Mongo (${err.message})`; }
  }

  const recent = await col().find({}).sort({ seq: -1 }).limit(MAX_BUS_EVENTS).toArray();
  for (const doc of recent.reverse()) {
    const event = remember(toEvent(doc));
    delivered.add(event.id);
    if (event.seq > lastSeq) lastSeq = event.seq;
  }

  if (useFeed) {
    feed = createChangeFeed({
      collection: col(),
      operationTypes: ['insert', 'update', 'replace'],
      label: 'bus',
      logger,
      onChange(change) {
        const doc = change.fullDocument;
        if (!doc) return;
        if (change.operationType === 'insert') {
          deliver(remember(toEvent(doc)));
          return;
        }
        const event = toEvent(doc);
        const known = byId.get(event.id);
        if (known) Object.assign(known, event);
        broadcast(frame({ ...event, _type: 'state_update' }, false));
      },
      // Cada vez que el stream se abre sin token (tambien la primera): lo escrito mientras tanto.
      onReset: backfill,
    });
    feed.start();
    modeDetail = 'compartido entre réplicas (change streams de MongoDB)';
  } else {
    modeDetail = `solo en esta réplica: ${modeDetail || 'Mongo sin replica set, sin change streams'}`;
  }

  /* ---- Escritura por lotes en segundo plano ---- */
  const outbox = [];
  let flushing = null;

  async function flush() {
    while (outbox.length) {
      const batch = outbox.splice(0, WRITE_BATCH);
      // Indices del lote que no se guardaron; sin detalle por documento, todos.
      let failed = new Set();
      try {
        const first = await reserveSeq(mongo, batch.length);
        batch.forEach(({ event }, i) => { event.seq = first + i; });
        // Sin orden: un evento que Mongo rechace no impide guardar el resto del lote.
        await col().insertMany(batch.map(({ event }) => toDoc(event, retentionMs)), { ordered: false });
      } catch (err) {
        failed = Array.isArray(err?.writeErrors) && err.writeErrors.length
          ? new Set(err.writeErrors.map((e) => e.index))
          : new Set(batch.keys());
        logError('eventos no guardados en Mongo, se entregan solo en esta réplica', err);
      }
      // Sin change stream (o sin guardar) nadie mas los entregara.
      batch.forEach(({ event }, i) => { if (!feed || failed.has(i)) deliver(event); });
      batch.forEach(({ event, resolve }) => resolve(event));
    }
    flushing = null;
  }

  function busEmit(event) {
    const { seq, ...rest } = event;
    const ev = remember({ ...rest, id: event.id || crypto.randomUUID(), ts: event.ts || new Date().toISOString() });
    const done = new Promise((resolve) => outbox.push({ event: ev, resolve }));
    if (!flushing) flushing = flush();
    return done;
  }

  /* Emite un fallo al bus para que el panel Elvi-Ra lo muestre en rojo */
  function busEmitAlert({ origin = 'SYSTEM', dest = 'ELVI-RA', label, detail, user }) {
    busEmit({
      id: crypto.randomUUID(), ts: new Date().toISOString(),
      origin, dest, type: 'alert', state: 'BLOCKED',
      label, payload: { error: detail }, user,
    });
    adminNotify({ origin, label, detail });
  }

  /* Apagado ordenado: termina de guardar lo pendiente y cierra el change stream. */
  async function closeBus() {
    if (flushing) await flushing;
    if (feed) await feed.stop();
  }

  /* GET /api/bus/stream — SSE. Con Last-Event-ID reenvia lo que falte; sin el, los ultimos SSE_BACKLOG. */
  app.get('/api/bus/stream', auth, async (req, res) => {
    const lastEventId = Number.parseInt(req.get('Last-Event-ID') ?? '', 10);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // nginx: disable buffering
    res.flushHeaders();

    // Lo que llegue mientras se lee el historial espera en `pending` y sale despues, en orden.
    const client = { res, pending: [] };
    sseClients.add(client);
    // Heartbeat every 25s to keep connection alive through proxies
    const hb = setInterval(() => {
      try { res.write(': heartbeat\n\n'); } catch { clearInterval(hb); sseClients.delete(client); }
    }, 25000);
    req.on('close', () => { clearInterval(hb); sseClients.delete(client); });

    let backlog;
    try {
      const filter = lastEventId > 0 ? { seq: { $gt: lastEventId } } : {};
      const docs = await col().find(filter).sort({ seq: -1 }).limit(lastEventId > 0 ? MAX_REPLAY : SSE_BACKLOG).toArray();
      backlog = docs.reverse().map(toEvent);
    } catch (err) {
      logError('historial no disponible para el SSE', err);
      backlog = lastEventId > 0 ? [] : busEvents.slice(0, SSE_BACKLOG).reverse();
    }
    const pending = client.pending;
    client.pending = null;
    const sent = new Set(backlog.map((ev) => ev.id));
    for (const ev of backlog) send(client, frame(ev));
    for (const { text, eventId } of pending) {
      if (!eventId || !sent.has(eventId)) send(client, text);
    }
  });

  /* GET /api/bus/events — REST snapshot (último N eventos) */
  app.get('/api/bus/events', auth, (req, res) => {
    const limit = intParam(req.query.limit, 200, 1, MAX_BUS_EVENTS);
    res.json({ total: busEvents.length, events: busEvents.slice(0, limit) });
  });

  /* POST /api/bus/emit — cualquier módulo interno emite aquí */
  app.post('/api/bus/emit', auth, async (req, res) => {
    const b = req.body || {};
    const origin  = ORIGINS.includes(String(b.origin || '').toUpperCase()) ? String(b.origin).toUpperCase() : 'SYSTEM';
    const dest    = String(b.dest || 'BUS').toUpperCase();
    const state   = STATES.includes(String(b.state || '').toUpperCase()) ? String(b.state).toUpperCase() : 'PENDING';
    const type    = String(b.type || 'event').toLowerCase();   // event | request | response | alert
    const payload = b.payload && typeof b.payload === 'object' ? b.payload : {};
    const label   = String(b.label || '').slice(0, 140);

    const event = await busEmit({
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      origin,
      dest,
      type,
      state,
      label,
      payload,
      user: req.user,
    });
    res.status(201).json(event);
  });

  /* PATCH /api/bus/events/:id — actualizar estado de un evento existente */
  app.patch('/api/bus/events/:id', auth, async (req, res) => {
    const id = String(req.params.id);
    const set = {};
    const state = String(req.body?.state || '').toUpperCase();
    if (STATES.includes(state)) {
      set.state = state;
      set.updatedAt = new Date().toISOString();
    }
    if (req.body?.label) set.label = String(req.body.label).slice(0, 140);

    const doc = Object.keys(set).length
      ? await col().findOneAndUpdate({ _id: id }, { $set: set }, { returnDocument: 'after' })
      : await col().findOne({ _id: id });
    if (!doc) return res.status(404).json({ error: 'evento no encontrado' });
    const event = toEvent(doc);
    // Con change stream el aviso sale de alli, hacia todas las replicas.
    if (!feed && Object.keys(set).length) {
      const known = byId.get(id);
      if (known) Object.assign(known, event);
      broadcast(frame({ ...event, _type: 'state_update' }, false));
    }
    res.json(event);
  });

  /* GET /api/bus/stats — métricas del bus */
  app.get('/api/bus/stats', auth, (req, res) => {
    const counts = {};
    for (const ev of busEvents) counts[ev.state] = (counts[ev.state] || 0) + 1;
    const byOrigin = {};
    for (const ev of busEvents) byOrigin[ev.origin] = (byOrigin[ev.origin] || 0) + 1;
    res.json({
      total: busEvents.length,
      sseClients: sseClients.size,
      crossReplica: Boolean(feed),
      byState: counts,
      byOrigin,
      latest: busEvents[0] || null,
    });
  });

  /* GET /api/bus/history — historial persistente, filtrable por fecha/origen/estado/tipo/texto
   * Query params: from, to (ISO date), origin, dest, state, type, q (busca en label), limit, offset
   * Orden: más reciente primero.
   */
  app.get('/api/bus/history', auth, async (req, res) => {
    const { origin, dest, state, type, q } = req.query;
    const filter = {};
    const from = dateParam(req.query.from);
    const to = dateParam(req.query.to);
    if (from || to) filter.createdAt = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
    if (origin) filter.origin = String(origin).toUpperCase();
    if (dest)   filter.dest   = String(dest).toUpperCase();
    if (state)  filter.state  = String(state).toUpperCase();
    if (type)   filter.type   = String(type).toLowerCase();
    if (q)      filter.label  = { $regex: escapeRegex(String(q).slice(0, 200)), $options: 'i' };

    const limit  = intParam(req.query.limit, 200, 1, 1000);
    const offset = intParam(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const [total, docs] = await Promise.all([
      col().countDocuments(filter),
      col().find(filter).sort({ seq: -1 }).skip(offset).limit(limit).toArray(),
    ]);
    res.json({ total, limit, offset, events: docs.map(toEvent) });
  });

  return {
    busEvents, busEmit, busEmitAlert, closeBus, MAX_BUS_EVENTS,
    busStatus: () => ({ crossReplica: Boolean(feed), detail: modeDetail }),
  };
}
