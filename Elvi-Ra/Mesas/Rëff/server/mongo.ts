import { MongoClient, Db } from 'mongodb';

let client: MongoClient | null = null;
let reffDb: Db | null = null;

// Reutiliza el MongoClient ya conectado por Elvi-Ra (server.js) — un solo pool
// para todo el proceso, igual que hoy server.js fuerza DB_PATH para Rëff.
export async function setMongoClient(sharedClient: MongoClient): Promise<void> {
  client = sharedClient;
  reffDb = client.db('reff');
  await ensureIndexes();
}

export function getReffDb(): Db {
  if (!reffDb) throw new Error('Mongo no conectado. Llama setMongoClient() primero.');
  return reffDb;
}


async function ensureIndexes(): Promise<void> {
  if (!reffDb) return;
  await reffDb.collection('users').createIndex({ username: 1 }, { unique: true });
  await reffDb.collection('sheets').createIndex({ user_id: 1 });
  await reffDb.collection('companies').createIndex({ sheet_id: 1 });
  await reffDb.collection('companies').createIndex({ city: 1, country: 1 });
  await reffDb.collection('herzog_audits').createIndex({ user_id: 1 });
  await reffDb.collection('watch_companies').createIndex({ active: 1 });
  await reffDb.collection('watch_news').createIndex({ company_id: 1, detected_at: -1 });
  await reffDb.collection('watch_news').createIndex({ dedupe_hash: 1 }, { unique: true });
  await reffDb.collection('traffic_requests').createIndex({ status: 1 });
  await reffDb.collection('traffic_requests').createIndex({ requester_id: 1 });
  await reffDb.collection('company_meetings').createIndex({ company_id: 1, scheduled_at: -1 });
  await reffDb.collection('company_meetings').createIndex({ sheet_id: 1, scheduled_at: 1 });
  await reffDb.collection('company_meetings').createIndex({ status: 1, scheduled_at: 1 });
  await reffDb.collection('company_meetings').createIndex({ reminder_sent_at: 1 });
}

// Emula AUTOINCREMENT de SQLite vía contador atómico.
export async function nextSeq(counterName: string): Promise<number> {
  const result = await getReffDb().collection('counters').findOneAndUpdate(
    { _id: counterName as unknown as never },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' },
  );
  return (result as unknown as { seq: number }).seq;
}
