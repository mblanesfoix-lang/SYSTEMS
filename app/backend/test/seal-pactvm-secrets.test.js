/**
 * scripts/seal-pactvm-secrets.js: sella los secretos de Pactvm heredados en claro
 * (clave privada del bunker CIBE y tokenKey de los certificados) en todas las bases.
 * Sin --apply no escribe; es idempotente; el bunker sigue funcionando despues; y el
 * script se niega a sellar sin una PACTVM_DATA_KEY propia. Bases de prueba propias que
 * se borran al terminar. Se salta sin MONGO_URI.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';
import { sealPactvmSecrets } from '../scripts/seal-pactvm-secrets.js';
import { createCibeBunker, tokenKeyContext, PRIVATE_KEY_CONTEXT } from '../cibe-bunker.js';
import { createDataSeal, isSealed } from '../lib/data-seal.js';
import { DEV_DATA_KEY } from '../config.js';

const MONGO_URI = process.env.MONGO_URI;
const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/seal-pactvm-secrets.js');
const noop = () => {};

describe('seal-pactvm-secrets: sellado de secretos heredados', { skip: !MONGO_URI && 'MONGO_URI no configurada' }, () => {
  let client;
  let keysDb;
  let tenantA;
  let tenantB;
  const dataSeal = createDataSeal(crypto.randomBytes(32));
  const pair = crypto.generateKeyPairSync('ed25519');
  const privatePem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const keys = { a1: 'a1'.repeat(24), a2: 'a2'.repeat(24), b1: 'b1'.repeat(24), sealed: 'cc'.repeat(24) };

  before(async () => {
    client = new MongoClient(MONGO_URI);
    await client.connect();
    keysDb = client.db('elvira_test_seal_keys');
    tenantA = client.db('elvira_test_seal_a');
    tenantB = client.db('elvira_test_seal_b');
    await Promise.all([keysDb, tenantA, tenantB].map((db) => db.dropDatabase()));
    await keysDb.collection('cibe_keys').insertOne({
      _id: 'active', kid: 'heredada', privateKeyPem: privatePem,
      publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }), createdAt: new Date().toISOString(),
    });
    await tenantA.collection('pactvm_cibe').insertMany([
      { _id: 'a1', entityName: 'rack-a1', status: 'emitido', tokenKey: keys.a1 },
      { _id: 'a2', entityName: 'rack-a2', status: 'suspendido', tokenKey: keys.a2 },
      { _id: 'a3', entityName: 'rack-a3', status: 'pendiente' },
      { _id: 'ya', entityName: 'rack-ya', status: 'emitido', tokenKey: dataSeal.seal(keys.sealed, tokenKeyContext('ya')) },
    ]);
    await tenantB.collection('pactvm_cibe').insertOne({ _id: 'b1', entityName: 'rack-b1', status: 'emitido', tokenKey: keys.b1 });
  });

  after(async () => {
    await Promise.all([keysDb, tenantA, tenantB].map((db) => db.dropDatabase()));
    await client.close();
  });

  const run = (apply) => sealPactvmSecrets({ keysDb, certDbs: [tenantA, tenantB], dataSeal, apply });

  test('sin --apply solo cuenta y no escribe nada', async () => {
    const before = await tenantA.collection('pactvm_cibe').find({}).sort({ _id: 1 }).toArray();
    assert.deepEqual(await run(false), { privateKey: 1, tokenKeys: 3, alreadySealed: 1 });
    assert.deepEqual(await tenantA.collection('pactvm_cibe').find({}).sort({ _id: 1 }).toArray(), before);
    assert.equal((await keysDb.collection('cibe_keys').findOne({ _id: 'active' })).privateKeyPem, privatePem);
  });

  test('con --apply sella todo lo heredado y cada valor se descifra igual en su documento', async () => {
    assert.deepEqual(await run(true), { privateKey: 1, tokenKeys: 3, alreadySealed: 1 });
    const keyDoc = await keysDb.collection('cibe_keys').findOne({ _id: 'active' });
    assert.ok(isSealed(keyDoc.privateKeyPem));
    assert.equal(dataSeal.open(keyDoc.privateKeyPem, PRIVATE_KEY_CONTEXT), privatePem);
    for (const [db, id] of [[tenantA, 'a1'], [tenantA, 'a2'], [tenantB, 'b1'], [tenantA, 'ya']]) {
      const cert = await db.collection('pactvm_cibe').findOne({ _id: id });
      assert.ok(isSealed(cert.tokenKey), id);
      assert.equal(dataSeal.open(cert.tokenKey, tokenKeyContext(id)), id === 'ya' ? keys.sealed : keys[id]);
    }
    assert.equal((await tenantA.collection('pactvm_cibe').findOne({ _id: 'a3' })).tokenKey, undefined);
  });

  test('idempotente: una segunda pasada no cambia nada', async () => {
    const before = await tenantA.collection('pactvm_cibe').find({}).sort({ _id: 1 }).toArray();
    assert.deepEqual(await run(true), { privateKey: 0, tokenKeys: 0, alreadySealed: 5 });
    assert.deepEqual(await tenantA.collection('pactvm_cibe').find({}).sort({ _id: 1 }).toArray(), before);
  });

  test('tras sellar, el bunker carga su clave y firma, y lee la tokenKey', async () => {
    const bunker = createCibeBunker({ mongo: keysDb, busEmit: noop, adminNotify: noop, dataSeal });
    await bunker.ready();
    assert.match(bunker.status().keySource, /cifrada/);
    const { token } = await bunker.issue({ sub: 'entity:test', scope: 'rack.command', via: 'test', actor: 'test' });
    assert.equal(bunker.verify(token, 'rack.command').ok, true);
    const cert = await tenantB.collection('pactvm_cibe').findOne({ _id: 'b1' });
    assert.equal(bunker.openTokenKey(cert), keys.b1);
  });
});

describe('seal-pactvm-secrets: ejecucion como script', () => {
  test('sin PACTVM_DATA_KEY propia se niega antes de conectar a ninguna base', () => {
    for (const value of ['', DEV_DATA_KEY, DEV_DATA_KEY.toUpperCase()]) {
      const r = spawnSync(process.execPath, [SCRIPT, '--apply'], {
        env: { ...process.env, PACTVM_DATA_KEY: value, MONGO_URI: 'mongodb://127.0.0.1:1/no-debe-conectar' },
        encoding: 'utf8',
        timeout: 20000,
      });
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, /No se ha tocado nada/);
    }
  });
});
