/**
 * PAIA — Predictive AI Agent / Analytics.
 *
 * Sub-interfaz del Cockpit OPHS. Inteligencia proactiva distribuida: analiza
 * las lecturas OPS (ops_readings) para anticipar anomalias mecanicas o
 * fricciones biologicas y proponer optimizaciones de rendimiento del nodo.
 *
 * Deteccion base: heuristica local (tendencia lineal + desviacion sobre
 * ventana movil), sin coste de API. Insight en lenguaje natural opcional via
 * llm.js (Ollama en produccion = coste cero, Anthropic en dev). Nunca ejecuta
 * nada: solo propone. La decision de intervenir es de Central/humano
 * (doctrina: el humano autoriza, el sistema ejecuta).
 *
 * Mismo patron que Ops/Finance/FL/M&A/Pactvm: CRUD + log inmutable propio
 * (paia_log, hash chain).
 */

import crypto from 'node:crypto';
import { callLLM } from './llm.js';

const METRICS = ['pressureBar', 'flowLpm', 'tempC', 'rpm'];
const WINDOW = 20;
const TREND_ALERT_SLOPE = 0.15; // fraccion de rango por lectura, umbral heuristico

function withId(doc) {
  if (!doc) return doc;
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
}

function canonical(entry) {
  return JSON.stringify(entry, Object.keys(entry).sort());
}

async function appendPaiaLog(mongo, entry) {
  const col = mongo.collection('paia_log');
  const tail = await col.find().sort({ seq: -1 }).limit(1).next();
  const seq = tail ? tail.seq + 1 : 1;
  const prevHash = tail ? tail.hash : '0'.repeat(64);
  const canonicalEntry = { ...entry, seq };
  const hash = crypto.createHash('sha256').update(prevHash + canonical(canonicalEntry)).digest('hex');
  const doc = { _id: crypto.randomUUID(), ...entry, seq, prevHash, hash, createdAt: new Date().toISOString() };
  await col.insertOne(doc);
  return doc;
}

function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / (arr.length || 1);
}

function stdDev(arr, m) {
  if (arr.length < 2) return 0;
  const variance = arr.reduce((a, v) => a + (v - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

// Regresion lineal simple sobre indice temporal -> pendiente normalizada
function trendSlope(values) {
  const n = values.length;
  if (n < 3) return 0;
  const xs = values.map((_, i) => i);
  const xMean = mean(xs);
  const yMean = mean(values);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - xMean) * (values[i] - yMean);
    den += (xs[i] - xMean) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  const range = Math.max(...values) - Math.min(...values) || 1;
  return slope / range;
}

/**
 * Analiza una serie de lecturas (mas reciente primero, como devuelve Mongo
 * sort ts:-1) y devuelve anomalias por metrica: desviacion fuera de 2 sigma
 * o tendencia sostenida hacia el limite.
 */
function analyzeReadings(readings) {
  const ordered = [...readings].reverse(); // cronologico ascendente
  const findings = [];
  for (const metric of METRICS) {
    const values = ordered.map((r) => r[metric]).filter((v) => typeof v === 'number');
    if (values.length < 5) continue;
    const window = values.slice(-WINDOW);
    const m = mean(window);
    const sd = stdDev(window, m);
    const last = window[window.length - 1];
    const zScore = sd === 0 ? 0 : (last - m) / sd;
    const slope = trendSlope(window);

    if (Math.abs(zScore) >= 2) {
      findings.push({
        metric,
        type: 'anomalia_estadistica',
        zScore: Math.round(zScore * 100) / 100,
        lastValue: last,
        windowMean: Math.round(m * 100) / 100,
      });
    }
    if (Math.abs(slope) >= TREND_ALERT_SLOPE) {
      findings.push({
        metric,
        type: 'tendencia_sostenida',
        direction: slope > 0 ? 'ascendente' : 'descendente',
        slope: Math.round(slope * 1000) / 1000,
      });
    }
  }
  return findings;
}

export function mountPaia(app, { auth, requireMesa, mongo }) {
  const router = app;
  const guard = [auth, requireMesa('ophs')];

  /* ---- analisis bajo demanda de un nodo ---- */

  router.post('/api/paia/nodes/:nodeId/analyze', ...guard, async (req, res) => {
    const { nodeId } = req.params;
    const readings = await mongo.collection('ops_readings')
      .find({ nodeId })
      .sort({ ts: -1 })
      .limit(WINDOW)
      .toArray();

    if (readings.length < 5) {
      return res.json({ nodeId, findings: [], insight: null, note: 'datos insuficientes (min 5 lecturas)' });
    }

    const findings = analyzeReadings(readings);
    const doc = {
      _id: crypto.randomUUID(),
      nodeId,
      findings,
      readingsAnalyzed: readings.length,
      createdAt: new Date().toISOString(),
    };
    await mongo.collection('paia_analyses').insertOne(doc);
    if (findings.length > 0) {
      await appendPaiaLog(mongo, { action: 'analysis.findings', actorId: 'system', detail: { nodeId, findingsCount: findings.length } });
    }
    res.status(201).json(withId(doc));
  });

  /* ---- insight en lenguaje natural (opcional, bajo demanda explicita) ---- */

  router.post('/api/paia/nodes/:nodeId/insight', ...guard, async (req, res) => {
    const { nodeId } = req.params;
    const lastAnalysis = await mongo.collection('paia_analyses')
      .find({ nodeId })
      .sort({ createdAt: -1 })
      .limit(1)
      .next();
    if (!lastAnalysis || lastAnalysis.findings.length === 0) {
      return res.json({ nodeId, insight: 'Sin anomalias detectadas en el ultimo analisis.' });
    }

    const systemPrompt = 'Eres PAIA, el modulo de analitica predictiva del Cockpit OPHS de S-NFI. '
      + 'Recibes hallazgos estadisticos de telemetria de un nodo BioHybrid (presion, caudal, temperatura, RPM). '
      + 'Redacta en espanol, en maximo 4 frases, un diagnostico tecnico breve y una recomendacion de mantenimiento. '
      + 'Nunca propongas ejecutar acciones automaticamente: solo recomienda, la decision es humana.';
    const userPrompt = `Nodo: ${nodeId}\nHallazgos: ${JSON.stringify(lastAnalysis.findings)}`;

    let insight;
    try {
      const result = await callLLM(systemPrompt, userPrompt, 400);
      insight = result.text;
    } catch (err) {
      return res.status(502).json({ error: `PAIA insight no disponible: ${err.message}` });
    }

    await appendPaiaLog(mongo, { action: 'insight.generate', actorId: req.user, detail: { nodeId } });
    res.json({ nodeId, insight });
  });

  /* ---- historial de analisis ---- */

  router.get('/api/paia/nodes/:nodeId/analyses', ...guard, async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const rows = await mongo.collection('paia_analyses')
      .find({ nodeId: req.params.nodeId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
    res.json(rows.map(withId));
  });

  /* ---- resumen KPI (para Cockpit OPHS) ---- */

  router.get('/api/paia/summary', ...guard, async (req, res) => {
    const sinceIso = new Date(Date.now() - 24 * 3600000).toISOString();
    const [analysesTotal, analysesWithFindings, recent] = await Promise.all([
      mongo.collection('paia_analyses').countDocuments({}),
      mongo.collection('paia_analyses').countDocuments({ 'findings.0': { $exists: true } }),
      mongo.collection('paia_analyses').countDocuments({ createdAt: { $gte: sinceIso } }),
    ]);
    res.json({ analysesTotal, analysesWithFindings, analysesUltimas24h: recent });
  });

  /* ---- integridad del log ---- */

  router.get('/api/paia/log/verify', ...guard, async (req, res) => {
    const all = await mongo.collection('paia_log').find({}).sort({ seq: 1 }).toArray();
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
