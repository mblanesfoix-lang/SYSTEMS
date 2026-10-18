/**
 * Registro forense de Sentinel: clave de firma, integridad de la cadena y re-sellado.
 * La parte de cadena usa una base Mongo real de prueba (MONGO_URI del .env, db
 * 'elvira_test') con colecciones propias de cada ejecución, para ejercitar el mismo
 * código que producción sin chocar con otras ejecuciones. Se salta sin MONGO_URI.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import { MongoClient } from 'mongodb';
import { createSentinelForensics, resolveForensicSecret } from '../sentinel-forensics.js';
import { mountSentinelForensicRoutes } from '../routes/sentinel-forensic.routes.js';
import { DEV_FORENSIC_SECRET } from '../config.js';

const MONGO_URI = process.env.MONGO_URI;
const skip = !MONGO_URI;
const KEY_A = crypto.randomBytes(32).toString('hex');
const KEY_B = crypto.randomBytes(32).toString('hex');
const silent = { warn() {} };
const hmacWith = (key, hash) => crypto.createHmac('sha256', key).update(hash).digest('hex');

describe('sentinel-forensics: clave de firma', () => {
  test('sin clave en producción lanza, también al crear el servicio', () => {
    assert.throws(() => resolveForensicSecret({ NODE_ENV: 'production' }, silent), /obligatoria en producción/);
    assert.throws(() => createSentinelForensics({ mongo: {}, env: { NODE_ENV: 'production' } }), /obligatoria en producción/);
  });

  test('no toma JWT_SECRET como clave forense', () => {
    assert.throws(() => resolveForensicSecret({ NODE_ENV: 'production', JWT_SECRET: KEY_A }, silent), /obligatoria en producción/);
    assert.equal(resolveForensicSecret({ JWT_SECRET: KEY_A }, silent), DEV_FORENSIC_SECRET);
  });

  test('una clave de menos de 32 bytes lanza en cualquier entorno', () => {
    for (const NODE_ENV of ['production', 'development']) {
      assert.throws(() => resolveForensicSecret({ NODE_ENV, SENTINEL_FORENSIC_SECRET: 'x'.repeat(31) }, silent), /32 bytes/);
    }
    assert.equal(resolveForensicSecret({ NODE_ENV: 'production', SENTINEL_FORENSIC_SECRET: KEY_A }, silent), KEY_A);
  });

  test('la clave de desarrollo solo se usa fuera de producción y con aviso', () => {
    const warnings = [];
    assert.equal(resolveForensicSecret({}, { warn: (m) => warnings.push(m) }), DEV_FORENSIC_SECRET);
    assert.equal(warnings.length, 1);
    assert.throws(
      () => resolveForensicSecret({ NODE_ENV: 'production', SENTINEL_FORENSIC_SECRET: DEV_FORENSIC_SECRET }, silent),
      /clave de desarrollo/,
    );
  });

  test('se lee al usarla, no al importar el módulo', () => {
    const previous = process.env.SENTINEL_FORENSIC_SECRET;
    process.env.SENTINEL_FORENSIC_SECRET = KEY_B;
    try {
      assert.equal(resolveForensicSecret(undefined, silent), KEY_B);
    } finally {
      if (previous === undefined) delete process.env.SENTINEL_FORENSIC_SECRET;
      else process.env.SENTINEL_FORENSIC_SECRET = previous;
    }
  });
});

describe('sentinel-forensics: cadena de hashes forense', { skip: skip && 'MONGO_URI no configurada' }, () => {
  const PREFIX = `t_forensic_${process.pid}_`;
  const COLLECTIONS = ['forensic_log', 'login_attempts', 'ip_review_queue', 'ip_allowlist'];
  let client, db, mongo, sentinelA, sentinelA2, sentinelB;

  const blockedLogin = (sentinel, i) => sentinel.registerLoginAttempt({
    ip: `10.0.0.${i}`, username: `intruso${i}@gmail.com`, ok: false, reason: 'dominio_no_autorizado',
  });
  const entries = () => mongo.collection('forensic_log').find().sort({ seq: 1 }).toArray();

  before(async () => {
    client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db('elvira_test');
    mongo = { collection: (name) => db.collection(PREFIX + name) };
    // Mismo índice que db/mongo.js: arbitra el seq entre procesos.
    await mongo.collection('forensic_log').createIndex({ seq: 1 }, { unique: true });
    sentinelA = createSentinelForensics({ mongo, busEmit: () => {}, env: { SENTINEL_FORENSIC_SECRET: KEY_A } });
    // Segunda instancia con la misma clave: escribe como lo haría otro proceso.
    sentinelA2 = createSentinelForensics({ mongo, busEmit: () => {}, env: { SENTINEL_FORENSIC_SECRET: KEY_A } });
    sentinelB = createSentinelForensics({ mongo, busEmit: () => {}, env: { SENTINEL_FORENSIC_SECRET: KEY_B } });
  });

  after(async () => {
    await Promise.all(COLLECTIONS.map((name) => mongo.collection(name).drop().catch(() => {})));
    await client.close();
  });

  test('cadena vacia verifica como valida', async () => {
    const result = await sentinelA.verifyChain();
    assert.equal(result.valid, true);
    assert.equal(result.totalEntries, 0);
  });

  test('escrituras seguidas y simultaneas (tambien desde dos procesos) forman una cadena valida', async () => {
    for (let i = 1; i <= 3; i++) await blockedLogin(sentinelA, i);
    await Promise.all([4, 5, 6, 7, 8, 9, 10, 11].map((i) => blockedLogin(i % 2 ? sentinelA : sentinelA2, i)));
    const result = await sentinelA.verifyChain();
    assert.equal(result.valid, true);
    assert.equal(result.totalEntries, 11);
    assert.deepEqual((await entries()).map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  test('un HMAC hecho con la clave A no verifica con la clave B', async () => {
    const [first] = await entries();
    assert.equal(first.hmac, hmacWith(KEY_A, first.hash));
    assert.notEqual(first.hmac, hmacWith(KEY_B, first.hash));

    const result = await sentinelB.verifyChain();
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'hmac_mismatch');
    assert.equal(result.brokenAtSeq, 1);
  });

  test('tras cambiar de clave, el re-sellado deja la cadena verificando y conserva el sello anterior', async () => {
    const before = await entries();
    const result = await sentinelB.reanchorChain('admin-test', { ip: '10.0.0.250' });
    assert.equal(result.reanchored, true);
    assert.equal(result.cause, 'hmac_mismatch');
    assert.equal(result.fixedFrom, 1);
    assert.equal(result.resealed, before.length);
    assert.equal(result.contentMismatch, 0);
    assert.equal(result.valid, true);

    const verify = await sentinelB.verifyChain();
    assert.equal(verify.valid, true);
    assert.equal(verify.totalEntries, before.length + 1);
    assert.equal((await sentinelA.verifyChain()).valid, false);

    const after = await entries();
    before.forEach((old, i) => {
      const now = after[i];
      for (const field of ['seq', 'ts', 'ip', 'method', 'path', 'user', 'statusCode', 'blocked', 'reason']) {
        assert.equal(now[field], old[field], `${field} del registro ${old.seq} no debe cambiar`);
      }
      assert.equal(now.hash, old.hash);
      assert.equal(now.hmac, hmacWith(KEY_B, now.hash));
      assert.equal(now.reanchoredBy, 'admin-test');
      const [previousSeal] = now.sealHistory;
      assert.deepEqual([previousSeal.prevHash, previousSeal.hash, previousSeal.hmac], [old.prevHash, old.hash, old.hmac]);
      assert.equal(hmacWith(KEY_A, previousSeal.hash), previousSeal.hmac);
    });

    const trace = after.at(-1);
    assert.equal(trace.seq, result.traceSeq);
    assert.match(trace.reason, /^RE-SELLADO · 11 registro\(s\) desde el número 1, causa: firma$/);
    assert.equal(trace.user, 'admin-test');
    assert.equal(trace.ip, '10.0.0.250');
  });

  test('tras el re-sellado las escrituras siguientes encadenan bien', async () => {
    await Promise.all([20, 21, 22].map((i) => blockedLogin(sentinelB, i)));
    const result = await sentinelB.verifyChain();
    assert.equal(result.valid, true);
    assert.equal(result.totalEntries, 15);
  });

  test('cadena integra: el re-sellado no toca nada', async () => {
    const result = await sentinelB.reanchorChain('admin-test');
    assert.deepEqual(result, { reanchored: false, reason: 'cadena_ya_integra' });
  });

  test('detecta manipulacion y el re-sellado la senala sin borrar historial', async () => {
    const victim = (await entries())[1];
    // Simula una alteración directa en Mongo, fuera de appendForensicEntry.
    await mongo.collection('forensic_log').updateOne({ _id: victim._id }, { $set: { reason: 'MANIPULADO: acceso autorizado' } });

    const broken = await sentinelB.verifyChain();
    assert.equal(broken.valid, false);
    assert.equal(broken.reason, 'hash_mismatch');
    assert.equal(broken.brokenAtSeq, victim.seq);

    const countBefore = await mongo.collection('forensic_log').countDocuments();
    const result = await sentinelB.reanchorChain('admin-test');
    assert.equal(result.reanchored, true);
    assert.equal(result.fixedFrom, victim.seq);
    assert.equal(result.contentMismatch, 1);
    assert.equal(result.valid, true);
    assert.equal(await mongo.collection('forensic_log').countDocuments(), countBefore + 1);

    const resealed = await mongo.collection('forensic_log').findOne({ _id: victim._id });
    assert.equal(resealed.sealHistory.at(-1).hash, victim.hash);
    assert.equal((await sentinelB.verifyChain()).valid, true);
  });

  test('un hueco en la cadena se re-sella sin marcar contenido alterado', async () => {
    const victim = (await entries())[4];
    await mongo.collection('forensic_log').deleteOne({ _id: victim._id });
    assert.equal((await sentinelB.verifyChain()).reason, 'hash_mismatch');

    const result = await sentinelB.reanchorChain('admin-test');
    assert.equal(result.reanchored, true);
    assert.equal(result.fixedFrom, victim.seq + 1);
    assert.equal(result.contentMismatch, 0);
    assert.equal(result.valid, true);
  });

  test('escrituras durante el re-sellado: esperan su turno y la cadena queda integra', async () => {
    const victim = (await entries())[2];
    await mongo.collection('forensic_log').updateOne({ _id: victim._id }, { $set: { reason: 'MANIPULADO' } });

    const reseal = sentinelB.reanchorChain('admin-test');
    const writes = [40, 41, 42, 43, 44].map((i) => blockedLogin(sentinelB, i));
    const [result] = await Promise.all([reseal, ...writes]);
    assert.equal(result.reanchored, true);
    assert.equal(result.valid, true);
    assert.equal((await sentinelB.verifyChain()).valid, true);
    // Las escrituras pedidas durante el re-sellado se encadenan después de su entrada de traza.
    const written = await mongo.collection('forensic_log').find({ user: /^intruso4\d@/ }).toArray();
    assert.equal(written.length, 5);
    assert.ok(written.every((e) => e.seq > result.traceSeq));
  });

  test('dos re-sellados a la vez: el segundo espera y encuentra la cadena integra', async () => {
    const victim = (await entries())[3];
    await mongo.collection('forensic_log').updateOne({ _id: victim._id }, { $set: { reason: 'MANIPULADO' } });
    const traces = () => mongo.collection('forensic_log').countDocuments({ reason: /^RE-SELLADO/ });
    const tracesBefore = await traces();

    const [first, second] = await Promise.all([
      sentinelB.reanchorChain('admin-1'),
      sentinelB.reanchorChain('admin-2'),
    ]);
    assert.equal(first.reanchored, true);
    assert.equal(first.valid, true);
    assert.deepEqual(second, { reanchored: false, reason: 'cadena_ya_integra' });
    assert.equal(await traces(), tracesBefore + 1);
  });

  test('login exitoso no queda en la cadena forense (solo login_attempts)', async () => {
    const chainBefore = await sentinelB.verifyChain();
    await sentinelB.registerLoginAttempt({ ip: '10.0.0.99', username: 'marc@snficorp.com', ok: true });
    const chainAfter = await sentinelB.verifyChain();
    assert.equal(chainAfter.totalEntries, chainBefore.totalEntries);
    assert.equal(chainAfter.valid, true);

    const attempt = await mongo.collection('login_attempts').findOne({ ip: '10.0.0.99', ok: true });
    assert.ok(attempt);
  });
});

describe('sentinel-forensics: ensayo del re-sellado por la ruta de Admin', { skip: skip && 'MONGO_URI no configurada' }, () => {
  const PREFIX = `t_forensic_${process.pid}_route_`;
  const COLLECTIONS = ['forensic_log', 'login_attempts', 'ip_review_queue', 'ip_allowlist'];
  const busEvents = [];
  let client, mongo, server, baseUrl;

  const call = async (method, path, role = 'admin') => {
    const res = await fetch(`${baseUrl}${path}`, { method, headers: { 'x-test-role': role } });
    return { status: res.status, body: await res.json() };
  };

  before(async () => {
    client = new MongoClient(MONGO_URI);
    await client.connect();
    const db = client.db('elvira_test');
    mongo = { collection: (name) => db.collection(PREFIX + name) };
    await mongo.collection('forensic_log').createIndex({ seq: 1 }, { unique: true });

    // Situación de partida: registro firmado con la clave de desarrollo.
    const devSentinel = createSentinelForensics({ mongo, busEmit: () => {}, env: { SENTINEL_FORENSIC_SECRET: DEV_FORENSIC_SECRET } });
    for (let i = 1; i <= 4; i++) {
      await devSentinel.registerLoginAttempt({ ip: `10.1.0.${i}`, username: `intruso${i}@gmail.com`, ok: false, reason: 'dominio_no_autorizado' });
    }

    // Arranque con la clave nueva, como en producción.
    const sentinelForensics = createSentinelForensics({
      mongo, busEmit: (e) => busEvents.push(e), env: { NODE_ENV: 'production', SENTINEL_FORENSIC_SECRET: KEY_A },
    });
    const app = express();
    const auth = (req, res, next) => {
      req.user = 'marc@snficorp.com';
      req.role = req.get('x-test-role');
      next();
    };
    mountSentinelForensicRoutes(app, { auth, sentinelForensics, busEmit: (e) => busEvents.push(e), busEvents });
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    server?.close();
    await Promise.all(COLLECTIONS.map((name) => mongo.collection(name).drop().catch(() => {})));
    await client.close();
  });

  test('con la clave nueva la cadena antigua no verifica', async () => {
    const { status, body } = await call('GET', '/api/sentinel/verify-chain');
    assert.equal(status, 200);
    assert.equal(body.valid, false);
    assert.equal(body.reason, 'hmac_mismatch');
    assert.equal(body.brokenAtSeq, 1);
    assert.match(body.explanation, /cambiado la clave de firma/);
  });

  test('solo un Admin puede re-sellar', async () => {
    const { status } = await call('POST', '/api/sentinel/reanchor-chain', 'user');
    assert.equal(status, 403);
    assert.equal((await call('GET', '/api/sentinel/verify-chain')).body.valid, false);
  });

  test('el Admin re-sella y la cadena vuelve a verificar, con el re-sellado trazado', async () => {
    const { status, body } = await call('POST', '/api/sentinel/reanchor-chain');
    assert.equal(status, 200);
    assert.equal(body.reanchored, true);
    assert.equal(body.resealed, 4);
    assert.equal(body.cause, 'hmac_mismatch');
    assert.equal(body.valid, true);

    const verify = await call('GET', '/api/sentinel/verify-chain');
    assert.deepEqual(verify.body, { valid: true, totalEntries: 5 });

    assert.ok(busEvents.some((e) => e.label.startsWith('CADENA FORENSE RE-SELLADA') && e.label.endsWith('por marc@snficorp.com')));
    const human = await call('GET', '/api/sentinel/forensic-log-human?limit=1');
    assert.match(human.body.events[0].message, /^el usuario marc@snficorp\.com re-selló la cadena forense: 4 registro\(s\) desde el número 1, causa: firma\.$/);
  });
});
