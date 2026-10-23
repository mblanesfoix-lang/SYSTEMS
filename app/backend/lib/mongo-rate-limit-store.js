/**
 * Almacén de express-rate-limit sobre Mongo, para que todas las réplicas compartan el
 * mismo contador por cliente. Implementa la interfaz Store de express-rate-limit 8
 * (init, get, increment, decrement, resetKey, resetAll; localKeys y prefix).
 *
 * Ventana fija, como el MemoryStore de la librería: un documento por clave con los
 * golpes y el fin de su ventana. El incremento es una sola operación atómica que abre
 * una ventana nueva si la anterior ya terminó, así dos réplicas no se pisan. Igual que
 * rate_limits de Sentinel, un índice TTL sobre resetTime borra los contadores vencidos;
 * mientras el TTL no pasa, la propia operación los trata como caducados.
 *
 * Global, no por tenant: el límite corre antes de la sesión. Cada limitador usa su propio
 * prefix, y la librería lo exige para no contar dos veces una misma petición.
 */

export const RATE_LIMIT_COLLECTION = 'rate_limit_windows';

export async function ensureRateLimitIndexes(db) {
  await db.collection(RATE_LIMIT_COLLECTION).createIndex({ resetTime: 1 }, { expireAfterSeconds: 0 });
}

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export class MongoRateLimitStore {
  constructor({ db, prefix }) {
    if (!db) throw new TypeError('MongoRateLimitStore: falta db');
    if (!prefix) throw new TypeError('MongoRateLimitStore: falta prefix');
    this.db = db;
    this.prefix = prefix;
    this.localKeys = false;
    this.windowMs = 60 * 1000;
  }

  init(options) {
    this.windowMs = options.windowMs;
  }

  get col() {
    return this.db.collection(RATE_LIMIT_COLLECTION);
  }

  id(key) {
    return `${this.prefix}${key}`;
  }

  async get(key) {
    const doc = await this.col.findOne({ _id: this.id(key) });
    if (!doc || doc.resetTime <= new Date()) return undefined;
    return { totalHits: doc.hits, resetTime: doc.resetTime };
  }

  async increment(key) {
    const now = new Date();
    const open = { $gt: ['$resetTime', now] };
    const update = [{
      $set: {
        hits: { $cond: [open, { $add: ['$hits', 1] }, 1] },
        resetTime: { $cond: [open, '$resetTime', new Date(now.getTime() + this.windowMs)] },
      },
    }];
    const options = { upsert: true, returnDocument: 'after' };
    let doc;
    try {
      doc = await this.col.findOneAndUpdate({ _id: this.id(key) }, update, options);
    } catch (err) {
      // Dos réplicas crean a la vez el contador de un cliente nuevo: una gana la
      // inserción y la otra repite sobre el documento ya creado.
      if (err?.code !== 11000) throw err;
      doc = await this.col.findOneAndUpdate({ _id: this.id(key) }, update, options);
    }
    return { totalHits: doc.hits, resetTime: doc.resetTime };
  }

  async decrement(key) {
    await this.col.updateOne(
      { _id: this.id(key), resetTime: { $gt: new Date() }, hits: { $gt: 0 } },
      { $inc: { hits: -1 } },
    );
  }

  async resetKey(key) {
    await this.col.deleteOne({ _id: this.id(key) });
  }

  async resetAll() {
    await this.col.deleteMany({ _id: { $regex: `^${escapeRegex(this.prefix)}` } });
  }
}
