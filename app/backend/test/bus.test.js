/**
 * Bus de eventos compartido entre réplicas sobre Mongo real de prueba (elvira_test_bus):
 * cada "réplica" es un Express propio con su propia conexión a Mongo, montado sobre la
 * misma base. Difusión por change streams (el mongod de pruebas es replica set), modo en
 * proceso, Last-Event-ID, historial, caducidad, importación de bus_history.json, apagado,
 * reanudación con resume token y SSE de avisos al Admin.
 * Se salta si no hay MONGO_URI configurada.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { MongoClient } from 'mongodb';
import express from 'express';
import { mountBus, ensureBusIndexes, migrateBusHistoryFile, BUS_COLLECTION } from '../routes/bus.routes.js';
import { mountNotifications, ensureAdminNotificationIndexes } from '../routes/notifications.routes.js';
import { createChangeFeed, supportsChangeStreams } from '../lib/change-feed.js';

const MONGO_URI = process.env.MONGO_URI;
const skip = !MONGO_URI;
const DB_NAME = 'elvira_test_bus';
const DAY_MS = 24 * 60 * 60 * 1000;
const COLLECTIONS = [BUS_COLLECTION, 'counters', 'json_migrations', 'admin_notifications', 'feed_probe'];

const clients = [];
const servers = [];
const sseConnections = [];
const closers = [];
let db, tmpDir;
const quietLogger = { warn() {}, error() {}, log() {} };

async function connect() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  clients.push(client);
  return client.db(DB_NAME);
}

async function listen(app) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

const auth = (req, _res, next) => { req.user = 'test@snficorp.com'; req.role = 'admin'; next(); };
const requireAdmin = (_req, _res, next) => next();

async function busReplica(opts = {}) {
  const app = express();
  app.use(express.json());
  const api = await mountBus(app, { auth, mongo: await connect(), adminNotify: () => {}, logger: quietLogger, ...opts });
  closers.push(api.closeBus);
  return { api, base: await listen(app) };
}

async function call(base, pathName, opts = {}) {
  const res = await fetch(`${base}${pathName}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/* Cliente SSE mínimo: guarda cada mensaje como { id, data }. */
function sse(base, pathName, headers = {}) {
  const messages = [];
  let req;
  const ready = new Promise((resolve, reject) => {
    req = http.get(`${base}${pathName}`, { headers }, (res) => {
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', (chunk) => {
        buf += chunk;
        let cut;
        while ((cut = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          const msg = {};
          for (const line of block.split('\n')) {
            if (line.startsWith('id: ')) msg.id = line.slice(4);
            else if (line.startsWith('data: ')) msg.data = JSON.parse(line.slice(6));
          }
          if (msg.data) messages.push(msg);
        }
      });
      res.on('error', () => {});
      resolve(res);
    });
    req.on('error', reject);
  });
  const conn = { messages, ready, close: () => req.destroy() };
  sseConnections.push(conn);
  return conn;
}

async function waitFor(fn, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('tiempo agotado esperando la condicion');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const emit = (base, body) => call(base, '/api/bus/emit', { method: 'POST', body });
const clean = () => Promise.all(COLLECTIONS.map((c) => db.collection(c).deleteMany({})));

describe('bus de eventos entre réplicas', { skip: skip && 'MONGO_URI no configurada' }, () => {
  before(async () => {
    db = await connect();
    await clean();
    await ensureBusIndexes(db);
    await ensureAdminNotificationIndexes(db);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-'));
  });

  after(async () => {
    for (const conn of sseConnections) conn.close();
    for (const close of closers) await close();
    for (const server of servers) server.closeAllConnections();
    await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
    await clean();
    await Promise.all(clients.map((c) => c.close()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('el mongod de pruebas admite change streams', async () => {
    assert.equal(await supportsChangeStreams(db), true);
  });

  describe('con change streams', () => {
    let A, B;
    before(async () => {
      await clean();
      A = await busReplica();
      B = await busReplica();
    });

    test('un evento emitido en A llega a un cliente SSE conectado a B', async () => {
      assert.equal(A.api.busStatus().crossReplica, true);
      assert.equal(B.api.busStatus().crossReplica, true);
      const client = sse(B.base, '/api/bus/stream');
      await client.ready;

      const { status, body: event } = await emit(A.base, { origin: 'sentinel', state: 'approved', label: 'desde A' });
      assert.equal(status, 201);
      assert.ok(Number.isInteger(event.seq) && event.seq > 0);

      const got = await waitFor(() => client.messages.find((m) => m.data.id === event.id));
      assert.equal(got.id, String(event.seq));
      assert.equal(got.data.label, 'desde A');
      assert.equal(got.data.origin, 'SENTINEL');
      assert.equal(got.data.user, 'test@snficorp.com');

      // También lo que emite una mesa por dentro, sin pasar por HTTP.
      A.api.busEmit({ origin: 'RACK', dest: 'SENTINEL', type: 'rack_state', state: 'COMPLETED', label: 'interno A' });
      await waitFor(() => client.messages.find((m) => m.data.label === 'interno A'));
      // La ventana en memoria de B reúne los eventos de A.
      const snapshot = await call(B.base, '/api/bus/events');
      assert.ok(snapshot.body.events.some((e) => e.id === event.id));
      client.close();
    });

    test('el emisor también lo recibe una sola vez', async () => {
      const client = sse(A.base, '/api/bus/stream');
      await client.ready;
      const { body: event } = await emit(A.base, { label: 'sin duplicar' });
      await waitFor(() => client.messages.find((m) => m.data.id === event.id));
      await sleep(300);
      assert.equal(client.messages.filter((m) => m.data.id === event.id).length, 1);
      client.close();
    });

    test('con Last-Event-ID el cliente recibe lo que se perdió y sigue en directo', async () => {
      const first = sse(B.base, '/api/bus/stream');
      await first.ready;
      const { body: e1 } = await emit(A.base, { label: 'antes del corte' });
      await waitFor(() => first.messages.find((m) => m.data.id === e1.id));
      first.close();

      const { body: e2 } = await emit(A.base, { label: 'perdido 1' });
      const { body: e3 } = await emit(A.base, { label: 'perdido 2' });

      const again = sse(B.base, '/api/bus/stream', { 'Last-Event-ID': String(e1.seq) });
      await again.ready;
      await waitFor(() => again.messages.length >= 2);
      assert.deepEqual(again.messages.slice(0, 2).map((m) => m.data.id), [e2.id, e3.id]);
      assert.deepEqual(again.messages.slice(0, 2).map((m) => m.id), [String(e2.seq), String(e3.seq)]);
      assert.ok(!again.messages.some((m) => m.data.id === e1.id));

      const { body: e4 } = await emit(A.base, { label: 'en directo' });
      await waitFor(() => again.messages.find((m) => m.data.id === e4.id));
      again.close();
    });

    test('sin Last-Event-ID recibe los últimos eventos guardados', async () => {
      const client = sse(B.base, '/api/bus/stream');
      await client.ready;
      await waitFor(() => client.messages.some((m) => m.data.label === 'en directo'));
      const seqs = client.messages.map((m) => Number(m.id));
      assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
      client.close();
    });

    test('el cambio de estado en A llega a B como state_update', async () => {
      const client = sse(B.base, '/api/bus/stream');
      await client.ready;
      const { body: event } = await emit(A.base, { label: 'por aprobar' });
      const patched = await call(A.base, `/api/bus/events/${event.id}`, { method: 'PATCH', body: { state: 'completed' } });
      assert.equal(patched.status, 200);
      assert.equal(patched.body.state, 'COMPLETED');
      const update = await waitFor(() => client.messages.find((m) => m.data.id === event.id && m.data._type === 'state_update'));
      assert.equal(update.data.state, 'COMPLETED');
      assert.equal(update.id, undefined);
      const known = await waitFor(async () => (await call(B.base, '/api/bus/events')).body.events.find((e) => e.id === event.id && e.state === 'COMPLETED'));
      assert.ok(known.updatedAt);

      const missing = await call(A.base, '/api/bus/events/no-existe', { method: 'PATCH', body: { state: 'COMPLETED' } });
      assert.equal(missing.status, 404);
      client.close();
    });
  });

  describe('historial y caducidad', () => {
    let A;
    const retentionMs = 2 * DAY_MS;
    before(async () => {
      await clean();
      A = await busReplica({ retentionMs, crossReplica: false });
      await emit(A.base, { origin: 'SENTINEL', state: 'BLOCKED', type: 'alert', label: 'IP bloqueada 10.0.0.1' });
      await emit(A.base, { origin: 'HERZOG', state: 'COMPLETED', label: 'Informe listo' });
      await emit(A.base, { origin: 'SENTINEL', state: 'APPROVED', label: 'IP revisada' });
    });

    test('se consulta desde Mongo con filtros, más reciente primero', async () => {
      const all = await call(A.base, '/api/bus/history');
      assert.equal(all.body.total, 3);
      assert.deepEqual(all.body.events.map((e) => e.label), ['IP revisada', 'Informe listo', 'IP bloqueada 10.0.0.1']);

      const sentinel = await call(A.base, '/api/bus/history?origin=sentinel');
      assert.equal(sentinel.body.total, 2);
      const text = await call(A.base, '/api/bus/history?q=bloqueada%2010.0.0.1');
      assert.deepEqual(text.body.events.map((e) => e.label), ['IP bloqueada 10.0.0.1']);
      const regexLike = await call(A.base, '/api/bus/history?q=.*');
      assert.equal(regexLike.body.total, 0);
      const future = await call(A.base, `/api/bus/history?from=${new Date(Date.now() + DAY_MS).toISOString()}`);
      assert.equal(future.body.total, 0);
      const page = await call(A.base, '/api/bus/history?limit=1&offset=1');
      assert.deepEqual(page.body.events.map((e) => e.label), ['Informe listo']);
      const bad = await call(A.base, '/api/bus/history?limit=abc&offset=-5');
      assert.equal(bad.body.limit, 200);
      assert.equal(bad.body.offset, 0);
      assert.ok(all.body.events.every((e) => !('_id' in e) && !('expiresAt' in e) && !('createdAt' in e)));
    });

    test('cada evento caduca a la retención fijada, por índice TTL', async () => {
      const docs = await db.collection(BUS_COLLECTION).find({}).toArray();
      assert.equal(docs.length, 3);
      for (const d of docs) assert.equal(d.expiresAt.getTime() - d.createdAt.getTime(), retentionMs);
      const indexes = await db.collection(BUS_COLLECTION).listIndexes().toArray();
      const ttl = indexes.find((i) => i.key.expiresAt === 1);
      assert.equal(ttl.expireAfterSeconds, 0);
      assert.ok(indexes.find((i) => i.key.seq === 1).unique);
    });

    test('closeBus guarda lo pendiente antes de salir', async () => {
      const B = await busReplica({ crossReplica: false });
      for (let i = 0; i < 5; i++) B.api.busEmit({ origin: 'SYSTEM', label: `pendiente ${i}` });
      await B.api.closeBus();
      const stored = await db.collection(BUS_COLLECTION).find({ label: /^pendiente / }).sort({ seq: 1 }).toArray();
      assert.deepEqual(stored.map((d) => d.label), ['pendiente 0', 'pendiente 1', 'pendiente 2', 'pendiente 3', 'pendiente 4']);
    });

    test('un evento rechazado por Mongo no impide guardar el resto de su lote', async () => {
      const B = await busReplica({ crossReplica: false });
      B.api.busEmit({ id: 'repetido', label: 'primero' });
      B.api.busEmit({ id: 'repetido', label: 'segundo' });
      B.api.busEmit({ label: 'detras del repetido' });
      await B.api.closeBus();
      assert.equal(await db.collection(BUS_COLLECTION).countDocuments({ _id: 'repetido' }), 1);
      assert.equal(await db.collection(BUS_COLLECTION).countDocuments({ label: 'detras del repetido' }), 1);
    });
  });

  describe('Mongo sin change streams (modo en proceso)', () => {
    test('cada réplica empuja solo lo suyo y el historial es común', async () => {
      await clean();
      const C = await busReplica({ crossReplica: false });
      const D = await busReplica({ crossReplica: false });
      assert.equal(C.api.busStatus().crossReplica, false);
      assert.match(C.api.busStatus().detail, /solo en esta réplica/);
      const onC = sse(C.base, '/api/bus/stream');
      const onD = sse(D.base, '/api/bus/stream');
      await Promise.all([onC.ready, onD.ready]);

      const { body: event } = await emit(C.base, { label: 'solo C' });
      const got = await waitFor(() => onC.messages.find((m) => m.data.id === event.id));
      assert.equal(got.id, String(event.seq));
      await sleep(300);
      assert.ok(!onD.messages.some((m) => m.data.id === event.id));
      const history = await call(D.base, '/api/bus/history');
      assert.ok(history.body.events.some((e) => e.id === event.id));
      onC.close();
      onD.close();
    });
  });

  describe('importación de bus_history.json', () => {
    test('una sola vez, en orden cronológico y sin lo caducado', async () => {
      await clean();
      const now = Date.now();
      const iso = (ms) => new Date(ms).toISOString();
      const legacy = [
        { id: 'viejo', ts: iso(now - 200 * DAY_MS), origin: 'SYSTEM', label: 'caducado' },
        { id: 'a', ts: iso(now - 2 * DAY_MS), seq: 501, origin: 'SNFI-U2', label: 'evento a' },
        { ts: iso(now - DAY_MS), origin: 'SENTINEL', label: 'sin id' },
        { id: 'a', ts: iso(now - 1.5 * DAY_MS), origin: 'SNFI-U2', label: 'id repetido' },
        { id: 'refresco', ts: iso(now - DAY_MS), _type: 'state_update', label: 'refresco' },
        { at: iso(now - 3 * DAY_MS), type: 'u2-calculo', label: 'solo at' },
      ];
      const file = path.join(tmpDir, 'bus_history.json');
      fs.writeFileSync(file, JSON.stringify(legacy));
      const before = fs.readFileSync(file, 'utf8');

      const first = await migrateBusHistoryFile(db, file, { retentionMs: 90 * DAY_MS });
      assert.equal(first.imported, 3);
      const docs = await db.collection(BUS_COLLECTION).find({}).sort({ seq: 1 }).toArray();
      assert.deepEqual(docs.map((d) => d.label), ['solo at', 'evento a', 'sin id']);
      assert.ok(docs[2]._id.length === 32);
      assert.ok(docs.every((d) => d.expiresAt.getTime() - d.createdAt.getTime() === 90 * DAY_MS));

      const second = await migrateBusHistoryFile(db, file);
      assert.deepEqual(second, { skipped: 'done' });
      assert.equal(await db.collection(BUS_COLLECTION).countDocuments(), 3);
      assert.equal(fs.readFileSync(file, 'utf8'), before);

      // Los importados se sirven por el historial y los nuevos siguen la secuencia.
      const A = await busReplica({ crossReplica: false });
      const { body: fresh } = await emit(A.base, { label: 'nuevo' });
      assert.ok(fresh.seq > docs[2].seq);
      const history = await call(A.base, '/api/bus/history');
      assert.deepEqual(history.body.events.map((e) => e.label), ['nuevo', 'sin id', 'evento a', 'solo at']);
    });

    test('sin archivo no hace nada', async () => {
      await clean();
      const res = await migrateBusHistoryFile(db, path.join(tmpDir, 'no-existe.json'));
      assert.deepEqual(res, { skipped: 'no-file' });
    });
  });

  describe('createChangeFeed', () => {
    test('continúa desde el resume token de un feed anterior', async () => {
      await clean();
      const col = db.collection('feed_probe');
      const seen1 = [];
      const f1 = createChangeFeed({ collection: col, operationTypes: ['insert'], onChange: (c) => seen1.push(c.fullDocument.n), logger: quietLogger });
      f1.start();
      await sleep(300);
      await col.insertOne({ n: 1 });
      await waitFor(() => seen1.length === 1);
      const token = f1.resumeToken;
      await f1.stop();

      await col.insertMany([{ n: 2 }, { n: 3 }]);
      const seen2 = [];
      let resets = 0;
      const f2 = createChangeFeed({
        collection: col, operationTypes: ['insert'], resumeAfter: token, logger: quietLogger,
        onChange: (c) => seen2.push(c.fullDocument.n), onReset: () => { resets += 1; },
      });
      f2.start();
      await waitFor(() => seen2.length === 2);
      assert.deepEqual(seen2, [2, 3]);
      assert.equal(resets, 0);
      await f2.stop();
    });

    test('si el token no sirve, reabre sin él y avisa para recuperar', async () => {
      const col = db.collection('feed_probe');
      const opened = [];
      // Las dos primeras aperturas fallan, como un token fuera del oplog.
      const flaky = {
        watch(pipeline, options) {
          opened.push(options.resumeAfter ? 'token' : 'nuevo');
          if (opened.length > 2) return col.watch(pipeline, options);
          const fake = new EventEmitter();
          fake.close = async () => {};
          setImmediate(() => fake.emit('error', Object.assign(new Error('fallo simulado'), { code: 286 })));
          return fake;
        },
      };
      const seen = [];
      let resets = 0;
      const feed = createChangeFeed({
        collection: flaky, operationTypes: ['insert'], resumeAfter: { _data: 'token-antiguo' }, logger: quietLogger,
        onChange: (c) => seen.push(c.fullDocument.n), onReset: () => { resets += 1; },
      });
      feed.start();
      await waitFor(() => resets === 1, 8000);
      assert.deepEqual(opened, ['token', 'token', 'nuevo']);
      await col.insertOne({ n: 10 });
      await waitFor(() => seen.includes(10));
      await feed.stop();
    });

    test('si la colección se borra, vuelve a abrir el stream', async () => {
      const col = db.collection('feed_probe');
      await col.insertOne({ n: 0 });
      const seen = [];
      let resets = 0;
      const feed = createChangeFeed({
        collection: col, operationTypes: ['insert'], logger: quietLogger,
        onChange: (c) => seen.push(c.fullDocument.n), onReset: () => { resets += 1; },
      });
      feed.start();
      await waitFor(() => resets === 1);
      await col.drop();
      await waitFor(() => resets === 2, 8000);
      await col.insertOne({ n: 20 });
      await waitFor(() => seen.includes(20));
      await feed.stop();
    });
  });

  describe('avisos al Admin', () => {
    test('un aviso creado en A llega al SSE de avisos de B', async () => {
      await clean();
      const replica = async () => {
        const app = express();
        const api = await mountNotifications(app, { auth, requireAdmin, mongo: await connect(), logger: quietLogger });
        closers.push(api.closeNotifications);
        return { api, base: await listen(app) };
      };
      const A = await replica();
      const B = await replica();
      const onB = sse(B.base, '/api/notifications/stream');
      const onA = sse(A.base, '/api/notifications/stream');
      await Promise.all([onA.ready, onB.ready]);
      await sleep(300);

      const notif = A.api.adminNotify({ origin: 'K8S', label: 'Aviso desde A', detail: 'prueba' });
      const got = await waitFor(() => onB.messages.find((m) => m.data.id === notif.id));
      assert.equal(got.data.label, 'Aviso desde A');
      await waitFor(() => onA.messages.find((m) => m.data.id === notif.id));
      await sleep(200);
      assert.equal(onA.messages.filter((m) => m.data.id === notif.id).length, 1);
      onA.close();
      onB.close();
    });
  });
});
