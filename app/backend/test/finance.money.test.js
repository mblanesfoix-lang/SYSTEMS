import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAmountToCents,
  centsToEuros,
  applyVat,
  computeAssetCurrentValueCents,
  projectCashflow,
} from '../finance.js';

describe('finance: aritmetica monetaria en centimos', () => {
  test('parseAmountToCents redondea a centimo mas cercano', () => {
    assert.equal(parseAmountToCents(10.005), 1001); // evita drift de flotante 10.005 -> 1000.5 -> round
    assert.equal(parseAmountToCents(10), 1000);
    assert.equal(parseAmountToCents(0.1), 10);
  });

  test('parseAmountToCents devuelve null para valores no numericos', () => {
    assert.equal(parseAmountToCents('abc'), null);
    assert.equal(parseAmountToCents(undefined), null);
    assert.equal(parseAmountToCents(NaN), null);
  });

  test('centsToEuros es la inversa exacta de parseAmountToCents para valores con 2 decimales', () => {
    assert.equal(centsToEuros(parseAmountToCents(1234.56)), 1234.56);
  });

  test('applyVat calcula IVA sobre base en centimos sin arrastre de coma flotante', () => {
    // 1000 movimientos de 1 centimo con IVA 21% no deben acumular error de redondeo
    let totalVat = 0;
    for (let i = 0; i < 1000; i++) totalVat += applyVat(1, 21).vatCents;
    // cada aplicacion redondea a entero; el total debe ser un entero exacto, no NaN ni fraccion
    assert.equal(Number.isInteger(totalVat), true);
  });

  test('applyVat: 100 EUR + 21% = 121 EUR exacto', () => {
    const { vatCents, totalCents } = applyVat(10000, 21);
    assert.equal(vatCents, 2100);
    assert.equal(totalCents, 12100);
  });

  test('applyVat con tasa 0 o no numerica no rompe', () => {
    assert.deepEqual(applyVat(10000, 0), { vatCents: 0, totalCents: 10000 });
    assert.deepEqual(applyVat(10000, undefined), { vatCents: 0, totalCents: 10000 });
  });
});

describe('finance: amortizacion lineal de activos', () => {
  test('valor en fecha de adquisicion = coste de adquisicion', () => {
    const acquisitionDate = '2024-01-01';
    const v = computeAssetCurrentValueCents(100000, 10000, acquisitionDate, 24, new Date('2024-01-01'));
    assert.equal(v, 100000);
  });

  test('valor tras vida util completa = valor residual', () => {
    const acquisitionDate = '2024-01-01';
    const v = computeAssetCurrentValueCents(100000, 10000, acquisitionDate, 24, new Date('2026-01-01'));
    assert.equal(v, 10000);
  });

  test('valor a mitad de vida util = punto medio entre adquisicion y residual', () => {
    const acquisitionDate = '2024-01-01';
    const v = computeAssetCurrentValueCents(100000, 10000, acquisitionDate, 24, new Date('2025-01-01'));
    assert.equal(v, 55000); // 100000 - (90000/24)*12 = 55000
  });

  test('usefulLifeMonths <= 0 devuelve directamente el residual', () => {
    const v = computeAssetCurrentValueCents(100000, 10000, '2024-01-01', 0, new Date('2024-06-01'));
    assert.equal(v, 10000);
  });

  test('nunca devuelve menos que el valor residual aunque el calculo se pase', () => {
    const v = computeAssetCurrentValueCents(100000, 10000, '2020-01-01', 12, new Date('2026-01-01'));
    assert.equal(v, 10000);
  });
});

describe('finance: proyeccion de flujo de caja', () => {
  test('sin movimientos, el balance se mantiene constante en todo el horizonte', () => {
    const points = projectCashflow(500000, [], 5, new Date('2026-01-01'));
    assert.equal(points.length, 6); // dia 0 incluido
    for (const p of points) assert.equal(p.balance, 5000);
  });

  test('un movimiento puntual desplaza el balance desde su fecha en adelante', () => {
    const points = projectCashflow(500000, [
      { valueDate: '2026-01-03', amountCents: -100000 },
    ], 5, new Date('2026-01-01'));
    assert.equal(points[0].balance, 5000); // dia 0
    assert.equal(points[1].balance, 5000); // dia 1
    assert.equal(points[2].balance, 4000); // dia 2 (2026-01-03) aplica el movimiento
    assert.equal(points[3].balance, 4000); // se mantiene
  });

  test('movimiento recurrente mensual se repite dentro del horizonte', () => {
    const points = projectCashflow(0, [
      { valueDate: '2026-01-01', amountCents: 10000, recurring: { frequency: 'monthly' } },
    ], 62, new Date('2026-01-01'));
    const balances = points.map(p => p.balance);
    // dia 0: +100; ~dia 31 (feb): +100 mas = 200; ~dia 59 (mar): +100 mas = 300
    assert.equal(balances[0], 100);
    assert.ok(balances[balances.length - 1] >= 200);
  });
});
