/**
 * Estado compartido entre réplicas sobre Mongo real de prueba (elvira_test_shared):
 * contador del límite de tasa, estado de Elvi-Ra, avisos al Admin, historial de
 * búsquedas de Rëff y la importación única de los JSON de data/. Cada "réplica" es un
 * Express propio con sus módulos montados sobre la misma base.
 * Se salta si no hay MONGO_URI configurada.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MongoClient } from 'mongodb';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { MongoRateLimitStore, ensureRateLimitIndexes, RATE_LIMIT_COLLECTION } from '../lib/mongo-rate-limit-store.js';
import { createElviraStore, migrateElviraFile } from '../routes/elvira-store.js';
import { mountNotifications, ensureAdminNotificationIndexes, migrateAdminNotificationsFile } from '../routes/notifications.routes.js';
import { mountReffCrm, migrateSearchHistoryFile } from '../routes/reff-crm.routes.js';

const MONGO_URI = process.env.MONGO_URI;
const skip = !MONGO_URI;

const COLLECTIONS = [RATE_LIMIT_COLLECTION, 'elvira_state', 'admin_notifications', 'search_history', 'json_migrations'];

let client, db, tmpDir;
const servers = [];

async function listen(app) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

function authAs(user, role = 'admin') {
  return (req, _res, next) => { req.user = user; req.role = role; next(); };
}
const requireAdmin = (req, res, next) => (req.role === 'admin' ? next() : res.status(403).json({ error: 'admin requerido' }));

async function call(base, pathName, opts = {}) {
  const res = await fetch(`${base}${pathName}`, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function writeTmp(name, data) {
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
  return file;
}

const clean = () => Promise.all(COLLECTIONS.map((c) => db.collection(c).deleteMany({})));

describe('estado compartido entre réplicas', { skip: skip && 'MONGO_URI no configurada' }, () => {
  before(async () => {
    client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db('elvira_test_shared');
    await clean();
    await ensureRateLimitIndexes(db);
    await ensureAdminNotificationIndexes(db);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-state-'));
  });

  after(async () => {
    await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
    await clean();
    await client.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('MongoRateLimitStore', () => {
    function limitedApp(opts = {}) {
      const app = express();
      app.use(rateLimit({
        windowMs: 60_000, limit: 3, standardHeaders: 'draft-7', legacyHeaders: false,
        keyGenerator: () => 'cliente-1',
        store: new MongoRateLimitStore({ db, prefix: 'test-shared:' }),
        ...opts,
      }));
      app.get('/ok', (_req, res) => res.json({ ok: true }));
      app.get('/fail', (_req, res) => res.status(401).json({ ok: false }));
      return listen(app);
    }

    test('dos réplicas cuentan sobre el mismo contador', async () => {
      const [a, b] = await Promise.all([limitedApp(), limitedApp()]);
      const statuses = [];
      for (const base of [a, b, a, b]) statuses.push((await call(base, '/ok')).status);
      assert.deepEqual(statuses, [200, 200, 200, 429]);
    });

    test('los incrementos simultáneos no se pierden y la ventana caducada vuelve a 1', async () => {
      const store = new MongoRateLimitStore({ db, prefix: 'test-concurrent:' });
      store.init({ windowMs: 60_000 });
      const results = await Promise.all(Array.from({ length: 25 }, () => store.increment('k')));
      assert.deepEqual(results.map((r) => r.totalHits).sort((x, y) => x - y), Array.from({ length: 25 }, (_, i) => i + 1));
      assert.equal((await store.get('k')).totalHits, 25);

      await db.collection(RATE_LIMIT_COLLECTION).updateOne({ _id: 'test-concurrent:k' }, { $set: { resetTime: new Date(Date.now() - 1000) } });
      assert.equal(await store.get('k'), undefined);
      const fresh = await store.increment('k');
      assert.equal(fresh.totalHits, 1);
      assert.ok(fresh.resetTime > new Date(Date.now() + 50_000));
    });

    test('decrement, resetKey y resetAll respetan el prefijo', async () => {
      const store = new MongoRateLimitStore({ db, prefix: 'test-reset:' });
      const other = new MongoRateLimitStore({ db, prefix: 'test-other:' });
      store.init({ windowMs: 60_000 });
      other.init({ windowMs: 60_000 });
      await store.increment('x');
      await store.increment('x');
      await store.decrement('x');
      assert.equal((await store.get('x')).totalHits, 1);
      await store.resetKey('x');
      assert.equal(await store.get('x'), undefined);

      await store.increment('y');
      await other.increment('y');
      await store.resetAll();
      assert.equal(await store.get('y'), undefined);
      assert.equal((await other.get('y')).totalHits, 1);
    });

    test('skipFailedRequests descuenta en el contador compartido', async () => {
      const base = await limitedApp({ skipFailedRequests: true, keyGenerator: () => 'cliente-2' });
      for (let i = 0; i < 5; i++) assert.equal((await call(base, '/fail')).status, 401);
      // la librería descuenta al terminar la respuesta, sin esperar a la siguiente petición
      await new Promise((resolve) => setTimeout(resolve, 100));
      const doc = await db.collection(RATE_LIMIT_COLLECTION).findOne({ _id: 'test-shared:cliente-2' });
      assert.equal(doc.hits, 0);
    });
  });

  describe('estado de Elvi-Ra', () => {
    test('sin documento devuelve el estado de serie', async () => {
      await db.collection('elvira_state').deleteMany({});
      const { readElvira } = createElviraStore(db);
      const state = await readElvira();
      assert.equal(state.systems.ophs.status, 'pending');
      assert.deepEqual(state.cnmc.documents, []);
    });

    test('escrituras simultáneas de dos réplicas no se pisan', async () => {
      await db.collection('elvira_state').deleteMany({});
      const a = createElviraStore(db);
      const b = createElviraStore(db);
      await Promise.all(Array.from({ length: 6 }, (_, i) => (i % 2 ? a : b).updateElvira((state) => {
        state.bridges.sentinel.events.unshift({ id: `ev-${i}` });
      })));
      const state = await a.readElvira();
      assert.equal(state.bridges.sentinel.events.length, 6);
      assert.deepEqual(state.bridges.sentinel.events.map((e) => e.id).sort(), ['ev-0', 'ev-1', 'ev-2', 'ev-3', 'ev-4', 'ev-5']);
      const doc = await db.collection('elvira_state').findOne({ _id: 'state' });
      assert.equal(doc.rev, 6);
    });

    test('updateElvira devuelve lo que devuelve el cambio', async () => {
      const { updateElvira } = createElviraStore(db);
      const value = await updateElvira((state) => { state.systems.ophs.endpoint = 'x'; return state.systems.ophs; });
      assert.equal(value.endpoint, 'x');
    });

    test('importa elvira.json una vez, con las claves øphs en ASCII', async () => {
      await db.collection('elvira_state').deleteMany({});
      await db.collection('json_migrations').deleteMany({});
      const file = writeTmp('elvira.json', {
        systems: { 'øphs': { status: 'pending', endpoint: 'legacy' }, tcontroler: { tokensUsed: 7, byUser: {} } },
        'øphs': { weights: { W: 1 }, threshold: { estrategico: 1, operativo: 0 }, dictamenes: [{ id: 'd1' }] },
        bridges: { sentinel: { events: [] }, herzog: { audits: [] } },
      });
      assert.equal((await migrateElviraFile(db, file)).imported, 1);
      const doc = await db.collection('elvira_state').findOne({ _id: 'state' });
      assert.equal(doc.ophs.dictamenes[0].id, 'd1');
      assert.equal(doc.systems.ophs.endpoint, 'legacy');
      assert.equal(doc.systems.tcontroler.tokensUsed, 7);
      assert.ok(!('øphs' in doc) && !('øphs' in doc.systems));
      assert.deepEqual(doc.cnmc, { documents: [], auditLog: [] });

      const { updateElvira } = createElviraStore(db);
      await updateElvira((state) => { state.ophs.dictamenes = []; });
      assert.equal((await migrateElviraFile(db, file)).skipped, 'done');
      assert.deepEqual((await db.collection('elvira_state').findOne({ _id: 'state' })).ophs.dictamenes, []);
    });
  });

  describe('avisos al Admin', () => {
    async function replica() {
      const app = express();
      app.use(express.json());
      const api = mountNotifications(app, { auth: authAs('admin'), requireAdmin, mongo: db });
      return { api, base: await listen(app) };
    }

    async function waitFor(fn) {
      for (let i = 0; i < 50; i++) {
        const value = await fn();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error('condicion no cumplida a tiempo');
    }

    test('un aviso creado en una réplica aparece en la otra', async () => {
      await db.collection('admin_notifications').deleteMany({});
      const [a, b] = await Promise.all([replica(), replica()]);
      const notif = a.api.adminNotify({ origin: 'TEST', label: 'desde A', severity: 'warning' });
      const seen = await waitFor(async () => {
        const { body } = await call(b.base, '/api/notifications');
        return body.notifications.find((n) => n.id === notif.id);
      });
      assert.equal(seen.label, 'desde A');
      assert.equal(seen.read, false);

      const { body: counts } = await call(b.base, '/api/notifications');
      assert.equal(counts.unread, 1);

      assert.equal((await call(b.base, `/api/notifications/${notif.id}/read`, { method: 'POST' })).status, 200);
      const stored = await db.collection('admin_notifications').findOne({ _id: notif.id });
      assert.equal(stored.read, true);
      assert.equal(stored.expireAt.getTime(), Date.parse(notif.ts) + 1000 * 60 * 60 * 24 * 30 * 6);
      assert.equal((await a.api.listAdminNotifications())[0].read, true);

      assert.equal((await call(a.base, '/api/notifications', { method: 'DELETE' })).status, 200);
      assert.equal((await call(b.base, `/api/notifications/${notif.id}`, { method: 'DELETE' })).status, 404);
    });

    test('read-all y tope de 300', async () => {
      await db.collection('admin_notifications').deleteMany({});
      const base = new Date('2026-01-01T00:00:00Z').getTime();
      await db.collection('admin_notifications').insertMany(Array.from({ length: 300 }, (_, i) => ({
        _id: `old-${i}`, ts: new Date(base + i * 1000).toISOString(), origin: 'TEST', severity: 'error', label: `n${i}`, detail: '', read: false,
      })));
      const { api, base: url } = await replica();
      const fresh = api.adminNotify({ label: 'nuevo' });
      await waitFor(async () => !(await db.collection('admin_notifications').findOne({ _id: 'old-0' })));
      assert.equal(await db.collection('admin_notifications').countDocuments({}), 300);
      assert.ok(await db.collection('admin_notifications').findOne({ _id: fresh.id }));

      assert.equal((await call(url, '/api/notifications/read-all', { method: 'POST' })).status, 200);
      assert.equal(await db.collection('admin_notifications').countDocuments({ read: false }), 0);
      assert.equal(await db.collection('admin_notifications').countDocuments({ expireAt: { $type: 'date' } }), 300);
    });

    test('importa admin_notifications.json una sola vez', async () => {
      await db.collection('admin_notifications').deleteMany({});
      await db.collection('json_migrations').deleteMany({});
      const file = writeTmp('admin_notifications.json', [
        { id: 'n1', ts: '2026-10-01T10:00:00.000Z', origin: 'SYSTEM', severity: 'error', label: 'uno', detail: '', read: false },
        { id: 'n2', ts: '2026-09-01T10:00:00.000Z', origin: 'SYSTEM', severity: 'warning', label: 'dos', detail: '', read: true },
      ]);
      assert.equal((await migrateAdminNotificationsFile(db, file)).imported, 2);
      const read = await db.collection('admin_notifications').findOne({ _id: 'n2' });
      assert.ok(read.expireAt instanceof Date);
      assert.equal((await db.collection('admin_notifications').findOne({ _id: 'n1' })).expireAt, undefined);

      await db.collection('admin_notifications').deleteOne({ _id: 'n1' });
      assert.equal((await migrateAdminNotificationsFile(db, file)).skipped, 'done');
      assert.equal(await db.collection('admin_notifications').countDocuments({}), 1);
    });

    test('sin archivo o con archivo ilegible no importa ni marca', async () => {
      await db.collection('json_migrations').deleteMany({});
      assert.equal((await migrateAdminNotificationsFile(db, path.join(tmpDir, 'no-existe.json'))).skipped, 'no-file');
      assert.equal((await migrateAdminNotificationsFile(db, writeTmp('roto.json', '{no es json'))).skipped, 'unreadable');
      assert.equal(await db.collection('json_migrations').countDocuments({}), 0);
    });
  });

  describe('historial de búsquedas de Rëff', () => {
    async function reffReplica(user) {
      const app = express();
      app.use(express.json());
      mountReffCrm(app, {
        auth: authAs(user, 'reff'), mongo: db, withTransaction: async (fn) => fn(), adminNotify: () => {},
        readElvira: async () => ({}),
      });
      return listen(app);
    }

    test('importa el JSON sin lo caducado, lista por usuario y borra solo lo propio', async () => {
      await db.collection('search_history').deleteMany({});
      await db.collection('json_migrations').deleteMany({});
      const now = Date.now();
      const file = writeTmp('search_history.json', {
        marc: [
          { id: 'h1', createdAt: new Date(now - 3600_000).toISOString(), filters: { pais: 'España' }, resumen: 'r1', results: [] },
          { id: 'h0', createdAt: new Date(now - 49 * 3600_000).toISOString(), filters: {}, resumen: 'caducada', results: [] },
        ],
        ana: [{ id: 'h2', createdAt: new Date(now - 60_000).toISOString(), filters: {}, resumen: 'r2', results: [] }],
      });
      assert.equal((await migrateSearchHistoryFile(db, file)).imported, 2);
      assert.equal((await migrateSearchHistoryFile(db, file)).skipped, 'done');

      const [marc, ana] = await Promise.all([reffReplica('marc'), reffReplica('ana')]);
      const { body: list } = await call(marc, '/api/search/history');
      assert.deepEqual(list, [{ id: 'h1', createdAt: list[0].createdAt, filters: { pais: 'España' }, resumen: 'r1', results: [] }]);

      assert.equal((await call(ana, '/api/search/history/h1', { method: 'DELETE' })).status, 404);
      assert.equal((await call(marc, '/api/search/history/h1', { method: 'DELETE' })).status, 200);
      assert.deepEqual((await call(marc, '/api/search/history')).body, []);
      assert.equal((await call(ana, '/api/search/history')).body.length, 1);
    });
  });
});
