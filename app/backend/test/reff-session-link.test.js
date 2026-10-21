/**
 * Tokens de Rëff atados a la sesion de Elvi-Ra (Elvi-Ra/Mesas/Rëff/server/auth.ts, tal
 * como lo carga server.js desde dist/): vida maxima de 8 h, recortable a lo que le quede a
 * la sesion, y con la comprobacion de sesion registrada un token sin `sid` o de una sesion
 * cerrada no entra. Sin Mongo real: stub del cliente con el que Rëff lee sus usuarios.
 * Se salta si Rëff no esta compilado (npm run build en su carpeta).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REFF_SERVER = path.resolve(__dirname, '../../../Elvi-Ra/Mesas/Rëff/dist/server');
const built = fs.existsSync(path.join(REFF_SERVER, 'auth.js'));

const MAX_SECONDS = 8 * 60 * 60;
const claims = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
const lifetime = (jwt) => { const c = claims(jwt); return c.exp - c.iat; };

describe('Rëff: tokens atados a la sesion de Elvi-Ra', { skip: !built && 'Rëff sin compilar (npm run build en Elvi-Ra/Mesas/Rëff)' }, () => {
  let reffAuth;
  let server;
  let baseUrl;
  const openSessions = new Set();

  const sign = (payload, seconds) => reffAuth.signToken({ userId: 'u-1', ...payload }, seconds);
  async function get(token) {
    const res = await fetch(`${baseUrl}/me`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  before(async () => {
    const { setMongoClient } = await import(pathToFileURL(path.join(REFF_SERVER, 'mongo.js')).href);
    const users = { 'u-1': { _id: 'u-1', username: 'marc', display_name: 'Marc', avatar_url: null } };
    await setMongoClient({
      db: () => ({
        collection: () => ({ createIndex: async () => {}, findOne: async ({ _id }) => users[_id] ?? null }),
      }),
    });
    reffAuth = await import(pathToFileURL(path.join(REFF_SERVER, 'auth.js')).href);

    const app = express();
    app.get('/me', reffAuth.authMiddleware, (req, res) => res.json(req.user));
    app.use((err, req, res, _next) => res.status(500).json({ error: err.message }));
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    reffAuth?.setSessionCheck(null);
    await new Promise((resolve) => server.close(resolve));
  });

  test('vida del token: 8 h como maximo, recortable, nunca mas larga ni nula', () => {
    assert.equal(lifetime(sign({})), MAX_SECONDS);
    assert.equal(lifetime(sign({}, 300)), 300);
    assert.equal(lifetime(sign({}, 10 * MAX_SECONDS)), MAX_SECONDS);
    assert.equal(lifetime(sign({}, 0)), 1);
    assert.equal(lifetime(sign({}, -50)), 1);
  });

  test('sin comprobacion registrada (Rëff suelto) basta un token firmado y vigente', async () => {
    reffAuth.setSessionCheck(null);
    const { status, body } = await get(sign({}));
    assert.equal(status, 200);
    assert.equal(body.username, 'marc');
  });

  test('integrado: solo entra un token cuya sesion de origen sigue abierta', async () => {
    openSessions.clear();
    openSessions.add('sid-abierta');
    const checked = [];
    reffAuth.setSessionCheck(async (sid) => { checked.push(sid); return openSessions.has(sid); });

    assert.equal((await get(sign({ sid: 'sid-abierta' }))).status, 200);
    assert.equal((await get(sign({ sid: 'sid-cerrada' }))).status, 401);
    // sin sid, o con un sid que no es texto, ni siquiera se consulta la sesion
    assert.equal((await get(sign({}))).status, 401);
    assert.equal((await get(sign({ sid: '' }))).status, 401);
    assert.equal((await get(sign({ sid: 123 }))).status, 401);
    assert.equal((await get(sign({ sid: { $ne: null } }))).status, 401);
    assert.deepEqual(checked, ['sid-abierta', 'sid-cerrada']);
  });

  test('cerrar la sesion de origen invalida al momento un token ya emitido', async () => {
    openSessions.clear();
    openSessions.add('sid-viva');
    reffAuth.setSessionCheck(async (sid) => openSessions.has(sid));
    const token = sign({ sid: 'sid-viva' });
    assert.equal((await get(token)).status, 200);
    openSessions.delete('sid-viva');
    const after = await get(token);
    assert.equal(after.status, 401);
    assert.match(after.body.error, /sesión de origen/);
  });

  test('un token viejo no se reaprovecha cambiandole el sid por el de otra sesion abierta', async () => {
    openSessions.clear();
    openSessions.add('sid-ajena');
    reffAuth.setSessionCheck(async (sid) => openSessions.has(sid));
    const original = sign({ sid: 'sid-cerrada' });
    const [header, , signature] = original.split('.');
    const forgedClaims = Buffer.from(JSON.stringify({ ...claims(original), sid: 'sid-ajena' })).toString('base64url');
    assert.equal((await get(`${header}.${forgedClaims}.${signature}`)).status, 401);
  });

  test('token caducado -> 401 aunque su sesion siga abierta', async () => {
    openSessions.clear();
    openSessions.add('sid-larga');
    reffAuth.setSessionCheck(async (sid) => openSessions.has(sid));
    const token = sign({ sid: 'sid-larga' }, 1);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal((await get(token)).status, 401);
  });

  test('si la comprobacion de sesion falla, la peticion no entra', async () => {
    reffAuth.setSessionCheck(async () => { throw new Error('mongo caido'); });
    const { status } = await get(sign({ sid: 'sid-cualquiera' }));
    assert.ok(status >= 500, `status ${status}`);
  });
});
