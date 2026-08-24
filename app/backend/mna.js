/**
 * S-NFI M&A — inteligencia corporativa para el crecimiento fractal (Volumen 2+)
 *
 * Alcance: modelado financiero para la absorcion de empresas competidoras o
 * complementarias, fusiones estrategicas y expansion del perimetro del
 * Holding internacional.
 *
 * Mismo patron que S-NFI Factory / Finance: CRUD directo sobre Mongo, sin
 * router TS separado. Log inmutable propio (mna_log, hash chain).
 */

import crypto from 'node:crypto';

function withId(doc) {
  if (!doc) return doc;
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/* ---- valoracion: multiplos EBITDA ---- */
function valuationMultiples(ebitda, multipleUsed) {
  return round2(ebitda * multipleUsed);
}

/* ---- valoracion: DCF auto-generado desde EBITDA + growth ---- */
function projectFreeCashflows(ebitdaBase, growthRate, horizonYears) {
  const flows = [];
  let value = ebitdaBase;
  for (let y = 1; y <= horizonYears; y++) {
    value = y === 1 ? ebitdaBase : value * (1 + growthRate);
    flows.push(round2(value));
  }
  return flows;
}

function valuationDCF(freeCashflows, wacc, terminalGrowthRate) {
  let pv = 0;
  freeCashflows.forEach((cf, idx) => {
    const year = idx + 1;
    pv += cf / Math.pow(1 + wacc, year);
  });
  const lastCf = freeCashflows[freeCashflows.length - 1] || 0;
  const terminalValue = wacc > terminalGrowthRate
    ? (lastCf * (1 + terminalGrowthRate)) / (wacc - terminalGrowthRate)
    : 0;
  const pvTerminal = terminalValue / Math.pow(1 + wacc, freeCashflows.length);
  return round2(pv + pvTerminal);
}

function synergyPayback(oneOffIntegrationCost, costSynergiesAnnual, revenueSynergiesAnnual) {
  const totalAnnual = costSynergiesAnnual + revenueSynergiesAnnual;
  if (totalAnnual <= 0) return null;
  return round2((oneOffIntegrationCost / totalAnnual) * 12);
}

function canonical(entry) {
  return JSON.stringify(entry, Object.keys(entry).sort());
}

async function appendMnaLog(mongo, entry) {
  const col = mongo.collection('mna_log');
  const tail = await col.find().sort({ seq: -1 }).limit(1).next();
  const seq = tail ? tail.seq + 1 : 1;
  const prevHash = tail ? tail.hash : '0'.repeat(64);
  const canonicalEntry = { ...entry, seq };
  const hash = crypto.createHash('sha256').update(prevHash + canonical(canonicalEntry)).digest('hex');
  const doc = { _id: crypto.randomUUID(), ...entry, seq, prevHash, hash, createdAt: new Date().toISOString() };
  await col.insertOne(doc);
  return doc;
}

const DEAL_TYPES = ['adquisicion', 'fusion', 'jv'];
const DEAL_STAGES = ['screening', 'nda', 'dd', 'loi', 'cierre'];
const DILIGENCE_STATUSES = ['pendiente', 'en_curso', 'ok', 'riesgo'];

export function mountMna(app, { auth, requireMesa, mongo }) {
  const router = app;
  const guard = [auth, requireMesa('mna')];

  async function requireDeal(dealId) {
    return mongo.collection('mna_deals').findOne({ _id: dealId });
  }

  /* ---- pipeline de candidatos ---- */

  router.get('/api/mna/deals', ...guard, async (req, res) => {
    const rows = await mongo.collection('mna_deals').find({}).sort({ _id: -1 }).toArray();
    res.json(rows.map(withId));
  });

  router.post('/api/mna/deals', ...guard, async (req, res) => {
    const b = req.body || {};
    const targetName = String(b.targetName || '').trim();
    if (!targetName) return res.status(400).json({ error: 'targetName requerido' });
    if (b.dealType && !DEAL_TYPES.includes(b.dealType)) return res.status(400).json({ error: 'dealType invalido' });

    const doc = {
      _id: crypto.randomUUID(),
      targetName,
      sector: typeof b.sector === 'string' ? b.sector.trim() : null,
      location: typeof b.location === 'string' ? b.location.trim() : null,
      dealType: b.dealType || 'adquisicion',
      stage: 'screening',
      ophsScore: Number.isFinite(Number(b.ophsScore)) ? Number(b.ophsScore) : null,
      owner: typeof b.owner === 'string' ? b.owner.trim() : null,
      blockerNote: null,
      createdBy: req.user,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await mongo.collection('mna_deals').insertOne(doc);
    await appendMnaLog(mongo, { action: 'deal.create', actorId: req.user, detail: { dealId: doc._id, targetName } });
    res.status(201).json(withId(doc));
  });

  router.patch('/api/mna/deals/:id', ...guard, async (req, res) => {
    const deal = await requireDeal(req.params.id);
    if (!deal) return res.status(404).json({ error: 'deal no encontrado' });
    const b = req.body || {};
    const $set = { updatedAt: new Date().toISOString() };

    if (b.stage !== undefined) {
      if (!DEAL_STAGES.includes(b.stage)) return res.status(400).json({ error: 'stage invalido' });
      $set.stage = b.stage;
    }
    if (b.blockerNote !== undefined) $set.blockerNote = b.blockerNote ? String(b.blockerNote).slice(0, 300) : null;
    if (b.owner !== undefined) $set.owner = b.owner ? String(b.owner).trim() : null;
    if (b.ophsScore !== undefined) $set.ophsScore = Number.isFinite(Number(b.ophsScore)) ? Number(b.ophsScore) : null;

    await mongo.collection('mna_deals').updateOne({ _id: req.params.id }, { $set });
    if ($set.stage && $set.stage !== deal.stage) {
      await appendMnaLog(mongo, { action: 'deal.stage_change', actorId: req.user, detail: { dealId: deal._id, from: deal.stage, to: $set.stage } });
    }
    const updated = await requireDeal(req.params.id);
    res.json(withId(updated));
  });

  router.delete('/api/mna/deals/:id', ...guard, async (req, res) => {
    const result = await mongo.collection('mna_deals').deleteOne({ _id: req.params.id });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'deal no encontrado' });
    await Promise.all([
      mongo.collection('mna_valuations').deleteMany({ dealId: req.params.id }),
      mongo.collection('mna_synergies').deleteMany({ dealId: req.params.id }),
      mongo.collection('mna_diligence_categories').deleteMany({ dealId: req.params.id }),
      mongo.collection('mna_diligence_items').deleteMany({ dealId: req.params.id }),
    ]);
    await appendMnaLog(mongo, { action: 'deal.delete', actorId: req.user, detail: { dealId: req.params.id } });
    res.json({ id: req.params.id });
  });

  /* ---- valoracion (multiplos + DCF) ---- */

  router.get('/api/mna/deals/:id/valuation', ...guard, async (req, res) => {
    const deal = await requireDeal(req.params.id);
    if (!deal) return res.status(404).json({ error: 'deal no encontrado' });
    const row = await mongo.collection('mna_valuations').findOne({ dealId: req.params.id });
    res.json(row ? withId(row) : null);
  });

  router.put('/api/mna/deals/:id/valuation', ...guard, async (req, res) => {
    const deal = await requireDeal(req.params.id);
    if (!deal) return res.status(404).json({ error: 'deal no encontrado' });
    const b = req.body || {};

    const ebitda = Number(b.ebitda);
    if (!Number.isFinite(ebitda) || ebitda <= 0) return res.status(400).json({ error: 'ebitda invalido' });
    const multipleUsed = Number(b.multipleUsed);
    if (!Number.isFinite(multipleUsed) || multipleUsed <= 0) return res.status(400).json({ error: 'multipleUsed invalido' });
    const growthRate = Number(b.growthRate);
    if (!Number.isFinite(growthRate)) return res.status(400).json({ error: 'growthRate invalido' });
    const wacc = Number(b.wacc);
    if (!Number.isFinite(wacc) || wacc <= 0) return res.status(400).json({ error: 'wacc invalido' });
    const terminalGrowthRate = Number(b.terminalGrowthRate);
    if (!Number.isFinite(terminalGrowthRate)) return res.status(400).json({ error: 'terminalGrowthRate invalido' });
    if (terminalGrowthRate >= wacc) return res.status(400).json({ error: 'terminalGrowthRate debe ser menor que wacc' });
    const horizonYears = Math.min(15, Math.max(1, Number(b.horizonYears) || 5));

    const cashPct = Number(b.cashPct) || 0;
    const stockPct = Number(b.stockPct) || 0;
    const earnoutPct = Number(b.earnoutPct) || 0;
    if (Math.round(cashPct + stockPct + earnoutPct) !== 100) {
      return res.status(400).json({ error: 'cashPct + stockPct + earnoutPct debe sumar 100' });
    }

    const freeCashflows = projectFreeCashflows(ebitda, growthRate, horizonYears);
    const impliedValueMultiples = valuationMultiples(ebitda, multipleUsed);
    const impliedValueDCF = valuationDCF(freeCashflows, wacc, terminalGrowthRate);

    const doc = {
      _id: crypto.randomUUID(),
      dealId: req.params.id,
      ebitda, multipleUsed, growthRate, wacc, terminalGrowthRate, horizonYears,
      freeCashflows,
      impliedValueMultiples, impliedValueDCF,
      structure: {
        cashPct, stockPct, earnoutPct,
        earnoutConditions: typeof b.earnoutConditions === 'string' ? b.earnoutConditions.slice(0, 500) : null,
        earnoutHorizonMonths: Number.isFinite(Number(b.earnoutHorizonMonths)) ? Number(b.earnoutHorizonMonths) : null,
      },
      createdBy: req.user,
      createdAt: new Date().toISOString(),
    };
    await mongo.collection('mna_valuations').deleteMany({ dealId: req.params.id });
    await mongo.collection('mna_valuations').insertOne(doc);
    await appendMnaLog(mongo, { action: 'valuation.set', actorId: req.user, detail: { dealId: req.params.id, impliedValueMultiples, impliedValueDCF } });
    res.status(201).json(withId(doc));
  });

  /* ---- sinergias ---- */

  router.get('/api/mna/deals/:id/synergies', ...guard, async (req, res) => {
    const row = await mongo.collection('mna_synergies').findOne({ dealId: req.params.id });
    res.json(row ? withId(row) : null);
  });

  router.put('/api/mna/deals/:id/synergies', ...guard, async (req, res) => {
    const deal = await requireDeal(req.params.id);
    if (!deal) return res.status(404).json({ error: 'deal no encontrado' });
    const b = req.body || {};
    const costSynergiesAnnual = Number(b.costSynergiesAnnual) || 0;
    const revenueSynergiesAnnual = Number(b.revenueSynergiesAnnual) || 0;
    const oneOffIntegrationCost = Number(b.oneOffIntegrationCost) || 0;
    if (costSynergiesAnnual < 0 || revenueSynergiesAnnual < 0 || oneOffIntegrationCost < 0) {
      return res.status(400).json({ error: 'valores de sinergia no pueden ser negativos' });
    }

    const doc = {
      _id: crypto.randomUUID(),
      dealId: req.params.id,
      costSynergiesAnnual, revenueSynergiesAnnual, oneOffIntegrationCost,
      paybackMonths: synergyPayback(oneOffIntegrationCost, costSynergiesAnnual, revenueSynergiesAnnual),
      createdBy: req.user,
      createdAt: new Date().toISOString(),
    };
    await mongo.collection('mna_synergies').deleteMany({ dealId: req.params.id });
    await mongo.collection('mna_synergies').insertOne(doc);
    await appendMnaLog(mongo, { action: 'synergies.set', actorId: req.user, detail: { dealId: req.params.id, paybackMonths: doc.paybackMonths } });
    res.status(201).json(withId(doc));
  });

  /* ---- due diligence: categorias custom por deal ---- */

  router.get('/api/mna/deals/:id/diligence/categories', ...guard, async (req, res) => {
    const rows = await mongo.collection('mna_diligence_categories').find({ dealId: req.params.id }).sort({ name: 1 }).toArray();
    res.json(rows.map(withId));
  });

  router.post('/api/mna/deals/:id/diligence/categories', ...guard, async (req, res) => {
    const deal = await requireDeal(req.params.id);
    if (!deal) return res.status(404).json({ error: 'deal no encontrado' });
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name requerido' });
    const doc = {
      _id: crypto.randomUUID(),
      dealId: req.params.id,
      name,
      description: typeof b.description === 'string' ? b.description : null,
      createdAt: new Date().toISOString(),
    };
    await mongo.collection('mna_diligence_categories').insertOne(doc);
    res.status(201).json(withId(doc));
  });

  router.delete('/api/mna/diligence/categories/:id', ...guard, async (req, res) => {
    const result = await mongo.collection('mna_diligence_categories').deleteOne({ _id: req.params.id });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'categoria no encontrada' });
    await mongo.collection('mna_diligence_items').deleteMany({ categoryId: req.params.id });
    res.json({ id: req.params.id });
  });

  /* ---- due diligence: items ---- */

  router.get('/api/mna/deals/:id/diligence/items', ...guard, async (req, res) => {
    const rows = await mongo.collection('mna_diligence_items').find({ dealId: req.params.id }).sort({ _id: -1 }).toArray();
    res.json(rows.map(withId));
  });

  router.post('/api/mna/deals/:id/diligence/items', ...guard, async (req, res) => {
    const deal = await requireDeal(req.params.id);
    if (!deal) return res.status(404).json({ error: 'deal no encontrado' });
    const b = req.body || {};
    const item = String(b.item || '').trim();
    if (!item) return res.status(400).json({ error: 'item requerido' });
    if (b.categoryId) {
      const cat = await mongo.collection('mna_diligence_categories').findOne({ _id: String(b.categoryId), dealId: req.params.id });
      if (!cat) return res.status(400).json({ error: 'categoria no encontrada' });
    }
    const doc = {
      _id: crypto.randomUUID(),
      dealId: req.params.id,
      categoryId: b.categoryId || null,
      item,
      status: 'pendiente',
      auditor: typeof b.auditor === 'string' ? b.auditor.trim() : null,
      note: null,
      createdAt: new Date().toISOString(),
    };
    await mongo.collection('mna_diligence_items').insertOne(doc);
    res.status(201).json(withId(doc));
  });

  router.patch('/api/mna/diligence/items/:id', ...guard, async (req, res) => {
    const b = req.body || {};
    const $set = {};
    if (b.status !== undefined) {
      if (!DILIGENCE_STATUSES.includes(b.status)) return res.status(400).json({ error: 'status invalido' });
      $set.status = b.status;
    }
    if (b.note !== undefined) $set.note = b.note ? String(b.note).slice(0, 500) : null;
    if (b.auditor !== undefined) $set.auditor = b.auditor ? String(b.auditor).trim() : null;
    const result = await mongo.collection('mna_diligence_items').updateOne({ _id: req.params.id }, { $set });
    if (result.matchedCount === 0) return res.status(404).json({ error: 'item no encontrado' });
    if ($set.status === 'riesgo') {
      const row = await mongo.collection('mna_diligence_items').findOne({ _id: req.params.id });
      await appendMnaLog(mongo, { action: 'diligence.risk_flagged', actorId: req.user, detail: { dealId: row.dealId, itemId: row._id, item: row.item } });
    }
    const updated = await mongo.collection('mna_diligence_items').findOne({ _id: req.params.id });
    res.json(withId(updated));
  });

  router.delete('/api/mna/diligence/items/:id', ...guard, async (req, res) => {
    const result = await mongo.collection('mna_diligence_items').deleteOne({ _id: req.params.id });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'item no encontrado' });
    res.json({ id: req.params.id });
  });

  /* ---- resumen KPI ---- */

  router.get('/api/mna/summary', ...guard, async (req, res) => {
    const [deals, riskItems, valuations] = await Promise.all([
      mongo.collection('mna_deals').find({}).toArray(),
      mongo.collection('mna_diligence_items').countDocuments({ status: 'riesgo' }),
      mongo.collection('mna_valuations').find({}).toArray(),
    ]);
    const activeDeals = deals.filter((d) => d.stage !== 'cierre').length;
    const inDiligence = deals.filter((d) => d.stage === 'dd').length;
    const totalPipelineValue = round2(valuations.reduce((sum, v) => sum + (v.impliedValueDCF || v.impliedValueMultiples || 0), 0));
    res.json({ activeDeals, inDiligence, totalPipelineValue, dealsAtRisk: riskItems });
  });

  /* ---- integridad del log ---- */

  router.get('/api/mna/log/verify', ...guard, async (req, res) => {
    const all = await mongo.collection('mna_log').find({}).sort({ seq: 1 }).toArray();
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
