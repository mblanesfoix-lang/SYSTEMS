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

const SEED_USERS = {
  'nzaroual@s-nfi.com':     { password: process.env.SEED_NOUR_PASSWORD,     role: 'admin'    },
  'mblanes@s-nficorp.com':  { password: process.env.SEED_MARC_PASSWORD,     role: 'admin'    },
  'gonzalosb@s-nficorp.com':{ password: process.env.SEED_GONZALO_PASSWORD,  role: 'admin'    },
  'ventures@s-nficorp.com': { password: process.env.SEED_AMIR_PASSWORD,     role: 'amir'     },
  'ray@s-nficorp.com':      { password: process.env.SEED_RAY_PASSWORD,      role: 'ray'      },
  'csanser@s-nficorp.com':  { password: process.env.SEED_CELIA_PASSWORD,    role: 'celia'    },
  'malvarez@s-nficorp.com': { password: process.env.SEED_MAITANE_PASSWORD,  role: 'maitane'  },
  'aporquet@snficorp.com':  { password: process.env.SEED_ARKAITZ_PASSWORD,  role: 'arkaitz'  },
  'oscars@s-nficorp.com':   { password: process.env.SEED_OSCAR_PASSWORD,    role: 'oscar'    },
};

const SESSION_TTL_MS = 1000 * 60 * 60 * 8; // 8h

export async function ensureUsersSeed(mongo) {
  const count = await mongo.collection('users').countDocuments();
  if (count > 0) return;
  const now = new Date().toISOString();
  for (const [email, { password, role }] of Object.entries(SEED_USERS)) {
    if (!password) continue;
    await mongo.collection('users').insertOne({
      _id: email,
      passwordHash: bcrypt.hashSync(password, 12),
      role,
      createdAt: now,
    });
  }
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
    await mongo.collection('sessions').insertOne({ _id: token, user: username, role: u.role, exp });

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

  app.get('/api/me', auth, (req, res) => res.json({ user: req.user, role: req.role }));
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
