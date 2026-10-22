/**
 * S-EAGLE — Rëff Core Engine, mesa 5. Ventana de inspeccion: un inspector de
 * gobierno ve, solo en lectura, el cumplimiento de S-NFI calculado sobre
 * Herzog LaW. No ejecuta accion alguna ni modifica datos de otras mesas —
 * Regla de Oro: S-EAGLE señala, el humano decide.
 *
 * Doctrina aplicada al acceso externo:
 *  - Dirección autoriza: solo el Admin crea, revisa y revoca invitaciones.
 *  - Una invitacion = organismo, correos autorizados, duracion y alcance (que
 *    normas, si ve las zonas ATEX y que documentos puede descargar).
 *  - El enlace lleva un token aleatorio y el inspector añade un codigo de 6
 *    digitos. En Mongo solo quedan el sha256 del token y el HMAC del codigo:
 *    quien lea la base no puede entrar.
 *  - El codigo abre una sesion de solo lectura que muere con la invitacion, con
 *    la revocacion o a las SESSION_MAX_HOURS. Cada peticion vuelve a comprobar
 *    la invitacion: revocar corta al inspector en su siguiente refresco.
 *  - Todo acceso queda en seagle_log (cadena de hashes) y avisa al Admin.
 *  - El servidor arma una copia filtrada: lo que no se comparte no viaja.
 *
 * Limite conocido y aceptado (igual que el VDR de Pactvm): quien ve la pantalla
 * puede capturarla. El enlace controla quien entra, cuanto tiempo y deja
 * traza; no impide la copia visual.
 */

import crypto from 'node:crypto';
import { GridFSBucket, ObjectId } from 'mongodb';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { tenantContext, withTenant } from './db/tenant-context.js';
import { DEFAULT_TENANT_ID } from './db/tenant-registry.js';
import { DOCUMENT_TYPES } from './herzog-law.js';
import { appendChained, verifyLog } from './lib/hash-chain.js';
import { safeEqual } from './lib/safe-compare.js';
import { getDataSeal } from './lib/data-seal.js';
import { buildComplianceView } from './lib/compliance-view.js';
import {
  parseInvitationInput, invitationState, sessionExpiry, INVITE_MAX_FAILURES,
} from './lib/inspection-invite.js';

const LOG = 'seagle_log';
const PUBLIC_PREFIX = '/api/seagle-inspect';
// Una entrada de "sigue mirando" por sesion como mucho cada 10 min: deja traza de la
// duracion sin llenar la cadena con cada refresco de la pantalla.
const VIEW_LOG_EVERY_MS = 10 * 60 * 1000;
const ACCESS_LOG_SHOWN = 50;

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const appendSeagleLog = (mongo, entry) => appendChained(mongo, LOG, entry);
const noStore = (res) => res.set('Cache-Control', 'no-store');

function asObjectId(id) {
  return ObjectId.isValid(id) && String(new ObjectId(id)) === id ? new ObjectId(id) : null;
}

function documentView(f) {
  return {
    id: f._id.toString(),
    filename: f.filename,
    contentType: f.metadata?.content_type || 'application/octet-stream',
    size: f.length,
    frameworkId: f.metadata?.framework_id || null,
  };
}

const STATUS_CODE = { NOT_FOUND: 404, REVOKED: 410, EXPIRED: 410, LOCKED: 410 };

/**
 * systemTenantId: tenant de las rutas publicas, que no tienen sesion de la que
 * sacarlo (mismo criterio que Pactvm). Por eso las invitaciones solo se crean
 * desde ese tenant: en otro, el enlace no se encontraria nunca.
 * integrityTtlMs: cuanto se reutiliza la verificacion de los logs entre
 * refrescos de la pantalla (recorrerlos enteros en cada peticion no escala).
 */
export function mountSeagle(app, {
  auth, requireMesa, requireAdmin, mongo, adminNotify,
  systemTenantId = DEFAULT_TENANT_ID, dataSeal = getDataSeal(), integrityTtlMs = 15000,
}) {
  const router = app;
  const guard = [auth, requireMesa('seagle')];
  const adminGuard = [...guard, requireAdmin];
  const publicTenant = withTenant(systemTenantId);

  const invitations = () => mongo.collection('seagle_invitations');
  const sessions = () => mongo.collection('seagle_inspector_sessions');
  const frameworksCol = () => mongo.collection('herzog_law_frameworks');
  const zonesCol = () => mongo.collection('herzog_law_zones');
  const documentFiles = () => mongo.collection('herzog_law_documents.files');
  const documentsBucket = () => new GridFSBucket(mongo, { bucketName: 'herzog_law_documents' });

  // El codigo va atado a su invitacion: un HMAC copiado a otra no sirve.
  const codeHashOf = (invitationId, code) => dataSeal.mac('seagle.access-code', `${invitationId}:${code}`);

  /* ---- sello de integridad, con cache corta por tenant ---- */

  const integrityCache = new Map();
  async function integrityNow() {
    const key = tenantContext.getStore()?.tenantId ?? '_';
    const hit = integrityCache.get(key);
    if (hit && Date.now() - hit.at < integrityTtlMs) return hit.value;
    const [herzogLaw, seagle] = await Promise.all([verifyLog(mongo, 'herzog_law_log'), verifyLog(mongo, LOG)]);
    const value = { checkedAt: new Date().toISOString(), herzogLaw, seagle };
    integrityCache.set(key, { at: Date.now(), value });
    return value;
  }

  /* ---- lo que ve el inspector: la vista de cumplimiento recortada a su alcance ---- */

  async function inspectorPayload(invitation, now = new Date()) {
    const { scope } = invitation;
    const fwQuery = Array.isArray(scope.frameworkIds) ? { _id: { $in: scope.frameworkIds } } : {};
    const docIds = (scope.documentIds ?? []).map(asObjectId).filter(Boolean);
    const [frameworks, zones, documents, integrity] = await Promise.all([
      frameworksCol().find(fwQuery).toArray(),
      scope.includeZones ? zonesCol().find({}).toArray() : [],
      docIds.length ? documentFiles().find({ _id: { $in: docIds } }).toArray() : [],
      integrityNow(),
    ]);
    const view = buildComplianceView({ frameworks, zones, integrity, now });
    return {
      inspection: {
        label: invitation.label,
        expiresAt: invitation.expiresAt,
        demo: invitation.demo,
        includeZones: scope.includeZones,
        allFrameworks: !Array.isArray(scope.frameworkIds),
      },
      ...view,
      zones: scope.includeZones ? view.zones : null,
      documents: documents.map(documentView),
    };
  }

  /* ---- resumen (health-check dashboard) ---- */

  router.get('/api/seagle/summary', ...guard, async (req, res) => {
    const now = new Date().toISOString();
    const active = await invitations().countDocuments({ revoked: false, expiresAt: { $gt: now }, failedAttempts: { $lt: INVITE_MAX_FAILURES } });
    res.json({ invitationsActive: active });
  });

  /* ---- vista de cumplimiento interna ----
   * Solo lee los registros de Herzog LaW (misma db, sin duplicar dato) y calcula el
   * semaforo. No siembra el catalogo: si Herzog LaW aun no se ha abierto, sale vacio. */

  router.get('/api/seagle/compliance', ...guard, async (req, res) => {
    const [frameworks, zones, integrity] = await Promise.all([
      frameworksCol().find({}).toArray(),
      zonesCol().find({}).toArray(),
      integrityNow(),
    ]);
    res.json(buildComplianceView({ frameworks, zones, integrity, now: new Date() }));
  });

  /* ---- invitaciones de inspeccion (solo Admin) ---- */

  // Normas y documentos que se pueden compartir: alimenta el formulario de alta.
  router.get('/api/seagle/inspectable', ...adminGuard, async (req, res) => {
    const [frameworks, documents] = await Promise.all([
      frameworksCol().find({}, { projection: { code: 1, title: 1, status: 1, nature: 1, priority: 1 } }).sort({ code: 1 }).toArray(),
      documentFiles().find({}).sort({ uploadDate: -1 }).limit(300).toArray(),
    ]);
    res.json({
      frameworks: frameworks.map(({ _id, ...rest }) => ({ id: _id, ...rest })),
      documents: documents.map(documentView),
    });
  });

  router.get('/api/seagle/invitations', ...adminGuard, async (req, res) => {
    const now = new Date();
    const [rows, liveSessions] = await Promise.all([
      invitations().find({}).sort({ createdAt: -1 }).limit(100).toArray(),
      sessions().aggregate([
        { $match: { endedAt: null, expireAt: { $gt: now } } },
        { $group: { _id: '$invitationId', count: { $sum: 1 } } },
      ]).toArray(),
    ]);
    const liveBy = new Map(liveSessions.map((s) => [s._id, s.count]));
    noStore(res).json(rows.map((r) => ({
      id: r._id,
      label: r.label,
      emails: r.emails,
      expiresAt: r.expiresAt,
      state: invitationState(r, now).reason,
      scope: r.scope,
      demo: r.demo,
      failedAttempts: r.failedAttempts ?? 0,
      createdBy: r.createdBy,
      createdAt: r.createdAt,
      revokedBy: r.revokedBy ?? null,
      revokedAt: r.revokedAt ?? null,
      accessCount: (r.accessLog ?? []).length,
      accessLog: (r.accessLog ?? []).slice(-ACCESS_LOG_SHOWN),
      liveSessions: liveBy.get(r._id) ?? 0,
      // ni el token ni el codigo: solo se ven una vez, al crear la invitacion
    })));
  });

  router.post('/api/seagle/invitations', ...adminGuard, async (req, res) => {
    const tenant = tenantContext.getStore()?.tenantId;
    if (tenant && tenant !== systemTenantId) {
      return res.status(409).json({ error: 'Las invitaciones de inspección solo se pueden crear desde el entorno principal de S-NFI' });
    }
    const [fwRows, docRows] = await Promise.all([
      frameworksCol().find({}, { projection: { _id: 1 } }).toArray(),
      documentFiles().find({}, { projection: { _id: 1 } }).toArray(),
    ]);
    const parsed = parseInvitationInput(req.body, {
      knownFrameworks: new Set(fwRows.map((f) => String(f._id))),
      knownDocuments: new Set(docRows.map((d) => d._id.toString())),
    });
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const { label, emails, hours, scope, demo } = parsed.value;

    const token = crypto.randomBytes(24).toString('base64url');
    const id = sha256(token);
    const code = String(crypto.randomInt(100000, 1000000));
    const now = new Date();
    const expiresAt = new Date(now.getTime() + hours * 3600 * 1000).toISOString();
    await invitations().insertOne({
      _id: id, // el token solo viaja en el enlace de esta respuesta
      label,
      emails,
      codeHash: codeHashOf(id, code), // nunca el codigo en claro
      expiresAt,
      scope,
      demo,
      revoked: false,
      failedAttempts: 0,
      accessLog: [],
      createdBy: req.user,
      createdAt: now.toISOString(),
    });
    await appendSeagleLog(mongo, {
      action: 'invitation.created', actorId: req.user,
      detail: { invitationId: id, label, emails, hours, expiresAt, scope, demo },
    });
    const base = `${req.protocol}://${req.get('host')}`;
    // El token va en el fragmento (#): el navegador no lo envia en peticiones ni en el Referer.
    noStore(res).status(201).json({ id, token, code, expiresAt, label, emails, url: `${base}/pages/seagle-inspeccion.html#t=${token}` });
  });

  router.post('/api/seagle/invitations/:id/revoke', ...adminGuard, async (req, res) => {
    const id = String(req.params.id);
    const row = await invitations().findOne({ _id: id });
    if (!row) return res.status(404).json({ error: 'invitación no encontrada' });
    const now = new Date();
    if (!row.revoked) {
      await invitations().updateOne({ _id: id }, { $set: { revoked: true, revokedBy: req.user, revokedAt: now.toISOString() } });
      const ended = await sessions().updateMany({ invitationId: id, endedAt: null }, { $set: { endedAt: now, endedBy: 'revocation' } });
      await appendSeagleLog(mongo, {
        action: 'invitation.revoked', actorId: req.user,
        detail: { invitationId: id, label: row.label, sessionsEnded: ended.modifiedCount },
      });
    }
    res.json({ id, revoked: true });
  });

  // Exactamente lo que vera el inspector, para revisarlo antes de enviar el enlace.
  router.get('/api/seagle/invitations/:id/preview', ...adminGuard, async (req, res) => {
    const row = await invitations().findOne({ _id: String(req.params.id) });
    if (!row) return res.status(404).json({ error: 'invitación no encontrada' });
    noStore(res).json(await inspectorPayload(row));
  });

  /* ---- integridad del log ---- */

  router.get('/api/seagle/log/verify', ...guard, async (req, res) => {
    res.json(await verifyLog(mongo, LOG));
  });

  /* ---- rutas publicas del inspector (SIN sesion de SYSTEMS) ----
   * Fuera del prefijo '/api/seagle' a proposito: server.js aplica auth+requireMesa a
   * todo ese prefijo con app.use antes de montar la mesa, y una ruta publica ahi
   * dentro quedaria bloqueada. El token viaja en el cuerpo, nunca en la URL: asi no
   * queda en registros de acceso ni en el historial del navegador. */

  const tokenOf = (req) => (typeof req.body?.token === 'string' ? req.body.token.trim() : '');

  // Solo cuentan los intentos fallidos. Por IP y enlace (10 cada 15 min) y por enlace
  // desde cualquier IP (30 por hora); ademas, INVITE_MAX_FAILURES bloquea la invitacion.
  const limiterBase = {
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: { error: 'Demasiados intentos fallidos. Espera unos minutos.' },
  };
  const targetKey = (req) => sha256(tokenOf(req)).slice(0, 32);
  const unlockPerIp = rateLimit({
    ...limiterBase, windowMs: 15 * 60 * 1000, limit: 10,
    keyGenerator: (req) => `${req.ip ? ipKeyGenerator(req.ip) : 'anon'}|${targetKey(req)}`,
  });
  const unlockPerTarget = rateLimit({
    ...limiterBase, windowMs: 60 * 60 * 1000, limit: 30,
    keyGenerator: (req) => `target|${targetKey(req)}`,
  });

  async function findByToken(req) {
    const token = tokenOf(req);
    if (!token || token.length > 200) return null;
    return invitations().findOne({ _id: sha256(token) });
  }

  // Estado del enlace antes de pedir credenciales. No revela el contenido ni el organismo.
  app.post(`${PUBLIC_PREFIX}/status`, publicTenant, async (req, res) => {
    const row = await findByToken(req);
    const state = invitationState(row);
    if (!state.ok) return noStore(res).status(STATUS_CODE[state.reason]).json({ status: state.reason });
    noStore(res).json({ status: 'ACTIVE', expiresAt: row.expiresAt });
  });

  async function registerFailure(row, email, reason, ip) {
    const updated = await invitations().findOneAndUpdate(
      { _id: row._id },
      { $inc: { failedAttempts: 1 } },
      { returnDocument: 'after' },
    );
    await appendSeagleLog(mongo, { action: 'inspect.denied', actorId: 'inspector', detail: { invitationId: row._id, email, reason, ip } });
    if ((updated?.failedAttempts ?? 0) === INVITE_MAX_FAILURES) {
      await appendSeagleLog(mongo, { action: 'invitation.locked', actorId: 'system', detail: { invitationId: row._id, label: row.label } });
      adminNotify?.({
        origin: 'SEAGLE', severity: 'warning',
        label: `S-EAGLE · Invitación bloqueada: ${row.label}`,
        detail: `${INVITE_MAX_FAILURES} intentos fallidos de correo o código. Si el inspector es legítimo, emite una invitación nueva.`,
      });
    }
  }

  app.post(`${PUBLIC_PREFIX}/unlock`, unlockPerIp, unlockPerTarget, publicTenant, async (req, res) => {
    const row = await findByToken(req);
    const state = invitationState(row);
    if (!state.ok) return noStore(res).status(STATUS_CODE[state.reason]).json({ status: state.reason });

    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase().slice(0, 200) : '';
    const code = typeof req.body?.code === 'string' ? req.body.code.trim().slice(0, 20) : '';
    if (!email || !code) return res.status(400).json({ error: 'Correo y código requeridos' });

    const ip = req.ip || null;
    // Mismo mensaje para correo y codigo: no se deja averiguar que correos estan invitados.
    const denied = () => noStore(res).status(403).json({ error: 'Correo o código incorrectos' });
    if (!row.emails.includes(email)) {
      await registerFailure(row, email, 'email_no_autorizado', ip);
      return denied();
    }
    if (!safeEqual(codeHashOf(row._id, code), row.codeHash)) {
      await registerFailure(row, email, 'codigo_invalido', ip);
      return denied();
    }

    const sessionToken = crypto.randomBytes(32).toString('base64url');
    const sessionId = sha256(sessionToken);
    const now = new Date();
    const expireAt = sessionExpiry(row.expiresAt, now);
    await sessions().insertOne({
      _id: sessionId,
      invitationId: row._id,
      email,
      ip,
      userAgent: String(req.get('user-agent') || '').slice(0, 200),
      createdAt: now,
      expireAt, // indice TTL: Mongo la borra al vencer; la traza queda en seagle_log
      lastSeenAt: now,
      views: 0,
      lastLoggedAt: now,
      endedAt: null,
    });
    await invitations().updateOne({ _id: row._id }, { $push: { accessLog: { email, at: now.toISOString(), ip } } });
    await appendSeagleLog(mongo, { action: 'inspect.unlocked', actorId: 'inspector', detail: { invitationId: row._id, email, sessionId, ip } });
    adminNotify?.({
      origin: 'SEAGLE', severity: 'info',
      label: `S-EAGLE · Inspector dentro: ${row.label}`,
      detail: `${email} ha abierto la ventana de inspección (solo lectura). Sesión hasta ${expireAt.toISOString()}.`,
    });
    noStore(res).json({ sessionToken, expiresAt: expireAt.toISOString(), label: row.label });
  });

  // Sesion del inspector: Bearer propio, nunca la sesion de SYSTEMS. Revalida la
  // invitacion en cada peticion para que revocar o caducar corte al instante.
  async function inspectorSession(req, res, next) {
    try {
      const match = /^Bearer\s+([A-Za-z0-9_-]{20,200})$/.exec(req.get('authorization') || '');
      if (!match) return noStore(res).status(401).json({ status: 'SESSION_INVALID' });
      const session = await sessions().findOne({ _id: sha256(match[1]) });
      if (!session || session.endedAt) return noStore(res).status(401).json({ status: 'SESSION_INVALID' });
      if (new Date(session.expireAt).getTime() <= Date.now()) return noStore(res).status(401).json({ status: 'SESSION_EXPIRED' });
      const invitation = await invitations().findOne({ _id: session.invitationId });
      const state = invitationState(invitation);
      if (!state.ok) return noStore(res).status(401).json({ status: state.reason });
      req.inspection = { session, invitation };
      next();
    } catch (err) {
      next(err);
    }
  }

  app.get(`${PUBLIC_PREFIX}/view`, publicTenant, inspectorSession, async (req, res) => {
    const { session, invitation } = req.inspection;
    const now = new Date();
    const payload = await inspectorPayload(invitation, now);
    const logNow = now.getTime() - new Date(session.lastLoggedAt).getTime() >= VIEW_LOG_EVERY_MS;
    await sessions().updateOne(
      { _id: session._id },
      { $set: { lastSeenAt: now, ...(logNow ? { lastLoggedAt: now } : {}) }, $inc: { views: 1 } },
    );
    if (logNow) {
      await appendSeagleLog(mongo, { action: 'inspect.view', actorId: 'inspector', detail: { invitationId: invitation._id, email: session.email, sessionId: session._id, views: session.views + 1 } });
    }
    noStore(res).json({ ...payload, session: { email: session.email, expiresAt: new Date(session.expireAt).toISOString() } });
  });

  app.get(`${PUBLIC_PREFIX}/documents/:fileId`, publicTenant, inspectorSession, async (req, res, next) => {
    const { session, invitation } = req.inspection;
    const fileId = String(req.params.fileId);
    // Un documento no compartido responde igual que uno inexistente.
    const oid = (invitation.scope.documentIds ?? []).includes(fileId) ? asObjectId(fileId) : null;
    const file = oid ? await documentFiles().findOne({ _id: oid }) : null;
    if (!file) return noStore(res).status(404).json({ error: 'documento no encontrado' });

    await appendSeagleLog(mongo, { action: 'inspect.document', actorId: 'inspector', detail: { invitationId: invitation._id, email: session.email, fileId, filename: file.filename } });
    const declared = file.metadata?.content_type;
    noStore(res).set({
      'Content-Type': DOCUMENT_TYPES.includes(declared) ? declared : 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.filename || 'documento')}`,
      'Content-Length': String(file.length),
    });
    documentsBucket().openDownloadStream(oid)
      .on('error', (err) => (res.headersSent ? res.destroy(err) : next(err)))
      .pipe(res);
  });

  app.post(`${PUBLIC_PREFIX}/logout`, publicTenant, inspectorSession, async (req, res) => {
    const { session, invitation } = req.inspection;
    await sessions().updateOne({ _id: session._id }, { $set: { endedAt: new Date(), endedBy: 'inspector' } });
    await appendSeagleLog(mongo, { action: 'inspect.logout', actorId: 'inspector', detail: { invitationId: invitation._id, email: session.email, sessionId: session._id } });
    noStore(res).json({ ok: true });
  });
}
