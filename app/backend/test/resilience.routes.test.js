/**
 * Test E2E de resilience.js contra Mongo real de prueba (elvira_test).
 * Mismo patron que auth.routes.test.js / sentinel-forensics.chain.test.js:
 * Express minimo con mountResilience directo, sin pasar por server.js ni
 * por sentinel-forensics.attach() (el middleware global de Sentinel solo se
 * conecta dentro de server.js) — por diseño esta suite nunca toca
 * ip_review_queue/rate_limits, no hace falta whitelist ni tocar Sentinel.
 * Se salta si no hay MONGO_URI configurada.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MongoClient } from 'mongodb';
import express from 'express';
import { mountResilience } from '../resilience.js';

const MONGO_URI = process.env.MONGO_URI;
const skip = !MONGO_URI;

let client, db, app, server, baseUrl;
const busEvents = [];
const notifications = [];

const COLLECTIONS = [
  'resilience_bss_readings',
  'resilience_suppliers',
  'resilience_backup_status',
  'resilience_isolated_mode',
  'resilience_log',
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

describe('resilience.js: BSS/proveedores/backup/modo aislado sobre Mongo', { skip: skip && 'MONGO_URI no configurada' }, () => {
  before(async () => {
    client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db('elvira_test');
    await Promise.all(COLLECTIONS.map((c) => db.collection(c).deleteMany({})));

    app = express();
    app.use(express.json());
    mountResilience(app, {
      auth: authAs('admin'),
      requireMesa: requireMesaStub,
      mongo: db,
      busEmit: (e) => busEvents.push(e),
      adminNotify: (n) => notifications.push(n),
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

  beforeEach(() => {
    busEvents.length = 0;
    notifications.length = 0;
  });

  test('GET /api/resilience/summary responde 200 (seed automatico ya inserto datos)', async () => {
    const { status, body } = await fetchJson('/api/resilience/summary');
    assert.equal(status, 200);
    assert.ok(body);
  });

  test('POST /api/resilience/bss-readings valida rangos y dispara alerta bajo umbral', async () => {
    const bad = await fetchJson('/api/resilience/bss-readings', {
      method: 'POST',
      body: JSON.stringify({ autonomyHours: -1, socPct: 50, icoPct: 50 }),
    });
    assert.equal(bad.status, 400);

    const critico = await fetchJson('/api/resilience/bss-readings', {
      method: 'POST',
      body: JSON.stringify({ autonomyHours: 40, socPct: 15, icoPct: 90, source: 'test E2E' }),
    });
    assert.equal(critico.status, 201);
    assert.equal(critico.body.socPct, 15);

    // socPct<20 => severity error, alerta a Elvi-Ra
    assert.ok(busEvents.some((e) => e.origin === 'RESILIENCE' && e.dest === 'ELVIRA' && e.state === 'BLOCKED'));
    assert.ok(notifications.some((n) => n.severity === 'error'));
  });

  test('CRUD proveedor + recalculo por region bloqueada promueve alterno a primario', async () => {
    const primario = await fetchJson('/api/resilience/suppliers', {
      method: 'POST',
      body: JSON.stringify({ component: 'inversor-test', supplierName: 'Proveedor Primario', region: 'ES', leadTimeDays: 10, isPrimary: true }),
    });
    assert.equal(primario.status, 201);
    const primarioId = primario.body.id;

    const alterno = await fetchJson('/api/resilience/suppliers', {
      method: 'POST',
      body: JSON.stringify({ component: 'inversor-test', supplierName: 'Proveedor Alterno', region: 'PT', leadTimeDays: 15, isPrimary: false }),
    });
    assert.equal(alterno.status, 201);
    const alternoId = alterno.body.id;

    const recalc = await fetchJson('/api/resilience/suppliers/recalculate', {
      method: 'POST',
      body: JSON.stringify({ blockedRegions: ['ES'] }),
    });
    assert.equal(recalc.status, 201);
    const change = recalc.body.snapshot.changes.find((c) => c.component === 'inversor-test');
    assert.equal(change.resolved, true);
    assert.equal(change.replacementSupplierId, alternoId);

    const check = await fetchJson('/api/resilience/suppliers');
    const primarioActualizado = check.body.find((s) => s.id === primarioId);
    const alternoActualizado = check.body.find((s) => s.id === alternoId);
    assert.equal(primarioActualizado.status, 'bloqueado');
    assert.equal(primarioActualizado.isPrimary, false);
    assert.equal(alternoActualizado.isPrimary, true);

    // señal a Elvi-Ra emitida, doctrina: Resilience detecta/arbitra, nunca ejecuta
    assert.ok(busEvents.some((e) => e.origin === 'RESILIENCE' && e.dest === 'ELVIRA' && e.label.includes('Recalculo')));

    await fetchJson(`/api/resilience/suppliers/${primarioId}`, { method: 'DELETE' });
    await fetchJson(`/api/resilience/suppliers/${alternoId}`, { method: 'DELETE' });
  });

  test('modo aislado: activar -> 409 si ya activo -> desactivar', async () => {
    const activate = await fetchJson('/api/resilience/isolated-mode/activate', {
      method: 'POST',
      body: JSON.stringify({ reason: 'test E2E' }),
    });
    assert.equal(activate.status, 201);
    assert.equal(activate.body.active, true);
    assert.equal(activate.body.simulated, true);

    const dup = await fetchJson('/api/resilience/isolated-mode/activate', { method: 'POST', body: JSON.stringify({}) });
    assert.equal(dup.status, 409);

    const deactivate = await fetchJson('/api/resilience/isolated-mode/deactivate', { method: 'POST', body: JSON.stringify({}) });
    assert.equal(deactivate.status, 201);
    assert.equal(deactivate.body.active, false);
  });

  test('sovereignty/migrate valida destination/dataVolumeGb y genera snapshot cifrado con hash', async () => {
    const bad = await fetchJson('/api/resilience/sovereignty/migrate', {
      method: 'POST',
      body: JSON.stringify({ dataVolumeGb: 10 }),
    });
    assert.equal(bad.status, 400);

    const { status, body } = await fetchJson('/api/resilience/sovereignty/migrate', {
      method: 'POST',
      body: JSON.stringify({ destination: 'Suiza (placeholder)', dataVolumeGb: 120 }),
    });
    assert.equal(status, 201);
    assert.ok(body.snapshot.payloadHash);
    assert.equal(body.snapshot.encryptionAlgo, 'aes-256-gcm');
    assert.match(body.snapshot.status, /sin transferencia real/);
  });

  test('cadena de hashes de resilience_log integra tras todas las mutaciones previas', async () => {
    const log = await db.collection('resilience_log').find().sort({ seq: 1 }).toArray();
    assert.ok(log.length > 0);
    let prev = '0'.repeat(64);
    for (const entry of log) {
      assert.equal(entry.prevHash, prev);
      prev = entry.hash;
    }
  });

  test('requireMesa bloquea rol sin acceso (403) via guard real de la ruta', async () => {
    const app2 = express();
    app2.use(express.json());
    mountResilience(app2, {
      auth: authAs('ray'),
      requireMesa: requireMesaStub,
      mongo: db,
      busEmit: () => {},
      adminNotify: () => {},
    });
    const server2 = app2.listen(0);
    const { port } = server2.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/resilience/summary`);
    assert.equal(res.status, 403);
    await new Promise((resolve) => server2.close(resolve));
  });
});
