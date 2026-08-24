import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getReffDb } from '../mongo.js';
import { authMiddleware } from '../auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface CityEntry {
  city: string;
  lat: number;
  lng: number;
}

const citiesByCountry: Record<string, CityEntry[]> = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../data/cities.json'), 'utf-8'),
);

const router = Router();

router.use(authMiddleware);

router.get('/countries', (_req: Request, res: Response) => {
  res.json({ countries: Object.keys(citiesByCountry).sort((a, b) => a.localeCompare(b, 'es')) });
});

router.get('/cities', (req: Request, res: Response) => {
  const country = String(req.query.country || '');
  const cities = citiesByCountry[country] || [];
  res.json({ cities });
});

interface CompanyDoc {
  _id: number;
  name: string;
  country: string;
  city: string;
  lat: number;
  lng: number;
  status: string;
  sheet_id: number;
}

router.get('/globe', async (req: Request, res: Response) => {
  const db = getReffDb();
  const userSheets = await db.collection('sheets').find({ user_id: req.user.id } as never).toArray();
  const sheetIds = userSheets.map((s) => s._id) as unknown as number[];
  const rows = await db.collection<CompanyDoc>('companies')
    .find({ sheet_id: { $in: sheetIds } })
    .project<CompanyDoc>({ name: 1, country: 1, city: 1, lat: 1, lng: 1, status: 1, sheet_id: 1 })
    .toArray();

  const byCity = new Map<string, {
    city: string;
    country: string;
    lat: number;
    lng: number;
    companies: { id: number; name: string; status: string; sheetId: number }[];
  }>();

  for (const row of rows) {
    const key = `${row.country}|${row.city}`;
    let entry = byCity.get(key);
    if (!entry) {
      entry = { city: row.city, country: row.country, lat: row.lat, lng: row.lng, companies: [] };
      byCity.set(key, entry);
    }
    entry.companies.push({ id: row._id, name: row.name, status: row.status, sheetId: row.sheet_id });
  }

  res.json({ cities: Array.from(byCity.values()) });
});

export default router;
