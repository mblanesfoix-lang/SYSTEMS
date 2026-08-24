import express from 'express';
import cors from 'cors';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcrypt';
import { connectMongo, getElviraDb, getMongoClient, withTransaction } from './db/mongo.js';
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
import { mountFL } from './fl.js';
import { mountMna } from './mna.js';
import { mountPactvm } from './pactum-viridi.js';
import { mountOps } from './ops.js';
import { mountPaia } from './paia.js';
import { mountOphsCockpit } from './ophs-cockpit.js';
import { mountFoundry } from './foundry.js';
import { createCibeBunker, mountCibeBunker } from './cibe-bunker.js';
import { mountRackState } from './rack-state.js';
import { mountGridInterlink } from './grid-interlink.js';

import { mountAuth } from './routes/auth.routes.js';
import { mountBus } from './routes/bus.routes.js';
import { mountNotifications } from './routes/notifications.routes.js';
import { createElviraStore } from './routes/elvira-store.js';
import { mountReffCrm } from './routes/reff-crm.routes.js';
import { mountFactory } from './routes/factory.routes.js';
import { mountElviraBridges } from './routes/elvira-bridges.routes.js';
import { mountCnmc } from './routes/cnmc.routes.js';
import { mountSentinelForensicRoutes } from './routes/sentinel-forensic.routes.js';
import { mountU2Ree } from './routes/u2-ree.routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FRONT = path.join(ROOT, 'frontend');
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
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

/* Carga de sesiones persistentes */
const SESSIONS = new Map();
if (fs.existsSync(SESSIONS_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    const now = Date.now();
    // Solo cargar sesiones que no hayan expirado
    for (const [k, v] of Object.entries(saved)) {
      if (v.exp > now) SESSIONS.set(k, v);
    }
  } catch { console.warn('[sessions] No se pudieron cargar sesiones previas'); }
}
function saveSessions() { atomicWriteJson(SESSIONS_FILE, Object.fromEntries(SESSIONS)); }

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

// Credenciales: hashes persistidos en data/users.json (gitignored).
// Seed inicial solo si el archivo no existe, desde variables de entorno SEED_*_PASSWORD.
const SEED_USERS = {
  'mblanes@snficorp.com': { password: process.env.SEED_MARC_PASSWORD,    role: 'admin'   },
  'nour@snficorp.com':    { password: process.env.SEED_NOUR_PASSWORD,    role: 'admin'   },
  'ray@snficorp.com':     { password: process.env.SEED_RAY_PASSWORD,     role: 'ray'     },
  'ventures@snficorp.com':{ password: process.env.SEED_AMIR_PASSWORD,    role: 'amir'    },
  'gonzalo@snficorp.com': { password: process.env.SEED_GONZALO_PASSWORD, role: 'gonzalo' },
};

function loadUsers() {
  if (fs.existsSync(USERS_FILE)) {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  }
  const users = {};
  for (const [name, { password, role }] of Object.entries(SEED_USERS)) {
    if (!password) continue;
    users[name] = { passwordHash: bcrypt.hashSync(password, 12), role };
  }
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
  return users;
}
function saveUsers(users) {
  atomicWriteJson(USERS_FILE, users);
}
const USERS = loadUsers();

// Mesas accesibles por rol. 'admin' = todo. Others = whitelist.
const ROLE_MESAS = {
  admin:   ['elvira', 'reff', 'snfiu2', 'ophs', 'sentinel', 'factory', 'finance', 'fl', 'mna', 'pactvm', 'foundry'],
  ray:     ['snfiu2', 'pactvm'],
  amir:    ['reff'],
  gonzalo: ['reff', 'snfiu2', 'pactvm'],
};

// Prefijos de rutas API por mesa (para protección en backend)
const MESA_ROUTES = {
  elvira:   ['/api/elvira/'],
  reff:     ['/api/reff', '/api/sheets', '/api/companies', '/api/search', '/api/linkedin', '/api/email', '/api/overview'],
  snfiu2:   ['/api/snfi-u2/', '/api/u2/'],
  sentinel: ['/api/sentinel', '/api/rack'],
  factory:  ['/api/factory'],
  finance:  ['/api/finance'],
  fl:       ['/api/fl'],
  mna:      ['/api/mna'],
  pactvm:   ['/api/pactvm'],
  ophs:     ['/api/ops', '/api/paia', '/api/ophs-cockpit', '/api/grid'],
  foundry:  ['/api/foundry'],
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
let adminNotify, busEmit, busEmitAlert, busEvents, auth;
// (sseClients del bus no se usa fuera de bus.routes.js; se ignora aquí)

/* Captura cualquier caída no controlada del proceso y la sube a notificaciones Admin */
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  adminNotify({ origin: 'SYSTEM', label: 'Excepción no controlada', detail: err?.stack || err?.message || String(err), severity: 'error' });
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
  adminNotify({ origin: 'SYSTEM', label: 'Promesa rechazada sin manejar', detail: reason?.stack || reason?.message || String(reason), severity: 'error' });
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => req.ip ? ipKeyGenerator(req.ip) : 'anon',
  message: { error: 'Demasiados intentos de login. Espera 15 minutos.' },
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

const sentinelForensics = createSentinelForensics({ mongo, busEmit: (...args) => busEmit(...args) });
app.use(sentinelForensics.middleware(mesaForPath));

/* ---- Notificaciones Admin (mount temprano: adminNotify es dependencia de sentinelLogger/uncaughtException arriba) ---- */
({ adminNotify } = mountNotifications(app, { auth: (req, res, next) => auth(req, res, next), requireAdmin, atomicWriteJson, NOTIFICATIONS_FILE }));

/* ---- Event Bus (mount temprano: busEmit es dependencia compartida por ~10 modulos) ---- */
({ busEvents, busEmit, busEmitAlert } = mountBus(app, {
  auth: (req, res, next) => auth(req, res, next),
  requireAdmin, atomicWriteJson, BUS_HISTORY_FILE, adminNotify,
}));

/* ---------- auth ---------- */
({ auth } = mountAuth(app, {
  authLimiter, sentinelForensics, USERS, SESSIONS, saveUsers, saveSessions,
  ROLE_MESAS, busEmit, busEvents,
}));

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
app.use('/api/fl',        auth, requireMesa('fl'));
app.use('/api/mna',       auth, requireMesa('mna'));
app.use('/api/pactvm',    auth, requireMesa('pactvm'));
app.use('/api/ops',       auth, requireMesa('ophs'));
app.use('/api/paia',      auth, requireMesa('ophs'));
app.use('/api/ophs-cockpit', auth, requireMesa('ophs'));

/* ---------- Rëff CRM-adjacent: sheets/companies/search/linkedin/email/overview ---------- */
const reffCrm = mountReffCrm(app, {
  auth, mongo, withTransaction, adminNotify,
  readElvira, writeElvira,
  HISTORY_FILE, atomicWriteJson, fs,
});

/* ==========================================================================
   S-NFI U2 · energia desperdiciada (REE/ESIOS)
   Se monta aqui (antes de Pactvm/CIBE/.../Elvira Central) porque su snapshot
   diario (getU2SnapshotToday) lo consumen los closures getU2Snapshot pasados
   a mountPactvm y mountElviraCentral mas abajo.
========================================================================== */
const u2Ree = mountU2Ree(app, { auth, busEmit, busEmitAlert, busEvents, atomicWriteJson, DATA_DIR });

/* ==========================================================================
   S-NFI Factory · control cadena de suministro industrial
   Alcance: ensamblaje BioHybrid, logistica materiales, inventario
   componentes mecanicos, ciclo mantenimiento nodos desplegados.
   Datos manuales (CRUD) por ahora; conector ERP/sensores real queda pendiente.
========================================================================== */
mountFactory(app, { mongo });

/* ==========================================================================
   S-NFI Finance · control financiero y valoracion de activos reales
   Tesoreria, flujo caja proyectado, contabilidad analitica, activos reales,
   pasarela cifrada export para asesoria contable externa.
========================================================================== */
mountFinance(app, { auth, requireMesa, mongo });
mountMna(app, { auth, requireMesa, mongo });

/* ==========================================================================
   Pactvm Viridi · guardian doctrinal, cientifico y de cumplimiento bio-ambiental
   Certificado CIBE, politicas medioambientales, condiciones de acceso, lectura
   de auditorias Herzog (db 'reff', sin escritura).
========================================================================== */
mountPactvm(app, {
  auth, requireMesa, mongo, getMongoClient,
  getU2Snapshot: () => u2Ree.getU2SnapshotToday(),
});

/* ==========================================================================
   CIBE Bunker · modulo bunker de Pactvm Viridi (Instrucciones.txt §3)
   Control de admision zero-trust: tokens Ed25519 firmados y fechados para
   los endpoints criticos del OPHS Framework. Sin conformidad CIBE la puerta
   permanece cerrada (Auth-Refusal en log de hash encadenado).
========================================================================== */
const cibe = createCibeBunker({ mongo, busEmit, adminNotify });
cibe.ready().catch((err) => console.error('[CIBE] Error de arranque:', err.message));
mountCibeBunker(app, { auth, requireMesa, mongo, bunker: cibe, busEmit });

/* ==========================================================================
   S-NFI F&L (Fiscal & Legal) · custodia legal del Holding
   NDAs, contratos mercantiles/laborales, cesion de licencias, expediente
   tecnico-juridico Modelo de Utilidad OEPM. Documentos en GridFS.
========================================================================== */
mountFL(app, { auth, requireMesa, mongo, db: mongo });

/* ==========================================================================
   OPHS Framework · OPS (telemetria) + PAIA (analitica predictiva) + Cockpit
   Sub-interfaces del framework OPHS que convergen en la Consola Soberana
   (fusiona OPS+PAIA+Herzog+Sentinel). Doctrina: solo lectura/propuesta, la
   autoridad de ejecucion sigue siendo de cada dominio.
========================================================================== */
mountOps(app, { auth, requireMesa, mongo, cibe });
mountPaia(app, { auth, requireMesa, mongo });
mountOphsCockpit(app, { auth, requireMesa, mongo, getMongoClient });

/* ==========================================================================
   Data Foundry · pipeline de ingesta asincrona (doctrina Instrucciones.txt)
   Ingress Gateway HMAC (puerto embebido o dedicado via FOUNDRY_INGRESS_PORT),
   bus no bloqueante, salas OPS/PAIA/Herzog/U-2 con circuit breaker propio,
   sifon U-2 en worker thread, metricas travel-time vigiladas por Sentinel.
========================================================================== */
mountFoundry(app, { auth, requireMesa, mongo, busEmit, adminNotify, cibe });

/* ==========================================================================
   Rack State · estado distribuido entre racks fisicos (Instrucciones.txt §1)
   Consenso Raft (eleccion + replicacion + commit por mayoria) para puertos
   parametrizados y estados de seguridad. Sin quorum: escrituras bloqueadas,
   lecturas Offline-First del ultimo estado comprometido. Mesa sentinel.
========================================================================== */
const rackState = mountRackState(app, { auth, requireMesa, mongo, busEmit, adminNotify, cibe });

/* ==========================================================================
   Grid Interlink · redes electricas transnacionales (Instrucciones.txt §2)
   Grid Abstraction Layer: un worker thread sandboxed (resourceLimits) por
   pais (REE/REN/RTE/ONEE). El colapso de un TSO no toca a los demas. Mesa ophs.
========================================================================== */
mountGridInterlink(app, { auth, requireMesa, mongo, busEmit, adminNotify, cibe });

/* ==========================================================================
   ELVI-RA · puentes mock (Sentinel/Herzog) + OPHS scoring + T'Controler
========================================================================== */
mountElviraBridges(app, {
  auth, mongo, busEmit, busEvents,
  readElvira, writeElvira, USERS, SESSIONS,
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
  SESSIONS, readElvira, cibe,
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
    const { startWatchCron }               = await import(toFileUrl(path.join(REFF_SERVER, 'watch.js')));

    const reffHealth = (_req, res) => res.json({ status: 'ok', service: 'reff', env: process.env.NODE_ENV || 'development' });

    // Issues a short-lived JWT so el cliente React de Rëff autentica con la sesión de Elvi-Ra, sin login propio
    const ELVIRA_TO_REFF_USERNAME = {
      'mblanes@snficorp.com': 'marc',
      'nour@snficorp.com': 'nour',
      'ventures@snficorp.com': 'amir',
      'gonzalo@snficorp.com': 'gonzalo',
    };
    app.get('/reff/api/guest-token', async (req, res) => {
      const elviraUser = req.headers['x-elvira-user'];
      const normalized = (typeof elviraUser === 'string' && elviraUser.trim()) ? elviraUser.trim().toLowerCase() : '';
      const username = ELVIRA_TO_REFF_USERNAME[normalized] || 'marc';
      const userRow = (await getUserByUsername(username)) || (await getUserByUsername('marc'));
      if (!userRow) return res.status(500).json({ error: 'usuario no encontrado en DB de Rëff' });
      const token = signToken({ userId: userRow.id, username: userRow.username });
      res.json({
        token,
        user: {
          id: userRow.id,
          username: userRow.username,
          displayName: userRow.display_name,
          avatarUrl: userRow.avatar_url ?? null,
        },
      });
    });

    app.get('/reff/api/health', reffHealth);
    app.use('/reff/api/auth', reffAuthRoutes);
    app.use('/reff/api/crm',  reffSheetsRoutes);
    app.use('/reff/api/crm',  reffCompaniesRoutes);
    app.use('/reff/api/geo',  reffGeoRoutes);
    app.use('/reff/api/herzog', reffHerzogRoutes);
    app.use('/reff/api/watch', reffWatchRoutes);

    // Aliases at root /api so Rëff React client (built with base path "/") resolves correctly
    app.get('/api/guest-token', (_req, res) => res.redirect('/reff/api/guest-token'));
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
    app.use('/api/geo',    reffGeoRoutes);
    app.use('/api/herzog', reffHerzogRoutes);
    app.use('/api/watch',  reffWatchRoutes);

    startWatchCron();

    // Serve Rëff React client — assets built with base "/" so /assets/* must be mirrored
    if (fs.existsSync(REFF_CLIENT)) {
      // Wrapper: usa la sesión de Elvi-Ra (elvira_user) para obtener un token de Rëff, lo guarda
      // bajo las claves que espera el cliente React (reff_token / reff_user) y entra al SPA.
      app.get('/reff', (_req, res) => {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(`<!doctype html><html><head><meta charset="UTF-8"><title>Rëff</title></head><body>
<script>
(async () => {
  try {
    const elviraUser = localStorage.getItem('elvira_user') || '';
    const headers = {};
    if (elviraUser) headers['X-Elvira-User'] = elviraUser;
    const r = await fetch('/reff/api/guest-token', { headers });
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
  } catch (err) {
    console.error('[Rëff] Error al integrar — Rëff no disponible:', err.message);
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

const PORT = process.env.PORT || 5173;
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => console.log(`Elvi-Ra running → http://0.0.0.0:${PORT}`));

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
