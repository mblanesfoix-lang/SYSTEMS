/**
 * Calculos puros de Herzog LaW: vencimientos, preparacion por marco, categoria
 * de equipo por zona ATEX y estimacion orientativa de CBAM. Sin Mongo ni Express
 * para poder probarlos sin infraestructura.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export const EXPIRY_WARN_DAYS = 90;
export const EXPIRY_CRITICAL_DAYS = 30;

/** Orden de gravedad de un aviso de vencimiento; los estados sin aviso no tienen rango. */
export const ALERT_RANK = { proximo: 1, critico: 2, vencido: 3 };

/** Fecha 'YYYY-MM-DD' real (rechaza 2026-02-31). Devuelve el mismo texto o null. */
export function parseDateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return value;
}

function utcDay(dateOnly) {
  const [y, m, d] = dateOnly.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

/** Estado de un vencimiento respecto a hoy (UTC): sin_fecha, ok, proximo, critico o vencido. */
export function expiryState(expiresAt, now = new Date()) {
  if (!expiresAt) return { state: 'sin_fecha', days: null };
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const days = Math.round((utcDay(expiresAt) - today) / DAY_MS);
  if (days < 0) return { state: 'vencido', days };
  if (days <= EXPIRY_CRITICAL_DAYS) return { state: 'critico', days };
  if (days <= EXPIRY_WARN_DAYS) return { state: 'proximo', days };
  return { state: 'ok', days };
}

/** Requisitos cumplidos sobre el total, con el porcentaje redondeado. */
export function readiness(requirements = []) {
  const total = requirements.length;
  const done = requirements.filter((r) => r.done).length;
  return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
}

/* Categoria de equipo exigida por zona (Directiva 2014/34/UE): 1 en zona 0/20, 2 en 1/21, 3 en 2/22. */
const ZONE_CATEGORY = {
  polvo: { 20: '1D', 21: '2D', 22: '3D' },
  gas: { 0: '1G', 1: '2G', 2: '3G' },
};

export function zoneCategory(kind, zone) {
  if (!Object.hasOwn(ZONE_CATEGORY, kind)) return null;
  return Object.hasOwn(ZONE_CATEGORY[kind], zone) ? ZONE_CATEGORY[kind][zone] : null;
}

export function validZonesFor(kind) {
  return Object.hasOwn(ZONE_CATEGORY, kind) ? Object.keys(ZONE_CATEGORY[kind]) : [];
}

/* ---- CBAM: estimacion orientativa ---- */

const CBAM_FIELDS = {
  tonnes: { min: 0, max: 1e9, required: true },
  embeddedPerTonne: { min: 0, max: 100, required: true },
  freeAllocationPerTonne: { min: 0, max: 100, default: 0 },
  certificatePrice: { min: 0, max: 1000, required: true },
  originCarbonPrice: { min: 0, max: 1000, default: 0 },
  fuelSharePct: { min: 0, max: 100, default: 0 },
  substitutionPct: { min: 0, max: 100, default: 0 },
};

/** Valida y completa la entrada del simulador. Devuelve { value } o { error }. */
export function parseCbamInput(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const value = {};
  for (const [key, rule] of Object.entries(CBAM_FIELDS)) {
    const given = src[key];
    if (given === undefined || given === null || given === '') {
      if (rule.required) return { error: `${key} requerido` };
      value[key] = rule.default;
      continue;
    }
    if (typeof given !== 'number' && typeof given !== 'string') return { error: `${key} no es un numero` };
    const n = Number(given);
    if (!Number.isFinite(n) || n < rule.min || n > rule.max) return { error: `${key} fuera de rango (${rule.min} a ${rule.max})` };
    value[key] = n;
  }
  return { value };
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Coste CBAM orientativo: (emisiones incorporadas - asignacion gratuita) x toneladas,
 * al precio del certificado menos el precio del carbono ya pagado en origen, sin bajar
 * de cero. El escenario con biomasa quita de las emisiones la parte debida al
 * combustible que se sustituye; solo vale si esa biomasa cumple los criterios de
 * sostenibilidad de la Directiva (UE) 2018/2001.
 */
export function estimateCbam(input) {
  const {
    tonnes, embeddedPerTonne, freeAllocationPerTonne, certificatePrice, originCarbonPrice, fuelSharePct, substitutionPct,
  } = input;
  const netPrice = Math.max(0, certificatePrice - originCarbonPrice);
  const side = (perTonne) => {
    const chargeable = Math.max(0, perTonne - freeAllocationPerTonne) * tonnes;
    return {
      embeddedPerTonne: round2(perTonne),
      embeddedEmissions: round2(perTonne * tonnes),
      chargeableEmissions: round2(chargeable),
      cost: round2(chargeable * netPrice),
    };
  };
  const baseline = side(embeddedPerTonne);
  const withBiomass = side(embeddedPerTonne * (1 - (fuelSharePct / 100) * (substitutionPct / 100)));
  return {
    netPrice: round2(netPrice),
    baseline,
    withBiomass,
    saving: round2(baseline.cost - withBiomass.cost),
    emissionsReductionPct: baseline.embeddedEmissions > 0
      ? round2((1 - withBiomass.embeddedEmissions / baseline.embeddedEmissions) * 100)
      : 0,
  };
}
