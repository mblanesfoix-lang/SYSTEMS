/**
 * safeEqual (lib/safe-compare.js): comparacion de secretos en tiempo constante.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeEqual } from '../lib/safe-compare.js';

test('iguales -> true, tambien entre texto y Buffer con el mismo contenido', () => {
  assert.equal(safeEqual('a1b2c3', 'a1b2c3'), true);
  assert.equal(safeEqual(Buffer.from('a1b2c3'), 'a1b2c3'), true);
  assert.equal(safeEqual('', ''), true);
});

test('distintos -> false, con la misma longitud o con otra', () => {
  assert.equal(safeEqual('a1b2c3', 'a1b2c4'), false);
  assert.equal(safeEqual('a1b2c3', 'a1b2c'), false);
  assert.equal(safeEqual('a1b2c3', 'a1b2c3 '), false);
  assert.equal(safeEqual('abc', 'ABC'), false);
});

test('lo que no es texto ni Buffer nunca coincide, ni siquiera consigo mismo', () => {
  const obj = { $ne: null };
  for (const v of [undefined, null, 0, 42, true, obj, ['secreto'], () => 'secreto']) {
    assert.equal(safeEqual(v, 'secreto'), false);
    assert.equal(safeEqual('secreto', v), false);
    assert.equal(safeEqual(v, v), false);
  }
});
