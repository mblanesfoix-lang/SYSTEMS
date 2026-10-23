/**
 * Importacion unica a Mongo del estado que antes vivia en un JSON de data/.
 * Cada importacion deja una marca en `json_migrations` de la misma base: con la marca
 * no se vuelve a leer el archivo, para que lo borrado despues en Mongo no reaparezca
 * en el siguiente arranque. El archivo no se toca; sin archivo no hay nada que hacer.
 * `importFn` debe ser idempotente por si dos replicas arrancan a la vez.
 */

import fs from 'node:fs';

const MARKS = 'json_migrations';

export async function migrateJsonOnce(db, name, file, importFn) {
  const marks = db.collection(MARKS);
  if (await marks.findOne({ _id: name })) return { skipped: 'done' };
  if (!file || !fs.existsSync(file)) return { skipped: 'no-file' };

  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.warn(`[migracion] ${name}: archivo ilegible, no se importa (${err.message})`);
    return { skipped: 'unreadable' };
  }

  const imported = await importFn(data);
  try {
    await marks.insertOne({ _id: name, importedAt: new Date(), imported });
  } catch (err) {
    if (err?.code !== 11000) throw err;
  }
  console.log(`[migracion] ${name}: ${imported} registro(s) importados a Mongo`);
  return { imported };
}

/** insertMany que ignora los _id ya presentes (otra replica o un intento anterior). */
export async function insertIgnoringDuplicates(collection, docs) {
  if (docs.length === 0) return 0;
  try {
    const res = await collection.insertMany(docs, { ordered: false });
    return res.insertedCount;
  } catch (err) {
    const writeErrors = err?.writeErrors ?? [];
    const onlyDuplicates = writeErrors.length > 0 && writeErrors.every((e) => e.code === 11000);
    if (!onlyDuplicates) throw err;
    return err.insertedCount ?? 0;
  }
}
