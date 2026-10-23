/**
 * ELVI-RA · Centro de mando · orquestador (puentes mock + OPHS scoring)
 * Endpoints mock estructurados, listos para enchufar Sentinel + Herzog reales.
 *
 * Incluye: overview agregado, Systems registry, OPHS scoring (Dictamen de
 * Soberanía) + webhook de integración externa, T'Controler (consumo tokens),
 * y los puentes mock de Sentinel/Herzog. Usa el mismo estado de Elvi-Ra
 * (readElvira/updateElvira, routes/elvira-store.js) que reff-crm.routes.js,
 * cnmc.routes.js y la contabilidad del módulo de IA.
 */

import crypto from 'node:crypto';
import { llmStatus } from '../llm/index.js';
import { userCostUsd } from '../llm/usage.js';
import { egressFetch } from '../egress/index.js';

/* ---------- USD -> EUR exchange rate (cached 1h, frankfurter.app, sin API key, por la compuerta de Pactvm) ---------- */
let exchangeRateCache = { rate: 0.92, fetchedAt: 0 };
async function getUsdToEurRate() {
  const ONE_HOUR = 60 * 60 * 1000;
  if (Date.now() - exchangeRateCache.fetchedAt < ONE_HOUR) return exchangeRateCache.rate;
  try {
    const r = await egressFetch('https://api.frankfurter.app/latest?from=USD&to=EUR', {}, { mesa: 'elvira', poll: true });
    if (r.ok) {
      const data = await r.json();
      if (data.rates?.EUR) exchangeRateCache = { rate: data.rates.EUR, fetchedAt: Date.now() };
    }
  } catch { /* mantiene ultima tasa conocida */ }
  return exchangeRateCache.rate;
}

export function mountElviraBridges(app, {
  auth, mongo, busEmit,
  readElvira, updateElvira,
}) {
  /* Overview agregado: estado sistemas + métricas globales */
  app.get('/api/elvira/overview', auth, async (req, res) => {
    const state = await readElvira();
    const [totalUsers, activeSessions, totalCompanies] = await Promise.all([
      mongo.collection('users').countDocuments(),
      mongo.collection('sessions').countDocuments({ exp: { $gt: new Date() } }),
      mongo.collection('companies').countDocuments(),
    ]);

    res.json({
      systems: state.systems,
      metrics: {
        totalUsers,
        activeSessions,
        totalCompanies,
        dictamenes: (state.ophs?.dictamenes || []).length,
      },
      updatedAt: state.updatedAt,
    });
  });

  /* ---------- Systems registry ---------- */
  app.get('/api/elvira/systems', auth, async (req, res) => {
    const state = await readElvira();
    res.json(state.systems);
  });

  app.put('/api/elvira/systems/:key', auth, async (req, res) => {
    if (req.role !== 'admin') return res.status(403).json({ error: 'admin requerido' });
    const key = String(req.params.key);
    const allowed = ['status', 'endpoint', 'tokensUsed', 'tokensCap', 'backend'];
    const sys = await updateElvira((state) => {
      const target = Object.hasOwn(state.systems, key) ? state.systems[key] : null;
      if (!target) return null;
      for (const k of allowed) if (k in req.body) target[k] = req.body[k];
      target.lastPing = new Date().toISOString();
      return target;
    });
    if (!sys) return res.status(404).json({ error: 'sistema no registrado' });
    res.json(sys);
  });

  /* Mock ping — sustituir por handshake real cuando exista */
  app.post('/api/elvira/systems/:key/ping', auth, async (req, res) => {
    const key = String(req.params.key);
    const t0 = Date.now();
    const sys = await updateElvira((state) => {
      const target = Object.hasOwn(state.systems, key) ? state.systems[key] : null;
      if (!target) return null;
      target.latencyMs = Math.floor(8 + Math.random() * 22);
      target.lastPing = new Date().toISOString();
      if (target.endpoint) target.status = 'connected';
      return target;
    });
    if (!sys) return res.status(404).json({ error: 'sistema no registrado' });
    res.json({ key, ...sys, ackMs: Date.now() - t0 });
  });

  /* ---------- OPHS · scoring centralizado ---------- */
  /*
   * Scoring heurístico Dictamen de Soberanía.
   * Variables: W,I,S,M,E,R,B,G,U2  (0-100 cada una).
   * OPHS = sum(weights[k] * vars[k]).
   * Clasificación: ESTRATEGICO >= threshold.estrategico, OPERATIVO >= threshold.operativo, NO_CANDIDATO resto.
   * Penalización dura: vars.G === 0 (tóxico Herzog) o flags.biogas → NO_CANDIDATO.
   */
  app.get('/api/elvira/ophs', auth, async (req, res) => {
    const state = await readElvira();
    res.json(state.ophs);
  });

  app.put('/api/elvira/ophs/config', auth, async (req, res) => {
    if (req.role !== 'admin') return res.status(403).json({ error: 'admin requerido' });
    const { weights, threshold } = req.body || {};
    const config = await updateElvira((state) => {
      if (weights && typeof weights === 'object') state.ophs.weights = { ...state.ophs.weights, ...weights };
      if (threshold && typeof threshold === 'object') state.ophs.threshold = { ...state.ophs.threshold, ...threshold };
      return { weights: state.ophs.weights, threshold: state.ophs.threshold };
    });
    res.json(config);
  });

  app.post('/api/elvira/ophs/score', auth, async (req, res) => {
    const { vars = {}, flags = {}, nodo = '' } = req.body || {};
    const dictamen = await updateElvira((state) => {
      const w = state.ophs.weights;
      const th = state.ophs.threshold;
      const keys = ['W','I','S','M','E','R','B','G','U2'];
      const clean = {};
      let total = 0;
      for (const k of keys) {
        const v = Math.max(0, Math.min(100, Number(vars[k] ?? 0)));
        clean[k] = v;
        total += (w[k] || 0) * v;
      }
      let ophs = Math.round(total);
      let clasificacion = 'NO_CANDIDATO';
      let razonDescarte = '';
      if (flags.biogas)              { ophs = Math.min(ophs, 30); razonDescarte = 'Dependencia biogás/anaerobia'; }
      else if (flags.cnmcSancion)    { ophs = Math.min(ophs, 25); razonDescarte = 'Sanción CNMC previa'; }
      else if (clean.G === 0)        { ophs = Math.min(ophs, 20); razonDescarte = 'Gobernanza tóxica (Herzog bloquea)'; }
      if (!razonDescarte) {
        if (ophs >= th.estrategico) clasificacion = 'ESTRATEGICO';
        else if (ophs >= th.operativo) clasificacion = 'OPERATIVO';
      }
      const dictamen = {
        id: crypto.randomUUID(),
        nodo: String(nodo || '').trim(),
        vars: clean,
        flags,
        ophs,
        clasificacion,
        razonDescarte,
        createdAt: new Date().toISOString(),
        user: req.user,
      };
      state.ophs.dictamenes.unshift(dictamen);
      state.ophs.dictamenes = state.ophs.dictamenes.slice(0, 100);
      return dictamen;
    });
    res.json(dictamen);
  });

  /* GET /api/elvira/ophs/dictamenes/:id/report — Dictamen de Soberania descargable */
  app.get('/api/elvira/ophs/dictamenes/:id/report', auth, async (req, res) => {
    const state = await readElvira();
    const dictamen = (state.ophs.dictamenes || []).find(d => d.id === req.params.id);
    if (!dictamen) return res.status(404).json({ error: 'dictamen no encontrado' });
    res.json({
      tipo:        'DICTAMEN_DE_SOBERANIA',
      generadoEn:  new Date().toISOString(),
      generadoPor: req.user,
      dictamen,
    });
  });

  /* ---------- T'Controler · consumo de tokens (Admin) ---------- */
  app.get('/api/elvira/tcontroler', auth, async (req, res) => {
    if (req.role !== 'admin') return res.status(403).json({ error: 'admin requerido' });
    const state = await readElvira();
    const tc = state.systems.tcontroler || {};
    const byUser = tc.byUser || {};
    const eurRate = await getUsdToEurRate();
    const ai = llmStatus();

    const users = Object.entries(byUser).map(([user, u]) => {
      const totalTokens = u.inputTokens + u.outputTokens;
      const costTotalUSD = userCostUsd(u, ai.pricing);
      return {
        user,
        calls: u.calls,
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        webSearches: u.webSearches || 0,
        totalTokens,
        costTotalUSD,
        costTotalEUR: costTotalUSD * eurRate,
        operations: u.operations || {},
        lastCall: u.lastCall || null,
      };
    }).sort((a, b) => b.totalTokens - a.totalTokens);

    const global = users.reduce((acc, u) => {
      acc.calls += u.calls;
      acc.inputTokens += u.inputTokens;
      acc.outputTokens += u.outputTokens;
      acc.totalTokens += u.totalTokens;
      acc.costTotalUSD += u.costTotalUSD;
      acc.costTotalEUR += u.costTotalEUR;
      return acc;
    }, { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costTotalUSD: 0, costTotalEUR: 0 });

    // El coste de cada llamada se guardó con la tarifa de su proveedor; la tarifa
    // vigente solo valora los tokens que llegaron sin ella.
    res.json({
      provider: ai.provider,
      model: ai.model,
      pricing: {
        inputPer1M: ai.pricing?.inputPerM ?? null,
        outputPer1M: ai.pricing?.outputPerM ?? null,
        perWebSearch: ai.pricing?.perWebSearch ?? null,
        usdToEur: eurRate,
      },
      tokensCap: tc.tokensCap || 0,
      global,
      byUser: users,
      updatedAt: state.updatedAt,
    });
  });

  app.delete('/api/elvira/tcontroler/reset', auth, async (req, res) => {
    if (req.role !== 'admin') return res.status(403).json({ error: 'admin requerido' });
    await updateElvira((state) => {
      const tc = state.systems.tcontroler || (state.systems.tcontroler = { status: 'local', tokensUsed: 0, tokensCap: 0 });
      tc.byUser = {};
      tc.tokensUsed = 0;
    });
    setImmediate(() => busEmit({
      id: crypto.randomUUID(), ts: new Date().toISOString(),
      origin: 'ELVI-RA', dest: 'TCONTROLER', type: 'event', state: 'COMPLETED',
      label: `TCONTROLER RESET · ${req.user}`, payload: {}, user: req.user,
    }));
    res.json({ ok: true });
  });

  /* ---------- OPHS Webhook · puerto de integración externa ---------- */
  /*
   * Receptor de eventos/scores OPHS enviados por sistemas externos.
   * Autenticación: Bearer token de Elvi-Ra (mismo auth middleware).
   * Cuando Pactvm Viridi / sistema OPHS real exista, apunta aquí su webhook.
   *
   * Payload esperado:
   *   { type: "event"|"score", source: "string", payload: {...} }
   *
   * Los eventos quedan en state.ophs.webhookEvents (últimos 200).
   * Los scores de tipo "score" también corren por el mismo pipeline de /ophs/score
   * si incluyen el campo "vars".
   */
  app.get('/api/elvira/ophs/webhook', auth, async (req, res) => {
    const state = await readElvira();
    res.json({
      status: 'active',
      endpoint: '/api/elvira/ophs/webhook',
      events: (state.ophs.webhookEvents || []).slice(0, 50),
      description: 'Puerto OPHS — receptor webhook para integración externa. POST aquí para enviar eventos o scores.',
    });
  });

  app.post('/api/elvira/ophs/webhook', auth, async (req, res) => {
    const b = req.body || {};
    const type    = String(b.type || 'event');   // "event" | "score"
    const source  = String(b.source || 'external');
    const payload = b.payload && typeof b.payload === 'object' ? b.payload : {};

    const entry = await updateElvira((state) => {
      if (!state.ophs.webhookEvents) state.ophs.webhookEvents = [];

      const entry = {
        id: crypto.randomUUID(),
        type,
        source,
        payload,
        receivedAt: new Date().toISOString(),
        user: req.user,
      };

      // Si es un score con vars, ejecutar el pipeline OPHS y adjuntar dictamen
      if (type === 'score' && payload.vars && typeof payload.vars === 'object') {
        const w  = state.ophs.weights;
        const th = state.ophs.threshold;
        const keys = ['W','I','S','M','E','R','B','G','U2'];
        const flags = payload.flags || {};
        const clean = {};
        let total = 0;
        for (const k of keys) {
          const v = Math.max(0, Math.min(100, Number(payload.vars[k] ?? 0)));
          clean[k] = v;
          total += (w[k] || 0) * v;
        }
        let ophs = Math.round(total);
        let clasificacion = 'NO_CANDIDATO';
        let razonDescarte = '';
        if (flags.biogas)           { ophs = Math.min(ophs, 30); razonDescarte = 'Dependencia biogás/anaerobia'; }
        else if (flags.cnmcSancion) { ophs = Math.min(ophs, 25); razonDescarte = 'Sanción CNMC previa'; }
        else if (clean.G === 0)     { ophs = Math.min(ophs, 20); razonDescarte = 'Gobernanza tóxica (Herzog bloquea)'; }
        if (!razonDescarte) {
          if (ophs >= th.estrategico) clasificacion = 'ESTRATEGICO';
          else if (ophs >= th.operativo) clasificacion = 'OPERATIVO';
        }
        const dictamen = {
          id: crypto.randomUUID(),
          nodo: String(payload.nodo || '').trim(),
          vars: clean,
          flags,
          ophs,
          clasificacion,
          razonDescarte,
          createdAt: new Date().toISOString(),
          user: req.user,
          viaWebhook: true,
          webhookSource: source,
        };
        state.ophs.dictamenes.unshift(dictamen);
        state.ophs.dictamenes = state.ophs.dictamenes.slice(0, 100);
        entry.dictamen = dictamen;
      }

      state.ophs.webhookEvents.unshift(entry);
      state.ophs.webhookEvents = state.ophs.webhookEvents.slice(0, 200);
      return entry;
    });
    res.status(201).json(entry);
  });

  /* ---------- Sentinel bridge (mock) ---------- */
  /* Espejo de eventos de identidad/acceso. Real Sentinel publicará aquí. */
  app.get('/api/elvira/sentinel/events', auth, async (req, res) => {
    const state = await readElvira();
    res.json(state.bridges.sentinel.events.slice(0, 50));
  });

  app.post('/api/elvira/sentinel/events', auth, async (req, res) => {
    const b = req.body || {};
    const ev = {
      id: crypto.randomUUID(),
      type: String(b.type || 'access'),       // access | denied | attempt | identity
      subject: String(b.subject || ''),
      detail: String(b.detail || ''),
      severity: String(b.severity || 'info'), // info | warn | critical
      createdAt: new Date().toISOString(),
    };
    await updateElvira((state) => {
      state.bridges.sentinel.events.unshift(ev);
      state.bridges.sentinel.events = state.bridges.sentinel.events.slice(0, 200);
    });
    res.status(201).json(ev);
  });

  /* ---------- Herzog bridge (mock) ---------- */
  /* Auditoría Fase 4 protocolo S-NFI. Real Herzog publicará aquí. */
  app.get('/api/elvira/herzog/audits', auth, async (req, res) => {
    const state = await readElvira();
    res.json(state.bridges.herzog.audits.slice(0, 50));
  });

  app.post('/api/elvira/herzog/audits', auth, async (req, res) => {
    const b = req.body || {};
    const a = {
      id: crypto.randomUUID(),
      candidato: String(b.candidato || ''),
      veredicto: String(b.veredicto || 'pendiente'), // apto | toxico | pendiente
      fase: String(b.fase || 'F4'),
      motivo: String(b.motivo || ''),
      createdAt: new Date().toISOString(),
      user: req.user,
    };
    await updateElvira((state) => {
      state.bridges.herzog.audits.unshift(a);
      state.bridges.herzog.audits = state.bridges.herzog.audits.slice(0, 200);
    });
    res.status(201).json(a);
  });
}
