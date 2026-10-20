/**
 * Red de seguridad de rutas (lib/async-errors.js), sin Mongo: un error dentro de una ruta
 * async responde 500 por el manejador global, el servidor sigue atendiendo y ningún
 * rechazo llega al proceso. También la copia de Express que trae Rëff.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import { captureAsyncErrors, createErrorHandler } from '../lib/async-errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REFF_SERVER = path.resolve(__dirname, '../../../Elvi-Ra/Mesas/Rëff/dist/server');
const reffExpressAvailable = fs.existsSync(path.join(REFF_SERVER, 'index.js'));

const rejections = [];
const onRejection = (reason) => rejections.push(reason);
const silentLog = { error() {} };

async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function get(baseUrl, path, init) {
  const res = await fetch(`${baseUrl}${path}`, init);
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe('async-errors: un error en una ruta no llega al proceso', () => {
  const notices = [];
  let server, baseUrl;
  let clock = 1_000_000;
  let calls = 0;

  before(async () => {
    process.on('unhandledRejection', onRejection);
    captureAsyncErrors(express);

    const app = express();
    app.use(express.json());
    app.get('/ok', (_req, res) => res.json({ ok: true }));
    app.get('/async-lanza', async () => { throw new Error('fallo de prueba'); });
    app.get('/promesa-sin-motivo', () => Promise.reject(undefined));
    app.get('/sincrona-lanza', () => { throw new Error('fallo sincrono'); });
    app.get('/item/:id', async () => { throw new Error('fallo por id'); });
    app.get('/una-vez', async (_req, res) => { calls += 1; res.json({ calls }); });
    app.get('/tras-responder', async (_req, res) => {
      res.json({ enviado: true });
      await Promise.resolve();
      throw new Error('fallo despues de responder');
    });
    app.post('/json', (req, res) => res.json(req.body));
    app.use('/mw', async () => { throw new Error('fallo en middleware'); });

    const router = express.Router();
    router.get('/dentro', async () => { throw new Error('fallo en router'); });
    app.use('/router', router);

    // Middleware de errores propio de una ruta: sigue recibiendo el error (aridad 4 conservada).
    app.get('/con-manejador', async () => { throw new Error('para el manejador propio'); }, async (err, _req, res, _next) => {
      res.status(418).json({ propio: err.message });
    });

    app.use(createErrorHandler({ notify: (n) => notices.push(n), log: silentLog, windowMs: 60_000, now: () => clock }));
    ({ server, baseUrl } = await listen(app));
  });

  after(async () => {
    process.off('unhandledRejection', onRejection);
    await new Promise((resolve) => server.close(resolve));
  });

  test('una ruta async que lanza responde 500 y el servidor sigue respondiendo', async () => {
    const r = await get(baseUrl, '/async-lanza');
    assert.equal(r.status, 500);
    assert.deepEqual(r.body, { error: 'Error interno del servidor' });
    assert.equal((await get(baseUrl, '/ok')).status, 200);
    const notice = notices.find((n) => n.label === 'Error no controlado · GET /async-lanza');
    assert.ok(notice, 'avisa al Admin');
    assert.match(notice.detail, /fallo de prueba/);
    assert.equal(notice.severity, 'error');
  });

  test('promesa rechazada sin motivo, fallo síncrono, middleware y Router: todos 500', async () => {
    for (const p of ['/promesa-sin-motivo', '/sincrona-lanza', '/mw', '/router/dentro']) {
      assert.equal((await get(baseUrl, p)).status, 500, p);
    }
    assert.equal((await get(baseUrl, '/ok')).status, 200);
  });

  test('el middleware de errores propio de una ruta sigue funcionando', async () => {
    const r = await get(baseUrl, '/con-manejador');
    assert.equal(r.status, 418);
    assert.equal(r.body.propio, 'para el manejador propio');
  });

  test('fallo después de responder: la respuesta llega entera y se avisa', async () => {
    const r = await get(baseUrl, '/tras-responder');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { enviado: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(notices.some((n) => n.label === 'Error no controlado · GET /tras-responder'));
  });

  test('JSON mal formado conserva su 400 y no avisa al Admin', async () => {
    const before = notices.length;
    const r = await get(baseUrl, '/json', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"roto":' });
    assert.equal(r.status, 400);
    assert.equal(notices.length, before);
  });

  test('un aviso por ruta y ventana, aunque cambie el identificador; al pasar la ventana avisa con el recuento', async () => {
    const before = notices.length;
    for (const id of ['a', 'b', 'c']) assert.equal((await get(baseUrl, `/item/${id}`)).status, 500);
    const first = notices.slice(before);
    assert.equal(first.length, 1);
    assert.equal(first[0].label, 'Error no controlado · GET /item/a');

    clock += 60_001;
    assert.equal((await get(baseUrl, '/item/d')).status, 500);
    const second = notices.slice(before + 1);
    assert.equal(second.length, 1);
    assert.match(second[0].detail, /^2 repeticiones más desde el aviso anterior\. /);
  });

  test('aplicarlo dos veces no envuelve dos veces', async () => {
    assert.equal(captureAsyncErrors(express), false);
    const r = await get(baseUrl, '/una-vez');
    assert.equal(r.body.calls, 1);
  });

  test('ningún rechazo llegó al proceso', () => {
    assert.deepEqual(rejections, []);
  });
});

describe('async-errors: rutas de Rëff (su propia copia de Express)', { skip: !reffExpressAvailable && 'Rëff sin compilar' }, () => {
  const reffRequire = createRequire(path.join(REFF_SERVER, 'index.js'));
  let server, baseUrl;

  before(async () => {
    process.on('unhandledRejection', onRejection);
    const reffExpress = reffRequire('express');
    captureAsyncErrors(reffExpress);

    // Igual que server.js: Router de la app registrado antes del manejador global y
    // rellenado después con un Router de la copia de Rëff.
    const app = express();
    const reffRoutes = express.Router();
    app.use(reffRoutes);
    app.use(createErrorHandler({ log: silentLog }));
    const reffRouter = reffExpress.Router();
    reffRouter.get('/falla', async () => { throw new Error('fallo en Rëff'); });
    reffRouter.get('/bien', (_req, res) => res.json({ ok: true }));
    reffRoutes.use('/reff/api/prueba', reffRouter);
    ({ server, baseUrl } = await listen(app));
  });

  after(async () => {
    process.off('unhandledRejection', onRejection);
    await new Promise((resolve) => server.close(resolve));
  });

  test('es la misma copia que importan los módulos de Rëff', async () => {
    const resolved = reffRequire.resolve('express');
    const viaImport = await import(pathToFileURL(resolved).href);
    assert.equal(viaImport.default, reffRequire('express'));
  });

  test('una ruta async de Rëff que lanza responde 500 por el manejador global', async () => {
    const r = await get(baseUrl, '/reff/api/prueba/falla');
    assert.equal(r.status, 500);
    assert.deepEqual(r.body, { error: 'Error interno del servidor' });
    assert.equal((await get(baseUrl, '/reff/api/prueba/bien')).status, 200);
    assert.deepEqual(rejections, []);
  });
});

test('el envoltorio es para Express 4 (con Express 5 sobra y hay que quitarlo)', () => {
  const backend = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../node_modules/express/package.json'), 'utf8'));
  assert.equal(backend.version.split('.')[0], '4');
  if (reffExpressAvailable) {
    const reffPkg = createRequire(path.join(REFF_SERVER, 'index.js')).resolve('express/package.json');
    assert.equal(JSON.parse(fs.readFileSync(reffPkg, 'utf8')).version.split('.')[0], '4');
  }
});
