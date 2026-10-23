/**
 * Grid Interlink — orquestacion de redes electricas transnacionales bajo
 * doctrina OPHS (Instrucciones.txt §2) con aislamiento de carga (§ punto 3).
 *
 * Grid Abstraction Layer: cada pais (REE/REN/RTE/ONEE...) se succiona desde
 * un worker thread PROPIO con resourceLimits (sandbox de memoria V8
 * independiente). El colapso del servidor de datos de un pais (DDOS, fallo
 * masivo de red) mata o congela SOLO su worker; el supervisor lo detecta,
 * lo aisla y lo resucita con backoff exponencial mientras las tuberias de
 * los demas paises siguen al 100% de rendimiento.
 *
 * El Kernel consume el payload GridSignal estandarizado — agnostico del
 * operador nacional. Reflejo hacia PAIA: SOLO notificacion al Admin en
 * alerta critica; ninguna accion automatica sobre nodos (Regla de Oro:
 * la intervencion real pasa por Central con confirmacion humana).
 */

import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runAsTenant } from './db/tenant-context.js';
import { DEFAULT_TENANT_ID } from './db/tenant-registry.js';
import { appendChained, verifyLog } from './lib/hash-chain.js';
import { recordEgress } from './egress/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CODE_RE = /^[A-Z]{2}$/;
const CHAOS_MODES = ['crash', 'stall', 'flood'];
const RING_CAP = 300;
const SIGNAL_TTL_S = 7 * 24 * 3600;
const BACKOFF_STEPS_MS = [5000, 10000, 20000, 40000, 60000];
const STABLE_RESET_MS = 5 * 60 * 1000;

const DEFAULT_COUNTRIES = [
  { code: 'ES', tso: 'REE', label: 'Red Electrica de España', baseDemandMw: 28000 },
  { code: 'PT', tso: 'REN', label: 'Rede Electrica Nacional', baseDemandMw: 6500 },
  { code: 'FR', tso: 'RTE', label: "Reseau de Transport d'Electricite", baseDemandMw: 52000 },
  { code: 'MA', tso: 'ONEE', label: "Office National de l'Electricite (Maroc)", baseDemandMw: 7200 },
];

const appendGridLog = (mongo, entry) => appendChained(mongo, 'grid_log', entry);

export function mountGridInterlink(app, { auth, requireMesa, mongo, busEmit, adminNotify, cibe }) {
  const AUTOSTART = process.env.GRID_AUTOSTART !== '0';
  const MAX_OLD_MB = Number(process.env.GRID_WORKER_MAX_OLD_MB) || 96;

  /* ---- supervisores por pais ---- */
  // code -> { config, worker, state, ring[], stats, restarts, backoffStep,
  //           lastSignalAt, respawnTimer, stableTimer, workerStats }
  const countries = new Map();

  function countryEnvUrl(code) {
    return process.env[`GRID_${code}_URL`] || null;
  }

  function snapshot(c) {
    const last = c.ring[c.ring.length - 1] || null;
    return {
      code: c.config.code,
      tso: c.config.tso,
      label: c.config.label,
      mode: c.config.url || countryEnvUrl(c.config.code) ? 'live' : 'sim',
      active: c.config.active !== false,
      workerState: c.state,
      restarts: c.restarts,
      pollMs: c.config.pollMs || 2000,
      lastSignalAt: c.lastSignalAt ? new Date(c.lastSignalAt).toISOString() : null,
      lastSignal: last,
      worker: c.workerStats,
      sandbox: { maxOldGenerationSizeMb: MAX_OLD_MB },
    };
  }

  function emitIsolationEvent(code, state, detail) {
    const label = `Grid · ${code} ${state}`;
    busEmit({
      id: crypto.randomUUID(), ts: new Date().toISOString(),
      origin: 'GRID', dest: 'SENTINEL', type: 'grid_isolation',
      state: state === 'restaurado' ? 'DONE' : 'BLOCKED',
      label, payload: { country: code, detail }, user: 'system',
    });
    // Sin TSO real conectado (GRID_<CC>_URL) el pais corre en modo sim/chaos-demo:
    // crashes y stalls son ruido esperado, no incidencias -> solo bus+log, sin Admin.
    if (state !== 'restaurado' && countryEnvUrl(code)) {
      adminNotify({
        origin: 'GRID', severity: 'warning', label,
        detail: `${detail} — resto de paises operando al 100% (aislamiento de carga)`,
      });
    }
    appendGridLog(mongo, { action: `isolation.${state}`, actorId: 'system', detail: { country: code, info: detail } }).catch(() => {});
  }

  function spawnWorker(c) {
    const cfg = c.config;
    const url = cfg.url || countryEnvUrl(cfg.code);
    let worker;
    try {
      worker = new Worker(path.join(__dirname, 'grid-country-worker.js'), {
        workerData: {
          code: cfg.code, tso: cfg.tso,
          mode: url ? 'live' : 'sim', url,
          pollMs: cfg.pollMs || 2000,
          baseDemandMw: cfg.baseDemandMw,
        },
        // sandbox de memoria: el heap de este pais no puede crecer sobre el
        // proceso principal ni sobre los demas paises
        resourceLimits: {
          maxOldGenerationSizeMb: MAX_OLD_MB,
          maxYoungGenerationSizeMb: 16,
          stackSizeMb: 4,
        },
      });
    } catch (err) {
      c.state = `error (${err.message})`;
      scheduleRespawn(c);
      return;
    }
    c.worker = worker;
    c.state = 'arrancando';

    worker.on('message', (msg) => {
      if (msg.type === 'ready') {
        const wasDown = c.restarts > 0 && c.state !== 'activo';
        c.state = 'activo';
        if (wasDown) emitIsolationEvent(cfg.code, 'restaurado', `worker ${cfg.tso} de vuelta tras ${c.restarts} reinicios`);
        if (c.stableTimer) clearTimeout(c.stableTimer);
        c.stableTimer = setTimeout(() => { c.backoffStep = 0; }, STABLE_RESET_MS);
        c.stableTimer.unref?.();
      } else if (msg.type === 'signal') {
        c.lastSignalAt = Date.now();
        c.ring.push(msg.signal);
        if (c.ring.length > RING_CAP) c.ring.shift();
        const doc = { _id: crypto.randomUUID(), ...msg.signal, receivedAt: new Date() };
        mongo.collection('grid_signals').insertOne(doc).catch(() => {});
        // Reflejo PAIA: aviso al Admin en alerta critica REAL (modo live).
        // En modo sim la telemetria es sintetica (pico periodico de demo), no
        // es una incidencia -> no se notifica. Ademas anti-spam: una sola
        // notificacion por pais mientras dure el episodio critico (rearmado
        // cuando la frecuencia vuelve a rango nominal).
        if (msg.signal.mode === 'live' && msg.signal.alertLevel === 'critico') {
          if (!c.criticalNotified) {
            c.criticalNotified = true;
            adminNotify({
              origin: 'GRID', severity: 'warning',
              label: `Grid ${cfg.code}/${cfg.tso} · frecuencia critica ${msg.signal.frequencyHz} Hz`,
              detail: 'reflejo PAIA: solo aviso — cualquier orden a nodos pasa por Central con confirmacion humana',
            });
          }
        } else if (msg.signal.alertLevel === 'nominal') {
          c.criticalNotified = false;
        }
      } else if (msg.type === 'stats') {
        c.workerStats = msg.stats;
      } else if (msg.type === 'error') {
        c.workerStats = { ...(c.workerStats || {}), lastError: msg.error };
      } else if (msg.type === 'egress') {
        // el worker sale por la compuerta; su registro se guarda desde aqui
        recordEgress(msg.event);
      }
    });

    worker.on('exit', (code) => {
      c.worker = null;
      if (c.stopping) {
        c.stopping = false;
        if (c.restartRequested) {
          // parada intencionada (restart/patch/stall): respawn sin evento "caido"
          c.restartRequested = false;
          c.state = 'reiniciando';
          scheduleRespawn(c);
        } else {
          c.state = 'parado';
        }
        return;
      }
      c.state = `caido (exit ${code})`;
      c.restarts += 1;
      emitIsolationEvent(cfg.code, 'caido', `worker ${cfg.tso} terminado (exit ${code}: crash/OOM sandbox)`);
      scheduleRespawn(c);
    });
    worker.on('error', () => { /* exit gestiona el respawn */ });
  }

  function scheduleRespawn(c) {
    if (c.respawnTimer || c.config.active === false) return;
    const delay = BACKOFF_STEPS_MS[Math.min(c.backoffStep, BACKOFF_STEPS_MS.length - 1)];
    c.backoffStep += 1;
    c.respawnTimer = setTimeout(() => { c.respawnTimer = null; spawnWorker(c); }, delay);
    c.respawnTimer.unref?.();
  }

  function stopWorker(c) {
    if (!c.worker) return;
    c.stopping = true;
    c.worker.terminate().catch(() => {});
  }

  function startCountry(config) {
    const existing = countries.get(config.code);
    if (existing) {
      existing.config = config;
      return existing;
    }
    const c = {
      config, worker: null, state: 'parado', ring: [], restarts: 0,
      backoffStep: 0, lastSignalAt: null, respawnTimer: null, stableTimer: null,
      workerStats: null, stopping: false, criticalNotified: false,
    };
    countries.set(config.code, c);
    if (config.active !== false) spawnWorker(c);
    return c;
  }

  /* ---- detector de workers congelados (stall/DDOS sin crash) ---- */
  setInterval(() => {
    for (const c of countries.values()) {
      if (c.state !== 'activo' || !c.worker) continue;
      const staleMs = Math.max((c.config.pollMs || 2000) * 5, 10000);
      if (c.lastSignalAt && Date.now() - c.lastSignalAt > staleMs) {
        c.state = 'sin señal (congelado)';
        emitIsolationEvent(c.config.code, 'congelado', `sin GridSignal en ${Math.round(staleMs / 1000)}s: aislando y reiniciando worker`);
        c.restarts += 1;
        c.restartRequested = true;
        stopWorker(c); // el handler 'exit' hace el respawn sin evento "caido" duplicado
      }
    }
  }, 5000).unref();

  /* ---- arranque: paises por defecto + overrides Mongo ---- */
  async function boot() {
    await mongo.collection('grid_signals').createIndex({ country: 1, receivedAt: -1 });
    await mongo.collection('grid_signals').createIndex({ receivedAt: 1 }, { expireAfterSeconds: SIGNAL_TTL_S });
    const stored = await mongo.collection('grid_countries').find({}).toArray();
    const byCode = new Map(stored.map((s) => [s.code, s]));
    const configs = [];
    for (const d of DEFAULT_COUNTRIES) {
      configs.push({ ...d, ...(byCode.get(d.code) || {}) });
      byCode.delete(d.code);
    }
    configs.push(...byCode.values());
    if (AUTOSTART) {
      for (const cfg of configs) startCountry(cfg);
    } else {
      for (const cfg of configs) countries.set(cfg.code, {
        config: cfg, worker: null, state: 'parado (GRID_AUTOSTART=0)', ring: [], restarts: 0,
        backoffStep: 0, lastSignalAt: null, respawnTimer: null, stableTimer: null, workerStats: null, stopping: false, criticalNotified: false,
      });
    }
    console.log(`[Grid] Interlink activo · ${configs.length} paises (${configs.map((c) => c.code).join(', ')}) · sandbox ${MAX_OLD_MB}MB/worker`);
  }

  /* ---------------- Rutas HTTP (mesa ophs) ---------------- */

  const guard = [auth, requireMesa('ophs')];
  const command = [...guard, cibe.guard('grid.command')];
  const h = (fn) => (req, res) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      console.error('[Grid] route error:', err?.message || err);
      if (!res.headersSent) res.status(500).json({ error: String(err?.message || err) });
    });
  };

  app.get('/api/grid/status', ...guard, (req, res) => {
    res.json({
      generatedAt: new Date().toISOString(),
      autostart: AUTOSTART,
      isolation: 'un worker thread por pais con resourceLimits: el colapso de un TSO no toca a los demas',
      countries: [...countries.values()].map(snapshot),
    });
  });

  app.get('/api/grid/summary', ...guard, (req, res) => {
    const out = [];
    for (const c of countries.values()) {
      const last = c.ring[c.ring.length - 1] || null;
      out.push({
        code: c.config.code, tso: c.config.tso, workerState: c.state,
        frequencyHz: last?.frequencyHz ?? null, demandMw: last?.demandMw ?? null,
        priceEurMwh: last?.priceEurMwh ?? null, alertLevel: last?.alertLevel ?? 'sin_dato',
        restarts: c.restarts,
      });
    }
    res.json({ countries: out });
  });

  app.get('/api/grid/signals', ...guard, h(async (req, res) => {
    const code = String(req.query.country || '').toUpperCase();
    const limit = Math.min(Number(req.query.limit) || 100, RING_CAP);
    if (req.query.persisted === '1') {
      const q = CODE_RE.test(code) ? { country: code } : {};
      const rows = await mongo.collection('grid_signals').find(q).sort({ receivedAt: -1 }).limit(limit).toArray();
      return res.json(rows.map(({ _id, ...r }) => ({ id: _id, ...r })));
    }
    const c = countries.get(code);
    if (!c) return res.status(404).json({ error: 'pais no registrado' });
    res.json(c.ring.slice(-limit).reverse());
  }));

  app.post('/api/grid/countries', ...command, h(async (req, res) => {
    const b = req.body || {};
    const code = String(b.code || '').toUpperCase().trim();
    if (!CODE_RE.test(code)) return res.status(400).json({ error: 'code invalido (ISO-2, ej: IT)' });
    if (countries.has(code)) return res.status(409).json({ error: 'pais ya registrado' });
    const tso = String(b.tso || '').trim().slice(0, 40);
    if (!tso) return res.status(400).json({ error: 'tso requerido' });
    const config = {
      code, tso,
      label: typeof b.label === 'string' ? b.label.trim().slice(0, 200) : tso,
      url: typeof b.url === 'string' && b.url.startsWith('http') ? b.url.trim() : null,
      pollMs: Math.min(Math.max(Number(b.pollMs) || 2000, 500), 60000),
      baseDemandMw: Number(b.baseDemandMw) || 10000,
      active: true,
    };
    await mongo.collection('grid_countries').updateOne({ code }, { $set: config }, { upsert: true });
    startCountry(config);
    await appendGridLog(mongo, { action: 'country.register', actorId: req.user, detail: { code, tso, mode: config.url ? 'live' : 'sim' } });
    res.status(201).json(snapshot(countries.get(code)));
  }));

  app.patch('/api/grid/countries/:code', ...command, h(async (req, res) => {
    const code = String(req.params.code).toUpperCase();
    const c = countries.get(code);
    if (!c) return res.status(404).json({ error: 'pais no registrado' });
    const b = req.body || {};
    const $set = {};
    if (b.url !== undefined) $set.url = typeof b.url === 'string' && b.url.startsWith('http') ? b.url.trim() : null;
    if (b.pollMs !== undefined) $set.pollMs = Math.min(Math.max(Number(b.pollMs) || 2000, 500), 60000);
    if (b.label !== undefined) $set.label = String(b.label).trim().slice(0, 200);
    if (b.active !== undefined) $set.active = !!b.active;
    if (Object.keys($set).length === 0) return res.status(400).json({ error: 'sin campos validos' });
    c.config = { ...c.config, ...$set };
    await mongo.collection('grid_countries').updateOne({ code }, { $set: { ...c.config } }, { upsert: true });
    await appendGridLog(mongo, { action: 'country.update', actorId: req.user, detail: { code, $set } });
    if ($set.active === false) stopWorker(c);
    else if (!c.worker && c.config.active !== false) { c.backoffStep = 0; spawnWorker(c); }
    else if ($set.url !== undefined || $set.pollMs !== undefined) { c.backoffStep = 0; c.restartRequested = true; stopWorker(c); }
    res.json(snapshot(c));
  }));

  app.post('/api/grid/countries/:code/restart', ...command, h(async (req, res) => {
    const code = String(req.params.code).toUpperCase();
    const c = countries.get(code);
    if (!c) return res.status(404).json({ error: 'pais no registrado' });
    c.backoffStep = 0;
    if (c.worker) { c.restartRequested = true; stopWorker(c); }
    else scheduleRespawn(c);
    await appendGridLog(mongo, { action: 'country.restart', actorId: req.user, detail: { code } });
    res.json({ code, restarting: true });
  }));

  // Demo de aislamiento: colapsa UN pais a proposito y observa en /status que
  // los demas siguen emitiendo. crash|stall|flood (flood = OOM del sandbox).
  app.post('/api/grid/countries/:code/chaos', ...command, h(async (req, res) => {
    const code = String(req.params.code).toUpperCase();
    const mode = req.body?.mode;
    const c = countries.get(code);
    if (!c) return res.status(404).json({ error: 'pais no registrado' });
    if (!CHAOS_MODES.includes(mode)) return res.status(400).json({ error: `mode debe ser ${CHAOS_MODES.join('|')}` });
    if (!c.worker || c.state !== 'activo') return res.status(409).json({ error: `worker ${code} no activo (${c.state})` });
    c.worker.postMessage({ type: 'chaos', mode });
    await appendGridLog(mongo, { action: 'chaos.inject', actorId: req.user, detail: { code, mode } });
    res.json({ code, mode, note: 'colapso inyectado solo en este pais: verificar en GET /api/grid/status que el resto sigue al 100%' });
  }));

  app.get('/api/grid/log/verify', ...guard, h(async (req, res) => {
    res.json(await verifyLog(mongo, 'grid_log'));
  }));

  // Arranque de boot, fuera de cualquier request: corre explicitamente
  // contra el tenant por defecto (runAsTenant). AsyncLocalStorage propaga el
  // contexto a los listeners worker.on('message', ...) registrados dentro
  // de boot() aunque el Worker corra en otro hilo (el listener en si vive en
  // el hilo principal, verificado empiricamente), asi que la insercion
  // mongo.collection('grid_signals')... dentro de ese callback tambien queda
  // resuelta sin envolverla aparte.
  runAsTenant(DEFAULT_TENANT_ID, () => boot().catch((err) => console.error('[Grid] Error de arranque:', err.message)));
}
