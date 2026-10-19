/**
 * S-NFI Finance — control financiero y valoración de activos reales (Volumen 2+)
 *
 * Alcance: tráfico de tesorería, flujos de caja proyectados, contabilidad
 * analítica interna (centros de coste), gestión de cuentas y transferencias,
 * y pasarela de comunicación para la ejecución administrativa por parte de
 * la asesoría contable externa (export en PDF, 3 informes).
 *
 * Mismo patrón que S-NFI Factory: CRUD directo sobre Mongo, sin router TS
 * separado. Log inmutable propio (finance_log, hash chain) — no reusa
 * Sentinel porque ese middleware es forense de IP/rate-limit, no un log de
 * negocio genérico.
 *
 * Precisión monetaria: todo importe se persiste y opera en CÉNTIMOS (entero),
 * nunca en coma flotante decimal. Conversión a EUR solo en el borde de
 * entrada (parseAmountToCents) y salida (centsToEuros) hacia el cliente/PDF.
 * Esto elimina el arrastre de error de redondeo de Math.round(x*100)/100
 * al sumar grandes volúmenes de movimientos.
 */

import crypto from 'node:crypto';
import PDFDocument from 'pdfkit';
import { appendChained, verifyLog } from './lib/hash-chain.js';

/* ---- aritmética monetaria en céntimos (entero), sin coma flotante ---- */

export function parseAmountToCents(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

export function centsToEuros(cents) {
  return Math.round(cents) / 100;
}

function money(cents) {
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(centsToEuros(cents || 0));
}

function withId(doc) {
  if (!doc) return doc;
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
}

/* ---- IVA: importe base -> importe con IVA, en céntimos, redondeo bancario ---- */

export function applyVat(baseCents, vatRatePct) {
  const rate = Number(vatRatePct) || 0;
  const vatCents = Math.round(baseCents * (rate / 100));
  return { vatCents, totalCents: baseCents + vatCents };
}

/* ---- amortización lineal de activos, en céntimos ---- */

export function computeAssetCurrentValueCents(acquisitionCents, residualCents, acquisitionDate, usefulLifeMonths, asOf = new Date()) {
  const start = new Date(acquisitionDate);
  const monthsElapsed = Math.max(0, (asOf.getFullYear() - start.getFullYear()) * 12 + (asOf.getMonth() - start.getMonth()));
  if (usefulLifeMonths <= 0) return residualCents;
  const depreciableCents = acquisitionCents - residualCents;
  const monthlyCents = depreciableCents / usefulLifeMonths;
  const accumulatedCents = Math.min(depreciableCents, monthlyCents * monthsElapsed);
  return Math.max(residualCents, Math.round(acquisitionCents - accumulatedCents));
}

/* ---- proyección de caja, en céntimos ---- */

export function projectCashflow(currentBalanceCents, scheduledMovements, horizonDays, from = new Date()) {
  const points = [];
  let balanceCents = currentBalanceCents;
  const dailyDeltas = new Map();

  for (const mv of scheduledMovements) {
    const day = mv.valueDate.slice(0, 10);
    dailyDeltas.set(day, (dailyDeltas.get(day) || 0) + mv.amountCents);

    if (mv.recurring) {
      let next = new Date(mv.valueDate);
      const until = mv.recurring.until ? new Date(mv.recurring.until) : null;
      const horizonEnd = new Date(from.getTime() + horizonDays * 86400000);
      const step = mv.recurring.frequency === 'weekly' ? 7 : null;
      for (let i = 0; i < 120; i++) {
        next = step ? new Date(next.getTime() + step * 86400000) : new Date(next.getFullYear(), next.getMonth() + 1, next.getDate());
        if (next > horizonEnd) break;
        if (until && next > until) break;
        const key = next.toISOString().slice(0, 10);
        dailyDeltas.set(key, (dailyDeltas.get(key) || 0) + mv.amountCents);
      }
    }
  }

  for (let d = 0; d <= horizonDays; d++) {
    const date = new Date(from.getTime() + d * 86400000);
    const key = date.toISOString().slice(0, 10);
    const deltaCents = dailyDeltas.get(key) || 0;
    balanceCents += deltaCents;
    points.push({ date: key, balance: centsToEuros(balanceCents), delta: centsToEuros(deltaCents) });
  }
  return points;
}

const appendFinanceLog = (mongo, entry) => appendChained(mongo, 'finance_log', entry);

/* ---- generadores PDF: 3 informes separados ---- */

function pdfHeader(doc, title, payload) {
  doc.fontSize(18).text(`S-NFI Finance — ${title}`, { align: 'left' });
  doc.moveDown(0.3);
  doc.fontSize(10).fillColor('#555')
    .text(`Rango: ${payload.range.from} — ${payload.range.to}`)
    .text(`Generado: ${payload.generatedAt}`);
  doc.fillColor('#000');
  doc.moveDown();
}

function buildTesoreriaPdf(payload) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    pdfHeader(doc, 'Informe de Tesorería', payload);

    doc.fontSize(13).text('Saldo por cuenta', { underline: true });
    doc.moveDown(0.3);
    doc.fontSize(9);
    for (const a of payload.accounts) {
      doc.text(`${a.name.padEnd(28)}  ${a.kind.padEnd(6)}  ${money(a.balanceCents).padStart(16)}`);
    }
    doc.moveDown();

    doc.fontSize(13).text('Movimientos del periodo', { underline: true });
    doc.moveDown(0.3);
    if (!payload.movements.length) {
      doc.fontSize(10).fillColor('#777').text('Sin movimientos en el rango.').fillColor('#000');
    } else {
      doc.fontSize(9);
      let totalIngresos = 0, totalGastos = 0;
      for (const m of payload.movements) {
        if (m.amountCents >= 0) totalIngresos += m.amountCents; else totalGastos += m.amountCents;
        const vat = m.vatCents ? `  IVA ${money(m.vatCents)}` : '';
        doc.text(`${m.valueDate}  ${m.category.padEnd(8)}  ${money(m.amountCents).padStart(14)}${vat}   ${m.description || ''}`);
      }
      doc.moveDown(0.5);
      doc.fontSize(10).font('Helvetica-Bold');
      doc.text(`Total ingresos: ${money(totalIngresos)}`);
      doc.text(`Total gastos:   ${money(totalGastos)}`);
      doc.text(`Neto:           ${money(totalIngresos + totalGastos)}`);
      doc.font('Helvetica');
    }
    doc.moveDown();

    if (payload.transfers.length) {
      doc.fontSize(13).text('Transferencias entre cuentas', { underline: true });
      doc.moveDown(0.3);
      doc.fontSize(9);
      for (const t of payload.transfers) {
        doc.text(`${t.valueDate}  ${t.fromName} -> ${t.toName}   ${money(t.amountCents)}`);
      }
    }

    doc.end();
  });
}

function buildActivosPdf(payload) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    pdfHeader(doc, 'Informe de Activos (cuadro de amortización)', payload);

    if (!payload.assets.length) {
      doc.fontSize(10).fillColor('#777').text('Sin activos registrados.').fillColor('#000');
    } else {
      doc.fontSize(9);
      let totalAcquisition = 0, totalCurrent = 0;
      for (const a of payload.assets) {
        totalAcquisition += a.acquisitionCents;
        totalCurrent += a.currentValueCents;
        doc.font('Helvetica-Bold').text(a.name);
        doc.font('Helvetica').text(
          `  adquisición: ${a.acquisitionDate}  valor origen: ${money(a.acquisitionCents)}  ` +
          `residual: ${money(a.residualCents)}  vida útil: ${a.usefulLifeMonths}m  valor actual: ${money(a.currentValueCents)}`
        );
        doc.moveDown(0.2);
      }
      doc.moveDown(0.4);
      doc.fontSize(10).font('Helvetica-Bold');
      doc.text(`Valor origen total: ${money(totalAcquisition)}`);
      doc.text(`Valor actual total:  ${money(totalCurrent)}`);
      doc.text(`Depreciación acumulada: ${money(totalAcquisition - totalCurrent)}`);
      doc.font('Helvetica');
    }

    doc.end();
  });
}

function buildAnaliticaPdf(payload) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    pdfHeader(doc, 'Informe Analítico por Centro de Coste', payload);

    if (!payload.costCenters.length) {
      doc.fontSize(10).fillColor('#777').text('Sin centros de coste.').fillColor('#000');
    } else {
      const totalAbs = payload.costCenters.reduce((s, cc) => s + Math.abs(cc.totalCents), 0) || 1;
      doc.fontSize(9);
      for (const cc of payload.costCenters) {
        const pct = ((Math.abs(cc.totalCents) / totalAbs) * 100).toFixed(1);
        doc.font('Helvetica-Bold').text(`${cc.name}${cc.description ? ' — ' + cc.description : ''}`);
        doc.font('Helvetica').text(`  total: ${money(cc.totalCents)}   (${pct}% del movimiento total)   movimientos: ${cc.count}`);
        doc.moveDown(0.2);
      }
      doc.moveDown(0.3);
      const sinCentro = payload.movements.filter((m) => !m.costCenterId).reduce((s, m) => s + m.amountCents, 0);
      doc.fontSize(10).font('Helvetica-Bold').text(`Sin centro de coste asignado: ${money(sinCentro)}`);
      doc.font('Helvetica');
    }

    doc.end();
  });
}

const REPORT_BUILDERS = {
  tesoreria: buildTesoreriaPdf,
  activos: buildActivosPdf,
  analitica: buildAnaliticaPdf,
};

export function mountFinance(app, { auth, requireMesa, mongo }) {
  const router = app;
  const guard = [auth, requireMesa('finance')];

  /* ---- cuentas ---- */

  async function accountMovementsSumCents(accountId) {
    const rows = await mongo.collection('finance_movements')
      .aggregate([{ $match: { accountId } }, { $group: { _id: null, total: { $sum: '$amountCents' } } }])
      .toArray();
    return rows.length ? rows[0].total : 0;
  }

  async function accountBalanceCents(account) {
    return (account.openingBalanceCents || 0) + (await accountMovementsSumCents(account._id));
  }

  router.get('/api/finance/accounts', ...guard, async (req, res) => {
    const rows = await mongo.collection('finance_accounts').find({}).sort({ _id: 1 }).toArray();
    const withBalance = await Promise.all(rows.map(async (r) => ({
      ...withId(r),
      openingBalance: centsToEuros(r.openingBalanceCents || 0),
      balance: centsToEuros(await accountBalanceCents(r)),
    })));
    res.json(withBalance);
  });

  router.post('/api/finance/accounts', ...guard, async (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name requerido' });
    if (b.kind !== 'banco' && b.kind !== 'caja') return res.status(400).json({ error: 'kind debe ser banco o caja' });
    const openingBalanceCents = b.openingBalance !== undefined && b.openingBalance !== null && b.openingBalance !== ''
      ? parseAmountToCents(b.openingBalance)
      : 0;
    if (openingBalanceCents === null) return res.status(400).json({ error: 'openingBalance invalido' });
    const doc = {
      _id: crypto.randomUUID(),
      name,
      kind: b.kind,
      iban: typeof b.iban === 'string' && b.iban.trim() ? b.iban.trim() : null,
      currency: typeof b.currency === 'string' && b.currency.trim() ? b.currency.trim().toUpperCase() : 'EUR',
      openingBalanceCents,
      createdBy: req.user,
      createdAt: new Date().toISOString(),
    };
    await mongo.collection('finance_accounts').insertOne(doc);
    await appendFinanceLog(mongo, { action: 'account.create', actorId: req.user, detail: { accountId: doc._id, name, openingBalanceCents } });
    res.status(201).json({ ...withId(doc), openingBalance: centsToEuros(openingBalanceCents), balance: centsToEuros(openingBalanceCents) });
  });

  router.patch('/api/finance/accounts/:id', ...guard, async (req, res) => {
    const b = req.body || {};
    const account = await mongo.collection('finance_accounts').findOne({ _id: req.params.id });
    if (!account) return res.status(404).json({ error: 'cuenta no encontrada' });
    const update = {};
    if (b.name !== undefined) {
      const name = String(b.name).trim();
      if (!name) return res.status(400).json({ error: 'name invalido' });
      update.name = name;
    }
    if (b.iban !== undefined) update.iban = typeof b.iban === 'string' && b.iban.trim() ? b.iban.trim() : null;
    if (b.kind !== undefined) {
      if (b.kind !== 'banco' && b.kind !== 'caja') return res.status(400).json({ error: 'kind debe ser banco o caja' });
      update.kind = b.kind;
    }
    if (Object.keys(update).length === 0) return res.status(400).json({ error: 'nada que actualizar' });
    await mongo.collection('finance_accounts').updateOne({ _id: req.params.id }, { $set: update });
    await appendFinanceLog(mongo, { action: 'account.update', actorId: req.user, detail: { accountId: req.params.id, update } });
    const updated = await mongo.collection('finance_accounts').findOne({ _id: req.params.id });
    res.json({ ...withId(updated), openingBalance: centsToEuros(updated.openingBalanceCents || 0), balance: centsToEuros(await accountBalanceCents(updated)) });
  });

  router.delete('/api/finance/accounts/:id', ...guard, async (req, res) => {
    const result = await mongo.collection('finance_accounts').deleteOne({ _id: req.params.id });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'cuenta no encontrada' });
    await appendFinanceLog(mongo, { action: 'account.delete', actorId: req.user, detail: { accountId: req.params.id } });
    res.json({ id: req.params.id });
  });

  /* ---- transferencias entre cuentas propias ---- */

  router.get('/api/finance/transfers', ...guard, async (req, res) => {
    const rows = await mongo.collection('finance_transfers').find({}).sort({ valueDate: -1, _id: -1 }).limit(500).toArray();
    res.json(rows.map((r) => ({ ...withId(r), amount: centsToEuros(r.amountCents) })));
  });

  router.post('/api/finance/transfers', ...guard, async (req, res) => {
    const b = req.body || {};
    const fromId = String(b.fromAccountId || '');
    const toId = String(b.toAccountId || '');
    if (!fromId || !toId || fromId === toId) return res.status(400).json({ error: 'cuentas origen/destino invalidas' });
    const [fromAcc, toAcc] = await Promise.all([
      mongo.collection('finance_accounts').findOne({ _id: fromId }),
      mongo.collection('finance_accounts').findOne({ _id: toId }),
    ]);
    if (!fromAcc || !toAcc) return res.status(400).json({ error: 'cuenta no encontrada' });
    const amountCents = parseAmountToCents(b.amount);
    if (amountCents === null || amountCents <= 0) return res.status(400).json({ error: 'amount invalido' });
    if (!b.valueDate || Number.isNaN(Date.parse(b.valueDate))) return res.status(400).json({ error: 'valueDate invalido' });

    const transferId = crypto.randomUUID();
    const description = typeof b.description === 'string' ? b.description.trim().slice(0, 300) : '';
    const createdAt = new Date().toISOString();

    const outMv = {
      _id: crypto.randomUUID(), accountId: fromId, costCenterId: null,
      amountCents: -amountCents, valueDate: b.valueDate, description: description || `Transferencia a ${toAcc.name}`,
      category: 'transferencia', transferId, recurring: null, vatRatePct: 0, vatCents: 0,
      createdBy: req.user, createdAt,
    };
    const inMv = {
      _id: crypto.randomUUID(), accountId: toId, costCenterId: null,
      amountCents, valueDate: b.valueDate, description: description || `Transferencia desde ${fromAcc.name}`,
      category: 'transferencia', transferId, recurring: null, vatRatePct: 0, vatCents: 0,
      createdBy: req.user, createdAt,
    };
    await mongo.collection('finance_movements').insertMany([outMv, inMv]);

    const transferDoc = {
      _id: transferId, fromAccountId: fromId, toAccountId: toId, amountCents,
      valueDate: b.valueDate, description, createdBy: req.user, createdAt,
    };
    await mongo.collection('finance_transfers').insertOne(transferDoc);
    await appendFinanceLog(mongo, { action: 'transfer.create', actorId: req.user, detail: { transferId, fromId, toId, amountCents } });

    res.status(201).json({ ...withId(transferDoc), amount: centsToEuros(amountCents) });
  });

  /* ---- centros de coste ---- */

  router.get('/api/finance/cost-centers', ...guard, async (req, res) => {
    const rows = await mongo.collection('finance_cost_centers').find({}).sort({ name: 1 }).toArray();
    res.json(rows.map(withId));
  });

  router.post('/api/finance/cost-centers', ...guard, async (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name requerido' });
    const existing = await mongo.collection('finance_cost_centers').findOne({ name });
    if (existing) return res.status(409).json({ error: 'ya existe un centro de coste con ese nombre' });
    const doc = {
      _id: crypto.randomUUID(),
      name,
      description: typeof b.description === 'string' ? b.description : null,
      createdBy: req.user,
      createdAt: new Date().toISOString(),
    };
    await mongo.collection('finance_cost_centers').insertOne(doc);
    res.status(201).json(withId(doc));
  });

  router.patch('/api/finance/cost-centers/:id', ...guard, async (req, res) => {
    const b = req.body || {};
    const existing = await mongo.collection('finance_cost_centers').findOne({ _id: req.params.id });
    if (!existing) return res.status(404).json({ error: 'centro de coste no encontrado' });
    const update = {};
    if (b.name !== undefined) {
      const name = String(b.name).trim();
      if (!name) return res.status(400).json({ error: 'name invalido' });
      if (name !== existing.name) {
        const dup = await mongo.collection('finance_cost_centers').findOne({ name });
        if (dup) return res.status(409).json({ error: 'ya existe un centro de coste con ese nombre' });
      }
      update.name = name;
    }
    if (b.description !== undefined) update.description = typeof b.description === 'string' ? b.description.trim() || null : null;
    if (Object.keys(update).length === 0) return res.status(400).json({ error: 'nada que actualizar' });
    await mongo.collection('finance_cost_centers').updateOne({ _id: req.params.id }, { $set: update });
    const updated = await mongo.collection('finance_cost_centers').findOne({ _id: req.params.id });
    res.json(withId(updated));
  });

  router.delete('/api/finance/cost-centers/:id', ...guard, async (req, res) => {
    const result = await mongo.collection('finance_cost_centers').deleteOne({ _id: req.params.id });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'centro de coste no encontrado' });
    res.json({ id: req.params.id });
  });

  /* ---- movimientos de tesorería ---- */

  function serializeMovement(r) {
    return {
      ...withId(r),
      amount: centsToEuros(r.amountCents),
      vatRatePct: r.vatRatePct || 0,
      vat: centsToEuros(r.vatCents || 0),
      total: centsToEuros(r.amountCents + (r.vatCents || 0)),
    };
  }

  router.get('/api/finance/movements', ...guard, async (req, res) => {
    const { accountId, costCenterId, from, to } = req.query;
    const match = {};
    if (accountId) match.accountId = String(accountId);
    if (costCenterId) match.costCenterId = String(costCenterId);
    if (from || to) match.valueDate = { ...(from ? { $gte: String(from) } : {}), ...(to ? { $lte: String(to) } : {}) };
    const rows = await mongo.collection('finance_movements').find(match).sort({ valueDate: -1, _id: -1 }).limit(500).toArray();
    res.json(rows.map(serializeMovement));
  });

  router.post('/api/finance/movements', ...guard, async (req, res) => {
    const b = req.body || {};
    const account = await mongo.collection('finance_accounts').findOne({ _id: String(b.accountId || '') });
    if (!account) return res.status(400).json({ error: 'cuenta no encontrada' });

    const amountCents = parseAmountToCents(b.amount);
    if (amountCents === null || amountCents === 0) return res.status(400).json({ error: 'amount invalido' });
    if (!b.valueDate || Number.isNaN(Date.parse(b.valueDate))) return res.status(400).json({ error: 'valueDate invalido' });
    if (b.category !== 'ingreso' && b.category !== 'gasto') return res.status(400).json({ error: 'category debe ser ingreso o gasto' });
    if ((b.category === 'ingreso' && amountCents < 0) || (b.category === 'gasto' && amountCents > 0)) {
      return res.status(400).json({ error: 'el signo del importe no coincide con la categoria' });
    }

    let costCenterId = null;
    if (b.costCenterId) {
      const cc = await mongo.collection('finance_cost_centers').findOne({ _id: String(b.costCenterId) });
      if (!cc) return res.status(400).json({ error: 'centro de coste no encontrado' });
      costCenterId = cc._id;
    }

    let recurring = null;
    if (b.recurring) {
      if (b.recurring.frequency !== 'monthly' && b.recurring.frequency !== 'weekly') {
        return res.status(400).json({ error: 'frecuencia de recurrencia invalida' });
      }
      recurring = { frequency: b.recurring.frequency, until: typeof b.recurring.until === 'string' ? b.recurring.until : null };
    }

    const vatRatePct = Number(b.vatRatePct) || 0;
    if (vatRatePct < 0 || vatRatePct > 100) return res.status(400).json({ error: 'vatRatePct invalido' });
    const { vatCents } = applyVat(Math.abs(amountCents), vatRatePct);

    const doc = {
      _id: crypto.randomUUID(),
      accountId: account._id,
      costCenterId,
      amountCents,
      vatRatePct,
      vatCents: amountCents < 0 ? vatCents : vatCents, // IVA siempre positivo como magnitud informativa
      reference: typeof b.reference === 'string' ? b.reference.trim().slice(0, 80) : '',
      valueDate: b.valueDate,
      description: typeof b.description === 'string' ? b.description.trim().slice(0, 300) : '',
      category: b.category,
      recurring,
      createdBy: req.user,
      createdAt: new Date().toISOString(),
    };
    await mongo.collection('finance_movements').insertOne(doc);
    await appendFinanceLog(mongo, { action: 'movement.create', actorId: req.user, detail: { movementId: doc._id, accountId: account._id, amountCents: doc.amountCents, category: b.category } });
    res.status(201).json(serializeMovement(doc));
  });

  router.patch('/api/finance/movements/:id', ...guard, async (req, res) => {
    const b = req.body || {};
    const existing = await mongo.collection('finance_movements').findOne({ _id: req.params.id });
    if (!existing) return res.status(404).json({ error: 'movimiento no encontrado' });
    if (existing.category === 'transferencia' && existing.transferId) {
      return res.status(409).json({ error: 'movimiento de transferencia: no editable, elimina la transferencia asociada' });
    }

    const update = {};
    let amountCents = existing.amountCents;
    let category = existing.category;
    if (b.category !== undefined) {
      if (b.category !== 'ingreso' && b.category !== 'gasto') return res.status(400).json({ error: 'category debe ser ingreso o gasto' });
      category = b.category;
    }
    if (b.amount !== undefined) {
      const parsed = parseAmountToCents(b.amount);
      if (parsed === null || parsed === 0) return res.status(400).json({ error: 'amount invalido' });
      amountCents = category === 'gasto' ? -Math.abs(parsed) : Math.abs(parsed);
    } else if (b.category !== undefined) {
      amountCents = category === 'gasto' ? -Math.abs(existing.amountCents) : Math.abs(existing.amountCents);
    }
    if (amountCents !== existing.amountCents || category !== existing.category) {
      update.amountCents = amountCents;
      update.category = category;
    }

    if (b.vatRatePct !== undefined) {
      const vatRatePct = Number(b.vatRatePct) || 0;
      if (vatRatePct < 0 || vatRatePct > 100) return res.status(400).json({ error: 'vatRatePct invalido' });
      update.vatRatePct = vatRatePct;
      update.vatCents = applyVat(Math.abs(amountCents), vatRatePct).vatCents;
    } else if (update.amountCents !== undefined) {
      update.vatCents = applyVat(Math.abs(amountCents), existing.vatRatePct || 0).vatCents;
    }

    if (b.valueDate !== undefined) {
      if (!b.valueDate || Number.isNaN(Date.parse(b.valueDate))) return res.status(400).json({ error: 'valueDate invalido' });
      update.valueDate = b.valueDate;
    }
    if (b.description !== undefined) update.description = String(b.description).trim().slice(0, 300);
    if (b.reference !== undefined) update.reference = String(b.reference).trim().slice(0, 80);
    if (b.costCenterId !== undefined) {
      if (b.costCenterId) {
        const cc = await mongo.collection('finance_cost_centers').findOne({ _id: String(b.costCenterId) });
        if (!cc) return res.status(400).json({ error: 'centro de coste no encontrado' });
        update.costCenterId = cc._id;
      } else {
        update.costCenterId = null;
      }
    }
    if (b.accountId !== undefined) {
      const account = await mongo.collection('finance_accounts').findOne({ _id: String(b.accountId) });
      if (!account) return res.status(400).json({ error: 'cuenta no encontrada' });
      update.accountId = account._id;
    }

    if (Object.keys(update).length === 0) return res.status(400).json({ error: 'nada que actualizar' });
    await mongo.collection('finance_movements').updateOne({ _id: req.params.id }, { $set: update });
    await appendFinanceLog(mongo, { action: 'movement.update', actorId: req.user, detail: { movementId: req.params.id, update } });
    const updated = await mongo.collection('finance_movements').findOne({ _id: req.params.id });
    res.json(serializeMovement(updated));
  });

  router.delete('/api/finance/movements/:id', ...guard, async (req, res) => {
    const existing = await mongo.collection('finance_movements').findOne({ _id: req.params.id });
    if (!existing) return res.status(404).json({ error: 'movimiento no encontrado' });
    if (existing.category === 'transferencia' && existing.transferId) {
      return res.status(409).json({ error: 'movimiento de transferencia: elimina la transferencia asociada' });
    }
    await mongo.collection('finance_movements').deleteOne({ _id: req.params.id });
    await appendFinanceLog(mongo, { action: 'movement.delete', actorId: req.user, detail: { movementId: req.params.id } });
    res.json({ id: req.params.id });
  });

  /* ---- proyección de caja ---- */

  router.get('/api/finance/projection', ...guard, async (req, res) => {
    const accountId = req.query.accountId ? String(req.query.accountId) : null;
    const horizonDays = Math.min(365, Math.max(1, Number(req.query.horizonDays) || 90));
    const match = accountId ? { accountId } : {};
    const allMovements = await mongo.collection('finance_movements').find(match).toArray();

    let currentBalanceCents;
    if (accountId) {
      const account = await mongo.collection('finance_accounts').findOne({ _id: accountId });
      currentBalanceCents = account ? await accountBalanceCents(account) : 0;
    } else {
      const accounts = await mongo.collection('finance_accounts').find({}).toArray();
      const openingSum = accounts.reduce((sum, a) => sum + (a.openingBalanceCents || 0), 0);
      currentBalanceCents = openingSum + allMovements.reduce((sum, m) => sum + m.amountCents, 0);
    }

    const todayIso = new Date().toISOString().slice(0, 10);
    const future = allMovements.filter((m) => m.valueDate >= todayIso);
    const points = projectCashflow(currentBalanceCents, future, horizonDays);
    res.json({ accountId, horizonDays, currentBalance: centsToEuros(currentBalanceCents), points });
  });

  /* ---- analítica: series mensuales para gráficos ---- */

  router.get('/api/finance/analytics', ...guard, async (req, res) => {
    const months = Math.min(24, Math.max(1, Number(req.query.months) || 12));
    const now = new Date();
    const fromDate = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1);
    const fromIso = fromDate.toISOString().slice(0, 10);

    const [movements, costCenters] = await Promise.all([
      mongo.collection('finance_movements').find({ valueDate: { $gte: fromIso }, category: { $ne: 'transferencia' } }).toArray(),
      mongo.collection('finance_cost_centers').find({}).toArray(),
    ]);

    const byMonth = new Map();
    for (let i = 0; i < months; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - (months - 1 - i), 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      byMonth.set(key, { month: key, incomeCents: 0, expenseCents: 0 });
    }
    for (const m of movements) {
      const key = m.valueDate.slice(0, 7);
      if (!byMonth.has(key)) continue;
      const bucket = byMonth.get(key);
      if (m.amountCents >= 0) bucket.incomeCents += m.amountCents; else bucket.expenseCents += m.amountCents;
    }
    const series = Array.from(byMonth.values()).map((b) => ({
      month: b.month,
      income: centsToEuros(b.incomeCents),
      expense: centsToEuros(b.expenseCents),
      net: centsToEuros(b.incomeCents + b.expenseCents),
    }));

    const byCostCenter = new Map();
    for (const cc of costCenters) byCostCenter.set(cc._id, { id: cc._id, name: cc.name, totalCents: 0, count: 0 });
    let unassignedCents = 0, unassignedCount = 0;
    for (const m of movements) {
      if (m.costCenterId && byCostCenter.has(m.costCenterId)) {
        const bucket = byCostCenter.get(m.costCenterId);
        bucket.totalCents += m.amountCents;
        bucket.count += 1;
      } else {
        unassignedCents += m.amountCents;
        unassignedCount += 1;
      }
    }
    const costCenterBreakdown = Array.from(byCostCenter.values())
      .map((b) => ({ id: b.id, name: b.name, total: centsToEuros(b.totalCents), count: b.count }))
      .concat(unassignedCount ? [{ id: null, name: 'Sin asignar', total: centsToEuros(unassignedCents), count: unassignedCount }] : []);

    res.json({ months, series, costCenterBreakdown });
  });

  /* ---- activos reales ---- */

  function serializeAsset(r) {
    const currentValueCents = computeAssetCurrentValueCents(r.acquisitionCents, r.residualCents, r.acquisitionDate, r.usefulLifeMonths);
    return {
      ...withId(r),
      acquisitionValue: centsToEuros(r.acquisitionCents),
      residualValue: centsToEuros(r.residualCents),
      currentValue: centsToEuros(currentValueCents),
    };
  }

  router.get('/api/finance/assets', ...guard, async (req, res) => {
    const rows = await mongo.collection('finance_assets').find({}).sort({ _id: 1 }).toArray();
    res.json(rows.map(serializeAsset));
  });

  router.post('/api/finance/assets', ...guard, async (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name requerido' });
    const acquisitionCents = parseAmountToCents(b.acquisitionValue);
    if (acquisitionCents === null || acquisitionCents <= 0) return res.status(400).json({ error: 'acquisitionValue invalido' });
    const residualCents = parseAmountToCents(b.residualValue ?? 0);
    if (residualCents === null || residualCents < 0 || residualCents > acquisitionCents) return res.status(400).json({ error: 'residualValue invalido' });
    if (!b.acquisitionDate || Number.isNaN(Date.parse(b.acquisitionDate))) return res.status(400).json({ error: 'acquisitionDate invalido' });
    const usefulLifeMonths = Number(b.usefulLifeMonths);
    if (!Number.isFinite(usefulLifeMonths) || usefulLifeMonths <= 0) return res.status(400).json({ error: 'usefulLifeMonths invalido' });

    let costCenterId = null;
    if (b.costCenterId) {
      const cc = await mongo.collection('finance_cost_centers').findOne({ _id: String(b.costCenterId) });
      if (!cc) return res.status(400).json({ error: 'centro de coste no encontrado' });
      costCenterId = cc._id;
    }

    const doc = {
      _id: crypto.randomUUID(),
      name,
      costCenterId,
      acquisitionCents,
      residualCents,
      acquisitionDate: b.acquisitionDate,
      usefulLifeMonths,
      createdBy: req.user,
      createdAt: new Date().toISOString(),
    };
    await mongo.collection('finance_assets').insertOne(doc);
    await appendFinanceLog(mongo, { action: 'asset.create', actorId: req.user, detail: { assetId: doc._id, name } });
    res.status(201).json(serializeAsset(doc));
  });

  router.patch('/api/finance/assets/:id', ...guard, async (req, res) => {
    const b = req.body || {};
    const existing = await mongo.collection('finance_assets').findOne({ _id: req.params.id });
    if (!existing) return res.status(404).json({ error: 'activo no encontrado' });

    const update = {};
    if (b.name !== undefined) {
      const name = String(b.name).trim();
      if (!name) return res.status(400).json({ error: 'name invalido' });
      update.name = name;
    }
    if (b.acquisitionValue !== undefined) {
      const acquisitionCents = parseAmountToCents(b.acquisitionValue);
      if (acquisitionCents === null || acquisitionCents <= 0) return res.status(400).json({ error: 'acquisitionValue invalido' });
      update.acquisitionCents = acquisitionCents;
    }
    if (b.residualValue !== undefined) {
      const residualCents = parseAmountToCents(b.residualValue);
      const acquisitionCents = update.acquisitionCents ?? existing.acquisitionCents;
      if (residualCents === null || residualCents < 0 || residualCents > acquisitionCents) return res.status(400).json({ error: 'residualValue invalido' });
      update.residualCents = residualCents;
    }
    if (b.acquisitionDate !== undefined) {
      if (!b.acquisitionDate || Number.isNaN(Date.parse(b.acquisitionDate))) return res.status(400).json({ error: 'acquisitionDate invalido' });
      update.acquisitionDate = b.acquisitionDate;
    }
    if (b.usefulLifeMonths !== undefined) {
      const usefulLifeMonths = Number(b.usefulLifeMonths);
      if (!Number.isFinite(usefulLifeMonths) || usefulLifeMonths <= 0) return res.status(400).json({ error: 'usefulLifeMonths invalido' });
      update.usefulLifeMonths = usefulLifeMonths;
    }
    if (b.costCenterId !== undefined) {
      if (b.costCenterId) {
        const cc = await mongo.collection('finance_cost_centers').findOne({ _id: String(b.costCenterId) });
        if (!cc) return res.status(400).json({ error: 'centro de coste no encontrado' });
        update.costCenterId = cc._id;
      } else {
        update.costCenterId = null;
      }
    }

    if (Object.keys(update).length === 0) return res.status(400).json({ error: 'nada que actualizar' });
    await mongo.collection('finance_assets').updateOne({ _id: req.params.id }, { $set: update });
    await appendFinanceLog(mongo, { action: 'asset.update', actorId: req.user, detail: { assetId: req.params.id, update } });
    const updated = await mongo.collection('finance_assets').findOne({ _id: req.params.id });
    res.json(serializeAsset(updated));
  });

  router.delete('/api/finance/assets/:id', ...guard, async (req, res) => {
    const result = await mongo.collection('finance_assets').deleteOne({ _id: req.params.id });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'activo no encontrado' });
    await appendFinanceLog(mongo, { action: 'asset.delete', actorId: req.user, detail: { assetId: req.params.id } });
    res.json({ id: req.params.id });
  });

  /* ---- pasarela: exports PDF para asesoría externa (3 tipos de informe) ---- */

  router.post('/api/finance/exports', ...guard, async (req, res) => {
    const b = req.body || {};
    const fromDate = String(b.fromDate || '');
    const toDate = String(b.toDate || '');
    const reportType = String(b.reportType || 'tesoreria');
    if (!REPORT_BUILDERS[reportType]) return res.status(400).json({ error: 'reportType invalido' });
    if (!fromDate || !toDate || Number.isNaN(Date.parse(fromDate)) || Number.isNaN(Date.parse(toDate))) {
      return res.status(400).json({ error: 'rango de fechas invalido' });
    }

    const [movements, assets, costCenters, accounts, transferRows] = await Promise.all([
      mongo.collection('finance_movements').find({ valueDate: { $gte: fromDate, $lte: toDate } }).toArray(),
      mongo.collection('finance_assets').find({}).toArray(),
      mongo.collection('finance_cost_centers').find({}).toArray(),
      mongo.collection('finance_accounts').find({}).toArray(),
      mongo.collection('finance_transfers').find({ valueDate: { $gte: fromDate, $lte: toDate } }).toArray(),
    ]);

    const accountsById = new Map(accounts.map((a) => [a._id, a]));
    const accountsWithBalance = await Promise.all(accounts.map(async (a) => ({
      name: a.name, kind: a.kind, balanceCents: await accountBalanceCents(a),
    })));

    const costCenterTotals = costCenters.map((cc) => {
      const ccMovements = movements.filter((m) => m.costCenterId === cc._id && m.category !== 'transferencia');
      return { name: cc.name, description: cc.description, totalCents: ccMovements.reduce((s, m) => s + m.amountCents, 0), count: ccMovements.length };
    });

    const payload = {
      generatedAt: new Date().toISOString(),
      range: { from: fromDate, to: toDate },
      accounts: accountsWithBalance,
      movements: movements.filter((m) => m.category !== 'transferencia').map((m) => ({ ...m })),
      transfers: transferRows.map((t) => ({
        ...t,
        fromName: accountsById.get(t.fromAccountId)?.name || t.fromAccountId,
        toName: accountsById.get(t.toAccountId)?.name || t.toAccountId,
      })),
      assets: assets.map((a) => ({
        name: a.name,
        acquisitionDate: a.acquisitionDate,
        acquisitionCents: a.acquisitionCents,
        residualCents: a.residualCents,
        usefulLifeMonths: a.usefulLifeMonths,
        currentValueCents: computeAssetCurrentValueCents(a.acquisitionCents, a.residualCents, a.acquisitionDate, a.usefulLifeMonths),
      })),
      costCenters: costCenterTotals,
    };
    const pdfBuffer = await REPORT_BUILDERS[reportType](payload);
    const contentHash = crypto.createHash('sha256').update(pdfBuffer).digest('hex');

    const now = new Date();
    const expires = new Date(now.getTime() + 24 * 3600 * 1000);
    const doc = {
      _id: crypto.randomUUID(),
      requestedBy: req.user,
      reportType,
      fromDate,
      toDate,
      contentHash,
      pdfB64: pdfBuffer.toString('base64'),
      createdAt: now.toISOString(),
      expiresAt: expires.toISOString(),
    };
    await mongo.collection('finance_exports').insertOne(doc);
    await appendFinanceLog(mongo, { action: 'export.create', actorId: req.user, detail: { exportId: doc._id, reportType, fromDate, toDate, contentHash } });

    res.status(201).json({ id: doc._id, reportType, fromDate, toDate, contentHash, createdAt: doc.createdAt, expiresAt: doc.expiresAt });
  });

  router.get('/api/finance/exports', ...guard, async (req, res) => {
    const rows = await mongo.collection('finance_exports').find({}).sort({ createdAt: -1 }).limit(100).toArray();
    res.json(rows.map((r) => ({
      id: r._id,
      requestedBy: r.requestedBy,
      reportType: r.reportType || 'tesoreria',
      fromDate: r.fromDate,
      toDate: r.toDate,
      contentHash: r.contentHash,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      expired: new Date(r.expiresAt).getTime() < Date.now(),
    })));
  });

  router.get('/api/finance/exports/:id/download', ...guard, async (req, res) => {
    const row = await mongo.collection('finance_exports').findOne({ _id: req.params.id });
    if (!row) return res.status(404).json({ error: 'export no encontrado' });
    if (new Date(row.expiresAt).getTime() < Date.now()) return res.status(410).json({ error: 'export expirado' });
    await appendFinanceLog(mongo, { action: 'export.download', actorId: req.user, detail: { exportId: row._id } });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="finance-${row.reportType || 'export'}-${row._id}.pdf"`);
    res.setHeader('X-Content-SHA256', row.contentHash);
    res.send(Buffer.from(row.pdfB64, 'base64'));
  });

  /* ---- resumen KPI ---- */

  router.get('/api/finance/summary', ...guard, async (req, res) => {
    const [accounts, movements, assets] = await Promise.all([
      mongo.collection('finance_accounts').find({}).toArray(),
      mongo.collection('finance_movements').find({}).toArray(),
      mongo.collection('finance_assets').find({}).toArray(),
    ]);
    const openingSum = accounts.reduce((sum, a) => sum + (a.openingBalanceCents || 0), 0);
    const totalBalanceCents = openingSum + movements.reduce((sum, m) => sum + m.amountCents, 0);
    const totalAssetValueCents = assets.reduce(
      (sum, a) => sum + computeAssetCurrentValueCents(a.acquisitionCents, a.residualCents, a.acquisitionDate, a.usefulLifeMonths), 0,
    );
    const todayIso = new Date().toISOString().slice(0, 10);
    const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const movementsLast30d = movements.filter((m) => m.valueDate >= monthAgo && m.valueDate <= todayIso && m.category !== 'transferencia').length;
    res.json({
      accountsCount: accounts.length,
      totalBalance: centsToEuros(totalBalanceCents),
      totalAssetValue: centsToEuros(totalAssetValueCents),
      movementsLast30d,
    });
  });

  /* ---- integridad del log ---- */

  router.get('/api/finance/log/verify', ...guard, async (req, res) => {
    res.json(await verifyLog(mongo, 'finance_log'));
  });
}
