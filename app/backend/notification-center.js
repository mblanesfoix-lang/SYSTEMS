/**
 * Consola de Notificaciones — mesa SYSTEMS de primer nivel (transversal).
 *
 * Unifica en una sola vista admin-only las dos fuentes de notificación que
 * existían por separado:
 *  - admin_notifications (JSON, notifications.routes.js): alertas de sistema
 *    (RESILIENCE/RACK/SENTINEL/K8S/SYSTEM/...), ya solo-admin.
 *  - traffic_requests (Mongo db 'reff', Consola Maestra de Rëff): solicitudes
 *    de interconexión de usuarios con acciones 1-clic
 *    APROBAR_Y_EMITIR / DENEGAR_PETICIÓN / REQUERIR_JUSTIFICACIÓN.
 *
 * No se duplica almacenamiento: se lee directamente de ambas fuentes
 * (mismo patrón cross-db ya usado en ophs-cockpit.js/pactum-viridi.js vía
 * getMongoClient().db('reff')). Las acciones de traffic se re-implementan
 * aquí detrás de requireAdmin real (ROLE_MESAS), en vez de la whitelist de
 * username TRAFFIC_ADMINS que usa Rëff — pedido explícito: "solo acceso
 * admin" en esta consola. La ruta original de Rëff sigue intacta para su
 * propio flujo (marc/nour), sin tocarla.
 *
 * Retención 6 meses: al resolver una traffic_request (aprobada/denegada) se
 * fija expireAt = ahora + 6 meses; TTL index de Mongo la purga sola si nadie
 * la borra antes a mano. Las 'pendiente'/'justificacion_requerida' no
 * expiran (siguen abiertas). admin_notifications usa el mismo umbral vía
 * listAdminNotifications() (purga en cada lectura, ver notifications.routes.js).
 */

import { getMongoClient } from './db/mongo.js';

const RETENTION_MS = 1000 * 60 * 60 * 24 * 30 * 6;

// getReffDb: inyectado por mountNotificationCenter (parametro de mount), resuelve
// la db 'reff' del tenant de la sesion activa — ver db/tenant-context.js.
// ensureNotificationCenterIndexes() corre en boot sin sesion/tenant todavia,
// por eso sigue usando el tenant por defecto via getMongoClient().db('reff')
// directo (Fase 1: 'equipo-interno' ES esa db).
let _getReffDb = null;

function trafficCol() {
  if (!_getReffDb) throw new Error('trafficCol() llamado antes de mountNotificationCenter');
  return _getReffDb().collection('traffic_requests');
}

function serializeTraffic(doc) {
  return {
    source: 'traffic',
    id: doc._id,
    status: doc.status,
    requesterId: doc.requester_id,
    requesterName: doc.requester_name,
    module: doc.module,
    resource: doc.resource,
    action: doc.action,
    justification: doc.justification,
    resolvedBy: doc.resolved_by,
    resolvedAt: doc.resolved_at,
    resolutionNote: doc.resolution_note,
    portOpenedAt: doc.port_opened_at,
    portClosedAt: doc.port_closed_at,
    createdAt: doc.created_at,
  };
}

function serializeSystem(n) {
  return {
    source: 'system',
    id: n.id,
    status: n.read ? 'leida' : 'pendiente',
    origin: n.origin,
    severity: n.severity,
    label: n.label,
    detail: n.detail,
    createdAt: n.ts,
  };
}

export function mountNotificationCenter(app, { auth, requireMesa, requireAdmin, listAdminNotifications, getReffDb }) {
  _getReffDb = getReffDb;
  const guard = [auth, requireMesa('notificaciones'), requireAdmin];

  /* GET /api/notif-center/summary — KPIs agregados de las dos fuentes */
  app.get('/api/notif-center/summary', ...guard, async (req, res) => {
    const systemList = listAdminNotifications();
    const trafficList = await trafficCol().find({}).toArray();

    res.json({
      system: {
        total: systemList.length,
        unread: systemList.filter(n => !n.read).length,
      },
      traffic: {
        total: trafficList.length,
        pendiente: trafficList.filter(r => r.status === 'pendiente').length,
        justificacion_requerida: trafficList.filter(r => r.status === 'justificacion_requerida').length,
        aprobada: trafficList.filter(r => r.status === 'aprobada').length,
        denegada: trafficList.filter(r => r.status === 'denegada').length,
      },
    });
  });

  /* GET /api/notif-center/feed?source=system|traffic&status=... — vista unificada, orden reciente primero */
  app.get('/api/notif-center/feed', ...guard, async (req, res) => {
    const source = typeof req.query.source === 'string' ? req.query.source : null;
    const status = typeof req.query.status === 'string' ? req.query.status : null;

    let items = [];
    if (source !== 'traffic') {
      let sys = listAdminNotifications().map(serializeSystem);
      if (status) sys = sys.filter(n => n.status === status);
      items = items.concat(sys);
    }
    if (source !== 'system') {
      const query = status ? { status } : {};
      const rows = await trafficCol().find(query).sort({ _id: -1 }).limit(200).toArray();
      items = items.concat(rows.map(serializeTraffic));
    }
    items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    res.json({ items: items.slice(0, 300) });
  });

  /* ---- acciones 1-clic sobre traffic_requests, detrás de admin real ---- */

  app.post('/api/notif-center/traffic/:id/approve', ...guard, async (req, res) => {
    const id = Number(req.params.id);
    const col = trafficCol();
    const row = await col.findOne({ _id: id });
    if (!row) return res.status(404).json({ error: 'Solicitud no encontrada' });
    if (row.status === 'aprobada') return res.status(409).json({ error: 'Solicitud ya aprobada' });

    const openedAt = new Date();
    const closedAt = new Date(openedAt.getTime() + 60_000);
    const transferPayload = {
      resource: row.resource,
      module: row.module,
      action: row.action,
      issuedTo: row.requester_name,
      issuedAt: openedAt.toISOString(),
      note: 'Transferencia simulada — pendiente socket real Twin Elvi-Ra<->Systems',
    };
    await col.updateOne({ _id: id }, {
      $set: {
        status: 'aprobada',
        resolved_by: req.user,
        resolved_at: openedAt.toISOString(),
        resolution_note: `Información transferida a ${row.requester_name}: ${JSON.stringify(transferPayload)}`,
        port_opened_at: openedAt.toISOString(),
        port_closed_at: closedAt.toISOString(),
        requester_seen: false,
        expireAt: new Date(openedAt.getTime() + RETENTION_MS),
      },
    });
    const updated = await col.findOne({ _id: id });
    res.json(serializeTraffic(updated));
  });

  app.post('/api/notif-center/traffic/:id/deny', ...guard, async (req, res) => {
    const id = Number(req.params.id);
    const { note } = req.body || {};
    const col = trafficCol();
    const row = await col.findOne({ _id: id });
    if (!row) return res.status(404).json({ error: 'Solicitud no encontrada' });

    const resolvedAt = new Date();
    await col.updateOne({ _id: id }, {
      $set: {
        status: 'denegada',
        resolved_by: req.user,
        resolved_at: resolvedAt.toISOString(),
        resolution_note: typeof note === 'string' && note.trim() ? note.trim() : 'Solicitud cancelada: requiere revisión estratégica',
        requester_seen: false,
        expireAt: new Date(resolvedAt.getTime() + RETENTION_MS),
      },
    });
    const updated = await col.findOne({ _id: id });
    res.json(serializeTraffic(updated));
  });

  app.post('/api/notif-center/traffic/:id/require-justification', ...guard, async (req, res) => {
    const id = Number(req.params.id);
    const col = trafficCol();
    const row = await col.findOne({ _id: id });
    if (!row) return res.status(404).json({ error: 'Solicitud no encontrada' });

    await col.updateOne({ _id: id }, {
      $set: {
        status: 'justificacion_requerida',
        resolved_by: req.user,
        resolved_at: new Date().toISOString(),
        resolution_note: null,
        requester_seen: false,
      },
      $unset: { expireAt: '' },
    });
    const updated = await col.findOne({ _id: id });
    res.json(serializeTraffic(updated));
  });

}

export async function ensureNotificationCenterIndexes() {
  await getMongoClient().db('reff').collection('traffic_requests')
    .createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 });
}
