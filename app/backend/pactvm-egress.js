/**
 * Pactvm Viridi · registro de salidas a la red.
 *
 * Cada evento de la compuerta (egress/) se guarda en pactvm_egress_log, log
 * encadenado por hash (lib/hash-chain.js), en la base del tenant que hizo la
 * llamada; las salidas de fondo, sin tenant, van a la base del tenant por
 * defecto. Las llamadas que pide una persona se guardan una a una; las consultas
 * automáticas y repetitivas (poll) se agregan por ventana en una entrada de
 * resumen con el número de llamadas y los bytes, para que el log no crezca con
 * cada sondeo. Una salida denegada avisa al Admin una vez por ventana y destino.
 *
 * La vista es de solo lectura y solo del Admin: registro, integridad de la cadena
 * y lista blanca efectiva (exportable, base de la política de red de los racks).
 */

import { appendChained, verifyLog } from './lib/hash-chain.js';
import { egressPolicy } from './egress/index.js';

export const EGRESS_LOG = 'pactvm_egress_log';
export const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
const MAX_RETRY = 1000;
const MAX_PAGE = 200;

const callFields = (e) => ({
  mesa: e.mesa, user: e.user ?? null, destination: e.destination ?? null, category: e.category ?? null,
  protocol: e.protocol, host: e.host, port: e.port ?? null, method: e.method ?? null,
});

export function createEgressLog({ resolveDb, windowMs = DEFAULT_WINDOW_MS, notifyDenied = null, now = () => Date.now() }) {
  const queues = new Map();      // nombre de la base -> promesa de la última escritura
  const indexed = new Set();
  const aggregates = new Map();  // clave -> { tenantId, entry }
  const notified = new Set();
  let retry = [];
  let dropped = 0;

  // Escrituras en serie por base: dos entradas simultáneas no pueden bifurcar la cadena.
  function write(tenantId, entry) {
    let db;
    try {
      db = resolveDb(tenantId);
    } catch (err) {
      return keepForRetry(tenantId, entry, err);
    }
    const name = db.databaseName;
    const prev = queues.get(name) || Promise.resolve();
    const next = prev.then(async () => {
      if (!indexed.has(name)) {
        await db.collection(EGRESS_LOG).createIndex({ seq: 1 }, { unique: true });
        indexed.add(name);
      }
      await appendChained(db, EGRESS_LOG, entry);
    }).catch((err) => keepForRetry(tenantId, entry, err));
    queues.set(name, next);
    return next;
  }

  function keepForRetry(tenantId, entry, err) {
    console.error('[egress] no se pudo guardar la salida en el registro de Pactvm:', err?.message || err);
    if (retry.length < MAX_RETRY) retry.push({ tenantId, entry });
    else dropped += 1;
  }

  function aggregate(tenantId, event) {
    const fields = callFields(event);
    const key = JSON.stringify([tenantId, fields, event.result]);
    const item = aggregates.get(key);
    if (!item) {
      aggregates.set(key, {
        tenantId,
        entry: {
          kind: 'resumen', ...fields, result: event.result, calls: 1,
          bytesOut: event.bytesOut ?? 0, bytesIn: event.bytesIn ?? 0, durationMs: event.durationMs ?? 0,
          from: event.at, to: event.at, lastStatus: event.status ?? null, lastReason: event.reason ?? null,
        },
      });
      return;
    }
    const e = item.entry;
    e.calls += 1;
    e.bytesOut += event.bytesOut ?? 0;
    e.bytesIn += event.bytesIn ?? 0;
    e.durationMs += event.durationMs ?? 0;
    e.to = event.at;
    e.lastStatus = event.status ?? e.lastStatus;
    e.lastReason = event.reason ?? e.lastReason;
  }

  function maybeNotify(tenantId, event) {
    if (!notifyDenied || event.result !== 'denegada') return;
    const key = `${tenantId}|${event.mesa}|${event.host}`;
    if (notified.has(key)) return;
    notified.add(key);
    try {
      notifyDenied(event);
    } catch (err) {
      console.error('[egress] aviso de salida denegada:', err?.message || err);
    }
  }

  /** Recibe un evento de la compuerta (con tenantId opcional). Nunca lanza. */
  function record(event) {
    const { tenantId = null, poll, ...rest } = event || {};
    if (!rest.mesa || !rest.host) return;
    maybeNotify(tenantId, rest);
    if (poll) aggregate(tenantId, rest);
    else write(tenantId, { kind: 'llamada', ...callFields(rest), path: rest.path ?? null, redirects: rest.redirects ?? 0, result: rest.result, status: rest.status ?? null, reason: rest.reason ?? null, bytesOut: rest.bytesOut ?? null, bytesIn: rest.bytesIn ?? null, durationMs: rest.durationMs ?? null, at: rest.at });
  }

  /** Guarda los resúmenes de la ventana y los pendientes, y espera a que todo esté escrito. */
  async function flush() {
    const items = [...aggregates.values()];
    aggregates.clear();
    notified.clear();
    const pendingRetry = retry;
    retry = [];
    for (const { tenantId, entry } of pendingRetry) write(tenantId, entry);
    for (const { tenantId, entry } of items) write(tenantId, entry);
    await Promise.all([...queues.values()]);
  }

  const timer = setInterval(() => { flush().catch(() => {}); }, windowMs);
  timer.unref?.();

  return {
    record,
    flush,
    async stop() {
      clearInterval(timer);
      await flush();
    },
    /** Resúmenes de la ventana en curso, aún sin escribir, del tenant indicado. */
    pending(tenantId = null) {
      return [...aggregates.values()].filter((a) => a.tenantId === tenantId).map((a) => ({ ...a.entry }));
    },
    stats: () => ({ pendingWrites: retry.length, dropped, windowMs, at: new Date(now()).toISOString() }),
  };
}

// Solo el Admin: el registro y la lista blanca revelan las máquinas internas (racks, ØPHS, base de datos) y quién llamó a qué.
export function mountPactvmEgress(app, { auth, requireMesa, requireAdmin, mongo, egressLog, currentTenant = () => null, env = process.env }) {
  const guard = [auth, requireMesa('pactvm'), requireAdmin];
  const col = () => mongo.collection(EGRESS_LOG);

  app.get('/api/pactvm/egress', ...guard, async (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), MAX_PAGE);
    const filter = {};
    const before = parseInt(req.query.before, 10);
    if (Number.isInteger(before) && before > 0) filter.seq = { $lt: before };
    if (['ok', 'error', 'denegada'].includes(req.query.result)) filter.result = req.query.result;
    if (typeof req.query.mesa === 'string' && /^[a-z][a-z0-9_]*$/.test(req.query.mesa)) filter.mesa = req.query.mesa;
    const entries = await col().find(filter, { projection: { _id: 0 } }).sort({ seq: -1 }).limit(limit).toArray();
    const tenantId = currentTenant();
    res.json({
      entries,
      nextBefore: entries.length === limit ? entries[entries.length - 1].seq : null,
      pending: egressLog ? egressLog.pending(tenantId) : [],
    });
  });

  // Totales por destino: una entrada de resumen cuenta sus llamadas, una individual cuenta una.
  app.get('/api/pactvm/egress/summary', ...guard, async (_req, res) => {
    const calls = { $ifNull: ['$calls', 1] };
    const rows = await col().aggregate([
      { $group: {
        _id: { destination: '$destination', host: '$host', category: '$category' },
        calls: { $sum: calls },
        denied: { $sum: { $cond: [{ $eq: ['$result', 'denegada'] }, calls, 0] } },
        errors: { $sum: { $cond: [{ $eq: ['$result', 'error'] }, calls, 0] } },
        bytesOut: { $sum: { $ifNull: ['$bytesOut', 0] } },
        bytesIn: { $sum: { $ifNull: ['$bytesIn', 0] } },
        mesas: { $addToSet: '$mesa' },
        last: { $max: { $ifNull: ['$to', '$at'] } },
      } },
      { $sort: { calls: -1 } },
    ]).toArray();
    const byDestination = rows.map((r) => ({ ...r._id, ...r, _id: undefined, mesas: r.mesas.sort() }));
    res.json({
      entries: await col().countDocuments(),
      calls: byDestination.reduce((s, r) => s + r.calls, 0),
      denied: byDestination.reduce((s, r) => s + r.denied, 0),
      thirdParties: new Set(byDestination.filter((r) => r.category === 'tercero' && r.calls > r.denied).map((r) => r.host)).size,
      byDestination,
    });
  });

  app.get('/api/pactvm/egress/verify', ...guard, async (_req, res) => {
    res.json(await verifyLog(mongo, EGRESS_LOG));
  });

  // Lista blanca efectiva. Sin secretos: máquinas, puertos y mesas.
  app.get('/api/pactvm/egress/policy', ...guard, (_req, res) => {
    res.json({ generatedAt: new Date().toISOString(), ...egressPolicy(env) });
  });
}
