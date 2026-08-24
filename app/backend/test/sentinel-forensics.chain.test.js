/**
 * Test de integridad de la cadena de hashes forense (Sentinel).
 * Usa una base Mongo real de prueba (MONGO_URI del .env, db 'elvira_test'
 * en vez de 'elvira') para ejercitar el mismo codigo que produccion.
 * Se salta automaticamente si no hay MONGO_URI configurada.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MongoClient } from 'mongodb';
import { createSentinelForensics } from '../sentinel-forensics.js';

const MONGO_URI = process.env.MONGO_URI;
const skip = !MONGO_URI;

let client, db, sentinelForensics;

describe('sentinel-forensics: cadena de hashes forense', { skip: skip && 'MONGO_URI no configurada' }, () => {
  before(async () => {
    client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db('elvira_test');
    // limpieza de colecciones usadas por este test
    await Promise.all([
      db.collection('forensic_log').deleteMany({}),
      db.collection('forensic_seq').deleteMany({}),
      db.collection('login_attempts').deleteMany({}),
      db.collection('ip_review_queue').deleteMany({}),
      db.collection('ip_allowlist').deleteMany({}),
    ]);
    sentinelForensics = createSentinelForensics({ mongo: db, busEmit: () => {} });
  });

  after(async () => {
    await Promise.all([
      db.collection('forensic_log').deleteMany({}),
      db.collection('forensic_seq').deleteMany({}),
      db.collection('login_attempts').deleteMany({}),
      db.collection('ip_review_queue').deleteMany({}),
      db.collection('ip_allowlist').deleteMany({}),
    ]);
    await client.close();
  });

  test('cadena vacia verifica como valida', async () => {
    const result = await sentinelForensics.verifyChain();
    assert.equal(result.valid, true);
    assert.equal(result.totalEntries, 0);
  });

  test('appends via login attempt bloqueado forman cadena valida', async () => {
    const ip = '10.0.0.1';
    for (let i = 0; i < 5; i++) {
      await sentinelForensics.registerLoginAttempt({
        ip, username: `intruso${i}@gmail.com`, ok: false, reason: 'dominio_no_autorizado',
      });
    }
    const result = await sentinelForensics.verifyChain();
    assert.equal(result.valid, true);
    assert.equal(result.totalEntries, 5);
  });

  test('detecta manipulacion: alterar un campo de una entrada rompe la cadena', async () => {
    const before = await db.collection('forensic_log').find().sort({ seq: 1 }).toArray();
    assert.ok(before.length >= 1);
    const victim = before[0];

    // simula un atacante alterando el motivo de bloqueo directamente en Mongo,
    // sin pasar por appendForensicEntry (que es el unico camino legitimo)
    await db.collection('forensic_log').updateOne(
      { _id: victim._id },
      { $set: { reason: 'MANIPULADO: acceso autorizado' } },
    );

    const result = await sentinelForensics.verifyChain();
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'hash_mismatch');
    assert.equal(result.brokenAtSeq, victim.seq);
  });

  test('reanchorChain re-sella la cadena rota sin borrar historial', async () => {
    const before = await db.collection('forensic_log').countDocuments();
    const result = await sentinelForensics.reanchorChain('test-admin');
    assert.equal(result.reanchored, true);

    const after = await db.collection('forensic_log').countDocuments();
    assert.equal(after, before); // ningun registro se borro

    const verify = await sentinelForensics.verifyChain();
    assert.equal(verify.valid, true);
  });

  test('login exitoso no queda en la cadena forense (solo login_attempts)', async () => {
    const chainBefore = await sentinelForensics.verifyChain();
    await sentinelForensics.registerLoginAttempt({ ip: '10.0.0.2', username: 'marc@snficorp.com', ok: true });
    const chainAfter = await sentinelForensics.verifyChain();
    assert.equal(chainAfter.totalEntries, chainBefore.totalEntries); // no crece: exito no genera entrada forense
    assert.equal(chainAfter.valid, true);

    const attempt = await db.collection('login_attempts').findOne({ ip: '10.0.0.2', ok: true });
    assert.ok(attempt);
  });
});
