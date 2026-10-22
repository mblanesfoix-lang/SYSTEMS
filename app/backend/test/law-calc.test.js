/**
 * Calculos puros de Herzog LaW (lib/law-calc.js): vencimientos, preparacion,
 * categorias ATEX y estimacion CBAM. No necesitan Mongo.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDateOnly, expiryState, readiness, zoneCategory, validZonesFor, parseCbamInput, estimateCbam,
} from '../lib/law-calc.js';

const NOW = new Date('2026-10-22T15:30:00Z');

describe('parseDateOnly', () => {
  test('acepta fechas reales y rechaza el resto', () => {
    assert.equal(parseDateOnly('2026-10-22'), '2026-10-22');
    assert.equal(parseDateOnly('2028-02-29'), '2028-02-29');
    for (const bad of ['2026-02-31', '2027-02-29', '2026-13-01', '22/10/2026', '2026-1-1', '', null, undefined, 20261022]) {
      assert.equal(parseDateOnly(bad), null, String(bad));
    }
  });
});

describe('expiryState', () => {
  test('sin fecha', () => {
    assert.deepEqual(expiryState(null, NOW), { state: 'sin_fecha', days: null });
  });

  test('limites de cada tramo', () => {
    assert.deepEqual(expiryState('2026-10-21', NOW), { state: 'vencido', days: -1 });
    assert.deepEqual(expiryState('2026-10-22', NOW), { state: 'critico', days: 0 });
    assert.deepEqual(expiryState('2026-11-21', NOW), { state: 'critico', days: 30 });
    assert.deepEqual(expiryState('2026-11-22', NOW), { state: 'proximo', days: 31 });
    assert.deepEqual(expiryState('2027-01-20', NOW), { state: 'proximo', days: 90 });
    assert.deepEqual(expiryState('2027-01-21', NOW), { state: 'ok', days: 91 });
  });

  test('la hora del dia no cambia el resultado', () => {
    assert.equal(expiryState('2026-10-22', new Date('2026-10-22T00:00:00Z')).days, 0);
    assert.equal(expiryState('2026-10-22', new Date('2026-10-22T23:59:59Z')).days, 0);
  });
});

describe('readiness', () => {
  test('cuenta requisitos cumplidos', () => {
    assert.deepEqual(readiness([]), { done: 0, total: 0, pct: 0 });
    assert.deepEqual(readiness([{ done: true }, { done: false }, { done: false }]), { done: 1, total: 3, pct: 33 });
    assert.deepEqual(readiness([{ done: true }, { done: true }]), { done: 2, total: 2, pct: 100 });
  });
});

describe('zonas ATEX', () => {
  test('categoria exigida por zona', () => {
    assert.equal(zoneCategory('polvo', '20'), '1D');
    assert.equal(zoneCategory('polvo', '21'), '2D');
    assert.equal(zoneCategory('polvo', '22'), '3D');
    assert.equal(zoneCategory('gas', '0'), '1G');
    assert.equal(zoneCategory('gas', '1'), '2G');
    assert.equal(zoneCategory('gas', '2'), '3G');
  });

  test('zona o tipo invalidos no tienen categoria', () => {
    assert.equal(zoneCategory('polvo', '1'), null);
    assert.equal(zoneCategory('gas', '20'), null);
    assert.equal(zoneCategory('polvo', 'sin_clasificar'), null);
    assert.equal(zoneCategory('__proto__', '20'), null);
    assert.equal(zoneCategory('polvo', '__proto__'), null);
    assert.deepEqual(validZonesFor('polvo'), ['20', '21', '22']);
    assert.deepEqual(validZonesFor('gas'), ['0', '1', '2']);
    assert.deepEqual(validZonesFor('otro'), []);
  });
});

describe('parseCbamInput', () => {
  const base = { tonnes: 1000, embeddedPerTonne: 2, certificatePrice: 80 };

  test('completa los valores por defecto', () => {
    const { value } = parseCbamInput(base);
    assert.deepEqual(value, {
      tonnes: 1000, embeddedPerTonne: 2, freeAllocationPerTonne: 0, certificatePrice: 80,
      originCarbonPrice: 0, fuelSharePct: 0, substitutionPct: 0,
    });
  });

  test('acepta numeros escritos como texto', () => {
    assert.equal(parseCbamInput({ ...base, tonnes: '250.5' }).value.tonnes, 250.5);
  });

  test('exige los campos obligatorios', () => {
    for (const key of Object.keys(base)) {
      const partial = { ...base };
      delete partial[key];
      assert.match(parseCbamInput(partial).error, new RegExp(`${key} requerido`));
    }
  });

  test('rechaza valores fuera de rango o que no son numeros', () => {
    assert.match(parseCbamInput({ ...base, tonnes: -1 }).error, /tonnes fuera de rango/);
    assert.match(parseCbamInput({ ...base, fuelSharePct: 101 }).error, /fuelSharePct fuera de rango/);
    assert.match(parseCbamInput({ ...base, certificatePrice: 'abc' }).error, /certificatePrice fuera de rango/);
    assert.match(parseCbamInput({ ...base, tonnes: true }).error, /tonnes no es un numero/);
    assert.match(parseCbamInput({ ...base, tonnes: Infinity }).error, /tonnes fuera de rango/);
    assert.ok(parseCbamInput(null).error);
  });
});

describe('estimateCbam', () => {
  const input = {
    tonnes: 1000, embeddedPerTonne: 2, freeAllocationPerTonne: 0.5, certificatePrice: 80,
    originCarbonPrice: 0, fuelSharePct: 40, substitutionPct: 50,
  };

  test('coste base y escenario con biomasa', () => {
    const r = estimateCbam(input);
    assert.equal(r.netPrice, 80);
    assert.deepEqual(r.baseline, { embeddedPerTonne: 2, embeddedEmissions: 2000, chargeableEmissions: 1500, cost: 120000 });
    assert.deepEqual(r.withBiomass, { embeddedPerTonne: 1.6, embeddedEmissions: 1600, chargeableEmissions: 1100, cost: 88000 });
    assert.equal(r.saving, 32000);
    assert.equal(r.emissionsReductionPct, 20);
  });

  test('sin sustitucion el escenario con biomasa es igual al base', () => {
    const r = estimateCbam({ ...input, fuelSharePct: 0, substitutionPct: 0 });
    assert.deepEqual(r.withBiomass, r.baseline);
    assert.equal(r.saving, 0);
    assert.equal(r.emissionsReductionPct, 0);
  });

  test('la asignacion gratuita no genera coste negativo', () => {
    const r = estimateCbam({ ...input, freeAllocationPerTonne: 5 });
    assert.equal(r.baseline.chargeableEmissions, 0);
    assert.equal(r.baseline.cost, 0);
  });

  test('el precio pagado en origen se descuenta sin bajar de cero', () => {
    assert.equal(estimateCbam({ ...input, originCarbonPrice: 30 }).baseline.cost, 75000);
    const r = estimateCbam({ ...input, originCarbonPrice: 120 });
    assert.equal(r.netPrice, 0);
    assert.equal(r.baseline.cost, 0);
  });

  test('sin toneladas no hay emisiones ni porcentaje', () => {
    const r = estimateCbam({ ...input, tonnes: 0 });
    assert.equal(r.baseline.embeddedEmissions, 0);
    assert.equal(r.emissionsReductionPct, 0);
  });
});
