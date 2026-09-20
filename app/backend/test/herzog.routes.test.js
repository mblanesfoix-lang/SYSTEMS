/**
 * Test E2E de herzog.js (Herzog Central / bunker receptor SYSTEMS) contra
 * Mongo real de prueba (elvira_test). Mismo patron aislado que
 * resilience.routes.test.js: mountHerzog directo sobre Express minimo, sin
 * sentinel-forensics.attach() -> nunca toca ip_review_queue.
 * Se salta si no hay MONGO_URI configurada.
 *
 * Nota: mountHerzog arranca un setInterval propio (pollBaseMetrics) que no
 * se puede cancelar desde fuera (no expone el handle) — inocuo en este
 * proceso de test porque node:test cierra el proceso al terminar.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MongoClient } from 'mongodb';
import express from 'express';
import { mountHerzog } from '../herzog.js';

const MONGO_URI = process.env.MONGO_URI;
const skip = !MONGO_URI;

let client, db, app, server, baseUrl;

const COLLECTIONS = [
  'herzog_metrics',
  'herzog_documents.files',
  'herzog_documents.chunks',
  'herzog_notes',
  'herzog_log',
];

function authAs(role, user = 'test-admin') {
  return (req, res, next) => {
    req.user = user;
    req.role = role;
    next();
  };
}

function requireMesaStub() {
  return (req, res, next) => {
    if (req.role !== 'admin') return res.status(403).json({ error: 'Acceso denegado a esta mesa' });
    next();
  };
}

async function fetchJson(path, opts = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

describe('herzog.js: metricas/documentos/notas sobre Mongo', { skip: skip && 'MONGO_URI no configurada' }, () => {
  before(async () => {
    client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db('elvira_test');
    await Promise.all(COLLECTIONS.map((c) => db.collection(c).deleteMany({})));

    app = express();
    app.use(express.json());
    mountHerzog(app, {
      auth: authAs('admin'),
      requireMesa: requireMesaStub,
      mongo: db,
      busEmit: () => {},
      adminNotify: () => {},
      getU2Snapshot: () => null, // sin U2 real en este test aislado
    });

    server = app.listen(0);
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await Promise.all(COLLECTIONS.map((c) => db.collection(c).deleteMany({})));
    await client.close();
    await new Promise((resolve) => server.close(resolve));
  });

  test('POST /api/herzog-central/metrics valida campos requeridos', async () => {
    const bad = await fetchJson('/api/herzog-central/metrics', {
      method: 'POST',
      body: JSON.stringify({ department: 'finance' }),
    });
    assert.equal(bad.status, 400);

    const ok = await fetchJson('/api/herzog-central/metrics', {
      method: 'POST',
      body: JSON.stringify({ department: 'finance', metric: 'cash_balance', value: 12345.67, unit: 'EUR' }),
    });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.source, 'manual');
  });

  test('GET /api/herzog-central/metrics filtra por department y source', async () => {
    const { body } = await fetchJson('/api/herzog-central/metrics?department=finance&source=manual');
    assert.ok(body.length >= 1);
    assert.ok(body.every((m) => m.department === 'finance' && m.source === 'manual'));
  });

  test('documentos: upload raw + descarga + borrado', async () => {
    const fileContent = Buffer.from('%PDF-1.4 contenido de prueba');
    const upload = await fetch(`${baseUrl}/api/herzog-central/documents`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/pdf',
        'X-Filename': encodeURIComponent('informe-test.pdf'),
        'X-Department': 'finance',
      },
      body: fileContent,
    });
    assert.equal(upload.status, 201);
    const uploaded = await upload.json();
    assert.equal(uploaded.filename, 'informe-test.pdf');

    const download = await fetch(`${baseUrl}/api/herzog-central/documents/${uploaded.id}`);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type'), 'application/pdf');

    const del = await fetch(`${baseUrl}/api/herzog-central/documents/${uploaded.id}`, { method: 'DELETE' });
    assert.equal(del.status, 200);

    const after404 = await fetch(`${baseUrl}/api/herzog-central/documents/${uploaded.id}`);
    assert.equal(after404.status, 404);
  });

  test('documentos: tipo no permitido devuelve 415', async () => {
    const res = await fetch(`${baseUrl}/api/herzog-central/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip', 'X-Filename': 'malware.zip' },
      body: Buffer.from('x'),
    });
    assert.equal(res.status, 415);
  });

  test('notas: crear, listar, borrar', async () => {
    const create = await fetchJson('/api/herzog-central/notes', {
      method: 'POST',
      body: JSON.stringify({ department: 'finance', text: 'Nota de prueba E2E', tags: ['test'] }),
    });
    assert.equal(create.status, 201);

    const list = await fetchJson('/api/herzog-central/notes?department=finance');
    assert.ok(list.body.some((n) => n.id === create.body.id));

    const del = await fetch(`${baseUrl}/api/herzog-central/notes/${create.body.id}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
  });

  test('GET /api/herzog-central/summary agrega auto vs manual', async () => {
    const { status, body } = await fetchJson('/api/herzog-central/summary');
    assert.equal(status, 200);
    assert.ok(body.metricsCount >= 1);
    assert.ok(body.manualMetricsCount >= 1);
    assert.ok('documentsCount' in body);
    assert.ok('notesCount' in body);
  });

  test('cadena de hashes de herzog_log integra', async () => {
    const { status, body } = await fetchJson('/api/herzog-central/log/verify');
    assert.equal(status, 200);
    assert.equal(body.valid, true);
  });

  test('requireMesa bloquea rol sin acceso (403)', async () => {
    const app2 = express();
    app2.use(express.json());
    mountHerzog(app2, {
      auth: authAs('gonzalo'),
      requireMesa: requireMesaStub,
      mongo: db,
      busEmit: () => {},
      adminNotify: () => {},
      getU2Snapshot: () => null,
    });
    const server2 = app2.listen(0);
    const { port } = server2.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/herzog-central/summary`);
    assert.equal(res.status, 403);
    await new Promise((resolve) => server2.close(resolve));
  });
});
