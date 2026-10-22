/**
 * S-EAGLE — Rëff Core Engine, mesa 5. Ventana de inspeccion: pensada para que
 * un inspector de gobierno vea, solo en lectura, el cumplimiento de S-NFI. No
 * ejecuta accion alguna ni modifica datos de otras mesas — Regla de Oro:
 * S-EAGLE señala, el humano decide.
 *
 * Expone el resumen de la mesa, la vista de cumplimiento (semaforo calculado
 * sobre Herzog LaW) y la verificacion de su log inmutable (seagle_log). El
 * acceso externo temporal se anade sobre esta base.
 */

import { verifyLog } from './lib/hash-chain.js';
import { buildComplianceView } from './lib/compliance-view.js';

export function mountSeagle(app, { auth, requireMesa, mongo }) {
  const router = app;
  const guard = [auth, requireMesa('seagle')];

  /* ---- resumen (health-check dashboard) ---- */

  router.get('/api/seagle/summary', ...guard, async (req, res) => {
    res.json({
      metricsOwn: null, // placeholder — metricas propias de S-EAGLE, por desarrollar
    });
  });

  /* ---- vista de cumplimiento ----
   * Solo lee los registros de Herzog LaW (misma db, sin duplicar dato) y calcula el
   * semaforo. No siembra el catalogo: si Herzog LaW aun no se ha abierto, sale vacio. */

  router.get('/api/seagle/compliance', ...guard, async (req, res) => {
    const [frameworks, zones, lawLog, seagleLog] = await Promise.all([
      mongo.collection('herzog_law_frameworks').find({}).toArray(),
      mongo.collection('herzog_law_zones').find({}).toArray(),
      verifyLog(mongo, 'herzog_law_log'),
      verifyLog(mongo, 'seagle_log'),
    ]);
    const now = new Date();
    res.json(buildComplianceView({
      frameworks,
      zones,
      now,
      integrity: { checkedAt: now.toISOString(), herzogLaw: lawLog, seagle: seagleLog },
    }));
  });

  /* ---- integridad del log ---- */

  router.get('/api/seagle/log/verify', ...guard, async (req, res) => {
    res.json(await verifyLog(mongo, 'seagle_log'));
  });
}
