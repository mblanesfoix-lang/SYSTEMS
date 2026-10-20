/**
 * Raiz Merkle simplificada de los paquetes de carbono: hash de cada registro
 * (hoja) concatenados y hasheados en una raiz unica.
 *
 * La version del algoritmo viaja dentro del certificado (merkleVersion). Los
 * certificados sin marca son version 1 y se verifican siempre con el
 * algoritmo con el que se emitieron.
 */

import crypto from 'node:crypto';
import { canonicalV1, canonicalV2 } from './hash-chain.js';

export const MERKLE_VERSION = 2;

const LEAF_CANON = { 1: canonicalV1, 2: canonicalV2 };

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export function merkleRoot(leaves, version = MERKLE_VERSION) {
  const canon = LEAF_CANON[version];
  if (!canon) throw new Error(`version de Merkle no soportada: ${version}`);
  return sha256(leaves.map((leaf) => sha256(canon(leaf))).join(''));
}

/* `version` ausente = certificado emitido antes de versionar el algoritmo. */
export function verifyMerkleRoot(leaves, expectedRoot, version) {
  return merkleRoot(leaves, version ?? 1) === expectedRoot;
}
