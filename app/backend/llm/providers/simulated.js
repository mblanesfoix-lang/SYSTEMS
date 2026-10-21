/**
 * Proveedor simulado: respuestas deterministas, sin red ni coste, para las
 * pruebas y para los equipos que no tienen IA. Cada operación conocida
 * devuelve un texto con la forma que espera la mesa que la pide (JSON donde se
 * pide JSON); cualquier otra, un texto genérico. Todo va marcado como
 * simulación para que nunca se confunda con un resultado real. La vigilancia
 * de Rëff no recibe noticias: así una tarea programada no escribe datos de
 * prueba por su cuenta.
 */
const MARK = '[Simulación]';
const NO_DATA = `${MARK} Sin modelo de IA: no hay datos verificados.`;

const json = (value) => JSON.stringify(value);

const herzogCategory = () => ({ score: 5, weightPct: 0, justification: NO_DATA });

const FIXTURES = {
  // Elvi-Ra Central (elvira-central.js)
  'central-chat': () => `${MARK} Respuesta de prueba de Elvi-Ra: la IA funciona en modo simulado y no consulta ningún modelo.`,
  // PAIA (paia.js)
  'paia-insight': () => `${MARK} Diagnóstico de prueba sin modelo de IA. Revise los hallazgos estadísticos del último análisis; la decisión es humana.`,
  // Rëff: búsqueda de nodos, LinkedIn y correo (routes/reff-crm.routes.js)
  search: () => json({ resumen: `${MARK} Búsqueda de prueba sin modelo de IA: no se devuelven empresas.`, results: [] }),
  linkedin: () => json({
    contactos: [{
      rol: 'Director de Sostenibilidad', area: 'Sostenibilidad', seniority: 'Director',
      keywords: ['sostenibilidad', 'residuos'], prioridadOutreach: 1,
      anguloApertura: `${MARK} Perfil de ejemplo`,
    }],
    notaEstrategica: NO_DATA,
  }),
  email: () => json({
    asunto: `${MARK} Borrador de prueba`,
    preheader: '',
    cuerpoTexto: `${MARK} Borrador generado sin modelo de IA.`,
    cuerpoHtml: `<p>${MARK} Borrador generado sin modelo de IA.</p>`,
    siguientePaso: 'Revisar el borrador',
  }),
  // CNMC (routes/cnmc.routes.js)
  cnmc_search: () => json({
    fuente: MARK,
    confianza: 'BAJA',
    datos: {
      servicios: [], sanciones: 'sin datos', expedientes: 'sin datos', regimen: null,
      potenciaInstalada: null, volumenResiduoT: null, obligacionesIncumplidas: [],
      estadoCompliance: 'OBSERVACION', perfilOperador: null,
    },
    notas: NO_DATA,
    recomiendaIngest: false,
  }),
  // Rëff: auditoría Herzog (server/routes/herzog.routes.ts)
  'herzog-audit': () => json({
    evalType: 'CLIENTE',
    taxId: null,
    activity: NO_DATA,
    categories: {
      solvenciaFinanciera: herzogCategory(),
      infraestructuraOperativa: herzogCategory(),
      transparenciaCompliance: herzogCategory(),
      alineacionEstrategica: herzogCategory(),
    },
    variables: [],
    overallScore: 5,
    opacityCount: 4,
    verdict: 'REVISION_MANUAL',
    flags: [],
    summary: `${MARK} Auditoría de prueba sin modelo de IA ni búsqueda web.`,
    recommendation: 'Repetir la auditoría con la IA conectada.',
    contact: { methods: [], noDataFound: true },
    firstContact: { channel: '', approach: '' },
  }),
  // Rëff: vigilancia de empresas (server/watch.ts)
  'reff-watch': () => 'TITULAR: Sin novedades',
};

const generic = () => `${MARK} Respuesta de prueba: la IA funciona en modo simulado y no consulta ningún modelo.`;

// Estimación de tokens por longitud, solo para que la contabilidad tenga cifras.
const tokens = (chars) => Math.ceil(chars / 4);

export default {
  name: 'simulado',
  defaults: { url: '', model: 'simulado' },
  requiresKey: false,
  supportsWebSearch: true,
  pricing: () => ({ inputPerM: 0, outputPerM: 0, perWebSearch: 0 }),

  async call(req) {
    const text = (FIXTURES[req.operation] || generic)();
    const inputChars = req.system.length + req.messages.reduce((s, m) => s + m.content.length, 0);
    return {
      text,
      parts: [text],
      inputTokens: tokens(inputChars),
      outputTokens: tokens(text.length),
      webSearches: 0,
      sources: [],
      truncated: false,
    };
  },
};
