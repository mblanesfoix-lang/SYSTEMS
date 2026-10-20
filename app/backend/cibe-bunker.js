/**
 * CIBE Bunker — modulo bunker de Pactvm Viridi (doctrina Instrucciones.txt §3).
 *
 * Control de Admision de Confianza Cero: toda peticion a los endpoints criticos
 * del OPHS Framework debe ir acompañada de una firma digital (token CIBE)
 * expedida por este modulo. El token es inmutable (firmado Ed25519) y fechado
 * (iat/exp, TTL corto). Sin conformidad CIBE la puerta permanece cerrada:
 * la denegacion genera un Auth-Refusal registrado en log de hash encadenado.
 *
 * Mecanica del filtro (zero-trust):
 *   - Sujetos internos (Admin con sesion): en modo 'auto' el bunker expide el
 *     token en linea y lo registra — cada mutacion critica queda firmada y
 *     trazada sin romper la UI. En modo 'strict' la cabecera es obligatoria.
 *   - Sujetos externos (racks perifericos / redes electricas): necesitan un
 *     certificado CIBE en estado 'emitido' (coleccion pactvm_cibe) con
 *     tokenKey asignada. Piden token via POST /api/cibe/token firmando con
 *     HMAC su tokenKey. Cert suspendido/revocado/inexistente => AUTH_REFUSAL,
 *     da igual la urgencia o el dinero.
 *
 * Claves: par Ed25519 generado una vez y persistido en Mongo (cibe_keys).
 * Override prod: env CIBE_PRIVATE_KEY_PEM + CIBE_PUBLIC_KEY_PEM (vault/env,
 * misma nota de produccion que el resto de secretos de nodo).
 */

import crypto from 'node:crypto';
import { appendChained, verifyLog } from './lib/hash-chain.js';

const TOKEN_RE = /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const KEY_SCOPES = ['ophs.command', 'grid.command', 'rack.command', 'fl.expediente.read', '*'];
const CLOCK_SKEW_S = 60;
const EXTERNAL_TS_WINDOW_MS = 30000;

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

const appendCibeLog = (mongo, entry) => appendChained(mongo, 'cibe_log', entry);

export function createCibeBunker({ mongo, busEmit, adminNotify }) {
  const MODE = ['off', 'auto', 'strict'].includes(process.env.CIBE_MODE) ? process.env.CIBE_MODE : 'auto';
  const TTL_S = Math.min(Math.max(Number(process.env.CIBE_TOKEN_TTL_S) || 120, 30), 3600);

  let privateKey = null;
  let publicKey = null;
  let kid = null;
  const revoked = new Set();
  const counters = { issued: 0, verified: 0, refused: 0, autoIssued: 0 };
  let readyPromise = null;

  async function init() {
    if (process.env.CIBE_PRIVATE_KEY_PEM && process.env.CIBE_PUBLIC_KEY_PEM) {
      privateKey = crypto.createPrivateKey(process.env.CIBE_PRIVATE_KEY_PEM);
      publicKey = crypto.createPublicKey(process.env.CIBE_PUBLIC_KEY_PEM);
      kid = 'env';
    } else {
      const col = mongo.collection('cibe_keys');
      let doc = await col.findOne({ _id: 'active' });
      if (!doc) {
        const pair = crypto.generateKeyPairSync('ed25519');
        doc = {
          _id: 'active',
          kid: crypto.randomUUID().slice(0, 8),
          privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
          publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }),
          createdAt: new Date().toISOString(),
        };
        await col.insertOne(doc);
        await appendCibeLog(mongo, { action: 'keypair.generate', actorId: 'system', detail: { kid: doc.kid } });
      }
      privateKey = crypto.createPrivateKey(doc.privateKeyPem);
      publicKey = crypto.createPublicKey(doc.publicKeyPem);
      kid = doc.kid;
    }
    const revs = await mongo.collection('cibe_revocations').find({}).toArray();
    for (const r of revs) revoked.add(r._id);
    console.log(`[CIBE] Bunker activo · modo ${MODE} · kid ${kid} · TTL ${TTL_S}s`);
  }

  function ready() {
    if (!readyPromise) readyPromise = init();
    return readyPromise;
  }

  function signPayload(payload) {
    const body = b64url(JSON.stringify(payload));
    const sig = crypto.sign(null, Buffer.from(body), privateKey);
    return `v1.${body}.${b64url(sig)}`;
  }

  async function issue({ sub, scope, via, actor }) {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      jti: crypto.randomUUID(),
      kid,
      sub,
      scope,
      iat: now,
      exp: now + TTL_S,
      nonce: crypto.randomBytes(8).toString('hex'),
    };
    const token = signPayload(payload);
    counters.issued += 1;
    await appendCibeLog(mongo, {
      action: 'token.issue',
      actorId: actor || sub,
      detail: { jti: payload.jti, sub, scope, via, exp: payload.exp },
    });
    return { token, payload };
  }

  function verify(token, requiredScope) {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return { ok: false, code: 'bad_format', error: 'token CIBE con formato invalido' };
    const [, body, sig] = token.split('.');
    let payload;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      return { ok: false, code: 'bad_format', error: 'payload CIBE ilegible' };
    }
    if (payload.kid !== kid) return { ok: false, code: 'bad_kid', error: 'kid desconocido (clave rotada)' };
    const valid = crypto.verify(null, Buffer.from(body), publicKey, Buffer.from(sig, 'base64url'));
    if (!valid) return { ok: false, code: 'bad_sig', error: 'firma Ed25519 invalida' };
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(payload.exp) || payload.exp < now) return { ok: false, code: 'expired', error: 'token CIBE caducado' };
    if (!Number.isFinite(payload.iat) || payload.iat > now + CLOCK_SKEW_S) return { ok: false, code: 'bad_iat', error: 'iat en el futuro' };
    if (revoked.has(payload.jti)) return { ok: false, code: 'revoked', error: 'token CIBE revocado' };
    if (payload.scope !== '*' && payload.scope !== requiredScope) return { ok: false, code: 'bad_scope', error: `scope '${payload.scope}' no cubre '${requiredScope}'` };
    counters.verified += 1;
    return { ok: true, payload };
  }

  async function refuse(req, res, { scope, code, error, sub }) {
    counters.refused += 1;
    const detail = { scope, code, sub: sub || null, path: req.path, method: req.method, ip: req.ip || null };
    appendCibeLog(mongo, { action: 'auth_refusal', actorId: sub || 'anonimo', detail }).catch(() => {});
    busEmit({
      id: crypto.randomUUID(), ts: new Date().toISOString(),
      origin: 'PACTVM', dest: 'SENTINEL', type: 'cibe_refusal', state: 'BLOCKED',
      label: `CIBE · Auth-Refusal ${code} en ${req.method} ${req.path}`,
      payload: detail, user: sub || 'anonimo',
    });
    adminNotify({
      origin: 'PACTVM', severity: 'warning',
      label: `CIBE Auth-Refusal (${code})`,
      detail: `${req.method} ${req.path}: ${error}`,
    });
    res.status(403).json({ error: 'AUTH_REFUSAL', code, detail: error });
  }

  /**
   * Middleware para endpoints criticos. Colocar SIEMPRE despues de auth en la
   * cadena de la ruta (necesita req.user para el modo auto).
   */
  function guard(scope) {
    return (req, res, next) => {
      if (MODE === 'off') return next();
      ready().then(async () => {
        const header = req.headers['x-cibe-token'];
        if (header) {
          const result = verify(String(header), scope);
          if (!result.ok) return refuse(req, res, { scope, code: result.code, error: result.error, sub: req.user });
          req.cibe = result.payload;
          return next();
        }
        if (MODE === 'auto' && req.user) {
          // Expedicion en linea: la peticion del Admin queda firmada y trazada
          // por el bunker sin exigir que la UI gestione tokens.
          counters.autoIssued += 1;
          const { payload } = await issue({ sub: `user:${req.user}`, scope, via: 'auto-session', actor: req.user });
          req.cibe = payload;
          return next();
        }
        return refuse(req, res, {
          scope,
          code: 'missing_token',
          error: MODE === 'strict' ? 'cabecera X-CIBE-Token obligatoria (modo strict)' : 'sin sesion ni token CIBE',
          sub: req.user,
        });
      }).catch((err) => {
        if (!res.headersSent) res.status(500).json({ error: `bunker CIBE no disponible: ${err.message}` });
      });
    };
  }

  async function revoke(jti, actor) {
    revoked.add(jti);
    await mongo.collection('cibe_revocations').updateOne(
      { _id: jti },
      { $set: { revokedBy: actor, revokedAt: new Date().toISOString() } },
      { upsert: true },
    );
    await appendCibeLog(mongo, { action: 'token.revoke', actorId: actor, detail: { jti } });
  }

  function status() {
    return {
      mode: MODE,
      kid,
      alg: 'Ed25519',
      tokenTtlS: TTL_S,
      counters: { ...counters },
      revokedCount: revoked.size,
      keySource: process.env.CIBE_PRIVATE_KEY_PEM ? 'env (vault)' : 'mongo (cibe_keys — mover a vault en prod)',
    };
  }

  function publicKeyInfo() {
    return { kid, alg: 'Ed25519', publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) };
  }

  return { ready, issue, verify, guard, revoke, status, publicKeyInfo, MODE };
}

export function mountCibeBunker(app, { auth, requireMesa, mongo, bunker, busEmit }) {
  const guard = [auth, requireMesa('pactvm')];

  const h = (fn) => (req, res) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      console.error('[CIBE] route error:', err?.message || err);
      if (!res.headersSent) res.status(500).json({ error: String(err?.message || err) });
    });
  };

  /* ---- endpoints publicos (sin sesion: los consume el rack periferico) ---- */

  // Clave publica para que cualquier rack periferico verifique tokens localmente.
  app.get('/api/cibe/public-key', h(async (req, res) => {
    await bunker.ready();
    res.json(bunker.publicKeyInfo());
  }));

  // Puerta de acceso CIBE: sujeto externo pide token firmando con su tokenKey.
  // Sin certificado 'emitido' => Auth-Refusal automatico (doctrina: el acceso
  // no se compra, se gana mediante cumplimiento).
  app.post('/api/cibe/token', h(async (req, res) => {
    await bunker.ready();
    const b = req.body || {};
    const entityId = String(b.entityId || '').trim();
    const ts = Number(b.ts);
    const nonce = String(b.nonce || '');
    const hmac = String(b.hmac || '');
    const scope = KEY_SCOPES.includes(b.scope) && b.scope !== '*' ? b.scope : null;

    async function externalRefusal(code, error) {
      await appendCibeLog(mongo, { action: 'auth_refusal', actorId: entityId || 'anonimo', detail: { code, via: 'external', path: '/api/cibe/token' } });
      busEmit?.({
        id: crypto.randomUUID(), ts: new Date().toISOString(),
        origin: 'PACTVM', dest: 'SENTINEL', type: 'cibe_refusal', state: 'BLOCKED',
        label: `CIBE · Auth-Refusal externo ${code} (${entityId || 'anonimo'})`,
        payload: { code, entityId: entityId || null, via: 'external' }, user: entityId || 'anonimo',
      });
      res.status(403).json({ error: 'AUTH_REFUSAL', code, detail: error });
    }

    if (!entityId || !Number.isFinite(ts) || !nonce || !hmac || !scope) {
      return externalRefusal('bad_request', 'entityId, ts, nonce, hmac y scope (concreto, no *) requeridos');
    }
    if (Math.abs(Date.now() - ts) > EXTERNAL_TS_WINDOW_MS) {
      return externalRefusal('stale_ts', 'ts fuera de ventana (±30s, exige NTP)');
    }
    const cert = await mongo.collection('pactvm_cibe').findOne({ entityName: entityId });
    if (!cert) return externalRefusal('no_cert', 'sin certificado CIBE: solicitar auditoria Herzog');
    if (cert.status !== 'emitido') return externalRefusal('cert_not_issued', `certificado en estado '${cert.status}': la puerta permanece cerrada`);
    if (!cert.tokenKey) return externalRefusal('no_token_key', 'certificado sin tokenKey asignada (pedir alta al Admin)');

    const expected = crypto.createHmac('sha256', cert.tokenKey).update(`${entityId}|${ts}|${nonce}`).digest('hex');
    const a = Buffer.from(hmac.toLowerCase(), 'hex');
    const e = Buffer.from(expected, 'hex');
    if (a.length !== e.length || !crypto.timingSafeEqual(a, e)) {
      return externalRefusal('bad_hmac', 'firma HMAC invalida');
    }

    const { token, payload } = await bunker.issue({ sub: `entity:${entityId}`, scope, via: 'external-hmac', actor: entityId });
    res.json({ token, jti: payload.jti, exp: payload.exp, scope });
  }));

  /* ---- administracion del bunker (mesa pactvm) ---- */

  app.get('/api/pactvm/cibe-bunker/status', ...guard, h(async (req, res) => {
    await bunker.ready();
    const refusals = await mongo.collection('cibe_log')
      .find({ action: 'auth_refusal' }).sort({ seq: -1 }).limit(20).toArray();
    res.json({
      ...bunker.status(),
      recentRefusals: refusals.map((r) => ({ seq: r.seq, actorId: r.actorId, detail: r.detail, createdAt: r.createdAt })),
    });
  }));

  // Asigna (o rota) la tokenKey de un certificado CIBE. Se devuelve UNA vez.
  app.post('/api/pactvm/cibe/:id/token-key', ...guard, h(async (req, res) => {
    const cert = await mongo.collection('pactvm_cibe').findOne({ _id: req.params.id });
    if (!cert) return res.status(404).json({ error: 'certificado no encontrado' });
    if (cert.status !== 'emitido') return res.status(409).json({ error: `certificado en estado '${cert.status}', solo 'emitido' puede tener tokenKey` });
    const tokenKey = crypto.randomBytes(24).toString('hex');
    await mongo.collection('pactvm_cibe').updateOne({ _id: cert._id }, { $set: { tokenKey, tokenKeyRotatedAt: new Date().toISOString() } });
    await appendCibeLog(mongo, { action: 'token_key.assign', actorId: req.user, detail: { cibeId: cert._id, entityName: cert.entityName } });
    res.json({ cibeId: cert._id, entityName: cert.entityName, tokenKey });
  }));

  app.post('/api/pactvm/cibe-bunker/revoke', ...guard, h(async (req, res) => {
    const jti = String(req.body?.jti || '').trim();
    if (!jti) return res.status(400).json({ error: 'jti requerido' });
    await bunker.ready();
    await bunker.revoke(jti, req.user);
    res.json({ jti, revoked: true });
  }));

  app.get('/api/pactvm/cibe-bunker/log', ...guard, h(async (req, res) => {
    const rows = await mongo.collection('cibe_log').find({}).sort({ seq: -1 }).limit(100).toArray();
    res.json(rows.map(({ _id, ...r }) => ({ id: _id, ...r })));
  }));

  app.get('/api/pactvm/cibe-bunker/log/verify', ...guard, h(async (req, res) => {
    res.json(await verifyLog(mongo, 'cibe_log'));
  }));
}
