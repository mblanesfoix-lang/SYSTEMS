/**
 * Test E2E de pactum-viridi.js (6 sub-mesas Pactvm Viridi) contra Mongo real
 * de prueba (elvira_test). Mismo patron aislado que resilience/herzog:
 * mountPactvm directo sobre Express minimo, sin sentinel-forensics.attach().
 *
 * Alcance: smoke test por sub-mesa (create + read + summary/agregado), no
 * cobertura exhaustiva de cada campo — mesa con 60+ rutas.
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
      getReffDb: () => client.db('reff'),
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

  test('1b. CIBE: ni el listado ni el PATCH devuelven la tokenKey, solo si existe', async () => {
    await db.collection('pactvm_cibe').insertOne({
      _id: 'cibe-con-clave', entityName: 'Rack con clave', status: 'emitido', tokenKey: 'sealed:v1:valor-de-prueba',
    });
    const list = await fetchJson('/api/pactvm/cibe');
    const row = list.body.find((c) => c.id === 'cibe-con-clave');
    assert.equal(row.tokenKey, undefined);
    assert.equal(row.hasTokenKey, true);
    assert.ok(list.body.filter((c) => c.id !== 'cibe-con-clave').every((c) => c.hasTokenKey === false));
    assert.ok(!JSON.stringify(list.body).includes('valor-de-prueba'));

    const patched = await fetchJson('/api/pactvm/cibe/cibe-con-clave', { method: 'PATCH', body: JSON.stringify({ notes: 'revisado' }) });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.tokenKey, undefined);
    assert.equal(patched.body.hasTokenKey, true);
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
    // DE no tiene tabla de regiones propia: cae al fallback generico
    // (una sola region ficticia centrada en el pais), no en España.
    assert.equal(globe.body.esCurtailment.countryCode, 'DE');
    assert.ok(globe.body.esCurtailment.nodes.every((n) => n.regionName === globe.body.esCurtailment.countryLabel));
  });

  test('6b. VDR: el cluster de nodos sigue al pais de la empresa, no queda fijo en España', async () => {
    const dz = await fetchJson('/api/pactvm/vdr/companies', {
      method: 'POST',
      body: JSON.stringify({ name: 'Empresa Argelia VDR', geoCountry: 'dz', geoWeight: 3, spainActivity: 1 }),
    });
    assert.equal(dz.status, 201);

    const globe = await fetchJson(`/api/pactvm/vdr/companies/${dz.body.id}/globe`);
    assert.equal(globe.status, 200);
    assert.equal(globe.body.star.countryCode, 'DZ');
    // Argelia SI tiene tabla de wilayas propia (COUNTRY_REGIONS.DZ): el
    // cluster debe repartirse entre ellas, no caer en el fallback generico
    // ni (el bug original) quedarse fijo sobre comunidades españolas.
    assert.equal(globe.body.esCurtailment.countryCode, 'DZ');
    assert.ok(globe.body.esCurtailment.regions.length > 1, 'DZ debe repartir en varias wilayas, no una sola region ficticia');
    const regionNames = new Set(globe.body.esCurtailment.regions.map((r) => r.name));
    assert.ok(regionNames.has('Argel'));
    assert.ok(!regionNames.has('Andalucía') && !regionNames.has('Cataluña'), 'ningun nodo debe caer en comunidades españolas');
    // coordenadas del cluster dentro del territorio argelino (lat ~19-37N, lng ~-9 a 12E)
    globe.body.esCurtailment.nodes.forEach((n) => {
      assert.ok(n.lat > 15 && n.lat < 40, `nodo ${n.code} fuera de latitud argelina: ${n.lat}`);
      assert.ok(n.lng > -10 && n.lng < 15, `nodo ${n.code} fuera de longitud argelina: ${n.lng}`);
    });
  });

  test('6c. VDR: es-config es por pais, no un unico valor compartido', async () => {
    // pais invalido -> 400 en GET y PATCH
    const badGet = await fetchJson('/api/pactvm/vdr/es-config/ZZ');
    assert.equal(badGet.status, 400);
    const badPatch = await fetchJson('/api/pactvm/vdr/es-config/ZZ', { method: 'PATCH', body: JSON.stringify({ nodesTargetTotal: 10 }) });
    assert.equal(badPatch.status, 400);

    // sin editar, cualquier pais valido sale con el default (200 nodos)
    const esDefault = await fetchJson('/api/pactvm/vdr/es-config/ES');
    assert.equal(esDefault.status, 200);
    assert.equal(esDefault.body.nodesTargetTotal, 200);
    const dzDefault = await fetchJson('/api/pactvm/vdr/es-config/dz');
    assert.equal(dzDefault.status, 200);
    assert.equal(dzDefault.body.nodesTargetTotal, 200);

    // editar DZ a 50 nodos no debe tocar ES
    const patchDz = await fetchJson('/api/pactvm/vdr/es-config/dz', { method: 'PATCH', body: JSON.stringify({ nodesTargetTotal: 50 }) });
    assert.equal(patchDz.status, 200);
    assert.equal(patchDz.body.nodesTargetTotal, 50);

    const esAfter = await fetchJson('/api/pactvm/vdr/es-config/ES');
    assert.equal(esAfter.body.nodesTargetTotal, 200, 'editar DZ no debe afectar a ES');

    // el listado de todos los paises refleja el cambio solo en DZ
    const all = await fetchJson('/api/pactvm/vdr/es-config');
    assert.equal(all.status, 200);
    const allDz = all.body.find((c) => c.id === 'DZ');
    const allEs = all.body.find((c) => c.id === 'ES');
    assert.equal(allDz.nodesTargetTotal, 50);
    assert.equal(allEs.nodesTargetTotal, 200);

    // el globo de una empresa en DZ refleja los 50 nodos de su pais
    const company = await fetchJson('/api/pactvm/vdr/companies', {
      method: 'POST',
      body: JSON.stringify({ name: 'Empresa DZ 50 nodos', geoCountry: 'dz', geoWeight: 1, spainActivity: 0 }),
    });
    const globe = await fetchJson(`/api/pactvm/vdr/companies/${company.body.id}/globe`);
    assert.equal(globe.body.esCurtailment.nodesTargetTotal, 50);
    assert.equal(globe.body.esCurtailment.nodes.length, 50);
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
      getReffDb: () => client.db('reff'),
      getU2Snapshot: () => null,
    });
    const server2 = app2.listen(0);
    const { port } = server2.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/pactvm/summary`);
    assert.equal(res.status, 403);
    await new Promise((resolve) => server2.close(resolve));
  });
});
