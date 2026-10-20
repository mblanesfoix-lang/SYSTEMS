/**
 * Rutas publicas de Pactvm Viridi (verificacion de certificados por QR y enlaces de
 * invitado VDR) montadas como en server.js: con el acceso a datos por tenant real
 * (Proxy de createTenantAwareDb y registro de tenants), no con una db directa.
 *
 * Las rutas privadas pasan por un auth de prueba que fija el tenant en el contexto
 * como el real; las publicas se llaman sin sesion. El tenant de prueba vive en
 * elvira_control.tenants con dbs propias y se borra al terminar. Se salta sin MONGO_URI.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { connectMongo, closeMongo, getMongoClient } from '../db/mongo.js';
import { tenantsCollection, getTenantDb, getTenantReffDb } from '../db/tenant-registry.js';
import { tenantContext, createTenantAwareDb, createTenantAwareReffDb } from '../db/tenant-context.js';
import { captureAsyncErrors, createErrorHandler } from '../lib/async-errors.js';
import { mountPactvm } from '../pactum-viridi.js';

const MONGO_URI = process.env.MONGO_URI;
const skip = !MONGO_URI;
const TENANT = 'tenant_test_pactvm_public';
const DB_NAME = 'elvira_test_pactvm_public';
const REFF_DB_NAME = 'reff_test_pactvm_public';

let server;
let baseUrl;
const routeErrors = [];

// Igual que createAuthMiddleware: sesion de admin del tenant de prueba y contexto fijado.
const adminAuth = (req, res, next) => {
  if (req.headers.authorization !== 'Bearer admin-de-prueba') return res.status(401).json({ error: 'unauthorized' });
  req.user = 'test-admin';
  req.role = 'admin';
  req.tenantId = TENANT;
  tenantContext.run({ tenantId: TENANT }, next);
};
const requireMesaStub = () => (req, res, next) => next();
const requireAdminStub = (req, res, next) => (req.role === 'admin' ? next() : res.status(403).json({ error: 'admin requerido' }));

// Sin Accept explicito la verificacion responde con la tarjeta HTML (la que ve un movil al
// escanear el QR); las llamadas programaticas piden JSON.
async function call(method, path, { body, admin = false, accept = 'application/json' } = {}) {
  const headers = { 'Content-Type': 'application/json', Accept: accept };
  if (admin) headers.Authorization = 'Bearer admin-de-prueba';
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* respuesta HTML */ }
  return { status: res.status, body: json, text };
}

describe('pactvm: rutas publicas con acceso a datos por tenant', { skip: skip && 'MONGO_URI no configurada' }, () => {
  before(async () => {
    await connectMongo();
    const client = getMongoClient();
    await client.db(DB_NAME).dropDatabase();
    await client.db(REFF_DB_NAME).dropDatabase();
    await tenantsCollection().deleteOne({ _id: TENANT });
    await tenantsCollection().insertOne({
      _id: TENANT,
      kind: 'internal',
      displayName: 'Tenant de prueba (Pactvm publico)',
      status: 'active',
      mongo: { mode: 'shared-cluster', uri: null, dbName: DB_NAME, reffDbName: REFF_DB_NAME },
      createdAt: new Date().toISOString(),
    });
    // Como server.js: el registro se calienta antes de montar (las siembras de arranque usan el Proxy).
    await getTenantDb(TENANT);
    await getTenantReffDb(TENANT);

    captureAsyncErrors(express);
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
    });
    app.use(createErrorHandler({ notify: (n) => routeErrors.push(n), log: { error() {} } }));
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
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

  test('verificacion de certificados sin sesion: identificadores inexistentes o raros dan 404, no 500', async () => {
    for (const id of ['no-existe', 'a'.repeat(300), 'certificado%20falso', encodeURIComponent('ñ€'), '%7B%22%24gt%22%3A%22%22%7D']) {
      const json = await call('GET', `/api/pactvm-verify/${id}`);
      assert.equal(json.status, 404, `GET ${id}`);
      assert.equal(json.body.status, 'NOT_FOUND');
      const html = await call('GET', `/api/pactvm-verify/${id}`, { accept: 'text/html' });
      assert.equal(html.status, 404, `GET html ${id}`);
      assert.match(html.text, /No encontrado/);
    }
    const unlock = await call('POST', '/api/pactvm-verify/no-existe/unlock', { body: { email: 'a@b.com', code: '123456' } });
    assert.equal(unlock.status, 403);
    const sinDatos = await call('POST', '/api/pactvm-verify/no-existe/unlock', { body: {} });
    assert.equal(sinDatos.status, 400);
    assert.deepEqual(routeErrors, []);
  });

  test('enlaces de invitado VDR sin sesion: inexistentes dan 404', async () => {
    const estado = await call('GET', '/api/vdr-share/no-existe');
    assert.equal(estado.status, 404);
    assert.equal(estado.body.status, 'NOT_FOUND');
    const unlock = await call('POST', '/api/vdr-share/no-existe/unlock', { body: { email: 'a@b.com', code: '123456' } });
    assert.equal(unlock.status, 404);
    assert.deepEqual(routeErrors, []);
  });

  test('certificado de principio a fin: emitido con sesion, verificado sin ella desde el tenant', async () => {
    const cliente = await call('POST', '/api/pactvm/carbon/clients', {
      admin: true,
      body: { clientName: 'Cliente Publico', period: '2026-09', co2eTons: 12.5, dbo5Tons: 3, hectares: 2, revenueEur: 1000, ghgGases: ['co2', 'ch4'] },
    });
    assert.equal(cliente.status, 201);
    const emitido = await call('POST', '/api/pactvm/carbon/emit-certificate', { admin: true, body: { period: '2026-09' } });
    assert.equal(emitido.status, 201);
    const { packageId, snapshot } = emitido.body;
    assert.match(snapshot.security.verificationUrl, new RegExp(`/api/pactvm-verify/${packageId}$`));

    // Los datos estan en la db del tenant, a la que llegan las rutas publicas.
    const fila = await getMongoClient().db(DB_NAME).collection('pactvm_carbon_verify').findOne({ _id: packageId });
    assert.equal(fila.merkleRoot, snapshot.security.merkleRoot);

    const publico = await call('GET', `/api/pactvm-verify/${packageId}`);
    assert.equal(publico.status, 200);
    assert.equal(publico.body.packageId, packageId);
    assert.equal(publico.body.merkleRoot, snapshot.security.merkleRoot);
    assert.equal(publico.body.merkleVersion, snapshot.security.merkleVersion);
    const tarjeta = await call('GET', `/api/pactvm-verify/${packageId}`, { accept: 'text/html' });
    assert.equal(tarjeta.status, 200);
    assert.ok(tarjeta.text.includes(snapshot.security.merkleRoot));

    // Acceso restringido: sin codigo 403; con correo autorizado y codigo, los datos.
    const allow = await call('PUT', `/api/pactvm/carbon/packages/${packageId}/allowlist`, { admin: true, body: { emails: ['auditor@cliente.com'] } });
    assert.equal(allow.status, 200);
    assert.equal((await call('GET', `/api/pactvm-verify/${packageId}`)).status, 403);
    const codigo = await call('POST', `/api/pactvm/carbon/packages/${packageId}/access-code`, { admin: true, body: { minutes: 5 } });
    assert.equal(codigo.status, 201);
    const mal = await call('POST', `/api/pactvm-verify/${packageId}/unlock`, { body: { email: 'auditor@cliente.com', code: '000000' } });
    assert.equal(mal.status, 403);
    const ok = await call('POST', `/api/pactvm-verify/${packageId}/unlock`, { body: { email: 'auditor@cliente.com', code: codigo.body.code } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.clientName, 'Cliente Publico');
    assert.equal(ok.body.merkleRoot, snapshot.security.merkleRoot);

    // Las trazas del acceso publico van a la cadena del tenant, no a otra.
    const denegado = await getMongoClient().db(DB_NAME).collection('pactvm_log').findOne({ action: 'carbon.verify_denied', 'detail.packageId': packageId });
    assert.equal(denegado.detail.reason, 'codigo_invalido_o_caducado');
    const verify = await call('GET', '/api/pactvm/log/verify', { admin: true });
    assert.equal(verify.status, 200);
    assert.equal(verify.body.valid, true);
    assert.deepEqual(routeErrors, []);
  });

  test('enlace VDR de principio a fin sin sesion', async () => {
    const empresa = await call('POST', '/api/pactvm/vdr/companies', {
      admin: true, body: { name: 'Empresa VDR Publica', geoCountry: 'DE', geoWeight: 5, spainActivity: 3 },
    });
    assert.equal(empresa.status, 201);
    const enlace = await call('POST', '/api/pactvm/vdr/shares', {
      admin: true, body: { companyId: empresa.body.id, emails: ['cliente@vdr.com'], minutes: 5 },
    });
    assert.equal(enlace.status, 201);
    const { token, code } = enlace.body;

    const estado = await call('GET', `/api/vdr-share/${token}`);
    assert.equal(estado.status, 200);
    assert.equal(estado.body.status, 'ACTIVE');
    const ajeno = await call('POST', `/api/vdr-share/${token}/unlock`, { body: { email: 'intruso@otro.com', code } });
    assert.equal(ajeno.status, 403);
    const ok = await call('POST', `/api/vdr-share/${token}/unlock`, { body: { email: 'cliente@vdr.com', code } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.company.id, empresa.body.id);
    assert.equal(ok.body.globe.esCurtailment.regions, undefined);
    assert.deepEqual(routeErrors, []);
  });
});
