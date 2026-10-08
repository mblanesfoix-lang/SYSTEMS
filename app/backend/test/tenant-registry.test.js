/**
 * Test de db/tenant-registry.js contra Mongo real de prueba.
 * Mismo patron que resilience.routes.test.js: se salta sin MONGO_URI.
 * No monta ningun mountX — solo ejercita getTenantDb/getTenantDbSync/
 * TenantNotFoundError directamente contra 2 tenants de prueba reales.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MongoClient } from 'mongodb';
import { connectMongo, closeMongo } from '../db/mongo.js';
import {
  getTenantDb,
  getTenantDbSync,
  tenantsCollection,
  TenantNotFoundError,
  __resetTenantRegistryForTests,
} from '../db/tenant-registry.js';

const MONGO_URI = process.env.MONGO_URI;
const skip = !MONGO_URI;

let client;

const TENANT_A = 'tenant_test_a';
const TENANT_B = 'tenant_test_b';
const TENANT_SUSPENDED = 'tenant_test_suspended';

describe('db/tenant-registry.js: aislamiento entre tenants, cache, estado suspendido', { skip: skip && 'MONGO_URI no configurada' }, () => {
  before(async () => {
    process.env.MONGO_URI = MONGO_URI;
    client = await connectMongo();

    await tenantsCollection().deleteMany({ _id: { $in: [TENANT_A, TENANT_B, TENANT_SUSPENDED] } });
    await client.db(`db_${TENANT_A}`).collection('probe').deleteMany({});
    await client.db(`db_${TENANT_B}`).collection('probe').deleteMany({});

    await tenantsCollection().insertMany([
      {
        _id: TENANT_A,
        kind: 'internal',
        displayName: 'Tenant A (test)',
        status: 'active',
        mongo: { mode: 'shared-cluster', uri: null, dbName: `db_${TENANT_A}`, reffDbName: `reff_${TENANT_A}` },
        createdAt: new Date().toISOString(),
      },
      {
        _id: TENANT_B,
        kind: 'internal',
        displayName: 'Tenant B (test)',
        status: 'active',
        mongo: { mode: 'shared-cluster', uri: null, dbName: `db_${TENANT_B}`, reffDbName: `reff_${TENANT_B}` },
        createdAt: new Date().toISOString(),
      },
      {
        _id: TENANT_SUSPENDED,
        kind: 'internal',
        displayName: 'Tenant suspendido (test)',
        status: 'suspended',
        mongo: { mode: 'shared-cluster', uri: null, dbName: `db_${TENANT_SUSPENDED}`, reffDbName: `reff_${TENANT_SUSPENDED}` },
        createdAt: new Date().toISOString(),
      },
    ]);
  });

  beforeEach(() => {
    __resetTenantRegistryForTests();
  });

  after(async () => {
    await tenantsCollection().deleteMany({ _id: { $in: [TENANT_A, TENANT_B, TENANT_SUSPENDED] } });
    await client.db(`db_${TENANT_A}`).dropDatabase();
    await client.db(`db_${TENANT_B}`).dropDatabase();
    await closeMongo();
  });

  test('getTenantDb resuelve dbs distintas y fisicamente separadas por tenant', async () => {
    const dbA = await getTenantDb(TENANT_A);
    const dbB = await getTenantDb(TENANT_B);

    await dbA.collection('probe').insertOne({ marker: 'solo-en-a' });

    const foundInA = await dbA.collection('probe').findOne({ marker: 'solo-en-a' });
    const foundInB = await dbB.collection('probe').findOne({ marker: 'solo-en-a' });

    assert.ok(foundInA, 'el documento debe existir en el tenant donde se escribio');
    assert.equal(foundInB, null, 'el tenant B no debe ver nada escrito en el tenant A');
    assert.notEqual(dbA.databaseName, dbB.databaseName);
  });

  test('getTenantDb cachea: segunda llamada devuelve el mismo Db sin volver a leer tenants', async () => {
    const first = await getTenantDb(TENANT_A);
    await tenantsCollection().deleteOne({ _id: TENANT_A }); // si no cacheara, la siguiente llamada fallaria
    const second = await getTenantDb(TENANT_A);
    assert.equal(first, second);

    // restaurar para el resto de la suite
    await tenantsCollection().insertOne({
      _id: TENANT_A,
      kind: 'internal',
      displayName: 'Tenant A (test)',
      status: 'active',
      mongo: { mode: 'shared-cluster', uri: null, dbName: `db_${TENANT_A}`, reffDbName: `reff_${TENANT_A}` },
      createdAt: new Date().toISOString(),
    });
  });

  test('getTenantDbSync exige resolucion async previa (cache en frio lanza TenantNotFoundError)', async () => {
    assert.throws(() => getTenantDbSync(TENANT_A), TenantNotFoundError);
    await getTenantDb(TENANT_A);
    assert.doesNotThrow(() => getTenantDbSync(TENANT_A));
  });

  test('tenant suspendido o inexistente lanza TenantNotFoundError', async () => {
    await assert.rejects(() => getTenantDb(TENANT_SUSPENDED), TenantNotFoundError);
    await assert.rejects(() => getTenantDb('tenant_que_no_existe'), TenantNotFoundError);
  });
});
