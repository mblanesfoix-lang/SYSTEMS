import express from 'express';
import cors from 'cors';
import bcrypt from 'bcrypt';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectMongo, getElviraDb, getMongoClient, withTransaction } from './db/mongo.js';
import { createSentinelForensics } from './sentinel-forensics.js';

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
import { callLLM, PRICE_INPUT_PER_M, PRICE_OUTPUT_PER_M, ANTHROPIC_MODEL } from './llm.js';
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

/* ---------- USD -> EUR exchange rate (cached 1h, frankfurter.app, sin API key) ---------- */
let exchangeRateCache = { rate: 0.92, fetchedAt: 0 };
async function getUsdToEurRate() {
  const ONE_HOUR = 60 * 60 * 1000;
  if (Date.now() - exchangeRateCache.fetchedAt < ONE_HOUR) return exchangeRateCache.rate;
  try {
    const r = await fetch('https://api.frankfurter.app/latest?from=USD&to=EUR');
    if (r.ok) {
      const data = await r.json();
      if (data.rates?.EUR) exchangeRateCache = { rate: data.rates.EUR, fetchedAt: Date.now() };
    }
  } catch { /* mantiene ultima tasa conocida */ }
  return exchangeRateCache.rate;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FRONT = path.join(ROOT, 'frontend');
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const HISTORY_FILE = path.join(DATA_DIR, 'search_history.json');
const ELVIRA_FILE = path.join(DATA_DIR, 'elvira.json');
const BUS_HISTORY_FILE = path.join(DATA_DIR, 'bus_history.json');

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

/* ---------- sheet helpers ---------- */
async function ensureUserSheets(user) {
  const count = await mongo.collection('sheets').countDocuments({ user });
  if (count === 0) {
    await mongo.collection('sheets').insertOne({
      _id: crypto.randomUUID(),
      user,
      name: 'Hoja principal',
      createdAt: new Date().toISOString(),
    });
  }
}

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

/* ---- Event Bus ring-buffer (declared early so login/logout hooks can use busEmit) ---- */
const MAX_BUS_EVENTS = 500;
const MAX_BUS_HISTORY = 20000;
const busEvents = [];
const sseClients = new Set();

/* Historial persistente del bus — consultable vía /api/bus/history */
function appendBusHistory(event) {
  let history = [];
  try { history = JSON.parse(fs.readFileSync(BUS_HISTORY_FILE, 'utf8')); }
  catch { history = []; }
  if (!Array.isArray(history)) history = [];
  history.push(event);
  if (history.length > MAX_BUS_HISTORY) history = history.slice(history.length - MAX_BUS_HISTORY);
  atomicWriteJson(BUS_HISTORY_FILE, history);
}
function busEmit(event) {
  busEvents.unshift(event);
  if (busEvents.length > MAX_BUS_EVENTS) busEvents.length = MAX_BUS_EVENTS;
  // Historial persistente solo para movimientos reales: state_update es refresh
  // de un evento ya guardado (no acción nueva), no se duplica en disco.
  if (event._type !== 'state_update') appendBusHistory(event);
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch { sseClients.delete(client); }
  }
}

/* Emite un fallo al bus para que el panel Elvi-Ra lo muestre en rojo */
function busEmitAlert({ origin = 'SYSTEM', dest = 'ELVI-RA', label, detail, user }) {
  busEmit({
    id: crypto.randomUUID(), ts: new Date().toISOString(), seq: busEvents.length + 1,
    origin, dest, type: 'alert', state: 'BLOCKED',
    label, payload: { error: detail }, user,
  });
  adminNotify({ origin, label, detail });
}

/* ---- Notificaciones Admin: cola separada del bus, solo errores/inestabilidad ----
   El bus registra todo el tráfico; esto es la señal curada para el Admin. */
const NOTIFICATIONS_FILE = path.join(DATA_DIR, 'admin_notifications.json');
const MAX_NOTIFICATIONS = 300;
let adminNotifications = [];
if (fs.existsSync(NOTIFICATIONS_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(NOTIFICATIONS_FILE, 'utf8'));
    if (Array.isArray(saved)) adminNotifications = saved.slice(0, MAX_NOTIFICATIONS);
  } catch { console.warn('[notifications] No se pudieron cargar notificaciones previas'); }
}
const adminSseClients = new Set();

function adminNotify({ origin = 'SYSTEM', label, detail, severity = 'error' }) {
  const notif = {
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    origin,
    severity, // 'error' | 'warning'
    label: String(label || '').slice(0, 200),
    detail: detail ? String(detail).slice(0, 500) : '',
    read: false,
  };
  adminNotifications.unshift(notif);
  if (adminNotifications.length > MAX_NOTIFICATIONS) adminNotifications.length = MAX_NOTIFICATIONS;
  atomicWriteJson(NOTIFICATIONS_FILE, adminNotifications);
  const payload = `data: ${JSON.stringify(notif)}\n\n`;
  for (const client of adminSseClients) {
    try { client.write(payload); } catch { adminSseClients.delete(client); }
  }
  return notif;
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

function normalizeTareas(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map(t => {
      if (typeof t === 'string') {
        const text = t.trim();
        if (!text) return null;
        return { id: crypto.randomUUID(), text, done: false, createdAt: new Date().toISOString() };
      }
      if (t && typeof t === 'object') {
        const text = String(t.text || '').trim();
        if (!text) return null;
        return {
          id: typeof t.id === 'string' && t.id ? t.id : crypto.randomUUID(),
          text,
          done: !!t.done,
          createdAt: t.createdAt || new Date().toISOString(),
        };
      }
      return null;
    })
    .filter(Boolean);
}

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

/* ---------- auth ---------- */
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  // EventSource no permite headers personalizados: el stream SSE acepta el token por query string.
  const token = h.startsWith('Bearer ') ? h.slice(7) : (req.path.endsWith('/stream') ? req.query.token : null);
  const s = token && SESSIONS.get(token);
  if (!s || s.exp < Date.now()) return res.status(401).json({ error: 'unauthorized' });
  req.user = s.user;
  req.role = s.role;
  next();
}
app.use(sentinelLogger);

const sentinelForensics = createSentinelForensics({ mongo, busEmit });
app.use(sentinelForensics.middleware(mesaForPath));

app.post('/api/login', authLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  const ip = req.ip || 'unknown';

  if (!username || !String(username).toLowerCase().endsWith('@snficorp.com')) {
    await sentinelForensics.registerLoginAttempt({ ip, username, ok: false, reason: 'dominio_no_autorizado' });
    return res.status(403).json({ error: 'Dominio no autorizado. IP bloqueada por Sentinel.' });
  }

  const u = USERS[username];
  if (!u || !password || !(await bcrypt.compare(password, u.passwordHash))) {
    await sentinelForensics.registerLoginAttempt({ ip, username, ok: false, reason: 'credenciales_invalidas' });
    return res.status(401).json({ error: 'Credenciales inválidas' });
  }
  await sentinelForensics.registerLoginAttempt({ ip, username, ok: true });
  const token = crypto.randomBytes(24).toString('hex');
  SESSIONS.set(token, { user: username, role: u.role, exp: Date.now() + 1000 * 60 * 60 * 8 });
  saveSessions();
  // Bus hook: auth event (busEmit defined later — deferred call safe because Express routes run after all top-level code)
  setImmediate(() => busEmit({
    id: crypto.randomUUID(), ts: new Date().toISOString(), seq: busEvents.length + 1,
    origin: 'SENTINEL', dest: 'ELVI-RA', type: 'event', state: 'COMPLETED',
    label: `LOGIN OK · ${username}`, payload: { user: username, role: u.role }, user: username,
  }));
  res.json({ token, user: username, role: u.role });
});
app.post('/api/logout', auth, (req, res) => {
  const h = req.headers.authorization || '';
  SESSIONS.delete(h.slice(7));
  saveSessions();
  setImmediate(() => busEmit({
    id: crypto.randomUUID(), ts: new Date().toISOString(), seq: busEvents.length + 1,
    origin: 'SENTINEL', dest: 'ELVI-RA', type: 'event', state: 'COMPLETED',
    label: `LOGOUT · ${req.user}`, payload: { user: req.user }, user: req.user,
  }));
  res.json({ ok: true });
});
app.get('/api/me', auth, (req, res) => res.json({ user: req.user, role: req.role }));
app.get('/api/me/permissions', auth, (req, res) => {
  res.json({ mesas: ROLE_MESAS[req.role] || [] });
});

app.post('/api/change-password', auth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'currentPassword y newPassword requeridos' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
  const u = USERS[req.user];
  if (!u || !(await bcrypt.compare(currentPassword, u.passwordHash))) {
    return res.status(401).json({ error: 'Contraseña actual incorrecta' });
  }
  u.passwordHash = await bcrypt.hash(newPassword, 12);
  saveUsers(USERS);
  busEmit({
    id: crypto.randomUUID(), ts: new Date().toISOString(), seq: busEvents.length + 1,
    origin: 'SENTINEL', dest: 'ELVI-RA', type: 'event', state: 'COMPLETED',
    label: `PASSWORD_CHANGE · ${req.user}`, payload: { user: req.user }, user: req.user,
  });
  res.json({ ok: true });
});

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

/* ---------- sheets ---------- */
app.get('/api/sheets', auth, async (req, res) => {
  await ensureUserSheets(req.user);
  const rows = await mongo.collection('sheets').aggregate([
    { $match: { user: req.user } },
    { $lookup: {
        from: 'companies',
        localField: '_id',
        foreignField: 'sheetId',
        as: 'companies',
    } },
    { $addFields: { count: { $size: '$companies' } } },
    { $project: { companies: 0 } },
  ]).toArray();
  res.json(rows.map(r => ({ id: r._id, user: r.user, name: r.name, createdAt: r.createdAt, count: r.count })));
});

app.post('/api/sheets', auth, async (req, res) => {
  const name = String((req.body || {}).name || '').trim();
  if (!name) return res.status(400).json({ error: 'nombre requerido' });
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  await mongo.collection('sheets').insertOne({ _id: id, user: req.user, name, createdAt });
  res.status(201).json({ id, name, count: 0, createdAt });
});

app.delete('/api/sheets/:sid', auth, async (req, res) => {
  const userSheetCount = await mongo.collection('sheets').countDocuments({ user: req.user });
  if (userSheetCount <= 1) return res.status(400).json({ error: 'no se puede eliminar la única hoja' });

  const sheet = await mongo.collection('sheets').findOne({ _id: req.params.sid, user: req.user });
  if (!sheet) return res.status(404).json({ error: 'hoja no encontrada' });

  await withTransaction(async (session) => {
    await mongo.collection('companies').deleteMany({ sheetId: req.params.sid }, { session });
    await mongo.collection('sheets').deleteOne({ _id: req.params.sid, user: req.user }, { session });
  });
  res.json({ id: req.params.sid });
});

/* ---------- companies ---------- */
app.get('/api/sheets/:sid/companies', auth, async (req, res) => {
  const sheet = await mongo.collection('sheets').findOne({ _id: req.params.sid, user: req.user });
  if (!sheet) return res.json([]);
  const rows = await mongo.collection('companies').find({ sheetId: req.params.sid }).toArray();
  res.json(rows.map(r => ({ ...r, id: r._id, tareas: r.tareas || [] })));
});

app.post('/api/sheets/:sid/companies', auth, async (req, res) => {
  const sheet = await mongo.collection('sheets').findOne({ _id: req.params.sid, user: req.user });
  if (!sheet) return res.status(404).json({ error: 'hoja no encontrada' });

  const b = req.body || {};
  const c = {
    _id: crypto.randomUUID(),
    sheetId: req.params.sid,
    nodo: String(b.nodo || '').trim(),
    sector: String(b.sector || '').trim(),
    ubicacion: String(b.ubicacion || '').trim(),
    ophs: Number(b.ophs ?? 0),
    bssMwh: Number(b.bssMwh ?? 0),
    cnmc: String(b.cnmc || 'OK').trim(),
    dictamen: b.dictamen, notas: b.notas, tipoResiduo: b.tipoResiduo,
    volumenResiduoT: b.volumenResiduoT, plantas: b.plantas, empleados: b.empleados,
    facturacionM: b.facturacionM, pagaGestion: b.pagaGestion, esg: b.esg,
    tareas: normalizeTareas(b.tareas),
    createdAt: new Date().toISOString(),
    source: 'manual'
  };

  if (!c.nodo) return res.status(400).json({ error: 'nodo requerido' });

  await mongo.collection('companies').insertOne(c);

  res.status(201).json({ ...c, id: c._id });
});

app.put('/api/sheets/:sid/companies/:cid', auth, async (req, res) => {
  const c = await mongo.collection('companies').findOne({ _id: req.params.cid });
  if (!c) return res.status(404).json({ error: 'empresa no encontrada' });
  const sheet = await mongo.collection('sheets').findOne({ _id: c.sheetId, user: req.user });
  if (!sheet) return res.status(404).json({ error: 'empresa no encontrada' });

  const allowed = ['nodo','sector','ubicacion','ophs','bssMwh','cnmc','dictamen','notas','tareas','tipoResiduo','volumenResiduoT','plantas','empleados','facturacionM','pagaGestion','esg'];
  const $set = {};
  for (const k of allowed) {
    if (k in req.body) {
      $set[k] = k === 'tareas' ? normalizeTareas(req.body[k]) : req.body[k];
    }
  }

  if (Object.keys($set).length > 0) {
    await mongo.collection('companies').updateOne({ _id: req.params.cid }, { $set });
  }

  const updated = await mongo.collection('companies').findOne({ _id: req.params.cid });
  res.json({ ...updated, id: updated._id, tareas: updated.tareas || [] });
});

app.delete('/api/sheets/:sid/companies/:cid', auth, async (req, res) => {
  const c = await mongo.collection('companies').findOne({ _id: req.params.cid });
  if (!c) return res.status(404).json({ error: 'empresa no encontrada' });
  const sheet = await mongo.collection('sheets').findOne({ _id: c.sheetId, user: req.user });
  if (!sheet) return res.status(404).json({ error: 'empresa no encontrada' });

  await mongo.collection('companies').deleteOne({ _id: req.params.cid });
  res.json({ id: req.params.cid });
});

/* move company between sheets */
app.post('/api/companies/:cid/move', auth, async (req, res) => {
  const { fromSheetId, toSheetId } = req.body || {};
  if (!fromSheetId || !toSheetId) return res.status(400).json({ error: 'fromSheetId/toSheetId requeridos' });

  const sheet = await mongo.collection('sheets').findOne({ _id: fromSheetId, user: req.user });
  if (!sheet) return res.status(404).json({ error: 'no se pudo mover la empresa' });

  const result = await mongo.collection('companies').updateOne(
    { _id: req.params.cid, sheetId: fromSheetId },
    { $set: { sheetId: toSheetId } },
  );

  if (result.matchedCount === 0) return res.status(404).json({ error: 'no se pudo mover la empresa' });
  res.json({ id: req.params.cid, sheetId: toSheetId });
});

/* aggregate for Dashboard General across all sheets */
app.get('/api/overview', auth, async (req, res) => {
  const sheets = await mongo.collection('sheets').find({ user: req.user }).project({ _id: 1, name: 1 }).toArray();
  const sheetIds = sheets.map(s => s._id);

  const [stats] = await mongo.collection('companies').aggregate([
    { $match: { sheetId: { $in: sheetIds } } },
    { $group: {
        _id: null,
        totalCompanies: { $sum: 1 },
        totalBss: { $sum: '$bssMwh' },
        avgOphs: { $avg: '$ophs' },
        cnmcRiesgo: { $sum: { $cond: [{ $ne: ['$cnmc', 'OK'] }, 1, 0] } },
    } },
  ]).toArray();

  const top = await mongo.collection('companies').aggregate([
    { $match: { sheetId: { $in: sheetIds } } },
    { $lookup: { from: 'sheets', localField: 'sheetId', foreignField: '_id', as: 'sheet' } },
    { $addFields: { sheetName: { $first: '$sheet.name' } } },
    { $project: { sheet: 0 } },
    { $sort: { ophs: -1 } },
    { $limit: 5 },
  ]).toArray();

  res.json({
    sheets: sheets.length,
    companies: stats?.totalCompanies || 0,
    totalBssMwh: Number((stats?.totalBss || 0).toFixed(1)),
    avgOphs: Math.round(stats?.avgOphs || 0),
    cnmcRiesgo: stats?.cnmcRiesgo || 0,
    top: top.map(t => ({ ...t, id: t._id, tareas: t.tareas || [] })),
  });
});

/* ==========================================================================
   S-NFI Factory · control cadena de suministro industrial
   Alcance: ensamblaje BioHybrid, logistica materiales, inventario
   componentes mecanicos, ciclo mantenimiento nodos desplegados.
   Datos manuales (CRUD) por ahora; conector ERP/sensores real queda pendiente.
========================================================================== */

const FACTORY_ASSEMBLY_STAGES = ['recepcion', 'mecanizado', 'integracion', 'qa', 'listo_envio'];
const FACTORY_ASSEMBLY_STATUSES = ['en_curso', 'parado', 'bloqueado', 'completado'];
const FACTORY_LOGISTICS_STATUSES = ['pedido', 'transito', 'recibido', 'incidencia'];
const FACTORY_MAINTENANCE_TYPES = ['preventivo', 'correctivo', 'inspeccion'];
const FACTORY_MAINTENANCE_STATUSES = ['programado', 'en_curso', 'completado'];

function withId(doc) {
  if (!doc) return doc;
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
}

/* ---- Ensamblaje ---- */
app.get('/api/factory/assembly', async (req, res) => {
  const rows = await mongo.collection('factory_assembly').find({}).sort({ _id: -1 }).toArray();
  res.json(rows.map(withId));
});

app.post('/api/factory/assembly', async (req, res) => {
  const b = req.body || {};
  const nodeRef = String(b.nodeRef || '').trim();
  if (!nodeRef) return res.status(400).json({ error: 'nodeRef requerido' });
  const stage = FACTORY_ASSEMBLY_STAGES.includes(b.stage) ? b.stage : 'recepcion';
  const now = new Date().toISOString();
  const doc = {
    _id: crypto.randomUUID(),
    nodeRef,
    stage,
    status: 'en_curso',
    startedAt: now,
    eta: typeof b.eta === 'string' ? b.eta : null,
    blockerNote: typeof b.blockerNote === 'string' ? b.blockerNote : null,
    createdBy: req.user,
    updatedAt: now,
  };
  await mongo.collection('factory_assembly').insertOne(doc);
  res.status(201).json(withId(doc));
});

app.patch('/api/factory/assembly/:id', async (req, res) => {
  const row = await mongo.collection('factory_assembly').findOne({ _id: req.params.id });
  if (!row) return res.status(404).json({ error: 'registro no encontrado' });

  const b = req.body || {};
  const $set = { updatedAt: new Date().toISOString() };
  if (b.nodeRef !== undefined) {
    if (!String(b.nodeRef).trim()) return res.status(400).json({ error: 'nodeRef invalido' });
    $set.nodeRef = String(b.nodeRef).trim();
  }
  if (b.stage !== undefined) {
    if (!FACTORY_ASSEMBLY_STAGES.includes(b.stage)) return res.status(400).json({ error: 'stage invalido' });
    $set.stage = b.stage;
  }
  if (b.status !== undefined) {
    if (!FACTORY_ASSEMBLY_STATUSES.includes(b.status)) return res.status(400).json({ error: 'status invalido' });
    $set.status = b.status;
  }
  if (b.eta !== undefined) $set.eta = typeof b.eta === 'string' ? b.eta : null;
  if (b.blockerNote !== undefined) $set.blockerNote = typeof b.blockerNote === 'string' ? b.blockerNote : null;

  await mongo.collection('factory_assembly').updateOne({ _id: req.params.id }, { $set });
  const updated = await mongo.collection('factory_assembly').findOne({ _id: req.params.id });
  res.json(withId(updated));
});

app.delete('/api/factory/assembly/:id', async (req, res) => {
  const result = await mongo.collection('factory_assembly').deleteOne({ _id: req.params.id });
  if (result.deletedCount === 0) return res.status(404).json({ error: 'registro no encontrado' });
  res.json({ id: req.params.id });
});

/* ---- Logistica de materiales ---- */
app.get('/api/factory/logistics', async (req, res) => {
  const rows = await mongo.collection('factory_logistics').find({}).sort({ _id: -1 }).toArray();
  res.json(rows.map(withId));
});

app.post('/api/factory/logistics', async (req, res) => {
  const b = req.body || {};
  const material = String(b.material || '').trim();
  if (!material) return res.status(400).json({ error: 'material requerido' });
  const qty = Number(b.qty);
  if (!Number.isFinite(qty) || qty < 0) return res.status(400).json({ error: 'qty invalido' });
  const unit = String(b.unit || '').trim();
  if (!unit) return res.status(400).json({ error: 'unit requerido' });
  const now = new Date().toISOString();
  const doc = {
    _id: crypto.randomUUID(),
    material,
    supplier: typeof b.supplier === 'string' ? b.supplier : null,
    qty,
    unit,
    origin: typeof b.origin === 'string' ? b.origin : null,
    destination: typeof b.destination === 'string' ? b.destination : null,
    status: 'pedido',
    eta: typeof b.eta === 'string' ? b.eta : null,
    trackingRef: typeof b.trackingRef === 'string' ? b.trackingRef : null,
    createdBy: req.user,
    updatedAt: now,
  };
  await mongo.collection('factory_logistics').insertOne(doc);
  res.status(201).json(withId(doc));
});

app.patch('/api/factory/logistics/:id', async (req, res) => {
  const row = await mongo.collection('factory_logistics').findOne({ _id: req.params.id });
  if (!row) return res.status(404).json({ error: 'envio no encontrado' });

  const b = req.body || {};
  const $set = { updatedAt: new Date().toISOString() };
  if (b.material !== undefined) {
    if (!String(b.material).trim()) return res.status(400).json({ error: 'material invalido' });
    $set.material = String(b.material).trim();
  }
  if (b.supplier !== undefined) $set.supplier = typeof b.supplier === 'string' ? b.supplier : null;
  if (b.qty !== undefined) {
    const qty = Number(b.qty);
    if (!Number.isFinite(qty) || qty < 0) return res.status(400).json({ error: 'qty invalido' });
    $set.qty = qty;
  }
  if (b.unit !== undefined) {
    if (!String(b.unit).trim()) return res.status(400).json({ error: 'unit invalido' });
    $set.unit = String(b.unit).trim();
  }
  if (b.origin !== undefined) $set.origin = typeof b.origin === 'string' ? b.origin : null;
  if (b.destination !== undefined) $set.destination = typeof b.destination === 'string' ? b.destination : null;
  if (b.status !== undefined) {
    if (!FACTORY_LOGISTICS_STATUSES.includes(b.status)) return res.status(400).json({ error: 'status invalido' });
    $set.status = b.status;
  }
  if (b.eta !== undefined) $set.eta = typeof b.eta === 'string' ? b.eta : null;
  if (b.trackingRef !== undefined) $set.trackingRef = typeof b.trackingRef === 'string' ? b.trackingRef : null;

  await mongo.collection('factory_logistics').updateOne({ _id: req.params.id }, { $set });
  const updated = await mongo.collection('factory_logistics').findOne({ _id: req.params.id });
  res.json(withId(updated));
});

app.delete('/api/factory/logistics/:id', async (req, res) => {
  const result = await mongo.collection('factory_logistics').deleteOne({ _id: req.params.id });
  if (result.deletedCount === 0) return res.status(404).json({ error: 'envio no encontrado' });
  res.json({ id: req.params.id });
});

/* ---- Inventario de componentes ---- */
app.get('/api/factory/inventory', async (req, res) => {
  const rows = await mongo.collection('factory_inventory').find({}).sort({ componentName: 1 }).toArray();
  res.json(rows.map(r => ({ ...withId(r), lowStock: r.qtyStock < r.minThreshold })));
});

app.post('/api/factory/inventory', async (req, res) => {
  const b = req.body || {};
  const componentName = String(b.componentName || '').trim();
  if (!componentName) return res.status(400).json({ error: 'componentName requerido' });
  const category = String(b.category || '').trim();
  if (!category) return res.status(400).json({ error: 'category requerido' });
  const now = new Date().toISOString();
  const doc = {
    _id: crypto.randomUUID(),
    componentName,
    category,
    qtyStock: Number.isFinite(Number(b.qtyStock)) && Number(b.qtyStock) >= 0 ? Number(b.qtyStock) : 0,
    qtyReserved: Number.isFinite(Number(b.qtyReserved)) && Number(b.qtyReserved) >= 0 ? Number(b.qtyReserved) : 0,
    minThreshold: Number.isFinite(Number(b.minThreshold)) && Number(b.minThreshold) >= 0 ? Number(b.minThreshold) : 0,
    location: typeof b.location === 'string' ? b.location : null,
    unitCost: Number.isFinite(Number(b.unitCost)) ? Number(b.unitCost) : null,
    createdBy: req.user,
    updatedAt: now,
  };
  await mongo.collection('factory_inventory').insertOne(doc);
  res.status(201).json({ ...withId(doc), lowStock: doc.qtyStock < doc.minThreshold });
});

app.patch('/api/factory/inventory/:id', async (req, res) => {
  const row = await mongo.collection('factory_inventory').findOne({ _id: req.params.id });
  if (!row) return res.status(404).json({ error: 'componente no encontrado' });

  const b = req.body || {};
  const $set = { updatedAt: new Date().toISOString() };
  if (b.componentName !== undefined) {
    if (!String(b.componentName).trim()) return res.status(400).json({ error: 'componentName invalido' });
    $set.componentName = String(b.componentName).trim();
  }
  if (b.category !== undefined) {
    if (!String(b.category).trim()) return res.status(400).json({ error: 'category invalido' });
    $set.category = String(b.category).trim();
  }
  for (const field of ['qtyStock', 'qtyReserved', 'minThreshold']) {
    if (b[field] !== undefined) {
      const n = Number(b[field]);
      if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: `${field} invalido` });
      $set[field] = n;
    }
  }
  if (b.location !== undefined) $set.location = typeof b.location === 'string' ? b.location : null;
  if (b.unitCost !== undefined) $set.unitCost = Number.isFinite(Number(b.unitCost)) ? Number(b.unitCost) : null;

  await mongo.collection('factory_inventory').updateOne({ _id: req.params.id }, { $set });
  const updated = await mongo.collection('factory_inventory').findOne({ _id: req.params.id });
  res.json({ ...withId(updated), lowStock: updated.qtyStock < updated.minThreshold });
});

app.delete('/api/factory/inventory/:id', async (req, res) => {
  const result = await mongo.collection('factory_inventory').deleteOne({ _id: req.params.id });
  if (result.deletedCount === 0) return res.status(404).json({ error: 'componente no encontrado' });
  res.json({ id: req.params.id });
});

/* ---- Mantenimiento de nodos desplegados ---- */
app.get('/api/factory/maintenance', async (req, res) => {
  const rows = await mongo.collection('factory_maintenance').find({}).sort({ scheduledAt: 1 }).toArray();
  const now = Date.now();
  res.json(rows.map(r => ({ ...withId(r), overdue: r.status !== 'completado' && new Date(r.scheduledAt).getTime() < now })));
});

app.post('/api/factory/maintenance', async (req, res) => {
  const b = req.body || {};
  const nodeId = String(b.nodeId || '').trim();
  if (!nodeId) return res.status(400).json({ error: 'nodeId requerido' });
  if (!FACTORY_MAINTENANCE_TYPES.includes(b.type)) return res.status(400).json({ error: 'type invalido' });
  const scheduledAt = String(b.scheduledAt || '');
  if (!scheduledAt) return res.status(400).json({ error: 'scheduledAt requerido' });
  const now = new Date().toISOString();
  const doc = {
    _id: crypto.randomUUID(),
    nodeId,
    type: b.type,
    status: 'programado',
    scheduledAt,
    completedAt: null,
    technician: typeof b.technician === 'string' ? b.technician : null,
    notes: typeof b.notes === 'string' ? b.notes : null,
    createdBy: req.user,
    updatedAt: now,
  };
  await mongo.collection('factory_maintenance').insertOne(doc);
  res.status(201).json({ ...withId(doc), overdue: false });
});

app.patch('/api/factory/maintenance/:id', async (req, res) => {
  const row = await mongo.collection('factory_maintenance').findOne({ _id: req.params.id });
  if (!row) return res.status(404).json({ error: 'mantenimiento no encontrado' });

  const b = req.body || {};
  const $set = { updatedAt: new Date().toISOString() };
  if (b.nodeId !== undefined) {
    if (!String(b.nodeId).trim()) return res.status(400).json({ error: 'nodeId invalido' });
    $set.nodeId = String(b.nodeId).trim();
  }
  if (b.type !== undefined) {
    if (!FACTORY_MAINTENANCE_TYPES.includes(b.type)) return res.status(400).json({ error: 'type invalido' });
    $set.type = b.type;
  }
  if (b.status !== undefined) {
    if (!FACTORY_MAINTENANCE_STATUSES.includes(b.status)) return res.status(400).json({ error: 'status invalido' });
    $set.status = b.status;
    if (b.status === 'completado') $set.completedAt = new Date().toISOString();
  }
  if (b.scheduledAt !== undefined) {
    if (!String(b.scheduledAt).trim()) return res.status(400).json({ error: 'scheduledAt invalido' });
    $set.scheduledAt = b.scheduledAt;
  }
  if (b.technician !== undefined) $set.technician = typeof b.technician === 'string' ? b.technician : null;
  if (b.notes !== undefined) $set.notes = typeof b.notes === 'string' ? b.notes : null;

  await mongo.collection('factory_maintenance').updateOne({ _id: req.params.id }, { $set });
  const updated = await mongo.collection('factory_maintenance').findOne({ _id: req.params.id });
  res.json({ ...withId(updated), overdue: updated.status !== 'completado' && new Date(updated.scheduledAt).getTime() < Date.now() });
});

app.delete('/api/factory/maintenance/:id', async (req, res) => {
  const result = await mongo.collection('factory_maintenance').deleteOne({ _id: req.params.id });
  if (result.deletedCount === 0) return res.status(404).json({ error: 'mantenimiento no encontrado' });
  res.json({ id: req.params.id });
});

/* ---- Resumen KPI ---- */
app.get('/api/factory/summary', async (req, res) => {
  const nowIso = new Date().toISOString();
  const [assemblyActive, logisticsIncidents, inventoryLow, maintenanceOverdue] = await Promise.all([
    mongo.collection('factory_assembly').countDocuments({ status: 'en_curso' }),
    mongo.collection('factory_logistics').countDocuments({ status: 'incidencia' }),
    mongo.collection('factory_inventory').countDocuments({ $expr: { $lt: ['$qtyStock', '$minThreshold'] } }),
    mongo.collection('factory_maintenance').countDocuments({ status: { $ne: 'completado' }, scheduledAt: { $lt: nowIso } }),
  ]);
  res.json({ assemblyActive, logisticsIncidents, inventoryLow, maintenanceOverdue });
});

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
  getU2Snapshot: () => {
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

/* ---------- search history (per user, 48h) ---------- */
function readHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); }
  catch { return {}; }
}
function writeHistory(h) { atomicWriteJson(HISTORY_FILE, h); }
function pruneHistory(arr) {
  const cutoff = Date.now() - 48 * 3600 * 1000;
  return arr.filter(x => new Date(x.createdAt).getTime() >= cutoff);
}

app.get('/api/search/history', auth, (req, res) => {
  const h = readHistory();
  const list = pruneHistory(h[req.user] || []);
  h[req.user] = list;
  writeHistory(h);
  res.json(list);
});

app.delete('/api/search/history/:hid', auth, (req, res) => {
  const h = readHistory();
  const list = pruneHistory(h[req.user] || []);
  const idx = list.findIndex(x => x.id === req.params.hid);
  if (idx < 0) return res.status(404).json({ error: 'no encontrada' });
  list.splice(idx, 1);
  h[req.user] = list;
  writeHistory(h);
  res.json({ ok: true });
});

/* ---------- IA search (Claude) ---------- */
const SYSTEM_PROMPT = `Eres el Agente S-NFI (South Navarre Fresh Innovations) integrado en Elvi-Ra. Tu trabajo: detectar Nodos de Integración Potencial (no "leads").

REGLAS DURAS de inclusión:
- Volumen de residuo orgánico anual > 8 toneladas.
- Residuo 100% orgánico (no mezclas con plástico/químico).
- Modelo B2B o B2C compatible con S-NFI BioHybrid.

VARIABLES CRÍTICAS por empresa:
- Variable B (BSS & Resilience): estima MWh de Battery Storage para 48h autonomía post-apagón. Penaliza si la empresa no tiene espacio/capacidad para BSS (vulnerabilidad CNMC).
- Variable G (Gobernanza Herzog): si la empresa está hipotecada con eléctrica tradicional o no permite modelos OEM → TÓXICO, bloquear.
- Variable U-2 (Reto Científico): si el residuo es complejo y requiere I+D S-NFI U-2, sube valor estratégico.

PENALIZACIÓN FUERTE / DESCARTE si:
- Dependencia de Biogás/Anaerobia (competencia/lastre).
- Opacidad CNMC o sanciones previas.
- Estructura jerárquica incompatible con Gobernanza Externa OPHS.

Para cada empresa devuelve PUNTUACIÓN OPHS (0-100) basada en compatibilidad global.

DATOS DE FICHA EXIGIDOS por empresa. REGLA DURA: TODOS los campos numéricos (volumenResiduoT, plantas, empleados, facturacionM) deben ir RELLENOS con un número estimado. Prohibido devolver null o 0 sin justificar. Si no hay dato exacto, ESTIMA con razonamiento sectorial usando los siguientes proxies:

PROTOCOLO DE ESTIMACIÓN (obligatorio aplicar antes de devolver):
1. Buscar dato público (web corporativa, eInforma, registro mercantil ES, SABI, Crunchbase, LinkedIn, Bloomberg, memoria anual, informe sostenibilidad GRI/ESG).
2. Si no hay público: estimar por benchmarks sectoriales:
   • Facturación → cruzar con tamaño plantilla (ratio sectorial: agroalimentario ~150-250 k€/empleado, vinícola ~120-180 k€/empleado, cárnico ~200-300 k€/empleado).
   • Empleados → buscar en LinkedIn "company size" o estimar desde facturación.
   • Plantas → web corporativa "nuestras instalaciones" / "centros productivos". Mínimo 1.
   • Volumen residuo → derivar de facturación + sector usando intensidad de residuo orgánico típica (vinícola: 0.3-0.5 T residuo / 1 T uva; cárnico: 0.4-0.6 T residuo / 1 T producto; lácteo: 0.9 L suero / 1 L leche).
3. Devolver el número estimado. Marcar la incertidumbre en "fuentes" (campo opcional).
4. Solo usar "DESCONOCIDO" en campos string (tipoResiduo, esg, pagaGestion). NUNCA en numéricos.

CAMPOS:
- tipoResiduo: categoría dominante del residuo orgánico (string, obligatorio rellenar).
- volumenResiduoT: toneladas/año totales de residuo orgánico (número, > 8, obligatorio).
- plantas: número de centros productivos (entero, mínimo 1, obligatorio).
- empleados: plantilla total estimada (entero, obligatorio).
- facturacionM: facturación anual estimada en M€ (número con 1 decimal, obligatorio).
- pagaGestion: SI si paga gestor externo de residuos hoy / NO si autogestiona / DESCONOCIDO solo si no hay señal alguna. Heurística: empresas >100 empleados sin planta propia de tratamiento → SI por defecto.
- esg: rating público (MSCI, Sustainalytics, S&P Global) o nota cualitativa ('sin reporte público', 'memoria GRI sin rating', 'greenwashing detectado', 'B Corp', 'ISO 14001').

Para candidatos ESTRATÉGICOS (OPHS >= 70) genera dictamen segmentado: IIA (transparencia datos públicos), Factory (m² planta vs unidad BioHybrid), Finance (ROI in-situ vs transporte), Pactvm Viridi/CIBE (sello circular).

SALIDA: SOLO JSON válido, sin markdown, sin texto extra. Schema:
{
  "results": [
    {
      "nodo": "string (nombre empresa)",
      "sector": "string",
      "ubicacion": "Ciudad, País",
      "ophs": 0-100,
      "bssMwh": number (MWh estimados 48h),
      "cnmc": "OK" | "RIESGO" | "SANCION",
      "variableB": "string (resumen BSS/resilience)",
      "variableG": "string (gobernanza Herzog)",
      "variableU2": "string (reto U-2)",
      "porQue": "string (por qué el sistema la detecta como buena empresa)",
      "tipoResiduo": "string (categoría residuo orgánico: vinaza, orujo, suero lácteo, restos cárnicos, FORM, hortofrutícola, etc.)",
      "volumenResiduoT": number (toneladas/año estimadas, residuo orgánico),
      "residuoAnualT": number (alias retrocompatible de volumenResiduoT),
      "plantas": number (número de plantas/centros productivos),
      "empleados": number (plantilla total estimada),
      "facturacionM": number (facturación anual estimada en millones de euros),
      "pagaGestion": "SI" | "NO" | "DESCONOCIDO" (si actualmente paga a un gestor externo por el residuo),
      "esg": "string (rating ESG público o nota corta: ej. 'A', 'B+', 'sin reporte', 'greenwashing detectado')",
      "fuentes": ["string (fuente o proxy usado para estimar, ej. 'eInforma 2024', 'LinkedIn size band', 'estimación sectorial vinícola')"],
      "modelo": "B2B" | "B2C" | "B2B/B2C",
      "dictamen": {
        "iia": "string",
        "factory": "string",
        "finance": "string",
        "pactvm": "string"
      },
      "descartar": boolean,
      "razonDescarte": "string o vacío"
    }
  ],
  "resumen": "string corto del barrido"
}

EJEMPLO de ficha completa correcta (referencia de estilo y profundidad de relleno):
{
  "nodo": "Bodegas García Carrión",
  "sector": "Vinícola",
  "ubicacion": "Jumilla, España",
  "ophs": 78,
  "bssMwh": 4.5,
  "cnmc": "OK",
  "tipoResiduo": "Orujo + lías + raspón (vinaza)",
  "volumenResiduoT": 95000,
  "plantas": 7,
  "empleados": 1100,
  "facturacionM": 825,
  "pagaGestion": "SI",
  "esg": "Memoria sostenibilidad publicada, sin rating MSCI",
  "fuentes": ["web corporativa centros productivos", "eInforma 2023", "estimación sectorial vinícola 0.4 T residuo/T uva"],
  "modelo": "B2B/B2C",
  "porQue": "Mayor bodega europea, alto volumen residuo concentrado, 7 plantas con espacio físico para BSS, sin dependencia biogás",
  "variableB": "Espacio amplio en planta Jumilla para BSS 4-5 MWh; resiliencia 48h viable",
  "variableG": "Estructura familiar, sin PPA largo plazo con eléctrica → gobernanza OEM compatible",
  "variableU2": "Orujo estándar, no requiere I+D U-2 salvo subproducto enológico específico",
  "dictamen": { "iia": "Memoria GRI publica, datos volúmenes plausibles", "factory": "Jumilla 15.000 m² → unidad BioHybrid L cabe", "finance": "Ahorro logístico ~280 k€/año vs transporte gestor", "pactvm": "Apta sello CIBE tras NDA y auditoría F4 Herzog" },
  "descartar": false,
  "razonDescarte": ""
}

Si no encuentras candidatos reales con datos públicos verificables, devuelve results vacío y explica en resumen. Nunca inventes datos financieros precisos como cifras exactas con decimales no soportados; pero SIEMPRE estima con un número plausible y registra el proxy en "fuentes". Campos numéricos null/0 = error crítico.`;

function trackTokens(user, operation, inputTokens, outputTokens) {
  const state = readElvira();
  const tc = state.systems.tcontroler;
  if (!tc.byUser) tc.byUser = {};
  if (!tc.byUser[user]) tc.byUser[user] = { inputTokens: 0, outputTokens: 0, calls: 0, operations: {} };
  const u = tc.byUser[user];
  u.inputTokens  += inputTokens;
  u.outputTokens += outputTokens;
  u.calls        += 1;
  if (!u.operations[operation]) u.operations[operation] = { inputTokens: 0, outputTokens: 0, calls: 0 };
  u.operations[operation].inputTokens  += inputTokens;
  u.operations[operation].outputTokens += outputTokens;
  u.operations[operation].calls        += 1;
  u.lastCall = new Date().toISOString();
  // global totals
  const allUsers = Object.values(tc.byUser);
  tc.tokensUsed = allUsers.reduce((s, x) => s + x.inputTokens + x.outputTokens, 0);
  writeElvira(state);
}

async function callLLMTracked(systemPrompt, userPrompt, maxTokens = 4096, user = null, operation = 'unknown') {
  const result = await callLLM(systemPrompt, userPrompt, maxTokens);
  if (user) {
    trackTokens(user, operation, result.inputTokens, result.outputTokens);
  }
  return result.text;
}
const callClaude = (userPrompt, user) => callLLMTracked(SYSTEM_PROMPT, userPrompt, 8192, user, 'search');

function extractJson(text) {
  let s = text.trim();
  // Limpiar posibles bloques de markdown antes y después
  s = s.replace(/^[^{]*/, '').replace(/[^}]*$/, '');
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first < 0 || last < 0) throw new Error('respuesta IA sin JSON');
  try {
    return JSON.parse(s.slice(first, last + 1));
  } catch (e) {
    throw new Error('JSON de la IA mal formado: ' + e.message);
  }
}

app.post('/api/search', auth, async (req, res) => {
  try {
    const f = req.body || {};
    const continente = String(f.continente || '').trim();
    const pais       = String(f.pais || '').trim();
    const ciudad     = String(f.ciudad || '').trim();
    const sectoresArr= Array.isArray(f.sectores) ? f.sectores.filter(Boolean).map(String) : [];
    const sector     = sectoresArr.length ? sectoresArr.join(', ') : String(f.sector || '').trim();
    const modelo     = String(f.modelo || 'B2B/B2C').trim();
    const minResiduoT= 8; // suelo duro S-NFI: > 8 T/año residuo orgánico
    const maxResults = Math.min(Math.max(Number(f.maxResults ?? 6), 1), 12);
    const extra      = String(f.extra || '').trim();

    const userPrompt = `BARRIDO de Nodos de Integración Potencial para S-NFI.

FILTROS JURISDICCIÓN:
- Continente: ${continente || 'cualquiera'}
- País: ${pais || 'cualquiera'}
- Ciudad/Región: ${ciudad || 'cualquiera'}

FILTROS DE ELEGIBILIDAD:
- Volumen mínimo residuo orgánico anual: ${minResiduoT} T/año
- Residuo: 100% orgánico
- Modelo: ${modelo}
- Sector preferido: ${sector || 'agroalimentario, vinícola, ganadero, hortofrutícola, conservero, lácteo, cárnico, panificación industrial, restauración colectiva'}

CONTEXTO ADICIONAL DEL OPERADOR: ${extra || '(ninguno)'}

Devuelve hasta ${maxResults} empresas REALES (con nombre verificable) que encajen. PREFIERE profundidad sobre cantidad: mejor 3 empresas con ficha completa que 8 a medias.

CHECKLIST OBLIGATORIO antes de emitir JSON (revisa empresa a empresa):
[ ] nodo es nombre real verificable, no genérico.
[ ] tipoResiduo no está vacío.
[ ] volumenResiduoT es número > 8 (no null, no 0).
[ ] plantas es entero >= 1.
[ ] empleados es entero > 0.
[ ] facturacionM es número > 0.
[ ] pagaGestion es SI, NO o DESCONOCIDO (preferir SI/NO).
[ ] esg tiene texto descriptivo, no vacío.
[ ] fuentes lista al menos 1 proxy/fuente.

Si un campo no se puede estimar ni siquiera por proxy, descarta esa empresa antes que devolverla con ficha rota.

SOLO JSON.`;

    const raw = await callClaude(userPrompt, req.user);
    const parsed = extractJson(raw);
    const results = Array.isArray(parsed.results) ? parsed.results : [];

    const entry = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      filters: { continente, pais, ciudad, sector, sectores: sectoresArr, modelo, minResiduoT, maxResults, extra },
      resumen: parsed.resumen || '',
      results,
    };
    const h = readHistory();
    const list = pruneHistory(h[req.user] || []);
    list.unshift(entry);
    h[req.user] = list.slice(0, 30);
    writeHistory(h);

    res.json(entry);
  } catch (ex) {
    console.error('[search]', ex);
    adminNotify({ origin: 'REFF', label: 'Búsqueda IA · fallo', detail: ex.message, severity: 'error' });
    res.status(500).json({ error: ex.message || 'error en búsqueda' });
  }
});

/* add a search result directly to a sheet */
app.post('/api/sheets/:sid/companies/from-search', auth, async (req, res) => {
  const sheet = await mongo.collection('sheets').findOne({ _id: req.params.sid, user: req.user });
  if (!sheet) return res.status(404).json({ error: 'hoja no encontrada' });

  const r = req.body || {};
  if (!r.nodo) return res.status(400).json({ error: 'nodo requerido' });
  const dict = r.dictamen && typeof r.dictamen === 'object' ? r.dictamen : {};
  const dictLine = [
    dict.iia     && `IIA: ${dict.iia}`,
    dict.factory && `Factory: ${dict.factory}`,
    dict.finance && `Finance: ${dict.finance}`,
    dict.pactvm  && `Pactvm: ${dict.pactvm}`,
  ].filter(Boolean).join(' · ');
  const volumen = r.volumenResiduoT != null && r.volumenResiduoT !== ''
    ? Number(r.volumenResiduoT)
    : (r.residuoAnualT != null && r.residuoAnualT !== '' ? Number(r.residuoAnualT) : null);
  const fuentesArr = Array.isArray(r.fuentes) ? r.fuentes.filter(Boolean).map(String) : [];
  const notas = [
    r.porQue && `Por qué: ${r.porQue}`,
    r.variableB && `B (BSS): ${r.variableB}`,
    r.variableG && `G (Herzog): ${r.variableG}`,
    r.variableU2 && `U-2: ${r.variableU2}`,
    volumen != null && `Residuo ${volumen} T/año`,
    r.tipoResiduo && `Tipo residuo: ${r.tipoResiduo}`,
    r.modelo && `Modelo ${r.modelo}`,
    fuentesArr.length && `Fuentes: ${fuentesArr.join(' · ')}`,
  ].filter(Boolean).join('\n');
  const c = {
    _id: crypto.randomUUID(),
    sheetId: req.params.sid,
    nodo: String(r.nodo).trim(),
    sector: String(r.sector || '').trim(),
    ubicacion: String(r.ubicacion || '').trim(),
    ophs: Number(r.ophs ?? 0),
    bssMwh: Number(r.bssMwh ?? 0),
    cnmc: String(r.cnmc || 'OK').trim(),
    dictamen: dictLine || String(r.dictamen || ''),
    notas,
    tipoResiduo: String(r.tipoResiduo || '').trim(),
    volumenResiduoT: volumen,
    plantas: r.plantas != null && r.plantas !== '' ? Number(r.plantas) : null,
    empleados: r.empleados != null && r.empleados !== '' ? Number(r.empleados) : null,
    facturacionM: r.facturacionM != null && r.facturacionM !== '' ? Number(r.facturacionM) : null,
    pagaGestion: String(r.pagaGestion || 'DESCONOCIDO').trim(),
    esg: String(r.esg || '').trim(),
    tareas: [],
    createdAt: new Date().toISOString(),
    source: 'search',
  };

  await mongo.collection('companies').insertOne(c);

  res.status(201).json({ ...c, id: c._id, tareas: [] });
});

/* ---------- companies (cross-sheet helpers para LinkedIn / Email) ---------- */
app.get('/api/companies/all', auth, async (req, res) => {
  const sheets = await mongo.collection('sheets').find({ user: req.user }).project({ _id: 1, name: 1 }).toArray();
  const sheetMap = new Map(sheets.map(s => [s._id, s.name]));
  const all = await mongo.collection('companies').find({ sheetId: { $in: sheets.map(s => s._id) } }).toArray();
  res.json(all.map(c => ({ ...c, id: c._id, sheetName: sheetMap.get(c.sheetId) })));
});

/*
 * GET /api/companies/:cid/dictamen
 * Dictamen de Soberanía descargable: snapshot consolidado del nodo
 * (OPHS, BSS, estado CNMC, dictamen departamental) + huella CNMC si existe
 * auditoría previa. Pensado para entregar a una empresa que pide pruebas
 * de una evaluación o discrepancia detectada.
 */
app.get('/api/companies/:cid/dictamen', auth, async (req, res) => {
  const sheets = await mongo.collection('sheets').find({ user: req.user }).project({ _id: 1, name: 1 }).toArray();
  const sheetIds = sheets.map(s => s._id);
  const sheetMap = new Map(sheets.map(s => [s._id, s.name]));

  const c = await mongo.collection('companies').findOne({ _id: req.params.cid, sheetId: { $in: sheetIds } });
  if (!c) return res.status(404).json({ error: 'empresa no encontrada' });

  const state = readElvira();
  const cnmcAuditLog = (state.cnmc?.auditLog || []).filter(a => a.companyId === c._id || a.nodo === c.nodo);

  res.json({
    tipo:        'DICTAMEN_DE_SOBERANIA',
    generadoEn:  new Date().toISOString(),
    generadoPor: req.user,
    nodo:        c.nodo,
    sector:      c.sector || null,
    ubicacion:   c.ubicacion || null,
    sheetName:   sheetMap.get(c.sheetId) || null,
    puntuacionOphs: c.ophs ?? null,
    resilienceBss:  { mwh: c.bssMwh ?? null, descripcion: 'MWh estimados para 48h post-apagón' },
    estadoCnmc:     c.cnmc ?? 'OK',
    opsBlocked:     c.opsBlocked || false,
    dictamenDepartamental: c.dictamen || null,
    ficha: {
      tipoResiduo:      c.tipoResiduo ?? null,
      volumenResiduoT:  c.volumenResiduoT ?? null,
      plantas:          c.plantas ?? null,
      empleados:        c.empleados ?? null,
      facturacionM:     c.facturacionM ?? null,
      esg:              c.esg ?? null,
    },
    auditoriasCnmc: cnmcAuditLog,
  });
});

/* ---------- LinkedIn Finder (IA · sugerencias de contactos) ---------- */
const LINKEDIN_SYSTEM = `Eres el módulo "LinkedIn Finder" del Agente S-NFI dentro de Elvi-Ra.

Tu tarea: dada una empresa cliente potencial (Nodo S-NFI), proponer perfiles tipo de decision-makers y operadores clave que conviene contactar en LinkedIn para abrir conversación sobre integración S-NFI BioHybrid + Physical AI + gobernanza OPHS.

REGLAS:
- NO inventes nombres reales ni URLs concretas. Devuelve PERFILES TIPO (rol, seniority, área) que se pueden buscar.
- Para cada perfil construye una URL de BÚSQUEDA real en LinkedIn (https://www.linkedin.com/search/results/people/?keywords=...) con keywords + nombre de empresa codificados.
- Prioriza roles que tocan: sostenibilidad, operaciones de planta, energía/utilities, gestión de residuos, innovación/I+D, compliance regulatorio (CNMC), CFO/CapEx.
- Ordena por prioridadOutreach (1 = primero a contactar).
- Da un "anguloApertura" breve y específico al sector/contexto de la empresa, alineado a S-NFI (resiliencia BSS, in-situ vs transporte, soberanía energética OPHS).

SALIDA: SOLO JSON válido, sin markdown:
{
  "contactos": [
    {
      "rol": "string (ej. Director de Sostenibilidad)",
      "area": "string (Sostenibilidad | Operaciones | Energía | Innovación | Finanzas | Compliance | C-Suite)",
      "seniority": "C-Suite | VP | Director | Manager | Lead",
      "keywords": ["string", "..."],
      "searchUrl": "https://www.linkedin.com/search/results/people/?keywords=...",
      "prioridadOutreach": 1,
      "anguloApertura": "string corto"
    }
  ],
  "notaEstrategica": "string corto"
}`;

app.post('/api/linkedin', auth, async (req, res) => {
  try {
    const { companyId } = req.body || {};
    if (!companyId) return res.status(400).json({ error: 'companyId requerido' });
    const targetDoc = await mongo.collection('companies').findOne({ _id: companyId });
    if (!targetDoc) return res.status(404).json({ error: 'empresa no encontrada' });
    const sheet = await mongo.collection('sheets').findOne({ _id: targetDoc.sheetId, user: req.user });
    if (!sheet) return res.status(404).json({ error: 'empresa no encontrada' });
    const target = { ...targetDoc, id: targetDoc._id, sheetName: sheet.name };

    const prompt = `EMPRESA OBJETIVO:
- NODO: ${target.nodo}
- Sector: ${target.sector || 'n/d'}
- Ubicación: ${target.ubicacion || 'n/d'}
- OPHS: ${target.ophs || 0}/100
- BSS estimado: ${target.bssMwh || 0} MWh
- CNMC: ${target.cnmc || 'OK'}
- Tipo residuo: ${target.tipoResiduo || 'n/d'}
- Volumen residuo: ${target.volumenResiduoT != null ? target.volumenResiduoT + ' T/año' : 'n/d'}
- Plantas: ${target.plantas ?? 'n/d'}
- Empleados: ${target.empleados ?? 'n/d'}
- Facturación: ${target.facturacionM != null ? target.facturacionM + ' M€' : 'n/d'}
- Paga gestión: ${target.pagaGestion || 'DESCONOCIDO'}
- ESG: ${target.esg || 'n/d'}
- Notas: ${(target.notas || '').slice(0, 600)}
- Dictamen: ${(target.dictamen || '').slice(0, 600)}

Devuelve 5–8 perfiles tipo priorizados para outreach LinkedIn alineado a S-NFI. SOLO JSON.`;

    const raw = await callLLMTracked(LINKEDIN_SYSTEM, prompt, 2048, req.user, 'linkedin');
    const parsed = extractJson(raw);
    const contactos = Array.isArray(parsed.contactos) ? parsed.contactos : [];

    // sanitize / re-build searchUrl by hand to ensure validity
    const cleaned = contactos.map(c => {
      const kw = Array.isArray(c.keywords) ? c.keywords.join(' ') : (c.rol || '');
      const q = `${kw} ${target.nodo}`.trim();
      return {
        rol: String(c.rol || '').trim(),
        area: String(c.area || '').trim(),
        seniority: String(c.seniority || '').trim(),
        keywords: Array.isArray(c.keywords) ? c.keywords.slice(0, 8) : [],
        searchUrl: 'https://www.linkedin.com/search/results/people/?keywords=' + encodeURIComponent(q),
        prioridadOutreach: Number(c.prioridadOutreach || 99),
        anguloApertura: String(c.anguloApertura || '').trim(),
      };
    }).sort((a, b) => a.prioridadOutreach - b.prioridadOutreach);

    res.json({
      company: { id: target.id, nodo: target.nodo, sector: target.sector, ubicacion: target.ubicacion },
      contactos: cleaned,
      notaEstrategica: parsed.notaEstrategica || '',
      generatedAt: new Date().toISOString(),
    });
  } catch (ex) {
    console.error('[linkedin]', ex);
    adminNotify({ origin: 'REFF', label: 'LinkedIn Finder · fallo', detail: ex.message, severity: 'error' });
    res.status(500).json({ error: ex.message || 'error LinkedIn Finder' });
  }
});

/* ---------- Email Creator (IA · plantillas políticas S-NFI) ---------- */
const EMAIL_SYSTEM = `Eres el módulo "Email Creator" del Agente S-NFI dentro de Elvi-Ra.

Generas correos de outreach corporativo en NOMBRE de South-Navarre Fresh Innovations Corp. (S-NFI), OEM deep-tech de infraestructura industrial modular. Tecnología núcleo: S-NFI BioHybrid (BioGrinder + BioDeshidratador → biopellet 7–8%) + Physical AI + Gobernanza OPHS.

PRINCIPIOS DE ESTILO S-NFI:
- Tono: serio, técnico-industrial, soberano. Nada de marketing verde blando. Nada de emojis. Nada de exclamaciones.
- Español de España. Frases cortas. No promesas vacías.
- Posicionar S-NFI como infraestructura OEM, no proveedor de servicios.
- Si se cita resiliencia: hablar de autonomía post-apagón (48h) y vulnerabilidad CNMC.
- NDA: encuadrar como prerrequisito de transferencia técnica controlada, no como trámite.
- Firma cierre: "— Equipo S-NFI · South Navarre Fresh Innovations Corp."

SITUACIONES SOPORTADAS:
1. "primer_contacto" → toma de contacto inicial alineada al sector/residuo de la empresa.
2. "solicitud_nda" → segunda iteración solicitando NDA para abrir datos técnicos / cifras.

SALIDA: SOLO JSON válido, sin markdown:
{
  "asunto": "string (max 90 chars)",
  "preheader": "string (max 110 chars, opcional)",
  "cuerpoTexto": "string (texto plano, saltos de línea con \\n, listo para pegar)",
  "cuerpoHtml": "string (HTML simple <p>/<ul>, sin estilos inline ni imágenes)",
  "siguientePaso": "string corto (qué esperamos del destinatario)"
}`;

app.post('/api/email', auth, async (req, res) => {
  try {
    const { companyId, situacion, destinatarioRol, tonoExtra } = req.body || {};
    if (!companyId) return res.status(400).json({ error: 'companyId requerido' });
    const sit = situacion === 'solicitud_nda' ? 'solicitud_nda' : 'primer_contacto';
    const target = await mongo.collection('companies').findOne({ _id: companyId });
    if (!target) return res.status(404).json({ error: 'empresa no encontrada' });
    const sheet = await mongo.collection('sheets').findOne({ _id: target.sheetId, user: req.user });
    if (!sheet) return res.status(404).json({ error: 'empresa no encontrada' });

    const prompt = `SITUACIÓN: ${sit}
DESTINATARIO (rol/perfil): ${destinatarioRol || 'Decision-maker industrial'}
CONTEXTO EXTRA OPERADOR: ${tonoExtra || '(ninguno)'}

EMPRESA OBJETIVO:
- NODO: ${target.nodo}
- Sector: ${target.sector || 'n/d'}
- Ubicación: ${target.ubicacion || 'n/d'}
- OPHS: ${target.ophs || 0}/100
- BSS estimado: ${target.bssMwh || 0} MWh / 48h
- Estado CNMC: ${target.cnmc || 'OK'}
- Tipo residuo: ${target.tipoResiduo || 'n/d'}
- Volumen residuo: ${target.volumenResiduoT != null ? target.volumenResiduoT + ' T/año' : 'n/d'}
- Plantas: ${target.plantas ?? 'n/d'}
- Empleados: ${target.empleados ?? 'n/d'}
- Facturación: ${target.facturacionM != null ? target.facturacionM + ' M€' : 'n/d'}
- Paga gestión externa: ${target.pagaGestion || 'DESCONOCIDO'}
- ESG: ${target.esg || 'n/d'}
- Notas internas: ${(target.notas || '').slice(0, 800)}
- Dictamen interno: ${(target.dictamen || '').slice(0, 800)}

Redacta el email para esta situación, anclado al sector y a las variables S-NFI relevantes. SOLO JSON.`;

    const raw = await callLLMTracked(EMAIL_SYSTEM, prompt, 2048, req.user, 'email');
    const parsed = extractJson(raw);

    res.json({
      company: { id: target._id, nodo: target.nodo, sector: target.sector, ubicacion: target.ubicacion },
      situacion: sit,
      destinatarioRol: destinatarioRol || '',
      asunto: String(parsed.asunto || '').trim(),
      preheader: String(parsed.preheader || '').trim(),
      cuerpoTexto: String(parsed.cuerpoTexto || '').trim(),
      cuerpoHtml: String(parsed.cuerpoHtml || '').trim(),
      siguientePaso: String(parsed.siguientePaso || '').trim(),
      generatedAt: new Date().toISOString(),
    });
  } catch (ex) {
    console.error('[email]', ex);
    adminNotify({ origin: 'REFF', label: 'Email Creator · fallo', detail: ex.message, severity: 'error' });
    res.status(500).json({ error: ex.message || 'error Email Creator' });
  }
});

/* ============================================================
   ELVI-RA · Centro de mando · orquestador
   Endpoints mock estructurados, listos para enchufar Sentinel + Herzog reales.
   ============================================================ */
function readElvira() {
  try { return JSON.parse(fs.readFileSync(ELVIRA_FILE, 'utf8')); }
  catch { return {}; }
}
function writeElvira(state) {
  state.updatedAt = new Date().toISOString();
  atomicWriteJson(ELVIRA_FILE, state);
}

/* Overview agregado: estado sistemas + métricas globales */
app.get('/api/elvira/overview', auth, async (req, res) => {
  const state = readElvira();
  const totalUsers = Object.keys(USERS).length;
  const activeSessions = [...SESSIONS.values()].filter(s => s.exp > Date.now()).length;

  const totalCompanies = await mongo.collection('companies').countDocuments();

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
app.get('/api/elvira/systems', auth, (req, res) => {
  const state = readElvira();
  res.json(state.systems);
});

app.put('/api/elvira/systems/:key', auth, (req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'admin requerido' });
  const state = readElvira();
  const key = String(req.params.key);
  if (!state.systems[key]) return res.status(404).json({ error: 'sistema no registrado' });
  const allowed = ['status', 'endpoint', 'tokensUsed', 'tokensCap', 'backend'];
  for (const k of allowed) if (k in req.body) state.systems[key][k] = req.body[k];
  state.systems[key].lastPing = new Date().toISOString();
  writeElvira(state);
  res.json(state.systems[key]);
});

/* Mock ping — sustituir por handshake real cuando exista */
app.post('/api/elvira/systems/:key/ping', auth, (req, res) => {
  const state = readElvira();
  const key = String(req.params.key);
  const sys = state.systems[key];
  if (!sys) return res.status(404).json({ error: 'sistema no registrado' });
  const t0 = Date.now();
  sys.latencyMs = Math.floor(8 + Math.random() * 22);
  sys.lastPing = new Date().toISOString();
  if (sys.endpoint) sys.status = 'connected';
  writeElvira(state);
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
app.get('/api/elvira/ophs', auth, (req, res) => {
  const state = readElvira();
  res.json(state.ophs);
});

app.put('/api/elvira/ophs/config', auth, (req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'admin requerido' });
  const state = readElvira();
  const { weights, threshold } = req.body || {};
  if (weights && typeof weights === 'object') state.ophs.weights = { ...state.ophs.weights, ...weights };
  if (threshold && typeof threshold === 'object') state.ophs.threshold = { ...state.ophs.threshold, ...threshold };
  writeElvira(state);
  res.json({ weights: state.ophs.weights, threshold: state.ophs.threshold });
});

app.post('/api/elvira/ophs/score', auth, (req, res) => {
  const { vars = {}, flags = {}, nodo = '' } = req.body || {};
  const state = readElvira();
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
  writeElvira(state);
  res.json(dictamen);
});

/* GET /api/elvira/ophs/dictamenes/:id/report — Dictamen de Soberania descargable */
app.get('/api/elvira/ophs/dictamenes/:id/report', auth, (req, res) => {
  const state = readElvira();
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
  const state = readElvira();
  const tc = state.systems.tcontroler || {};
  const byUser = tc.byUser || {};
  const eurRate = await getUsdToEurRate();

  const users = Object.entries(byUser).map(([user, u]) => {
    const totalTokens = u.inputTokens + u.outputTokens;
    const costTotalUSD = (u.inputTokens / 1e6) * PRICE_INPUT_PER_M + (u.outputTokens / 1e6) * PRICE_OUTPUT_PER_M;
    return {
      user,
      calls: u.calls,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
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

  res.json({
    model: ANTHROPIC_MODEL(),
    pricing: { inputPer1M: PRICE_INPUT_PER_M, outputPer1M: PRICE_OUTPUT_PER_M, usdToEur: eurRate },
    tokensCap: tc.tokensCap || 0,
    global,
    byUser: users,
    updatedAt: state.updatedAt,
  });
});

app.delete('/api/elvira/tcontroler/reset', auth, (req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'admin requerido' });
  const state = readElvira();
  const tc = state.systems.tcontroler || (state.systems.tcontroler = { status: 'local', tokensUsed: 0, tokensCap: 0 });
  tc.byUser = {};
  tc.tokensUsed = 0;
  writeElvira(state);
  setImmediate(() => busEmit({
    id: crypto.randomUUID(), ts: new Date().toISOString(), seq: busEvents.length + 1,
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
app.get('/api/elvira/ophs/webhook', auth, (req, res) => {
  const state = readElvira();
  if (!state.ophs.webhookEvents) state.ophs.webhookEvents = [];
  res.json({
    status: 'active',
    endpoint: '/api/elvira/ophs/webhook',
    events: state.ophs.webhookEvents.slice(0, 50),
    description: 'Puerto OPHS — receptor webhook para integración externa. POST aquí para enviar eventos o scores.',
  });
});

app.post('/api/elvira/ophs/webhook', auth, (req, res) => {
  const b = req.body || {};
  const type    = String(b.type || 'event');   // "event" | "score"
  const source  = String(b.source || 'external');
  const payload = b.payload && typeof b.payload === 'object' ? b.payload : {};

  const state = readElvira();
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
  writeElvira(state);
  res.status(201).json(entry);
});

/* ============================================================
   CNMC · Embudo Legal — ingesta documental regulatoria + auditoría de asimetría
   ============================================================ */

/* GET /api/elvira/cnmc/documents — lista documentos ingestados */
app.get('/api/elvira/cnmc/documents', auth, (req, res) => {
  const state = readElvira();
  if (!state.cnmc) state.cnmc = { documents: [], auditLog: [] };
  res.json(state.cnmc.documents.slice(0, 100));
});

/* GET /api/elvira/cnmc/audit-log — historial de auditorias CNMC (asimetria declarado vs CNMC) */
app.get('/api/elvira/cnmc/audit-log', auth, (req, res) => {
  const state = readElvira();
  if (!state.cnmc) state.cnmc = { documents: [], auditLog: [] };
  res.json(state.cnmc.auditLog.slice(0, 100));
});

/*
 * POST /api/elvira/cnmc/ingest
 * Acepta metadatos + datos tabulados de un informe regulatorio CNMC.
 * PDFs reales se procesarán cuando el LLM local esté operativo; por ahora
 * se recibe el extracto ya parseado (JSON) junto con metadatos de fuente.
 *
 * Body esperado:
 * {
 *   empresa:   "Iberdrola S.A.",
 *   cif:       "A95653077",           // opcional
 *   periodo:   "2023",
 *   fuente:    "Informe Anual CNMC 2023 — Actividad Eléctrica",
 *   url:       "https://...",          // opcional, para trazabilidad
 *   datos: {                           // variables extraídas del informe
 *     bssMwh:        number | null,
 *     resiliencia:   string | null,
 *     sanciones:     string | null,    // "ninguna" | "expediente X" | ...
 *     expedientes:   string | null,
 *     [key: string]: any               // cualquier otro parámetro del informe
 *   }
 * }
 */
app.post('/api/elvira/cnmc/ingest', auth, (req, res) => {
  const b = req.body || {};
  const empresa  = String(b.empresa  || '').trim();
  const periodo  = String(b.periodo  || '').trim();
  const fuente   = String(b.fuente   || '').trim();
  if (!empresa || !fuente) return res.status(400).json({ error: 'empresa y fuente requeridos' });

  const doc = {
    id:         crypto.randomUUID(),
    dataSource: 'CNMC',                     // Dato Jurídico — prioridad absoluta
    empresa,
    cif:        String(b.cif || '').trim() || null,
    periodo,
    fuente,
    url:        String(b.url || '').trim() || null,
    datos:      b.datos && typeof b.datos === 'object' ? b.datos : {},
    ingestedAt: new Date().toISOString(),
    ingestedBy: req.user,
  };

  const state = readElvira();
  if (!state.cnmc) state.cnmc = { documents: [], auditLog: [] };
  state.cnmc.documents.unshift(doc);
  state.cnmc.documents = state.cnmc.documents.slice(0, 500);
  writeElvira(state);

  busEmit({
    id: crypto.randomUUID(), ts: new Date().toISOString(), seq: busEvents.length + 1,
    origin: 'ELVI-RA', dest: 'REFF', type: 'request', state: 'PENDING',
    label: `CNMC INGEST · ${empresa} · ${periodo}`,
    payload: { docId: doc.id, empresa, periodo, fuente, dataSource: 'CNMC' },
    user: req.user,
  });

  res.status(201).json(doc);
});

/*
 * POST /api/elvira/cnmc/audit/:companyId
 * Cruza el último documento CNMC ingestado para esa empresa (por nombre)
 * contra los datos del nodo en el CRM.
 * Si detecta asimetría relevante:
 *   — marca la empresa con cnmcAudit: { status:'FAILED', ... }
 *   — pone opsBlocked: true en la empresa
 *   — emite evento bus REFF→OPHS state=BLOCKED
 *   — escribe evento Sentinel con huella forense
 *
 * Body opcional: { docId } para forzar un documento específico.
 */
app.post('/api/elvira/cnmc/audit/:companyId', auth, async (req, res) => {
  const state = readElvira();
  if (!state.cnmc) state.cnmc = { documents: [], auditLog: [] };

  const targetCompany = await mongo.collection('companies').findOne({ _id: req.params.companyId });
  if (targetCompany) {
    const sheet = await mongo.collection('sheets').findOne({ _id: targetCompany.sheetId, user: req.user });
    if (!sheet) return res.status(404).json({ error: 'empresa no encontrada' });
  }

  if (!targetCompany) return res.status(404).json({ error: 'empresa no encontrada' });

  // Find matching CNMC document — by docId (body) or by empresa name match
  let doc = null;
  const { docId } = req.body || {};
  if (docId) {
    doc = state.cnmc.documents.find(d => d.id === docId);
  } else {
    const nodo = (targetCompany.nodo || '').toLowerCase();
    doc = state.cnmc.documents.find(d =>
      d.empresa.toLowerCase().includes(nodo) || nodo.includes(d.empresa.toLowerCase())
    );
  }
  if (!doc) return res.status(404).json({ error: 'no hay documento CNMC ingestado para esta empresa' });

  const now = new Date().toISOString();
  const cnmcDatos = doc.datos || {};

  // --- Asymmetry detection ---
  const findings = [];

  // BSS / Resilience
  if (cnmcDatos.bssMwh != null && targetCompany.bssMwh != null) {
    const delta = Number(targetCompany.bssMwh) - Number(cnmcDatos.bssMwh);
    const pct   = cnmcDatos.bssMwh !== 0 ? Math.abs(delta / Number(cnmcDatos.bssMwh)) : 0;
    if (pct > 0.10 && delta > 0) {
      findings.push({
        parametro:       'bssMwh',
        valorDeclarado:  targetCompany.bssMwh,
        valorCnmc:       cnmcDatos.bssMwh,
        delta,
        nivel:           'INFRACCION_NIVEL_1',
        descripcion:     `Empresa declara ${targetCompany.bssMwh} MWh BSS; CNMC reporta ${cnmcDatos.bssMwh} MWh. Delta +${delta.toFixed(2)} MWh (${(pct*100).toFixed(1)}%)`,
      });
    }
  }

  // Sanciones / expedientes — cualquier mención no nula en CNMC y estado OK en CRM
  if (cnmcDatos.sanciones && cnmcDatos.sanciones !== 'ninguna' && targetCompany.cnmc === 'OK') {
    findings.push({
      parametro:       'sanciones',
      valorDeclarado:  'OK (CRM)',
      valorCnmc:       cnmcDatos.sanciones,
      delta:           'presencia de expediente no declarado',
      nivel:           'INFRACCION_NIVEL_2',
      descripcion:     `CNMC registra: "${cnmcDatos.sanciones}". Empresa figura como OK en CRM.`,
    });
  }
  if (cnmcDatos.expedientes && cnmcDatos.expedientes !== 'ninguno' && targetCompany.cnmc === 'OK') {
    findings.push({
      parametro:       'expedientes',
      valorDeclarado:  'OK (CRM)',
      valorCnmc:       cnmcDatos.expedientes,
      delta:           'expediente activo no declarado',
      nivel:           'INFRACCION_NIVEL_2',
      descripcion:     `CNMC registra expediente activo: "${cnmcDatos.expedientes}". Empresa figura como OK en CRM.`,
    });
  }

  // Extra custom fields passed in datos — numeric check >10% delta
  for (const [key, cnmcVal] of Object.entries(cnmcDatos)) {
    if (['bssMwh','sanciones','expedientes'].includes(key)) continue;
    const crmVal = targetCompany[key];
    if (crmVal != null && cnmcVal != null && typeof cnmcVal === 'number' && typeof crmVal === 'number') {
      const delta = Number(crmVal) - Number(cnmcVal);
      const pct   = cnmcVal !== 0 ? Math.abs(delta / cnmcVal) : 0;
      if (pct > 0.10 && delta > 0) {
        findings.push({
          parametro:       key,
          valorDeclarado:  crmVal,
          valorCnmc:       cnmcVal,
          delta,
          nivel:           'INFRACCION_NIVEL_1',
          descripcion:     `${key}: declarado ${crmVal}, CNMC reporta ${cnmcVal}. Delta +${delta.toFixed(2)} (${(pct*100).toFixed(1)}%)`,
        });
      }
    }
  }

  const hasFailed = findings.some(f => f.nivel === 'INFRACCION_NIVEL_1' || f.nivel === 'INFRACCION_NIVEL_2');
  const auditStatus = hasFailed ? 'FAILED' : findings.length > 0 ? 'REVIEW' : 'PASSED';
  const worstNivel  = findings.reduce((worst, f) => {
    const order = { INFRACCION_NIVEL_1: 3, INFRACCION_NIVEL_2: 2, INFRACCION_NIVEL_3: 1 };
    return (order[f.nivel] || 0) > (order[worst] || 0) ? f.nivel : worst;
  }, 'SIN_ASIMETRIA');

  const auditRecord = {
    id:          crypto.randomUUID(),
    companyId:   targetCompany._id,
    nodo:        targetCompany.nodo,
    docId:       doc.id,
    fuente:      doc.fuente,
    periodo:     doc.periodo,
    status:      auditStatus,       // PASSED | FAILED | REVIEW
    nivel:       worstNivel,
    findings,
    opsBlocked:  hasFailed,
    auditedAt:   now,
    auditedBy:   req.user,
  };

  // --- Persist audit result on company ---
  targetCompany.cnmcAudit  = auditRecord;
  targetCompany.opsBlocked = hasFailed;
  if (hasFailed && targetCompany.cnmc === 'OK') targetCompany.cnmc = 'RIESGO';

  await mongo.collection('companies').updateOne(
    { _id: targetCompany._id },
    { $set: { cnmc: targetCompany.cnmc, cnmcAudit: auditRecord, opsBlocked: hasFailed } }
  );

  // --- Persist in auditLog ---
  state.cnmc.auditLog.unshift(auditRecord);
  state.cnmc.auditLog = state.cnmc.auditLog.slice(0, 200);
  writeElvira(state);

  // --- Bus event: REFF → OPHS ---
  const busState = hasFailed ? 'BLOCKED' : 'COMPLETED';
  const busLabel = hasFailed
    ? `CNMC_AUDIT_FAILED · ${targetCompany.nodo} · ${findings[0]?.parametro || '?'} · OPS BLOQUEADOS`
    : `CNMC_AUDIT_PASSED · ${targetCompany.nodo}`;
  busEmit({
    id: crypto.randomUUID(), ts: now, seq: busEvents.length + 1,
    origin: 'REFF', dest: 'OPHS', type: 'response', state: busState,
    label: busLabel,
    payload: {
      cnmcAudit: auditStatus,
      nodo:      targetCompany.nodo,
      findings:  findings.slice(0, 5),
      opsBlocked: hasFailed,
    },
    user: req.user,
  });

  // --- Sentinel forensic log (only on failure) ---
  if (hasFailed) {
    const primaryFinding = findings.find(f => f.nivel === 'INFRACCION_NIVEL_1') || findings[0];
    const sentinelEvent = {
      id:        crypto.randomUUID(),
      type:      'cnmc_fraud',
      subject:   targetCompany.nodo,
      detail:    `CNMC_AUDIT_FAILED · Parámetro: ${primaryFinding.parametro} · Declarado: ${primaryFinding.valorDeclarado} · CNMC: ${primaryFinding.valorCnmc} · Delta: ${primaryFinding.delta} · Fuente: ${doc.fuente} · Periodo: ${doc.periodo}`,
      severity:  'critical',
      createdAt: now,
      forensic: {
        auditId:        auditRecord.id,
        docId:          doc.id,
        fuente:         doc.fuente,
        periodo:        doc.periodo,
        parametro:      primaryFinding.parametro,
        valorDeclarado: primaryFinding.valorDeclarado,
        valorCnmc:      primaryFinding.valorCnmc,
        delta:          primaryFinding.delta,
        nivel:          primaryFinding.nivel,
        ts:             now,
      },
    };
    state.bridges.sentinel.events.unshift(sentinelEvent);
    state.bridges.sentinel.events = state.bridges.sentinel.events.slice(0, 200);
    writeElvira(state);

    // Also emit to bus for panel pickup
    busEmit({
      id: crypto.randomUUID(), ts: now, seq: busEvents.length + 1,
      origin: 'SENTINEL', dest: 'ELVI-RA', type: 'alert', state: 'BLOCKED',
      label: `HUELLA FORENSE · ${targetCompany.nodo} · ${primaryFinding.parametro}`,
      payload: sentinelEvent.forensic,
      user: req.user,
    });
  }

  res.status(200).json(auditRecord);
});

/*
 * GET /api/elvira/cnmc/audit-log/:auditId/report
 * Informe descargable autocontenido de una auditoría CNMC ya realizada:
 * útil cuando una empresa pide pruebas de por qué se detectó una asimetría
 * (ej. "por qué nos marcasteis error de mercado en 2023").
 */
app.get('/api/elvira/cnmc/audit-log/:auditId/report', auth, (req, res) => {
  const state = readElvira();
  if (!state.cnmc) state.cnmc = { documents: [], auditLog: [] };

  const auditRecord = state.cnmc.auditLog.find(a => a.id === req.params.auditId);
  if (!auditRecord) return res.status(404).json({ error: 'auditoría no encontrada' });

  const doc = state.cnmc.documents.find(d => d.id === auditRecord.docId) || null;

  res.json({
    tipo:        'INFORME_AUDITORIA_CNMC',
    generadoEn:  new Date().toISOString(),
    generadoPor: req.user,
    auditoria:   auditRecord,
    fuente:      doc ? { fuente: doc.fuente, url: doc.url, periodo: doc.periodo, ingestedAt: doc.ingestedAt, ingestedBy: doc.ingestedBy, datos: doc.datos } : null,
  });
});

/* ============================================================
   CNMC · Buscador híbrido: API real numeracionyoperadores.cnmc.es + LLM
   1) Consulta la API pública CNMC para datos de registro actualizados
   2) El LLM enriquece con contexto regulatorio usando los datos reales
   ============================================================ */

const CNMC_API_BASE = 'https://numeracionyoperadores.cnmc.es';

async function fetchCnmcOperadores(nombre) {
  const { default: https } = await import('node:https');
  const encoded = encodeURIComponent(nombre);
  const url = `${CNMC_API_BASE}/api/operador/get_busqueda_operadores?nombre=${encoded}`;
  return new Promise((resolve) => {
    https.get(url, { headers: { 'User-Agent': 'Elvi-Ra/1.0 (S-NFI Corp; regulatorio)', 'Accept': 'application/json' } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch { resolve([]); }
      });
    }).on('error', () => resolve([]));
  });
}

const CNMC_ENRICH_SYSTEM = `Eres el módulo "CNMC Intelligence" del agente Rëff dentro de Elvi-Ra.

Se te proporcionan datos REALES y ACTUALIZADOS del Registro Oficial de Operadores de la CNMC (numeracionyoperadores.cnmc.es) sobre una empresa. Tu tarea es:

1. Interpretar los datos de registro oficial (servicios autorizados, ámbito, fechas de resolución)
2. Añadir contexto regulatorio adicional que conozcas: expedientes sancionadores, RIPRE/RAIPRE, informes CNMC, régimen retributivo energético si aplica
3. Evaluar el perfil de compliance según el marco OPHS de S-NFI

DATOS REALES DE REGISTRO CNMC: se proporcionan en el prompt del usuario como JSON.

VARIABLES A COMPLETAR (combina datos reales + tu conocimiento):
- registroOficial: resumen de servicios autorizados por CNMC (extrae de los datos reales)
- servicios: lista de servicios y ámbitos registrados
- sanciones: "ninguna conocida" o descripción de expediente sancionador si lo conoces
- expedientes: "ninguno conocido" o descripción
- regimen: régimen retributivo energético si aplica (mercado libre, RECORE, prima regulada)
- potenciaInstalada: MW registrados si aplica
- volumenResiduoT: toneladas residuo orgánico si aplica
- obligacionesIncumplidas: lista de incumplimientos conocidos
- estadoCompliance: "APTO" | "OBSERVACION" | "EXPEDIENTE_ACTIVO" | "SANCIONADO"
- perfilOperador: descripción del perfil como operador CNMC relevante para S-NFI

REGLA CRÍTICA: Los datos del registro oficial son VERIFICADOS y tienen prioridad absoluta. Lo que añades del LLM marca confianza MEDIA o BAJA. No inventes datos — usa null y explica en notas.

SALIDA: SOLO JSON válido, sin markdown:
{
  "empresa": "string",
  "cif": "string | null",
  "periodo": "string",
  "fuente": "string",
  "confianza": "ALTA | MEDIA | BAJA",
  "registroOficial": { "encontrado": boolean, "nombreRegistrado": "string | null", "nif": "string | null", "domicilio": "string | null", "fechaAltaRegistro": "string | null", "totalServicios": number },
  "datos": {
    "servicios": [{"nombre": "string", "tipo": "string", "ambito": "string", "fechaResolucion": "string"}],
    "sanciones": "string",
    "expedientes": "string",
    "regimen": "string | null",
    "potenciaInstalada": number | null,
    "volumenResiduoT": number | null,
    "obligacionesIncumplidas": [],
    "estadoCompliance": "APTO | OBSERVACION | EXPEDIENTE_ACTIVO | SANCIONADO",
    "perfilOperador": "string | null"
  },
  "notas": "string",
  "recomiendaIngest": boolean
}`;

app.post('/api/elvira/cnmc/search', auth, async (req, res) => {
  try {
    const b = req.body || {};
    const empresa = String(b.empresa || '').trim();
    const cif     = String(b.cif     || '').trim();
    const periodo = String(b.periodo || new Date().getFullYear().toString()).trim();

    if (!empresa) return res.status(400).json({ error: 'empresa requerida' });

    // Step 1: fetch real CNMC registry data
    const cnmcResults = await fetchCnmcOperadores(empresa);
    const found = cnmcResults.length > 0;
    const cnmcDataStr = found
      ? JSON.stringify(cnmcResults.slice(0, 5), null, 2)
      : 'No se encontraron resultados en el registro oficial de operadores CNMC para esta empresa.';

    // Step 2: LLM enriches with regulatory context using real data as base
    const userPrompt = `EMPRESA A INVESTIGAR: ${empresa}${cif ? ` · CIF: ${cif}` : ''}
PERIODO DE INTERÉS: ${periodo}

DATOS REALES DEL REGISTRO OFICIAL CNMC (numeracionyoperadores.cnmc.es):
${cnmcDataStr}

Interpreta estos datos y enriquece con contexto regulatorio adicional (sanciones, RIPRE/RAIPRE, régimen energético, perfil OPHS).
Si hay múltiples resultados, analiza el más relevante o el que coincida mejor con la búsqueda.
SOLO JSON.`;

    const raw = await callLLMTracked(CNMC_ENRICH_SYSTEM, userPrompt, 3000, req.user, 'cnmc_search');
    const parsed = extractJson(raw);

    // Override registroOficial with verified data if LLM missed it
    if (found && (!parsed.registroOficial || !parsed.registroOficial.encontrado)) {
      const first = cnmcResults[0];
      parsed.registroOficial = {
        encontrado: true,
        nombreRegistrado: first.nombre || null,
        nif: first.nif || null,
        domicilio: first.domicilio || null,
        fechaAltaRegistro: first.fecha_notif_ini || null,
        totalServicios: (first.servicios || []).length,
      };
      parsed.confianza = parsed.confianza === 'BAJA' ? 'MEDIA' : parsed.confianza;
    } else if (!found) {
      parsed.registroOficial = { encontrado: false, nombreRegistrado: null, nif: null, domicilio: null, fechaAltaRegistro: null, totalServicios: 0 };
    }

    busEmit({
      id: crypto.randomUUID(), ts: new Date().toISOString(), seq: busEvents.length + 1,
      origin: 'REFF', dest: 'ELVI-RA', type: 'response', state: 'COMPLETED',
      label: `CNMC SEARCH · ${empresa} · ${periodo} · registro:${found ? 'ENCONTRADO' : 'NO_ENCONTRADO'} · confianza: ${parsed.confianza || '?'}`,
      payload: { empresa, periodo, registroEncontrado: found, confianza: parsed.confianza, estadoCompliance: parsed.datos?.estadoCompliance },
      user: req.user,
    });

    res.json({
      empresa,
      cif: cif || null,
      periodo,
      searchedAt: new Date().toISOString(),
      cnmcResultCount: cnmcResults.length,
      ...parsed,
    });
  } catch (ex) {
    console.error('[cnmc/search]', ex);
    adminNotify({ origin: 'REFF', label: 'CNMC búsqueda · fallo', detail: ex.message, severity: 'error' });
    res.status(500).json({ error: ex.message || 'error búsqueda CNMC' });
  }
});

/* ---------- Sentinel bridge (mock) ---------- */
/* Espejo de eventos de identidad/acceso. Real Sentinel publicará aquí. */
app.get('/api/elvira/sentinel/events', auth, (req, res) => {
  const state = readElvira();
  res.json(state.bridges.sentinel.events.slice(0, 50));
});

app.post('/api/elvira/sentinel/events', auth, (req, res) => {
  const b = req.body || {};
  const ev = {
    id: crypto.randomUUID(),
    type: String(b.type || 'access'),       // access | denied | attempt | identity
    subject: String(b.subject || ''),
    detail: String(b.detail || ''),
    severity: String(b.severity || 'info'), // info | warn | critical
    createdAt: new Date().toISOString(),
  };
  const state = readElvira();
  state.bridges.sentinel.events.unshift(ev);
  state.bridges.sentinel.events = state.bridges.sentinel.events.slice(0, 200);
  writeElvira(state);
  res.status(201).json(ev);
});

/* ---------- Herzog bridge (mock) ---------- */
/* Auditoría Fase 4 protocolo S-NFI. Real Herzog publicará aquí. */
app.get('/api/elvira/herzog/audits', auth, (req, res) => {
  const state = readElvira();
  res.json(state.bridges.herzog.audits.slice(0, 50));
});

app.post('/api/elvira/herzog/audits', auth, (req, res) => {
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
  const state = readElvira();
  state.bridges.herzog.audits.unshift(a);
  state.bridges.herzog.audits = state.bridges.herzog.audits.slice(0, 200);
  writeElvira(state);
  res.status(201).json(a);
});

/* ============================================================
   EVENT BUS · Bus de eventos central
   Flujo: Emisor → POST /api/bus/emit → ring-buffer → SSE push → consumidores (panel Elvi-Ra, Sentinel)

   Estados de paquete:
     PENDING | ROUTING | VALIDATING | BLOCKED | APPROVED | COMPLETED
   ============================================================ */

/* GET /api/bus/stream — SSE endpoint */
app.get('/api/bus/stream', auth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // nginx: disable buffering
  res.flushHeaders();

  // Send backlog (last 100 events so client shows history on connect)
  const backlog = busEvents.slice(0, 100).reverse();
  for (const ev of backlog) {
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  }

  sseClients.add(res);

  // Heartbeat every 25s to keep connection alive through proxies
  const hb = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch { clearInterval(hb); sseClients.delete(res); }
  }, 25000);

  req.on('close', () => { clearInterval(hb); sseClients.delete(res); });
});

/* GET /api/bus/events — REST snapshot (último N eventos) */
app.get('/api/bus/events', auth, (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit ?? 200), 1), MAX_BUS_EVENTS);
  res.json({ total: busEvents.length, events: busEvents.slice(0, limit) });
});

/* POST /api/bus/emit — cualquier módulo interno emite aquí */
app.post('/api/bus/emit', auth, (req, res) => {
  const b = req.body || {};
  const allowed_origins  = ['ELVI-RA', 'REFF', 'OPHS', 'SENTINEL', 'HERZOG', 'TCONTROLER', 'SYSTEM'];
  const allowed_states   = ['PENDING', 'ROUTING', 'VALIDATING', 'BLOCKED', 'APPROVED', 'COMPLETED'];

  const origin  = allowed_origins.includes(String(b.origin  || '').toUpperCase()) ? String(b.origin).toUpperCase()  : 'SYSTEM';
  const dest    = String(b.dest    || 'BUS').toUpperCase();
  const state   = allowed_states.includes(String(b.state   || '').toUpperCase()) ? String(b.state).toUpperCase()   : 'PENDING';
  const type    = String(b.type    || 'event').toLowerCase();   // event | request | response | alert
  const payload = b.payload && typeof b.payload === 'object' ? b.payload : {};
  const label   = String(b.label   || '').slice(0, 140);

  const event = {
    id:        crypto.randomUUID(),
    ts:        new Date().toISOString(),
    seq:       busEvents.length + 1,
    origin,
    dest,
    type,
    state,
    label,
    payload,
    user:      req.user,
  };

  busEmit(event);
  res.status(201).json(event);
});

/* PATCH /api/bus/events/:id — actualizar estado de un evento existente */
app.patch('/api/bus/events/:id', auth, (req, res) => {
  const ev = busEvents.find(e => e.id === req.params.id);
  if (!ev) return res.status(404).json({ error: 'evento no encontrado' });
  const allowed_states = ['PENDING','ROUTING','VALIDATING','BLOCKED','APPROVED','COMPLETED'];
  if (req.body.state && allowed_states.includes(String(req.body.state).toUpperCase())) {
    ev.state = String(req.body.state).toUpperCase();
    ev.updatedAt = new Date().toISOString();
  }
  if (req.body.label) ev.label = String(req.body.label).slice(0, 140);
  busEmit({ ...ev, _type: 'state_update' }); // notify SSE clients
  res.json(ev);
});

/* GET /api/bus/stats — métricas del bus */
app.get('/api/bus/stats', auth, (req, res) => {
  const counts = {};
  for (const ev of busEvents) counts[ev.state] = (counts[ev.state] || 0) + 1;
  const byOrigin = {};
  for (const ev of busEvents) byOrigin[ev.origin] = (byOrigin[ev.origin] || 0) + 1;
  res.json({
    total: busEvents.length,
    sseClients: sseClients.size,
    byState: counts,
    byOrigin,
    latest: busEvents[0] || null,
  });
});

/* GET /api/bus/history — historial persistente, filtrable por fecha/origen/estado/tipo/texto
 * Query params: from, to (ISO date), origin, dest, state, type, q (busca en label), limit, offset
 * Orden: más reciente primero.
 */
app.get('/api/bus/history', auth, (req, res) => {
  let history = [];
  try { history = JSON.parse(fs.readFileSync(BUS_HISTORY_FILE, 'utf8')); }
  catch { history = []; }
  if (!Array.isArray(history)) history = [];

  const { from, to, origin, dest, state, type, q } = req.query;
  const fromMs = from ? new Date(String(from)).getTime() : null;
  const toMs   = to   ? new Date(String(to)).getTime()   : null;
  const qLower = q ? String(q).toLowerCase() : '';

  let filtered = history.filter(ev => {
    const tsMs = new Date(ev.ts).getTime();
    if (fromMs != null && !Number.isNaN(fromMs) && tsMs < fromMs) return false;
    if (toMs   != null && !Number.isNaN(toMs)   && tsMs > toMs)   return false;
    if (origin && ev.origin !== String(origin).toUpperCase()) return false;
    if (dest   && ev.dest   !== String(dest).toUpperCase())   return false;
    if (state  && ev.state  !== String(state).toUpperCase())  return false;
    if (type   && ev.type   !== String(type).toLowerCase())   return false;
    if (qLower && !String(ev.label || '').toLowerCase().includes(qLower)) return false;
    return true;
  });

  filtered.reverse(); // más reciente primero

  const total  = filtered.length;
  const limit  = Math.min(Math.max(Number(req.query.limit ?? 200), 1), 1000);
  const offset = Math.max(Number(req.query.offset ?? 0), 0);

  res.json({
    total,
    limit,
    offset,
    events: filtered.slice(offset, offset + limit),
  });
});

/* ============================================================
   NOTIFICACIONES ADMIN · errores/inestabilidad del sistema
   Cola curada, separada del bus de tráfico general. Solo visible para 'admin'.
   ============================================================ */

/* GET /api/notifications/stream — SSE, push en tiempo real */
app.get('/api/notifications/stream', auth, requireAdmin, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const backlog = adminNotifications.slice(0, 50).reverse();
  for (const n of backlog) res.write(`data: ${JSON.stringify(n)}\n\n`);

  adminSseClients.add(res);
  const hb = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch { clearInterval(hb); adminSseClients.delete(res); }
  }, 25000);
  req.on('close', () => { clearInterval(hb); adminSseClients.delete(res); });
});

/* GET /api/notifications — snapshot + contador de no leídas */
app.get('/api/notifications', auth, requireAdmin, (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), MAX_NOTIFICATIONS);
  res.json({
    total: adminNotifications.length,
    unread: adminNotifications.filter(n => !n.read).length,
    notifications: adminNotifications.slice(0, limit),
  });
});

/* POST /api/notifications/:id/read — marcar una como leída */
app.post('/api/notifications/:id/read', auth, requireAdmin, (req, res) => {
  const n = adminNotifications.find(x => x.id === req.params.id);
  if (!n) return res.status(404).json({ error: 'notificación no encontrada' });
  n.read = true;
  atomicWriteJson(NOTIFICATIONS_FILE, adminNotifications);
  res.json(n);
});

/* POST /api/notifications/read-all — marcar todas como leídas */
app.post('/api/notifications/read-all', auth, requireAdmin, (req, res) => {
  for (const n of adminNotifications) n.read = true;
  atomicWriteJson(NOTIFICATIONS_FILE, adminNotifications);
  res.json({ ok: true });
});

/* DELETE /api/notifications/:id — eliminar una notificación */
app.delete('/api/notifications/:id', auth, requireAdmin, (req, res) => {
  const idx = adminNotifications.findIndex(x => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'notificación no encontrada' });
  adminNotifications.splice(idx, 1);
  atomicWriteJson(NOTIFICATIONS_FILE, adminNotifications);
  res.json({ ok: true });
});

/* DELETE /api/notifications — eliminar todas las leídas */
app.delete('/api/notifications', auth, requireAdmin, (req, res) => {
  adminNotifications = adminNotifications.filter(n => !n.read);
  atomicWriteJson(NOTIFICATIONS_FILE, adminNotifications);
  res.json({ ok: true });
});

/* ============================================================
   SENTINEL · Trazabilidad forense de IPs
   Log criptográfico inmutable (hash chain + HMAC) + cola de revisión
   de IPs que exceden rate limit en rutas sensibles (CNMC, U-2).
   ============================================================ */

/* GET /api/sentinel/forensic-log — paginado, filtrable por ip/mesa/blocked/sensitive */
app.get('/api/sentinel/forensic-log', auth, async (req, res) => {
  const { ip, mesa, blocked, sensitive, from, to, limit, offset } = req.query;
  const result = await sentinelForensics.listForensicLog({ ip, mesa, blocked, sensitive, from, to, limit, offset });
  res.json(result);
});

/* GET /api/sentinel/forensic-log-human — mismo log en frases claras, sin jerga tecnica */
app.get('/api/sentinel/forensic-log-human', auth, async (req, res) => {
  const { ip, blocked, from, to, limit, offset } = req.query;
  const result = await sentinelForensics.listForensicLogHuman({ ip, blocked, from, to, limit, offset });
  res.json(result);
});

/*
 * GET /api/sentinel/forensic-log/export
 * Informe descargable: traza completa de peticiones en un rango de fecha,
 * util para demostrar a una empresa o auditor que pasó en un periodo concreto.
 * Admin-only — datos forenses crudos.
 */
app.get('/api/sentinel/forensic-log/export', auth, async (req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'admin requerido' });
  const { ip, mesa, blocked, sensitive, from, to } = req.query;
  const result = await sentinelForensics.listForensicLog({ ip, mesa, blocked, sensitive, from, to, limit: 1000, offset: 0 });
  res.json({
    tipo:        'INFORME_TRAZA_SENTINEL',
    generadoEn:  new Date().toISOString(),
    generadoPor: req.user,
    filtros:     { ip: ip || null, mesa: mesa || null, blocked: blocked ?? null, sensitive: sensitive ?? null, from: from || null, to: to || null },
    total:       result.total,
    events:      result.events,
  });
});

/* GET /api/sentinel/verify-chain — Admin, valida integridad de la cadena de hashes */
app.get('/api/sentinel/verify-chain', auth, async (req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'admin requerido' });
  const result = await sentinelForensics.verifyChain();
  res.json(result);
});

/* POST /api/sentinel/reanchor-chain — Admin, re-sella la cadena tras un fallo (no borra historial) */
app.post('/api/sentinel/reanchor-chain', auth, async (req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'admin requerido' });
  const result = await sentinelForensics.reanchorChain(req.user);
  res.json(result);
});

/* GET /api/sentinel/ip-stats — top IPs por volumen de tráfico */
app.get('/api/sentinel/ip-stats', auth, async (req, res) => {
  const stats = await sentinelForensics.ipStats();
  res.json(stats);
});

/* GET /api/sentinel/traffic-timeline — peticiones/min ultimos N minutos (grafico panel) */
app.get('/api/sentinel/traffic-timeline', auth, async (req, res) => {
  const minutes = Math.min(Number(req.query.minutes) || 60, 1440);
  const timeline = await sentinelForensics.trafficTimeline(minutes);
  res.json({ minutes, timeline });
});

/* POST /api/sentinel/block-ip — Admin, bloqueo manual directo desde el panel */
app.post('/api/sentinel/block-ip', auth, async (req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'admin requerido' });
  const { ip, reason } = req.body || {};
  if (!ip) return res.status(400).json({ error: 'ip requerida' });
  const updated = await sentinelForensics.manualBlock(ip, reason, req.user);
  busEmit({
    id: crypto.randomUUID(), ts: new Date().toISOString(), seq: busEvents.length + 1,
    origin: 'SENTINEL', dest: 'ELVI-RA', type: 'alert', state: 'BLOCKED',
    label: `IP BLOQUEADA MANUALMENTE · ${ip} · por ${req.user}`, payload: { ip, reason }, user: req.user,
  });
  res.json(updated);
});

/* GET /api/sentinel/allowlist — IPs de confianza que Sentinel nunca bloquea */
app.get('/api/sentinel/allowlist', auth, async (req, res) => {
  const list = await sentinelForensics.listAllowlist();
  res.json(list);
});

/* POST /api/sentinel/allowlist — Admin marca una IP como propia/de confianza, nunca mas se bloquea */
app.post('/api/sentinel/allowlist', auth, async (req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'admin requerido' });
  const { ip, label } = req.body || {};
  if (!ip) return res.status(400).json({ error: 'ip requerida' });
  const updated = await sentinelForensics.addToAllowlist(ip, label, req.user);
  busEmit({
    id: crypto.randomUUID(), ts: new Date().toISOString(), seq: busEvents.length + 1,
    origin: 'SENTINEL', dest: 'ELVI-RA', type: 'event', state: 'APPROVED',
    label: `IP MARCADA DE CONFIANZA · ${ip} · por ${req.user}`, payload: { ip, label }, user: req.user,
  });
  res.json(updated);
});

/* DELETE /api/sentinel/allowlist/:ip — Admin quita una IP de la lista de confianza */
app.delete('/api/sentinel/allowlist/:ip', auth, async (req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'admin requerido' });
  const result = await sentinelForensics.removeFromAllowlist(req.params.ip);
  res.json(result);
});

/* GET /api/sentinel/review-queue — IPs pendientes/bloqueadas/permitidas */
app.get('/api/sentinel/review-queue', auth, async (req, res) => {
  const queue = await sentinelForensics.listReviewQueue();
  res.json(queue);
});

/* POST /api/sentinel/review-queue/:ip/decide — Admin concede o bloquea acceso */
app.post('/api/sentinel/review-queue/:ip/decide', auth, async (req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'admin requerido' });
  const { decision } = req.body || {};
  if (!['ALLOWED', 'BLOCKED'].includes(decision)) return res.status(400).json({ error: 'decision debe ser ALLOWED o BLOCKED' });
  const updated = await sentinelForensics.decideReview(req.params.ip, decision, req.user);
  busEmit({
    id: crypto.randomUUID(), ts: new Date().toISOString(), seq: busEvents.length + 1,
    origin: 'SENTINEL', dest: 'ELVI-RA', type: 'event', state: decision === 'BLOCKED' ? 'BLOCKED' : 'APPROVED',
    label: `IP ${decision} · ${req.params.ip} · por ${req.user}`, payload: { ip: req.params.ip, decision }, user: req.user,
  });
  res.json(updated);
});

/* GET /api/sentinel/review-queue/:ip/report — informe descargable del historial de esa IP */
app.get('/api/sentinel/review-queue/:ip/report', auth, async (req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'admin requerido' });
  const report = await sentinelForensics.exportIpReport(req.params.ip);
  res.json(report);
});

/* ============================================================
   S-NFI U2 · Mesa de energía desperdiciada
   Fuente: api.esios.ree.es (token personal ESIOS)
   - Precio SPOT horario: indicador 600 (geo España)
   - Demanda real horaria: indicador 1293 (geo Península)
   - Generación T.Real: eólica 551, solar 1295, hidro 546, nuclear 549
   Metodología: horas precio SPOT <= umbral → energía desperdiciada estimada
   ============================================================ */

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
   Poller: cada 5 min REE apidatos → cache → SSE push
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

/* ============================================================
   S-NFI U2 · ESIOS token endpoints (token requerido)
   Token en process.env.ESIOS_API_KEY
   ============================================================ */

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

/* ============================================================
   ELVI-RA · CENTRAL (Volumen 2)
   Chat conocedor del sistema + acciones con consentimiento humano
   + mock del puerto OPHS/Systems (/api/ophs/*)
   ============================================================ */
mountElviraCentral(app, {
  auth, requireMesa, mongo, getMongoClient,
  callLLM, trackTokens, busEmit, adminNotify,
  SESSIONS, readElvira, cibe,
  getU2Snapshot: () => {
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
