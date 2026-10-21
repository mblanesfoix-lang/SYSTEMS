import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { MongoClient } from 'mongodb';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { setMongoClient } from './mongo.js';
import { seedDatabase } from './db.js';
import authRoutes from './routes/auth.routes.js';
import sheetsRoutes from './routes/sheets.routes.js';
import companiesRoutes from './routes/companies.routes.js';
import geoRoutes from './routes/geo.routes.js';
import herzogRoutes from './routes/herzog.routes.js';
import watchRoutes from './routes/watch.routes.js';
import trafficRoutes from './routes/traffic.routes.js';
import meetingsRoutes from './routes/meetings.routes.js';
import communicationsRoutes from './routes/communications.routes.js';
import { startWatchCron } from './watch.js';
import { startMeetingReminderCron } from './meeting-reminders.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3001);
const NODE_ENV = process.env.NODE_ENV || 'development';

// La IA es del backend integrado (app/backend/llm): aquí Herzog y la vigilancia responden que no está disponible.
console.warn('[Rëff][WARN] Modo independiente sin IA: Herzog y la vigilancia solo funcionan integrados en el backend.');

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
  keyGenerator: (req) => req.ip ? ipKeyGenerator(req.ip) : 'anon',
  message: { error: 'Demasiadas peticiones. Intenta de nuevo en un minuto.' },
});

app.use('/api', apiLimiter);

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'reff', env: NODE_ENV });
});

app.use('/api/auth', authRoutes);
app.use('/api/crm', sheetsRoutes);
app.use('/api/crm', companiesRoutes);
app.use('/api/crm', meetingsRoutes);
app.use('/api/crm', communicationsRoutes);
app.use('/api/geo', geoRoutes);
app.use('/api/herzog', herzogRoutes);
app.use('/api/watch', watchRoutes);
app.use('/api/traffic', trafficRoutes);

startWatchCron();
startMeetingReminderCron();

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
