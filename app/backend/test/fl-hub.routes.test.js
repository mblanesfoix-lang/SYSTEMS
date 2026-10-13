/**
 * Test E2E del Hub fiscal y legal de F&L (fl-hub.js) contra Mongo real de
 * prueba. Mismo patron que resilience.routes.test.js: Express minimo con
 * mountFlHub directo y auth/requireMesa como stubs. Db propia
 * (elvira_test_flhub) porque los ficheros de test corren en paralelo. Sin red:
 * autoSync desactivado. Fecha fija (12 de octubre de 2026) para que los
 * plazos derivados sean deterministas. Se salta sin MONGO_URI.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { MongoClient } from 'mongodb';
import express from 'express';
import { mountFlHub, canonicalV2 } from '../fl-hub.js';

const MONGO_URI = process.env.MONGO_URI;
const NOW = new Date('2026-10-12T10:00:00Z');

let client;
let db;
let server;
let baseUrl;
let hub;
const notifications = [];
const busEvents = [];

function authStub(req, res, next) {
  req.user = req.get('x-test-user') || 'test-admin';
  req.role = req.get('x-test-role') || 'admin';
  next();
}

function requireMesaStub() {
  return (req, res, next) => (req.role === 'admin' ? next() : res.status(403).json({ error: 'Acceso denegado a esta mesa' }));
}

async function call(path, { method = 'GET', body, role } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(role ? { 'x-test-role': role } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = res.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, body: data, type };
}

/* Entrada heredada (sin canon), escrita igual que fl-expediente.js. */
async function appendLegacy(entry) {
  const col = db.collection('fl_log');
  const tail = await col.find().sort({ seq: -1 }).limit(1).next();
  const seq = tail ? tail.seq + 1 : 1;
  const prevHash = tail ? tail.hash : '0'.repeat(64);
  const body = { ...entry, seq };
  const hash = crypto.createHash('sha256').update(prevHash + JSON.stringify(body, Object.keys(body).sort())).digest('hex');
  await col.insertOne({ _id: crypto.randomUUID(), ...entry, seq, prevHash, hash, createdAt: new Date().toISOString() });
}

describe('fl-hub.js: Hub fiscal y legal sobre Mongo', { skip: !MONGO_URI && 'MONGO_URI no configurada' }, () => {
  before(async () => {
    client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db('elvira_test_flhub');
    await db.dropDatabase();
    await db.collection('fl_log').createIndex({ seq: 1 }, { unique: true });

    const app = express();
    app.use(express.json());
    hub = mountFlHub(app, {
      auth: authStub,
      requireMesa: requireMesaStub,
      mongo: db,
      busEmit: (e) => busEvents.push(e),
      adminNotify: (n) => notifications.push(n),
      autoSync: false,
      now: () => NOW,
    });
    await hub.ready;
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await db.dropDatabase();
    await client.close();
  });

  beforeEach(() => {
    notifications.length = 0;
    busEvents.length = 0;
  });

  test('GET /api/fl/hub: demostracion sembrada, KPIs, calendario y metadatos', async () => {
    const { status, body } = await call('/api/fl/hub');
    assert.equal(status, 200);
    assert.equal(body.hoy, '2026-10-12');
    assert.equal(body.sociedades.length, 4);
    assert.equal(body.modelos.length, 48);
    assert.equal(body.notificaciones.length, 9);
    assert.equal(body.contratos.length, 10);
    assert.ok(body.demo.registros > 0);
    assert.ok(body.sociedades.every((s) => s.placeholder === true && /^B00/.test(s.nif)));

    assert.equal(body.kpis.notificaciones.sin_acuse, 3);
    assert.equal(body.kpis.notificaciones.proximo_vencimiento.dias, 2);
    assert.equal(body.kpis.fiscal.proximo.fecha_limite, '2026-10-20');
    assert.ok(body.kpis.fiscal.cumplimiento_pct > 90 && body.kpis.fiscal.cumplimiento_pct < 100);
    assert.equal(body.kpis.renovaciones.total, 5);
    assert.equal(body.kpis.societario.depositos_vencidos, 1);

    assert.ok(body.calendario.some((e) => e.tipo === 'fiscal' && e.fecha === '2026-10-20'));
    assert.equal(body.conectores.dehu.estado, 'no_configurado');
    assert.equal(body.conectores.boletines.estado, 'pendiente');
    assert.deepEqual(Object.keys(body.meta.esquemas), ['sociedades', 'modelos', 'notificaciones', 'juntas', 'apoderamientos', 'contratos', 'checklist']);
    assert.ok(body.meta.normas.some((n) => n.id === 'BOE-A-2015-10565' && n.articulos.some((a) => a.url.endsWith('#a43'))));

    const critica = body.notificaciones.find((n) => n.calc.urgencia === 'critica');
    assert.equal(critica.calc.dias_acceso, 2);
    assert.equal(critica.calc.fecha_rechazo_presunto, '2026-10-14');
  });

  test('el seed es idempotente: un segundo montaje no duplica', async () => {
    const app2 = express();
    const hub2 = mountFlHub(app2, { auth: authStub, requireMesa: requireMesaStub, mongo: db, autoSync: false, now: () => NOW });
    await hub2.ready;
    assert.equal(await db.collection('fl_sociedades').countDocuments({}), 4);
    assert.equal(await db.collection('fl_log').countDocuments({ action: 'hub.seed' }), 1);
  });

  test('portal restringido (CBAM): solo lo reciben los usuarios autorizados', async () => {
    const ver = async (user) => {
      const res = await fetch(`${baseUrl}/api/fl/hub`, { headers: { 'x-test-user': user } });
      return (await res.json()).meta.portales;
    };
    const marc = await ver('mblanes@s-nficorp.com');
    assert.ok(marc.some((p) => p.key === 'cbam'));
    assert.ok(marc.every((p) => !('soloUsuarios' in p)), 'la lista de autorizados no sale al cliente');
    assert.ok((await ver('nzaroual@s-nfi.com')).some((p) => p.key === 'cbam'));
    const otro = await ver('gonzalosb@s-nficorp.com');
    assert.ok(!otro.some((p) => p.key === 'cbam'));
    assert.ok(otro.some((p) => p.key === 'csv_abogacia'));
  });

  test('guard de mesa: un rol sin acceso recibe 403', async () => {
    const { status } = await call('/api/fl/hub', { role: 'ray' });
    assert.equal(status, 403);
  });

  test('POST valida contra el esquema y la sociedad referenciada', async () => {
    const vacio = await call('/api/fl/modelos', { method: 'POST', body: {} });
    assert.equal(vacio.status, 400);
    assert.ok(vacio.body.errors.some((e) => e.startsWith('Sociedad')));

    const malaFecha = await call('/api/fl/modelos', {
      method: 'POST',
      body: { sociedad_id: 'x', modelo: '303', concepto: 'IVA', periodo: '4T', ejercicio: 2026, fecha_limite: '2027-02-30' },
    });
    assert.equal(malaFecha.status, 400);
    assert.ok(malaFecha.body.errors.some((e) => e.startsWith('Fecha límite')));

    const sinSociedad = await call('/api/fl/modelos', {
      method: 'POST',
      body: { sociedad_id: 'no-existe', modelo: '303', concepto: 'IVA', periodo: '4T', ejercicio: 2026, fecha_limite: '2027-02-01' },
    });
    assert.equal(sinSociedad.status, 400);
  });

  test('alta, cambio de estado e historial de un modelo real', async () => {
    const { body: hubData } = await call('/api/fl/hub');
    const sociedad = hubData.sociedades.find((s) => s.rol === 'spv');

    const alta = await call('/api/fl/modelos', {
      method: 'POST',
      body: { sociedad_id: sociedad.id, administracion: 'AEAT', modelo: '232', concepto: 'Operaciones vinculadas', periodo: 'Anual', ejercicio: 2025, fecha_limite: '2026-11-30', importe_cents: '0' },
    });
    assert.equal(alta.status, 201);
    assert.equal(alta.body.placeholder, false);
    assert.equal(alta.body.estado, 'pendiente');
    assert.equal(alta.body.calc.dias, 49);

    const liquidar = await call(`/api/fl/modelos/${alta.body.id}`, { method: 'PATCH', body: { estado: 'liquidado', justificante: 'NRC-TEST' } });
    assert.equal(liquidar.status, 200);
    assert.equal(liquidar.body.estado, 'liquidado');
    assert.equal(liquidar.body.presentado_at, '2026-10-12');

    const malPatch = await call(`/api/fl/modelos/${alta.body.id}`, { method: 'PATCH', body: { estado: 'presentado' } });
    assert.equal(malPatch.status, 400);

    const hist = await call(`/api/fl/historial/modelos/${alta.body.id}`);
    assert.equal(hist.status, 200);
    assert.deepEqual(hist.body.map((h) => h.action), ['modelos.update', 'modelos.create']);
    assert.ok(hist.body[0].detail.cambios.includes('estado'));
  });

  test('acuse de una notificacion: declaracion obligatoria, fechas y plazo de respuesta', async () => {
    const { body } = await call('/api/fl/hub');
    const n = body.notificaciones.find((x) => x.calc.urgencia === 'critica');

    assert.equal((await call(`/api/fl/notificaciones/${n.id}/acuse`, { method: 'POST', body: {} })).status, 400);
    const antes = await call(`/api/fl/notificaciones/${n.id}/acuse`, { method: 'POST', body: { declaracion: true, fecha: '2026-09-01' } });
    assert.equal(antes.status, 400);
    const futuro = await call(`/api/fl/notificaciones/${n.id}/acuse`, { method: 'POST', body: { declaracion: true, fecha: '2026-10-13' } });
    assert.equal(futuro.status, 400);

    const ok = await call(`/api/fl/notificaciones/${n.id}/acuse`, { method: 'POST', body: { declaracion: true } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.acuse.fecha, '2026-10-12');
    assert.equal(ok.body.acuse.registrado_por, 'test-admin');
    // Lunes 12 + 10 dias habiles = lunes 26 (festivos no modelados).
    assert.equal(ok.body.fecha_limite_respuesta, '2026-10-26');
    assert.equal(ok.body.calc.dias_acceso, null);
    assert.equal(ok.body.calc.dias_respuesta, 14);

    assert.equal((await call(`/api/fl/notificaciones/${n.id}/acuse`, { method: 'POST', body: { declaracion: true } })).status, 409);
  });

  test('flujo de estados de una notificacion con transiciones validadas', async () => {
    const { body } = await call('/api/fl/hub');
    const n = body.notificaciones.find((x) => x.acuse && x.estado === 'pendiente');

    assert.equal((await call(`/api/fl/notificaciones/${n.id}/estado`, { method: 'POST', body: { estado: 'respondida' } })).status, 409);
    assert.equal((await call(`/api/fl/notificaciones/${n.id}/estado`, { method: 'POST', body: { estado: 'asignada' } })).status, 400);

    const asignada = await call(`/api/fl/notificaciones/${n.id}/estado`, { method: 'POST', body: { estado: 'asignada', abogado_asignado: 'Dirección Jurídica' } });
    assert.equal(asignada.status, 200);
    assert.equal(asignada.body.abogado_asignado, 'Dirección Jurídica');

    const respondida = await call(`/api/fl/notificaciones/${n.id}/estado`, {
      method: 'POST', body: { estado: 'respondida', respuesta: { fecha: '2026-10-12', referencia: 'RGE-TEST-1', nota: 'Alegaciones presentadas' } },
    });
    assert.equal(respondida.status, 200);
    assert.equal(respondida.body.respuesta.referencia, 'RGE-TEST-1');
    assert.equal(respondida.body.calc.urgencia, 'cerrada');

    assert.equal((await call(`/api/fl/notificaciones/${n.id}/estado`, { method: 'POST', body: { estado: 'asignada' } })).status, 409);
  });

  test('archivar es soft-delete y una sociedad con registros activos no se archiva', async () => {
    const { body } = await call('/api/fl/hub');
    const contrato = body.contratos[0];
    const r = await call(`/api/fl/contratos/${contrato.id}`, { method: 'DELETE' });
    assert.equal(r.status, 200);
    const raw = await db.collection('fl_clm_contratos').findOne({ _id: contrato.id });
    assert.equal(raw.deleted, true);
    assert.equal(raw.deletedBy, 'test-admin');
    const despues = await call('/api/fl/hub');
    assert.ok(!despues.body.contratos.some((c) => c.id === contrato.id));
    assert.equal((await call(`/api/fl/contratos/${contrato.id}`, { method: 'DELETE' })).status, 404);

    const soc = await call(`/api/fl/sociedades/${body.sociedades[0].id}`, { method: 'DELETE' });
    assert.equal(soc.status, 409);
  });

  test('confirmar un registro de demostracion lo convierte en dato real una sola vez', async () => {
    const { body } = await call('/api/fl/hub');
    const sociedad = body.sociedades.find((s) => s.rol === 'holding');
    const r = await call(`/api/fl/sociedades/${sociedad.id}/confirmar`, { method: 'POST', body: {} });
    assert.equal(r.status, 200);
    assert.equal(r.body.placeholder, false);
    assert.equal((await call(`/api/fl/sociedades/${sociedad.id}/confirmar`, { method: 'POST', body: {} })).status, 409);
  });

  test('alertas normativas: revision y validacion de estado', async () => {
    await db.collection('fl_alertas_normativas').insertOne({
      _id: 'BOE-A-2026-9999', fuente: 'BOE', fecha_publicacion: '2026-10-09', seccion: '1', titulo: 'Real Decreto de prueba sobre residuos',
      categorias: ['residuos'], puntuacion: 7, relevancia: 'alta', estado: 'nueva', sociedad_id: null,
    });
    const { body } = await call('/api/fl/hub');
    assert.equal(body.kpis.boletines.nuevas_7d, 1);
    assert.equal((await call('/api/fl/alertas/BOE-A-2026-9999', { method: 'PATCH', body: { estado: 'leida' } })).status, 400);
    const r = await call('/api/fl/alertas/BOE-A-2026-9999', { method: 'PATCH', body: { estado: 'revisada' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.revisada_por, 'test-admin');
    assert.equal((await call('/api/fl/alertas/no-existe', { method: 'PATCH', body: { estado: 'revisada' } })).status, 404);
  });

  test('ficha PDF: descarga registrada en fl_log y marcada como demostracion', async () => {
    const { body } = await call('/api/fl/hub');
    const m = body.modelos[0];
    const r = await call(`/api/fl/modelos/${m.id}/pdf`);
    assert.equal(r.status, 200);
    assert.match(r.type, /application\/pdf/);
    assert.equal(r.body.subarray(0, 5).toString(), '%PDF-');
    const entry = await db.collection('fl_log').findOne({ action: 'pdf.download', refId: m.id });
    assert.equal(entry.actorId, 'test-admin');
    assert.equal(entry.canon, 2);
  });

  test('cadena fl_log: mezcla entradas heredadas y canon 2, y detecta manipulaciones en detail', async () => {
    await appendLegacy({ action: 'expediente.doc.create', actorId: 'legacy-user', detail: { docId: 'd1' } });
    await call('/api/fl/demo/retirar', { method: 'POST', body: {} }); // 400, no escribe
    const { body: hubData } = await call('/api/fl/hub');
    await call(`/api/fl/checklist/${hubData.checklist[2].id}`, { method: 'PATCH', body: { estado: 'completado' } });

    const ok = await call('/api/fl/log/verify');
    assert.equal(ok.status, 200);
    assert.equal(ok.body.valid, true);

    const victima = await db.collection('fl_log').findOne({ action: 'checklist.update' });
    assert.ok(canonicalV2({ b: 1, a: { d: 2, c: [1, { f: 3, e: 4 }] } }) === '{"a":{"c":[1,{"e":4,"f":3}],"d":2},"b":1}');
    await db.collection('fl_log').updateOne({ _id: victima._id }, { $set: { 'detail.estado': 'pendiente' } });
    const roto = await call('/api/fl/log/verify');
    assert.equal(roto.body.valid, false);
    assert.equal(roto.body.brokenAtSeq, victima.seq);
    await db.collection('fl_log').updateOne({ _id: victima._id }, { $set: { 'detail.estado': 'completado' } });
    assert.equal((await call('/api/fl/log/verify')).body.valid, true);
  });

  test('alarmas: los datos de demostracion no avisan; una notificacion real sin abrir si, una vez', async () => {
    await hub.revisarAlarmas();
    assert.equal(notifications.length, 0);

    const { body } = await call('/api/fl/hub');
    const alta = await call('/api/fl/notificaciones', {
      method: 'POST',
      body: {
        sociedad_id: body.sociedades[0].id, emisor: 'Agencia Estatal de Administración Tributaria', emisor_siglas: 'AEAT', canal: 'dehu',
        tipo: 'requerimiento', expediente: 'REAL-TEST-1', asunto: 'Requerimiento de prueba', puesta_disposicion: '2026-10-03', plazo_respuesta: 10,
      },
    });
    assert.equal(alta.status, 201);
    assert.equal(alta.body.estado, 'pendiente');
    assert.equal(alta.body.calc.dias_acceso, 1);

    await hub.revisarAlarmas();
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].origin, 'FL');
    assert.equal(notifications[0].severity, 'error');
    assert.equal(busEvents.length, 1);

    await hub.revisarAlarmas();
    assert.equal(notifications.length, 1, 'el aviso no se repite');
  });

  test('retirar la demostracion archiva solo los placeholders, con confirmacion expresa', async () => {
    assert.equal((await call('/api/fl/demo/retirar', { method: 'POST', body: { confirmar: 'si' } })).status, 400);
    const r = await call('/api/fl/demo/retirar', { method: 'POST', body: { confirmar: true } });
    assert.equal(r.status, 200);
    assert.ok(r.body.archivados.modelos > 0);

    const { body } = await call('/api/fl/hub');
    assert.equal(body.demo.registros, 0);
    assert.ok(body.modelos.length >= 1 && body.modelos.every((m) => m.placeholder === false));
    assert.ok(body.sociedades.some((s) => s.rol === 'holding'), 'la sociedad confirmada como real se conserva');
    const summary = await call('/api/fl/summary');
    assert.equal(summary.status, 200);
    assert.equal(summary.body.hoy, '2026-10-12');
  });
});
