/**
 * S-NFI Factory · control cadena de suministro industrial
 * Alcance: ensamblaje BioHybrid, logistica materiales, inventario
 * componentes mecanicos, ciclo mantenimiento nodos desplegados.
 * Datos manuales (CRUD) por ahora; conector ERP/sensores real queda pendiente.
 *
 * Nota: estas rutas no llevan `auth` por-ruta porque en server.js estan
 * protegidas por el guard de mesa previo: `app.use('/api/factory', auth,
 * requireMesa('factory'))`, montado antes de esta funcion. Se preserva tal
 * cual (mismo comportamiento que el original).
 */

import crypto from 'node:crypto';

const FACTORY_ASSEMBLY_STAGES = ['recepcion', 'mecanizado', 'integracion', 'qa', 'listo_envio'];
const FACTORY_ASSEMBLY_STATUSES = ['en_curso', 'parado', 'bloqueado', 'completado'];
const FACTORY_LOGISTICS_STATUSES = ['pedido', 'transito', 'recibido', 'incidencia'];
const FACTORY_MAINTENANCE_TYPES = ['preventivo', 'correctivo', 'inspeccion'];
const FACTORY_MAINTENANCE_STATUSES = ['programado', 'en_curso', 'completado'];

function withId(doc) {
  if (!doc) return doc;
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
}

export function mountFactory(app, { mongo }) {
  /* ---- Ensamblaje ---- */
  app.get('/api/factory/assembly', async (req, res) => {
    const rows = await mongo.collection('factory_assembly').find({}).sort({ _id: -1 }).toArray();
    res.json(rows.map(withId));
  });

  app.post('/api/factory/assembly', async (req, res) => {
    const b = req.body || {};
    const nodeRef = String(b.nodeRef || '').trim();
    if (!nodeRef) return res.status(400).json({ error: 'nodeRef requerido' });
    const stage = FACTORY_ASSEMBLY_STAGES.includes(b.stage) ? b.stage : 'recepcion';
    const now = new Date().toISOString();
    const doc = {
      _id: crypto.randomUUID(),
      nodeRef,
      stage,
      status: 'en_curso',
      startedAt: now,
      eta: typeof b.eta === 'string' ? b.eta : null,
      blockerNote: typeof b.blockerNote === 'string' ? b.blockerNote : null,
      createdBy: req.user,
      updatedAt: now,
    };
    await mongo.collection('factory_assembly').insertOne(doc);
    res.status(201).json(withId(doc));
  });

  app.patch('/api/factory/assembly/:id', async (req, res) => {
    const row = await mongo.collection('factory_assembly').findOne({ _id: req.params.id });
    if (!row) return res.status(404).json({ error: 'registro no encontrado' });

    const b = req.body || {};
    const $set = { updatedAt: new Date().toISOString() };
    if (b.nodeRef !== undefined) {
      if (!String(b.nodeRef).trim()) return res.status(400).json({ error: 'nodeRef invalido' });
      $set.nodeRef = String(b.nodeRef).trim();
    }
    if (b.stage !== undefined) {
      if (!FACTORY_ASSEMBLY_STAGES.includes(b.stage)) return res.status(400).json({ error: 'stage invalido' });
      $set.stage = b.stage;
    }
    if (b.status !== undefined) {
      if (!FACTORY_ASSEMBLY_STATUSES.includes(b.status)) return res.status(400).json({ error: 'status invalido' });
      $set.status = b.status;
    }
    if (b.eta !== undefined) $set.eta = typeof b.eta === 'string' ? b.eta : null;
    if (b.blockerNote !== undefined) $set.blockerNote = typeof b.blockerNote === 'string' ? b.blockerNote : null;

    await mongo.collection('factory_assembly').updateOne({ _id: req.params.id }, { $set });
    const updated = await mongo.collection('factory_assembly').findOne({ _id: req.params.id });
    res.json(withId(updated));
  });

  app.delete('/api/factory/assembly/:id', async (req, res) => {
    const result = await mongo.collection('factory_assembly').deleteOne({ _id: req.params.id });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'registro no encontrado' });
    res.json({ id: req.params.id });
  });

  /* ---- Logistica de materiales ---- */
  app.get('/api/factory/logistics', async (req, res) => {
    const rows = await mongo.collection('factory_logistics').find({}).sort({ _id: -1 }).toArray();
    res.json(rows.map(withId));
  });

  app.post('/api/factory/logistics', async (req, res) => {
    const b = req.body || {};
    const material = String(b.material || '').trim();
    if (!material) return res.status(400).json({ error: 'material requerido' });
    const qty = Number(b.qty);
    if (!Number.isFinite(qty) || qty < 0) return res.status(400).json({ error: 'qty invalido' });
    const unit = String(b.unit || '').trim();
    if (!unit) return res.status(400).json({ error: 'unit requerido' });
    const now = new Date().toISOString();
    const doc = {
      _id: crypto.randomUUID(),
      material,
      supplier: typeof b.supplier === 'string' ? b.supplier : null,
      qty,
      unit,
      origin: typeof b.origin === 'string' ? b.origin : null,
      destination: typeof b.destination === 'string' ? b.destination : null,
      status: 'pedido',
      eta: typeof b.eta === 'string' ? b.eta : null,
      trackingRef: typeof b.trackingRef === 'string' ? b.trackingRef : null,
      createdBy: req.user,
      updatedAt: now,
    };
    await mongo.collection('factory_logistics').insertOne(doc);
    res.status(201).json(withId(doc));
  });

  app.patch('/api/factory/logistics/:id', async (req, res) => {
    const row = await mongo.collection('factory_logistics').findOne({ _id: req.params.id });
    if (!row) return res.status(404).json({ error: 'envio no encontrado' });

    const b = req.body || {};
    const $set = { updatedAt: new Date().toISOString() };
    if (b.material !== undefined) {
      if (!String(b.material).trim()) return res.status(400).json({ error: 'material invalido' });
      $set.material = String(b.material).trim();
    }
    if (b.supplier !== undefined) $set.supplier = typeof b.supplier === 'string' ? b.supplier : null;
    if (b.qty !== undefined) {
      const qty = Number(b.qty);
      if (!Number.isFinite(qty) || qty < 0) return res.status(400).json({ error: 'qty invalido' });
      $set.qty = qty;
    }
    if (b.unit !== undefined) {
      if (!String(b.unit).trim()) return res.status(400).json({ error: 'unit invalido' });
      $set.unit = String(b.unit).trim();
    }
    if (b.origin !== undefined) $set.origin = typeof b.origin === 'string' ? b.origin : null;
    if (b.destination !== undefined) $set.destination = typeof b.destination === 'string' ? b.destination : null;
    if (b.status !== undefined) {
      if (!FACTORY_LOGISTICS_STATUSES.includes(b.status)) return res.status(400).json({ error: 'status invalido' });
      $set.status = b.status;
    }
    if (b.eta !== undefined) $set.eta = typeof b.eta === 'string' ? b.eta : null;
    if (b.trackingRef !== undefined) $set.trackingRef = typeof b.trackingRef === 'string' ? b.trackingRef : null;

    await mongo.collection('factory_logistics').updateOne({ _id: req.params.id }, { $set });
    const updated = await mongo.collection('factory_logistics').findOne({ _id: req.params.id });
    res.json(withId(updated));
  });

  app.delete('/api/factory/logistics/:id', async (req, res) => {
    const result = await mongo.collection('factory_logistics').deleteOne({ _id: req.params.id });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'envio no encontrado' });
    res.json({ id: req.params.id });
  });

  /* ---- Inventario de componentes ---- */
  app.get('/api/factory/inventory', async (req, res) => {
    const rows = await mongo.collection('factory_inventory').find({}).sort({ componentName: 1 }).toArray();
    res.json(rows.map(r => ({ ...withId(r), lowStock: r.qtyStock < r.minThreshold })));
  });

  app.post('/api/factory/inventory', async (req, res) => {
    const b = req.body || {};
    const componentName = String(b.componentName || '').trim();
    if (!componentName) return res.status(400).json({ error: 'componentName requerido' });
    const category = String(b.category || '').trim();
    if (!category) return res.status(400).json({ error: 'category requerido' });
    const now = new Date().toISOString();
    const doc = {
      _id: crypto.randomUUID(),
      componentName,
      category,
      qtyStock: Number.isFinite(Number(b.qtyStock)) && Number(b.qtyStock) >= 0 ? Number(b.qtyStock) : 0,
      qtyReserved: Number.isFinite(Number(b.qtyReserved)) && Number(b.qtyReserved) >= 0 ? Number(b.qtyReserved) : 0,
      minThreshold: Number.isFinite(Number(b.minThreshold)) && Number(b.minThreshold) >= 0 ? Number(b.minThreshold) : 0,
      location: typeof b.location === 'string' ? b.location : null,
      unitCost: Number.isFinite(Number(b.unitCost)) ? Number(b.unitCost) : null,
      createdBy: req.user,
      updatedAt: now,
    };
    await mongo.collection('factory_inventory').insertOne(doc);
    res.status(201).json({ ...withId(doc), lowStock: doc.qtyStock < doc.minThreshold });
  });

  app.patch('/api/factory/inventory/:id', async (req, res) => {
    const row = await mongo.collection('factory_inventory').findOne({ _id: req.params.id });
    if (!row) return res.status(404).json({ error: 'componente no encontrado' });

    const b = req.body || {};
    const $set = { updatedAt: new Date().toISOString() };
    if (b.componentName !== undefined) {
      if (!String(b.componentName).trim()) return res.status(400).json({ error: 'componentName invalido' });
      $set.componentName = String(b.componentName).trim();
    }
    if (b.category !== undefined) {
      if (!String(b.category).trim()) return res.status(400).json({ error: 'category invalido' });
      $set.category = String(b.category).trim();
    }
    for (const field of ['qtyStock', 'qtyReserved', 'minThreshold']) {
      if (b[field] !== undefined) {
        const n = Number(b[field]);
        if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: `${field} invalido` });
        $set[field] = n;
      }
    }
    if (b.location !== undefined) $set.location = typeof b.location === 'string' ? b.location : null;
    if (b.unitCost !== undefined) $set.unitCost = Number.isFinite(Number(b.unitCost)) ? Number(b.unitCost) : null;

    await mongo.collection('factory_inventory').updateOne({ _id: req.params.id }, { $set });
    const updated = await mongo.collection('factory_inventory').findOne({ _id: req.params.id });
    res.json({ ...withId(updated), lowStock: updated.qtyStock < updated.minThreshold });
  });

  app.delete('/api/factory/inventory/:id', async (req, res) => {
    const result = await mongo.collection('factory_inventory').deleteOne({ _id: req.params.id });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'componente no encontrado' });
    res.json({ id: req.params.id });
  });

  /* ---- Mantenimiento de nodos desplegados ---- */
  app.get('/api/factory/maintenance', async (req, res) => {
    const rows = await mongo.collection('factory_maintenance').find({}).sort({ scheduledAt: 1 }).toArray();
    const now = Date.now();
    res.json(rows.map(r => ({ ...withId(r), overdue: r.status !== 'completado' && new Date(r.scheduledAt).getTime() < now })));
  });

  app.post('/api/factory/maintenance', async (req, res) => {
    const b = req.body || {};
    const nodeId = String(b.nodeId || '').trim();
    if (!nodeId) return res.status(400).json({ error: 'nodeId requerido' });
    if (!FACTORY_MAINTENANCE_TYPES.includes(b.type)) return res.status(400).json({ error: 'type invalido' });
    const scheduledAt = String(b.scheduledAt || '');
    if (!scheduledAt) return res.status(400).json({ error: 'scheduledAt requerido' });
    const now = new Date().toISOString();
    const doc = {
      _id: crypto.randomUUID(),
      nodeId,
      type: b.type,
      status: 'programado',
      scheduledAt,
      completedAt: null,
      technician: typeof b.technician === 'string' ? b.technician : null,
      notes: typeof b.notes === 'string' ? b.notes : null,
      createdBy: req.user,
      updatedAt: now,
    };
    await mongo.collection('factory_maintenance').insertOne(doc);
    res.status(201).json({ ...withId(doc), overdue: false });
  });

  app.patch('/api/factory/maintenance/:id', async (req, res) => {
    const row = await mongo.collection('factory_maintenance').findOne({ _id: req.params.id });
    if (!row) return res.status(404).json({ error: 'mantenimiento no encontrado' });

    const b = req.body || {};
    const $set = { updatedAt: new Date().toISOString() };
    if (b.nodeId !== undefined) {
      if (!String(b.nodeId).trim()) return res.status(400).json({ error: 'nodeId invalido' });
      $set.nodeId = String(b.nodeId).trim();
    }
    if (b.type !== undefined) {
      if (!FACTORY_MAINTENANCE_TYPES.includes(b.type)) return res.status(400).json({ error: 'type invalido' });
      $set.type = b.type;
    }
    if (b.status !== undefined) {
      if (!FACTORY_MAINTENANCE_STATUSES.includes(b.status)) return res.status(400).json({ error: 'status invalido' });
      $set.status = b.status;
      if (b.status === 'completado') $set.completedAt = new Date().toISOString();
    }
    if (b.scheduledAt !== undefined) {
      if (!String(b.scheduledAt).trim()) return res.status(400).json({ error: 'scheduledAt invalido' });
      $set.scheduledAt = b.scheduledAt;
    }
    if (b.technician !== undefined) $set.technician = typeof b.technician === 'string' ? b.technician : null;
    if (b.notes !== undefined) $set.notes = typeof b.notes === 'string' ? b.notes : null;

    await mongo.collection('factory_maintenance').updateOne({ _id: req.params.id }, { $set });
    const updated = await mongo.collection('factory_maintenance').findOne({ _id: req.params.id });
    res.json({ ...withId(updated), overdue: updated.status !== 'completado' && new Date(updated.scheduledAt).getTime() < Date.now() });
  });

  app.delete('/api/factory/maintenance/:id', async (req, res) => {
    const result = await mongo.collection('factory_maintenance').deleteOne({ _id: req.params.id });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'mantenimiento no encontrado' });
    res.json({ id: req.params.id });
  });

  /* ---- Resumen KPI ---- */
  app.get('/api/factory/summary', async (req, res) => {
    const nowIso = new Date().toISOString();
    const [assemblyActive, logisticsIncidents, inventoryLow, maintenanceOverdue] = await Promise.all([
      mongo.collection('factory_assembly').countDocuments({ status: 'en_curso' }),
      mongo.collection('factory_logistics').countDocuments({ status: 'incidencia' }),
      mongo.collection('factory_inventory').countDocuments({ $expr: { $lt: ['$qtyStock', '$minThreshold'] } }),
      mongo.collection('factory_maintenance').countDocuments({ status: { $ne: 'completado' }, scheduledAt: { $lt: nowIso } }),
    ]);
    res.json({ assemblyActive, logisticsIncidents, inventoryLow, maintenanceOverdue });
  });
}
