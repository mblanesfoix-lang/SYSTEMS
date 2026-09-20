/**
 * Test E2E de pactum-viridi.js (6 sub-mesas Pactvm Viridi) contra Mongo real
 * de prueba (elvira_test). Mismo patron aislado que resilience/herzog:
 * mountPactvm directo sobre Express minimo, sin sentinel-forensics.attach().
 *
 * Alcance: smoke test por sub-mesa (create + read + summary/agregado), no
 * cobertura exhaustiva de cada campo — mesa con 60+ rutas, ver CLAUDE.md.
 * Se salta si no hay MONGO_URI configurada.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MongoClient } from 'mongodb';
import express from 'express';
import { mountPactvm } from '../pactum-viridi.js';

const MONGO_URI = process.env.MONGO_URI;
const skip = !MONGO_URI;

let client, db, app, server, baseUrl;

const COLLECTIONS = [
  'pactvm_cibe', 'pactvm_policies', 'pactvm_access_rules',
  'pactvm_country_nodes', 'pactvm_entry_conditions',
  'pactvm_carbon_ratio', 'pactvm_carbon_cert_config', 'pactvm_carbon_clients', 'pactvm_carbon_packages',
  'pactvm_planetary_config', 'pactvm_planetary_countries',
  'pactvm_vdr_companies', 'pactvm_vdr_shares', 'pactvm_vdr_es_config',
  'pactvm_log',
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
    if (req.role !== 'admin' && !(req.role === 'ray' || req.role === 'gonzalo')) {
      return res.status(403).json({ error: 'Acceso denegado a esta mesa' });
    }
    next();
  };
}

function requireAdminStub(req, res, next) {
  if (req.role !== 'admin') return res.status(403).json({ error: 'admin requerido' });
  next();
}

async function fetchJson(path, opts = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

describe('pactum-viridi.js: 6 sub-mesas sobre Mongo', { skip: skip && 'MONGO_URI no configurada' }, () => {
  before(async () => {
    client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db('elvira_test');
    await Promise.all(COLLECTIONS.map((c) => db.collection(c).deleteMany({})));

    app = express();
    app.use(express.json());
    mountPactvm(app, {
      auth: authAs('admin'),
      requireMesa: requireMesaStub,
      requireAdmin: requireAdminStub,
      mongo: db,
      getMongoClient: () => client,
      getU2Snapshot: () => null,
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

  test('1. CIBE: crear certificado + listar', async () => {
    const create = await fetchJson('/api/pactvm/cibe', {
      method: 'POST',
      body: JSON.stringify({ entityName: 'Empresa Test CIBE', sector: 'agro' }),
    });
    assert.equal(create.status, 201);
    assert.equal(create.body.status, 'pendiente');

    const list = await fetchJson('/api/pactvm/cibe');
    assert.equal(list.status, 200);
    assert.ok(list.body.some((c) => c.id === create.body.id));
  });

  test('2. Nodos por pais: crear con code duplicado -> 409, nodesNeeded calculado', async () => {
    const create = await fetchJson('/api/pactvm/country-nodes', {
      method: 'POST',
      body: JSON.stringify({ code: 'de', label: 'Alemania', wasteEstTDay: 300 }),
    });
    assert.equal(create.status, 201);
    assert.equal(create.body.code, 'DE');
    assert.equal(create.body.nodesNeeded, 2); // ceil(300/150)

    const dup = await fetchJson('/api/pactvm/country-nodes', {
      method: 'POST',
      body: JSON.stringify({ code: 'DE', label: 'Alemania otra vez', wasteEstTDay: 50 }),
    });
    assert.equal(dup.status, 409);
  });

  test('3. Condiciones de entrada: listar (sin romper aunque este vacio)', async () => {
    const { status, body } = await fetchJson('/api/pactvm/entry-conditions');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body));
  });

  test('4. Carbono: crear cliente valida ghgGases y calcula summary con tokens RWA', async () => {
    const bad = await fetchJson('/api/pactvm/carbon/clients', {
      method: 'POST',
      body: JSON.stringify({ clientName: 'Finca Test', period: '2026-09', co2eTons: 10, dbo5Tons: 5, hectares: 2, revenueEur: 1000, ghgGases: [] }),
    });
    assert.equal(bad.status, 400);

    const ok = await fetchJson('/api/pactvm/carbon/clients', {
      method: 'POST',
      body: JSON.stringify({ clientName: 'Finca Test', period: '2026-09', co2eTons: 10, dbo5Tons: 5, hectares: 2, revenueEur: 1000, ghgGases: ['co2'] }),
    });
    assert.equal(ok.status, 201);

    const summary = await fetchJson('/api/pactvm/carbon/summary');
    assert.equal(summary.status, 200);
    assert.ok(summary.body.co2eTotal >= 10);
    assert.ok('rwaTokensMinted' in summary.body);
  });

  test('5. Motor Planetario: crear pais objetivo + summary agrega capacidad global', async () => {
    const create = await fetchJson('/api/pactvm/planetary/countries', {
      method: 'POST',
      body: JSON.stringify({ code: 'BR', label: 'Brasil', wasteEstTYear: 50000 }),
    });
    assert.equal(create.status, 201);
    assert.ok(create.body.nodesTarget > 0);

    const summary = await fetchJson('/api/pactvm/planetary/summary');
    assert.equal(summary.status, 200);
    assert.ok('totalInfraValueEur' in summary.body);
    assert.ok('globalProcessingTYear' in summary.body);
  });

  test('6. VDR: crear empresa con pais invalido -> 400, con pais valido -> globo resuelve lat/lng', async () => {
    const bad = await fetchJson('/api/pactvm/vdr/companies', {
      method: 'POST',
      body: JSON.stringify({ name: 'Empresa X', geoCountry: 'ZZ', geoWeight: 1, spainActivity: 1 }),
    });
    assert.equal(bad.status, 400);

    const ok = await fetchJson('/api/pactvm/vdr/companies', {
      method: 'POST',
      body: JSON.stringify({ name: 'Empresa Test VDR', geoCountry: 'de', geoWeight: 5, spainActivity: 2 }),
    });
    assert.equal(ok.status, 201);

    const globe = await fetchJson(`/api/pactvm/vdr/companies/${ok.body.id}/globe`);
    assert.equal(globe.status, 200);
    assert.equal(typeof globe.body.star.lat, 'number');
    assert.equal(globe.body.star.countryCode, 'DE');
  });

  test('GET /api/pactvm/summary agrega las sub-mesas sin romper', async () => {
    const { status, body } = await fetchJson('/api/pactvm/summary');
    assert.equal(status, 200);
    assert.ok(body);
  });

  test('cadena de hashes de pactvm_log integra tras todas las mutaciones', async () => {
    const log = await db.collection('pactvm_log').find().sort({ seq: 1 }).toArray();
    assert.ok(log.length > 0);
    let prev = '0'.repeat(64);
    for (const entry of log) {
      assert.equal(entry.prevHash, prev);
      prev = entry.hash;
    }
  });

  test('requireMesa bloquea rol sin acceso pactvm (403)', async () => {
    const app2 = express();
    app2.use(express.json());
    mountPactvm(app2, {
      auth: authAs('marc'),
      requireMesa: requireMesaStub,
      requireAdmin: requireAdminStub,
      mongo: db,
      getMongoClient: () => client,
      getU2Snapshot: () => null,
    });
    const server2 = app2.listen(0);
    const { port } = server2.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/pactvm/summary`);
    assert.equal(res.status, 403);
    await new Promise((resolve) => server2.close(resolve));
  });
});
