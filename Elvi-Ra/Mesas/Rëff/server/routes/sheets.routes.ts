import { Router, Request, Response } from 'express';
import { getReffDb, nextSeq } from '../mongo.js';
import { authMiddleware } from '../auth.js';

const router = Router();

router.use(authMiddleware);

interface SheetDoc {
  _id: number;
  user_id: string;
  name: string;
  position: number;
  created_at: string;
}

router.get('/sheets', async (req: Request, res: Response) => {
  const userId = req.user.id;
  const db = getReffDb();
  const sheets = await db.collection<SheetDoc>('sheets')
    .find({ user_id: userId })
    .sort({ position: 1, _id: 1 })
    .toArray();

  const counts = await db.collection('companies').aggregate([
    { $match: { sheet_id: { $in: sheets.map((s) => s._id) } } },
    { $group: { _id: '$sheet_id', count: { $sum: 1 } } },
  ]).toArray() as { _id: number; count: number }[];
  const countMap = new Map(counts.map((c) => [c._id, c.count]));

  res.json({
    sheets: sheets.map((s) => ({
      id: s._id,
      name: s.name,
      position: s.position,
      companyCount: countMap.get(s._id) || 0,
    })),
  });
});

router.post('/sheets', async (req: Request, res: Response) => {
  const { name } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'El nombre de la hoja es obligatorio' });
  }
  const userId = req.user.id;
  const db = getReffDb();
  const maxPosDoc = await db.collection<SheetDoc>('sheets')
    .find({ user_id: userId })
    .sort({ position: -1 })
    .limit(1)
    .next();
  const position = (maxPosDoc?.position ?? -1) + 1;
  const id = await nextSeq('sheets');
  await db.collection<SheetDoc>('sheets').insertOne({
    _id: id,
    user_id: userId,
    name: name.trim(),
    position,
    created_at: new Date().toISOString(),
  });
  res.status(201).json({ sheet: { id, name: name.trim(), position, companyCount: 0 } });
});

router.patch('/sheets/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const userId = req.user.id;
  const db = getReffDb();
  const sheet = await db.collection<SheetDoc>('sheets').findOne({ _id: id, user_id: userId });
  if (!sheet) return res.status(404).json({ error: 'Hoja no encontrada' });

  const { name, position } = req.body || {};
  const $set: Record<string, unknown> = {};
  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'El nombre de la hoja no puede estar vacío' });
    }
    $set.name = name.trim();
  }
  if (position !== undefined) {
    if (typeof position !== 'number') {
      return res.status(400).json({ error: 'Posición inválida' });
    }
    $set.position = position;
  }
  if (Object.keys($set).length > 0) {
    await db.collection<SheetDoc>('sheets').updateOne({ _id: id }, { $set });
  }
  const updated = await db.collection<SheetDoc>('sheets').findOne({ _id: id }) as SheetDoc;
  res.json({ sheet: { id: updated._id, name: updated.name, position: updated.position } });
});

router.delete('/sheets/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const userId = req.user.id;
  const db = getReffDb();
  const sheet = await db.collection<SheetDoc>('sheets').findOne({ _id: id, user_id: userId });
  if (!sheet) return res.status(404).json({ error: 'Hoja no encontrada' });

  const sheetCount = await db.collection<SheetDoc>('sheets').countDocuments({ user_id: userId });
  if (sheetCount <= 1) {
    return res.status(400).json({ error: 'No se puede eliminar la única hoja' });
  }

  await db.collection('companies').deleteMany({ sheet_id: id });
  await db.collection<SheetDoc>('sheets').deleteOne({ _id: id });
  res.json({ ok: true });
});

export default router;
