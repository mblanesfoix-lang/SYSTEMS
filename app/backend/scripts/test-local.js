#!/usr/bin/env node
/**
 * Pruebas del backend contra el mongod local de pruebas (ver test-mongo.js),
 * nunca contra el MONGO_URI del .env. Una variable ya presente en el entorno
 * gana sobre --env-file, asi que el .env solo aporta el resto de claves.
 * Se fija desde Node y no en el script de npm para que funcione igual en
 * Windows y en Linux. La concurrencia se limita a 2 ficheros a la vez para
 * no saturar equipos con poca memoria.
 *
 *   node scripts/test-local.js [ficheros...]
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEST_MONGO_URI } from './test-mongo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = path.join(__dirname, '..');

const ready = spawnSync(process.execPath, [path.join(__dirname, 'test-mongo.js'), 'status'], { stdio: 'inherit' });
if (ready.status !== 0) {
  console.error('El mongod de pruebas no esta listo. Arrancalo con: npm run test:mongo:start');
  process.exit(1);
}

const files = process.argv.slice(2);
const args = [
  ...(existsSync(path.join(BACKEND_DIR, '.env')) ? ['--env-file=.env'] : []),
  '--test',
  '--test-concurrency=2',
  ...(files.length ? files : ['test/**/*.test.js']),
];
const run = spawnSync(process.execPath, args, {
  cwd: BACKEND_DIR,
  stdio: 'inherit',
  env: { ...process.env, MONGO_URI: TEST_MONGO_URI },
});
process.exit(run.status ?? 1);
