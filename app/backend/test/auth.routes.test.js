/**
 * Test de auth.routes.js (login/logout/me/change-password) contra Mongo real
 * de prueba. Usa una app Express minima, no el server.js completo, para
 * aislar el modulo de auth de las ~4000 lineas de mesas/integraciones.
 * Se salta si no hay MONGO_URI configurada.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MongoClient } from 'mongodb';
import express from 'express';
import bcrypt from 'bcrypt';
import { mountAuth, ensureUsersSeed, hashSessionToken, isSessionActive } from '../routes/auth.routes.js';
import { connectMongo, closeMongo, ensureTenantIndexes } from '../db/mongo.js';

const MONGO_URI = process.env.MONGO_URI;
const skip = !MONGO_URI;
const TENANT = 'tenant_auth_test';

let client, db, app, server, baseUrl;
const busEvents = [];
const noopSentinel = {
  registerLoginAttempt: async () => {},
};

async function fetchJson(path, opts = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

const login = (username, password) => fetchJson('/api/login', {
  method: 'POST',
  body: JSON.stringify({ username, password }),
});
const me = (token) => fetchJson('/api/me', { headers: { Authorization: `Bearer ${token}` } });

describe('auth.routes: login/logout/sesiones sobre Mongo', { skip: skip && 'MONGO_URI no configurada' }, () => {
  before(async () => {
    // createAuthMiddleware calienta tenant-registry.js, que resuelve sobre
    // el MongoClient GLOBAL (getMongoClient() en db/mongo.js), no sobre el
    // `client` local de este test — sin esto, 'Mongo no conectado. Llama
    // connectMongo() primero.'. No-op si otro archivo de test ya lo conecto
    // en este mismo proceso (ver db/mongo.js: if (client) return client).
    await connectMongo();

    client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db('elvira_test');
    await Promise.all([
      db.collection('users').deleteMany({}),
      db.collection('sessions').deleteMany({}),
    ]);

    // Multi-tenancy Fase 1: createAuthMiddleware calienta el cache de
    // tenant-registry.js (getTenantDb/getTenantReffDb) antes de propagar el
    // contexto — el tenant de prueba debe existir en elvira_control.tenants,
    // igual que 'equipo-interno' en produccion real.
    await client.db('elvira_control').collection('tenants').updateOne(
      { _id: TENANT },
      { $set: {
        _id: TENANT,
        kind: 'internal',
        displayName: 'Auth test',
        status: 'active',
        mongo: { mode: 'shared-cluster', uri: null, dbName: 'elvira_test', reffDbName: 'elvira_test' },
        createdAt: new Date().toISOString(),
      } },
      { upsert: true },
    );

    // usuarios de prueba directos (sin depender de SEED_* env vars); cada bloque que
    // cambia la contraseña usa su propio usuario para no afectar al resto
    const user = (_id, password) => ({
      _id, passwordHash: bcrypt.hashSync(password, 12), role: 'admin', tenantId: TENANT, createdAt: new Date().toISOString(),
    });
    await db.collection('users').insertMany([
      user('test@snficorp.com', 'correcta123'),
      user('cambio@snficorp.com', 'antigua123'),
      user('otro@snficorp.com', 'otra12345'),
    ]);

    app = express();
    app.use(express.json());
    const authLimiter = (req, res, next) => next(); // sin rate limit en test
    const { auth } = mountAuth(app, {
      mongo: db,
      requireAdmin: (req, res, next) => next(),
      ROLE_MESAS: { admin: ['elvira', 'reff'] },
      authLimiter,
      sentinelForensics: noopSentinel,
      busEmit: (e) => busEvents.push(e),
    });
    // Equivalente a un stream SSE: el token llega por query string.
    app.get('/api/test/stream', auth, (req, res) => res.json({ user: req.user }));

    server = app.listen(0);
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await Promise.all([
      db.collection('users').deleteMany({}),
      db.collection('sessions').deleteMany({}),
      client.db('elvira_control').collection('tenants').deleteOne({ _id: TENANT }),
    ]);
    await client.close();
    await new Promise((resolve) => server.close(resolve));
    // Cada archivo de test corre en su propio proceso worker aislado (ver
    // "node --test" con multiples archivos en package.json) — cerrar el
    // MongoClient GLOBAL aqui no afecta a otros archivos de la suite, cada
    // uno tiene su propia instancia de db/mongo.js. Sin esto, el handle de
    // conexion abierto por connectMongo() (arriba) deja el event loop vivo
    // y el proceso nunca termina solo al correr este archivo aislado.
    await closeMongo();
  });

  test('login con usuario inexistente devuelve 401 (login normal, sin restriccion de dominio)', async () => {
    const { status, body } = await login('alguien@gmail.com', 'x');
    assert.equal(status, 401);
    assert.match(body.error, /Credenciales inválidas/);
  });

  test('login con credenciales invalidas devuelve 401', async () => {
    const { status, body } = await login('test@snficorp.com', 'incorrecta');
    assert.equal(status, 401);
    assert.match(body.error, /Credenciales inválidas/);
  });

  test('login con usuario o contraseña que no son texto devuelve 401, nunca 500', async () => {
    for (const body of [
      { username: { $ne: null }, password: 'correcta123' },
      { username: ['test@snficorp.com'], password: 'correcta123' },
      { username: 'test@snficorp.com', password: { $ne: null } },
      { username: 'test@snficorp.com' },
    ]) {
      const res = await fetchJson('/api/login', { method: 'POST', body: JSON.stringify(body) });
      assert.equal(res.status, 401, JSON.stringify(body));
      assert.equal(res.body.token, undefined);
    }
  });

  test('login correcto devuelve token y en Mongo guarda solo su sha256', async () => {
    const { status, body } = await login('test@snficorp.com', 'correcta123');
    assert.equal(status, 200);
    assert.ok(body.token);
    assert.equal(body.user, 'test@snficorp.com');
    assert.equal(body.role, 'admin');

    const session = await db.collection('sessions').findOne({ _id: hashSessionToken(body.token) });
    assert.ok(session);
    assert.equal(session.user, 'test@snficorp.com');
    assert.ok(session.exp > new Date());
    // el token en claro no aparece en ningun campo del documento
    assert.equal(await db.collection('sessions').findOne({ _id: body.token }), null);
    assert.ok(!JSON.stringify(session).includes(body.token));
  });

  test('el hash guardado no sirve como token: leer la coleccion no da sesiones utilizables', async () => {
    const { body } = await login('test@snficorp.com', 'correcta123');
    const leaked = hashSessionToken(body.token);
    assert.equal((await me(leaked)).status, 401);
    assert.equal((await me(body.token)).status, 200);
  });

  test('/api/me con token valido devuelve el usuario y su tenantId', async () => {
    const { body: session } = await login('test@snficorp.com', 'correcta123');
    const { status, body } = await me(session.token);
    assert.equal(status, 200);
    assert.equal(body.user, 'test@snficorp.com');
    assert.equal(body.tenantId, TENANT);
  });

  test('/api/me sin token devuelve 401', async () => {
    const { status } = await fetchJson('/api/me');
    assert.equal(status, 401);
  });

  test('/api/me con token expirado devuelve 401 aunque Mongo aun no lo haya purgado', async () => {
    const expiredToken = 'expired-token-test';
    await db.collection('sessions').insertOne({
      _id: hashSessionToken(expiredToken), user: 'test@snficorp.com', role: 'admin', tenantId: TENANT,
      exp: new Date(Date.now() - 1000), // ya expirada
    });
    const { status } = await me(expiredToken);
    assert.equal(status, 401);
  });

  test('sesiones: indice TTL sobre exp, para que Mongo purgue las caducadas', async () => {
    const created = [];
    const recorder = { collection: (name) => ({ createIndex: async (keys, opts) => { created.push({ name, keys, opts }); } }) };
    await ensureTenantIndexes(recorder);
    const ttl = created.find((i) => i.name === 'sessions' && i.keys.exp === 1);
    assert.ok(ttl, 'falta el indice de sessions sobre exp');
    assert.equal(ttl.opts?.expireAfterSeconds, 0);
  });

  test('isSessionActive: viva, caducada, desconocida y valores que no son texto', async () => {
    const { body } = await login('test@snficorp.com', 'correcta123');
    assert.equal(await isSessionActive(db, hashSessionToken(body.token)), true);
    assert.equal(await isSessionActive(db, hashSessionToken('expired-token-test')), false);
    assert.equal(await isSessionActive(db, hashSessionToken('nunca-emitido')), false);
    // el token en claro no es el identificador de la sesion
    assert.equal(await isSessionActive(db, body.token), false);
    for (const v of [undefined, null, '', 42, { $ne: null }]) assert.equal(await isSessionActive(db, v), false);
  });

  test('stream SSE: token por query string valido, y un token en forma de lista no rompe el middleware', async () => {
    const { body } = await login('test@snficorp.com', 'correcta123');
    const ok = await fetchJson(`/api/test/stream?token=${body.token}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user, 'test@snficorp.com');
    const list = await fetchJson(`/api/test/stream?token=${body.token}&token=${body.token}`);
    assert.equal(list.status, 401);
    const outsideStream = await fetchJson(`/api/me?token=${body.token}`);
    assert.equal(outsideStream.status, 401);
  });

  test('logout borra la sesion de Mongo y el token deja de valer', async () => {
    const { body: session } = await login('test@snficorp.com', 'correcta123');
    const token = session.token;

    const { status } = await fetchJson('/api/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(status, 200);

    assert.equal(await db.collection('sessions').findOne({ _id: hashSessionToken(token) }), null);
    assert.equal((await me(token)).status, 401);

    const again = await fetchJson('/api/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    assert.equal(again.status, 401);
  });

  test('logout solo cierra la sesion propia, no otras del mismo usuario', async () => {
    const a = (await login('test@snficorp.com', 'correcta123')).body.token;
    const b = (await login('test@snficorp.com', 'correcta123')).body.token;
    await fetchJson('/api/logout', { method: 'POST', headers: { Authorization: `Bearer ${a}` } });
    assert.equal((await me(a)).status, 401);
    assert.equal((await me(b)).status, 200);
  });

  test('change-password rechaza contraseña actual incorrecta y no cierra sesiones', async () => {
    const { body: session } = await login('test@snficorp.com', 'correcta123');
    const { status } = await fetchJson('/api/change-password', {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ currentPassword: 'mala', newPassword: 'nuevaClave123' }),
    });
    assert.equal(status, 401);
    assert.equal((await me(session.token)).status, 200);
  });

  test('change-password con datos que no son texto devuelve 400', async () => {
    const { body: session } = await login('test@snficorp.com', 'correcta123');
    const { status } = await fetchJson('/api/change-password', {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ currentPassword: { $ne: null }, newPassword: 'nuevaClave123' }),
    });
    assert.equal(status, 400);
  });

  test('change-password cierra el resto de sesiones del usuario y conserva la de quien la cambia', async () => {
    const actual = (await login('cambio@snficorp.com', 'antigua123')).body.token;
    const otraDelMismo = (await login('cambio@snficorp.com', 'antigua123')).body.token;
    const terceraDelMismo = (await login('cambio@snficorp.com', 'antigua123')).body.token;
    const deOtroUsuario = (await login('otro@snficorp.com', 'otra12345')).body.token;

    const changed = await fetchJson('/api/change-password', {
      method: 'POST',
      headers: { Authorization: `Bearer ${actual}` },
      body: JSON.stringify({ currentPassword: 'antigua123', newPassword: 'nuevaClave123' }),
    });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.closedSessions, 2);

    assert.equal((await me(actual)).status, 200);
    assert.equal((await me(otraDelMismo)).status, 401);
    assert.equal((await me(terceraDelMismo)).status, 401);
    assert.equal((await me(deOtroUsuario)).status, 200);
    assert.equal(await db.collection('sessions').countDocuments({ user: 'cambio@snficorp.com' }), 1);

    const event = busEvents.find((e) => e.label === 'PASSWORD_CHANGE · cambio@snficorp.com');
    assert.equal(event?.payload.closedSessions, 2);
  });

  test('change-password con contraseña correcta actualiza el hash y permite nuevo login', async () => {
    const { body: session } = await login('test@snficorp.com', 'correcta123');
    const changed = await fetchJson('/api/change-password', {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ currentPassword: 'correcta123', newPassword: 'nuevaClave123' }),
    });
    assert.equal(changed.status, 200);

    assert.equal((await login('test@snficorp.com', 'correcta123')).status, 401);
    assert.equal((await login('test@snficorp.com', 'nuevaClave123')).status, 200);
  });
});

describe('auth.routes: ensureUsersSeed', { skip: skip && 'MONGO_URI no configurada' }, () => {
  test('no crea usuarios si la coleccion ya tiene datos', async () => {
    const c2 = new MongoClient(MONGO_URI);
    await c2.connect();
    const db2 = c2.db('elvira_test');
    await db2.collection('users').deleteMany({});
    await db2.collection('users').insertOne({ _id: 'existing@snficorp.com', passwordHash: 'x', role: 'admin' });

    await ensureUsersSeed(db2);
    const count = await db2.collection('users').countDocuments();
    assert.equal(count, 1); // no añadió seeds porque ya había 1 usuario

    await db2.collection('users').deleteMany({});
    await c2.close();
  });
});
