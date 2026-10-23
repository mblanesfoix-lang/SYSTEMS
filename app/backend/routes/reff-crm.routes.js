/**
 * Rëff CRM-adjacent · sheets/companies/search/linkedin/email/overview
 * Todo Mongo-backed (db 'elvira': sheets, companies). Incluye el buscador de
 * Nodos de Integración Potencial (búsqueda asistida), LinkedIn Finder y Email
 * Creator — los tres módulos IA de outreach. El consumo de cada llamada lo
 * registra el módulo de IA en T'Controler.
 */

import crypto from 'node:crypto';
import { callLlm, isLlmUnavailable } from '../llm/index.js';
import { migrateJsonOnce, insertIgnoringDuplicates } from '../lib/json-migration.js';

function normalizeTareas(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map(t => {
      if (typeof t === 'string') {
        const text = t.trim();
        if (!text) return null;
        return { id: crypto.randomUUID(), text, done: false, createdAt: new Date().toISOString() };
      }
      if (t && typeof t === 'object') {
        const text = String(t.text || '').trim();
        if (!text) return null;
        return {
          id: typeof t.id === 'string' && t.id ? t.id : crypto.randomUUID(),
          text,
          done: !!t.done,
          createdAt: t.createdAt || new Date().toISOString(),
        };
      }
      return null;
    })
    .filter(Boolean);
}

function extractJson(text) {
  let s = text.trim();
  // Limpiar posibles bloques de markdown antes y después
  s = s.replace(/^[^{]*/, '').replace(/[^}]*$/, '');
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first < 0 || last < 0) throw new Error('respuesta IA sin JSON');
  try {
    return JSON.parse(s.slice(first, last + 1));
  } catch (e) {
    throw new Error('JSON de la IA mal formado: ' + e.message);
  }
}

/* ---------- búsqueda asistida de nodos ---------- */
const SYSTEM_PROMPT = `Eres el Agente S-NFI (South Navarre Fresh Innovations) integrado en Rëff, la mesa comercial de SYSTEMS. Tu trabajo: detectar Nodos de Integración Potencial (no "leads").

REGLAS DURAS de inclusión:
- Volumen de residuo orgánico anual > 8 toneladas.
- Residuo 100% orgánico (no mezclas con plástico/químico).
- Modelo B2B o B2C compatible con S-NFI BioHybrid.

VARIABLES CRÍTICAS por empresa:
- Variable B (BSS & Resilience): estima MWh de Battery Storage para 48h autonomía post-apagón. Penaliza si la empresa no tiene espacio/capacidad para BSS (vulnerabilidad CNMC).
- Variable G (Gobernanza Herzog): si la empresa está hipotecada con eléctrica tradicional o no permite modelos OEM → TÓXICO, bloquear.
- Variable U-2 (Reto Científico): si el residuo es complejo y requiere I+D S-NFI U-2, sube valor estratégico.

PENALIZACIÓN FUERTE / DESCARTE si:
- Dependencia de Biogás/Anaerobia (competencia/lastre).
- Opacidad CNMC o sanciones previas.
- Estructura jerárquica incompatible con Gobernanza Externa OPHS.

Para cada empresa devuelve PUNTUACIÓN OPHS (0-100) basada en compatibilidad global.

DATOS DE FICHA EXIGIDOS por empresa. REGLA DURA: TODOS los campos numéricos (volumenResiduoT, plantas, empleados, facturacionM) deben ir RELLENOS con un número estimado. Prohibido devolver null o 0 sin justificar. Si no hay dato exacto, ESTIMA con razonamiento sectorial usando los siguientes proxies:

PROTOCOLO DE ESTIMACIÓN (obligatorio aplicar antes de devolver):
1. Buscar dato público (web corporativa, eInforma, registro mercantil ES, SABI, Crunchbase, LinkedIn, Bloomberg, memoria anual, informe sostenibilidad GRI/ESG).
2. Si no hay público: estimar por benchmarks sectoriales:
   • Facturación → cruzar con tamaño plantilla (ratio sectorial: agroalimentario ~150-250 k€/empleado, vinícola ~120-180 k€/empleado, cárnico ~200-300 k€/empleado).
   • Empleados → buscar en LinkedIn "company size" o estimar desde facturación.
   • Plantas → web corporativa "nuestras instalaciones" / "centros productivos". Mínimo 1.
   • Volumen residuo → derivar de facturación + sector usando intensidad de residuo orgánico típica (vinícola: 0.3-0.5 T residuo / 1 T uva; cárnico: 0.4-0.6 T residuo / 1 T producto; lácteo: 0.9 L suero / 1 L leche).
3. Devolver el número estimado. Marcar la incertidumbre en "fuentes" (campo opcional).
4. Solo usar "DESCONOCIDO" en campos string (tipoResiduo, esg, pagaGestion). NUNCA en numéricos.

CAMPOS:
- tipoResiduo: categoría dominante del residuo orgánico (string, obligatorio rellenar).
- volumenResiduoT: toneladas/año totales de residuo orgánico (número, > 8, obligatorio).
- plantas: número de centros productivos (entero, mínimo 1, obligatorio).
- empleados: plantilla total estimada (entero, obligatorio).
- facturacionM: facturación anual estimada en M€ (número con 1 decimal, obligatorio).
- pagaGestion: SI si paga gestor externo de residuos hoy / NO si autogestiona / DESCONOCIDO solo si no hay señal alguna. Heurística: empresas >100 empleados sin planta propia de tratamiento → SI por defecto.
- esg: rating público (MSCI, Sustainalytics, S&P Global) o nota cualitativa ('sin reporte público', 'memoria GRI sin rating', 'greenwashing detectado', 'B Corp', 'ISO 14001').

Para candidatos ESTRATÉGICOS (OPHS >= 70) genera dictamen segmentado: IIA (transparencia datos públicos), Factory (m² planta vs unidad BioHybrid), Finance (ROI in-situ vs transporte), Pactvm Viridi/CIBE (sello circular).

SALIDA: SOLO JSON válido, sin markdown, sin texto extra. Schema:
{
  "results": [
    {
      "nodo": "string (nombre empresa)",
      "sector": "string",
      "ubicacion": "Ciudad, País",
      "ophs": 0-100,
      "bssMwh": number (MWh estimados 48h),
      "cnmc": "OK" | "RIESGO" | "SANCION",
      "variableB": "string (resumen BSS/resilience)",
      "variableG": "string (gobernanza Herzog)",
      "variableU2": "string (reto U-2)",
      "porQue": "string (por qué el sistema la detecta como buena empresa)",
      "tipoResiduo": "string (categoría residuo orgánico: vinaza, orujo, suero lácteo, restos cárnicos, FORM, hortofrutícola, etc.)",
      "volumenResiduoT": number (toneladas/año estimadas, residuo orgánico),
      "residuoAnualT": number (alias retrocompatible de volumenResiduoT),
      "plantas": number (número de plantas/centros productivos),
      "empleados": number (plantilla total estimada),
      "facturacionM": number (facturación anual estimada en millones de euros),
      "pagaGestion": "SI" | "NO" | "DESCONOCIDO" (si actualmente paga a un gestor externo por el residuo),
      "esg": "string (rating ESG público o nota corta: ej. 'A', 'B+', 'sin reporte', 'greenwashing detectado')",
      "fuentes": ["string (fuente o proxy usado para estimar, ej. 'eInforma 2024', 'LinkedIn size band', 'estimación sectorial vinícola')"],
      "modelo": "B2B" | "B2C" | "B2B/B2C",
      "dictamen": {
        "iia": "string",
        "factory": "string",
        "finance": "string",
        "pactvm": "string"
      },
      "descartar": boolean,
      "razonDescarte": "string o vacío"
    }
  ],
  "resumen": "string corto del barrido"
}

EJEMPLO de ficha completa correcta (referencia de estilo y profundidad de relleno):
{
  "nodo": "Bodegas García Carrión",
  "sector": "Vinícola",
  "ubicacion": "Jumilla, España",
  "ophs": 78,
  "bssMwh": 4.5,
  "cnmc": "OK",
  "tipoResiduo": "Orujo + lías + raspón (vinaza)",
  "volumenResiduoT": 95000,
  "plantas": 7,
  "empleados": 1100,
  "facturacionM": 825,
  "pagaGestion": "SI",
  "esg": "Memoria sostenibilidad publicada, sin rating MSCI",
  "fuentes": ["web corporativa centros productivos", "eInforma 2023", "estimación sectorial vinícola 0.4 T residuo/T uva"],
  "modelo": "B2B/B2C",
  "porQue": "Mayor bodega europea, alto volumen residuo concentrado, 7 plantas con espacio físico para BSS, sin dependencia biogás",
  "variableB": "Espacio amplio en planta Jumilla para BSS 4-5 MWh; resiliencia 48h viable",
  "variableG": "Estructura familiar, sin PPA largo plazo con eléctrica → gobernanza OEM compatible",
  "variableU2": "Orujo estándar, no requiere I+D U-2 salvo subproducto enológico específico",
  "dictamen": { "iia": "Memoria GRI publica, datos volúmenes plausibles", "factory": "Jumilla 15.000 m² → unidad BioHybrid L cabe", "finance": "Ahorro logístico ~280 k€/año vs transporte gestor", "pactvm": "Apta sello CIBE tras NDA y auditoría F4 Herzog" },
  "descartar": false,
  "razonDescarte": ""
}

Si no encuentras candidatos reales con datos públicos verificables, devuelve results vacío y explica en resumen. Nunca inventes datos financieros precisos como cifras exactas con decimales no soportados; pero SIEMPRE estima con un número plausible y registra el proxy en "fuentes". Campos numéricos null/0 = error crítico.`;

/* ---------- LinkedIn Finder (IA · sugerencias de contactos) ---------- */
const LINKEDIN_SYSTEM = `Eres el módulo "LinkedIn Finder" del Agente S-NFI dentro de Rëff (SYSTEMS).

Tu tarea: dada una empresa cliente potencial (Nodo S-NFI), proponer perfiles tipo de decision-makers y operadores clave que conviene contactar en LinkedIn para abrir conversación sobre integración S-NFI BioHybrid + Physical AI + gobernanza OPHS.

REGLAS:
- NO inventes nombres reales ni URLs concretas. Devuelve PERFILES TIPO (rol, seniority, área) que se pueden buscar.
- Para cada perfil construye una URL de BÚSQUEDA real en LinkedIn (https://www.linkedin.com/search/results/people/?keywords=...) con keywords + nombre de empresa codificados.
- Prioriza roles que tocan: sostenibilidad, operaciones de planta, energía/utilities, gestión de residuos, innovación/I+D, compliance regulatorio (CNMC), CFO/CapEx.
- Ordena por prioridadOutreach (1 = primero a contactar).
- Da un "anguloApertura" breve y específico al sector/contexto de la empresa, alineado a S-NFI (resiliencia BSS, in-situ vs transporte, soberanía energética OPHS).

SALIDA: SOLO JSON válido, sin markdown:
{
  "contactos": [
    {
      "rol": "string (ej. Director de Sostenibilidad)",
      "area": "string (Sostenibilidad | Operaciones | Energía | Innovación | Finanzas | Compliance | C-Suite)",
      "seniority": "C-Suite | VP | Director | Manager | Lead",
      "keywords": ["string", "..."],
      "searchUrl": "https://www.linkedin.com/search/results/people/?keywords=...",
      "prioridadOutreach": 1,
      "anguloApertura": "string corto"
    }
  ],
  "notaEstrategica": "string corto"
}`;

/* ---------- Email Creator (IA · plantillas políticas S-NFI) ---------- */
const EMAIL_SYSTEM = `Eres el módulo "Email Creator" del Agente S-NFI dentro de Rëff (SYSTEMS).

Generas correos de outreach corporativo en NOMBRE de South-Navarre Fresh Innovations Corp. (S-NFI), OEM deep-tech de infraestructura industrial modular. Tecnología núcleo: S-NFI BioHybrid (BioGrinder + BioDeshidratador → biopellet 7–8%) + Physical AI + Gobernanza OPHS.

PRINCIPIOS DE ESTILO S-NFI:
- Tono: serio, técnico-industrial, soberano. Nada de marketing verde blando. Nada de emojis. Nada de exclamaciones.
- Español de España. Frases cortas. No promesas vacías.
- Posicionar S-NFI como infraestructura OEM, no proveedor de servicios.
- Si se cita resiliencia: hablar de autonomía post-apagón (48h) y vulnerabilidad CNMC.
- NDA: encuadrar como prerrequisito de transferencia técnica controlada, no como trámite.
- Firma cierre: "— Equipo S-NFI · South Navarre Fresh Innovations Corp."

SITUACIONES SOPORTADAS:
1. "primer_contacto" → toma de contacto inicial alineada al sector/residuo de la empresa.
2. "solicitud_nda" → segunda iteración solicitando NDA para abrir datos técnicos / cifras.

SALIDA: SOLO JSON válido, sin markdown:
{
  "asunto": "string (max 90 chars)",
  "preheader": "string (max 110 chars, opcional)",
  "cuerpoTexto": "string (texto plano, saltos de línea con \\n, listo para pegar)",
  "cuerpoHtml": "string (HTML simple <p>/<ul>, sin estilos inline ni imágenes)",
  "siguientePaso": "string corto (qué esperamos del destinatario)"
}`;

/* Historial de búsquedas: por tenant (cada búsqueda es de un usuario con sesión), 30 por
   usuario como máximo y 48 h de vida, que aplica el índice TTL de expiresAt. */
const SEARCH_HISTORY = 'search_history';
const SEARCH_HISTORY_MAX = 30;
const SEARCH_HISTORY_TTL_MS = 48 * 3600 * 1000;

function historyDoc(user, { id, ...entry }) {
  const createdMs = Date.parse(entry.createdAt);
  const base = Number.isFinite(createdMs) ? createdMs : Date.now();
  return { _id: String(id), user, ...entry, expiresAt: new Date(base + SEARCH_HISTORY_TTL_MS) };
}

/** Importa data/search_history.json ({ usuario: [búsquedas] }) sin las que ya caducaron. */
export function migrateSearchHistoryFile(db, file) {
  return migrateJsonOnce(db, 'search_history.json', file, async (data) => {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return 0;
    const now = Date.now();
    const docs = Object.entries(data).flatMap(([user, list]) => (Array.isArray(list) ? list : [])
      .filter((entry) => entry && entry.id)
      .map((entry) => historyDoc(user, entry))
      .filter((doc) => doc.expiresAt.getTime() > now));
    return insertIgnoringDuplicates(db.collection(SEARCH_HISTORY), docs);
  });
}

export function mountReffCrm(app, {
  auth, mongo, withTransaction, adminNotify,
  readElvira,
}) {
  /* ---------- sheet helpers ---------- */
  async function ensureUserSheets(user) {
    const count = await mongo.collection('sheets').countDocuments({ user });
    if (count === 0) {
      await mongo.collection('sheets').insertOne({
        _id: crypto.randomUUID(),
        user,
        name: 'Hoja principal',
        createdAt: new Date().toISOString(),
      });
    }
  }

  async function callLlmText(system, prompt, maxTokens, user, operation, mesa = 'reff') {
    const result = await callLlm({ system, prompt, maxTokens, mesa, user, operation });
    return result.text;
  }
  const searchNodes = (prompt, user) => callLlmText(SYSTEM_PROMPT, prompt, 8192, user, 'search');

  // Sin IA configurada, las rutas responden 503 con el motivo y sin avisar al Admin: es configuración, no avería.
  function failLlmRoute(res, ex, logTag, label, fallback) {
    if (isLlmUnavailable(ex)) return res.status(503).json({ error: ex.message });
    console.error(logTag, ex);
    adminNotify({ origin: 'REFF', label, detail: ex.message, severity: 'error' });
    res.status(500).json({ error: ex.message || fallback });
  }

  /* ---------- sheets ---------- */
  app.get('/api/sheets', auth, async (req, res) => {
    await ensureUserSheets(req.user);
    const rows = await mongo.collection('sheets').aggregate([
      { $match: { user: req.user } },
      { $lookup: {
          from: 'companies',
          localField: '_id',
          foreignField: 'sheetId',
          as: 'companies',
      } },
      { $addFields: { count: { $size: '$companies' } } },
      { $project: { companies: 0 } },
    ]).toArray();
    res.json(rows.map(r => ({ id: r._id, user: r.user, name: r.name, createdAt: r.createdAt, count: r.count })));
  });

  app.post('/api/sheets', auth, async (req, res) => {
    const name = String((req.body || {}).name || '').trim();
    if (!name) return res.status(400).json({ error: 'nombre requerido' });
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    await mongo.collection('sheets').insertOne({ _id: id, user: req.user, name, createdAt });
    res.status(201).json({ id, name, count: 0, createdAt });
  });

  app.delete('/api/sheets/:sid', auth, async (req, res) => {
    const userSheetCount = await mongo.collection('sheets').countDocuments({ user: req.user });
    if (userSheetCount <= 1) return res.status(400).json({ error: 'no se puede eliminar la única hoja' });

    const sheet = await mongo.collection('sheets').findOne({ _id: req.params.sid, user: req.user });
    if (!sheet) return res.status(404).json({ error: 'hoja no encontrada' });

    await withTransaction(async (session) => {
      await mongo.collection('companies').deleteMany({ sheetId: req.params.sid }, { session });
      await mongo.collection('sheets').deleteOne({ _id: req.params.sid, user: req.user }, { session });
    });
    res.json({ id: req.params.sid });
  });

  /* ---------- companies ---------- */
  app.get('/api/sheets/:sid/companies', auth, async (req, res) => {
    const sheet = await mongo.collection('sheets').findOne({ _id: req.params.sid, user: req.user });
    if (!sheet) return res.json([]);
    const rows = await mongo.collection('companies').find({ sheetId: req.params.sid }).toArray();
    res.json(rows.map(r => ({ ...r, id: r._id, tareas: r.tareas || [] })));
  });

  app.post('/api/sheets/:sid/companies', auth, async (req, res) => {
    const sheet = await mongo.collection('sheets').findOne({ _id: req.params.sid, user: req.user });
    if (!sheet) return res.status(404).json({ error: 'hoja no encontrada' });

    const b = req.body || {};
    const c = {
      _id: crypto.randomUUID(),
      sheetId: req.params.sid,
      nodo: String(b.nodo || '').trim(),
      sector: String(b.sector || '').trim(),
      ubicacion: String(b.ubicacion || '').trim(),
      ophs: Number(b.ophs ?? 0),
      bssMwh: Number(b.bssMwh ?? 0),
      cnmc: String(b.cnmc || 'OK').trim(),
      dictamen: b.dictamen, notas: b.notas, tipoResiduo: b.tipoResiduo,
      volumenResiduoT: b.volumenResiduoT, plantas: b.plantas, empleados: b.empleados,
      facturacionM: b.facturacionM, pagaGestion: b.pagaGestion, esg: b.esg,
      tareas: normalizeTareas(b.tareas),
      createdAt: new Date().toISOString(),
      source: 'manual'
    };

    if (!c.nodo) return res.status(400).json({ error: 'nodo requerido' });

    await mongo.collection('companies').insertOne(c);

    res.status(201).json({ ...c, id: c._id });
  });

  app.put('/api/sheets/:sid/companies/:cid', auth, async (req, res) => {
    const c = await mongo.collection('companies').findOne({ _id: req.params.cid });
    if (!c) return res.status(404).json({ error: 'empresa no encontrada' });
    const sheet = await mongo.collection('sheets').findOne({ _id: c.sheetId, user: req.user });
    if (!sheet) return res.status(404).json({ error: 'empresa no encontrada' });

    const allowed = ['nodo','sector','ubicacion','ophs','bssMwh','cnmc','dictamen','notas','tareas','tipoResiduo','volumenResiduoT','plantas','empleados','facturacionM','pagaGestion','esg'];
    const $set = {};
    for (const k of allowed) {
      if (k in req.body) {
        $set[k] = k === 'tareas' ? normalizeTareas(req.body[k]) : req.body[k];
      }
    }

    if (Object.keys($set).length > 0) {
      await mongo.collection('companies').updateOne({ _id: req.params.cid }, { $set });
    }

    const updated = await mongo.collection('companies').findOne({ _id: req.params.cid });
    res.json({ ...updated, id: updated._id, tareas: updated.tareas || [] });
  });

  app.delete('/api/sheets/:sid/companies/:cid', auth, async (req, res) => {
    const c = await mongo.collection('companies').findOne({ _id: req.params.cid });
    if (!c) return res.status(404).json({ error: 'empresa no encontrada' });
    const sheet = await mongo.collection('sheets').findOne({ _id: c.sheetId, user: req.user });
    if (!sheet) return res.status(404).json({ error: 'empresa no encontrada' });

    await mongo.collection('companies').deleteOne({ _id: req.params.cid });
    res.json({ id: req.params.cid });
  });

  /* move company between sheets */
  app.post('/api/companies/:cid/move', auth, async (req, res) => {
    const { fromSheetId, toSheetId } = req.body || {};
    if (!fromSheetId || !toSheetId) return res.status(400).json({ error: 'fromSheetId/toSheetId requeridos' });

    const sheet = await mongo.collection('sheets').findOne({ _id: fromSheetId, user: req.user });
    if (!sheet) return res.status(404).json({ error: 'no se pudo mover la empresa' });

    const result = await mongo.collection('companies').updateOne(
      { _id: req.params.cid, sheetId: fromSheetId },
      { $set: { sheetId: toSheetId } },
    );

    if (result.matchedCount === 0) return res.status(404).json({ error: 'no se pudo mover la empresa' });
    res.json({ id: req.params.cid, sheetId: toSheetId });
  });

  /* aggregate for Dashboard General across all sheets */
  app.get('/api/overview', auth, async (req, res) => {
    const sheets = await mongo.collection('sheets').find({ user: req.user }).project({ _id: 1, name: 1 }).toArray();
    const sheetIds = sheets.map(s => s._id);

    const [stats] = await mongo.collection('companies').aggregate([
      { $match: { sheetId: { $in: sheetIds } } },
      { $group: {
          _id: null,
          totalCompanies: { $sum: 1 },
          totalBss: { $sum: '$bssMwh' },
          avgOphs: { $avg: '$ophs' },
          cnmcRiesgo: { $sum: { $cond: [{ $ne: ['$cnmc', 'OK'] }, 1, 0] } },
      } },
    ]).toArray();

    const top = await mongo.collection('companies').aggregate([
      { $match: { sheetId: { $in: sheetIds } } },
      { $lookup: { from: 'sheets', localField: 'sheetId', foreignField: '_id', as: 'sheet' } },
      { $addFields: { sheetName: { $first: '$sheet.name' } } },
      { $project: { sheet: 0 } },
      { $sort: { ophs: -1 } },
      { $limit: 5 },
    ]).toArray();

    res.json({
      sheets: sheets.length,
      companies: stats?.totalCompanies || 0,
      totalBssMwh: Number((stats?.totalBss || 0).toFixed(1)),
      avgOphs: Math.round(stats?.avgOphs || 0),
      cnmcRiesgo: stats?.cnmcRiesgo || 0,
      top: top.map(t => ({ ...t, id: t._id, tareas: t.tareas || [] })),
    });
  });

  /* ---------- search history (per user, 48h) ---------- */
  const historyCol = () => mongo.collection(SEARCH_HISTORY);

  async function listHistory(user) {
    const rows = await historyCol()
      .find({ user, expiresAt: { $gt: new Date() } })
      .sort({ createdAt: -1 })
      .limit(SEARCH_HISTORY_MAX)
      .toArray();
    return rows.map(({ _id, user: _user, expiresAt, ...entry }) => ({ id: _id, ...entry }));
  }

  async function addHistory(user, entry) {
    await historyCol().insertOne(historyDoc(user, entry));
    const surplus = await historyCol()
      .find({ user }, { projection: { _id: 1 } })
      .sort({ createdAt: -1 })
      .skip(SEARCH_HISTORY_MAX)
      .toArray();
    if (surplus.length) await historyCol().deleteMany({ _id: { $in: surplus.map((d) => d._id) } });
  }

  app.get('/api/search/history', auth, async (req, res) => {
    res.json(await listHistory(req.user));
  });

  app.delete('/api/search/history/:hid', auth, async (req, res) => {
    const { deletedCount } = await historyCol().deleteOne({ _id: String(req.params.hid), user: req.user });
    if (!deletedCount) return res.status(404).json({ error: 'no encontrada' });
    res.json({ ok: true });
  });

  app.post('/api/search', auth, async (req, res) => {
    try {
      const f = req.body || {};
      const continente = String(f.continente || '').trim();
      const pais       = String(f.pais || '').trim();
      const ciudad     = String(f.ciudad || '').trim();
      const sectoresArr= Array.isArray(f.sectores) ? f.sectores.filter(Boolean).map(String) : [];
      const sector     = sectoresArr.length ? sectoresArr.join(', ') : String(f.sector || '').trim();
      const modelo     = String(f.modelo || 'B2B/B2C').trim();
      const minResiduoT= 8; // suelo duro S-NFI: > 8 T/año residuo orgánico
      const maxResults = Math.min(Math.max(Number(f.maxResults ?? 6), 1), 12);
      const extra      = String(f.extra || '').trim();

      const userPrompt = `BARRIDO de Nodos de Integración Potencial para S-NFI.

FILTROS JURISDICCIÓN:
- Continente: ${continente || 'cualquiera'}
- País: ${pais || 'cualquiera'}
- Ciudad/Región: ${ciudad || 'cualquiera'}

FILTROS DE ELEGIBILIDAD:
- Volumen mínimo residuo orgánico anual: ${minResiduoT} T/año
- Residuo: 100% orgánico
- Modelo: ${modelo}
- Sector preferido: ${sector || 'agroalimentario, vinícola, ganadero, hortofrutícola, conservero, lácteo, cárnico, panificación industrial, restauración colectiva'}

CONTEXTO ADICIONAL DEL OPERADOR: ${extra || '(ninguno)'}

Devuelve hasta ${maxResults} empresas REALES (con nombre verificable) que encajen. PREFIERE profundidad sobre cantidad: mejor 3 empresas con ficha completa que 8 a medias.

CHECKLIST OBLIGATORIO antes de emitir JSON (revisa empresa a empresa):
[ ] nodo es nombre real verificable, no genérico.
[ ] tipoResiduo no está vacío.
[ ] volumenResiduoT es número > 8 (no null, no 0).
[ ] plantas es entero >= 1.
[ ] empleados es entero > 0.
[ ] facturacionM es número > 0.
[ ] pagaGestion es SI, NO o DESCONOCIDO (preferir SI/NO).
[ ] esg tiene texto descriptivo, no vacío.
[ ] fuentes lista al menos 1 proxy/fuente.

Si un campo no se puede estimar ni siquiera por proxy, descarta esa empresa antes que devolverla con ficha rota.

SOLO JSON.`;

      const raw = await searchNodes(userPrompt, req.user);
      const parsed = extractJson(raw);
      const results = Array.isArray(parsed.results) ? parsed.results : [];

      const entry = {
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        filters: { continente, pais, ciudad, sector, sectores: sectoresArr, modelo, minResiduoT, maxResults, extra },
        resumen: parsed.resumen || '',
        results,
      };
      await addHistory(req.user, entry);

      res.json(entry);
    } catch (ex) {
      failLlmRoute(res, ex, '[search]', 'Búsqueda IA · fallo', 'error en búsqueda');
    }
  });

  /* add a search result directly to a sheet */
  app.post('/api/sheets/:sid/companies/from-search', auth, async (req, res) => {
    const sheet = await mongo.collection('sheets').findOne({ _id: req.params.sid, user: req.user });
    if (!sheet) return res.status(404).json({ error: 'hoja no encontrada' });

    const r = req.body || {};
    if (!r.nodo) return res.status(400).json({ error: 'nodo requerido' });
    const dict = r.dictamen && typeof r.dictamen === 'object' ? r.dictamen : {};
    const dictLine = [
      dict.iia     && `IIA: ${dict.iia}`,
      dict.factory && `Factory: ${dict.factory}`,
      dict.finance && `Finance: ${dict.finance}`,
      dict.pactvm  && `Pactvm: ${dict.pactvm}`,
    ].filter(Boolean).join(' · ');
    const volumen = r.volumenResiduoT != null && r.volumenResiduoT !== ''
      ? Number(r.volumenResiduoT)
      : (r.residuoAnualT != null && r.residuoAnualT !== '' ? Number(r.residuoAnualT) : null);
    const fuentesArr = Array.isArray(r.fuentes) ? r.fuentes.filter(Boolean).map(String) : [];
    const notas = [
      r.porQue && `Por qué: ${r.porQue}`,
      r.variableB && `B (BSS): ${r.variableB}`,
      r.variableG && `G (Herzog): ${r.variableG}`,
      r.variableU2 && `U-2: ${r.variableU2}`,
      volumen != null && `Residuo ${volumen} T/año`,
      r.tipoResiduo && `Tipo residuo: ${r.tipoResiduo}`,
      r.modelo && `Modelo ${r.modelo}`,
      fuentesArr.length && `Fuentes: ${fuentesArr.join(' · ')}`,
    ].filter(Boolean).join('\n');
    const c = {
      _id: crypto.randomUUID(),
      sheetId: req.params.sid,
      nodo: String(r.nodo).trim(),
      sector: String(r.sector || '').trim(),
      ubicacion: String(r.ubicacion || '').trim(),
      ophs: Number(r.ophs ?? 0),
      bssMwh: Number(r.bssMwh ?? 0),
      cnmc: String(r.cnmc || 'OK').trim(),
      dictamen: dictLine || String(r.dictamen || ''),
      notas,
      tipoResiduo: String(r.tipoResiduo || '').trim(),
      volumenResiduoT: volumen,
      plantas: r.plantas != null && r.plantas !== '' ? Number(r.plantas) : null,
      empleados: r.empleados != null && r.empleados !== '' ? Number(r.empleados) : null,
      facturacionM: r.facturacionM != null && r.facturacionM !== '' ? Number(r.facturacionM) : null,
      pagaGestion: String(r.pagaGestion || 'DESCONOCIDO').trim(),
      esg: String(r.esg || '').trim(),
      tareas: [],
      createdAt: new Date().toISOString(),
      source: 'search',
    };

    await mongo.collection('companies').insertOne(c);

    res.status(201).json({ ...c, id: c._id, tareas: [] });
  });

  /* ---------- companies (cross-sheet helpers para LinkedIn / Email) ---------- */
  app.get('/api/companies/all', auth, async (req, res) => {
    const sheets = await mongo.collection('sheets').find({ user: req.user }).project({ _id: 1, name: 1 }).toArray();
    const sheetMap = new Map(sheets.map(s => [s._id, s.name]));
    const all = await mongo.collection('companies').find({ sheetId: { $in: sheets.map(s => s._id) } }).toArray();
    res.json(all.map(c => ({ ...c, id: c._id, sheetName: sheetMap.get(c.sheetId) })));
  });

  /*
   * GET /api/companies/:cid/dictamen
   * Dictamen de Soberanía descargable: snapshot consolidado del nodo
   * (OPHS, BSS, estado CNMC, dictamen departamental) + huella CNMC si existe
   * auditoría previa. Pensado para entregar a una empresa que pide pruebas
   * de una evaluación o discrepancia detectada.
   */
  app.get('/api/companies/:cid/dictamen', auth, async (req, res) => {
    const sheets = await mongo.collection('sheets').find({ user: req.user }).project({ _id: 1, name: 1 }).toArray();
    const sheetIds = sheets.map(s => s._id);
    const sheetMap = new Map(sheets.map(s => [s._id, s.name]));

    const c = await mongo.collection('companies').findOne({ _id: req.params.cid, sheetId: { $in: sheetIds } });
    if (!c) return res.status(404).json({ error: 'empresa no encontrada' });

    const state = await readElvira();
    const cnmcAuditLog = (state.cnmc?.auditLog || []).filter(a => a.companyId === c._id || a.nodo === c.nodo);

    res.json({
      tipo:        'DICTAMEN_DE_SOBERANIA',
      generadoEn:  new Date().toISOString(),
      generadoPor: req.user,
      nodo:        c.nodo,
      sector:      c.sector || null,
      ubicacion:   c.ubicacion || null,
      sheetName:   sheetMap.get(c.sheetId) || null,
      puntuacionOphs: c.ophs ?? null,
      resilienceBss:  { mwh: c.bssMwh ?? null, descripcion: 'MWh estimados para 48h post-apagón' },
      estadoCnmc:     c.cnmc ?? 'OK',
      opsBlocked:     c.opsBlocked || false,
      dictamenDepartamental: c.dictamen || null,
      ficha: {
        tipoResiduo:      c.tipoResiduo ?? null,
        volumenResiduoT:  c.volumenResiduoT ?? null,
        plantas:          c.plantas ?? null,
        empleados:        c.empleados ?? null,
        facturacionM:     c.facturacionM ?? null,
        esg:              c.esg ?? null,
      },
      auditoriasCnmc: cnmcAuditLog,
    });
  });

  app.post('/api/linkedin', auth, async (req, res) => {
    try {
      const { companyId } = req.body || {};
      if (!companyId) return res.status(400).json({ error: 'companyId requerido' });
      const targetDoc = await mongo.collection('companies').findOne({ _id: companyId });
      if (!targetDoc) return res.status(404).json({ error: 'empresa no encontrada' });
      const sheet = await mongo.collection('sheets').findOne({ _id: targetDoc.sheetId, user: req.user });
      if (!sheet) return res.status(404).json({ error: 'empresa no encontrada' });
      const target = { ...targetDoc, id: targetDoc._id, sheetName: sheet.name };

      const prompt = `EMPRESA OBJETIVO:
- NODO: ${target.nodo}
- Sector: ${target.sector || 'n/d'}
- Ubicación: ${target.ubicacion || 'n/d'}
- OPHS: ${target.ophs || 0}/100
- BSS estimado: ${target.bssMwh || 0} MWh
- CNMC: ${target.cnmc || 'OK'}
- Tipo residuo: ${target.tipoResiduo || 'n/d'}
- Volumen residuo: ${target.volumenResiduoT != null ? target.volumenResiduoT + ' T/año' : 'n/d'}
- Plantas: ${target.plantas ?? 'n/d'}
- Empleados: ${target.empleados ?? 'n/d'}
- Facturación: ${target.facturacionM != null ? target.facturacionM + ' M€' : 'n/d'}
- Paga gestión: ${target.pagaGestion || 'DESCONOCIDO'}
- ESG: ${target.esg || 'n/d'}
- Notas: ${(target.notas || '').slice(0, 600)}
- Dictamen: ${(target.dictamen || '').slice(0, 600)}

Devuelve 5–8 perfiles tipo priorizados para outreach LinkedIn alineado a S-NFI. SOLO JSON.`;

      const raw = await callLlmText(LINKEDIN_SYSTEM, prompt, 2048, req.user, 'linkedin');
      const parsed = extractJson(raw);
      const contactos = Array.isArray(parsed.contactos) ? parsed.contactos : [];

      // sanitize / re-build searchUrl by hand to ensure validity
      const cleaned = contactos.map(c => {
        const kw = Array.isArray(c.keywords) ? c.keywords.join(' ') : (c.rol || '');
        const q = `${kw} ${target.nodo}`.trim();
        return {
          rol: String(c.rol || '').trim(),
          area: String(c.area || '').trim(),
          seniority: String(c.seniority || '').trim(),
          keywords: Array.isArray(c.keywords) ? c.keywords.slice(0, 8) : [],
          searchUrl: 'https://www.linkedin.com/search/results/people/?keywords=' + encodeURIComponent(q),
          prioridadOutreach: Number(c.prioridadOutreach || 99),
          anguloApertura: String(c.anguloApertura || '').trim(),
        };
      }).sort((a, b) => a.prioridadOutreach - b.prioridadOutreach);

      res.json({
        company: { id: target.id, nodo: target.nodo, sector: target.sector, ubicacion: target.ubicacion },
        contactos: cleaned,
        notaEstrategica: parsed.notaEstrategica || '',
        generatedAt: new Date().toISOString(),
      });
    } catch (ex) {
      failLlmRoute(res, ex, '[linkedin]', 'LinkedIn Finder · fallo', 'error LinkedIn Finder');
    }
  });

  app.post('/api/email', auth, async (req, res) => {
    try {
      const { companyId, situacion, destinatarioRol, tonoExtra } = req.body || {};
      if (!companyId) return res.status(400).json({ error: 'companyId requerido' });
      const sit = situacion === 'solicitud_nda' ? 'solicitud_nda' : 'primer_contacto';
      const target = await mongo.collection('companies').findOne({ _id: companyId });
      if (!target) return res.status(404).json({ error: 'empresa no encontrada' });
      const sheet = await mongo.collection('sheets').findOne({ _id: target.sheetId, user: req.user });
      if (!sheet) return res.status(404).json({ error: 'empresa no encontrada' });

      const prompt = `SITUACIÓN: ${sit}
DESTINATARIO (rol/perfil): ${destinatarioRol || 'Decision-maker industrial'}
CONTEXTO EXTRA OPERADOR: ${tonoExtra || '(ninguno)'}

EMPRESA OBJETIVO:
- NODO: ${target.nodo}
- Sector: ${target.sector || 'n/d'}
- Ubicación: ${target.ubicacion || 'n/d'}
- OPHS: ${target.ophs || 0}/100
- BSS estimado: ${target.bssMwh || 0} MWh / 48h
- Estado CNMC: ${target.cnmc || 'OK'}
- Tipo residuo: ${target.tipoResiduo || 'n/d'}
- Volumen residuo: ${target.volumenResiduoT != null ? target.volumenResiduoT + ' T/año' : 'n/d'}
- Plantas: ${target.plantas ?? 'n/d'}
- Empleados: ${target.empleados ?? 'n/d'}
- Facturación: ${target.facturacionM != null ? target.facturacionM + ' M€' : 'n/d'}
- Paga gestión externa: ${target.pagaGestion || 'DESCONOCIDO'}
- ESG: ${target.esg || 'n/d'}
- Notas internas: ${(target.notas || '').slice(0, 800)}
- Dictamen interno: ${(target.dictamen || '').slice(0, 800)}

Redacta el email para esta situación, anclado al sector y a las variables S-NFI relevantes. SOLO JSON.`;

      const raw = await callLlmText(EMAIL_SYSTEM, prompt, 2048, req.user, 'email');
      const parsed = extractJson(raw);

      res.json({
        company: { id: target._id, nodo: target.nodo, sector: target.sector, ubicacion: target.ubicacion },
        situacion: sit,
        destinatarioRol: destinatarioRol || '',
        asunto: String(parsed.asunto || '').trim(),
        preheader: String(parsed.preheader || '').trim(),
        cuerpoTexto: String(parsed.cuerpoTexto || '').trim(),
        cuerpoHtml: String(parsed.cuerpoHtml || '').trim(),
        siguientePaso: String(parsed.siguientePaso || '').trim(),
        generatedAt: new Date().toISOString(),
      });
    } catch (ex) {
      failLlmRoute(res, ex, '[email]', 'Email Creator · fallo', 'error Email Creator');
    }
  });

  return { ensureUserSheets, callLlmText, extractJson };
}
