/**
 * Computo de plazos de la mesa F&L (fl-hub-fechas.js): funciones puras, sin
 * Mongo. Casos anclados al texto del art. 30 y 43.2 de la Ley 39/2015.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  isIsoDate, todayIso, addDaysIso, diffDaysIso, nextBusinessDayIso, addBusinessDaysIso, addMonthsIso,
  computeFechaLimite, fechaRechazoPresunto,
} from '../fl-hub-fechas.js';

describe('fl-hub-fechas: dias civiles y plazos legales', () => {
  test('isIsoDate rechaza fechas imposibles y formatos ajenos', () => {
    assert.equal(isIsoDate('2026-10-12'), true);
    assert.equal(isIsoDate('2026-02-30'), false);
    assert.equal(isIsoDate('12/10/2026'), false);
    assert.equal(isIsoDate(null), false);
  });

  test('todayIso usa el dia civil de Madrid, no el UTC del proceso', () => {
    // 23:30 UTC del 11 de octubre = 01:30 del 12 en Madrid (horario de verano).
    assert.equal(todayIso(new Date('2026-10-11T23:30:00Z')), '2026-10-12');
    // En invierno Madrid es UTC+1: 23:30 UTC del 15 de enero = 00:30 del 16.
    assert.equal(todayIso(new Date('2026-01-15T23:30:00Z')), '2026-01-16');
  });

  test('aritmetica de dias sin saltos por cambio de hora', () => {
    assert.equal(addDaysIso('2026-10-24', 2), '2026-10-26');
    assert.equal(diffDaysIso('2026-03-28', '2026-03-30'), 2);
    assert.equal(diffDaysIso('2026-10-12', '2026-10-05'), -7);
  });

  test('dias habiles: desde el dia siguiente, sin sabados ni domingos (art. 30.2)', () => {
    // Jueves 8 de octubre + 10 habiles = jueves 22 (festivos no modelados).
    assert.equal(addBusinessDaysIso('2026-10-08', 10), '2026-10-22');
    // Viernes + 1 habil = lunes.
    assert.equal(addBusinessDaysIso('2026-10-09', 1), '2026-10-12');
  });

  test('ultimo dia inhabil se prorroga al primer habil (art. 30.5)', () => {
    assert.equal(nextBusinessDayIso('2026-10-17'), '2026-10-19');
    assert.equal(nextBusinessDayIso('2026-10-19'), '2026-10-19');
  });

  test('meses: mismo dia del mes de vencimiento o ultimo dia del mes (art. 30.4)', () => {
    assert.equal(addMonthsIso('2026-01-31', 1), '2026-02-28');
    assert.equal(addMonthsIso('2028-01-31', 1), '2028-02-29');
    assert.equal(addMonthsIso('2026-11-30', 2), '2027-01-30');
    // 7 de octubre + 1 mes = sabado 7 de noviembre -> lunes 9.
    assert.equal(computeFechaLimite('2026-10-07', 1, 'meses'), '2026-11-09');
  });

  test('computeFechaLimite por unidad y sin plazo', () => {
    assert.equal(computeFechaLimite('2026-10-08', 10, 'habiles'), '2026-10-22');
    assert.equal(computeFechaLimite('2026-10-08', 9, 'naturales'), '2026-10-19');
    assert.equal(computeFechaLimite('2026-10-08', 0, 'habiles'), null);
    assert.equal(computeFechaLimite('no-fecha', 10, 'habiles'), null);
  });

  test('rechazo presunto: diez dias naturales desde la puesta a disposicion (art. 43.2)', () => {
    assert.equal(fechaRechazoPresunto('2026-10-04'), '2026-10-14');
    assert.equal(fechaRechazoPresunto(null), null);
  });
});
