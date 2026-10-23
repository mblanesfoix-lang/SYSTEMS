/**
 * Registro de salidas de Pactvm Viridi (pactvm-egress.js) contra Mongo de
 * prueba: log encadenado, escritura en serie, agregación de consultas
 * automáticas, aviso de salidas denegadas, reintento si la base falla y vista
 * de solo lectura. Se salta sin MONGO_URI.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MongoClient } from 'mongodb';
import express from 'express';
import { createEgressLog, mountPactvmEgress, EGRESS_LOG } from '../pactvm-egress.js';
import { egressFetch, setEgressRecorder } from '../egress/index.js';
import { verifyLog } from '../lib/hash-chain.js';

const MONGO_URI = process.env.MONGO_URI;

let client, dbA, dbB;

const call = (over = {}) => ({
  at: '2026-10-22T10:00:00.000Z', mesa: 'snfiu2', user: 'marc', destination: 'ree-datos', category: 'tercero',
  protocol: 'https', host: 'apidatos.ree.es', port: 443, method: 'GET', path: '/es/datos', redirects: 0,
  bytesOut: 0, bytesIn: 1500, status: 200, reason: null, result: 'ok', durationMs: 120, poll: false, ...over,
});
const newLog = (extra = {}) => createEgressLog({
  resolveDb: (tenantId) => (tenantId === 'tenant-b' ? dbB : dbA), windowMs: 3_600_000, ...extra,
});
const rows = (db) => db.collection(EGRESS_LOG).find({}).sort({ seq: 1 }).toArray();

describe('pactvm-egress: registro encadenado', { skip: !MONGO_URI && 'MONGO_URI no configurada' }, () => {
  before(async () => {
    client = new MongoClient(MONGO_URI);
    await client.connect();
    dbA = client.db('elvira_test_egress_a');
    dbB = client.db('elvira_test_egress_b');
  });
  after(async () => {
    await dbA.dropDatabase();
    await dbB.dropDatabase();
    await client.close();
  });
  beforeEach(async () => {
    await dbA.dropDatabase();
    await dbB.dropDatabase();
  });

  test('cada llamada de una persona queda como entrada encadenada y verificable', async () => {
    const log = newLog();
    log.record(call());
    log.record(call({ mesa: 'elvira', destination: null, category: null, result: 'denegada', status: null, reason: 'destino fuera de la lista blanca' }));
    await log.stop();
    const entries = await rows(dbA);
    assert.equal(entries.length, 2);
    assert.deepEqual(entries.map((e) => e.seq), [1, 2]);
    assert.deepEqual(entries.map((e) => [e.kind, e.mesa, e.result]), [['llamada', 'snfiu2', 'ok'], ['llamada', 'elvira', 'denegada']]);
    assert.equal(entries[0].user, 'marc');
    assert.equal(entries[0].bytesIn, 1500);
    assert.deepEqual(await verifyLog(dbA, EGRESS_LOG), { valid: true, totalEntries: 2, brokenAtSeq: null });
  });

  test('alterar una entrada rompe la cadena', async () => {
    const log = newLog();
    log.record(call());
    log.record(call({ host: 'api.esios.ree.es' }));
    await log.stop();
    await dbA.collection(EGRESS_LOG).updateOne({ seq: 1 }, { $set: { bytesIn: 1 } });
    const v = await verifyLog(dbA, EGRESS_LOG);
    assert.deepEqual([v.valid, v.brokenAtSeq], [false, 1]);
  });

  test('escrituras simultáneas no bifurcan la cadena', async () => {
    const log = newLog();
    for (let i = 0; i < 25; i += 1) log.record(call({ path: `/p${i}` }));
    await log.stop();
    const entries = await rows(dbA);
    assert.equal(entries.length, 25);
    assert.deepEqual(entries.map((e) => e.seq), Array.from({ length: 25 }, (_, i) => i + 1));
    assert.equal((await verifyLog(dbA, EGRESS_LOG)).valid, true);
  });

  test('cada salida va al registro de su tenant; las de fondo, al del tenant por defecto', async () => {
    const log = newLog();
    log.record({ ...call(), tenantId: 'tenant-b' });
    log.record({ ...call(), tenantId: null });
    await log.stop();
    assert.equal((await rows(dbB)).length, 1);
    assert.equal((await rows(dbA)).length, 1);
  });

  test('las consultas automáticas se agregan por ventana en una entrada de resumen', async () => {
    const log = newLog();
    for (let i = 0; i < 5; i += 1) log.record(call({ poll: true, at: `2026-10-22T10:0${i}:00.000Z`, bytesIn: 100, durationMs: 10 }));
    log.record(call({ poll: true, result: 'error', status: 502, reason: 'HTTP 502' }));
    log.record(call({ poll: true, host: 'api.esios.ree.es', destination: 'ree-esios' }));
    assert.equal((await rows(dbA)).length, 0, 'nada se escribe hasta cerrar la ventana');
    assert.equal(log.pending().length, 3);

    await log.flush();
    const entries = await rows(dbA);
    assert.equal(entries.length, 3);
    const ok = entries.find((e) => e.host === 'apidatos.ree.es' && e.result === 'ok');
    assert.deepEqual([ok.kind, ok.calls, ok.bytesIn, ok.durationMs, ok.from, ok.to], ['resumen', 5, 500, 50, '2026-10-22T10:00:00.000Z', '2026-10-22T10:04:00.000Z']);
    const failed = entries.find((e) => e.result === 'error');
    assert.deepEqual([failed.calls, failed.lastStatus, failed.lastReason], [1, 502, 'HTTP 502']);
    assert.equal(log.pending().length, 0);
    assert.equal((await verifyLog(dbA, EGRESS_LOG)).valid, true);
    await log.stop();
  });

  test('una salida denegada avisa al Admin una vez por mesa y destino y ventana', async () => {
    const notified = [];
    const log = newLog({ notifyDenied: (e) => notified.push([e.mesa, e.host]) });
    const denied = (over) => call({ result: 'denegada', status: null, reason: 'fuera de la lista', ...over });
    log.record(denied());
    log.record(denied());
    log.record(denied({ host: 'otro.es' }));
    log.record(denied({ mesa: 'fl' }));
    log.record(call());
    assert.deepEqual(notified, [['snfiu2', 'apidatos.ree.es'], ['snfiu2', 'otro.es'], ['fl', 'apidatos.ree.es']]);
    await log.flush();
    log.record(denied());
    assert.equal(notified.length, 4, 'en la ventana siguiente vuelve a avisar');
    await log.stop();
  });

  test('si la base falla, la entrada se guarda en cuanto vuelve', async () => {
    const originalError = console.error;
    console.error = () => {};
    let down = true;
    const log = createEgressLog({ resolveDb: () => { if (down) throw new Error('base caída'); return dbA; }, windowMs: 3_600_000 });
    try {
      log.record(call());
      await log.flush();
      assert.equal(log.stats().pendingWrites, 1);
      down = false;
      await log.flush();
    } finally {
      console.error = originalError;
    }
    assert.equal(log.stats().pendingWrites, 0);
    assert.equal((await rows(dbA)).length, 1);
    await log.stop();
  });

  test('integrado con la compuerta: lo permitido y lo denegado llegan al registro', async () => {
    const log = newLog();
    setEgressRecorder((e) => log.record(e));
    const env = { EGRESS_ALLOWLIST: 'snfiu2=http://127.0.0.1:1' };
    const fake = async () => new Response('{"a":1}', { status: 200 });
    try {
      await egressFetch('http://127.0.0.1:1/permitido', {}, { mesa: 'snfiu2', user: 'marc' }, { env, fetch: fake });
      await assert.rejects(egressFetch('http://127.0.0.1:2/no', {}, { mesa: 'snfiu2', user: 'marc' }, { env, fetch: fake }), { code: 'denied' });
    } finally {
      setEgressRecorder(null);
    }
    await log.stop();
    const entries = await rows(dbA);
    assert.deepEqual(entries.map((e) => [e.result, e.port, e.user]), [['ok', 1, 'marc'], ['denegada', 2, 'marc']]);
    assert.equal((await verifyLog(dbA, EGRESS_LOG)).valid, true);
  });
});

describe('pactvm-egress: vista de solo lectura', { skip: !MONGO_URI && 'MONGO_URI no configurada' }, () => {
  let app, server, baseUrl, log;
  const get = async (path, role = 'admin') => {
    const res = await fetch(`${baseUrl}${path}`, { headers: { 'x-test-role': role } });
    return { status: res.status, body: await res.json() };
  };

  before(async () => {
    client = new MongoClient(MONGO_URI);
    await client.connect();
    dbA = client.db('elvira_test_egress_a');
    await dbA.dropDatabase();
    log = createEgressLog({ resolveDb: () => dbA, windowMs: 3_600_000 });
    for (let i = 0; i < 6; i += 1) log.record(call({ path: `/p${i}`, bytesIn: 100 }));
    log.record(call({ mesa: 'elvira', result: 'denegada', status: null, reason: 'fuera de la lista', destination: null, category: null, host: 'raro.es', bytesIn: null }));
    log.record(call({ poll: true, host: 'api.esios.ree.es', destination: 'ree-esios', bytesIn: 40 }));
    log.record(call({ poll: true, host: 'api.esios.ree.es', destination: 'ree-esios', bytesIn: 40 }));
    await log.flush();
    log.record(call({ poll: true, mesa: 'fl', host: 'www.boe.es', destination: 'boe' }));

    app = express();
    const auth = (req, _res, next) => { req.user = 'test'; req.role = req.headers['x-test-role'] || 'admin'; next(); };
    const requireMesa = (mesa) => (req, res, next) => (req.role === 'admin' || req.role === mesa ? next() : res.status(403).json({ error: 'Acceso denegado a esta mesa' }));
    const requireAdmin = (req, res, next) => (req.role === 'admin' ? next() : res.status(403).json({ error: 'admin requerido' }));
    mountPactvmEgress(app, {
      auth, requireMesa, requireAdmin, mongo: dbA, egressLog: log,
      env: { MONGO_URI: 'mongodb+srv://usuario:clave-secreta@cluster0.abc.mongodb.net/elvira', EGRESS_TIMEOUT_MS: '9000' },
    });
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    await log.stop();
    server.close();
    await dbA.dropDatabase();
    await client.close();
  });

  test('registro: más recientes primero, con paginación y filtros', async () => {
    const first = await get('/api/pactvm/egress?limit=4');
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.entries.map((e) => e.seq), [8, 7, 6, 5]);
    assert.equal(first.body.nextBefore, 5);
    assert.ok(first.body.entries.every((e) => e._id === undefined && typeof e.hash === 'string'));
    const second = await get('/api/pactvm/egress?limit=4&before=5');
    assert.deepEqual(second.body.entries.map((e) => e.seq), [4, 3, 2, 1]);

    const denied = await get('/api/pactvm/egress?result=denegada');
    assert.deepEqual(denied.body.entries.map((e) => [e.mesa, e.host]), [['elvira', 'raro.es']]);
    assert.equal(denied.body.nextBefore, null);
    assert.deepEqual((await get('/api/pactvm/egress?mesa=elvira')).body.entries.map((e) => e.mesa), ['elvira']);
  });

  test('registro: incluye el resumen de la ventana en curso, aún sin escribir', async () => {
    const { body } = await get('/api/pactvm/egress');
    assert.deepEqual(body.pending.map((p) => [p.kind, p.mesa, p.calls]), [['resumen', 'fl', 1]]);
  });

  test('resumen por destino: llamadas individuales y agregadas cuentan por igual', async () => {
    const { body } = await get('/api/pactvm/egress/summary');
    assert.equal(body.entries, 8);
    assert.equal(body.calls, 6 + 1 + 2);
    assert.equal(body.denied, 1);
    const esios = body.byDestination.find((d) => d.host === 'api.esios.ree.es');
    assert.deepEqual([esios.calls, esios.bytesIn, esios.mesas], [2, 80, ['snfiu2']]);
    assert.equal(body.thirdParties, 2, 'REE datos y ESIOS; el destino denegado nunca se contactó');
  });

  test('integridad de la cadena', async () => {
    const { body } = await get('/api/pactvm/egress/verify');
    assert.deepEqual(body, { valid: true, totalEntries: 8, brokenAtSeq: null });
  });

  test('lista blanca vigente: exportable y sin credenciales', async () => {
    const { status, body } = await get('/api/pactvm/egress/policy');
    assert.equal(status, 200);
    assert.equal(body.timeoutMs, 9000);
    assert.ok(Array.isArray(body.destinations) && body.destinations.length > 0);
    assert.ok(body.destinations.some((d) => d.id === 'boe' && d.mesas[0] === 'fl'));
    assert.ok(body.destinations.some((d) => d.via === 'controlador' && d.host === 'cluster0.abc.mongodb.net'));
    assert.ok(!JSON.stringify(body).includes('clave-secreta'));
    assert.ok(typeof body.generatedAt === 'string');
  });

  test('solo el Admin lo ve, y solo en lectura', async () => {
    for (const path of ['/api/pactvm/egress', '/api/pactvm/egress/summary', '/api/pactvm/egress/verify', '/api/pactvm/egress/policy']) {
      assert.equal((await get(path, 'amir')).status, 403, path);
      assert.equal((await get(path, 'pactvm')).status, 403, 'tener la mesa Pactvm no basta');
      assert.equal((await get(path, 'admin')).status, 200, path);
    }
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await fetch(`${baseUrl}/api/pactvm/egress`, { method });
      assert.equal(res.status, 404, `${method} no existe`);
    }
  });
});
