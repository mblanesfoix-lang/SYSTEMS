/**
 * Desbloqueos publicos de Pactvm Viridi (verificacion de certificados de carbono
 * e invitados VDR): codigos de acceso hasheados, traza de los intentos fallidos
 * y limite de intentos por IP + objetivo y por objetivo desde cualquier IP.
 *
 * Mongo real de prueba y mountPactvm aislado (sin sentinel-forensics.attach()), con el
 * acceso a datos por tenant de server.js (Proxy y registro de tenants) sobre un tenant
 * de prueba con dbs propias: pactvm.routes.test.js vacia pactvm_log en elvira_test y los
 * ficheros de test corren en paralelo. Se salta si no hay MONGO_URI.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { connectMongo, closeMongo, getMongoClient } from '../db/mongo.js';
import { tenantsCollection, getTenantDb, getTenantReffDb } from '../db/tenant-registry.js';
import { tenantContext, createTenantAwareDb, createTenantAwareReffDb } from '../db/tenant-context.js';
import { mountPactvm } from '../pactum-viridi.js';
import { createDataSeal } from '../lib/data-seal.js';

const MONGO_URI = process.env.MONGO_URI;
const skip = !MONGO_URI;
const TENANT = 'tenant_test_pactvm_unlock';
const DB_NAME = 'elvira_test_pactvm_unlock';
const REFF_DB_NAME = 'reff_test_pactvm_unlock';
const FRONT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../frontend');

let db;
let server;
let baseUrl;

// Como el auth real: sesion de admin y tenant fijado en el contexto.
const adminAuth = (req, res, next) => {
  req.user = 'test-admin';
  req.role = 'admin';
  req.tenantId = TENANT;
  tenantContext.run({ tenantId: TENANT }, next);
};
const requireMesaStub = () => (req, res, next) => next();
const requireAdminStub = (req, res, next) => (req.role === 'admin' ? next() : res.status(403).json({ error: 'admin requerido' }));
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const dataSeal = createDataSeal(crypto.randomBytes(32));

// ip simula el cliente via X-Forwarded-For (la app de prueba tiene trust proxy).
async function call(method, path, { body, ip } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(ip ? { 'X-Forwarded-For': ip } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function newPackage(id, emails = ['auditor@cliente.com']) {
  await db.collection('pactvm_carbon_verify').insertOne({
    _id: id, status: 'VALID', type: 'carbon_certificate', period: '2026-09', clientName: 'Cliente Test',
    co2eTotal: 12.5, co2eWeightedTotal: 10, dbo5Total: 3, merkleRoot: 'abc123', createdAt: new Date().toISOString(),
  });
  const put = await call('PUT', `/api/pactvm/carbon/packages/${id}/allowlist`, { body: { emails } });
  assert.equal(put.status, 200);
}

async function issueCode(id, minutes = 5) {
  const r = await call('POST', `/api/pactvm/carbon/packages/${id}/access-code`, { body: { minutes } });
  assert.equal(r.status, 201);
  assert.match(r.body.code, /^\d{6}$/);
  return r.body.code;
}

const unlock = (id, email, code, ip) => call('POST', `/api/pactvm-verify/${id}/unlock`, { body: { email, code }, ip });
const WRONG = '000000'; // randomInt(100000, 999999) nunca emite un codigo que empiece por 0

describe('pactvm: desbloqueos publicos endurecidos', { skip: skip && 'MONGO_URI no configurada' }, () => {
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
      displayName: 'Tenant de prueba (desbloqueos Pactvm)',
      status: 'active',
      mongo: { mode: 'shared-cluster', uri: null, dbName: DB_NAME, reffDbName: REFF_DB_NAME },
      createdAt: new Date().toISOString(),
    });
    await getTenantDb(TENANT);
    await getTenantReffDb(TENANT);

    const app = express();
    app.set('trust proxy', true);
    app.use(express.json());
    const reffDb = createTenantAwareReffDb();
    mountPactvm(app, {
      auth: adminAuth,
      requireMesa: requireMesaStub,
      requireAdmin: requireAdminStub,
      mongo: createTenantAwareDb(),
      getReffDb: () => reffDb,
      getU2Snapshot: () => null,
      systemTenantId: TENANT,
      dataSeal,
    });
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    try {
      if (server) await new Promise((resolve) => server.close(resolve));
      const client = getMongoClient();
      await tenantsCollection().deleteOne({ _id: TENANT });
      await client.db(DB_NAME).dropDatabase();
      await client.db(REFF_DB_NAME).dropDatabase();
    } finally {
      await closeMongo();
    }
  });

  describe('verificacion de certificados de carbono', () => {
    test('las tarjetas HTML no llevan script en linea; la restringida carga su archivo', async () => {
      const html = async (id) => {
        const res = await fetch(`${baseUrl}/api/pactvm-verify/${id}`, { headers: { Accept: 'text/html' } });
        return { status: res.status, body: await res.text() };
      };
      const inlineScripts = (body) => [...body.matchAll(/<script\b([^>]*)>/gi)].filter(([, attrs]) => !/\ssrc=/.test(attrs));
      await newPackage('PKG-HTML');
      const gated = await html('PKG-HTML');
      assert.equal(gated.status, 200);
      assert.deepEqual(inlineScripts(gated.body), []);
      assert.ok(gated.body.includes('<script src="/js/pactvm-verify-gate.js"></script>'));
      assert.ok(gated.body.includes('data-package-id="PKG-HTML"'));
      assert.ok(fs.existsSync(path.join(FRONT, 'js', 'pactvm-verify-gate.js')));
      const missing = await html('PKG-NO-EXISTE');
      assert.equal(missing.status, 404);
      assert.deepEqual(inlineScripts(missing.body), []);
    });

    test('el codigo de acceso se guarda con HMAC de la clave del servidor, nunca en claro', async () => {
      await newPackage('PKG-HASH');
      const code = await issueCode('PKG-HASH');
      const doc = await db.collection('pactvm_verify_access_codes').findOne({ packageId: 'PKG-HASH' });
      assert.equal(doc.codeHash, dataSeal.mac('pactvm.access-code', code));
      // un sha256 sin clave se recuperaria probando el millon de codigos posibles
      assert.notEqual(doc.codeHash, sha256(code));
      assert.equal(doc.code, undefined);
      assert.ok(!JSON.stringify(doc).includes(code), 'el codigo en claro no debe aparecer en el documento');
    });

    test('un codigo heredado guardado con sha256 sin clave ya no desbloquea', async () => {
      await newPackage('PKG-SHA');
      await db.collection('pactvm_verify_access_codes').insertOne({
        _id: 'legacy-sha', packageId: 'PKG-SHA', codeHash: sha256('654321'),
        expiresAt: new Date(Date.now() + 60_000).toISOString(), usedBy: [],
      });
      const r = await unlock('PKG-SHA', 'auditor@cliente.com', '654321', '203.0.113.5');
      assert.equal(r.status, 403);
    });

    test('correo autorizado + codigo correcto -> 200 y queda el uso registrado', async () => {
      await newPackage('PKG-OK');
      const code = await issueCode('PKG-OK');
      const r = await unlock('PKG-OK', 'Auditor@Cliente.com', code, '203.0.113.1');
      assert.equal(r.status, 200);
      assert.equal(r.body.clientName, 'Cliente Test');
      assert.equal(r.body.co2eTotal, 12.5);
      const doc = await db.collection('pactvm_verify_access_codes').findOne({ packageId: 'PKG-OK' });
      assert.equal(doc.usedBy.length, 1);
      assert.equal(doc.usedBy[0].email, 'auditor@cliente.com');
    });

    test('codigo erroneo -> 403 y traza carbon.verify_denied sin guardar el codigo probado', async () => {
      await newPackage('PKG-DENY');
      await issueCode('PKG-DENY');
      const r = await unlock('PKG-DENY', 'auditor@cliente.com', '123456', '203.0.113.2');
      assert.equal(r.status, 403);
      const log = await db.collection('pactvm_log').find({ action: 'carbon.verify_denied', 'detail.packageId': 'PKG-DENY' }).toArray();
      assert.equal(log.length, 1);
      assert.equal(log[0].detail.reason, 'codigo_invalido_o_caducado');
      assert.ok(!JSON.stringify(log[0]).includes('123456'), 'el codigo probado no debe quedar en el log');
    });

    test('correo fuera de la allowlist -> 403 y traza email_no_autorizado', async () => {
      await newPackage('PKG-MAIL');
      const code = await issueCode('PKG-MAIL');
      const r = await unlock('PKG-MAIL', 'intruso@otro.com', code, '203.0.113.3');
      assert.equal(r.status, 403);
      const log = await db.collection('pactvm_log').findOne({ action: 'carbon.verify_denied', 'detail.packageId': 'PKG-MAIL' });
      assert.equal(log.detail.reason, 'email_no_autorizado');
    });

    test('un documento heredado con el codigo en claro ya no desbloquea', async () => {
      await newPackage('PKG-LEGACY');
      await db.collection('pactvm_verify_access_codes').insertOne({
        _id: 'legacy-1', packageId: 'PKG-LEGACY', code: '123456',
        expiresAt: new Date(Date.now() + 60_000).toISOString(), usedBy: [],
      });
      const r = await unlock('PKG-LEGACY', 'auditor@cliente.com', '123456', '203.0.113.4');
      assert.equal(r.status, 403);
    });

    test('limite por IP y paquete: 10 fallos y el 11 recibe 429 aunque el codigo sea correcto; otra IP no se ve afectada', async () => {
      await newPackage('PKG-LIM');
      const good = await issueCode('PKG-LIM');
      const ip = '203.0.113.7';
      for (let i = 0; i < 10; i++) {
        const r = await unlock('PKG-LIM', 'auditor@cliente.com', WRONG, ip);
        assert.equal(r.status, 403, `intento ${i + 1}`);
      }
      const blocked = await unlock('PKG-LIM', 'auditor@cliente.com', good, ip);
      assert.equal(blocked.status, 429);
      assert.match(blocked.body.error, /intentos/i);
      const otherIp = await unlock('PKG-LIM', 'auditor@cliente.com', good, '203.0.113.99');
      assert.equal(otherIp.status, 200);
    });

    test('el limite es por objetivo: la misma IP bloqueada en un paquete sigue entrando en otro', async () => {
      await newPackage('PKG-A');
      await newPackage('PKG-B');
      await issueCode('PKG-A');
      const goodB = await issueCode('PKG-B');
      const ip = '203.0.113.8';
      for (let i = 0; i < 10; i++) await unlock('PKG-A', 'auditor@cliente.com', WRONG, ip);
      assert.equal((await unlock('PKG-A', 'auditor@cliente.com', WRONG, ip)).status, 429);
      assert.equal((await unlock('PKG-B', 'auditor@cliente.com', goodB, ip)).status, 200);
    });

    test('ataque distribuido: 30 fallos desde IPs distintas bloquean el paquete para todas las IPs', async () => {
      await newPackage('PKG-DIST');
      const good = await issueCode('PKG-DIST');
      for (let i = 1; i <= 30; i++) {
        const r = await unlock('PKG-DIST', 'auditor@cliente.com', WRONG, `198.51.100.${i}`);
        assert.equal(r.status, 403, `fallo ${i}`);
      }
      const blocked = await unlock('PKG-DIST', 'auditor@cliente.com', good, '198.51.100.200');
      assert.equal(blocked.status, 429);
    });

    test('los desbloqueos correctos no consumen el cupo de intentos', async () => {
      await newPackage('PKG-MANY');
      const good = await issueCode('PKG-MANY');
      for (let i = 0; i < 12; i++) {
        const r = await unlock('PKG-MANY', 'auditor@cliente.com', good, '203.0.113.50');
        assert.equal(r.status, 200, `desbloqueo ${i + 1}`);
      }
    });
  });

  describe('enlaces de invitado VDR', () => {
    test('10 fallos y el 11 recibe 429; con otra IP y el codigo correcto entra', async () => {
      const company = await call('POST', '/api/pactvm/vdr/companies', {
        body: { name: 'Empresa VDR Test', geoCountry: 'DE', geoWeight: 5, spainActivity: 3 },
      });
      assert.equal(company.status, 201);
      const share = await call('POST', '/api/pactvm/vdr/shares', {
        body: { companyId: company.body.id, emails: ['cliente@vdr.com'], minutes: 5 },
      });
      assert.equal(share.status, 201);
      const { token, code } = share.body;
      const unlockVdr = (c, ip) => call('POST', `/api/vdr-share/${token}/unlock`, { body: { email: 'cliente@vdr.com', code: c }, ip });

      const ip = '192.0.2.10';
      for (let i = 0; i < 10; i++) {
        assert.equal((await unlockVdr(WRONG, ip)).status, 403, `intento ${i + 1}`);
      }
      assert.equal((await unlockVdr(code, ip)).status, 429);

      const ok = await unlockVdr(code, '192.0.2.11');
      assert.equal(ok.status, 200);
      assert.equal(ok.body.company.id, company.body.id);
    });

    test('el enlace se guarda por su huella: el token no esta en la base ni en el registro', async () => {
      const company = await call('POST', '/api/pactvm/vdr/companies', {
        body: { name: 'Empresa VDR Huella', geoCountry: 'FR', geoWeight: 2, spainActivity: 1 },
      });
      const share = await call('POST', '/api/pactvm/vdr/shares', {
        body: { companyId: company.body.id, emails: ['cliente@vdr.com'], minutes: 5 },
      });
      assert.equal(share.status, 201);
      const { id, token, code, url } = share.body;
      assert.equal(id, sha256(token));
      assert.ok(url.endsWith(`?t=${token}`));

      const doc = await db.collection('pactvm_vdr_shares').findOne({ _id: id });
      assert.ok(doc);
      assert.equal(await db.collection('pactvm_vdr_shares').findOne({ _id: token }), null);
      assert.ok(!JSON.stringify(doc).includes(token));
      assert.ok(!JSON.stringify(doc).includes(code));
      assert.equal(doc.codeHash, dataSeal.mac('pactvm.access-code', code));

      assert.equal((await call('GET', `/api/vdr-share/${token}`)).status, 200);
      // la huella no sirve como enlace
      assert.equal((await call('GET', `/api/vdr-share/${id}`)).status, 404);
      const ok = await call('POST', `/api/vdr-share/${token}/unlock`, { body: { email: 'cliente@vdr.com', code }, ip: '192.0.2.20' });
      assert.equal(ok.status, 200);

      const list = await call('GET', '/api/pactvm/vdr/shares');
      assert.ok(list.body.some((s) => s.id === id));
      assert.ok(!JSON.stringify(list.body).includes(token));

      const revoked = await call('DELETE', `/api/pactvm/vdr/shares/${id}`);
      assert.equal(revoked.status, 200);
      assert.deepEqual(revoked.body, { id, revoked: true });
      assert.equal((await call('GET', `/api/vdr-share/${token}`)).status, 410);

      const log = await db.collection('pactvm_log').find({ action: /^vdr\.share_/ }).toArray();
      assert.ok(log.some((e) => e.action === 'vdr.share_created' && e.detail.shareId === id));
      assert.ok(log.some((e) => e.action === 'vdr.share_revoked' && e.detail.shareId === id));
      assert.ok(!JSON.stringify(log).includes(token), 'el token no debe quedar en pactvm_log');
    });
  });
});
