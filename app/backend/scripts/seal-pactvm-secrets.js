/**
 * Sella (cifra con PACTVM_DATA_KEY) los secretos de Pactvm que quedaron en claro en
 * Mongo: la clave privada del bunker CIBE (cibe_keys, base elvira) y la tokenKey de cada
 * certificado CIBE (pactvm_cibe, en la base de cada tenant). Idempotente: lo ya sellado
 * no se toca. Sin --apply solo cuenta lo que sellaria y no escribe nada.
 *
 * Exige una PACTVM_DATA_KEY propia en el entorno: sellar con la clave de desarrollo no
 * protege nada y dejaria los valores ilegibles para una instalacion con la clave real.
 * Mientras dos instalaciones compartan base, deben usar la misma clave.
 *
 * Uso: node --env-file=.env scripts/seal-pactvm-secrets.js [--apply]
 */
import { pathToFileURL } from 'node:url';
import { DEV_DATA_KEY } from '../config.js';
import { connectMongo, getElviraDb, closeMongo } from '../db/mongo.js';
import { tenantsCollection, getTenantDb } from '../db/tenant-registry.js';
import { createDataSeal, resolveDataKey, isSealed } from '../lib/data-seal.js';
import { safeEqual } from '../lib/safe-compare.js';
import { PRIVATE_KEY_CONTEXT, tokenKeyContext } from '../cibe-bunker.js';

// Sella y comprueba que se descifra igual antes de escribir nada.
function sealChecked(dataSeal, value, context) {
  const sealed = dataSeal.seal(value, context);
  if (dataSeal.open(sealed, context) !== value) throw new Error(`comprobacion de sellado fallida (${context})`);
  return sealed;
}

/**
 * keysDb: base con cibe_keys. certDbs: bases con pactvm_cibe (una por tenant).
 * Devuelve cuantos valores en claro habia (y, con apply, se han sellado).
 */
export async function sealPactvmSecrets({ keysDb, certDbs, dataSeal, apply = false }) {
  const result = { privateKey: 0, tokenKeys: 0, alreadySealed: 0 };

  const active = await keysDb.collection('cibe_keys').findOne({ _id: 'active' });
  if (active?.privateKeyPem) {
    if (isSealed(active.privateKeyPem)) {
      result.alreadySealed += 1;
    } else {
      result.privateKey = 1;
      if (apply) {
        await keysDb.collection('cibe_keys').updateOne(
          { _id: 'active', privateKeyPem: active.privateKeyPem },
          { $set: { privateKeyPem: sealChecked(dataSeal, active.privateKeyPem, PRIVATE_KEY_CONTEXT) } },
        );
      }
    }
  }

  for (const db of certDbs) {
    const certs = await db.collection('pactvm_cibe')
      .find({ tokenKey: { $type: 'string' } }, { projection: { tokenKey: 1 } }).toArray();
    for (const cert of certs) {
      if (isSealed(cert.tokenKey)) {
        result.alreadySealed += 1;
        continue;
      }
      result.tokenKeys += 1;
      if (apply) {
        // Condicionado al valor leido: si alguien la rota mientras tanto, no se pisa.
        await db.collection('pactvm_cibe').updateOne(
          { _id: cert._id, tokenKey: cert.tokenKey },
          { $set: { tokenKey: sealChecked(dataSeal, cert.tokenKey, tokenKeyContext(cert._id)) } },
        );
      }
    }
  }
  return result;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const configured = process.env.PACTVM_DATA_KEY;
  if (!configured || safeEqual(configured.toLowerCase(), DEV_DATA_KEY)) {
    console.error('[seal] Falta una PACTVM_DATA_KEY propia en el entorno (la de desarrollo no vale). No se ha tocado nada.');
    process.exit(1);
  }
  const dataSeal = createDataSeal(resolveDataKey());

  await connectMongo();
  const keysDb = getElviraDb();
  const certDbs = [];
  const seen = new Set();
  for (const tenant of await tenantsCollection().find({}).toArray()) {
    try {
      const db = await getTenantDb(tenant._id);
      if (!seen.has(db.databaseName)) {
        seen.add(db.databaseName);
        certDbs.push(db);
      }
    } catch (err) {
      console.warn(`[seal] tenant ${tenant._id} omitido: ${err.message}`);
    }
  }
  if (!seen.has(keysDb.databaseName)) certDbs.push(keysDb);

  const r = await sealPactvmSecrets({ keysDb, certDbs, dataSeal, apply });
  const verb = apply ? 'sellados' : 'por sellar (sin --apply no se escribe nada)';
  console.log(`[seal] bases revisadas: ${certDbs.map((db) => db.databaseName).join(', ')}`);
  console.log(`[seal] ${verb}: clave privada CIBE ${r.privateKey}, tokenKey ${r.tokenKeys}; ya sellados: ${r.alreadySealed}`);
  await closeMongo();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[seal] fallo:', err.message);
    process.exit(1);
  });
}
