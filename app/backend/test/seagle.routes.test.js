/**
 * Test E2E de seagle.js (ventana de inspeccion) contra Mongo real de prueba
 * (elvira_test): mountSeagle directo sobre un Express minimo, con los datos de
 * Herzog LaW insertados a mano. Se salta si no hay MONGO_URI configurada.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MongoClient } from 'mongodb';
import express from 'express';
import { mountSeagle } from '../seagle.js';
import crypto from 'node:crypto';
import { appendChained } from '../lib/hash-chain.js';
import { createDataSeal } from '../lib/data-seal.js';

const MONGO_URI = process.env.MONGO_URI;
const skip = !MONGO_URI;

const COLLECTIONS = ['herzog_law_frameworks', 'herzog_law_zones', 'herzog_law_log', 'seagle_log'];
const MESAS_BY_ROLE = { admin: ['seagle'], gonzalo: ['herzog'] };

let client, db, server, baseUrl, role = 'admin';

const authStub = (req, res, next) => { req.user = 'test'; req.role = role; next(); };
const requireMesaStub = (mesa) => (req, res, next) => {
  if (!(MESAS_BY_ROLE[req.role] ?? []).includes(mesa)) return res.status(403).json({ error: 'Acceso denegado a esta mesa' });
  next();
};
const get = async (path) => {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.json().catch(() => null) };
};
const isoIn = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

describe('seagle.js: vista de cumplimiento sobre Herzog LaW', { skip: skip && 'MONGO_URI no configurada' }, () => {
  before(async () => {
    client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db('elvira_test');
    await Promise.all(COLLECTIONS.map((c) => db.collection(c).deleteMany({})));
    const app = express();
    mountSeagle(app, {
      auth: authStub, requireMesa: requireMesaStub, requireAdmin: (req, res, next) => next(), mongo: db,
      dataSeal: createDataSeal(crypto.randomBytes(32)), integrityTtlMs: 0,
    });
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await Promise.all(COLLECTIONS.map((c) => db.collection(c).deleteMany({})));
    await client.close();
    await new Promise((resolve) => server.close(resolve));
  });

  test('sin permiso sobre la mesa seagle: 403', async () => {
    role = 'gonzalo';
    assert.equal((await get('/api/seagle/compliance')).status, 403);
    role = 'admin';
  });

  test('sin registros: semaforo sin_datos y logs validos', async () => {
    const { status, body } = await get('/api/seagle/compliance');
    assert.equal(status, 200);
    assert.equal(body.overall.level, 'sin_datos');
    assert.equal(body.integrity.herzogLaw.valid, true);
    assert.deepEqual(body.frameworks, []);
  });

  test('calcula el semaforo con normas y zonas reales y no filtra notas internas', async () => {
    await db.collection('herzog_law_frameworks').insertMany([
      { _id: 'a', code: 'ISO 9001', title: 'Calidad', kind: 'iso', family: 'ISO', jurisdictions: ['INT'], nature: 'obligatoria', priority: 'media', status: 'vigente', tracksExpiry: true, expiresAt: isoIn(300), requirements: [{ id: 'r1', done: true }], notes: 'nota interna' },
      { _id: 'b', code: 'ATEX', title: 'ATEX', kind: 'ue', family: 'UE', jurisdictions: ['UE'], nature: 'obligatoria', priority: 'alta', status: 'no_iniciado', tracksExpiry: false, expiresAt: null, requirements: [] },
    ]);
    await db.collection('herzog_law_zones').insertOne({ _id: 'z', name: 'Silo', kind: 'polvo', zone: '21', status: 'clasificada', notes: 'zona interna' });
    const { body } = await get('/api/seagle/compliance');
    assert.equal(body.overall.level, 'rojo');
    assert.equal(body.frameworks[0].id, 'b');
    assert.equal(body.frameworks.find((f) => f.id === 'a').level, 'verde');
    assert.equal(body.zones.items[0].level, 'verde');
    const text = JSON.stringify(body);
    assert.ok(!text.includes('nota interna') && !text.includes('zona interna'));
  });

  test('el sello de integridad detecta un log de Herzog LaW alterado', async () => {
    await appendChained(db, 'herzog_law_log', { action: 'x', actorId: 'u', detail: { a: 1 } });
    await appendChained(db, 'herzog_law_log', { action: 'y', actorId: 'u', detail: { a: 2 } });
    assert.equal((await get('/api/seagle/compliance')).body.integrity.herzogLaw.valid, true);
    await db.collection('herzog_law_log').updateOne({ seq: 1 }, { $set: { 'detail.a': 99 } });
    const { body } = await get('/api/seagle/compliance');
    assert.equal(body.integrity.herzogLaw.valid, false);
    assert.equal(body.integrity.herzogLaw.brokenAtSeq, 1);
  });
});
