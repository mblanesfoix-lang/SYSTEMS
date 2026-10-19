/**
 * Logs inmutables encadenados por hash, comunes a las mesas con log propio.
 * Cada entrada guarda `seq`, `prevHash` y `hash`; el hash cubre la entrada y el
 * hash de la anterior, asi que alterar o quitar una entrada rompe la cadena.
 *
 * Las entradas nuevas llevan canon: 2 (serializacion canonica profunda: el hash
 * cubre tambien el contenido anidado). Las heredadas, sin marca, se verifican
 * con el algoritmo de siempre y nunca se reescriben; una cadena puede mezclar
 * ambas.
 */

import crypto from 'node:crypto';

const GENESIS_HASH = '0'.repeat(64);
const MAX_APPEND_ATTEMPTS = 5;

/* Algoritmo heredado: JSON.stringify con la lista de claves de primer nivel
   como replacer. Se conserva solo para verificar entradas antiguas. */
export function canonicalV1(entry) {
  return JSON.stringify(entry, Object.keys(entry).sort());
}

/* Serializacion canonica profunda: claves ordenadas a cualquier nivel. */
export function canonicalV2(value) {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalV2(v === undefined ? null : v)).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalV2(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/* Reduce la entrada a JSON puro (sin undefined, fechas como texto) para que lo
   que se hashea sea exactamente lo que Mongo devuelve al leerla. */
function toPlainJson(entry) {
  return JSON.parse(JSON.stringify(entry));
}

/* Anade una entrada al final del log `logName`. Reintenta si otra escritura se
   adelanta con el mismo seq (solo ocurre si la coleccion tiene indice unico
   sobre seq). */
export async function appendChained(mongo, logName, entry) {
  const col = mongo.collection(logName);
  const plain = toPlainJson(entry);
  for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt += 1) {
    const tail = await col.find().sort({ seq: -1 }).limit(1).next();
    const seq = tail ? tail.seq + 1 : 1;
    const prevHash = tail ? tail.hash : GENESIS_HASH;
    const hash = sha256(prevHash + canonicalV2({ ...plain, canon: 2, seq }));
    const doc = { _id: crypto.randomUUID(), ...plain, canon: 2, seq, prevHash, hash, createdAt: new Date().toISOString() };
    try {
      await col.insertOne(doc);
      return doc;
    } catch (err) {
      if (err?.code !== 11000) throw err;
    }
  }
  throw new Error(`${logName}: no se pudo encadenar la entrada tras ${MAX_APPEND_ATTEMPTS} intentos`);
}

/* `entries` debe venir ordenado por seq ascendente. */
export function verifyChain(entries) {
  let prev = GENESIS_HASH;
  for (const entry of entries) {
    const { _id, seq, prevHash, hash, createdAt, ...rest } = entry;
    const body = { ...rest, seq };
    const expected = sha256(prev + (rest.canon === 2 ? canonicalV2(body) : canonicalV1(body)));
    if (expected !== hash || prevHash !== prev) return { valid: false, totalEntries: entries.length, brokenAtSeq: seq };
    prev = hash;
  }
  return { valid: true, totalEntries: entries.length, brokenAtSeq: null };
}

export async function verifyLog(mongo, logName) {
  const entries = await mongo.collection(logName).find({}).sort({ seq: 1 }).toArray();
  return verifyChain(entries);
}
