/**
 * Estado de Elvi-Ra (registro de sistemas, T'Controler, scoring ØPHS, puentes y CNMC)
 * en la coleccion `elvira_state` del tenant: un documento por tenant, como lo era
 * data/elvira.json en una sola instalacion. Lo comparten la contabilidad de la IA
 * (server.js), reff-crm.routes.js, cnmc.routes.js, elvira-bridges.routes.js y
 * elvira-central.js.
 *
 * Por tenant: son datos de negocio de quien tiene la sesion, asi que `mongo` es el Proxy
 * de db/tenant-context.js. Fuera de una peticion hay que envolver la llamada en
 * runAsTenant().
 *
 * Varias replicas escriben el mismo documento: cada cambio pasa por updateElvira(),
 * que relee, aplica el cambio y solo lo guarda si nadie lo ha modificado entretanto
 * (campo `rev`); si alguien se adelanto, vuelve a empezar con lo nuevo. Por eso la
 * funcion de cambio puede ejecutarse mas de una vez y no debe tener efectos fuera
 * del estado que recibe.
 */

import { migrateJsonOnce } from '../lib/json-migration.js';

const COLLECTION = 'elvira_state';
const STATE_ID = 'state';
const MAX_ATTEMPTS = 8;

export function defaultElviraState() {
  return {
    systems: {
      sentinel: { status: 'connected', endpoint: 'local · bus events', lastPing: null, latencyMs: null },
      herzog:   { status: 'connected', endpoint: 'local · reff/api/herzog', lastPing: null, latencyMs: null },
      ophs:     { status: 'pending', endpoint: '', lastPing: null, latencyMs: null },
      tcontroler: { status: 'local', tokensUsed: 0, tokensCap: 0, byUser: {} },
      dataBase: { status: 'ok', backend: 'mongodb' },
    },
    ophs: {
      weights: { W: 0.18, I: 0.10, S: 0.10, M: 0.12, E: 0.10, R: 0.10, B: 0.12, G: 0.13, U2: 0.05 },
      threshold: { estrategico: 70, operativo: 45 },
      dictamenes: [],
    },
    bridges: {
      sentinel: { events: [] },
      herzog:   { audits: [] },
    },
    cnmc: {
      documents: [],
      auditLog:  [],
    },
    updatedAt: null,
  };
}

// Las secciones que falten (documento antiguo o a medio crear) se completan con las de
// serie, para que ninguna ruta tenga que comprobar su existencia.
function withDefaults(doc) {
  const { _id, rev, ...stored } = doc || {};
  const base = defaultElviraState();
  const state = { ...base, ...stored };
  state.systems = { ...base.systems, ...stored.systems };
  state.ophs = { ...base.ophs, ...stored.ophs };
  state.bridges = { ...base.bridges, ...stored.bridges };
  state.cnmc = { ...base.cnmc, ...stored.cnmc };
  return state;
}

// El JSON antiguo usaba la clave visible `øphs`; en Mongo los identificadores van en ASCII.
function asciiKeys(state) {
  const fix = (obj) => {
    if (!obj || typeof obj !== 'object' || !('øphs' in obj)) return obj;
    const { 'øphs': legacy, ...rest } = obj;
    return { ...rest, ophs: rest.ophs ?? legacy };
  };
  const out = fix(state);
  if (out.systems) out.systems = fix(out.systems);
  return out;
}

export function createElviraStore(mongo) {
  const col = () => mongo.collection(COLLECTION);

  async function readElvira() {
    return withDefaults(await col().findOne({ _id: STATE_ID }));
  }

  /** Aplica `mutate(state)` y lo guarda; devuelve lo que devuelva `mutate`. */
  async function updateElvira(mutate) {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const doc = await col().findOne({ _id: STATE_ID });
      const rev = doc?.rev ?? 0;
      const state = withDefaults(doc);
      const result = mutate(state);
      state.updatedAt = new Date().toISOString();
      if (!doc) {
        try {
          await col().insertOne({ _id: STATE_ID, rev: 1, ...state });
          return result;
        } catch (err) {
          if (err?.code !== 11000) throw err;
          continue;
        }
      }
      const res = await col().replaceOne({ _id: STATE_ID, rev }, { rev: rev + 1, ...state });
      if (res.matchedCount === 1) return result;
    }
    throw new Error('elvira_state: demasiadas escrituras simultaneas, cambio no guardado');
  }

  return { readElvira, updateElvira };
}

/** Importa data/elvira.json una sola vez, si el tenant aun no tiene estado propio. */
export function migrateElviraFile(db, file) {
  return migrateJsonOnce(db, 'elvira.json', file, async (data) => {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return 0;
    const state = withDefaults(asciiKeys(data));
    const res = await db.collection(COLLECTION).updateOne(
      { _id: STATE_ID },
      { $setOnInsert: { rev: 1, ...state } },
      { upsert: true },
    );
    return res.upsertedCount;
  });
}
