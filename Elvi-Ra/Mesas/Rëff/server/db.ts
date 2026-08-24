import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import { getReffDb } from './mongo.js';

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  avatar_url: string | null;
}

interface UserDoc {
  _id: string;
  username: string;
  display_name: string;
  password_hash: string;
  avatar_url: string | null;
  created_at: string;
}

function toUserRow(doc: UserDoc): UserRow {
  return {
    id: doc._id,
    username: doc.username,
    display_name: doc.display_name,
    password_hash: doc.password_hash,
    avatar_url: doc.avatar_url ?? null,
  };
}

export async function seedDatabase(): Promise<void> {
  const db = getReffDb();
  const users = db.collection<UserDoc>('users');
  const sheets = db.collection('sheets');
  const counters = db.collection('counters');

  // Contraseñas seed via env (REFF_SEED_<USER>_PASSWORD); sin variable no se crea el usuario.
  const seedUsers = [
    { username: 'marc', displayName: 'Marc Blanes', password: process.env.REFF_SEED_MARC_PASSWORD },
    { username: 'nour', displayName: 'Nour', password: process.env.REFF_SEED_NOUR_PASSWORD },
    { username: 'amir', displayName: 'Amir', password: process.env.REFF_SEED_AMIR_PASSWORD },
    { username: 'gonzalo', displayName: 'Gonzalo', password: process.env.REFF_SEED_GONZALO_PASSWORD },
  ];

  for (const u of seedUsers) {
    const existing = await users.findOne({ username: u.username });
    let userId: string;
    if (!existing) {
      if (!u.password) continue;
      userId = crypto.randomUUID();
      const hash = bcrypt.hashSync(u.password, 10);
      await users.insertOne({
        _id: userId,
        username: u.username,
        display_name: u.displayName,
        password_hash: hash,
        avatar_url: null,
        created_at: new Date().toISOString(),
      });
    } else {
      userId = existing._id;
    }

    const userSheetCount = await sheets.countDocuments({ user_id: userId });
    if (userSheetCount === 0) {
      const seq = (await counters.findOneAndUpdate(
        { _id: 'sheets' as unknown as never },
        { $inc: { seq: 1 } },
        { upsert: true, returnDocument: 'after' },
      )) as unknown as { seq: number };
      await sheets.insertOne({
        _id: seq.seq,
        user_id: userId,
        name: 'General',
        position: 0,
        created_at: new Date().toISOString(),
      } as never);
    }
  }
}

export async function getUserByUsername(username: string): Promise<UserRow | null> {
  const doc = await getReffDb().collection<UserDoc>('users').findOne({ username });
  return doc ? toUserRow(doc) : null;
}

export async function getUserById(id: string): Promise<UserRow | null> {
  const doc = await getReffDb().collection<UserDoc>('users').findOne({ _id: id });
  return doc ? toUserRow(doc) : null;
}

export async function updateUserPassword(userId: string, newHash: string): Promise<void> {
  await getReffDb().collection<UserDoc>('users').updateOne({ _id: userId }, { $set: { password_hash: newHash } });
}

export async function updateUserProfile(userId: string, displayName: string, avatarUrl: string | null): Promise<void> {
  await getReffDb().collection<UserDoc>('users').updateOne(
    { _id: userId },
    { $set: { display_name: displayName, avatar_url: avatarUrl } },
  );
}
