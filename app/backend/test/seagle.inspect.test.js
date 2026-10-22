/**
 * Ventana de inspeccion de S-EAGLE de punta a punta: el Admin invita, el
 * inspector entra con enlace y codigo y ve solo lo compartido. Montada como en
 * server.js, con acceso a datos por tenant real (Proxy y registro de tenants),
 * porque las rutas publicas fijan su tenant sin sesion. El tenant de prueba vive
 * en elvira_control.tenants con dbs propias y se borra al terminar. Se salta sin
 * MONGO_URI.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import express from 'express';
import { GridFSBucket } from 'mongodb';
import { connectMongo, closeMongo, getMongoClient } from '../db/mongo.js';
import { tenantsCollection, getTenantDb, getTenantReffDb } from '../db/tenant-registry.js';
import { tenantContext, createTenantAwareDb } from '../db/tenant-context.js';
import { captureAsyncErrors, createErrorHandler } from '../lib/async-errors.js';
import { createDataSeal } from '../lib/data-seal.js';
import { verifyChain } from '../lib/hash-chain.js';
import { INVITE_MAX_FAILURES } from '../lib/inspection-invite.js';
import { mountSeagle } from '../seagle.js';

const MONGO_URI = process.env.MONGO_URI;
const skip = !MONGO_URI;
const TENANT = 'tenant_test_seagle_inspect';
const DB_NAME = 'elvira_test_seagle_inspect';
const REFF_DB_NAME = 'reff_test_seagle_inspect';

let server, baseUrl, db;
const notices = [];
const routeErrors = [];

// Sesiones de SYSTEMS de prueba: admin, un analista con la mesa seagle y un admin de otro tenant.
const SESSIONS = {
  'Bearer admin': { user: 'admin', role: 'admin', tenantId: TENANT },
  'Bearer analista': { user: 'analista', role: 'analyst', tenantId: TENANT },
  'Bearer otro-tenant': { user: 'admin2', role: 'admin', tenantId: 'otro_tenant' },
};
const auth = (req, res, next) => {
  const s = SESSIONS[req.headers.authorization];
  if (!s) return res.status(401).json({ error: 'unauthorized' });
  Object.assign(req, { user: s.user, role: s.role, tenantId: s.tenantId });
  tenantContext.run({ tenantId: s.tenantId }, next);
};
const requireMesa = () => (req, res, next) => next();
const requireAdmin = (req, res, next) => (req.role === 'admin' ? next() : res.status(403).json({ error: 'admin requerido' }));

async function call(method, path, { body, as, bearer, ip } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (as) headers.Authorization = `Bearer ${as}`;
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (ip) headers['X-Forwarded-For'] = ip;
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buf.toString('utf8')); } catch { /* binario */ }
  return { status: res.status, body: json, raw: buf, headers: res.headers };
}

const invite = (body, as = 'admin') => call('POST', '/api/seagle/invitations', { body, as });
const unlock = (token, email, code, ip) => call('POST', '/api/seagle-inspect/unlock', { body: { token, email, code }, ip });
const view = (sessionToken) => call('GET', '/api/seagle-inspect/view', { bearer: sessionToken });
const isoIn = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

async function uploadDocument(filename, content) {
  const bucket = new GridFSBucket(db, { bucketName: 'herzog_law_documents' });
  const upload = bucket.openUploadStream(filename, { metadata: { content_type: 'application/pdf', framework_id: 'iso-9001' } });
  await new Promise((resolve, reject) => Readable.from([Buffer.from(content)]).pipe(upload).on('finish', resolve).on('error', reject));
  return upload.id.toString();
}

describe('seagle: invitaciones de inspeccion y acceso del inspector', { skip: skip && 'MONGO_URI no configurada' }, () => {
  let sharedDoc, privateDoc;

  before(async () => {
    await connectMongo();
    const client = getMongoClient();
    await client.db(DB_NAME).dropDatabase();
    await client.db(REFF_DB_NAME).dropDatabase();
    await tenantsCollection().deleteOne({ _id: TENANT });
    await tenantsCollection().insertOne({
      _id: TENANT, kind: 'internal', displayName: 'Tenant de prueba (S-EAGLE)', status: 'active',
      mongo: { mode: 'shared-cluster', uri: null, dbName: DB_NAME, reffDbName: REFF_DB_NAME },
      createdAt: new Date().toISOString(),
    });
    db = await getTenantDb(TENANT);
    await getTenantReffDb(TENANT);

    await db.collection('herzog_law_frameworks').insertMany([
      { _id: 'iso-9001', code: 'ISO 9001', title: 'Calidad', kind: 'iso', family: 'ISO', jurisdictions: ['INT'], nature: 'obligatoria', priority: 'media', status: 'vigente', tracksExpiry: true, expiresAt: isoIn(300), requirements: [{ id: 'r1', done: true }], notes: 'nota interna reservada' },
      { _id: 'atex', code: 'ATEX', title: 'ATEX', kind: 'ue', family: 'UE', jurisdictions: ['UE'], nature: 'obligatoria', priority: 'alta', status: 'no_iniciado', tracksExpiry: false, expiresAt: null, requirements: [] },
    ]);
    await db.collection('herzog_law_zones').insertOne({ _id: 'z1', name: 'Silo', kind: 'polvo', zone: '21', status: 'clasificada' });
    sharedDoc = await uploadDocument('certificado-iso.pdf', '%PDF-1.4 compartido');
    privateDoc = await uploadDocument('interno.pdf', '%PDF-1.4 reservado');

    captureAsyncErrors(express);
    const app = express();
    app.set('trust proxy', true);
    app.use(express.json());
    mountSeagle(app, {
      auth, requireMesa, requireAdmin, mongo: createTenantAwareDb(),
      adminNotify: (n) => notices.push(n),
      systemTenantId: TENANT, dataSeal: createDataSeal(crypto.randomBytes(32)), integrityTtlMs: 0,
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

  describe('alta de invitaciones (solo Admin)', () => {
    test('sin sesion 401; un usuario con la mesa pero sin ser Admin, 403', async () => {
      assert.equal((await call('POST', '/api/seagle/invitations', { body: {} })).status, 401);
      assert.equal((await invite({ label: 'Industria', emails: ['i@gob.es'] }, 'analista')).status, 403);
      assert.equal((await call('GET', '/api/seagle/invitations', { as: 'analista' })).status, 403);
    });

    test('desde otro tenant no se crea: el enlace publico no lo encontraria', async () => {
      assert.equal((await invite({ label: 'Industria', emails: ['i@gob.es'] }, 'otro-tenant')).status, 409);
    });

    test('valida lo que pide el Admin', async () => {
      const r = await invite({ label: 'Industria', emails: ['i@gob.es'], frameworkIds: ['no-existe'] });
      assert.equal(r.status, 400);
      assert.match(r.body.error, /desconocida/);
    });

    test('devuelve enlace y codigo una sola vez; en la base solo quedan hashes', async () => {
      const r = await invite({ label: 'Inspección de Industria', emails: ['Inspector@Gob.es'] });
      assert.equal(r.status, 201);
      assert.match(r.body.code, /^\d{6}$/);
      assert.match(r.body.url, /\/pages\/seagle-inspeccion\.html#t=/);
      assert.equal(r.headers.get('cache-control'), 'no-store');
      const row = await db.collection('seagle_invitations').findOne({ _id: r.body.id });
      const stored = JSON.stringify(row);
      assert.ok(!stored.includes(r.body.token) && !stored.includes(`"${r.body.code}"`));
      assert.notEqual(row.codeHash, r.body.code);

      const list = await call('GET', '/api/seagle/invitations', { as: 'admin' });
      const text = JSON.stringify(list.body);
      assert.ok(!text.includes('codeHash') && !text.includes(r.body.token));
      assert.equal(list.body.find((i) => i.id === r.body.id).state, 'ACTIVE');
    });
  });

  describe('acceso del inspector', () => {
    let inv;
    before(async () => {
      inv = (await invite({ label: 'Aduanas CBAM', emails: ['ana@aduanas.es'], frameworkIds: ['iso-9001'], includeZones: false, documentIds: [sharedDoc], demo: false })).body;
    });

    test('estado del enlace sin credenciales: no revela el organismo', async () => {
      const ok = await call('POST', '/api/seagle-inspect/status', { body: { token: inv.token } });
      assert.equal(ok.status, 200);
      assert.equal(ok.body.status, 'ACTIVE');
      assert.ok(!JSON.stringify(ok.body).includes('Aduanas'));
      assert.equal((await call('POST', '/api/seagle-inspect/status', { body: { token: 'no-existe' } })).status, 404);
      assert.equal((await call('POST', '/api/seagle-inspect/status', { body: { token: { $gt: '' } } })).status, 404);
    });

    test('correo no invitado o codigo erroneo: mismo mensaje, y queda en el log', async () => {
      const wrongCode = inv.code === '111111' ? '222222' : '111111';
      const a = await unlock(inv.token, 'intruso@otro.es', inv.code, '198.51.100.1');
      const b = await unlock(inv.token, 'ana@aduanas.es', wrongCode, '198.51.100.1');
      assert.equal(a.status, 403);
      assert.equal(b.status, 403);
      assert.equal(a.body.error, b.body.error);
      const reasons = (await db.collection('seagle_log').find({ action: 'inspect.denied', 'detail.invitationId': inv.id }).toArray()).map((e) => e.detail.reason);
      assert.deepEqual(reasons.sort(), ['codigo_invalido', 'email_no_autorizado']);
    });

    test('entra con correo y codigo y ve solo lo compartido', async () => {
      const r = await unlock(inv.token, 'ANA@aduanas.es', inv.code, '198.51.100.2');
      assert.equal(r.status, 200);
      assert.ok(notices.some((n) => n.severity === 'info' && n.label.includes('Aduanas CBAM')));
      const v = await view(r.body.sessionToken);
      assert.equal(v.status, 200);
      assert.deepEqual(v.body.frameworks.map((f) => f.id), ['iso-9001']);
      assert.equal(v.body.overall.level, 'verde');
      assert.equal(v.body.zones, null);
      assert.equal(v.body.inspection.demo, false);
      assert.deepEqual(v.body.documents.map((d) => d.id), [sharedDoc]);
      assert.equal(v.body.session.email, 'ana@aduanas.es');
      assert.equal(v.body.integrity.seagle.valid, true);
      assert.ok(!JSON.stringify(v.body).includes('nota interna reservada'));

      // La vista previa del Admin es exactamente lo que ve el inspector.
      const preview = await call('GET', `/api/seagle/invitations/${inv.id}/preview`, { as: 'admin' });
      assert.deepEqual(preview.body.frameworks, v.body.frameworks);
    });

    test('documentos: solo descarga los compartidos', async () => {
      const { sessionToken } = (await unlock(inv.token, 'ana@aduanas.es', inv.code, '198.51.100.3')).body;
      const ok = await call('GET', `/api/seagle-inspect/documents/${sharedDoc}`, { bearer: sessionToken });
      assert.equal(ok.status, 200);
      assert.equal(ok.raw.toString(), '%PDF-1.4 compartido');
      assert.match(ok.headers.get('content-disposition'), /attachment/);
      assert.equal((await call('GET', `/api/seagle-inspect/documents/${privateDoc}`, { bearer: sessionToken })).status, 404);
      assert.equal((await call('GET', '/api/seagle-inspect/documents/xyz', { bearer: sessionToken })).status, 404);
    });

    test('sin sesion de inspector no hay vista, tampoco con una sesion de SYSTEMS', async () => {
      assert.equal((await call('GET', '/api/seagle-inspect/view')).status, 401);
      assert.equal((await call('GET', '/api/seagle-inspect/view', { as: 'admin' })).status, 401);
      assert.equal((await view('A'.repeat(43))).status, 401);
    });

    test('cerrar sesion la invalida', async () => {
      const { sessionToken } = (await unlock(inv.token, 'ana@aduanas.es', inv.code, '198.51.100.4')).body;
      assert.equal((await call('POST', '/api/seagle-inspect/logout', { bearer: sessionToken })).status, 200);
      assert.equal((await view(sessionToken)).body.status, 'SESSION_INVALID');
    });

    test('revocar corta al inspector en su siguiente peticion', async () => {
      const { sessionToken } = (await unlock(inv.token, 'ana@aduanas.es', inv.code, '198.51.100.5')).body;
      assert.equal((await view(sessionToken)).status, 200);
      assert.equal((await call('POST', `/api/seagle/invitations/${inv.id}/revoke`, { as: 'admin' })).status, 200);
      const after = await view(sessionToken);
      assert.equal(after.status, 401);
      assert.equal(after.body.status, 'SESSION_INVALID');
      assert.equal((await call('POST', '/api/seagle-inspect/status', { body: { token: inv.token } })).body.status, 'REVOKED');
      assert.equal((await unlock(inv.token, 'ana@aduanas.es', inv.code, '198.51.100.6')).status, 410);
    });
  });

  test('una invitacion caducada no abre ni mantiene sesiones', async () => {
    const inv = (await invite({ label: 'Medio Ambiente', emails: ['m@gob.es'] })).body;
    const { sessionToken } = (await unlock(inv.token, 'm@gob.es', inv.code, '198.51.100.7')).body;
    await db.collection('seagle_invitations').updateOne({ _id: inv.id }, { $set: { expiresAt: new Date(Date.now() - 1000).toISOString() } });
    assert.equal((await view(sessionToken)).body.status, 'EXPIRED');
    assert.equal((await unlock(inv.token, 'm@gob.es', inv.code, '198.51.100.8')).status, 410);
  });

  test(`tras ${INVITE_MAX_FAILURES} fallos la invitacion se bloquea aunque luego llegue el codigo bueno`, async () => {
    const inv = (await invite({ label: 'Trabajo', emails: ['t@gob.es'] })).body;
    const wrong = inv.code === '000001' ? '000002' : '000001';
    // Desde IPs distintas: el limitador por IP no frena el ataque repartido, el tope de la invitacion si.
    for (let i = 0; i < INVITE_MAX_FAILURES; i += 1) {
      assert.equal((await unlock(inv.token, 't@gob.es', wrong, `203.0.113.${i + 1}`)).status, 403);
    }
    const late = await unlock(inv.token, 't@gob.es', inv.code, '203.0.113.200');
    assert.equal(late.status, 410);
    assert.equal(late.body.status, 'LOCKED');
    assert.ok(notices.some((n) => n.severity === 'warning' && n.label.includes('Trabajo')));
    assert.equal(await db.collection('seagle_log').countDocuments({ action: 'invitation.locked', 'detail.invitationId': inv.id }), 1);
  });

  test('el limitador por IP corta la fuerza bruta desde una sola IP', async () => {
    const inv = (await invite({ label: 'Hacienda', emails: ['h@gob.es'] })).body;
    const wrong = inv.code === '000001' ? '000002' : '000001';
    const statuses = [];
    for (let i = 0; i < 11; i += 1) statuses.push((await unlock(inv.token, 'h@gob.es', wrong, '192.0.2.50')).status);
    assert.equal(statuses.at(-1), 429);
  });

  test('todo lo anterior queda en una cadena de hashes integra y sin errores de ruta', async () => {
    const entries = await db.collection('seagle_log').find({}).sort({ seq: 1 }).toArray();
    assert.equal(verifyChain(entries).valid, true);
    const actions = new Set(entries.map((e) => e.action));
    for (const a of ['invitation.created', 'invitation.revoked', 'invitation.locked', 'inspect.denied', 'inspect.unlocked', 'inspect.document', 'inspect.logout']) {
      assert.ok(actions.has(a), a);
    }
    assert.ok(!JSON.stringify(entries).includes('"code"'));
    assert.deepEqual(routeErrors, []);
  });
});
