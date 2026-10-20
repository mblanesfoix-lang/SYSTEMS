/**
 * Raiz Merkle de los paquetes de carbono: los certificados emitidos antes de
 * versionar el algoritmo (sin merkleVersion) siguen verificando, y la version
 * 2 cubre tambien el contenido anidado de cada hoja.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { merkleRoot, verifyMerkleRoot, MERKLE_VERSION } from '../lib/merkle.js';

const LEAVES = [
  { clientName: 'Cliente A', nodeLabel: 'N1', nodeCount: 2, co2eTons: 10, dbo5Tons: 3, wasteCategory: 'estiercol_guano', ghgGases: ['co2', 'ch4'], gwpFactor: 28, co2eWeightedTons: 280, hectares: 5, creditsEstimated: 3, revenueEur: 0, mwhStabilized: 0, biopelletTons: 1000, gisLat: null, gisLng: null, cadastralRef: '', source: '' },
  { clientName: 'Cliente B', nodeLabel: '', nodeCount: 1, co2eTons: 4, dbo5Tons: 1, wasteCategory: 'comida_no_comercializada', ghgGases: ['co2'], gwpFactor: 1, co2eWeightedTons: 4, creditsEstimated: 1, revenueEur: 12, mwhStabilized: 0, biopelletTons: 500, gisLat: 42.1, gisLng: -1.6, cadastralRef: 'X', source: 's' },
];
/* Raiz calculada con el algoritmo con el que se emitieron los certificados v1. */
const V1_ROOT = '0eda4cebce401b05bb62932dc9500295d1a472a3787d295fc483a03eb316255d';

describe('merkle de certificados de carbono', () => {
  test('los certificados v1 (sin version) siguen verificando', () => {
    assert.equal(merkleRoot(LEAVES, 1), V1_ROOT);
    assert.equal(verifyMerkleRoot(LEAVES, V1_ROOT, undefined), true);
    assert.equal(verifyMerkleRoot(LEAVES, V1_ROOT, 1), true);
  });

  test('alterar un registro de un certificado v1 invalida su raiz', () => {
    const altered = [{ ...LEAVES[0], co2eTons: 11 }, LEAVES[1]];
    assert.equal(verifyMerkleRoot(altered, V1_ROOT, undefined), false);
  });

  test('los certificados nuevos usan la version 2 y cubren contenido anidado', () => {
    assert.equal(MERKLE_VERSION, 2);
    const nested = [{ clientName: 'C', extra: { a: 1 } }];
    const root = merkleRoot(nested);
    assert.equal(verifyMerkleRoot(nested, root, 2), true);
    assert.equal(verifyMerkleRoot([{ clientName: 'C', extra: { a: 2 } }], root, 2), false);
  });

  test('una version desconocida se rechaza', () => {
    assert.throws(() => merkleRoot(LEAVES, 3), /version de Merkle no soportada: 3/);
  });
});
