/**
 * Telemetria de la linea S-NFI BioHybrid: Bio-Grinder -> Bio-Dehydrator -> Bio-Pelletizer.
 *
 * ESTADO REAL: no hay sensores conectados. Todo valor que sale de este modulo es SIMULADO,
 * con el mismo criterio que la telemetria "CUDA-Bio" de Pactvm Planetario: funcion
 * determinista del reloj (sin Math.random), de modo que dos pestanas ven la misma curva y el
 * historial se puede reconstruir hacia atras. createTelemetryFeed() es el punto de sustitucion
 * por la fuente real (ØPS via Foundry / bus de eventos): el HUD solo consume snapshots.
 *
 * Procedencia de cada cifra (campo `source` de cada metrica):
 *   'spec'         dato dado por Direccion (ficha S-NFI BioHybrid)
 *   'placeholder'  orden de magnitud sin ficha tecnica; editable aqui, el HUD lo marca con †
 *   'derived'      calculado a partir de otras lecturas
 *
 * Sin dependencias de DOM ni de three.js: se importa tal cual desde node:test.
 */

const INF = Infinity;

/** Id de nodo mostrado en el HUD. PLACEHOLDER: no hay registro de nodos de maquinaria todavia. */
export const NODE_ID = 'BH-0001';

/**
 * @typedef {[number, number]} Range
 * @typedef {Object} MetricDef
 * @property {string} label      nombre completo
 * @property {string} short      etiqueta corta del marcador 3D
 * @property {string} unit
 * @property {number} decimals   resolucion de la lectura (tambien la del redondeo interno)
 * @property {number} nominal    valor de referencia (marca en los medidores)
 * @property {'spec'|'placeholder'|'derived'} source
 * @property {{base?: number, amp: number, period: number, noise: number}} [sim]  oscilacion simulada
 * @property {(v: Record<string, number>) => number} [derive]                      lectura calculada
 * @property {Range} [ok]        rango nominal: fuera = atencion. Sin `ok` la metrica no cuenta para el estado
 * @property {Range} [warn]      rango tolerable: fuera = alarma
 * @property {Range} range       escala del medidor y limites de la simulacion
 */

/**
 * Esquema de una celda del HUD:
 *   view 'spark'   valor + sparkline (historial de 60 s)
 *   view 'meter'   valor + medidor; fill:true = barra de progreso, false = banda por zonas con marcador
 *   view 'flow'    dos lecturas encadenadas (entrada -> salida)
 *   view 'probes'  varias sondas + medidor de la media
 */

/** @type {Record<string, any>} */
export const MACHINE_SPECS = {
  'bio-grinder': {
    id: 'bio-grinder',
    type: 'BIO-GRINDER',
    role: 'Trituración y homogenización',
    unitTag: 'GR',
    units: 4, // 4 x 460 kg/h = 1.840 kg/h por nodo (spec de Direccion). La base de conocimiento habla de un piloto con 2 BioGrinders.
    glance: ['rate', 'h_out', 'torque'],
    standard: null,
    demoFault: { key: 'vibration', delta: 3.8, label: 'pico de vibración' },
    metrics: {
      rate: { label: 'Tasa de procesamiento', short: 'TASA', unit: 'kg/h', decimals: 0, nominal: 460, source: 'spec',
        sim: { amp: 8, period: 53, noise: 3 }, ok: [420, 500], warn: [380, 540], range: [0, 600] },
      extraction: { label: 'Eficiencia de deshidratación inicial', short: 'EXTR', unit: '%', decimals: 1, nominal: 60, source: 'spec',
        sim: { amp: 1.1, period: 61, noise: 0.4 }, ok: [55, 65], warn: [50, 70], range: [0, 100] },
      h_in: { label: 'Humedad de entrada (H_in)', short: 'H IN', unit: '%', decimals: 1, nominal: 70, source: 'spec',
        sim: { amp: 3.2, period: 89, noise: 0.8 }, ok: [15, 85], warn: [10, 90], range: [0, 100] },
      // Balance de masa: base 100 kg con agua w; extraer una fraccion e del agua deja w(1-e) de agua y (1-w) de solido.
      // Con w = 70 % y e = 60 % sale 48,3 %, que cuadra con el ~48 % de la ficha.
      h_out: { label: 'Humedad de salida (H_out)', short: 'H OUT', unit: '%', decimals: 1, nominal: 48, source: 'derived',
        derive: (v) => {
          const wet = (v.h_in / 100) * (1 - v.extraction / 100);
          return (wet / (wet + (1 - v.h_in / 100))) * 100;
        },
        ok: [40, 56], warn: [30, 65], range: [0, 100] },
      torque: { label: 'Par motor', short: 'PAR', unit: 'Nm', decimals: 0, nominal: 850, source: 'placeholder',
        sim: { amp: 55, period: 37, noise: 16 }, ok: [500, 1100], warn: [300, 1300], range: [0, 1500] },
      granulometry: { label: 'Granulometría de salida', short: 'GRAN', unit: 'mm', decimals: 1, nominal: 12, source: 'placeholder',
        sim: { amp: 0.7, period: 71, noise: 0.25 }, ok: [8, 15], warn: [5, 20], range: [0, 25] },
      vibration: { label: 'Vibración acústica de chasis', short: 'VIB', unit: 'mm/s', decimals: 1, nominal: 2.4, source: 'placeholder',
        sim: { amp: 0.3, period: 29, noise: 0.1 }, ok: [0, 4.5], warn: [0, 7.1], range: [0, 10] },
      chassisTemp: { label: 'Temperatura de chasis', short: 'T CHASIS', unit: '°C', decimals: 1, nominal: 54, source: 'placeholder',
        sim: { amp: 2, period: 140, noise: 0.3 }, ok: [0, 70], warn: [0, 85], range: [20, 100] },
    },
    layout: [
      { title: 'Rendimiento', cells: [
        { view: 'spark', key: 'rate', note: (v, s) => `NODO ${fmt(v.rate * s.units, 0)} kg/h · ${s.units} UD` },
        { view: 'meter', key: 'extraction', fill: true, ticks: [60], note: () => 'CHOQUE TÉRMICO-MECÁNICO' },
        { view: 'flow', title: 'Curva de humedad', keys: ['h_in', 'h_out'], span: 2, ticks: [70],
          note: () => 'ENTRADA 15-85 % · MEDIA 70 % → SALIDA ~48 %' },
      ] },
      { title: 'Salud mecánica', cells: [
        { view: 'spark', key: 'torque', note: () => 'ESFUERZO DE CUCHILLAS' },
        { view: 'meter', key: 'granulometry', ticks: [12], note: () => 'PARTÍCULA MOLIDA' },
        { view: 'spark', key: 'vibration', note: () => 'RMS · CHASIS' },
        { view: 'meter', key: 'chassisTemp', fill: true, note: () => 'ENVOLVENTE TÉRMICA' },
      ] },
    ],
  },

  'bio-dehydrator': {
    id: 'bio-dehydrator',
    type: 'BIO-DEHYDRATOR',
    role: 'Deshidratación térmico-mecánica',
    unitTag: 'DH',
    units: 2, // 2 x 1.000 kg/h = 2.000 kg/h por nodo (spec de Direccion)
    glance: ['rate', 'h_out', 'chamberTemp'],
    // Estandar S-NFI 7 %: humedad de salida <= 7,0 % (93 % PCI). Se evalua sobre la lectura redondeada que ve el operador.
    standard: {
      key: 'h_out',
      rule: 'H ≤ 7,0 %',
      evaluate: (v) => ({
        ok: v.h_out <= 7.0,
        detail: v.h_out <= 7.0
          ? `H salida ${fmt(v.h_out, 2)} % ≤ 7,0 % · PCI rel. ${fmt(100 - v.h_out, 1)} %`
          : `H salida ${fmt(v.h_out, 2)} % supera el 7,0 % del estándar`,
      }),
    },
    demoFault: { key: 'h_out', delta: 0.75, label: 'H de salida > 7,0 %' },
    metrics: {
      rate: { label: 'Tasa de procesamiento', short: 'TASA', unit: 'kg/h', decimals: 0, nominal: 1000, source: 'spec',
        sim: { amp: 18, period: 59, noise: 5 }, ok: [900, 1100], warn: [800, 1200], range: [0, 1400] },
      extraction: { label: 'Rendimiento hídrico secundario', short: 'EXTR', unit: '%', decimals: 1, nominal: 80, source: 'spec',
        sim: { amp: 1.3, period: 67, noise: 0.4 }, ok: [75, 85], warn: [70, 90], range: [0, 100] },
      h_out: { label: 'Humedad de salida', short: 'H OUT', unit: '%', decimals: 2, nominal: 7.0, source: 'spec',
        sim: { base: 6.7, amp: 0.14, period: 73, noise: 0.05 }, ok: [0, 7.0], warn: [0, 8.0], range: [0, 12] },
      chamberTemp: { label: 'Temperatura de cámara (media PT100)', short: 'T CÁM', unit: '°C', decimals: 1, nominal: 78, source: 'placeholder',
        sim: { amp: 2.6, period: 97, noise: 0.2 }, ok: [55, 95], warn: [50, 100], range: [40, 110] },
      pt1: { label: 'PT100 T1', short: 'T1', unit: '°C', decimals: 1, nominal: 78, source: 'derived',
        derive: (v) => v.chamberTemp - 1.3, ok: [55, 95], warn: [50, 100], range: [40, 110] },
      pt2: { label: 'PT100 T2', short: 'T2', unit: '°C', decimals: 1, nominal: 78, source: 'derived',
        derive: (v) => v.chamberTemp + 0.2, ok: [55, 95], warn: [50, 100], range: [40, 110] },
      pt3: { label: 'PT100 T3', short: 'T3', unit: '°C', decimals: 1, nominal: 78, source: 'derived',
        derive: (v) => v.chamberTemp + 1.1, ok: [55, 95], warn: [50, 100], range: [40, 110] },
      // 7,4 L/min sale de un balance de masa por unidad: 1.000 kg/h con ~48 % de humedad de entrada
      // (la salida del Grinder) y 7 % de salida evaporan ~441 kg/h de agua. Sigue siendo una estimacion.
      steam: { label: 'Flujo de vapor / condensados', short: 'VAPOR', unit: 'L/min', decimals: 1, nominal: 7.4, source: 'placeholder',
        sim: { amp: 0.28, period: 47, noise: 0.1 }, ok: [5.5, 9.5], warn: [4, 11], range: [0, 14] },
      chamberPressure: { label: 'Presión de cámara de evaporación', short: 'P CÁM', unit: 'bar', decimals: 3, nominal: 1.02, source: 'placeholder',
        sim: { amp: 0.012, period: 43, noise: 0.004 }, ok: [0.95, 1.1], warn: [0.85, 1.2], range: [0.7, 1.3] },
    },
    layout: [
      { title: 'Rendimiento', cells: [
        { view: 'spark', key: 'rate', note: (v, s) => `NODO ${fmt(v.rate * s.units, 0)} kg/h · ${s.units} UD` },
        { view: 'meter', key: 'extraction', fill: true, ticks: [80], note: () => 'AGUA RESIDUAL EXTRAÍDA' },
        { view: 'meter', key: 'h_out', span: 2, ticks: [7], note: (v) => `ESTÁNDAR ≤ 7,0 % · PCI REL. ${fmt(100 - v.h_out, 1)} %` },
      ] },
      { title: 'Salud térmica y de proceso', cells: [
        { view: 'probes', title: 'Sondas PT100 · cámara de secado', keys: ['pt1', 'pt2', 'pt3'], mean: 'chamberTemp', span: 2,
          note: () => '±0,1 °C · RANGO OPERATIVO 50-100 °C' },
        { view: 'spark', key: 'steam', note: () => 'EXTRAÍDO DE LA CÁMARA' },
        { view: 'spark', key: 'chamberPressure', note: (v) => `${fmt(v.chamberPressure * 1000, 0)} hPa` },
      ] },
    ],
  },

  'bio-pelletizator': {
    id: 'bio-pelletizator',
    type: 'BIO-PELLETIZER',
    role: 'Densificación y formación del biocombustible',
    unitTag: 'PL',
    units: 1,
    glance: ['rate', 'moisture', 'power'],
    // Estandar S-NFI 7 % en el pellet: humedad estable en la ventana 7,0 % - 8,0 %.
    standard: {
      key: 'moisture',
      rule: '7,0 % ≤ H ≤ 8,0 %',
      evaluate: (v) => ({
        ok: v.moisture >= 7.0 && v.moisture <= 8.0,
        detail: v.moisture >= 7.0 && v.moisture <= 8.0
          ? `Humedad pellet ${fmt(v.moisture, 2)} % dentro de la ventana 7,0-8,0 %`
          : `Humedad pellet ${fmt(v.moisture, 2)} % fuera de la ventana 7,0-8,0 %`,
      }),
    },
    demoFault: { key: 'moisture', delta: 0.9, label: 'humedad fuera de ventana' },
    metrics: {
      rate: { label: 'Capacidad de procesamiento', short: 'CAP', unit: 't/h', decimals: 2, nominal: 2.0, source: 'spec',
        sim: { base: 1.96, amp: 0.04, period: 61, noise: 0.012 }, ok: [1.8, 2.2], warn: [1.5, 2.4], range: [0, 2.8] },
      power: { label: 'Potencia / consumo', short: 'POT', unit: 'kW', decimals: 0, nominal: 132, source: 'spec',
        sim: { base: 124, amp: 3.5, period: 47, noise: 1.2 }, ok: [0, 132], warn: [0, 145], range: [0, 160] },
      density: { label: 'Densidad de salida', short: 'DENS', unit: 'kg/m³', decimals: 0, nominal: 650, source: 'spec',
        sim: { base: 672, amp: 6, period: 83, noise: 2 }, ok: [650, INF], warn: [620, INF], range: [560, 760] },
      moisture: { label: 'Estabilidad hídrica del pellet', short: 'H PELLET', unit: '%', decimals: 2, nominal: 7.5, source: 'spec',
        sim: { base: 7.45, amp: 0.15, period: 67, noise: 0.05 }, ok: [7.0, 8.0], warn: [6.5, 8.5], range: [5, 10] },
      diePressure: { label: 'Presión de compresión de dado', short: 'P DADO', unit: 'MPa', decimals: 1, nominal: 62, source: 'placeholder',
        sim: { amp: 3.2, period: 31, noise: 0.9 }, ok: [40, 85], warn: [25, 100], range: [0, 120] },
      matrixTemp: { label: 'Temperatura de extrusión (matriz)', short: 'T MATRIZ', unit: '°C', decimals: 1, nominal: 92, source: 'placeholder',
        sim: { amp: 2.6, period: 113, noise: 0.5 }, ok: [70, 110], warn: [50, 125], range: [20, 140] },
      // kW por t/h equivale a kWh por tonelada. A plena carga nominal: 132 kW / 2,0 t/h = 66 kW/t.
      specificEnergy: { label: 'Eficiencia energética específica', short: 'kW/t', unit: 'kW/t', decimals: 1, nominal: 66, source: 'derived',
        derive: (v) => v.power / v.rate, ok: [0, 75], warn: [0, 90], range: [0, 120] },
    },
    layout: [
      { title: 'Rendimiento', cells: [
        { view: 'spark', key: 'rate', note: () => 'NOMINAL 2,0 t/h' },
        { view: 'meter', key: 'power', fill: true, ticks: [132], note: (v) => `INSTALADA 132 kW · CARGA ${fmt((v.power / 132) * 100, 0)} %` },
        { view: 'meter', key: 'density', ticks: [650], note: () => 'MÍNIMO > 650 kg/m³' },
        { view: 'meter', key: 'moisture', ticks: [7, 8], note: () => 'VENTANA 7,0-8,0 %' },
      ] },
      { title: 'Salud mecánica', cells: [
        { view: 'spark', key: 'diePressure', note: () => 'DADO / MATRIZ' },
        { view: 'meter', key: 'matrixTemp', fill: true, note: () => 'EXTRUSIÓN' },
        { view: 'spark', key: 'specificEnergy', span: 2, note: () => 'kWh POR TONELADA · PLENA CARGA 66' },
      ] },
    ],
  },
};

export const MACHINE_IDS = Object.keys(MACHINE_SPECS);

/* ---------------------------------------------------------------- formato */

const formatters = new Map();
/** Numero con coma decimal y separador de miles siempre visible (es-ES omite el de 4 digitos por defecto). */
export function fmt(v, decimals = 0) {
  if (!Number.isFinite(v)) return '--';
  let f = formatters.get(decimals);
  if (!f) {
    f = new Intl.NumberFormat('es-ES', { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: 'always' });
    formatters.set(decimals, f);
  }
  return f.format(v === 0 ? 0 : v);
}

const roundTo = (v, d) => { const k = 10 ** d; return Math.round(v * k) / k; };

/* ------------------------------------------------------------ ruido determinista */

function hashString(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

function hash01(n) {
  let x = (n | 0) + 0x6d2b79f5;
  x = Math.imul(x ^ (x >>> 15), x | 1);
  x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
}

/** Ruido de valor suave en [-1, 1]: interpola entre puntos de rejilla enteros con smoothstep. */
function valueNoise(t, seed) {
  const i = Math.floor(t);
  const f = t - i;
  const u = f * f * (3 - 2 * f);
  const a = hash01(i * 7919 + seed) * 2 - 1;
  const b = hash01((i + 1) * 7919 + seed) * 2 - 1;
  return a + (b - a) * u;
}

const TAU = Math.PI * 2;
const smooth = (x) => x * x * (3 - 2 * x);

function simulate(def, tSec, seed) {
  const s = def.sim;
  const base = s.base ?? def.nominal;
  const slow = Math.sin((TAU * tSec) / s.period + seed * 0.37);
  const mid = Math.sin((TAU * tSec) / (s.period * 0.43) + seed * 1.13) * 0.35;
  const jitter = valueNoise(tSec / 1.7, seed) * s.noise;
  return base + s.amp * (slow + mid) + jitter;
}

/* ---------------------------------------------------------------- niveles */

const within = (v, r) => v >= r[0] && v <= r[1];
const RANK = { ok: 0, warn: 1, crit: 2 };

/** 'ok' | 'warn' | 'crit' segun los rangos de la metrica; null si no tiene rango de aceptacion. */
export function levelOf(def, v) {
  if (!def.ok) return null;
  if (within(v, def.ok)) return 'ok';
  return def.warn && within(v, def.warn) ? 'warn' : 'crit';
}

export function worstLevel(levels) {
  let worst = 'ok';
  for (const l of levels) if (l && RANK[l] > RANK[worst]) worst = l;
  return worst;
}

/* -------------------------------------------------------------- muestreo */

/**
 * Lecturas de una maquina en el instante tMs. Funcion pura del tiempo y de los offsets de falla.
 * @param {any} spec
 * @param {number} tMs
 * @param {Record<string, number>} [offsets] desviaciones aditivas por metrica (fallas inyectadas)
 */
export function sampleMachine(spec, tMs, offsets = {}) {
  const tSec = tMs / 1000;
  /** @type {Record<string, number>} */
  const values = {};
  const store = (key, def, raw) => {
    const [lo, hi] = def.range;
    values[key] = roundTo(Math.min(Math.max(raw + (offsets[key] || 0), lo), hi), def.decimals);
  };
  for (const [key, def] of Object.entries(spec.metrics)) {
    if (!def.sim) continue;
    store(key, def, simulate(def, tSec, hashString(`${spec.id}:${key}`)));
  }
  for (const [key, def] of Object.entries(spec.metrics)) {
    if (def.derive) store(key, def, def.derive(values));
  }
  /** @type {Record<string, string|null>} */
  const levels = {};
  for (const [key, def] of Object.entries(spec.metrics)) levels[key] = levelOf(def, values[key]);
  const status = worstLevel(Object.values(levels));
  const standard = spec.standard ? spec.standard.evaluate(values) : null;
  return { values, levels, status: standard && !standard.ok ? worstLevel([status, 'warn']) : status, standard };
}

/* ----------------------------------------------------------- huella SHA-256 */

function hex(buf) {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Huella efimera del paquete de lectura: SHA-256 de `nodo|maquina|ts|valores`, truncada a 12 hex.
 * Es un fingerprint LOCAL del snapshot que se esta mostrando, no una firma del nodo: la firma
 * HMAC real la valida el Ingress Gateway de Foundry cuando exista hardware conectado.
 * SubtleCrypto exige contexto seguro (https o localhost); fuera de el cae a un hash no
 * criptografico y lo declara en `algo`.
 * @returns {Promise<{algo: 'SHA-256'|'LOCAL', hex: string}>}
 */
export async function fingerprint(nodeId, machineId, ts, values) {
  const body = `${nodeId}|${machineId}|${ts}|` + Object.keys(values).sort().map((k) => `${k}=${values[k]}`).join(';');
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(body));
    return { algo: 'SHA-256', hex: hex(digest).slice(0, 12).toUpperCase() };
  }
  const a = hashString(body).toString(16).padStart(8, '0');
  const b = hashString(body + '#').toString(16).padStart(8, '0');
  return { algo: 'LOCAL', hex: (a + b).slice(0, 12).toUpperCase() };
}

/* ------------------------------------------------------------------ feed */

const FAULT_RISE_MS = 2500;
const FAULT_FALL_MS = 5000;

function faultOffset(f, tMs) {
  const dt = tMs - f.start;
  if (dt < 0) return 0;
  if (dt < f.rise) return f.delta * smooth(dt / f.rise);
  if (dt < f.rise + f.hold) return f.delta;
  const d2 = dt - f.rise - f.hold;
  return d2 < f.fall ? f.delta * (1 - smooth(d2 / f.fall)) : 0;
}

/**
 * Fuente de telemetria. Hoy simulada; una fuente real implementa esta misma superficie.
 * El reloj solo corre con la fuente activa y con al menos un suscriptor.
 * @param {{intervalMs?: number, historyLen?: number, now?: () => number}} [opts]
 */
export function createTelemetryFeed({ intervalMs = 1000, historyLen = 60, now = () => Date.now() } = {}) {
  const subscribers = new Set();
  /** @type {Array<{machineId: string, key: string, delta: number, start: number, rise: number, hold: number, fall: number}>} */
  let faults = [];
  /** @type {Map<string, Record<string, number[]>>} */
  const histories = new Map();
  /** @type {Map<string, any>} */
  const latest = new Map();
  let active = false;
  let timer = null;
  let running = null; // promesa del tick en vuelo
  let rerun = false;  // se pidio otro tick mientras corria uno

  const offsetsAt = (machineId, tMs) => {
    /** @type {Record<string, number>} */
    const out = {};
    for (const f of faults) if (f.machineId === machineId) out[f.key] = (out[f.key] || 0) + faultOffset(f, tMs);
    return out;
  };

  const pushHistory = (machineId, values) => {
    let h = histories.get(machineId);
    if (!h) { h = {}; histories.set(machineId, h); }
    for (const [k, v] of Object.entries(values)) {
      const arr = h[k] || (h[k] = []);
      arr.push(v);
      if (arr.length > historyLen) arr.shift();
    }
    return h;
  };

  // La simulacion es funcion del reloj: al activar se reconstruyen los ultimos historyLen s, sin hueco en las curvas.
  const rebuildHistory = (tMs) => {
    histories.clear();
    for (const id of MACHINE_IDS) {
      for (let i = historyLen - 1; i >= 1; i--) {
        const t = tMs - i * intervalMs;
        pushHistory(id, sampleMachine(MACHINE_SPECS[id], t, offsetsAt(id, t)).values);
      }
    }
  };

  async function tickOnce() {
    const ts = now();
    faults = faults.filter((f) => ts < f.start + f.rise + f.hold + f.fall);
    const snapshots = new Map();
    await Promise.all(MACHINE_IDS.map(async (id) => {
      const spec = MACHINE_SPECS[id];
      const sample = sampleMachine(spec, ts, offsetsAt(id, ts));
      const history = pushHistory(id, sample.values);
      const hash = await fingerprint(NODE_ID, id, ts, sample.values);
      const snap = { machineId: id, ts, ...sample, history, hash, faultActive: faults.some((f) => f.machineId === id), source: 'simulated' };
      latest.set(id, snap);
      snapshots.set(id, snap);
    }));
    for (const fn of subscribers) fn(snapshots);
  }

  // Un solo tick a la vez (el historial es compartido). Un tick pedido en vuelo no se descarta:
  // se repite con el reloj fresco, para que un cambio de falla nunca se muestre con lecturas viejas.
  function tick() {
    if (running) { rerun = true; return running; }
    running = (async () => {
      try {
        do { rerun = false; await tickOnce(); } while (rerun);
      } finally {
        running = null;
      }
    })();
    return running;
  }

  function sync() {
    const shouldRun = active && subscribers.size > 0;
    if (shouldRun && !timer) {
      rebuildHistory(now());
      tick();
      timer = setInterval(tick, intervalMs);
    } else if (!shouldRun && timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    source: 'simulated',
    nodeId: NODE_ID,
    /** @returns {() => void} baja del suscriptor */
    subscribe(fn) {
      subscribers.add(fn);
      sync();
      return () => { subscribers.delete(fn); sync(); };
    },
    setActive(on) { active = !!on; sync(); },
    latest: (machineId) => latest.get(machineId) || null,
    /** Desvia `key` en `delta` durante `holdMs` (rampa de subida y bajada incluidas). */
    injectFault(machineId, key, delta, holdMs = 25000) {
      faults.push({ machineId, key, delta, start: now(), rise: FAULT_RISE_MS, hold: holdMs, fall: FAULT_FALL_MS });
      tick();
    },
    /** Termina las fallas activas con su rampa de bajada (no corta en seco). */
    clearFaults(machineId) {
      const ts = now();
      for (const f of faults) {
        if (machineId && f.machineId !== machineId) continue;
        const elapsed = ts - f.start;
        if (elapsed < f.rise + f.hold) f.hold = Math.max(0, elapsed - f.rise);
      }
      tick();
    },
    hasFault: (machineId) => faults.some((f) => f.machineId === machineId),
    /** Un tick inmediato; los tests lo esperan en lugar de depender del reloj. */
    tickNow: tick,
  };
}
