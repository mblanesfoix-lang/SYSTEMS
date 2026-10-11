/**
 * S-NFI F&L · logica pura del Hub fiscal y legal: formato, calendario,
 * filtros, cuentas atras y buscador del command bar. Sin DOM ni red, para
 * poder testearla desde app/backend/test (mismo criterio que
 * machine-telemetry.js). Los plazos legales los calcula el backend; aqui solo
 * se presentan.
 */

export const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
export const MESES_CORTOS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
export const DIAS_SEMANA = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];

const DAY_MS = 86400000;

function partes(iso) {
  return [Number(iso.slice(0, 4)), Number(iso.slice(5, 7)), Number(iso.slice(8, 10))];
}

export function esIso(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

export function isoDeFecha(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDias(iso, n) {
  const [y, m, d] = partes(iso);
  return new Date(Date.UTC(y, m - 1, d) + n * DAY_MS).toISOString().slice(0, 10);
}

export function diffDias(a, b) {
  const [ya, ma, da] = partes(a);
  const [yb, mb, db] = partes(b);
  return Math.round((Date.UTC(yb, mb - 1, db) - Date.UTC(ya, ma - 1, da)) / DAY_MS);
}

/** '12 oct 2026' (corta: '12 oct'; numerica: '12/10/2026'). */
export function fmtFecha(iso, { corta = false, numerica = false } = {}) {
  if (!esIso(iso)) return '—';
  const [y, m, d] = partes(iso);
  if (numerica) return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;
  return corta ? `${d} ${MESES_CORTOS[m - 1]}` : `${d} ${MESES_CORTOS[m - 1]} ${y}`;
}

export function fmtFechaLarga(iso) {
  if (!esIso(iso)) return '—';
  const [y, m, d] = partes(iso);
  const dow = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${dow} ${d} de ${MESES[m - 1]} de ${y}`;
}

export function fmtRelDias(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '';
  if (n === 0) return 'hoy';
  if (n === 1) return 'mañana';
  if (n === -1) return 'ayer';
  return n > 0 ? `en ${n} días` : `hace ${-n} días`;
}

const EUR = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' });
const EUR0 = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });

/** Importe en centimos a texto. compacto: '1,24 M€' / '525.600 €'. */
export function fmtEur(cents, { compacto = false } = {}) {
  if (!Number.isInteger(cents)) return '—';
  const eur = cents / 100;
  if (compacto && Math.abs(eur) >= 1e6) {
    return `${(eur / 1e6).toLocaleString('es-ES', { maximumFractionDigits: 2 })} M€`;
  }
  return compacto ? EUR0.format(eur) : EUR.format(eur);
}

/** '1.234,56' o '1234.56' -> 123456 centimos; null si vacio; NaN si no es numero. */
export function parseEurACents(texto) {
  if (texto === null || texto === undefined) return null;
  const s = String(texto).trim().replace(/\s|€/g, '');
  if (!s) return null;
  const normal = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s;
  if (!/^-?\d+(\.\d{1,2})?$/.test(normal)) return NaN;
  return Math.round(Number(normal) * 100);
}

export function centsAEurTexto(cents) {
  if (!Number.isInteger(cents)) return '';
  return (cents / 100).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false });
}

/** Fin del dia civil `iso` en la zona horaria del navegador (ms epoch). */
export function finDeDiaMs(iso) {
  const [y, m, d] = partes(iso);
  return new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
}

/** Cuenta atras legible: '2d 14h 05m', '5h 12m 09s', 'vencido'. */
export function fmtCuentaAtras(ms) {
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return 'vencido';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p2 = (n) => String(n).padStart(2, '0');
  if (d > 0) return `${d}d ${p2(h)}h ${p2(m)}m`;
  return `${h}h ${p2(m)}m ${p2(sec)}s`;
}

/** Severidad de una cuenta atras: 'bad' < 72 h, 'warn' < 5 dias. */
export function severidadPlazo(ms) {
  if (!Number.isFinite(ms) || ms <= 72 * 3600 * 1000) return 'bad';
  if (ms <= 5 * DAY_MS) return 'warn';
  return 'ok';
}

/** 42 dias (6 semanas, lunes primero) que cubren el mes `month` (0-11) de `year`. */
export function mesGrid(year, month) {
  const primero = new Date(Date.UTC(year, month, 1));
  const offset = (primero.getUTCDay() + 6) % 7;
  const inicio = Date.UTC(year, month, 1) - offset * DAY_MS;
  return Array.from({ length: 42 }, (_, i) => new Date(inicio + i * DAY_MS).toISOString().slice(0, 10));
}

export function esFinDeSemana(iso) {
  const [y, m, d] = partes(iso);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow === 0 || dow === 6;
}

/**
 * Eventos del calendario filtrados y agrupados por dia.
 * estado: 'todos' | 'pendientes' (pendiente + vencido) | 'vencidos' | 'completados'.
 */
export function agruparEventos(eventos, { tipos, estado = 'todos' } = {}) {
  const pasaEstado = (e) => {
    if (estado === 'pendientes') return e.estado === 'pendiente' || e.estado === 'vencido';
    if (estado === 'vencidos') return e.estado === 'vencido';
    if (estado === 'completados') return e.estado === 'completado';
    return true;
  };
  const mapa = new Map();
  for (const e of eventos) {
    if (tipos && !tipos.has(e.tipo)) continue;
    if (!pasaEstado(e)) continue;
    if (!mapa.has(e.fecha)) mapa.set(e.fecha, []);
    mapa.get(e.fecha).push(e);
  }
  const peso = { vencido: 0, pendiente: 1, informativo: 2, completado: 3 };
  for (const lista of mapa.values()) lista.sort((a, b) => (peso[a.estado] ?? 9) - (peso[b.estado] ?? 9));
  return mapa;
}

export function normalizar(texto) {
  return String(texto ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * Indice del command bar: una entrada por registro del Hub con su texto de
 * busqueda (NIF, referencias BOE, numeros de modelo, expedientes...).
 */
export function construirIndice(data) {
  if (!data) return [];
  const soc = new Map((data.sociedades || []).map((s) => [s.id, s]));
  const nombre = (id) => soc.get(id)?.nombre_corto ?? '';
  const out = [];
  const add = (e) => out.push({ ...e, clave: normalizar([e.titulo, e.sub, ...(e.extra || [])].join(' ')) });

  for (const s of data.sociedades || []) {
    add({ grupo: 'Sociedades', entidad: 'sociedades', id: s.id, tab: 'corporativo', codigo: s.nif || s.forma, titulo: s.denominacion, sub: `${s.nombre_corto} · NIF ${s.nif || 'pendiente'}`, extra: [s.nif, s.nombre_corto, ...(s.borme_alias || [])] });
  }
  for (const m of data.modelos || []) {
    add({ grupo: 'Modelos tributarios', entidad: 'modelos', id: m.id, tab: 'fiscal', codigo: m.modelo, titulo: `Modelo ${m.modelo} · ${m.periodo} ${m.ejercicio}`, sub: `${m.concepto} · ${nombre(m.sociedad_id)}`, extra: [m.administracion, m.justificante, m.estado] });
  }
  for (const n of data.notificaciones || []) {
    add({ grupo: 'Notificaciones', entidad: 'notificaciones', id: n.id, tab: 'gobtech', codigo: n.emisor_siglas || 'AA.PP.', titulo: n.asunto, sub: `${n.expediente} · ${n.emisor} · ${nombre(n.sociedad_id)}`, extra: [n.canal === 'dehu' ? 'dehu notificacion electronica' : n.canal, n.emisor_siglas] });
  }
  for (const c of data.contratos || []) {
    add({ grupo: 'Contratos', entidad: 'contratos', id: c.id, tab: 'clm', codigo: c.tipo.toUpperCase(), titulo: c.titulo, sub: `${c.contraparte} · ${nombre(c.sociedad_id)}`, extra: [c.contraparte_nif, c.tipo === 'ppa' ? 'ppa power purchase agreement' : c.tipo] });
  }
  for (const p of data.apoderamientos || []) {
    add({ grupo: 'Apoderamientos', entidad: 'apoderamientos', id: p.id, tab: 'corporativo', codigo: 'PODER', titulo: p.apoderado, sub: `Poder ${p.tipo} · ${nombre(p.sociedad_id)}`, extra: [p.cargo, p.protocolo, ...(p.facultades || [])] });
  }
  for (const j of data.juntas || []) {
    add({ grupo: 'Juntas y actas', entidad: 'juntas', id: j.id, tab: 'corporativo', codigo: 'ACTA', titulo: `${j.organo === 'socio_unico' ? 'Decisiones del socio único' : 'Junta'} · ${fmtFecha(j.fecha)}`, sub: nombre(j.sociedad_id), extra: [...(j.orden_del_dia || []), j.acta_ref] });
  }
  for (const a of data.alertas || []) {
    add({ grupo: 'Boletines oficiales', entidad: 'alertas', id: a.id, tab: 'overview', codigo: a.fuente, titulo: a.titulo, sub: `${a.id} · ${fmtFecha(a.fecha_publicacion)}`, extra: [a.id, a.departamento, ...(a.categorias || [])] });
  }
  for (const n of data.meta?.normas || []) {
    add({ grupo: 'Normativa', entidad: 'normas', id: n.id || n.ref, tab: 'fiscal', codigo: 'NORMA', titulo: n.titulo, sub: n.id || n.fuente || '', url: n.url, extra: [n.ref, n.id, ...(n.articulos || []).map((a) => `art ${a.art} ${a.tema}`)] });
  }
  for (const c of data.checklist || []) {
    add({ grupo: 'Auditoría (NIA-ES)', entidad: 'checklist', id: c.id, tab: 'fiscal', codigo: 'NIA', titulo: `${c.nia} · ${c.titulo}`, sub: c.requerimiento || '', extra: [c.responsable] });
  }
  return out;
}

/** Busqueda AND por terminos con puntuacion; devuelve como mucho `limite`. */
export function buscar(indice, consulta, limite = 14) {
  const q = normalizar(consulta).trim();
  if (!q) return [];
  const terminos = q.split(/\s+/).filter(Boolean);
  const res = [];
  for (const e of indice) {
    if (!terminos.every((t) => e.clave.includes(t))) continue;
    const titulo = normalizar(e.titulo);
    let score = 0;
    if (titulo.startsWith(q)) score += 12;
    if (normalizar(e.codigo) === q || e.clave.split(' ').includes(q)) score += 8;
    for (const t of terminos) {
      if (new RegExp(`(^|[^a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(titulo)) score += 4;
      else if (titulo.includes(t)) score += 2;
    }
    score -= Math.min(4, titulo.length / 60);
    res.push({ ...e, score });
  }
  return res.sort((a, b) => b.score - a.score).slice(0, limite);
}

export function nivelRiesgo(r) {
  if (!Number.isInteger(r)) return null;
  return r < 30 ? 'bajo' : r < 60 ? 'medio' : 'alto';
}

export function filtrarModelos(modelos, f) {
  const q = normalizar(f.q).trim();
  return modelos.filter((m) => (!f.sociedad || m.sociedad_id === f.sociedad)
    && (!f.ejercicio || String(m.ejercicio) === String(f.ejercicio))
    && (!f.administracion || m.administracion === f.administracion)
    && (!f.estado || (f.estado === 'vencido' ? m.calc?.vencido : m.estado === f.estado))
    && (!q || normalizar(`${m.modelo} ${m.concepto} ${m.periodo} ${m.justificante || ''}`).includes(q)));
}

export function filtrarNotificaciones(lista, f) {
  const q = normalizar(f.q).trim();
  const pasaEstado = (n) => {
    switch (f.estado) {
      case 'abiertas': return n.estado !== 'respondida' && n.estado !== 'archivada';
      case 'sin_acuse': return !n.acuse && n.estado !== 'archivada';
      case 'todas': return true;
      default: return n.estado === f.estado;
    }
  };
  const peso = { critica: 0, alta: 1, normal: 2, cerrada: 3 };
  return lista
    .filter((n) => pasaEstado(n)
      && (!f.emisor || (n.emisor_siglas || n.emisor) === f.emisor)
      && (!f.sociedad || n.sociedad_id === f.sociedad)
      && (!q || normalizar(`${n.expediente} ${n.asunto} ${n.emisor} ${n.emisor_siglas || ''}`).includes(q)))
    .sort((a, b) => (peso[a.calc?.urgencia] ?? 9) - (peso[b.calc?.urgencia] ?? 9) || String(b.puesta_disposicion).localeCompare(String(a.puesta_disposicion)));
}

const ESTADOS_ACTIVOS = new Set(['vigente', 'negociacion', 'borrador']);

export function filtrarContratos(lista, f) {
  const q = normalizar(f.q).trim();
  const pasaEstado = (c) => {
    if (!f.estado || f.estado === 'todos') return true;
    if (f.estado === 'activos') return ESTADOS_ACTIVOS.has(c.estado);
    if (f.estado === 'cerrados') return c.estado === 'vencido' || c.estado === 'rescindido';
    return c.estado === f.estado;
  };
  const lejos = '9999-12-31';
  const orden = {
    vencimiento: (a, b) => (a.fecha_vencimiento || lejos).localeCompare(b.fecha_vencimiento || lejos),
    riesgo: (a, b) => (b.riesgo_contraparte ?? -1) - (a.riesgo_contraparte ?? -1),
    valor: (a, b) => (b.valor_cents ?? -1) - (a.valor_cents ?? -1),
    titulo: (a, b) => a.titulo.localeCompare(b.titulo, 'es'),
  }[f.orden || 'vencimiento'];
  return lista
    .filter((c) => pasaEstado(c)
      && (!f.tipo || c.tipo === f.tipo)
      && (!f.sociedad || c.sociedad_id === f.sociedad)
      && (!q || normalizar(`${c.titulo} ${c.contraparte} ${c.contraparte_nif || ''} ${(c.clausulas_clave || []).join(' ')}`).includes(q)))
    .sort(orden);
}

/** Estado de una junta en su secuencia (0..3) para el stepper. */
export const PASOS_JUNTA = ['convocada', 'celebrada', 'acta_firmada', 'formalizada'];
export function pasoJunta(estado) {
  return Math.max(0, PASOS_JUNTA.indexOf(estado));
}
