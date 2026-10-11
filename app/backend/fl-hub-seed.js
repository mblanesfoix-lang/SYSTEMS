/**
 * S-NFI F&L · datos de demostracion del Hub fiscal y legal.
 *
 * Todo lo que siembra este archivo es PLACEHOLDER (placeholder: true en cada
 * documento) hasta que Direccion confirme los datos reales, mismo criterio que
 * los placeholders de Pactvm Viridi y Resilience. La interfaz lo marca como
 * DEMO, las alarmas al Admin lo ignoran y POST /api/fl/demo/retirar lo
 * archiva de una vez cuando lleguen los reales.
 *
 * Criterios para que la demostracion no engane:
 *   - NIF con codigo de provincia 00 (B00000001...): no existe, no puede
 *     coincidir con una sociedad real.
 *   - Expedientes, justificantes y protocolos con prefijo DEMO-.
 *   - Personas y contrapartes ficticias; ninguna persona real del equipo
 *     figura como apoderado ni contraparte.
 *   - Cifras de negocio tomadas de la base de conocimiento y del Expediente
 *     (piloto Navarra 2 BioGrinder + 1 BioDeshidratador, Gipuzkoa 150 t/dia y
 *     4.380 t/ano, royalties 175.000-262.000 EUR/ano, off-take 110-130 EUR/t,
 *     DSCR 6,36x); el resto es ilustrativo.
 *   - Calendario tributario real de la AEAT (303/111 trimestral el dia 20 del
 *     mes siguiente y 30 de enero el 4T del 303; 202 en abril, octubre y
 *     diciembre; 200 hasta el 25 de julio; 347 en febrero; 390 hasta el 30 de
 *     enero), con traslado al lunes si cae en fin de semana. Los modelos
 *     forales de Navarra (S-90, F-69, F50-347) llevan plazo orientativo y una
 *     nota para confirmarlo con Hacienda Foral.
 *
 * Fechas relativas a `hoy` (YYYY-MM-DD): la demostracion siempre arranca
 * coherente con el dia en que se siembra y envejece como lo harian los datos
 * reales.
 */

import crypto from 'node:crypto';
import {
  addDaysIso, diffDaysIso, isoOf, nextBusinessDayIso, lastDayOfMonthIso, computeFechaLimite,
} from './fl-hub-fechas.js';

export const SEED_KEY = 'fl_hub_seed_v1';
export const PLACEHOLDER_SOURCE = 'PLACEHOLDER — dato de demostración, pendiente de confirmar por Dirección';

const NOTA_FORAL = 'Plazo orientativo: confirmar con el calendario del contribuyente de Hacienda Foral de Navarra.';

const CONCEPTOS = {
  '303': 'IVA · Autoliquidación trimestral',
  '111': 'IRPF · Retenciones del trabajo y actividades profesionales',
  '202': 'Impuesto sobre Sociedades · Pago fraccionado',
  '200': 'Impuesto sobre Sociedades · Declaración anual',
  '347': 'Declaración anual de operaciones con terceras personas',
  '390': 'IVA · Declaración-resumen anual',
  'S-90': 'Impuesto sobre Sociedades (Navarra) · Autoliquidación anual',
  'F-69': 'IVA (Navarra) · Autoliquidación trimestral',
  'F50-347': 'Operaciones con terceras personas (Navarra) · Declaración anual',
};

/** Plazo trimestral: dia 20 del mes siguiente; 4T el 30 de enero (303/F-69) o el 20 (111). */
function plazoTrimestral(y, q, modelo) {
  if (q < 4) return nextBusinessDayIso(isoOf(y, q * 3 + 1, 20));
  return nextBusinessDayIso(isoOf(y + 1, 1, modelo === '111' ? 20 : 30));
}

/** Importe deterministico a partir de una tabla (sin aleatoriedad: tests estables). */
function pick(tabla, i) {
  return tabla[i % tabla.length];
}

export function buildSeed(hoy) {
  const Y = Number(hoy.slice(0, 4));
  const now = new Date().toISOString();
  const base = () => ({
    _id: crypto.randomUUID(),
    placeholder: true,
    source: PLACEHOLDER_SOURCE,
    deleted: false,
    createdBy: 'system',
    createdAt: now,
    updatedAt: now,
  });
  const d = (n) => addDaysIso(hoy, n);

  /* ------------------------------ Sociedades ------------------------------ */
  const corp = {
    ...base(), nombre_corto: 'S-NFI Corp.', denominacion: 'South-Navarre Fresh Innovations, S.L.', nif: 'B00000001',
    forma: 'S.L.', rol: 'holding', estado: 'activa', administracion: 'HFN',
    domicilio: 'Navarra (pendiente de confirmar)', registro_mercantil: 'Registro Mercantil de Navarra', datos_registrales: 'Pendiente de confirmar',
    fecha_constitucion: null, capital_social_cents: null, participacion_pct: null,
    organo_administracion: 'administrador_unico', administradores: 'Pendiente de confirmar', socio_unico: null,
    objeto_social: 'OEM de infraestructura industrial modular: diseño, integración y gobierno por software propietario de sistemas BioHybrid de valorización de residuo orgánico húmedo.',
    borme_alias: ['S-NFI Corp'],
  };
  const vanguard = {
    ...base(), nombre_corto: 'S-NFI Vanguard', denominacion: 'S-NFI Vanguard, S.L.U.', nif: 'B00000002',
    forma: 'S.L.U.', rol: 'filial', estado: 'activa', administracion: 'HFN',
    domicilio: 'Navarra (pendiente de confirmar)', registro_mercantil: 'Registro Mercantil de Navarra', datos_registrales: 'Pendiente de confirmar',
    fecha_constitucion: null, capital_social_cents: null, participacion_pct: 100,
    organo_administracion: 'administrador_unico', administradores: 'Pendiente de confirmar', socio_unico: 'South-Navarre Fresh Innovations, S.L.',
    objeto_social: 'Titularidad, registro y licencia de la propiedad intelectual e industrial del grupo: Kernel, PAIA, patentes y marca.',
    borme_alias: [],
  };
  const energy = {
    ...base(), nombre_corto: 'S-NFI Energy', denominacion: 'S-NFI Energy, S.L.U.', nif: 'B00000003',
    forma: 'S.L.U.', rol: 'spv', estado: 'activa', administracion: 'AEAT',
    domicilio: 'Pendiente de confirmar (territorio común)', registro_mercantil: 'Pendiente de confirmar', datos_registrales: 'Pendiente de confirmar',
    fecha_constitucion: null, capital_social_cents: null, participacion_pct: 100,
    organo_administracion: 'administrador_unico', administradores: 'Pendiente de confirmar', socio_unico: 'South-Navarre Fresh Innovations, S.L.',
    objeto_social: 'Vehículo de proyecto energético: contratos de compraventa de energía (PPA) para la absorción de excedentes renovables.',
    borme_alias: [],
  };
  const infra = {
    ...base(), nombre_corto: 'S-NFI Infra', denominacion: 'S-NFI Infra, S.L.U.', nif: 'B00000004',
    forma: 'S.L.U.', rol: 'spv', estado: 'activa', administracion: 'AEAT',
    domicilio: 'Pendiente de confirmar (territorio común)', registro_mercantil: 'Pendiente de confirmar', datos_registrales: 'Pendiente de confirmar',
    fecha_constitucion: null, capital_social_cents: null, participacion_pct: 100,
    organo_administracion: 'administrador_unico', administradores: 'Pendiente de confirmar', socio_unico: 'South-Navarre Fresh Innovations, S.L.',
    objeto_social: 'Vehículo de proyecto industrial: titularidad y explotación de plantas BioHybrid (BioGrinder + BioDeshidratador) y venta de biopellet.',
    borme_alias: [],
  };
  const sociedades = [corp, vanguard, energy, infra];

  /* --------------------------- Modelos tributarios --------------------------- */
  const modelos = [];
  const enVentana = (fecha) => {
    const dd = diffDaysIso(hoy, fecha);
    return dd >= -300 && dd <= 120;
  };
  const addModelo = (soc, admin, modelo, periodo, ejercicio, fecha_limite, extra) => {
    const pasado = diffDaysIso(hoy, fecha_limite) < 0;
    modelos.push({
      ...base(), sociedad_id: soc._id, administracion: admin, modelo, concepto: CONCEPTOS[modelo],
      periodo, ejercicio, fecha_limite,
      estado: pasado ? 'liquidado' : 'pendiente',
      resultado: null, importe_cents: null,
      presentado_at: pasado ? addDaysIso(fecha_limite, -(1 + (modelos.length % 5))) : null,
      justificante: pasado ? `DEMO-${modelo}-${ejercicio}-${periodo}` : null,
      responsable: admin === 'HFN' ? 'Dirección Financiera' : 'Asesoría fiscal externa',
      notas: admin === 'HFN' ? NOTA_FORAL : '',
      ...extra,
    });
    return modelos[modelos.length - 1];
  };

  const trimestres = [];
  for (let y = Y - 1; y <= Y; y += 1) for (let q = 1; q <= 4; q += 1) trimestres.push({ y, q });

  const IMPORTES = {
    energy303: [1843210, 2190544, 1688002, 2431075, 1974430],
    infra303: [4122000, 3890412, 5211089, 4467320, 3988710],
    energy111: [624000, 648000, 691000, 702500, 655800],
    infra111: [412000, 438000, 451500, 447300, 463900],
    corpF69: [321040, 298015, 410577, 356690, 377420],
    vanguardF69: [1184000, 1230000, 1251600, 1302450, 1276800],
  };

  for (const [soc, key303, key111] of [[energy, 'energy303', 'energy111'], [infra, 'infra303', 'infra111']]) {
    let i303 = 0;
    let i111 = 0;
    for (const { y, q } of trimestres) {
      const f303 = plazoTrimestral(y, q, '303');
      if (enVentana(f303)) {
        addModelo(soc, 'AEAT', '303', `${q}T`, y, f303, {
          resultado: soc === infra ? 'a_compensar' : 'a_ingresar',
          importe_cents: pick(IMPORTES[key303], i303),
        });
        i303 += 1;
      }
      const f111 = plazoTrimestral(y, q, '111');
      if (enVentana(f111)) {
        addModelo(soc, 'AEAT', '111', `${q}T`, y, f111, { resultado: 'a_ingresar', importe_cents: pick(IMPORTES[key111], i111) });
        i111 += 1;
      }
    }
    for (let y = Y - 1; y <= Y; y += 1) {
      for (const [p, m, dd] of [['1P', 4, 20], ['2P', 10, 20], ['3P', 12, 20]]) {
        const f202 = nextBusinessDayIso(isoOf(y, m, dd));
        if (!enVentana(f202)) continue;
        addModelo(soc, 'AEAT', '202', p, y, f202, soc === infra
          ? { resultado: 'sin_actividad', importe_cents: 0 }
          : { resultado: 'a_ingresar', importe_cents: pick([1250000, 1420000, 980000, 1310000], modelos.length) });
      }
    }
    addModelo(soc, 'AEAT', '200', 'Anual', Y - 1, nextBusinessDayIso(isoOf(Y, 7, 25)), soc === infra
      ? { resultado: 'a_devolver', importe_cents: 341000 }
      : { resultado: 'a_ingresar', importe_cents: 4892033 });
    addModelo(soc, 'AEAT', '347', 'Anual', Y - 1, nextBusinessDayIso(lastDayOfMonthIso(Y, 2)), { resultado: 'informativa' });
    addModelo(soc, 'AEAT', '390', 'Anual', Y - 1, nextBusinessDayIso(isoOf(Y, 1, 30)), { resultado: 'informativa' });
  }

  for (const [soc, keyF69] of [[corp, 'corpF69'], [vanguard, 'vanguardF69']]) {
    let i = 0;
    for (const { y, q } of trimestres) {
      const f = plazoTrimestral(y, q, 'F-69');
      if (!enVentana(f)) continue;
      addModelo(soc, 'HFN', 'F-69', `${q}T`, y, f, { resultado: 'a_ingresar', importe_cents: pick(IMPORTES[keyF69], i) });
      i += 1;
    }
    addModelo(soc, 'HFN', 'S-90', 'Anual', Y - 1, nextBusinessDayIso(isoOf(Y, 7, 25)), {
      resultado: 'a_ingresar', importe_cents: soc === corp ? 745000 : 2988050,
    });
    addModelo(soc, 'HFN', 'F50-347', 'Anual', Y - 1, nextBusinessDayIso(lastDayOfMonthIso(Y, 2)), { resultado: 'informativa' });
  }

  // El 303 vencido mas reciente de S-NFI Infra queda en revision: lo
  // comprueba la propuesta de liquidacion sembrada mas abajo.
  const infra303Pasados = modelos
    .filter((m) => m.sociedad_id === infra._id && m.modelo === '303' && m.estado === 'liquidado')
    .sort((a, b) => b.fecha_limite.localeCompare(a.fecha_limite));
  const enRevision = infra303Pasados[0] ?? null;
  if (enRevision) {
    enRevision.estado = 'en_auditoria';
    enRevision.resultado = 'a_devolver';
    enRevision.importe_cents = 6348015;
    enRevision.notas = 'Comprobación limitada abierta: ver la propuesta de liquidación en GobTech.';
  }
  // Un 111 de S-NFI Energy presentado fuera de plazo (baja el cumplimiento).
  const tardio = modelos
    .filter((m) => m.sociedad_id === energy._id && m.modelo === '111' && m.estado === 'liquidado')
    .sort((a, b) => a.fecha_limite.localeCompare(b.fecha_limite))[1];
  if (tardio) {
    tardio.presentado_at = addDaysIso(tardio.fecha_limite, 2);
    tardio.notas = 'Presentado con dos días de retraso: recargo del art. 27 LGT.';
  }

  /* ------------------------- Notificaciones oficiales ------------------------ */
  const notif = (soc, o) => {
    const acuse = o.acuse_fecha ? { fecha: o.acuse_fecha, registrado_por: 'system', registrado_at: now } : null;
    const fecha_limite_respuesta = acuse && o.plazo_respuesta > 0 ? computeFechaLimite(acuse.fecha, o.plazo_respuesta, o.plazo_tipo) : null;
    const { acuse_fecha, ...rest } = o;
    return {
      ...base(), sociedad_id: soc._id, importe_cents: null, abogado_asignado: null, respuesta: null, resumen: '',
      ...rest, acuse, fecha_limite_respuesta,
    };
  };
  const periodoRevision = enRevision ? `${enRevision.periodo} ${enRevision.ejercicio}` : 'del último trimestre';
  const notificaciones = [
    notif(vanguard, {
      emisor: 'Agencia Estatal de Administración Tributaria', emisor_siglas: 'AEAT', canal: 'dehu', tipo: 'requerimiento',
      expediente: 'DEMO-AEAT-RQ-2026-04127',
      asunto: 'Requerimiento de información sobre operaciones vinculadas: canon de licencia del Kernel y PAIA a sociedades del grupo',
      resumen: 'Solicita los contratos de licencia inter-company, la documentación de precios de transferencia (art. 18 LIS) y la facturación del canon del ejercicio anterior.',
      puesta_disposicion: d(-3), acuse_fecha: null, plazo_respuesta: 10, plazo_tipo: 'habiles', prioridad: 'alta', estado: 'pendiente',
    }),
    notif(infra, {
      emisor: 'Agencia Estatal de Administración Tributaria', emisor_siglas: 'AEAT', canal: 'dehu', tipo: 'propuesta_liquidacion',
      expediente: 'DEMO-AEAT-CL-2026-11873',
      asunto: `Propuesta de liquidación provisional · IVA ${periodoRevision}: minoración de cuotas a compensar`,
      resumen: 'Procedimiento de comprobación limitada sobre el modelo 303. El plazo de alegaciones corre desde la notificación.',
      puesta_disposicion: d(-8), acuse_fecha: null, plazo_respuesta: 10, plazo_tipo: 'habiles', prioridad: 'critica', estado: 'pendiente',
      importe_cents: 1835000,
    }),
    notif(corp, {
      emisor: 'Agencia Estatal de Administración Tributaria', emisor_siglas: 'AEAT', canal: 'dehu', tipo: 'comunicacion',
      expediente: 'DEMO-AEAT-CO-2026-71530',
      asunto: 'Comunicación sobre la obligación de relacionarse por medios electrónicos y alta en la DEHú',
      puesta_disposicion: d(-1), acuse_fecha: null, plazo_respuesta: 0, plazo_tipo: 'habiles', prioridad: 'baja', estado: 'pendiente',
    }),
    notif(corp, {
      emisor: 'Tesorería General de la Seguridad Social', emisor_siglas: 'TGSS', canal: 'sede_tgss', tipo: 'requerimiento',
      expediente: 'DEMO-TGSS-2026-55210',
      asunto: 'Reclamación de deuda por diferencias de cotización',
      resumen: 'Diferencias en bases de cotización del personal técnico. Cabe recurso de alzada en el plazo de un mes.',
      puesta_disposicion: d(-6), acuse_fecha: d(-5), plazo_respuesta: 1, plazo_tipo: 'meses', prioridad: 'media', estado: 'asignada',
      abogado_asignado: 'Asesoría laboral externa', importe_cents: 412680,
    }),
    notif(infra, {
      emisor: 'Ministerio para la Transición Ecológica y el Reto Demográfico', emisor_siglas: 'MITECO', canal: 'dehu', tipo: 'tramite_audiencia',
      expediente: 'DEMO-MITECO-PERTE-EC-0389',
      asunto: 'Trámite de audiencia: propuesta de resolución provisional de ayudas del PERTE de Economía Circular',
      resumen: 'Propuesta de concesión condicionada a acreditar la inscripción como gestor de residuos y la memoria técnica de la línea BioHybrid.',
      puesta_disposicion: d(-4), acuse_fecha: d(-4), plazo_respuesta: 10, plazo_tipo: 'habiles', prioridad: 'alta', estado: 'asignada',
      abogado_asignado: 'Dirección Jurídica', importe_cents: 68500000,
    }),
    notif(energy, {
      emisor: 'Instituto para la Diversificación y Ahorro de la Energía', emisor_siglas: 'IDAE', canal: 'dehu', tipo: 'requerimiento',
      expediente: 'DEMO-IDAE-ALM-2026-0912',
      asunto: 'Requerimiento de justificación de ayuda al almacenamiento energético (PRTR, NextGenerationEU)',
      resumen: 'Solicita la cuenta justificativa, las facturas y la acreditación de los hitos técnicos del almacenamiento asociado al PPA.',
      puesta_disposicion: d(-16), acuse_fecha: d(-15), plazo_respuesta: 15, plazo_tipo: 'habiles', prioridad: 'alta', estado: 'asignada',
      abogado_asignado: 'Dirección Financiera', importe_cents: 21000000,
    }),
    notif(energy, {
      emisor: 'Agencia Estatal de Administración Tributaria', emisor_siglas: 'AEAT', canal: 'dehu', tipo: 'inicio_procedimiento',
      expediente: 'DEMO-AEAT-CL-2026-09644',
      asunto: 'Inicio de comprobación limitada · Impuesto sobre Sociedades: deducción por I+D+i (art. 35 LIS)',
      resumen: 'Solicita el informe motivado y el detalle de los gastos de I+D imputados.',
      puesta_disposicion: d(-30), acuse_fecha: d(-29), plazo_respuesta: 10, plazo_tipo: 'habiles', prioridad: 'media', estado: 'respondida',
      abogado_asignado: 'Asesoría fiscal externa',
      respuesta: { fecha: d(-18), referencia: 'DEMO-RGE-2026-118204', nota: 'Aportado el informe motivado y el detalle de gastos.', registrado_por: 'system', registrado_at: now },
    }),
    notif(corp, {
      emisor: 'Hacienda Foral de Navarra', emisor_siglas: 'HFN', canal: 'sede_navarra', tipo: 'requerimiento',
      expediente: 'DEMO-HFN-2026-30071',
      asunto: 'Requerimiento de documentación sobre la aplicación del régimen FEAC a una aportación no dineraria de rama de actividad',
      resumen: 'Escritura de aportación, valoración de la rama de actividad y acreditación de motivos económicos válidos.',
      puesta_disposicion: d(-48), acuse_fecha: d(-47), plazo_respuesta: 10, plazo_tipo: 'habiles', prioridad: 'media', estado: 'archivada',
      abogado_asignado: 'Dirección Jurídica',
      respuesta: { fecha: d(-37), referencia: 'DEMO-HFN-RE-2026-7718', nota: 'Documentación aportada; expediente cerrado sin regularización.', registrado_por: 'system', registrado_at: now },
    }),
    notif(infra, {
      emisor: 'Agencia Estatal de Administración Tributaria', emisor_siglas: 'AEAT', canal: 'sede_aeat', tipo: 'resolucion',
      expediente: 'DEMO-AEAT-DEV-2026-33415',
      asunto: 'Acuerdo de devolución · IVA: cuotas a compensar del ejercicio anterior',
      resumen: 'Reconoce la devolución solicitada en la declaración-resumen anual.',
      puesta_disposicion: d(-22), acuse_fecha: d(-22), plazo_respuesta: 0, plazo_tipo: 'habiles', prioridad: 'baja', estado: 'archivada',
      importe_cents: 9420000,
    }),
  ];

  /* ------------------------------ Juntas y actas ------------------------------ */
  const yJgo = diffDaysIso(isoOf(Y, 6, 26), hoy) >= 0 ? Y : Y - 1;
  const junta = (soc, o) => ({
    ...base(), sociedad_id: soc._id, caracter: null, hora: null, lugar: null, orden_del_dia: [], acuerdos: [],
    aprueba_cuentas: false, ejercicio_cuentas: null, inscribible: false, acta_ref: null, notario: null, ...o,
  });
  const ordenCuentas = (ej) => [
    `Examen y aprobación de las cuentas anuales del ejercicio ${ej}`,
    'Aplicación del resultado',
    'Aprobación de la gestión del órgano de administración',
  ];
  const juntas = [
    junta(corp, {
      organo: 'junta_general', caracter: 'ordinaria', fecha: isoOf(yJgo, 6, 26), hora: '11:00', lugar: 'Domicilio social (Navarra)', estado: 'formalizada',
      orden_del_dia: [...ordenCuentas(yJgo - 1), 'Nombramiento de auditor de cuentas (arts. 263 LSC y 40 LAC)'],
      acuerdos: [`Se aprueban las cuentas anuales del ejercicio ${yJgo - 1}`, 'Se aplica el resultado a reservas voluntarias', 'Se nombra auditor por tres ejercicios'],
      aprueba_cuentas: true, ejercicio_cuentas: yJgo - 1, inscribible: true, acta_ref: 'DEMO · Libro de actas 1, acta 7',
    }),
    junta(vanguard, {
      organo: 'socio_unico', caracter: 'ordinaria', fecha: isoOf(yJgo, 6, 20), estado: 'formalizada',
      orden_del_dia: ordenCuentas(yJgo - 1), acuerdos: [`Se aprueban las cuentas anuales del ejercicio ${yJgo - 1}`],
      aprueba_cuentas: true, ejercicio_cuentas: yJgo - 1, acta_ref: 'DEMO · Libro de decisiones 1, decisión 4',
    }),
    junta(energy, {
      organo: 'socio_unico', caracter: 'ordinaria', fecha: isoOf(yJgo, 6, 29), estado: 'acta_firmada',
      orden_del_dia: ordenCuentas(yJgo - 1), acuerdos: [`Se aprueban las cuentas anuales del ejercicio ${yJgo - 1}`],
      aprueba_cuentas: true, ejercicio_cuentas: yJgo - 1, acta_ref: 'DEMO · Libro de decisiones 1, decisión 2',
    }),
    junta(corp, {
      organo: 'junta_general', caracter: 'universal', fecha: d(-15), hora: '17:00', lugar: 'Domicilio social (Navarra)', estado: 'celebrada',
      orden_del_dia: ['Marco de licencias inter-company del Kernel y PAIA a las sociedades del grupo'],
      acuerdos: ['Se aprueba el marco de licencias con cláusula de revocación automática (Pactvm Viridi)'],
    }),
    junta(corp, {
      organo: 'junta_general', caracter: 'extraordinaria', fecha: d(9), hora: '10:30', lugar: 'Notaría (pendiente de confirmar)', estado: 'convocada',
      orden_del_dia: ['Aumento de capital con cargo a aportaciones dinerarias (entrada de inversor)', 'Modificación del artículo 2 de los estatutos (objeto social)', 'Otorgamiento de poderes'],
      inscribible: true,
    }),
    junta(infra, {
      organo: 'socio_unico', fecha: d(20), estado: 'convocada',
      orden_del_dia: ['Aprobación del arrendamiento financiero de la línea piloto BioHybrid', 'Autorización de garantías a favor de la entidad financiera (Tramo 2)'],
    }),
  ];

  /* ------------------------------ Apoderamientos ------------------------------ */
  const poder = (soc, o) => ({
    ...base(), sociedad_id: soc._id, cargo: null, mancomunado_con: null, facultades: [], limite_cents: null,
    notario: 'Notaría (pendiente de confirmar)', protocolo: null, fecha_otorgamiento: null, fecha_caducidad: null,
    inscrito_rm: false, estado: 'vigente', ...o,
  });
  const apoderamientos = [
    poder(corp, {
      apoderado: 'Laura Etxeberria Goñi', cargo: 'Directora Financiera', tipo: 'general', regimen: 'solidario',
      mancomunado_con: 'Iñigo Arriaga Sola (por encima del límite)', limite_cents: 15000000,
      facultades: ['Operativa bancaria y tesorería', 'Contratación mercantil', 'Representación ante la Hacienda Foral de Navarra y la AEAT'],
      protocolo: 'DEMO-1284', fecha_otorgamiento: d(-700), fecha_caducidad: d(25), inscrito_rm: true,
    }),
    poder(corp, {
      apoderado: 'Iñigo Arriaga Sola', cargo: 'Director de Operaciones', tipo: 'especial', regimen: 'solidario', limite_cents: 6000000,
      facultades: ['Contratación de suministros y servicios industriales', 'Firma de pedidos de equipos BioHybrid'],
      protocolo: 'DEMO-1285', fecha_otorgamiento: d(-700), fecha_caducidad: d(420), inscrito_rm: true,
    }),
    poder(vanguard, {
      apoderado: 'Paula Mendívil Ruiz', cargo: 'Responsable de Propiedad Industrial', tipo: 'especial', regimen: 'solidario',
      facultades: ['Solicitudes y renovaciones ante OEPM, EUIPO y OMPI', 'Oposiciones y defensa de marcas y patentes'],
      protocolo: 'DEMO-0311', fecha_otorgamiento: d(-240), inscrito_rm: false,
    }),
    poder(energy, {
      apoderado: 'Laura Etxeberria Goñi', cargo: 'Apoderada', tipo: 'especial', regimen: 'mancomunado', mancomunado_con: 'Iñigo Arriaga Sola',
      limite_cents: 200000000, facultades: ['Negociación y firma de contratos PPA', 'Operaciones en el mercado eléctrico'],
      protocolo: 'DEMO-0907', fecha_otorgamiento: d(-353), fecha_caducidad: d(12), inscrito_rm: true,
    }),
    poder(energy, {
      apoderado: 'Laura Etxeberria Goñi', cargo: 'Apoderada', tipo: 'bancario', regimen: 'mancomunado', mancomunado_con: 'Iñigo Arriaga Sola',
      limite_cents: 50000000, facultades: ['Disposición de la cuenta de servicio de la deuda (Tramo 2)'],
      protocolo: 'DEMO-0951', fecha_otorgamiento: d(-60), fecha_caducidad: d(200), inscrito_rm: true,
    }),
    poder(infra, {
      apoderado: 'Iñigo Arriaga Sola', cargo: 'Apoderado', tipo: 'general', regimen: 'solidario', limite_cents: 25000000,
      facultades: ['Administración ordinaria', 'Contratación de personal técnico'],
      protocolo: 'DEMO-0622', fecha_otorgamiento: d(-1100), fecha_caducidad: d(-5), inscrito_rm: true,
    }),
    poder(corp, {
      apoderado: 'Letrados del despacho externo', cargo: 'Abogados y procuradores', tipo: 'pleitos', regimen: 'solidario',
      facultades: ['Representación en juicio ante cualquier jurisdicción', 'Interposición de recursos'],
      protocolo: 'DEMO-1302', fecha_otorgamiento: d(-420),
    }),
  ];

  /* ------------------------------ Contratos (CLM) ------------------------------ */
  const contrato = (soc, o) => ({
    ...base(), sociedad_id: soc._id, contraparte_nif: null, valor_cents: null, valor_periodicidad: 'total',
    fecha_firma: null, fecha_inicio: null, fecha_vencimiento: null, renovacion_automatica: false, preaviso_dias: null,
    ley_aplicable: 'Española', jurisdiccion: null, clausulas_clave: [], responsable: null, notas: '', ...o,
  });
  const contratos = [
    contrato(energy, {
      tipo: 'ppa', titulo: 'PPA de absorción de excedentes renovables (curtailment) a 0 €/MWh', contraparte: 'Ribera Generación Renovable, S.L.',
      riesgo_contraparte: 38, estado: 'negociacion', jurisdiccion: 'Juzgados y tribunales de Pamplona', responsable: 'Dirección General',
      clausulas_clave: ['Precio de entrada: 0 €/MWh en horas de vertido', 'Plazo: 10 años desde la puesta en marcha', 'Volumen mínimo de absorción anual (take-or-pay)', 'Garantías de origen a favor del comprador'],
    }),
    contrato(infra, {
      tipo: 'offtake', titulo: 'Off-take de biopellet (take-or-pay, 110–130 €/t)', contraparte: 'Bioenergía Industrial del Ebro, S.A.',
      valor_cents: 52560000, valor_periodicidad: 'anual', riesgo_contraparte: 64, estado: 'borrador', responsable: 'Dirección Comercial',
      clausulas_clave: ['Precio indexado entre 110 y 130 €/t', 'Take-or-pay sobre 4.380 t/año', 'Humedad del biopellet: 7–8 %'],
      notas: 'Riesgo alto por concentración: un único comprador absorbe toda la producción de la planta.',
    }),
    contrato(vanguard, {
      tipo: 'licencia', titulo: 'Licencia inter-company de uso del Kernel y PAIA (revocación automática Pactvm Viridi)',
      contraparte: 'S-NFI Energy, S.L.U. y S-NFI Infra, S.L.U.', fecha_firma: d(-15), fecha_inicio: d(-14), fecha_vencimiento: d(1812),
      renovacion_automatica: true, preaviso_dias: 180, riesgo_contraparte: 8, estado: 'vigente', responsable: 'Dirección Jurídica',
      clausulas_clave: ['Canon a valor de mercado (art. 18 LIS, operaciones vinculadas)', 'Revocación automática por incumplimiento de Pactvm Viridi', 'Prohibición de sublicencia'],
    }),
    contrato(infra, {
      tipo: 'leasing', titulo: 'Arrendamiento financiero de la línea piloto BioHybrid (2 BioGrinder + 1 BioDeshidratador)',
      contraparte: 'Navarra Equipment Leasing, E.F.C., S.A.', valor_cents: 124000000, fecha_firma: d(-200), fecha_inicio: d(-190), fecha_vencimiento: d(1636),
      riesgo_contraparte: 22, estado: 'vigente', responsable: 'Dirección Financiera',
      clausulas_clave: ['Opción de compra al vencimiento', 'Seguro a todo riesgo a cargo del arrendatario', 'Cuotas mensuales indexadas al euríbor'],
    }),
    contrato(corp, {
      tipo: 'joint_venture', titulo: 'Joint Venture para la planta de Gipuzkoa (150 t/día)', contraparte: 'Bidasoa Circular Partners, S.L.',
      valor_cents: 21850000, valor_periodicidad: 'anual', riesgo_contraparte: 48, estado: 'negociacion', responsable: 'Dirección General',
      clausulas_clave: ['Royalties S-NFI: 175.000–262.000 €/año', 'Capacidad objetivo: 150 t/día de residuo, 12 t/día de biopellet', 'Gobierno paritario con veto sobre el Kernel'],
    }),
    contrato(corp, {
      tipo: 'servicios', titulo: `Auditoría de cuentas anuales individuales y consolidadas (ejercicios ${Y}–${Y + 2})`, contraparte: 'Arga Auditores, S.L.P.',
      valor_cents: 5400000, fecha_firma: d(-110), fecha_inicio: isoOf(Y, 1, 1), fecha_vencimiento: isoOf(Y + 2, 12, 31),
      riesgo_contraparte: 10, estado: 'vigente', responsable: 'Dirección Financiera',
      clausulas_clave: ['Nombramiento por tres ejercicios (art. 40 LAC)', 'Honorarios fijos sin componente contingente', 'Independencia: sin servicios distintos de la auditoría'],
    }),
    contrato(corp, {
      tipo: 'servicios', titulo: 'Asesoría tributaria y de cumplimiento (Hacienda Foral de Navarra y AEAT)', contraparte: 'Baztan Asesores Tributarios, S.L.',
      valor_cents: 3600000, valor_periodicidad: 'anual', fecha_firma: d(-655), fecha_inicio: d(-655), fecha_vencimiento: d(75),
      renovacion_automatica: true, preaviso_dias: 60, riesgo_contraparte: 15, estado: 'vigente', responsable: 'Dirección Financiera',
      clausulas_clave: ['Prórroga tácita anual salvo preaviso de 60 días', 'Responsabilidad limitada a los honorarios anuales'],
    }),
    contrato(infra, {
      tipo: 'financiacion', titulo: 'Préstamo de project finance · Tramo 2 (cuenta de servicio de la deuda pignorada)',
      contraparte: 'Entidad financiera acreditante (pendiente de confirmar)', valor_cents: 380000000, fecha_firma: d(-60), fecha_inicio: d(-60), fecha_vencimiento: d(3592),
      riesgo_contraparte: 30, estado: 'vigente', responsable: 'Dirección Financiera',
      clausulas_clave: ['Ratio de cobertura del servicio de la deuda mínimo de 1,30x (el modelo proyecta 6,36x)', 'Cascada de pagos con prioridad al servicio de la deuda', 'Pignoración de la cuenta de servicio de la deuda'],
    }),
    contrato(corp, {
      tipo: 'nda', titulo: 'Confidencialidad bilateral (NDA-B) · due diligence de inversor', contraparte: 'Fondo de inversión (data room, pendiente de confirmar)',
      fecha_firma: d(-65), fecha_inicio: d(-65), fecha_vencimiento: d(665), riesgo_contraparte: 35, estado: 'vigente', responsable: 'Dirección Jurídica',
      clausulas_clave: ['Vigencia de dos años desde la firma', 'Devolución o destrucción de la información al término', 'Prohibición de captación de personal'],
    }),
    contrato(energy, {
      tipo: 'suministro', titulo: 'Suministro eléctrico de la planta piloto', contraparte: 'Comercializadora eléctrica (pendiente de confirmar)',
      valor_cents: 1850000, valor_periodicidad: 'anual', fecha_firma: d(-344), fecha_inicio: d(-344), fecha_vencimiento: d(21),
      riesgo_contraparte: 18, estado: 'vigente', responsable: 'Dirección de Operaciones',
      clausulas_clave: ['Sin prórroga tácita', 'Precio indexado al mercado diario'],
    }),
  ];

  /* ---------------------------- Checklist NIA-ES ---------------------------- */
  const punto = (nia, titulo, requerimiento, offset, estado, responsable = 'Dirección Financiera') => ({
    ...base(), ejercicio: Y, nia, titulo, requerimiento, responsable, fecha_objetivo: d(offset), estado,
    completado_por: estado === 'completado' ? 'system' : null, completado_at: estado === 'completado' ? now : null,
  });
  const checklist = [
    punto('NIA-ES 210', 'Acuerdo de los términos del encargo de auditoría', 'Carta de encargo firmada por el órgano de administración, con alcance individual y consolidado.', -60, 'completado'),
    punto('NIA-ES 300', 'Planificación de la auditoría de estados financieros', 'Calendario de trabajo, interlocutores y fechas de cierre acordados con la firma auditora.', -30, 'completado'),
    punto('NIA-ES 315', 'Identificación y valoración de los riesgos de incorrección material', 'Narrativas de procesos (ventas, compras, tesorería, nóminas) y matriz de controles internos.', 10, 'en_curso'),
    punto('NIA-ES 320', 'Importancia relativa o materialidad en la planificación y ejecución de la auditoría', 'Presupuesto del ejercicio y cierres trimestrales para fijar la materialidad.', 10, 'en_curso'),
    punto('NIA-ES 260', 'Comunicación con los responsables del gobierno de la entidad', 'Calendario de reuniones con el órgano de administración para comunicar hallazgos.', 25, 'pendiente', 'Dirección General'),
    punto('NIA-ES 550', 'Partes vinculadas', 'Relación de partes vinculadas y operaciones intra-grupo: licencia del Kernel y PAIA (art. 18 LIS).', 30, 'pendiente', 'Dirección Jurídica'),
    punto('NIA-ES 505', 'Confirmaciones externas', 'Cartas de confirmación a bancos, abogados, clientes y proveedores significativos.', 80, 'pendiente'),
    punto('NIA-ES 540', 'Auditoría de estimaciones contables y de la correspondiente información a revelar', 'Hipótesis de vida útil y deterioro de las plantas BioHybrid y de los activos intangibles.', 110, 'pendiente'),
    punto('NIA-ES 600', 'Auditorías de estados financieros de grupos (incluido el trabajo de los auditores de los componentes)', 'Paquetes de reporte de S-NFI Vanguard, S-NFI Energy y S-NFI Infra para la consolidación.', 120, 'pendiente'),
    punto('NIA-ES 570', 'Empresa en funcionamiento', 'Plan de tesorería a doce meses y financiación comprometida (Tramo 2).', 130, 'pendiente', 'Dirección General'),
    punto('NIA-ES 560', 'Hechos posteriores al cierre', 'Relación de hechos posteriores al cierre hasta la fecha del informe.', 150, 'pendiente', 'Dirección Jurídica'),
    punto('NIA-ES 580', 'Manifestaciones escritas', 'Carta de manifestaciones de la Dirección firmada en la fecha del informe.', 160, 'pendiente', 'Dirección General'),
  ];

  return { sociedades, modelos, notificaciones, juntas, apoderamientos, contratos, checklist };
}
