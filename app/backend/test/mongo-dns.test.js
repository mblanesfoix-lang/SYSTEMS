/**
 * El ajuste de DNS de db/mongo.js solo debe aplicarse a URIs mongodb+srv://.
 * Cada caso corre en un proceso aparte porque el ajuste se evalua al cargar el
 * modulo. No necesita Mongo.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BACKEND_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const SCRIPT = `
import dns from 'node:dns';
const before = dns.getServers();
await import('./db/mongo.js');
console.log(JSON.stringify({ before, after: dns.getServers() }));
`;

function loadWith(mongoUri) {
  const env = { ...process.env };
  delete env.MONGO_URI;
  if (mongoUri !== undefined) env.MONGO_URI = mongoUri;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', SCRIPT], { cwd: BACKEND_DIR, env, encoding: 'utf8' });
  return JSON.parse(out);
}

describe('db/mongo.js: ajuste de DNS', () => {
  test('con mongodb+srv:// fija los DNS publicos', () => {
    const { after } = loadWith('mongodb+srv://usuario:clave@cluster.example.net/elvira');
    assert.deepEqual(after, ['8.8.8.8', '1.1.1.1']);
  });

  test('con mongodb:// no toca los DNS', () => {
    const { before, after } = loadWith('mongodb://127.0.0.1:27018/?replicaSet=rs0');
    assert.deepEqual(after, before);
  });

  test('sin MONGO_URI no toca los DNS', () => {
    const { before, after } = loadWith(undefined);
    assert.deepEqual(after, before);
  });
});
