/**
 * Migracion one-shot: data/users.json + data/sessions.json -> colecciones
 * Mongo `users` / `sessions`. Idempotente (upsert por _id=email/sha256 del token).
 * No borra los JSON originales: los renombra a *.migrated.json como respaldo.
 *
 * Uso: node --env-file=.env scripts/migrate-auth-to-mongo.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectMongo, getElviraDb, closeMongo } from '../db/mongo.js';
import { hashSessionToken } from '../routes/auth.routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

function loadJson(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (err) { console.error(`[migrate] ${file} corrupto: ${err.message}`); return null; }
}

function backupFile(file) {
  if (!fs.existsSync(file)) return;
  const dest = `${file}.migrated.json`;
  fs.renameSync(file, dest);
  console.log(`[migrate] respaldo: ${path.basename(file)} -> ${path.basename(dest)}`);
}

async function main() {
  await connectMongo();
  const mongo = getElviraDb();

  const users = loadJson(USERS_FILE);
  if (users) {
    let count = 0;
    for (const [email, { passwordHash, role }] of Object.entries(users)) {
      if (!passwordHash || !role) { console.warn(`[migrate] usuario ${email} incompleto, se salta`); continue; }
      await mongo.collection('users').updateOne(
        { _id: email },
        { $set: { passwordHash, role }, $setOnInsert: { createdAt: new Date().toISOString() } },
        { upsert: true }
      );
      count++;
    }
    console.log(`[migrate] ${count} usuarios migrados a Mongo (coleccion 'users')`);
    backupFile(USERS_FILE);
  } else {
    console.log('[migrate] no hay data/users.json, nada que migrar (seed por env se encargara)');
  }

  const sessions = loadJson(SESSIONS_FILE);
  if (sessions && Object.keys(sessions).length > 0) {
    const now = Date.now();
    let count = 0;
    for (const [token, s] of Object.entries(sessions)) {
      if (!s.exp || s.exp <= now) continue; // no migrar sesiones ya expiradas
      await mongo.collection('sessions').updateOne(
        { _id: hashSessionToken(token) }, // como el login: solo el hash del token
        { $set: { user: s.user, role: s.role, exp: new Date(s.exp) } },
        { upsert: true }
      );
      count++;
    }
    console.log(`[migrate] ${count} sesiones activas migradas a Mongo (coleccion 'sessions')`);
    backupFile(SESSIONS_FILE);
  } else {
    console.log('[migrate] no hay sesiones activas en data/sessions.json, nada que migrar');
    if (sessions) backupFile(SESSIONS_FILE);
  }

  await closeMongo();
  console.log('[migrate] listo.');
}

main().catch(err => {
  console.error('[migrate] fallo:', err);
  process.exit(1);
});
