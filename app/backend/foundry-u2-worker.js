/**
 * Data Foundry — S-NFI U-2 siphon worker.
 *
 * Worker thread totalmente independiente del hilo principal del OPHS Framework
 * (doctrina Instrucciones.txt §3). Consumidor pasivo: recibe paquetes de
 * telemetria via postMessage, los acumula en un buffer local y hace bulk-insert
 * periodico en la coleccion time-series `u2_timeseries`.
 *
 * Backpressure control: si el buffer supera BUFFER_CAP se aplica descarte
 * ordenado (se tiran los paquetes mas antiguos primero) y se contabiliza.
 * La estabilidad del hilo principal / hardware prima sobre la recoleccion
 * cientifica: este worker jamas bloquea a quien le envia.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { MongoClient } from 'mongodb';

const MONGO_URI = workerData?.mongoUri;
const BUFFER_CAP = Number(workerData?.bufferCap) || 10000;
const FLUSH_MS = Number(workerData?.flushMs) || 2000;
const FLUSH_BATCH = Number(workerData?.flushBatch) || 500;

let buffer = [];
let stats = {
  received: 0,
  inserted: 0,
  discarded: 0,   // descarte ordenado por backpressure
  failedFlushes: 0,
  lastFlushMs: null,
  lastFlushAt: null,
  buffered: 0,
};

let client = null;
let col = null;

async function connect() {
  if (!MONGO_URI) throw new Error('U2 worker: mongoUri no recibido en workerData');
  client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db('elvira');
  col = db.collection('u2_timeseries');
  await col.createIndex({ nodeId: 1, ts_origin_us: -1 });
  await col.createIndex({ siphonedAt: -1 });
}

parentPort.on('message', (msg) => {
  if (!msg || msg.type !== 'packet') return;
  stats.received += 1;
  buffer.push({
    nodeId: msg.packet.nodeId,
    seq: msg.packet.seq,
    ts_origin_us: msg.packet.ts_origin_us,
    metrics: msg.packet.metrics,
    t_gateway_us: msg.t_gateway_us,
    siphonedAt: new Date().toISOString(),
  });
  // Backpressure: descarte ordenado (los mas antiguos fuera primero)
  if (buffer.length > BUFFER_CAP) {
    const excess = buffer.length - BUFFER_CAP;
    buffer.splice(0, excess);
    stats.discarded += excess;
  }
  stats.buffered = buffer.length;
});

async function flushLoop() {
  for (;;) {
    await new Promise((r) => setTimeout(r, FLUSH_MS));
    if (buffer.length === 0) {
      publishStats();
      continue;
    }
    const batch = buffer.splice(0, Math.min(buffer.length, FLUSH_BATCH));
    const t0 = Date.now();
    try {
      await col.insertMany(batch, { ordered: false });
      stats.inserted += batch.length;
      stats.lastFlushMs = Date.now() - t0;
      stats.lastFlushAt = new Date().toISOString();
    } catch (err) {
      stats.failedFlushes += 1;
      // devolver el batch al frente respetando backpressure
      buffer = batch.concat(buffer);
      if (buffer.length > BUFFER_CAP) {
        const excess = buffer.length - BUFFER_CAP;
        buffer.splice(0, excess);
        stats.discarded += excess;
      }
      parentPort.postMessage({ type: 'error', error: String(err?.message || err) });
    }
    stats.buffered = buffer.length;
    publishStats();
  }
}

function publishStats() {
  parentPort.postMessage({ type: 'stats', stats: { ...stats } });
}

connect()
  .then(() => {
    parentPort.postMessage({ type: 'ready' });
    flushLoop();
  })
  .catch((err) => {
    parentPort.postMessage({ type: 'fatal', error: String(err?.message || err) });
    process.exit(1);
  });
