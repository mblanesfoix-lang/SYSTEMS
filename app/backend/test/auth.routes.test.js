/**
 * Test de auth.routes.js (login/logout/me/change-password) contra Mongo real
 * de prueba. Usa una app Express minima, no el server.js completo, para
 * aislar el modulo de auth de las ~4000 lineas de mesas/integraciones.
 * Se salta si no hay MONGO_URI configurada.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MongoClient } from 'mongodb';
import express from 'express';
import bcrypt from 'bcrypt';
import { mountAuth, ensureUsersSeed } from '../routes/auth.routes.js';

const MONGO_URI = process.env.MONGO_URI;
const skip = !MONGO_URI;

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

describe('auth.routes: login/logout/sesiones sobre Mongo', { skip: skip && 'MONGO_URI no configurada' }, () => {
  before(async () => {
    client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db('elvira_test');
    await Promise.all([
      db.collection('users').deleteMany({}),
      db.collection('sessions').deleteMany({}),
    ]);

    // usuario de prueba directo (sin depender de SEED_* env vars)
    await db.collection('users').insertOne({
      _id: 'test@snficorp.com',
      passwordHash: bcrypt.hashSync('correcta123', 12),
      role: 'admin',
      createdAt: new Date().toISOString(),
    });

    app = express();
    app.use(express.json());
    const authLimiter = (req, res, next) => next(); // sin rate limit en test
    mountAuth(app, {
      mongo: db,
      requireAdmin: (req, res, next) => next(),
      ROLE_MESAS: { admin: ['elvira', 'reff'] },
      authLimiter,
      sentinelForensics: noopSentinel,
      busEmit: (e) => busEvents.push(e),
    });

    server = app.listen(0);
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await Promise.all([
      db.collection('users').deleteMany({}),
      db.collection('sessions').deleteMany({}),
    ]);
    await client.close();
    await new Promise((resolve) => server.close(resolve));
  });

  test('login con dominio no autorizado devuelve 403 sin tocar Mongo', async () => {
    const { status, body } = await fetchJson('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'alguien@gmail.com', password: 'x' }),
    });
    assert.equal(status, 403);
    assert.match(body.error, /Dominio no autorizado/);
  });

  test('login con credenciales invalidas devuelve 401', async () => {
    const { status, body } = await fetchJson('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'test@snficorp.com', password: 'incorrecta' }),
    });
    assert.equal(status, 401);
    assert.match(body.error, /Credenciales inválidas/);
  });

  test('login correcto devuelve token y crea sesion en Mongo', async () => {
    const { status, body } = await fetchJson('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'test@snficorp.com', password: 'correcta123' }),
    });
    assert.equal(status, 200);
    assert.ok(body.token);
    assert.equal(body.user, 'test@snficorp.com');
    assert.equal(body.role, 'admin');

    const session = await db.collection('sessions').findOne({ _id: body.token });
    assert.ok(session);
    assert.equal(session.user, 'test@snficorp.com');
    assert.ok(session.exp > new Date());
  });

  test('/api/me con token valido devuelve el usuario', async () => {
    const login = await fetchJson('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'test@snficorp.com', password: 'correcta123' }),
    });
    const { status, body } = await fetchJson('/api/me', {
      headers: { Authorization: `Bearer ${login.body.token}` },
    });
    assert.equal(status, 200);
    assert.equal(body.user, 'test@snficorp.com');
  });

  test('/api/me sin token devuelve 401', async () => {
    const { status } = await fetchJson('/api/me');
    assert.equal(status, 401);
  });

  test('/api/me con token expirado devuelve 401', async () => {
    const expiredToken = 'expired-token-test';
    await db.collection('sessions').insertOne({
      _id: expiredToken, user: 'test@snficorp.com', role: 'admin',
      exp: new Date(Date.now() - 1000), // ya expirada
    });
    const { status } = await fetchJson('/api/me', {
      headers: { Authorization: `Bearer ${expiredToken}` },
    });
    assert.equal(status, 401);
  });

  test('logout borra la sesion de Mongo', async () => {
    const login = await fetchJson('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'test@snficorp.com', password: 'correcta123' }),
    });
    const token = login.body.token;

    const { status } = await fetchJson('/api/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(status, 200);

    const session = await db.collection('sessions').findOne({ _id: token });
    assert.equal(session, null);

    const meAfterLogout = await fetchJson('/api/me', { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(meAfterLogout.status, 401);
  });

  test('change-password rechaza contraseña actual incorrecta', async () => {
    const login = await fetchJson('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'test@snficorp.com', password: 'correcta123' }),
    });
    const { status } = await fetchJson('/api/change-password', {
      method: 'POST',
      headers: { Authorization: `Bearer ${login.body.token}` },
      body: JSON.stringify({ currentPassword: 'mala', newPassword: 'nuevaClave123' }),
    });
    assert.equal(status, 401);
  });

  test('change-password con contraseña correcta actualiza el hash y permite nuevo login', async () => {
    const login = await fetchJson('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'test@snficorp.com', password: 'correcta123' }),
    });
    const changed = await fetchJson('/api/change-password', {
      method: 'POST',
      headers: { Authorization: `Bearer ${login.body.token}` },
      body: JSON.stringify({ currentPassword: 'correcta123', newPassword: 'nuevaClave123' }),
    });
    assert.equal(changed.status, 200);

    const oldPwLogin = await fetchJson('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'test@snficorp.com', password: 'correcta123' }),
    });
    assert.equal(oldPwLogin.status, 401);

    const newPwLogin = await fetchJson('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'test@snficorp.com', password: 'nuevaClave123' }),
    });
    assert.equal(newPwLogin.status, 200);
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
