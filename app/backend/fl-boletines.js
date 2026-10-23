/**
 * S-NFI F&L · Boletines oficiales en vivo: BOE y BORME (2026-10-12).
 *
 * Fuente: API de datos abiertos de la Agencia Estatal BOE, sin clave
 * (verificada en vivo 2026-10-12):
 *   GET https://www.boe.es/datosabiertos/api/boe/sumario/AAAAMMDD    (Accept: application/json)
 *   GET https://www.boe.es/datosabiertos/api/borme/sumario/AAAAMMDD
 * 404 = ese dia no hubo boletin (domingos; BORME tampoco sale en sabado) o
 * todavia no se ha publicado.
 *
 * BOE: cada disposicion de las secciones I, III y V-B se puntua con un motor
 * de reglas sobre el TITULO (no el departamento: "Movilidad Sostenible" o
 * "Transicion Ecologica" en el nombre del ministerio no son un acierto). Las
 * reglas se ajustaron contra siete sumarios reales (2026-09-30 a 2026-10-09).
 * Es un clasificador de palabras clave, no un modelo de IA, y la interfaz lo
 * dice asi.
 *
 * BORME: vigilancia de las sociedades del grupo por denominacion social (el
 * BORME no indexa por NIF):
 *   - Seccion segunda (anuncios: convocatorias, fusiones, escisiones...): el
 *     titulo de cada anuncio es la denominacion de la sociedad.
 *   - Seccion primera (actos inscritos): un unico documento diario, el
 *     "Indice alfabetico de sociedades", lista todas las sociedades con actos
 *     del dia; solo si hay coincidencia se descarga la provincia para extraer
 *     el texto del acto.
 *
 * Doctrina: lectura de datos publicos, nunca accion. Las coincidencias quedan
 * en fl_alertas_normativas para que el humano las revise o descarte.
 */

import { egressFetcher } from './egress/index.js';

const API_BASE = 'https://www.boe.es/datosabiertos/api';
const FETCH_TIMEOUT_MS = 15000;
const USER_AGENT = 'SYSTEMS-SNFI-FL/1.0 (vigilancia normativa interna)';

export const SECCION_PESO = { '1': 3, '3': 2, '5B': 1 };

export const CATEGORIAS = [
  {
    key: 'energia', label: 'Energía', peso: 3,
    re: /\b(energia|energetic[oa]s?|electric[oa]s?|renovables?|fotovoltaic[oa]s?|eolic[oa]s?|hidrogeno|almacenamiento de energia|autoconsumo|baterias|curtailment|red de transporte|redes de distribucion|peajes|cargos del sistema|mercado de produccion|garantias de origen|biocombustibles?|biometano|biogas|bioenergia|potencia instalada|instalaciones de produccion)\b/i,
  },
  {
    key: 'residuos', label: 'Residuos y circularidad', peso: 3,
    re: /\b(residuos?|economia circular|valorizacion|compost|biomasa|lodos|subproductos?|envases|vertederos?|biorresiduos?)\b/i,
  },
  {
    key: 'clima', label: 'Clima y emisiones', peso: 2,
    re: /\b(emisiones|efecto invernadero|derechos de emision|huella de carbono|descarbonizacion|neutralidad climatica|cambio climatico)\b/i,
  },
  {
    key: 'fiscal', label: 'Fiscal', peso: 2,
    re: /\b(impuesto sobre sociedades|impuesto sobre el valor anadido|modelos? (?:200|202|303|347|390|111|190|220|232)|declaraciones? informativas?|autoliquidacion(?:es)?|obligaciones tributarias|incentivos fiscales|ley general tributaria|procedimientos? tributari[oa]s?|regimen fiscal|deducciones?)\b/i,
  },
  {
    // Siglas en mayusculas a proposito (sin flag i): "PERTE" no debe casar con "pertenecientes".
    key: 'fondos', label: 'Fondos y ayudas (PRTR)', peso: 2,
    re: /(\bPlan de Recuperacion\b|\bPRTR\b|NextGeneration|Next Generation|Mecanismo de Recuperacion|\bPERTE\b|\bIDAE\b|Instituto para la Diversificacion y Ahorro)/,
  },
  {
    key: 'mercantil', label: 'Mercantil', peso: 2,
    re: /\b(sociedades de capital|registro mercantil|auditoria de cuentas|cuentas anuales|instituto de contabilidad)\b/i,
  },
  {
    key: 'datos_ia', label: 'Datos e IA', peso: 1, soloSecciones: ['1', '3'],
    re: /\b(inteligencia artificial|ciberseguridad|proteccion de datos|datos personales|esquema nacional de seguridad)\b/i,
  },
];

export const UMBRAL_ALTA = 7;
export const UMBRAL_MEDIA = 5;

export function stripAccents(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export function toArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

/** '20261009' -> '2026-10-09' */
export function isoFromCompact(d) {
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

export function compactFromIso(iso) {
  return iso.replaceAll('-', '');
}

function urlPdf(it) {
  return typeof it.url_pdf === 'object' ? it.url_pdf?.texto ?? null : it.url_pdf ?? null;
}

/**
 * Aplana el sumario BOE. La conversion XML->JSON de la API devuelve objeto o
 * array segun haya uno o varios elementos, y hay secciones sin departamentos
 * (visto en el sumario real de 2026-09-30): todo se normaliza con toArray.
 */
export function parseBoeSumario(json) {
  const sumario = json?.data?.sumario;
  const fecha = sumario?.metadatos?.fecha_publicacion ?? null;
  const items = [];
  for (const diario of toArray(sumario?.diario)) {
    for (const sec of toArray(diario?.seccion)) {
      for (const dep of toArray(sec?.departamento)) {
        const push = (it, epigrafe) => {
          if (!it?.identificador || !it?.titulo) return;
          items.push({
            identificador: it.identificador,
            titulo: String(it.titulo).trim(),
            seccion: String(sec.codigo ?? ''),
            seccion_nombre: sec.nombre ?? '',
            departamento: dep?.nombre ?? '',
            epigrafe: epigrafe ?? null,
            url_html: it.url_html ?? null,
            url_pdf: urlPdf(it),
          });
        };
        for (const ep of toArray(dep?.epigrafe)) for (const it of toArray(ep?.item)) push(it, ep?.nombre);
        for (const it of toArray(dep?.item)) push(it, null);
      }
    }
  }
  return { fecha, items };
}

/** Puntua una disposicion BOE. null si no es relevante para S-NFI. */
export function classifyBoeItem(item) {
  const pesoSeccion = SECCION_PESO[item.seccion];
  if (!pesoSeccion) return null;
  const titulo = stripAccents(item.titulo);
  const cats = CATEGORIAS.filter((c) => (!c.soloSecciones || c.soloSecciones.includes(item.seccion)) && c.re.test(titulo));
  if (!cats.length) return null;

  let puntuacion = pesoSeccion + cats.reduce((acc, c) => acc + c.peso, 0);
  const dep = stripAccents(item.departamento).toUpperCase();
  const keys = cats.map((c) => c.key);
  if (/TRANSICION ECOLOGICA|MERCADOS Y LA COMPETENCIA/.test(dep) && keys.some((k) => k === 'energia' || k === 'residuos' || k === 'clima')) puntuacion += 1;
  if (/HACIENDA/.test(dep) && keys.includes('fiscal')) puntuacion += 1;
  if (/\bNavarra\b/i.test(titulo)) puntuacion += 1;

  const relevancia = puntuacion >= UMBRAL_ALTA ? 'alta' : puntuacion >= UMBRAL_MEDIA ? 'media' : 'baja';
  return { categorias: keys, puntuacion, relevancia };
}

/** Sumario BORME: anuncios de la seccion segunda e indice alfabetico de la primera. */
export function parseBormeSumario(json) {
  const sumario = json?.data?.sumario;
  const fecha = sumario?.metadatos?.fecha_publicacion ?? null;
  const anuncios = [];
  const provincias = new Map();
  let indice = null;
  for (const diario of toArray(sumario?.diario)) {
    for (const sec of toArray(diario?.seccion)) {
      const codigo = String(sec?.codigo ?? '');
      if (codigo === 'A' || codigo === 'B') {
        for (const it of toArray(sec?.item)) {
          if (!it?.identificador) continue;
          if (codigo === 'A' && /INDICE ALFABETICO/i.test(stripAccents(it.titulo))) {
            indice = { identificador: it.identificador, url_html: it.url_html ?? null };
          } else {
            provincias.set(it.identificador, { titulo: it.titulo, url_html: it.url_html ?? null, url_pdf: urlPdf(it), seccion: codigo });
          }
        }
      }
      if (codigo === 'C') {
        for (const ap of toArray(sec?.apartado)) {
          for (const it of toArray(ap?.item)) {
            if (!it?.identificador || !it?.titulo) continue;
            anuncios.push({ identificador: it.identificador, titulo: String(it.titulo).trim(), apartado: ap?.nombre ?? '', url_html: it.url_html ?? null, url_pdf: urlPdf(it) });
          }
        }
      }
    }
  }
  return { fecha, indice, anuncios, provincias };
}

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, x) => String.fromCodePoint(parseInt(x, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

const INDICE_ROW_RE = /<td>([^<]+)<\/td>\s*<td>\s*<p class="cuerpo_tabla_izq">(BORME-A-\d{4}-\d+-\d+)<\/p>\s*<\/td>\s*<td align="right">\s*\((\d+)\)/g;

/** Filas del indice alfabetico de sociedades: { nombre, identificador, numero }. */
export function parseBormeIndice(html) {
  const rows = [];
  for (const m of String(html).matchAll(INDICE_ROW_RE)) {
    rows.push({ nombre: decodeEntities(m[1]).trim(), identificador: m[2], numero: m[3] });
  }
  return rows;
}

/** Texto del acto inscrito numero `numero` dentro del HTML de una provincia. */
export function extractBormeEntry(html, numero) {
  const text = decodeEntities(String(html).replace(/<[^>]+>/g, '\n')).replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n');
  const start = text.indexOf(`${numero} - `);
  if (start < 0) return null;
  const rest = text.slice(start + String(numero).length + 3);
  const next = rest.search(/\n\d{5,7} - /);
  const entry = (next >= 0 ? text.slice(start, start + String(numero).length + 3 + next) : text.slice(start, start + 1500)).trim();
  return entry.replace(/\n/g, ' ').slice(0, 1500);
}

const FORMAS_RE = /\b(SOCIEDAD LIMITADA UNIPERSONAL|SOCIEDAD LIMITADA PROFESIONAL|SOCIEDAD LIMITADA|SOCIEDAD ANONIMA UNIPERSONAL|SOCIEDAD ANONIMA|S L U|S L P|S L|S A U|S A|SLU|SLP|SL|SAU|SA|EN LIQUIDACION)\b/g;

/** Nucleo comparable de una denominacion: sin tildes, signos ni forma juridica. */
export function normalizeCompanyName(name) {
  return stripAccents(name).toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .replace(FORMAS_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Lista de vigilancia a partir de las sociedades activas del grupo. */
export function buildWatchList(sociedades) {
  return sociedades
    .map((s) => ({
      sociedadId: s._id ?? s.id,
      cores: new Set([s.denominacion, ...toArray(s.borme_alias)].filter(Boolean).map(normalizeCompanyName).filter((c) => c.length >= 4)),
    }))
    .filter((w) => w.cores.size > 0);
}

export function matchCompany(nombre, watchList) {
  const core = normalizeCompanyName(nombre);
  if (!core) return null;
  const hit = watchList.find((w) => w.cores.has(core));
  return hit ? hit.sociedadId : null;
}

/** Ultimos `dias` dias civiles hasta `hoyIso` incluido, del mas antiguo al mas reciente. */
export function ultimosDias(hoyIso, dias) {
  const base = Date.UTC(Number(hoyIso.slice(0, 4)), Number(hoyIso.slice(5, 7)) - 1, Number(hoyIso.slice(8, 10)));
  const out = [];
  for (let i = dias - 1; i >= 0; i -= 1) out.push(new Date(base - i * 86400000).toISOString().slice(0, 10));
  return out;
}

/**
 * Orquestador de la sincronizacion. mongo: Db (o el Proxy tenant-aware dentro
 * de un contexto de tenant). Sale por la compuerta de Pactvm Viridi como consulta
 * automatica de datos publicos; fetchImpl inyectable para los tests.
 */
export function createBoletinesSync({ mongo, fetchImpl = egressFetcher({ mesa: 'fl', poll: true, timeoutMs: FETCH_TIMEOUT_MS }), adminNotify, appendLog, today, pauseMs = 250 }) {
  const alertas = () => mongo.collection('fl_alertas_normativas');
  const meta = () => mongo.collection('fl_meta');
  let running = null;

  async function request(url, accept) {
    const res = await fetchImpl(url, {
      headers: { Accept: accept, 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status} en ${url}`);
    return res;
  }

  async function getJson(url) {
    const res = await request(url, 'application/json');
    return res ? res.json() : null;
  }

  async function getText(url) {
    const res = await request(url, 'text/html');
    return res ? res.text() : null;
  }

  const pause = () => (pauseMs > 0 ? new Promise((r) => setTimeout(r, pauseMs)) : Promise.resolve());

  // $setOnInsert: una alerta ya vista conserva su estado (revisada/descartada).
  async function upsertAlerta(doc) {
    const { _id, ...rest } = doc;
    const r = await alertas().updateOne({ _id }, { $setOnInsert: rest }, { upsert: true });
    return r.upsertedCount === 1;
  }

  async function syncBoe(fechaIso, detectadaAt) {
    const json = await getJson(`${API_BASE}/boe/sumario/${compactFromIso(fechaIso)}`);
    if (!json) return { estado: 'sin_publicacion', items: 0, nuevas: [] };
    const { items } = parseBoeSumario(json);
    const nuevas = [];
    for (const it of items) {
      const c = classifyBoeItem(it);
      if (!c) continue;
      const doc = {
        _id: it.identificador, fuente: 'BOE', fecha_publicacion: fechaIso,
        seccion: it.seccion, seccion_nombre: it.seccion_nombre, departamento: it.departamento, epigrafe: it.epigrafe,
        titulo: it.titulo, url_html: it.url_html, url_pdf: it.url_pdf,
        categorias: c.categorias, puntuacion: c.puntuacion, relevancia: c.relevancia,
        sociedad_id: null, acto: null, estado: 'nueva', detectada_at: detectadaAt, origen: 'boe-datosabiertos',
      };
      if (await upsertAlerta(doc)) nuevas.push(doc);
    }
    return { estado: 'ok', items: items.length, nuevas };
  }

  async function syncBorme(fechaIso, detectadaAt, watch) {
    const json = await getJson(`${API_BASE}/borme/sumario/${compactFromIso(fechaIso)}`);
    if (!json) return { estado: 'sin_publicacion', items: 0, nuevas: [] };
    const { indice, anuncios, provincias } = parseBormeSumario(json);
    const nuevas = [];
    if (!watch.length) return { estado: 'ok', items: anuncios.length, nuevas };

    for (const a of anuncios) {
      const sociedadId = matchCompany(a.titulo, watch);
      if (!sociedadId) continue;
      const doc = {
        _id: a.identificador, fuente: 'BORME', fecha_publicacion: fechaIso,
        seccion: 'C', seccion_nombre: 'Anuncios y avisos legales', departamento: a.apartado, epigrafe: null,
        titulo: a.titulo, url_html: a.url_html, url_pdf: a.url_pdf,
        categorias: ['mercantil'], puntuacion: 10, relevancia: 'alta',
        sociedad_id: sociedadId, acto: a.apartado, estado: 'nueva', detectada_at: detectadaAt, origen: 'boe-datosabiertos',
      };
      if (await upsertAlerta(doc)) nuevas.push(doc);
    }

    if (indice?.url_html) {
      await pause();
      const html = await getText(indice.url_html);
      const hits = html ? parseBormeIndice(html).map((r) => ({ ...r, sociedadId: matchCompany(r.nombre, watch) })).filter((r) => r.sociedadId) : [];
      const cache = new Map();
      for (const h of hits) {
        const prov = provincias.get(h.identificador);
        let acto = null;
        if (prov?.url_html) {
          if (!cache.has(h.identificador)) {
            await pause();
            cache.set(h.identificador, await getText(prov.url_html));
          }
          const provHtml = cache.get(h.identificador);
          acto = provHtml ? extractBormeEntry(provHtml, h.numero) : null;
        }
        const doc = {
          _id: `${h.identificador}_${h.numero}`, fuente: 'BORME', fecha_publicacion: fechaIso,
          seccion: 'A', seccion_nombre: 'Actos inscritos', departamento: prov?.titulo ?? '', epigrafe: null,
          titulo: h.nombre, url_html: prov?.url_html ?? indice.url_html, url_pdf: prov?.url_pdf ?? null,
          categorias: ['mercantil'], puntuacion: 10, relevancia: 'alta',
          sociedad_id: h.sociedadId, acto, estado: 'nueva', detectada_at: detectadaAt, origen: 'boe-datosabiertos',
        };
        if (await upsertAlerta(doc)) nuevas.push(doc);
      }
    }
    return { estado: 'ok', items: anuncios.length, nuevas };
  }

  async function loadWatch() {
    const sociedades = await mongo.collection('fl_sociedades').find({ deleted: { $ne: true } }).toArray();
    return buildWatchList(sociedades);
  }

  async function runSync({ dias = 7, actorId = 'system' } = {}) {
    const hoy = today();
    const detectadaAt = new Date().toISOString();
    const watch = await loadWatch();
    const resumen = { dias: 0, nuevas: 0, boe: 0, borme: 0, errores: [] };
    const nuevasDocs = [];

    for (const fecha of ultimosDias(hoy, dias)) {
      const key = `boletines:${fecha}`;
      const prev = await meta().findOne({ _id: key });
      if (prev?.completo && fecha !== hoy) continue;
      try {
        const boe = await syncBoe(fecha, detectadaAt);
        await pause();
        const borme = await syncBorme(fecha, detectadaAt, watch);
        await pause();
        // Hoy puede no estar publicado todavia: solo un dia pasado queda cerrado.
        const completo = fecha !== hoy || (boe.estado === 'ok' && borme.estado === 'ok');
        await meta().updateOne({ _id: key }, {
          $set: { completo, boe: { estado: boe.estado, items: boe.items, hits: boe.nuevas.length }, borme: { estado: borme.estado, items: borme.items, hits: borme.nuevas.length }, at: new Date().toISOString() },
        }, { upsert: true });
        resumen.dias += 1;
        resumen.boe += boe.nuevas.length;
        resumen.borme += borme.nuevas.length;
        nuevasDocs.push(...boe.nuevas, ...borme.nuevas);
      } catch (err) {
        resumen.errores.push(`${fecha}: ${err.message}`);
      }
    }
    resumen.nuevas = nuevasDocs.length;

    const ahora = new Date().toISOString();
    const statusSet = { ultimaSync: ahora, ultimoError: resumen.errores[0] ?? null, ultimasNuevas: resumen.nuevas };
    if (!resumen.errores.length) statusSet.ultimoOk = ahora;
    await meta().updateOne({ _id: 'boletines_status' }, { $set: statusSet }, { upsert: true });

    for (const d of nuevasDocs) {
      if (d.fuente === 'BORME') {
        adminNotify?.({ origin: 'FL', label: `BORME: publicación sobre ${d.titulo}`, detail: `${d.seccion_nombre} · ${d.acto || d.departamento || ''}`.slice(0, 240), severity: 'warning' });
      } else if (d.relevancia === 'alta') {
        adminNotify?.({ origin: 'FL', label: 'BOE: disposición de relevancia alta', detail: d.titulo.slice(0, 240), severity: 'warning' });
      }
    }
    if (resumen.nuevas > 0 || actorId !== 'system') {
      await appendLog?.({ action: 'boletines.sync', actorId, detail: { dias: resumen.dias, nuevas: resumen.nuevas, boe: resumen.boe, borme: resumen.borme, errores: resumen.errores.length } });
    }
    return resumen;
  }

  /** Una sola sincronizacion a la vez: las llamadas concurrentes esperan la misma. */
  function sync(opts) {
    if (!running) running = runSync(opts).finally(() => { running = null; });
    return running;
  }

  async function status() {
    return (await meta().findOne({ _id: 'boletines_status' })) ?? { ultimaSync: null, ultimoOk: null, ultimoError: null };
  }

  return { sync, status, isRunning: () => !!running };
}
