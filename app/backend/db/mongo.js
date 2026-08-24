import { MongoClient } from 'mongodb';

let client = null;
let elviraDb = null;

export async function connectMongo() {
  if (client) return client;
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI no definida.');
  client = new MongoClient(uri);
  await client.connect();
  elviraDb = client.db('elvira');
  await ensureIndexes();
  return client;
}

export function getMongoClient() {
  if (!client) throw new Error('Mongo no conectado. Llama connectMongo() primero.');
  return client;
}

export function getElviraDb() {
  if (!elviraDb) throw new Error('Mongo no conectado. Llama connectMongo() primero.');
  return elviraDb;
}

async function ensureIndexes() {
  // Auth: sesiones expiran solas via TTL index (Mongo purga tras exp, sin filtrar en memoria)
  await elviraDb.collection('sessions').createIndex({ exp: 1 }, { expireAfterSeconds: 0 });
  await elviraDb.collection('users').createIndex({ role: 1 });

  await elviraDb.collection('sheets').createIndex({ user: 1 });
  await elviraDb.collection('companies').createIndex({ sheetId: 1 });
  await elviraDb.collection('companies').createIndex({ cnmc: 1 });
  await elviraDb.collection('u2_calculos').createIndex({ creadoAt: -1 });
  await elviraDb.collection('bus_history').createIndex({ ts: -1 });
  await elviraDb.collection('bus_history').createIndex({ origin: 1, state: 1, type: 1 });

  // Sentinel · trazabilidad forense IP
  await elviraDb.collection('forensic_log').createIndex({ seq: 1 }, { unique: true });
  await elviraDb.collection('forensic_log').createIndex({ ip: 1 });
  await elviraDb.collection('forensic_log').createIndex({ mesa: 1, sensitive: 1, blocked: 1 });
  await elviraDb.collection('rate_limits').createIndex({ key: 1, ts: -1 });
  await elviraDb.collection('rate_limits').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await elviraDb.collection('ip_excess_log').createIndex({ ip: 1, path: 1, ts: -1 });
  await elviraDb.collection('ip_review_queue').createIndex({ ip: 1 }, { unique: true });

  // S-NFI Factory · cadena de suministro industrial
  await elviraDb.collection('factory_assembly').createIndex({ status: 1 });
  await elviraDb.collection('factory_logistics').createIndex({ status: 1 });
  await elviraDb.collection('factory_inventory').createIndex({ category: 1 });
  await elviraDb.collection('factory_maintenance').createIndex({ status: 1, scheduledAt: 1 });

  // S-NFI F&L · custodia legal (NDAs, contratos, licencias, expediente OEPM)
  await elviraDb.collection('fl_ndas').createIndex({ status: 1, validTo: 1 });
  await elviraDb.collection('fl_contracts').createIndex({ status: 1, validTo: 1 });
  await elviraDb.collection('fl_licenses').createIndex({ status: 1, validTo: 1 });
  await elviraDb.collection('fl_documents.files').createIndex({ 'metadata.entity_kind': 1, 'metadata.entity_id': 1 });

  // Pactvm Viridi · cumplimiento bio-ambiental (certificado CIBE, politicas, accesos)
  await elviraDb.collection('pactvm_cibe').createIndex({ status: 1 });
  await elviraDb.collection('pactvm_policies').createIndex({ category: 1, active: 1 });
  await elviraDb.collection('pactvm_access_rules').createIndex({ status: 1, scope: 1 });

  // Data Foundry · pipeline de ingesta asincrona (gateway HMAC + salas limpias)
  await elviraDb.collection('foundry_nodes').createIndex({ nodeId: 1 }, { unique: true });
  await elviraDb.collection('foundry_log').createIndex({ seq: 1 }, { unique: true });
  await elviraDb.collection('foundry_herzog_records').createIndex({ seq: 1 }, { unique: true });
  await elviraDb.collection('foundry_herzog_records').createIndex({ nodeId: 1, recordedAt: -1 });
  await elviraDb.collection('paia_stream_stats').createIndex({ nodeId: 1 }, { unique: true });
  // u2_timeseries: indices creados por el worker U-2 (hilo independiente)
}

export async function closeMongo() {
  if (client) {
    await client.close();
    client = null;
    elviraDb = null;
  }
}

export async function withTransaction(fn) {
  const session = getMongoClient().startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}
