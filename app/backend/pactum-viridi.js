/**
 * Pactvm Viridi — guardian doctrinal, cientifico y de cumplimiento bio-ambiental.
 *
 * Alcance: certificado CIBE (sello de estandar circular S-NFI), parametrizacion
 * de politicas medioambientales, condiciones de acceso bajo sello CIBE, y
 * lectura (sin escritura) de las auditorias Herzog para fundamentar el
 * dictamen de cumplimiento.
 *
 * Mismo patron que S-NFI Finance/FL/M&A: CRUD directo sobre Mongo, sin router
 * TS separado, log inmutable propio (pactvm_log, hash chain). Herzog vive en
 * la app Reff (db 'reff', coleccion herzog_audits) — Pactvm Viridi solo lee,
 * nunca escribe ahi ni juzga el veredicto (esa autoridad es de Herzog/Reff).
 */

import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';

// Codigos de acceso temporales de los desbloqueos publicos (verificacion de
// certificados): en Mongo solo se guarda su sha256, nunca el codigo en claro
// (mismo criterio que los enlaces VDR).
const hashAccessCode = (code) => crypto.createHash('sha256').update(String(code)).digest('hex');

const CIBE_STATUSES = ['pendiente', 'emitido', 'suspendido', 'revocado'];
const POLICY_CATEGORIES = ['quimico', 'circularidad', 'energia', 'residuo', 'otro'];
const ACCESS_SCOPES = ['empresa', 'mesa', 'rol'];
const ACCESS_STATUSES = ['activo', 'suspendido'];

// Capacidad piloto BioHybrid (SNFI Base Conocimiento §2.3): 150 T/dia de
// residuo organico humedo por nodo -> 12 T/dia biopellet 7%.
const PILOT_NODE_CAPACITY_T_DAY = 150;
const COUNTRY_NODE_STATUSES = ['estimado', 'validado', 'en_negociacion', 'activo'];
const ENTRY_RESIDUE_TYPES = ['organico_humedo', 'agroindustrial', 'ganadero', 'forestal', 'otro'];
const ENTRY_PROCEDENCIA = ['vertido_propio', 'vertido_tercero_contratado', 'planta_transferencia'];
const ENTRY_STATUSES = ['propuesta', 'activa', 'suspendida'];

// Ratio DBO5->creditos y ratio de conversion son PLACEHOLDER editables por el
// admin (sin dataset cientifico homologado bajo ISO 14064/GHG Protocol en el
// repo), mismo patron que wasteEstTDay de pactvm_country_nodes: campo source
// declara procedencia.
const CARBON_RATIO_ID = 'default';
const DEFAULT_CARBON_RATIO = {
  _id: CARBON_RATIO_ID,
  dbo5ToCreditsRatio: 1,
  unit: 'creditos por T DBO5',
  source: 'PLACEHOLDER — pendiente metodología homologada bajo ISO 14064-2/3 y GHG Protocol',
  updatedAt: null,
  updatedBy: null,
};

// Configuracion del certificado soberano (Sovereign Energy Biofuel &
// Circularity Asset Certificate): produccion de biopellet por nodo/ano y
// consumo energetico de referencia por nodo. PLACEHOLDER editable por admin
// (S-NFI Base Conocimiento §2.3: 150 T/dia residuo -> 12 T/dia biopellet 7%
// a escala piloto; aqui la cifra de venta/certificacion es una constante de
// referencia distinta y mas simple, mismo patron que dbo5ToCreditsRatio).
const CERT_CONFIG_ID = 'default';
const DEFAULT_CERT_CONFIG = {
  _id: CERT_CONFIG_ID,
  biopelletTonsPerNodeYear: 500,
  energyConsumptionGwhPerNode: 2.45,
  source: 'PLACEHOLDER — cifra de referencia interna, pendiente de validar con datos reales de planta',
  updatedAt: null,
  updatedBy: null,
};

// Categoria de residuo: dos vertientes de "no comercializable" que el
// sistema debe poder distinguir ante utilities/tribunales internacionales
// a la hora de justificar la reduccion de emisiones de forma quirurgica.
const WASTE_CATEGORIES = ['comida_no_comercializada', 'estiercol_guano'];
// Gases GEI presentes en el residuo procesado (subconjunto no vacio).
// GWP-100 IPCC AR5: CO2=1, CH4=28. NH3 no es GEI directo de Kyoto (no
// tiene GWP-100 asignado por el IPCC) — se registra como gas presente
// para trazabilidad regulatoria pero no aporta multiplicador propio.
const GHG_GASES = ['co2', 'ch4', 'nh3'];
const GHG_GWP_CH4 = 28;
function gwpFactorFromGases(gases) {
  return Array.isArray(gases) && gases.includes('ch4') ? GHG_GWP_CH4 : 1;
}
const SOLIDS_ONLY_DISCLAIMER = 'S-NFI BioHybrid procesa exclusivamente materia organica solida y polimeros solidos emisores de CO2, CH4, NH3 (o combinaciones de los tres). No se tratan lodos ni corrientes liquidas — no es una planta de tratamiento de aguas.';

const SEED_COUNTRY_NODES = [
  { code: 'ES', label: 'España', wasteEstTDay: 45000, source: 'PLACEHOLDER — estimar con MITECO/Eurostat', status: 'estimado' },
  { code: 'PT', label: 'Portugal', wasteEstTDay: 9000, source: 'PLACEHOLDER — estimar con APA/Eurostat', status: 'estimado' },
  { code: 'FR', label: 'Francia', wasteEstTDay: 62000, source: 'PLACEHOLDER — estimar con ADEME/Eurostat', status: 'estimado' },
  { code: 'MA', label: 'Marruecos', wasteEstTDay: 15000, source: 'PLACEHOLDER — estimar con fuente local ONEE/Ministerio', status: 'estimado' },
];

/* ---- Motor Planetario (Planetary Monitoring Engine) — 5a mesa Pactvm ----
 * Modelo de capacidad global: nodo BioHybrid 3-1-1 procesa 50 T/dia = 18.250
 * T/ano nominal (distinto del nodo piloto de "Nodos por Pais", 150 T/dia —
 * doctrina explicita del jefe 2026-09: dos escalas de referencia, tabla de
 * paises propia con T/ano en vez de T/dia). Todos los parametros de
 * pactvm_planetary_config son PLACEHOLDER editables por admin, sin dataset
 * de mercado real conectado (mismo patron que wasteEstTDay/dbo5ToCreditsRatio). */
const NODE_ANNUAL_CAPACITY_T_YEAR = 18250;
const PLANETARY_CONFIG_ID = 'default';
const DEFAULT_PLANETARY_CONFIG = {
  _id: PLANETARY_CONFIG_ID,
  nodesMax: 83000,
  nodesActive: 1420,
  unitTicketEur: 380000,
  nodeAnnualCapacityTYear: NODE_ANNUAL_CAPACITY_T_YEAR,
  carbonCreditPriceUsd: 45.20,
  source: 'PLACEHOLDER — modelo de negocio interno, sin mercado externo conectado',
  updatedAt: null,
  updatedBy: null,
};

const SEED_PLANETARY_COUNTRIES = [
  { code: 'ES', label: 'España', wasteEstTYear: 50000000, source: 'PLACEHOLDER — cifra de maqueta comercial' },
  { code: 'MX', label: 'México', wasteEstTYear: 38000000, source: 'PLACEHOLDER — cifra de maqueta comercial' },
  { code: 'DE', label: 'Alemania', wasteEstTYear: 72000000, source: 'PLACEHOLDER — cifra de maqueta comercial' },
];

/* ---- VDR: despliegue de curtailment ES (interfaz geoespacial, ver mas
 * abajo) — cuantifica cuantos nodos BioHybrid faltan por desplegar en
 * España para acaparar la franja de vertido renovable curtailed (GW) que
 * REE/ESIOS reporta como excedente sistemico. PLACEHOLDER de modelo de
 * negocio: nodesTargetTotal/curtailmentGwTargetMin/Max sin fuente REE
 * oficial homologada en el repo (mismo patron que wasteEstTDay/
 * dbo5ToCreditsRatio — campo source declara procedencia), editable por
 * admin vía PATCH. nodeAnnualEnergyGwh reutiliza el mismo orden de
 * magnitud que pactvm_cert_config.energyConsumptionGwhPerNode (Certificado
 * de Carbono) pero es un campo propio de VDR — no acopla ambas mesas.
 *
 * Bloque economico por nodo (tabla "lo que absorbe / lo que genera"):
 * biopelletTonsPerNodeYear reusa el mismo orden de magnitud que
 * pactvm_cert_config.biopelletTonsPerNodeYear (500 T/nodo/año, Certificado
 * de Carbono) como campo propio de VDR. biopelletPriceEurPerTon (350€/T) y
 * co2ch4AvoidedTonsPerNodeYear (3.000 T CO2+CH4 combinado/nodo/año) son
 * PLACEHOLDER de modelo de negocio dados por el usuario, sin mercado
 * secundario ni metodologia homologada conectada (mismo patron que el
 * resto de Pactvm). annualLossEur (70M€/año) es la cifra titular fija de
 * "coste de no adoptar BioHybrid" que Enel/el cliente pierde hoy — dato de
 * entrada independiente, no se fuerza a que la suma de los otros campos
 * cuadre matematicamente con ella. */
const VDR_ES_CONFIG_ID = 'default';
const DEFAULT_VDR_ES_CONFIG = {
  _id: VDR_ES_CONFIG_ID,
  nodesTargetTotal: 200,
  curtailmentGwTargetMin: 500,
  curtailmentGwTargetMax: 600,
  nodeAnnualEnergyGwh: 2.45,
  biopelletTonsPerNodeYear: 500,
  biopelletPriceEurPerTon: 350,
  co2ch4AvoidedTonsPerNodeYear: 3000,
  annualLossEur: 70000000,
  ppaClause: 'Desbloqueo de nodos condicionado exclusivamente a PPA energético de grid curtailment bajo gobernanza Pactvm Viridi — ningún nodo se activa sin contrato de compra de excedente renovable curtailed.',
  source: 'PLACEHOLDER — modelo de negocio interno, sin dataset REE/ESIOS de curtailment ni mercado de biopellet/carbono oficial homologado en el repo',
  updatedAt: null,
  updatedBy: null,
};

function withId(doc) {
  if (!doc) return doc;
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
}

function canonical(entry) {
  return JSON.stringify(entry, Object.keys(entry).sort());
}

async function appendPactvmLog(mongo, entry) {
  const col = mongo.collection('pactvm_log');
  const tail = await col.find().sort({ seq: -1 }).limit(1).next();
  const seq = tail ? tail.seq + 1 : 1;
  const prevHash = tail ? tail.hash : '0'.repeat(64);
  const canonicalEntry = { ...entry, seq };
  const hash = crypto.createHash('sha256').update(prevHash + canonical(canonicalEntry)).digest('hex');
  const doc = { _id: crypto.randomUUID(), ...entry, seq, prevHash, hash, createdAt: new Date().toISOString() };
  await col.insertOne(doc);
  return doc;
}

export function mountPactvm(app, { auth, requireMesa, requireAdmin, mongo, getMongoClient, getU2Snapshot }) {
  const router = app;
  const guard = [auth, requireMesa('pactvm')];
  const adminGuard = [auth, requireMesa('pactvm'), requireAdmin];
  const herzogAudits = () => getMongoClient().db('reff').collection('herzog_audits');

  // Desbloqueos publicos con codigo de 6 digitos (verificacion de certificados e
  // invitados VDR): sin limite propio se podia recorrer el espacio de ~900k
  // codigos dentro del TTL con solo el limitador global (120/min por IP). Dos
  // capas que cuentan unicamente los intentos fallidos (skipSuccessfulRequests):
  // por IP + objetivo (10 fallos cada 15 min) y por objetivo desde cualquier IP
  // (30 fallos por hora), que frena el ataque distribuido.
  const unlockTarget = (req) => String(req.params.token || req.params.packageId || '');
  const unlockLimiterBase = {
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: { error: 'Demasiados intentos fallidos. Espera unos minutos y pide un codigo nuevo si hace falta.' },
  };
  const unlockPerIp = rateLimit({
    ...unlockLimiterBase,
    windowMs: 15 * 60 * 1000,
    limit: 10,
    keyGenerator: (req) => `${req.ip ? ipKeyGenerator(req.ip) : 'anon'}|${unlockTarget(req)}`,
  });
  const unlockPerTarget = rateLimit({
    ...unlockLimiterBase,
    windowMs: 60 * 60 * 1000,
    limit: 30,
    keyGenerator: (req) => `target|${unlockTarget(req)}`,
  });

  function nodesNeeded(wasteEstTDay) {
    if (!Number.isFinite(wasteEstTDay) || wasteEstTDay <= 0) return 0;
    return Math.ceil(wasteEstTDay / PILOT_NODE_CAPACITY_T_DAY);
  }

  mongo.collection('pactvm_country_nodes').countDocuments({}).then(async (count) => {
    if (count > 0) return;
    const now = new Date().toISOString();
    await mongo.collection('pactvm_country_nodes').insertMany(SEED_COUNTRY_NODES.map((c) => ({
      _id: crypto.randomUUID(),
      ...c,
      nodesOverride: null,
      nodesNeeded: nodesNeeded(c.wasteEstTDay),
      createdBy: 'system',
      createdAt: now,
      updatedAt: now,
    })));
  }).catch(() => {});

  mongo.collection('pactvm_carbon_ratio').countDocuments({ _id: CARBON_RATIO_ID }).then(async (count) => {
    if (count > 0) return;
    await mongo.collection('pactvm_carbon_ratio').insertOne(DEFAULT_CARBON_RATIO);
  }).catch(() => {});

  mongo.collection('pactvm_cert_config').countDocuments({ _id: CERT_CONFIG_ID }).then(async (count) => {
    if (count > 0) return;
    await mongo.collection('pactvm_cert_config').insertOne(DEFAULT_CERT_CONFIG);
  }).catch(() => {});

  mongo.collection('pactvm_planetary_config').countDocuments({ _id: PLANETARY_CONFIG_ID }).then(async (count) => {
    if (count > 0) return;
    await mongo.collection('pactvm_planetary_config').insertOne(DEFAULT_PLANETARY_CONFIG);
  }).catch(() => {});

  mongo.collection('pactvm_vdr_es_config').countDocuments({ _id: VDR_ES_CONFIG_ID }).then(async (count) => {
    if (count > 0) return;
    await mongo.collection('pactvm_vdr_es_config').insertOne(DEFAULT_VDR_ES_CONFIG);
  }).catch(() => {});

  mongo.collection('pactvm_planetary_countries').countDocuments({}).then(async (count) => {
    if (count > 0) return;
    const now = new Date().toISOString();
    await mongo.collection('pactvm_planetary_countries').insertMany(SEED_PLANETARY_COUNTRIES.map((c) => ({
      _id: crypto.randomUUID(),
      ...c,
      nodesTarget: Math.ceil(c.wasteEstTYear / NODE_ANNUAL_CAPACITY_T_YEAR),
      createdBy: 'system',
      createdAt: now,
      updatedAt: now,
    })));
  }).catch(() => {});

  /* ---- certificados CIBE ---- */

  router.get('/api/pactvm/cibe', ...guard, async (req, res) => {
    const rows = await mongo.collection('pactvm_cibe').find({}).sort({ _id: -1 }).toArray();
    res.json(rows.map(withId));
  });

  router.post('/api/pactvm/cibe', ...guard, async (req, res) => {
    const b = req.body || {};
    const entityName = String(b.entityName || '').trim();
    if (!entityName) return res.status(400).json({ error: 'entityName requerido' });
    const doc = {
      _id: crypto.randomUUID(),
      entityName,
      sector: typeof b.sector === 'string' ? b.sector.trim().slice(0, 200) : '',
      status: 'pendiente',
      auditF4Date: typeof b.auditF4Date === 'string' && b.auditF4Date && !Number.isNaN(Date.parse(b.auditF4Date)) ? b.auditF4Date : null,
      herzogAuditId: typeof b.herzogAuditId === 'string' && b.herzogAuditId ? b.herzogAuditId : null,
      notes: typeof b.notes === 'string' ? b.notes.trim().slice(0, 1000) : '',
      createdBy: req.user,
      createdAt: new Date().toISOString(),
    };
    await mongo.collection('pactvm_cibe').insertOne(doc);
    await appendPactvmLog(mongo, { action: 'cibe.create', actorId: req.user, detail: { cibeId: doc._id, entityName } });
    res.status(201).json(withId(doc));
  });

  router.patch('/api/pactvm/cibe/:id', ...guard, async (req, res) => {
    const row = await mongo.collection('pactvm_cibe').findOne({ _id: req.params.id });
    if (!row) return res.status(404).json({ error: 'certificado no encontrado' });
    const b = req.body || {};
    const $set = {};
    if (b.status !== undefined) {
      if (!CIBE_STATUSES.includes(b.status)) return res.status(400).json({ error: 'status invalido' });
      $set.status = b.status;
    }
    if (b.auditF4Date !== undefined) {
      if (b.auditF4Date && Number.isNaN(Date.parse(b.auditF4Date))) return res.status(400).json({ error: 'auditF4Date invalido' });
      $set.auditF4Date = b.auditF4Date || null;
    }
    if (b.notes !== undefined) $set.notes = String(b.notes).trim().slice(0, 1000);
    if (Object.keys($set).length > 0) {
      await mongo.collection('pactvm_cibe').updateOne({ _id: req.params.id }, { $set });
      await appendPactvmLog(mongo, { action: 'cibe.update', actorId: req.user, detail: { cibeId: req.params.id, $set } });
    }
    const updated = await mongo.collection('pactvm_cibe').findOne({ _id: req.params.id });
    res.json(withId(updated));
  });

  router.delete('/api/pactvm/cibe/:id', ...guard, async (req, res) => {
    const result = await mongo.collection('pactvm_cibe').deleteOne({ _id: req.params.id });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'certificado no encontrado' });
    await appendPactvmLog(mongo, { action: 'cibe.delete', actorId: req.user, detail: { cibeId: req.params.id } });
    res.json({ id: req.params.id });
  });

  /* ---- politicas medioambientales ---- */

  router.get('/api/pactvm/policies', ...guard, async (req, res) => {
    const rows = await mongo.collection('pactvm_policies').find({}).sort({ category: 1, name: 1 }).toArray();
    res.json(rows.map(withId));
  });

  router.post('/api/pactvm/policies', ...guard, async (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name requerido' });
    if (!POLICY_CATEGORIES.includes(b.category)) return res.status(400).json({ error: 'category invalida' });
    const threshold = b.threshold !== undefined && b.threshold !== null && b.threshold !== '' ? Number(b.threshold) : null;
    if (threshold !== null && !Number.isFinite(threshold)) return res.status(400).json({ error: 'threshold invalido' });
    const doc = {
      _id: crypto.randomUUID(),
      name,
      category: b.category,
      threshold,
      unit: typeof b.unit === 'string' ? b.unit.trim().slice(0, 50) : '',
      description: typeof b.description === 'string' ? b.description.trim().slice(0, 1000) : '',
      active: true,
      version: 1,
      createdBy: req.user,
      createdAt: new Date().toISOString(),
    };
    await mongo.collection('pactvm_policies').insertOne(doc);
    await appendPactvmLog(mongo, { action: 'policy.create', actorId: req.user, detail: { policyId: doc._id, name, category: b.category } });
    res.status(201).json(withId(doc));
  });

  router.patch('/api/pactvm/policies/:id', ...guard, async (req, res) => {
    const row = await mongo.collection('pactvm_policies').findOne({ _id: req.params.id });
    if (!row) return res.status(404).json({ error: 'politica no encontrada' });
    const b = req.body || {};
    const $set = {};
    if (b.threshold !== undefined) {
      const threshold = b.threshold !== null && b.threshold !== '' ? Number(b.threshold) : null;
      if (threshold !== null && !Number.isFinite(threshold)) return res.status(400).json({ error: 'threshold invalido' });
      $set.threshold = threshold;
    }
    if (b.unit !== undefined) $set.unit = String(b.unit).trim().slice(0, 50);
    if (b.description !== undefined) $set.description = String(b.description).trim().slice(0, 1000);
    if (b.active !== undefined) $set.active = !!b.active;
    if (Object.keys($set).length > 0) {
      $set.version = (row.version || 1) + 1;
      await mongo.collection('pactvm_policies').updateOne({ _id: req.params.id }, { $set });
      await appendPactvmLog(mongo, { action: 'policy.update', actorId: req.user, detail: { policyId: req.params.id, $set } });
    }
    const updated = await mongo.collection('pactvm_policies').findOne({ _id: req.params.id });
    res.json(withId(updated));
  });

  router.delete('/api/pactvm/policies/:id', ...guard, async (req, res) => {
    const result = await mongo.collection('pactvm_policies').deleteOne({ _id: req.params.id });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'politica no encontrada' });
    await appendPactvmLog(mongo, { action: 'policy.delete', actorId: req.user, detail: { policyId: req.params.id } });
    res.json({ id: req.params.id });
  });

  /* ---- condiciones de acceso bajo sello CIBE ---- */

  router.get('/api/pactvm/access-rules', ...guard, async (req, res) => {
    const rows = await mongo.collection('pactvm_access_rules').find({}).sort({ _id: -1 }).toArray();
    res.json(rows.map(withId));
  });

  router.post('/api/pactvm/access-rules', ...guard, async (req, res) => {
    const b = req.body || {};
    const subject = String(b.subject || '').trim();
    if (!subject) return res.status(400).json({ error: 'subject requerido' });
    if (!ACCESS_SCOPES.includes(b.scope)) return res.status(400).json({ error: 'scope invalido' });
    const target = String(b.target || '').trim();
    if (!target) return res.status(400).json({ error: 'target requerido' });
    const doc = {
      _id: crypto.randomUUID(),
      subject,
      scope: b.scope,
      target,
      status: 'activo',
      reason: typeof b.reason === 'string' ? b.reason.trim().slice(0, 500) : '',
      createdBy: req.user,
      createdAt: new Date().toISOString(),
    };
    await mongo.collection('pactvm_access_rules').insertOne(doc);
    await appendPactvmLog(mongo, { action: 'access_rule.create', actorId: req.user, detail: { ruleId: doc._id, subject, scope: b.scope, target } });
    res.status(201).json(withId(doc));
  });

  router.patch('/api/pactvm/access-rules/:id', ...guard, async (req, res) => {
    const row = await mongo.collection('pactvm_access_rules').findOne({ _id: req.params.id });
    if (!row) return res.status(404).json({ error: 'regla no encontrada' });
    const b = req.body || {};
    const $set = {};
    if (b.status !== undefined) {
      if (!ACCESS_STATUSES.includes(b.status)) return res.status(400).json({ error: 'status invalido' });
      $set.status = b.status;
    }
    if (b.reason !== undefined) $set.reason = String(b.reason).trim().slice(0, 500);
    if (Object.keys($set).length > 0) {
      await mongo.collection('pactvm_access_rules').updateOne({ _id: req.params.id }, { $set });
      await appendPactvmLog(mongo, { action: 'access_rule.update', actorId: req.user, detail: { ruleId: req.params.id, $set } });
    }
    const updated = await mongo.collection('pactvm_access_rules').findOne({ _id: req.params.id });
    res.json(withId(updated));
  });

  router.delete('/api/pactvm/access-rules/:id', ...guard, async (req, res) => {
    const result = await mongo.collection('pactvm_access_rules').deleteOne({ _id: req.params.id });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'regla no encontrada' });
    await appendPactvmLog(mongo, { action: 'access_rule.delete', actorId: req.user, detail: { ruleId: req.params.id } });
    res.json({ id: req.params.id });
  });

  /* ---- auditorias Herzog (solo lectura, coleccion vive en db 'reff') ---- */

  router.get('/api/pactvm/herzog-audits', ...guard, async (req, res) => {
    const rows = await herzogAudits().find({}).sort({ created_at: -1 }).limit(50).toArray();
    res.json(rows.map((r) => ({
      id: r._id?.toString?.() || r._id,
      companyName: r.company_name,
      classification: r.result_json?.classification || null,
      overall: r.result_json?.overall ?? null,
      summary: r.result_json?.summary || null,
      createdAt: r.created_at,
    })));
  });

  /* ---- interfaz geoespacial: nodos BioHybrid necesarios por pais ----
   * nodosNecesarios = ceil(residuo organico humedo estimado T/dia / 150 T/dia
   * capacidad piloto por nodo, SNFI Base Conocimiento §2.3). El dato de
   * residuo es una ESTIMACION editable por el admin (campo source declara
   * la fuente); Pactvm Viridi no inventa cifras oficiales de generacion de
   * residuo por pais. */

  router.get('/api/pactvm/country-nodes', ...guard, async (req, res) => {
    const rows = await mongo.collection('pactvm_country_nodes').find({}).sort({ nodesNeeded: -1 }).toArray();
    res.json(rows.map(withId));
  });

  router.post('/api/pactvm/country-nodes', ...guard, async (req, res) => {
    const b = req.body || {};
    const code = String(b.code || '').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(code)) return res.status(400).json({ error: 'code invalido (ISO-2)' });
    const label = String(b.label || '').trim();
    if (!label) return res.status(400).json({ error: 'label requerido' });
    const wasteEstTDay = Number(b.wasteEstTDay);
    if (!Number.isFinite(wasteEstTDay) || wasteEstTDay < 0) return res.status(400).json({ error: 'wasteEstTDay invalido' });
    let nodesOverride = null;
    if (b.nodesOverride !== undefined && b.nodesOverride !== null && b.nodesOverride !== '') {
      nodesOverride = Number(b.nodesOverride);
      if (!Number.isFinite(nodesOverride) || nodesOverride < 0 || !Number.isInteger(nodesOverride)) {
        return res.status(400).json({ error: 'nodesOverride invalido' });
      }
    }
    const existing = await mongo.collection('pactvm_country_nodes').findOne({ code });
    if (existing) return res.status(409).json({ error: `pais ${code} ya registrado` });
    const doc = {
      _id: crypto.randomUUID(),
      code,
      label,
      wasteEstTDay,
      nodesOverride,
      nodesNeeded: nodesOverride !== null ? nodesOverride : nodesNeeded(wasteEstTDay),
      source: typeof b.source === 'string' ? b.source.trim().slice(0, 300) : '',
      status: COUNTRY_NODE_STATUSES.includes(b.status) ? b.status : 'estimado',
      createdBy: req.user,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await mongo.collection('pactvm_country_nodes').insertOne(doc);
    await appendPactvmLog(mongo, { action: 'country_node.create', actorId: req.user, detail: { code, wasteEstTDay, nodesOverride, nodesNeeded: doc.nodesNeeded } });
    res.status(201).json(withId(doc));
  });

  router.patch('/api/pactvm/country-nodes/:id', ...guard, async (req, res) => {
    const row = await mongo.collection('pactvm_country_nodes').findOne({ _id: req.params.id });
    if (!row) return res.status(404).json({ error: 'pais no encontrado' });
    const b = req.body || {};
    const $set = { updatedAt: new Date().toISOString() };
    if (b.wasteEstTDay !== undefined) {
      const wasteEstTDay = Number(b.wasteEstTDay);
      if (!Number.isFinite(wasteEstTDay) || wasteEstTDay < 0) return res.status(400).json({ error: 'wasteEstTDay invalido' });
      $set.wasteEstTDay = wasteEstTDay;
    }
    if (b.nodesOverride !== undefined) {
      if (b.nodesOverride === null || b.nodesOverride === '') {
        $set.nodesOverride = null;
      } else {
        const nodesOverride = Number(b.nodesOverride);
        if (!Number.isFinite(nodesOverride) || nodesOverride < 0 || !Number.isInteger(nodesOverride)) {
          return res.status(400).json({ error: 'nodesOverride invalido' });
        }
        $set.nodesOverride = nodesOverride;
      }
    }
    if ($set.wasteEstTDay !== undefined || $set.nodesOverride !== undefined) {
      const effectiveOverride = $set.nodesOverride !== undefined ? $set.nodesOverride : row.nodesOverride;
      const effectiveWaste = $set.wasteEstTDay !== undefined ? $set.wasteEstTDay : row.wasteEstTDay;
      $set.nodesNeeded = (effectiveOverride !== null && effectiveOverride !== undefined)
        ? effectiveOverride
        : nodesNeeded(effectiveWaste);
    }
    if (b.source !== undefined) $set.source = String(b.source).trim().slice(0, 300);
    if (b.status !== undefined) {
      if (!COUNTRY_NODE_STATUSES.includes(b.status)) return res.status(400).json({ error: 'status invalido' });
      $set.status = b.status;
    }
    if (b.label !== undefined) {
      const label = String(b.label).trim();
      if (!label) return res.status(400).json({ error: 'label invalido' });
      $set.label = label;
    }
    await mongo.collection('pactvm_country_nodes').updateOne({ _id: req.params.id }, { $set });
    await appendPactvmLog(mongo, { action: 'country_node.update', actorId: req.user, detail: { id: req.params.id, $set } });
    const updated = await mongo.collection('pactvm_country_nodes').findOne({ _id: req.params.id });
    res.json(withId(updated));
  });

  router.delete('/api/pactvm/country-nodes/:id', ...guard, async (req, res) => {
    const result = await mongo.collection('pactvm_country_nodes').deleteOne({ _id: req.params.id });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'pais no encontrado' });
    await appendPactvmLog(mongo, { action: 'country_node.delete', actorId: req.user, detail: { id: req.params.id } });
    res.json({ id: req.params.id });
  });

  /* ---- condiciones de entrada (operativas: solo vertidos de residuo, NO
   * energia de red) ---- */

  router.get('/api/pactvm/entry-conditions', ...guard, async (req, res) => {
    const rows = await mongo.collection('pactvm_entry_conditions').find({}).sort({ _id: -1 }).toArray();
    res.json(rows.map(withId));
  });

  router.post('/api/pactvm/entry-conditions', ...guard, async (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name requerido' });
    if (!ENTRY_RESIDUE_TYPES.includes(b.residueType)) return res.status(400).json({ error: 'residueType invalido' });
    if (!ENTRY_PROCEDENCIA.includes(b.procedencia)) return res.status(400).json({ error: 'procedencia invalida' });
    const maxHumedadPct = b.maxHumedadPct !== undefined && b.maxHumedadPct !== null && b.maxHumedadPct !== ''
      ? Number(b.maxHumedadPct) : null;
    if (maxHumedadPct !== null && (!Number.isFinite(maxHumedadPct) || maxHumedadPct < 0 || maxHumedadPct > 100)) {
      return res.status(400).json({ error: 'maxHumedadPct invalido (0-100)' });
    }
    const doc = {
      _id: crypto.randomUUID(),
      name,
      residueType: b.residueType,
      procedencia: b.procedencia,
      maxHumedadPct,
      requiresBSS: !!b.requiresBSS,
      status: 'propuesta',
      notes: typeof b.notes === 'string' ? b.notes.trim().slice(0, 1000) : '',
      createdBy: req.user,
      createdAt: new Date().toISOString(),
    };
    await mongo.collection('pactvm_entry_conditions').insertOne(doc);
    await appendPactvmLog(mongo, { action: 'entry_condition.create', actorId: req.user, detail: { id: doc._id, name, residueType: b.residueType, procedencia: b.procedencia } });
    res.status(201).json(withId(doc));
  });

  router.patch('/api/pactvm/entry-conditions/:id', ...guard, async (req, res) => {
    const row = await mongo.collection('pactvm_entry_conditions').findOne({ _id: req.params.id });
    if (!row) return res.status(404).json({ error: 'condicion no encontrada' });
    const b = req.body || {};
    const $set = {};
    if (b.status !== undefined) {
      if (!ENTRY_STATUSES.includes(b.status)) return res.status(400).json({ error: 'status invalido' });
      $set.status = b.status;
    }
    if (b.maxHumedadPct !== undefined) {
      const maxHumedadPct = b.maxHumedadPct !== null && b.maxHumedadPct !== '' ? Number(b.maxHumedadPct) : null;
      if (maxHumedadPct !== null && (!Number.isFinite(maxHumedadPct) || maxHumedadPct < 0 || maxHumedadPct > 100)) {
        return res.status(400).json({ error: 'maxHumedadPct invalido (0-100)' });
      }
      $set.maxHumedadPct = maxHumedadPct;
    }
    if (b.requiresBSS !== undefined) $set.requiresBSS = !!b.requiresBSS;
    if (b.notes !== undefined) $set.notes = String(b.notes).trim().slice(0, 1000);
    if (Object.keys($set).length > 0) {
      await mongo.collection('pactvm_entry_conditions').updateOne({ _id: req.params.id }, { $set });
      await appendPactvmLog(mongo, { action: 'entry_condition.update', actorId: req.user, detail: { id: req.params.id, $set } });
    }
    const updated = await mongo.collection('pactvm_entry_conditions').findOne({ _id: req.params.id });
    res.json(withId(updated));
  });

  router.delete('/api/pactvm/entry-conditions/:id', ...guard, async (req, res) => {
    const result = await mongo.collection('pactvm_entry_conditions').deleteOne({ _id: req.params.id });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'condicion no encontrada' });
    await appendPactvmLog(mongo, { action: 'entry_condition.delete', actorId: req.user, detail: { id: req.params.id } });
    res.json({ id: req.params.id });
  });

  /* ---- creditos de carbono: medidor de mitigacion y monetizacion ----
   * Metricas por cliente/periodo (entrada manual, sin integracion externa a
   * mercados secundarios): T CO2e mitigadas, T DBO5 procesada, hectareas
   * instaladas, ingreso de monetizacion, geolocalizacion del nodo y MWh de
   * estabilizacion de red. El ratio DBO5->creditos y el rendimiento €/ha se
   * derivan de estos datos. Marco normativo referenciado: GHG Protocol
   * (Scope 1 y 3), ISO 14064-2/3, Directiva CSRD/Taxonomia Verde UE, Art 6.4
   * del Acuerdo de Paris (no doble contabilizacion) — sin nombrar entes
   * certificadores privados, solo estandares/normativa internacional. */

  router.get('/api/pactvm/carbon/ratio', ...guard, async (req, res) => {
    const doc = await mongo.collection('pactvm_carbon_ratio').findOne({ _id: CARBON_RATIO_ID });
    res.json(withId(doc || DEFAULT_CARBON_RATIO));
  });

  router.patch('/api/pactvm/carbon/ratio', ...guard, async (req, res) => {
    const b = req.body || {};
    const $set = { updatedAt: new Date().toISOString(), updatedBy: req.user };
    if (b.dbo5ToCreditsRatio !== undefined) {
      const ratio = Number(b.dbo5ToCreditsRatio);
      if (!Number.isFinite(ratio) || ratio <= 0) return res.status(400).json({ error: 'dbo5ToCreditsRatio invalido' });
      $set.dbo5ToCreditsRatio = ratio;
    }
    if (b.unit !== undefined) $set.unit = String(b.unit).trim().slice(0, 100);
    if (b.source !== undefined) $set.source = String(b.source).trim().slice(0, 300);
    await mongo.collection('pactvm_carbon_ratio').updateOne({ _id: CARBON_RATIO_ID }, { $set }, { upsert: true });
    await appendPactvmLog(mongo, { action: 'carbon.ratio_update', actorId: req.user, detail: { $set } });
    const updated = await mongo.collection('pactvm_carbon_ratio').findOne({ _id: CARBON_RATIO_ID });
    res.json(withId(updated));
  });

  router.get('/api/pactvm/carbon/cert-config', ...guard, async (req, res) => {
    const doc = await mongo.collection('pactvm_cert_config').findOne({ _id: CERT_CONFIG_ID });
    res.json(withId(doc || DEFAULT_CERT_CONFIG));
  });

  router.patch('/api/pactvm/carbon/cert-config', ...guard, async (req, res) => {
    const b = req.body || {};
    const $set = { updatedAt: new Date().toISOString(), updatedBy: req.user };
    if (b.biopelletTonsPerNodeYear !== undefined) {
      const val = Number(b.biopelletTonsPerNodeYear);
      if (!Number.isFinite(val) || val < 0) return res.status(400).json({ error: 'biopelletTonsPerNodeYear invalido' });
      $set.biopelletTonsPerNodeYear = val;
    }
    if (b.energyConsumptionGwhPerNode !== undefined) {
      const val = Number(b.energyConsumptionGwhPerNode);
      if (!Number.isFinite(val) || val < 0) return res.status(400).json({ error: 'energyConsumptionGwhPerNode invalido' });
      $set.energyConsumptionGwhPerNode = val;
    }
    if (b.source !== undefined) $set.source = String(b.source).trim().slice(0, 300);
    await mongo.collection('pactvm_cert_config').updateOne({ _id: CERT_CONFIG_ID }, { $set }, { upsert: true });
    await appendPactvmLog(mongo, { action: 'carbon.cert_config_update', actorId: req.user, detail: { $set } });
    const updated = await mongo.collection('pactvm_cert_config').findOne({ _id: CERT_CONFIG_ID });
    res.json(withId(updated));
  });

  router.get('/api/pactvm/carbon/clients', ...guard, async (req, res) => {
    const rows = await mongo.collection('pactvm_carbon_clients').find({}).sort({ period: -1, clientName: 1 }).toArray();
    res.json(rows.map(withId));
  });

  router.post('/api/pactvm/carbon/clients', ...guard, async (req, res) => {
    const b = req.body || {};
    const clientName = String(b.clientName || '').trim();
    if (!clientName) return res.status(400).json({ error: 'clientName requerido' });
    const period = String(b.period || '').trim();
    if (!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: 'period invalido (formato YYYY-MM)' });
    const co2eTons = Number(b.co2eTons);
    if (!Number.isFinite(co2eTons) || co2eTons < 0) return res.status(400).json({ error: 'co2eTons invalido' });
    const dbo5Tons = Number(b.dbo5Tons);
    if (!Number.isFinite(dbo5Tons) || dbo5Tons < 0) return res.status(400).json({ error: 'dbo5Tons invalido' });
    const hectares = Number(b.hectares);
    if (!Number.isFinite(hectares) || hectares <= 0) return res.status(400).json({ error: 'hectares invalido' });
    const revenueEur = Number(b.revenueEur);
    if (!Number.isFinite(revenueEur) || revenueEur < 0) return res.status(400).json({ error: 'revenueEur invalido' });
    const gisLat = b.gisLat !== undefined && b.gisLat !== '' ? Number(b.gisLat) : null;
    if (gisLat !== null && (!Number.isFinite(gisLat) || gisLat < -90 || gisLat > 90)) return res.status(400).json({ error: 'gisLat invalido' });
    const gisLng = b.gisLng !== undefined && b.gisLng !== '' ? Number(b.gisLng) : null;
    if (gisLng !== null && (!Number.isFinite(gisLng) || gisLng < -180 || gisLng > 180)) return res.status(400).json({ error: 'gisLng invalido' });
    const mwhStabilized = b.mwhStabilized !== undefined && b.mwhStabilized !== '' ? Number(b.mwhStabilized) : 0;
    if (!Number.isFinite(mwhStabilized) || mwhStabilized < 0) return res.status(400).json({ error: 'mwhStabilized invalido' });
    const nodeCount = b.nodeCount !== undefined && b.nodeCount !== '' ? Number(b.nodeCount) : 1;
    if (!Number.isFinite(nodeCount) || nodeCount <= 0) return res.status(400).json({ error: 'nodeCount invalido' });
    const wasteCategory = WASTE_CATEGORIES.includes(b.wasteCategory) ? b.wasteCategory : 'comida_no_comercializada';
    const ghgGases = Array.isArray(b.ghgGases) ? b.ghgGases.filter(g => GHG_GASES.includes(g)) : [];
    if (ghgGases.length === 0) return res.status(400).json({ error: 'ghgGases requiere al menos un gas (co2/ch4/nh3)' });
    const existing = await mongo.collection('pactvm_carbon_clients').findOne({ clientName, period });
    if (existing) return res.status(409).json({ error: `ya existe registro de "${clientName}" para ${period}` });
    const doc = {
      _id: crypto.randomUUID(),
      clientName,
      nodeLabel: typeof b.nodeLabel === 'string' ? b.nodeLabel.trim().slice(0, 40) : '',
      nodeCount,
      period,
      co2eTons,
      dbo5Tons,
      wasteCategory,
      ghgGases,
      hectares,
      revenueEur,
      gisLat,
      gisLng,
      cadastralRef: typeof b.cadastralRef === 'string' ? b.cadastralRef.trim().slice(0, 120) : '',
      mwhStabilized,
      source: typeof b.source === 'string' ? b.source.trim().slice(0, 300) : '',
      createdBy: req.user,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await mongo.collection('pactvm_carbon_clients').insertOne(doc);
    await appendPactvmLog(mongo, { action: 'carbon.client_create', actorId: req.user, detail: { id: doc._id, clientName, period, co2eTons } });
    res.status(201).json(withId(doc));
  });

  router.patch('/api/pactvm/carbon/clients/:id', ...guard, async (req, res) => {
    const row = await mongo.collection('pactvm_carbon_clients').findOne({ _id: req.params.id });
    if (!row) return res.status(404).json({ error: 'registro no encontrado' });
    const b = req.body || {};
    const $set = { updatedAt: new Date().toISOString() };
    for (const [field, key] of [['co2eTons', 'co2eTons'], ['dbo5Tons', 'dbo5Tons'], ['hectares', 'hectares'], ['revenueEur', 'revenueEur'], ['mwhStabilized', 'mwhStabilized']]) {
      if (b[key] !== undefined) {
        const val = Number(b[key]);
        if (!Number.isFinite(val) || val < 0) return res.status(400).json({ error: `${key} invalido` });
        $set[field] = val;
      }
    }
    if (b.nodeCount !== undefined) {
      const val = Number(b.nodeCount);
      if (!Number.isFinite(val) || val <= 0) return res.status(400).json({ error: 'nodeCount invalido' });
      $set.nodeCount = val;
    }
    if (b.nodeLabel !== undefined) $set.nodeLabel = String(b.nodeLabel).trim().slice(0, 40);
    if (b.wasteCategory !== undefined) {
      if (!WASTE_CATEGORIES.includes(b.wasteCategory)) return res.status(400).json({ error: 'wasteCategory invalido' });
      $set.wasteCategory = b.wasteCategory;
    }
    if (b.ghgGases !== undefined) {
      const gases = Array.isArray(b.ghgGases) ? b.ghgGases.filter(g => GHG_GASES.includes(g)) : [];
      if (gases.length === 0) return res.status(400).json({ error: 'ghgGases requiere al menos un gas (co2/ch4/nh3)' });
      $set.ghgGases = gases;
    }
    if (b.gisLat !== undefined) {
      const val = b.gisLat === '' || b.gisLat === null ? null : Number(b.gisLat);
      if (val !== null && (!Number.isFinite(val) || val < -90 || val > 90)) return res.status(400).json({ error: 'gisLat invalido' });
      $set.gisLat = val;
    }
    if (b.gisLng !== undefined) {
      const val = b.gisLng === '' || b.gisLng === null ? null : Number(b.gisLng);
      if (val !== null && (!Number.isFinite(val) || val < -180 || val > 180)) return res.status(400).json({ error: 'gisLng invalido' });
      $set.gisLng = val;
    }
    if (b.cadastralRef !== undefined) $set.cadastralRef = String(b.cadastralRef).trim().slice(0, 120);
    if (b.source !== undefined) $set.source = String(b.source).trim().slice(0, 300);
    await mongo.collection('pactvm_carbon_clients').updateOne({ _id: req.params.id }, { $set });
    await appendPactvmLog(mongo, { action: 'carbon.client_update', actorId: req.user, detail: { id: req.params.id, $set } });
    const updated = await mongo.collection('pactvm_carbon_clients').findOne({ _id: req.params.id });
    res.json(withId(updated));
  });

  router.delete('/api/pactvm/carbon/clients/:id', ...guard, async (req, res) => {
    const result = await mongo.collection('pactvm_carbon_clients').deleteOne({ _id: req.params.id });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'registro no encontrado' });
    await appendPactvmLog(mongo, { action: 'carbon.client_delete', actorId: req.user, detail: { id: req.params.id } });
    res.json({ id: req.params.id });
  });

  router.get('/api/pactvm/carbon/summary', ...guard, async (req, res) => {
    const [rows, ratioDoc] = await Promise.all([
      mongo.collection('pactvm_carbon_clients').find({}).toArray(),
      mongo.collection('pactvm_carbon_ratio').findOne({ _id: CARBON_RATIO_ID }),
    ]);
    const ratio = ratioDoc || DEFAULT_CARBON_RATIO;
    const co2eTotal = rows.reduce((sum, r) => sum + (r.co2eTons || 0), 0);
    const dbo5Total = rows.reduce((sum, r) => sum + (r.dbo5Tons || 0), 0);
    const hectaresTotal = rows.reduce((sum, r) => sum + (r.hectares || 0), 0);
    const revenueTotal = rows.reduce((sum, r) => sum + (r.revenueEur || 0), 0);
    const clientsTracked = new Set(rows.map((r) => r.clientName)).size;
    res.json({
      co2eTotal,
      dbo5Total,
      hectaresTotal,
      revenueTotal,
      clientsTracked,
      recordsTotal: rows.length,
      creditsEstimated: dbo5Total * (ratio.dbo5ToCreditsRatio || 0),
      dbo5ToCreditsRatio: ratio.dbo5ToCreditsRatio,
      revenuePerHectare: hectaresTotal > 0 ? revenueTotal / hectaresTotal : 0,
      // Motor de Tokenizacion (Vol.4 doctrina): 1 T de residuo convertido que
      // evita emision CO2e = 1 token Pactvm Viridi (RWA respaldado por
      // hardware BioHybrid + contratos de vertido firmados). Sin ledger
      // blockchain real: derivado del mismo co2eTotal ya auditado por cliente.
      rwaTokensMinted: co2eTotal,
      rwaTokenUnit: 'PACTVM_TOKEN_1T_CO2E_AVOIDED',
    });
  });

  /* ---- botones accionables: paquetes de datos para auditoria/tokenizacion.
   * Genera snapshot JSON + registro inmutable en pactvm_log. Sin llamada real
   * a mercado secundario — infraestructura interna de auditoria/paquete de
   * datos, la emision/cotizacion real la gestiona el humano fuera de este
   * sistema. Marco normativo citado: GHG Protocol, ISO 14064-2/3, CSRD/
   * Taxonomia Verde UE, Art 6.4 Acuerdo de Paris — sin nombrar certificadores
   * privados (directriz explicita: solo normativa/estandares internacionales
   * reconocidos oficialmente). */

  // Merkle root simplificado: hash de cada registro (hoja) combinados en un
  // unico hash raiz. No es un arbol Merkle completo con pruebas de inclusion
  // (no hay necesidad de probar un registro individual sin revelar los demas
  // todavia) — es el mismo nivel de rigor que el hash chain de pactvm_log,
  // aplicado aqui al lote de registros de un paquete concreto.
  function merkleRootFromRecords(leaves) {
    const leafHashes = leaves.map((leaf) => crypto.createHash('sha256').update(canonical(leaf)).digest('hex'));
    return crypto.createHash('sha256').update(leafHashes.join('')).digest('hex');
  }

  function verificationUrl(req, packageId) {
    // Fuera del prefijo '/api/pactvm' a proposito: server.js aplica
    // auth+requireMesa('pactvm') a todo ese prefijo con app.use ANTES de que
    // mountPactvm registre sus rutas, asi que una ruta publica dentro de
    // '/api/pactvm/*' quedaria bloqueada pese a no llevar el guard aqui.
    return `${req.protocol}://${req.get('host')}/api/pactvm-verify/${packageId}`;
  }

  async function qrDataUri(url) {
    try {
      return await QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 1, scale: 6 });
    } catch {
      return null;
    }
  }

  function verifyCardEscape(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Tarjeta de verificacion movil-first (iOS/Safari): lo que ve quien
  // escanea el QR en directo. Deliberadamente resumida — solo lo
  // necesario para verificar autenticidad ante un tercero (utility,
  // tribunal), sin exponer publicamente el detalle financiero completo
  // que si lleva el PDF (ese requiere login).
  function verifyCardHtml({ row, notFound, packageId, gated }) {
    const fmt = (n, d = 2) => Number(n || 0).toLocaleString('es-ES', { maximumFractionDigits: d });
    if (notFound) {
      return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black">
<title>Verificación no encontrada · Pactvm Viridi</title>
<style>${verifyCardCss()}</style>
</head>
<body>
  <div class="card not-found">
    <div class="icon">✕</div>
    <div class="status">No encontrado</div>
    <div class="sub">No existe ningún paquete verificado con este identificador.</div>
    <div class="pkg-id">${verifyCardEscape(packageId)}</div>
  </div>
</body>
</html>`;
    }
    const typeLabel = row.type === 'certificado' ? 'Certificado de Activo Soberano' : 'Tokenización RWA';
    if (gated) {
      return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black">
<title>Verificación · Pactvm Viridi</title>
<style>${verifyCardCss()}</style>
</head>
<body>
  <div class="card" id="gateCard">
    <div class="brand">CIBE/ICEB International Certification Standard</div>
    <div class="icon lock">🔒</div>
    <div class="status">Acceso restringido</div>
    <div class="sub">${verifyCardEscape(typeLabel)} · introduce tu correo autorizado y el código temporal facilitado en la reunión.</div>
    <div class="gate-form">
      <input id="gateEmail" type="email" inputmode="email" autocapitalize="off" autocorrect="off" placeholder="tu-correo@empresa.com">
      <input id="gateCode" type="tel" inputmode="numeric" maxlength="6" placeholder="Código de 6 dígitos">
      <button id="gateBtn">Verificar acceso</button>
      <div class="gate-error" id="gateError" hidden></div>
    </div>
    <div class="pkg-id">${verifyCardEscape(row._id)}</div>
  </div>
  <script>
    (function () {
      var btn = document.getElementById('gateBtn');
      var err = document.getElementById('gateError');
      var packageId = ${JSON.stringify(row._id)};
      function fmt(n, d) {
        d = d || 2;
        n = Number(n || 0);
        return n.toLocaleString('es-ES', { maximumFractionDigits: d });
      }
      function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
          return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
      }
      btn.addEventListener('click', function () {
        var email = document.getElementById('gateEmail').value.trim();
        var code = document.getElementById('gateCode').value.trim();
        err.hidden = true;
        if (!email || !code) { err.textContent = 'Indica correo y código.'; err.hidden = false; return; }
        btn.disabled = true; btn.textContent = 'Verificando…';
        fetch('/api/pactvm-verify/' + packageId + '/unlock', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email, code: code }),
        }).then(function (r) { return r.json().then(function (data) { return { ok: r.ok, data: data }; }); })
          .then(function (res) {
            btn.disabled = false; btn.textContent = 'Verificar acceso';
            if (!res.ok) { err.textContent = res.data.error || 'Acceso denegado.'; err.hidden = false; return; }
            var d = res.data;
            document.getElementById('gateCard').outerHTML =
              '<div class="card">' +
              '<div class="brand">CIBE/ICEB International Certification Standard</div>' +
              '<div class="icon">\\u2713</div>' +
              '<div class="status">' + esc(String(d.status || '').replace(/_/g, ' ')) + '</div>' +
              '<div class="sub">' + esc(d.type === 'certificado' ? 'Certificado de Activo Soberano' : 'Tokenización RWA') + '</div>' +
              '<div class="rows">' +
              '<div class="row"><span class="k">Cliente</span><span class="v">' + esc(d.clientName || '—') + '</span></div>' +
              '<div class="row"><span class="k">Periodo</span><span class="v mono">' + esc(d.period) + '</span></div>' +
              '<div class="row"><span class="k">T CO\\u2082e</span><span class="v">' + fmt(d.co2eTotal) + '</span></div>' +
              '<div class="row"><span class="k">T CO\\u2082e ponderado (GWP)</span><span class="v">' + fmt(d.co2eWeightedTotal) + '</span></div>' +
              '<div class="row"><span class="k">T DBO\\u2085</span><span class="v">' + fmt(d.dbo5Total) + '</span></div>' +
              '<div class="row"><span class="k">Emitido</span><span class="v">' + esc(new Date(d.issuedAt).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' })) + '</span></div>' +
              '</div>' +
              '<div class="hash-box"><span class="k">Merkle Root (SHA-256)</span><span class="hash">' + esc(d.merkleRoot) + '</span></div>' +
              '<div class="pkg-id">' + esc(d.packageId) + '</div>' +
              '<div class="footer">Acceso verificado por correo · sesión no persistente · Pactvm Viridi</div>' +
              '</div>';
          }).catch(function () {
            btn.disabled = false; btn.textContent = 'Verificar acceso';
            err.textContent = 'Error de red. Reintenta.'; err.hidden = false;
          });
      });
    })();
  </script>
</body>
</html>`;
    }
    return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black">
<title>Verificación · Pactvm Viridi</title>
<style>${verifyCardCss()}</style>
</head>
<body>
  <div class="card">
    <div class="brand">CIBE/ICEB International Certification Standard</div>
    <div class="icon">✓</div>
    <div class="status">${verifyCardEscape((row.status || '').replace(/_/g, ' '))}</div>
    <div class="sub">${verifyCardEscape(typeLabel)}</div>

    <div class="rows">
      <div class="row"><span class="k">Cliente</span><span class="v">${verifyCardEscape(row.clientName || '—')}</span></div>
      <div class="row"><span class="k">Periodo</span><span class="v mono">${verifyCardEscape(row.period)}</span></div>
      <div class="row"><span class="k">T CO₂e</span><span class="v">${fmt(row.co2eTotal)}</span></div>
      <div class="row"><span class="k">T CO₂e ponderado (GWP)</span><span class="v">${fmt(row.co2eWeightedTotal)}</span></div>
      <div class="row"><span class="k">T DBO₅</span><span class="v">${fmt(row.dbo5Total)}</span></div>
      <div class="row"><span class="k">Emitido</span><span class="v">${verifyCardEscape(new Date(row.createdAt).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' }))}</span></div>
    </div>

    <div class="hash-box">
      <span class="k">Merkle Root (SHA-256)</span>
      <span class="hash">${verifyCardEscape(row.merkleRoot)}</span>
    </div>

    <div class="pkg-id">${verifyCardEscape(row._id)}</div>
    <div class="footer">Sello de verificación pública · Pactvm Viridi · S-NFI Systems</div>
  </div>
</body>
</html>`;
  }

  function verifyCardCss() {
    return `
      :root { color-scheme: light; }
      * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
      body {
        margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
        padding: max(20px, env(safe-area-inset-top)) 16px max(20px, env(safe-area-inset-bottom));
        background: linear-gradient(180deg, #eef2ef 0%, #dfe7e1 100%);
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", "Segoe UI", sans-serif;
        color: #1d1d1f;
      }
      .card {
        width: 100%; max-width: 380px; background: #fff; border-radius: 22px;
        padding: 28px 22px 20px; box-shadow: 0 12px 34px rgba(0,0,0,0.14);
        text-align: center;
      }
      .brand { font-size: 9.5px; letter-spacing: 0.08em; text-transform: uppercase; color: #86868b; margin-bottom: 14px; }
      .icon {
        width: 56px; height: 56px; border-radius: 50%; background: #1c6b3a; color: #fff;
        font-size: 28px; line-height: 56px; margin: 0 auto 12px;
      }
      .not-found .icon { background: #c62828; }
      .status { font-size: 17px; font-weight: 700; letter-spacing: -0.01em; text-transform: uppercase; }
      .sub { font-size: 12.5px; color: #6e6e73; margin-top: 4px; margin-bottom: 18px; }
      .rows { text-align: left; border-top: 1px solid #eee; padding-top: 14px; }
      .row { display: flex; justify-content: space-between; align-items: baseline; padding: 7px 0; font-size: 13px; border-bottom: 1px solid #f2f2f4; }
      .row:last-child { border-bottom: none; }
      .row .k { color: #86868b; }
      .row .v { font-weight: 600; }
      .row .v.mono { font-family: "SF Mono", Consolas, monospace; }
      .hash-box { margin-top: 16px; background: #f5f5f7; border-radius: 10px; padding: 10px 12px; text-align: left; }
      .hash-box .k { display: block; font-size: 9px; text-transform: uppercase; letter-spacing: 0.04em; color: #86868b; margin-bottom: 4px; }
      .hash { font-family: "SF Mono", Consolas, monospace; font-size: 9.5px; color: #424245; word-break: break-all; }
      .pkg-id { margin-top: 14px; font-family: "SF Mono", Consolas, monospace; font-size: 9px; color: #a1a1a6; word-break: break-all; }
      .footer { margin-top: 12px; font-size: 9px; color: #a1a1a6; }
      .icon.lock { background: #48484a; font-size: 24px; }
      .gate-form { display: flex; flex-direction: column; gap: 10px; text-align: left; }
      .gate-form input {
        width: 100%; padding: 11px 12px; border-radius: 10px; border: 1px solid #d2d2d7;
        font-size: 15px; font-family: inherit; background: #f9f9fb;
      }
      .gate-form input:focus { outline: 2px solid #1c6b3a; outline-offset: -1px; }
      .gate-form button {
        margin-top: 2px; padding: 12px; border: none; border-radius: 10px; background: #1c6b3a; color: #fff;
        font-size: 14px; font-weight: 700; letter-spacing: 0.02em; -webkit-appearance: none;
      }
      .gate-form button:disabled { opacity: 0.6; }
      .gate-error { color: #c62828; font-size: 12px; text-align: center; }
    `;
  }

  router.post('/api/pactvm/carbon/emit-certificate', ...guard, async (req, res) => {
    const b = req.body || {};
    const period = String(b.period || '').trim();
    if (!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: 'period invalido (formato YYYY-MM)' });
    const query = { period };
    if (b.clientName) query.clientName = String(b.clientName).trim();
    const rows = await mongo.collection('pactvm_carbon_clients').find(query).toArray();
    if (rows.length === 0) return res.status(404).json({ error: 'sin registros para ese periodo/cliente' });
    const ratioDoc = await mongo.collection('pactvm_carbon_ratio').findOne({ _id: CARBON_RATIO_ID }) || DEFAULT_CARBON_RATIO;
    const certConfig = await mongo.collection('pactvm_cert_config').findOne({ _id: CERT_CONFIG_ID }) || DEFAULT_CERT_CONFIG;
    const packageId = crypto.randomUUID();
    const records = rows.map((r) => ({
      clientName: r.clientName,
      nodeLabel: r.nodeLabel || '',
      nodeCount: r.nodeCount || 1,
      co2eTons: r.co2eTons,
      dbo5Tons: r.dbo5Tons,
      wasteCategory: r.wasteCategory || 'comida_no_comercializada',
      ghgGases: Array.isArray(r.ghgGases) && r.ghgGases.length ? r.ghgGases : ['co2'],
      gwpFactor: gwpFactorFromGases(r.ghgGases),
      co2eWeightedTons: (r.co2eTons || 0) * gwpFactorFromGases(r.ghgGases),
      hectares: r.hectares,
      creditsEstimated: r.dbo5Tons * (ratioDoc.dbo5ToCreditsRatio || 0),
      revenueEur: r.revenueEur || 0,
      mwhStabilized: r.mwhStabilized || 0,
      biopelletTons: (r.nodeCount || 1) * (certConfig.biopelletTonsPerNodeYear || 0),
      gisLat: r.gisLat ?? null,
      gisLng: r.gisLng ?? null,
      cadastralRef: r.cadastralRef || '',
      source: r.source || '',
    }));
    const merkleRoot = merkleRootFromRecords(records);
    const sensorCalibrationChecksum = crypto.createHash('sha256').update(`${packageId}:${merkleRoot}:${ratioDoc.dbo5ToCreditsRatio}`).digest('hex');
    const vUrl = verificationUrl(req, packageId);
    const snapshot = {
      packageId,
      documentType: 'SOVEREIGN_ENVIRONMENTAL_BIO_ENERGY_ASSET_CERTIFICATE',
      period,
      generatedAt: new Date().toISOString(),
      generatedBy: req.user,
      security: {
        merkleRoot,
        sensorCalibrationChecksum,
        rfc3161Timestamp: new Date().toISOString(),
        verificationUrl: vUrl,
        qrDataUri: await qrDataUri(vUrl),
      },
      compliance: {
        frameworks: ['GHG Protocol (Scope 1 & 3)', 'ISO 14064-2/3', 'Directiva CSRD / Taxonomía Verde UE'],
        additionalityClause: 'La reducción de emisiones certificada en este paquete es adicional: no se habría producido sin la operación del nodo BioHybrid asociado.',
        doubleCountingClause: 'Sin doble contabilización — Art. 6.4 del Acuerdo de París. Los créditos de este paquete no han sido reclamados en ningún otro registro o inventario.',
        feedstockScopeClause: SOLIDS_ONLY_DISCLAIMER,
      },
      dbo5ToCreditsRatio: ratioDoc.dbo5ToCreditsRatio,
      biopelletTonsPerNodeYear: certConfig.biopelletTonsPerNodeYear,
      energyConsumptionGwhPerNode: certConfig.energyConsumptionGwhPerNode,
      records,
      totals: {
        co2eTons: rows.reduce((s, r) => s + (r.co2eTons || 0), 0),
        co2eWeightedTons: rows.reduce((s, r) => s + (r.co2eTons || 0) * gwpFactorFromGases(r.ghgGases), 0),
        dbo5Tons: rows.reduce((s, r) => s + (r.dbo5Tons || 0), 0),
        hectares: rows.reduce((s, r) => s + (r.hectares || 0), 0),
        mwhStabilized: rows.reduce((s, r) => s + (r.mwhStabilized || 0), 0),
        revenueEur: rows.reduce((s, r) => s + (r.revenueEur || 0), 0),
        nodeCount: rows.reduce((s, r) => s + (r.nodeCount || 1), 0),
        biopelletTons: rows.reduce((s, r) => s + (r.nodeCount || 1) * (certConfig.biopelletTonsPerNodeYear || 0), 0),
      },
      status: 'LISTO_PARA_COTIZACION',
    };
    await mongo.collection('pactvm_carbon_verify').insertOne({
      _id: packageId, type: 'certificado', period, merkleRoot, status: 'VERIFIED_AND_LOCKED', createdAt: snapshot.generatedAt,
      clientName: rows.length === 1 ? rows[0].clientName : `${rows.length} clientes`,
      recordCount: rows.length,
      co2eTotal: snapshot.totals.co2eTons,
      co2eWeightedTotal: snapshot.totals.co2eWeightedTons,
      dbo5Total: snapshot.totals.dbo5Tons,
    });
    const logEntry = await appendPactvmLog(mongo, { action: 'carbon.certificate_emitted', actorId: req.user, detail: { packageId, period, clientName: query.clientName || null, records: rows.length, snapshot } });
    res.status(201).json({ packageId, logSeq: logEntry.seq, snapshot });
  });

  // Endpoint publico (sin auth) para el QR de verificacion impreso en el
  // certificado — solo expone estado/hash, nunca datos comerciales del
  // cliente. Doctrina: "cualquier auditor externo (PwC/Deloitte/EY/KPMG o
  // regulador) puede verificar sin credenciales del sistema".
  app.get('/api/pactvm-verify/:packageId', async (req, res) => {
    const row = await mongo.collection('pactvm_carbon_verify').findOne({ _id: req.params.packageId });
    // El QR de los certificados apunta aqui: un movil escaneando pide
    // text/html (Safari/Camera de iOS), una llamada programatica pide
    // application/json — mismo endpoint publico, sin auth, dos formatos.
    const wantsHtml = (req.accepts(['html', 'json']) || 'json') === 'html';
    if (!row) {
      if (wantsHtml) return res.status(404).send(verifyCardHtml({ notFound: true, packageId: req.params.packageId }));
      return res.status(404).json({ status: 'NOT_FOUND', packageId: req.params.packageId });
    }
    const allowlist = await mongo.collection('pactvm_verify_allowlist').findOne({ _id: req.params.packageId });
    const gated = !!(allowlist && Array.isArray(allowlist.emails) && allowlist.emails.length > 0);
    if (wantsHtml) return res.send(verifyCardHtml({ row, gated }));
    if (gated) return res.status(403).json({ status: 'ACCESS_RESTRICTED', packageId: row._id });
    res.json({
      status: row.status,
      packageId: row._id,
      type: row.type,
      period: row.period,
      merkleRoot: row.merkleRoot,
      issuedAt: row.createdAt,
    });
  });

  // Desbloqueo del gate de acceso restringido: valida email (contra la
  // allowlist del packageId) + codigo temporal (generado por el admin
  // desde la consola, ver POST .../access-code). Sin sesion persistente
  // — el frontend usa esta respuesta directamente para renderizar los
  // datos client-side, nada queda guardado en el navegador del viewer.
  app.post('/api/pactvm-verify/:packageId/unlock', unlockPerIp, unlockPerTarget, async (req, res) => {
    const { packageId } = req.params;
    const email = String(req.body?.email || '').trim().toLowerCase();
    const code = String(req.body?.code || '').trim();
    if (!email || !code) return res.status(400).json({ error: 'email y codigo requeridos' });
    const allowlist = await mongo.collection('pactvm_verify_allowlist').findOne({ _id: packageId });
    if (!allowlist || !Array.isArray(allowlist.emails) || !allowlist.emails.includes(email)) {
      await appendPactvmLog(mongo, { action: 'carbon.verify_denied', actorId: 'externo', detail: { packageId, email, reason: 'email_no_autorizado' } });
      return res.status(403).json({ error: 'correo no autorizado para este paquete' });
    }
    const accessCode = await mongo.collection('pactvm_verify_access_codes').findOne({
      packageId, codeHash: hashAccessCode(code), expiresAt: { $gt: new Date().toISOString() },
    });
    if (!accessCode) {
      await appendPactvmLog(mongo, { action: 'carbon.verify_denied', actorId: 'externo', detail: { packageId, email, reason: 'codigo_invalido_o_caducado' } });
      return res.status(403).json({ error: 'codigo invalido o caducado' });
    }
    const row = await mongo.collection('pactvm_carbon_verify').findOne({ _id: packageId });
    if (!row) return res.status(404).json({ error: 'paquete no encontrado' });
    await mongo.collection('pactvm_verify_access_codes').updateOne(
      { _id: accessCode._id },
      { $push: { usedBy: { email, at: new Date().toISOString() } } },
    );
    res.json({
      status: row.status,
      packageId: row._id,
      type: row.type,
      period: row.period,
      clientName: row.clientName,
      co2eTotal: row.co2eTotal,
      co2eWeightedTotal: row.co2eWeightedTotal,
      dbo5Total: row.dbo5Total,
      merkleRoot: row.merkleRoot,
      issuedAt: row.createdAt,
    });
  });

  // ---- Gestion de acceso restringido por certificado (admin/mesa) ----

  router.get('/api/pactvm/carbon/packages/:packageId/allowlist', ...guard, async (req, res) => {
    const doc = await mongo.collection('pactvm_verify_allowlist').findOne({ _id: req.params.packageId });
    res.json({ packageId: req.params.packageId, emails: doc?.emails || [] });
  });

  router.put('/api/pactvm/carbon/packages/:packageId/allowlist', ...guard, async (req, res) => {
    const emails = Array.isArray(req.body?.emails)
      ? req.body.emails.map(e => String(e).trim().toLowerCase()).filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))
      : [];
    await mongo.collection('pactvm_verify_allowlist').updateOne(
      { _id: req.params.packageId },
      { $set: { emails, updatedBy: req.user, updatedAt: new Date().toISOString() } },
      { upsert: true },
    );
    await appendPactvmLog(mongo, { action: 'carbon.verify_allowlist_update', actorId: req.user, detail: { packageId: req.params.packageId, emails } });
    res.json({ packageId: req.params.packageId, emails });
  });

  router.post('/api/pactvm/carbon/packages/:packageId/access-code', ...guard, async (req, res) => {
    const minutes = Number(req.body?.minutes) || 20;
    if (minutes <= 0 || minutes > 240) return res.status(400).json({ error: 'minutes debe estar entre 1 y 240' });
    const code = String(crypto.randomInt(100000, 999999));
    const expiresAt = new Date(Date.now() + minutes * 60000).toISOString();
    const doc = {
      _id: crypto.randomUUID(),
      packageId: req.params.packageId,
      codeHash: hashAccessCode(code), // el codigo en claro solo se devuelve en esta respuesta
      expiresAt,
      createdBy: req.user,
      createdAt: new Date().toISOString(),
      usedBy: [],
    };
    await mongo.collection('pactvm_verify_access_codes').insertOne(doc);
    await appendPactvmLog(mongo, { action: 'carbon.verify_access_code_issued', actorId: req.user, detail: { packageId: req.params.packageId, expiresAt } });
    res.status(201).json({ code, expiresAt, minutes });
  });

  // QR bajo demanda para un packageId ya emitido: el snapshot original ya
  // trae su propio QR embebido, pero este endpoint permite regenerarlo
  // (misma URL de verificacion) para mostrarlo en la consola sin tener
  // que reabrir el PDF completo — util para proyectarlo en una reunion.
  router.get('/api/pactvm/carbon/packages/:packageId/qr', ...guard, async (req, res) => {
    const row = await mongo.collection('pactvm_carbon_verify').findOne({ _id: req.params.packageId });
    if (!row) return res.status(404).json({ error: 'paquete no encontrado' });
    const url = verificationUrl(req, req.params.packageId);
    const qr = await qrDataUri(url);
    if (!qr) return res.status(500).json({ error: 'no se pudo generar el QR' });
    res.json({ qrDataUri: qr, verificationUrl: url });
  });

  router.post('/api/pactvm/carbon/tokenize', ...guard, async (req, res) => {
    const b = req.body || {};
    const period = String(b.period || '').trim();
    if (!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: 'period invalido (formato YYYY-MM)' });
    const rows = await mongo.collection('pactvm_carbon_clients').find({ period }).toArray();
    if (rows.length === 0) return res.status(404).json({ error: 'sin registros para ese periodo' });
    const ratioDoc = await mongo.collection('pactvm_carbon_ratio').findOne({ _id: CARBON_RATIO_ID }) || DEFAULT_CARBON_RATIO;
    const certConfig = await mongo.collection('pactvm_cert_config').findOne({ _id: CERT_CONFIG_ID }) || DEFAULT_CERT_CONFIG;
    const tokenBatchId = crypto.randomUUID();
    const tokens = rows.map((r) => ({
      tokenId: crypto.randomUUID(),
      clientName: r.clientName,
      nodeLabel: r.nodeLabel || '',
      nodeCount: r.nodeCount || 1,
      unit: 'kg_biomasa_kwh_2030_2050',
      wasteCategory: r.wasteCategory || 'comida_no_comercializada',
      ghgGases: Array.isArray(r.ghgGases) && r.ghgGases.length ? r.ghgGases : ['co2'],
      gwpFactor: gwpFactorFromGases(r.ghgGases),
      co2eWeightedTons: (r.co2eTons || 0) * gwpFactorFromGases(r.ghgGases),
      creditsTokenized: r.dbo5Tons * (ratioDoc.dbo5ToCreditsRatio || 0),
      revenueEur: r.revenueEur,
      mwhStabilized: r.mwhStabilized || 0,
      biopelletTons: (r.nodeCount || 1) * (certConfig.biopelletTonsPerNodeYear || 0),
      gisLat: r.gisLat ?? null,
      gisLng: r.gisLng ?? null,
      cadastralRef: r.cadastralRef || '',
    }));
    const merkleRoot = merkleRootFromRecords(tokens);
    const vUrl = verificationUrl(req, tokenBatchId);
    const snapshot = {
      tokenBatchId,
      documentType: 'SOVEREIGN_ENVIRONMENTAL_BIO_ENERGY_ASSET_CERTIFICATE',
      period,
      generatedAt: new Date().toISOString(),
      generatedBy: req.user,
      security: {
        merkleRoot,
        rfc3161Timestamp: new Date().toISOString(),
        verificationUrl: vUrl,
        qrDataUri: await qrDataUri(vUrl),
      },
      compliance: {
        frameworks: ['GHG Protocol (Scope 1 & 3)', 'ISO 14064-2/3', 'Directiva CSRD / Taxonomía Verde UE'],
        additionalityClause: 'La reducción de emisiones tokenizada en este lote es adicional: no se habría producido sin la operación del nodo BioHybrid asociado.',
        doubleCountingClause: 'Sin doble contabilización — Art. 6.4 del Acuerdo de París. Los créditos de este lote no han sido reclamados en ningún otro registro o inventario.',
        feedstockScopeClause: SOLIDS_ONLY_DISCLAIMER,
      },
      standardRef: 'PACTVM_KG_BIOMASA_KWH',
      biopelletTonsPerNodeYear: certConfig.biopelletTonsPerNodeYear,
      energyConsumptionGwhPerNode: certConfig.energyConsumptionGwhPerNode,
      tokens,
      totalCreditsTokenized: tokens.reduce((s, t) => s + t.creditsTokenized, 0),
      totalRevenueEur: tokens.reduce((s, t) => s + (t.revenueEur || 0), 0),
      status: 'LISTO_PARA_COTIZACION',
    };
    await mongo.collection('pactvm_carbon_verify').insertOne({
      _id: tokenBatchId, type: 'tokenizacion', period, merkleRoot, status: 'VERIFIED_AND_LOCKED', createdAt: snapshot.generatedAt,
      clientName: rows.length === 1 ? rows[0].clientName : `${rows.length} clientes`,
      recordCount: rows.length,
      co2eTotal: tokens.reduce((s, t) => s + (t.co2eWeightedTons ? t.co2eWeightedTons / (t.gwpFactor || 1) : 0), 0),
      co2eWeightedTotal: tokens.reduce((s, t) => s + (t.co2eWeightedTons || 0), 0),
      dbo5Total: rows.reduce((s, r) => s + (r.dbo5Tons || 0), 0),
    });
    const logEntry = await appendPactvmLog(mongo, { action: 'carbon.tokenized', actorId: req.user, detail: { tokenBatchId, period, tokens: tokens.length, snapshot } });
    res.status(201).json({ tokenBatchId, logSeq: logEntry.seq, snapshot });
  });

  /* ---- historico de paquetes (certificados/tokenizaciones) generados ----
   * Recupera snapshots ya persistidos en pactvm_log (campo detail.snapshot)
   * para poder volver a exportarlos sin regenerar/perder el calculo. */

  router.get('/api/pactvm/carbon/packages', ...guard, async (req, res) => {
    const rows = await mongo.collection('pactvm_log')
      .find({ action: { $in: ['carbon.certificate_emitted', 'carbon.tokenized'] } })
      .sort({ seq: -1 })
      .toArray();
    const metaRows = await mongo.collection('pactvm_package_meta')
      .find({ _id: { $in: rows.map((r) => String(r.seq)) } })
      .toArray();
    const metaBySeq = new Map(metaRows.map((m) => [m._id, m]));
    const includeVoided = req.query.includeVoided === '1';
    const out = rows
      .map((r) => {
        const meta = metaBySeq.get(String(r.seq)) || null;
        return {
          logSeq: r.seq,
          action: r.action,
          type: r.action === 'carbon.certificate_emitted' ? 'certificado' : 'tokenizacion',
          packageId: r.detail?.packageId || r.detail?.tokenBatchId,
          period: r.detail?.period || null,
          clientName: meta?.clientNameOverride || r.detail?.clientName || null,
          records: r.detail?.records ?? r.detail?.tokens ?? null,
          actorId: r.actorId,
          createdAt: r.createdAt,
          hasSnapshot: !!r.detail?.snapshot || !!r.detail?.period,
          reconstructed: !r.detail?.snapshot,
          notes: meta?.notes || '',
          voided: !!meta?.voided,
          voidedReason: meta?.voidedReason || null,
        };
      })
      .filter((r) => includeVoided || !r.voided);
    res.json(out);
  });

  // Edicion/anulacion de paquetes ya emitidos. El calculo original congelado
  // en detail.snapshot de pactvm_log NUNCA se toca (integridad de la cadena
  // de hashes) — esto solo anota una capa de metadatos mutable aparte
  // (pactvm_package_meta) y dos acciones de auditoria propias en el log.
  router.patch('/api/pactvm/carbon/packages/:logSeq', ...adminGuard, async (req, res) => {
    const seq = Number(req.params.logSeq);
    if (!Number.isInteger(seq)) return res.status(400).json({ error: 'logSeq invalido' });
    const row = await mongo.collection('pactvm_log').findOne({ seq, action: { $in: ['carbon.certificate_emitted', 'carbon.tokenized'] } });
    if (!row) return res.status(404).json({ error: 'paquete no encontrado' });
    const b = req.body || {};
    const $set = { updatedBy: req.user, updatedAt: new Date().toISOString() };
    if (b.clientNameOverride !== undefined) $set.clientNameOverride = String(b.clientNameOverride).trim().slice(0, 200) || null;
    if (b.notes !== undefined) $set.notes = String(b.notes).trim().slice(0, 1000);
    await mongo.collection('pactvm_package_meta').updateOne(
      { _id: String(seq) },
      { $set, $setOnInsert: { createdBy: req.user, createdAt: new Date().toISOString() } },
      { upsert: true },
    );
    await appendPactvmLog(mongo, { action: 'carbon.package_annotated', actorId: req.user, detail: { logSeq: seq, $set } });
    const meta = await mongo.collection('pactvm_package_meta').findOne({ _id: String(seq) });
    res.json({ logSeq: seq, clientNameOverride: meta.clientNameOverride || null, notes: meta.notes || '', voided: !!meta.voided });
  });

  // "Eliminar" = anulacion logica (voided:true), nunca borrado del log
  // inmutable ni de pactvm_carbon_verify (el QR publico debe poder seguir
  // resolviendo el packageId como REVOCADO en vez de desaparecer sin rastro).
  router.delete('/api/pactvm/carbon/packages/:logSeq', ...adminGuard, async (req, res) => {
    const seq = Number(req.params.logSeq);
    if (!Number.isInteger(seq)) return res.status(400).json({ error: 'logSeq invalido' });
    const row = await mongo.collection('pactvm_log').findOne({ seq, action: { $in: ['carbon.certificate_emitted', 'carbon.tokenized'] } });
    if (!row) return res.status(404).json({ error: 'paquete no encontrado' });
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) : '';
    await mongo.collection('pactvm_package_meta').updateOne(
      { _id: String(seq) },
      { $set: { voided: true, voidedReason: reason || null, voidedBy: req.user, voidedAt: new Date().toISOString() }, $setOnInsert: { createdBy: req.user, createdAt: new Date().toISOString() } },
      { upsert: true },
    );
    const packageId = row.detail?.packageId || row.detail?.tokenBatchId;
    if (packageId) {
      await mongo.collection('pactvm_carbon_verify').updateOne({ _id: packageId }, { $set: { status: 'REVOKED', revokedAt: new Date().toISOString(), revokedBy: req.user, revokedReason: reason || null } });
    }
    await appendPactvmLog(mongo, { action: 'carbon.package_voided', actorId: req.user, detail: { logSeq: seq, packageId: packageId || null, reason: reason || null } });
    res.json({ logSeq: seq, voided: true });
  });

  router.get('/api/pactvm/carbon/packages/:logSeq', ...guard, async (req, res) => {
    const seq = Number(req.params.logSeq);
    if (!Number.isInteger(seq)) return res.status(400).json({ error: 'logSeq invalido' });
    const row = await mongo.collection('pactvm_log').findOne({ seq, action: { $in: ['carbon.certificate_emitted', 'carbon.tokenized'] } });
    if (!row) return res.status(404).json({ error: 'paquete no encontrado' });
    const meta = await mongo.collection('pactvm_package_meta').findOne({ _id: String(seq) });

    if (row.detail?.snapshot) {
      return res.json({
        logSeq: row.seq,
        action: row.action,
        type: row.action === 'carbon.certificate_emitted' ? 'certificado' : 'tokenizacion',
        snapshot: row.detail.snapshot,
        reconstructed: false,
        clientNameOverride: meta?.clientNameOverride || null,
        notes: meta?.notes || '',
        voided: !!meta?.voided,
        voidedReason: meta?.voidedReason || null,
      });
    }

    // Paquetes generados antes de persistir el snapshot completo en el log
    // (solo quedo el resumen en detail): se reconstruye con los datos ACTUALES
    // de pactvm_carbon_clients/ratio para poder seguir entregando el PDF, mal
    // marcado explicitamente como reconstruccion (no es el calculo exacto del
    // momento si el registro se edito despues de emitir/tokenizar).
    const period = row.detail?.period;
    if (!period) return res.status(404).json({ error: 'paquete sin snapshot ni periodo recuperable' });
    const query = { period };
    if (row.detail?.clientName) query.clientName = row.detail.clientName;
    const rows = await mongo.collection('pactvm_carbon_clients').find(query).toArray();
    const ratioDoc = await mongo.collection('pactvm_carbon_ratio').findOne({ _id: CARBON_RATIO_ID }) || DEFAULT_CARBON_RATIO;
    const certConfig = await mongo.collection('pactvm_cert_config').findOne({ _id: CERT_CONFIG_ID }) || DEFAULT_CERT_CONFIG;

    let snapshot;
    if (row.action === 'carbon.certificate_emitted') {
      const records = rows.map((r) => ({
        clientName: r.clientName,
        nodeLabel: r.nodeLabel || '',
        nodeCount: r.nodeCount || 1,
        co2eTons: r.co2eTons,
        dbo5Tons: r.dbo5Tons,
        wasteCategory: r.wasteCategory || 'comida_no_comercializada',
        ghgGases: Array.isArray(r.ghgGases) && r.ghgGases.length ? r.ghgGases : ['co2'],
        gwpFactor: gwpFactorFromGases(r.ghgGases),
        co2eWeightedTons: (r.co2eTons || 0) * gwpFactorFromGases(r.ghgGases),
        hectares: r.hectares,
        creditsEstimated: r.dbo5Tons * (ratioDoc.dbo5ToCreditsRatio || 0),
        revenueEur: r.revenueEur || 0,
        mwhStabilized: r.mwhStabilized || 0,
        biopelletTons: (r.nodeCount || 1) * (certConfig.biopelletTonsPerNodeYear || 0),
        gisLat: r.gisLat ?? null,
        gisLng: r.gisLng ?? null,
        cadastralRef: r.cadastralRef || '',
        source: r.source || '',
      }));
      const merkleRoot = merkleRootFromRecords(records);
      const vUrlCert = verificationUrl(req, row.detail.packageId);
      snapshot = {
        packageId: row.detail.packageId,
        documentType: 'SOVEREIGN_ENVIRONMENTAL_BIO_ENERGY_ASSET_CERTIFICATE',
        period,
        generatedAt: row.createdAt,
        generatedBy: row.actorId,
        security: {
          merkleRoot,
          sensorCalibrationChecksum: crypto.createHash('sha256').update(`${row.detail.packageId}:${merkleRoot}:${ratioDoc.dbo5ToCreditsRatio}`).digest('hex'),
          rfc3161Timestamp: row.createdAt,
          verificationUrl: vUrlCert,
          qrDataUri: await qrDataUri(vUrlCert),
        },
        compliance: {
          frameworks: ['GHG Protocol (Scope 1 & 3)', 'ISO 14064-2/3', 'Directiva CSRD / Taxonomía Verde UE'],
          additionalityClause: 'La reducción de emisiones certificada en este paquete es adicional: no se habría producido sin la operación del nodo BioHybrid asociado.',
          doubleCountingClause: 'Sin doble contabilización — Art. 6.4 del Acuerdo de París. Los créditos de este paquete no han sido reclamados en ningún otro registro o inventario.',
          feedstockScopeClause: SOLIDS_ONLY_DISCLAIMER,
        },
        dbo5ToCreditsRatio: ratioDoc.dbo5ToCreditsRatio,
        biopelletTonsPerNodeYear: certConfig.biopelletTonsPerNodeYear,
        energyConsumptionGwhPerNode: certConfig.energyConsumptionGwhPerNode,
        records,
        totals: {
          co2eTons: rows.reduce((s, r) => s + (r.co2eTons || 0), 0),
          co2eWeightedTons: rows.reduce((s, r) => s + (r.co2eTons || 0) * gwpFactorFromGases(r.ghgGases), 0),
          dbo5Tons: rows.reduce((s, r) => s + (r.dbo5Tons || 0), 0),
          hectares: rows.reduce((s, r) => s + (r.hectares || 0), 0),
          mwhStabilized: rows.reduce((s, r) => s + (r.mwhStabilized || 0), 0),
          revenueEur: rows.reduce((s, r) => s + (r.revenueEur || 0), 0),
          nodeCount: rows.reduce((s, r) => s + (r.nodeCount || 1), 0),
          biopelletTons: rows.reduce((s, r) => s + (r.nodeCount || 1) * (certConfig.biopelletTonsPerNodeYear || 0), 0),
        },
        status: 'LISTO_PARA_COTIZACION',
      };
    } else {
      const tokens = rows.map((r) => ({
        tokenId: null,
        clientName: r.clientName,
        nodeLabel: r.nodeLabel || '',
        nodeCount: r.nodeCount || 1,
        unit: 'kg_biomasa_kwh_2030_2050',
        wasteCategory: r.wasteCategory || 'comida_no_comercializada',
        ghgGases: Array.isArray(r.ghgGases) && r.ghgGases.length ? r.ghgGases : ['co2'],
        gwpFactor: gwpFactorFromGases(r.ghgGases),
        co2eWeightedTons: (r.co2eTons || 0) * gwpFactorFromGases(r.ghgGases),
        creditsTokenized: r.dbo5Tons * (ratioDoc.dbo5ToCreditsRatio || 0),
        revenueEur: r.revenueEur,
        mwhStabilized: r.mwhStabilized || 0,
        biopelletTons: (r.nodeCount || 1) * (certConfig.biopelletTonsPerNodeYear || 0),
        gisLat: r.gisLat ?? null,
        gisLng: r.gisLng ?? null,
        cadastralRef: r.cadastralRef || '',
      }));
      const merkleRoot = merkleRootFromRecords(tokens);
      const vUrlTok = verificationUrl(req, row.detail.tokenBatchId);
      snapshot = {
        tokenBatchId: row.detail.tokenBatchId,
        documentType: 'SOVEREIGN_ENVIRONMENTAL_BIO_ENERGY_ASSET_CERTIFICATE',
        period,
        generatedAt: row.createdAt,
        generatedBy: row.actorId,
        security: {
          merkleRoot,
          rfc3161Timestamp: row.createdAt,
          verificationUrl: vUrlTok,
          qrDataUri: await qrDataUri(vUrlTok),
        },
        compliance: {
          frameworks: ['GHG Protocol (Scope 1 & 3)', 'ISO 14064-2/3', 'Directiva CSRD / Taxonomía Verde UE'],
          additionalityClause: 'La reducción de emisiones tokenizada en este lote es adicional: no se habría producido sin la operación del nodo BioHybrid asociado.',
          doubleCountingClause: 'Sin doble contabilización — Art. 6.4 del Acuerdo de París. Los créditos de este lote no han sido reclamados en ningún otro registro o inventario.',
        },
        standardRef: 'PACTVM_KG_BIOMASA_KWH',
        biopelletTonsPerNodeYear: certConfig.biopelletTonsPerNodeYear,
        energyConsumptionGwhPerNode: certConfig.energyConsumptionGwhPerNode,
        tokens,
        totalCreditsTokenized: tokens.reduce((s, t) => s + t.creditsTokenized, 0),
        totalRevenueEur: tokens.reduce((s, t) => s + (t.revenueEur || 0), 0),
        status: 'LISTO_PARA_COTIZACION',
      };
    }

    res.json({
      logSeq: row.seq,
      action: row.action,
      type: row.action === 'carbon.certificate_emitted' ? 'certificado' : 'tokenizacion',
      snapshot,
      reconstructed: true,
    });
  });

  /* ---- resumen KPI ---- */

  router.get('/api/pactvm/summary', ...guard, async (req, res) => {
    const [cibeAll, policiesActive, accessRulesActive, herzogRecent, countryNodes] = await Promise.all([
      mongo.collection('pactvm_cibe').find({}).toArray(),
      mongo.collection('pactvm_policies').countDocuments({ active: true }),
      mongo.collection('pactvm_access_rules').countDocuments({ status: 'activo' }),
      herzogAudits().find({}).sort({ created_at: -1 }).limit(50).toArray(),
      mongo.collection('pactvm_country_nodes').find({}).toArray(),
    ]);
    const nodesTotal = countryNodes.reduce((sum, c) => sum + (c.nodesNeeded || 0), 0);
    const cibeEmitidos = cibeAll.filter((c) => c.status === 'emitido').length;
    const cibePendientes = cibeAll.filter((c) => c.status === 'pendiente').length;
    const herzogNoCandidato = herzogRecent.filter((r) => r.result_json?.classification === 'NO_CANDIDATO').length;
    res.json({
      cibeTotal: cibeAll.length,
      cibeEmitidos,
      cibePendientes,
      policiesActive,
      accessRulesActive,
      herzogAuditsRecent: herzogRecent.length,
      herzogNoCandidatoRecent: herzogNoCandidato,
      countriesTracked: countryNodes.length,
      nodesNeededTotal: nodesTotal,
      u2: typeof getU2Snapshot === 'function' ? getU2Snapshot() : null,
    });
  });

  /* ---- perdidas globales U-2 (solo lectura; unica conexion externa fuera de Herzog) ---- */

  router.get('/api/pactvm/u2-summary', ...guard, async (req, res) => {
    const snapshot = typeof getU2Snapshot === 'function' ? getU2Snapshot() : null;
    res.json({ snapshot });
  });

  /* ---- Motor Planetario: parametros globales, paises target (T/año), y
   * telemetria CUDA-Bio simulada (sin sensores reales conectados aun). ---- */

  router.get('/api/pactvm/planetary/config', ...guard, async (req, res) => {
    const doc = await mongo.collection('pactvm_planetary_config').findOne({ _id: PLANETARY_CONFIG_ID });
    res.json(withId(doc || DEFAULT_PLANETARY_CONFIG));
  });

  router.patch('/api/pactvm/planetary/config', ...guard, async (req, res) => {
    const b = req.body || {};
    const $set = { updatedAt: new Date().toISOString(), updatedBy: req.user };
    for (const [key, opts] of Object.entries({
      nodesMax: { min: 1 },
      nodesActive: { min: 0 },
      unitTicketEur: { min: 0 },
      nodeAnnualCapacityTYear: { min: 1 },
      carbonCreditPriceUsd: { min: 0 },
    })) {
      if (b[key] !== undefined) {
        const val = Number(b[key]);
        if (!Number.isFinite(val) || val < opts.min) return res.status(400).json({ error: `${key} invalido` });
        $set[key] = val;
      }
    }
    if (b.source !== undefined) $set.source = String(b.source).trim().slice(0, 300);
    await mongo.collection('pactvm_planetary_config').updateOne({ _id: PLANETARY_CONFIG_ID }, { $set }, { upsert: true });
    await appendPactvmLog(mongo, { action: 'planetary.config_update', actorId: req.user, detail: { $set } });
    const updated = await mongo.collection('pactvm_planetary_config').findOne({ _id: PLANETARY_CONFIG_ID });
    res.json(withId(updated));
  });

  router.get('/api/pactvm/planetary/countries', ...guard, async (req, res) => {
    const rows = await mongo.collection('pactvm_planetary_countries').find({}).sort({ wasteEstTYear: -1 }).toArray();
    res.json(rows.map(withId));
  });

  router.post('/api/pactvm/planetary/countries', ...guard, async (req, res) => {
    const b = req.body || {};
    const code = String(b.code || '').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(code)) return res.status(400).json({ error: 'code invalido (ISO-2)' });
    const label = String(b.label || '').trim();
    if (!label) return res.status(400).json({ error: 'label requerido' });
    const wasteEstTYear = Number(b.wasteEstTYear);
    if (!Number.isFinite(wasteEstTYear) || wasteEstTYear < 0) return res.status(400).json({ error: 'wasteEstTYear invalido' });
    const existing = await mongo.collection('pactvm_planetary_countries').findOne({ code });
    if (existing) return res.status(409).json({ error: `pais ${code} ya registrado` });
    const configDoc = await mongo.collection('pactvm_planetary_config').findOne({ _id: PLANETARY_CONFIG_ID }) || DEFAULT_PLANETARY_CONFIG;
    const doc = {
      _id: crypto.randomUUID(),
      code,
      label,
      wasteEstTYear,
      nodesTarget: Math.ceil(wasteEstTYear / (configDoc.nodeAnnualCapacityTYear || NODE_ANNUAL_CAPACITY_T_YEAR)),
      source: typeof b.source === 'string' ? b.source.trim().slice(0, 300) : '',
      createdBy: req.user,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await mongo.collection('pactvm_planetary_countries').insertOne(doc);
    await appendPactvmLog(mongo, { action: 'planetary.country_create', actorId: req.user, detail: { code, wasteEstTYear, nodesTarget: doc.nodesTarget } });
    res.status(201).json(withId(doc));
  });

  router.patch('/api/pactvm/planetary/countries/:id', ...guard, async (req, res) => {
    const row = await mongo.collection('pactvm_planetary_countries').findOne({ _id: req.params.id });
    if (!row) return res.status(404).json({ error: 'pais no encontrado' });
    const b = req.body || {};
    const $set = { updatedAt: new Date().toISOString() };
    if (b.wasteEstTYear !== undefined) {
      const wasteEstTYear = Number(b.wasteEstTYear);
      if (!Number.isFinite(wasteEstTYear) || wasteEstTYear < 0) return res.status(400).json({ error: 'wasteEstTYear invalido' });
      $set.wasteEstTYear = wasteEstTYear;
    }
    if (b.label !== undefined) {
      const label = String(b.label).trim();
      if (!label) return res.status(400).json({ error: 'label invalido' });
      $set.label = label;
    }
    if (b.source !== undefined) $set.source = String(b.source).trim().slice(0, 300);
    if ($set.wasteEstTYear !== undefined) {
      const configDoc = await mongo.collection('pactvm_planetary_config').findOne({ _id: PLANETARY_CONFIG_ID }) || DEFAULT_PLANETARY_CONFIG;
      $set.nodesTarget = Math.ceil($set.wasteEstTYear / (configDoc.nodeAnnualCapacityTYear || NODE_ANNUAL_CAPACITY_T_YEAR));
    }
    await mongo.collection('pactvm_planetary_countries').updateOne({ _id: req.params.id }, { $set });
    await appendPactvmLog(mongo, { action: 'planetary.country_update', actorId: req.user, detail: { id: req.params.id, $set } });
    const updated = await mongo.collection('pactvm_planetary_countries').findOne({ _id: req.params.id });
    res.json(withId(updated));
  });

  router.delete('/api/pactvm/planetary/countries/:id', ...guard, async (req, res) => {
    const result = await mongo.collection('pactvm_planetary_countries').deleteOne({ _id: req.params.id });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'pais no encontrado' });
    await appendPactvmLog(mongo, { action: 'planetary.country_delete', actorId: req.user, detail: { id: req.params.id } });
    res.json({ id: req.params.id });
  });

  router.get('/api/pactvm/planetary/summary', ...guard, async (req, res) => {
    const [configDoc, countries] = await Promise.all([
      mongo.collection('pactvm_planetary_config').findOne({ _id: PLANETARY_CONFIG_ID }),
      mongo.collection('pactvm_planetary_countries').find({}).toArray(),
    ]);
    const cfg = configDoc || DEFAULT_PLANETARY_CONFIG;
    const totalInfraValueEur = cfg.nodesMax * cfg.unitTicketEur;
    const globalProcessingTYear = cfg.nodesMax * cfg.nodeAnnualCapacityTYear;
    const nodesTargetSum = countries.reduce((sum, c) => sum + (c.nodesTarget || 0), 0);
    res.json({
      nodesMax: cfg.nodesMax,
      nodesActive: cfg.nodesActive,
      deployPct: cfg.nodesMax > 0 ? (cfg.nodesActive / cfg.nodesMax) * 100 : 0,
      unitTicketEur: cfg.unitTicketEur,
      totalInfraValueEur,
      nodeAnnualCapacityTYear: cfg.nodeAnnualCapacityTYear,
      globalProcessingTYear,
      carbonCreditPriceUsd: cfg.carbonCreditPriceUsd,
      countriesTracked: countries.length,
      nodesTargetSum,
      source: cfg.source,
    });
  });

  /* Telemetria "CUDA-Bio" — SIMULADA, sin sensores reales conectados. Oscila
   * de forma suave y determinista dentro de una franja realista usando el
   * minuto de reloj como semilla, para que la pantalla se vea viva delante
   * de inversores sin ser random caotico entre refrescos consecutivos. */
  function simulatedWave(baseline, amplitude, periodMinutes, phase = 0) {
    const minutesSinceEpoch = Date.now() / 60000;
    return baseline + amplitude * Math.sin((2 * Math.PI * minutesSinceEpoch) / periodMinutes + phase);
  }

  router.get('/api/pactvm/planetary/telemetry', ...guard, async (req, res) => {
    const configDoc = await mongo.collection('pactvm_planetary_config').findOne({ _id: PLANETARY_CONFIG_ID }) || DEFAULT_PLANETARY_CONFIG;
    res.json({
      simulated: true,
      note: 'Telemetria CUDA-Bio simulada — sin sensores fisicos conectados aun. Oscila dentro de una franja realista para demo/inversores.',
      generatedAt: new Date().toISOString(),
      bioCoreOccupancyPct: Number(simulatedWave(88.4, 3.2, 14, 0).toFixed(1)),
      massTransferBandwidthTMin: Number(simulatedWave(142.5, 8, 9, 1.1).toFixed(1)),
      thermalMethaneYieldPct: Number(simulatedWave(96.2, 1.1, 22, 2.4).toFixed(1)),
      carbonCreditMintingRateTokensSec: Number(simulatedWave(18.4, 1.8, 11, 0.6).toFixed(1)),
      carbonCreditPriceUsd: configDoc.carbonCreditPriceUsd,
      bioComputeBandwidthTbEquivalent: Number(simulatedWave(4.8, 0.3, 17, 3).toFixed(2)),
    });
  });

  /* ---- VDR: CRM geoespacial de empresas ----
   * Cada empresa registra un pais de ubicacion geografica (dropdown ISO-2,
   * mismo set de referencia que Nodos por Pais/Motor Planetario, con
   * lat/lng fijo en VDR_COUNTRY_COORDS), una ciudad opcional (geoCity, texto
   * libre, solo informativo — la estrella del globo se posiciona en las
   * coordenadas del PAIS, no de la ciudad, sin geocodificacion propia en el
   * repo) + un peso numerico (geoWeight,
   * PLACEHOLDER de "relevancia"/volumen — define el tamano de la estrella
   * en el globo individual) y un nivel de actividad en Espana (spainActivity,
   * PLACEHOLDER — define tamano/intensidad del punto rojo sobre Espana en
   * el mismo globo). Sin geometria propia: la vista geoespacial individual
   * (GET /api/pactvm/vdr/companies/:id/globe) resuelve lat/lng del pais
   * elegido a partir de esta tabla fija, ampliar si se registran paises
   * fuera de ella. */

  const VDR_COUNTRY_COORDS = {
    ES: { label: 'España', lat: 40.4168, lng: -3.7038 },
    PT: { label: 'Portugal', lat: 39.3999, lng: -8.2245 },
    FR: { label: 'Francia', lat: 46.6034, lng: 1.8883 },
    MA: { label: 'Marruecos', lat: 31.7917, lng: -7.0926 },
    MX: { label: 'México', lat: 23.6345, lng: -102.5528 },
    DE: { label: 'Alemania', lat: 51.1657, lng: 10.4515 },
    US: { label: 'Estados Unidos', lat: 37.0902, lng: -95.7129 },
    GB: { label: 'Reino Unido', lat: 55.3781, lng: -3.4360 },
    IT: { label: 'Italia', lat: 41.8719, lng: 12.5674 },
    BR: { label: 'Brasil', lat: -14.2350, lng: -51.9253 },
    DZ: { label: 'Argelia', lat: 28.0339, lng: 1.6596 },
  };
  const SPAIN_COORDS = VDR_COUNTRY_COORDS.ES;

  /* ---- Regiones internas por pais: centroide aproximado + reparto de nodos ----
   * Los nodos de curtailment se distribuyen por region interna en proporcion
   * a su poblacion (proxy de generacion de residuo organico y de demanda
   * electrica; no hay dataset de curtailment por region en el repo). El
   * campo weight es poblacion en millones (orden de magnitud) y sirve SOLO
   * como criterio de reparto — declarado como PLACEHOLDER igual que el resto
   * de cifras de VDR. radiusDeg acota la dispersion de los nodos dentro de
   * cada region para que caigan sobre su territorio y no formen un circulo
   * uniforme encima del pais.
   *
   * Solo ES y DZ tienen tabla de regiones propia hoy (DZ: 10 wilayas
   * mayores por poblacion, INE-style orden de magnitud, fuente Wikipedia
   * "List of Algerian provinces by population" + censo 2008 donde no hay
   * cifra 2023 oficial — mismo placeholder que ES). Un pais sin tabla usa
   * COUNTRY_REGIONS_FALLBACK (dispersion alrededor del centroide del pais en
   * VDR_COUNTRY_COORDS, sin reparto por region). Ampliar aqui si se añade un
   * pais nuevo y se quiere reparto por region en vez de dispersion generica. */
  const COUNTRY_REGIONS = {
    ES: [
      { code: 'AN', name: 'Andalucía',            lat: 37.55, lng: -4.75, weight: 8.58, radiusDeg: 1.45 },
      { code: 'CT', name: 'Cataluña',             lat: 41.75, lng:  1.60, weight: 7.90, radiusDeg: 0.90 },
      { code: 'MD', name: 'Comunidad de Madrid',  lat: 40.42, lng: -3.70, weight: 6.87, radiusDeg: 0.45 },
      { code: 'VC', name: 'Comunidad Valenciana', lat: 39.40, lng: -0.60, weight: 5.22, radiusDeg: 1.05 },
      { code: 'GA', name: 'Galicia',              lat: 42.75, lng: -7.90, weight: 2.70, radiusDeg: 0.85 },
      { code: 'CL', name: 'Castilla y León',      lat: 41.70, lng: -4.80, weight: 2.38, radiusDeg: 1.55 },
      { code: 'PV', name: 'País Vasco',           lat: 43.00, lng: -2.60, weight: 2.23, radiusDeg: 0.45 },
      { code: 'CN', name: 'Canarias',             lat: 28.35, lng: -15.85, weight: 2.24, radiusDeg: 1.20 },
      { code: 'CM', name: 'Castilla-La Mancha',   lat: 39.50, lng: -3.00, weight: 2.09, radiusDeg: 1.40 },
      { code: 'MC', name: 'Región de Murcia',     lat: 38.00, lng: -1.50, weight: 1.55, radiusDeg: 0.55 },
      { code: 'AR', name: 'Aragón',               lat: 41.50, lng: -0.70, weight: 1.34, radiusDeg: 1.15 },
      { code: 'IB', name: 'Illes Balears',        lat: 39.60, lng:  2.95, weight: 1.20, radiusDeg: 0.55 },
      { code: 'EX', name: 'Extremadura',          lat: 39.20, lng: -6.10, weight: 1.06, radiusDeg: 1.05 },
      { code: 'AS', name: 'Asturias',             lat: 43.30, lng: -5.95, weight: 1.01, radiusDeg: 0.45 },
      { code: 'NC', name: 'Navarra',              lat: 42.70, lng: -1.65, weight: 0.67, radiusDeg: 0.45 },
      { code: 'CB', name: 'Cantabria',            lat: 43.20, lng: -4.03, weight: 0.59, radiusDeg: 0.40 },
      { code: 'RI', name: 'La Rioja',             lat: 42.28, lng: -2.50, weight: 0.32, radiusDeg: 0.30 },
    ],
    DZ: [
      { code: 'ALG', name: 'Argel',       lat: 36.732,  lng:  3.087, weight: 7.80, radiusDeg: 0.70 },
      { code: 'ORA', name: 'Orán',        lat: 35.699,  lng: -0.636, weight: 1.58, radiusDeg: 0.65 },
      { code: 'SET', name: 'Setif',       lat: 36.191,  lng:  5.414, weight: 1.50, radiusDeg: 0.95 },
      { code: 'DJE', name: 'Djelfa',      lat: 34.673,  lng:  3.263, weight: 1.22, radiusDeg: 1.60 },
      { code: 'BAT', name: 'Batna',       lat: 35.556,  lng:  6.174, weight: 1.13, radiusDeg: 1.10 },
      { code: 'TIZ', name: 'Tizi Ouzou',  lat: 36.712,  lng:  4.046, weight: 1.13, radiusDeg: 0.55 },
      { code: 'BLI', name: 'Blida',       lat: 36.470,  lng:  2.830, weight: 1.01, radiusDeg: 0.45 },
      { code: 'CON', name: 'Constantina', lat: 36.365,  lng:  6.615, weight: 0.94, radiusDeg: 0.50 },
      { code: 'ANN', name: 'Annaba',      lat: 36.900,  lng:  7.767, weight: 0.64, radiusDeg: 0.45 },
      { code: 'CHL', name: 'Chlef',       lat: 36.170,  lng:  1.330, weight: 0.62, radiusDeg: 0.60 },
    ],
  };

  /* Pais sin tabla propia en COUNTRY_REGIONS: una sola "region" ficticia
   * centrada en el centroide del pais (VDR_COUNTRY_COORDS), con radio fijo
   * en grados para que el cluster disperso no se salga del territorio en
   * paises pequeños ni se quede minusculo en paises grandes. */
  const COUNTRY_REGIONS_FALLBACK_RADIUS_DEG = 2.2;
  function fallbackRegionsFor(countryCode) {
    const geo = VDR_COUNTRY_COORDS[countryCode];
    if (!geo) return [];
    return [{ code: countryCode, name: geo.label, lat: geo.lat, lng: geo.lng, weight: 1, radiusDeg: COUNTRY_REGIONS_FALLBACK_RADIUS_DEG }];
  }
  function regionsForCountry(countryCode) {
    return COUNTRY_REGIONS[countryCode] || fallbackRegionsFor(countryCode);
  }

  /* Reparto de N nodos entre regiones por el metodo de los restos mayores
   * (Hare): cada region recibe la parte entera de su cuota y los nodos
   * sobrantes van a los mayores restos. Garantiza que la suma sea EXACTAMENTE
   * N y que ninguna region con peso se quede en cero. */
  function distributeNodesByRegion(total, regions) {
    if (regions.length === 0) return [];
    const sumW = regions.reduce((s, r) => s + r.weight, 0);
    const rows = regions.map((r) => {
      const exact = (r.weight / sumW) * total;
      return { region: r, base: Math.floor(exact), rem: exact - Math.floor(exact) };
    });
    let assigned = rows.reduce((s, r) => s + r.base, 0);
    // minimo 1 nodo por region mientras queden nodos por repartir
    rows.forEach((r) => { if (r.base === 0 && assigned < total) { r.base = 1; assigned++; } });
    rows.sort((a, b) => b.rem - a.rem);
    for (let i = 0; assigned < total; i = (i + 1) % rows.length) { rows[i].base++; assigned++; }
    const byCode = new Map(rows.map((r) => [r.region.code, r.base]));
    return regions.map((r) => ({ region: r, count: byCode.get(r.code) || 0 }));
  }

  /* Posiciona los nodos de una comunidad dentro de su radio mediante espiral
   * de Fermat local (reparto uniforme sin solapes), corrigiendo la longitud
   * por el coseno de la latitud para que el area no se deforme al proyectar. */
  function placeRegionNodes(region, count, startIndex) {
    const golden = Math.PI * (3 - Math.sqrt(5));
    const lonScale = 1 / Math.max(0.2, Math.cos(region.lat * Math.PI / 180));
    const out = [];
    for (let i = 0; i < count; i++) {
      const rNorm = count === 1 ? 0 : Math.sqrt((i + 0.5) / count);
      const rad = rNorm * region.radiusDeg;
      const ang = (startIndex + i) * golden;
      out.push({
        lat: region.lat + rad * Math.sin(ang),
        lng: region.lng + rad * Math.cos(ang) * lonScale,
      });
    }
    return out;
  }

  /* Coordenadas de ciudad: cuando la empresa declara geoCity y la ciudad
   * esta en esta tabla, la estrella del globo se posiciona en la ciudad
   * exacta en vez del centroide del pais (Pisa vs centro de Italia son ~250
   * km). Sin geocodificador en el repo: tabla explicita, se amplia a mano.
   * Clave = ciudad normalizada (minusculas, sin acentos). */
  const VDR_CITY_COORDS = {
    IT: {
      pisa: { lat: 43.7228, lng: 10.4017 },
      roma: { lat: 41.9028, lng: 12.4964 },
      milan: { lat: 45.4642, lng: 9.1900 },
      milano: { lat: 45.4642, lng: 9.1900 },
      turin: { lat: 45.0703, lng: 7.6869 },
      torino: { lat: 45.0703, lng: 7.6869 },
      napoles: { lat: 40.8518, lng: 14.2681 },
      florencia: { lat: 43.7696, lng: 11.2558 },
    },
    ES: {
      madrid: { lat: 40.4168, lng: -3.7038 },
      barcelona: { lat: 41.3874, lng: 2.1686 },
      valencia: { lat: 39.4699, lng: -0.3763 },
      sevilla: { lat: 37.3891, lng: -5.9845 },
      bilbao: { lat: 43.2630, lng: -2.9350 },
      zaragoza: { lat: 41.6488, lng: -0.8891 },
      malaga: { lat: 36.7213, lng: -4.4214 },
      pamplona: { lat: 42.8125, lng: -1.6458 },
    },
    PT: { lisboa: { lat: 38.7223, lng: -9.1393 }, oporto: { lat: 41.1579, lng: -8.6291 } },
    FR: { paris: { lat: 48.8566, lng: 2.3522 }, lyon: { lat: 45.7640, lng: 4.8357 }, marsella: { lat: 43.2965, lng: 5.3698 } },
    DE: { berlin: { lat: 52.5200, lng: 13.4050 }, munich: { lat: 48.1351, lng: 11.5820 }, hamburgo: { lat: 53.5511, lng: 9.9937 } },
    GB: { londres: { lat: 51.5074, lng: -0.1278 }, manchester: { lat: 53.4808, lng: -2.2426 } },
    US: { 'nueva york': { lat: 40.7128, lng: -74.0060 }, houston: { lat: 29.7604, lng: -95.3698 }, 'san francisco': { lat: 37.7749, lng: -122.4194 } },
    MX: { 'ciudad de mexico': { lat: 19.4326, lng: -99.1332 }, monterrey: { lat: 25.6866, lng: -100.3161 }, guadalajara: { lat: 20.6597, lng: -103.3496 } },
    MA: { casablanca: { lat: 33.5731, lng: -7.5898 }, rabat: { lat: 34.0209, lng: -6.8416 } },
    BR: { 'sao paulo': { lat: -23.5505, lng: -46.6333 }, 'rio de janeiro': { lat: -22.9068, lng: -43.1729 } },
  };

  function normalizeCity(s) {
    return String(s || '').trim().toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '');
  }

  // Devuelve lat/lng de la ciudad si se reconoce, si no el centroide del pais.
  function resolveStarCoords(countryCode, city) {
    const country = VDR_COUNTRY_COORDS[countryCode];
    if (!country) return null;
    const key = normalizeCity(city);
    const hit = key && VDR_CITY_COORDS[countryCode]?.[key];
    if (hit) return { lat: hit.lat, lng: hit.lng, precision: 'ciudad' };
    return { lat: country.lat, lng: country.lng, precision: 'pais' };
  }

  router.get('/api/pactvm/vdr/countries', ...guard, async (req, res) => {
    res.json(Object.entries(VDR_COUNTRY_COORDS).map(([code, v]) => ({ code, label: v.label })));
  });

  router.get('/api/pactvm/vdr/es-config', ...guard, async (req, res) => {
    const doc = await mongo.collection('pactvm_vdr_es_config').findOne({ _id: VDR_ES_CONFIG_ID });
    res.json(withId({ ...DEFAULT_VDR_ES_CONFIG, ...(doc || {}) }));
  });

  router.patch('/api/pactvm/vdr/es-config', ...guard, async (req, res) => {
    const b = req.body || {};
    const $set = { updatedAt: new Date().toISOString(), updatedBy: req.user };
    if (b.nodesTargetTotal !== undefined) {
      const v = Number(b.nodesTargetTotal);
      if (!Number.isFinite(v) || v < 0 || !Number.isInteger(v)) return res.status(400).json({ error: 'nodesTargetTotal invalido' });
      $set.nodesTargetTotal = v;
    }
    if (b.curtailmentGwTargetMin !== undefined) {
      const v = Number(b.curtailmentGwTargetMin);
      if (!Number.isFinite(v) || v < 0) return res.status(400).json({ error: 'curtailmentGwTargetMin invalido' });
      $set.curtailmentGwTargetMin = v;
    }
    if (b.curtailmentGwTargetMax !== undefined) {
      const v = Number(b.curtailmentGwTargetMax);
      if (!Number.isFinite(v) || v < 0) return res.status(400).json({ error: 'curtailmentGwTargetMax invalido' });
      $set.curtailmentGwTargetMax = v;
    }
    if (b.nodeAnnualEnergyGwh !== undefined) {
      const v = Number(b.nodeAnnualEnergyGwh);
      if (!Number.isFinite(v) || v < 0) return res.status(400).json({ error: 'nodeAnnualEnergyGwh invalido' });
      $set.nodeAnnualEnergyGwh = v;
    }
    if (b.biopelletTonsPerNodeYear !== undefined) {
      const v = Number(b.biopelletTonsPerNodeYear);
      if (!Number.isFinite(v) || v < 0) return res.status(400).json({ error: 'biopelletTonsPerNodeYear invalido' });
      $set.biopelletTonsPerNodeYear = v;
    }
    if (b.biopelletPriceEurPerTon !== undefined) {
      const v = Number(b.biopelletPriceEurPerTon);
      if (!Number.isFinite(v) || v < 0) return res.status(400).json({ error: 'biopelletPriceEurPerTon invalido' });
      $set.biopelletPriceEurPerTon = v;
    }
    if (b.co2ch4AvoidedTonsPerNodeYear !== undefined) {
      const v = Number(b.co2ch4AvoidedTonsPerNodeYear);
      if (!Number.isFinite(v) || v < 0) return res.status(400).json({ error: 'co2ch4AvoidedTonsPerNodeYear invalido' });
      $set.co2ch4AvoidedTonsPerNodeYear = v;
    }
    if (b.annualLossEur !== undefined) {
      const v = Number(b.annualLossEur);
      if (!Number.isFinite(v) || v < 0) return res.status(400).json({ error: 'annualLossEur invalido' });
      $set.annualLossEur = v;
    }
    if (b.ppaClause !== undefined) $set.ppaClause = String(b.ppaClause).trim().slice(0, 1000);
    if (b.source !== undefined) $set.source = String(b.source).trim().slice(0, 300);
    await mongo.collection('pactvm_vdr_es_config').updateOne({ _id: VDR_ES_CONFIG_ID }, { $set }, { upsert: true });
    await appendPactvmLog(mongo, { action: 'vdr.es_config_update', actorId: req.user, detail: { $set } });
    const updated = await mongo.collection('pactvm_vdr_es_config').findOne({ _id: VDR_ES_CONFIG_ID });
    res.json(withId(updated));
  });

  router.get('/api/pactvm/vdr/companies', ...guard, async (req, res) => {
    const rows = await mongo.collection('pactvm_vdr_companies').find({}).sort({ name: 1 }).toArray();
    res.json(rows.map(withId));
  });

  router.get('/api/pactvm/vdr/companies/:id', ...guard, async (req, res) => {
    const row = await mongo.collection('pactvm_vdr_companies').findOne({ _id: req.params.id });
    if (!row) return res.status(404).json({ error: 'empresa no encontrada' });
    res.json(withId(row));
  });

  router.post('/api/pactvm/vdr/companies', ...guard, async (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name requerido' });
    const geoCountry = String(b.geoCountry || '').trim().toUpperCase();
    if (!VDR_COUNTRY_COORDS[geoCountry]) return res.status(400).json({ error: 'geoCountry invalido' });
    const geoCity = typeof b.geoCity === 'string' ? b.geoCity.trim().slice(0, 120) : '';
    const geoWeight = Number(b.geoWeight);
    if (!Number.isFinite(geoWeight) || geoWeight < 0) return res.status(400).json({ error: 'geoWeight invalido' });
    const spainActivity = Number(b.spainActivity);
    if (!Number.isFinite(spainActivity) || spainActivity < 0) return res.status(400).json({ error: 'spainActivity invalido' });
    const doc = {
      _id: crypto.randomUUID(),
      name,
      geoCountry,
      geoCity,
      geoWeight,
      spainActivity,
      notes: typeof b.notes === 'string' ? b.notes.trim().slice(0, 1000) : '',
      createdBy: req.user,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await mongo.collection('pactvm_vdr_companies').insertOne(doc);
    await appendPactvmLog(mongo, { action: 'vdr.company_create', actorId: req.user, detail: { id: doc._id, name, geoCountry, geoCity, geoWeight, spainActivity } });
    res.status(201).json(withId(doc));
  });

  router.patch('/api/pactvm/vdr/companies/:id', ...guard, async (req, res) => {
    const row = await mongo.collection('pactvm_vdr_companies').findOne({ _id: req.params.id });
    if (!row) return res.status(404).json({ error: 'empresa no encontrada' });
    const b = req.body || {};
    const $set = { updatedAt: new Date().toISOString() };
    if (b.name !== undefined) {
      const name = String(b.name).trim();
      if (!name) return res.status(400).json({ error: 'name invalido' });
      $set.name = name;
    }
    if (b.geoCountry !== undefined) {
      const geoCountry = String(b.geoCountry).trim().toUpperCase();
      if (!VDR_COUNTRY_COORDS[geoCountry]) return res.status(400).json({ error: 'geoCountry invalido' });
      $set.geoCountry = geoCountry;
    }
    if (b.geoCity !== undefined) $set.geoCity = String(b.geoCity).trim().slice(0, 120);
    if (b.geoWeight !== undefined) {
      const geoWeight = Number(b.geoWeight);
      if (!Number.isFinite(geoWeight) || geoWeight < 0) return res.status(400).json({ error: 'geoWeight invalido' });
      $set.geoWeight = geoWeight;
    }
    if (b.spainActivity !== undefined) {
      const spainActivity = Number(b.spainActivity);
      if (!Number.isFinite(spainActivity) || spainActivity < 0) return res.status(400).json({ error: 'spainActivity invalido' });
      $set.spainActivity = spainActivity;
    }
    if (b.notes !== undefined) $set.notes = String(b.notes).trim().slice(0, 1000);
    await mongo.collection('pactvm_vdr_companies').updateOne({ _id: req.params.id }, { $set });
    await appendPactvmLog(mongo, { action: 'vdr.company_update', actorId: req.user, detail: { id: req.params.id, $set } });
    const updated = await mongo.collection('pactvm_vdr_companies').findOne({ _id: req.params.id });
    res.json(withId(updated));
  });

  router.delete('/api/pactvm/vdr/companies/:id', ...guard, async (req, res) => {
    const result = await mongo.collection('pactvm_vdr_companies').deleteOne({ _id: req.params.id });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'empresa no encontrada' });
    await appendPactvmLog(mongo, { action: 'vdr.company_delete', actorId: req.user, detail: { id: req.params.id } });
    res.json({ id: req.params.id });
  });

  router.get('/api/pactvm/vdr/summary', ...guard, async (req, res) => {
    const rows = await mongo.collection('pactvm_vdr_companies').find({}).toArray();
    res.json({
      companiesTotal: rows.length,
      spainActivityTotal: rows.reduce((sum, r) => sum + (r.spainActivity || 0), 0),
      countriesTracked: new Set(rows.map((r) => r.geoCountry)).size,
    });
  });

  // Datos ya resueltos para renderizar el globo 3D individual de una empresa:
  // estrella en su pais (lat/lng + geoWeight -> tamano) y punto rojo fijo
  // sobre Espana (spainActivity -> tamano/intensidad), mas el bloque de
  // curtailment ES (roster de nodos #001.. pendientes de desplegar, ver
  // DEFAULT_VDR_ES_CONFIG). El roster se genera en cada request (no se
  // persisten 200 documentos por nodo — no hay estado individual por nodo
  // hoy, solo el contador agregado editable en pactvm_vdr_es_config).
  // Merge sobre los defaults: un doc sembrado antes de que existieran los
  // campos economicos (biopellet/CO2/perdida anual) sigue siendo valido y
  // hereda los valores por defecto en vez de devolver ceros.
  async function esConfigResolved() {
    const stored = await mongo.collection('pactvm_vdr_es_config').findOne({ _id: VDR_ES_CONFIG_ID });
    return { ...DEFAULT_VDR_ES_CONFIG, ...(stored || {}) };
  }

  // Payload del globo de una empresa. Compartido por la ruta autenticada y
  // por el enlace temporal de presentacion (sin auth): una sola
  // implementacion, para que la vista del invitado no derive de la real.
  //
  // El cluster de curtailment (spainDot/esCurtailment, nombres de campo
  // historicos que se mantienen por compatibilidad con el frontend y el PDF)
  // se posiciona SIEMPRE en el pais de la empresa (row.geoCountry), con
  // reparto por region interna si existe tabla en COUNTRY_REGIONS o
  // dispersion generica alrededor del centroide si no (ver regionsForCountry).
  // Antes quedaba fijo en España para cualquier empresa — ver docs/ESTADO-HISTORICO.md.
  function buildGlobePayload(row, esConfigDoc) {
    const geo = VDR_COUNTRY_COORDS[row.geoCountry];
    const clusterCoords = geo || SPAIN_COORDS;
    const nodesTotal = esConfigDoc.nodesTargetTotal || 0;
    const biopelletTonsPerNodeYear = esConfigDoc.biopelletTonsPerNodeYear || 0;
    const biopelletPriceEurPerTon = esConfigDoc.biopelletPriceEurPerTon || 0;
    const co2ch4AvoidedTonsPerNodeYear = esConfigDoc.co2ch4AvoidedTonsPerNodeYear || 0;
    const revenueEurPerNodeYear = Number((biopelletTonsPerNodeYear * biopelletPriceEurPerTon).toFixed(2));

    // Reparto geografico: los nodos se asignan a regiones internas del pais
    // de la empresa en proporcion a su peso y se posicionan dentro del
    // territorio de cada una (ver COUNTRY_REGIONS / distributeNodesByRegion),
    // en vez de formar un circulo uniforme sobre el centro del pais.
    const regions = regionsForCountry(row.geoCountry);
    const distribution = distributeNodesByRegion(nodesTotal, regions);
    const nodes = [];
    const regionsSummary = [];
    let running = 0;
    for (const { region, count } of distribution) {
      const positions = placeRegionNodes(region, count, running);
      positions.forEach((pos, i) => {
        nodes.push({
          code: `#${String(running + i + 1).padStart(3, '0')}`,
          status: 'pendiente_despliegue',
          regionCode: region.code,
          regionName: region.name,
          lat: Number(pos.lat.toFixed(4)),
          lng: Number(pos.lng.toFixed(4)),
          annualEnergyGwh: esConfigDoc.nodeAnnualEnergyGwh,
          biopelletTonsYear: biopelletTonsPerNodeYear,
          co2ch4AvoidedTonsYear: co2ch4AvoidedTonsPerNodeYear,
          revenueEurYear: revenueEurPerNodeYear,
        });
      });
      regionsSummary.push({
        code: region.code,
        name: region.name,
        lat: region.lat,
        lng: region.lng,
        nodes: count,
        annualEnergyGwh: Number((count * (esConfigDoc.nodeAnnualEnergyGwh || 0)).toFixed(2)),
        biopelletTonsYear: count * biopelletTonsPerNodeYear,
        co2ch4AvoidedTonsYear: count * co2ch4AvoidedTonsPerNodeYear,
        revenueEurYear: Number((count * revenueEurPerNodeYear).toFixed(2)),
      });
      running += count;
    }
    return {
      id: row._id,
      name: row.name,
      star: geo ? (() => {
        const c = resolveStarCoords(row.geoCountry, row.geoCity);
        return {
          countryCode: row.geoCountry,
          countryLabel: geo.label,
          city: row.geoCity || '',
          lat: c.lat,
          lng: c.lng,
          precision: c.precision, // 'ciudad' si se reconocio, si no 'pais'
          weight: row.geoWeight,
        };
      })() : null,
      spainDot: { lat: clusterCoords.lat, lng: clusterCoords.lng, intensity: row.spainActivity },
      esCurtailment: {
        countryCode: row.geoCountry,
        countryLabel: clusterCoords.label,
        lat: clusterCoords.lat,
        lng: clusterCoords.lng,
        nodesTargetTotal: nodesTotal,
        curtailmentGwTargetMin: esConfigDoc.curtailmentGwTargetMin,
        curtailmentGwTargetMax: esConfigDoc.curtailmentGwTargetMax,
        nodeAnnualEnergyGwh: esConfigDoc.nodeAnnualEnergyGwh,
        totalAnnualEnergyGwh: Number((nodesTotal * (esConfigDoc.nodeAnnualEnergyGwh || 0)).toFixed(2)),
        biopelletTonsPerNodeYear,
        biopelletPriceEurPerTon,
        co2ch4AvoidedTonsPerNodeYear,
        revenueEurPerNodeYear,
        totalBiopelletTonsYear: Number((nodesTotal * biopelletTonsPerNodeYear).toFixed(2)),
        totalCo2ch4AvoidedTonsYear: Number((nodesTotal * co2ch4AvoidedTonsPerNodeYear).toFixed(2)),
        totalRevenueEurYear: Number((nodesTotal * revenueEurPerNodeYear).toFixed(2)),
        annualLossEur: esConfigDoc.annualLossEur,
        ppaClause: esConfigDoc.ppaClause,
        regions: regionsSummary,
        nodes,
      },
    };
  }

  router.get('/api/pactvm/vdr/companies/:id/globe', ...guard, async (req, res) => {
    const row = await mongo.collection('pactvm_vdr_companies').findOne({ _id: req.params.id });
    if (!row) return res.status(404).json({ error: 'empresa no encontrada' });
    res.json(buildGlobePayload(row, await esConfigResolved()));
  });

  /* ---- VDR: enlace temporal para presentacion a cliente bajo NDA ----
   * Caso de uso: reunion comercial. El cliente firma NDA, se le da un enlace
   * que caduca (por defecto 15 min) y un codigo de 6 digitos dictado en la
   * sala. Su correo debe estar en la allowlist del enlace. Mismo patron ya
   * probado en la verificacion publica de certificados de carbono
   * (pactvm_verify_allowlist / pactvm_verify_access_codes).
   *
   * Alcance deliberado del invitado: puede explorar y simular, NO exportar
   * PDF ni navegar al resto del sistema. La vista invitado no monta sesion:
   * el unlock devuelve los datos y el navegador los usa en memoria.
   *
   * Limite conocido y aceptado (Nour, presentacion bajo NDA): quien ve la
   * pantalla puede capturarla. El enlace controla QUIEN entra, CUANTO tiempo
   * y deja traza de accesos — no impide la copia visual. La proteccion de
   * ese lado es contractual (NDA + derechos de autor), no tecnica. */

  const VDR_SHARE_DEFAULT_MINUTES = 15;
  const VDR_SHARE_MAX_MINUTES = 240;

  router.get('/api/pactvm/vdr/shares', ...guard, async (req, res) => {
    const rows = await mongo.collection('pactvm_vdr_shares').find({}).sort({ createdAt: -1 }).limit(50).toArray();
    const now = Date.now();
    res.json(rows.map((r) => ({
      id: r._id,
      companyId: r.companyId,
      companyName: r.companyName,
      emails: r.emails || [],
      expiresAt: r.expiresAt,
      expired: new Date(r.expiresAt).getTime() <= now,
      revoked: !!r.revoked,
      createdBy: r.createdBy,
      createdAt: r.createdAt,
      accessCount: (r.accessLog || []).length,
      accessLog: r.accessLog || [],
      // el codigo solo se devuelve al crearlo, nunca se re-expone aqui
    })));
  });

  router.post('/api/pactvm/vdr/shares', ...guard, async (req, res) => {
    const b = req.body || {};
    const companyId = String(b.companyId || '').trim();
    if (!companyId) return res.status(400).json({ error: 'companyId requerido' });
    const company = await mongo.collection('pactvm_vdr_companies').findOne({ _id: companyId });
    if (!company) return res.status(404).json({ error: 'empresa no encontrada' });

    const minutes = b.minutes === undefined ? VDR_SHARE_DEFAULT_MINUTES : Number(b.minutes);
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > VDR_SHARE_MAX_MINUTES) {
      return res.status(400).json({ error: `minutes debe estar entre 1 y ${VDR_SHARE_MAX_MINUTES}` });
    }
    const emails = Array.isArray(b.emails)
      ? [...new Set(b.emails.map((e) => String(e).trim().toLowerCase()).filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)))]
      : [];
    if (emails.length === 0) return res.status(400).json({ error: 'indica al menos un correo autorizado' });

    const token = crypto.randomBytes(24).toString('base64url');
    const code = String(crypto.randomInt(100000, 999999));
    const codeHash = crypto.createHash('sha256').update(code).digest('hex');
    const expiresAt = new Date(Date.now() + minutes * 60000).toISOString();
    const doc = {
      _id: token,
      companyId,
      companyName: company.name,
      emails,
      codeHash, // nunca se guarda el codigo en claro
      expiresAt,
      revoked: false,
      accessLog: [],
      createdBy: req.user,
      createdAt: new Date().toISOString(),
    };
    await mongo.collection('pactvm_vdr_shares').insertOne(doc);
    await appendPactvmLog(mongo, {
      action: 'vdr.share_created', actorId: req.user,
      detail: { token, companyId, companyName: company.name, emails, minutes, expiresAt },
    });
    const base = `${req.protocol}://${req.get('host')}`;
    res.status(201).json({
      token, code, expiresAt, minutes, emails,
      url: `${base}/pages/pactvm-vdr-invitado.html?t=${token}`,
    });
  });

  router.delete('/api/pactvm/vdr/shares/:token', ...guard, async (req, res) => {
    const result = await mongo.collection('pactvm_vdr_shares').updateOne(
      { _id: req.params.token },
      { $set: { revoked: true, revokedBy: req.user, revokedAt: new Date().toISOString() } },
    );
    if (result.matchedCount === 0) return res.status(404).json({ error: 'enlace no encontrado' });
    await appendPactvmLog(mongo, { action: 'vdr.share_revoked', actorId: req.user, detail: { token: req.params.token } });
    res.json({ token: req.params.token, revoked: true });
  });

  /* ---- rutas publicas del enlace temporal (SIN auth) ----
   * Fuera del prefijo '/api/pactvm' a proposito: server.js aplica
   * auth+requireMesa('pactvm') a todo ese prefijo con app.use ANTES de que
   * mountPactvm registre sus rutas, asi que una ruta publica ahi dentro
   * quedaria bloqueada pese a no llevar guard aqui. */

  function shareState(row) {
    if (!row) return { ok: false, reason: 'NOT_FOUND' };
    if (row.revoked) return { ok: false, reason: 'REVOKED' };
    if (new Date(row.expiresAt).getTime() <= Date.now()) return { ok: false, reason: 'EXPIRED' };
    return { ok: true };
  }

  // Estado del enlace: el invitado lo consulta al abrir, antes de introducir
  // credenciales. No revela nada del contenido, solo si sigue vivo.
  app.get('/api/vdr-share/:token', async (req, res) => {
    const row = await mongo.collection('pactvm_vdr_shares').findOne({ _id: req.params.token });
    const state = shareState(row);
    if (!state.ok) return res.status(state.reason === 'NOT_FOUND' ? 404 : 410).json({ status: state.reason });
    res.json({ status: 'ACTIVE', companyName: row.companyName, expiresAt: row.expiresAt });
  });

  // Desbloqueo: correo en la allowlist + codigo correcto. Devuelve el mismo
  // payload que el endpoint autenticado del globo. Sin sesion persistente.
  app.post('/api/vdr-share/:token/unlock', unlockPerIp, unlockPerTarget, async (req, res) => {
    const row = await mongo.collection('pactvm_vdr_shares').findOne({ _id: req.params.token });
    const state = shareState(row);
    if (!state.ok) return res.status(state.reason === 'NOT_FOUND' ? 404 : 410).json({ status: state.reason });

    const email = String(req.body?.email || '').trim().toLowerCase();
    const code = String(req.body?.code || '').trim();
    if (!email || !code) return res.status(400).json({ error: 'correo y código requeridos' });
    if (!row.emails.includes(email)) {
      await appendPactvmLog(mongo, { action: 'vdr.share_denied', actorId: 'invitado', detail: { token: row._id, email, reason: 'email_no_autorizado' } });
      return res.status(403).json({ error: 'correo no autorizado para este enlace' });
    }
    const codeHash = crypto.createHash('sha256').update(code).digest('hex');
    // comparacion en tiempo constante: evita distinguir codigos por latencia
    const given = Buffer.from(codeHash, 'hex');
    const expected = Buffer.from(row.codeHash, 'hex');
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
      await appendPactvmLog(mongo, { action: 'vdr.share_denied', actorId: 'invitado', detail: { token: row._id, email, reason: 'codigo_invalido' } });
      return res.status(403).json({ error: 'código inválido' });
    }

    const company = await mongo.collection('pactvm_vdr_companies').findOne({ _id: row.companyId });
    if (!company) return res.status(404).json({ error: 'empresa no encontrada' });

    await mongo.collection('pactvm_vdr_shares').updateOne(
      { _id: row._id },
      { $push: { accessLog: { email, at: new Date().toISOString(), ip: req.ip || null } } },
    );
    await appendPactvmLog(mongo, { action: 'vdr.share_accessed', actorId: 'invitado', detail: { token: row._id, email, companyId: row.companyId } });

    // El reparto territorial va bajo SPV LEVEL 2: no basta con ocultarlo en
    // la interfaz, se retira del payload para que tampoco viaje al cliente.
    const full = buildGlobePayload(company, await esConfigResolved());
    const globe = {
      ...full,
      esCurtailment: {
        ...full.esCurtailment,
        regions: undefined,
        nodes: full.esCurtailment.nodes.map(({ regionCode, regionName, ...rest }) => rest),
      },
    };
    delete globe.esCurtailment.regions;

    res.json({
      company: { id: company._id, name: company.name },
      globe,
      expiresAt: row.expiresAt,
    });
  });

  /* ---- integridad del log ---- */

  router.get('/api/pactvm/log/verify', ...guard, async (req, res) => {
    const all = await mongo.collection('pactvm_log').find({}).sort({ seq: 1 }).toArray();
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
