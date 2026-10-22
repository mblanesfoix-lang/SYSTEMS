/**
 * Cada mesa con log encadenado por hash (Finance, Empresas de Finance, M&A,
 * Puerto Maestro, Herzog PG, Herzog LaW, S-EAGLE, Resilience, ØPS y Pactvm) escribe entradas
 * canon 2 y su /log/verify acepta tambien las heredadas. Mismo patron que
 * resilience.routes.test.js: cada mesa se monta sobre un Express propio con
 * auth y requireMesa como stubs y una db de pruebas propia. Se salta sin
 * MONGO_URI.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { MongoClient } from 'mongodb';
import express from 'express';
import { mountFinance } from '../finance.js';
import { mountFinanceCompanies } from '../finance-companies.js';
import { mountMna } from '../mna.js';
import { mountMasterGateway } from '../master-gateway.js';
import { mountHerzog } from '../herzog.js';
import { mountHerzogLaw } from '../herzog-law.js';
import { mountSeagle } from '../seagle.js';
import { mountResilience } from '../resilience.js';
import { mountOps } from '../ops.js';
import { mountPactvm } from '../pactum-viridi.js';

const MONGO_URI = process.env.MONGO_URI;
const GENESIS = '0'.repeat(64);

const allow = () => (req, res, next) => next();
const authStub = (req, res, next) => {
  req.user = 'test-admin';
  req.role = 'admin';
  next();
};

/* `write` dispara una accion real de la mesa; `nested` es el campo anidado de
   esa entrada que el test altera en Mongo. */
const MODULES = [
  {
    name: 'finance',
    log: 'finance_log',
    verify: '/api/finance/log/verify',
    mount: (app, deps) => mountFinance(app, deps),
    write: { path: '/api/finance/accounts', body: { name: 'Caja de prueba', kind: 'caja', openingBalance: 10 } },
    action: 'account.create',
    nested: 'detail.name',
  },
  {
    name: 'finance-companies',
    log: 'finance_log',
    verify: '/api/finance/log/verify',
    mount: (app, deps) => { mountFinance(app, deps); mountFinanceCompanies(app, deps); },
    write: { path: '/api/finance/companies', body: { name: 'Empresa de prueba', relation: 'cliente' } },
    action: 'company.create',
    nested: 'detail.name',
  },
  {
    name: 'mna',
    log: 'mna_log',
    verify: '/api/mna/log/verify',
    mount: (app, deps) => mountMna(app, deps),
    write: { path: '/api/mna/deals', body: { targetName: 'Objetivo de prueba' } },
    action: 'deal.create',
    nested: 'detail.targetName',
  },
  {
    name: 'master-gateway',
    log: 'gateway_log',
    verify: '/api/gateway/log/verify',
    mount: (app, deps) => mountMasterGateway(app, { ...deps, requireAdmin: (req, res, next) => next() }),
    write: { path: '/api/gateway/requests', body: { sourcePort: 'REFF_CRM', targetPort: 'OPHS_COCKPIT', scope: 'u2.snapshot' } },
    action: 'request.create',
    nested: 'detail.scope',
  },
  {
    name: 'herzog',
    log: 'herzog_log',
    verify: '/api/herzog-central/log/verify',
    mount: (app, deps) => mountHerzog(app, { ...deps, busEmit: () => {}, adminNotify: () => {}, getU2Snapshot: () => null }),
    write: { path: '/api/herzog-central/metrics', body: { department: 'finanzas', metric: 'caja', value: 5 } },
    action: 'metric.create',
    nested: 'detail.metric',
  },
  {
    name: 'herzog-law',
    log: 'herzog_law_log',
    verify: '/api/herzog-law/log/verify',
    mount: (app, deps) => mountHerzogLaw(app, { ...deps, adminNotify: () => {} }),
    write: { path: '/api/herzog-law/zones', body: { name: 'Zona de prueba' } },
    action: 'zone.create',
    nested: 'detail.name',
  },
  {
    name: 'seagle',
    log: 'seagle_log',
    verify: '/api/seagle/log/verify',
    mount: (app, deps) => mountSeagle(app, { ...deps, requireAdmin: (req, res, next) => next(), adminNotify: () => {} }),
    write: { path: '/api/seagle/invitations', body: { label: 'Inspeccion de prueba', emails: ['inspector@gob.es'] } },
    action: 'invitation.created',
    nested: 'detail.label',
  },
  {
    name: 'resilience',
    log: 'resilience_log',
    verify: '/api/resilience/log/verify',
    mount: (app, deps) => mountResilience(app, { ...deps, busEmit: () => {}, adminNotify: () => {} }),
    write: { path: '/api/resilience/bss-readings', body: { autonomyHours: 60, socPct: 50, icoPct: 50 } },
    action: 'bss_reading.create',
    nested: 'detail.socPct',
  },
  {
    name: 'ops',
    log: 'ops_log',
    verify: '/api/ops/log/verify',
    mount: (app, deps) => mountOps(app, deps),
    write: () => ({ path: '/api/ops/nodes', body: { nodeId: `nodo-${crypto.randomUUID()}` } }),
    action: 'node.register',
    nested: 'detail.nodeId',
  },
  {
    name: 'pactvm',
    log: 'pactvm_log',
    verify: '/api/pactvm/log/verify',
    mount: (app, deps) => mountPactvm(app, { ...deps, requireAdmin: (req, res, next) => next(), getReffDb: () => deps.mongo, getU2Snapshot: () => null }),
    write: { path: '/api/pactvm/policies', body: { name: 'Politica de prueba', category: 'residuo' } },
    action: 'policy.create',
    nested: 'detail.name',
  },
];

/* Entrada heredada, escrita como lo hacia cada mesa antes de la serializacion profunda. */
async function appendLegacy(db, logName, entry) {
  const col = db.collection(logName);
  const tail = await col.find().sort({ seq: -1 }).limit(1).next();
  const seq = tail ? tail.seq + 1 : 1;
  const prevHash = tail ? tail.hash : GENESIS;
  const body = { ...entry, seq };
  const hash = crypto.createHash('sha256').update(prevHash + JSON.stringify(body, Object.keys(body).sort())).digest('hex');
  await col.insertOne({ _id: crypto.randomUUID(), ...entry, seq, prevHash, hash, createdAt: new Date().toISOString() });
}

const getPath = (obj, path) => path.split('.').reduce((acc, key) => acc?.[key], obj);

for (const mod of MODULES) {
  describe(`${mod.name}: ${mod.log} encadenado`, { skip: !MONGO_URI && 'MONGO_URI no configurada' }, () => {
    let client;
    let db;
    let server;
    let baseUrl;

    async function call(path, { method = 'GET', body } = {}) {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    }

    async function writeOne() {
      const write = typeof mod.write === 'function' ? mod.write() : mod.write;
      const res = await call(write.path, { method: 'POST', body: write.body });
      assert.ok(res.status >= 200 && res.status < 300, `${write.path} respondio ${res.status}`);
    }

    const legacyEntry = (i) => ({ action: 'legacy.create', actorId: 'legacy-user', detail: { n: i, nested: { campo: `valor-${i}` } } });

    before(async () => {
      client = new MongoClient(MONGO_URI);
      await client.connect();
      db = client.db(`elvira_test_logchain_${mod.name.replace(/-/g, '_')}`);
      await db.dropDatabase();
      const app = express();
      app.use(express.json());
      mod.mount(app, { auth: authStub, requireMesa: allow, mongo: db });
      server = app.listen(0);
      baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    after(async () => {
      await new Promise((resolve) => server.close(resolve));
      await db.dropDatabase();
      await client.close();
    });

    beforeEach(async () => {
      await db.collection(mod.log).deleteMany({});
    });

    test('las entradas heredadas (v1) siguen verificando', async () => {
      await appendLegacy(db, mod.log, legacyEntry(1));
      await appendLegacy(db, mod.log, legacyEntry(2));
      const { status, body } = await call(mod.verify);
      assert.equal(status, 200);
      assert.deepEqual(body, { valid: true, totalEntries: 2, brokenAtSeq: null });
    });

    test('cadena mixta: heredadas seguidas de una entrada nueva canon 2 verifica', async () => {
      await appendLegacy(db, mod.log, legacyEntry(1));
      await appendLegacy(db, mod.log, legacyEntry(2));
      await writeOne();
      const rows = await db.collection(mod.log).find({}).sort({ seq: 1 }).toArray();
      assert.equal(rows.length, 3);
      assert.equal(rows[0].canon, undefined);
      assert.equal(rows[2].canon, 2);
      assert.equal(rows[2].action, mod.action);
      assert.equal(rows[2].prevHash, rows[1].hash);
      assert.deepEqual((await call(mod.verify)).body, { valid: true, totalEntries: 3, brokenAtSeq: null });
    });

    test('alterar un campo anidado de una entrada canon 2 rompe la verificacion', async () => {
      await appendLegacy(db, mod.log, legacyEntry(1));
      await writeOne();
      await writeOne();
      const victim = await db.collection(mod.log).findOne({ action: mod.action, canon: 2 }, { sort: { seq: 1 } });
      const original = getPath(victim, mod.nested);
      assert.notEqual(original, undefined, `${mod.nested} no existe en la entrada`);

      await db.collection(mod.log).updateOne({ _id: victim._id }, { $set: { [mod.nested]: 'alterado' } });
      assert.deepEqual((await call(mod.verify)).body, { valid: false, totalEntries: 3, brokenAtSeq: victim.seq });

      await db.collection(mod.log).updateOne({ _id: victim._id }, { $set: { [mod.nested]: original } });
      assert.deepEqual((await call(mod.verify)).body, { valid: true, totalEntries: 3, brokenAtSeq: null });
    });
  });
}
