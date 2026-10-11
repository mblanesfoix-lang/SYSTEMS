/**
 * S-NFI F&L · catalogos, esquemas de entidad y validacion del Hub fiscal y legal.
 *
 * Fuente unica de verdad de los campos de cada entidad: el backend valida con
 * estos esquemas y el frontend construye sus formularios a partir de ellos
 * (GET /api/fl/hub los devuelve en meta.esquemas). Anadir un campo aqui lo
 * hace aparecer en el formulario y lo deja pasar por la validacion.
 *
 * NORMAS: indice curado de normativa real. Cada identificador BOE-A y cada
 * titulo de articulo se verifico contra el texto consolidado de boe.es
 * (2026-10-12); no se listan consultas de la DGT concretas para no citar
 * doctrina que no se haya leido: el modulo de consulta enlaza al buscador
 * oficial (petete.tributos.hacienda.gob.es).
 */

import { isIsoDate } from './fl-hub-fechas.js';

export const ADMINISTRACIONES = [
  { v: 'AEAT', l: 'Agencia Tributaria (AEAT)' },
  { v: 'HFN', l: 'Hacienda Foral de Navarra' },
  { v: 'DFG', l: 'Diputación Foral de Gipuzkoa' },
  { v: 'DFB', l: 'Diputación Foral de Bizkaia' },
  { v: 'DFA', l: 'Diputación Foral de Álava' },
];

const opts = (pairs) => pairs.map(([v, l]) => ({ v, l }));

export const ESTADOS_MODELO = opts([['pendiente', 'Pendiente'], ['en_auditoria', 'En auditoría'], ['liquidado', 'Liquidado']]);
export const ESTADOS_NOTIFICACION = opts([['pendiente', 'Pendiente'], ['asignada', 'Asignada a abogado'], ['respondida', 'Respondida'], ['archivada', 'Archivada']]);

/* Transiciones del flujo de una notificacion oficial. Archivar se permite
   desde cualquier estado abierto (p. ej. comunicaciones sin respuesta). */
export const TRANSICIONES_NOTIFICACION = {
  pendiente: ['asignada', 'archivada'],
  asignada: ['pendiente', 'respondida', 'archivada'],
  respondida: ['archivada'],
  archivada: [],
};

export const ESQUEMAS = {
  sociedades: {
    col: 'fl_sociedades',
    label: 'Sociedad del grupo',
    orden: { nombre_corto: 1 },
    campos: [
      { key: 'nombre_corto', label: 'Nombre corto', tipo: 'str', max: 60, requerido: true },
      { key: 'denominacion', label: 'Denominación social', tipo: 'str', max: 160, requerido: true, ayuda: 'Tal y como figura en el Registro Mercantil: se vigila en el BORME.' },
      { key: 'nif', label: 'NIF', tipo: 'nif' },
      { key: 'forma', label: 'Forma jurídica', tipo: 'enum', opciones: opts([['S.L.', 'S.L.'], ['S.L.U.', 'S.L.U.'], ['S.A.', 'S.A.'], ['S.A.U.', 'S.A.U.'], ['S.L.P.', 'S.L.P.'], ['otra', 'Otra']]) },
      { key: 'rol', label: 'Rol en el grupo', tipo: 'enum', requerido: true, defecto: 'filial', opciones: opts([['holding', 'Sociedad dominante'], ['filial', 'Filial'], ['spv', 'SPV / vehículo de proyecto']]) },
      { key: 'estado', label: 'Estado', tipo: 'enum', requerido: true, defecto: 'activa', opciones: opts([['activa', 'Activa'], ['en_constitucion', 'En constitución'], ['en_liquidacion', 'En liquidación'], ['inactiva', 'Inactiva']]) },
      { key: 'administracion', label: 'Administración tributaria', tipo: 'enum', requerido: true, defecto: 'AEAT', opciones: ADMINISTRACIONES },
      { key: 'domicilio', label: 'Domicilio social', tipo: 'str', max: 200 },
      { key: 'registro_mercantil', label: 'Registro Mercantil', tipo: 'str', max: 120 },
      { key: 'datos_registrales', label: 'Datos registrales', tipo: 'str', max: 160, ayuda: 'Tomo, folio y hoja.' },
      { key: 'fecha_constitucion', label: 'Fecha de constitución', tipo: 'date' },
      { key: 'capital_social_cents', label: 'Capital social', tipo: 'cents' },
      { key: 'participacion_pct', label: 'Participación del grupo (%)', tipo: 'pct' },
      { key: 'organo_administracion', label: 'Órgano de administración', tipo: 'enum', opciones: opts([['administrador_unico', 'Administrador único'], ['solidarios', 'Administradores solidarios'], ['mancomunados', 'Administradores mancomunados'], ['consejo', 'Consejo de administración']]) },
      { key: 'administradores', label: 'Administradores', tipo: 'text', max: 400 },
      { key: 'socio_unico', label: 'Socio único', tipo: 'str', max: 160 },
      { key: 'objeto_social', label: 'Objeto social', tipo: 'text', max: 800 },
      { key: 'borme_alias', label: 'Otras denominaciones a vigilar en BORME', tipo: 'list', maxItems: 5, max: 160, ayuda: 'Una por línea (denominaciones anteriores o abreviadas).' },
    ],
  },

  modelos: {
    col: 'fl_modelos',
    label: 'Modelo tributario',
    orden: { fecha_limite: 1 },
    campos: [
      { key: 'sociedad_id', label: 'Sociedad', tipo: 'ref', requerido: true },
      { key: 'administracion', label: 'Administración', tipo: 'enum', requerido: true, defecto: 'AEAT', opciones: ADMINISTRACIONES },
      { key: 'modelo', label: 'Modelo', tipo: 'str', max: 12, requerido: true, ayuda: 'Por ejemplo 303, 200, 347, S-90 o F-69.' },
      { key: 'concepto', label: 'Concepto', tipo: 'str', max: 160, requerido: true },
      { key: 'periodo', label: 'Periodo', tipo: 'str', max: 20, requerido: true, ayuda: '1T…4T, 1P…3P, mes o Anual.' },
      { key: 'ejercicio', label: 'Ejercicio', tipo: 'int', min: 2000, max: 2100, requerido: true },
      { key: 'fecha_limite', label: 'Fecha límite', tipo: 'date', requerido: true },
      { key: 'estado', label: 'Estado', tipo: 'enum', requerido: true, defecto: 'pendiente', opciones: ESTADOS_MODELO },
      { key: 'resultado', label: 'Resultado', tipo: 'enum', opciones: opts([['a_ingresar', 'A ingresar'], ['a_devolver', 'A devolver'], ['a_compensar', 'A compensar'], ['sin_actividad', 'Sin actividad'], ['informativa', 'Informativa']]) },
      { key: 'importe_cents', label: 'Importe', tipo: 'cents' },
      { key: 'presentado_at', label: 'Fecha de presentación', tipo: 'date' },
      { key: 'justificante', label: 'Nº de justificante / CSV', tipo: 'str', max: 60 },
      { key: 'responsable', label: 'Responsable', tipo: 'str', max: 120 },
      { key: 'notas', label: 'Notas', tipo: 'text', max: 1000 },
    ],
  },

  notificaciones: {
    col: 'fl_notificaciones',
    label: 'Notificación oficial',
    orden: { puesta_disposicion: -1 },
    campos: [
      { key: 'sociedad_id', label: 'Receptor', tipo: 'ref', requerido: true },
      { key: 'emisor', label: 'Organismo emisor', tipo: 'str', max: 160, requerido: true },
      { key: 'emisor_siglas', label: 'Siglas', tipo: 'str', max: 16 },
      { key: 'canal', label: 'Canal', tipo: 'enum', requerido: true, defecto: 'dehu', opciones: opts([['dehu', 'DEHú'], ['sede_aeat', 'Sede electrónica AEAT'], ['sede_tgss', 'Sede electrónica TGSS'], ['sede_navarra', 'Sede Gobierno de Navarra'], ['otro', 'Otro canal']]) },
      { key: 'tipo', label: 'Tipo de acto', tipo: 'enum', requerido: true, defecto: 'comunicacion', opciones: opts([['requerimiento', 'Requerimiento'], ['propuesta_liquidacion', 'Propuesta de liquidación'], ['inicio_procedimiento', 'Inicio de procedimiento'], ['tramite_audiencia', 'Trámite de audiencia'], ['resolucion', 'Resolución'], ['subvencion', 'Subvención / ayuda'], ['sancion', 'Expediente sancionador'], ['comunicacion', 'Comunicación']]) },
      { key: 'expediente', label: 'Expediente', tipo: 'str', max: 80, requerido: true },
      { key: 'asunto', label: 'Asunto', tipo: 'str', max: 240, requerido: true },
      { key: 'resumen', label: 'Resumen', tipo: 'text', max: 1500 },
      { key: 'puesta_disposicion', label: 'Puesta a disposición', tipo: 'date', requerido: true, ayuda: 'Desde esta fecha corren los 10 días naturales para acceder (art. 43.2 Ley 39/2015).' },
      { key: 'plazo_respuesta', label: 'Plazo de respuesta', tipo: 'int', min: 0, max: 365, ayuda: '0 si el acto no exige respuesta.' },
      { key: 'plazo_tipo', label: 'Unidad del plazo', tipo: 'enum', defecto: 'habiles', opciones: opts([['habiles', 'Días hábiles'], ['naturales', 'Días naturales'], ['meses', 'Meses']]) },
      { key: 'fecha_limite_respuesta', label: 'Fecha límite de respuesta', tipo: 'date', ayuda: 'Se calcula al registrar el acuse; rellenar solo para corregirla.' },
      { key: 'prioridad', label: 'Prioridad', tipo: 'enum', defecto: 'media', opciones: opts([['critica', 'Crítica'], ['alta', 'Alta'], ['media', 'Media'], ['baja', 'Baja']]) },
      { key: 'importe_cents', label: 'Importe en juego', tipo: 'cents' },
      { key: 'abogado_asignado', label: 'Abogado asignado', tipo: 'str', max: 120 },
    ],
  },

  juntas: {
    col: 'fl_juntas',
    label: 'Junta o reunión',
    orden: { fecha: -1 },
    campos: [
      { key: 'sociedad_id', label: 'Sociedad', tipo: 'ref', requerido: true },
      { key: 'organo', label: 'Órgano', tipo: 'enum', requerido: true, defecto: 'junta_general', opciones: opts([['junta_general', 'Junta General'], ['consejo', 'Consejo de Administración'], ['socio_unico', 'Decisiones del socio único'], ['administrador', 'Decisión del órgano de administración']]) },
      { key: 'caracter', label: 'Carácter', tipo: 'enum', defecto: 'ordinaria', opciones: opts([['ordinaria', 'Ordinaria'], ['extraordinaria', 'Extraordinaria'], ['universal', 'Universal']]) },
      { key: 'fecha', label: 'Fecha', tipo: 'date', requerido: true },
      { key: 'hora', label: 'Hora', tipo: 'time' },
      { key: 'lugar', label: 'Lugar', tipo: 'str', max: 160 },
      { key: 'estado', label: 'Estado', tipo: 'enum', requerido: true, defecto: 'convocada', opciones: opts([['convocada', 'Convocada'], ['celebrada', 'Celebrada'], ['acta_firmada', 'Acta firmada'], ['formalizada', 'Formalizada (RM)']]) },
      { key: 'orden_del_dia', label: 'Orden del día', tipo: 'list', maxItems: 20, max: 240, ayuda: 'Un punto por línea.' },
      { key: 'acuerdos', label: 'Acuerdos adoptados', tipo: 'list', maxItems: 30, max: 400, ayuda: 'Un acuerdo por línea.' },
      { key: 'aprueba_cuentas', label: 'Aprueba cuentas anuales', tipo: 'bool', ayuda: 'Activa el plazo de depósito en el Registro Mercantil (art. 279 LSC).' },
      { key: 'ejercicio_cuentas', label: 'Ejercicio de las cuentas', tipo: 'int', min: 2000, max: 2100 },
      { key: 'inscribible', label: 'Acuerdos inscribibles en el RM', tipo: 'bool' },
      { key: 'acta_ref', label: 'Referencia del acta', tipo: 'str', max: 80 },
      { key: 'notario', label: 'Notario', tipo: 'str', max: 120 },
    ],
  },

  apoderamientos: {
    col: 'fl_apoderamientos',
    label: 'Apoderamiento',
    orden: { apoderado: 1 },
    campos: [
      { key: 'sociedad_id', label: 'Sociedad poderdante', tipo: 'ref', requerido: true },
      { key: 'apoderado', label: 'Apoderado', tipo: 'str', max: 160, requerido: true },
      { key: 'cargo', label: 'Cargo', tipo: 'str', max: 120 },
      { key: 'tipo', label: 'Tipo de poder', tipo: 'enum', requerido: true, defecto: 'especial', opciones: opts([['general', 'General'], ['especial', 'Especial'], ['pleitos', 'Para pleitos'], ['bancario', 'Bancario']]) },
      { key: 'regimen', label: 'Régimen de actuación', tipo: 'enum', requerido: true, defecto: 'solidario', opciones: opts([['solidario', 'Solidario'], ['mancomunado', 'Mancomunado']]) },
      { key: 'mancomunado_con', label: 'Mancomunado con', tipo: 'str', max: 160 },
      { key: 'facultades', label: 'Facultades', tipo: 'list', maxItems: 12, max: 160, ayuda: 'Una por línea.' },
      { key: 'limite_cents', label: 'Límite cuantitativo de firma', tipo: 'cents', ayuda: 'Vacío = sin límite.' },
      { key: 'notario', label: 'Notario autorizante', tipo: 'str', max: 160 },
      { key: 'protocolo', label: 'Nº de protocolo', tipo: 'str', max: 40 },
      { key: 'fecha_otorgamiento', label: 'Fecha de otorgamiento', tipo: 'date' },
      { key: 'fecha_caducidad', label: 'Fecha de caducidad', tipo: 'date', ayuda: 'Vacío = indefinido.' },
      { key: 'inscrito_rm', label: 'Inscrito en el Registro Mercantil', tipo: 'bool' },
      { key: 'estado', label: 'Estado', tipo: 'enum', requerido: true, defecto: 'vigente', opciones: opts([['vigente', 'Vigente'], ['revocado', 'Revocado']]) },
    ],
  },

  contratos: {
    col: 'fl_clm_contratos',
    label: 'Contrato',
    orden: { fecha_vencimiento: 1 },
    campos: [
      { key: 'sociedad_id', label: 'Sociedad', tipo: 'ref', requerido: true },
      { key: 'tipo', label: 'Tipo', tipo: 'enum', requerido: true, defecto: 'servicios', opciones: opts([['ppa', 'PPA'], ['offtake', 'Off-take'], ['leasing', 'Leasing'], ['joint_venture', 'Joint Venture'], ['servicios', 'Servicios'], ['licencia', 'Licencia'], ['financiacion', 'Financiación'], ['suministro', 'Suministro'], ['nda', 'Confidencialidad (NDA)']]) },
      { key: 'titulo', label: 'Título', tipo: 'str', max: 200, requerido: true },
      { key: 'contraparte', label: 'Contraparte', tipo: 'str', max: 160, requerido: true },
      { key: 'contraparte_nif', label: 'NIF contraparte', tipo: 'nif' },
      { key: 'valor_cents', label: 'Valor', tipo: 'cents' },
      { key: 'valor_periodicidad', label: 'Periodicidad del valor', tipo: 'enum', defecto: 'total', opciones: opts([['total', 'Total'], ['anual', 'Anual'], ['mensual', 'Mensual']]) },
      { key: 'fecha_firma', label: 'Fecha de firma', tipo: 'date' },
      { key: 'fecha_inicio', label: 'Inicio de vigencia', tipo: 'date' },
      { key: 'fecha_vencimiento', label: 'Vencimiento', tipo: 'date' },
      { key: 'renovacion_automatica', label: 'Renovación automática', tipo: 'bool' },
      { key: 'preaviso_dias', label: 'Preaviso de no renovación (días)', tipo: 'int', min: 0, max: 730 },
      { key: 'riesgo_contraparte', label: 'Riesgo de contraparte (0-100)', tipo: 'int', min: 0, max: 100 },
      { key: 'estado', label: 'Estado', tipo: 'enum', requerido: true, defecto: 'borrador', opciones: opts([['borrador', 'Borrador'], ['negociacion', 'En negociación'], ['vigente', 'Vigente'], ['vencido', 'Vencido'], ['rescindido', 'Rescindido']]) },
      { key: 'ley_aplicable', label: 'Ley aplicable', tipo: 'str', max: 80 },
      { key: 'jurisdiccion', label: 'Jurisdicción / arbitraje', tipo: 'str', max: 120 },
      { key: 'clausulas_clave', label: 'Cláusulas clave', tipo: 'list', maxItems: 12, max: 240, ayuda: 'Una por línea.' },
      { key: 'responsable', label: 'Responsable', tipo: 'str', max: 120 },
      { key: 'notas', label: 'Notas', tipo: 'text', max: 1500 },
    ],
  },

  checklist: {
    col: 'fl_nia_checklist',
    label: 'Punto de auditoría (NIA-ES)',
    orden: { fecha_objetivo: 1 },
    campos: [
      { key: 'ejercicio', label: 'Ejercicio auditado', tipo: 'int', min: 2000, max: 2100, requerido: true },
      { key: 'nia', label: 'NIA-ES', tipo: 'str', max: 20, requerido: true },
      { key: 'titulo', label: 'Título', tipo: 'str', max: 200, requerido: true },
      { key: 'requerimiento', label: 'Qué aporta S-NFI', tipo: 'text', max: 800 },
      { key: 'responsable', label: 'Responsable', tipo: 'str', max: 120 },
      { key: 'fecha_objetivo', label: 'Fecha objetivo', tipo: 'date' },
      { key: 'estado', label: 'Estado', tipo: 'enum', requerido: true, defecto: 'pendiente', opciones: opts([['pendiente', 'Pendiente'], ['en_curso', 'En curso'], ['completado', 'Completado'], ['no_aplica', 'No aplica']]) },
    ],
  },
};

export const ENTIDADES = Object.keys(ESQUEMAS);

/* Patron de ruta Express para las entidades genericas (no captura 'expediente',
   'hub', 'summary' ni el resto de rutas propias de la mesa). */
export const ENTIDAD_ROUTE = `:entidad(${ENTIDADES.join('|')})`;

const MAX_CENTS = 10_000_000_000_000; // 100.000 millones de euros
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function normalizeNif(raw) {
  return String(raw).toUpperCase().replace(/[\s.-]/g, '');
}

/**
 * Valida y normaliza un cuerpo de peticion contra el esquema de una entidad.
 * partial=true (PATCH): solo se tocan los campos presentes en el cuerpo.
 * Devuelve { value, errors }: value solo trae claves del esquema (lista
 * blanca), con '' convertido a null en los campos opcionales.
 */
export function validarEntidad(esquema, body, { partial = false } = {}) {
  const value = {};
  const errors = [];
  const src = body && typeof body === 'object' ? body : {};

  for (const campo of esquema.campos) {
    const present = Object.prototype.hasOwnProperty.call(src, campo.key);
    if (!present) {
      if (!partial) {
        if (campo.defecto !== undefined) value[campo.key] = campo.defecto;
        else if (campo.requerido) errors.push(`${campo.label}: obligatorio`);
      }
      continue;
    }

    const raw = src[campo.key];
    const empty = raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '');
    if (empty) {
      if (campo.requerido) errors.push(`${campo.label}: obligatorio`);
      else value[campo.key] = campo.tipo === 'list' ? [] : campo.tipo === 'bool' ? false : null;
      continue;
    }

    switch (campo.tipo) {
      case 'str':
      case 'text': {
        if (typeof raw !== 'string') { errors.push(`${campo.label}: debe ser texto`); break; }
        const s = raw.trim();
        if (s.length > campo.max) { errors.push(`${campo.label}: máximo ${campo.max} caracteres`); break; }
        value[campo.key] = s;
        break;
      }
      case 'nif': {
        const s = normalizeNif(raw);
        if (!/^[A-Z0-9]{8,10}$/.test(s)) { errors.push(`${campo.label}: formato no válido`); break; }
        value[campo.key] = s;
        break;
      }
      case 'enum': {
        if (!campo.opciones.some((o) => o.v === raw)) { errors.push(`${campo.label}: valor no permitido`); break; }
        value[campo.key] = raw;
        break;
      }
      case 'date': {
        if (!isIsoDate(raw)) { errors.push(`${campo.label}: fecha no válida (AAAA-MM-DD)`); break; }
        value[campo.key] = raw;
        break;
      }
      case 'time': {
        if (typeof raw !== 'string' || !TIME_RE.test(raw)) { errors.push(`${campo.label}: hora no válida (HH:MM)`); break; }
        value[campo.key] = raw;
        break;
      }
      case 'int': {
        const n = typeof raw === 'string' ? Number(raw) : raw;
        if (!Number.isInteger(n) || n < campo.min || n > campo.max) { errors.push(`${campo.label}: entero entre ${campo.min} y ${campo.max}`); break; }
        value[campo.key] = n;
        break;
      }
      case 'cents': {
        const n = typeof raw === 'string' ? Number(raw) : raw;
        if (!Number.isInteger(n) || n < 0 || n > MAX_CENTS) { errors.push(`${campo.label}: importe no válido`); break; }
        value[campo.key] = n;
        break;
      }
      case 'pct': {
        const n = typeof raw === 'string' ? Number(raw) : raw;
        if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 100) { errors.push(`${campo.label}: porcentaje entre 0 y 100`); break; }
        value[campo.key] = Math.round(n * 100) / 100;
        break;
      }
      case 'bool': {
        if (typeof raw !== 'boolean') { errors.push(`${campo.label}: debe ser verdadero o falso`); break; }
        value[campo.key] = raw;
        break;
      }
      case 'list': {
        const arr = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split('\n') : null;
        if (!arr || arr.some((x) => typeof x !== 'string')) { errors.push(`${campo.label}: lista de textos`); break; }
        const items = arr.map((x) => x.trim()).filter(Boolean);
        if (items.length > campo.maxItems) { errors.push(`${campo.label}: máximo ${campo.maxItems} elementos`); break; }
        if (items.some((x) => x.length > campo.max)) { errors.push(`${campo.label}: máximo ${campo.max} caracteres por elemento`); break; }
        value[campo.key] = items;
        break;
      }
      case 'ref': {
        if (typeof raw !== 'string' || raw.length > 64) { errors.push(`${campo.label}: referencia no válida`); break; }
        value[campo.key] = raw;
        break;
      }
      default:
        errors.push(`${campo.label}: tipo desconocido`);
    }
  }

  return { value, errors };
}

/* Proyeccion publica del esquema para el frontend (sin nombre de coleccion). */
export function esquemasPublicos() {
  return Object.fromEntries(ENTIDADES.map((k) => [k, { label: ESQUEMAS[k].label, campos: ESQUEMAS[k].campos }]));
}

const boeUrl = (id, art) => `https://www.boe.es/buscar/act.php?id=${id}${art ? `#a${art}` : ''}`;

export const NORMAS = [
  {
    id: 'BOE-A-2003-23186', ref: 'Ley 58/2003 (LGT)', ambito: 'fiscal',
    titulo: 'Ley 58/2003, de 17 de diciembre, General Tributaria',
    articulos: [
      { art: '66', tema: 'Plazos de prescripción' },
      { art: '88', tema: 'Consultas tributarias escritas' },
      { art: '89', tema: 'Efectos de las contestaciones a consultas tributarias escritas' },
      { art: '93', tema: 'Obligaciones de información' },
    ],
  },
  {
    id: 'BOE-A-2014-12328', ref: 'Ley 27/2014 (LIS)', ambito: 'fiscal',
    titulo: 'Ley 27/2014, de 27 de noviembre, del Impuesto sobre Sociedades',
    articulos: [
      { art: '18', tema: 'Operaciones vinculadas' },
      { art: '23', tema: 'Reducción de las rentas procedentes de determinados activos intangibles' },
      { art: '35', tema: 'Deducción por actividades de investigación y desarrollo e innovación tecnológica' },
      { art: '76', tema: 'Régimen especial FEAC: definiciones (arts. 76 a 89)' },
      { art: '89', tema: 'Régimen especial FEAC: aplicación del régimen fiscal' },
    ],
  },
  {
    id: 'BOE-A-1992-28740', ref: 'Ley 37/1992 (LIVA)', ambito: 'fiscal',
    titulo: 'Ley 37/1992, de 28 de diciembre, del Impuesto sobre el Valor Añadido',
    articulos: [
      { art: '84', tema: 'Sujetos pasivos' },
      { art: '164', tema: 'Obligaciones de los sujetos pasivos' },
    ],
  },
  {
    id: 'BOE-A-2007-15984', ref: 'RD 1065/2007 (RGAT)', ambito: 'fiscal',
    titulo: 'Real Decreto 1065/2007, de 27 de julio, Reglamento General de las actuaciones y los procedimientos de gestión e inspección tributaria',
    articulos: [],
  },
  {
    id: null, ref: 'LF 26/2016 (IS Navarra)', ambito: 'fiscal', fuente: 'BON de 31 de diciembre de 2016',
    titulo: 'Ley Foral 26/2016, de 28 de diciembre, del Impuesto sobre Sociedades',
    articulos: [],
  },
  {
    id: 'BOE-A-2015-10565', ref: 'Ley 39/2015 (LPACAP)', ambito: 'administrativo',
    titulo: 'Ley 39/2015, de 1 de octubre, del Procedimiento Administrativo Común de las Administraciones Públicas',
    articulos: [
      { art: '30', tema: 'Cómputo de plazos' },
      { art: '43', tema: 'Práctica de las notificaciones a través de medios electrónicos (rechazo a los diez días naturales)' },
    ],
  },
  {
    id: 'BOE-A-2021-5032', ref: 'RD 203/2021', ambito: 'administrativo',
    titulo: 'Real Decreto 203/2021, de 30 de marzo, Reglamento de actuación y funcionamiento del sector público por medios electrónicos',
    articulos: [],
  },
  {
    id: 'BOE-A-2010-10544', ref: 'RDLeg 1/2010 (LSC)', ambito: 'mercantil',
    titulo: 'Real Decreto Legislativo 1/2010, de 2 de julio, texto refundido de la Ley de Sociedades de Capital',
    articulos: [
      { art: '164', tema: 'Junta ordinaria' },
      { art: '253', tema: 'Formulación de las cuentas anuales' },
      { art: '263', tema: 'Auditor de cuentas' },
      { art: '279', tema: 'Depósito de las cuentas' },
    ],
  },
  {
    id: 'BOE-A-1996-17533', ref: 'RD 1784/1996 (RRM)', ambito: 'mercantil',
    titulo: 'Real Decreto 1784/1996, de 19 de julio, Reglamento del Registro Mercantil',
    articulos: [],
  },
  {
    id: 'BOE-A-2015-8147', ref: 'Ley 22/2015 (LAC)', ambito: 'auditoria',
    titulo: 'Ley 22/2015, de 20 de julio, de Auditoría de Cuentas',
    articulos: [
      { art: '40', tema: 'Contratación, rotación y designación de auditores de cuentas o sociedades de auditoría' },
    ],
  },
  {
    id: 'BOE-A-2013-13645', ref: 'Ley 24/2013 (LSE)', ambito: 'energia',
    titulo: 'Ley 24/2013, de 26 de diciembre, del Sector Eléctrico',
    articulos: [],
  },
  {
    id: 'BOE-A-2019-5089', ref: 'RD 244/2019 (autoconsumo)', ambito: 'energia',
    titulo: 'Real Decreto 244/2019, de 5 de abril, condiciones administrativas, técnicas y económicas del autoconsumo de energía eléctrica',
    articulos: [],
  },
  {
    id: 'BOE-A-2022-5809', ref: 'Ley 7/2022 (residuos)', ambito: 'residuos',
    titulo: 'Ley 7/2022, de 8 de abril, de residuos y suelos contaminados para una economía circular',
    articulos: [],
  },
].map((n) => ({
  ...n,
  url: n.id ? boeUrl(n.id) : null,
  articulos: n.articulos.map((a) => ({ ...a, url: n.id ? boeUrl(n.id, a.art) : null })),
}));

/* Portales oficiales enlazados desde la mesa (comprobados 2026-10-12). */
export const PORTALES = [
  { key: 'dehu', label: 'DEHú · Dirección Electrónica Habilitada única', url: 'https://dehu.redsara.es/' },
  { key: 'aeat', label: 'Sede electrónica de la AEAT', url: 'https://sede.agenciatributaria.gob.es/' },
  { key: 'tgss', label: 'Sede electrónica de la Seguridad Social', url: 'https://sede.seg-social.gob.es/' },
  { key: 'hfn', label: 'Hacienda Foral de Navarra', url: 'https://www.navarra.es/es/hacienda' },
  { key: 'borme', label: 'BORME · último boletín', url: 'https://www.boe.es/diario_borme/' },
  { key: 'dgt', label: 'Consultas de la Dirección General de Tributos', url: 'https://petete.tributos.hacienda.gob.es/consultas/' },
];

export const DGT_CONSULTA_URL = 'https://petete.tributos.hacienda.gob.es/consultas/';
