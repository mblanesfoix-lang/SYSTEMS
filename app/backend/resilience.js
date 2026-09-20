/**
 * S-NFI Resilience (BSS) — inteligencia de deteccion y arbitraje ante fallos
 * de red electrica / eventos sistemicos. NUNCA ejecuta accion fisica: detecta
 * condicion de riesgo y manda senal a Elvi-Ra (busEmit + adminNotify, origin
 * 'RESILIENCE'), el humano autoriza en Central. Misma Regla de Oro que
 * PAIA -> Central.
 *
 * Mismo patron que Pactvm Viridi/F&L: CRUD directo sobre Mongo, sin router TS
 * separado, log inmutable propio (resilience_log, hash chain).
 *
 * 3 bloques (KPIs BSS 2026-09-08):
 *  1. Continuidad operativa: lecturas de autonomia/SoC/ICO (resilience_bss_readings).
 *  2. Cadena de suministro: CRM proveedores por componente + pais (resilience_suppliers).
 *  3. Backup soberania de datos: estado RPO/RTO/sync (resilience_backup_status).
 *
 * 3 accionables (fase 1 = simulacro, sin integracion externa real):
 *  - POST /api/resilience/isolated-mode/activate  (conmutacion red -> mesh/satelital)
 *  - POST /api/resilience/suppliers/recalculate    (reasigna proveedor tras bloqueo de region)
 *  - POST /api/resilience/sovereignty/migrate      (snapshot cifrado hacia reserva Suiza/Islandia)
 *
 * Todos los datos de partida (autonomia, proveedores, servidor de respaldo)
 * son PLACEHOLDER editables por el admin desde la UI — mismo patron que
 * wasteEstTDay en Pactvm Viridi: sin infraestructura fisica real documentada
 * en el repo todavia.
 */

import crypto from 'node:crypto';

const SUPPLY_STATUSES = ['activo', 'bloqueado', 'alterno'];
const BACKUP_STATUSES = ['ok', 'degradado', 'critico'];
const ISOLATED_MODE_ID = 'default';

const SEED_BSS_READING = {
  autonomyHours: 0,
  socPct: 0,
  icoPct: 0,
  source: 'PLACEHOLDER — sin generadores/placas/horas de autonomia documentados, pendiente de carga real por Admin',
};

const SEED_SUPPLIERS = [
  { component: 'Baterías BSS', supplierName: 'Proveedor primario (placeholder)', region: 'UE', leadTimeDays: 45, status: 'activo', isPrimary: true, source: 'PLACEHOLDER — pendiente carga real' },
  { component: 'Membranas', supplierName: 'Proveedor primario (placeholder)', region: 'UE', leadTimeDays: 30, status: 'activo', isPrimary: true, source: 'PLACEHOLDER — pendiente carga real' },
  { component: 'Válvulas', supplierName: 'Proveedor primario (placeholder)', region: 'UE', leadTimeDays: 20, status: 'activo', isPrimary: true, source: 'PLACEHOLDER — pendiente carga real' },
];

const DEFAULT_BACKUP_STATUS = {
  _id: ISOLATED_MODE_ID,
  destination: 'PLACEHOLDER — Suiza/Islandia por concretar',
  rpoMinutes: null,
  rtoMinutes: null,
  lastSyncAt: null,
  dataVolumeGb: null,
  status: 'critico',
  source: 'PLACEHOLDER — sin servidor de respaldo real conectado',
  updatedAt: null,
  updatedBy: null,
};

const DEFAULT_ISOLATED_MODE_STATE = {
  _id: ISOLATED_MODE_ID,
  active: false,
  activatedAt: null,
  activatedBy: null,
  deactivatedAt: null,
};

function withId(doc) {
  if (!doc) return doc;
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
}

function canonical(entry) {
  return JSON.stringify(entry, Object.keys(entry).sort());
}

async function appendResilienceLog(mongo, entry) {
  const col = mongo.collection('resilience_log');
  const tail = await col.find().sort({ seq: -1 }).limit(1).next();
  const seq = tail ? tail.seq + 1 : 1;
  const prevHash = tail ? tail.hash : '0'.repeat(64);
  const canonicalEntry = { ...entry, seq };
  const hash = crypto.createHash('sha256').update(prevHash + canonical(canonicalEntry)).digest('hex');
  const doc = { _id: crypto.randomUUID(), ...entry, seq, prevHash, hash, createdAt: new Date().toISOString() };
  await col.insertOne(doc);
  return doc;
}

export function mountResilience(app, { auth, requireMesa, mongo, busEmit, adminNotify }) {
  const router = app;
  const guard = [auth, requireMesa('resilience')];

  mongo.collection('resilience_bss_readings').countDocuments({}).then(async (count) => {
    if (count > 0) return;
    await mongo.collection('resilience_bss_readings').insertOne({
      _id: crypto.randomUUID(),
      ...SEED_BSS_READING,
      createdBy: 'system',
      createdAt: new Date().toISOString(),
    });
  }).catch(() => {});

  mongo.collection('resilience_suppliers').countDocuments({}).then(async (count) => {
    if (count > 0) return;
    const now = new Date().toISOString();
    await mongo.collection('resilience_suppliers').insertMany(SEED_SUPPLIERS.map((s) => ({
      _id: crypto.randomUUID(),
      ...s,
      createdBy: 'system',
      createdAt: now,
      updatedAt: now,
    })));
  }).catch(() => {});

  mongo.collection('resilience_backup_status').countDocuments({ _id: ISOLATED_MODE_ID }).then(async (count) => {
    if (count > 0) return;
    await mongo.collection('resilience_backup_status').insertOne(DEFAULT_BACKUP_STATUS);
  }).catch(() => {});

  mongo.collection('resilience_isolated_mode').countDocuments({ _id: ISOLATED_MODE_ID }).then(async (count) => {
    if (count > 0) return;
    await mongo.collection('resilience_isolated_mode').insertOne(DEFAULT_ISOLATED_MODE_STATE);
  }).catch(() => {});

  /* ---- bloque 1: continuidad operativa (autonomia BSS / SoC / ICO) ---- */

  router.get('/api/resilience/bss-readings', ...guard, async (req, res) => {
    const rows = await mongo.collection('resilience_bss_readings').find({}).sort({ createdAt: -1 }).limit(50).toArray();
    res.json(rows.map(withId));
  });

  router.post('/api/resilience/bss-readings', ...guard, async (req, res) => {
    const b = req.body || {};
    const autonomyHours = Number(b.autonomyHours);
    const socPct = Number(b.socPct);
    const icoPct = Number(b.icoPct);
    if (!Number.isFinite(autonomyHours) || autonomyHours < 0) return res.status(400).json({ error: 'autonomyHours invalido' });
    if (!Number.isFinite(socPct) || socPct < 0 || socPct > 100) return res.status(400).json({ error: 'socPct invalido (0-100)' });
    if (!Number.isFinite(icoPct) || icoPct < 0 || icoPct > 100) return res.status(400).json({ error: 'icoPct invalido (0-100)' });
    const doc = {
      _id: crypto.randomUUID(),
      autonomyHours,
      socPct,
      icoPct,
      source: typeof b.source === 'string' ? b.source.trim().slice(0, 300) : '',
      createdBy: req.user,
      createdAt: new Date().toISOString(),
    };
    await mongo.collection('resilience_bss_readings').insertOne(doc);
    await appendResilienceLog(mongo, { action: 'bss_reading.create', actorId: req.user, detail: { readingId: doc._id, autonomyHours, socPct, icoPct } });

    if (autonomyHours < 48 || socPct < 20) {
      const severity = socPct < 20 ? 'error' : 'warning';
      adminNotify?.({ origin: 'RESILIENCE', label: socPct < 20 ? 'BSS bajo umbral crítico de carga' : 'Autonomía BSS bajo objetivo (48h)', detail: `Autonomía: ${autonomyHours}h · SoC: ${socPct}% · ICO: ${icoPct}%`, severity });
      busEmit?.({ id: crypto.randomUUID(), ts: new Date().toISOString(), origin: 'RESILIENCE', dest: 'ELVIRA', type: 'alert', state: severity === 'error' ? 'BLOCKED' : 'PENDING', label: 'Desvío objetivo continuidad operativa BSS', payload: { readingId: doc._id, autonomyHours, socPct, icoPct } });
    }
    res.status(201).json(withId(doc));
  });

  /* ---- bloque 2: cadena de suministro / redundancia por componente (CRM proveedores) ---- */

  router.get('/api/resilience/suppliers', ...guard, async (req, res) => {
    const rows = await mongo.collection('resilience_suppliers').find({}).sort({ component: 1, isPrimary: -1 }).toArray();
    res.json(rows.map(withId));
  });

  router.post('/api/resilience/suppliers', ...guard, async (req, res) => {
    const b = req.body || {};
    const component = String(b.component || '').trim();
    const supplierName = String(b.supplierName || '').trim();
    const region = String(b.region || '').trim();
    if (!component) return res.status(400).json({ error: 'component requerido' });
    if (!supplierName) return res.status(400).json({ error: 'supplierName requerido' });
    if (!region) return res.status(400).json({ error: 'region requerida' });
    const leadTimeDays = Number(b.leadTimeDays);
    if (!Number.isFinite(leadTimeDays) || leadTimeDays < 0) return res.status(400).json({ error: 'leadTimeDays invalido' });
    const doc = {
      _id: crypto.randomUUID(),
      component,
      supplierName,
      region,
      leadTimeDays,
      status: SUPPLY_STATUSES.includes(b.status) ? b.status : 'activo',
      isPrimary: !!b.isPrimary,
      source: typeof b.source === 'string' ? b.source.trim().slice(0, 300) : '',
      createdBy: req.user,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await mongo.collection('resilience_suppliers').insertOne(doc);
    await appendResilienceLog(mongo, { action: 'supplier.create', actorId: req.user, detail: { supplierId: doc._id, component, supplierName, region } });
    res.status(201).json(withId(doc));
  });

  router.patch('/api/resilience/suppliers/:id', ...guard, async (req, res) => {
    const row = await mongo.collection('resilience_suppliers').findOne({ _id: req.params.id });
    if (!row) return res.status(404).json({ error: 'proveedor no encontrado' });
    const b = req.body || {};
    const $set = { updatedAt: new Date().toISOString() };
    if (b.leadTimeDays !== undefined) {
      const leadTimeDays = Number(b.leadTimeDays);
      if (!Number.isFinite(leadTimeDays) || leadTimeDays < 0) return res.status(400).json({ error: 'leadTimeDays invalido' });
      $set.leadTimeDays = leadTimeDays;
    }
    if (b.status !== undefined) {
      if (!SUPPLY_STATUSES.includes(b.status)) return res.status(400).json({ error: 'status invalido' });
      $set.status = b.status;
    }
    if (b.isPrimary !== undefined) $set.isPrimary = !!b.isPrimary;
    if (b.region !== undefined) $set.region = String(b.region).trim().slice(0, 100);
    if (b.source !== undefined) $set.source = String(b.source).trim().slice(0, 300);
    await mongo.collection('resilience_suppliers').updateOne({ _id: req.params.id }, { $set });
    await appendResilienceLog(mongo, { action: 'supplier.update', actorId: req.user, detail: { supplierId: req.params.id, $set } });
    const updated = await mongo.collection('resilience_suppliers').findOne({ _id: req.params.id });
    res.json(withId(updated));
  });

  router.delete('/api/resilience/suppliers/:id', ...guard, async (req, res) => {
    const result = await mongo.collection('resilience_suppliers').deleteOne({ _id: req.params.id });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'proveedor no encontrado' });
    await appendResilienceLog(mongo, { action: 'supplier.delete', actorId: req.user, detail: { supplierId: req.params.id } });
    res.json({ id: req.params.id });
  });

  /* ---- accionable: recalcular cadena tras bloqueo de region ----
   * Fase 1 (doctrina "se profundizara mas adelante"): para cada componente con
   * proveedor primario en una region marcada bloqueada, promueve el mejor
   * proveedor 'alterno' disponible (menor leadTimeDays) a primario. No ejecuta
   * ninguna orden de compra real, solo reasigna el CRM y deja constancia en
   * el log inmutable + senal a Elvi-Ra. */

  router.post('/api/resilience/suppliers/recalculate', ...guard, async (req, res) => {
    const b = req.body || {};
    const blockedRegions = Array.isArray(b.blockedRegions) ? b.blockedRegions.map((r) => String(r).trim()).filter(Boolean) : [];
    if (blockedRegions.length === 0) return res.status(400).json({ error: 'blockedRegions requerido (array de regiones)' });

    const all = await mongo.collection('resilience_suppliers').find({}).toArray();
    const byComponent = new Map();
    for (const s of all) {
      if (!byComponent.has(s.component)) byComponent.set(s.component, []);
      byComponent.get(s.component).push(s);
    }

    const changes = [];
    for (const [component, list] of byComponent.entries()) {
      const primary = list.find((s) => s.isPrimary);
      if (!primary || !blockedRegions.includes(primary.region)) continue;
      const candidates = list.filter((s) => s._id !== primary._id && !blockedRegions.includes(s.region) && s.status !== 'bloqueado')
        .sort((a, b2) => a.leadTimeDays - b2.leadTimeDays);
      const replacement = candidates[0];
      changes.push({ component, previousSupplierId: primary._id, previousSupplierName: primary.supplierName, previousRegion: primary.region, replacementSupplierId: replacement?._id || null, replacementSupplierName: replacement?.supplierName || null, replacementRegion: replacement?.region || null, resolved: !!replacement });
    }

    const ops = [];
    for (const c of changes) {
      ops.push(mongo.collection('resilience_suppliers').updateOne({ _id: c.previousSupplierId }, { $set: { status: 'bloqueado', isPrimary: false, updatedAt: new Date().toISOString() } }));
      if (c.replacementSupplierId) {
        ops.push(mongo.collection('resilience_suppliers').updateOne({ _id: c.replacementSupplierId }, { $set: { isPrimary: true, updatedAt: new Date().toISOString() } }));
      }
    }
    await Promise.all(ops);

    const snapshot = { recalculatedAt: new Date().toISOString(), recalculatedBy: req.user, blockedRegions, changes };
    const logEntry = await appendResilienceLog(mongo, { action: 'suppliers.recalculate', actorId: req.user, detail: { blockedRegions, changesCount: changes.length, unresolved: changes.filter((c) => !c.resolved).length } });

    const unresolved = changes.filter((c) => !c.resolved);
    adminNotify?.({ origin: 'RESILIENCE', label: `Cadena de suministro recalculada (${changes.length} componentes afectados)`, detail: unresolved.length > 0 ? `${unresolved.length} componentes sin proveedor alterno disponible: ${unresolved.map((c) => c.component).join(', ')}` : 'Todos los componentes reasignados a proveedor alterno', severity: unresolved.length > 0 ? 'error' : 'warning' });
    busEmit?.({ id: crypto.randomUUID(), ts: new Date().toISOString(), origin: 'RESILIENCE', dest: 'ELVIRA', type: 'alert', state: unresolved.length > 0 ? 'BLOCKED' : 'COMPLETED', label: 'Recalculo cadena de suministro', payload: { blockedRegions, changesCount: changes.length } });

    res.status(201).json({ logSeq: logEntry.seq, snapshot });
  });

  /* ---- bloque 3: resiliencia de datos transfronterizos (RPO/RTO/backup soberania) ---- */

  router.get('/api/resilience/backup-status', ...guard, async (req, res) => {
    const doc = await mongo.collection('resilience_backup_status').findOne({ _id: ISOLATED_MODE_ID }) || DEFAULT_BACKUP_STATUS;
    res.json(withId(doc));
  });

  router.patch('/api/resilience/backup-status', ...guard, async (req, res) => {
    const b = req.body || {};
    const $set = { updatedAt: new Date().toISOString(), updatedBy: req.user };
    if (b.destination !== undefined) $set.destination = String(b.destination).trim().slice(0, 200);
    if (b.rpoMinutes !== undefined) {
      const rpoMinutes = b.rpoMinutes === null || b.rpoMinutes === '' ? null : Number(b.rpoMinutes);
      if (rpoMinutes !== null && (!Number.isFinite(rpoMinutes) || rpoMinutes < 0)) return res.status(400).json({ error: 'rpoMinutes invalido' });
      $set.rpoMinutes = rpoMinutes;
    }
    if (b.rtoMinutes !== undefined) {
      const rtoMinutes = b.rtoMinutes === null || b.rtoMinutes === '' ? null : Number(b.rtoMinutes);
      if (rtoMinutes !== null && (!Number.isFinite(rtoMinutes) || rtoMinutes < 0)) return res.status(400).json({ error: 'rtoMinutes invalido' });
      $set.rtoMinutes = rtoMinutes;
    }
    if (b.dataVolumeGb !== undefined) {
      const dataVolumeGb = b.dataVolumeGb === null || b.dataVolumeGb === '' ? null : Number(b.dataVolumeGb);
      if (dataVolumeGb !== null && (!Number.isFinite(dataVolumeGb) || dataVolumeGb < 0)) return res.status(400).json({ error: 'dataVolumeGb invalido' });
      $set.dataVolumeGb = dataVolumeGb;
    }
    if (b.status !== undefined) {
      if (!BACKUP_STATUSES.includes(b.status)) return res.status(400).json({ error: 'status invalido' });
      $set.status = b.status;
    }
    if (b.source !== undefined) $set.source = String(b.source).trim().slice(0, 300);
    await mongo.collection('resilience_backup_status').updateOne({ _id: ISOLATED_MODE_ID }, { $set }, { upsert: true });
    await appendResilienceLog(mongo, { action: 'backup_status.update', actorId: req.user, detail: { $set } });
    const updated = await mongo.collection('resilience_backup_status').findOne({ _id: ISOLATED_MODE_ID });
    res.json(withId(updated));
  });

  /* ---- accionable: encriptar y migrar datos de soberania ----
   * Fase 1 (doctrina "por concretar"): genera snapshot cifrado localmente
   * (AES-256-GCM, node:crypto) con metadatos de destino/volumen, deja hash
   * como prueba de integridad en resilience_log. Sin transferencia real a
   * Suiza/Islandia hasta que exista el servidor fisico — mismo patron que
   * emit-certificate/tokenize de Pactvm Carbono. */

  router.post('/api/resilience/sovereignty/migrate', ...guard, async (req, res) => {
    const b = req.body || {};
    const destination = String(b.destination || '').trim();
    if (!destination) return res.status(400).json({ error: 'destination requerido' });
    const dataVolumeGb = Number(b.dataVolumeGb);
    if (!Number.isFinite(dataVolumeGb) || dataVolumeGb < 0) return res.status(400).json({ error: 'dataVolumeGb invalido' });

    const migrationId = crypto.randomUUID();
    const key = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);
    const payload = JSON.stringify({ migrationId, destination, dataVolumeGb, requestedBy: req.user, requestedAt: new Date().toISOString() });
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const payloadHash = crypto.createHash('sha256').update(encrypted).digest('hex');

    const snapshot = {
      migrationId,
      destination,
      dataVolumeGb,
      generatedAt: new Date().toISOString(),
      generatedBy: req.user,
      status: 'SNAPSHOT_CIFRADO_LOCAL — sin transferencia real (servidor de respaldo pendiente de infraestructura)',
      payloadHash,
      encryptionAlgo: 'aes-256-gcm',
    };
    const logEntry = await appendResilienceLog(mongo, { action: 'sovereignty.migrate_requested', actorId: req.user, detail: { migrationId, destination, dataVolumeGb, payloadHash } });

    adminNotify?.({ origin: 'RESILIENCE', label: `Migración de soberanía de datos solicitada — destino ${destination}`, detail: `Volumen: ${dataVolumeGb} GB · Snapshot cifrado local, sin transferencia real (infraestructura pendiente)`, severity: 'warning' });
    busEmit?.({ id: crypto.randomUUID(), ts: new Date().toISOString(), origin: 'RESILIENCE', dest: 'ELVIRA', type: 'alert', state: 'PENDING', label: 'Migración soberanía de datos propuesta', payload: { migrationId, destination, dataVolumeGb } });

    res.status(201).json({ logSeq: logEntry.seq, snapshot });
  });

  /* ---- accionable: ACTIVAR MODO AISLADO (conmutacion red -> mesh/satelital) ----
   * Fase 1 (doctrina "se profundizara mas adelante"): sin socket real de red
   * mesh/satelital conectado. Simulacro: marca de tiempo + registro inmutable
   * + senal a Elvi-Ra, reversible. Misma logica que apertura de puerto en
   * Consola Maestra & Control de Trafico (Reff). */

  router.get('/api/resilience/isolated-mode', ...guard, async (req, res) => {
    const doc = await mongo.collection('resilience_isolated_mode').findOne({ _id: ISOLATED_MODE_ID }) || DEFAULT_ISOLATED_MODE_STATE;
    res.json(withId(doc));
  });

  router.post('/api/resilience/isolated-mode/activate', ...guard, async (req, res) => {
    const b = req.body || {};
    const reason = typeof b.reason === 'string' ? b.reason.trim().slice(0, 500) : '';
    const current = await mongo.collection('resilience_isolated_mode').findOne({ _id: ISOLATED_MODE_ID });
    if (current?.active) return res.status(409).json({ error: 'modo aislado ya está activo' });
    const now = new Date().toISOString();
    await mongo.collection('resilience_isolated_mode').updateOne({ _id: ISOLATED_MODE_ID }, { $set: { active: true, activatedAt: now, activatedBy: req.user, deactivatedAt: null } }, { upsert: true });
    const logEntry = await appendResilienceLog(mongo, { action: 'isolated_mode.activate', actorId: req.user, detail: { reason: reason || null, simulated: true } });

    adminNotify?.({ origin: 'RESILIENCE', label: 'MODO AISLADO activado (simulacro)', detail: `Conmutación de comunicaciones a red mesh/satelital solicitada por ${req.user}${reason ? ` · Motivo: ${reason}` : ''}. Sin conexión mesh/satelital real conectada todavía.`, severity: 'error' });
    busEmit?.({ id: crypto.randomUUID(), ts: new Date().toISOString(), origin: 'RESILIENCE', dest: 'ELVIRA', type: 'alert', state: 'PENDING', label: 'Activación modo aislado (simulacro)', payload: { reason: reason || null } });

    res.status(201).json({ logSeq: logEntry.seq, active: true, activatedAt: now, simulated: true });
  });

  router.post('/api/resilience/isolated-mode/deactivate', ...guard, async (req, res) => {
    const current = await mongo.collection('resilience_isolated_mode').findOne({ _id: ISOLATED_MODE_ID });
    if (!current?.active) return res.status(409).json({ error: 'modo aislado no está activo' });
    const now = new Date().toISOString();
    await mongo.collection('resilience_isolated_mode').updateOne({ _id: ISOLATED_MODE_ID }, { $set: { active: false, deactivatedAt: now } });
    const logEntry = await appendResilienceLog(mongo, { action: 'isolated_mode.deactivate', actorId: req.user, detail: { simulated: true } });
    adminNotify?.({ origin: 'RESILIENCE', label: 'MODO AISLADO desactivado', detail: `Vuelta a comunicaciones normales, solicitado por ${req.user}.`, severity: 'warning' });
    res.status(201).json({ logSeq: logEntry.seq, active: false, deactivatedAt: now });
  });

  /* ---- resumen KPI ---- */

  router.get('/api/resilience/summary', ...guard, async (req, res) => {
    const [lastReading, suppliers, backupStatus, isolatedMode] = await Promise.all([
      mongo.collection('resilience_bss_readings').find({}).sort({ createdAt: -1 }).limit(1).next(),
      mongo.collection('resilience_suppliers').find({}).toArray(),
      mongo.collection('resilience_backup_status').findOne({ _id: ISOLATED_MODE_ID }),
      mongo.collection('resilience_isolated_mode').findOne({ _id: ISOLATED_MODE_ID }),
    ]);
    const componentsTracked = new Set(suppliers.map((s) => s.component)).size;
    const componentsWithoutRedundancy = [...new Set(suppliers.map((s) => s.component))]
      .filter((c) => suppliers.filter((s) => s.component === c).length < 2).length;
    res.json({
      autonomyHours: lastReading?.autonomyHours ?? null,
      socPct: lastReading?.socPct ?? null,
      icoPct: lastReading?.icoPct ?? null,
      componentsTracked,
      componentsWithoutRedundancy,
      suppliersTotal: suppliers.length,
      backupStatus: backupStatus?.status ?? 'critico',
      rpoMinutes: backupStatus?.rpoMinutes ?? null,
      rtoMinutes: backupStatus?.rtoMinutes ?? null,
      isolatedModeActive: !!isolatedMode?.active,
    });
  });

  /* ---- integridad del log ---- */

  router.get('/api/resilience/log/verify', ...guard, async (req, res) => {
    const all = await mongo.collection('resilience_log').find({}).sort({ seq: 1 }).toArray();
    let prev = '0'.repeat(64);
    for (const entry of all) {
      const { _id, seq, prevHash, hash, createdAt, ...rest } = entry;
      const expectedHash = crypto.createHash('sha256').update(prev + canonical({ ...rest, seq })).digest('hex');
      if (expectedHash !== hash || prevHash !== prev) {
        return res.json({ valid: false, totalEntries: all.length, brokenAtSeq: seq });
      }
      prev = hash;
    }
    res.json({ valid: true, totalEntries: all.length, brokenAtSeq: null });
  });
}
