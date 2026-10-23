import { Router, Request, Response } from 'express';
import { getReffDb, nextSeq } from '../mongo.js';
import { authMiddleware } from '../auth.js';
import { callLlm, isLlmUnavailable } from '../llm.js';
import { egressFetch, egressErrorCode } from '../egress.js';

const router = Router();

router.use(authMiddleware);

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
const FETCH_TIMEOUT_MS = 8000;
const MAX_FETCH_BYTES = 400_000; // límite de descarga cruda
const MAX_EXTRACTED_CHARS = 6000; // límite de texto extraído por URL, para no disparar el prompt
const MAX_URLS_PER_AUDIT = 3;
const MAX_WEB_SEARCH_USES = 6; // tope de búsquedas por auditoría, coste controlado
const AUDIT_TIMEOUT_MS = 240_000; // varias rondas de búsqueda web: más margen que una llamada normal a la IA

// Extractor de texto minimalista: sin dependencia nueva. Quita script/style,
// tags, decodifica entidades comunes y colapsa espacio en blanco.
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

// La descarga sale por la compuerta de Pactvm Viridi como página pública: solo http(s)
// estándar, y localhost, redes privadas y metadatos cloud se rechazan al conectar y en
// cada redirección. El texto a auditar lo escribe el usuario, así que una URL ahí es SSRF
// si no se valida.
async function fetchUrlAsText(rawUrl: string, username: string): Promise<{ url: string; text: string } | { url: string; error: string }> {
  try {
    new URL(rawUrl);
  } catch {
    return { url: rawUrl, error: 'URL no accesible (privada, local o inválida) — omitida por seguridad' };
  }
  try {
    const r = await egressFetch(rawUrl, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; ElviRaHerzog/1.0)' },
    }, { user: username, publicWeb: true, timeoutMs: FETCH_TIMEOUT_MS, maxBytes: MAX_FETCH_BYTES, truncate: true });
    if (!r.ok) return { url: rawUrl, error: `HTTP ${r.status} al descargar la página` };

    const contentType = r.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
      return { url: rawUrl, error: `Tipo de contenido no soportado (${contentType || 'desconocido'})` };
    }

    const text = htmlToText(await r.text()).slice(0, MAX_EXTRACTED_CHARS);
    if (!text) return { url: rawUrl, error: 'No se pudo extraer texto legible de la página' };
    return { url: rawUrl, text };
  } catch (err: any) {
    const code = egressErrorCode(err);
    if (code === 'denied') return { url: rawUrl, error: 'URL no accesible (privada, local o inválida) — omitida por seguridad' };
    if (code === 'timeout') return { url: rawUrl, error: 'Timeout al descargar la página' };
    if (code === 'unavailable') return { url: rawUrl, error: 'Descarga de páginas no disponible en este modo' };
    return { url: rawUrl, error: err?.message || 'Error al descargar la página' };
  }
}

type EvalType = 'CLIENTE' | 'FINANCIADOR';

// Pesos por tipo de acreditacion. Suman 100 en ambos casos.
// Cliente (A): manda la capacidad de soportar el despliegue tecnico y la auditabilidad.
// Financiador (B): manda el musculo financiero y el perfil accionarial.
const WEIGHTS: Record<EvalType, Record<string, number>> = {
  CLIENTE: {
    solvenciaFinanciera: 20,
    infraestructuraOperativa: 35,
    transparenciaCompliance: 30,
    alineacionEstrategica: 15,
  },
  FINANCIADOR: {
    solvenciaFinanciera: 40,
    infraestructuraOperativa: 10,
    transparenciaCompliance: 25,
    alineacionEstrategica: 25,
  },
};

const COMMON_PROMPT = `Eres HERZOG, el modulo de acreditacion empresarial de Reff (agente par de Elvi-Ra), centro de mando de South-Navarre Fresh Innovations Corp. (S-NFI).

OBJETIVO: investigar informacion publica 100% REAL de la empresa candidata y emitir un REPORTE DE ACREDITACION DE EMPRESA.

REGLAS DE INVESTIGACION (no negociables):
1. Usa la herramienta de busqueda web para consultar webs oficiales, cuentas depositadas en registro mercantil, noticias, informes anuales y perfiles profesionales. Prioriza fuentes primarias (web corporativa, BORME, boletines oficiales, informes anuales) sobre agregadores.
2. Si el mensaje del usuario incluye bloques "[Contenido extraido de <url>]", tratalos como fuente primaria adicional. Si ves "[URL ... no se pudo extraer contenido: ...]", esa URL no aporto datos: no inventes que contiene.
3. Si un dato no es verificable publicamente, indicalo como "No disponible / No publico". PROHIBIDO inventar, estimar o extrapolar datos no verificados: ni cifras, ni ratios, ni contactos, ni certificaciones.
4. Cuenta cuantas de las 4 categorias quedan sin dato verificable suficiente ("opacas") y reportalo en "opacityCount".
5. El CIF/NIF solo se rellena si lo encuentras verificado en una fuente. Si no, "taxId": null.

LOGICA DE PUNTUACION (escala 1 a 10, aplicala a cada categoria y a cada variable individual):
- 9.0 - 10.0 (Excelente / automaticamente acreditable): cumple holgadamente todos los criterios de solvencia, compliance impecable, infraestructura madura o capital de inversion disponible de inmediato.
- 7.0 - 8.9 (Bueno / acreditable con condiciones standard): riesgo bajo/medio, solvencia solida, requiere tramites habituales de comprobacion.
- 5.0 - 6.9 (Moderado / requiere revision manual humana): lagunas operativas o financieras corregibles (falta de certificaciones IT en Cliente, o liquidez justa en Financiador).
- 1.0 - 4.9 (Riesgo alto / no acreditable): perdidas continuas, presencia en registros de morosidad, opacidad societaria, o incapacidad tecnica para soportar los Nodos.

CALCULO DE overallScore: media ponderada de las 4 categorias usando EXACTAMENTE los pesos indicados abajo para este tipo de evaluacion. Resultado 0-10 redondeado a un decimal.

VEREDICTO (umbrales fijos, no ajustables):
- "ACEPTADO" si overallScore >= 7.0 y no hay ninguna RED FLAG.
- "RECHAZADO" si overallScore < 5.0, o si hay una RED FLAG descalificatoria (insolvencia, concurso de acreedores, opacidad societaria total, sanciones graves).
- "REVISION_MANUAL" en el resto de casos: overallScore entre 5.0 y 6.9, o overallScore >= 7.0 con alguna RED FLAG presente, o opacityCount > 2.

BANDERAS DE RIESGO: emite "RED" para hechos descalificatorios o graves verificados (cuentas no auditadas o no depositadas, litigios graves, morosidad RAI/ASNEF, concurso, jurisdiccion opaca, sanciones). Emite "YELLOW" para avisos no descalificatorios (ratio de endeudamiento elevado, ausencia de certificaciones, informacion parcial). Si no hay banderas, devuelve un array vacio.

Ante duda razonable, no puntues al alza.`;

const CLIENTE_PROMPT = `TIPO DE EVALUACION: CLIENTE (Empresa Tipo A) - donde auditar e implantar Nodos.
El objetivo es la capacidad operativa y de infraestructura: asegurar que la empresa soportara el despliegue tecnico y la auditoria.

PESOS DE CATEGORIA para este tipo (usalos en el calculo, son fijos):
- solvenciaFinanciera: 20%  (Solvencia y Salud Financiera)
- infraestructuraOperativa: 35%  (Infraestructura y Modelo Operativo)
- transparenciaCompliance: 30%  (Transparencia y Compliance)
- alineacionEstrategica: 15%  (Alineacion Estrategica / Encaje S-NFI)

QUE EVALUAR EN CADA CATEGORIA:
- infraestructuraOperativa: Digital maturity index (grado de digitalizacion: ERPs modernos, APIs, cloud vs on-premise). Estructura IT y governance (existencia de CTO/CISO, certificaciones ISO 27001, SOC2, ENS). Complejidad operativa y numero de sedes, para medir la viabilidad fisica/logica de implantacion de Nodos.
- transparenciaCompliance: Transparencia contable (obligatoriedad de auditoria externa y/o deposito regular de cuentas). Riesgo legal y reputacional (ausencia de litigios graves activos, presencia en listas de morosidad RAI/ASNEF, sanciones o expedientes de compliance).
- solvenciaFinanciera: Facturacion anual y EBITDA (minimo vital para absorber los costes del proyecto). Ratio de solvencia (Activo Total / Pasivo Total, optimo >= 1.5).
- alineacionEstrategica: encaje del residuo/proceso con S-NFI BioHybrid y compatibilidad con el marco OPHS.

VARIABLES INDIVIDUALES OBLIGATORIAS en "variables" (todas con score 1-10 y justificacion citando la fuente del dato):
1. "Madurez Digital / Arquitectura IT"
2. "Estructura IT y Governance"
3. "Complejidad operativa / Numero de sedes"
4. "Transparencia contable"
5. "Historial Legal y Reputacional"
6. "Facturacion anual y EBITDA"
7. "Ratio de Solvencia"
8. "Complejidad de Auditoria"`;

const FINANCIADOR_PROMPT = `TIPO DE EVALUACION: FINANCIADOR (Empresa Tipo B) - capacitada para entrar en el accionariado de S-NFI.
El objetivo es la solvencia financiera, la reputacion del capital y el encaje estrategico.

PESOS DE CATEGORIA para este tipo (usalos en el calculo, son fijos):
- solvenciaFinanciera: 40%  (Solvencia y Salud Financiera / Musculo inversor)
- infraestructuraOperativa: 10%  (Infraestructura y Modelo Operativo)
- transparenciaCompliance: 25%  (Transparencia y Compliance)
- alineacionEstrategica: 25%  (Alineacion Estrategica / Encaje S-NFI)

QUE EVALUAR EN CADA CATEGORIA:
- solvenciaFinanciera: Cash y liquidez inmediata (posicion de tesoreria y equivalentes disponible para despliegue de capital). Capacidad de apalancamiento / Debt-to-Equity (Pasivo / Patrimonio Neto, optimo <= 1.0). Capacidad de inversion previa (historico demostrable en Private Equity, Venture Capital o M&A corporativo).
- transparenciaCompliance: Estructura societaria y UBO (Ultimate Beneficial Owner): identificacion clara de propietarios y ausencia de sociedades en jurisdicciones de riesgo u opacas. Track record y reputacion corporativa (historial de permanencia en accionariados, calificacion en agencias de riesgo y buros de credito).
- alineacionEstrategica: Encaje estrategico y smart capital (valor anadido mas alla del dinero: red de contactos, sinergias de sector, peso institucional).
- infraestructuraOperativa: solidez estructural del inversor como organizacion (peso bajo en este tipo, pero evaluala igualmente).

VARIABLES INDIVIDUALES OBLIGATORIAS en "variables" (todas con score 1-10 y justificacion citando la fuente del dato):
1. "Cash / Liquidez Inmediata"
2. "Capacidad de Apalancamiento / Debt-to-Equity"
3. "Capacidad de Inversion Previa"
4. "Estructura Societaria / UBO"
5. "Encaje Estrategico & Smart Capital"
6. "Track record & Reputacion corporativa"
7. "Capacidad de Inversion / Liquidez"
8. "Historial Legal y Reputacional"`;

const OUTPUT_PROMPT = `Responde EXCLUSIVAMENTE con un JSON valido (sin markdown, sin texto adicional), con esta forma exacta:
{
  "evalType": "CLIENTE" | "FINANCIADOR",
  "taxId": "CIF/NIF verificado o null",
  "activity": "descripcion concreta de que hace la empresa, 2-4 frases, o indicacion explicita de falta de dato",
  "categories": {
    "solvenciaFinanciera":      { "score": 0, "weightPct": 0, "justification": "justificacion concreta citando datos encontrados" },
    "infraestructuraOperativa": { "score": 0, "weightPct": 0, "justification": "..." },
    "transparenciaCompliance":  { "score": 0, "weightPct": 0, "justification": "..." },
    "alineacionEstrategica":    { "score": 0, "weightPct": 0, "justification": "..." }
  },
  "variables": [ { "label": "nombre exacto de la variable", "score": 0, "justification": "..." } ],
  "overallScore": 0,
  "opacityCount": 0,
  "verdict": "ACEPTADO" | "REVISION_MANUAL" | "RECHAZADO",
  "flags": [ { "level": "RED" | "YELLOW", "message": "hecho concreto verificado" } ],
  "summary": "resumen ejecutivo, 2-4 frases, explicando el veredicto",
  "recommendation": "explicacion breve justificando por que es o no acreditable y bajo que condiciones (por ejemplo: Acreditable sujeto a auditoria previa de seguridad IT)",
  "contact": {
    "methods": [ { "channel": "web" | "email" | "telefono" | "linkedin" | "sede", "value": "dato real encontrado", "note": "fuente del dato" } ],
    "noDataFound": false
  },
  "firstContact": {
    "channel": "canal recomendado para el primer contacto",
    "approach": "como encarar la primera toma de contacto: tono, argumento de apertura, que ofrecer, que evitar, 2-4 frases"
  }
}

"score" de cada categoria y de cada variable es un numero 1-10 (permite un decimal). "weightPct" debe coincidir EXACTAMENTE con los pesos indicados arriba para este tipo de evaluacion. "overallScore" es la media ponderada 0-10 con un decimal. Si no hay datos de contacto verificables, deja "methods" vacio y "noDataFound": true. Todos los textos en espanol, en frases completas y sin ambiguedad.`;

function buildSystemPrompt(evalType: EvalType): string {
  const typeBlock = evalType === 'CLIENTE' ? CLIENTE_PROMPT : FINANCIADOR_PROMPT;
  return COMMON_PROMPT + '\n\n' + typeBlock + '\n\n' + OUTPUT_PROMPT;
}

// Recalcula la nota global en el servidor a partir de las categorias y los pesos
// fijos del tipo: el LLM puede equivocarse en la aritmetica, y los umbrales de
// veredicto no deben depender de eso.
// La herramienta de busqueda web hace que el modelo cuele a veces etiquetas
// <cite index="...">...</cite> dentro de los textos. Se limpian aqui: el
// frontend renderiza texto plano y las mostraria crudas.
const CITE_TAG_RE = /<\/?cite[^>]*>/gi;

function stripCitations(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(CITE_TAG_RE, '').replace(/[ \t]{2,}/g, ' ').trim();
  if (Array.isArray(value)) return value.map(stripCitations);
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) (value as Record<string, unknown>)[k] = stripCitations(v);
    return value;
  }
  return value;
}

function recomputeScores(result: any, evalType: EvalType): void {
  if (!result || typeof result !== 'object') return;
  stripCitations(result);
  const weights = WEIGHTS[evalType];
  result.evalType = evalType;

  const cats = result.categories;
  if (!cats || typeof cats !== 'object') return;

  let weighted = 0;
  let totalWeight = 0;
  for (const [key, weight] of Object.entries(weights)) {
    const cat = cats[key];
    if (!cat || typeof cat.score !== 'number' || !Number.isFinite(cat.score)) continue;
    const score = Math.min(10, Math.max(1, cat.score));
    cat.score = Math.round(score * 10) / 10;
    cat.weightPct = weight; // el peso lo fija el servidor, no el modelo
    weighted += score * weight;
    totalWeight += weight;
  }
  if (totalWeight === 0) return;

  const overall = Math.round((weighted / totalWeight) * 10) / 10;
  result.overallScore = overall;

  const flags = Array.isArray(result.flags) ? result.flags : [];
  const hasRedFlag = flags.some((f: any) => f && f.level === 'RED');
  const opacity = typeof result.opacityCount === 'number' ? result.opacityCount : 0;

  if (overall < 5) result.verdict = 'RECHAZADO';
  else if (hasRedFlag || opacity > 2 || overall < 7) result.verdict = 'REVISION_MANUAL';
  else result.verdict = 'ACEPTADO';
}

router.post('/audit', async (req: Request, res: Response) => {
  const { companyName, text, evalType: rawEvalType } = req.body || {};
  if (!companyName || typeof companyName !== 'string' || !companyName.trim()) {
    return res.status(400).json({ error: 'El nombre de la empresa es obligatorio' });
  }
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'El texto a auditar es obligatorio' });
  }
  if (rawEvalType !== undefined && rawEvalType !== 'CLIENTE' && rawEvalType !== 'FINANCIADOR') {
    return res.status(400).json({ error: 'Tipo de acreditación inválido (debe ser CLIENTE o FINANCIADOR)' });
  }
  // Por defecto CLIENTE: es el flujo de acreditación más habitual (auditar e implantar Nodos).
  const evalType: EvalType = rawEvalType === 'FINANCIADOR' ? 'FINANCIADOR' : 'CLIENTE';

  const trimmedText = text.trim();
  const urls = Array.from(new Set(trimmedText.match(URL_RE) || [])).slice(0, MAX_URLS_PER_AUDIT);

  let extractedBlock = '';
  if (urls.length > 0) {
    const fetched = await Promise.all(urls.map((u) => fetchUrlAsText(u, req.user.username)));
    extractedBlock = fetched.map((f) => {
      if ('error' in f) return `\n\n[URL ${f.url} — no se pudo extraer contenido: ${f.error}]`;
      return `\n\n[Contenido extraído de ${f.url}]\n${f.text}`;
    }).join('');
  }

  const typeLabel = evalType === 'CLIENTE'
    ? 'CLIENTE (Tipo A — donde auditar e implantar Nodos)'
    : 'FINANCIADOR (Tipo B — capacitado para entrar en el accionariado de S-NFI)';
  const userMessage = `Empresa a investigar: ${companyName.trim()}\nTipo de acreditación solicitada: ${typeLabel}\n\nInformación de partida proporcionada por el usuario (puede estar vacía o ser solo el nombre — usa la búsqueda web para completar el resto):\n${trimmedText}${extractedBlock}`;

  let result: unknown;
  let sources: HerzogSource[];
  try {
    ({ result, sources } = await runHerzogAudit(userMessage, evalType, req.user.username));
  } catch (err: any) {
    const status = isLlmUnavailable(err) ? 503 : 502;
    return res.status(status).json({ error: err?.message || 'Error al ejecutar la auditoría Herzog' });
  }

  // El servidor manda sobre pesos, nota global y veredicto — el LLM solo aporta
  // las puntuaciones por categoría y su justificación.
  recomputeScores(result, evalType);

  const auditId = await nextSeq('herzog_audits');
  await getReffDb().collection<AuditDoc>('herzog_audits').insertOne({
    _id: auditId,
    user_id: req.user.id,
    company_name: companyName.trim(),
    eval_type: evalType,
    input_text: text.trim(),
    result_json: result as Record<string, unknown>,
    sources,
    created_at: new Date().toISOString(),
  });

  const matchedCompany = await findCrmCompanyByName(companyName.trim(), req.user.id);

  res.json({ result, sources, matchedCompany });
});

interface HerzogSource {
  url: string;
  title: string | null;
}

// Búsqueda asistida: la IA investiga la empresa en la web (el proveedor resuelve
// las búsquedas y las rondas que hagan falta) y devuelve el JSON final.
async function runHerzogAudit(userMessage: string, evalType: EvalType, username: string): Promise<{ result: unknown; sources: HerzogSource[] }> {
  const llm = await callLlm({
    system: buildSystemPrompt(evalType),
    prompt: userMessage,
    // El reporte de acreditacion (4 categorias + 8 variables + flags +
    // recomendacion + contacto) no cabe en 4096: se corta a mitad del JSON.
    maxTokens: 8192,
    webSearch: { maxUses: MAX_WEB_SEARCH_USES },
    timeoutMs: AUDIT_TIMEOUT_MS,
    user: username,
    operation: 'herzog-audit',
  });

  let result: unknown;
  try {
    const jsonMatch = llm.text.match(/\{[\s\S]*\}/);
    result = JSON.parse(jsonMatch ? jsonMatch[0] : llm.text);
  } catch {
    // El corte por límite de tokens es el fallo mas probable con el esquema
    // completo del reporte: se distingue del JSON malformado para no mandar al
    // usuario a depurar el prompt cuando lo que falta es presupuesto de salida.
    console.error('[Herzog] JSON invalido · truncado=%s · chars=%d · cola=%j',
      llm.truncated, llm.text.length, llm.text.slice(-300));
    if (llm.truncated) {
      throw new Error('La auditoría se cortó por longitud antes de completar el informe — reintenta.');
    }
    throw new Error('La auditoría no devolvió un JSON válido');
  }

  return { result, sources: llm.sources };
}

// Busca si la empresa auditada ya existe en el CRM del usuario (por nombre,
// case-insensitive), para que el frontend ofrezca "eliminar" en vez de "añadir".
async function findCrmCompanyByName(name: string, userId: string) {
  const db = getReffDb();
  const userSheets = await db.collection('sheets').find({ user_id: userId } as never).project({ _id: 1 }).toArray();
  const sheetIds = userSheets.map((s) => s._id);
  if (sheetIds.length === 0) return null;

  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const company = await db.collection('companies').findOne({
    sheet_id: { $in: sheetIds },
    name: { $regex: `^${escaped}$`, $options: 'i' },
  } as never);
  if (!company) return null;
  return { id: (company as never as { _id: number })._id, sheetId: (company as never as { sheet_id: number }).sheet_id };
}

interface AuditDoc {
  _id: number;
  user_id: string;
  company_name: string;
  /** Ausente en auditorías anteriores al modelo A/B — se normaliza a CLIENTE al leer. */
  eval_type?: EvalType;
  input_text: string;
  result_json: Record<string, unknown>;
  sources: HerzogSource[];
  created_at: string;
}

router.delete('/audit/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Id inválido' });

  const result = await getReffDb().collection<AuditDoc>('herzog_audits')
    .deleteOne({ _id: id, user_id: req.user.id });
  if (result.deletedCount === 0) return res.status(404).json({ error: 'Auditoría no encontrada' });

  res.json({ ok: true });
});

// Auditorias anteriores al modelo A/B usaban {dimensions, weightedScorePct, score10,
// verdict: APTO|APTO_CON_CONDICIONES|NO_APTO|REVISION_MANUAL_REQUERIDA}. Se traducen al
// formato actual al leerlas para que el historial siga renderizando, sin reescribir Mongo.
const LEGACY_DIMENSION_MAP: Record<string, string> = {
  corporateViability: 'infraestructuraOperativa',
  snfiAlignment: 'alineacionEstrategica',
  reputationRisk: 'transparenciaCompliance',
  operationalCapacity: 'solvenciaFinanciera',
};

const LEGACY_VERDICT_MAP: Record<string, string> = {
  APTO: 'ACEPTADO',
  APTO_CON_CONDICIONES: 'REVISION_MANUAL',
  REVISION_MANUAL_REQUERIDA: 'REVISION_MANUAL',
  NO_APTO: 'RECHAZADO',
};

function normalizeLegacyResult(raw: any, evalType: EvalType): any {
  if (!raw || typeof raw !== 'object') {
    return {
      evalType, taxId: null, activity: '', categories: {}, variables: [],
      overallScore: 0, opacityCount: 4, verdict: 'REVISION_MANUAL', flags: [],
      summary: 'Auditoría en formato antiguo: no se pudo recuperar el contenido.',
      recommendation: '', contact: { methods: [], noDataFound: true },
      firstContact: { channel: '', approach: '' },
    };
  }
  if (raw.categories) return raw; // ya esta en el formato actual

  const weights = WEIGHTS[evalType];
  const categories: Record<string, unknown> = {};
  for (const [legacyKey, newKey] of Object.entries(LEGACY_DIMENSION_MAP)) {
    const dim = raw.dimensions?.[legacyKey];
    if (!dim) continue;
    // La escala antigua era 1-5; se reescala a 1-10 para no mezclar unidades.
    const score = typeof dim.score === 'number' ? Math.min(10, Math.max(1, dim.score * 2)) : 1;
    categories[newKey] = {
      score: Math.round(score * 10) / 10,
      weightPct: weights[newKey] ?? 0,
      justification: dim.justification ?? '',
    };
  }

  const overall = typeof raw.weightedScorePct === 'number'
    ? Math.round((raw.weightedScorePct / 10) * 10) / 10
    : (typeof raw.score10 === 'number' ? raw.score10 : 0);

  return {
    evalType,
    taxId: null,
    activity: raw.activity ?? '',
    categories,
    variables: [],
    overallScore: overall,
    opacityCount: typeof raw.opacityCount === 'number' ? raw.opacityCount : 0,
    verdict: LEGACY_VERDICT_MAP[raw.verdict] ?? 'REVISION_MANUAL',
    flags: Array.isArray(raw.redFlags)
      ? raw.redFlags.map((m: string) => ({ level: 'RED', message: m }))
      : [],
    summary: raw.summary ?? '',
    recommendation: raw.verticalNote ?? '',
    contact: raw.contact ?? { methods: [], noDataFound: true },
    firstContact: raw.firstContact ?? { channel: '', approach: '' },
  };
}

router.get('/history', async (req: Request, res: Response) => {
  const rows = await getReffDb().collection<AuditDoc>('herzog_audits')
    .find({ user_id: req.user.id })
    .sort({ _id: -1 })
    .limit(50)
    .toArray();
  res.json({
    audits: rows.map((r) => ({
      id: r._id,
      companyName: r.company_name,
      evalType: r.eval_type ?? 'CLIENTE',
      inputText: r.input_text,
      result: normalizeLegacyResult(r.result_json, r.eval_type ?? 'CLIENTE'),
      sources: r.sources ?? [],
      createdAt: r.created_at,
    })),
  });
});

export default router;
