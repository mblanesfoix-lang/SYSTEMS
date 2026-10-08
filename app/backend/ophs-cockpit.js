/**
 * OPHS Framework Cockpit — la Consola Soberana.
 *
 * Cuadro de mando unificado que fusiona las 4 sub-interfaces del framework:
 *   OPS      -> telemetria hardware (ops.js, coleccion ops_nodes/ops_readings)
 *   PAIA     -> analitica predictiva (paia.js, coleccion paia_analyses)
 *   Herzog   -> auditoria/cumplimiento (vive en db 'reff', herzog_audits;
 *               mismo patron de lectura que pactum-viridi.js)
 *   Sentinel -> seguridad/vigilancia (sentinel-forensics.js, coleccion
 *               ip_review_queue/forensic_log en esta misma db)
 *
 * Solo lectura agregada. No ejecuta nada ni sustituye el juicio de cada
 * sub-interfaz: el Cockpit es la vista C-Level, la autoridad de cada dominio
 * sigue siendo de su propio modulo.
 */

export function mountOphsCockpit(app, { auth, requireMesa, mongo, getReffDb }) {
  const guard = [auth, requireMesa('ophs')];
  const herzogAudits = () => getReffDb().collection('herzog_audits');

  app.get('/api/ophs-cockpit/summary', ...guard, async (req, res) => {
    const sinceIso1h = new Date(Date.now() - 3600000).toISOString();
    const sinceIso24h = new Date(Date.now() - 24 * 3600000).toISOString();

    const [
      opsStateFacet,
      opsBreaches1h,
      paiaTotal,
      paiaWithFindings24h,
      herzogRecentTotal,
      herzogNoCandidato,
      sentinelReviewQueue,
    ] = await Promise.all([
      mongo.collection('ops_nodes').aggregate([{ $group: { _id: '$circuitState', count: { $sum: 1 } } }]).toArray(),
      mongo.collection('ops_readings').countDocuments({ ts: { $gte: sinceIso1h }, 'breaches.0': { $exists: true } }),
      mongo.collection('paia_analyses').countDocuments({}),
      mongo.collection('paia_analyses').countDocuments({ createdAt: { $gte: sinceIso24h }, 'findings.0': { $exists: true } }),
      herzogAudits().countDocuments({}),
      herzogAudits().countDocuments({ 'result_json.classification': 'NO_CANDIDATO' }),
      mongo.collection('ip_review_queue').countDocuments({ decision: { $exists: false } }),
    ]);

    const opsByState = Object.fromEntries(opsStateFacet.map((s) => [s._id, s.count]));
    const opsNodesTotal = opsStateFacet.reduce((sum, s) => sum + s.count, 0);

    res.json({
      ops: {
        nodesTotal: opsNodesTotal,
        nodesNominal: opsByState.nominal ?? 0,
        nodesDegradado: opsByState.degradado ?? 0,
        nodesParada: opsByState.parada ?? 0,
        breachesUltimaHora: opsBreaches1h,
      },
      paia: {
        analysesTotal: paiaTotal,
        analysesConHallazgos24h: paiaWithFindings24h,
      },
      herzog: {
        auditsRecientes: herzogRecentTotal,
        noCandidatoRecientes: herzogNoCandidato,
      },
      sentinel: {
        colaRevisionPendiente: sentinelReviewQueue,
      },
      generatedAt: new Date().toISOString(),
    });
  });
}
