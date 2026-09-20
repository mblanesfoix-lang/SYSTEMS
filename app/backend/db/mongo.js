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

  // Sentinel · Behavioral Analytics (profiling de comportamiento por usuario)
  await elviraDb.collection('user_review_queue').createIndex({ user: 1 }, { unique: true });
  await elviraDb.collection('behavior_alerts').createIndex({ ts: -1 });
  await elviraDb.collection('behavior_alerts').createIndex({ user: 1, type: 1 });

  // Pactvm Viridi · cumplimiento bio-ambiental (certificado CIBE, politicas, accesos)
  await elviraDb.collection('pactvm_cibe').createIndex({ status: 1 });
  await elviraDb.collection('pactvm_policies').createIndex({ category: 1, active: 1 });
  await elviraDb.collection('pactvm_access_rules').createIndex({ status: 1, scope: 1 });

  // S-NFI F&L · Audit Legal (licencias multi-planta + matriz de responsabilidad + poderes)
  await elviraDb.collection('fl_licencias').createIndex({ id_instalacion: 1 });
  await elviraDb.collection('fl_licencias').createIndex({ fecha_vencimiento: 1 });
  await elviraDb.collection('fl_licencias').createIndex({ dependencia: 1, estado_tramite: 1 });
  await elviraDb.collection('fl_metricas').createIndex({ id_licencia: 1, tipo_parametro: 1 });
  await elviraDb.collection('fl_condicionantes').createIndex({ id_licencia: 1, estado_cumplimiento: 1 });
  await elviraDb.collection('fl_evidencias').createIndex({ id_condicionante: 1 });
  await elviraDb.collection('fl_inspecciones').createIndex({ id_instalacion: 1, estatus_resolucion: 1 });
  await elviraDb.collection('fl_hitos').createIndex({ project_id: 1 });
  await elviraDb.collection('fl_matriz_riesgo').createIndex({ project_id: 1, status: 1 });
  await elviraDb.collection('fl_matriz_riesgo').createIndex({ milestone_id: 1 });
  await elviraDb.collection('fl_poderes').createIndex({ fecha_caducidad: 1 });
  await elviraDb.collection('fl_poderes').createIndex({ estado: 1 });
  await elviraDb.collection('fl_log').createIndex({ seq: 1 }, { unique: true });
  // Expediente Fiscal y Juridico Impecable (CRM documental + adjuntos GridFS)
  await elviraDb.collection('fl_expediente_docs').createIndex({ bloque: 1, orden: 1 });
  await elviraDb.collection('fl_expediente_docs').createIndex({ fecha_caducidad: 1 });
  await elviraDb.collection('fl_expediente_docs').createIndex({ estado: 1 });
  await elviraDb.collection('fl_expediente_docs').createIndex({ confidencial: 1 });
  await elviraDb.collection('fl_expediente_files.files').createIndex({ 'metadata.doc_id': 1 });
  // Clave de cifrado del expediente: SOLO env FL_EXPEDIENTE_ENC_KEY (retirado
  // el fallback fl_expediente_keys en Mongo, 2026-09-20) — sin coleccion propia.

  // S-NFI Finance · CRM de empresas + archivo documental
  await elviraDb.collection('finance_companies').createIndex({ name: 1 });
  await elviraDb.collection('finance_companies').createIndex({ relation: 1, status: 1 });
  await elviraDb.collection('finance_company_notes').createIndex({ companyId: 1, createdAt: -1 });
  await elviraDb.collection('finance_company_docs.files').createIndex({ 'metadata.company_id': 1, 'metadata.folder': 1 });

  // Lab · pipeline de ingesta asincrona (gateway HMAC + salas limpias)
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
