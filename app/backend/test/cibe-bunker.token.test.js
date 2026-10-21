/**
 * Puerta CIBE para sujetos externos (POST /api/cibe/token): solo un certificado
 * 'emitido' con tokenKey y una firma HMAC correcta reciben token; cualquier otra
 * firma (otra clave, otra longitud, otro tipo) es un Auth-Refusal. Mongo de
 * pruebas en una base propia que se borra al terminar. Se salta sin MONGO_URI.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { MongoClient } from 'mongodb';
import express from 'express';
import { createCibeBunker, mountCibeBunker } from '../cibe-bunker.js';

const MONGO_URI = process.env.MONGO_URI;
const ENTITY = 'rack-norte';
const TOKEN_KEY = crypto.randomBytes(24).toString('hex');

const hmacFor = (key, ts, nonce, entity = ENTITY) =>
  crypto.createHmac('sha256', key).update(`${entity}|${ts}|${nonce}`).digest('hex');

describe('CIBE: token para sujetos externos firmado con HMAC', { skip: !MONGO_URI && 'MONGO_URI no configurada' }, () => {
  let client;
  let db;
  let server;
  let baseUrl;

  async function requestToken(body) {
    const res = await fetch(`${baseUrl}/api/cibe/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  function signedBody(overrides = {}) {
    const ts = Date.now();
    const nonce = crypto.randomBytes(8).toString('hex');
    return { entityId: ENTITY, ts, nonce, scope: 'rack.command', hmac: hmacFor(TOKEN_KEY, ts, nonce), ...overrides };
  }

  before(async () => {
    client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db('elvira_test_cibe');
    await db.dropDatabase();
    await db.collection('pactvm_cibe').insertMany([
      { _id: 'cibe-1', entityName: ENTITY, status: 'emitido', tokenKey: TOKEN_KEY },
      { _id: 'cibe-2', entityName: 'rack-suspendido', status: 'suspendido', tokenKey: TOKEN_KEY },
    ]);

    const noop = () => {};
    const bunker = createCibeBunker({ mongo: db, busEmit: noop, adminNotify: noop });
    const app = express();
    app.use(express.json());
    mountCibeBunker(app, {
      auth: (req, res, next) => next(),
      requireMesa: () => (req, res, next) => next(),
      mongo: db,
      bunker,
      busEmit: noop,
    });
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await db.dropDatabase();
    await client.close();
  });

  test('firma correcta -> token con el scope pedido', async () => {
    const { status, body } = await requestToken(signedBody());
    assert.equal(status, 200);
    assert.match(body.token, /^v1\./);
    assert.equal(body.scope, 'rack.command');
  });

  test('la firma en hexadecimal mayusculas tambien vale', async () => {
    const b = signedBody();
    const { status } = await requestToken({ ...b, hmac: b.hmac.toUpperCase() });
    assert.equal(status, 200);
  });

  test('firma con otra clave, alterada o de otra longitud -> AUTH_REFUSAL bad_hmac', async () => {
    const b = signedBody();
    const flipped = b.hmac.slice(0, -1) + (b.hmac.endsWith('0') ? '1' : '0');
    for (const hmac of [
      hmacFor('otra-clave', b.ts, b.nonce),
      flipped,
      b.hmac.slice(0, 32),
      `${b.hmac}00`,
      { $ne: null },
      12345,
    ]) {
      const { status, body } = await requestToken({ ...b, hmac });
      assert.equal(status, 403, JSON.stringify(hmac));
      assert.equal(body.code, 'bad_hmac', JSON.stringify(hmac));
      assert.equal(body.token, undefined);
    }
  });

  test('una firma valida no sirve para otra entidad ni con el certificado sin emitir', async () => {
    const b = signedBody({ entityId: 'rack-suspendido' });
    const suspended = await requestToken({ ...b, hmac: hmacFor(TOKEN_KEY, b.ts, b.nonce, 'rack-suspendido') });
    assert.equal(suspended.status, 403);
    assert.equal(suspended.body.code, 'cert_not_issued');

    const unknown = await requestToken(signedBody({ entityId: 'rack-inexistente' }));
    assert.equal(unknown.status, 403);
    assert.equal(unknown.body.code, 'no_cert');
  });

  test('cada intento rechazado queda en el log encadenado de CIBE', async () => {
    const refusals = await db.collection('cibe_log').countDocuments({ action: 'auth_refusal' });
    assert.ok(refusals >= 8, `solo ${refusals} rechazos registrados`);
  });
});
