/**
 * Data Foundry — pipeline de ingesta asincrona (doctrina Instrucciones.txt).
 *
 * Sistema real, no representacion: Ingress Gateway con firma HMAC por nodo,
 * bus de eventos no bloqueante en proceso, 4 ramificaciones en salas limpias
 * (OPS, PAIA, Herzog, sifon U-2 en worker thread), circuit breaker
 * independiente por ramificacion y metricas de "tiempo de viaje" del dato
 * vigiladas por Sentinel.
 *
 * Punto de conexion para S-NFI Systems (hardware real):
 *   - Modo embebido (default): POST /api/foundry/ingress en el puerto principal.
 *   - Modo puerto dedicado: env FOUNDRY_INGRESS_PORT=NNNN levanta un listener
 *     exclusivo con /ingress, /contract y /health (endpoint privado, puerto
 *     cerrado via firewall — doctrina Context Model 1).
 *   - Contrato completo: GET /api/foundry/contract (tambien en el puerto dedicado).
 *
 * Punto de correccion para produccion multi-proceso: la clase FoundryBus es el
 * adaptador a sustituir por Redis Streams / MQTT (misma interfaz publish()).
 */

import crypto from 'node:crypto';
import express from 'express';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { THRESHOLDS, evalThresholds } from './ops.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CHANNELS = ['ops', 'paia', 'herzog', 'u2'];
const NODE_ID_RE = /^[A-Za-z0-9_-]{2,40}$/;
const MAX_METRIC_KEYS = 20;
const CLOCK_SKEW_US = 15 * 60 * 1e6; // ±15 min: exige NTP en el nodo
const LATENCY_RING_CAP = 600;

const QUEUE_CAPS = { ops: 5000, paia: 20000, herzog: 20000, u2: 20000 };
const BREAKER_FAILURE_THRESHOLD = 5;
const BREAKER_COOLDOWN_MS = 30000;

function sortedJson(obj) {
  return JSON.stringify(obj, Object.keys(obj).sort());
}

function nowUs() {
  return Date.now() * 1000;
}

function signPacket({ nodeId, seq, ts_origin_us, metrics }, secret) {
  const stringToSign = `${nodeId}|${seq}|${ts_origin_us}|${sortedJson(metrics)}`;
  return crypto.createHmac('sha256', secret).update(stringToSign).digest('hex');
}

function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return null;
  const idx = Math.min(sortedArr.length - 1, Math.ceil((p / 100) * sortedArr.length) - 1);
  return sortedArr[Math.max(0, idx)];
}

/* seq atomico via contador Mongo (mismo motivo que sentinel-forensics: dos
   appends concurrentes leyendo el mismo tail garantizan seq duplicado). */
async function nextFoundrySeq(mongo) {
  const doc = await mongo.collection('foundry_seq').findOneAndUpdate(
    { _id: 'counter' },
    { $inc: { value: 1 } },
    { upsert: true, returnDocument: 'after' },
  );
  return doc.value;
}

async function appendFoundryLog(mongo, entry, attempt = 0) {
  const col = mongo.collection('foundry_log');
  const seq = await nextFoundrySeq(mongo);
  let prevHash = '0'.repeat(64);
  if (seq > 1) {
    // el escritor de seq-1 puede no haber insertado aun: espera corta
    for (let i = 0; i < 12; i += 1) {
      const tail = await col.findOne({ seq: seq - 1 });
      if (tail) { prevHash = tail.hash; break; }
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  const canonicalEntry = { ...entry, seq };
  const hash = crypto.createHash('sha256').update(prevHash + sortedJson(canonicalEntry)).digest('hex');
  const doc = { _id: crypto.randomUUID(), ...entry, seq, prevHash, hash, createdAt: new Date().toISOString() };
  try {
    await col.insertOne(doc);
  } catch (err) {
    if (err?.code === 11000 && attempt < 5) return appendFoundryLog(mongo, entry, attempt + 1);
    throw err;
  }
  return doc;
}

/* ---------------- Circuit breaker por ramificacion ---------------- */

class CircuitBreaker {
  constructor(channel, { onOpen, onClose } = {}) {
    this.channel = channel;
    this.state = 'closed'; // closed | open | half-open
    this.consecutiveFailures = 0;
    this.openedAt = null;
    this.reason = null;
    this.manual = false;
    this.onOpen = onOpen || (() => {});
    this.onClose = onClose || (() => {});
  }

  /** true = se permite intentar entregar el paquete */
  allow() {
    if (this.state === 'closed') return true;
    if (this.state === 'half-open') return true;
    if (this.manual) return false;
    if (Date.now() - this.openedAt >= BREAKER_COOLDOWN_MS) {
      this.state = 'half-open';
      return true;
    }
    return false;
  }

  onSuccess() {
    if (this.state !== 'closed') {
      this.state = 'closed';
      this.manual = false;
      this.reason = null;
      this.onClose(this.channel);
    }
    this.consecutiveFailures = 0;
  }

  onFailure(err) {
    this.consecutiveFailures += 1;
    const shouldOpen =
      this.state === 'half-open' || this.consecutiveFailures >= BREAKER_FAILURE_THRESHOLD;
    if (shouldOpen && this.state !== 'open') {
      this.state = 'open';
      this.openedAt = Date.now();
      this.reason = String(err?.message || err || 'fallo').slice(0, 300);
      this.onOpen(this.channel, this.reason);
    } else if (shouldOpen) {
      this.openedAt = Date.now();
    }
  }

  forceOpen(reason) {
    this.state = 'open';
    this.manual = true;
    this.openedAt = Date.now();
    this.reason = reason;
    this.onOpen(this.channel, reason);
  }

  forceClose() {
    const wasOpen = this.state !== 'closed';
    this.state = 'closed';
    this.manual = false;
    this.consecutiveFailures = 0;
    this.reason = null;
    if (wasOpen) this.onClose(this.channel);
  }

  snapshot() {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      openedAt: this.openedAt ? new Date(this.openedAt).toISOString() : null,
      manual: this.manual,
      reason: this.reason,
    };
  }
}

/* ---------------- Bus asincrono en proceso ----------------
   Adaptador a sustituir por Redis Streams / MQTT en produccion
   multi-proceso. Interfaz estable: publish(packet, t_gateway_us). */

class FoundryBus {
  constructor() {
    this.channels = {};
  }

  register(name, { handler, breaker }) {
    this.channels[name] = {
      name,
      queue: [],
      handler,
      breaker,
      delivered: 0,
      dropped: 0,          // por breaker abierto o cola llena
      failNext: 0,         // inyeccion de fallos para demo/test del breaker
      latencySamples: [],  // { at, deliveredMs, gatewayMs }
      stopped: false,
    };
    this.#run(this.channels[name]);
  }

  publish(packet, t_gateway_us) {
    for (const ch of Object.values(this.channels)) {
      if (ch.queue.length >= QUEUE_CAPS[ch.name]) {
        ch.dropped += 1;
        continue;
      }
      ch.queue.push({ packet, t_gateway_us });
    }
  }

  async #run(ch) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    while (!ch.stopped) {
      if (ch.queue.length === 0) {
        await sleep(15);
        continue;
      }
      const item = ch.queue.shift();
      if (!ch.breaker.allow()) {
        ch.dropped += 1;
        continue;
      }
      try {
        if (ch.failNext > 0) {
          ch.failNext -= 1;
          throw new Error(`fallo inyectado (test-trip, quedan ${ch.failNext})`);
        }
        await ch.handler(item.packet, item.t_gateway_us);
        ch.breaker.onSuccess();
        ch.delivered += 1;
        const nUs = nowUs();
        ch.latencySamples.push({
          at: Date.now(),
          deliveredMs: (nUs - item.packet.ts_origin_us) / 1000,
          gatewayMs: (item.t_gateway_us - item.packet.ts_origin_us) / 1000,
        });
        if (ch.latencySamples.length > LATENCY_RING_CAP) ch.latencySamples.shift();
      } catch (err) {
        ch.breaker.onFailure(err);
      }
    }
  }

  channelStats(name) {
    const ch = this.channels[name];
    const lat = ch.latencySamples.map((s) => s.deliveredMs).sort((a, b) => a - b);
    const last = ch.latencySamples[ch.latencySamples.length - 1] || null;
    const cutoff = Date.now() - 10000;
    const recent = ch.latencySamples.filter((s) => s.at >= cutoff).length;
    return {
      breaker: ch.breaker.snapshot(),
      queueDepth: ch.queue.length,
      queueCap: QUEUE_CAPS[name],
      delivered: ch.delivered,
      dropped: ch.dropped,
      failNextPending: ch.failNext,
      ratePerSec: Math.round((recent / 10) * 10) / 10,
      latencyMs: {
        avg: lat.length ? Math.round((lat.reduce((a, b) => a + b, 0) / lat.length) * 100) / 100 : null,
        p95: lat.length ? Math.round(percentile(lat, 95) * 100) / 100 : null,
        max: lat.length ? Math.round(lat[lat.length - 1] * 100) / 100 : null,
        last: last ? Math.round(last.deliveredMs * 100) / 100 : null,
        samples: lat.length,
      },
    };
  }
}

/* ---------------- Mount ---------------- */

export function mountFoundry(app, { auth, requireMesa, mongo, busEmit, adminNotify, cibe }) {
  const startedAt = new Date().toISOString();
  // control manual de breakers = comando critico: exige firma CIBE del bunker
  const cibeCommand = cibe ? cibe.guard('foundry.command') : (_req, _res, next) => next();

  // Express 4 no captura rechazos de handlers async: sin esto, un throw deja
  // la request colgada (headers timeout en el cliente) y un unhandledRejection.
  const h = (fn) => (req, res) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      console.error('[Foundry] route error:', err?.message || err);
      if (!res.headersSent) res.status(500).json({ error: String(err?.message || err) });
    });
  };
  const GLOBAL_SECRET = process.env.FOUNDRY_NODE_SECRET || '';
  const INGRESS_PORT = Number(process.env.FOUNDRY_INGRESS_PORT) || null;
  const LATENCY_BUDGET_MS = Number(process.env.FOUNDRY_LATENCY_BUDGET_MS) || 250;

  /* ---- registro de nodos (firma criptografica) ---- */
  const nodeCache = new Map(); // nodeId -> { secret, label }
  async function loadNodes() {
    nodeCache.clear();
    const rows = await mongo.collection('foundry_nodes').find({}).toArray();
    for (const n of rows) nodeCache.set(n.nodeId, { secret: n.secret, label: n.label });
  }

  /* ---- eventos de breaker → Sentinel/bus/notificaciones ---- */
  function emitBreakerEvent(channel, state, reason) {
    const label = `Foundry · breaker ${channel.toUpperCase()} ${state === 'open' ? 'ABIERTO' : 'cerrado'}`;
    busEmit({
      id: crypto.randomUUID(), ts: new Date().toISOString(),
      origin: 'FOUNDRY', dest: 'SENTINEL', type: 'circuit_breaker',
      state: state === 'open' ? 'BLOCKED' : 'DONE',
      label, payload: { channel, reason: reason || null }, user: 'system',
    });
    if (state === 'open') {
      adminNotify({ origin: 'FOUNDRY', severity: 'error', label, detail: reason || 'aislamiento de ramificacion' });
    }
    appendFoundryLog(mongo, { action: `breaker.${state}`, actorId: 'system', detail: { channel, reason: reason || null } })
      .catch(() => {});
  }

  const breakers = {};
  for (const c of CHANNELS) {
    breakers[c] = new CircuitBreaker(c, {
      onOpen: (channel, reason) => emitBreakerEvent(channel, 'open', reason),
      onClose: (channel) => emitBreakerEvent(channel, 'closed'),
    });
  }

  /* ---- Sala 1 · OPS (control critico) ---- */
  const knownOpsNodes = new Set();
  async function opsHandler(packet) {
    const { nodeId, metrics } = packet;
    if (!knownOpsNodes.has(nodeId)) {
      const existing = await mongo.collection('ops_nodes').findOne({ nodeId });
      if (!existing) {
        await mongo.collection('ops_nodes').insertOne({
          _id: crypto.randomUUID(),
          nodeId,
          label: nodeCache.get(nodeId)?.label || nodeId,
          lat: null, lng: null,
          circuitState: 'nominal',
          createdBy: 'foundry',
          source: 'foundry',
          createdAt: new Date().toISOString(),
        });
      }
      knownOpsNodes.add(nodeId);
    }
    // solo metricas canonicas presentes y finitas (NaN esquivaria evalThresholds)
    const reading = {};
    for (const key of ['pressureBar', 'flowLpm', 'tempC', 'rpm']) {
      const v = Number(metrics[key]);
      if (Number.isFinite(v)) reading[key] = v;
    }
    if (Object.keys(reading).length === 0) return; // paquete sin metricas OPS canonicas
    const breaches = evalThresholds(reading);
    await mongo.collection('ops_readings').insertOne({
      _id: crypto.randomUUID(),
      nodeId,
      ...reading,
      breaches,
      source: 'foundry',
      ts: new Date().toISOString(),
    });
    if (breaches.length >= 2) {
      await mongo.collection('ops_nodes').updateOne(
        { nodeId, circuitState: 'nominal' },
        { $set: { circuitState: 'degradado' } },
      );
    }
  }

  /* ---- Sala 2 · PAIA (computacion proactiva, buffer elastico) ---- */
  const paiaWindows = new Map(); // nodeId -> { values: number[], count }
  async function paiaHandler(packet) {
    const { nodeId, metrics } = packet;
    let w = paiaWindows.get(nodeId);
    if (!w) { w = { temps: [], pressures: [], count: 0 }; paiaWindows.set(nodeId, w); }
    if (Number.isFinite(metrics.tempC)) w.temps.push(metrics.tempC);
    if (Number.isFinite(metrics.pressureBar)) w.pressures.push(metrics.pressureBar);
    if (w.temps.length > 50) w.temps.shift();
    if (w.pressures.length > 50) w.pressures.shift();
    w.count += 1;

    if (w.count % 25 !== 0) return; // escritura diferida: el canal se acumula sin ralentizar OPS

    const stat = (arr) => {
      if (arr.length < 5) return null;
      const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
      const std = Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length) || 1e-9;
      const lastZ = (arr[arr.length - 1] - mean) / std;
      return { mean: Math.round(mean * 100) / 100, std: Math.round(std * 100) / 100, lastZ: Math.round(lastZ * 100) / 100 };
    };
    const temp = stat(w.temps);
    const pressure = stat(w.pressures);
    const anomaly = Boolean((temp && Math.abs(temp.lastZ) > 3) || (pressure && Math.abs(pressure.lastZ) > 3));
    await mongo.collection('paia_stream_stats').updateOne(
      { nodeId },
      {
        $set: {
          nodeId, window: 50, packetsSeen: w.count, temp, pressure, anomaly,
          updatedAt: new Date().toISOString(),
        },
      },
      { upsert: true },
    );
  }

  /* ---- Sala 3 · Herzog (conformidad, solo escritura, registros encadenados) ---- */
  let herzogPrevHash = null;
  let herzogSeq = 0;
  async function initHerzogChain() {
    const tail = await mongo.collection('foundry_herzog_records').find().sort({ seq: -1 }).limit(1).next();
    herzogPrevHash = tail ? tail.hash : '0'.repeat(64);
    herzogSeq = tail ? tail.seq : 0;
  }
  async function herzogHandler(packet) {
    const { nodeId, metrics, ts_origin_us } = packet;
    const breaches = evalThresholds({
      pressureBar: Number(metrics.pressureBar),
      flowLpm: Number(metrics.flowLpm),
      tempC: Number(metrics.tempC),
      rpm: Number(metrics.rpm),
    });
    herzogSeq += 1;
    const record = {
      seq: herzogSeq,
      nodeId,
      ts_origin_us,
      cibe: {
        // NaN (metrica ausente) no cuenta como fuera de limites
        tempWithinLimits: !(Number(metrics.tempC) > THRESHOLDS.tempC.max),
        pressureWithinLimits: !(Number(metrics.pressureBar) > THRESHOLDS.pressureBar.max),
        compliant: breaches.length === 0,
        breaches,
      },
    };
    const hash = crypto.createHash('sha256').update(herzogPrevHash + sortedJson(record)).digest('hex');
    await mongo.collection('foundry_herzog_records').insertOne({
      _id: crypto.randomUUID(),
      ...record,
      prevHash: herzogPrevHash,
      hash,
      recordedAt: new Date().toISOString(),
    });
    herzogPrevHash = hash;
  }

  /* ---- Bunker · sifon U-2 (worker thread independiente) ---- */
  let u2Worker = null;
  let u2WorkerStats = null;
  let u2WorkerState = 'arrancando';
  let u2RespawnTimer = null;

  function spawnU2Worker() {
    try {
      u2Worker = new Worker(path.join(__dirname, 'foundry-u2-worker.js'), {
        workerData: { mongoUri: process.env.MONGO_URI, bufferCap: 10000, flushMs: 2000, flushBatch: 500 },
      });
    } catch (err) {
      u2WorkerState = 'error';
      breakers.u2.forceOpen(`worker no arranca: ${err.message}`);
      return;
    }
    u2Worker.on('message', (msg) => {
      if (msg.type === 'ready') {
        u2WorkerState = 'activo';
        if (breakers.u2.manual === false && breakers.u2.state === 'open') breakers.u2.forceClose();
      } else if (msg.type === 'stats') {
        u2WorkerStats = msg.stats;
      } else if (msg.type === 'fatal') {
        u2WorkerState = 'error';
      }
    });
    u2Worker.on('exit', (code) => {
      u2WorkerState = `caido (exit ${code})`;
      u2Worker = null;
      if (code !== 0) {
        breakers.u2.forceOpen(`worker U-2 caido (exit ${code})`);
        breakers.u2.manual = false; // permitir half-open cuando el worker vuelva
      }
      if (!u2RespawnTimer) {
        u2RespawnTimer = setTimeout(() => { u2RespawnTimer = null; spawnU2Worker(); }, 10000);
      }
    });
    u2Worker.on('error', () => { /* el evento exit gestiona el respawn */ });
  }

  async function u2Handler(packet, t_gateway_us) {
    if (!u2Worker) throw new Error('worker U-2 no disponible');
    u2Worker.postMessage({ type: 'packet', packet, t_gateway_us });
  }

  /* ---- bus + consumidores ---- */
  const bus = new FoundryBus();
  bus.register('ops', { handler: opsHandler, breaker: breakers.ops });
  bus.register('paia', { handler: paiaHandler, breaker: breakers.paia });
  bus.register('herzog', { handler: herzogHandler, breaker: breakers.herzog });
  bus.register('u2', { handler: u2Handler, breaker: breakers.u2 });

  /* ---- Ingress Gateway (el colimador optico) ----
     Regla de Oro: valida firma + formato. No procesa, no guarda, no transforma. */
  const gatewayCounters = {
    accepted: 0,
    rejected: { bad_format: 0, unknown_node: 0, bad_sig: 0, stale_ts: 0 },
    lastPacketAt: null,
    lastRejectReason: null,
  };

  function validateAndDispatch(body) {
    const nodeId = body?.nodeId;
    const seq = body?.seq;
    const ts = body?.ts_origin_us;
    const metrics = body?.metrics;
    const sig = body?.sig;

    if (typeof nodeId !== 'string' || !NODE_ID_RE.test(nodeId)) return { ok: false, code: 'bad_format', error: 'nodeId invalido' };
    if (!Number.isInteger(seq) || seq < 0) return { ok: false, code: 'bad_format', error: 'seq invalido' };
    if (!Number.isFinite(ts)) return { ok: false, code: 'bad_format', error: 'ts_origin_us invalido' };
    if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) return { ok: false, code: 'bad_format', error: 'metrics invalido' };
    const keys = Object.keys(metrics);
    if (keys.length === 0 || keys.length > MAX_METRIC_KEYS) return { ok: false, code: 'bad_format', error: 'metrics vacio o demasiadas claves' };
    for (const k of keys) {
      if (!Number.isFinite(metrics[k])) return { ok: false, code: 'bad_format', error: `metrics.${k} no numerico` };
    }
    if (typeof sig !== 'string' || !/^[0-9a-f]{64}$/i.test(sig)) return { ok: false, code: 'bad_format', error: 'sig invalida (hex sha256)' };

    const t_gateway_us = nowUs();
    if (Math.abs(t_gateway_us - ts) > CLOCK_SKEW_US) return { ok: false, code: 'stale_ts', error: 'ts_origin_us fuera de ventana (±15 min, exige NTP)' };

    const node = nodeCache.get(nodeId);
    const secret = node?.secret || GLOBAL_SECRET;
    if (!node && !GLOBAL_SECRET) return { ok: false, code: 'unknown_node', error: 'nodo no registrado y sin FOUNDRY_NODE_SECRET global' };

    const expected = signPacket({ nodeId, seq, ts_origin_us: ts, metrics }, secret);
    const sigBuf = Buffer.from(sig.toLowerCase(), 'hex');
    const expBuf = Buffer.from(expected, 'hex');
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return { ok: false, code: 'bad_sig', error: 'firma HMAC invalida' };
    }

    const packet = { nodeId, seq, ts_origin_us: ts, metrics };
    bus.publish(packet, t_gateway_us); // despacho inmediato, nunca bloquea
    return { ok: true, t_gateway_us };
  }

  function ingressHandler(req, res) {
    const result = validateAndDispatch(req.body || {});
    if (!result.ok) {
      gatewayCounters.rejected[result.code] += 1;
      gatewayCounters.lastRejectReason = result.error;
      return res.status(result.code === 'bad_sig' || result.code === 'unknown_node' ? 401 : 400)
        .json({ accepted: false, error: result.error });
    }
    gatewayCounters.accepted += 1;
    gatewayCounters.lastPacketAt = new Date().toISOString();
    res.status(202).json({ accepted: true, t_gateway_us: result.t_gateway_us });
  }

  /* ---- contrato para el integrador (S-NFI Systems) ---- */
  function contractHandler(req, res) {
    res.json({
      system: 'S-NFI Data Foundry · Ingress Gateway',
      version: 1,
      transport: {
        embedded: 'POST /api/foundry/ingress (puerto principal Elvi-Ra)',
        dedicated: 'env FOUNDRY_INGRESS_PORT=NNNN → POST http://<host>:NNNN/ingress (+ GET /contract, /health)',
        active: INGRESS_PORT ? `dedicado :${INGRESS_PORT}` : 'embebido',
      },
      auth: {
        scheme: 'HMAC-SHA256 por nodo (sin sesion ni Bearer)',
        secretResolution: 'secreto por nodo registrado en foundry_nodes; fallback global env FOUNDRY_NODE_SECRET',
        stringToSign: 'nodeId|seq|ts_origin_us|JSON(metrics, claves ordenadas alfabeticamente)',
        sig: 'hex minusculas de HMAC-SHA256(stringToSign, secret)',
      },
      packetSchema: {
        nodeId: 'string ^[A-Za-z0-9_-]{2,40}$ (registrado via POST /api/foundry/nodes)',
        seq: 'entero >= 0, monotono por nodo (recomendado)',
        ts_origin_us: 'epoch en MICROsegundos en el hardware (capa ASML). Ventana ±15 min: NTP obligatorio',
        metrics: `objeto plano de numeros (1..${MAX_METRIC_KEYS} claves). Canonicas: pressureBar, flowLpm, tempC, rpm`,
        sig: 'firma HMAC (ver auth)',
      },
      responses: {
        202: '{ accepted: true, t_gateway_us } — despachado al bus asincrono',
        400: 'formato invalido / reloj fuera de ventana',
        401: 'nodo desconocido o firma invalida',
      },
      pipeline: {
        channels: CHANNELS,
        note: 'cada canal tiene circuit breaker independiente; OPS nunca hereda la caida de PAIA/Herzog/U-2',
        latencyBudgetMs: LATENCY_BUDGET_MS,
        metrics: 'GET /api/foundry/metrics (admin) · GET /api/sentinel/pipeline-metrics (Sentinel)',
      },
      productionNotes: [
        'Sustituir FoundryBus (in-process) por Redis Streams o MQTT: adaptador unico en app/backend/foundry.js',
        'Secretos de nodo: mover de Mongo a vault/env en produccion',
        'Puerto dedicado debe quedar cerrado al exterior (UFW) y accesible solo desde la red del nodo',
      ],
      example: {
        note: 'firma calculada con secret=REPLACE_ME',
        packet: {
          nodeId: 'BH-0001',
          seq: 1,
          ts_origin_us: 1751970000000000,
          metrics: { flowLpm: 120, pressureBar: 4.2, rpm: 1450, tempC: 74.5 },
          sig: signPacket(
            { nodeId: 'BH-0001', seq: 1, ts_origin_us: 1751970000000000, metrics: { flowLpm: 120, pressureBar: 4.2, rpm: 1450, tempC: 74.5 } },
            'REPLACE_ME',
          ),
        },
        curl: `curl -X POST ${INGRESS_PORT ? `http://<host>:${INGRESS_PORT}/ingress` : 'http://<host>:5173/api/foundry/ingress'} -H "Content-Type: application/json" -d @packet.json`,
      },
    });
  }

  /* ---- simulador (demo E2E sin hardware) ---- */
  const simulator = { timer: null, nodes: [], hz: 0, startedAt: null, packetsSent: 0, rejected: 0 };

  async function simulatorStart(nodesCount, hz) {
    if (simulator.timer) return;
    simulator.nodes = [];
    for (let i = 1; i <= nodesCount; i += 1) {
      const nodeId = `SIM-BH-${String(i).padStart(3, '0')}`;
      let node = await mongo.collection('foundry_nodes').findOne({ nodeId });
      if (!node) {
        node = {
          _id: crypto.randomUUID(),
          nodeId,
          label: `Simulador BioHybrid ${i}`,
          secret: crypto.randomBytes(24).toString('hex'),
          createdBy: 'simulator',
          createdAt: new Date().toISOString(),
        };
        await mongo.collection('foundry_nodes').insertOne(node);
      }
      nodeCache.set(nodeId, { secret: node.secret, label: node.label });
      simulator.nodes.push({ nodeId, secret: node.secret, seq: 0, phase: Math.random() * Math.PI * 2 });
    }
    simulator.hz = hz;
    simulator.startedAt = new Date().toISOString();
    simulator.timer = setInterval(() => {
      for (const n of simulator.nodes) {
        n.seq += 1;
        const t = Date.now() / 1000;
        const breachTick = n.seq % 45 === 0; // pico periodico para demostrar breaches OPS/Herzog
        const metrics = {
          pressureBar: Math.round((4.2 + Math.sin(t / 7 + n.phase) * 1.1 + Math.random() * 0.2) * 100) / 100,
          flowLpm: Math.round((120 + Math.sin(t / 11 + n.phase) * 30 + Math.random() * 4) * 10) / 10,
          tempC: breachTick ? 120 : Math.round((72 + Math.sin(t / 9 + n.phase) * 9 + Math.random()) * 10) / 10,
          rpm: Math.round(1450 + Math.sin(t / 13 + n.phase) * 300 + Math.random() * 20),
        };
        const packet = { nodeId: n.nodeId, seq: n.seq, ts_origin_us: nowUs(), metrics };
        packet.sig = signPacket(packet, n.secret);
        const result = validateAndDispatch(packet);
        if (result.ok) {
          gatewayCounters.accepted += 1;
          gatewayCounters.lastPacketAt = new Date().toISOString();
          simulator.packetsSent += 1;
        } else {
          gatewayCounters.rejected[result.code] += 1;
          simulator.rejected += 1;
        }
      }
    }, Math.max(50, Math.round(1000 / hz)));
    await appendFoundryLog(mongo, { action: 'simulator.start', actorId: 'admin', detail: { nodesCount, hz } });
  }

  async function simulatorStop() {
    if (simulator.timer) clearInterval(simulator.timer);
    simulator.timer = null;
    await appendFoundryLog(mongo, { action: 'simulator.stop', actorId: 'admin', detail: { packetsSent: simulator.packetsSent } });
  }

  /* ---- metricas agregadas ---- */
  function metricsPayload() {
    const channels = {};
    for (const c of CHANNELS) channels[c] = bus.channelStats(c);
    channels.u2.worker = { state: u2WorkerState, ...(u2WorkerStats || {}) };
    return {
      generatedAt: new Date().toISOString(),
      latencyBudgetMs: LATENCY_BUDGET_MS,
      gateway: {
        mode: INGRESS_PORT ? 'puerto dedicado' : 'embebido',
        port: INGRESS_PORT,
        accepted: gatewayCounters.accepted,
        rejected: gatewayCounters.rejected,
        lastPacketAt: gatewayCounters.lastPacketAt,
        lastRejectReason: gatewayCounters.lastRejectReason,
        nodesRegistered: nodeCache.size,
        globalSecretConfigured: Boolean(GLOBAL_SECRET),
      },
      simulator: {
        running: Boolean(simulator.timer),
        nodes: simulator.nodes.map((n) => n.nodeId),
        hz: simulator.hz,
        startedAt: simulator.startedAt,
        packetsSent: simulator.packetsSent,
        rejected: simulator.rejected,
      },
      channels,
    };
  }

  /* ---- vigilancia Sentinel: presupuesto de latencia ---- */
  const latencyAlertAt = {};
  setInterval(() => {
    for (const c of CHANNELS) {
      const stats = bus.channelStats(c);
      const p95 = stats.latencyMs.p95;
      if (p95 !== null && p95 > LATENCY_BUDGET_MS && stats.latencyMs.samples >= 20) {
        const last = latencyAlertAt[c] || 0;
        if (Date.now() - last > 5 * 60 * 1000) {
          latencyAlertAt[c] = Date.now();
          const label = `Foundry · latencia ${c.toUpperCase()} p95 ${p95}ms > presupuesto ${LATENCY_BUDGET_MS}ms`;
          busEmit({
            id: crypto.randomUUID(), ts: new Date().toISOString(),
            origin: 'FOUNDRY', dest: 'SENTINEL', type: 'latency_budget',
            state: 'BLOCKED', label, payload: { channel: c, p95, budgetMs: LATENCY_BUDGET_MS }, user: 'system',
          });
          adminNotify({ origin: 'FOUNDRY', severity: 'warning', label, detail: 'tiempo de viaje del dato por encima del presupuesto' });
        }
      }
    }
  }, 15000).unref();

  /* ---------------- Rutas HTTP ---------------- */

  // Ingress + contrato: SIN auth de sesion (la auth es la firma HMAC del nodo).
  // Registradas antes del guard para que el hardware pueda conectar.
  app.post('/api/foundry/ingress', ingressHandler);
  app.get('/api/foundry/contract', contractHandler);

  // Todo lo demas: solo mesa foundry (admin)
  app.use('/api/foundry', auth, requireMesa('foundry'));

  app.get('/api/foundry/status', (req, res) => {
    const m = metricsPayload();
    res.json({
      startedAt,
      ...m,
      env: {
        FOUNDRY_INGRESS_PORT: INGRESS_PORT || '(no definido → embebido)',
        FOUNDRY_NODE_SECRET: GLOBAL_SECRET ? 'definido' : '(no definido → solo nodos registrados)',
        FOUNDRY_LATENCY_BUDGET_MS: LATENCY_BUDGET_MS,
      },
    });
  });

  app.get('/api/foundry/metrics', (req, res) => res.json(metricsPayload()));

  app.get('/api/foundry/nodes', h(async (req, res) => {
    const rows = await mongo.collection('foundry_nodes').find({}).sort({ nodeId: 1 }).toArray();
    res.json(rows.map((n) => ({
      id: n._id, nodeId: n.nodeId, label: n.label,
      secretMasked: n.secret ? `${n.secret.slice(0, 4)}…${n.secret.slice(-4)}` : null,
      createdBy: n.createdBy, createdAt: n.createdAt,
    })));
  }));

  app.post('/api/foundry/nodes', h(async (req, res) => {
    const b = req.body || {};
    const nodeId = String(b.nodeId || '').trim();
    if (!NODE_ID_RE.test(nodeId)) return res.status(400).json({ error: 'nodeId invalido (^[A-Za-z0-9_-]{2,40}$)' });
    const existing = await mongo.collection('foundry_nodes').findOne({ nodeId });
    if (existing) return res.status(409).json({ error: 'nodo ya registrado' });
    const secret = typeof b.secret === 'string' && b.secret.length >= 16
      ? b.secret
      : crypto.randomBytes(24).toString('hex');
    const doc = {
      _id: crypto.randomUUID(),
      nodeId,
      label: typeof b.label === 'string' && b.label.trim() ? b.label.trim().slice(0, 200) : nodeId,
      secret,
      createdBy: req.user,
      createdAt: new Date().toISOString(),
    };
    await mongo.collection('foundry_nodes').insertOne(doc);
    nodeCache.set(nodeId, { secret, label: doc.label });
    await appendFoundryLog(mongo, { action: 'node.register', actorId: req.user, detail: { nodeId } });
    // el secreto se devuelve UNA vez, en el alta (luego solo enmascarado)
    res.status(201).json({ nodeId, label: doc.label, secret });
  }));

  app.delete('/api/foundry/nodes/:nodeId', h(async (req, res) => {
    const { nodeId } = req.params;
    const result = await mongo.collection('foundry_nodes').deleteOne({ nodeId });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'nodo no registrado' });
    nodeCache.delete(nodeId);
    await appendFoundryLog(mongo, { action: 'node.delete', actorId: req.user, detail: { nodeId } });
    res.json({ nodeId, deleted: true });
  }));

  app.post('/api/foundry/breakers/:channel', cibeCommand, h(async (req, res) => {
    const { channel } = req.params;
    if (!CHANNELS.includes(channel)) return res.status(400).json({ error: 'canal invalido' });
    const action = req.body?.action;
    if (action === 'open') breakers[channel].forceOpen(`abierto manualmente por ${req.user}`);
    else if (action === 'close' || action === 'reset') breakers[channel].forceClose();
    else return res.status(400).json({ error: 'action debe ser open|close|reset' });
    await appendFoundryLog(mongo, { action: `breaker.manual.${action}`, actorId: req.user, detail: { channel } });
    res.json({ channel, breaker: breakers[channel].snapshot() });
  }));

  app.post('/api/foundry/breakers/:channel/test-trip', cibeCommand, h(async (req, res) => {
    const { channel } = req.params;
    if (!CHANNELS.includes(channel)) return res.status(400).json({ error: 'canal invalido' });
    const failures = Math.min(Math.max(Number(req.body?.failures) || BREAKER_FAILURE_THRESHOLD, 1), 100);
    bus.channels[channel].failNext = failures;
    await appendFoundryLog(mongo, { action: 'breaker.test_trip', actorId: req.user, detail: { channel, failures } });
    res.json({ channel, failNext: failures, note: `los proximos ${failures} paquetes de ${channel} fallaran; el breaker abrira y el resto de salas sigue` });
  }));

  app.post('/api/foundry/simulator/start', h(async (req, res) => {
    if (simulator.timer) return res.status(409).json({ error: 'simulador ya corriendo' });
    const nodes = Math.min(Math.max(Number(req.body?.nodes) || 3, 1), 20);
    const hz = Math.min(Math.max(Number(req.body?.hz) || 2, 0.2), 10);
    await simulatorStart(nodes, hz);
    res.json({ running: true, nodes, hz });
  }));

  app.post('/api/foundry/simulator/stop', h(async (req, res) => {
    if (!simulator.timer) return res.status(409).json({ error: 'simulador parado' });
    await simulatorStop();
    res.json({ running: false, packetsSent: simulator.packetsSent });
  }));

  app.get('/api/foundry/log/verify', h(async (req, res) => {
    const all = await mongo.collection('foundry_log').find({}).sort({ seq: 1 }).toArray();
    let prev = '0'.repeat(64);
    for (const entry of all) {
      const { _id, seq, prevHash, hash, createdAt, ...rest } = entry;
      const expected = crypto.createHash('sha256').update(prev + sortedJson({ ...rest, seq })).digest('hex');
      if (expected !== hash || prevHash !== prev) {
        return res.json({ valid: false, totalEntries: all.length, brokenAtSeq: seq });
      }
      prev = hash;
    }
    res.json({ valid: true, totalEntries: all.length, brokenAtSeq: null });
  }));

  // Sentinel vigila el pipeline: mismas metricas bajo la mesa sentinel
  app.get('/api/sentinel/pipeline-metrics', (req, res) => res.json(metricsPayload()));

  /* ---- listener dedicado (endpoint privado, puerto cerrado) ---- */
  if (INGRESS_PORT) {
    const ingressApp = express();
    ingressApp.use(express.json({ limit: '256kb' }));
    ingressApp.post('/ingress', ingressHandler);
    ingressApp.get('/contract', contractHandler);
    ingressApp.get('/health', (req, res) => res.json({ ok: true, gateway: 'foundry', accepted: gatewayCounters.accepted }));
    ingressApp.listen(INGRESS_PORT, process.env.HOST || '0.0.0.0', () => {
      console.log(`[Foundry] Ingress Gateway dedicado → puerto ${INGRESS_PORT}`);
    });
  }

  /* ---- arranque ---- */
  async function seedFoundrySeq() {
    // alinear el contador atomico con logs escritos antes de introducirlo
    const tail = await mongo.collection('foundry_log').find().sort({ seq: -1 }).limit(1).next();
    if (tail) {
      await mongo.collection('foundry_seq').updateOne(
        { _id: 'counter' },
        { $max: { value: tail.seq } },
        { upsert: true },
      );
    }
  }

  Promise.all([loadNodes(), initHerzogChain(), seedFoundrySeq()])
    .then(() => {
      spawnU2Worker();
      console.log(`[Foundry] Pipeline activo (${INGRESS_PORT ? `ingress dedicado :${INGRESS_PORT}` : 'ingress embebido /api/foundry/ingress'}) · canales: ${CHANNELS.join(', ')}`);
    })
    .catch((err) => console.error('[Foundry] Error de arranque:', err.message));
}
