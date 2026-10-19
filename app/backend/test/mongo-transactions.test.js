/**
 * withTransaction de db/mongo.js: transacciones reales contra un replica set
 * (atomicidad y aislamiento) y vuelta atras sin transaccion cuando el servidor
 * es un mongod suelto. La parte real usa su propia db y se salta sin MONGO_URI
 * o si el servidor no es un replica set (ver npm run test:local).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MongoClient } from 'mongodb';
import { withTransaction, isTransactionUnsupported } from '../db/mongo.js';

const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = 'elvira_test_transactions';

describe('db/mongo.js: deteccion de mongod sin transacciones', () => {
  test('reconoce el rechazo del servidor y el del driver', () => {
    assert.equal(isTransactionUnsupported(Object.assign(new Error('Transaction numbers are only allowed on a replica set member or mongos'), { code: 20 })), true);
    assert.equal(isTransactionUnsupported(new Error('This MongoDB deployment does not support retryable writes. Please add retryWrites=false to your connection string.')), true);
  });

  test('no confunde otros errores', () => {
    assert.equal(isTransactionUnsupported(new Error('boom')), false);
    assert.equal(isTransactionUnsupported(Object.assign(new Error('duplicate key'), { code: 11000 })), false);
    assert.equal(isTransactionUnsupported(Object.assign(new Error('otra cosa'), { code: 20 })), false);
    assert.equal(isTransactionUnsupported(undefined), false);
  });

  test('en un mongod suelto ejecuta la funcion una vez sin sesion', async (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    let ended = 0;
    const standalone = {
      startSession: () => ({
        withTransaction: async () => { throw Object.assign(new Error('Transaction numbers are only allowed on a replica set member or mongos'), { code: 20 }); },
        endSession: async () => { ended += 1; },
      }),
    };
    const seen = [];
    const result = await withTransaction(async (session) => { seen.push(session); return 'listo'; }, standalone);
    assert.equal(result, 'listo');
    assert.deepEqual(seen, [undefined]);
    assert.equal(ended, 1);
    assert.equal(warn.mock.callCount(), 1);
  });

  test('un error que no es de transacciones se propaga sin repetir la funcion', async () => {
    let calls = 0;
    const failing = {
      startSession: () => ({
        withTransaction: async (fn) => { await fn(); },
        endSession: async () => {},
      }),
    };
    await assert.rejects(withTransaction(async () => { calls += 1; throw new Error('boom'); }, failing), /boom/);
    assert.equal(calls, 1);
  });
});

describe('db/mongo.js: transacciones reales', { skip: !MONGO_URI && 'MONGO_URI no configurada' }, () => {
  let client;
  let db;
  let isReplicaSet = false;

  before(async () => {
    client = new MongoClient(MONGO_URI);
    await client.connect();
    isReplicaSet = Boolean((await client.db('admin').command({ hello: 1 })).setName);
    db = client.db(DB_NAME);
    await db.dropDatabase();
    await db.createCollection('padres');
    await db.createCollection('hijos');
  });

  after(async () => {
    await db.dropDatabase();
    await client.close();
  });

  const counts = async (id) => [
    await db.collection('padres').countDocuments({ _id: id }),
    await db.collection('hijos').countDocuments({ _id: id }),
  ];

  test('usa una transaccion de verdad: lo escrito no se ve fuera hasta confirmar', async (t) => {
    if (!isReplicaSet) return t.skip('el servidor no es un replica set');
    const warn = t.mock.method(console, 'warn', () => {});
    let inTransaction;
    let withSession;
    let withoutSession;
    await withTransaction(async (session) => {
      inTransaction = session.inTransaction();
      await db.collection('padres').insertOne({ _id: 'ok' }, { session });
      await db.collection('hijos').insertOne({ _id: 'ok' }, { session });
      withSession = await db.collection('padres').countDocuments({ _id: 'ok' }, { session });
      withoutSession = await db.collection('padres').countDocuments({ _id: 'ok' });
    }, client);
    assert.equal(inTransaction, true);
    assert.equal(withSession, 1);
    assert.equal(withoutSession, 0, 'una lectura ajena no debe ver la escritura sin confirmar');
    assert.deepEqual(await counts('ok'), [1, 1]);
    assert.equal(warn.mock.callCount(), 0, 'no debe caer en el modo sin transaccion');
  });

  test('si la funcion falla, se deshacen todas las escrituras', async (t) => {
    if (!isReplicaSet) return t.skip('el servidor no es un replica set');
    await assert.rejects(withTransaction(async (session) => {
      await db.collection('padres').insertOne({ _id: 'fallo' }, { session });
      await db.collection('hijos').insertOne({ _id: 'fallo' }, { session });
      throw new Error('boom');
    }, client), /boom/);
    assert.deepEqual(await counts('fallo'), [0, 0]);
  });

  test('un fallo en la segunda escritura deshace la primera', async (t) => {
    if (!isReplicaSet) return t.skip('el servidor no es un replica set');
    await assert.rejects(withTransaction(async (session) => {
      await db.collection('padres').insertOne({ _id: 'dup' }, { session });
      await db.collection('hijos').insertOne({ _id: 'dup' }, { session });
      await db.collection('hijos').insertOne({ _id: 'dup' }, { session });
    }, client), (err) => err.code === 11000);
    assert.deepEqual(await counts('dup'), [0, 0]);
  });
});
