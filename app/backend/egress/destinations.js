import { resolveLlmConfig } from '../llm/config.js';

/**
 * Lista blanca de destinos de salida de Pactvm Viridi, por mesa. Se calcula del
 * entorno en cada consulta (server.js carga los .env después de importar los
 * módulos) y es exportable: la política de red de los racks sale de ella.
 *
 * Categorías:
 *   tercero  servicio de otra organización; es lo que Pactvm Viridi filtra
 *   propio   infraestructura de S-NFI (racks, ØPHS, IA local, base de datos)
 * Vía:
 *   compuerta    la llamada pasa por egress/ y queda registrada
 *   controlador  conexión del controlador de la base de datos; no es HTTP y
 *                no pasa por la compuerta, pero la política de red la necesita
 */

export const ANY_MESA = '*';
export const DEFAULT_EXTERNAL_LLM_MESAS = ['elvira', 'ophs', 'reff'];
export const DEFAULT_PUBLIC_WEB_MESAS = ['reff'];
export const DEFAULT_TIMEOUT_MS = 20000;
export const DEFAULT_SMTP_PORT = 587;
const NONE = 'ninguna';
const MESA_RE = /^[a-z][a-z0-9_]*$/;
const DEFAULT_PORTS = { http: 80, https: 443 };

// De serie, una entrada por servicio. EGRESS_ALLOWLIST sustituye los de cada mesa que nombre.
export const BUILTIN_DESTINATIONS = [
  { id: 'ree-datos', label: 'REE · datos del sistema eléctrico', url: 'https://apidatos.ree.es', mesas: ['snfiu2'] },
  { id: 'ree-esios', label: 'REE · ESIOS', url: 'https://api.esios.ree.es', mesas: ['snfiu2'] },
  { id: 'cnmc', label: 'CNMC · registro de operadores', url: 'https://numeracionyoperadores.cnmc.es', mesas: ['elvira'] },
  { id: 'boe', label: 'BOE · datos abiertos del BOE y el BORME', url: 'https://www.boe.es', mesas: ['fl'] },
  { id: 'divisas', label: 'Frankfurter · cambio USD/EUR de T\'Controler', url: 'https://api.frankfurter.app', mesas: ['elvira'] },
];

const isSet = (v) => typeof v === 'string' && v.trim() !== '';

export const normalizeHost = (host) => String(host).toLowerCase().replace(/\.$/, '');

/** Protocolo (sin ':'), máquina y puerto de una dirección; sin esquema se toma `defaultProtocol`. */
export function endpointOf(value, defaultProtocol = 'https') {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `${defaultProtocol}://${raw}`);
  } catch {
    return null;
  }
  const protocol = url.protocol.replace(/:$/, '');
  const port = url.port ? Number(url.port) : DEFAULT_PORTS[protocol];
  if (!url.hostname || !port) return null;
  return { protocol, host: normalizeHost(url.hostname), port };
}

/** EGRESS_ALLOWLIST: "mesa=destino,destino;mesa=..." (destino: máquina o URL http(s); vacío o "ninguna" deja la mesa sin destinos fijos). */
export function parseAllowlist(value) {
  const entries = new Map();
  const problems = [];
  if (!isSet(value)) return { entries, problems };
  for (const part of value.split(';')) {
    if (!part.trim()) continue;
    const eq = part.indexOf('=');
    if (eq < 0) {
      problems.push(`"${part.trim()}" no tiene la forma mesa=destinos`);
      continue;
    }
    const mesa = part.slice(0, eq).trim().toLowerCase();
    if (!MESA_RE.test(mesa)) {
      problems.push(`"${mesa}" no es un nombre de mesa válido`);
      continue;
    }
    const endpoints = entries.get(mesa) || [];
    for (const item of part.slice(eq + 1).split(',').map((s) => s.trim()).filter(Boolean)) {
      if (item.toLowerCase() === NONE) continue;
      const ep = endpointOf(item);
      if (!ep || !DEFAULT_PORTS[ep.protocol]) problems.push(`"${item}" no es un destino http(s) válido`);
      else endpoints.push(ep);
    }
    entries.set(mesa, endpoints);
  }
  return { entries, problems };
}

/** Lista de mesas separadas por comas; sin valor, `defaults`; "ninguna", ninguna. */
export function parseMesaList(value, defaults) {
  if (!isSet(value)) return { mesas: [...defaults], problems: [] };
  const items = value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (items.length === 1 && items[0] === NONE) return { mesas: [], problems: [] };
  return {
    mesas: items.filter((m) => MESA_RE.test(m)),
    problems: items.filter((m) => !MESA_RE.test(m)).map((m) => `"${m}" no es un nombre de mesa válido`),
  };
}

/* Máquinas de una cadena de conexión de MongoDB, sin credenciales. Con +srv el puerto lo da el DNS. */
function mongoEndpoints(uri) {
  const m = String(uri ?? '').match(/^(mongodb(?:\+srv)?):\/\/(?:[^@/]*@)?([^/?]+)/);
  if (!m) return [];
  const srv = m[1] === 'mongodb+srv';
  return m[2].split(',').map((item) => {
    const hp = item.match(/^\[([^\]]+)\](?::(\d+))?$/) || item.match(/^([^:]+)(?::(\d+))?$/);
    if (!hp) return null;
    const host = item.startsWith('[') ? `[${hp[1].toLowerCase()}]` : normalizeHost(hp[1]);
    return { protocol: m[1], host, port: srv ? null : Number(hp[2]) || 27017 };
  }).filter(Boolean);
}

const originOf = (d) => (d.host === '*' ? `${d.protocol}://*` : `${d.protocol}://${d.host}${d.port ? `:${d.port}` : ''}`);

function destination(fields) {
  const d = { via: 'compuerta', ...fields };
  return { ...d, origin: originOf(d) };
}

/** Política efectiva: destinos con sus mesas, mesas con IA externa y con web pública, y tiempo máximo. */
export function egressPolicy(env = process.env) {
  const override = parseAllowlist(env.EGRESS_ALLOWLIST).entries;
  const externalLlmMesas = parseMesaList(env.EGRESS_EXTERNAL_LLM_MESAS, DEFAULT_EXTERNAL_LLM_MESAS).mesas;
  const publicWebMesas = parseMesaList(env.EGRESS_PUBLIC_WEB_MESAS, DEFAULT_PUBLIC_WEB_MESAS).mesas;
  const timeout = Number(env.EGRESS_TIMEOUT_MS);
  const destinations = [];

  for (const b of BUILTIN_DESTINATIONS) {
    const mesas = b.mesas.filter((m) => !override.has(m));
    if (mesas.length) destinations.push(destination({ id: b.id, label: b.label, category: 'tercero', ...endpointOf(b.url), mesas, source: 'serie' }));
  }
  for (const [mesa, endpoints] of override) {
    for (const ep of endpoints) {
      destinations.push(destination({ id: `${mesa}:${ep.host}:${ep.port}`, label: 'Destino configurado', category: 'tercero', ...ep, mesas: [mesa], source: 'EGRESS_ALLOWLIST' }));
    }
  }

  // La IA local no es un tercero: cualquier mesa con IA puede usarla. La externa, solo las autorizadas.
  const llm = resolveLlmConfig(env);
  const llmEndpoint = (llm.name === 'externo' || llm.name === 'local') && endpointOf(llm.url, 'http');
  if (llmEndpoint) {
    const external = llm.name === 'externo';
    destinations.push(destination({
      id: external ? 'ia-externa' : 'ia-local',
      label: external ? 'Proveedor de IA externo' : 'Servidor de IA propio',
      category: external ? 'tercero' : 'propio',
      ...llmEndpoint,
      mesas: external ? externalLlmMesas : [ANY_MESA],
      source: 'LLM_URL',
    }));
  }

  const systems = endpointOf(env.SYSTEMS_URL);
  if (systems) destinations.push(destination({ id: 'systems', label: 'ØPHS real (Systems)', category: 'propio', ...systems, mesas: ['elvira'], source: 'SYSTEMS_URL' }));

  String(env.RACK_PEERS ?? '').split(',').map((s) => endpointOf(s)).filter(Boolean).forEach((ep, i) => {
    destinations.push(destination({ id: `rack-${i + 1}`, label: 'Rack par (consenso)', category: 'propio', ...ep, mesas: ['sentinel'], source: 'RACK_PEERS' }));
  });

  for (const key of Object.keys(env).filter((k) => /^GRID_[A-Z]{2}_URL$/.test(k)).sort()) {
    const ep = endpointOf(env[key]);
    if (ep) destinations.push(destination({ id: `grid-${key.slice(5, 7).toLowerCase()}`, label: `Operador de red ${key.slice(5, 7)}`, category: 'tercero', ...ep, mesas: ['ophs'], source: key }));
  }

  if (isSet(env.SMTP_HOST)) {
    destinations.push(destination({
      id: 'smtp', label: 'Correo saliente (SMTP)', category: 'tercero',
      protocol: 'smtp', host: normalizeHost(env.SMTP_HOST.trim()), port: Number(env.SMTP_PORT) || DEFAULT_SMTP_PORT,
      mesas: ['reff'], source: 'SMTP_HOST',
    }));
  }

  if (publicWebMesas.length) {
    destinations.push(destination({
      id: 'web-publica', label: 'Páginas públicas que cita un usuario (nunca redes privadas)', category: 'tercero',
      protocol: 'http(s)', host: '*', port: null, mesas: publicWebMesas, source: 'EGRESS_PUBLIC_WEB_MESAS',
    }));
  }

  mongoEndpoints(env.MONGO_URI).forEach((ep, i) => {
    destinations.push(destination({
      id: `mongo-${i + 1}`, label: 'Base de datos (MongoDB)', via: 'controlador',
      category: ep.host.endsWith('.mongodb.net') ? 'tercero' : 'propio',
      ...ep, mesas: [ANY_MESA], source: 'MONGO_URI',
    }));
  });

  return {
    timeoutMs: Number.isInteger(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
    externalLlmMesas,
    publicWebMesas,
    destinations,
  };
}
