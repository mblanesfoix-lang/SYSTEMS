#!/usr/bin/env node
/**
 * Purga (o solo lista, por defecto) colecciones Mongo huerfanas de mesas
 * eliminadas/rediseñadas. Ver CLAUDE.md seccion "Limpieza estructural" 2026-09-08
 * y "S-NFI F&L: rediseño total" 2026-09-04.
 *
 * Confirmado por grep en este repo (2026-09-20): ninguno de estos nombres
 * aparece en app/backend/*.js — cero codigo activo los referencia.
 *
 * SOLO LISTA por defecto. Purga real requiere --confirm explicito.
 *
 * Uso:
 *   node scripts/purge-orphan-collections.js              # dry-run, solo cuenta docs
 *   node scripts/purge-orphan-collections.js --confirm     # dropea de verdad (solo vacias)
 *   node scripts/purge-orphan-collections.js --confirm --force-nonempty  # dropea aunque tenga docs (no recomendado)
 *
 * SALVAGUARDAS (2026-09-28, tras incidente real: los 12 documentos del
 * Expediente Fiscal se perdieron por un borrado que asumio "estaba vacio"
 * sin verificacion dura en el momento del drop — ver fl-expediente.js
 * bloque RETENCION):
 *   1. PROTECTED_PREFIXES: nombres que este script rechaza tocar SIEMPRE,
 *      aunque alguien los añada a ORPHAN_COLLECTIONS por error.
 *   2. Con --confirm, si una coleccion tiene documentos en el momento exacto
 *      del drop (recontados aqui, no confiando en una auditoria previa)
 *      el script se NIEGA a dropearla salvo --force-nonempty explicito.
 */
import { MongoClient } from 'mongodb';

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('MONGO_URI no definida. Aborta.');
  process.exit(1);
}

// Colecciones que este script NUNCA debe dropear, pase lo que pase en
// ORPHAN_COLLECTIONS. Prefijos, no nombres exactos, para cubrir tambien
// *.files/*.chunks de GridFS.
const PROTECTED_PREFIXES = [
  'fl_expediente', // Expediente Fiscal y Juridico — retencion obligatoria, ver fl-expediente.js
  'fl_log',        // log inmutable con cadena de hashes
];

function isProtected(name) {
  return PROTECTED_PREFIXES.some((p) => name.startsWith(p));
}

// Huerfanas conocidas por rediseño de mesa (no confundir con las activas
// de la mesa actual: fl_expediente_docs, fl_licenses, etc siguen vivas).
const ORPHAN_COLLECTIONS = [
  // F&L rediseño 2026-09-04 (NDAs/contratos mercantiles/OEPM descartados)
  'fl_ndas',
  'fl_contracts',
  'fl_oepm_files.files',
  'fl_oepm_files.chunks',
  'fl_contract_audits', // confirmado sin referencias en fl.js actual (grep 2026-09-20)
  // Factory vaciada 2026-09-08 (routes/factory.routes.js borrado)
  'factory_assembly',
  'factory_logistics',
  'factory_inventory',
  'factory_maintenance',
];

const confirm = process.argv.includes('--confirm');
const forceNonEmpty = process.argv.includes('--force-nonempty');

async function main() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db('elvira');

  const existing = new Set((await db.listCollections().toArray()).map((c) => c.name));

  console.log(`Modo: ${confirm ? 'PURGA REAL' : 'DRY-RUN (solo lista)'}`);
  console.log('---');

  for (const name of ORPHAN_COLLECTIONS) {
    if (isProtected(name)) {
      console.log(`[BLOQUEADA] ${name} — prefijo protegido, este script se niega a tocarla (revisa PROTECTED_PREFIXES)`);
      continue;
    }
    if (!existing.has(name)) {
      console.log(`[ausente]  ${name}`);
      continue;
    }
    const count = await db.collection(name).countDocuments();
    if (!confirm) {
      console.log(`[dry-run]  ${name} — ${count} documentos (se dropearia)`);
      continue;
    }
    if (count > 0 && !forceNonEmpty) {
      console.log(`[RECHAZADA] ${name} — tiene ${count} documentos AHORA MISMO, no vacia como se esperaba. No se dropea sin --force-nonempty.`);
      continue;
    }
    await db.collection(name).drop();
    console.log(`[dropeada] ${name} — tenia ${count} documentos`);
  }

  await client.close();
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
