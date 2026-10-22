/**
 * S-EAGLE — Rëff Core Engine, mesa 5. Ventana de inspeccion: pensada para que
 * un inspector de gobierno vea, solo en lectura, el cumplimiento de S-NFI. No
 * ejecuta accion alguna ni modifica datos de otras mesas — Regla de Oro:
 * S-EAGLE señala, el humano decide.
 *
 * Hoy solo expone el resumen de la mesa y la verificacion de su log
 * inmutable (seagle_log). La vista de cumplimiento y el acceso externo
 * temporal se anaden sobre esta base.
 */

import { verifyLog } from './lib/hash-chain.js';

export function mountSeagle(app, { auth, requireMesa, mongo }) {
  const router = app;
  const guard = [auth, requireMesa('seagle')];

  /* ---- resumen (health-check dashboard) ---- */

  router.get('/api/seagle/summary', ...guard, async (req, res) => {
    res.json({
      metricsOwn: null, // placeholder — metricas propias de S-EAGLE, por desarrollar
    });
  });

  /* ---- integridad del log ---- */

  router.get('/api/seagle/log/verify', ...guard, async (req, res) => {
    res.json(await verifyLog(mongo, 'seagle_log'));
  });
}
