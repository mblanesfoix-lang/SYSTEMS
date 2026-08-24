/**
 * NOTIFICACIONES ADMIN · errores/inestabilidad del sistema
 * Cola curada, separada del bus de tráfico general. Solo visible para 'admin'.
 *
 * JSON-backed (admin_notifications.json). El estado (adminNotifications array,
 * adminSseClients set) y la función adminNotify() se crean en este módulo y se
 * devuelven al bootstrap porque adminNotify es dependencia compartida: otros
 * módulos (bus, u2-ree, elvira-bridges, cnmc, y las mesas ya modulares como
 * foundry/rack-state/grid-interlink) la reciben en su objeto de deps.
 */

import fs from 'node:fs';
import crypto from 'node:crypto';

export function mountNotifications(app, { auth, requireAdmin, atomicWriteJson, NOTIFICATIONS_FILE }) {
  const MAX_NOTIFICATIONS = 300;
  let adminNotifications = [];
  if (fs.existsSync(NOTIFICATIONS_FILE)) {
    try {
      const saved = JSON.parse(fs.readFileSync(NOTIFICATIONS_FILE, 'utf8'));
      if (Array.isArray(saved)) adminNotifications = saved.slice(0, MAX_NOTIFICATIONS);
    } catch { console.warn('[notifications] No se pudieron cargar notificaciones previas'); }
  }
  const adminSseClients = new Set();

  function adminNotify({ origin = 'SYSTEM', label, detail, severity = 'error' }) {
    const notif = {
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      origin,
      severity, // 'error' | 'warning'
      label: String(label || '').slice(0, 200),
      detail: detail ? String(detail).slice(0, 500) : '',
      read: false,
    };
    adminNotifications.unshift(notif);
    if (adminNotifications.length > MAX_NOTIFICATIONS) adminNotifications.length = MAX_NOTIFICATIONS;
    atomicWriteJson(NOTIFICATIONS_FILE, adminNotifications);
    const payload = `data: ${JSON.stringify(notif)}\n\n`;
    for (const client of adminSseClients) {
      try { client.write(payload); } catch { adminSseClients.delete(client); }
    }
    return notif;
  }

  /* GET /api/notifications/stream — SSE, push en tiempo real */
  app.get('/api/notifications/stream', auth, requireAdmin, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const backlog = adminNotifications.slice(0, 50).reverse();
    for (const n of backlog) res.write(`data: ${JSON.stringify(n)}\n\n`);

    adminSseClients.add(res);
    const hb = setInterval(() => {
      try { res.write(': heartbeat\n\n'); } catch { clearInterval(hb); adminSseClients.delete(res); }
    }, 25000);
    req.on('close', () => { clearInterval(hb); adminSseClients.delete(res); });
  });

  /* GET /api/notifications — snapshot + contador de no leídas */
  app.get('/api/notifications', auth, requireAdmin, (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), MAX_NOTIFICATIONS);
    res.json({
      total: adminNotifications.length,
      unread: adminNotifications.filter(n => !n.read).length,
      notifications: adminNotifications.slice(0, limit),
    });
  });

  /* POST /api/notifications/:id/read — marcar una como leída */
  app.post('/api/notifications/:id/read', auth, requireAdmin, (req, res) => {
    const n = adminNotifications.find(x => x.id === req.params.id);
    if (!n) return res.status(404).json({ error: 'notificación no encontrada' });
    n.read = true;
    atomicWriteJson(NOTIFICATIONS_FILE, adminNotifications);
    res.json(n);
  });

  /* POST /api/notifications/read-all — marcar todas como leídas */
  app.post('/api/notifications/read-all', auth, requireAdmin, (req, res) => {
    for (const n of adminNotifications) n.read = true;
    atomicWriteJson(NOTIFICATIONS_FILE, adminNotifications);
    res.json({ ok: true });
  });

  /* DELETE /api/notifications/:id — eliminar una notificación */
  app.delete('/api/notifications/:id', auth, requireAdmin, (req, res) => {
    const idx = adminNotifications.findIndex(x => x.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'notificación no encontrada' });
    adminNotifications.splice(idx, 1);
    atomicWriteJson(NOTIFICATIONS_FILE, adminNotifications);
    res.json({ ok: true });
  });

  /* DELETE /api/notifications — eliminar todas las leídas */
  app.delete('/api/notifications', auth, requireAdmin, (req, res) => {
    adminNotifications = adminNotifications.filter(n => !n.read);
    atomicWriteJson(NOTIFICATIONS_FILE, adminNotifications);
    res.json({ ok: true });
  });

  return { adminNotify };
}
