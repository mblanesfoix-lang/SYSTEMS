/**
 * Grid Interlink — worker de ingesta por pais (doctrina Instrucciones.txt §2).
 *
 * Un worker thread POR PAIS, aislado en memoria via resourceLimits (sandbox
 * V8 propio): si el servidor de datos de un TSO colapsa (DDOS, fallo masivo)
 * y este worker muere por OOM, cuelgue o crash, los workers de los demas
 * paises NO se enteran — la tuberia asincrona sigue al 100%.
 *
 * El worker NO toca Mongo ni credenciales: solo succiona telemetria (modo
 * live) o la sintetiza (modo sim), la normaliza al payload GridSignal de la
 * Grid Abstraction Layer y la emite al padre via postMessage. El Kernel
 * S-NFI procesa GridSignal de forma agnostica: no sabe si habla con REE o RTE.
 *
 * Chaos (demo de aislamiento, orden del Admin via padre):
 *   crash -> process.exit(13)   | el supervisor lo resucita con backoff
 *   stall -> bucle sincrono 45s | bloquea SOLO su event loop; padre detecta stale
 *   flood -> asignacion de memoria hasta que resourceLimits mata el worker
 */

import { parentPort, workerData } from 'node:worker_threads';
import { egressFetch, setEgressRecorder } from './egress/index.js';

const CODE = workerData?.code || 'XX';
const TSO = workerData?.tso || 'TSO';
const MODE = workerData?.mode === 'live' && workerData?.url ? 'live' : 'sim';
const URL_LIVE = workerData?.url || null;
const POLL_MS = Math.min(Math.max(Number(workerData?.pollMs) || 2000, 500), 60000);
const BASE_DEMAND = Number(workerData?.baseDemandMw) || 25000;

let stats = { emitted: 0, errors: 0, lastError: null, startedAt: new Date().toISOString() };
let seq = 0;
const phase = Math.random() * Math.PI * 2;
const floodHoard = [];

function num(...candidates) {
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function alertFor(frequencyHz) {
  if (frequencyHz === null) return 'sin_dato';
  const dev = Math.abs(frequencyHz - 50);
  if (dev > 0.3) return 'critico';
  if (dev > 0.15) return 'alerta';
  return 'nominal';
}

function simSignal() {
  const t = Date.now() / 1000;
  // pico de inestabilidad periodico para que PAIA/Cockpit tengan algo que ver
  const spike = seq > 0 && seq % 120 === 0 ? 0.35 : 0;
  const frequencyHz = Math.round((50 + Math.sin(t / 13 + phase) * 0.05 + (Math.random() - 0.5) * 0.04 + spike) * 1000) / 1000;
  const demandMw = Math.round(BASE_DEMAND * (1 + Math.sin(t / 3600 + phase) * 0.25 + (Math.random() - 0.5) * 0.02));
  const generationMw = Math.round(demandMw * (0.97 + Math.random() * 0.06));
  return {
    frequencyHz,
    demandMw,
    generationMw,
    renewablePct: Math.round((45 + Math.sin(t / 1800 + phase) * 20 + Math.random() * 5) * 10) / 10,
    priceEurMwh: Math.round((60 + Math.sin(t / 900 + phase) * 45 + Math.random() * 8) * 100) / 100,
  };
}

// La salida al TSO pasa por la compuerta de Pactvm Viridi (lista blanca de la
// mesa ophs); sus eventos se registran en el hilo principal.
setEgressRecorder((event) => parentPort.postMessage({ type: 'egress', event }));

async function liveSignal() {
  const res = await egressFetch(URL_LIVE, {}, { mesa: 'ophs', poll: true, timeoutMs: 5000 });
  if (!res.ok) throw new Error(`TSO ${TSO} HTTP ${res.status}`);
  const data = await res.json();
  // mapeo tolerante: cada adaptador nacional puede renombrar campos, la capa
  // de abstraccion siempre entrega el mismo GridSignal
  return {
    frequencyHz: num(data.frequencyHz, data.freq, data.frecuencia_hz),
    demandMw: num(data.demandMw, data.demand, data.demanda_mw),
    generationMw: num(data.generationMw, data.generation, data.generacion_mw),
    renewablePct: num(data.renewablePct, data.renewable_pct),
    priceEurMwh: num(data.priceEurMwh, data.price, data.precio_eur_mwh),
  };
}

async function tick() {
  try {
    const raw = MODE === 'live' ? await liveSignal() : simSignal();
    seq += 1;
    const signal = {
      country: CODE,
      tso: TSO,
      seq,
      ts_origin_us: Date.now() * 1000,
      mode: MODE,
      ...raw,
      alertLevel: alertFor(raw.frequencyHz),
    };
    stats.emitted += 1;
    parentPort.postMessage({ type: 'signal', signal });
  } catch (err) {
    stats.errors += 1;
    stats.lastError = String(err?.message || err);
    parentPort.postMessage({ type: 'error', error: stats.lastError });
  }
  if (seq % 10 === 0 || stats.errors % 5 === 1) {
    parentPort.postMessage({ type: 'stats', stats: { ...stats, heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1048576) } });
  }
}

parentPort.on('message', (msg) => {
  if (msg?.type !== 'chaos') return;
  if (msg.mode === 'crash') {
    process.exit(13);
  } else if (msg.mode === 'stall') {
    const until = Date.now() + 45000;
    while (Date.now() < until) { /* bucle sincrono: solo congela ESTE worker */ }
  } else if (msg.mode === 'flood') {
    // simula saturacion por DDOS: crece hasta que resourceLimits ejecuta al worker
    const hoard = setInterval(() => {
      for (let i = 0; i < 50; i += 1) floodHoard.push(Buffer.alloc(1048576, 1));
    }, 20);
    hoard.unref?.();
  }
});

parentPort.postMessage({ type: 'ready', mode: MODE, tso: TSO });
setInterval(() => { tick(); }, POLL_MS);
