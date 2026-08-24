/**
 * Vault de secretos minimo, sin infraestructura externa (AES-256-GCM, node:crypto).
 *
 * Problema: .env vive solo en disco del servidor, sin respaldo cifrado versionable.
 * Si el servidor se pierde, los secretos (API keys, seed passwords, JWT secret) se
 * pierden con el. Este script cifra .env -> .env.vault (committeable, sin riesgo:
 * illegible sin la clave) usando una clave que NUNCA se commitea.
 *
 * Uso:
 *   node scripts/env-vault.js encrypt [dir]   # dir/.env -> dir/.env.vault, imprime la clave UNA VEZ
 *   node scripts/env-vault.js decrypt [dir]   # dir/.env.vault -> dir/.env (requiere ENV_VAULT_KEY)
 * dir por defecto: app/backend (donde vive este script). Pasa otra ruta para
 * cifrar el .env de otro paquete (ej. Elvi-Ra/Mesas/Rëff).
 *
 * La clave se pasa via env var ENV_VAULT_KEY (hex, 32 bytes) al descifrar.
 * Guardar la clave en el gestor de secretos de la plataforma de despliegue
 * (panel Coolify/host, o gestor de contraseñas del equipo) — nunca en el repo.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TARGET_DIR = process.argv[3] ? path.resolve(process.argv[3]) : path.join(__dirname, '..');
const ENV_FILE = path.join(TARGET_DIR, '.env');
const VAULT_FILE = path.join(TARGET_DIR, '.env.vault');

const ALGO = 'aes-256-gcm';

function encrypt() {
  if (!fs.existsSync(ENV_FILE)) {
    console.error(`[env-vault] no existe ${ENV_FILE}`);
    process.exit(1);
  }
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const plaintext = fs.readFileSync(ENV_FILE, 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const payload = {
    algo: ALGO,
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
    data: ciphertext.toString('hex'),
    encryptedAt: new Date().toISOString(),
  };
  fs.writeFileSync(VAULT_FILE, JSON.stringify(payload, null, 2));

  console.log(`[env-vault] .env cifrado -> ${VAULT_FILE} (seguro de commitear)`);
  console.log('[env-vault] CLAVE (guardar en gestor de secretos, NO en el repo, se muestra una sola vez):');
  console.log(key.toString('hex'));
}

function decrypt() {
  const keyHex = process.env.ENV_VAULT_KEY;
  if (!keyHex) {
    console.error('[env-vault] ENV_VAULT_KEY no definida. Exporta la clave antes de descifrar.');
    process.exit(1);
  }
  if (!fs.existsSync(VAULT_FILE)) {
    console.error(`[env-vault] no existe ${VAULT_FILE}`);
    process.exit(1);
  }
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) {
    console.error('[env-vault] ENV_VAULT_KEY invalida (se esperan 32 bytes en hex)');
    process.exit(1);
  }
  const payload = JSON.parse(fs.readFileSync(VAULT_FILE, 'utf8'));
  const decipher = crypto.createDecipheriv(payload.algo, key, Buffer.from(payload.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(payload.authTag, 'hex'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(payload.data, 'hex')),
    decipher.final(),
  ]).toString('utf8');

  if (fs.existsSync(ENV_FILE)) {
    fs.copyFileSync(ENV_FILE, `${ENV_FILE}.bak.${Date.now()}`);
    console.log('[env-vault] .env existente respaldado antes de sobreescribir');
  }
  fs.writeFileSync(ENV_FILE, plaintext);
  console.log(`[env-vault] .env restaurado desde ${VAULT_FILE}`);
}

const cmd = process.argv[2];
if (cmd === 'encrypt') encrypt();
else if (cmd === 'decrypt') decrypt();
else {
  console.error('Uso: node scripts/env-vault.js encrypt|decrypt');
  process.exit(1);
}
