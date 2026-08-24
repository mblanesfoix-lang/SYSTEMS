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

export function mountOphsCockpit(app, { auth, requireMesa, mongo, getMongoClient }) {
  const guard = [auth, requireMesa('ophs')];
  const herzogAudits = () => getMongoClient().db('reff').collection('herzog_audits');

  app.get('/api/ophs-cockpit/summary', ...guard, async (req, res) => {
    const sinceIso1h = new Date(Date.now() - 3600000).toISOString();
    const sinceIso24h = new Date(Date.now() - 24 * 3600000).toISOString();

    const [
      opsNodes,
      opsBreaches1h,
      paiaTotal,
      paiaWithFindings24h,
      herzogRecent,
      sentinelReviewQueue,
    ] = await Promise.all([
      mongo.collection('ops_nodes').find({}).toArray(),
      mongo.collection('ops_readings').countDocuments({ ts: { $gte: sinceIso1h }, 'breaches.0': { $exists: true } }),
      mongo.collection('paia_analyses').countDocuments({}),
      mongo.collection('paia_analyses').countDocuments({ createdAt: { $gte: sinceIso24h }, 'findings.0': { $exists: true } }),
      herzogAudits().find({}).sort({ created_at: -1 }).limit(50).toArray(),
      mongo.collection('ip_review_queue').countDocuments({ decision: { $exists: false } }),
    ]);

    const herzogNoCandidato = herzogRecent.filter((r) => r.result_json?.classification === 'NO_CANDIDATO').length;

    res.json({
      ops: {
        nodesTotal: opsNodes.length,
        nodesNominal: opsNodes.filter((n) => n.circuitState === 'nominal').length,
        nodesDegradado: opsNodes.filter((n) => n.circuitState === 'degradado').length,
        nodesParada: opsNodes.filter((n) => n.circuitState === 'parada').length,
        breachesUltimaHora: opsBreaches1h,
      },
      paia: {
        analysesTotal: paiaTotal,
        analysesConHallazgos24h: paiaWithFindings24h,
      },
      herzog: {
        auditsRecientes: herzogRecent.length,
        noCandidatoRecientes: herzogNoCandidato,
      },
      sentinel: {
        colaRevisionPendiente: sentinelReviewQueue,
      },
      generatedAt: new Date().toISOString(),
    });
  });
}
