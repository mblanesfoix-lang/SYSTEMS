/**
 * S-NFI U2 · Mesa de energía desperdiciada
 * Fuente: api.esios.ree.es (token personal ESIOS) + apidatos.ree.es (público)
 * - Precio SPOT horario: indicador 600 (geo España)
 * - Demanda real horaria: indicador 1293 (geo Península)
 * - Generación T.Real: eólica 551, solar 1295, hidro 546, nuclear 549
 * Metodología: horas precio SPOT <= umbral → energía desperdiciada estimada
 *
 * Self-contained: fetch helpers propios, cache Map propio (liveCache) y loop
 * de polling propio (setInterval). liveCache/liveLastUpdated se exponen via
 * getter porque los closures getU2Snapshot pasados a mountPactvm y
 * mountElviraCentral (montados despues, en server.js) necesitan leer el
 * ultimo snapshot del dia sin duplicar el poller.
 */

import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

const ESIOS_BASE = 'https://api.esios.ree.es';
const PRECIO_CERO_UMBRAL_EUR = 1.0; // EUR/MWh

// REE apidatos.ree.es — público sin token
const REE_BASE = 'https://apidatos.ree.es/es/datos';

// REE apidatos category/widget paths
const REE_ENDPOINTS = {
  precios:  '/mercados/precios-mercados-tiempo-real',
  demanda:  '/demanda/demanda-tiempo-real',
  generacion: '/generacion/estructura-generacion',
};

// IDs within apidatos "included" responses
const REE_IDS = {
  pvpc:           1001,
  precio_spot:    600,
  dem_prevista:   2052,
  dem_programada: 2053,
  dem_real:       2037,
  hidro:          10288,
  nuclear:        1446,
  carbon:         10289,
  motores_diesel: 10344,
  turbina_gas:    1450,
  turbina_vapor:  1451,
  ciclo_comb:     1454,
  eolica:         10291,
  solar_fv:       1458,
  solar_term:     1459,
  otras_renov:    10292,
  cogeneracion:   10293,
  residuos_norenv:10294,
  residuos_renov: 10295,
  gen_total:      1,
};

async function fetchREEOnce(endpoint, startDate, endDate, timeTrunc, timeoutMs) {
  const { default: https } = await import('node:https');
  const url = new URL(`${REE_BASE}${endpoint}`);
  url.searchParams.set('start_date', `${startDate}T00:00`);
  url.searchParams.set('end_date',   `${endDate}T23:59`);
  url.searchParams.set('time_trunc', timeTrunc);
  return new Promise((resolve) => {
    const req = https.get(url.toString(), { headers: { 'Accept': 'application/json' }, timeout: timeoutMs }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (!d) { resolve({ ok: false, status: res.statusCode, data: null, error: 'empty body' }); return; }
        try {
          const json = JSON.parse(d);
          resolve({ ok: res.statusCode === 200, status: res.statusCode, data: json });
        } catch (e) {
          resolve({ ok: false, status: res.statusCode, data: null, error: 'invalid JSON: ' + e.message });
        }
      });
      res.on('error', e => resolve({ ok: false, status: res.statusCode, data: null, error: e.message }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', e => resolve({ ok: false, status: 0, data: null, error: e.message }));
  });
}

// REE apidatos publico es intermitente: reintenta con backoff antes de rendirse
async function fetchREE(endpoint, startDate, endDate, timeTrunc = 'hour', retries = 2) {
  let last = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    last = await fetchREEOnce(endpoint, startDate, endDate, timeTrunc, 12000);
    if (last.ok && last.data) return last;
    if (attempt < retries) await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
  }
  return last;
}

// Extract series by REE numeric id from "included" array
function extractREESeries(data, id) {
  const inc = data?.included || [];
  const item = inc.find(x => x.id === String(id) || x.id === id);
  return item?.attributes?.values || [];
}

// Extract all series as { id -> values[] }
function extractAllSeries(data) {
  const inc = data?.included || [];
  const out = {};
  for (const x of inc) {
    out[x.id] = { title: x.attributes?.title, values: x.attributes?.values || [] };
  }
  return out;
}

// Index array of {value, datetime} by 'YYYY-MM-DDTHH' key
function indexByHour(values) {
  const idx = {};
  for (const v of values) {
    const key = (v.datetime || '').substring(0, 13);
    if (key) idx[key] = v.value;
  }
  return idx;
}

// Fetch a full year (or partial) for an endpoint by splitting into monthly chunks (hour trunc).
// REE apidatos rejects ranges > 1 month; this stitches the series automatically.
// yearStart and yearEnd are YYYY-MM-DD strings
async function fetchREEHourlyYear(endpoint, yearStart, yearEnd) {
  const allPrecios = [];
  const allDemanda = [];

  // Build monthly windows
  const months = [];
  let cur = new Date(`${yearStart}T00:00:00`);
  const finalEnd = new Date(`${yearEnd}T23:59:59`);
  while (cur <= finalEnd) {
    const mStart = cur.toISOString().split('T')[0];
    // last day of this calendar month
    const mLast = new Date(cur.getFullYear(), cur.getMonth() + 1, 0);
    const mEnd = mLast > finalEnd ? yearEnd : mLast.toISOString().split('T')[0];
    months.push({ start: mStart, end: mEnd });
    cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
  }

  // Fetch months in parallel, max 4 concurrent to avoid REE rate limiting
  const CONCURRENCY = 4;
  const results = new Array(months.length);
  for (let i = 0; i < months.length; i += CONCURRENCY) {
    const batch = months.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(({ start, end }) =>
      Promise.all([
        fetchREE(endpoint === 'precios' ? REE_ENDPOINTS.precios : endpoint, start, end, 'hour'),
        fetchREE(REE_ENDPOINTS.demanda, start, end, 'hour'),
      ])
    ));
    for (let j = 0; j < batchResults.length; j++) results[i + j] = batchResults[j];
  }

  for (const [pRes, dRes] of results) {
    if (pRes?.ok) allPrecios.push(...(extractREESeries(pRes.data, REE_IDS.precio_spot)));
    if (dRes?.ok) allDemanda.push(...(extractREESeries(dRes.data, REE_IDS.dem_real)));
  }

  return { precioVals: allPrecios, demandaVals: allDemanda };
}

// Index by 15-min slot 'YYYY-MM-DDTHH:MM'
function indexBy15(values) {
  const idx = {};
  for (const v of values) {
    const key = (v.datetime || '').substring(0, 16);
    if (key) idx[key] = v.value;
  }
  return idx;
}

function calcularDesperdicio(precioValues, demandaValues) {
  const precIdx = indexByHour(precioValues);
  const demIdx  = indexByHour(demandaValues);
  const keys = Object.keys(precIdx).sort();
  if (!keys.length) return null;

  let horasPrecioCero = 0;
  let excesoMwh = 0;
  const detalle = [];

  for (const key of keys) {
    const precio    = precIdx[key] ?? 999;
    const demandaMw = demIdx[key] ?? null;
    if (precio <= PRECIO_CERO_UMBRAL_EUR) {
      horasPrecioCero++;
      if (demandaMw != null) {
        const exceso = demandaMw * 0.10;
        excesoMwh += exceso;
        detalle.push({ datetime: key, precio_eur_mwh: precio, demanda_mw: demandaMw, exceso_mwh: exceso });
      }
    }
  }

  return {
    horas_precio_cero: horasPrecioCero,
    exceso_gwh: Math.round((excesoMwh / 1000) * 10000) / 10000,
    generacion_proxy: '10% demanda en horas precio<=1EUR (proxy curtailment REE)',
    detalle_horas: detalle,
  };
}

// Variante para datos de resolución diaria: precio y demanda en time_trunc=day.
// REE devuelve valores diarios con datetime tipo '2024-01-15T00:00:00.000+01:00';
// se indexan por 'YYYY-MM-DD'.
function indexByDay(values) {
  const idx = {};
  for (const v of values) {
    const key = (v.datetime || '').substring(0, 10);
    if (key) idx[key] = v.value;
  }
  return idx;
}

function calcularDesperdicioDaily(precioValues, demandaValues) {
  const precIdx = indexByDay(precioValues);
  const demIdx  = indexByDay(demandaValues);
  const keys = Object.keys(precIdx).sort();
  if (!keys.length) return null;

  // demanda diaria viene en MW·h acumulados del día (MWh), precio en EUR/MWh medio diario
  let diasPrecioCero = 0;
  let excesoMwh = 0;
  const detalle = [];

  for (const key of keys) {
    const precio    = precIdx[key] ?? 999;
    const demandaMwh = demIdx[key] ?? null; // MWh diarios (time_trunc=day sum)
    if (precio <= PRECIO_CERO_UMBRAL_EUR) {
      diasPrecioCero++;
      if (demandaMwh != null) {
        // proxy: 10% de la energía diaria desperdiciada
        const exceso = demandaMwh * 0.10;
        excesoMwh += exceso;
        detalle.push({ datetime: key, precio_eur_mwh: precio, demanda_mwh: demandaMwh, exceso_mwh: exceso });
      }
    }
  }

  return {
    horas_precio_cero: diasPrecioCero, // días con precio <= umbral (misma semántica en histórico)
    exceso_gwh: Math.round((excesoMwh / 1000) * 10000) / 10000,
    generacion_proxy: '10% demanda diaria en días precio medio<=1EUR/MWh (proxy curtailment REE)',
    detalle_horas: detalle,
  };
}

/* ═══════════════════════════════════════════════════════════════════
   CURTAILMENT ESTIMADO (no oficial)

   Por que existe: los indicadores ERNI de ESIOS (2200/2201/2202), que son
   la cifra OFICIAL de renovable no integrada, exigen cuenta institucional.
   Con token personal devuelven 403 y /curtailment responde 503. Este
   bloque estima la misma magnitud con series a las que si se llega.

   Metodo: curtailment ~ generacion renovable en las horas en que el
   mercado no puede absorberla. Se detecta por precio SPOT hundido
   (<= umbral): con exceso de renovable el marginalista cae a cero o
   negativo. Sobre esas horas se aplica una tasa de vertido.

   NO es la cifra oficial de REE. Es un proxy con sesgo conocido:
   subestima el curtailment por restriccion tecnica local (que ocurre sin
   que el precio nacional caiga) y sobreestima en horas de precio bajo por
   causas ajenas (hidraulicidad alta, demanda baja festiva).
   ═══════════════════════════════════════════════════════════════════ */

// Tasa de vertido aplicada sobre la renovable de las horas de precio
// hundido. PLACEHOLDER de modelo: sin serie ERNI real no hay forma de
// calibrarla contra el dato oficial. Editable via ?tasa=.
const CURTAILMENT_RATE_DEFAULT = 0.18;
const CURTAILMENT_PRICE_THRESHOLD_DEFAULT = 5; // EUR/MWh

/*
 * Paises vecinos y fronterizos con Espana.
 *
 * IMPORTANTE: no hay integracion con RTE (FR), REN (PT) ni ONEE (MA) en
 * este repo — no existe token ni endpoint equivalente a ESIOS para ellos.
 * Las tasas son cifras PUBLICADAS, no lecturas en vivo, y por tanto
 * PLACEHOLDER editables: cada una declara su procedencia en `source`.
 * Actualizar cuando el jefe confirme fuentes definitivas.
 */
const NEIGHBOUR_GRIDS = [
  {
    code: 'ES', label: 'España', tso: 'REE',
    pctCurtailmentRenovable: null, // se calcula en vivo, no se fija aqui
    genRenovableTwhYear: null,
    frontera: 'referencia',
    source: 'calculado en vivo (apidatos.ree.es, publico)',
  },
  {
    code: 'PT', label: 'Portugal', tso: 'REN',
    pctCurtailmentRenovable: 1.1,
    genRenovableTwhYear: 33.0,
    frontera: 'terrestre',
    source: 'PLACEHOLDER — orden de magnitud publico REN/ERSE, sin API integrada',
  },
  {
    code: 'FR', label: 'Francia', tso: 'RTE',
    pctCurtailmentRenovable: 2.4,
    genRenovableTwhYear: 140.0,
    frontera: 'terrestre',
    source: 'PLACEHOLDER — orden de magnitud publico RTE Bilan electrique, sin API integrada',
  },
  {
    code: 'MA', label: 'Marruecos', tso: 'ONEE',
    pctCurtailmentRenovable: 3.0,
    genRenovableTwhYear: 7.5,
    frontera: 'interconexion submarina',
    source: 'PLACEHOLDER — estimacion sectorial, sin fuente oficial accesible',
  },
  {
    code: 'AD', label: 'Andorra', tso: 'FEDA',
    pctCurtailmentRenovable: 0.4,
    genRenovableTwhYear: 0.1,
    frontera: 'terrestre',
    source: 'PLACEHOLDER — red muy pequena, mayoritariamente importadora',
  },
];

// Tecnologias que cuentan como renovable en estructura-generacion.
// Mismo criterio que usa la pestana de Renovables de esta mesa.
const REE_RENOVABLE_IDS = [
  REE_IDS.hidro, REE_IDS.eolica, REE_IDS.solar_fv,
  REE_IDS.solar_term, REE_IDS.otras_renov, REE_IDS.residuos_renov,
];

/*
 * Descarga precio SPOT (horario) + generacion renovable (diaria) de
 * apidatos.ree.es, troceando por meses naturales (la API rechaza rangos
 * > 1 mes).
 *
 * Dos granularidades distintas a proposito:
 *   - precios-mercados-tiempo-real  admite time_trunc=hour
 *   - estructura-generacion         SOLO admite day/month (hour da 400)
 * Por eso el cruce no puede ser hora-contra-hora. Ver estimarCurtailmentES.
 *
 * Se usa apidatos y NO ESIOS porque el token ESIOS de este despliegue
 * devuelve 403 en todos los indicadores, no solo en los ERNI.
 */
async function fetchCurtailmentInputs(from, to) {
  const months = [];
  let cur = new Date(`${from}T00:00:00`);
  const finalEnd = new Date(`${to}T23:59:59`);
  while (cur <= finalEnd) {
    const mStart = cur.toISOString().split('T')[0];
    const mLast = new Date(cur.getFullYear(), cur.getMonth() + 1, 0);
    const mEnd = mLast > finalEnd ? to : mLast.toISOString().split('T')[0];
    months.push({ start: mStart, end: mEnd });
    cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
  }

  const precios = [];
  const renovable = [];
  let fallos = 0;

  const CONCURRENCY = 3;
  for (let i = 0; i < months.length; i += CONCURRENCY) {
    const batch = months.slice(i, i + CONCURRENCY);
    const res = await Promise.all(batch.map(({ start, end }) => Promise.all([
      fetchREE(REE_ENDPOINTS.precios, start, end, 'hour'),
      fetchREE(REE_ENDPOINTS.generacion, start, end, 'day'),
    ])));

    for (const [pRes, gRes] of res) {
      if (!pRes.ok || !gRes.ok) { fallos++; continue; }

      precios.push(...extractREESeries(pRes.data, REE_IDS.precio_spot));

      // Suma diaria de las tecnologias renovables
      const porDia = {};
      for (const id of REE_RENOVABLE_IDS) {
        for (const v of extractREESeries(gRes.data, id)) {
          const k = (v.datetime || '').substring(0, 10);
          if (!k) continue;
          porDia[k] = (porDia[k] || 0) + (Number(v.value) || 0);
        }
      }
      for (const [datetime, value] of Object.entries(porDia)) {
        renovable.push({ datetime, value });
      }
    }
  }

  return { precios, renovable, mesesPedidos: months.length, mesesFallidos: fallos };
}

/*
 * Estima curtailment espanol.
 *
 * precios:  valores HORARIOS de precio SPOT.
 * genRenov: valores DIARIOS de generacion renovable agregada.
 *
 * Como estructura-generacion no da hora, no se puede cruzar hora contra
 * hora. En su lugar, por cada dia se calcula que fraccion de sus horas
 * tuvo el precio bajo el umbral, y esa fraccion se aplica a la renovable
 * de ese dia. Conserva la resolucion horaria del precio (que es donde
 * esta la senal de exceso) sin inventar un reparto horario de generacion.
 */
function estimarCurtailmentES(precios, genRenov, { umbral, tasa }) {
  // horas hundidas y horas totales por dia
  const porDia = {};
  for (const p of precios) {
    const dia = (p.datetime || '').substring(0, 10);
    if (!dia) continue;
    if (!porDia[dia]) porDia[dia] = { horas: 0, hundidas: 0 };
    porDia[dia].horas++;
    if (Number(p.value) <= umbral) porDia[dia].hundidas++;
  }

  let renovableTotalMwh = 0;
  let renovableEnHorasHundidasMwh = 0;
  let horasHundidas = 0;
  const porMes = {};

  for (const g of genRenov) {
    const dia = (g.datetime || '').substring(0, 10);
    const mes = (g.datetime || '').substring(0, 7);
    const mwh = Number(g.value) || 0;
    if (!dia || !mes) continue;

    renovableTotalMwh += mwh;
    if (!porMes[mes]) porMes[mes] = { mes, renovable_mwh: 0, horas_precio_hundido: 0, estimado_mwh: 0 };
    porMes[mes].renovable_mwh += mwh;

    const d = porDia[dia];
    if (!d || !d.horas || !d.hundidas) continue;

    const fraccion = d.hundidas / d.horas;
    const expuesta = mwh * fraccion;
    horasHundidas += d.hundidas;
    renovableEnHorasHundidasMwh += expuesta;
    porMes[mes].horas_precio_hundido += d.hundidas;
    porMes[mes].estimado_mwh += expuesta * tasa;
    d.hundidas = 0; // ya contabilizado: evita doble conteo si el dia se repite
  }

  const estimadoMwh = renovableEnHorasHundidasMwh * tasa;

  // Dias con dato por mes: un mes al que la API fallo aparece aqui con
  // dos o tres dias de solape de los meses vecinos. Marcarlo evita
  // presentar 3 dias sueltos como si fueran un mes entero.
  const diasPorMes = {};
  for (const g of genRenov) {
    const mes = (g.datetime || '').substring(0, 7);
    const dia = (g.datetime || '').substring(0, 10);
    if (!mes || !dia) continue;
    (diasPorMes[mes] ||= new Set()).add(dia);
  }

  const mensual = Object.values(porMes)
    .sort((a, b) => a.mes.localeCompare(b.mes))
    .map((m) => {
      const dias = diasPorMes[m.mes]?.size || 0;
      const [y, mm] = m.mes.split('-').map(Number);
      const diasDelMes = new Date(y, mm, 0).getDate();
      return {
        mes: m.mes,
        dias_con_dato: dias,
        dias_del_mes: diasDelMes,
        completo: dias >= diasDelMes - 1, // 1 dia de margen por husos/DST
        renovable_gwh: Math.round((m.renovable_mwh / 1000) * 100) / 100,
        horas_precio_hundido: m.horas_precio_hundido,
        curtailment_estimado_gwh: Math.round((m.estimado_mwh / 1000) * 100) / 100,
      };
    });

  return {
    horas_precio_hundido: horasHundidas,
    renovable_total_gwh: Math.round((renovableTotalMwh / 1000) * 100) / 100,
    renovable_en_horas_hundidas_gwh: Math.round((renovableEnHorasHundidasMwh / 1000) * 100) / 100,
    curtailment_estimado_gwh: Math.round((estimadoMwh / 1000) * 100) / 100,
    pct_sobre_renovable: renovableTotalMwh > 0
      ? Math.round((estimadoMwh / renovableTotalMwh) * 10000) / 100
      : null,
    mensual,
  };
}

async function fetchESIOS(indicatorId, startDate, endDate, timeTrunc = 'hour') {
  const { default: https } = await import('node:https');
  const token = process.env.ESIOS_API_KEY || process.env.ESIOS_TOKEN || '';
  const url = `${ESIOS_BASE}/indicators/${indicatorId}?start_date=${encodeURIComponent(startDate + 'T00:00:00')}&end_date=${encodeURIComponent(endDate + 'T23:59:59')}&time_trunc=${timeTrunc}`;
  return new Promise((resolve) => {
    https.get(url, {
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': `Token token=${token}`,
      },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(d);
          resolve({ ok: res.statusCode === 200, status: res.statusCode, data: json });
        } catch {
          resolve({ ok: false, status: res.statusCode, data: null });
        }
      });
    }).on('error', e => resolve({ ok: false, status: 0, data: null, error: e.message }));
  });
}

function extractESIOSValues(data) {
  return data?.indicator?.values || [];
}

export function mountU2Ree(app, { auth, busEmit, busEmitAlert, busEvents, atomicWriteJson, DATA_DIR }) {
  /* Historic year-level disk cache — past years never change, current year expires 4h */
  const HISTORIC_CACHE_FILE = path.join(DATA_DIR, 'cnmc_historic_cache.json');
  let historicCache = {};
  try {
    if (fs.existsSync(HISTORIC_CACHE_FILE)) {
      historicCache = JSON.parse(fs.readFileSync(HISTORIC_CACHE_FILE, 'utf8'));
    }
  } catch { historicCache = {}; }

  function historicCacheGet(year, currentYear) {
    const entry = historicCache[year];
    if (!entry) return null;
    if (year < currentYear) return entry.data; // past year: never expires
    const age = Date.now() - (entry.ts || 0);
    if (age < 4 * 60 * 60 * 1000) return entry.data; // current year: 4h TTL
    return null;
  }

  function historicCacheSet(year, data) {
    historicCache[year] = { ts: Date.now(), data };
    atomicWriteJson(HISTORIC_CACHE_FILE, historicCache);
  }

  /* GET /api/snfi-u2/waste?start=YYYY-MM-DD&end=YYYY-MM-DD */
  app.get('/api/snfi-u2/waste', auth, async (req, res) => {
    try {
      const start = String(req.query.start || '').trim();
      const end   = String(req.query.end   || '').trim();
      if (!start || !end) return res.status(400).json({ error: 'start y end requeridos (YYYY-MM-DD)' });

      const { precioVals: spotVals, demandaVals: demRealVals } = await fetchREEHourlyYear('precios', start, end);
      if (!spotVals.length) return res.status(502).json({ error: 'Sin series precio en respuesta REE' });

      const calculo = calcularDesperdicio(spotVals, demRealVals);
      if (!calculo) return res.status(502).json({ error: 'Sin series precio/demanda en respuesta REE' });

      busEmit({
        id: crypto.randomUUID(), ts: new Date().toISOString(), seq: busEvents.length + 1,
        origin: 'ELVI-RA', dest: 'SNFI-U2', type: 'event', state: 'COMPLETED',
        label: `S-NFI U2 · ${start}→${end} · ${calculo.horas_precio_cero}h precio<=1€ · ${calculo.exceso_gwh} GWh`,
        payload: { start, end, horas: calculo.horas_precio_cero, gwh: calculo.exceso_gwh },
        user: req.user,
      });

      res.json({
        periodo: { start, end },
        umbral_eur_mwh: PRECIO_CERO_UMBRAL_EUR,
        metodologia: 'Precio SPOT peninsular real (REE). Horas <= umbral = energia desperdiciada. Exceso = 10% demanda real.',
        fuente: 'apidatos.ree.es — Red Electrica de Espana (publico)',
        horas_precio_cero: calculo.horas_precio_cero,
        exceso_gwh: calculo.exceso_gwh,
        detalle_horas: calculo.detalle_horas,
        calculadoAt: new Date().toISOString(),
      });
    } catch (ex) {
      console.error('[snfi-u2/waste]', ex);
      busEmitAlert({ origin: 'SNFI-U2', label: `S-NFI U2 WASTE · fallo`, detail: ex.message, user: req.user });
      res.status(500).json({ error: ex.message || 'error interno S-NFI U2' });
    }
  });

  /* GET /api/snfi-u2/annual?year=2025 */
  app.get('/api/snfi-u2/annual', auth, async (req, res) => {
    try {
      const today = new Date();
      const currentYear = today.getFullYear();
      const year = parseInt(req.query.year || currentYear, 10);
      if (isNaN(year) || year < 2020 || year > 2030) return res.status(400).json({ error: 'year invalido' });

      // Serve from historic cache if available (shares cache with /historic)
      const cached = historicCacheGet(year, currentYear);
      if (cached) {
        return res.json({
          year: cached.year,
          periodo_analizado: cached.periodo,
          umbral_eur_mwh: PRECIO_CERO_UMBRAL_EUR,
          total_gwh_desperdiciados: cached.exceso_gwh,
          total_horas_precio_cero: cached.horas_precio_cero,
          metodologia: 'Precio SPOT peninsular <= 1 EUR/MWh. Exceso = 10% demanda real.',
          fuente: 'apidatos.ree.es — Red Electrica de Espana (publico)',
          mensual: cached.mensual,
          calculadoAt: new Date().toISOString(),
          cached: true,
        });
      }

      const endDate = (year < currentYear) ? `${year}-12-31` : today.toISOString().split('T')[0];
      const start = `${year}-01-01`;

      const { precioVals: spotVals, demandaVals: demRealVals } = await fetchREEHourlyYear('precios', start, endDate);
      if (!spotVals.length) return res.status(502).json({ error: 'Sin datos REE para el periodo' });

      const calculo = calcularDesperdicio(spotVals, demRealVals);
      if (!calculo) return res.status(502).json({ error: 'Sin datos REE para el periodo' });

      const porMes = {};
      for (const h of calculo.detalle_horas) {
        const mes = h.datetime?.substring(0, 7);
        if (!mes) continue;
        if (!porMes[mes]) porMes[mes] = { mes, horas: 0, exceso_gwh: 0 };
        porMes[mes].horas++;
        porMes[mes].exceso_gwh = Math.round((porMes[mes].exceso_gwh + h.exceso_mwh / 1000) * 10000) / 10000;
      }

      const result = {
        year,
        completo: year < currentYear,
        periodo: { start, end: endDate },
        exceso_gwh: calculo.exceso_gwh,
        horas_precio_cero: calculo.horas_precio_cero,
        mensual: Object.values(porMes),
        error: null,
      };
      historicCacheSet(year, result);

      res.json({
        year,
        periodo_analizado: { start, end: endDate },
        umbral_eur_mwh: PRECIO_CERO_UMBRAL_EUR,
        total_gwh_desperdiciados: calculo.exceso_gwh,
        total_horas_precio_cero: calculo.horas_precio_cero,
        metodologia: calculo.generacion_proxy,
        fuente: 'apidatos.ree.es — Red Electrica de Espana (publico)',
        mensual: Object.values(porMes),
        calculadoAt: new Date().toISOString(),
      });
    } catch (ex) {
      console.error('[snfi-u2/annual]', ex);
      busEmitAlert({ origin: 'SNFI-U2', label: `S-NFI U2 ANNUAL · fallo`, detail: ex.message, user: req.user });
      res.status(500).json({ error: ex.message || 'error interno S-NFI U2' });
    }
  });

  /* GET /api/snfi-u2/historic?from=2022&to=2026 */
  app.get('/api/snfi-u2/historic', auth, async (req, res) => {
    try {
      const today = new Date();
      const currentYear = today.getFullYear();
      const fromYear = Math.max(2014, Math.min(parseInt(req.query.from || '2020', 10), currentYear));
      const toYear   = Math.min(currentYear, Math.max(parseInt(req.query.to || String(currentYear), 10), fromYear));

      if (isNaN(fromYear) || isNaN(toYear)) return res.status(400).json({ error: 'from/to invalidos' });

      const years = [];
      for (let y = fromYear; y <= toYear; y++) years.push(y);

      const resultados = await Promise.all(years.map(async year => {
        // Return cached result if available
        const cached = historicCacheGet(year, currentYear);
        if (cached) return cached;

        try {
          const endDate = year < currentYear ? `${year}-12-31` : today.toISOString().split('T')[0];
          const start   = `${year}-01-01`;

          const { precioVals, demandaVals } = await fetchREEHourlyYear('precios', start, endDate);

          const calculo = calcularDesperdicio(precioVals, demandaVals);
          if (!calculo || !precioVals.length) {
            return { year, error: 'sin series en respuesta REE', exceso_gwh: null, horas_precio_cero: null };
          }

          const porMes = {};
          for (const h of calculo.detalle_horas) {
            const mes = h.datetime?.substring(0, 7);
            if (!mes) continue;
            if (!porMes[mes]) porMes[mes] = { mes, horas: 0, exceso_gwh: 0 };
            porMes[mes].horas++;
            porMes[mes].exceso_gwh = Math.round((porMes[mes].exceso_gwh + h.exceso_mwh / 1000) * 10000) / 10000;
          }

          const result = {
            year,
            completo: year < currentYear,
            periodo: { start, end: endDate },
            exceso_gwh: calculo.exceso_gwh,
            horas_precio_cero: calculo.horas_precio_cero,
            mensual: Object.values(porMes),
            error: null,
          };
          historicCacheSet(year, result);
          return result;
        } catch (yearErr) {
          return { year, error: yearErr.message, exceso_gwh: null, horas_precio_cero: null };
        }
      }));

      const totalGwh   = resultados.reduce((s, r) => s + (r.exceso_gwh || 0), 0);
      const totalHoras = resultados.reduce((s, r) => s + (r.horas_precio_cero || 0), 0);
      const maxGwh     = Math.max(...resultados.map(r => r.exceso_gwh || 0));

      busEmit({
        id: crypto.randomUUID(), ts: new Date().toISOString(), seq: busEvents.length + 1,
        origin: 'ELVI-RA', dest: 'SNFI-U2', type: 'event', state: 'COMPLETED',
        label: `S-NFI U2 HISTORICO · ${fromYear}-${toYear} · ${Math.round(totalGwh)} GWh acumulados`,
        payload: { fromYear, toYear, totalGwh: Math.round(totalGwh), anos: resultados.length },
        user: req.user,
      });

      res.json({
        fromYear,
        toYear,
        total_gwh_acumulados: Math.round(totalGwh * 100) / 100,
        total_horas_acumuladas: totalHoras,
        max_gwh_ano: maxGwh,
        fuente: 'apidatos.ree.es — Red Electrica de Espana (publico)',
        metodologia: 'Precio SPOT peninsular <= 1 EUR/MWh = hora desperdiciada. Exceso = 10% demanda real.',
        anos: resultados,
        calculadoAt: new Date().toISOString(),
      });
    } catch (ex) {
      console.error('[snfi-u2/historic]', ex);
      busEmitAlert({ origin: 'SNFI-U2', label: `S-NFI U2 HISTORICO · fallo`, detail: ex.message, user: req.user });
      res.status(500).json({ error: ex.message || 'error historico S-NFI U2' });
    }
  });

  /* ============================================================
     S-NFI U2 · Live monitor
     Poller: cada ~69s REE apidatos → cache → SSE push (via bus)
     ============================================================ */

  const LIVE_POLL_INTERVAL_MS = 69 * 1000; // 1.15 min
  const LIVE_HISTORY_MAX_DAYS = 7;

  const liveCache = new Map();
  let liveLastUpdated = null;
  let liveIsPolling = false;
  let generacionCache = null;
  let generacionLastUpdated = null;

  function computeLiveStats(spotValues, demPrevistaValues, demProgramadaValues, demRealValues) {
    // spot has 15-min granularity (96/day), demanda has 5-min (288/day)
    // index spot by 15-min slot, demanda by 5-min slot
    const spotIdx = indexBy15(spotValues);
    const demRealIdx = indexByHour(demRealValues);
    const demPrevIdx = indexByHour(demPrevistaValues);
    const demProgIdx = indexByHour(demProgramadaValues);

    let negativeCount = 0;
    let totalExcesoMwh = 0;
    const intervals = [];
    let minPrice = Infinity;
    let maxPrice = -Infinity;

    // Use spot as primary series (15-min)
    for (const p of spotValues) {
      const precio     = p.value ?? 999;
      const slotKey    = (p.datetime || '').substring(0, 16);
      const hourKey    = (p.datetime || '').substring(0, 13);
      const demMw      = demRealIdx[hourKey] ?? null;
      const prevMw     = demPrevIdx[hourKey] ?? null;
      const progMw     = demProgIdx[hourKey] ?? null;
      const isWasted   = precio <= PRECIO_CERO_UMBRAL_EUR;
      const isNegative = precio < 0;
      const excesoMwh  = (isWasted && demMw != null) ? demMw * 0.10 : 0;

      if (isNegative) negativeCount++;
      if (isWasted) totalExcesoMwh += excesoMwh;
      if (precio < minPrice) minPrice = precio;
      if (precio > maxPrice) maxPrice = precio;

      intervals.push({
        datetime: p.datetime,
        precio_eur_mwh: precio,
        demanda_mw: demMw,
        demanda_prevista_mw: prevMw,
        demanda_programada_mw: progMw,
        desperdiciada: isWasted,
        negativa: isNegative,
        exceso_mwh: excesoMwh,
      });
    }

    const wastedCount = intervals.filter(i => i.desperdiciada).length;

    return {
      intervalos_totales: intervals.length,
      intervalos_desperdiciados: wastedCount,
      intervalos_negativos: negativeCount,
      exceso_gwh_hoy: Math.round((totalExcesoMwh / 1000) * 10000) / 10000,
      precio_min_eur_mwh: isFinite(minPrice) ? Math.round(minPrice * 100) / 100 : null,
      precio_max_eur_mwh: isFinite(maxPrice) ? Math.round(maxPrice * 100) / 100 : null,
      all_intervals: intervals,
    };
  }

  async function pollLiveData() {
    if (liveIsPolling) return;
    liveIsPolling = true;
    try {
      const today = new Date().toISOString().split('T')[0];

      const [precioRes, demandaRes] = await Promise.all([
        fetchREE(REE_ENDPOINTS.precios, today, today, 'hour'),
        fetchREE(REE_ENDPOINTS.demanda, today, today, 'hour'),
      ]);

      if (!precioRes.ok || !demandaRes.ok) {
        console.warn(`[snfi-u2/live] poll failed: precios=${precioRes.status} demanda=${demandaRes.status}`);
        return;
      }

      const spotVals    = extractREESeries(precioRes.data,  REE_IDS.precio_spot);
      const pvpcVals    = extractREESeries(precioRes.data,  REE_IDS.pvpc);
      const demPrevVals = extractREESeries(demandaRes.data, REE_IDS.dem_prevista);
      const demProgVals = extractREESeries(demandaRes.data, REE_IDS.dem_programada);
      const demRealVals = extractREESeries(demandaRes.data, REE_IDS.dem_real);

      if (!spotVals.length) {
        console.warn('[snfi-u2/live] no spot values from REE');
        return;
      }

      const stats = computeLiveStats(spotVals, demPrevVals, demProgVals, demRealVals);
      liveCache.set(today, {
        date: today,
        updatedAt: new Date().toISOString(),
        pvpc_series: pvpcVals,
        ...stats,
      });
      liveLastUpdated = new Date().toISOString();

      const days = [...liveCache.keys()].sort();
      while (days.length > LIVE_HISTORY_MAX_DAYS) liveCache.delete(days.shift());

      busEmit({
        id: crypto.randomUUID(), ts: new Date().toISOString(), seq: busEvents.length + 1,
        origin: 'SNFI-U2', dest: 'ELVI-RA', type: 'event',
        state: stats.exceso_gwh_hoy > 0 ? 'BLOCKED' : 'COMPLETED',
        label: `S-NFI U2 LIVE · ${today} · ${stats.intervalos_negativos} neg · ${stats.exceso_gwh_hoy} GWh`,
        payload: { date: today, exceso_gwh_hoy: stats.exceso_gwh_hoy, intervalos_negativos: stats.intervalos_negativos },
        user: 'system',
      });
    } catch (err) {
      console.error('[snfi-u2/live] poll error:', err.message);
      busEmitAlert({ origin: 'SNFI-U2', label: `S-NFI U2 LIVE · poll fallido`, detail: err.message, user: 'system' });
    } finally {
      liveIsPolling = false;
    }
  }

  async function pollGeneracion() {
    try {
      const today = new Date().toISOString().split('T')[0];
      const [genRes, demandaRes] = await Promise.all([
        fetchREE(REE_ENDPOINTS.generacion, today, today, 'day'),
        fetchREE(REE_ENDPOINTS.demanda,    today, today, 'hour'),
      ]);

      if (!genRes.ok) return;

      const series = extractAllSeries(genRes.data);
      const demSeries = extractAllSeries(demandaRes.ok ? demandaRes.data : { included: [] });

      // Build snapshot: last value per technology
      const snap = {};
      for (const [id, { title, values }] of Object.entries(series)) {
        if (!values.length) continue;
        snap[id] = { title, value_mwh: values[values.length - 1]?.value ?? null };
      }

      // Aggregate categories
      const get = (id) => snap[String(id)]?.value_mwh ?? 0;
      const totalGen  = get(REE_IDS.gen_total) || Object.values(snap).reduce((s, v) => s + (v.value_mwh || 0), 0);
      const renovable = get(REE_IDS.eolica) + get(REE_IDS.solar_fv) + get(REE_IDS.solar_term) +
                        get(REE_IDS.hidro) + get(REE_IDS.otras_renov) + get(REE_IDS.residuos_renov);
      const libreCO2  = renovable + get(REE_IDS.nuclear);
      const pctRenov  = totalGen > 0 ? Math.round((renovable / totalGen) * 1000) / 10 : null;
      const pctCO2    = totalGen > 0 ? Math.round((libreCO2  / totalGen) * 1000) / 10 : null;

      // Demanda real last value
      const demRealVals = extractREESeries(demandaRes.ok ? demandaRes.data : {}, REE_IDS.dem_real);
      const demandaNow  = demRealVals.length ? demRealVals[demRealVals.length - 1]?.value : null;
      const demPrevVals = extractREESeries(demandaRes.ok ? demandaRes.data : {}, REE_IDS.dem_prevista);
      const demProgVals = extractREESeries(demandaRes.ok ? demandaRes.data : {}, REE_IDS.dem_programada);
      const demPrevNow  = demPrevVals.length  ? demPrevVals[demPrevVals.length - 1]?.value   : null;
      const demProgNow  = demProgVals.length  ? demProgVals[demProgVals.length - 1]?.value   : null;

      generacionCache = {
        updatedAt: new Date().toISOString(),
        date: today,
        snapshot: {
          eolica_mwh:           get(REE_IDS.eolica),
          solar_fv_mwh:         get(REE_IDS.solar_fv),
          solar_term_mwh:       get(REE_IDS.solar_term),
          hidro_mwh:            get(REE_IDS.hidro),
          nuclear_mwh:          get(REE_IDS.nuclear),
          ciclo_comb_mwh:       get(REE_IDS.ciclo_comb),
          carbon_mwh:           get(REE_IDS.carbon),
          cogeneracion_mwh:     get(REE_IDS.cogeneracion),
          otras_renov_mwh:      get(REE_IDS.otras_renov),
          residuos_renov_mwh:   get(REE_IDS.residuos_renov),
          residuos_norenov_mwh: get(REE_IDS.residuos_norenv),
          total_gen_mwh:        totalGen,
          total_renovable_mwh:  renovable,
          total_libre_co2_mwh:  libreCO2,
          pct_renovable:        pctRenov,
          pct_libre_co2:        pctCO2,
          demanda_real_mw:      demandaNow,
          demanda_prevista_mw:  demPrevNow,
          demanda_programada_mw: demProgNow,
        },
        series_demanda: {
          prevista:    extractREESeries(demandaRes.ok ? demandaRes.data : {}, REE_IDS.dem_prevista),
          programada:  extractREESeries(demandaRes.ok ? demandaRes.data : {}, REE_IDS.dem_programada),
          real:        demRealVals,
        },
        tecnologias: snap,
      };
      generacionLastUpdated = generacionCache.updatedAt;
    } catch (err) {
      console.error('[snfi-u2/generacion] poll error:', err.message);
      busEmitAlert({ origin: 'SNFI-U2', label: `S-NFI U2 GENERACION · poll fallido`, detail: err.message, user: 'system' });
    }
  }

  pollLiveData();
  pollGeneracion();
  setInterval(pollLiveData,   LIVE_POLL_INTERVAL_MS);
  setInterval(pollGeneracion, LIVE_POLL_INTERVAL_MS);

  /* GET /api/snfi-u2/live */
  app.get('/api/snfi-u2/live', auth, async (req, res) => {
    try {
    const today = new Date().toISOString().split('T')[0];

    if (!liveCache.has(today)) {
      if (liveIsPolling) {
        await new Promise(resolve => {
          const t0 = Date.now();
          const check = setInterval(() => {
            if (!liveIsPolling || Date.now() - t0 > 20000) { clearInterval(check); resolve(); }
          }, 250);
        });
      } else {
        await pollLiveData();
      }
    }

    const rawSnap = liveCache.get(today) || null;
    let snapshot = null;
    if (rawSnap) {
      const nowIso  = new Date().toISOString();
      const past    = (rawSnap.all_intervals || []).filter(i => i.datetime <= nowIso);
      const display = past.length ? past : (rawSnap.all_intervals || []).slice(0, 1);
      const current = display[display.length - 1] || null;
      const wastedNow = display.filter(i => i.desperdiciada).length;
      const negNow    = display.filter(i => i.negativa).length;
      const excesoNow = display.reduce((s, i) => s + (i.exceso_mwh || 0), 0);
      snapshot = {
        ...rawSnap,
        all_intervals: undefined,
        pvpc_series: rawSnap.pvpc_series,
        intervalos_totales: display.length,
        intervalos_desperdiciados: wastedNow,
        intervalos_negativos: negNow,
        exceso_gwh_hoy: Math.round((excesoNow / 1000) * 10000) / 10000,
        precio_actual_eur_mwh: current ? current.precio_eur_mwh : null,
        pvpc_actual_eur_mwh: rawSnap.pvpc_series?.length
          ? (() => {
              const nowH = new Date().toISOString().substring(0, 13);
              const match = rawSnap.pvpc_series.find(v => (v.datetime||'').substring(0,13) === nowH);
              return match ? match.value : rawSnap.pvpc_series[rawSnap.pvpc_series.length - 1]?.value ?? null;
            })()
          : null,
        demanda_actual_mw: current ? current.demanda_mw : null,
        demanda_prevista_mw: current ? current.demanda_prevista_mw : null,
        demanda_programada_mw: current ? current.demanda_programada_mw : null,
        pct_horas_desperdiciadas: display.length ? Math.round((wastedNow / display.length) * 1000) / 10 : 0,
        en_desperdicio_ahora: current ? current.desperdiciada : false,
        intervals: display,
      };
    }

    const history = [...liveCache.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, d]) => ({
        date,
        exceso_gwh: d.exceso_gwh_hoy,
        intervalos_negativos: (d.all_intervals || []).filter(i => i.negativa).length,
        precio_min: d.precio_min_eur_mwh,
        precio_max: d.precio_max_eur_mwh,
        pct_desperdiciadas: d.pct_horas_desperdiciadas,
      }));

    res.json({
      polling_interval_ms: LIVE_POLL_INTERVAL_MS,
      last_updated: liveLastUpdated,
      today,
      snapshot,
      history_days: history,
      fuente: 'apidatos.ree.es — Red Electrica de Espana (publico)',
      metodologia: 'Precio SPOT peninsular <= 1 EUR/MWh = energia desperdiciada. Exceso = 10% demanda real. PVPC tarifa regulada.',
    });
    } catch (err) {
      console.error('[snfi-u2/live] handler error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Error interno consultando datos en vivo' });
    }
  });

  /* GET /api/snfi-u2/generacion — mix generacion + demanda tiempo real */
  app.get('/api/snfi-u2/generacion', auth, async (req, res) => {
    try {
    if (!generacionCache) await pollGeneracion();
    if (!generacionCache) return res.status(503).json({ error: 'Sin datos generacion aun, reintenta en 10s' });
    res.json({
      ...generacionCache,
      fuente: 'apidatos.ree.es — estructura-generacion + demanda-tiempo-real (publico)',
    });
    } catch (err) {
      console.error('[snfi-u2/generacion] handler error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Error interno consultando generacion' });
    }
  });

  /* GET /api/snfi-u2/renewables — alias hacia generacion (compatibilidad) */
  app.get('/api/snfi-u2/renewables', auth, async (req, res) => {
    try {
    if (!generacionCache) await pollGeneracion();
    if (!generacionCache) return res.status(503).json({ error: 'Sin datos renovables aun, reintenta en 10s' });

    const s = generacionCache.snapshot || {};
    res.json({
      updatedAt: generacionCache.updatedAt,
      date: generacionCache.date,
      snapshot: {
        eolica_mw:          s.eolica_mwh,
        solar_mw:           s.solar_fv_mwh + s.solar_term_mwh,
        solar_fv_mw:        s.solar_fv_mwh,
        solar_term_mw:      s.solar_term_mwh,
        hidro_mw:           s.hidro_mwh,
        nuclear_mw:         s.nuclear_mwh,
        ciclo_comb_mw:      s.ciclo_comb_mwh,
        carbon_mw:          s.carbon_mwh,
        cogeneracion_mw:    s.cogeneracion_mwh,
        otras_renov_mw:     s.otras_renov_mwh,
        demanda_mw:         s.demanda_real_mw,
        demanda_prevista_mw: s.demanda_prevista_mw,
        demanda_programada_mw: s.demanda_programada_mw,
        total_generacion_mwh: s.total_gen_mwh,
        total_renovable_mwh:  s.total_renovable_mwh,
        pct_renovable:        s.pct_renovable,
        pct_libre_co2:        s.pct_libre_co2,
      },
      series: {
        demanda_prevista:   generacionCache.series_demanda.prevista,
        demanda_programada: generacionCache.series_demanda.programada,
        demanda_real:       generacionCache.series_demanda.real,
      },
      fuente: 'apidatos.ree.es — publico',
    });
    } catch (err) {
      console.error('[snfi-u2/renewables] handler error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Error interno consultando renovables' });
    }
  });

  /* GET /api/snfi-u2/renewables-historic?from=2022&to=2026 */
  app.get('/api/snfi-u2/renewables-historic', auth, async (req, res) => {
    try {
      const today       = new Date();
      const currentYear = today.getFullYear();
      const fromYear = Math.max(2022, Math.min(parseInt(req.query.from || '2022', 10), currentYear));
      const toYear   = Math.min(currentYear, Math.max(parseInt(req.query.to   || String(currentYear), 10), fromYear));

      if (isNaN(fromYear) || isNaN(toYear)) return res.status(400).json({ error: 'from/to invalidos' });

      const years = [];
      for (let y = fromYear; y <= toYear; y++) years.push(y);

      const resultados = [];
      for (const year of years) {
        try {
          const endDate = year < currentYear ? `${year}-12-31` : today.toISOString().split('T')[0];
          const start   = `${year}-01-01`;

          const [genRes, precioRes] = await Promise.all([
            fetchREE(REE_ENDPOINTS.generacion, start, endDate, 'month'),
            fetchREE(REE_ENDPOINTS.precios,    start, endDate, 'month'),
          ]);

          const avgSeries = (data, id) => {
            const vals = extractREESeries(data, id).map(v => v.value).filter(v => v != null);
            return vals.length ? Math.round(vals.reduce((s, v) => s + v, 0) / vals.length) : null;
          };

          const eolica    = genRes.ok ? avgSeries(genRes.data, REE_IDS.eolica)    : null;
          const solar_fv  = genRes.ok ? avgSeries(genRes.data, REE_IDS.solar_fv)  : null;
          const solar_t   = genRes.ok ? avgSeries(genRes.data, REE_IDS.solar_term): null;
          const hidro     = genRes.ok ? avgSeries(genRes.data, REE_IDS.hidro)     : null;
          const nuclear   = genRes.ok ? avgSeries(genRes.data, REE_IDS.nuclear)   : null;
          const totalGen  = genRes.ok ? avgSeries(genRes.data, REE_IDS.gen_total) : null;

          const totalRenov = (eolica||0) + (solar_fv||0) + (solar_t||0) + (hidro||0);
          const pctRenov   = totalGen > 0 ? Math.round((totalRenov / totalGen) * 1000) / 10 : null;
          const pctCO2     = totalGen > 0 ? Math.round(((totalRenov + (nuclear||0)) / totalGen) * 1000) / 10 : null;

          const spotVals  = precioRes.ok ? extractREESeries(precioRes.data, REE_IDS.precio_spot) : [];
          const pvpcVals  = precioRes.ok ? extractREESeries(precioRes.data, REE_IDS.pvpc)        : [];
          const horasCero = spotVals.filter(v => (v.value ?? 999) <= PRECIO_CERO_UMBRAL_EUR).length;
          const precMedio = spotVals.length
            ? Math.round(spotVals.reduce((s, v) => s + (v.value||0), 0) / spotVals.length * 100) / 100
            : null;
          const pvpcMedio = pvpcVals.length
            ? Math.round(pvpcVals.reduce((s, v) => s + (v.value||0), 0) / pvpcVals.length * 100) / 100
            : null;

          const buildMonthly = (data, id) => {
            if (!genRes.ok) return [];
            return extractREESeries(data, id).map(v => ({
              mes: (v.datetime || '').substring(0, 7),
              value_mwh: v.value,
            }));
          };

          resultados.push({
            year,
            completo: year < currentYear,
            periodo: { start, end: endDate },
            eolica_avg_mwh:   eolica,
            solar_fv_avg_mwh: solar_fv,
            solar_t_avg_mwh:  solar_t,
            hidro_avg_mwh:    hidro,
            nuclear_avg_mwh:  nuclear,
            total_gen_avg_mwh: totalGen,
            total_renovable_avg_mwh: totalRenov,
            pct_renovable_medio:  pctRenov,
            pct_libre_co2_medio:  pctCO2,
            precio_spot_medio_eur_mwh: precMedio,
            pvpc_medio_eur_mwh: pvpcMedio,
            dias_precio_cero: horasCero,
            mensual: {
              eolica:    buildMonthly(genRes.data, REE_IDS.eolica),
              solar_fv:  buildMonthly(genRes.data, REE_IDS.solar_fv),
              solar_term:buildMonthly(genRes.data, REE_IDS.solar_term),
              hidro:     buildMonthly(genRes.data, REE_IDS.hidro),
            },
            error: null,
          });
        } catch (yearErr) {
          resultados.push({ year, error: yearErr.message });
        }
      }

      res.json({
        fromYear,
        toYear,
        fuente: 'apidatos.ree.es — publico (estructura-generacion + precios)',
        anos: resultados,
        calculadoAt: new Date().toISOString(),
      });
    } catch (ex) {
      console.error('[snfi-u2/renewables-historic]', ex);
      busEmitAlert({ origin: 'SNFI-U2', label: `S-NFI U2 RENEWABLES HISTORICO · fallo`, detail: ex.message, user: req.user });
      res.status(500).json({ error: ex.message || 'error renewables-historic' });
    }
  });

  /*
   * GET /api/snfi-u2/curtailment?from=2020&to=2026
   * Energía Renovable No Integrable por restricciones técnicas
   * Indicadores ESIOS:
   *   2200 —ERNI RTT SNP (MWh)
   *   2201 —ERNI Balance SNP (MWh)
   *   2202 —ERNI Total SNP (MWh)
   *   10456 — % ERNI RTT PDBF Fase 1
   *   10457 — % ERNI RTD PDBF Fase 1
   *   10458 — % ERNI RTT tiempo real
   *   10459 — % ERNI RTD tiempo real
   *   10462 — % ERNI total
   *   10351 — Generación T.Real renovable (para ratio)
   */
  app.get('/api/snfi-u2/curtailment', auth, async (req, res) => {
    try {
      const today = new Date();
      const currentYear = today.getFullYear();
      const fromYear = Math.max(2020, Math.min(parseInt(req.query.from || '2020', 10), currentYear));
      const toYear   = Math.min(currentYear, Math.max(parseInt(req.query.to || String(currentYear), 10), fromYear));

      if (!process.env.ESIOS_API_KEY) return res.status(503).json({ error: 'ESIOS_TOKEN no configurado' });

      const startDate = `${fromYear}-01-01`;
      const endDate   = toYear < currentYear ? `${toYear}-12-31` : today.toISOString().split('T')[0];

      // Fetch curtailment + generation renewable in parallel
      const [erniTotalRes, erniRttRes, erniBalRes, pctTotalRes, pctRttRes, genRenovRes] = await Promise.all([
        fetchESIOS(2202, startDate, endDate, 'month'),    // ERNI Total MWh
        fetchESIOS(2200, startDate, endDate, 'month'),    // ERNI RTT MWh
        fetchESIOS(2201, startDate, endDate, 'month'),    // ERNI Balance MWh
        fetchESIOS(10462, startDate, endDate, 'month'),   // % ERNI total
        fetchESIOS(10458, startDate, endDate, 'month'),   // % ERNI RTT tiempo real
        fetchESIOS(10351, startDate, endDate, 'month'),   // Generación renovable total
      ]);

      const erniTotal  = erniTotalRes.ok  ? extractESIOSValues(erniTotalRes.data)  : [];
      const erniRtt    = erniRttRes.ok    ? extractESIOSValues(erniRttRes.data)    : [];
      const erniBal    = erniBalRes.ok    ? extractESIOSValues(erniBalRes.data)    : [];
      const pctTotal   = pctTotalRes.ok   ? extractESIOSValues(pctTotalRes.data)   : [];
      const pctRtt     = pctRttRes.ok     ? extractESIOSValues(pctRttRes.data)     : [];
      const genRenov   = genRenovRes.ok   ? extractESIOSValues(genRenovRes.data)   : [];

      // If primary ERNI indicator returned empty, surface a clear error
      if (!erniTotal.length) {
        const status = erniTotalRes.status || erniRttRes.status || 403;
        return res.status(503).json({
          error: `Indicadores ERNI no accesibles via ESIOS (HTTP ${status}). Los indicadores 2200/2201/2202 requieren permisos de cuenta institucional. Token personal sin acceso a datos de curtailment.`,
          esiosStatus: status,
          indicadores: [2202, 2200, 2201],
        });
      }

      // Index by month YYYY-MM
      const idxByMonth = (vals) => {
        const m = {};
        for (const v of vals) {
          const k = (v.datetime || '').substring(0, 7);
          if (k) m[k] = v.value;
        }
        return m;
      };

      const iTotal  = idxByMonth(erniTotal);
      const iRtt    = idxByMonth(erniRtt);
      const iBal    = idxByMonth(erniBal);
      const iPctT   = idxByMonth(pctTotal);
      const iPctR   = idxByMonth(pctRtt);
      const iGenR   = idxByMonth(genRenov);

      // Build monthly series from all keys
      const allMonths = [...new Set([
        ...Object.keys(iTotal), ...Object.keys(iRtt), ...Object.keys(iBal),
        ...Object.keys(iPctT), ...Object.keys(iPctR), ...Object.keys(iGenR),
      ])].sort();

      const mensual = allMonths.map(mes => ({
        mes,
        erni_total_mwh:    iTotal[mes] ?? null,
        erni_rtt_mwh:      iRtt[mes]   ?? null,
        erni_balance_mwh:  iBal[mes]   ?? null,
        pct_erni_total:    iPctT[mes]  ?? null,
        pct_erni_rtt:      iPctR[mes]  ?? null,
        gen_renovable_mwh: iGenR[mes]  ?? null,
      }));

      // Annual aggregates
      const porAnio = {};
      for (const m of mensual) {
        const y = m.mes.substring(0, 4);
        if (!porAnio[y]) porAnio[y] = { year: y, erni_total_mwh: 0, erni_rtt_mwh: 0, erni_balance_mwh: 0, gen_renovable_mwh: 0, meses: 0 };
        porAnio[y].erni_total_mwh   += m.erni_total_mwh   || 0;
        porAnio[y].erni_rtt_mwh     += m.erni_rtt_mwh     || 0;
        porAnio[y].erni_balance_mwh += m.erni_balance_mwh || 0;
        porAnio[y].gen_renovable_mwh+= m.gen_renovable_mwh|| 0;
        porAnio[y].meses++;
      }
      const anual = Object.values(porAnio).map(a => ({
        ...a,
        pct_curtailment: a.gen_renovable_mwh > 0
          ? Math.round((a.erni_total_mwh / a.gen_renovable_mwh) * 10000) / 100
          : null,
      }));

      const totalErni = mensual.reduce((s, m) => s + (m.erni_total_mwh || 0), 0);
      const totalRenov = mensual.reduce((s, m) => s + (m.gen_renovable_mwh || 0), 0);

      busEmit({
        id: crypto.randomUUID(), ts: new Date().toISOString(), seq: busEvents.length + 1,
        origin: 'SNFI-U2', dest: 'ELVI-RA', type: 'event', state: 'COMPLETED',
        label: `CURTAILMENT ${fromYear}-${toYear} · ${Math.round(totalErni / 1000)} GWh no integrados`,
        payload: { fromYear, toYear, totalErniMwh: Math.round(totalErni) },
        user: req.user,
      });

      res.json({
        fromYear, toYear,
        fuente: 'api.esios.ree.es — indicadores 2200/2201/2202/10458/10462/10351',
        descripcion: 'Energia Renovable No Integrable (ERNI) por restricciones tecnicas de red',
        total_erni_gwh: Math.round(totalErni / 1000 * 100) / 100,
        total_gen_renovable_gwh: Math.round(totalRenov / 1000 * 100) / 100,
        pct_curtailment_global: totalRenov > 0 ? Math.round((totalErni / totalRenov) * 10000) / 100 : null,
        anual,
        mensual,
        calculadoAt: new Date().toISOString(),
      });
    } catch (ex) {
      console.error('[snfi-u2/curtailment]', ex);
      busEmitAlert({ origin: 'SNFI-U2', label: `S-NFI U2 CURTAILMENT · fallo`, detail: ex.message, user: req.user });
      res.status(500).json({ error: ex.message || 'error curtailment ESIOS' });
    }
  });

  /*
   * GET /api/snfi-u2/curtailment-estimado?from=YYYY-MM-DD&to=YYYY-MM-DD
   *
   * Calculo NO OFICIAL de curtailment espanol + comparativa con la red de
   * los paises vecinos y fronterizos.
   *
   * Existe porque /curtailment (ERNI oficial) devuelve 503 con token
   * personal: los indicadores 2200/2201/2202 son de cuenta institucional.
   * Ver el bloque de doctrina sobre estimarCurtailmentES arriba.
   */
  app.get('/api/snfi-u2/curtailment-estimado', auth, async (req, res) => {
    try {
      const today = new Date();
      const defaultFrom = new Date(today.getTime() - 365 * 24 * 3600 * 1000);
      const from = String(req.query.from || defaultFrom.toISOString().split('T')[0]);
      const to   = String(req.query.to   || today.toISOString().split('T')[0]);

      const umbral = Number.isFinite(Number(req.query.umbral))
        ? Number(req.query.umbral) : CURTAILMENT_PRICE_THRESHOLD_DEFAULT;
      const tasa = Number.isFinite(Number(req.query.tasa))
        ? Math.min(1, Math.max(0, Number(req.query.tasa))) : CURTAILMENT_RATE_DEFAULT;

      // Fuente: apidatos.ree.es (publico, sin token). No se usa ESIOS
      // porque su token devuelve 403 en todos los indicadores aqui.
      const { precios, renovable: genRenov, mesesPedidos, mesesFallidos } =
        await fetchCurtailmentInputs(from, to);

      if (!precios.length || !genRenov.length) {
        return res.status(503).json({
          error: 'apidatos.ree.es no devolvio series para el rango pedido',
          detalle: { mesesPedidos, mesesFallidos },
        });
      }

      const es = estimarCurtailmentES(precios, genRenov, { umbral, tasa });

      // Comparativa: Espana en vivo + vecinos con cifra publicada.
      // La media se pondera por generacion renovable, no aritmetica: una
      // media simple daria a Andorra el mismo peso que a Francia.
      const anualizadoTwh = es.renovable_total_gwh / 1000;
      const comparativa = NEIGHBOUR_GRIDS.map((n) => (
        n.code === 'ES'
          ? {
              ...n,
              pctCurtailmentRenovable: es.pct_sobre_renovable,
              genRenovableTwhYear: Math.round(anualizadoTwh * 100) / 100,
              esEstimacionPropia: true,
            }
          : { ...n, esEstimacionPropia: false }
      ));

      const conDato = comparativa.filter((c) => c.pctCurtailmentRenovable != null && c.genRenovableTwhYear);
      const sumaGen = conDato.reduce((s, c) => s + c.genRenovableTwhYear, 0);
      const mediaPonderada = sumaGen > 0
        ? conDato.reduce((s, c) => s + c.pctCurtailmentRenovable * c.genRenovableTwhYear, 0) / sumaGen
        : null;
      const mediaAritmetica = conDato.length
        ? conDato.reduce((s, c) => s + c.pctCurtailmentRenovable, 0) / conDato.length
        : null;

      busEmit({
        id: crypto.randomUUID(), ts: new Date().toISOString(), seq: busEvents.length + 1,
        origin: 'SNFI-U2', dest: 'ELVI-RA', type: 'event', state: 'COMPLETED',
        label: `CURTAILMENT ESTIMADO ${from}→${to} · ${es.curtailment_estimado_gwh} GWh (${es.pct_sobre_renovable}% renovable)`,
        payload: { from, to, gwh: es.curtailment_estimado_gwh, pct: es.pct_sobre_renovable },
        user: req.user,
      });

      res.json({
        from, to,
        oficial: false,
        fuente: 'apidatos.ree.es (publico) — precios-mercados-tiempo-real + estructura-generacion',
        cobertura: { meses_pedidos: mesesPedidos, meses_sin_datos: mesesFallidos },
        metodologia: `Por cada dia se calcula la fraccion de horas con precio SPOT <= ${umbral} EUR/MWh y se aplica a la generacion renovable de ese dia; sobre esa energia expuesta se aplica una tasa de vertido del ${Math.round(tasa * 100)}%. Precio horario y generacion diaria porque estructura-generacion de apidatos no admite granularidad horaria. Proxy: NO es la serie ERNI oficial de REE.`,
        aviso: 'Calculo no oficial. La cifra oficial (indicadores ERNI 2200/2201/2202) requiere cuenta institucional ESIOS; el token de este despliegue devuelve 403 en todo ESIOS. Este proxy subestima la restriccion tecnica local y sobreestima las horas de precio bajo por causas ajenas (hidraulicidad, demanda festiva).',
        parametros: { umbral_eur_mwh: umbral, tasa_vertido: tasa },
        espana: es,
        comparativa_vecinos: comparativa,
        media_vecinos: {
          pct_ponderado_por_generacion: mediaPonderada != null ? Math.round(mediaPonderada * 100) / 100 : null,
          pct_aritmetico: mediaAritmetica != null ? Math.round(mediaAritmetica * 100) / 100 : null,
          paises_con_dato: conDato.length,
          nota: 'Ponderada por TWh renovables: sin ponderar, Andorra pesaria igual que Francia. Vecinos = cifras publicadas PLACEHOLDER, no lectura en vivo (no hay API RTE/REN/ONEE integrada).',
        },
        calculadoAt: new Date().toISOString(),
      });
    } catch (ex) {
      console.error('[snfi-u2/curtailment-estimado]', ex);
      busEmitAlert({ origin: 'SNFI-U2', label: 'S-NFI U-2 CURTAILMENT ESTIMADO · fallo', detail: ex.message, user: req.user });
      res.status(500).json({ error: ex.message || 'error curtailment estimado' });
    }
  });

  /*
   * GET /api/snfi-u2/installed-capacity
   * Potencia instalada por tecnología (histórico anual)
   * Indicadores:
   *   1477  Nuclear       1486  Solar FV      1487  Solar Térmica
   *   1483  Eólica        1484  Hidroeólica   10302 Total Renovable
   *   10301 Total No Renovable               1488  Otras renovables
   *   1489  Cogeneración  1490  Residuos no renov  1491 Residuos renov
   */
  app.get('/api/snfi-u2/installed-capacity', auth, async (req, res) => {
    try {
      if (!process.env.ESIOS_API_KEY) return res.status(503).json({ error: 'ESIOS_TOKEN no configurado' });

      const today = new Date();
      const startDate = '2020-01-01';
      const endDate   = today.toISOString().split('T')[0];

      const IDS = {
        nuclear:        1477,
        solar_fv:       1486,
        solar_term:     1487,
        eolica:         1483,
        hidro:          467,
        otras_renov:    1488,
        cogeneracion:   1489,
        residuos_renov: 1491,
        residuos_norenov: 1490,
        total_renov:    10302,
        total_norenov:  10301,
      };

      const results = await Promise.all(
        Object.entries(IDS).map(([key, id]) =>
          fetchESIOS(id, startDate, endDate, 'month').then(r => ({ key, values: r.ok ? extractESIOSValues(r.data) : [] }))
        )
      );

      // Index each tech by month
      const byTech = {};
      for (const { key, values } of results) {
        byTech[key] = {};
        for (const v of values) {
          const k = (v.datetime || '').substring(0, 7);
          if (k) byTech[key][k] = v.value;
        }
      }

      const allMonths = [...new Set(results.flatMap(r => r.values.map(v => (v.datetime || '').substring(0, 7))))].filter(Boolean).sort();

      const mensual = allMonths.map(mes => {
        const row = { mes };
        for (const key of Object.keys(IDS)) row[key + '_mw'] = byTech[key][mes] ?? null;
        return row;
      });

      res.json({
        fuente: 'api.esios.ree.es — potencia instalada por tecnologia (2020-hoy)',
        indicadores: IDS,
        mensual,
        calculadoAt: new Date().toISOString(),
      });
    } catch (ex) {
      console.error('[snfi-u2/installed-capacity]', ex);
      busEmitAlert({ origin: 'SNFI-U2', label: `S-NFI U2 INSTALLED CAPACITY · fallo`, detail: ex.message, user: req.user });
      res.status(500).json({ error: ex.message || 'error installed-capacity ESIOS' });
    }
  });

  /*
   * GET /api/snfi-u2/esios-generation?from=2020&to=2026&trunc=month
   * Mix generación histórico via ESIOS (más profundo que apidatos.ree.es)
   * Indicadores T.Real por tecnología:
   *   10351 Renovable total   10352 No renovable total
   *   551   Eólica            552   Solar total
   *   1295  Solar FV          1294  Solar Térmica
   *   549   Nuclear           546   Hidráulica
   *   1293  Demanda real      600   Precio SPOT
   */
  app.get('/api/snfi-u2/esios-generation', auth, async (req, res) => {
    try {
      if (!process.env.ESIOS_API_KEY) return res.status(503).json({ error: 'ESIOS_TOKEN no configurado' });

      const today = new Date();
      const currentYear = today.getFullYear();
      const fromYear = Math.max(2020, parseInt(req.query.from || '2020', 10));
      const toYear   = Math.min(currentYear, parseInt(req.query.to || String(currentYear), 10));
      const trunc    = ['hour','day','month','year'].includes(req.query.trunc) ? req.query.trunc : 'month';

      const startDate = `${fromYear}-01-01`;
      const endDate   = toYear < currentYear ? `${toYear}-12-31` : today.toISOString().split('T')[0];

      const IDS = {
        renovable_total: 10351,
        no_renovable:    10352,
        eolica:          551,
        solar:           552,
        solar_fv:        1295,
        solar_term:      1294,
        nuclear:         549,
        hidro:           546,
        demanda_real:    1293,
        precio_spot:     600,
      };

      const results = await Promise.all(
        Object.entries(IDS).map(([key, id]) =>
          fetchESIOS(id, startDate, endDate, trunc).then(r => ({ key, values: r.ok ? extractESIOSValues(r.data) : [] }))
        )
      );

      const byKey = {};
      for (const { key, values } of results) {
        byKey[key] = {};
        const klen = trunc === 'hour' ? 13 : trunc === 'day' ? 10 : 7;
        for (const v of values) {
          const k = (v.datetime || '').substring(0, klen);
          if (k) byKey[key][k] = v.value;
        }
      }

      const allKeys = [...new Set(results.flatMap(r => {
        const klen = trunc === 'hour' ? 13 : trunc === 'day' ? 10 : 7;
        return r.values.map(v => (v.datetime || '').substring(0, klen));
      }))].filter(Boolean).sort();

      const serie = allKeys.map(k => {
        const row = { datetime: k };
        for (const key of Object.keys(IDS)) row[key] = byKey[key][k] ?? null;
        // derived
        const renov = row.renovable_total || 0;
        const noRen = row.no_renovable || 0;
        const total = renov + noRen;
        row.total_gen = total || null;
        row.pct_renovable = total > 0 ? Math.round((renov / total) * 1000) / 10 : null;
        row.precio_negativo = (row.precio_spot !== null && row.precio_spot < 0);
        return row;
      });

      // Aggregate per year if trunc=month
      const anual = {};
      for (const row of serie) {
        const y = row.datetime.substring(0, 4);
        if (!anual[y]) anual[y] = { year: y, horas_precio_negativo: 0, renov_sum: 0, norenov_sum: 0, n: 0 };
        anual[y].horas_precio_negativo += row.precio_negativo ? 1 : 0;
        anual[y].renov_sum += row.renovable_total || 0;
        anual[y].norenov_sum += row.no_renovable || 0;
        anual[y].n++;
      }
      const anualArr = Object.values(anual).map(a => ({
        ...a,
        pct_renovable_medio: (a.renov_sum + a.norenov_sum) > 0
          ? Math.round((a.renov_sum / (a.renov_sum + a.norenov_sum)) * 1000) / 10
          : null,
      }));

      res.json({
        fromYear, toYear, trunc,
        fuente: 'api.esios.ree.es — generacion T.Real + precio SPOT + demanda (token personal)',
        indicadores: IDS,
        serie,
        anual: anualArr,
        calculadoAt: new Date().toISOString(),
      });
    } catch (ex) {
      console.error('[snfi-u2/esios-generation]', ex);
      busEmitAlert({ origin: 'SNFI-U2', label: `S-NFI U2 ESIOS GENERATION · fallo`, detail: ex.message, user: req.user });
      res.status(500).json({ error: ex.message || 'error esios-generation' });
    }
  });

  return {
    getU2SnapshotToday: () => {
      const today = new Date().toISOString().split('T')[0];
      const d = liveCache.get(today);
      if (!d) return null;
      return {
        fecha: today,
        exceso_gwh_hoy: d.exceso_gwh_hoy ?? null,
        pct_horas_desperdiciadas: d.pct_horas_desperdiciadas ?? null,
        precio_min_eur_mwh: d.precio_min_eur_mwh ?? null,
        precio_max_eur_mwh: d.precio_max_eur_mwh ?? null,
        actualizado: liveLastUpdated,
      };
    },
  };
}
