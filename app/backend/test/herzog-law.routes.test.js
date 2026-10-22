/**
 * Test E2E de herzog-law.js (Herzog LaW: marcos normativos, certificados, zonas
 * ATEX y CBAM) contra Mongo real de prueba (elvira_test). Mismo patron aislado
 * que herzog.routes.test.js: mountHerzogLaw directo sobre un Express minimo.
 * Se salta si no hay MONGO_URI configurada.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MongoClient } from 'mongodb';
import express from 'express';
import { mountHerzogLaw } from '../herzog-law.js';
import { FRAMEWORK_SEED, TITLE_SEED, SEED_VERSION } from '../herzog-law-data.js';
import { tenantContext } from '../db/tenant-context.js';
import { DEFAULT_TENANT_ID } from '../db/tenant-registry.js';

const MONGO_URI = process.env.MONGO_URI;
const skip = !MONGO_URI;

const COLLECTIONS = [
  'herzog_law_frameworks',
  'herzog_law_meta',
  'herzog_law_zones',
  'herzog_law_documents.files',
  'herzog_law_documents.chunks',
  'herzog_law_log',
];

let client, db, server, baseUrl;

function authAs(role, user = 'test-admin') {
  return (req, res, next) => {
    req.user = user;
    req.role = role;
    next();
  };
}

/* Mesas que tiene cada rol en esta prueba: 'gonzalo' tiene Herzog PG pero no Herzog LaW. */
const MESAS_BY_ROLE = { admin: ['herzog_law', 'herzog'], gonzalo: ['herzog'] };
const mesasRequested = new Set();

function requireMesaStub(mesa) {
  mesasRequested.add(mesa);
  return (req, res, next) => {
    if (!(MESAS_BY_ROLE[req.role] ?? []).includes(mesa)) return res.status(403).json({ error: 'Acceso denegado a esta mesa' });
    next();
  };
}

async function call(path, { method = 'GET', body, url = baseUrl } = {}) {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const isoIn = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
const logCount = (action) => db.collection('herzog_law_log').countDocuments({ action });

async function startApp({ role = 'admin', adminNotify = () => {}, database = db, tenantId } = {}) {
  const app = express();
  app.use(express.json());
  if (tenantId) app.use((req, res, next) => tenantContext.run({ tenantId }, next));
  mountHerzogLaw(app, { auth: authAs(role), requireMesa: requireMesaStub, mongo: database, adminNotify });
  const srv = app.listen(0);
  return { srv, url: `http://127.0.0.1:${srv.address().port}` };
}

const closeApp = (srv) => new Promise((resolve) => srv.close(resolve));

describe('herzog-law.js: marcos, certificados, zonas ATEX y CBAM sobre Mongo', { skip: skip && 'MONGO_URI no configurada' }, () => {
  before(async () => {
    client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db('elvira_test');
    await Promise.all(COLLECTIONS.map((c) => db.collection(c).deleteMany({})));
    // Mismo indice que crea ensureTenantIndexes: hace que escrituras simultaneas del log se reintenten.
    await db.collection('herzog_law_log').createIndex({ seq: 1 }, { unique: true });
    const started = await startApp();
    server = started.srv;
    baseUrl = started.url;
  });

  after(async () => {
    await Promise.all(COLLECTIONS.map((c) => db.collection(c).deleteMany({})));
    await client.close();
    await closeApp(server);
  });

  describe('catalogo', () => {
    test('el primer acceso, aunque sea simultaneo, siembra el catalogo una sola vez', async () => {
      const paths = ['/api/herzog-law/frameworks', '/api/herzog-law/summary', '/api/herzog-law/frameworks', '/api/herzog-law/summary', '/api/herzog-law/frameworks'];
      const responses = await Promise.all(paths.map((p) => call(p)));
      assert.ok(responses.every((r) => r.status === 200));
      assert.equal(await db.collection('herzog_law_frameworks').countDocuments({}), FRAMEWORK_SEED.length);
      assert.equal(await logCount('catalog.seed'), 1);
      assert.equal((await call('/api/herzog-law/log/verify')).body.valid, true);
    });

    test('el catalogo se devuelve ordenado por prioridad', async () => {
      const { status, body } = await call('/api/herzog-law/frameworks');
      assert.equal(status, 200);
      assert.equal(body.length, FRAMEWORK_SEED.length);
      const order = { alta: 0, media: 1, vigilar: 2 };
      for (let i = 1; i < body.length; i += 1) assert.ok(order[body[i - 1].priority] <= order[body[i].priority]);
      const atex = body.find((f) => f.id === 'atex-2014-34');
      assert.equal(atex.status, 'no_iniciado');
      assert.equal(atex.seed, true);
      assert.equal(atex.readiness.done, 0);
      assert.ok(atex.readiness.total >= 5);
      assert.deepEqual(atex.expiry, { state: 'sin_fecha', days: null });
    });

    test('la siembra no se repite ni deja entradas duplicadas en el log', async () => {
      await call('/api/herzog-law/frameworks');
      await call('/api/herzog-law/summary');
      assert.equal(await db.collection('herzog_law_frameworks').countDocuments({}), FRAMEWORK_SEED.length);
      assert.equal(await logCount('catalog.seed'), 1);
    });

    test('una nueva version del catalogo inserta lo que falta sin pisar lo editado', async () => {
      await call('/api/herzog-law/frameworks/iso-9001', { method: 'PATCH', body: { status: 'en_preparacion', owner: 'Calidad' } });
      await db.collection('herzog_law_frameworks').deleteOne({ _id: 'iso-27001' });
      await db.collection('herzog_law_meta').updateOne({ _id: 'seed' }, { $set: { version: SEED_VERSION - 1 } });

      const { body } = await call('/api/herzog-law/frameworks');
      assert.equal(body.length, FRAMEWORK_SEED.length);
      const edited = body.find((f) => f.id === 'iso-9001');
      assert.equal(edited.status, 'en_preparacion');
      assert.equal(edited.owner, 'Calidad');
      assert.ok(body.some((f) => f.id === 'iso-27001'));
    });

    test('filtra por tipo y devuelve 404 si el marco no existe', async () => {
      const iso = await call('/api/herzog-law/frameworks?kind=iso');
      assert.ok(iso.body.length > 0 && iso.body.every((f) => f.kind === 'iso'));
      assert.equal((await call('/api/herzog-law/frameworks/no-existe')).status, 404);
      assert.equal((await call('/api/herzog-law/frameworks/cbam')).status, 200);
    });
  });

  describe('edicion de un marco', () => {
    test('valida estado, fechas y textos del catalogo', async () => {
      const patch = (body) => call('/api/herzog-law/frameworks/iso-14001', { method: 'PATCH', body });
      assert.equal((await patch({ status: 'inventado' })).status, 400);
      assert.equal((await patch({ priority: 'urgente' })).status, 400);
      assert.equal((await patch({ expiresAt: '2026-02-31' })).status, 400);
      assert.equal((await patch({ issuedAt: '2026-06-01', expiresAt: '2026-05-01' })).status, 400);
      assert.equal((await patch({ title: 'Otro titulo' })).status, 400);
      assert.equal((await patch({})).status, 400);
      assert.equal((await call('/api/herzog-law/frameworks/no-existe', { method: 'PATCH', body: { status: 'vigente' } })).status, 404);
    });

    test('guarda el certificado, calcula el vencimiento y lo registra en el log', async () => {
      const before = await logCount('framework.update');
      const { status, body } = await call('/api/herzog-law/frameworks/iso-14001', {
        method: 'PATCH',
        body: { status: 'vigente', issuer: 'Entidad acreditada', certNumber: 'ES-123', issuedAt: isoIn(-300), expiresAt: isoIn(20) },
      });
      assert.equal(status, 200);
      assert.equal(body.status, 'vigente');
      assert.equal(body.certNumber, 'ES-123');
      assert.equal(body.expiry.state, 'critico');
      assert.equal(body.expiry.days, 20);
      assert.equal(await logCount('framework.update'), before + 1);
    });

    test('repetir el mismo cambio no escribe en el log', async () => {
      const before = await logCount('framework.update');
      const { status } = await call('/api/herzog-law/frameworks/iso-14001', { method: 'PATCH', body: { status: 'vigente', certNumber: 'ES-123' } });
      assert.equal(status, 200);
      assert.equal(await logCount('framework.update'), before);
    });
  });

  describe('requisitos', () => {
    test('marcar y desmarcar actualiza la preparacion', async () => {
      const on = await call('/api/herzog-law/frameworks/iso-45001/requirements/r1', { method: 'PATCH', body: { done: true } });
      assert.equal(on.status, 200);
      const r1 = on.body.requirements.find((r) => r.id === 'r1');
      assert.equal(r1.done, true);
      assert.equal(r1.doneBy, 'test-admin');
      assert.ok(r1.doneAt);
      assert.equal(on.body.readiness.done, 1);

      const off = await call('/api/herzog-law/frameworks/iso-45001/requirements/r1', { method: 'PATCH', body: { done: false } });
      assert.equal(off.body.readiness.done, 0);
      assert.equal(off.body.requirements.find((r) => r.id === 'r1').doneBy, null);
    });

    test('rechaza cuerpos invalidos y requisitos que no existen', async () => {
      assert.equal((await call('/api/herzog-law/frameworks/iso-45001/requirements/r1', { method: 'PATCH', body: { done: 'si' } })).status, 400);
      assert.equal((await call('/api/herzog-law/frameworks/iso-45001/requirements/zz', { method: 'PATCH', body: { done: true } })).status, 404);
    });

    test('un requisito propio se anade y se borra; los del catalogo no se borran', async () => {
      const added = await call('/api/herzog-law/frameworks/iso-45001/requirements', { method: 'POST', body: { text: 'Revisar extintores' } });
      assert.equal(added.status, 201);
      const own = added.body.requirements.find((r) => r.custom);
      assert.equal(own.text, 'Revisar extintores');

      assert.equal((await call('/api/herzog-law/frameworks/iso-45001/requirements', { method: 'POST', body: { text: '  ' } })).status, 400);
      assert.equal((await call('/api/herzog-law/frameworks/iso-45001/requirements/r2', { method: 'DELETE' })).status, 409);

      const removed = await call(`/api/herzog-law/frameworks/iso-45001/requirements/${own.id}`, { method: 'DELETE' });
      assert.equal(removed.status, 200);
      assert.ok(!removed.body.requirements.some((r) => r.custom));
    });

    test('hay un tope de requisitos por marco', async () => {
      const created = await call('/api/herzog-law/frameworks', { method: 'POST', body: { code: 'TOPE', title: 'Marco de tope' } });
      const id = created.body.id;
      const total = (await call(`/api/herzog-law/frameworks/${id}`)).body.requirements.length;
      for (let i = total; i < 40; i += 1) {
        const r = await call(`/api/herzog-law/frameworks/${id}/requirements`, { method: 'POST', body: { text: `Requisito ${i}` } });
        assert.equal(r.status, 201);
      }
      const over = await call(`/api/herzog-law/frameworks/${id}/requirements`, { method: 'POST', body: { text: 'Uno de mas' } });
      assert.equal(over.status, 400);
      await call(`/api/herzog-law/frameworks/${id}`, { method: 'DELETE' });
    });
  });

  describe('marcos propios (por ejemplo, titulos del Estado)', () => {
    test('crear, editar y borrar', async () => {
      assert.equal((await call('/api/herzog-law/frameworks', { method: 'POST', body: { title: 'Sin codigo' } })).status, 400);
      assert.equal((await call('/api/herzog-law/frameworks', { method: 'POST', body: { code: 'X', title: 'X', kind: 'raro' } })).status, 400);
      assert.equal((await call('/api/herzog-law/frameworks', { method: 'POST', body: { code: 'X', title: 'X', jurisdictions: ['ZZ'] } })).status, 400);

      const created = await call('/api/herzog-law/frameworks', {
        method: 'POST',
        body: { code: 'Título 1', title: 'Título concedido por el Estado', kind: 'titulo', jurisdictions: ['ES', 'ES'], requirements: ['Guardar copia del título'] },
      });
      assert.equal(created.status, 201);
      assert.equal(created.body.seed, false);
      assert.equal(created.body.family, 'Títulos del Estado');
      assert.deepEqual(created.body.jurisdictions, ['ES']);
      assert.equal(created.body.requirements[0].custom, true);

      const edited = await call(`/api/herzog-law/frameworks/${created.body.id}`, { method: 'PATCH', body: { title: 'Título renombrado', status: 'vigente' } });
      assert.equal(edited.status, 200);
      assert.equal(edited.body.title, 'Título renombrado');

      const removed = await call(`/api/herzog-law/frameworks/${created.body.id}`, { method: 'DELETE' });
      assert.equal(removed.status, 200);
      assert.equal((await call(`/api/herzog-law/frameworks/${created.body.id}`)).status, 404);
    });

    test('un marco del catalogo no se borra', async () => {
      assert.equal((await call('/api/herzog-law/frameworks/cbam', { method: 'DELETE' })).status, 409);
    });
  });

  describe('documentos', () => {
    const upload = (frameworkId, { type = 'application/pdf', name = 'certificado.pdf', body = Buffer.from('%PDF-1.4 prueba') } = {}) =>
      fetch(`${baseUrl}/api/herzog-law/documents`, {
        method: 'POST',
        headers: { 'Content-Type': type, 'X-Filename': encodeURIComponent(name), ...(frameworkId ? { 'X-Framework': frameworkId } : {}) },
        body,
      });

    test('subir, listar por marco, descargar y borrar', async () => {
      const res = await upload('iso-9001', { name: 'certificado ñ.pdf' });
      assert.equal(res.status, 201);
      const uploaded = await res.json();
      assert.equal(uploaded.filename, 'certificado ñ.pdf');
      assert.equal(uploaded.frameworkId, 'iso-9001');

      const list = await call('/api/herzog-law/documents?frameworkId=iso-9001');
      assert.ok(list.body.some((d) => d.id === uploaded.id));
      assert.equal((await call('/api/herzog-law/documents?frameworkId=cbam')).body.length, 0);

      const download = await fetch(`${baseUrl}/api/herzog-law/documents/${uploaded.id}`);
      assert.equal(download.status, 200);
      assert.equal(download.headers.get('content-type'), 'application/pdf');
      assert.equal(download.headers.get('x-content-type-options'), 'nosniff');

      assert.equal((await fetch(`${baseUrl}/api/herzog-law/documents/${uploaded.id}`, { method: 'DELETE' })).status, 200);
      assert.equal((await fetch(`${baseUrl}/api/herzog-law/documents/${uploaded.id}`)).status, 404);
    });

    test('valida formato, marco y id', async () => {
      assert.equal((await upload('iso-9001', { type: 'application/zip', name: 'x.zip' })).status, 415);
      assert.equal((await upload(null)).status, 400);
      assert.equal((await upload('no-existe')).status, 404);
      assert.equal((await fetch(`${baseUrl}/api/herzog-law/documents/no-es-un-id`)).status, 400);
    });

    test('borrar un marco propio borra tambien sus documentos', async () => {
      const created = await call('/api/herzog-law/frameworks', { method: 'POST', body: { code: 'DOC', title: 'Marco con documento' } });
      const res = await upload(created.body.id);
      assert.equal(res.status, 201);
      await call(`/api/herzog-law/frameworks/${created.body.id}`, { method: 'DELETE' });
      assert.equal(await db.collection('herzog_law_documents.files').countDocuments({ 'metadata.framework_id': created.body.id }), 0);
    });
  });

  describe('zonas ATEX', () => {
    test('una zona nueva queda pendiente y sin categoria', async () => {
      const { status, body } = await call('/api/herzog-law/zones', { method: 'POST', body: { name: 'Nave de molienda' } });
      assert.equal(status, 201);
      assert.equal(body.kind, 'polvo');
      assert.equal(body.zone, 'sin_clasificar');
      assert.equal(body.status, 'pendiente');
      assert.equal(body.requiredCategory, null);
    });

    test('clasificar una zona asigna su categoria y la deja clasificada', async () => {
      const created = await call('/api/herzog-law/zones', { method: 'POST', body: { name: 'Interior del BioGrinder', zone: '21', substance: 'Polvo de biomasa seca' } });
      assert.equal(created.status, 201);
      assert.equal(created.body.requiredCategory, '2D');
      assert.equal(created.body.status, 'clasificada');

      const patched = await call(`/api/herzog-law/zones/${created.body.id}`, { method: 'PATCH', body: { zone: '22', status: 'protegida' } });
      assert.equal(patched.body.requiredCategory, '3D');
      assert.equal(patched.body.status, 'protegida');

      const unclassified = await call(`/api/herzog-law/zones/${created.body.id}`, { method: 'PATCH', body: { zone: 'sin_clasificar' } });
      assert.equal(unclassified.body.status, 'pendiente');
      assert.equal(unclassified.body.requiredCategory, null);
    });

    test('rechaza combinaciones incoherentes', async () => {
      const post = (body) => call('/api/herzog-law/zones', { method: 'POST', body });
      assert.equal((await post({})).status, 400);
      assert.equal((await post({ name: 'A', kind: 'polvo', zone: '1' })).status, 400);
      assert.equal((await post({ name: 'A', kind: 'gas', zone: '21' })).status, 400);
      assert.equal((await post({ name: 'A', kind: 'liquido' })).status, 400);
      assert.equal((await post({ name: 'A', zone: '20', status: 'pendiente' })).status, 400);
      assert.equal((await post({ name: 'A', status: 'protegida' })).status, 400);
    });

    test('lista, borra y publica la referencia de zonas', async () => {
      const list = await call('/api/herzog-law/zones');
      assert.ok(list.body.length >= 2);
      const victim = list.body[0];
      assert.equal((await call(`/api/herzog-law/zones/${victim.id}`, { method: 'DELETE' })).status, 200);
      assert.equal((await call(`/api/herzog-law/zones/${victim.id}`, { method: 'DELETE' })).status, 404);
      assert.equal((await call('/api/herzog-law/zones/no-existe', { method: 'PATCH', body: { name: 'x' } })).status, 404);

      const ref = await call('/api/herzog-law/zones/reference');
      assert.deepEqual(ref.body.polvo.map((z) => [z.zone, z.category]), [['20', '1D'], ['21', '2D'], ['22', '3D']]);
      assert.deepEqual(ref.body.gas.map((z) => [z.zone, z.category]), [['0', '1G'], ['1', '2G'], ['2', '3G']]);
    });
  });

  describe('CBAM', () => {
    test('publica la referencia', async () => {
      const { status, body } = await call('/api/herzog-law/cbam/reference');
      assert.equal(status, 200);
      assert.equal(body.thresholdTonnes, 50);
      assert.equal(body.sectors.length, 6);
      assert.deepEqual(body.factorByYear.map((f) => f.pct), [2.5, 5, 10, 22.5, 48.5, 61, 73.5, 86, 100]);
    });

    test('estima el coste y valida la entrada', async () => {
      const ok = await call('/api/herzog-law/cbam/estimate', {
        method: 'POST',
        body: { tonnes: 1000, embeddedPerTonne: 2, freeAllocationPerTonne: 0.5, certificatePrice: 80, fuelSharePct: 40, substitutionPct: 50 },
      });
      assert.equal(ok.status, 200);
      assert.equal(ok.body.baseline.cost, 120000);
      assert.equal(ok.body.withBiomass.cost, 88000);
      assert.equal(ok.body.saving, 32000);

      assert.equal((await call('/api/herzog-law/cbam/estimate', { method: 'POST', body: { tonnes: 10 } })).status, 400);
      assert.equal((await call('/api/herzog-law/cbam/estimate', { method: 'POST', body: { tonnes: -5, embeddedPerTonne: 1, certificatePrice: 10 } })).status, 400);
    });
  });

  describe('resumen, actividad e integridad', () => {
    test('el resumen agrega marcos, vencimientos, zonas y documentos', async () => {
      const { status, body } = await call('/api/herzog-law/summary');
      assert.equal(status, 200);
      assert.ok(body.frameworksCount >= FRAMEWORK_SEED.length);
      assert.ok(body.byStatus.vigente >= 1);
      assert.ok(body.highPriority.frameworks >= 5);
      assert.ok(body.highPriority.readiness.total > 0);
      const upcoming = body.upcoming.find((u) => u.id === 'iso-14001');
      assert.equal(upcoming.state, 'critico');
      assert.equal(upcoming.days, 20);
      assert.ok(body.zones.total >= 1);
      assert.equal(typeof body.documentsCount, 'number');
    });

    test('la actividad devuelve las entradas mas recientes primero', async () => {
      const { status, body } = await call('/api/herzog-law/activity?limit=5');
      assert.equal(status, 200);
      assert.equal(body.length, 5);
      for (let i = 1; i < body.length; i += 1) assert.ok(body[i - 1].seq > body[i].seq);
      assert.ok(body[0].action && body[0].actorId);
    });

    test('la cadena de hashes de herzog_law_log es integra', async () => {
      const { status, body } = await call('/api/herzog-law/log/verify');
      assert.equal(status, 200);
      assert.equal(body.valid, true);
      assert.ok(body.totalEntries > 10);
    });
  });

  describe('avisos de vencimiento', () => {
    test('avisa una vez por cada empeoramiento y se reinicia al cambiar la fecha', async () => {
      const notices = [];
      const frameworks = db.collection('herzog_law_frameworks');
      // Solo debe contar el marco de este test: el resto deja de estar vigente.
      await frameworks.updateMany({}, { $set: { status: 'no_aplica' } });
      await frameworks.deleteMany({ _id: 'aviso-prueba' });
      await frameworks.insertOne({
        _id: 'aviso-prueba', code: 'AVISO', title: 'Marco de aviso', status: 'vigente', expiresAt: isoIn(60), requirements: [], alert: null,
      });
      const waitFor = async (check) => {
        for (let i = 0; i < 50; i += 1) {
          if (await check()) return;
          await new Promise((r) => setTimeout(r, 40));
        }
        assert.fail('el aviso no llego a tiempo');
      };

      const first = await startApp({ adminNotify: (n) => notices.push(n) });
      await waitFor(() => notices.length === 1);
      assert.equal(notices[0].origin, 'HERZOG');
      assert.equal(notices[0].severity, 'warning');
      assert.match(notices[0].label, /AVISO vence en 60 días/);
      assert.equal((await frameworks.findOne({ _id: 'aviso-prueba' })).alert.level, 'proximo');
      await closeApp(first.srv);

      // Mismo nivel: no vuelve a avisar.
      const second = await startApp({ adminNotify: (n) => notices.push(n) });
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(notices.length, 1);
      await closeApp(second.srv);

      // Empeora a vencido: avisa de nuevo.
      await frameworks.updateOne({ _id: 'aviso-prueba' }, { $set: { expiresAt: isoIn(-3) } });
      const third = await startApp({ adminNotify: (n) => notices.push(n) });
      await waitFor(() => notices.length === 2);
      assert.match(notices[1].label, /venció hace 3 días/);
      await closeApp(third.srv);

      // Cambiar la fecha por la API reinicia el aviso.
      const fourth = await startApp();
      const patched = await call('/api/herzog-law/frameworks/aviso-prueba', { method: 'PATCH', body: { expiresAt: isoIn(200) }, url: fourth.url });
      assert.equal(patched.status, 200);
      assert.equal((await frameworks.findOne({ _id: 'aviso-prueba' })).alert, null);
      await closeApp(fourth.srv);
      await frameworks.deleteOne({ _id: 'aviso-prueba' });
    });
  });

  test('todas las rutas piden solo la mesa herzog_law', () => {
    assert.deepEqual([...mesasRequested], ['herzog_law']);
  });

  test('tener Herzog PG no da acceso a Herzog LaW (403)', async () => {
    const { srv, url } = await startApp({ role: 'gonzalo' });
    for (const path of ['/api/herzog-law/frameworks', '/api/herzog-law/summary', '/api/herzog-law/zones', '/api/herzog-law/cbam/reference']) {
      assert.equal((await call(path, { url })).status, 403, path);
    }
    assert.equal((await call('/api/herzog-law/cbam/estimate', { method: 'POST', body: {}, url })).status, 403);
    await closeApp(srv);
  });
});

describe('herzog-law.js: titulos del Estado de S-NFI', { skip: skip && 'MONGO_URI no configurada' }, () => {
  let titlesClient, ownDb, otherDb;
  const DBS = ['elvira_test_law_titles_own', 'elvira_test_law_titles_other'];

  before(async () => {
    titlesClient = new MongoClient(MONGO_URI);
    await titlesClient.connect();
    await Promise.all(DBS.map((name) => titlesClient.db(name).dropDatabase()));
    ownDb = titlesClient.db(DBS[0]);
    otherDb = titlesClient.db(DBS[1]);
  });

  after(async () => {
    await Promise.all(DBS.map((name) => titlesClient.db(name).dropDatabase()));
    await titlesClient.close();
  });

  const titlesOf = (list) => list.filter((f) => f.kind === 'titulo');

  test('el tenant por defecto recibe los tres titulos, una sola vez aunque lleguen peticiones a la vez', async () => {
    const { srv, url } = await startApp({ database: ownDb, tenantId: DEFAULT_TENANT_ID });
    const responses = await Promise.all([1, 2, 3, 4].map(() => call('/api/herzog-law/frameworks', { url })));
    assert.ok(responses.every((r) => r.status === 200));

    const list = responses[0].body;
    assert.equal(list.length, FRAMEWORK_SEED.length + TITLE_SEED.length);
    const titles = titlesOf(list);
    assert.deepEqual(titles.map((t) => t.id).sort(), TITLE_SEED.map((t) => t.id).sort());
    for (const t of titles) {
      assert.equal(t.status, 'vigente');
      assert.equal(t.seed, false);
      assert.equal(t.family, 'Títulos del Estado');
      assert.ok(t.requirements.length > 0 && t.requirements.every((r) => r.custom));
      assert.ok(t.issuer);
    }
    assert.equal(titles.find((t) => t.id === 'titulo-pyme-innovadora').tracksExpiry, true);
    assert.equal(titles.find((t) => t.id === 'titulo-modelo-utilidad').tracksExpiry, true);
    assert.equal(titles.find((t) => t.id === 'titulo-camara-espana-emprende').tracksExpiry, false);

    const seeds = await ownDb.collection('herzog_law_log').find({ action: 'catalog.seed' }).toArray();
    assert.equal(seeds.length, 1);
    assert.deepEqual([seeds[0].detail.inserted, seeds[0].detail.titles], [FRAMEWORK_SEED.length, TITLE_SEED.length]);
    assert.equal((await call('/api/herzog-law/log/verify', { url })).body.valid, true);
    await closeApp(srv);
  });

  test('un titulo borrado no vuelve, ni siquiera con una version nueva del catalogo', async () => {
    const { srv, url } = await startApp({ database: ownDb, tenantId: DEFAULT_TENANT_ID });
    const del = await call('/api/herzog-law/frameworks/titulo-camara-espana-emprende', { method: 'DELETE', url });
    assert.equal(del.status, 200);

    await ownDb.collection('herzog_law_meta').updateOne({ _id: 'seed' }, { $set: { version: SEED_VERSION - 1 } });
    const list = (await call('/api/herzog-law/frameworks', { url })).body;
    assert.equal(titlesOf(list).length, TITLE_SEED.length - 1);
    assert.ok(!list.some((f) => f.id === 'titulo-camara-espana-emprende'));
    await closeApp(srv);
  });

  test('un titulo se edita y sus requisitos se pueden quitar', async () => {
    const { srv, url } = await startApp({ database: ownDb, tenantId: DEFAULT_TENANT_ID });
    const patched = await call('/api/herzog-law/frameworks/titulo-pyme-innovadora', {
      method: 'PATCH',
      body: { certNumber: 'PI-0001', issuedAt: '2025-03-01', expiresAt: '2028-03-01', title: 'Sello PYME Innovadora (renombrado)' },
      url,
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.certNumber, 'PI-0001');
    assert.equal(patched.body.title, 'Sello PYME Innovadora (renombrado)');

    const removed = await call('/api/herzog-law/frameworks/titulo-pyme-innovadora/requirements/c1', { method: 'DELETE', url });
    assert.equal(removed.status, 200);
    assert.ok(!removed.body.requirements.some((r) => r.id === 'c1'));
    await closeApp(srv);
  });

  test('otro tenant recibe el catalogo pero no los titulos de S-NFI', async () => {
    const { srv, url } = await startApp({ database: otherDb, tenantId: 'otro-tenant' });
    const list = (await call('/api/herzog-law/frameworks', { url })).body;
    assert.equal(list.length, FRAMEWORK_SEED.length);
    assert.equal(titlesOf(list).length, 0);
    await closeApp(srv);
  });
});
