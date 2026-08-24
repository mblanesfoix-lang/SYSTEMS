import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { MongoClient } from 'mongodb';
import { rateLimit } from 'express-rate-limit';
import { setMongoClient } from './mongo.js';
import { seedDatabase } from './db.js';
import authRoutes from './routes/auth.routes.js';
import sheetsRoutes from './routes/sheets.routes.js';
import companiesRoutes from './routes/companies.routes.js';
import geoRoutes from './routes/geo.routes.js';
import herzogRoutes from './routes/herzog.routes.js';
import watchRoutes from './routes/watch.routes.js';
import { startWatchCron } from './watch.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3001);
const NODE_ENV = process.env.NODE_ENV || 'development';

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn('[Rëff][WARN] ANTHROPIC_API_KEY no está definida en .env — Herzog fallará.');
}

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  throw new Error('MONGO_URI no definida — necesaria para arrancar Rëff standalone.');
}
const mongoClient = new MongoClient(MONGO_URI);
await mongoClient.connect();
await setMongoClient(mongoClient);
await seedDatabase();

const app = express();

app.use(cors({
  origin: NODE_ENV === 'production' ? (process.env.CORS_ORIGIN || false) : true,
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => req.ip || 'anon',
  message: { error: 'Demasiadas peticiones. Intenta de nuevo en un minuto.' },
});

app.use('/api', apiLimiter);

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'reff', env: NODE_ENV });
});

app.use('/api/auth', authRoutes);
app.use('/api/crm', sheetsRoutes);
app.use('/api/crm', companiesRoutes);
app.use('/api/geo', geoRoutes);
app.use('/api/herzog', herzogRoutes);
app.use('/api/watch', watchRoutes);

startWatchCron();

if (NODE_ENV === 'production') {
  const clientDir = path.resolve(__dirname, '../../dist/client');
  app.use(express.static(clientDir));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(clientDir, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`[Rëff] Servidor escuchando en http://localhost:${PORT}`);
  console.log(`[Rëff] Entorno: ${NODE_ENV}`);
});
