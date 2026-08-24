/**
 * CNMC · Embudo Legal + Buscador híbrido
 *
 * Embudo Legal: ingesta documental regulatoria + auditoría de asimetría
 * (declarado en CRM vs dato oficial CNMC), con huella forense Sentinel si
 * detecta fraude/incumplimiento.
 *
 * Buscador híbrido: 1) consulta la API pública CNMC
 * (numeracionyoperadores.cnmc.es) para datos de registro actualizados,
 * 2) el LLM enriquece con contexto regulatorio usando esos datos reales.
 *
 * callLLMTracked/extractJson son las mismas utilidades de reff-crm.routes.js
 * (T'Controler/tracking de tokens compartido) — se reciben como dependencia
 * en vez de reimplementarlas.
 */

import crypto from 'node:crypto';

const CNMC_API_BASE = 'https://numeracionyoperadores.cnmc.es';

async function fetchCnmcOperadores(nombre) {
  const { default: https } = await import('node:https');
  const encoded = encodeURIComponent(nombre);
  const url = `${CNMC_API_BASE}/api/operador/get_busqueda_operadores?nombre=${encoded}`;
  return new Promise((resolve) => {
    https.get(url, { headers: { 'User-Agent': 'Elvi-Ra/1.0 (S-NFI Corp; regulatorio)', 'Accept': 'application/json' } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch { resolve([]); }
      });
    }).on('error', () => resolve([]));
  });
}

const CNMC_ENRICH_SYSTEM = `Eres el módulo "CNMC Intelligence" del agente Rëff dentro de Elvi-Ra.

Se te proporcionan datos REALES y ACTUALIZADOS del Registro Oficial de Operadores de la CNMC (numeracionyoperadores.cnmc.es) sobre una empresa. Tu tarea es:

1. Interpretar los datos de registro oficial (servicios autorizados, ámbito, fechas de resolución)
2. Añadir contexto regulatorio adicional que conozcas: expedientes sancionadores, RIPRE/RAIPRE, informes CNMC, régimen retributivo energético si aplica
3. Evaluar el perfil de compliance según el marco OPHS de S-NFI

DATOS REALES DE REGISTRO CNMC: se proporcionan en el prompt del usuario como JSON.

VARIABLES A COMPLETAR (combina datos reales + tu conocimiento):
- registroOficial: resumen de servicios autorizados por CNMC (extrae de los datos reales)
- servicios: lista de servicios y ámbitos registrados
- sanciones: "ninguna conocida" o descripción de expediente sancionador si lo conoces
- expedientes: "ninguno conocido" o descripción
- regimen: régimen retributivo energético si aplica (mercado libre, RECORE, prima regulada)
- potenciaInstalada: MW registrados si aplica
- volumenResiduoT: toneladas residuo orgánico si aplica
- obligacionesIncumplidas: lista de incumplimientos conocidos
- estadoCompliance: "APTO" | "OBSERVACION" | "EXPEDIENTE_ACTIVO" | "SANCIONADO"
- perfilOperador: descripción del perfil como operador CNMC relevante para S-NFI

REGLA CRÍTICA: Los datos del registro oficial son VERIFICADOS y tienen prioridad absoluta. Lo que añades del LLM marca confianza MEDIA o BAJA. No inventes datos — usa null y explica en notas.

SALIDA: SOLO JSON válido, sin markdown:
{
  "empresa": "string",
  "cif": "string | null",
  "periodo": "string",
  "fuente": "string",
  "confianza": "ALTA | MEDIA | BAJA",
  "registroOficial": { "encontrado": boolean, "nombreRegistrado": "string | null", "nif": "string | null", "domicilio": "string | null", "fechaAltaRegistro": "string | null", "totalServicios": number },
  "datos": {
    "servicios": [{"nombre": "string", "tipo": "string", "ambito": "string", "fechaResolucion": "string"}],
    "sanciones": "string",
    "expedientes": "string",
    "regimen": "string | null",
    "potenciaInstalada": number | null,
    "volumenResiduoT": number | null,
    "obligacionesIncumplidas": [],
    "estadoCompliance": "APTO | OBSERVACION | EXPEDIENTE_ACTIVO | SANCIONADO",
    "perfilOperador": "string | null"
  },
  "notas": "string",
  "recomiendaIngest": boolean
}`;

export function mountCnmc(app, {
  auth, mongo, busEmit, busEvents, adminNotify,
  readElvira, writeElvira,
  callLLMTracked, extractJson,
}) {
  /* GET /api/elvira/cnmc/documents — lista documentos ingestados */
  app.get('/api/elvira/cnmc/documents', auth, (req, res) => {
    const state = readElvira();
    if (!state.cnmc) state.cnmc = { documents: [], auditLog: [] };
    res.json(state.cnmc.documents.slice(0, 100));
  });

  /* GET /api/elvira/cnmc/audit-log — historial de auditorias CNMC (asimetria declarado vs CNMC) */
  app.get('/api/elvira/cnmc/audit-log', auth, (req, res) => {
    const state = readElvira();
    if (!state.cnmc) state.cnmc = { documents: [], auditLog: [] };
    res.json(state.cnmc.auditLog.slice(0, 100));
  });

  /*
   * POST /api/elvira/cnmc/ingest
   * Acepta metadatos + datos tabulados de un informe regulatorio CNMC.
   * PDFs reales se procesarán cuando el LLM local esté operativo; por ahora
   * se recibe el extracto ya parseado (JSON) junto con metadatos de fuente.
   *
   * Body esperado:
   * {
   *   empresa:   "Iberdrola S.A.",
   *   cif:       "A95653077",           // opcional
   *   periodo:   "2023",
   *   fuente:    "Informe Anual CNMC 2023 — Actividad Eléctrica",
   *   url:       "https://...",          // opcional, para trazabilidad
   *   datos: {                           // variables extraídas del informe
   *     bssMwh:        number | null,
   *     resiliencia:   string | null,
   *     sanciones:     string | null,    // "ninguna" | "expediente X" | ...
   *     expedientes:   string | null,
   *     [key: string]: any               // cualquier otro parámetro del informe
   *   }
   * }
   */
  app.post('/api/elvira/cnmc/ingest', auth, (req, res) => {
    const b = req.body || {};
    const empresa  = String(b.empresa  || '').trim();
    const periodo  = String(b.periodo  || '').trim();
    const fuente   = String(b.fuente   || '').trim();
    if (!empresa || !fuente) return res.status(400).json({ error: 'empresa y fuente requeridos' });

    const doc = {
      id:         crypto.randomUUID(),
      dataSource: 'CNMC',                     // Dato Jurídico — prioridad absoluta
      empresa,
      cif:        String(b.cif || '').trim() || null,
      periodo,
      fuente,
      url:        String(b.url || '').trim() || null,
      datos:      b.datos && typeof b.datos === 'object' ? b.datos : {},
      ingestedAt: new Date().toISOString(),
      ingestedBy: req.user,
    };

    const state = readElvira();
    if (!state.cnmc) state.cnmc = { documents: [], auditLog: [] };
    state.cnmc.documents.unshift(doc);
    state.cnmc.documents = state.cnmc.documents.slice(0, 500);
    writeElvira(state);

    busEmit({
      id: crypto.randomUUID(), ts: new Date().toISOString(), seq: busEvents.length + 1,
      origin: 'ELVI-RA', dest: 'REFF', type: 'request', state: 'PENDING',
      label: `CNMC INGEST · ${empresa} · ${periodo}`,
      payload: { docId: doc.id, empresa, periodo, fuente, dataSource: 'CNMC' },
      user: req.user,
    });

    res.status(201).json(doc);
  });

  /*
   * POST /api/elvira/cnmc/audit/:companyId
   * Cruza el último documento CNMC ingestado para esa empresa (por nombre)
   * contra los datos del nodo en el CRM.
   * Si detecta asimetría relevante:
   *   — marca la empresa con cnmcAudit: { status:'FAILED', ... }
   *   — pone opsBlocked: true en la empresa
   *   — emite evento bus REFF→OPHS state=BLOCKED
   *   — escribe evento Sentinel con huella forense
   *
   * Body opcional: { docId } para forzar un documento específico.
   */
  app.post('/api/elvira/cnmc/audit/:companyId', auth, async (req, res) => {
    const state = readElvira();
    if (!state.cnmc) state.cnmc = { documents: [], auditLog: [] };

    const targetCompany = await mongo.collection('companies').findOne({ _id: req.params.companyId });
    if (targetCompany) {
      const sheet = await mongo.collection('sheets').findOne({ _id: targetCompany.sheetId, user: req.user });
      if (!sheet) return res.status(404).json({ error: 'empresa no encontrada' });
    }

    if (!targetCompany) return res.status(404).json({ error: 'empresa no encontrada' });

    // Find matching CNMC document — by docId (body) or by empresa name match
    let doc = null;
    const { docId } = req.body || {};
    if (docId) {
      doc = state.cnmc.documents.find(d => d.id === docId);
    } else {
      const nodo = (targetCompany.nodo || '').toLowerCase();
      doc = state.cnmc.documents.find(d =>
        d.empresa.toLowerCase().includes(nodo) || nodo.includes(d.empresa.toLowerCase())
      );
    }
    if (!doc) return res.status(404).json({ error: 'no hay documento CNMC ingestado para esta empresa' });

    const now = new Date().toISOString();
    const cnmcDatos = doc.datos || {};

    // --- Asymmetry detection ---
    const findings = [];

    // BSS / Resilience
    if (cnmcDatos.bssMwh != null && targetCompany.bssMwh != null) {
      const delta = Number(targetCompany.bssMwh) - Number(cnmcDatos.bssMwh);
      const pct   = cnmcDatos.bssMwh !== 0 ? Math.abs(delta / Number(cnmcDatos.bssMwh)) : 0;
      if (pct > 0.10 && delta > 0) {
        findings.push({
          parametro:       'bssMwh',
          valorDeclarado:  targetCompany.bssMwh,
          valorCnmc:       cnmcDatos.bssMwh,
          delta,
          nivel:           'INFRACCION_NIVEL_1',
          descripcion:     `Empresa declara ${targetCompany.bssMwh} MWh BSS; CNMC reporta ${cnmcDatos.bssMwh} MWh. Delta +${delta.toFixed(2)} MWh (${(pct*100).toFixed(1)}%)`,
        });
      }
    }

    // Sanciones / expedientes — cualquier mención no nula en CNMC y estado OK en CRM
    if (cnmcDatos.sanciones && cnmcDatos.sanciones !== 'ninguna' && targetCompany.cnmc === 'OK') {
      findings.push({
        parametro:       'sanciones',
        valorDeclarado:  'OK (CRM)',
        valorCnmc:       cnmcDatos.sanciones,
        delta:           'presencia de expediente no declarado',
        nivel:           'INFRACCION_NIVEL_2',
        descripcion:     `CNMC registra: "${cnmcDatos.sanciones}". Empresa figura como OK en CRM.`,
      });
    }
    if (cnmcDatos.expedientes && cnmcDatos.expedientes !== 'ninguno' && targetCompany.cnmc === 'OK') {
      findings.push({
        parametro:       'expedientes',
        valorDeclarado:  'OK (CRM)',
        valorCnmc:       cnmcDatos.expedientes,
        delta:           'expediente activo no declarado',
        nivel:           'INFRACCION_NIVEL_2',
        descripcion:     `CNMC registra expediente activo: "${cnmcDatos.expedientes}". Empresa figura como OK en CRM.`,
      });
    }

    // Extra custom fields passed in datos — numeric check >10% delta
    for (const [key, cnmcVal] of Object.entries(cnmcDatos)) {
      if (['bssMwh','sanciones','expedientes'].includes(key)) continue;
      const crmVal = targetCompany[key];
      if (crmVal != null && cnmcVal != null && typeof cnmcVal === 'number' && typeof crmVal === 'number') {
        const delta = Number(crmVal) - Number(cnmcVal);
        const pct   = cnmcVal !== 0 ? Math.abs(delta / cnmcVal) : 0;
        if (pct > 0.10 && delta > 0) {
          findings.push({
            parametro:       key,
            valorDeclarado:  crmVal,
            valorCnmc:       cnmcVal,
            delta,
            nivel:           'INFRACCION_NIVEL_1',
            descripcion:     `${key}: declarado ${crmVal}, CNMC reporta ${cnmcVal}. Delta +${delta.toFixed(2)} (${(pct*100).toFixed(1)}%)`,
          });
        }
      }
    }

    const hasFailed = findings.some(f => f.nivel === 'INFRACCION_NIVEL_1' || f.nivel === 'INFRACCION_NIVEL_2');
    const auditStatus = hasFailed ? 'FAILED' : findings.length > 0 ? 'REVIEW' : 'PASSED';
    const worstNivel  = findings.reduce((worst, f) => {
      const order = { INFRACCION_NIVEL_1: 3, INFRACCION_NIVEL_2: 2, INFRACCION_NIVEL_3: 1 };
      return (order[f.nivel] || 0) > (order[worst] || 0) ? f.nivel : worst;
    }, 'SIN_ASIMETRIA');

    const auditRecord = {
      id:          crypto.randomUUID(),
      companyId:   targetCompany._id,
      nodo:        targetCompany.nodo,
      docId:       doc.id,
      fuente:      doc.fuente,
      periodo:     doc.periodo,
      status:      auditStatus,       // PASSED | FAILED | REVIEW
      nivel:       worstNivel,
      findings,
      opsBlocked:  hasFailed,
      auditedAt:   now,
      auditedBy:   req.user,
    };

    // --- Persist audit result on company ---
    targetCompany.cnmcAudit  = auditRecord;
    targetCompany.opsBlocked = hasFailed;
    if (hasFailed && targetCompany.cnmc === 'OK') targetCompany.cnmc = 'RIESGO';

    await mongo.collection('companies').updateOne(
      { _id: targetCompany._id },
      { $set: { cnmc: targetCompany.cnmc, cnmcAudit: auditRecord, opsBlocked: hasFailed } }
    );

    // --- Persist in auditLog ---
    state.cnmc.auditLog.unshift(auditRecord);
    state.cnmc.auditLog = state.cnmc.auditLog.slice(0, 200);
    writeElvira(state);

    // --- Bus event: REFF → OPHS ---
    const busState = hasFailed ? 'BLOCKED' : 'COMPLETED';
    const busLabel = hasFailed
      ? `CNMC_AUDIT_FAILED · ${targetCompany.nodo} · ${findings[0]?.parametro || '?'} · OPS BLOQUEADOS`
      : `CNMC_AUDIT_PASSED · ${targetCompany.nodo}`;
    busEmit({
      id: crypto.randomUUID(), ts: now, seq: busEvents.length + 1,
      origin: 'REFF', dest: 'OPHS', type: 'response', state: busState,
      label: busLabel,
      payload: {
        cnmcAudit: auditStatus,
        nodo:      targetCompany.nodo,
        findings:  findings.slice(0, 5),
        opsBlocked: hasFailed,
      },
      user: req.user,
    });

    // --- Sentinel forensic log (only on failure) ---
    if (hasFailed) {
      const primaryFinding = findings.find(f => f.nivel === 'INFRACCION_NIVEL_1') || findings[0];
      const sentinelEvent = {
        id:        crypto.randomUUID(),
        type:      'cnmc_fraud',
        subject:   targetCompany.nodo,
        detail:    `CNMC_AUDIT_FAILED · Parámetro: ${primaryFinding.parametro} · Declarado: ${primaryFinding.valorDeclarado} · CNMC: ${primaryFinding.valorCnmc} · Delta: ${primaryFinding.delta} · Fuente: ${doc.fuente} · Periodo: ${doc.periodo}`,
        severity:  'critical',
        createdAt: now,
        forensic: {
          auditId:        auditRecord.id,
          docId:          doc.id,
          fuente:         doc.fuente,
          periodo:        doc.periodo,
          parametro:      primaryFinding.parametro,
          valorDeclarado: primaryFinding.valorDeclarado,
          valorCnmc:      primaryFinding.valorCnmc,
          delta:          primaryFinding.delta,
          nivel:          primaryFinding.nivel,
          ts:             now,
        },
      };
      state.bridges.sentinel.events.unshift(sentinelEvent);
      state.bridges.sentinel.events = state.bridges.sentinel.events.slice(0, 200);
      writeElvira(state);

      // Also emit to bus for panel pickup
      busEmit({
        id: crypto.randomUUID(), ts: now, seq: busEvents.length + 1,
        origin: 'SENTINEL', dest: 'ELVI-RA', type: 'alert', state: 'BLOCKED',
        label: `HUELLA FORENSE · ${targetCompany.nodo} · ${primaryFinding.parametro}`,
        payload: sentinelEvent.forensic,
        user: req.user,
      });
    }

    res.status(200).json(auditRecord);
  });

  /*
   * GET /api/elvira/cnmc/audit-log/:auditId/report
   * Informe descargable autocontenido de una auditoría CNMC ya realizada:
   * útil cuando una empresa pide pruebas de por qué se detectó una asimetría
   * (ej. "por qué nos marcasteis error de mercado en 2023").
   */
  app.get('/api/elvira/cnmc/audit-log/:auditId/report', auth, (req, res) => {
    const state = readElvira();
    if (!state.cnmc) state.cnmc = { documents: [], auditLog: [] };

    const auditRecord = state.cnmc.auditLog.find(a => a.id === req.params.auditId);
    if (!auditRecord) return res.status(404).json({ error: 'auditoría no encontrada' });

    const doc = state.cnmc.documents.find(d => d.id === auditRecord.docId) || null;

    res.json({
      tipo:        'INFORME_AUDITORIA_CNMC',
      generadoEn:  new Date().toISOString(),
      generadoPor: req.user,
      auditoria:   auditRecord,
      fuente:      doc ? { fuente: doc.fuente, url: doc.url, periodo: doc.periodo, ingestedAt: doc.ingestedAt, ingestedBy: doc.ingestedBy, datos: doc.datos } : null,
    });
  });

  app.post('/api/elvira/cnmc/search', auth, async (req, res) => {
    try {
      const b = req.body || {};
      const empresa = String(b.empresa || '').trim();
      const cif     = String(b.cif     || '').trim();
      const periodo = String(b.periodo || new Date().getFullYear().toString()).trim();

      if (!empresa) return res.status(400).json({ error: 'empresa requerida' });

      // Step 1: fetch real CNMC registry data
      const cnmcResults = await fetchCnmcOperadores(empresa);
      const found = cnmcResults.length > 0;
      const cnmcDataStr = found
        ? JSON.stringify(cnmcResults.slice(0, 5), null, 2)
        : 'No se encontraron resultados en el registro oficial de operadores CNMC para esta empresa.';

      // Step 2: LLM enriches with regulatory context using real data as base
      const userPrompt = `EMPRESA A INVESTIGAR: ${empresa}${cif ? ` · CIF: ${cif}` : ''}
PERIODO DE INTERÉS: ${periodo}

DATOS REALES DEL REGISTRO OFICIAL CNMC (numeracionyoperadores.cnmc.es):
${cnmcDataStr}

Interpreta estos datos y enriquece con contexto regulatorio adicional (sanciones, RIPRE/RAIPRE, régimen energético, perfil OPHS).
Si hay múltiples resultados, analiza el más relevante o el que coincida mejor con la búsqueda.
SOLO JSON.`;

      const raw = await callLLMTracked(CNMC_ENRICH_SYSTEM, userPrompt, 3000, req.user, 'cnmc_search');
      const parsed = extractJson(raw);

      // Override registroOficial with verified data if LLM missed it
      if (found && (!parsed.registroOficial || !parsed.registroOficial.encontrado)) {
        const first = cnmcResults[0];
        parsed.registroOficial = {
          encontrado: true,
          nombreRegistrado: first.nombre || null,
          nif: first.nif || null,
          domicilio: first.domicilio || null,
          fechaAltaRegistro: first.fecha_notif_ini || null,
          totalServicios: (first.servicios || []).length,
        };
        parsed.confianza = parsed.confianza === 'BAJA' ? 'MEDIA' : parsed.confianza;
      } else if (!found) {
        parsed.registroOficial = { encontrado: false, nombreRegistrado: null, nif: null, domicilio: null, fechaAltaRegistro: null, totalServicios: 0 };
      }

      busEmit({
        id: crypto.randomUUID(), ts: new Date().toISOString(), seq: busEvents.length + 1,
        origin: 'REFF', dest: 'ELVI-RA', type: 'response', state: 'COMPLETED',
        label: `CNMC SEARCH · ${empresa} · ${periodo} · registro:${found ? 'ENCONTRADO' : 'NO_ENCONTRADO'} · confianza: ${parsed.confianza || '?'}`,
        payload: { empresa, periodo, registroEncontrado: found, confianza: parsed.confianza, estadoCompliance: parsed.datos?.estadoCompliance },
        user: req.user,
      });

      res.json({
        empresa,
        cif: cif || null,
        periodo,
        searchedAt: new Date().toISOString(),
        cnmcResultCount: cnmcResults.length,
        ...parsed,
      });
    } catch (ex) {
      console.error('[cnmc/search]', ex);
      adminNotify({ origin: 'REFF', label: 'CNMC búsqueda · fallo', detail: ex.message, severity: 'error' });
      res.status(500).json({ error: ex.message || 'error búsqueda CNMC' });
    }
  });
}
