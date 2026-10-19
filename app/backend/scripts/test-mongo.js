#!/usr/bin/env node
/**
 * Mongo local de pruebas: un unico mongod en 127.0.0.1:27018 con replica set
 * de un nodo, para que las pruebas corran fuera de Atlas y con transacciones
 * reales (un mongod suelto no las soporta).
 *
 *   node scripts/test-mongo.js start | stop | status
 *
 * Es idempotente: start sobre un mongod ya en marcha no hace nada y stop sobre
 * uno parado tampoco. El binario y los datos viven fuera del repo
 * (TEST_MONGO_DIR, por defecto ~/mongo-test). El binario esperado es la misma
 * version que fija el despliegue; en Linux, si no esta en esa carpeta, se usa
 * el mongod del PATH o el indicado en TEST_MONGOD_BIN.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MongoClient } from 'mongodb';

const MONGOD_VERSION = '7.0.43';
const HOST = '127.0.0.1';
const PORT = 27018;
const REPLSET = 'rs0';
// Minimo que admite WiredTiger; con las bases de prueba sobra.
const CACHE_GB = '0.25';
// El oplog por defecto reserva un 5 % del disco libre; aqui no hace falta.
const OPLOG_MB = '128';
const WAIT_MS = 45_000;

export const TEST_MONGO_URI = `mongodb://${HOST}:${PORT}/?replicaSet=${REPLSET}`;
const DIRECT_URI = `mongodb://${HOST}:${PORT}/?directConnection=true`;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const BASE_DIR = path.resolve(process.env.TEST_MONGO_DIR || path.join(os.homedir(), 'mongo-test'));
const DB_PATH = path.join(BASE_DIR, 'data');
const LOG_PATH = path.join(BASE_DIR, 'mongod.log');
const PID_PATH = path.join(BASE_DIR, 'mongod.pid');

const exeName = process.platform === 'win32' ? 'mongod.exe' : 'mongod';
const defaultBin = path.join(BASE_DIR, `mongodb-${MONGOD_VERSION}`, 'bin', exeName);

function resolveBinary() {
  if (process.env.TEST_MONGOD_BIN) return process.env.TEST_MONGOD_BIN;
  if (existsSync(defaultBin)) return defaultBin;
  if (process.platform !== 'win32') return 'mongod';
  throw new Error(`No se encuentra mongod ${MONGOD_VERSION} en ${defaultBin}. Descarga el zip oficial de MongoDB y extrae bin/mongod.exe ahi.`);
}

function assertOutsideRepo() {
  const rel = path.relative(REPO_ROOT, BASE_DIR);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    throw new Error(`TEST_MONGO_DIR (${BASE_DIR}) no puede estar dentro del repositorio.`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, what) {
  const t0 = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - t0 > WAIT_MS) throw new Error(`Tiempo agotado esperando ${what}. Revisa ${LOG_PATH}.`);
    await sleep(500);
  }
}

// Conexion directa: funciona antes de iniciar el replica set y no depende de
// que el nodo ya sea primario.
async function withAdmin(fn) {
  const client = new MongoClient(DIRECT_URI, { serverSelectionTimeoutMS: 1500, connectTimeoutMS: 1500 });
  try {
    await client.connect();
    return await fn(client.db('admin'));
  } finally {
    await client.close().catch(() => {});
  }
}

async function probe() {
  try {
    return await withAdmin(async (admin) => ({ up: true, hello: await admin.command({ hello: 1 }) }));
  } catch {
    return { up: false };
  }
}

const isPrimary = (hello) => hello.setName === REPLSET && hello.isWritablePrimary === true;

async function initReplicaSet() {
  try {
    await withAdmin((admin) => admin.command({
      replSetInitiate: { _id: REPLSET, members: [{ _id: 0, host: `${HOST}:${PORT}` }] },
    }));
  } catch (err) {
    if (err?.code !== 23) throw err; // 23: ya inicializado
  }
}

async function waitPrimary() {
  return waitFor(async () => {
    const p = await probe();
    return p.up && isPrimary(p.hello) ? p.hello : null;
  }, 'que el nodo sea primario');
}

async function start() {
  assertOutsideRepo();
  const current = await probe();
  if (current.up) {
    if (current.hello.setName && current.hello.setName !== REPLSET) {
      throw new Error(`El puerto ${PORT} lo usa otro mongod (replica set "${current.hello.setName}"). No se toca.`);
    }
    if (!current.hello.setName) await initReplicaSet();
    await waitPrimary();
    console.log(`Mongo de pruebas ya en marcha en ${HOST}:${PORT} (${REPLSET}, primario).`);
    return;
  }

  const bin = resolveBinary();
  mkdirSync(DB_PATH, { recursive: true });
  const args = [
    '--port', String(PORT),
    '--bind_ip', HOST,
    '--replSet', REPLSET,
    '--dbpath', DB_PATH,
    '--wiredTigerCacheSizeGB', CACHE_GB,
    '--oplogSize', OPLOG_MB,
    '--logpath', LOG_PATH,
    '--logappend',
    '--pidfilepath', PID_PATH,
  ];
  const child = spawn(bin, args, { detached: true, stdio: 'ignore', windowsHide: true });
  let failure = null;
  child.once('error', (err) => { failure = `No se pudo lanzar ${bin}: ${err.message}`; });
  child.once('exit', (code) => { failure = `mongod termino al arrancar (codigo ${code}). Revisa ${LOG_PATH}.`; });
  child.unref();

  await waitFor(async () => {
    if (failure) throw new Error(failure);
    return (await probe()).up;
  }, 'que mongod acepte conexiones');
  child.removeAllListeners('exit');

  const hello = (await probe()).hello;
  if (!hello.setName) await initReplicaSet();
  await waitPrimary();
  console.log(`Mongo de pruebas en marcha en ${HOST}:${PORT} (${REPLSET}, primario). Datos: ${DB_PATH}`);
}

async function stop() {
  const current = await probe();
  if (!current.up) {
    console.log('Mongo de pruebas ya estaba parado.');
    return;
  }
  if (current.hello.setName !== REPLSET) {
    throw new Error(`El puerto ${PORT} no es el mongod de pruebas (${REPLSET}). No se toca.`);
  }
  // El servidor corta la conexion al apagarse: el error de red es lo esperado.
  await withAdmin((admin) => admin.command({ shutdown: 1 })).catch(() => {});
  await waitFor(async () => !(await probe()).up, 'que mongod se detenga');
  console.log('Mongo de pruebas parado.');
}

async function status() {
  const current = await probe();
  if (!current.up) {
    console.log('Mongo de pruebas parado.');
    return 1;
  }
  const info = await withAdmin(async (admin) => ({
    build: await admin.command({ buildInfo: 1 }),
    server: await admin.command({ serverStatus: 1 }),
  }));
  const role = isPrimary(current.hello) ? 'primario' : 'sin primario';
  console.log(`Mongo de pruebas en marcha: version ${info.build.version}, ${HOST}:${PORT}, replica set ${current.hello.setName ?? '(sin iniciar)'} (${role}), pid ${info.server.pid}, memoria residente ${info.server.mem.resident} MB.`);
  return isPrimary(current.hello) ? 0 : 1;
}

async function main() {
  const command = process.argv[2];
  if (command === 'start') return start();
  if (command === 'stop') return stop();
  if (command === 'status') return status();
  console.error('Uso: node scripts/test-mongo.js start | stop | status');
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code ?? 0), (err) => {
    console.error(err.message);
    process.exit(1);
  });
}
