import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeEqual } from './lib/safe-compare.js';
import { PROVIDER_NAMES, providerName, llmStatus, legacyNotices } from './llm/index.js';
import { parseAllowlist, parseMesaList } from './egress/destinations.js';

/* ============================================================
   Configuración del proceso: inventario único de variables de
   entorno, validación al arrancar y carga de los .env locales.
   De esta lista salen también .env.example, el bloque de entorno
   de docker-compose.yml y los ejemplos de k8s
   (npm run config:sync); la prueba de configuración falla si se
   desincronizan.
   ============================================================ */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const BACKEND_ENV_FILE = path.join(__dirname, '.env');
export const REFF_ENV_FILE = path.resolve(__dirname, '../../Elvi-Ra/Mesas/Rëff/.env');

/* ---------- formatos: devuelven el motivo del error o null ---------- */

export const MIN_SECRET_LENGTH = 32;

// Clave de firma del registro forense de Sentinel cuando no se define ninguna fuera de
// producción. Al estar en el repositorio no protege nada: producción la rechaza.
export const DEV_FORENSIC_SECRET = 'dev-only-secret-cambiar-en-produccion';

// Clave de los secretos de Pactvm guardados en la base (lib/data-seal.js) cuando no se
// define ninguna fuera de producción. Igual que la anterior, producción la rechaza.
export const DEV_DATA_KEY = '959c5fde3cd6efb643788abb7480d6b9396bdb748bd87edd5dd7e55ae6b63014';

const isSet = (v) => v !== undefined && v !== null && v !== '';
const listOf = (v) => v.split(',').map((s) => s.trim()).filter(Boolean);

const strongSecret = (v) => {
  if (/\s/.test(v)) return 'no puede contener espacios';
  return v.length >= MIN_SECRET_LENGTH ? null : `debe tener al menos ${MIN_SECRET_LENGTH} caracteres`;
};
const forensicSecret = (v) => strongSecret(v)
  ?? (safeEqual(v, DEV_FORENSIC_SECRET) ? 'es la clave de desarrollo del repositorio, hay que generar una propia' : null);
const hex64 = (v) => (/^[0-9a-fA-F]{64}$/.test(v) ? null : 'deben ser 64 caracteres hexadecimales (32 bytes)');
const dataKey = (v) => hex64(v)
  ?? (safeEqual(v.toLowerCase(), DEV_DATA_KEY) ? 'es la clave de desarrollo del repositorio, hay que generar una propia' : null);
const oneOf = (...allowed) => (v) => (allowed.includes(v) ? null : `valores admitidos: ${allowed.join(', ')}`);
const positiveInt = (v) => (/^\d+$/.test(v) && Number(v) > 0 ? null : 'debe ser un entero positivo');
const nonNegativeNumber = (v) => (/^\d+(\.\d+)?$/.test(v) ? null : 'debe ser un número mayor o igual que 0');
// Producción no admite respuestas simuladas: se tomarían por resultados reales.
const llmProvider = (v, env) => {
  const name = providerName(v);
  if (name === undefined) return `valores admitidos: ${PROVIDER_NAMES.join(', ')}`;
  return name === 'simulado' && env.NODE_ENV === 'production' ? 'el proveedor simulado no se admite en producción' : null;
};
const allowlist = (v) => parseAllowlist(v).problems[0] ?? null;
const mesaList = (v) => parseMesaList(v, []).problems[0] ?? null;
const tcpPort = (v) => (/^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 65535 ? null : 'debe ser un puerto entre 1 y 65535');
const mongoUri = (v) => (/^mongodb(\+srv)?:\/\//.test(v) ? null : 'debe empezar por mongodb:// o mongodb+srv://');
const pemBlock = (v) => (v.includes('-----BEGIN ') ? null : 'debe ser una clave en formato PEM');

function isHttpUrl(v) {
  try {
    return ['http:', 'https:'].includes(new URL(v).protocol);
  } catch {
    return false;
  }
}
const httpUrl = (v) => (isHttpUrl(v) ? null : 'debe ser una URL http(s)');
const httpUrlList = (v) => (listOf(v).every(isHttpUrl) ? null : 'deben ser URLs http(s) separadas por comas');
const countryList = (v) => (listOf(v).every((c) => /^[A-Za-z]{2}$/.test(c)) ? null : 'códigos de país de dos letras separados por comas');
const pathList = (v) => (listOf(v).every((p) => p.startsWith('/')) ? null : 'rutas que empiezan por / separadas por comas');

const GENERATE_HEX32 = 'Generar: openssl rand -hex 32';

/* ---------- inventario ----------
   Campos de cada variable:
     desc         qué controla (una línea)
     required     obligatoria en producción
     requiredIf   { test(env), text }: obligatoria solo en ese caso
     warnIf       { test(env), text }: aviso (nunca error) si falta en ese caso
     check        formato (valor, entorno), se aplica siempre que tenga valor
     def          valor por defecto que aplica el código (documentación)
     hint         ayuda extra para .env.example
     secret       va al Secret de k8s y nunca lleva valor en los ejemplos
     deploy       valor por defecto en docker-compose y en el ConfigMap
     fixed        valor fijo en docker-compose (no se toma del entorno)
     localOnly    solo ejecución local; no aparece en docker-compose ni en k8s
     reff         también la lee Rëff; objeto opcional { desc, def, hint } para su .env.example
*/

export const GROUPS = [
  { id: 'server', title: 'Servidor' },
  { id: 'mongo', title: 'Base de datos' },
  { id: 'keys', title: 'Claves de firma y cifrado' },
  { id: 'seed', title: 'Usuarios iniciales (solo primer arranque con la base vacía)' },
  { id: 'llm', title: 'IA' },
  { id: 'data', title: 'Fuentes de datos externas' },
  { id: 'egress', title: 'Salidas a la red (compuerta de Pactvm Viridi)' },
  { id: 'sentinel', title: 'Sentinel' },
  { id: 'systems', title: 'Systems y enlace Twin' },
  { id: 'cibe', title: 'CIBE Bunker (tokens firmados de Pactvm Viridi)' },
  { id: 'rack', title: 'Rack State (consenso entre racks)' },
  { id: 'reff', title: 'Rëff: correo de reuniones y tareas programadas' },
];

const seedVar = (name, user) => ({
  name, group: 'seed', secret: true,
  desc: `Contraseña inicial de ${user}`,
});
const reffSeedVar = (name, user) => ({
  name, group: 'seed', secret: true, reff: true,
  desc: `Contraseña inicial de ${user} en Rëff`,
});

export const VARS = [
  // Servidor
  { name: 'NODE_ENV', group: 'server', deploy: 'production', reff: true,
    desc: 'Entorno de ejecución; production activa la validación estricta de esta lista', def: 'development' },
  { name: 'PORT', group: 'server', fixed: '5173', deploy: '5173', check: tcpPort, def: '5173',
    reff: { desc: 'Puerto de Rëff en modo independiente (npm run dev:server); integrado no se usa', def: '3001' },
    desc: 'Puerto HTTP del proceso' },
  { name: 'HOST', group: 'server', deploy: '0.0.0.0', def: '0.0.0.0',
    desc: 'Interfaz de escucha' },
  { name: 'DATA_DIR', group: 'server', localOnly: true, def: 'app/backend/data',
    desc: 'Carpeta del estado local (JSON ligeros, marca de arranque)',
    hint: 'Para pruebas aisladas; en despliegue la ruta la fija el volumen de datos' },
  { name: 'CORS_ORIGIN', group: 'server', check: httpUrlList, reff: true,
    desc: 'Orígenes cruzados permitidos, separados por comas',
    def: 'ninguno en producción (la interfaz se sirve desde el mismo dominio)' },
  { name: 'SHUTDOWN_GRACE_MS', group: 'server', check: positiveInt, def: '10000 en k8s, 1500 fuera',
    desc: 'Espera a peticiones en vuelo durante el apagado ordenado (ms)' },
  { name: 'SHUTDOWN_HARD_MS', group: 'server', check: positiveInt, def: '25000',
    desc: 'Tope duro del apagado ordenado (ms)' },

  // Base de datos
  { name: 'MONGO_URI', group: 'mongo', required: true, check: mongoUri, deploy: 'mongodb://mongo:27017/elvira', reff: true,
    desc: 'Cadena de conexión a MongoDB',
    hint: 'Con docker compose se usa el servicio mongo; fuera de Docker, por ejemplo mongodb://127.0.0.1:27017/elvira' },

  // Claves de firma y cifrado
  { name: 'JWT_SECRET', group: 'keys', required: true, secret: true, check: strongSecret, reff: true,
    desc: 'Firma de las sesiones de Rëff', hint: GENERATE_HEX32 },
  { name: 'SENTINEL_FORENSIC_SECRET', group: 'keys', required: true, secret: true, check: forensicSecret,
    desc: 'Firma del registro forense de Sentinel, independiente de JWT_SECRET',
    hint: `Mínimo ${MIN_SECRET_LENGTH} bytes. ${GENERATE_HEX32}`
      + ` o, sin openssl, node -p "require('crypto').randomBytes(32).toString('hex')". `
      + 'Fuera de producción, si falta, se firma con una clave de desarrollo que producción rechaza. '
      + 'Cambiarla en un sistema con registro existente exige volver a sellarlo (Sentinel, Re-sellar cadena)' },
  { name: 'FL_EXPEDIENTE_ENC_KEY', group: 'keys', required: true, secret: true, check: hex64,
    desc: 'Cifrado del Expediente Fiscal y Jurídico',
    hint: `${GENERATE_HEX32}. Perderla deja ilegibles los documentos ya cifrados` },
  { name: 'PACTVM_DATA_KEY', group: 'keys', required: true, secret: true, check: dataKey,
    desc: 'Cifrado y firma de los secretos de Pactvm Viridi guardados en la base (claves CIBE y códigos de acceso)',
    hint: `${GENERATE_HEX32}. Fuera de producción, si falta, se usa una clave de desarrollo que producción rechaza. `
      + 'Perderla deja ilegibles las claves CIBE ya cifradas; mientras dos instalaciones compartan base, debe ser la misma en ambas' },

  // Usuarios iniciales
  seedVar('SEED_NOUR_PASSWORD', 'Nour'),
  seedVar('SEED_MARC_PASSWORD', 'Marc'),
  seedVar('SEED_GONZALO_PASSWORD', 'Gonzalo'),
  seedVar('SEED_AMIR_PASSWORD', 'Amir'),
  seedVar('SEED_RAY_PASSWORD', 'Ray'),
  seedVar('SEED_CELIA_PASSWORD', 'Celia'),
  seedVar('SEED_MAITANE_PASSWORD', 'Maitane'),
  seedVar('SEED_ARKAITZ_PASSWORD', 'Arkaitz'),
  seedVar('SEED_OSCAR_PASSWORD', 'Oscar'),
  reffSeedVar('REFF_SEED_MARC_PASSWORD', 'Marc'),
  reffSeedVar('REFF_SEED_NOUR_PASSWORD', 'Nour'),
  reffSeedVar('REFF_SEED_AMIR_PASSWORD', 'Amir'),
  reffSeedVar('REFF_SEED_GONZALO_PASSWORD', 'Gonzalo'),

  // IA (módulo llm/): el mismo para el backend y Rëff
  { name: 'LLM_PROVIDER', group: 'llm', check: llmProvider, reff: true,
    desc: `Proveedor de IA: ${PROVIDER_NAMES.join(', ')}. local es el servidor de modelos propio (Ollama); `
      + 'simulado da respuestas de prueba sin red y producción no lo admite; externo es el proveedor externo',
    def: 'sin IA (o externo si hay LLM_API_KEY)',
    warnIf: { test: (env) => !llmStatus(env).provider, text: 'sin ella, las funciones de IA no responden' } },
  { name: 'LLM_MODEL', group: 'llm', reff: true,
    desc: 'Modelo de IA', def: 'el del proveedor (local: llama3:70b)' },
  { name: 'LLM_URL', group: 'llm', check: httpUrl, reff: true,
    desc: 'Dirección del servicio de IA', def: 'la del proveedor (local: http://ollama:11434)' },
  { name: 'LLM_API_KEY', group: 'llm', secret: true, reff: true,
    desc: 'Clave del proveedor de IA externo',
    warnIf: {
      test: (env) => { const s = llmStatus(env); return s.provider === 'externo' && !s.available; },
      text: 'sin ella, el proveedor externo no responde',
    } },
  { name: 'LLM_TIMEOUT_MS', group: 'llm', check: positiveInt, def: '30000',
    desc: 'Tiempo máximo de cada llamada a la IA (ms); la auditoría Herzog y la vigilancia de Rëff fijan el suyo' },
  { name: 'LLM_PRICE_INPUT_PER_M', group: 'llm', check: nonNegativeNumber,
    desc: 'Precio en USD por millón de tokens de entrada, para la contabilidad de consumo',
    def: 'la tarifa del proveedor y modelo (0 en local y simulado)' },
  { name: 'LLM_PRICE_OUTPUT_PER_M', group: 'llm', check: nonNegativeNumber,
    desc: 'Precio en USD por millón de tokens de salida, para la contabilidad de consumo',
    def: 'la tarifa del proveedor y modelo (0 en local y simulado)' },

  // Fuentes de datos externas
  { name: 'ESIOS_API_KEY', group: 'data', secret: true,
    desc: 'Token personal de ESIOS (REE) para S-NFI U2',
    hint: 'Sin token, los datos públicos de REE siguen funcionando' },
  { name: 'GRID_AUTOSTART', group: 'data', check: oneOf('0', '1'), def: '1',
    desc: 'Arranca los workers de Grid Interlink al iniciar (0 = no)' },
  { name: 'GRID_WORKER_MAX_OLD_MB', group: 'data', check: positiveInt, def: '96',
    desc: 'Techo de memoria de cada worker de Grid Interlink (MB)' },
  ...['ES', 'PT', 'FR', 'MA'].map((cc) => ({
    name: `GRID_${cc}_URL`, group: 'data', check: httpUrl,
    desc: `Endpoint en vivo del operador de red de ${cc}`, def: 'modo simulado',
  })),

  // Salidas a la red
  { name: 'EGRESS_ALLOWLIST', group: 'egress', check: allowlist,
    desc: 'Destinos de salida permitidos por mesa, con la forma mesa=destino,destino;mesa=destino. Un destino es una máquina o una URL http(s); ninguna deja a la mesa sin destinos fijos. Para cada mesa que nombra, sustituye a los destinos de serie. Los destinos de la IA, SYSTEMS_URL, RACK_PEERS, GRID_<CC>_URL y SMTP_HOST salen de sus propias variables',
    def: 'los destinos de serie de cada mesa',
    hint: 'Ejemplo: snfiu2=apidatos.ree.es,api.esios.ree.es;fl=www.boe.es. La lista efectiva se ve y se exporta en Pactvm Viridi, Salidas a la red' },
  { name: 'EGRESS_EXTERNAL_LLM_MESAS', group: 'egress', check: mesaList,
    desc: 'Mesas que pueden enviar datos a un proveedor de IA externo, separadas por comas; ninguna las bloquea todas. La IA local no cuenta como tercero y no se filtra',
    def: 'elvira, ophs, reff' },
  { name: 'EGRESS_PUBLIC_WEB_MESAS', group: 'egress', check: mesaList,
    desc: 'Mesas que pueden descargar páginas públicas que cita un usuario (auditoría Herzog de Rëff); nunca redes privadas ni locales. ninguna lo desactiva',
    def: 'reff' },
  { name: 'EGRESS_TIMEOUT_MS', group: 'egress', check: positiveInt, def: '20000',
    desc: 'Tiempo máximo de cada salida a la red (ms) cuando la llamada no fija el suyo' },

  // Sentinel
  { name: 'SENTINEL_RISK_COUNTRIES', group: 'sentinel', check: countryList,
    desc: 'Países de riesgo elevado para el scoring (ISO-2, separados por comas)', def: 'ninguno' },
  { name: 'SENTINEL_EXTRA_SENSITIVE_PATHS', group: 'sentinel', check: pathList,
    desc: 'Prefijos de ruta extra con límite de peticiones estricto', def: 'ninguno' },

  // Systems y enlace Twin
  { name: 'SYSTEMS_URL', group: 'systems', check: httpUrl,
    desc: 'URL del ØPHS real (puerto cerrado)', def: 'simulación local' },
  { name: 'SYSTEMS_TOKEN', group: 'systems', secret: true,
    desc: 'Token Bearer para SYSTEMS_URL' },
  { name: 'SYSTEMS_TIMEOUT_MS', group: 'systems', check: positiveInt, def: '15000',
    desc: 'Tiempo máximo de cada llamada a SYSTEMS_URL (ms)' },
  { name: 'ENABLE_TWIN_PORT', group: 'systems', check: oneOf('true', 'false'), deploy: 'false', def: 'false',
    desc: 'Activa el listener Twin en 127.0.0.1' },
  { name: 'TWIN_PORT', group: 'systems', fixed: '5174', check: tcpPort, def: '5174',
    desc: 'Puerto del listener Twin' },
  { name: 'TWIN_TOKEN', group: 'systems', secret: true, check: strongSecret,
    requiredIf: { test: (env) => env.ENABLE_TWIN_PORT === 'true', text: 'ENABLE_TWIN_PORT=true' },
    desc: 'Token del listener Twin', hint: GENERATE_HEX32 },

  // CIBE
  { name: 'CIBE_MODE', group: 'cibe', check: oneOf('off', 'auto', 'strict'), deploy: 'auto', def: 'auto',
    desc: 'off | auto (sesión de Admin con token automático trazado) | strict (cabecera X-CIBE-Token obligatoria)' },
  { name: 'CIBE_TOKEN_TTL_S', group: 'cibe', check: positiveInt, def: '120',
    desc: 'Vida de cada token CIBE en segundos (de 30 a 3600)' },
  { name: 'CIBE_PRIVATE_KEY_PEM', group: 'cibe', secret: true, check: pemBlock,
    requiredIf: { test: (env) => isSet(env.CIBE_PUBLIC_KEY_PEM), text: 'se define CIBE_PUBLIC_KEY_PEM' },
    desc: 'Clave privada Ed25519 (PEM)', def: 'par generado y guardado en Mongo' },
  { name: 'CIBE_PUBLIC_KEY_PEM', group: 'cibe', secret: true, check: pemBlock,
    requiredIf: { test: (env) => isSet(env.CIBE_PRIVATE_KEY_PEM), text: 'se define CIBE_PRIVATE_KEY_PEM' },
    desc: 'Clave pública Ed25519 (PEM), pareja de la privada' },

  // Rack State
  { name: 'RACK_ID', group: 'rack',
    desc: 'Identificador de este rack', def: 'nombre de la máquina' },
  { name: 'RACK_PEERS', group: 'rack', check: httpUrlList, deploy: '',
    desc: 'URLs de los otros racks, separadas por comas', def: 'rack único (quórum 1)' },
  { name: 'RACK_SHARED_KEY', group: 'rack', secret: true, check: strongSecret,
    requiredIf: { test: (env) => isSet(env.RACK_PEERS), text: 'se define RACK_PEERS' },
    desc: 'Firma de los mensajes entre racks', hint: GENERATE_HEX32 },
  { name: 'RACK_HEARTBEAT_MS', group: 'rack', check: positiveInt, def: '500',
    desc: 'Latido del líder (ms)' },
  { name: 'RACK_ELECTION_MS_MIN', group: 'rack', check: positiveInt, def: '1500',
    desc: 'Espera mínima antes de convocar elección (ms)' },

  // Rëff
  { name: 'SMTP_HOST', group: 'reff', reff: true,
    desc: 'Servidor SMTP de los avisos de reuniones', def: 'modo simulado (solo registro, no se envía nada)' },
  { name: 'SMTP_PORT', group: 'reff', check: tcpPort, def: '587', reff: true,
    desc: 'Puerto SMTP' },
  { name: 'SMTP_SECURE', group: 'reff', check: oneOf('true', 'false'), def: 'false', reff: true,
    desc: 'TLS directo (true) o STARTTLS (false)' },
  { name: 'SMTP_USER', group: 'reff', reff: true,
    warnIf: { test: (env) => isSet(env.SMTP_HOST), text: 'sin ella el correo sigue en modo simulado' },
    desc: 'Usuario SMTP' },
  { name: 'SMTP_PASS', group: 'reff', secret: true, reff: true,
    warnIf: { test: (env) => isSet(env.SMTP_HOST), text: 'sin ella el correo sigue en modo simulado' },
    desc: 'Contraseña SMTP' },
  { name: 'MAIL_FROM', group: 'reff', reff: true,
    desc: 'Remitente de los avisos', def: 'SMTP_USER' },
  { name: 'MEETING_REMINDER_CRON', group: 'reff', reff: true,
    desc: 'Programación del recordatorio de reuniones (formato cron)', def: 'cada 15 minutos' },
  { name: 'WATCH_CRON_SCHEDULE', group: 'reff', reff: true,
    desc: 'Programación de la vigilancia de empresas (formato cron)', def: 'cada 6 horas' },
];

// Las inyecta la plataforma; no se configuran.
export const PLATFORM_VARS = [
  { name: 'KUBERNETES_SERVICE_HOST', desc: 'presente solo dentro de un pod de Kubernetes' },
  { name: 'HOSTNAME', desc: 'nombre del pod o de la máquina' },
];

// Solo para herramientas de línea de comandos; nunca en un .env.
export const TOOL_VARS = [
  { name: 'ENV_VAULT_KEY', desc: 'clave de descifrado de scripts/env-vault.js; vive en el gestor de secretos de la plataforma' },
  { name: 'TEST_MONGO_DIR', desc: 'carpeta con el binario y los datos del mongod de pruebas de scripts/test-mongo.js; por defecto ~/mongo-test' },
  { name: 'TEST_MONGOD_BIN', desc: 'ruta del mongod que usa scripts/test-mongo.js si no está en TEST_MONGO_DIR' },
];

// Variables de build del cliente de Rëff: van en el entorno de npm run build, no en un .env.
export const BUILD_VARS = [
  { name: 'VITE_BASE_PATH', desc: 'root compila el cliente con base /; sin definir, /reff/app/' },
  { name: 'VITE_API_URL', desc: 'URL de la API para el cliente en modo independiente' },
];

export const OBSOLETE_VARS = [
  { name: 'FOUNDRY_INGRESS_PORT', reason: 'el pipeline de ingesta Lab está retirado' },
  { name: 'SERPAPI_KEY', reason: 'ningún módulo la lee' },
  { name: 'DB_PATH', reason: 'Rëff ya no usa almacenamiento en archivo; todo está en MongoDB' },
  { name: 'OLLAMA_BASE_URL', reason: 'el nombre vigente es LLM_URL' },
  { name: 'ESIOS_TOKEN', reason: 'alias heredado; usar ESIOS_API_KEY' },
];

/* ---------- validación ---------- */

const PLACEHOLDER = 'CAMBIAR';

export class ConfigError extends Error {
  constructor(problems) {
    super([
      `Configuración incompleta o inválida para producción (${problems.length}):`,
      ...problems.map((p) => `  - ${p}`),
      'Referencia: app/backend/.env.example',
    ].join('\n'));
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/**
 * Revisa el entorno contra el inventario. Los mensajes nombran la variable y
 * el motivo, nunca su valor. En producción los fallos son errores; fuera de
 * producción, avisos.
 */
export function validateConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const problems = [];
  const notices = [];

  for (const v of VARS) {
    const value = env[v.name];
    if (!isSet(value)) {
      if (v.required) problems.push(`${v.name}: obligatoria en producción`);
      else if (v.requiredIf?.test(env)) problems.push(`${v.name}: obligatoria si ${v.requiredIf.text}`);
      else if (v.warnIf?.test(env)) notices.push(`${v.name}: ${v.warnIf.text}`);
      continue;
    }
    if (value.includes(PLACEHOLDER)) {
      problems.push(`${v.name}: conserva el valor de plantilla, hay que sustituirlo`);
      continue;
    }
    const reason = v.check?.(value, env);
    if (reason) problems.push(`${v.name}: ${reason}`);
  }

  for (const o of OBSOLETE_VARS) {
    if (isSet(env[o.name])) notices.push(`${o.name}: obsoleta, se ignora (${o.reason})`);
  }
  // Nombres antiguos de la IA: siguen funcionando mientras se renombran, por eso solo avisan.
  notices.push(...legacyNotices(env));

  return production
    ? { production, errors: problems, warnings: notices }
    : { production, errors: [], warnings: [...problems, ...notices] };
}

/** Falla con un único ConfigError que lista todos los problemas; los avisos solo se registran. */
export function assertConfig(env = process.env, logger = console) {
  const result = validateConfig(env);
  if (result.errors.length) throw new ConfigError(result.errors);
  if (result.warnings.length) {
    logger.warn([
      `[config] ${result.warnings.length} aviso(s) de configuración${result.production ? '' : ' (desarrollo: no bloquean el arranque)'}:`,
      ...result.warnings.map((w) => `  - ${w}`),
    ].join('\n'));
  }
  return result;
}

/* ---------- .env locales ---------- */

export function parseEnvFile(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const [, key, raw] = m;
    const quoted = raw.match(/^(["'])(.*)\1$/);
    out[key] = quoted ? quoted[2] : raw;
  }
  return out;
}

/** Copia las variables del archivo al entorno sin pisar las que ya tienen valor. Devuelve cuántas aplicó. */
export function loadEnvFile(file, env = process.env) {
  if (!fs.existsSync(file)) return 0;
  let applied = 0;
  for (const [key, value] of Object.entries(parseEnvFile(fs.readFileSync(file, 'utf8')))) {
    if (isSet(env[key])) continue;
    env[key] = value;
    applied += 1;
  }
  return applied;
}

/**
 * app/backend/.env sirve para ejecutar fuera de Docker (npm start ya lo pasa
 * con --env-file; node server.js a secas, no). El .env de Rëff es solo de
 * desarrollo: en producción todo llega por variables de entorno. Lo ya
 * definido en el entorno manda, y después app/backend/.env sobre el de Rëff.
 */
export function loadLocalEnvFiles(env = process.env) {
  loadEnvFile(BACKEND_ENV_FILE, env);
  if (env.NODE_ENV !== 'production') loadEnvFile(REFF_ENV_FILE, env);
}
