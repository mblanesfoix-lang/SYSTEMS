/**
 * Registro de tenants · resuelve que `Db` de Mongo corresponde a cada tenant.
 *
 * Fase 1 (shared-cluster): todos los tenants viven en el mismo MongoClient ya
 * conectado por connectMongo() (db/mongo.js), solo cambia el nombre de la db.
 * Fase 2 (dedicated-cluster): un tenant puede declarar su propio MONGO_URI y
 * este modulo abre un MongoClient nuevo solo para el, sin tocar el resto del
 * codigo (mountX sigue recibiendo un Db crudo igual en ambos casos).
 *
 * La lista de tenants vive en `elvira_control.tenants`, una db de control
 * separada de cualquier db de tenant — para que ningun tenant pueda leer la
 * lista de los demas via su propia conexion.
 */
import { MongoClient } from 'mongodb';
import { getMongoClient } from './mongo.js';
import { ensureTenantIndexes } from './mongo.js';

const CONTROL_DB_NAME = 'elvira_control';

// tenantId -> { client, db }
const registry = new Map();

export class TenantNotFoundError extends Error {
  constructor(tenantId) {
    super(`tenant_not_found: ${tenantId}`);
    this.name = 'TenantNotFoundError';
    this.tenantId = tenantId;
  }
}

export function getControlDb() {
  return getMongoClient().db(CONTROL_DB_NAME);
}

/** Coleccion de tenants, para que server.js pueda sembrar el tenant por defecto sin duplicar el nombre de la db de control. */
export function tenantsCollection() {
  return getControlDb().collection('tenants');
}

async function openTenantDb(tenantRow, dbKey) {
  const dbName = tenantRow.mongo[dbKey];
  if (tenantRow.mongo.mode === 'dedicated-cluster') {
    const client = new MongoClient(tenantRow.mongo.uri);
    await client.connect();
    return { client, db: client.db(dbName) };
  }
  // shared-cluster: reusa el MongoClient global ya conectado, solo cambia la db.
  return { client: getMongoClient(), db: getMongoClient().db(dbName) };
}

/**
 * Resuelve (y cachea) el Db de negocio de un tenant ('elvira' hoy para equipo-interno).
 * Lazy: no conecta nada hasta el primer request de ese tenant.
 */
export async function getTenantDb(tenantId) {
  const cacheKey = `${tenantId}:business`;
  if (registry.has(cacheKey)) return registry.get(cacheKey).db;

  const tenantRow = await tenantsCollection().findOne({ _id: tenantId, status: 'active' });
  if (!tenantRow) throw new TenantNotFoundError(tenantId);

  const entry = await openTenantDb(tenantRow, 'dbName');
  await ensureTenantIndexes(entry.db);
  registry.set(cacheKey, entry);
  return entry.db;
}

/**
 * Resuelve (y cachea) el Db de Rëff de un tenant ('reff' hoy para equipo-interno).
 * Segunda clave del mismo tenant — ver reffDbName en el esquema de `tenants`.
 */
export async function getTenantReffDb(tenantId) {
  const cacheKey = `${tenantId}:reff`;
  if (registry.has(cacheKey)) return registry.get(cacheKey).db;

  const tenantRow = await tenantsCollection().findOne({ _id: tenantId, status: 'active' });
  if (!tenantRow) throw new TenantNotFoundError(tenantId);

  const entry = await openTenantDb(tenantRow, 'reffDbName');
  registry.set(cacheKey, entry);
  return entry.db;
}

/** Variante sincrona para el hot path del Proxy (tenant-context.js): exige que ya se haya resuelto async al menos una vez (p.ej. en el login o en un warm-up explicito). */
export function getTenantDbSync(tenantId) {
  const entry = registry.get(`${tenantId}:business`);
  if (!entry) throw new TenantNotFoundError(tenantId);
  return entry.db;
}

export function getTenantReffDbSync(tenantId) {
  const entry = registry.get(`${tenantId}:reff`);
  if (!entry) throw new TenantNotFoundError(tenantId);
  return entry.db;
}

/** Solo para tests: limpia el registro en memoria entre casos. */
export function __resetTenantRegistryForTests() {
  registry.clear();
}
