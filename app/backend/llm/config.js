import localProvider from './providers/local.js';
import simulatedProvider from './providers/simulated.js';
import externalProvider from './providers/external.js';

/**
 * Configuración de la IA a partir del entorno: proveedor, modelo, dirección,
 * clave, tiempo máximo y tarifa. Separada de la llamada para que la compuerta
 * de salida (egress/) conozca el destino de la IA sin depender de este módulo
 * entero.
 *
 * LLM_PROVIDER elige el proveedor:
 *   local     servidor de modelos propio (Ollama), el de los servidores de S-NFI
 *   simulado  respuestas deterministas sin red, para pruebas y equipos sin IA;
 *             producción no lo admite
 *   externo   proveedor externo, aislado en providers/external.js
 * LLM_MODEL, LLM_URL, LLM_API_KEY, LLM_TIMEOUT_MS y LLM_PRICE_* valen para
 * cualquiera de ellos. Se leen en cada llamada: server.js carga los .env locales
 * después de importar este módulo.
 */

const PROVIDERS = { local: localProvider, simulado: simulatedProvider, externo: externalProvider };
export const PROVIDER_NAMES = Object.keys(PROVIDERS);

const DEFAULT_TIMEOUT_MS = 30000;

// Valores anteriores de LLM_PROVIDER.
const PROVIDER_ALIASES = {
  ollama: 'local',
  ...Object.fromEntries(externalProvider.legacy.providerNames.map((n) => [n, 'externo'])),
};

/** Variables renombradas: se leen mientras falte la nueva, solo con su proveedor, y el arranque avisa. */
export const RENAMED_VARS = [
  { name: 'OLLAMA_URL', replacement: 'LLM_URL', provider: 'local' },
  { name: 'OLLAMA_MODEL', replacement: 'LLM_MODEL', provider: 'local' },
  ...externalProvider.legacy.env.map((v) => ({ ...v, provider: 'externo' })),
];

const isSet = (v) => typeof v === 'string' && v.trim() !== '';
const positiveNumber = (v) => (isSet(v) && Number(v) > 0 ? Number(v) : null);
const nonNegativeNumber = (v) => (isSet(v) && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null);

function legacyValue(env, replacement, provider) {
  const old = RENAMED_VARS.find((r) => r.replacement === replacement && r.provider === provider && isSet(env[r.name]));
  return old ? env[old.name] : '';
}

/** Proveedor que corresponde a un valor de LLM_PROVIDER: su nombre, null si está vacío o undefined si no es válido. */
export function providerName(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v) return null;
  return PROVIDERS[v] ? v : PROVIDER_ALIASES[v];
}

function resolvePricing(env, provider, model) {
  const base = provider.pricing(model);
  const input = nonNegativeNumber(env.LLM_PRICE_INPUT_PER_M);
  const output = nonNegativeNumber(env.LLM_PRICE_OUTPUT_PER_M);
  if (input === null && output === null) return base;
  return {
    inputPerM: input ?? base?.inputPerM ?? 0,
    outputPerM: output ?? base?.outputPerM ?? 0,
    perWebSearch: base?.perWebSearch ?? 0,
  };
}

/** Configuración efectiva de la IA. Incluye la clave: no sale de este módulo y sus proveedores. */
export function resolveLlmConfig(env = process.env) {
  let name = providerName(env.LLM_PROVIDER);
  if (name === undefined) {
    return { name: null, reason: `IA no configurada: LLM_PROVIDER no es válido (admitidos: ${PROVIDER_NAMES.join(', ')})` };
  }
  // Antes el proveedor externo era el predeterminado: con su clave y sin LLM_PROVIDER se sigue usando.
  if (!name && isSet(env.LLM_API_KEY || legacyValue(env, 'LLM_API_KEY', 'externo'))) name = 'externo';
  if (!name) return { name: null, reason: `IA no configurada: falta LLM_PROVIDER (${PROVIDER_NAMES.join(', ')})` };

  const provider = PROVIDERS[name];
  const model = (env.LLM_MODEL || legacyValue(env, 'LLM_MODEL', name) || provider.defaults.model).trim();
  const apiKey = (env.LLM_API_KEY || legacyValue(env, 'LLM_API_KEY', name) || '').trim();
  return {
    name,
    provider,
    model,
    url: (env.LLM_URL || legacyValue(env, 'LLM_URL', name) || provider.defaults.url).trim().replace(/\/+$/, ''),
    apiKey: !provider.isUsableKey || provider.isUsableKey(apiKey) ? apiKey : '',
    timeoutMs: positiveNumber(env.LLM_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS,
    pricing: resolvePricing(env, provider, model),
  };
}

export function unavailableReason(cfg) {
  if (!cfg.name) return cfg.reason;
  if (cfg.provider.requiresKey && !cfg.apiKey) return `IA no configurada: falta LLM_API_KEY para el proveedor ${cfg.name}`;
  return null;
}

/** Estado de la IA para el arranque, T'Controler y Rëff. Nunca incluye la clave. */
export function llmStatus(env = process.env) {
  const cfg = resolveLlmConfig(env);
  const reason = unavailableReason(cfg);
  return {
    available: !reason,
    provider: cfg.name,
    model: cfg.name ? cfg.model : null,
    webSearch: !reason && cfg.provider.supportsWebSearch,
    pricing: cfg.name ? cfg.pricing : null,
    reason,
  };
}

/** Avisos por nombres antiguos en uso (variables o valores), sin mostrar valores. */
export function legacyNotices(env = process.env) {
  const notices = [];
  const active = resolveLlmConfig(env).name;
  const raw = String(env.LLM_PROVIDER ?? '').trim().toLowerCase();
  if (PROVIDER_ALIASES[raw]) notices.push(`LLM_PROVIDER: valor antiguo, equivale a ${PROVIDER_ALIASES[raw]}; cambiarlo`);
  if (!raw && active) notices.push(`LLM_PROVIDER: sin definir; se usa ${active} porque hay clave de ese proveedor; definirla`);
  for (const r of RENAMED_VARS) {
    if (!isSet(env[r.name])) continue;
    const used = r.provider === active && !isSet(env[r.replacement]);
    notices.push(`${r.name}: nombre antiguo de ${r.replacement} (proveedor ${r.provider}); ${used ? 'se lee mientras tanto, renombrarla' : 'se ignora'}`);
  }
  return notices;
}
