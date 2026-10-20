/**
 * Mensajes RAFT de la malla inter-rack: firma sobre el mensaje completo,
 * version de protocolo, ventana temporal y nonce de un solo uso; y rack_log
 * encadenado con canonicalizacion profunda. El rack se monta en modo cluster
 * con un par inalcanzable y eleccion diferida, asi que solo responde a los
 * mensajes del test. Se salta sin MONGO_URI.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { MongoClient } from 'mongodb';
import express from 'express';
import { mountRackState, signRackMessage, RACK_PROTOCOL_VERSION } from '../rack-state.js';

const MONGO_URI = process.env.MONGO_URI;
const KEY = 'clave-de-pruebas-de-la-malla';
const APPEND = '/api/rack/raft/append-entries';
const VOTE = '/api/rack/raft/request-vote';

const allow = () => (req, res, next) => next();
const authStub = (req, res, next) => { req.user = 'test-admin'; req.role = 'admin'; next(); };

describe('rack-state: mensajes RAFT firmados', { skip: !MONGO_URI && 'MONGO_URI no configurada' }, () => {
  let client;
  let db;
  let server;
  let baseUrl;
  const savedEnv = {};

  function envelope(body, overrides = {}) {
    return { ...body, proto: RACK_PROTOCOL_VERSION, ts: Date.now(), nonce: crypto.randomBytes(16).toString('hex'), ...overrides };
  }

  async function send(path, payload, sig = signRackMessage(path, payload, KEY)) {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Rack-Sig': sig },
      body: JSON.stringify(payload),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  const appendBody = (entries, leaderCommit = 0) => ({
    term: 1, leaderId: 'rack-lider', prevLogIndex: 0, prevLogTerm: 0, entries, leaderCommit,
  });
  const entry = (index, key, value) => ({ index, term: 1, key, value, actor: 'admin', ts: new Date().toISOString() });

  before(async () => {
    for (const k of ['RACK_PEERS', 'RACK_SHARED_KEY', 'RACK_ELECTION_MS_MIN', 'RACK_ID']) savedEnv[k] = process.env[k];
    process.env.RACK_PEERS = 'http://127.0.0.1:9';
    process.env.RACK_SHARED_KEY = KEY;
    process.env.RACK_ELECTION_MS_MIN = '600000';
    process.env.RACK_ID = 'rack-test';
    client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db('elvira_test_rack_raft');
    await db.dropDatabase();
    const app = express();
    app.use(express.json());
    mountRackState(app, {
      auth: authStub, requireMesa: allow, mongo: db,
      busEmit: () => {}, adminNotify: () => {}, cibe: { guard: allow },
    });
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    for (let i = 0; i < 100; i += 1) {
      const res = await fetch(`${baseUrl}/api/rack/status`).catch(() => null);
      if (res?.ok) break;
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await db.dropDatabase();
    await client.close();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test('un append-entries firmado se acepta y se replica', async () => {
    const res = await send(APPEND, envelope(appendBody([entry(1, 'security.posture', 'nominal')], 1)));
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.matchIndex, 1);
  });

  for (const field of ['key', 'value', 'actor', 'index']) {
    test(`alterar ${field} de una entrada invalida la firma`, async () => {
      const payload = envelope(appendBody([entry(2, 'security.lockdown', false)]));
      const sig = signRackMessage(APPEND, payload, KEY);
      const tampered = structuredClone(payload);
      tampered.entries[0][field] = field === 'index' ? 7 : field === 'value' ? true : 'alterado';
      const res = await send(APPEND, tampered, sig);
      assert.equal(res.status, 401);
      assert.match(res.body.error, /firma inter-rack invalida/);
    });
  }

  test('un mensaje repetido dentro de la ventana se rechaza', async () => {
    const payload = envelope(appendBody([]));
    assert.equal((await send(APPEND, payload)).status, 200);
    const replay = await send(APPEND, payload);
    assert.equal(replay.status, 409);
    assert.match(replay.body.error, /nonce ya usado/);
  });

  test('un mensaje fuera de ventana se rechaza aunque la firma sea valida', async () => {
    const res = await send(APPEND, envelope(appendBody([]), { ts: Date.now() - 31000 }));
    assert.equal(res.status, 400);
    assert.match(res.body.error, /ts fuera de ventana/);
  });

  test('un mensaje anterior al arranque del rack se rechaza', async () => {
    const res = await send(APPEND, envelope(appendBody([]), { ts: Date.now() - 20000 }));
    assert.equal(res.status, 400);
    assert.match(res.body.error, /anterior al arranque/);
  });

  test('un rack con otra version de protocolo se rechaza con error claro', async () => {
    const legacy = envelope(appendBody([]));
    delete legacy.proto;
    const res = await send(APPEND, legacy);
    assert.equal(res.status, 426);
    assert.match(res.body.error, /version de protocolo inter-rack incompatible: recibida ninguna, esperada 2/);
    assert.equal(res.body.expectedProto, RACK_PROTOCOL_VERSION);
  });

  test('una firma emitida para otra ruta no vale', async () => {
    const payload = envelope({ term: 1, candidateId: 'rack-x', lastLogIndex: 0, lastLogTerm: 0 });
    const res = await send(APPEND, payload, signRackMessage(VOTE, payload, KEY));
    assert.equal(res.status, 401);
  });

  test('rack_log se encadena con canon 2 y detecta cambios en detail', async () => {
    const verify = async () => (await fetch(`${baseUrl}/api/rack/log/verify`)).json();
    const rows = await db.collection('rack_log').find({}).sort({ seq: 1 }).toArray();
    assert.ok(rows.length >= 1);
    assert.ok(rows.every((r) => r.canon === 2));
    assert.equal((await verify()).valid, true);
    const victim = rows.find((r) => r.action === 'state.apply');
    await db.collection('rack_log').updateOne({ _id: victim._id }, { $set: { 'detail.value': 'alterado' } });
    assert.deepEqual(await verify(), { valid: false, totalEntries: rows.length, brokenAtSeq: victim.seq });
    await db.collection('rack_log').updateOne({ _id: victim._id }, { $set: { 'detail.value': victim.detail.value } });
    assert.equal((await verify()).valid, true);
  });
});
