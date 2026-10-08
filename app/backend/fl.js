/**
 * S-NFI F&L (Fiscal & Legal) — Audit Legal: Firmas & Normas.
 *
 * Reconstrucción completa (2026-09-08, misma sesión que vació la mesa a
 * placeholder "boletines" — el jefe confirmó en esta sesión que ese alcance
 * era contexto de paso, no la directriz final: F&L vuelve a ser el módulo de
 * compliance completo). Ver FL-PLAN.md en la raíz del repo.
 *
 * Alcance (3 partes, un único backend, mismo patrón que Finance/M&A/Pactvm
 * Viridi: CRUD directo sobre Mongo, sin router TS separado, log inmutable
 * propio fl_log con hash chain):
 *
 *  1. Licencias y permisos multi-planta ante SEMARNAT/CONAGUA/CFE/MITECO:
 *     instalaciones, licencias, métricas medidas vs límite legal,
 *     condicionantes/obligaciones, evidencia con hash SHA-256, inspecciones
 *     y sanciones. KPIs por entidad reguladora.
 *  2. Matriz de responsabilidad civil/penal activa por proyecto: proyectos
 *     legales propios de F&L (no existe módulo de "Projects" genérico en el
 *     sistema — se crean aquí, mismo patrón que mna_deals en M&A), hitos,
 *     matriz de riesgo con deber de garante y gating de pagos.
 *  3. Motor de alarmas de caducidad de poderes corporativos y firmas
 *     digitales, conectado a adminNotify (sistema de notificaciones que ya
 *     existe en notifications.routes.js — no es un módulo nuevo).
 */

import crypto from 'node:crypto';
import { runAsTenant } from './db/tenant-context.js';
import { DEFAULT_TENANT_ID } from './db/tenant-registry.js';

function withId(doc) {
  if (!doc) return doc;
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function canonical(entry) {
  return JSON.stringify(entry, Object.keys(entry).sort());
}

async function appendFlLog(mongo, entry) {
  const col = mongo.collection('fl_log');
  const tail = await col.find().sort({ seq: -1 }).limit(1).next();
  const seq = tail ? tail.seq + 1 : 1;
  const prevHash = tail ? tail.hash : '0'.repeat(64);
  const canonicalEntry = { ...entry, seq };
  const hash = crypto.createHash('sha256').update(prevHash + canonical(canonicalEntry)).digest('hex');
  const doc = { _id: crypto.randomUUID(), ...entry, seq, prevHash, hash, createdAt: new Date().toISOString() };
  await col.insertOne(doc);
  return doc;
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

function isValidDate(s) {
  return typeof s === 'string' && s && !Number.isNaN(Date.parse(s));
}

function daysUntil(dateStr) {
  const target = new Date(dateStr);
  const now = new Date();
  return Math.floor((target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

/* ---- catálogos (enums del brief) ---- */

const PAISES = ['México', 'España'];
const DEPENDENCIAS = ['SEMARNAT', 'CONAGUA', 'CFE', 'MITECO', 'OTRO_LOCAL'];
const ESTADOS_TRAMITE = ['Vigente', 'En_Renovación', 'Vencido', 'En_Prevención', 'Revocado', 'No_Aplica'];
const TIPOS_PARAMETRO = ['Volumen_Agua_m3', 'Factor_Potencia', 'Descarga_BOD', 'CO2_Emisiones', 'Otro'];
const FRECUENCIAS = ['Única', 'Mensual', 'Trimestral', 'Semestral', 'Anual', 'Por_Evento'];
const ESTADOS_CONDICIONANTE = ['Cumplido', 'Pendiente', 'En_Revision', 'Incumplido', 'Atrasado'];
const CRITICIDADES = ['Alta', 'Media', 'Baja'];
const TIPOS_DOCUMENTO = ['Reporte_Laboratorio', 'Acuse_Oficio', 'Fotografía', 'Factura', 'Otro'];
const AUTORIDADES_INSPECTORAS = ['SEMARNAT', 'PROFEPA', 'CONAGUA', 'CFE', 'MITECO', 'OTRA'];
const RESULTADOS_VISITA = ['Sin_Observaciones', 'Con_Observaciones', 'Apercibimiento', 'Clausura_Parcial', 'Clausura_Total'];
const ESTATUS_RESOLUCION = ['Abierta', 'En_Impugnacion_Legal', 'Cerrada_Resuelta'];

/* Parte 2 */
const TIPOS_RIESGO_LEGAL = ['PENAL', 'CIVIL', 'TRIBUTARIO_FISCAL', 'LABORAL'];
const NIVELES_RIESGO = ['CRITICO', 'ALTO', 'MEDIO', 'BAJO'];
const ESTADOS_CONTROL = ['PENDIENTE', 'VERIFICADO', 'EN_ALERTA', 'EXCEPCION_APROBADA'];
const ESTADOS_HITO = ['PLANIFICADO', 'EN_EJECUCION', 'APROBADO_PARA_PAGO', 'COMPLETADO'];

/* Parte 3 */
const TIPOS_PODER = ['Poder_Notarial', 'Firma_Digital', 'Certificado_Representacion', 'Otro'];
const ESTADOS_PODER = ['Vigente', 'Por_Caducar', 'Caducado', 'Renovado'];

export function mountFl(app, { auth, requireMesa, mongo, busEmit, adminNotify }) {
  const router = app;
  const guard = [auth, requireMesa('fl')];

  async function requireInstalacion(id) {
    return mongo.collection('fl_instalaciones').findOne({ _id: id });
  }
  async function requireLicencia(id) {
    return mongo.collection('fl_licencias').findOne({ _id: id });
  }
  async function requireProyecto(id) {
    return mongo.collection('fl_proyectos_legales').findOne({ _id: id });
  }
  async function requireHito(id) {
    return mongo.collection('fl_hitos').findOne({ _id: id });
  }

  /* ==========================================================================
     PARTE 1 · Licencias y permisos multi-planta
  ========================================================================== */

  /* ---- instalaciones ---- */

  router.get('/api/fl/instalaciones', ...guard, async (req, res) => {
    const rows = await mongo.collection('fl_instalaciones').find({}).sort({ nombre_instalacion: 1 }).toArray();
    res.json(rows.map(withId));
  });

  router.post('/api/fl/instalaciones', ...guard, async (req, res) => {
    const b = req.body || {};
    const nombre_instalacion = String(b.nombre_instalacion || '').trim();
    if (!nombre_instalacion) return res.status(400).json({ error: 'nombre_instalacion requerido' });
    if (b.pais && !PAISES.includes(b.pais)) return res.status(400).json({ error: 'pais invalido' });

    const doc = {
      _id: crypto.randomUUID(),
      nombre_instalacion,
      pais: b.pais || null,
      region_estado: typeof b.region_estado === 'string' ? b.region_estado.trim() : null,
      coordenadas_gps: typeof b.coordenadas_gps === 'string' ? b.coordenadas_gps.trim() : null,
      id_responsable_planta: typeof b.id_responsable_planta === 'string' ? b.id_responsable_planta.trim() : null,
      createdBy: req.user,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await mongo.collection('fl_instalaciones').insertOne(doc);
    await appendFlLog(mongo, { action: 'instalacion.create', actorId: req.user, detail: { instalacionId: doc._id, nombre: nombre_instalacion } });
    res.status(201).json(withId(doc));
  });

  router.patch('/api/fl/instalaciones/:id', ...guard, async (req, res) => {
    const row = await requireInstalacion(req.params.id);
    if (!row) return res.status(404).json({ error: 'instalacion no encontrada' });
    const b = req.body || {};
    const $set = { updatedAt: new Date().toISOString() };
    if (b.nombre_instalacion !== undefined) {
      const v = String(b.nombre_instalacion || '').trim();
      if (!v) return res.status(400).json({ error: 'nombre_instalacion no puede quedar vacio' });
      $set.nombre_instalacion = v;
    }
    if (b.pais !== undefined) {
      if (b.pais && !PAISES.includes(b.pais)) return res.status(400).json({ error: 'pais invalido' });
      $set.pais = b.pais || null;
    }
    if (b.region_estado !== undefined) $set.region_estado = b.region_estado ? String(b.region_estado).trim() : null;
    if (b.coordenadas_gps !== undefined) $set.coordenadas_gps = b.coordenadas_gps ? String(b.coordenadas_gps).trim() : null;
    if (b.id_responsable_planta !== undefined) $set.id_responsable_planta = b.id_responsable_planta ? String(b.id_responsable_planta).trim() : null;
    await mongo.collection('fl_instalaciones').updateOne({ _id: req.params.id }, { $set });
    const updated = await requireInstalacion(req.params.id);
    res.json(withId(updated));
  });

  router.delete('/api/fl/instalaciones/:id', ...guard, async (req, res) => {
    const licCount = await mongo.collection('fl_licencias').countDocuments({ id_instalacion: req.params.id });
    if (licCount > 0) return res.status(409).json({ error: 'no se puede eliminar: tiene licencias asociadas' });
    const result = await mongo.collection('fl_instalaciones').deleteOne({ _id: req.params.id });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'instalacion no encontrada' });
    await appendFlLog(mongo, { action: 'instalacion.delete', actorId: req.user, detail: { instalacionId: req.params.id } });
    res.json({ id: req.params.id });
  });

  /* ---- licencias / permisos ---- */

  router.get('/api/fl/licencias', ...guard, async (req, res) => {
    const filter = {};
    if (req.query.id_instalacion) filter.id_instalacion = String(req.query.id_instalacion);
    if (req.query.dependencia) filter.dependencia = String(req.query.dependencia);
    const rows = await mongo.collection('fl_licencias').find(filter).sort({ fecha_vencimiento: 1 }).toArray();
    res.json(rows.map(withId));
  });

  router.post('/api/fl/licencias', ...guard, async (req, res) => {
    const b = req.body || {};
    const instalacion = await requireInstalacion(b.id_instalacion);
    if (!instalacion) return res.status(400).json({ error: 'id_instalacion invalido' });
    if (!DEPENDENCIAS.includes(b.dependencia)) return res.status(400).json({ error: 'dependencia invalida' });
    const tipo_permiso = String(b.tipo_permiso || '').trim();
    if (!tipo_permiso) return res.status(400).json({ error: 'tipo_permiso requerido' });
    if (!isValidDate(b.fecha_emision)) return res.status(400).json({ error: 'fecha_emision invalida' });
    if (!isValidDate(b.fecha_vencimiento)) return res.status(400).json({ error: 'fecha_vencimiento invalida' });
    if (b.estado_tramite && !ESTADOS_TRAMITE.includes(b.estado_tramite)) return res.status(400).json({ error: 'estado_tramite invalido' });

    const doc = {
      _id: crypto.randomUUID(),
      id_instalacion: b.id_instalacion,
      codigo_interno: typeof b.codigo_interno === 'string' ? b.codigo_interno.trim() : null,
      dependencia: b.dependencia,
      tipo_permiso,
      numero_oficio_folio: typeof b.numero_oficio_folio === 'string' ? b.numero_oficio_folio.trim() : null,
      fecha_emision: b.fecha_emision,
      fecha_vencimiento: b.fecha_vencimiento,
      requiere_renovacion: b.requiere_renovacion !== false,
      dias_alerta_vencimiento: Number.isFinite(Number(b.dias_alerta_vencimiento)) ? Number(b.dias_alerta_vencimiento) : 180,
      estado_tramite: b.estado_tramite || 'Vigente',
      costo_derechos_tramite: Number.isFinite(Number(b.costo_derechos_tramite)) ? round2(Number(b.costo_derechos_tramite)) : 0,
      id_responsable_usuario: typeof b.id_responsable_usuario === 'string' ? b.id_responsable_usuario.trim() : null,
      createdBy: req.user,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await mongo.collection('fl_licencias').insertOne(doc);
    await appendFlLog(mongo, { action: 'licencia.create', actorId: req.user, detail: { licenciaId: doc._id, dependencia: doc.dependencia, tipo_permiso } });
    res.status(201).json(withId(doc));
  });

  router.patch('/api/fl/licencias/:id', ...guard, async (req, res) => {
    const row = await requireLicencia(req.params.id);
    if (!row) return res.status(404).json({ error: 'licencia no encontrada' });
    const b = req.body || {};
    const $set = { updatedAt: new Date().toISOString() };
    if (b.codigo_interno !== undefined) $set.codigo_interno = b.codigo_interno ? String(b.codigo_interno).trim() : null;
    if (b.numero_oficio_folio !== undefined) $set.numero_oficio_folio = b.numero_oficio_folio ? String(b.numero_oficio_folio).trim() : null;
    if (b.fecha_emision !== undefined) {
      if (!isValidDate(b.fecha_emision)) return res.status(400).json({ error: 'fecha_emision invalida' });
      $set.fecha_emision = b.fecha_emision;
    }
    if (b.fecha_vencimiento !== undefined) {
      if (!isValidDate(b.fecha_vencimiento)) return res.status(400).json({ error: 'fecha_vencimiento invalida' });
      $set.fecha_vencimiento = b.fecha_vencimiento;
    }
    if (b.requiere_renovacion !== undefined) $set.requiere_renovacion = !!b.requiere_renovacion;
    if (b.dias_alerta_vencimiento !== undefined) {
      const v = Number(b.dias_alerta_vencimiento);
      if (!Number.isFinite(v) || v < 0) return res.status(400).json({ error: 'dias_alerta_vencimiento invalido' });
      $set.dias_alerta_vencimiento = v;
    }
    if (b.estado_tramite !== undefined) {
      if (!ESTADOS_TRAMITE.includes(b.estado_tramite)) return res.status(400).json({ error: 'estado_tramite invalido' });
      $set.estado_tramite = b.estado_tramite;
    }
    if (b.costo_derechos_tramite !== undefined) {
      const v = Number(b.costo_derechos_tramite);
      if (!Number.isFinite(v) || v < 0) return res.status(400).json({ error: 'costo_derechos_tramite invalido' });
      $set.costo_derechos_tramite = round2(v);
    }
    if (b.id_responsable_usuario !== undefined) $set.id_responsable_usuario = b.id_responsable_usuario ? String(b.id_responsable_usuario).trim() : null;

    await mongo.collection('fl_licencias').updateOne({ _id: req.params.id }, { $set });
    if ($set.estado_tramite && $set.estado_tramite !== row.estado_tramite) {
      await appendFlLog(mongo, { action: 'licencia.estado_change', actorId: req.user, detail: { licenciaId: row._id, from: row.estado_tramite, to: $set.estado_tramite } });
    }
    const updated = await requireLicencia(req.params.id);
    res.json(withId(updated));
  });

  router.delete('/api/fl/licencias/:id', ...guard, async (req, res) => {
    const result = await mongo.collection('fl_licencias').deleteOne({ _id: req.params.id });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'licencia no encontrada' });
    await Promise.all([
      mongo.collection('fl_metricas').deleteMany({ id_licencia: req.params.id }),
      mongo.collection('fl_condicionantes').deleteMany({ id_licencia: req.params.id }),
    ]);
    await appendFlLog(mongo, { action: 'licencia.delete', actorId: req.user, detail: { licenciaId: req.params.id } });
    res.json({ id: req.params.id });
  });

  /* ---- métricas / parámetros medidos ---- */

  router.get('/api/fl/licencias/:id/metricas', ...guard, async (req, res) => {
    const rows = await mongo.collection('fl_metricas').find({ id_licencia: req.params.id }).sort({ fecha_medicion: -1 }).toArray();
    res.json(rows.map(withId));
  });

  router.post('/api/fl/licencias/:id/metricas', ...guard, async (req, res) => {
    const licencia = await requireLicencia(req.params.id);
    if (!licencia) return res.status(404).json({ error: 'licencia no encontrada' });
    const b = req.body || {};
    if (!TIPOS_PARAMETRO.includes(b.tipo_parametro)) return res.status(400).json({ error: 'tipo_parametro invalido' });
    const valor_limite_autorizado = Number(b.valor_limite_autorizado);
    const valor_real_medido = Number(b.valor_real_medido);
    if (!Number.isFinite(valor_limite_autorizado) || valor_limite_autorizado < 0) return res.status(400).json({ error: 'valor_limite_autorizado invalido' });
    if (!Number.isFinite(valor_real_medido) || valor_real_medido < 0) return res.status(400).json({ error: 'valor_real_medido invalido' });
    if (!isValidDate(b.fecha_medicion)) return res.status(400).json({ error: 'fecha_medicion invalida' });

    const cumple_limite_legal = valor_real_medido <= valor_limite_autorizado;
    const doc = {
      _id: crypto.randomUUID(),
      id_licencia: req.params.id,
      tipo_parametro: b.tipo_parametro,
      valor_limite_autorizado,
      valor_real_medido,
      unidad_medida: typeof b.unidad_medida === 'string' ? b.unidad_medida.trim() : '',
      fecha_medicion: b.fecha_medicion,
      cumple_limite_legal,
      createdBy: req.user,
      createdAt: new Date().toISOString(),
    };
    await mongo.collection('fl_metricas').insertOne(doc);

    /* Regla 2: control extracción CONAGUA — alerta amarilla 85%, roja+bloqueo 100% */
    if (b.tipo_parametro === 'Volumen_Agua_m3') {
      const suma = await mongo.collection('fl_metricas').aggregate([
        { $match: { id_licencia: req.params.id, tipo_parametro: 'Volumen_Agua_m3' } },
        { $group: { _id: null, total: { $sum: '$valor_real_medido' } } },
      ]).toArray();
      const totalExtraido = suma[0]?.total || 0;
      const pct = valor_limite_autorizado > 0 ? (totalExtraido / valor_limite_autorizado) * 100 : 0;
      if (pct >= 100) {
        adminNotify?.({ origin: 'FL', label: `Desborde legal extracción agua — licencia ${licencia.codigo_interno || licencia._id}`, detail: `${round2(totalExtraido)} / ${valor_limite_autorizado} m3 (${round2(pct)}%)`, severity: 'error' });
        busEmit?.({ id: crypto.randomUUID(), ts: new Date().toISOString(), origin: 'FL', dest: 'ADMIN', type: 'alert', state: 'BLOCKED', label: 'Desborde legal CONAGUA', payload: { licenciaId: licencia._id, pct: round2(pct) } });
      } else if (pct >= 85) {
        adminNotify?.({ origin: 'FL', label: `Alerta amarilla extracción agua — licencia ${licencia.codigo_interno || licencia._id}`, detail: `${round2(totalExtraido)} / ${valor_limite_autorizado} m3 (${round2(pct)}%)`, severity: 'warning' });
      }
    }

    if (!cumple_limite_legal) {
      await appendFlLog(mongo, { action: 'metrica.incumplimiento', actorId: req.user, detail: { licenciaId: req.params.id, tipo_parametro: b.tipo_parametro, valor_real_medido, valor_limite_autorizado } });
    }
    res.status(201).json(withId(doc));
  });

  /* ---- condicionantes / obligaciones ---- */

  router.get('/api/fl/licencias/:id/condicionantes', ...guard, async (req, res) => {
    const rows = await mongo.collection('fl_condicionantes').find({ id_licencia: req.params.id }).sort({ fecha_limite_entrega: 1 }).toArray();
    res.json(rows.map(withId));
  });

  router.post('/api/fl/licencias/:id/condicionantes', ...guard, async (req, res) => {
    const licencia = await requireLicencia(req.params.id);
    if (!licencia) return res.status(404).json({ error: 'licencia no encontrada' });
    const b = req.body || {};
    const codigo_condicionante = String(b.codigo_condicionante || '').trim();
    if (!codigo_condicionante) return res.status(400).json({ error: 'codigo_condicionante requerido' });
    if (!FRECUENCIAS.includes(b.frecuencia_cumplimiento)) return res.status(400).json({ error: 'frecuencia_cumplimiento invalida' });
    if (b.criticidad && !CRITICIDADES.includes(b.criticidad)) return res.status(400).json({ error: 'criticidad invalida' });

    const doc = {
      _id: crypto.randomUUID(),
      id_licencia: req.params.id,
      codigo_condicionante,
      descripcion_requisito: typeof b.descripcion_requisito === 'string' ? b.descripcion_requisito.slice(0, 2000) : '',
      frecuencia_cumplimiento: b.frecuencia_cumplimiento,
      fecha_limite_entrega: isValidDate(b.fecha_limite_entrega) ? b.fecha_limite_entrega : null,
      estado_cumplimiento: 'Pendiente',
      porcentaje_avance: 0,
      requiere_evidencia_documental: b.requiere_evidencia_documental !== false,
      criticidad: b.criticidad || 'Media',
      createdBy: req.user,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await mongo.collection('fl_condicionantes').insertOne(doc);
    res.status(201).json(withId(doc));
  });

  router.patch('/api/fl/condicionantes/:id', ...guard, async (req, res) => {
    const row = await mongo.collection('fl_condicionantes').findOne({ _id: req.params.id });
    if (!row) return res.status(404).json({ error: 'condicionante no encontrado' });
    const b = req.body || {};
    const $set = { updatedAt: new Date().toISOString() };
    if (b.estado_cumplimiento !== undefined) {
      if (!ESTADOS_CONDICIONANTE.includes(b.estado_cumplimiento)) return res.status(400).json({ error: 'estado_cumplimiento invalido' });
      $set.estado_cumplimiento = b.estado_cumplimiento;
    }
    if (b.porcentaje_avance !== undefined) {
      const v = Number(b.porcentaje_avance);
      if (!Number.isFinite(v) || v < 0 || v > 100) return res.status(400).json({ error: 'porcentaje_avance invalido (0-100)' });
      $set.porcentaje_avance = v;
    }
    if (b.criticidad !== undefined) {
      if (!CRITICIDADES.includes(b.criticidad)) return res.status(400).json({ error: 'criticidad invalida' });
      $set.criticidad = b.criticidad;
    }
    if (b.fecha_limite_entrega !== undefined) {
      if (b.fecha_limite_entrega && !isValidDate(b.fecha_limite_entrega)) return res.status(400).json({ error: 'fecha_limite_entrega invalida' });
      $set.fecha_limite_entrega = b.fecha_limite_entrega || null;
    }
    await mongo.collection('fl_condicionantes').updateOne({ _id: req.params.id }, { $set });
    if ($set.estado_cumplimiento === 'Incumplido' && row.estado_cumplimiento !== 'Incumplido') {
      await appendFlLog(mongo, { action: 'condicionante.incumplido', actorId: req.user, detail: { condicionanteId: row._id, licenciaId: row.id_licencia } });
      adminNotify?.({ origin: 'FL', label: `Condicionante incumplido: ${row.codigo_condicionante}`, detail: row.descripcion_requisito?.slice(0, 200) || '', severity: row.criticidad === 'Alta' ? 'error' : 'warning' });
    }
    const updated = await mongo.collection('fl_condicionantes').findOne({ _id: req.params.id });
    res.json(withId(updated));
  });

  /* ---- evidencia (hash SHA-256 obligatorio) ---- */

  router.get('/api/fl/condicionantes/:id/evidencias', ...guard, async (req, res) => {
    const rows = await mongo.collection('fl_evidencias').find({ id_condicionante: req.params.id }).sort({ fecha_carga: -1 }).toArray();
    res.json(rows.map(withId));
  });

  router.post('/api/fl/condicionantes/:id/evidencias', ...guard, async (req, res) => {
    const condicionante = await mongo.collection('fl_condicionantes').findOne({ _id: req.params.id });
    if (!condicionante) return res.status(404).json({ error: 'condicionante no encontrado' });
    const b = req.body || {};
    if (!TIPOS_DOCUMENTO.includes(b.tipo_documento)) return res.status(400).json({ error: 'tipo_documento invalido' });
    const ruta_archivo_url = String(b.ruta_archivo_url || '').trim();
    if (!ruta_archivo_url) return res.status(400).json({ error: 'ruta_archivo_url requerido' });

    const doc = {
      _id: crypto.randomUUID(),
      id_condicionante: req.params.id,
      tipo_documento: b.tipo_documento,
      ruta_archivo_url,
      fecha_carga: new Date().toISOString(),
      usuario_carga: req.user,
      hash_documento: sha256(`${ruta_archivo_url}|${req.user}|${Date.now()}`),
      observaciones: typeof b.observaciones === 'string' ? b.observaciones.slice(0, 1000) : '',
    };
    await mongo.collection('fl_evidencias').insertOne(doc);
    await appendFlLog(mongo, { action: 'evidencia.upload', actorId: req.user, detail: { evidenciaId: doc._id, condicionanteId: req.params.id, hash: doc.hash_documento } });
    res.status(201).json(withId(doc));
  });

  /* ---- inspecciones / sanciones ---- */

  router.get('/api/fl/inspecciones', ...guard, async (req, res) => {
    const filter = {};
    if (req.query.id_instalacion) filter.id_instalacion = String(req.query.id_instalacion);
    const rows = await mongo.collection('fl_inspecciones').find(filter).sort({ fecha_visita: -1 }).toArray();
    res.json(rows.map(withId));
  });

  router.post('/api/fl/inspecciones', ...guard, async (req, res) => {
    const b = req.body || {};
    const instalacion = await requireInstalacion(b.id_instalacion);
    if (!instalacion) return res.status(400).json({ error: 'id_instalacion invalido' });
    if (!AUTORIDADES_INSPECTORAS.includes(b.autoridad_inspectora)) return res.status(400).json({ error: 'autoridad_inspectora invalida' });
    if (!isValidDate(b.fecha_visita)) return res.status(400).json({ error: 'fecha_visita invalida' });
    if (!RESULTADOS_VISITA.includes(b.resultado_visita)) return res.status(400).json({ error: 'resultado_visita invalido' });
    if (b.id_licencia) {
      const lic = await requireLicencia(b.id_licencia);
      if (!lic) return res.status(400).json({ error: 'id_licencia invalido' });
    }

    const doc = {
      _id: crypto.randomUUID(),
      id_instalacion: b.id_instalacion,
      id_licencia: b.id_licencia || null,
      autoridad_inspectora: b.autoridad_inspectora,
      fecha_visita: b.fecha_visita,
      resultado_visita: b.resultado_visita,
      monto_multa_economica: Number.isFinite(Number(b.monto_multa_economica)) ? round2(Number(b.monto_multa_economica)) : 0,
      fecha_limite_solucion: isValidDate(b.fecha_limite_solucion) ? b.fecha_limite_solucion : null,
      estatus_resolucion: 'Abierta',
      createdBy: req.user,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await mongo.collection('fl_inspecciones').insertOne(doc);
    await appendFlLog(mongo, { action: 'inspeccion.create', actorId: req.user, detail: { inspeccionId: doc._id, resultado: doc.resultado_visita, multa: doc.monto_multa_economica } });

    if (['Apercibimiento', 'Clausura_Parcial', 'Clausura_Total'].includes(doc.resultado_visita)) {
      adminNotify?.({ origin: 'FL', label: `Inspección ${doc.resultado_visita} — ${instalacion.nombre_instalacion}`, detail: `Autoridad: ${doc.autoridad_inspectora}${doc.monto_multa_economica ? ` · Multa: ${doc.monto_multa_economica}€` : ''}`, severity: 'error' });
      busEmit?.({ id: crypto.randomUUID(), ts: new Date().toISOString(), origin: 'FL', dest: 'ADMIN', type: 'alert', state: doc.resultado_visita.startsWith('Clausura') ? 'BLOCKED' : 'WARN', label: `Inspección ${doc.resultado_visita}`, payload: { inspeccionId: doc._id, instalacionId: instalacion._id, autoridad: doc.autoridad_inspectora, multa: doc.monto_multa_economica } });
    }
    res.status(201).json(withId(doc));
  });

  router.patch('/api/fl/inspecciones/:id', ...guard, async (req, res) => {
    const row = await mongo.collection('fl_inspecciones').findOne({ _id: req.params.id });
    if (!row) return res.status(404).json({ error: 'inspeccion no encontrada' });
    const b = req.body || {};
    const $set = { updatedAt: new Date().toISOString() };
    if (b.estatus_resolucion !== undefined) {
      if (!ESTATUS_RESOLUCION.includes(b.estatus_resolucion)) return res.status(400).json({ error: 'estatus_resolucion invalido' });
      $set.estatus_resolucion = b.estatus_resolucion;
    }
    if (b.monto_multa_economica !== undefined) {
      const v = Number(b.monto_multa_economica);
      if (!Number.isFinite(v) || v < 0) return res.status(400).json({ error: 'monto_multa_economica invalido' });
      $set.monto_multa_economica = round2(v);
    }
    await mongo.collection('fl_inspecciones').updateOne({ _id: req.params.id }, { $set });
    if ($set.estatus_resolucion && $set.estatus_resolucion !== row.estatus_resolucion) {
      await appendFlLog(mongo, { action: 'inspeccion.estatus_change', actorId: req.user, detail: { inspeccionId: row._id, from: row.estatus_resolucion, to: $set.estatus_resolucion } });
    }
    const updated = await mongo.collection('fl_inspecciones').findOne({ _id: req.params.id });
    res.json(withId(updated));
  });

  /* ---- KPIs específicos por licencia (fórmulas §3.2) ---- */

  router.get('/api/fl/licencias/:id/kpis', ...guard, async (req, res) => {
    const licencia = await requireLicencia(req.params.id);
    if (!licencia) return res.status(404).json({ error: 'licencia no encontrada' });

    const [condicionantes, metricas] = await Promise.all([
      mongo.collection('fl_condicionantes').find({ id_licencia: req.params.id }).toArray(),
      mongo.collection('fl_metricas').find({ id_licencia: req.params.id }).toArray(),
    ]);

    const out = { dependencia: licencia.dependencia };

    if (licencia.dependencia === 'SEMARNAT') {
      const total = condicionantes.length;
      const aprobadas = condicionantes.filter(c => c.estado_cumplimiento === 'Cumplido').length;
      out.mia_comp = total > 0 ? round2((aprobadas / total) * 100) : null;
    }
    if (licencia.dependencia === 'CONAGUA') {
      const aguaMetricas = metricas.filter(m => m.tipo_parametro === 'Volumen_Agua_m3');
      const limite = aguaMetricas[0]?.valor_limite_autorizado || 0;
      const totalExtraido = aguaMetricas.reduce((s, m) => s + m.valor_real_medido, 0);
      out.vol_agua_pct = limite > 0 ? round2((totalExtraido / limite) * 100) : null;
      const calidad = metricas.filter(m => m.tipo_parametro === 'Descarga_BOD');
      const conformes = calidad.filter(m => m.cumple_limite_legal).length;
      out.cal_agua_pct = calidad.length > 0 ? round2((conformes / calidad.length) * 100) : null;
    }
    if (licencia.dependencia === 'CFE') {
      const fp = metricas.filter(m => m.tipo_parametro === 'Factor_Potencia');
      const conformes = fp.filter(m => m.cumple_limite_legal).length;
      out.cod_red_pct = fp.length > 0 ? round2((conformes / fp.length) * 100) : null;
    }
    if (licencia.dependencia === 'MITECO') {
      const total = condicionantes.length;
      const ejecutadas = condicionantes.filter(c => c.estado_cumplimiento === 'Cumplido').length;
      out.pva_pct = total > 0 ? round2((ejecutadas / total) * 100) : null;
      const emisiones = metricas.filter(m => m.tipo_parametro === 'CO2_Emisiones');
      const conformes = emisiones.filter(m => m.cumple_limite_legal).length;
      out.aai_pct = emisiones.length > 0 ? round2((conformes / emisiones.length) * 100) : null;
    }
    res.json(out);
  });

  /* ==========================================================================
     PARTE 2 · Matriz de responsabilidad civil/penal activa por proyecto
     Ver módulo separado más abajo (mismo router, misma guard).
  ========================================================================== */

  /* ---- proyectos legales (propios de F&L) ---- */

  router.get('/api/fl/proyectos', ...guard, async (req, res) => {
    const rows = await mongo.collection('fl_proyectos_legales').find({}).sort({ nombre: 1 }).toArray();
    res.json(rows.map(withId));
  });

  router.post('/api/fl/proyectos', ...guard, async (req, res) => {
    const b = req.body || {};
    const nombre = String(b.nombre || '').trim();
    if (!nombre) return res.status(400).json({ error: 'nombre requerido' });
    if (b.id_instalacion) {
      const inst = await requireInstalacion(b.id_instalacion);
      if (!inst) return res.status(400).json({ error: 'id_instalacion invalido' });
    }
    const doc = {
      _id: crypto.randomUUID(),
      nombre,
      id_instalacion: b.id_instalacion || null,
      descripcion: typeof b.descripcion === 'string' ? b.descripcion.slice(0, 1000) : '',
      bloqueado: false,
      createdBy: req.user,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await mongo.collection('fl_proyectos_legales').insertOne(doc);
    await appendFlLog(mongo, { action: 'proyecto.create', actorId: req.user, detail: { proyectoId: doc._id, nombre } });
    res.status(201).json(withId(doc));
  });

  router.post('/api/fl/proyectos/:id/bloquear', ...guard, async (req, res) => {
    const proyecto = await requireProyecto(req.params.id);
    if (!proyecto) return res.status(404).json({ error: 'proyecto no encontrado' });
    const bloqueado = req.body?.bloqueado !== false;
    await mongo.collection('fl_proyectos_legales').updateOne({ _id: req.params.id }, { $set: { bloqueado, updatedAt: new Date().toISOString() } });
    await appendFlLog(mongo, { action: bloqueado ? 'proyecto.bloquear' : 'proyecto.desbloquear', actorId: req.user, detail: { proyectoId: req.params.id } });
    res.json({ id: req.params.id, bloqueado });
  });

  /* ---- hitos ---- */

  router.get('/api/fl/proyectos/:id/hitos', ...guard, async (req, res) => {
    const rows = await mongo.collection('fl_hitos').find({ project_id: req.params.id }).sort({ createdAt: 1 }).toArray();
    res.json(rows.map(withId));
  });

  router.post('/api/fl/proyectos/:id/hitos', ...guard, async (req, res) => {
    const proyecto = await requireProyecto(req.params.id);
    if (!proyecto) return res.status(404).json({ error: 'proyecto no encontrado' });
    const b = req.body || {};
    const nombre = String(b.nombre || '').trim();
    if (!nombre) return res.status(400).json({ error: 'nombre requerido' });
    const doc = {
      _id: crypto.randomUUID(),
      project_id: req.params.id,
      nombre,
      es_hito_financiero: !!b.es_hito_financiero,
      status: 'PLANIFICADO',
      createdBy: req.user,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await mongo.collection('fl_hitos').insertOne(doc);
    res.status(201).json(withId(doc));
  });

  /* Regla 2 (Alertas): hito -> EN_EJECUCION con controles sin verificar ->
     status EN_ALERTA en cada control + notificación al garante.
     Regla 1 (Gating de pago): hito -> APROBADO_PARA_PAGO con algún control
     gating CRITICO/ALTO != VERIFICADO -> 409 LegalGatingError, no transiciona. */
  router.post('/api/fl/hitos/:id/transicion', ...guard, async (req, res) => {
    const hito = await requireHito(req.params.id);
    if (!hito) return res.status(404).json({ error: 'hito no encontrado' });
    const to = req.body?.status;
    if (!ESTADOS_HITO.includes(to)) return res.status(400).json({ error: 'status invalido' });

    const controles = await mongo.collection('fl_matriz_riesgo').find({ milestone_id: req.params.id }).toArray();

    if (to === 'APROBADO_PARA_PAGO') {
      const bloqueantes = controles.filter(c => c.is_gating_control && c.status !== 'VERIFICADO' && c.status !== 'EXCEPCION_APROBADA');
      if (bloqueantes.length > 0) {
        return res.status(409).json({
          error: 'LegalGatingError',
          message: 'Existen controles gating sin verificar para este hito',
          controles: bloqueantes.map(withId),
        });
      }
    }

    if (to === 'EN_EJECUCION') {
      const sinVerificar = controles.filter(c => c.status === 'PENDIENTE');
      for (const c of sinVerificar) {
        await mongo.collection('fl_matriz_riesgo').updateOne({ _id: c._id }, { $set: { status: 'EN_ALERTA', updatedAt: new Date().toISOString() } });
        adminNotify?.({ origin: 'FL', label: `Control legal en alerta: ${c.risk_description?.slice(0, 80) || c._id}`, detail: `Hito: ${hito.nombre} · Riesgo: ${c.legal_risk_type}/${c.risk_level}`, severity: c.risk_level === 'CRITICO' ? 'error' : 'warning' });
        await appendFlLog(mongo, { action: 'control.en_alerta', actorId: req.user, detail: { controlId: c._id, hitoId: req.params.id, garante: c.duty_of_guarantor_user_id } });
      }
    }

    await mongo.collection('fl_hitos').updateOne({ _id: req.params.id }, { $set: { status: to, updatedAt: new Date().toISOString() } });
    await appendFlLog(mongo, { action: 'hito.transicion', actorId: req.user, detail: { hitoId: req.params.id, from: hito.status, to } });
    const updated = await requireHito(req.params.id);
    res.json(withId(updated));
  });

  /* ---- matriz de responsabilidad legal ---- */

  router.get('/api/fl/proyectos/:id/matriz-riesgo', ...guard, async (req, res) => {
    const rows = await mongo.collection('fl_matriz_riesgo').find({ project_id: req.params.id }).sort({ risk_level: 1 }).toArray();
    res.json(rows.map(withId));
  });

  router.post('/api/fl/matriz-riesgo', ...guard, async (req, res) => {
    const b = req.body || {};
    const proyecto = await requireProyecto(b.project_id);
    if (!proyecto) return res.status(400).json({ error: 'project_id invalido' });
    if (b.milestone_id) {
      const hito = await requireHito(b.milestone_id);
      if (!hito || hito.project_id !== b.project_id) return res.status(400).json({ error: 'milestone_id invalido' });
    }
    if (!TIPOS_RIESGO_LEGAL.includes(b.legal_risk_type)) return res.status(400).json({ error: 'legal_risk_type invalido' });
    if (!NIVELES_RIESGO.includes(b.risk_level)) return res.status(400).json({ error: 'risk_level invalido' });
    const risk_description = String(b.risk_description || '').trim();
    if (!risk_description) return res.status(400).json({ error: 'risk_description requerido' });
    const duty_of_guarantor_user_id = String(b.duty_of_guarantor_user_id || '').trim();
    if (!duty_of_guarantor_user_id) return res.status(400).json({ error: 'duty_of_guarantor_user_id requerido' });
    const garante = await mongo.collection('users').findOne({ _id: duty_of_guarantor_user_id });
    if (!garante) return res.status(400).json({ error: 'duty_of_guarantor_user_id no corresponde a un usuario' });

    const doc = {
      _id: crypto.randomUUID(),
      project_id: b.project_id,
      milestone_id: b.milestone_id || null,
      legal_risk_type: b.legal_risk_type,
      risk_description,
      risk_level: b.risk_level,
      duty_of_guarantor_user_id,
      preventive_control_description: typeof b.preventive_control_description === 'string' ? b.preventive_control_description.slice(0, 2000) : '',
      is_gating_control: b.is_gating_control !== false,
      status: 'PENDIENTE',
      compliance_evidence_url: null,
      verified_at: null,
      digital_signature_hash: null,
      createdBy: req.user,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await mongo.collection('fl_matriz_riesgo').insertOne(doc);
    await appendFlLog(mongo, { action: 'control.create', actorId: req.user, detail: { controlId: doc._id, projectId: b.project_id, tipo: b.legal_risk_type, nivel: b.risk_level } });
    res.status(201).json(withId(doc));
  });

  router.patch('/api/fl/matriz-riesgo/:id', ...guard, async (req, res) => {
    const row = await mongo.collection('fl_matriz_riesgo').findOne({ _id: req.params.id });
    if (!row) return res.status(404).json({ error: 'control no encontrado' });
    const b = req.body || {};
    const $set = { updatedAt: new Date().toISOString() };
    if (b.risk_level !== undefined) {
      if (!NIVELES_RIESGO.includes(b.risk_level)) return res.status(400).json({ error: 'risk_level invalido' });
      $set.risk_level = b.risk_level;
    }
    if (b.status !== undefined) {
      if (!ESTADOS_CONTROL.includes(b.status)) return res.status(400).json({ error: 'status invalido' });
      if (b.status === 'VERIFICADO') return res.status(400).json({ error: 'usar POST /api/fl/matriz-riesgo/:id/verificar' });
      $set.status = b.status;
    }
    if (b.preventive_control_description !== undefined) $set.preventive_control_description = String(b.preventive_control_description).slice(0, 2000);
    if (b.is_gating_control !== undefined) $set.is_gating_control = !!b.is_gating_control;
    await mongo.collection('fl_matriz_riesgo').updateOne({ _id: req.params.id }, { $set });
    const updated = await mongo.collection('fl_matriz_riesgo').findOne({ _id: req.params.id });
    res.json(withId(updated));
  });

  /* Regla 3 (Trazabilidad e inmutabilidad): VERIFICADO exige
     compliance_evidence_url + genera firma digital + timestamp. */
  router.post('/api/fl/matriz-riesgo/:id/verificar', ...guard, async (req, res) => {
    const row = await mongo.collection('fl_matriz_riesgo').findOne({ _id: req.params.id });
    if (!row) return res.status(404).json({ error: 'control no encontrado' });
    const compliance_evidence_url = String(req.body?.compliance_evidence_url || '').trim();
    if (!compliance_evidence_url) return res.status(400).json({ error: 'compliance_evidence_url requerido para verificar' });

    const verified_at = new Date().toISOString();
    const digital_signature_hash = sha256(`${row._id}|${req.user}|${compliance_evidence_url}|${verified_at}`);
    await mongo.collection('fl_matriz_riesgo').updateOne({ _id: req.params.id }, {
      $set: { status: 'VERIFICADO', compliance_evidence_url, verified_at, digital_signature_hash, verifiedBy: req.user, updatedAt: verified_at },
    });
    await appendFlLog(mongo, { action: 'control.verificado', actorId: req.user, detail: { controlId: row._id, projectId: row.project_id, digital_signature_hash } });
    const updated = await mongo.collection('fl_matriz_riesgo').findOne({ _id: req.params.id });
    res.json(withId(updated));
  });

  /* ---- KRI / KPI engine (Parte 2, §2) ---- */

  router.get('/api/fl/proyectos/:id/kpis', ...guard, async (req, res) => {
    const proyecto = await requireProyecto(req.params.id);
    if (!proyecto) return res.status(404).json({ error: 'proyecto no encontrado' });
    const controles = await mongo.collection('fl_matriz_riesgo').find({ project_id: req.params.id }).toArray();

    /* a) ICE: controles con evidencia válida / total activos */
    const activos = controles.filter(c => c.status !== 'EXCEPCION_APROBADA' || c.compliance_evidence_url);
    const conEvidencia = controles.filter(c => !!c.compliance_evidence_url);
    const ice = activos.length > 0 ? round2((conEvidencia.length / activos.length) * 100) : null;

    /* b) TMM: tiempo medio EN_ALERTA -> VERIFICADO, via fl_log (approx: createdAt de
       'control.en_alerta' hasta 'control.verificado' del mismo controlId) */
    const logEntries = await mongo.collection('fl_log').find({
      action: { $in: ['control.en_alerta', 'control.verificado'] },
      'detail.controlId': { $in: controles.map(c => c._id) },
    }).sort({ seq: 1 }).toArray();
    const alertTimes = new Map();
    const mitigationsHours = [];
    for (const entry of logEntries) {
      const cid = entry.detail?.controlId;
      if (entry.action === 'control.en_alerta') alertTimes.set(cid, new Date(entry.createdAt).getTime());
      if (entry.action === 'control.verificado' && alertTimes.has(cid)) {
        const hours = (new Date(entry.createdAt).getTime() - alertTimes.get(cid)) / (1000 * 60 * 60);
        mitigationsHours.push(hours);
        alertTimes.delete(cid);
      }
    }
    const tmmHoras = mitigationsHours.length > 0 ? round2(mitigationsHours.reduce((s, h) => s + h, 0) / mitigationsHours.length) : null;

    /* c) Tasa de homologación de garantes: % con verified_at != null entre los que tienen garante asignado */
    const conGarante = controles.filter(c => c.duty_of_guarantor_user_id);
    const homologados = conGarante.filter(c => c.verified_at);
    const tasaGarantes = conGarante.length > 0 ? round2((homologados.length / conGarante.length) * 100) : null;

    /* d) Audit Pre-Payment Score por hito financiero */
    const hitos = await mongo.collection('fl_hitos').find({ project_id: req.params.id, es_hito_financiero: true }).toArray();
    const auditPrePaymentByHito = {};
    for (const h of hitos) {
      const controlesHito = controles.filter(c => c.milestone_id === h._id && ['CRITICO', 'ALTO'].includes(c.risk_level));
      auditPrePaymentByHito[h._id] = controlesHito.length === 0 || controlesHito.every(c => c.status === 'VERIFICADO');
    }

    res.json({
      ice,
      tmmHoras,
      tmmAlerta: tmmHoras !== null && tmmHoras > 24,
      tasaGarantes,
      auditPrePaymentByHito,
      controlesTotal: controles.length,
      controlesEnAlerta: controles.filter(c => c.status === 'EN_ALERTA').length,
    });
  });

  /* ==========================================================================
     PARTE 3 · Motor de alarmas de caducidad de poderes corporativos y firmas
  ========================================================================== */

  router.get('/api/fl/poderes', ...guard, async (req, res) => {
    const rows = await mongo.collection('fl_poderes').find({}).sort({ fecha_caducidad: 1 }).toArray();
    res.json(rows.map(withId));
  });

  router.post('/api/fl/poderes', ...guard, async (req, res) => {
    const b = req.body || {};
    const titular = String(b.titular || '').trim();
    if (!titular) return res.status(400).json({ error: 'titular requerido' });
    if (!TIPOS_PODER.includes(b.tipo)) return res.status(400).json({ error: 'tipo invalido' });
    if (!isValidDate(b.fecha_emision)) return res.status(400).json({ error: 'fecha_emision invalida' });
    if (!isValidDate(b.fecha_caducidad)) return res.status(400).json({ error: 'fecha_caducidad invalida' });

    const doc = {
      _id: crypto.randomUUID(),
      titular,
      tipo: b.tipo,
      entidad: typeof b.entidad === 'string' ? b.entidad.trim() : null,
      fecha_emision: b.fecha_emision,
      fecha_caducidad: b.fecha_caducidad,
      dias_alerta: Number.isFinite(Number(b.dias_alerta)) ? Number(b.dias_alerta) : 60,
      estado: 'Vigente',
      notas: typeof b.notas === 'string' ? b.notas.slice(0, 1000) : '',
      createdBy: req.user,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await mongo.collection('fl_poderes').insertOne(doc);
    await appendFlLog(mongo, { action: 'poder.create', actorId: req.user, detail: { poderId: doc._id, titular, tipo: b.tipo } });
    res.status(201).json(withId(doc));
  });

  router.patch('/api/fl/poderes/:id', ...guard, async (req, res) => {
    const row = await mongo.collection('fl_poderes').findOne({ _id: req.params.id });
    if (!row) return res.status(404).json({ error: 'poder no encontrado' });
    const b = req.body || {};
    const $set = { updatedAt: new Date().toISOString() };
    if (b.fecha_caducidad !== undefined) {
      if (!isValidDate(b.fecha_caducidad)) return res.status(400).json({ error: 'fecha_caducidad invalida' });
      $set.fecha_caducidad = b.fecha_caducidad;
    }
    if (b.dias_alerta !== undefined) {
      const v = Number(b.dias_alerta);
      if (!Number.isFinite(v) || v < 0) return res.status(400).json({ error: 'dias_alerta invalido' });
      $set.dias_alerta = v;
    }
    if (b.estado !== undefined) {
      if (!ESTADOS_PODER.includes(b.estado)) return res.status(400).json({ error: 'estado invalido' });
      $set.estado = b.estado;
    }
    if (b.notas !== undefined) $set.notas = String(b.notas).slice(0, 1000);
    await mongo.collection('fl_poderes').updateOne({ _id: req.params.id }, { $set });
    if ($set.estado && $set.estado !== row.estado) {
      await appendFlLog(mongo, { action: 'poder.estado_change', actorId: req.user, detail: { poderId: row._id, from: row.estado, to: $set.estado } });
    }
    const updated = await mongo.collection('fl_poderes').findOne({ _id: req.params.id });
    res.json(withId(updated));
  });

  router.delete('/api/fl/poderes/:id', ...guard, async (req, res) => {
    const result = await mongo.collection('fl_poderes').deleteOne({ _id: req.params.id });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'poder no encontrado' });
    await appendFlLog(mongo, { action: 'poder.delete', actorId: req.user, detail: { poderId: req.params.id } });
    res.json({ id: req.params.id });
  });

  /* Motor de alarmas: revisa licencias y poderes próximos a vencer/caducar.
     In-process, mismo patrón que los pollers de u2-ree.routes.js (sin cron
     externo). Corre al arrancar y cada 24h. */
  async function checkAlarmas() {
    try {
      const licencias = await mongo.collection('fl_licencias').find({ estado_tramite: { $in: ['Vigente', 'En_Renovación'] } }).toArray();
      for (const lic of licencias) {
        const dias = daysUntil(lic.fecha_vencimiento);
        if (dias <= lic.dias_alerta_vencimiento && lic.estado_tramite === 'Vigente') {
          await mongo.collection('fl_licencias').updateOne({ _id: lic._id }, { $set: { estado_tramite: 'En_Renovación', updatedAt: new Date().toISOString() } });
          adminNotify?.({ origin: 'FL', label: `Licencia próxima a vencer: ${lic.tipo_permiso}`, detail: `${lic.dependencia} · ${lic.codigo_interno || lic._id} · vence en ${dias} días`, severity: 'warning' });
          await appendFlLog(mongo, { action: 'licencia.alarma_vencimiento', actorId: 'system', detail: { licenciaId: lic._id, dias } });
        }
        if (dias <= 90 && lic.estado_tramite !== 'En_Renovación' && lic.ultimo_escalado_vencimiento !== lic.fecha_vencimiento) {
          adminNotify?.({ origin: 'FL', label: `Escalado gerencial: licencia vence en ${dias} días sin trámite iniciado`, detail: `${lic.dependencia} · ${lic.tipo_permiso} · ${lic.codigo_interno || lic._id}`, severity: 'error' });
          busEmit?.({ id: crypto.randomUUID(), ts: new Date().toISOString(), origin: 'FL', dest: 'ADMIN', type: 'alert', state: 'BLOCKED', label: 'Escalado gerencial licencia', payload: { licenciaId: lic._id, dias } });
          await mongo.collection('fl_licencias').updateOne({ _id: lic._id }, { $set: { ultimo_escalado_vencimiento: lic.fecha_vencimiento } });
          await appendFlLog(mongo, { action: 'licencia.escalado_gerencial', actorId: 'system', detail: { licenciaId: lic._id, dias } });
        }
      }

      const poderes = await mongo.collection('fl_poderes').find({ estado: { $in: ['Vigente', 'Por_Caducar'] } }).toArray();
      for (const p of poderes) {
        const dias = daysUntil(p.fecha_caducidad);
        if (dias <= p.dias_alerta && p.estado === 'Vigente') {
          await mongo.collection('fl_poderes').updateOne({ _id: p._id }, { $set: { estado: 'Por_Caducar', updatedAt: new Date().toISOString() } });
          adminNotify?.({ origin: 'FL', label: `Poder/firma próximo a caducar: ${p.titular}`, detail: `${p.tipo} · ${p.entidad || ''} · caduca en ${dias} días`, severity: dias <= 15 ? 'error' : 'warning' });
          await appendFlLog(mongo, { action: 'poder.alarma_caducidad', actorId: 'system', detail: { poderId: p._id, dias } });
        }
        if (dias < 0 && p.estado !== 'Caducado') {
          await mongo.collection('fl_poderes').updateOne({ _id: p._id }, { $set: { estado: 'Caducado', updatedAt: new Date().toISOString() } });
          adminNotify?.({ origin: 'FL', label: `Poder/firma CADUCADO: ${p.titular}`, detail: `${p.tipo} · ${p.entidad || ''}`, severity: 'error' });
        }
      }
    } catch (err) {
      console.error('[FL] Error en checkAlarmas:', err.message);
    }
  }
  // Cron de boot, fuera de cualquier request: corre explicitamente contra el
  // tenant por defecto (runAsTenant), nunca contra el mongo tenant-aware
  // recibido arriba, que exige un request con resolveTenant ya corrido.
  const runCheckAlarmas = () => runAsTenant(DEFAULT_TENANT_ID, checkAlarmas);
  runCheckAlarmas();
  setInterval(runCheckAlarmas, 24 * 60 * 60 * 1000);

  /* ==========================================================================
     KPI maestro de gobierno ejecutivo + integridad del log
  ========================================================================== */

  router.get('/api/fl/summary', ...guard, async (req, res) => {
    const [licencias, condicionantes, inspeccionesAbiertas, poderesAlerta, controlesEnAlerta] = await Promise.all([
      mongo.collection('fl_licencias').find({}).toArray(),
      mongo.collection('fl_condicionantes').find({}).toArray(),
      mongo.collection('fl_inspecciones').countDocuments({ estatus_resolucion: { $ne: 'Cerrada_Resuelta' } }),
      mongo.collection('fl_poderes').countDocuments({ estado: { $in: ['Por_Caducar', 'Caducado'] } }),
      mongo.collection('fl_matriz_riesgo').countDocuments({ status: 'EN_ALERTA' }),
    ]);

    /* ICRL: licencias+condicionantes requeridos vs cumplidos */
    const totalRequeridos = licencias.length + condicionantes.length;
    const cumplidos = licencias.filter(l => l.estado_tramite === 'Vigente').length + condicionantes.filter(c => c.estado_cumplimiento === 'Cumplido').length;
    const icrl = totalRequeridos > 0 ? round2((cumplidos / totalRequeridos) * 100) : null;

    /* IRV: licencias vigentes vs las que vencen en <=90 dias sin tramite iniciado */
    const vigentes = licencias.filter(l => l.estado_tramite === 'Vigente' || l.estado_tramite === 'En_Renovación');
    const enRiesgo = licencias.filter(l => daysUntil(l.fecha_vencimiento) <= 90 && l.estado_tramite === 'Vigente');
    const irv = vigentes.length > 0 ? round2((enRiesgo.length / vigentes.length) * 100) : 0;

    const infracciones = await mongo.collection('fl_inspecciones').countDocuments({ resultado_visita: { $ne: 'Sin_Observaciones' } });

    res.json({
      icrl,
      irv,
      contadorInfracciones: infracciones,
      inspeccionesAbiertas,
      poderesEnAlerta: poderesAlerta,
      controlesLegalesEnAlerta: controlesEnAlerta,
      totalLicencias: licencias.length,
      totalInstalaciones: await mongo.collection('fl_instalaciones').countDocuments({}),
      totalProyectos: await mongo.collection('fl_proyectos_legales').countDocuments({}),
    });
  });

  router.get('/api/fl/log/verify', ...guard, async (req, res) => {
    const all = await mongo.collection('fl_log').find({}).sort({ seq: 1 }).toArray();
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
