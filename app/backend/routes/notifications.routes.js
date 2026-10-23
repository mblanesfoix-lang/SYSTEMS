/**
 * NOTIFICACIONES ADMIN · errores/inestabilidad del sistema
 * Cola curada, separada del bus de tráfico general. Solo visible para 'admin'.
 *
 * Colección admin_notifications de la base por defecto, global y no por tenant: son
 * avisos sobre la instalación (caídas, mesas degradadas, salidas bloqueadas) y muchos
 * nacen fuera de una petición, sin tenant. Así todas las réplicas ven la misma cola.
 *
 * adminNotify() es síncrona y no falla: la reciben bus, u2-ree, elvira-bridges, cnmc,
 * rack-state, grid-interlink y los manejadores de caída del proceso, que no esperan a
 * Mongo. Empuja el aviso a los clientes SSE de esta réplica y lo guarda en segundo plano.
 */

import crypto from 'node:crypto';
import { migrateJsonOnce, insertIgnoringDuplicates } from '../lib/json-migration.js';

const COLLECTION = 'admin_notifications';
const MAX_NOTIFICATIONS = 300;
// Las leídas caducan a los 6 meses de su fecha (expireAt + índice TTL); las no leídas no caducan.
const RETENTION_MS = 1000 * 60 * 60 * 24 * 30 * 6;

const toPublic = ({ _id, expireAt, ...rest }) => ({ id: _id, ...rest });

function expiryOf(ts) {
  const ms = Date.parse(ts);
  return new Date((Number.isFinite(ms) ? ms : Date.now()) + RETENTION_MS);
}

export async function ensureAdminNotificationIndexes(db) {
  const col = db.collection(COLLECTION);
  await col.createIndex({ ts: -1 });
  await col.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 });
}

/** Importa data/admin_notifications.json una sola vez. */
export function migrateAdminNotificationsFile(db, file) {
  return migrateJsonOnce(db, 'admin_notifications.json', file, (data) => {
    const list = Array.isArray(data) ? data.filter((n) => n && n.id).slice(0, MAX_NOTIFICATIONS) : [];
    const docs = list.map(({ id, ...n }) => ({
      _id: String(id), ...n,
      ...(n.read ? { expireAt: expiryOf(n.ts) } : {}),
    }));
    return insertIgnoringDuplicates(db.collection(COLLECTION), docs);
  });
}

export function mountNotifications(app, { auth, requireAdmin, mongo }) {
  const col = () => mongo.collection(COLLECTION);
  const adminSseClients = new Set();

  async function trimToMax() {
    const surplus = await col().find({}, { projection: { _id: 1 } })
      .sort({ ts: -1 }).skip(MAX_NOTIFICATIONS).toArray();
    if (surplus.length) await col().deleteMany({ _id: { $in: surplus.map((d) => d._id) } });
  }

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
    const { id, ...stored } = notif;
    col().insertOne({ _id: id, ...stored })
      .then(trimToMax)
      .catch((err) => console.error(`[notifications] aviso no guardado (${notif.label}):`, err?.message || err));
    const payload = `data: ${JSON.stringify(notif)}\n\n`;
    for (const client of adminSseClients) {
      try { client.write(payload); } catch { adminSseClients.delete(client); }
    }
    return notif;
  }

  async function latest(limit) {
    const rows = await col().find({}).sort({ ts: -1 }).limit(limit).toArray();
    return rows.map(toPublic);
  }

  /* GET /api/notifications/stream — SSE, push en tiempo real de los avisos de esta réplica */
  app.get('/api/notifications/stream', auth, requireAdmin, async (req, res) => {
    const backlog = (await latest(50)).reverse();
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    for (const n of backlog) res.write(`data: ${JSON.stringify(n)}\n\n`);

    adminSseClients.add(res);
    const hb = setInterval(() => {
      try { res.write(': heartbeat\n\n'); } catch { clearInterval(hb); adminSseClients.delete(res); }
    }, 25000);
    req.on('close', () => { clearInterval(hb); adminSseClients.delete(res); });
  });

  /* GET /api/notifications — snapshot + contador de no leídas */
  app.get('/api/notifications', auth, requireAdmin, async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), MAX_NOTIFICATIONS);
    const [total, unread, notifications] = await Promise.all([
      col().countDocuments({}),
      col().countDocuments({ read: false }),
      latest(limit),
    ]);
    res.json({ total, unread, notifications });
  });

  /* POST /api/notifications/:id/read — marcar una como leída */
  app.post('/api/notifications/:id/read', auth, requireAdmin, async (req, res) => {
    const current = await col().findOne({ _id: String(req.params.id) });
    if (!current) return res.status(404).json({ error: 'notificación no encontrada' });
    await col().updateOne({ _id: current._id }, { $set: { read: true, expireAt: expiryOf(current.ts) } });
    res.json(toPublic({ ...current, read: true }));
  });

  /* POST /api/notifications/read-all — marcar todas como leídas */
  app.post('/api/notifications/read-all', auth, requireAdmin, async (req, res) => {
    const unread = await col().find({ read: false }, { projection: { _id: 1, ts: 1 } }).toArray();
    if (unread.length) {
      await col().bulkWrite(unread.map((n) => ({
        updateOne: { filter: { _id: n._id }, update: { $set: { read: true, expireAt: expiryOf(n.ts) } } },
      })), { ordered: false });
    }
    res.json({ ok: true });
  });

  /* DELETE /api/notifications/:id — eliminar una notificación */
  app.delete('/api/notifications/:id', auth, requireAdmin, async (req, res) => {
    const { deletedCount } = await col().deleteOne({ _id: String(req.params.id) });
    if (!deletedCount) return res.status(404).json({ error: 'notificación no encontrada' });
    res.json({ ok: true });
  });

  /* DELETE /api/notifications — eliminar todas las leídas */
  app.delete('/api/notifications', auth, requireAdmin, async (req, res) => {
    await col().deleteMany({ read: true });
    res.json({ ok: true });
  });

  return {
    adminNotify,
    listAdminNotifications: () => latest(MAX_NOTIFICATIONS),
  };
}
