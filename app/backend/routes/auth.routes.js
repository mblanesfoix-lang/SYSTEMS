/**
 * Auth · usuarios y sesiones sobre MongoDB (colecciones `users` y `sessions`).
 *
 * Sustituye el store JSON anterior (data/users.json, data/sessions.json).
 * `sessions` lleva indice TTL sobre `exp` (ver ensureIndexes en db/mongo.js):
 * Mongo expira y purga la sesion sola, sin necesidad de filtrar en memoria
 * ni de reescribir un fichero entero en cada login/logout.
 *
 * Seed inicial: si la coleccion `users` esta vacia, se crea desde
 * SEED_*_PASSWORD (env) — mismo comportamiento que el loader JSON previo.
 */
import bcrypt from 'bcrypt';
import crypto from 'node:crypto';

// Fase 1 de multi-tenancy (ver docs del plan): todos los usuarios actuales
// comparten el tenant por defecto 'equipo-interno' — ese tenant ES la db
// 'elvira'/'reff' de siempre (ver seedDefaultTenant), cero migracion de datos.
// Fragmentar cada usuario en su propio tenant es una decision de negocio
// pendiente (que mesas/documentos compartidos de equipo se dividen), no un
// cambio tecnico — fuera de alcance mientras no se decida.
const DEFAULT_TENANT_ID = 'equipo-interno';

const SEED_USERS = {
  'nzaroual@s-nfi.com':     { password: process.env.SEED_NOUR_PASSWORD,     role: 'admin',   tenantId: DEFAULT_TENANT_ID },
  'mblanes@s-nficorp.com':  { password: process.env.SEED_MARC_PASSWORD,     role: 'admin',   tenantId: DEFAULT_TENANT_ID },
  'gonzalosb@s-nficorp.com':{ password: process.env.SEED_GONZALO_PASSWORD,  role: 'admin',   tenantId: DEFAULT_TENANT_ID },
  'ventures@s-nficorp.com': { password: process.env.SEED_AMIR_PASSWORD,     role: 'amir',    tenantId: DEFAULT_TENANT_ID },
  'ray@s-nficorp.com':      { password: process.env.SEED_RAY_PASSWORD,      role: 'ray',     tenantId: DEFAULT_TENANT_ID },
  'csanser@s-nficorp.com':  { password: process.env.SEED_CELIA_PASSWORD,    role: 'celia',   tenantId: DEFAULT_TENANT_ID },
  'malvarez@s-nficorp.com': { password: process.env.SEED_MAITANE_PASSWORD,  role: 'maitane', tenantId: DEFAULT_TENANT_ID },
  'aporquet@snficorp.com':  { password: process.env.SEED_ARKAITZ_PASSWORD,  role: 'arkaitz', tenantId: DEFAULT_TENANT_ID },
  'oscars@s-nficorp.com':   { password: process.env.SEED_OSCAR_PASSWORD,    role: 'oscar',   tenantId: DEFAULT_TENANT_ID },
};

const SESSION_TTL_MS = 1000 * 60 * 60 * 8; // 8h

export async function ensureUsersSeed(mongo) {
  const count = await mongo.collection('users').countDocuments();
  if (count === 0) {
    const now = new Date().toISOString();
    for (const [email, { password, role, tenantId }] of Object.entries(SEED_USERS)) {
      if (!password) continue;
      await mongo.collection('users').insertOne({
        _id: email,
        passwordHash: bcrypt.hashSync(password, 12),
        role,
        tenantId,
        createdAt: now,
      });
    }
    return;
  }
  // Usuarios ya existentes de antes de multi-tenancy (Fase 1): backfill de
  // tenantId sin tocar passwordHash/role. Idempotente — solo escribe donde
  // falta el campo, no sobreescribe un tenantId ya asignado manualmente.
  await backfillTenantId(mongo);
}

async function backfillTenantId(mongo) {
  for (const [email, { tenantId }] of Object.entries(SEED_USERS)) {
    await mongo.collection('users').updateOne(
      { _id: email, tenantId: { $exists: false } },
      { $set: { tenantId } },
    );
  }
}

/**
 * Siembra el tenant por defecto en elvira_control.tenants si no existe todavia.
 * Apunta a los nombres de db YA EXISTENTES ('elvira'/'reff') — cero copia de
 * datos, el tenant 'equipo-interno' simplemente ES la db de siempre.
 * Idempotente: no toca nada si el documento ya existe (p.ej. tras reiniciar).
 */
export async function seedDefaultTenant(controlDb) {
  const existing = await controlDb.collection('tenants').findOne({ _id: DEFAULT_TENANT_ID });
  if (existing) return;
  await controlDb.collection('tenants').insertOne({
    _id: DEFAULT_TENANT_ID,
    kind: 'internal',
    displayName: 'S-NFI Corp - Equipo interno',
    status: 'active',
    mongo: { mode: 'shared-cluster', uri: null, dbName: 'elvira', reffDbName: 'reff' },
    createdAt: new Date().toISOString(),
  });
}

/** Middleware factory: requiere que ensureUsersSeed ya se haya ejecutado sobre `mongo`.
 *  sentinelForensics es opcional (algunos montajes tempranos aun no lo tienen listo);
 *  si se pasa, aplica el bloqueo por usuario de Behavioral Analytics (Sentinel). */
export function createAuthMiddleware(mongo, sentinelForensics) {
  return async function auth(req, res, next) {
    const h = req.headers.authorization || '';
    // EventSource no permite headers personalizados: el stream SSE acepta el token por query string.
    const token = h.startsWith('Bearer ') ? h.slice(7) : (req.path.endsWith('/stream') ? req.query.token : null);
    if (!token) return res.status(401).json({ error: 'unauthorized' });
    const s = await mongo.collection('sessions').findOne({ _id: token });
    if (!s || new Date(s.exp).getTime() < Date.now()) return res.status(401).json({ error: 'unauthorized' });
    if (sentinelForensics?.isUserBlocked && await sentinelForensics.isUserBlocked(s.user)) {
      return res.status(403).json({ error: 'Usuario bloqueado por Sentinel (Behavioral Analytics)' });
    }
    req.user = s.user;
    req.role = s.role;
    req.tenantId = s.tenantId;
    next();
  };
}

export function mountAuth(app, { mongo, requireAdmin, ROLE_MESAS, authLimiter, sentinelForensics, busEmit }) {
  const auth = createAuthMiddleware(mongo, sentinelForensics);

  app.post('/api/login', authLimiter, async (req, res) => {
    const { username, password } = req.body || {};
    const ip = req.ip || 'unknown';

    if (!username) {
      await sentinelForensics.registerLoginAttempt({ ip, username, ok: false, reason: 'credenciales_invalidas' });
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const u = await mongo.collection('users').findOne({ _id: username });
    if (!u || !password || !(await bcrypt.compare(password, u.passwordHash))) {
      await sentinelForensics.registerLoginAttempt({ ip, username, ok: false, reason: 'credenciales_invalidas' });
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }
    await sentinelForensics.registerLoginAttempt({ ip, username, ok: true });
    const token = crypto.randomBytes(24).toString('hex');
    const exp = new Date(Date.now() + SESSION_TTL_MS);
    await mongo.collection('sessions').insertOne({ _id: token, user: username, role: u.role, tenantId: u.tenantId, exp });

    setImmediate(() => busEmit({
      id: crypto.randomUUID(), ts: new Date().toISOString(),
      origin: 'SENTINEL', dest: 'ELVI-RA', type: 'event', state: 'COMPLETED',
      label: `LOGIN OK · ${username}`, payload: { user: username, role: u.role }, user: username,
    }));
    res.json({ token, user: username, role: u.role });
  });

  app.post('/api/logout', auth, async (req, res) => {
    const h = req.headers.authorization || '';
    await mongo.collection('sessions').deleteOne({ _id: h.slice(7) });
    setImmediate(() => busEmit({
      id: crypto.randomUUID(), ts: new Date().toISOString(),
      origin: 'SENTINEL', dest: 'ELVI-RA', type: 'event', state: 'COMPLETED',
      label: `LOGOUT · ${req.user}`, payload: { user: req.user }, user: req.user,
    }));
    res.json({ ok: true });
  });

  app.get('/api/me', auth, (req, res) => res.json({ user: req.user, role: req.role, tenantId: req.tenantId }));
  app.get('/api/me/permissions', auth, (req, res) => {
    res.json({ mesas: ROLE_MESAS[req.role] || [] });
  });

  app.post('/api/change-password', auth, async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'currentPassword y newPassword requeridos' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    const u = await mongo.collection('users').findOne({ _id: req.user });
    if (!u || !(await bcrypt.compare(currentPassword, u.passwordHash))) {
      return res.status(401).json({ error: 'Contraseña actual incorrecta' });
    }
    const passwordHash = await bcrypt.hash(newPassword, 12);
    await mongo.collection('users').updateOne({ _id: req.user }, { $set: { passwordHash } });
    busEmit({
      id: crypto.randomUUID(), ts: new Date().toISOString(),
      origin: 'SENTINEL', dest: 'ELVI-RA', type: 'event', state: 'COMPLETED',
      label: `PASSWORD_CHANGE · ${req.user}`, payload: { user: req.user }, user: req.user,
    });
    res.json({ ok: true });
  });

  return { auth };
}
