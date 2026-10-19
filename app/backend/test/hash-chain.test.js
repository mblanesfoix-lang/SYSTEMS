/**
 * Tests de lib/hash-chain.js: serializacion canonica, verificacion dual de
 * entradas heredadas (v1) y nuevas (canon 2), y encadenado contra Mongo real
 * de prueba. Las pruebas puras corren siempre; las de Mongo se saltan sin
 * MONGO_URI. Db propia (elvira_test_hashchain) porque los ficheros de test
 * corren en paralelo.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { MongoClient } from 'mongodb';
import { canonicalV1, canonicalV2, appendChained, verifyChain, verifyLog } from '../lib/hash-chain.js';

const MONGO_URI = process.env.MONGO_URI;
const GENESIS = '0'.repeat(64);

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

/* Cadena en memoria con el algoritmo heredado, escrita aparte de la libreria. */
function legacyChain(entries, { from = 0, prev = GENESIS } = {}) {
  return entries.map((entry, i) => {
    const seq = from + i + 1;
    const body = { ...structuredClone(entry), seq };
    const hash = sha256(prev + JSON.stringify(body, Object.keys(body).sort()));
    const row = { _id: crypto.randomUUID(), ...body, prevHash: prev, hash, createdAt: new Date().toISOString() };
    prev = hash;
    return row;
  });
}

/* Continua una cadena en memoria con entradas canon 2. */
function v2Chain(entries, prior = []) {
  let prev = prior.length ? prior[prior.length - 1].hash : GENESIS;
  return entries.map((entry, i) => {
    const seq = prior.length + i + 1;
    const body = { ...structuredClone(entry), canon: 2, seq };
    const hash = sha256(prev + canonicalV2(body));
    const row = { _id: crypto.randomUUID(), ...body, prevHash: prev, hash, createdAt: new Date().toISOString() };
    prev = hash;
    return row;
  });
}

const SAMPLE = [
  { action: 'a.create', actorId: 'u1', detail: { id: 'x1', fields: ['name', 'kind'], update: { name: 'Uno' } } },
  { action: 'a.update', actorId: 'u2', detail: { id: 'x1', update: { name: 'Dos' } } },
  { action: 'a.delete', actorId: 'u1', detail: { id: 'x1' } },
];

describe('hash-chain: serializacion canonica', () => {
  test('canonicalV2 ordena las claves a cualquier nivel y conserva el orden de los arrays', () => {
    assert.equal(
      canonicalV2({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } }),
      '{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}',
    );
  });

  test('canonicalV2 omite undefined en objetos y lo convierte en null en arrays', () => {
    assert.equal(canonicalV2({ a: undefined, b: [undefined, 1], c: null }), '{"b":[null,1],"c":null}');
  });

  test('canonicalV1 conserva el formato heredado en entradas planas', () => {
    assert.equal(canonicalV1({ seq: 1, action: 'x', actorId: 'u' }), '{"action":"x","actorId":"u","seq":1}');
  });
});

describe('hash-chain: verifyChain con soporte dual', () => {
  test('cadena vacia verifica', () => {
    assert.deepEqual(verifyChain([]), { valid: true, totalEntries: 0, brokenAtSeq: null });
  });

  test('cadena heredada (v1) verifica', () => {
    const chain = legacyChain(SAMPLE);
    assert.deepEqual(verifyChain(chain), { valid: true, totalEntries: 3, brokenAtSeq: null });
  });

  test('cadena canon 2 verifica', () => {
    const chain = v2Chain(SAMPLE);
    assert.deepEqual(verifyChain(chain), { valid: true, totalEntries: 3, brokenAtSeq: null });
  });

  test('cadena mixta: heredadas seguidas de canon 2 verifica', () => {
    const old = legacyChain(SAMPLE.slice(0, 2));
    const chain = [...old, ...v2Chain(SAMPLE.slice(2), old)];
    assert.deepEqual(verifyChain(chain), { valid: true, totalEntries: 3, brokenAtSeq: null });
  });

  test('alterar un campo anidado de una entrada canon 2 rompe la verificacion en ella', () => {
    const old = legacyChain(SAMPLE.slice(0, 1));
    const chain = [...old, ...v2Chain(SAMPLE.slice(1), old)];
    chain[1].detail.update.name = 'Alterado';
    assert.deepEqual(verifyChain(chain), { valid: false, totalEntries: 3, brokenAtSeq: 2 });
  });

  test('alterar un elemento de un array anidado rompe la verificacion', () => {
    const chain = v2Chain(SAMPLE);
    chain[0].detail.fields[1] = 'otro';
    assert.equal(verifyChain(chain).brokenAtSeq, 1);
  });

  test('quitar o reordenar entradas rompe la verificacion', () => {
    const chain = v2Chain(SAMPLE);
    assert.equal(verifyChain([chain[0], chain[2]]).valid, false);
    assert.equal(verifyChain([chain[1], chain[0], chain[2]]).valid, false);
  });

  test('quitar la marca canon de una entrada nueva rompe la verificacion', () => {
    const chain = v2Chain(SAMPLE);
    delete chain[1].canon;
    assert.deepEqual(verifyChain(chain), { valid: false, totalEntries: 3, brokenAtSeq: 2 });
  });
});

describe('hash-chain: appendChained sin Mongo', () => {
  function fakeMongo(insertOne) {
    return {
      collection: () => ({
        find: () => ({ sort: () => ({ limit: () => ({ next: async () => null }) }) }),
        insertOne,
      }),
    };
  }

  test('reintenta cuando el seq ya esta ocupado y falla tras 5 intentos', async () => {
    let calls = 0;
    const mongo = fakeMongo(async () => {
      calls += 1;
      throw Object.assign(new Error('duplicate key'), { code: 11000 });
    });
    await assert.rejects(appendChained(mongo, 'x_log', { action: 'a', actorId: 'u' }), /x_log: no se pudo encadenar/);
    assert.equal(calls, 5);
  });

  test('un error distinto de clave duplicada se propaga sin reintentos', async () => {
    let calls = 0;
    const mongo = fakeMongo(async () => {
      calls += 1;
      throw new Error('red caida');
    });
    await assert.rejects(appendChained(mongo, 'x_log', { action: 'a', actorId: 'u' }), /red caida/);
    assert.equal(calls, 1);
  });
});

describe('hash-chain: appendChained sobre Mongo', { skip: !MONGO_URI && 'MONGO_URI no configurada' }, () => {
  let client;
  let db;

  before(async () => {
    client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db('elvira_test_hashchain');
    await db.dropDatabase();
  });

  after(async () => {
    await db.dropDatabase();
    await client.close();
  });

  beforeEach(async () => {
    await db.collection('t_log').deleteMany({});
  });

  test('encadena desde la cadena vacia y marca canon 2', async () => {
    const a = await appendChained(db, 't_log', SAMPLE[0]);
    const b = await appendChained(db, 't_log', SAMPLE[1]);
    assert.equal(a.seq, 1);
    assert.equal(a.prevHash, GENESIS);
    assert.equal(a.canon, 2);
    assert.equal(b.seq, 2);
    assert.equal(b.prevHash, a.hash);
    assert.deepEqual(await verifyLog(db, 't_log'), { valid: true, totalEntries: 2, brokenAtSeq: null });
  });

  test('continua una cadena heredada sin reescribirla', async () => {
    const old = legacyChain(SAMPLE.slice(0, 2));
    await db.collection('t_log').insertMany(old);
    const next = await appendChained(db, 't_log', SAMPLE[2]);
    assert.equal(next.seq, 3);
    assert.equal(next.prevHash, old[1].hash);
    const stored = await db.collection('t_log').find({}).sort({ seq: 1 }).toArray();
    assert.deepEqual(stored.slice(0, 2), old);
    assert.equal((await verifyLog(db, 't_log')).valid, true);
  });

  test('alterar un campo anidado en Mongo rompe la verificacion y restaurarlo la repara', async () => {
    await appendChained(db, 't_log', SAMPLE[0]);
    const victim = await appendChained(db, 't_log', SAMPLE[1]);
    await appendChained(db, 't_log', SAMPLE[2]);
    await db.collection('t_log').updateOne({ _id: victim._id }, { $set: { 'detail.update.name': 'Alterado' } });
    assert.deepEqual(await verifyLog(db, 't_log'), { valid: false, totalEntries: 3, brokenAtSeq: 2 });
    await db.collection('t_log').updateOne({ _id: victim._id }, { $set: { 'detail.update.name': 'Dos' } });
    assert.equal((await verifyLog(db, 't_log')).valid, true);
  });

  test('valores que Mongo no devuelve tal cual (undefined, fechas, claves con $) siguen verificando', async () => {
    const when = new Date('2026-10-12T10:00:00Z');
    const doc = await appendChained(db, 't_log', {
      action: 'mix',
      actorId: 'u',
      detail: { omitido: undefined, nulo: null, cuando: when, lista: [1, undefined, 'x'], $set: { campo: 'v', vacio: undefined }, n: 0.1 + 0.2 },
    });
    assert.equal('omitido' in doc.detail, false);
    assert.equal(doc.detail.cuando, when.toISOString());
    assert.equal(doc.detail.lista[1], null);
    assert.deepEqual(await verifyLog(db, 't_log'), { valid: true, totalEntries: 1, brokenAtSeq: null });
  });

  test('escrituras simultaneas con indice unico en seq quedan todas encadenadas', async () => {
    await db.collection('t_log').createIndex({ seq: 1 }, { unique: true });
    const rows = await Promise.all([0, 1, 2, 3].map((i) => appendChained(db, 't_log', { action: 'par', actorId: `u${i}`, detail: { i } })));
    assert.deepEqual(rows.map((r) => r.seq).sort(), [1, 2, 3, 4]);
    assert.deepEqual(await verifyLog(db, 't_log'), { valid: true, totalEntries: 4, brokenAtSeq: null });
  });
});
