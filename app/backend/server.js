import express from 'express';
import cors from 'cors';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectMongo, closeMongo, getElviraDb, getMongoClient, withTransaction } from './db/mongo.js';
import { createSentinelForensics } from './sentinel-forensics.js';
import { callLLM } from './llm.js';

// Load .env manually for environments that don't use --env-file
{
  const envPath = new URL('.env', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const m = line.match(/^\s*([^#=\s][^=]*?)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}
import { mountElviraCentral } from './elvira-central.js';
import { mountFinance } from './finance.js';
import { mountFinanceCompanies } from './finance-companies.js';
import { mountMna } from './mna.js';
import { mountFl } from './fl.js';
import { mountFlExpediente } from './fl-expediente.js';
import { mountPactvm } from './pactum-viridi.js';
import { mountResilience } from './resilience.js';
import { mountHerzog } from './herzog.js';
import { mountSeagle } from './seagle.js';
import { mountMasterGateway } from './master-gateway.js';
import { mountNotificationCenter, ensureNotificationCenterIndexes } from './notification-center.js';
import { mountOps } from './ops.js';
import { mountPaia } from './paia.js';
import { mountOphsCockpit } from './ophs-cockpit.js';
import { createCibeBunker, mountCibeBunker } from './cibe-bunker.js';
import { mountRackState } from './rack-state.js';
import { mountGridInterlink } from './grid-interlink.js';

import { ensureUsersSeed, mountAuth } from './routes/auth.routes.js';
import { mountBus } from './routes/bus.routes.js';
import { mountNotifications } from './routes/notifications.routes.js';
import { createElviraStore } from './routes/elvira-store.js';
import { mountReffCrm } from './routes/reff-crm.routes.js';
import { mountElviraBridges } from './routes/elvira-bridges.routes.js';
import { mountCnmc } from './routes/cnmc.routes.js';
import { mountSentinelForensicRoutes } from './routes/sentinel-forensic.routes.js';
import { mountU2Ree } from './routes/u2-ree.routes.js';
import { mountReffGuestToken } from './routes/reff-guest.routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FRONT = path.join(ROOT, 'frontend');
// DATA_DIR: en k8s el volumen persistente (PVC) se monta en /app/backend/data, y los tests/sandbox necesitan
// aislar el estado local sin tocar data/ real. Sin la variable, el default de siempre.
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'search_history.json');
const ELVIRA_FILE = path.join(DATA_DIR, 'elvira.json');
const BUS_HISTORY_FILE = path.join(DATA_DIR, 'bus_history.json');
const NOTIFICATIONS_FILE = path.join(DATA_DIR, 'admin_notifications.json');

/* ---------- persistence helpers ---------- */
function atomicWriteJson(file, data) {
  const tempFile = `${file}.tmp`;
  try {
    fs.writeFileSync(tempFile, JSON.stringify(data, null, 2));
    fs.renameSync(tempFile, file);
  } catch (err) {
    console.error(`[persistence] Error crítico escribiendo ${file}:`, err);
  }
}

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(HISTORY_FILE)) atomicWriteJson(HISTORY_FILE, {});
if (!fs.existsSync(BUS_HISTORY_FILE)) atomicWriteJson(BUS_HISTORY_FILE, []);

/* ---------- MongoDB Initialization ---------- */
await connectMongo();
const mongo = getElviraDb();

if (!fs.existsSync(ELVIRA_FILE)) atomicWriteJson(ELVIRA_FILE, {
  systems: {
    sentinel: { status: 'connected', endpoint: 'local · bus events', lastPing: null, latencyMs: null },
    herzog:   { status: 'connected', endpoint: 'local · reff/api/herzog', lastPing: null, latencyMs: null },
    ophs:     { status: 'pending', endpoint: '', lastPing: null, latencyMs: null },
    tcontroler: { status: 'local', tokensUsed: 0, tokensCap: 0, byUser: {} },
    dataBase: { status: 'ok', backend: 'mongodb' },
  },
  ophs: {
    weights: { W: 0.18, I: 0.10, S: 0.10, M: 0.12, E: 0.10, R: 0.10, B: 0.12, G: 0.13, U2: 0.05 },
    threshold: { estrategico: 70, operativo: 45 },
    dictamenes: [],
  },
  bridges: {
    sentinel: { events: [] },
    herzog:   { audits: [] },
  },
  cnmc: {
    documents: [],
    auditLog:  [],
  },
  updatedAt: new Date().toISOString(),
});

const { readElvira, writeElvira } = createElviraStore(ELVIRA_FILE, atomicWriteJson);

// LLM provider configured in llm.js via LLM_PROVIDER env var (.env ya cargado arriba)

// Credenciales: usuarios/sesiones en Mongo (colecciones 'users'/'sessions').
// Seed inicial solo si 'users' esta vacia, desde variables de entorno SEED_*_PASSWORD.
await ensureUsersSeed(mongo);

// Mesas accesibles por rol. 'admin' = todo. Others = whitelist.
// fl_expediente: scope propio del Expediente Fiscal y Juridico (NDA-B bilaterales
// y documentacion protegida) dentro de F&L. Deliberadamente distinto de 'fl'
// (licencias/poderes/matriz de riesgo, menos sensible) aunque hoy ambos solo
// los tenga admin — separa el permiso para el dia que 'fl' se abra a mas roles
// sin arrastrar automaticamente el expediente confidencial.
const ROLE_MESAS = {
  admin:   ['elvira', 'reff', 'snfiu2', 'ophs', 'sentinel', 'factory', 'finance', 'mna', 'fl', 'fl_expediente', 'pactvm', 'gateway', 'seagle', 'herzog', 'resilience', 'notificaciones'],
  ray:     ['snfiu2', 'pactvm'],
  amir:    ['reff'],
  gonzalo: ['reff', 'snfiu2', 'pactvm', 'gateway'],
  celia:   [],
  maitane: [],
  arkaitz: [],
  oscar:   [],
};

// Prefijos de rutas API por mesa (para protección en backend)
const MESA_ROUTES = {
  elvira:   ['/api/elvira/'],
  reff:     ['/api/reff', '/api/sheets', '/api/companies', '/api/search', '/api/linkedin', '/api/email', '/api/overview'],
  snfiu2:   ['/api/snfi-u2/', '/api/u2/'],
  sentinel: ['/api/sentinel', '/api/rack'],
  factory:  ['/api/factory'],
  finance:  ['/api/finance'],
  mna:      ['/api/mna'],
  fl:       ['/api/fl'],
  pactvm:   ['/api/pactvm'],
  ophs:     ['/api/ops', '/api/paia', '/api/ophs-cockpit', '/api/grid'],
  gateway:  ['/api/gateway'],
  seagle:   ['/api/seagle'],
  herzog:   ['/api/herzog-central'],
  resilience: ['/api/resilience'],
  notificaciones: ['/api/notif-center'],
};

function canAccessMesa(role, mesa) {
  if (role === 'admin') return true;
  return (ROLE_MESAS[role] || []).includes(mesa);
}

function mesaForPath(path) {
  for (const [mesa, prefixes] of Object.entries(MESA_ROUTES)) {
    if (prefixes.some(p => path.startsWith(p))) return mesa;
  }
  return null;
}

function requireMesa(mesa) {
  return (req, res, next) => {
    if (!canAccessMesa(req.role, mesa)) {
      return res.status(403).json({ error: 'Acceso denegado a esta mesa' });
    }
    next();
  };
}

function requireAdmin(req, res, next) {
  if (req.role !== 'admin') return res.status(403).json({ error: 'admin requerido' });
  next();
}

const app = express();
app.set('trust proxy', 1);

/* ==========================================================================
   K8s · sondas de liveness / readiness. Se montan LO PRIMERO (antes de cors,
   body parser, rate limit y Sentinel), con motivo medido, no teorico:
   - livez no puede depender de Mongo. Detras del middleware forense de
     Sentinel (consulta Mongo en cada peticion) una caida de Mongo dejaba livez
     colgado y el kubelet reiniciaba pods sanos en cadena (verificado: livez
     sin respuesta en 4s con Mongo parado).
   - Las sondas se repiten cada pocos segundos: no son trafico de usuario y no
     deben llenar forensic_log (cadena de hashes inmutable), contar contra el
     rate limit ni mezclarse con el analisis de comportamiento.
   Contrato:
     /api/livez  200 mientras el event loop responda (tambien durante el
                 apagado: el kubelet no debe matar un pod que esta drenando).
     /api/readyz 200 solo si Mongo responde en <2s, Rack State tiene rol, la
                 integracion Reff ya termino de cargar y no hay apagado en curso.
                 503 saca el pod del Service sin reiniciarlo.
     /api/ophs/readyz  mismo criterio de infraestructura, namespaced para cuando
                 ØPHS se separe a su propio Deployment (hoy comparte proceso).
========================================================================== */
let rackState = null;      // asignado al montar Rack State (mas abajo)
let reffState = 'loading'; // 'loading' | 'mounted' | 'failed' (integracion Reff, mas abajo)
let shuttingDown = false;  // true desde SIGTERM: readyz pasa a 503 y el kubelet drena el trafico

const READYZ_MONGO_TIMEOUT_MS = 2000;
async function pingMongo() {
  let timer;
  try {
    await Promise.race([
      mongo.command({ ping: 1 }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`ping Mongo > ${READYZ_MONGO_TIMEOUT_MS}ms`)), READYZ_MONGO_TIMEOUT_MS); }),
    ]);
  } finally { clearTimeout(timer); }
}

app.get('/api/livez', (_req, res) => {
  res.json({ status: 'ok', service: 'elvira', uptimeSec: Math.floor(process.uptime()) });
});

app.get('/api/readyz', async (_req, res) => {
  const checks = { mongo: false, rack: 'n/a', reff: reffState };
  if (!shuttingDown) {
    try { await pingMongo(); checks.mongo = true; } catch { checks.mongo = false; }
    if (rackState) {
      const s = rackState.status();
      checks.rack = s.role === 'leader' || s.role === 'follower' ? s.role : 'unavailable';
    }
  }
  const ready = !shuttingDown && checks.mongo === true && checks.rack !== 'unavailable' && checks.reff !== 'loading';
  res.status(ready ? 200 : 503).json({ ready, shuttingDown, checks, uptimeSec: Math.floor(process.uptime()) });
});

app.get('/api/ophs/readyz', async (_req, res) => {
  if (shuttingDown) return res.status(503).json({ ready: false, shuttingDown: true });
  try {
    await pingMongo();
    res.json({ ready: true, note: 'ØPHS aun corre en el proceso monolito: readiness real por dominio pendiente de separacion a Deployment propio' });
  } catch (err) {
    res.status(503).json({ ready: false, error: String(err?.message || err) });
  }
});

const CORS_ORIGIN = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((s) => s.trim())
  : null;
app.use(cors({
  origin: process.env.NODE_ENV === 'production' ? (CORS_ORIGIN || false) : true,
  credentials: true,
}));
app.use(express.json({ limit: '2mb' }));

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => req.ip ? ipKeyGenerator(req.ip) : 'anon',
  message: { error: 'Demasiadas peticiones. Intenta de nuevo en un minuto.' },
});
app.use('/api', apiLimiter);

/*
 * Orden de arranque: en el server.js original, busEmit/adminNotify/auth eran
 * `function` (hoisted) y podian referenciarse entre si sin importar el orden
 * textual porque solo se EJECUTAN en tiempo de peticion, mucho despues de
 * que el modulo entero ya cargo. Al repartir cada bloque a su propio modulo
 * ese hoisting entre archivos ya no existe, así que aquí declaramos los
 * bindings mutables primero (let) y los rellenamos según se van montando los
 * módulos — los middlewares de mas abajo solo los invocan dentro de un
 * closure, en tiempo de petición, cuando ya están asignados.
 */
let adminNotify, busEmit, busEmitAlert, busEvents, auth, listAdminNotifications, flushBusHistory;
// (sseClients del bus no se usa fuera de bus.routes.js; se ignora aquí)

/* Captura cualquier caída no controlada del proceso y la sube a notificaciones Admin.
 * Tras una excepción no capturada el estado del proceso queda indefinido (doctrina
 * Node): no debe seguir sirviendo tráfico. Antes esto solo logueaba y continuaba —
 * si app.listen() fallaba (ej. EADDRINUSE por un reinicio de nodemon superpuesto),
 * el proceso quedaba "zombie" sin escuchar el puerto pero tampoco moría, generando
 * la misma notificación repetida en bucle. Ahora se notifica y se sale limpio;
 * el supervisor (nodemon/systemd/k8s) reinicia un proceso fresco. */
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  adminNotify({ origin: 'SYSTEM', label: 'Excepción no controlada — proceso reiniciando', detail: err?.stack || err?.message || String(err), severity: 'error' });
  setTimeout(() => process.exit(1), 300);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
  adminNotify({ origin: 'SYSTEM', label: 'Promesa rechazada sin manejar — proceso reiniciando', detail: reason?.stack || reason?.message || String(reason), severity: 'error' });
  setTimeout(() => process.exit(1), 300);
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => req.ip ? ipKeyGenerator(req.ip) : 'anon',
  message: { error: 'Demasiados intentos de login. Espera 15 minutos.' },
});

/* FASE 5 (2026-09-20): apiLimiter (120/min/IP) es un techo generico —
 * insuficiente para rutas que llaman callLLM() (coste real en tokens
 * Anthropic + timeout de hasta LLM_TIMEOUT_MS cada una: /api/elvira/central/chat,
 * /api/paia/nodes/:id/insight). Limiter propio, por usuario (no por IP,
 * varios usuarios detrás del mismo NAT/oficina no deben compartir cupo). */
const llmLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 12,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => req.user || (req.ip ? ipKeyGenerator(req.ip) : 'anon'),
  message: { error: 'Demasiadas consultas a la IA. Espera un minuto.' },
});

/* ---------- Middleware de Auditoría Sentinel ----------
   Bus = Historial de acciones, no log de tráfico HTTP.
   Solo se registran movimientos reales: métodos mutantes (POST/PUT/PATCH/DELETE)
   y fallos de acceso (401/403). Se descarta GET de polling (dashboard refresh,
   /api/me, /api/bus/stats, SSE stream, etc) y cualquier 2xx/3xx de lectura. */
const POLLING_PATHS = ['/api/bus/stream', '/api/bus/stats', '/api/bus/history', '/api/bus/'];
function sentinelLogger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    const isMutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
    const isAccessFailure = res.statusCode === 401 || res.statusCode === 403;
    if (!isMutation && !isAccessFailure) return;
    if (POLLING_PATHS.some(p => req.path.startsWith(p))) return;
    const duration = Date.now() - start;
    busEmit({
      id: crypto.randomUUID(), ts: new Date().toISOString(),
      origin: 'SENTINEL', dest: 'LOG', type: 'event',
      state: res.statusCode < 400 ? 'COMPLETED' : 'BLOCKED',
      label: `${req.method} ${req.path} (${res.statusCode})`,
      payload: { durationMs: duration, ip: req.ip, user: req.user || 'anon' }
    });
  });
  next();
}
app.use(sentinelLogger);

const sentinelForensics = createSentinelForensics({ mongo, busEmit: (...args) => busEmit(...args), ROLE_MESAS });
app.use(sentinelForensics.middleware(mesaForPath));

/* ---- Notificaciones Admin (mount temprano: adminNotify es dependencia de sentinelLogger/uncaughtException arriba) ---- */
({ adminNotify, listAdminNotifications } = mountNotifications(app, { auth: (req, res, next) => auth(req, res, next), requireAdmin, atomicWriteJson, NOTIFICATIONS_FILE }));

/* ---- Event Bus (mount temprano: busEmit es dependencia compartida por ~10 modulos) ---- */
({ busEvents, busEmit, busEmitAlert, flushBusHistory } = mountBus(app, {
  auth: (req, res, next) => auth(req, res, next),
  requireAdmin, atomicWriteJson, BUS_HISTORY_FILE, adminNotify,
}));

/* ---------- auth (usuarios/sesiones en Mongo, ver routes/auth.routes.js) ---------- */
({ auth } = mountAuth(app, { mongo, requireAdmin, ROLE_MESAS, authLimiter, sentinelForensics, busEmit }));

/* ---------- mesa guards ---------- */
app.use('/api/sheets',    auth, requireMesa('reff'));
app.use('/api/companies', auth, requireMesa('reff'));
app.use('/api/search',    auth, requireMesa('reff'));
app.use('/api/overview',  auth, requireMesa('reff'));
app.use('/api/linkedin',  auth, requireMesa('reff'));
app.use('/api/email',     auth, requireMesa('reff'));
app.use('/api/elvira',    auth, requireMesa('elvira'));
app.use('/api/bus',       auth);
app.use('/api/sentinel',  auth, requireMesa('sentinel'));
app.use('/api/snfi-u2',   auth, requireMesa('snfiu2'));
app.use('/api/u2',        auth, requireMesa('snfiu2'));
app.use('/api/reff',      auth, requireMesa('reff'));
app.use('/api/factory',   auth, requireMesa('factory'));
app.use('/api/finance',   auth, requireMesa('finance'));
app.use('/api/mna',       auth, requireMesa('mna'));
// /api/fl/expediente/* NO entra por este middleware generico: tiene guard
// propio (requireMesa('fl_expediente')) montado en fl-expediente.js, distinto
// de la mesa 'fl' del resto de F&L (licencias/poderes) — ver SEGURIDAD en ese
// archivo. mesaForPath (usado por sentinelForensics, no por autorizacion)
// sigue clasificando /api/fl/* como mesa 'fl' a efectos de log forense; eso
// es correcto y no otorga acceso por si solo.
app.use('/api/fl', (req, res, next) => (req.path.startsWith('/expediente') ? next() : auth(req, res, next)));
app.use('/api/fl', (req, res, next) => (req.path.startsWith('/expediente') ? next() : requireMesa('fl')(req, res, next)));
app.use('/api/pactvm',    auth, requireMesa('pactvm'));
app.use('/api/resilience', auth, requireMesa('resilience'));
app.use('/api/herzog-central', auth, requireMesa('herzog'));
app.use('/api/seagle',    auth, requireMesa('seagle'));
app.use('/api/ops',       auth, requireMesa('ophs'));
app.use('/api/paia',      auth, requireMesa('ophs'));
app.use('/api/ophs-cockpit', auth, requireMesa('ophs'));
app.use('/api/gateway',   auth, requireMesa('gateway'));
app.use('/api/notif-center', auth, requireMesa('notificaciones'));

/* ---------- Rëff CRM-adjacent: sheets/companies/search/linkedin/email/overview ---------- */
const reffCrm = mountReffCrm(app, {
  auth, mongo, withTransaction, adminNotify,
  readElvira, writeElvira,
  HISTORY_FILE, atomicWriteJson, fs,
});

/* ==========================================================================
   S-NFI U-2 · energia desperdiciada (REE/ESIOS)
   Se monta aqui (antes de Pactvm/CIBE/.../Elvira Central) porque su snapshot
   diario (getU2SnapshotToday) lo consumen los closures getU2Snapshot pasados
   a mountPactvm y mountElviraCentral mas abajo.
========================================================================== */
const u2Ree = mountU2Ree(app, { auth, busEmit, busEmitAlert, busEvents, atomicWriteJson, DATA_DIR });

/* ==========================================================================
   S-NFI Factory · en desarrollo pendiente (mesa vaciada, ver CLAUDE.md).
   Guard 'factory' se mantiene reservado; sin rutas backend activas.
========================================================================== */

/* ==========================================================================
   S-NFI Finance · control financiero y valoracion de activos reales
   Tesoreria, flujo caja proyectado, contabilidad analitica, activos reales,
   pasarela cifrada export para asesoria contable externa.
========================================================================== */
mountFinance(app, { auth, requireMesa, mongo });
mountFinanceCompanies(app, { auth, requireMesa, mongo });
mountMna(app, { auth, requireMesa, mongo });

/* ==========================================================================
   CIBE Bunker · modulo bunker de Pactvm Viridi (Instrucciones.txt §3)
   Creado aqui (antes que en su ubicacion historica junto a mountCibeBunker
   mas abajo) porque el Expediente Fiscal y Juridico de F&L, mas abajo,
   tambien lo consume (scope fl.expediente.read) para exigir token Ed25519
   en la descarga de documentos NDA-B. mountCibeBunker (rutas /api/cibe/*)
   sigue montandose en su sitio original; aqui solo se crea la instancia.
========================================================================== */
const cibe = createCibeBunker({ mongo, busEmit, adminNotify });
cibe.ready().catch((err) => console.error('[CIBE] Error de arranque (creacion temprana para F&L):', err.message));

/* ==========================================================================
   S-NFI F&L · Audit Legal - Firmas & Normas (reconstruida 2026-09-08,
   ver FL-PLAN.md). Licencias multi-planta SEMARNAT/CONAGUA/CFE/MITECO,
   matriz de responsabilidad legal por proyecto con gating de pagos, motor
   de alarmas de caducidad de poderes/firmas sobre adminNotify.
========================================================================== */
mountFl(app, { auth, requireMesa, mongo, busEmit, adminNotify });
/* Expediente Fiscal y Juridico Impecable: catalogo fijo de documentacion
   corporativa (identidad fiscal, PI, dataroom financiero, anclaje comercial)
   con adjuntos en GridFS y motor propio de alerta de caducidad. Modulo aparte,
   mismo log inmutable fl_log, pero guard propio 'fl_expediente' (distinto de
   'fl') por ser documentacion protegida/NDA-B — ver ROLE_MESAS. Archivos
   cifrados en reposo (AES-256-GCM) y descarga detras de token CIBE
   (scope fl.expediente.read, modo segun CIBE_MODE). */
mountFlExpediente(app, { auth, requireMesa, mongo, busEmit, adminNotify, cibe });

/* ==========================================================================
   Pactvm Viridi · guardian doctrinal, cientifico y de cumplimiento bio-ambiental
   Certificado CIBE, politicas medioambientales, condiciones de acceso, lectura
   de auditorias Herzog (db 'reff', sin escritura).
========================================================================== */
mountPactvm(app, {
  auth, requireMesa, requireAdmin, mongo, getMongoClient,
  getU2Snapshot: () => u2Ree.getU2SnapshotToday(),
});

/* ==========================================================================
   S-NFI Resilience (BSS) · inteligencia de deteccion y arbitraje ante fallos
   de red electrica / eventos sistemicos. Manda senal a Elvi-Ra (busEmit +
   adminNotify), nunca ejecuta accion fisica (Regla de Oro).
========================================================================== */
mountResilience(app, { auth, requireMesa, mongo, busEmit, adminNotify });

/* ==========================================================================
   Herzog (Central) · bunker receptor de toda la informacion/datos de SYSTEMS.
   Distinto del Herzog interno de OPHS Framework (sigue en elvira-central.js,
   solo telemetria fisica OPS/PAIA). Transversal: cualquier departamento
   pide/guarda informacion aqui (metricas, documentos, notas).
========================================================================== */
mountHerzog(app, { auth, requireMesa, mongo, busEmit, adminNotify, getU2Snapshot: () => u2Ree.getU2SnapshotToday() });

/* ==========================================================================
   S-EAGLE · Rëff Core Engine, mesa 5. Revisa la informacion que Herzog
   retiene: verificar/corregir/compartir. Mapa mundi portales (apartado 1)
   reutiliza Gob Share en frontend, sin backend propio. Ver seagle.js.
========================================================================== */
mountSeagle(app, { auth, requireMesa, mongo });

/* ==========================================================================
   Puerto Maestro (Master Gateway) · auditoria activa y control de trafico
   inter-puertos entre Reff, Elvi-Ra y OPHS. Ningun perfil (incluido PhD con
   credenciales tecnicas) extrae datos cruzados sin pasar por esta consola.
   Solo Admin decide (aprobar/denegar); crear solicitud es accesible a
   cualquier mesa con permiso 'gateway' (Regla de Oro: el ser humano
   autoriza).
========================================================================== */
mountMasterGateway(app, { auth, requireMesa, requireAdmin, mongo });

/* ==========================================================================
   Consola de Notificaciones · mesa transversal admin-only. Unifica lectura
   de admin_notifications (alertas de sistema) y traffic_requests (Rëff,
   Consola Maestra) en una sola vista, con acciones 1-clic sobre traffic
   detrás de requireAdmin real. Ver notification-center.js.
========================================================================== */
mountNotificationCenter(app, { auth, requireMesa, requireAdmin, listAdminNotifications });
await ensureNotificationCenterIndexes();

/* ==========================================================================
   CIBE Bunker · rutas de administracion (mesa pactvm) + endpoint externo
   POST /api/cibe/token. La instancia 'cibe' se crea mas arriba (antes de
   mountFl/mountFlExpediente, que ya la necesitan) — aqui solo se montan
   las rutas HTTP del bunker sobre esa misma instancia.
========================================================================== */
mountCibeBunker(app, { auth, requireMesa, mongo, bunker: cibe, busEmit });

/* ==========================================================================
   OPHS Framework · OPS (telemetria) + PAIA (analitica predictiva) + Cockpit
   Sub-interfaces del framework OPHS que convergen en la Consola Soberana
   (fusiona OPS+PAIA+Herzog+Sentinel). Doctrina: solo lectura/propuesta, la
   autoridad de ejecucion sigue siendo de cada dominio.
========================================================================== */
mountOps(app, { auth, requireMesa, mongo, cibe });
mountPaia(app, { auth, requireMesa, mongo, llmLimiter });
mountOphsCockpit(app, { auth, requireMesa, mongo, getMongoClient });

/* ==========================================================================
   Rack State · estado distribuido entre racks fisicos (Instrucciones.txt §1)
   Consenso Raft (eleccion + replicacion + commit por mayoria) para puertos
   parametrizados y estados de seguridad. Sin quorum: escrituras bloqueadas,
   lecturas Offline-First del ultimo estado comprometido. Mesa sentinel.
========================================================================== */
rackState = mountRackState(app, { auth, requireMesa, mongo, busEmit, adminNotify, cibe });

/* ==========================================================================
   Grid Interlink · redes electricas transnacionales (Instrucciones.txt §2)
   Grid Abstraction Layer: un worker thread sandboxed (resourceLimits) por
   pais (REE/REN/RTE/ONEE). El colapso de un TSO no toca a los demas. Mesa ophs.
========================================================================== */
mountGridInterlink(app, { auth, requireMesa, mongo, busEmit, adminNotify, cibe });

/* K8s · sondas /api/livez, /api/readyz y /api/ophs/readyz: ver el bloque al principio de este archivo (justo tras crear `app`). */

/* ==========================================================================
   ELVI-RA · puentes mock (Sentinel/Herzog) + OPHS scoring + T'Controler
========================================================================== */
mountElviraBridges(app, {
  auth, mongo, busEmit, busEvents,
  readElvira, writeElvira,
});

/* ==========================================================================
   CNMC · Embudo Legal + Buscador hibrido (numeracionyoperadores.cnmc.es + LLM)
========================================================================== */
mountCnmc(app, {
  auth, mongo, busEmit, busEvents, adminNotify,
  readElvira, writeElvira,
  callLLMTracked: reffCrm.callLLMTracked, extractJson: reffCrm.extractJson,
});

/* ==========================================================================
   SENTINEL · Trazabilidad forense de IPs (wrappers finos sobre sentinel-forensics.js)
========================================================================== */
mountSentinelForensicRoutes(app, { auth, sentinelForensics, busEmit, busEvents });

/* ============================================================
   ELVI-RA · CENTRAL (Volumen 2)
   Chat conocedor del sistema + acciones con consentimiento humano
   + mock del puerto OPHS/Systems (/api/ophs/*)
   ============================================================ */
mountElviraCentral(app, {
  auth, requireMesa, mongo, getMongoClient,
  callLLM, trackTokens: reffCrm.trackTokens, busEmit, adminNotify,
  readElvira, cibe, llmLimiter,
  getU2Snapshot: () => u2Ree.getU2SnapshotToday(),
});

/* ---------- static frontend ---------- */
app.use(express.static(FRONT));
app.get('/', (req, res) => res.redirect('/pages/login.html'));

/* ============================================================
   RËFF · Mesa de trabajo integrada
   Monta el servidor compilado de Rëff bajo /reff/api
   y sirve su cliente React bajo /reff
   ============================================================ */
(async () => {
  try {
    const REFF_DIST = path.resolve(__dirname, '../../Elvi-Ra/Mesas/Rëff/dist');
    const REFF_SERVER = path.join(REFF_DIST, 'server');
    const REFF_CLIENT = path.join(REFF_DIST, 'client');

    // Load Rëff .env into process.env (ANTHROPIC_API_KEY, JWT_SECRET)
    const reffEnv = path.resolve(__dirname, '../../Elvi-Ra/Mesas/Rëff/.env');
    if (fs.existsSync(reffEnv)) {
      for (const line of fs.readFileSync(reffEnv, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (!m) continue;
        const [, k, v] = m;
        if (!(k in process.env)) process.env[k] = v.replace(/^["']|["']$/g, '');
      }
    }

    const toFileUrl = (p) => 'file:///' + p.replace(/\\/g, '/');

    // Rëff comparte el mismo MongoClient/pool que Elvi-Ra — un solo proceso, una sola conexión.
    const { setMongoClient } = await import(toFileUrl(path.join(REFF_SERVER, 'mongo.js')));
    await setMongoClient(getMongoClient());

    const { seedDatabase, getUserByUsername } = await import(toFileUrl(path.join(REFF_SERVER, 'db.js')));
    await seedDatabase();

    const { signToken } = await import(toFileUrl(path.join(REFF_SERVER, 'auth.js')));

    const { default: reffAuthRoutes }      = await import(toFileUrl(path.join(REFF_SERVER, 'routes', 'auth.routes.js')));
    const { default: reffSheetsRoutes }    = await import(toFileUrl(path.join(REFF_SERVER, 'routes', 'sheets.routes.js')));
    const { default: reffCompaniesRoutes } = await import(toFileUrl(path.join(REFF_SERVER, 'routes', 'companies.routes.js')));
    const { default: reffGeoRoutes }       = await import(toFileUrl(path.join(REFF_SERVER, 'routes', 'geo.routes.js')));
    const { default: reffHerzogRoutes }    = await import(toFileUrl(path.join(REFF_SERVER, 'routes', 'herzog.routes.js')));
    const { default: reffWatchRoutes }     = await import(toFileUrl(path.join(REFF_SERVER, 'routes', 'watch.routes.js')));
    const { default: reffTrafficRoutes }   = await import(toFileUrl(path.join(REFF_SERVER, 'routes', 'traffic.routes.js')));
    const { default: reffMeetingsRoutes }  = await import(toFileUrl(path.join(REFF_SERVER, 'routes', 'meetings.routes.js')));
    const { default: reffCommsRoutes }     = await import(toFileUrl(path.join(REFF_SERVER, 'routes', 'communications.routes.js')));
    const { startWatchCron }               = await import(toFileUrl(path.join(REFF_SERVER, 'watch.js')));
    const { startMeetingReminderCron }     = await import(toFileUrl(path.join(REFF_SERVER, 'meeting-reminders.js')));

    const reffHealth = (_req, res) => res.json({ status: 'ok', service: 'reff', env: process.env.NODE_ENV || 'development' });

    // JWT de Rëff a partir de la sesión de Elvi-Ra, sin login propio. Exige sesión válida y
    // acceso a la mesa reff; registra también el alias /api/guest-token (routes/reff-guest.routes.js).
    mountReffGuestToken(app, { auth, requireMesa, signToken, getUserByUsername });

    app.get('/reff/api/health', reffHealth);
    app.use('/reff/api/auth', reffAuthRoutes);
    app.use('/reff/api/crm',  reffSheetsRoutes);
    app.use('/reff/api/crm',  reffCompaniesRoutes);
    app.use('/reff/api/crm',  reffMeetingsRoutes);
    app.use('/reff/api/crm',  reffCommsRoutes);
    app.use('/reff/api/geo',  reffGeoRoutes);
    app.use('/reff/api/herzog', reffHerzogRoutes);
    app.use('/reff/api/watch', reffWatchRoutes);
    app.use('/reff/api/traffic', reffTrafficRoutes);

    // Aliases at root /api so Rëff React client (built with base path "/") resolves correctly
    // (/api/guest-token ya lo registra mountReffGuestToken arriba)
    app.get('/api/health', (_req, res) => res.json({
      status: 'ok',
      service: 'elvira',
      nodeEnv: process.env.NODE_ENV || 'development',
      uptimeSec: Math.floor(process.uptime()),
      mongoConfigured: Boolean(process.env.MONGO_URI),
    }));
    app.get('/api/reff-health', reffHealth);
    app.use('/api/auth',   reffAuthRoutes);
    app.use('/api/crm',    reffSheetsRoutes);
    app.use('/api/crm',    reffCompaniesRoutes);
    app.use('/api/crm',    reffMeetingsRoutes);
    app.use('/api/crm',    reffCommsRoutes);
    app.use('/api/geo',    reffGeoRoutes);
    app.use('/api/herzog', reffHerzogRoutes);
    app.use('/api/watch',  reffWatchRoutes);
    app.use('/api/traffic', reffTrafficRoutes);

    startWatchCron();
    startMeetingReminderCron();

    // Serve Rëff React client — assets built with base "/" so /assets/* must be mirrored
    if (fs.existsSync(REFF_CLIENT)) {
      // Wrapper: usa el token de sesión de Elvi-Ra (elvira_token) para obtener un token de Rëff, lo guarda
      // bajo las claves que espera el cliente React (reff_token / reff_user) y entra al SPA. Sin sesión
      // (o con la sesión caducada) manda al login de Elvi-Ra.
      app.get('/reff', (_req, res) => {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(`<!doctype html><html><head><meta charset="UTF-8"><title>Rëff</title></head><body>
<script>
(async () => {
  const elviraToken = localStorage.getItem('elvira_token') || '';
  if (!elviraToken) { location.replace('/pages/login.html'); return; }
  try {
    const r = await fetch('/reff/api/guest-token', { headers: { Authorization: 'Bearer ' + elviraToken } });
    if (r.status === 401) { location.replace('/pages/login.html'); return; }
    if (!r.ok) throw new Error('guest-token HTTP ' + r.status);
    const { token, user } = await r.json();
    if (token) localStorage.setItem('reff_token', token);
    if (user) localStorage.setItem('reff_user', JSON.stringify(user));
  } catch(e) { console.warn('[reff-wrapper] guest-token failed', e); }
  location.replace('/reff/app/dashboard');
})();
</script>
</body></html>`);
      });
      app.use('/reff/app', express.static(REFF_CLIENT));
      app.use('/assets', express.static(path.join(REFF_CLIENT, 'assets')));
      app.get('/reff/app/*', (_req, res) => res.sendFile(path.join(REFF_CLIENT, 'index.html')));
    }

    console.log('[Rëff] Integrado en Elvi-Ra bajo /reff');
    reffState = 'mounted';
  } catch (err) {
    console.error('[Rëff] Error al integrar — Rëff no disponible:', err.message);
    reffState = 'failed';
  }
})();

/* Error handler global — última red. Cualquier excepción no atrapada en una ruta
   cae aquí; se notifica al Admin además de responder 500 al cliente. */
app.use((err, req, res, _next) => {
  console.error('[unhandled route error]', err);
  adminNotify({ origin: 'SYSTEM', label: `Error no controlado · ${req.method} ${req.path}`, detail: err?.stack || err?.message || String(err), severity: 'error' });
  if (res.headersSent) return;
  res.status(500).json({ error: 'Error interno del servidor' });
});

/* ==========================================================================
   K8s · puente entre la deteccion de infraestructura (kubelet) y la capa de
   negocio (Sentinel/bus). Un contenedor roto lo reinicia el kubelet sin que
   Sentinel se entere por si solo (viven en planos distintos). Marca de arranque
   en DATA_DIR (PVC en k8s: sobrevive al reinicio del contenedor y del pod):
     - al arrancar se escribe { cleanShutdown: false };
     - el apagado ordenado (SIGTERM del kubelet en rollout, drain o scale a 0)
       la pasa a true justo antes de salir.
   Si al arrancar la marca previa sigue en false, la instancia anterior murio
   sin apagarse (OOMKilled, SIGKILL, crash, liveness colgada) y se avisa al
   Admin. Un despliegue normal NO avisa; un pod que llevaba horas vivo y muere
   SI (la version anterior solo detectaba reinicios dentro de los 5 min del
   boot previo, y avisaba en falso al redesplegar dos veces seguidas).

   Solo dentro de un pod k8s real: KUBERNETES_SERVICE_HOST lo inyecta el propio
   Kubernetes. Sin el, cualquier reinicio manual en desarrollo (nodemon,
   npm run dev) generaba avisos falsos de "pod recuperado tras caida".
========================================================================== */
const BOOT_FLAG_FILE = path.join(DATA_DIR, '.last_boot');
const IN_K8S = Boolean(process.env.KUBERNETES_SERVICE_HOST);
let bootFlag = null;

function writeBootFlag(patch) {
  bootFlag = { ...bootFlag, ...patch };
  try { fs.writeFileSync(BOOT_FLAG_FILE, JSON.stringify(bootFlag)); }
  catch (err) { console.error('[k8s-boot-flag] no se pudo persistir:', err.message); }
}

if (IN_K8S) {
  const now = Date.now();
  const pod = process.env.HOSTNAME || process.env.RACK_ID || 'elvira';
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(BOOT_FLAG_FILE, 'utf8')); } catch (err) { /* primer arranque: sin marca previa */ }
  // Marca del formato anterior ({ ts, restartCount }, sin cleanShutdown): no se sabe como murio, no se avisa.
  const legacy = Boolean(prev) && prev.cleanShutdown === undefined;
  const crashed = Boolean(prev) && !legacy && prev.cleanShutdown !== true;
  const unexpectedRestarts = crashed ? (prev.unexpectedRestarts || 0) + 1 : 0;
  if (crashed) {
    const sinceMs = now - (prev.ts || now);
    // segundo reinicio inesperado seguido con un boot previo de <2min: crashloop real, no un fallo aislado
    const isLoop = unexpectedRestarts > 1 && sinceMs < 2 * 60 * 1000;
    adminNotify({
      origin: 'K8S', severity: isLoop ? 'error' : 'warning',
      label: `Pod ${pod} recuperado tras caida`,
      detail: `la instancia anterior (${prev.pod || 'desconocida'}, arrancada hace ${Math.round(sinceMs / 1000)}s) no se apago de forma limpia (OOMKilled, SIGKILL, crash o liveness colgada); reinicios inesperados consecutivos: ${unexpectedRestarts}${isLoop ? '; patron de crashloop, revisar logs del pod' : ''}`,
    });
    busEmit({
      id: crypto.randomUUID(), ts: new Date().toISOString(),
      origin: 'K8S', dest: 'SENTINEL', type: 'pod_restart',
      state: 'DONE', label: 'Pod recuperado tras caida (kubelet)',
      payload: { sinceMs, unexpectedRestarts, previousPod: prev.pod || null }, user: 'system',
    });
  }
  writeBootFlag({ pod, ts: now, cleanShutdown: false, unexpectedRestarts });
}

/* ==========================================================================
   FASE 4 · Boot Verification — resumen de servicios al arrancar.
   Mongo ya es dependencia dura mas arriba (await connectMongo() en linea 78:
   sin Mongo el proceso ni siquiera llega aqui, no hay "modo degraded" posible
   para el propio Mongo). Esto es solo VISIBILIDAD sobre servicios secundarios
   que ya degradan solos por diseño en su propio modulo (mock/fallback ya
   existente, ver comentarios de cada uno) — no bloquea el arranque, informa.
========================================================================== */
function bootVerification() {
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok, detail });

  check('Mongo', true, 'conectado (dependencia dura, ya verificado arriba)');
  check('LLM provider', !!process.env.ANTHROPIC_API_KEY || (process.env.LLM_PROVIDER || '').toLowerCase() === 'ollama',
    process.env.ANTHROPIC_API_KEY ? 'anthropic' : (process.env.LLM_PROVIDER || 'sin configurar — llm.js fallara en caliente al primer uso'));
  check('Systems (OPHS real)', !!process.env.SYSTEMS_URL,
    process.env.SYSTEMS_URL ? process.env.SYSTEMS_URL : 'sin configurar — mock local (systems_nodes)');
  check('S-NFI U2 (ESIOS/REE)', !!(process.env.ESIOS_TOKEN || process.env.ESIOS_API_KEY),
    (process.env.ESIOS_TOKEN || process.env.ESIOS_API_KEY) ? 'token presente' : 'sin configurar — u2-ree.routes.js usa su propio fallback');
  check('CIBE Bunker', !!process.env.CIBE_PRIVATE_KEY_PEM,
    process.env.CIBE_PRIVATE_KEY_PEM ? 'clave privada en env' : 'sin env — cibe-bunker.js genera/persiste par en Mongo (cibe_keys)');
  check('Rack State (RAFT)', true,
    process.env.RACK_PEERS ? `cluster: ${process.env.RACK_PEERS}` : 'standalone (quorum 1, sin RACK_PEERS)');
  check('JWT_SECRET', !!process.env.JWT_SECRET, process.env.JWT_SECRET ? 'presente' : 'AUSENTE — revisar si algun modulo lo exige antes de produccion');

  const critical = checks.filter((c) => !c.ok && c.name === 'Mongo');
  const optional = checks.filter((c) => !c.ok && c.name !== 'Mongo');

  console.log('\n[boot-verification] ------------------------------------');
  for (const c of checks) {
    console.log(`  ${c.ok ? 'OK  ' : 'WARN'} · ${c.name.padEnd(24)} ${c.detail}`);
  }
  console.log(`[boot-verification] ${optional.length === 0 ? 'todos los servicios configurados' : `${optional.length} servicio(s) secundario(s) en modo degradado/fallback (ver WARN arriba) — arranque continua`}`);
  console.log('[boot-verification] ------------------------------------\n');

  if (critical.length > 0) {
    // no debería poder llegar aquí (Mongo ya es hard-fail mas arriba), pero
    // si algún día deja de serlo, que quede explícito que esto SÍ frenaría el boot.
    throw new Error(`Boot verification: servicio critico caido: ${critical.map((c) => c.name).join(', ')}`);
  }
}
bootVerification();

const PORT = process.env.PORT || 5173;
const HOST = process.env.HOST || '0.0.0.0';
const server = app.listen(PORT, HOST, () => console.log(`Elvi-Ra running → http://0.0.0.0:${PORT}`));
// Detras de kube-proxy/Ingress/LB el keep-alive por defecto de Node (5s) es menor que el idle timeout
// de esos proxies (~60s): reutilizan una conexion que Node ya cerro y devuelven 502 esporadicos.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

/* Apagado ordenado. El kubelet manda SIGTERM en rollouts, drain de nodo y scale a 0 (y `docker stop`);
   sin handler Node moria al instante: peticiones en vuelo cortadas, debounce del historial del bus
   (500ms) perdido y marca de arranque siempre "sucia" (falso aviso de caida en cada despliegue).
   Secuencia: readyz pasa a 503 -> se deja de aceptar conexiones -> se espera a las peticiones en
   vuelo -> pasada la gracia se cortan los streams SSE (los clientes reconectan solos a la nueva
   instancia) -> flush del bus -> cierre de Mongo -> marca limpia -> exit 0. Tope duro por debajo del
   terminationGracePeriodSeconds del Deployment (40s). */
const SHUTDOWN_GRACE_MS = Number(process.env.SHUTDOWN_GRACE_MS) || (IN_K8S ? 10_000 : 1_500);
const SHUTDOWN_HARD_MS = Number(process.env.SHUTDOWN_HARD_MS) || 25_000;

async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal}: readyz->503, drenando conexiones (gracia ${SHUTDOWN_GRACE_MS}ms)`);
  setTimeout(() => { console.error('[shutdown] tope duro alcanzado, salida forzada'); process.exit(1); }, SHUTDOWN_HARD_MS).unref();
  const closed = new Promise((resolve) => server.close(resolve));
  server.closeIdleConnections();
  setTimeout(() => server.closeAllConnections(), SHUTDOWN_GRACE_MS).unref();
  await closed;
  try { flushBusHistory?.(); } catch (err) { console.error('[shutdown] flush bus:', err.message); }
  try { await closeMongo(); } catch (err) { console.error('[shutdown] cierre Mongo:', err.message); }
  if (IN_K8S) writeBootFlag({ cleanShutdown: true, stoppedAt: Date.now() });
  console.log('[shutdown] limpio');
  process.exit(0);
}
process.on('SIGTERM', () => { gracefulShutdown('SIGTERM'); });
process.on('SIGINT', () => { gracefulShutdown('SIGINT'); });

const TWIN_PORT = process.env.TWIN_PORT || 5174;
const TWIN_TOKEN = process.env.TWIN_TOKEN;

if (process.env.ENABLE_TWIN_PORT === 'true') {
  const twinApp = express();

  // Twin queda bajo la misma vigilancia Sentinel que el resto de puertos:
  // mismo log forense, mismo rate limit, misma cola de revision de IPs.
  sentinelForensics.attach(twinApp, () => 'twin');

  // Middleware de seguridad soberana para el Twin
  const twinAuthMiddleware = (req, res, next) => {
    const token = req.headers['x-twin-token'];

    if (!TWIN_TOKEN || token !== TWIN_TOKEN) {
      // Registrar el intento de acceso no autorizado en el Bus para Sentinel
      busEmit({
        id: crypto.randomUUID(),
        ts: new Date().toISOString(),
        origin: 'SENTINEL',
        dest: 'TWIN',
        type: 'alert',
        state: 'BLOCKED',
        label: `INTENTO ACCESO TWIN RECHAZADO · IP: ${req.ip}`,
        payload: { path: req.path, method: req.method, userAgent: req.headers['user-agent'] }
      });

      return res.status(401).json({ error: 'Twin Infrastructure: Unauthorized Access' });
    }
    next();
  };

  twinApp.use(twinAuthMiddleware);

  twinApp.get('/health', (_req, res) => res.json({
    status: 'active',
    service: 'twin-elvira-snfi',
    identity: 'authenticated'
  }));

  twinApp.listen(TWIN_PORT, '127.0.0.1', () =>
    console.log(`[Twin] Enlace seguro activo (Requiere x-twin-token) en 127.0.0.1:${TWIN_PORT}`));
}
