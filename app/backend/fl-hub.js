/**
 * S-NFI F&L · Hub fiscal y legal (2026-10-12).
 *
 * Sustituye a fl.js (licencias multi-planta, matriz legal, poderes e
 * inspecciones): peticion directa del usuario de dejar solo el Expediente
 * Fiscal y Juridico y rehacer la mesa desde cero con cinco vistas:
 *   1. Overview / Command Center: KPIs, calendario fiscal y societario, feed de
 *      boletines y notificaciones urgentes.
 *   2. Fiscalidad y Auditoria: modelos tributarios (AEAT y forales), checklist
 *      NIA-ES para la auditoria externa y consulta de normativa.
 *   3. GobTech: notificaciones de las AA.PP. (DEHu, sedes) con acuse, plazo de
 *      rechazo presunto (art. 43.2 Ley 39/2015) y flujo de respuesta.
 *   4. Gobierno corporativo: sociedades del grupo, libro de actas y juntas,
 *      matriz de apoderamientos y publicaciones BORME por sociedad.
 *   5. CLM: contratos (PPA, off-take, leasing, JV, servicios...) con
 *      vencimientos, preavisos de renovacion y riesgo de contraparte.
 * El Expediente sigue en fl-expediente.js con su guard propio.
 *
 * Mismo patron que el resto de mesas CRUD: Mongo directo, log inmutable fl_log
 * con hash chain (compartido con el Expediente) y soft-delete (archivar), nunca
 * borrado real. Las entradas nuevas usan serializacion canonica profunda
 * (canon: 2): el hash cubre tambien el contenido de `detail`. Las entradas
 * heredadas (sin canon) se verifican con el algoritmo de siempre.
 *
 * Datos: los registros de demostracion (fl-hub-seed.js) llevan
 * placeholder: true; las alertas BOE/BORME son reales (fl-boletines.js). DEHu
 * no tiene conector: el acuse se registra a mano tras comparecer en la sede, y
 * la interfaz lo dice.
 *
 * Doctrina: la mesa registra y avisa; no presenta modelos ni comparece ante
 * ninguna Administracion. Toda accion la hace un humano autenticado y queda en
 * fl_log.
 */

import crypto from 'node:crypto';
import PDFDocument from 'pdfkit';
import { runAsTenant } from './db/tenant-context.js';
import { DEFAULT_TENANT_ID } from './db/tenant-registry.js';
import {
  ESQUEMAS, ENTIDADES, ENTIDAD_ROUTE, TRANSICIONES_NOTIFICACION, ADMINISTRACIONES, NORMAS, portalesPara,
  DGT_CONSULTA_URL, validarEntidad, esquemasPublicos,
} from './fl-hub-catalogos.js';
import {
  todayIso, addDaysIso, diffDaysIso, addMonthsIso, isIsoDate, isoOf, computeFechaLimite, fechaRechazoPresunto,
} from './fl-hub-fechas.js';
import { buildSeed, SEED_KEY } from './fl-hub-seed.js';
import { createBoletinesSync, CATEGORIAS } from './fl-boletines.js';

const BOLETINES_INTERVAL_MS = 6 * 60 * 60 * 1000;
const ALARMAS_INTERVAL_MS = 24 * 60 * 60 * 1000;
const BOLETINES_DIAS_AUTO = 7;
const BOLETINES_DIAS_MANUAL = 14;
const SYNC_MANUAL_COOLDOWN_MS = 2 * 60 * 1000;
const ALERTAS_VENTANA_DIAS = 60;
const ALERTAS_MAX = 300;
const VENTANA_RENOVACION = 30;

/* =========================================================================
   Log inmutable fl_log (hash chain compartida con fl-expediente.js)
   ========================================================================= */

/* Algoritmo heredado: JSON.stringify con la lista de claves de primer nivel
   como replacer. Se conserva solo para verificar entradas antiguas. */
function canonicalV1(entry) {
  return JSON.stringify(entry, Object.keys(entry).sort());
}

/* Serializacion canonica profunda: claves ordenadas a cualquier nivel. */
export function canonicalV2(value) {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalV2(v === undefined ? null : v)).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalV2(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/* Reintenta si otra escritura se adelanta con el mismo seq (indice unico
   fl_log.seq, creado en db/mongo.js): el Hub y el Expediente escriben en la
   misma cadena. */
export async function appendFlLog(mongo, entry) {
  const col = mongo.collection('fl_log');
  for (let intento = 0; intento < 5; intento += 1) {
    const tail = await col.find().sort({ seq: -1 }).limit(1).next();
    const seq = tail ? tail.seq + 1 : 1;
    const prevHash = tail ? tail.hash : '0'.repeat(64);
    const body = { ...entry, canon: 2, seq };
    const hash = sha256(prevHash + canonicalV2(body));
    const doc = { _id: crypto.randomUUID(), ...entry, canon: 2, seq, prevHash, hash, createdAt: new Date().toISOString() };
    try {
      await col.insertOne(doc);
      return doc;
    } catch (err) {
      if (err?.code !== 11000) throw err;
    }
  }
  throw new Error('fl_log: no se pudo encadenar la entrada tras 5 intentos');
}

export function verifyChain(entries) {
  let prev = '0'.repeat(64);
  for (const entry of entries) {
    const { _id, seq, prevHash, hash, createdAt, ...rest } = entry;
    const body = { ...rest, seq };
    const expected = sha256(prev + (rest.canon === 2 ? canonicalV2(body) : canonicalV1(body)));
    if (expected !== hash || prevHash !== prev) return { valid: false, totalEntries: entries.length, brokenAtSeq: seq };
    prev = hash;
  }
  return { valid: true, totalEntries: entries.length, brokenAtSeq: null };
}

/* =========================================================================
   Utilidades
   ========================================================================= */

function withId(doc) {
  if (!doc) return doc;
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
}

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((err) => {
  console.error(`[FL/Hub] ${req.method} ${req.originalUrl}:`, err);
  if (!res.headersSent) res.status(500).json({ error: 'Error interno de la mesa F&L' });
});

function etiqueta(entidad, campo, valor) {
  const def = ESQUEMAS[entidad]?.campos.find((c) => c.key === campo);
  return def?.opciones?.find((o) => o.v === valor)?.l ?? valor;
}

const fmtEur = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' });

function fmtCents(c) {
  return Number.isInteger(c) ? fmtEur.format(c / 100) : '—';
}

function fmtFecha(iso) {
  return isIsoDate(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '—';
}

/* =========================================================================
   Derivaciones (estado calculado a partir de las fechas, nunca persistido)
   ========================================================================= */

export function derivarModelo(m, hoy) {
  const dias = isIsoDate(m.fecha_limite) ? diffDaysIso(hoy, m.fecha_limite) : null;
  const presentado = m.estado === 'liquidado' || m.estado === 'en_auditoria';
  return {
    dias,
    vencido: !presentado && dias !== null && dias < 0,
    fuera_plazo: presentado && isIsoDate(m.presentado_at) && isIsoDate(m.fecha_limite) && m.presentado_at > m.fecha_limite,
  };
}

export function derivarNotificacion(n, hoy) {
  const cerrada = n.estado === 'respondida' || n.estado === 'archivada';
  const fechaRechazo = fechaRechazoPresunto(n.puesta_disposicion);
  const diasAcceso = !n.acuse && fechaRechazo ? diffDaysIso(hoy, fechaRechazo) : null;
  const rechazoPresunto = !n.acuse && diasAcceso !== null && diasAcceso < 0;
  const flr = isIsoDate(n.fecha_limite_respuesta) ? n.fecha_limite_respuesta : null;
  const diasRespuesta = flr && !cerrada ? diffDaysIso(hoy, flr) : null;

  let progreso = null;
  if (!n.acuse && fechaRechazo) {
    const total = diffDaysIso(n.puesta_disposicion, fechaRechazo);
    progreso = Math.min(100, Math.max(0, Math.round((diffDaysIso(n.puesta_disposicion, hoy) / total) * 100)));
  } else if (n.acuse && flr) {
    const total = Math.max(1, diffDaysIso(n.acuse.fecha, flr));
    progreso = Math.min(100, Math.max(0, Math.round((diffDaysIso(n.acuse.fecha, hoy) / total) * 100)));
  }

  let urgencia = 'normal';
  if (cerrada) urgencia = 'cerrada';
  else if (rechazoPresunto || (diasAcceso !== null && diasAcceso <= 2) || (diasRespuesta !== null && diasRespuesta <= 2)) urgencia = 'critica';
  else if ((diasAcceso !== null && diasAcceso <= 5) || (diasRespuesta !== null && diasRespuesta <= 5)) urgencia = 'alta';

  return {
    fecha_rechazo_presunto: fechaRechazo,
    dias_acceso: diasAcceso,
    rechazo_presunto: rechazoPresunto,
    dias_respuesta: diasRespuesta,
    progreso_pct: progreso,
    urgencia,
    transiciones: TRANSICIONES_NOTIFICACION[n.estado] ?? [],
  };
}

export function derivarJunta(j, hoy) {
  const depositoLimite = j.aprueba_cuentas && isIsoDate(j.fecha) ? addMonthsIso(j.fecha, 1) : null;
  return {
    dias: isIsoDate(j.fecha) ? diffDaysIso(hoy, j.fecha) : null,
    deposito_limite: depositoLimite,
    deposito_vencido: !!depositoLimite && j.estado !== 'formalizada' && hoy > depositoLimite,
  };
}

export function derivarApoderamiento(p, hoy) {
  const dias = isIsoDate(p.fecha_caducidad) ? diffDaysIso(hoy, p.fecha_caducidad) : null;
  let situacion = 'vigente';
  if (p.estado === 'revocado') situacion = 'revocado';
  else if (dias !== null && dias < 0) situacion = 'caducado';
  else if (dias !== null && dias <= VENTANA_RENOVACION) situacion = 'por_caducar';
  return { dias_caducidad: dias, situacion };
}

export function derivarContrato(c, hoy) {
  const activo = c.estado === 'vigente';
  const diasVenc = isIsoDate(c.fecha_vencimiento) ? diffDaysIso(hoy, c.fecha_vencimiento) : null;
  const flp = isIsoDate(c.fecha_vencimiento) && Number.isInteger(c.preaviso_dias) && c.preaviso_dias > 0
    ? addDaysIso(c.fecha_vencimiento, -c.preaviso_dias) : null;
  const diasPreaviso = flp ? diffDaysIso(hoy, flp) : null;

  let alerta = null;
  if (activo && diasVenc !== null && diasVenc < 0) alerta = 'vencido';
  else if (activo && c.renovacion_automatica && diasPreaviso !== null && diasPreaviso >= 0 && diasPreaviso <= VENTANA_RENOVACION) alerta = 'preaviso';
  else if (activo && !c.renovacion_automatica && diasVenc !== null && diasVenc <= VENTANA_RENOVACION) alerta = 'vence';

  let progreso = null;
  if (isIsoDate(c.fecha_inicio) && isIsoDate(c.fecha_vencimiento)) {
    const total = Math.max(1, diffDaysIso(c.fecha_inicio, c.fecha_vencimiento));
    progreso = Math.min(100, Math.max(0, Math.round((diffDaysIso(c.fecha_inicio, hoy) / total) * 100)));
  }
  const r = Number.isInteger(c.riesgo_contraparte) ? c.riesgo_contraparte : null;
  return {
    dias_vencimiento: diasVenc,
    fecha_limite_preaviso: flp,
    dias_preaviso: diasPreaviso,
    alerta,
    progreso_vigencia_pct: progreso,
    riesgo_nivel: r === null ? null : r < 30 ? 'bajo' : r < 60 ? 'medio' : 'alto',
  };
}

export function derivarChecklist(p, hoy) {
  const dias = isIsoDate(p.fecha_objetivo) ? diffDaysIso(hoy, p.fecha_objetivo) : null;
  const abierto = p.estado === 'pendiente' || p.estado === 'en_curso';
  return { dias, atrasado: abierto && dias !== null && dias < 0 };
}

const DERIVAR = {
  modelos: derivarModelo,
  notificaciones: derivarNotificacion,
  juntas: derivarJunta,
  apoderamientos: derivarApoderamiento,
  contratos: derivarContrato,
  checklist: derivarChecklist,
};

export function serializar(entidad, doc, hoy) {
  const out = withId(doc);
  const fn = DERIVAR[entidad];
  if (fn) out.calc = fn(doc, hoy);
  return out;
}

/* =========================================================================
   KPIs y calendario
   ========================================================================= */

export function calcularKpis(data, hoy, boletinesStatus) {
  const { modelos, notificaciones, alertas, apoderamientos, contratos, juntas, checklist } = data;

  const vencidos = modelos.filter((m) => isIsoDate(m.fecha_limite) && m.fecha_limite <= hoy);
  const enPlazo = vencidos.filter((m) => (m.estado === 'liquidado' || m.estado === 'en_auditoria')
    && (!isIsoDate(m.presentado_at) || m.presentado_at <= m.fecha_limite));
  const pendientes = modelos.filter((m) => m.estado === 'pendiente').sort((a, b) => a.fecha_limite.localeCompare(b.fecha_limite));
  const proximo = pendientes.find((m) => m.fecha_limite >= hoy) ?? null;

  const notifAbiertas = notificaciones.filter((n) => n.estado !== 'respondida' && n.estado !== 'archivada');
  const sinAcuse = notifAbiertas.filter((n) => !n.acuse);
  const urgencias = notifAbiertas.map((n) => ({ n, c: derivarNotificacion(n, hoy) }));
  const vencimientos = urgencias
    .map(({ n, c }) => (c.dias_acceso !== null
      ? { id: n._id, tipo: 'acceso', fecha: c.fecha_rechazo_presunto, dias: c.dias_acceso }
      : c.dias_respuesta !== null ? { id: n._id, tipo: 'respuesta', fecha: n.fecha_limite_respuesta, dias: c.dias_respuesta } : null))
    .filter(Boolean)
    .sort((a, b) => a.fecha.localeCompare(b.fecha));

  const desde7 = addDaysIso(hoy, -7);
  const desde90 = addDaysIso(hoy, -90);
  const recientes = alertas.filter((a) => a.fecha_publicacion >= desde7 && a.estado === 'nueva' && (a.relevancia === 'alta' || a.relevancia === 'media'));

  const contratosRenovar = contratos.filter((c) => derivarContrato(c, hoy).alerta);
  const poderesRenovar = apoderamientos.filter((p) => {
    const s = derivarApoderamiento(p, hoy).situacion;
    return s === 'por_caducar' || s === 'caducado';
  });

  const checklistActivo = checklist.filter((p) => p.estado !== 'no_aplica');
  const completados = checklistActivo.filter((p) => p.estado === 'completado');

  return {
    fiscal: {
      cumplimiento_pct: vencidos.length ? Math.round((enPlazo.length / vencidos.length) * 1000) / 10 : null,
      vencidos_pendientes: modelos.filter((m) => derivarModelo(m, hoy).vencido).length,
      pendientes: pendientes.length,
      en_auditoria: modelos.filter((m) => m.estado === 'en_auditoria').length,
      proximo: proximo ? {
        id: proximo._id, modelo: proximo.modelo, periodo: proximo.periodo, ejercicio: proximo.ejercicio,
        sociedad_id: proximo.sociedad_id, fecha_limite: proximo.fecha_limite, dias: diffDaysIso(hoy, proximo.fecha_limite),
      } : null,
    },
    notificaciones: {
      pendientes: notificaciones.filter((n) => n.estado === 'pendiente').length,
      sin_acuse: sinAcuse.length,
      criticas: urgencias.filter(({ c }) => c.urgencia === 'critica').length,
      proximo_vencimiento: vencimientos[0] ?? null,
    },
    boletines: {
      nuevas_7d: recientes.length,
      alta_7d: recientes.filter((a) => a.relevancia === 'alta').length,
      borme_grupo_90d: alertas.filter((a) => a.fuente === 'BORME' && a.sociedad_id && a.fecha_publicacion >= desde90).length,
      ultima_sync: boletinesStatus?.ultimaSync ?? null,
      ultimo_ok: boletinesStatus?.ultimoOk ?? null,
      error: boletinesStatus?.ultimoError ?? null,
    },
    renovaciones: {
      total: contratosRenovar.length + poderesRenovar.length,
      contratos: contratosRenovar.length,
      poderes: poderesRenovar.length,
      caducados: poderesRenovar.filter((p) => derivarApoderamiento(p, hoy).situacion === 'caducado').length
        + contratosRenovar.filter((c) => derivarContrato(c, hoy).alerta === 'vencido').length,
    },
    societario: {
      depositos_vencidos: juntas.filter((j) => derivarJunta(j, hoy).deposito_vencido).length,
      juntas_proximas: juntas.filter((j) => j.estado === 'convocada' && j.fecha >= hoy && j.fecha <= addDaysIso(hoy, 30)).length,
    },
    auditoria: {
      total: checklistActivo.length,
      completados: completados.length,
      pct: checklistActivo.length ? Math.round((completados.length / checklistActivo.length) * 100) : null,
      atrasados: checklist.filter((p) => derivarChecklist(p, hoy).atrasado).length,
    },
  };
}

const ORGANO_CORTO = { junta_general: 'Junta General', consejo: 'Consejo', socio_unico: 'Socio único', administrador: 'Órgano de administración' };

export function construirCalendario(data, hoy) {
  const nombre = new Map(data.sociedades.map((s) => [s._id, s.nombre_corto]));
  const ev = [];
  const push = (e) => { if (isIsoDate(e.fecha)) ev.push(e); };

  for (const m of data.modelos) {
    const c = derivarModelo(m, hoy);
    push({
      id: `modelo:${m._id}`, fecha: m.fecha_limite, tipo: 'fiscal',
      titulo: `Modelo ${m.modelo} · ${m.periodo} ${m.ejercicio}`, sub: nombre.get(m.sociedad_id) ?? '',
      estado: m.estado === 'pendiente' ? (c.vencido ? 'vencido' : 'pendiente') : 'completado',
      ref: { entidad: 'modelos', id: m._id },
    });
  }
  for (const j of data.juntas) {
    const c = derivarJunta(j, hoy);
    push({
      id: `junta:${j._id}`, fecha: j.fecha, tipo: 'societario',
      titulo: `${ORGANO_CORTO[j.organo] ?? 'Junta'}${j.caracter ? ` ${etiqueta('juntas', 'caracter', j.caracter).toLowerCase()}` : ''}`,
      sub: nombre.get(j.sociedad_id) ?? '',
      estado: j.estado === 'convocada' ? (j.fecha < hoy ? 'vencido' : 'pendiente') : 'completado',
      ref: { entidad: 'juntas', id: j._id },
    });
    if (c.deposito_limite) {
      push({
        id: `deposito:${j._id}`, fecha: c.deposito_limite, tipo: 'societario',
        titulo: 'Depósito de cuentas en el RM (art. 279 LSC)', sub: nombre.get(j.sociedad_id) ?? '',
        estado: j.estado === 'formalizada' ? 'completado' : c.deposito_vencido ? 'vencido' : 'pendiente',
        ref: { entidad: 'juntas', id: j._id },
      });
    }
  }
  for (const n of data.notificaciones) {
    const c = derivarNotificacion(n, hoy);
    const cerrada = n.estado === 'respondida' || n.estado === 'archivada';
    if (!n.acuse && c.fecha_rechazo_presunto) {
      push({
        id: `acceso:${n._id}`, fecha: c.fecha_rechazo_presunto, tipo: 'notificacion',
        titulo: `Último día de acceso · ${n.emisor_siglas || n.emisor}`, sub: n.asunto,
        estado: cerrada ? 'completado' : c.rechazo_presunto ? 'vencido' : 'pendiente', ref: { entidad: 'notificaciones', id: n._id },
      });
    }
    if (isIsoDate(n.fecha_limite_respuesta)) {
      push({
        id: `respuesta:${n._id}`, fecha: n.fecha_limite_respuesta, tipo: 'notificacion',
        titulo: `Fin de plazo de respuesta · ${n.emisor_siglas || n.emisor}`, sub: n.asunto,
        estado: cerrada ? 'completado' : n.fecha_limite_respuesta < hoy ? 'vencido' : 'pendiente', ref: { entidad: 'notificaciones', id: n._id },
      });
    }
  }
  for (const k of data.contratos) {
    const c = derivarContrato(k, hoy);
    if (isIsoDate(k.fecha_vencimiento) && k.estado !== 'rescindido') {
      push({
        id: `vence:${k._id}`, fecha: k.fecha_vencimiento, tipo: 'contrato', titulo: `Vence: ${k.titulo}`, sub: k.contraparte,
        estado: k.estado === 'vencido' ? 'completado' : c.alerta === 'vencido' ? 'vencido' : 'pendiente', ref: { entidad: 'contratos', id: k._id },
      });
    }
    if (c.fecha_limite_preaviso && k.renovacion_automatica && k.estado === 'vigente') {
      push({
        id: `preaviso:${k._id}`, fecha: c.fecha_limite_preaviso, tipo: 'contrato', titulo: `Preaviso de no renovación: ${k.titulo}`, sub: k.contraparte,
        estado: c.dias_preaviso < 0 ? 'completado' : 'pendiente', ref: { entidad: 'contratos', id: k._id },
      });
    }
  }
  for (const p of data.apoderamientos) {
    const c = derivarApoderamiento(p, hoy);
    if (!isIsoDate(p.fecha_caducidad) || p.estado === 'revocado') continue;
    push({
      id: `poder:${p._id}`, fecha: p.fecha_caducidad, tipo: 'poder', titulo: `Caduca poder: ${p.apoderado}`, sub: nombre.get(p.sociedad_id) ?? '',
      estado: c.situacion === 'caducado' ? 'vencido' : 'pendiente', ref: { entidad: 'apoderamientos', id: p._id },
    });
  }

  // Hitos legales recurrentes de cada sociedad activa (LSC): formulacion en los
  // tres meses siguientes al cierre (art. 253) y junta ordinaria en los seis
  // primeros meses (art. 164). Se asume ejercicio igual al ano natural.
  const Y = Number(hoy.slice(0, 4));
  for (const s of data.sociedades.filter((x) => x.estado === 'activa')) {
    for (const y of [Y, Y + 1]) {
      push({ id: `formulacion:${s._id}:${y}`, fecha: isoOf(y, 3, 31), tipo: 'legal', titulo: `Formulación de cuentas ${y - 1} (art. 253 LSC)`, sub: s.nombre_corto, estado: 'informativo', ref: null });
      const hecha = data.juntas.some((j) => j.sociedad_id === s._id && j.aprueba_cuentas && j.ejercicio_cuentas === y - 1 && j.estado !== 'convocada');
      push({
        id: `jgo:${s._id}:${y}`, fecha: isoOf(y, 6, 30), tipo: 'legal', titulo: `Aprobación de cuentas ${y - 1} (art. 164 LSC)`, sub: s.nombre_corto,
        estado: hecha ? 'completado' : isoOf(y, 6, 30) < hoy ? 'vencido' : 'pendiente', ref: null,
      });
    }
  }

  const desde = addDaysIso(hoy, -120);
  const hasta = addDaysIso(hoy, 430);
  return ev.filter((e) => e.fecha >= desde && e.fecha <= hasta).sort((a, b) => a.fecha.localeCompare(b.fecha) || a.tipo.localeCompare(b.tipo));
}

/* =========================================================================
   PDF: ficha de un registro (pdfkit, mismo motor que Finance)
   ========================================================================= */

function valorLegible(entidad, campo, v, sociedades) {
  if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)) return null;
  switch (campo.tipo) {
    case 'date': return fmtFecha(v);
    case 'cents': return fmtCents(v);
    case 'bool': return v ? 'Sí' : 'No';
    case 'enum': return etiqueta(entidad, campo.key, v);
    case 'pct': return `${String(v).replace('.', ',')} %`;
    case 'ref': return sociedades.get(v)?.denominacion ?? v;
    case 'list': return v;
    default: return String(v);
  }
}

export function generarFichaPdf({ entidad, doc, sociedades, logEntry, usuario }) {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ margin: 54, size: 'A4', info: { Title: `S-NFI F&L · ${ESQUEMAS[entidad].label}`, Author: 'SYSTEMS · S-NFI' } });
    const chunks = [];
    pdf.on('data', (c) => chunks.push(c));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);

    const gold = '#a8740b';
    const muted = '#6b6f79';
    pdf.fillColor(gold).font('Helvetica-Bold').fontSize(9).text('SYSTEMS  //  FISCAL & LEGAL', { characterSpacing: 1.2 });
    pdf.moveDown(0.3);
    pdf.fillColor('#111').font('Helvetica-Bold').fontSize(17).text(`Ficha · ${ESQUEMAS[entidad].label}`);
    const titulo = doc.titulo || doc.asunto || doc.denominacion || doc.apoderado || (doc.modelo ? `Modelo ${doc.modelo} · ${doc.periodo} ${doc.ejercicio}` : null) || doc.nia || doc.id;
    pdf.font('Helvetica').fontSize(11).fillColor('#333').text(String(titulo));
    pdf.moveDown(0.6);

    if (doc.placeholder) {
      const y = pdf.y;
      pdf.rect(54, y, pdf.page.width - 108, 30).fill('#fff4dc');
      pdf.fillColor('#8a5a00').font('Helvetica-Bold').fontSize(9)
        .text('DATOS DE DEMOSTRACIÓN · No es un documento oficial ni refleja datos reales confirmados.', 64, y + 10, { width: pdf.page.width - 128 });
      pdf.moveDown(1.2);
    }

    pdf.x = 54;
    for (const campo of ESQUEMAS[entidad].campos) {
      const v = valorLegible(entidad, campo, doc[campo.key], sociedades);
      if (v === null) continue;
      pdf.font('Helvetica-Bold').fontSize(8).fillColor(muted).text(campo.label.toUpperCase(), { characterSpacing: 0.4 });
      pdf.font('Helvetica').fontSize(10.5).fillColor('#111');
      if (Array.isArray(v)) v.forEach((item) => pdf.text(`•  ${item}`, { indent: 6 }));
      else pdf.text(v);
      pdf.moveDown(0.45);
    }

    if (entidad === 'notificaciones') {
      pdf.moveDown(0.3);
      pdf.font('Helvetica-Bold').fontSize(8).fillColor(muted).text('ACUSE DE RECEPCIÓN');
      pdf.font('Helvetica').fontSize(10.5).fillColor('#111')
        .text(doc.acuse ? `Registrado el ${fmtFecha(doc.acuse.fecha)} por ${doc.acuse.registrado_por}` : 'Sin acuse registrado');
      if (doc.respuesta) {
        pdf.moveDown(0.45);
        pdf.font('Helvetica-Bold').fontSize(8).fillColor(muted).text('RESPUESTA');
        pdf.font('Helvetica').fontSize(10.5).fillColor('#111')
          .text(`${fmtFecha(doc.respuesta.fecha)} · ${doc.respuesta.referencia || 'sin referencia'}${doc.respuesta.nota ? ` · ${doc.respuesta.nota}` : ''}`);
      }
    }

    // El pie va dentro del margen inferior: sin anularlo, pdfkit abriria una
    // pagina nueva para la segunda linea.
    const footY = pdf.page.height - 72;
    pdf.page.margins.bottom = 0;
    pdf.moveTo(54, footY).lineTo(pdf.page.width - 54, footY).strokeColor('#dddddd').stroke();
    pdf.font('Helvetica').fontSize(7.5).fillColor(muted).text(
      `Generado por SYSTEMS · S-NFI F&L · ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC · ${usuario}`
      + `\nAcceso registrado en fl_log #${logEntry.seq} · ${logEntry.hash.slice(0, 16)}…`,
      54, footY + 8, { width: pdf.page.width - 108, lineBreak: true },
    );
    pdf.end();
  });
}

/* =========================================================================
   Mount
   ========================================================================= */

export function mountFlHub(app, {
  auth, requireMesa, mongo, busEmit, adminNotify,
  fetchImpl = globalThis.fetch, autoSync = true, now = () => new Date(),
}) {
  const guard = [auth, requireMesa('fl')];
  const hoy = () => todayIso(now());
  const col = (entidad) => mongo.collection(ESQUEMAS[entidad].col);
  const log = (entry) => appendFlLog(mongo, entry);

  const boletines = createBoletinesSync({ mongo, fetchImpl, adminNotify, appendLog: log, today: hoy });
  let ultimaSyncManual = 0;

  /* ---------------------- Seed de demostracion ---------------------- */
  async function sembrar() {
    const meta = mongo.collection('fl_meta');
    if (await meta.findOne({ _id: SEED_KEY })) return false;
    // Marca primero (indice unico _id): dos arranques simultaneos no siembran dos veces.
    try {
      await meta.insertOne({ _id: SEED_KEY, at: new Date().toISOString(), estado: 'sembrando' });
    } catch (err) {
      if (err?.code === 11000) return false;
      throw err;
    }
    const seed = buildSeed(hoy());
    const counts = {};
    for (const entidad of ENTIDADES) {
      const docs = seed[entidad] ?? [];
      if (docs.length) await col(entidad).insertMany(docs);
      counts[entidad] = docs.length;
    }
    await meta.updateOne({ _id: SEED_KEY }, { $set: { estado: 'hecho', counts } });
    await log({ action: 'hub.seed', actorId: 'system', detail: counts });
    console.log('[FL/Hub] Datos de demostración sembrados:', counts);
    return true;
  }

  /* ---------------------- Carga y serializacion ---------------------- */
  async function cargarTodo() {
    const entradas = await Promise.all(ENTIDADES.map((e) => col(e).find({ deleted: { $ne: true } }).sort(ESQUEMAS[e].orden).toArray()));
    const data = Object.fromEntries(ENTIDADES.map((e, i) => [e, entradas[i]]));
    const desde = addDaysIso(hoy(), -ALERTAS_VENTANA_DIAS);
    data.alertas = await mongo.collection('fl_alertas_normativas')
      .find({ fecha_publicacion: { $gte: desde } })
      .sort({ fecha_publicacion: -1, puntuacion: -1 })
      .limit(ALERTAS_MAX)
      .toArray();
    return data;
  }

  async function sociedadExiste(id) {
    return !!(await col('sociedades').findOne({ _id: id, deleted: { $ne: true } }));
  }

  /* ---------------------- Alarmas al Admin ---------------------- */
  async function avisarUnaVez(key, aviso) {
    try {
      await mongo.collection('fl_meta').insertOne({ _id: `aviso:${key}`, at: new Date().toISOString() });
    } catch (err) {
      if (err?.code === 11000) return;
      throw err;
    }
    adminNotify?.({ origin: 'FL', ...aviso });
    if (aviso.severity === 'error') {
      busEmit?.({ id: crypto.randomUUID(), ts: new Date().toISOString(), origin: 'FL', dest: 'ADMIN', type: 'alert', state: 'BLOCKED', label: aviso.label, payload: { key } });
    }
  }

  // Los registros de demostracion no generan avisos: una notificacion AEAT
  // ficticia no puede aparecer como urgente en el centro de notificaciones.
  async function revisarAlarmas() {
    const d = hoy();
    const data = await cargarTodo();
    const real = (x) => !x.placeholder;
    for (const n of data.notificaciones.filter(real)) {
      const c = derivarNotificacion(n, d);
      if (c.urgencia === 'cerrada') continue;
      if (c.rechazo_presunto) {
        await avisarUnaVez(`rechazo:${n._id}`, { label: `Notificación no abierta en plazo: ${n.emisor_siglas || n.emisor}`, detail: `${n.expediente} · rechazo presunto desde el ${fmtFecha(c.fecha_rechazo_presunto)} (art. 43.2 Ley 39/2015)`, severity: 'error' });
      } else if (c.dias_acceso !== null && c.dias_acceso <= 3) {
        await avisarUnaVez(`acceso:${n._id}`, { label: `Notificación sin abrir: ${n.emisor_siglas || n.emisor}`, detail: `${n.expediente} · quedan ${c.dias_acceso} días para el rechazo presunto`, severity: 'error' });
      }
      if (c.dias_respuesta !== null && c.dias_respuesta <= 3) {
        await avisarUnaVez(`respuesta:${n._id}:${n.fecha_limite_respuesta}`, { label: `Plazo de respuesta: ${n.emisor_siglas || n.emisor}`, detail: `${n.expediente} · vence el ${fmtFecha(n.fecha_limite_respuesta)}`, severity: c.dias_respuesta <= 1 ? 'error' : 'warning' });
      }
    }
    for (const m of data.modelos.filter(real)) {
      const c = derivarModelo(m, d);
      if (c.vencido) await avisarUnaVez(`modelo-vencido:${m._id}`, { label: `Modelo ${m.modelo} vencido sin presentar`, detail: `${m.periodo} ${m.ejercicio} · límite ${fmtFecha(m.fecha_limite)}`, severity: 'error' });
      else if (m.estado === 'pendiente' && c.dias !== null && c.dias <= 5) await avisarUnaVez(`modelo:${m._id}`, { label: `Modelo ${m.modelo} vence en ${c.dias} días`, detail: `${m.periodo} ${m.ejercicio} · ${m.concepto}`, severity: 'warning' });
    }
    for (const p of data.apoderamientos.filter(real)) {
      const c = derivarApoderamiento(p, d);
      if (c.situacion === 'caducado') await avisarUnaVez(`poder-caducado:${p._id}:${p.fecha_caducidad}`, { label: `Poder caducado: ${p.apoderado}`, detail: `${etiqueta('apoderamientos', 'tipo', p.tipo)} · caducó el ${fmtFecha(p.fecha_caducidad)}`, severity: 'error' });
      else if (c.situacion === 'por_caducar' && c.dias_caducidad <= 15) await avisarUnaVez(`poder:${p._id}:${p.fecha_caducidad}`, { label: `Poder próximo a caducar: ${p.apoderado}`, detail: `Caduca en ${c.dias_caducidad} días`, severity: 'warning' });
    }
    for (const k of data.contratos.filter(real)) {
      const c = derivarContrato(k, d);
      if (c.alerta === 'preaviso' && c.dias_preaviso <= 15) await avisarUnaVez(`preaviso:${k._id}:${c.fecha_limite_preaviso}`, { label: `Preaviso de no renovación: ${k.titulo}`, detail: `Decidir antes del ${fmtFecha(c.fecha_limite_preaviso)} o se renueva automáticamente`, severity: 'warning' });
      if (c.alerta === 'vence' && c.dias_vencimiento <= 15) await avisarUnaVez(`vence:${k._id}:${k.fecha_vencimiento}`, { label: `Contrato próximo a vencer: ${k.titulo}`, detail: `Vence el ${fmtFecha(k.fecha_vencimiento)} sin prórroga automática`, severity: 'warning' });
    }
    for (const j of data.juntas.filter(real)) {
      if (derivarJunta(j, d).deposito_vencido) await avisarUnaVez(`deposito:${j._id}`, { label: 'Depósito de cuentas fuera de plazo', detail: `Cuentas aprobadas el ${fmtFecha(j.fecha)} sin formalizar (art. 279 LSC)`, severity: 'error' });
    }
  }

  /* ---------------------- Arranque: seed, alarmas y boletines ---------------------- */
  // Fuera de cualquier request: siempre contra el tenant por defecto
  // (runAsTenant), igual que el resto de seeds y crons de boot.
  const enTenant = (fn) => runAsTenant(DEFAULT_TENANT_ID, fn);
  const ready = enTenant(sembrar)
    .then(() => enTenant(revisarAlarmas))
    .catch((err) => console.error('[FL/Hub] Error en el arranque (seed/alarmas):', err.message));

  if (autoSync) {
    const syncAuto = () => enTenant(() => boletines.sync({ dias: BOLETINES_DIAS_AUTO }))
      .then((r) => { if (r.errores.length) console.error('[FL/Boletines] Errores de sincronización:', r.errores.join(' | ')); })
      .catch((err) => console.error('[FL/Boletines] Sincronización fallida:', err.message));
    ready.then(syncAuto);
    setInterval(syncAuto, BOLETINES_INTERVAL_MS).unref();
  }
  setInterval(() => enTenant(revisarAlarmas).catch((err) => console.error('[FL/Hub] Error en revisarAlarmas:', err.message)), ALARMAS_INTERVAL_MS).unref();

  /* =========================================================================
     Rutas
     ========================================================================= */

  app.get('/api/fl/hub', ...guard, ah(async (req, res) => {
    const d = hoy();
    const [data, status] = await Promise.all([cargarTodo(), boletines.status()]);
    const ser = (e) => data[e].map((doc) => serializar(e, doc, d));
    const demo = ENTIDADES.reduce((acc, e) => acc + data[e].filter((x) => x.placeholder).length, 0);
    res.json({
      hoy: d,
      generado_at: new Date().toISOString(),
      sociedades: ser('sociedades'),
      modelos: ser('modelos'),
      notificaciones: ser('notificaciones'),
      juntas: ser('juntas'),
      apoderamientos: ser('apoderamientos'),
      contratos: ser('contratos'),
      checklist: ser('checklist'),
      alertas: data.alertas.map(withId),
      kpis: calcularKpis(data, d, status),
      calendario: construirCalendario(data, d),
      conectores: {
        dehu: { estado: 'no_configurado', detalle: 'Sin conector con la DEHú: el acuse se registra a mano tras comparecer en la sede.' },
        boletines: {
          estado: status.ultimoOk ? (status.ultimoError ? 'degradado' : 'ok') : status.ultimaSync ? 'error' : 'pendiente',
          ultima_sync: status.ultimaSync ?? null,
          ultimo_ok: status.ultimoOk ?? null,
          error: status.ultimoError ?? null,
          sincronizando: boletines.isRunning(),
        },
      },
      demo: { registros: demo },
      meta: {
        esquemas: esquemasPublicos(),
        transiciones: TRANSICIONES_NOTIFICACION,
        administraciones: ADMINISTRACIONES,
        categorias: CATEGORIAS.map(({ key, label }) => ({ key, label })),
        normas: NORMAS,
        portales: portalesPara(req.user),
        dgt_url: DGT_CONSULTA_URL,
      },
    });
  }));

  app.get('/api/fl/summary', ...guard, ah(async (req, res) => {
    const d = hoy();
    const [data, status] = await Promise.all([cargarTodo(), boletines.status()]);
    res.json({ hoy: d, ...calcularKpis(data, d, status) });
  }));

  app.get('/api/fl/log/verify', ...guard, ah(async (req, res) => {
    const all = await mongo.collection('fl_log').find({}).sort({ seq: 1 }).toArray();
    res.json(verifyChain(all));
  }));

  app.get(`/api/fl/historial/${ENTIDAD_ROUTE}/:id`, ...guard, ah(async (req, res) => {
    const entries = await mongo.collection('fl_log')
      .find({ entidad: req.params.entidad, refId: req.params.id })
      .sort({ seq: -1 }).limit(200).toArray();
    res.json(entries.map(({ _id, seq, action, actorId, createdAt, detail, hash, prevHash }) => ({ seq, action, actorId, createdAt, detail, hash, prevHash })));
  }));

  /* ---------------------- CRUD generico ---------------------- */
  app.post(`/api/fl/${ENTIDAD_ROUTE}`, ...guard, ah(async (req, res) => {
    const { entidad } = req.params;
    const { value, errors } = validarEntidad(ESQUEMAS[entidad], req.body);
    if (errors.length) return res.status(400).json({ error: errors.join(' · '), errors });
    if (value.sociedad_id && !(await sociedadExiste(value.sociedad_id))) return res.status(400).json({ error: 'La sociedad indicada no existe' });

    const ts = new Date().toISOString();
    const doc = { _id: crypto.randomUUID(), ...value, placeholder: false, deleted: false, createdBy: req.user, createdAt: ts, updatedAt: ts };
    if (entidad === 'notificaciones') Object.assign(doc, { estado: 'pendiente', acuse: null, respuesta: null });
    if (entidad === 'modelos' && doc.estado !== 'pendiente' && !doc.presentado_at) doc.presentado_at = hoy();
    if (entidad === 'checklist' && doc.estado === 'completado') Object.assign(doc, { completado_por: req.user, completado_at: ts });
    await col(entidad).insertOne(doc);
    await log({ action: `${entidad}.create`, actorId: req.user, entidad, refId: doc._id, detail: { campos: Object.keys(value) } });
    res.status(201).json(serializar(entidad, doc, hoy()));
  }));

  app.patch(`/api/fl/${ENTIDAD_ROUTE}/:id`, ...guard, ah(async (req, res) => {
    const { entidad, id } = req.params;
    const actual = await col(entidad).findOne({ _id: id, deleted: { $ne: true } });
    if (!actual) return res.status(404).json({ error: `${ESQUEMAS[entidad].label}: no encontrado` });
    const { value, errors } = validarEntidad(ESQUEMAS[entidad], req.body, { partial: true });
    if (errors.length) return res.status(400).json({ error: errors.join(' · '), errors });
    if (value.sociedad_id && !(await sociedadExiste(value.sociedad_id))) return res.status(400).json({ error: 'La sociedad indicada no existe' });
    if (!Object.keys(value).length) return res.status(400).json({ error: 'Nada que actualizar' });

    const set = { ...value, updatedAt: new Date().toISOString() };
    if (entidad === 'modelos' && value.estado && value.estado !== 'pendiente' && !actual.presentado_at && !value.presentado_at) set.presentado_at = hoy();
    if (entidad === 'checklist' && value.estado) {
      Object.assign(set, value.estado === 'completado' ? { completado_por: req.user, completado_at: set.updatedAt } : { completado_por: null, completado_at: null });
    }
    if (entidad === 'notificaciones' && actual.acuse && ('plazo_respuesta' in value || 'plazo_tipo' in value) && !('fecha_limite_respuesta' in value)) {
      const plazo = value.plazo_respuesta ?? actual.plazo_respuesta;
      set.fecha_limite_respuesta = computeFechaLimite(actual.acuse.fecha, plazo, value.plazo_tipo ?? actual.plazo_tipo);
    }
    await col(entidad).updateOne({ _id: id }, { $set: set });
    const cambios = Object.keys(value).filter((k) => JSON.stringify(actual[k] ?? null) !== JSON.stringify(value[k] ?? null));
    await log({ action: `${entidad}.update`, actorId: req.user, entidad, refId: id, detail: { cambios, ...(value.estado ? { estado: value.estado } : {}) } });
    res.json(serializar(entidad, await col(entidad).findOne({ _id: id }), hoy()));
  }));

  // Archivar = soft-delete: el registro sigue en Mongo (doctrina de retencion,
  // ver incidente del Expediente 2026-09-28); no hay borrado real por HTTP.
  app.delete(`/api/fl/${ENTIDAD_ROUTE}/:id`, ...guard, ah(async (req, res) => {
    const { entidad, id } = req.params;
    const actual = await col(entidad).findOne({ _id: id, deleted: { $ne: true } });
    if (!actual) return res.status(404).json({ error: `${ESQUEMAS[entidad].label}: no encontrado` });
    if (entidad === 'sociedades') {
      const dependientes = await Promise.all(ENTIDADES.filter((e) => e !== 'sociedades' && e !== 'checklist')
        .map((e) => col(e).countDocuments({ sociedad_id: id, deleted: { $ne: true } })));
      if (dependientes.some((n) => n > 0)) return res.status(409).json({ error: 'La sociedad tiene registros activos: archívalos o reasígnalos antes' });
    }
    const ts = new Date().toISOString();
    await col(entidad).updateOne({ _id: id }, { $set: { deleted: true, deletedAt: ts, deletedBy: req.user, updatedAt: ts } });
    await log({ action: `${entidad}.archive`, actorId: req.user, entidad, refId: id, detail: { placeholder: !!actual.placeholder } });
    res.json({ id, archivado: true });
  }));

  // Un registro de demostracion corregido a mano pasa a ser dato real.
  app.post(`/api/fl/${ENTIDAD_ROUTE}/:id/confirmar`, ...guard, ah(async (req, res) => {
    const { entidad, id } = req.params;
    const actual = await col(entidad).findOne({ _id: id, deleted: { $ne: true } });
    if (!actual) return res.status(404).json({ error: `${ESQUEMAS[entidad].label}: no encontrado` });
    if (!actual.placeholder) return res.status(409).json({ error: 'El registro ya es un dato real' });
    await col(entidad).updateOne({ _id: id }, { $set: { placeholder: false, source: null, confirmadoPor: req.user, confirmadoAt: new Date().toISOString() } });
    await log({ action: `${entidad}.confirm_real`, actorId: req.user, entidad, refId: id, detail: {} });
    res.json(serializar(entidad, await col(entidad).findOne({ _id: id }), hoy()));
  }));

  app.post('/api/fl/demo/retirar', ...guard, ah(async (req, res) => {
    if (req.body?.confirmar !== true) return res.status(400).json({ error: 'Falta la confirmación expresa (confirmar: true)' });
    const ts = new Date().toISOString();
    const counts = {};
    for (const e of ENTIDADES) {
      const r = await col(e).updateMany({ placeholder: true, deleted: { $ne: true } }, { $set: { deleted: true, deletedAt: ts, deletedBy: req.user, updatedAt: ts } });
      counts[e] = r.modifiedCount;
    }
    await log({ action: 'hub.demo_archive', actorId: req.user, detail: counts });
    res.json({ archivados: counts });
  }));

  /* ---------------------- Notificaciones: acuse y flujo ---------------------- */
  app.post('/api/fl/notificaciones/:id/acuse', ...guard, ah(async (req, res) => {
    const n = await col('notificaciones').findOne({ _id: req.params.id, deleted: { $ne: true } });
    if (!n) return res.status(404).json({ error: 'Notificación no encontrada' });
    if (n.acuse) return res.status(409).json({ error: 'La notificación ya tiene acuse registrado' });
    const d = hoy();
    const fecha = req.body?.fecha ?? d;
    if (!isIsoDate(fecha)) return res.status(400).json({ error: 'Fecha de acceso no válida (AAAA-MM-DD)' });
    if (fecha < n.puesta_disposicion || fecha > d) return res.status(400).json({ error: 'La fecha de acceso debe estar entre la puesta a disposición y hoy' });
    if (req.body?.declaracion !== true) return res.status(400).json({ error: 'Confirma que has accedido al contenido en la sede o en la DEHú' });

    const acuse = { fecha, registrado_por: req.user, registrado_at: new Date().toISOString() };
    const fechaLimite = n.plazo_respuesta > 0 ? computeFechaLimite(fecha, n.plazo_respuesta, n.plazo_tipo) : null;
    await col('notificaciones').updateOne({ _id: n._id }, { $set: { acuse, fecha_limite_respuesta: fechaLimite, updatedAt: acuse.registrado_at } });
    const fueraDePlazo = fecha > fechaRechazoPresunto(n.puesta_disposicion);
    await log({ action: 'notificaciones.acuse', actorId: req.user, entidad: 'notificaciones', refId: n._id, detail: { fecha, fecha_limite_respuesta: fechaLimite, tras_rechazo_presunto: fueraDePlazo } });
    res.json(serializar('notificaciones', await col('notificaciones').findOne({ _id: n._id }), d));
  }));

  app.post('/api/fl/notificaciones/:id/estado', ...guard, ah(async (req, res) => {
    const n = await col('notificaciones').findOne({ _id: req.params.id, deleted: { $ne: true } });
    if (!n) return res.status(404).json({ error: 'Notificación no encontrada' });
    const destino = req.body?.estado;
    if (!(TRANSICIONES_NOTIFICACION[n.estado] ?? []).includes(destino)) {
      return res.status(409).json({ error: `Transición no permitida: ${n.estado} → ${destino ?? '?'}` });
    }
    const set = { estado: destino, updatedAt: new Date().toISOString() };
    if (destino === 'asignada') {
      const abogado = typeof req.body.abogado_asignado === 'string' ? req.body.abogado_asignado.trim().slice(0, 120) : '';
      if (!abogado && !n.abogado_asignado) return res.status(400).json({ error: 'Indica el abogado o responsable asignado' });
      if (abogado) set.abogado_asignado = abogado;
    }
    if (destino === 'respondida') {
      if (!n.acuse) return res.status(409).json({ error: 'Registra antes el acuse de recepción' });
      const r = req.body.respuesta ?? {};
      const fecha = r.fecha ?? hoy();
      if (!isIsoDate(fecha) || fecha < n.acuse.fecha) return res.status(400).json({ error: 'Fecha de respuesta no válida' });
      set.respuesta = {
        fecha,
        referencia: typeof r.referencia === 'string' ? r.referencia.trim().slice(0, 80) : '',
        nota: typeof r.nota === 'string' ? r.nota.trim().slice(0, 600) : '',
        registrado_por: req.user,
        registrado_at: set.updatedAt,
      };
    }
    await col('notificaciones').updateOne({ _id: n._id }, { $set: set });
    await log({ action: 'notificaciones.estado', actorId: req.user, entidad: 'notificaciones', refId: n._id, detail: { de: n.estado, a: destino, ...(set.abogado_asignado ? { abogado: set.abogado_asignado } : {}) } });
    res.json(serializar('notificaciones', await col('notificaciones').findOne({ _id: n._id }), hoy()));
  }));

  /* ---------------------- Boletines ---------------------- */
  app.patch('/api/fl/alertas/:id', ...guard, ah(async (req, res) => {
    const estado = req.body?.estado;
    if (!['nueva', 'revisada', 'descartada'].includes(estado)) return res.status(400).json({ error: 'Estado no válido' });
    const alerta = await mongo.collection('fl_alertas_normativas').findOne({ _id: req.params.id });
    if (!alerta) return res.status(404).json({ error: 'Alerta no encontrada' });
    const ts = new Date().toISOString();
    await mongo.collection('fl_alertas_normativas').updateOne({ _id: alerta._id }, { $set: { estado, revisada_por: req.user, revisada_at: ts } });
    await log({ action: 'alertas.estado', actorId: req.user, entidad: 'alertas', refId: alerta._id, detail: { de: alerta.estado, a: estado } });
    res.json(withId(await mongo.collection('fl_alertas_normativas').findOne({ _id: alerta._id })));
  }));

  app.post('/api/fl/boletines/sync', ...guard, ah(async (req, res) => {
    const ahora = Date.now();
    if (!boletines.isRunning() && ahora - ultimaSyncManual < SYNC_MANUAL_COOLDOWN_MS) {
      return res.status(429).json({ error: 'Sincronización reciente: espera un par de minutos' });
    }
    ultimaSyncManual = ahora;
    const resumen = await boletines.sync({ dias: BOLETINES_DIAS_MANUAL, actorId: req.user });
    res.json({ ...resumen, status: await boletines.status() });
  }));

  /* ---------------------- Ficha PDF (acceso registrado) ---------------------- */
  app.get(`/api/fl/${ENTIDAD_ROUTE}/:id/pdf`, ...guard, ah(async (req, res) => {
    const { entidad, id } = req.params;
    const doc = await col(entidad).findOne({ _id: id, deleted: { $ne: true } });
    if (!doc) return res.status(404).json({ error: `${ESQUEMAS[entidad].label}: no encontrado` });
    const sociedades = new Map((await col('sociedades').find({}).toArray()).map((s) => [s._id, s]));
    const logEntry = await log({ action: 'pdf.download', actorId: req.user, entidad, refId: id, detail: {} });
    const buffer = await generarFichaPdf({ entidad, doc: withId(doc), sociedades, logEntry, usuario: req.user });
    const slug = String(doc.modelo || doc.expediente || doc.titulo || doc.apoderado || doc.nombre_corto || doc.nia || id)
      .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="ficha-${entidad}-${slug || 'registro'}.pdf"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(buffer);
  }));

  return { ready, boletines, revisarAlarmas: () => enTenant(revisarAlarmas) };
}
