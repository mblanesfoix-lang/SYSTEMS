/**
 * Arranque aislado de las mesas (lib/mount-guard.js).
 *
 * Primera parte, sin Mongo: el filtro de mesas degradadas sobre una app Express propia
 * con auth y requireMesa como stubs. Segunda parte, con Mongo de prueba: auth y Sentinel
 * reales, una mesa no crítica cuyo montaje falla a propósito y el Expediente F&L real sin
 * clave de cifrado. Base propia (elvira_test_mount_guard) para no chocar con otros tests.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import bcrypt from 'bcrypt';
import { MongoClient } from 'mongodb';
import { createMountGuard } from '../lib/mount-guard.js';
import { mountAuth } from '../routes/auth.routes.js';
import { createSentinelForensics } from '../sentinel-forensics.js';
import { mountSentinelForensicRoutes } from '../routes/sentinel-forensic.routes.js';
import { mountFlExpediente } from '../fl-expediente.js';
import { connectMongo, closeMongo } from '../db/mongo.js';

const MONGO_URI = process.env.MONGO_URI;
const silentLog = { error() {} };

function makeRequireMesa(roleMesas) {
  return (mesa) => (req, res, next) => (
    (roleMesas[req.role] || []).includes(mesa) ? next() : res.status(403).json({ error: 'Acceso denegado a esta mesa' })
  );
}

async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function call(baseUrl, path, { token, method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe('mount-guard: mesas degradadas', () => {
  const ROLE_MESAS = { admin: ['finance', 'fl', 'fl_expediente'], lector: ['fl'] };
  const SESSIONS = { 'token-admin': 'admin', 'token-lector': 'lector' };
  const stubAuth = (req, res, next) => {
    const role = SESSIONS[(req.headers.authorization || '').replace(/^Bearer /, '')];
    if (!role) return res.status(401).json({ error: 'unauthorized' });
    req.user = role;
    req.role = role;
    return next();
  };
  const notified = [];
  let guard, server, baseUrl, dependentCalled = false;
  const results = {};

  before(async () => {
    guard = createMountGuard({ auth: stubAuth, requireMesa: makeRequireMesa(ROLE_MESAS), notify: (unit) => notified.push(unit), log: silentLog });
    const app = express();
    app.use(guard.gate);

    results.hub = await guard.safeMount('fl-hub', () => {
      app.get('/api/fl/summary', stubAuth, (_req, res) => res.json({ ok: true }));
      return { mounted: true };
    }, { label: 'Hub F&L', mesa: 'fl', prefixes: ['/api/fl'] });

    // Registra una ruta y después falla: esa ruta no debe servirse.
    results.finance = await guard.safeMount('finance', () => {
      app.get('/api/finance/partial', stubAuth, (_req, res) => res.json({ servedHalfMounted: true }));
      throw new Error('fallo simulado al montar');
    }, { label: 'S-NFI Finance', mesa: 'finance', prefixes: ['/api/finance'] });

    results.expediente = await guard.safeMount('fl-expediente', async () => {
      await Promise.resolve();
      throw new Error('sin clave de cifrado');
    }, { label: 'Expediente', mesa: 'fl_expediente', prefixes: ['/api/fl/expediente'] });

    results.verify = await guard.safeMount('verify', () => {
      throw new Error('fallo de la ruta pública');
    }, { label: 'Verificación', mesa: 'finance', publicPrefixes: ['/api/verify'] });

    results.dependent = await guard.safeMount('dependiente', () => {
      dependentCalled = true;
    }, { label: 'Dependiente', mesa: 'finance', prefixes: ['/api/dependiente'], dependsOn: ['finance'] });

    ({ server, baseUrl } = await listen(app));
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  test('las que fallan quedan degradadas, devuelven undefined y avisan una vez al Admin', () => {
    assert.deepEqual(results.hub, { mounted: true });
    assert.equal(results.finance, undefined);
    assert.equal(results.expediente, undefined);
    assert.deepEqual(guard.summary(), {
      'fl-hub': 'ok', finance: 'degraded', 'fl-expediente': 'degraded', verify: 'degraded', dependiente: 'degraded',
    });
    assert.deepEqual(notified.map((u) => u.name), ['finance', 'fl-expediente', 'verify', 'dependiente']);
    assert.equal(notified[0].reason, 'fallo simulado al montar');
    assert.equal(notified[1].reason, 'sin clave de cifrado');
  });

  test('una ruta registrada antes del fallo responde 503 y no se sirve', async () => {
    const { status, body } = await call(baseUrl, '/api/finance/partial', { token: 'token-admin' });
    assert.equal(status, 503);
    assert.equal(body.degraded, true);
    assert.equal(body.mesa, 'finance');
    assert.match(body.error, /S-NFI Finance no está disponible/);
    assert.equal((await call(baseUrl, '/API/Finance/Partial', { token: 'token-admin' })).status, 503);
  });

  test('sin sesión 401 y sin permiso 403: no revela qué mesa está caída', async () => {
    assert.equal((await call(baseUrl, '/api/finance/partial')).status, 401);
    assert.equal((await call(baseUrl, '/api/finance/partial', { token: 'token-lector' })).status, 403);
    assert.equal((await call(baseUrl, '/api/fl/expediente', { token: 'token-lector' })).status, 403);
  });

  test('cada ruta es de la unidad con el prefijo más largo', async () => {
    assert.equal((await call(baseUrl, '/api/fl/summary', { token: 'token-lector' })).status, 200);
    for (const path of ['/api/fl/expediente', '/api/fl/expediente/', '/api/fl/expediente/summary']) {
      const expediente = await call(baseUrl, path, { token: 'token-admin' });
      assert.equal(expediente.status, 503, path);
      assert.equal(expediente.body.mesa, 'fl_expediente');
    }
    assert.equal((await call(baseUrl, '/api/financex', { token: 'token-admin' })).status, 404);
  });

  test('una ruta pública degradada responde 503 sin pedir sesión', async () => {
    const { status, body } = await call(baseUrl, '/api/verify/abc');
    assert.equal(status, 503);
    assert.equal(body.degraded, true);
  });

  test('si una dependencia está degradada, la dependiente ni se intenta montar', () => {
    assert.equal(dependentCalled, false);
    const unit = guard.degraded().find((u) => u.name === 'dependiente');
    assert.match(unit.reason, /depende de S-NFI Finance/);
  });

  test('las críticas siguen deteniendo el arranque', async () => {
    const g = createMountGuard({ auth: stubAuth, requireMesa: makeRequireMesa(ROLE_MESAS), log: silentLog });
    await assert.rejects(g.safeMount('auth', () => { throw new Error('auth rota'); }, { critical: true }), /auth rota/);
    await g.safeMount('bus', () => { throw new Error('bus roto'); }, { label: 'Bus' });
    await assert.rejects(g.safeMount('sentinel', () => {}, { critical: true, dependsOn: ['bus'] }), /depende de Bus/);
  });

  test('nombre duplicado o aviso que falla no rompen las reglas', async () => {
    const g = createMountGuard({
      auth: stubAuth, requireMesa: makeRequireMesa(ROLE_MESAS), log: silentLog,
      notify: () => { throw new Error('canal de avisos caído'); },
    });
    assert.equal(await g.safeMount('a', () => { throw new Error('x'); }), undefined);
    assert.equal(g.state('a'), 'degraded');
    await assert.rejects(g.safeMount('a', () => {}), /duplicada/);
  });
});

describe('mount-guard: arranque con auth, Sentinel y Expediente reales', { skip: !MONGO_URI && 'MONGO_URI no configurada' }, () => {
  const DB_NAME = 'elvira_test_mount_guard';
  const TENANT_ID = 'tenant_mount_guard_test';
  const USER = 'admin-mount@snficorp.com';
  const PASSWORD = 'correcta123';
  const ROLE_MESAS = { admin: ['sentinel', 'finance', 'fl', 'fl_expediente'] };
  const requireMesa = makeRequireMesa(ROLE_MESAS);
  const mesaForPath = (path) => (path.startsWith('/api/finance') ? 'finance' : path.startsWith('/api/fl') ? 'fl' : null);
  const notified = [];
  let client, db, server, baseUrl, guard, savedKey, token;

  before(async () => {
    // createAuthMiddleware resuelve el tenant con el MongoClient global de db/mongo.js.
    await connectMongo();
    client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db(DB_NAME);
    await db.dropDatabase();
    await client.db('elvira_control').collection('tenants').updateOne(
      { _id: TENANT_ID },
      { $set: {
        _id: TENANT_ID, kind: 'internal', displayName: 'Mount guard test', status: 'active',
        mongo: { mode: 'shared-cluster', uri: null, dbName: DB_NAME, reffDbName: DB_NAME },
        createdAt: new Date().toISOString(),
      } },
      { upsert: true },
    );
    await db.collection('users').insertOne({
      _id: USER, passwordHash: bcrypt.hashSync(PASSWORD, 4), role: 'admin', tenantId: TENANT_ID, createdAt: new Date().toISOString(),
    });

    savedKey = process.env.FL_EXPEDIENTE_ENC_KEY;
    delete process.env.FL_EXPEDIENTE_ENC_KEY;

    const app = express();
    app.use(express.json());
    const busEvents = [];
    const busEmit = (event) => busEvents.push(event);
    let auth;
    guard = createMountGuard({
      auth: (req, res, next) => auth(req, res, next), requireMesa, notify: (unit) => notified.push(unit), log: silentLog,
    });
    const listDegraded = () => guard.degraded().map(({ name, mesa, label }) => ({ name, mesa, label }));

    // Mismo orden que server.js: Sentinel, auth, guards de mesa, filtro y mesas.
    const sentinel = await guard.safeMount('sentinel', () => {
      const forensics = createSentinelForensics({ mongo: db, busEmit, ROLE_MESAS });
      app.use(forensics.middleware(mesaForPath));
      return forensics;
    }, { label: 'Sentinel', critical: true });
    ({ auth } = await guard.safeMount('auth', () => mountAuth(app, {
      mongo: db, requireAdmin: (_req, _res, next) => next(), ROLE_MESAS,
      authLimiter: (_req, _res, next) => next(), sentinelForensics: sentinel, busEmit, listDegraded,
    }), { label: 'Autenticación', critical: true }));
    app.use('/api/sentinel', auth, requireMesa('sentinel'));
    app.use('/api/finance', auth, requireMesa('finance'));
    app.use(guard.gate);

    await guard.safeMount('finance', () => {
      throw new Error('fallo forzado al montar');
    }, { label: 'S-NFI Finance', mesa: 'finance', prefixes: ['/api/finance'] });
    await guard.safeMount('fl-expediente', () => mountFlExpediente(app, {
      auth, requireMesa, mongo: db, busEmit, adminNotify: () => {}, cibe: {},
    }), { label: 'Expediente Fiscal y Jurídico', mesa: 'fl_expediente', prefixes: ['/api/fl/expediente'] });
    await guard.safeMount('sentinel-routes', () => mountSentinelForensicRoutes(app, {
      auth, sentinelForensics: sentinel, busEmit, busEvents,
    }), { label: 'Sentinel · trazabilidad forense', critical: true });

    ({ server, baseUrl } = await listen(app));
    const login = await call(baseUrl, '/api/login', { method: 'POST', body: { username: USER, password: PASSWORD } });
    token = login.body?.token;
  });

  after(async () => {
    if (savedKey === undefined) delete process.env.FL_EXPEDIENTE_ENC_KEY;
    else process.env.FL_EXPEDIENTE_ENC_KEY = savedKey;
    if (server) await new Promise((resolve) => server.close(resolve));
    if (client) {
      // Sentinel escribe su registro al terminar cada respuesta: esperar a que acabe antes de borrar la base.
      let previous = -1;
      for (let i = 0; i < 20; i += 1) {
        const count = await db.collection('forensic_log').countDocuments();
        if (count === previous) break;
        previous = count;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      await db.dropDatabase();
      await client.db('elvira_control').collection('tenants').deleteOne({ _id: TENANT_ID });
      await client.close();
    }
    await closeMongo();
  });

  test('el servidor arranca con la mesa caída y el Expediente sin clave degradados', () => {
    assert.deepEqual(guard.summary(), {
      sentinel: 'ok', auth: 'ok', finance: 'degraded', 'fl-expediente': 'degraded', 'sentinel-routes': 'ok',
    });
    const expediente = notified.find((u) => u.name === 'fl-expediente');
    assert.match(expediente.reason, /FL_EXPEDIENTE_ENC_KEY/);
  });

  test('auth funciona: login y sesión', async () => {
    assert.ok(token, 'login sin token');
    const me = await call(baseUrl, '/api/me', { token });
    assert.equal(me.status, 200);
    assert.equal(me.body.user, USER);
  });

  test('el prefijo de la mesa caída responde 503; sin sesión, 401', async () => {
    const res = await call(baseUrl, '/api/finance/summary', { token });
    assert.equal(res.status, 503);
    assert.equal(res.body.degraded, true);
    assert.equal((await call(baseUrl, '/api/finance/summary')).status, 401);
  });

  test('sin clave válida el Expediente no se sirve: 503 en lectura y escritura', async () => {
    const routes = [
      ['GET', '/api/fl/expediente'],
      ['GET', '/api/fl/expediente/summary'],
      ['GET', '/api/fl/expediente/archivos/cualquiera'],
      ['POST', '/api/fl/expediente/documentos'],
    ];
    for (const [method, path] of routes) {
      const res = await call(baseUrl, path, { token, method, body: method === 'POST' ? {} : undefined });
      assert.equal(res.status, 503, `${method} ${path}`);
      assert.equal(res.body.mesa, 'fl_expediente');
    }
    assert.equal((await call(baseUrl, '/api/fl/expediente')).status, 401);
  });

  test('/api/me/permissions marca las mesas degradadas', async () => {
    const { status, body } = await call(baseUrl, '/api/me/permissions', { token });
    assert.equal(status, 200);
    assert.deepEqual(body.degraded.map((d) => d.mesa).sort(), ['finance', 'fl_expediente']);
  });

  test('Sentinel funciona y registra los accesos a la mesa caída', async () => {
    await call(baseUrl, '/api/finance/summary', { token });
    let events = [];
    for (let i = 0; i < 20 && !events.some((e) => e.statusCode === 503); i += 1) {
      const res = await call(baseUrl, '/api/sentinel/forensic-log?mesa=finance', { token });
      assert.equal(res.status, 200);
      events = res.body.events;
      if (!events.some((e) => e.statusCode === 503)) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(events.some((e) => e.path === '/api/finance/summary' && e.statusCode === 503), 'sin registro forense del 503');
  });
});
