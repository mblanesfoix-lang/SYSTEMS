/**
 * Auth core — login/logout/me/permissions/change-password.
 *
 * Extraido de server.js sin cambios de comportamiento. Persistencia sigue
 * siendo JSON-backed (USERS_FILE/SESSIONS_FILE via loadUsers/saveUsers y
 * el Map SESSIONS + saveSessions) — no ha aterrizado ninguna migracion a
 * Mongo de usuarios/sesiones en esta rama a fecha de extraccion. Las
 * funciones de persistencia (saveUsers/saveSessions) y el estado (USERS,
 * SESSIONS) se reciben como dependencias explicitas en vez de leerse de
 * ficheros dentro de los handlers, para no complicar una futura migracion.
 */

import crypto from 'node:crypto';
import bcrypt from 'bcrypt';

export function mountAuth(app, {
  authLimiter,
  sentinelForensics,
  USERS,
  SESSIONS,
  saveUsers,
  saveSessions,
  ROLE_MESAS,
  busEmit,
  busEvents,
}) {
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

  return { auth };
}
