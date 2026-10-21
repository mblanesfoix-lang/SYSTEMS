/**
 * Secretos de Pactvm Viridi guardados en Mongo: claves de CIBE y códigos de acceso.
 *
 * Quien lea solo la base (una copia de seguridad, acceso al clúster) no debe obtener
 * nada utilizable. De una clave del servidor (PACTVM_DATA_KEY, 32 bytes en hex) salen
 * dos subclaves independientes con HKDF-SHA256:
 *   - AES-256-GCM para lo que hay que volver a leer (la tokenKey de cada certificado
 *     CIBE y la clave privada del búnker). El contexto (colección, campo y documento) va
 *     como dato autenticado: un valor copiado a otro documento no se descifra.
 *   - HMAC-SHA256 para lo que solo hay que comprobar (códigos de 6 dígitos): sin la
 *     clave no se pueden probar contra la base las combinaciones posibles.
 * La clave se lee en el primer uso, no al importar el módulo: server.js carga los .env
 * locales después de evaluar sus imports.
 */
import crypto from 'node:crypto';
import { DEV_DATA_KEY } from '../config.js';
import { safeEqual } from './safe-compare.js';

const PREFIX = 'sealed:v1:';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function resolveDataKey(
  env = { PACTVM_DATA_KEY: process.env.PACTVM_DATA_KEY, NODE_ENV: process.env.NODE_ENV },
  logger = console,
) {
  const configured = env.PACTVM_DATA_KEY;
  const production = env.NODE_ENV === 'production';
  if (!configured) {
    if (production) throw new Error('PACTVM_DATA_KEY es obligatoria en producción.');
    logger.warn('[data-seal] PACTVM_DATA_KEY no está definida: los secretos de Pactvm se protegen con la clave de desarrollo.');
    return Buffer.from(DEV_DATA_KEY, 'hex');
  }
  if (!/^[0-9a-fA-F]{64}$/.test(configured)) {
    throw new Error('PACTVM_DATA_KEY debe tener 64 caracteres hexadecimales (32 bytes).');
  }
  if (production && safeEqual(configured.toLowerCase(), DEV_DATA_KEY)) {
    throw new Error('PACTVM_DATA_KEY no puede ser la clave de desarrollo en producción.');
  }
  return Buffer.from(configured, 'hex');
}

const subkey = (key, label) => Buffer.from(crypto.hkdfSync('sha256', key, Buffer.alloc(0), label, 32));

/** true si el valor ya está cifrado por este módulo (y no es un valor heredado en claro). */
export const isSealed = (value) => typeof value === 'string' && value.startsWith(PREFIX);

export function createDataSeal(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('la clave de datos debe tener 32 bytes');
  const encKey = subkey(key, 'systems-data-seal:aes-256-gcm');
  const macKey = subkey(key, 'systems-data-seal:hmac-sha256');

  function seal(plaintext, context) {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(Buffer.from(String(context), 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    return `${PREFIX}${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${ciphertext.toString('base64url')}`;
  }

  /* Un valor heredado en claro se devuelve tal cual hasta que se selle
     (scripts/seal-pactvm-secrets.js). Lanza si el valor sellado no es de esta clave o
     de este contexto, o si está alterado. */
  function open(value, context) {
    if (!isSealed(value)) return value;
    const parts = value.slice(PREFIX.length).split(':');
    if (parts.length !== 3) throw new Error('valor sellado con formato invalido');
    const [iv, tag, ciphertext] = parts.map((p) => Buffer.from(p, 'base64url'));
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('valor sellado con formato invalido');
    const decipher = crypto.createDecipheriv('aes-256-gcm', encKey, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(String(context), 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }

  const mac = (context, value) => crypto.createHmac('sha256', macKey).update(`${context}\0${value}`).digest('hex');

  return { seal, open, mac };
}

let shared = null;

/** Instancia del proceso, creada en el primer uso con la clave del entorno. */
export function getDataSeal() {
  shared ??= createDataSeal(resolveDataKey());
  return shared;
}
