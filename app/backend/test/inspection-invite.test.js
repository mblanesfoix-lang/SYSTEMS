import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseInvitationInput, invitationState, sessionExpiry,
  INVITE_DEFAULT_HOURS, INVITE_MAX_HOURS, INVITE_MAX_FAILURES, SESSION_MAX_HOURS,
} from '../lib/inspection-invite.js';

const known = { knownFrameworks: new Set(['iso-9001', 'atex']), knownDocuments: new Set(['d1']) };
const parse = (body) => parseInvitationInput(body, known);
const base = { label: 'Inspección de Industria', emails: ['Inspector@Gob.es'] };

describe('inspection-invite: validacion del alta', () => {
  test('valores por defecto: todas las normas, zonas, sin documentos, demostracion', () => {
    const { value } = parse(base);
    assert.deepEqual(value.emails, ['inspector@gob.es']);
    assert.equal(value.hours, INVITE_DEFAULT_HOURS);
    assert.deepEqual(value.scope, { frameworkIds: null, includeZones: true, documentIds: [] });
    assert.equal(value.demo, true);
  });

  test('rechaza organismo corto, sin correos, correo invalido o demasiados correos', () => {
    assert.ok(parse({ ...base, label: 'ab' }).error);
    assert.ok(parse({ ...base, emails: [] }).error);
    assert.ok(parse({ ...base, emails: 'a@b.com' }).error);
    assert.match(parse({ ...base, emails: ['no-es-correo'] }).error, /no válido/);
    assert.ok(parse({ ...base, emails: Array.from({ length: 11 }, (_, i) => `u${i}@gob.es`) }).error);
  });

  test('duracion entre 1 y el maximo', () => {
    assert.ok(parse({ ...base, hours: 0 }).error);
    assert.ok(parse({ ...base, hours: INVITE_MAX_HOURS + 1 }).error);
    assert.ok(parse({ ...base, hours: 'x' }).error);
    assert.equal(parse({ ...base, hours: '24' }).value.hours, 24);
  });

  test('alcance: solo normas y documentos que existen', () => {
    assert.deepEqual(parse({ ...base, frameworkIds: ['atex', 'atex'] }).value.scope.frameworkIds, ['atex']);
    assert.match(parse({ ...base, frameworkIds: ['inventada'] }).error, /desconocida/);
    assert.ok(parse({ ...base, frameworkIds: [] }).error);
    assert.match(parse({ ...base, documentIds: ['d2'] }).error, /desconocido/);
    assert.deepEqual(parse({ ...base, documentIds: ['d1'] }).value.scope.documentIds, ['d1']);
  });

  test('includeZones y demo solo aceptan booleanos', () => {
    assert.ok(parse({ ...base, includeZones: 'no' }).error);
    assert.equal(parse({ ...base, includeZones: false, demo: false }).value.demo, false);
  });
});

describe('inspection-invite: estado y sesion', () => {
  const now = new Date('2026-10-22T10:00:00Z');
  const row = (over = {}) => ({ revoked: false, failedAttempts: 0, expiresAt: '2026-10-22T18:00:00.000Z', ...over });

  test('activa, revocada, bloqueada, caducada e inexistente', () => {
    assert.equal(invitationState(row(), now).reason, 'ACTIVE');
    assert.equal(invitationState(row({ revoked: true }), now).reason, 'REVOKED');
    assert.equal(invitationState(row({ failedAttempts: INVITE_MAX_FAILURES }), now).reason, 'LOCKED');
    assert.equal(invitationState(row({ expiresAt: '2026-10-22T10:00:00.000Z' }), now).reason, 'EXPIRED');
    assert.equal(invitationState(null, now).reason, 'NOT_FOUND');
  });

  test('la sesion no dura mas que la invitacion ni que el tope de sesion', () => {
    assert.equal(sessionExpiry('2026-10-22T18:00:00.000Z', now).toISOString(), '2026-10-22T18:00:00.000Z');
    const far = sessionExpiry('2026-10-25T10:00:00.000Z', now);
    assert.equal(far.getTime() - now.getTime(), SESSION_MAX_HOURS * 3600 * 1000);
  });
});
