import { MongoClient } from 'mongodb';
import dns from 'node:dns';

let client = null;
let elviraDb = null;

// Fix entorno dev: el resolver DNS interno de Node (c-ares) puede quedar
// apuntando a 127.0.0.1 (proxy/VPN/antivirus local) e ignorar el DNS del
// adaptador de red, rompiendo la resolucion SRV de mongodb+srv:// aunque
// nslookup del sistema resuelva bien. Forzamos DNS publicos solo para las
// consultas SRV de Node. No afecta a mongodb:// sin SRV ni a produccion
// con DNS correctamente configurado (setServers es idempotente).
if (process.env.MONGO_URI?.startsWith('mongodb+srv://')) {
  dns.setServers(['8.8.8.8', '1.1.1.1']);
}

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

// Parametrizada por `db` para que un tenant nuevo (ver tenant-registry.js) corra
// exactamente los mismos indices que el tenant por defecto, sin duplicar la lista.
export async function ensureTenantIndexes(db) {
  // Auth: sesiones expiran solas via TTL index (Mongo purga tras exp, sin filtrar en memoria)
  await db.collection('sessions').createIndex({ exp: 1 }, { expireAfterSeconds: 0 });
  await db.collection('users').createIndex({ role: 1 });

  await db.collection('sheets').createIndex({ user: 1 });
  await db.collection('companies').createIndex({ sheetId: 1 });
  await db.collection('companies').createIndex({ cnmc: 1 });
  // Historial de busquedas de Reff (routes/reff-crm.routes.js): 48 h de vida por TTL
  await db.collection('search_history').createIndex({ user: 1, createdAt: -1 });
  await db.collection('search_history').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await db.collection('u2_calculos').createIndex({ creadoAt: -1 });
  await db.collection('bus_history').createIndex({ ts: -1 });
  await db.collection('bus_history').createIndex({ origin: 1, state: 1, type: 1 });

  // Sentinel · trazabilidad forense IP
  await db.collection('forensic_log').createIndex({ seq: 1 }, { unique: true });
  await db.collection('forensic_log').createIndex({ ip: 1 });
  await db.collection('forensic_log').createIndex({ mesa: 1, sensitive: 1, blocked: 1 });
  await db.collection('rate_limits').createIndex({ key: 1, ts: -1 });
  await db.collection('rate_limits').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await db.collection('ip_excess_log').createIndex({ ip: 1, path: 1, ts: -1 });
  await db.collection('ip_review_queue').createIndex({ ip: 1 }, { unique: true });

  // Sentinel · Behavioral Analytics (profiling de comportamiento por usuario)
  await db.collection('user_review_queue').createIndex({ user: 1 }, { unique: true });
  await db.collection('behavior_alerts').createIndex({ ts: -1 });
  await db.collection('behavior_alerts').createIndex({ user: 1, type: 1 });

  // Pactvm Viridi · cumplimiento bio-ambiental (certificado CIBE, politicas, accesos)
  await db.collection('pactvm_cibe').createIndex({ status: 1 });
  await db.collection('pactvm_policies').createIndex({ category: 1, active: 1 });
  await db.collection('pactvm_access_rules').createIndex({ status: 1, scope: 1 });

  // S-NFI F&L · Hub fiscal y legal (fl-hub.js). Las colecciones de la version
  // anterior (fl_licencias, fl_poderes, fl_matriz_riesgo...) siguen en Mongo con
  // sus indices: ya no las lee nadie, pero no se borran (retencion).
  await db.collection('fl_modelos').createIndex({ sociedad_id: 1, fecha_limite: 1 });
  await db.collection('fl_notificaciones').createIndex({ estado: 1, puesta_disposicion: -1 });
  await db.collection('fl_juntas').createIndex({ sociedad_id: 1, fecha: -1 });
  await db.collection('fl_apoderamientos').createIndex({ fecha_caducidad: 1 });
  await db.collection('fl_clm_contratos').createIndex({ fecha_vencimiento: 1 });
  await db.collection('fl_alertas_normativas').createIndex({ fecha_publicacion: -1 });
  await db.collection('fl_alertas_normativas').createIndex({ sociedad_id: 1 });
  await db.collection('fl_log').createIndex({ seq: 1 }, { unique: true });
  await db.collection('fl_log').createIndex({ entidad: 1, refId: 1 });
  // Expediente Fiscal y Juridico Impecable (CRM documental + adjuntos GridFS)
  await db.collection('fl_expediente_docs').createIndex({ bloque: 1, orden: 1 });
  await db.collection('fl_expediente_docs').createIndex({ fecha_caducidad: 1 });
  await db.collection('fl_expediente_docs').createIndex({ estado: 1 });
  await db.collection('fl_expediente_docs').createIndex({ confidencial: 1 });
  await db.collection('fl_expediente_files.files').createIndex({ 'metadata.doc_id': 1 });
  // Clave de cifrado del expediente: SOLO env FL_EXPEDIENTE_ENC_KEY (retirado
  // el fallback fl_expediente_keys en Mongo, 2026-09-20) — sin coleccion propia.

  // S-NFI Finance · CRM de empresas + archivo documental
  await db.collection('finance_companies').createIndex({ name: 1 });
  await db.collection('finance_companies').createIndex({ relation: 1, status: 1 });
  await db.collection('finance_company_notes').createIndex({ companyId: 1, createdAt: -1 });
  await db.collection('finance_company_docs.files').createIndex({ 'metadata.company_id': 1, 'metadata.folder': 1 });

  // Herzog Central · bunker receptor (summary del dashboard hacia COLLSCAN sin estos)
  await db.collection('herzog_metrics').createIndex({ createdAt: -1 });
  await db.collection('herzog_metrics').createIndex({ source: 1 });
  await db.collection('herzog_metrics').createIndex({ department: 1 });
  await db.collection('herzog_notes').createIndex({ createdAt: -1 });
  await db.collection('herzog_notes').createIndex({ department: 1 });

  // Herzog LaW · marcos normativos, zonas ATEX, certificados y log encadenado
  await db.collection('herzog_law_frameworks').createIndex({ kind: 1, priority: 1 });
  await db.collection('herzog_law_frameworks').createIndex({ expiresAt: 1 });
  await db.collection('herzog_law_zones').createIndex({ zone: 1 });
  await db.collection('herzog_law_documents.files').createIndex({ 'metadata.framework_id': 1 });
  await db.collection('herzog_law_log').createIndex({ seq: 1 }, { unique: true });

  // S-EAGLE · invitaciones de inspeccion y sesiones de inspector (TTL: Mongo las borra al
  // vencer; la traza de cada acceso queda en seagle_log)
  await db.collection('seagle_log').createIndex({ seq: 1 }, { unique: true });
  await db.collection('seagle_invitations').createIndex({ createdAt: -1 });
  await db.collection('seagle_inspector_sessions').createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 });
  await db.collection('seagle_inspector_sessions').createIndex({ invitationId: 1, endedAt: 1 });

  // OPHS Framework · OPS (telemetria) y PAIA (analitica), leidos por el Cockpit
  await db.collection('ops_nodes').createIndex({ circuitState: 1 });
  await db.collection('ops_readings').createIndex({ ts: -1 });
  await db.collection('paia_analyses').createIndex({ createdAt: -1 });
}

async function ensureIndexes() {
  await ensureTenantIndexes(elviraDb);

  // Herzog Central (auditoria OPHS) vive en db 'reff', no 'elvira' — mismo
  // cliente, otra db (ver ophs-cockpit.js y pactum-viridi.js).
  await client.db('reff').collection('herzog_audits').createIndex({ created_at: -1 });
}

export async function closeMongo() {
  if (client) {
    await client.close();
    client = null;
    elviraDb = null;
  }
}

// Mongo standalone (docker-compose, k8s/03-mongo.yaml con replicas:1 y sin --replSet) no soporta
// transacciones. El driver las implementa sobre retryable writes y rechaza ANTES de tocar el server
// si la URI no lleva retryWrites=false (verificado contra un mongod 7.0.43 standalone real: el error
// es MongoServerError "This MongoDB deployment does not support retryable writes...", sin code/codeName
// — no el IllegalOperation/code 20 que documenta MongoDB para cuando si llega al servidor). Con
// retryWrites=false si llega al servidor y ese es el error que documenta MongoDB (code 20).
export function isTransactionUnsupported(err) {
  const msg = String(err?.message || '');
  if (err?.code === 20 && /replica set member or mongos/i.test(msg)) return true; // llego al servidor (retryWrites=false)
  if (/does not support retryable writes/i.test(msg)) return true; // rechazado por el driver antes de llegar al servidor
  return false;
}

export async function withTransaction(fn, client = getMongoClient()) {
  const session = client.startSession();
  try {
    let result;
    try {
      await session.withTransaction(async () => {
        result = await fn(session);
      });
    } catch (err) {
      if (!isTransactionUnsupported(err)) throw err;
      // Sin transaccion la operacion no es atomica entre documentos, pero sigue funcionando
      // (unico uso actual: borrado en cascada hoja -> empresas). Como el servidor rechazo la
      // primera operacion, no se habia escrito nada y repetir fn sin sesion es seguro.
      console.warn('[mongo] Mongo standalone: transacciones no soportadas, se ejecuta sin transaccion');
      result = await fn(undefined);
    }
    return result;
  } finally {
    await session.endSession();
  }
}
