/**
 * Cabeceras de seguridad (lib/security-headers.js) y receptor de informes CSP
 * (routes/csp-report.routes.js). Express real montado igual que server.js:
 * trust proxy 1, cabeceras antes que nada, una ruta de API y estaticos.
 * La parte que guarda informes usa Mongo de prueba (elvira_test) y se salta
 * sin MONGO_URI; el resto usa un stub de coleccion.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { MongoClient } from 'mongodb';
import { applySecurityHeaders, CSP_REPORT_PATH } from '../lib/security-headers.js';
import { mountCspReport, ensureCspReportIndexes, extractCspReports, cleanUrl, CSP_REPORT_TTL_DAYS } from '../routes/csp-report.routes.js';

const MONGO_URI = process.env.MONGO_URI;

function buildApp(mongo) {
  const app = express();
  app.set('trust proxy', 1);
  applySecurityHeaders(app);
  app.use(express.json());
  app.get('/api/ping', (_req, res) => res.json({ ok: true }));
  mountCspReport(app, { mongo });
  return app;
}

async function listen(app) {
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

function legacyReport(overrides = {}) {
  return {
    'csp-report': {
      'document-uri': 'http://127.0.0.1/pages/fl.html?token=secreto#ancla',
      'blocked-uri': 'inline',
      'effective-directive': 'script-src-elem',
      'violated-directive': 'script-src-elem',
      'original-policy': "default-src 'self'",
      disposition: 'report',
      'source-file': 'http://127.0.0.1/pages/fl.html?token=secreto',
      'line-number': 12,
      'column-number': 3,
      'script-sample': '(function () {',
      ...overrides,
    },
  };
}

function postReport(baseUrl, body, type = 'application/csp-report') {
  return fetch(`${baseUrl}${CSP_REPORT_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': type },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('cabeceras de seguridad en estaticos y API', () => {
  let server, baseUrl, staticDir;

  before(async () => {
    staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-headers-'));
    fs.writeFileSync(path.join(staticDir, 'pagina.html'), '<!doctype html><title>t</title>');
    const app = buildApp({ collection: () => ({ bulkWrite: async () => ({}) }) });
    app.use(express.static(staticDir));
    ({ server, baseUrl } = await listen(app));
  });

  after(() => {
    server?.close();
    fs.rmSync(staticDir, { recursive: true, force: true });
  });

  for (const [tipo, ruta] of [['estatica', '/pagina.html'], ['de API', '/api/ping']]) {
    test(`respuesta ${tipo}: CSP en Report-Only, antiencuadre, nosniff y referrer`, async () => {
      const res = await fetch(`${baseUrl}${ruta}`);
      assert.equal(res.status, 200);
      const csp = res.headers.get('content-security-policy-report-only');
      assert.ok(csp, 'falta Content-Security-Policy-Report-Only');
      for (const d of ["default-src 'self'", "script-src 'self'", "object-src 'none'", "frame-ancestors 'self'", `report-uri ${CSP_REPORT_PATH}`]) {
        assert.ok(csp.includes(d), `la politica no incluye: ${d}`);
      }
      assert.ok(!csp.includes('upgrade-insecure-requests'));
      assert.equal(res.headers.get('content-security-policy'), null, 'la politica aun no debe imponerse');
      assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(res.headers.get('cross-origin-opener-policy'), 'same-origin');
      assert.equal(res.headers.get('x-powered-by'), null);
    });
  }

  test('HSTS solo cuando la peticion llega por TLS', async () => {
    const plain = await fetch(`${baseUrl}/api/ping`);
    assert.equal(plain.headers.get('strict-transport-security'), null);
    const viaTls = await fetch(`${baseUrl}/api/ping`, { headers: { 'X-Forwarded-Proto': 'https' } });
    assert.equal(viaTls.headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains');
  });
});

describe('informes CSP: lectura y limpieza', () => {
  test('formato report-uri: URLs sin query ni fragmento', () => {
    const [r] = extractCspReports(legacyReport());
    assert.equal(r.documentUri, 'http://127.0.0.1/pages/fl.html');
    assert.equal(r.sourceFile, 'http://127.0.0.1/pages/fl.html');
    assert.equal(r.blockedUri, 'inline');
    assert.equal(r.directive, 'script-src-elem');
    assert.equal(r.line, 12);
    assert.equal(r.sample, '(function () {');
  });

  test('formato Reporting API: solo csp-violation y como mucho 10 por envio', () => {
    const one = { type: 'csp-violation', body: { documentURL: 'https://h/a?x=1', blockedURL: 'blob:https://h/1234', effectiveDirective: 'img-src', disposition: 'report' } };
    const reports = extractCspReports([...Array(12).fill(one), { type: 'deprecation', body: {} }]);
    assert.equal(reports.length, 10);
    assert.equal(reports[0].documentUri, 'https://h/a');
    assert.equal(reports[0].blockedUri, 'blob:');
  });

  test('cleanUrl: esquemas no http y palabras clave', () => {
    assert.equal(cleanUrl('chrome-extension://abc/x.js'), 'chrome-extension://abc');
    assert.equal(cleanUrl('data:image/png;base64,AAAA'), 'data:');
    assert.equal(cleanUrl('eval'), 'eval');
    assert.equal(cleanUrl(42), null);
  });

  test('cuerpos sin informes validos no producen nada', () => {
    assert.deepEqual(extractCspReports({}), []);
    assert.deepEqual(extractCspReports({ 'csp-report': {} }), []);
    assert.deepEqual(extractCspReports(null), []);
  });
});

describe('informes CSP: rechazos y limite de tasa', () => {
  let server, baseUrl;
  const errors = [];

  before(async () => {
    const app = buildApp({ collection: () => ({ bulkWrite: async () => ({}) }) });
    app.use((err, _req, res, _next) => { errors.push(err); res.status(500).end(); });
    ({ server, baseUrl } = await listen(app));
  });

  after(() => server?.close());

  test('tipo de contenido ajeno, JSON roto, cuerpo enorme o sin informes', async () => {
    assert.equal((await postReport(baseUrl, legacyReport(), 'application/json')).status, 415);
    assert.equal((await postReport(baseUrl, '{roto')).status, 400);
    assert.equal((await postReport(baseUrl, legacyReport({ 'script-sample': 'x'.repeat(20_000) }))).status, 413);
    assert.equal((await postReport(baseUrl, { otra: 1 })).status, 400);
    assert.equal((await postReport(baseUrl, legacyReport())).status, 204);
    assert.equal(errors.length, 0, 'los rechazos no deben llegar al manejador global de errores');
  });

  test('mas de 30 informes por minuto desde la misma IP: 429', async () => {
    // El test anterior ya gasto 5 del cupo de esta app.
    const statuses = [];
    for (let i = 0; i < 26; i += 1) statuses.push((await postReport(baseUrl, legacyReport())).status);
    assert.deepEqual([...new Set(statuses.slice(0, 25))], [204]);
    assert.equal(statuses[25], 429);
  });
});

describe('informes CSP en Mongo', { skip: !MONGO_URI && 'MONGO_URI no configurada' }, () => {
  let client, db, server, baseUrl;

  before(async () => {
    client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db('elvira_test');
    await db.collection('csp_reports').deleteMany({});
    await ensureCspReportIndexes(db);
    ({ server, baseUrl } = await listen(buildApp(db)));
  });

  after(async () => {
    server?.close();
    await db?.collection('csp_reports').deleteMany({});
    await client?.close();
  });

  test('indices: clave unica y caducidad por expiresAt', async () => {
    const idx = await db.collection('csp_reports').indexes();
    assert.ok(idx.some((i) => i.key.key === 1 && i.unique === true));
    assert.ok(idx.some((i) => i.key.expiresAt === 1 && i.expireAfterSeconds === 0));
  });

  test('la misma infraccion se guarda una vez con contador y caducidad', async () => {
    const before = Date.now();
    assert.equal((await postReport(baseUrl, legacyReport())).status, 204);
    assert.equal((await postReport(baseUrl, legacyReport({ 'document-uri': 'http://127.0.0.1/pages/fl.html?token=otro' }))).status, 204);
    const docs = await db.collection('csp_reports').find({}).toArray();
    assert.equal(docs.length, 1);
    assert.equal(docs[0].count, 2);
    assert.equal(docs[0].documentUri, 'http://127.0.0.1/pages/fl.html');
    assert.ok(!JSON.stringify(docs[0]).includes('secreto'));
    const ttlMs = docs[0].expiresAt.getTime() - before;
    assert.ok(Math.abs(ttlMs - CSP_REPORT_TTL_DAYS * 86_400_000) < 60_000);
  });

  test('Reporting API: varias infracciones en un envio', async () => {
    const res = await postReport(baseUrl, [
      { type: 'csp-violation', body: { documentURL: 'http://127.0.0.1/pages/ophs.html', blockedURL: 'inline', effectiveDirective: 'script-src-attr', lineNumber: 40 } },
      { type: 'csp-violation', body: { documentURL: 'http://127.0.0.1/pages/ophs.html', blockedURL: 'inline', effectiveDirective: 'script-src-attr', lineNumber: 41 } },
    ], 'application/reports+json');
    assert.equal(res.status, 204);
    assert.equal(await db.collection('csp_reports').countDocuments({ documentUri: 'http://127.0.0.1/pages/ophs.html' }), 2);
  });
});
