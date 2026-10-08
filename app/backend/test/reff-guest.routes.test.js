/**
 * Puente de sesion Elvi-Ra -> Rëff (routes/reff-guest.routes.js): el JWT de Rëff
 * solo se emite con sesion valida y acceso a la mesa reff, y el usuario sale de
 * la sesion, nunca de una cabecera del cliente. Express real, sin Mongo real
 * (stub de `mongo.collection('users').findOne()` en memoria).
 *
 * Multi-tenancy Fase 1: el mapa fijo ELVIRA_TO_REFF_USERNAME se sustituyo por
 * el campo `reffUsername` en el documento de `users` — este test stub lo
 * refleja con un Map en memoria en vez de un objeto congelado.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mountReffGuestToken } from '../routes/reff-guest.routes.js';

// Sesiones simuladas: el token Bearer elige usuario, rol y tenant, como el middleware real.
const SESSIONS = {
  't-marc': { user: 'mblanes@s-nficorp.com', role: 'admin', tenantId: 'equipo-interno' },
  't-amir': { user: 'ventures@s-nficorp.com', role: 'amir', tenantId: 'equipo-interno' },
  't-ray': { user: 'ray@s-nficorp.com', role: 'ray', tenantId: 'equipo-interno' }, // sin mesa reff
  't-otro-admin': { user: 'otro.admin@s-nficorp.com', role: 'admin', tenantId: 'equipo-interno' }, // acceso a reff, sin correspondencia
};

// users stub: equivalente al documento real de Mongo, solo con reffUsername.
const USERS = {
  'mblanes@s-nficorp.com': { reffUsername: 'marc' },
  'ventures@s-nficorp.com': { reffUsername: 'amir' },
  'ray@s-nficorp.com': {}, // sin reffUsername: nunca tuvo acceso a Rëff
  'otro.admin@s-nficorp.com': {}, // admin sin correspondencia
};

function authStub(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  const s = SESSIONS[token];
  if (!s) return res.status(401).json({ error: 'No autenticado' });
  req.user = s.user;
  req.role = s.role;
  req.tenantId = s.tenantId;
  next();
}

const requireMesaStub = (mesa) => (req, res, next) => {
  const ok = req.role === 'admin' || (mesa === 'reff' && req.role === 'amir');
  return ok ? next() : res.status(403).json({ error: 'Acceso denegado a esta mesa' });
};

const REFF_USERS = {
  marc: { id: 1, username: 'marc', display_name: 'Marc', avatar_url: null },
  nour: { id: 2, username: 'nour', display_name: 'Nour', avatar_url: null },
  amir: { id: 3, username: 'amir', display_name: 'Amir', avatar_url: null },
  gonzalo: { id: 4, username: 'gonzalo', display_name: 'Gonzalo', avatar_url: null },
};

const signToken = ({ userId, username, tenantId }) => `jwt:${userId}:${username}:${tenantId}`;

// mongo stub: solo el metodo que reff-guest.routes.js realmente usa.
const mongoStub = {
  collection(name) {
    if (name !== 'users') throw new Error(`stub inesperado: ${name}`);
    return {
      findOne: async ({ _id }) => (USERS[_id] ? { _id, ...USERS[_id] } : null),
    };
  },
};

let server;
let baseUrl;
let lookup = async (username) => REFF_USERS[username] || null;

async function get(path, headers = {}) {
  const res = await fetch(`${baseUrl}${path}`, { headers });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe('reff-guest.routes.js: JWT de Rëff solo con sesion de Elvi-Ra', () => {
  before(async () => {
    const app = express();
    mountReffGuestToken(app, {
      auth: authStub,
      requireMesa: requireMesaStub,
      signToken,
      getUserByUsername: (u) => lookup(u),
      mongo: mongoStub,
    });
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  for (const path of ['/reff/api/guest-token', '/api/guest-token']) {
    describe(path, () => {
      test('sin sesion -> 401, aunque el cliente diga quien es en X-Elvira-User', async () => {
        const plain = await get(path);
        assert.equal(plain.status, 401);
        const spoof = await get(path, { 'x-elvira-user': 'mblanes@s-nficorp.com' });
        assert.equal(spoof.status, 401);
        assert.equal(spoof.body.token, undefined);
      });

      test('token de sesion desconocido o caducado -> 401', async () => {
        const { status } = await get(path, { Authorization: 'Bearer caducado' });
        assert.equal(status, 401);
      });

      test('sesion sin acceso a la mesa reff -> 403', async () => {
        const { status, body } = await get(path, { Authorization: 'Bearer t-ray' });
        assert.equal(status, 403);
        assert.equal(body.token, undefined);
      });

      test('sesion con correspondencia -> 200 y token del usuario de Rëff de ESA sesion', async () => {
        const { status, body } = await get(path, { Authorization: 'Bearer t-marc' });
        assert.equal(status, 200);
        assert.equal(body.token, 'jwt:1:marc:equipo-interno');
        assert.deepEqual(body.user, { id: 1, username: 'marc', displayName: 'Marc', avatarUrl: null });
      });

      test('suplantacion: la cabecera X-Elvira-User no cambia el usuario de la sesion', async () => {
        const { status, body } = await get(path, {
          Authorization: 'Bearer t-amir',
          'x-elvira-user': 'mblanes@s-nficorp.com',
        });
        assert.equal(status, 200);
        assert.equal(body.user.username, 'amir');
        assert.equal(body.token, 'jwt:3:amir:equipo-interno');
      });

      test('admin de Elvi-Ra sin correspondencia en Rëff -> 403, no cae en marc', async () => {
        const { status, body } = await get(path, { Authorization: 'Bearer t-otro-admin' });
        assert.equal(status, 403);
        assert.equal(body.token, undefined);
      });
    });
  }

  test('usuario mapeado que no existe en la DB de Rëff -> 500, sin caer en otro usuario', async () => {
    const prev = lookup;
    lookup = async () => null;
    try {
      const { status, body } = await get('/api/guest-token', { Authorization: 'Bearer t-marc' });
      assert.equal(status, 500);
      assert.equal(body.token, undefined);
    } finally {
      lookup = prev;
    }
  });

  test('si la consulta a la DB de Rëff falla -> 500 y la peticion no se cuelga', async () => {
    const prev = lookup;
    lookup = async () => { throw new Error('mongo caido'); };
    try {
      const { status } = await get('/api/guest-token', { Authorization: 'Bearer t-marc' });
      assert.equal(status, 500);
    } finally {
      lookup = prev;
    }
  });

  test('reffUsername vive en el documento de users, no en un mapa fijo en codigo', async () => {
    assert.equal(USERS['mblanes@s-nficorp.com'].reffUsername, 'marc');
    assert.equal(USERS['ventures@s-nficorp.com'].reffUsername, 'amir');
    assert.equal(USERS['ray@s-nficorp.com'].reffUsername, undefined);
  });
});
