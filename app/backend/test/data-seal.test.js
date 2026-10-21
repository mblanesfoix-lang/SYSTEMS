/**
 * lib/data-seal.js: clave de los secretos de Pactvm en Mongo (resolucion por entorno),
 * cifrado atado a su contexto y HMAC de los codigos de acceso. Sin Mongo ni red.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { resolveDataKey, createDataSeal, isSealed } from '../lib/data-seal.js';
import { DEV_DATA_KEY } from '../config.js';

const KEY_HEX = crypto.randomBytes(32).toString('hex');
const OTHER_HEX = crypto.randomBytes(32).toString('hex');
const silent = { warn() {} };
const seal = createDataSeal(Buffer.from(KEY_HEX, 'hex'));
const other = createDataSeal(Buffer.from(OTHER_HEX, 'hex'));

describe('data-seal: clave desde el entorno', () => {
  test('clave valida -> 32 bytes', () => {
    const key = resolveDataKey({ PACTVM_DATA_KEY: KEY_HEX, NODE_ENV: 'production' }, silent);
    assert.equal(key.length, 32);
    assert.equal(key.toString('hex'), KEY_HEX);
  });

  test('sin clave: en desarrollo usa la de desarrollo y avisa; en produccion no arranca', () => {
    const warned = [];
    const key = resolveDataKey({ NODE_ENV: 'development' }, { warn: (m) => warned.push(m) });
    assert.equal(key.toString('hex'), DEV_DATA_KEY);
    assert.equal(warned.length, 1);
    assert.throws(() => resolveDataKey({ NODE_ENV: 'production' }, silent), /obligatoria en producción/);
  });

  test('formato invalido o clave de desarrollo en produccion -> error sin mostrar el valor', () => {
    for (const bad of ['corta', 'z'.repeat(64), `${KEY_HEX}00`]) {
      assert.throws(() => resolveDataKey({ PACTVM_DATA_KEY: bad, NODE_ENV: 'development' }, silent), (err) => {
        assert.match(err.message, /64 caracteres hexadecimales/);
        assert.ok(!err.message.includes(bad));
        return true;
      });
    }
    assert.throws(() => resolveDataKey({ PACTVM_DATA_KEY: DEV_DATA_KEY.toUpperCase(), NODE_ENV: 'production' }, silent), /clave de desarrollo/);
  });
});

describe('data-seal: cifrado', () => {
  test('sella y abre; el valor sellado no contiene el original y cambia en cada sellado', () => {
    const a = seal.seal('clave-secreta-123', 'ctx:1');
    const b = seal.seal('clave-secreta-123', 'ctx:1');
    assert.ok(isSealed(a));
    assert.notEqual(a, b);
    assert.ok(!a.includes('clave-secreta-123'));
    assert.equal(seal.open(a, 'ctx:1'), 'clave-secreta-123');
    assert.equal(seal.open(b, 'ctx:1'), 'clave-secreta-123');
  });

  test('otro contexto u otra clave no lo abren', () => {
    const sealed = seal.seal('clave-secreta-123', 'pactvm_cibe.tokenKey:cert-1');
    assert.throws(() => seal.open(sealed, 'pactvm_cibe.tokenKey:cert-2'));
    assert.throws(() => other.open(sealed, 'pactvm_cibe.tokenKey:cert-1'));
  });

  test('cualquier alteracion se detecta: datos, etiqueta recortada o formato', () => {
    const sealed = seal.seal('clave-secreta-123', 'ctx');
    const [prefix1, prefix2, iv, tag, data] = sealed.split(':');
    const flip = (s) => (s.startsWith('A') ? `B${s.slice(1)}` : `A${s.slice(1)}`);
    for (const bad of [
      [prefix1, prefix2, iv, tag, flip(data)].join(':'),
      [prefix1, prefix2, iv, flip(tag), data].join(':'),
      [prefix1, prefix2, flip(iv), tag, data].join(':'),
      [prefix1, prefix2, iv, tag.slice(0, 8), data].join(':'),
      [prefix1, prefix2, iv, tag].join(':'),
      `${sealed}:extra`,
    ]) {
      assert.throws(() => seal.open(bad, 'ctx'), bad);
    }
  });

  test('un valor heredado en claro se devuelve tal cual', () => {
    assert.equal(seal.open('a1b2c3', 'ctx'), 'a1b2c3');
    assert.equal(isSealed('a1b2c3'), false);
    assert.equal(isSealed(undefined), false);
    const pem = '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n';
    assert.equal(seal.open(pem, 'ctx'), pem);
  });

  test('textos largos y con caracteres no ASCII', () => {
    const text = `${'ñ€'.repeat(500)}\n-----END-----`;
    assert.equal(seal.open(seal.seal(text, 'ctx'), 'ctx'), text);
  });

  test('una clave que no es de 32 bytes no se acepta', () => {
    assert.throws(() => createDataSeal(Buffer.alloc(16)));
    assert.throws(() => createDataSeal(KEY_HEX));
  });
});

describe('data-seal: HMAC de codigos', () => {
  test('determinista, 64 hex, distinto por contexto y por clave, y no es un sha256 simple', () => {
    const m = seal.mac('pactvm.access-code', '123456');
    assert.match(m, /^[0-9a-f]{64}$/);
    assert.equal(seal.mac('pactvm.access-code', '123456'), m);
    assert.notEqual(seal.mac('pactvm.access-code', '123457'), m);
    assert.notEqual(seal.mac('otro.contexto', '123456'), m);
    assert.notEqual(other.mac('pactvm.access-code', '123456'), m);
    assert.notEqual(crypto.createHash('sha256').update('123456').digest('hex'), m);
  });
});
