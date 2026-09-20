import { Router, Request, Response } from 'express';
import { getReffDb, nextSeq } from '../mongo.js';
import { authMiddleware } from '../auth.js';

const router = Router();

router.use(authMiddleware);

// Whitelist temporal de admins que pueden accionar solicitudes (aprobar/denegar/
// requerir justificación). Rëff no tiene concepto de rol propio hoy — a diferencia
// de Elvi-Ra (users/sessions en db elvira) — así que se resuelve por username de
// Rëff. Ampliar aquí si se suma un admin nuevo.
const TRAFFIC_ADMINS = new Set(['marc', 'nour']);

export type TrafficStatus = 'pendiente' | 'aprobada' | 'denegada' | 'justificacion_requerida';

export interface TrafficRequestDoc {
  _id: number;
  requester_id: string;
  requester_name: string;
  module: string;
  resource: string;
  action: string;
  justification: string | null;
  status: TrafficStatus;
  resolved_by: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  port_opened_at: string | null;
  port_closed_at: string | null;
  requester_seen: boolean;
  created_at: string;
}

function serialize(doc: TrafficRequestDoc) {
  return {
    id: doc._id,
    requesterId: doc.requester_id,
    requesterName: doc.requester_name,
    module: doc.module,
    resource: doc.resource,
    action: doc.action,
    justification: doc.justification,
    status: doc.status,
    resolvedBy: doc.resolved_by,
    resolvedAt: doc.resolved_at,
    resolutionNote: doc.resolution_note,
    portOpenedAt: doc.port_opened_at,
    portClosedAt: doc.port_closed_at,
    requesterSeen: doc.requester_seen,
    createdAt: doc.created_at,
  };
}

function requireTrafficAdmin(req: Request, res: Response, next: () => void): void {
  if (!TRAFFIC_ADMINS.has(req.user.username)) {
    res.status(403).json({ error: 'Solo un admin de Consola Maestra puede accionar esta solicitud' });
    return;
  }
  next();
}

router.get('/requests', async (req: Request, res: Response) => {
  const { status } = req.query;
  const filter: Record<string, unknown> = {};
  if (typeof status === 'string' && status) filter.status = status;
  const rows = await getReffDb().collection<TrafficRequestDoc>('traffic_requests')
    .find(filter as never)
    .sort({ _id: -1 })
    .limit(200)
    .toArray();
  res.json({ requests: rows.map(serialize), isAdmin: TRAFFIC_ADMINS.has(req.user.username) });
});

router.post('/requests', async (req: Request, res: Response) => {
  const { module, resource, action } = req.body || {};
  if (!module || typeof module !== 'string' || !module.trim()) {
    return res.status(400).json({ error: 'El módulo de origen es obligatorio' });
  }
  if (!resource || typeof resource !== 'string' || !resource.trim()) {
    return res.status(400).json({ error: 'El recurso solicitado es obligatorio' });
  }
  if (!action || typeof action !== 'string' || !action.trim()) {
    return res.status(400).json({ error: 'La acción solicitada es obligatoria' });
  }

  const id = await nextSeq('traffic_requests');
  const doc: TrafficRequestDoc = {
    _id: id,
    requester_id: req.user.id,
    requester_name: req.user.displayName,
    module: module.trim(),
    resource: resource.trim(),
    action: action.trim(),
    justification: null,
    status: 'pendiente',
    resolved_by: null,
    resolved_at: null,
    resolution_note: null,
    port_opened_at: null,
    port_closed_at: null,
    requester_seen: true,
    created_at: new Date().toISOString(),
  };
  await getReffDb().collection<TrafficRequestDoc>('traffic_requests').insertOne(doc);
  res.status(201).json({ request: serialize(doc) });
});

// El propio solicitante añade el motivo pedido por REQUERIR_JUSTIFICACIÓN,
// lo que devuelve la solicitud a pendiente para que un admin la retramite.
router.post('/requests/:id/justify', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { justification } = req.body || {};
  if (!justification || typeof justification !== 'string' || !justification.trim()) {
    return res.status(400).json({ error: 'El motivo de negocio es obligatorio' });
  }
  const db = getReffDb();
  const row = await db.collection<TrafficRequestDoc>('traffic_requests').findOne({ _id: id });
  if (!row) return res.status(404).json({ error: 'Solicitud no encontrada' });
  if (row.requester_id !== req.user.id) {
    return res.status(403).json({ error: 'Solo el solicitante original puede justificar esta solicitud' });
  }
  if (row.status !== 'justificacion_requerida') {
    return res.status(409).json({ error: 'Esta solicitud no está esperando justificación' });
  }

  await db.collection<TrafficRequestDoc>('traffic_requests').updateOne({ _id: id }, {
    $set: { justification: justification.trim(), status: 'pendiente' },
  });
  const updated = await db.collection<TrafficRequestDoc>('traffic_requests').findOne({ _id: id }) as TrafficRequestDoc;
  res.json({ request: serialize(updated) });
});

// [APROBAR_Y_EMITIR]: abre el puerto 60s (simulado — no hay socket real de
// interconexión implementado todavía, ver doctrina Twin Elvi-Ra<->Systems),
// transfiere un payload de export (snapshot JSON del recurso solicitado,
// sustituible por el envío real cuando exista el socket) y marca aprobada.
// requester_seen:false dispara el badge de notificación en Sidebar/TrafficPage.
router.post('/requests/:id/approve', requireTrafficAdmin, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const db = getReffDb();
  const row = await db.collection<TrafficRequestDoc>('traffic_requests').findOne({ _id: id });
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
  await db.collection<TrafficRequestDoc>('traffic_requests').updateOne({ _id: id }, {
    $set: {
      status: 'aprobada',
      resolved_by: req.user.displayName,
      resolved_at: openedAt.toISOString(),
      resolution_note: `Información transferida a ${row.requester_name}: ${JSON.stringify(transferPayload)}`,
      port_opened_at: openedAt.toISOString(),
      port_closed_at: closedAt.toISOString(),
      requester_seen: false,
    },
  });
  const updated = await db.collection<TrafficRequestDoc>('traffic_requests').findOne({ _id: id }) as TrafficRequestDoc;
  res.json({ request: serialize(updated) });
});

// [DENEGAR_PETICIÓN]: cancela el envío. resolution_note siempre lleva el mensaje
// fijo de revisión estratégica salvo que el admin escriba uno propio, y
// requester_seen:false es lo que "notifica" al usuario (badge + banner en su
// próxima visita/poll a Consola Maestra).
router.post('/requests/:id/deny', requireTrafficAdmin, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { note } = req.body || {};
  const db = getReffDb();
  const row = await db.collection<TrafficRequestDoc>('traffic_requests').findOne({ _id: id });
  if (!row) return res.status(404).json({ error: 'Solicitud no encontrada' });

  await db.collection<TrafficRequestDoc>('traffic_requests').updateOne({ _id: id }, {
    $set: {
      status: 'denegada',
      resolved_by: req.user.displayName,
      resolved_at: new Date().toISOString(),
      resolution_note: typeof note === 'string' && note.trim() ? note.trim() : 'Solicitud cancelada: requiere revisión estratégica',
      requester_seen: false,
    },
  });
  const updated = await db.collection<TrafficRequestDoc>('traffic_requests').findOne({ _id: id }) as TrafficRequestDoc;
  res.json({ request: serialize(updated) });
});

router.post('/requests/:id/require-justification', requireTrafficAdmin, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const db = getReffDb();
  const row = await db.collection<TrafficRequestDoc>('traffic_requests').findOne({ _id: id });
  if (!row) return res.status(404).json({ error: 'Solicitud no encontrada' });

  await db.collection<TrafficRequestDoc>('traffic_requests').updateOne({ _id: id }, {
    $set: {
      status: 'justificacion_requerida',
      resolved_by: req.user.displayName,
      resolved_at: new Date().toISOString(),
      resolution_note: null,
      requester_seen: false,
    },
  });
  const updated = await db.collection<TrafficRequestDoc>('traffic_requests').findOne({ _id: id }) as TrafficRequestDoc;
  res.json({ request: serialize(updated) });
});

// Contador para el badge de Sidebar: solicitudes del usuario actual resueltas
// (aprobada/denegada/justificacion_requerida) que aún no ha reconocido.
router.get('/requests/unseen-count', async (req: Request, res: Response) => {
  const count = await getReffDb().collection<TrafficRequestDoc>('traffic_requests').countDocuments({
    requester_id: req.user.id,
    requester_seen: false,
    status: { $ne: 'pendiente' },
  } as never);
  res.json({ count });
});

// El solicitante reconoce una resolución (abre Consola Maestra) — apaga el badge para esa solicitud.
router.post('/requests/:id/ack', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const db = getReffDb();
  const row = await db.collection<TrafficRequestDoc>('traffic_requests').findOne({ _id: id });
  if (!row) return res.status(404).json({ error: 'Solicitud no encontrada' });
  if (row.requester_id !== req.user.id) {
    return res.status(403).json({ error: 'Solo el solicitante original puede reconocer esta solicitud' });
  }
  await db.collection<TrafficRequestDoc>('traffic_requests').updateOne({ _id: id }, { $set: { requester_seen: true } });
  res.json({ ok: true });
});

export default router;
