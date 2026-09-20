/**
 * SENTINEL · Trazabilidad forense de IPs
 * Log criptográfico inmutable (hash chain + HMAC) + cola de revisión
 * de IPs que exceden rate limit en rutas sensibles (CNMC, U-2).
 *
 * Wrappers finos que delegan en el objeto `sentinelForensics` construido en
 * server.js a partir de createSentinelForensics() (sentinel-forensics.js).
 */

import crypto from 'node:crypto';

export function mountSentinelForensicRoutes(app, { auth, sentinelForensics, busEmit, busEvents }) {
  /* GET /api/sentinel/forensic-log — paginado, filtrable por ip/mesa/blocked/sensitive */
  app.get('/api/sentinel/forensic-log', auth, async (req, res) => {
    const { ip, mesa, blocked, sensitive, from, to, limit, offset } = req.query;
    const result = await sentinelForensics.listForensicLog({ ip, mesa, blocked, sensitive, from, to, limit, offset });
    res.json(result);
  });

  /* GET /api/sentinel/forensic-log-human — mismo log en frases claras, sin jerga tecnica */
  app.get('/api/sentinel/forensic-log-human', auth, async (req, res) => {
    const { ip, blocked, from, to, limit, offset } = req.query;
    const result = await sentinelForensics.listForensicLogHuman({ ip, blocked, from, to, limit, offset });
    res.json(result);
  });

  /*
   * GET /api/sentinel/forensic-log/export
   * Informe descargable: traza completa de peticiones en un rango de fecha,
   * util para demostrar a una empresa o auditor que pasó en un periodo concreto.
   * Admin-only — datos forenses crudos.
   */
  app.get('/api/sentinel/forensic-log/export', auth, async (req, res) => {
    if (req.role !== 'admin') return res.status(403).json({ error: 'admin requerido' });
    const { ip, mesa, blocked, sensitive, from, to } = req.query;
    const result = await sentinelForensics.listForensicLog({ ip, mesa, blocked, sensitive, from, to, limit: 1000, offset: 0 });
    res.json({
      tipo:        'INFORME_TRAZA_SENTINEL',
      generadoEn:  new Date().toISOString(),
      generadoPor: req.user,
      filtros:     { ip: ip || null, mesa: mesa || null, blocked: blocked ?? null, sensitive: sensitive ?? null, from: from || null, to: to || null },
      total:       result.total,
      events:      result.events,
    });
  });

  /* GET /api/sentinel/verify-chain — Admin, valida integridad de la cadena de hashes */
  app.get('/api/sentinel/verify-chain', auth, async (req, res) => {
    if (req.role !== 'admin') return res.status(403).json({ error: 'admin requerido' });
    const result = await sentinelForensics.verifyChain();
    res.json(result);
  });

  /* POST /api/sentinel/reanchor-chain — Admin, re-sella la cadena tras un fallo (no borra historial) */
  app.post('/api/sentinel/reanchor-chain', auth, async (req, res) => {
    if (req.role !== 'admin') return res.status(403).json({ error: 'admin requerido' });
    const result = await sentinelForensics.reanchorChain(req.user);
    res.json(result);
  });

  /* GET /api/sentinel/ip-stats — top IPs por volumen de tráfico */
  app.get('/api/sentinel/ip-stats', auth, async (req, res) => {
    const stats = await sentinelForensics.ipStats();
    res.json(stats);
  });

  /* GET /api/sentinel/traffic-timeline — peticiones/min ultimos N minutos (grafico panel) */
  app.get('/api/sentinel/traffic-timeline', auth, async (req, res) => {
    const minutes = Math.min(Number(req.query.minutes) || 60, 1440);
    const timeline = await sentinelForensics.trafficTimeline(minutes);
    res.json({ minutes, timeline });
  });

  /* POST /api/sentinel/block-ip — Admin, bloqueo manual directo desde el panel */
  app.post('/api/sentinel/block-ip', auth, async (req, res) => {
    if (req.role !== 'admin') return res.status(403).json({ error: 'admin requerido' });
    const { ip, reason } = req.body || {};
    if (!ip) return res.status(400).json({ error: 'ip requerida' });
    const updated = await sentinelForensics.manualBlock(ip, reason, req.user);
    busEmit({
      id: crypto.randomUUID(), ts: new Date().toISOString(), seq: busEvents.length + 1,
      origin: 'SENTINEL', dest: 'ELVI-RA', type: 'alert', state: 'BLOCKED',
      label: `IP BLOQUEADA MANUALMENTE · ${ip} · por ${req.user}`, payload: { ip, reason }, user: req.user,
    });
    res.json(updated);
  });

  /* GET /api/sentinel/allowlist — IPs de confianza que Sentinel nunca bloquea */
  app.get('/api/sentinel/allowlist', auth, async (req, res) => {
    const list = await sentinelForensics.listAllowlist();
    res.json(list);
  });

  /* POST /api/sentinel/allowlist — Admin marca una IP como propia/de confianza, nunca mas se bloquea */
  app.post('/api/sentinel/allowlist', auth, async (req, res) => {
    if (req.role !== 'admin') return res.status(403).json({ error: 'admin requerido' });
    const { ip, label } = req.body || {};
    if (!ip) return res.status(400).json({ error: 'ip requerida' });
    const updated = await sentinelForensics.addToAllowlist(ip, label, req.user);
    busEmit({
      id: crypto.randomUUID(), ts: new Date().toISOString(), seq: busEvents.length + 1,
      origin: 'SENTINEL', dest: 'ELVI-RA', type: 'event', state: 'APPROVED',
      label: `IP MARCADA DE CONFIANZA · ${ip} · por ${req.user}`, payload: { ip, label }, user: req.user,
    });
    res.json(updated);
  });

  /* DELETE /api/sentinel/allowlist/:ip — Admin quita una IP de la lista de confianza */
  app.delete('/api/sentinel/allowlist/:ip', auth, async (req, res) => {
    if (req.role !== 'admin') return res.status(403).json({ error: 'admin requerido' });
    const result = await sentinelForensics.removeFromAllowlist(req.params.ip);
    res.json(result);
  });

  /* GET /api/sentinel/review-queue — IPs pendientes/bloqueadas/permitidas */
  app.get('/api/sentinel/review-queue', auth, async (req, res) => {
    const queue = await sentinelForensics.listReviewQueue();
    res.json(queue);
  });

  /* POST /api/sentinel/review-queue/:ip/decide — Admin concede o bloquea acceso */
  app.post('/api/sentinel/review-queue/:ip/decide', auth, async (req, res) => {
    if (req.role !== 'admin') return res.status(403).json({ error: 'admin requerido' });
    const { decision } = req.body || {};
    if (!['ALLOWED', 'BLOCKED'].includes(decision)) return res.status(400).json({ error: 'decision debe ser ALLOWED o BLOCKED' });
    const updated = await sentinelForensics.decideReview(req.params.ip, decision, req.user);
    busEmit({
      id: crypto.randomUUID(), ts: new Date().toISOString(), seq: busEvents.length + 1,
      origin: 'SENTINEL', dest: 'ELVI-RA', type: 'event', state: decision === 'BLOCKED' ? 'BLOCKED' : 'APPROVED',
      label: `IP ${decision} · ${req.params.ip} · por ${req.user}`, payload: { ip: req.params.ip, decision }, user: req.user,
    });
    res.json(updated);
  });

  /* GET /api/sentinel/review-queue/:ip/report — informe descargable del historial de esa IP */
  app.get('/api/sentinel/review-queue/:ip/report', auth, async (req, res) => {
    if (req.role !== 'admin') return res.status(403).json({ error: 'admin requerido' });
    const report = await sentinelForensics.exportIpReport(req.params.ip);
    res.json(report);
  });

  /* ==========================================================================
     Profiling de Comportamiento a Largo Plazo (Behavioral Analytics)
     Frecuencia anormal (NARANJA) + exfiltracion sospechosa (bloqueo por usuario)
     + heatmap de interes por departamento/mesa. Logica en sentinel-forensics.js.
  ========================================================================== */

  /* GET /api/sentinel/behavior/alerts — alertas de comportamiento (frecuencia + exfiltracion) */
  app.get('/api/sentinel/behavior/alerts', auth, async (req, res) => {
    if (req.role !== 'admin') return res.status(403).json({ error: 'admin requerido' });
    const { user, type, level, limit, offset } = req.query;
    const result = await sentinelForensics.listBehaviorAlerts({ user, type, level, limit, offset });
    res.json(result);
  });

  /* GET /api/sentinel/behavior/heatmap — peticiones por usuario x mesa, ultimos N dias */
  app.get('/api/sentinel/behavior/heatmap', auth, async (req, res) => {
    if (req.role !== 'admin') return res.status(403).json({ error: 'admin requerido' });
    const days = Math.min(Number(req.query.days) || 30, 180);
    const result = await sentinelForensics.behaviorHeatmap(days);
    res.json(result);
  });

  /* GET /api/sentinel/behavior/review-queue — usuarios pendientes/bloqueados/permitidos */
  app.get('/api/sentinel/behavior/review-queue', auth, async (req, res) => {
    if (req.role !== 'admin') return res.status(403).json({ error: 'admin requerido' });
    const queue = await sentinelForensics.listUserReviewQueue();
    res.json(queue);
  });

  /* POST /api/sentinel/behavior/review-queue/:user/decide — Admin concede o bloquea al usuario */
  app.post('/api/sentinel/behavior/review-queue/:user/decide', auth, async (req, res) => {
    if (req.role !== 'admin') return res.status(403).json({ error: 'admin requerido' });
    const { decision } = req.body || {};
    if (!['ALLOWED', 'BLOCKED'].includes(decision)) return res.status(400).json({ error: 'decision debe ser ALLOWED o BLOCKED' });
    const updated = await sentinelForensics.decideUserReview(req.params.user, decision, req.user);
    busEmit({
      id: crypto.randomUUID(), ts: new Date().toISOString(), seq: busEvents.length + 1,
      origin: 'SENTINEL', dest: 'ELVI-RA', type: 'event', state: decision === 'BLOCKED' ? 'BLOCKED' : 'APPROVED',
      label: `USUARIO ${decision} · ${req.params.user} · por ${req.user}`, payload: { user: req.params.user, decision }, user: req.user,
    });
    res.json(updated);
  });

  /* POST /api/sentinel/behavior/block-user — Admin, bloqueo manual directo de un usuario */
  app.post('/api/sentinel/behavior/block-user', auth, async (req, res) => {
    if (req.role !== 'admin') return res.status(403).json({ error: 'admin requerido' });
    const { user, reason } = req.body || {};
    if (!user) return res.status(400).json({ error: 'user requerido' });
    const updated = await sentinelForensics.manualBlockUser(user, reason, req.user);
    busEmit({
      id: crypto.randomUUID(), ts: new Date().toISOString(), seq: busEvents.length + 1,
      origin: 'SENTINEL', dest: 'ELVI-RA', type: 'alert', state: 'BLOCKED',
      label: `USUARIO BLOQUEADO MANUALMENTE · ${user} · por ${req.user}`, payload: { user, reason }, user: req.user,
    });
    res.json(updated);
  });
}
