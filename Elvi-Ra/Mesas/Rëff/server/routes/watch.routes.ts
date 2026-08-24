import { Router, Request, Response } from 'express';
import { getReffDb, nextSeq } from '../mongo.js';
import { authMiddleware } from '../auth.js';
import { runWatchCycle, WATCH_CATEGORIES, WatchCompanyDoc, WatchNewsDoc } from '../watch.js';

const router = Router();

router.use(authMiddleware);

function serializeCompany(doc: WatchCompanyDoc) {
  return {
    id: doc._id,
    name: doc.name,
    sector: doc.sector,
    country: doc.country,
    active: doc.active,
    createdBy: doc.created_by,
    createdAt: doc.created_at,
  };
}

function serializeNews(doc: WatchNewsDoc) {
  return {
    id: doc._id,
    companyId: doc.company_id,
    category: doc.category,
    headline: doc.headline,
    summary: doc.summary,
    url: doc.url,
    sourceDate: doc.source_date,
    detectedAt: doc.detected_at,
  };
}

router.get('/companies', async (_req: Request, res: Response) => {
  const rows = await getReffDb().collection<WatchCompanyDoc>('watch_companies').find({}).sort({ name: 1 }).toArray();
  res.json({ companies: rows.map(serializeCompany) });
});

router.post('/companies', async (req: Request, res: Response) => {
  const { name, sector, country } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'El nombre de la empresa es obligatorio' });
  }
  const id = await nextSeq('watch_companies');
  const doc: WatchCompanyDoc = {
    _id: id,
    name: name.trim(),
    sector: typeof sector === 'string' ? sector : null,
    country: typeof country === 'string' ? country : null,
    active: true,
    created_by: req.user.id,
    created_at: new Date().toISOString(),
  };
  await getReffDb().collection<WatchCompanyDoc>('watch_companies').insertOne(doc);
  res.status(201).json({ company: serializeCompany(doc) });
});

router.patch('/companies/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const db = getReffDb();
  const row = await db.collection<WatchCompanyDoc>('watch_companies').findOne({ _id: id });
  if (!row) return res.status(404).json({ error: 'Empresa no encontrada' });

  const { name, sector, country, active } = req.body || {};
  const $set: Record<string, unknown> = {};
  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'Nombre inválido' });
    $set.name = name.trim();
  }
  if (sector !== undefined) $set.sector = typeof sector === 'string' ? sector : null;
  if (country !== undefined) $set.country = typeof country === 'string' ? country : null;
  if (active !== undefined) $set.active = Boolean(active);

  if (Object.keys($set).length > 0) {
    await db.collection<WatchCompanyDoc>('watch_companies').updateOne({ _id: id }, { $set });
  }
  const updated = await db.collection<WatchCompanyDoc>('watch_companies').findOne({ _id: id }) as WatchCompanyDoc;
  res.json({ company: serializeCompany(updated) });
});

router.delete('/companies/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const db = getReffDb();
  const row = await db.collection<WatchCompanyDoc>('watch_companies').findOne({ _id: id });
  if (!row) return res.status(404).json({ error: 'Empresa no encontrada' });
  await db.collection<WatchCompanyDoc>('watch_companies').deleteOne({ _id: id });
  await db.collection<WatchNewsDoc>('watch_news').deleteMany({ company_id: id } as never);
  res.json({ ok: true });
});

router.get('/news', async (req: Request, res: Response) => {
  const { companyId, category } = req.query;
  const filter: Record<string, unknown> = {};
  if (companyId !== undefined) filter.company_id = Number(companyId);
  if (category !== undefined && (WATCH_CATEGORIES as readonly string[]).includes(String(category))) {
    filter.category = category;
  }
  const rows = await getReffDb().collection<WatchNewsDoc>('watch_news')
    .find(filter as never)
    .sort({ _id: -1 })
    .limit(200)
    .toArray();
  res.json({ news: rows.map(serializeNews) });
});

router.delete('/news/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const db = getReffDb();
  const row = await db.collection<WatchNewsDoc>('watch_news').findOne({ _id: id });
  if (!row) return res.status(404).json({ error: 'Noticia no encontrada' });
  await db.collection<WatchNewsDoc>('watch_news').deleteOne({ _id: id });
  res.json({ ok: true });
});

// Lanza un ciclo de búsqueda inmediato (todas las empresas activas, o una sola si se pasa companyId).
router.post('/run', async (req: Request, res: Response) => {
  const { companyId } = req.body || {};
  runWatchCycle(typeof companyId === 'number' ? companyId : undefined).catch((err) =>
    console.error('[Rëff][watch] Ciclo manual falló:', err),
  );
  res.status(202).json({ ok: true, message: 'Ciclo de búsqueda lanzado en segundo plano' });
});

export default router;
