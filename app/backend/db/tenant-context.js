/**
 * Propaga el tenant del request HTTP en curso a traves de la cadena async,
 * y expone un Proxy que se comporta como un Db nativo de mongodb pero resuelve
 * SIEMPRE el tenant activo — permite pasar un unico objeto `mongo` a los 27
 * mountX() de server.js sin que ninguno cambie su codigo (siguen escribiendo
 * literalmente mongo.collection('x')), preservando el contrato que usan los
 * tests (mongo: <Db crudo>) porque ambos exponen la misma interfaz.
 *
 * Fail-closed deliberado: si algun codigo llama mongo.collection() fuera de
 * un ciclo HTTP con resolveTenant ya corrido (crons, warm-up, codigo de
 * arranque), lanza tenant_context_missing en vez de servir datos de un tenant
 * equivocado. Los crons existentes deben envolver su trabajo en
 * tenantContext.run({ tenantId }, fn) por cada tenant activo que procesen.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { getTenantDb, getTenantReffDb, getTenantDbSync, getTenantReffDbSync } from './tenant-registry.js';

export const tenantContext = new AsyncLocalStorage();

export function resolveTenant(req, res, next) {
  if (!req.tenantId) return res.status(401).json({ error: 'unauthorized' });
  tenantContext.run({ tenantId: req.tenantId }, next);
}

function currentTenantId() {
  const store = tenantContext.getStore();
  if (!store?.tenantId) {
    throw new Error('tenant_context_missing: acceso a mongo fuera de un request con resolveTenant, o cron sin tenantContext.run()');
  }
  return store.tenantId;
}

function wrapAsTenantAwareDb(resolveDb) {
  return new Proxy({}, {
    get(_target, prop) {
      const realDb = resolveDb(currentTenantId());
      const value = realDb[prop];
      return typeof value === 'function' ? value.bind(realDb) : value;
    },
  });
}

/** El `mongo` que server.js pasa a los mountX de negocio (Finance, F&L, Herzog, GridFS, hash chains, ...). */
export function createTenantAwareDb() {
  return wrapAsTenantAwareDb(getTenantDbSync);
}

/** El `mongo` equivalente para los 4 sitios que hoy leen getMongoClient().db('reff') hardcodeado. */
export function createTenantAwareReffDb() {
  return wrapAsTenantAwareDb(getTenantReffDbSync);
}

/** Para crons/tareas de fondo que no corren dentro de un request: ejecuta fn con el tenant dado en contexto. */
export function runAsTenant(tenantId, fn) {
  return tenantContext.run({ tenantId }, fn);
}

/**
 * Middleware para rutas publicas (sin sesion): fija en el contexto un tenant concreto,
 * igual que hace el middleware de sesion con el tenant de cada usuario. Antes resuelve
 * sus dbs en el registro, porque el Proxy solo usa la variante sincrona. Si el tenant no
 * esta disponible responde 503 sin dar detalles a quien llama.
 */
export function withTenant(tenantId) {
  return async function tenantForPublicRoute(req, res, next) {
    try {
      await getTenantDb(tenantId);
      await getTenantReffDb(tenantId);
    } catch (err) {
      console.error(`[tenant] ruta publica sin tenant disponible (${tenantId}): ${err.message}`);
      return res.status(503).json({ error: 'servicio no disponible' });
    }
    tenantContext.run({ tenantId }, next);
  };
}
