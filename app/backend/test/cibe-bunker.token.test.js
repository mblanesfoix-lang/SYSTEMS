/**
 * Puerta CIBE para sujetos externos (POST /api/cibe/token): solo un certificado
 * 'emitido' con tokenKey y una firma HMAC correcta reciben token; cualquier otra
 * firma (otra clave, otra longitud, otro tipo) es un Auth-Refusal. La tokenKey y la
 * clave privada del bunker se guardan cifradas (lib/data-seal.js); las heredadas en
 * claro siguen funcionando hasta sellarlas. Las rutas se montan con el acceso a datos
 * por tenant de server.js (Proxy y registro) sobre un tenant de prueba: con una db
 * directa, la puerta publica parecia funcionar aunque en el servidor real fallaba por
 * no tener tenant. Bases propias que se borran al terminar. Se salta sin MONGO_URI.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { MongoClient } from 'mongodb';
import express from 'express';
import { connectMongo, closeMongo, getMongoClient } from '../db/mongo.js';
import { tenantsCollection, getTenantDb, getTenantReffDb } from '../db/tenant-registry.js';
import { tenantContext, createTenantAwareDb } from '../db/tenant-context.js';
import { createCibeBunker, mountCibeBunker, tokenKeyContext, PRIVATE_KEY_CONTEXT } from '../cibe-bunker.js';
import { createDataSeal, isSealed } from '../lib/data-seal.js';

const MONGO_URI = process.env.MONGO_URI;
const TENANT = 'tenant_test_cibe';
const DB_NAME = 'elvira_test_cibe';
const REFF_DB_NAME = 'reff_test_cibe';
const ENTITY = 'rack-norte';
const TOKEN_KEY = crypto.randomBytes(24).toString('hex');
const noop = () => {};

const hmacFor = (key, ts, nonce, entity = ENTITY) =>
  crypto.createHmac('sha256', key).update(`${entity}|${ts}|${nonce}`).digest('hex');

describe('CIBE: token para sujetos externos firmado con HMAC', { skip: !MONGO_URI && 'MONGO_URI no configurada' }, () => {
  let db;
  let server;
  let baseUrl;
  let bunker;
  const dataSeal = createDataSeal(crypto.randomBytes(32));
  const otherSeal = createDataSeal(crypto.randomBytes(32));

  async function post(path, body) {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }
  const requestToken = (body) => post('/api/cibe/token', body);

  function signedBody(overrides = {}, key = TOKEN_KEY) {
    const entityId = overrides.entityId ?? ENTITY;
    const ts = Date.now();
    const nonce = crypto.randomBytes(8).toString('hex');
    return { entityId, ts, nonce, scope: 'rack.command', hmac: hmacFor(key, ts, nonce, entityId), ...overrides };
  }

  before(async () => {
    await connectMongo();
    const client = getMongoClient();
    db = client.db(DB_NAME);
    await db.dropDatabase();
    await client.db(REFF_DB_NAME).dropDatabase();
    await tenantsCollection().deleteOne({ _id: TENANT });
    await tenantsCollection().insertOne({
      _id: TENANT,
      kind: 'internal',
      displayName: 'Tenant de prueba (CIBE)',
      status: 'active',
      mongo: { mode: 'shared-cluster', uri: null, dbName: DB_NAME, reffDbName: REFF_DB_NAME },
      createdAt: new Date().toISOString(),
    });
    await getTenantDb(TENANT);
    await getTenantReffDb(TENANT);
    await db.collection('pactvm_cibe').insertMany([
      // tokenKey heredada en claro (anterior al cifrado)
      { _id: 'cibe-1', entityName: ENTITY, status: 'emitido', tokenKey: TOKEN_KEY },
      { _id: 'cibe-2', entityName: 'rack-suspendido', status: 'suspendido', tokenKey: TOKEN_KEY },
      { _id: 'cibe-3', entityName: 'rack-sur', status: 'emitido' },
      { _id: 'cibe-4', entityName: 'rack-este', status: 'emitido' },
      { _id: 'cibe-5', entityName: 'rack-oeste', status: 'emitido', tokenKey: otherSeal.seal(TOKEN_KEY, tokenKeyContext('cibe-5')) },
    ]);

    // Como en server.js: el bunker trabaja sobre una db fija y las rutas con el Proxy por tenant.
    bunker = createCibeBunker({ mongo: db, busEmit: noop, adminNotify: noop, dataSeal });
    const app = express();
    app.use(express.json());
    mountCibeBunker(app, {
      auth: (req, res, next) => {
        req.user = 'test-admin';
        req.tenantId = TENANT;
        tenantContext.run({ tenantId: TENANT }, next);
      },
      requireMesa: () => (req, res, next) => next(),
      mongo: createTenantAwareDb(),
      bunker,
      busEmit: noop,
      systemTenantId: TENANT,
    });
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    const client = getMongoClient();
    await db.dropDatabase();
    await client.db(REFF_DB_NAME).dropDatabase();
    await tenantsCollection().deleteOne({ _id: TENANT });
    await closeMongo();
  });

  test('firma correcta -> token con el scope pedido (tokenKey heredada en claro)', async () => {
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
    const suspended = await requestToken(signedBody({ entityId: 'rack-suspendido' }));
    assert.equal(suspended.status, 403);
    assert.equal(suspended.body.code, 'cert_not_issued');

    const unknown = await requestToken(signedBody({ entityId: 'rack-inexistente' }));
    assert.equal(unknown.status, 403);
    assert.equal(unknown.body.code, 'no_cert');
  });

  test('peticion mal formada: rechazo limpio, nunca un error interno', async () => {
    for (const body of [{}, { entityId: ENTITY }, { entityId: { $ne: null }, ts: 'x', nonce: [], hmac: {}, scope: '*' }]) {
      const { status, body: res } = await requestToken(body);
      assert.equal(status, 403, JSON.stringify(body));
      assert.equal(res.code, 'bad_request');
    }
  });

  test('tokenKey asignada por el Admin: se entrega una vez, se guarda cifrada y funciona', async () => {
    const assigned = await post('/api/pactvm/cibe/cibe-3/token-key', {});
    assert.equal(assigned.status, 200);
    const { tokenKey } = assigned.body;
    assert.match(tokenKey, /^[0-9a-f]{48}$/);

    const stored = await db.collection('pactvm_cibe').findOne({ _id: 'cibe-3' });
    assert.ok(isSealed(stored.tokenKey));
    assert.ok(!JSON.stringify(stored).includes(tokenKey));
    assert.equal(dataSeal.open(stored.tokenKey, tokenKeyContext('cibe-3')), tokenKey);

    const { status } = await requestToken(signedBody({ entityId: 'rack-sur' }, tokenKey));
    assert.equal(status, 200);
  });

  test('una tokenKey cifrada copiada a otro certificado no se descifra -> token_key_unreadable', async () => {
    const source = await db.collection('pactvm_cibe').findOne({ _id: 'cibe-3' });
    await db.collection('pactvm_cibe').updateOne({ _id: 'cibe-4' }, { $set: { tokenKey: source.tokenKey } });
    const key = dataSeal.open(source.tokenKey, tokenKeyContext('cibe-3'));
    const { status, body } = await requestToken(signedBody({ entityId: 'rack-este' }, key));
    assert.equal(status, 403);
    assert.equal(body.code, 'token_key_unreadable');
  });

  test('una tokenKey cifrada con otra clave de datos -> token_key_unreadable, sin caerse', async () => {
    const { status, body } = await requestToken(signedBody({ entityId: 'rack-oeste' }));
    assert.equal(status, 403);
    assert.equal(body.code, 'token_key_unreadable');
  });

  test('la clave privada del bunker se genera y se guarda cifrada', async () => {
    await bunker.ready();
    const doc = await db.collection('cibe_keys').findOne({ _id: 'active' });
    assert.ok(isSealed(doc.privateKeyPem));
    assert.ok(!doc.privateKeyPem.includes('PRIVATE KEY'));
    assert.match(dataSeal.open(doc.privateKeyPem, PRIVATE_KEY_CONTEXT), /BEGIN PRIVATE KEY/);
    assert.match(bunker.status().keySource, /cifrada/);
  });

  test('cada intento rechazado queda en el log encadenado de CIBE', async () => {
    const refusals = await db.collection('cibe_log').countDocuments({ action: 'auth_refusal' });
    assert.ok(refusals >= 10, `solo ${refusals} rechazos registrados`);
  });
});

describe('CIBE: clave privada del bunker heredada o ajena', { skip: !MONGO_URI && 'MONGO_URI no configurada' }, () => {
  let client;
  let db;
  const dataSeal = createDataSeal(crypto.randomBytes(32));

  before(async () => {
    client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db('elvira_test_cibe_keys');
    await db.dropDatabase();
  });

  after(async () => {
    await db.dropDatabase();
    await client.close();
  });

  function keyDoc(privateKeyPem, publicKeyPem) {
    return { _id: 'active', kid: 'heredada', privateKeyPem, publicKeyPem, createdAt: new Date().toISOString() };
  }

  test('en claro (anterior al cifrado): se sigue cargando y firma, y el estado lo avisa', async () => {
    const pair = crypto.generateKeyPairSync('ed25519');
    await db.collection('cibe_keys').insertOne(keyDoc(
      pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      pair.publicKey.export({ type: 'spki', format: 'pem' }),
    ));
    const bunker = createCibeBunker({ mongo: db, busEmit: noop, adminNotify: noop, dataSeal });
    await bunker.ready();
    assert.match(bunker.status().keySource, /EN CLARO/);
    const { token } = await bunker.issue({ sub: 'entity:test', scope: 'rack.command', via: 'test', actor: 'test' });
    assert.equal(bunker.verify(token, 'rack.command').ok, true);
  });

  test('cifrada con otra clave de datos: el bunker no arranca y lo dice', async () => {
    const pair = crypto.generateKeyPairSync('ed25519');
    const foreign = createDataSeal(crypto.randomBytes(32));
    await db.collection('cibe_keys').deleteMany({});
    await db.collection('cibe_keys').insertOne(keyDoc(
      foreign.seal(pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), PRIVATE_KEY_CONTEXT),
      pair.publicKey.export({ type: 'spki', format: 'pem' }),
    ));
    const bunker = createCibeBunker({ mongo: db, busEmit: noop, adminNotify: noop, dataSeal });
    await assert.rejects(bunker.ready(), /no se puede descifrar con PACTVM_DATA_KEY/);
  });
});
