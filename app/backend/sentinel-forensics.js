import crypto from 'node:crypto';
import geoip from 'geoip-lite';
import { DEV_FORENSIC_SECRET, MIN_SECRET_LENGTH } from './config.js';

/* ============================================================
   SENTINEL · Trazabilidad Forense de IPs
   Log criptográfico inmutable: hash chain + HMAC por entry.
   Rate limiting dinámico sobre Mongo (sin Redis).
   ============================================================ */

const GENESIS_HASH = '0'.repeat(64);
const APPEND_ATTEMPTS = 5;
const RESEAL_ROUNDS = 5;
const RESEAL_BATCH = 500;
const RESEAL_REASON = 'RE-SELLADO';
const BREAK_CAUSE = { hash_mismatch: 'encadenamiento', hmac_mismatch: 'firma' };

/* ---- clave HMAC del registro forense ----
   Se lee al crear el servicio, no al importar el módulo: server.js carga los .env
   locales después de evaluar sus imports. Es independiente de JWT_SECRET para poder
   rotar una sin invalidar la otra. */
export function resolveForensicSecret(
  env = { SENTINEL_FORENSIC_SECRET: process.env.SENTINEL_FORENSIC_SECRET, NODE_ENV: process.env.NODE_ENV },
  logger = console,
) {
  const configured = env.SENTINEL_FORENSIC_SECRET;
  const production = env.NODE_ENV === 'production';
  if (!configured) {
    if (production) throw new Error('SENTINEL_FORENSIC_SECRET es obligatoria en producción.');
    logger.warn('[sentinel-forensics] SENTINEL_FORENSIC_SECRET no está definida: el registro forense se firma con la clave de desarrollo.');
    return DEV_FORENSIC_SECRET;
  }
  if (Buffer.byteLength(configured, 'utf8') < MIN_SECRET_LENGTH) {
    throw new Error(`SENTINEL_FORENSIC_SECRET debe tener al menos ${MIN_SECRET_LENGTH} bytes.`);
  }
  if (production && configured === DEV_FORENSIC_SECRET) {
    throw new Error('SENTINEL_FORENSIC_SECRET no puede ser la clave de desarrollo en producción.');
  }
  return configured;
}

// Rutas sensibles (rate limit estricto). Ampliable sin tocar código: el jefe
// añade prefijos extra via env SENTINEL_EXTRA_SENSITIVE_PATHS (separados por coma)
// cuando incorpore nuevos puertos/mesas, sin tener que editar este archivo.
const SENSITIVE_PREFIXES = [
  '/api/elvira/cnmc', '/api/snfi-u2', '/api/u2',
  ...(process.env.SENTINEL_EXTRA_SENSITIVE_PATHS || '').split(',').map(p => p.trim()).filter(Boolean),
];
const SENSITIVE_LIMIT_PER_MIN = 20;
const NORMAL_LIMIT_PER_MIN = 120;
const RATE_WINDOW_MS = 60 * 1000;
const AUTO_BLOCK_SAME_ROUTE_COUNT = 3;
const AUTO_BLOCK_SAME_ROUTE_WINDOW_MS = 60 * 60 * 1000; // 1h
const AUTO_BLOCK_DISTINCT_ROUTES_COUNT = 2;

// Paises marcados como riesgo elevado para el scoring heuristico (configurable, sin terceros).
// Codigo ISO-2 de geoip-lite. Vacio por defecto — el jefe puede rellenar via env.
const RISK_COUNTRIES = (process.env.SENTINEL_RISK_COUNTRIES || '').split(',').map(c => c.trim().toUpperCase()).filter(Boolean);

/* ============================================================
   Profiling de Comportamiento a Largo Plazo (Behavioral Analytics)
   Analiza patrones de USO por empleado (no por IP) sobre el propio
   forensic_log — sin coleccion nueva de eventos, se reutiliza la
   traza ya escrita por appendForensicEntry.
   ============================================================ */

// "Informes OPHS": rutas de lectura del Cockpit (OPS+PAIA+Herzog+Sentinel resumido) y nodos.
const OPHS_REPORT_PREFIXES = ['/api/ophs-cockpit', '/api/ophs/nodes', '/api/ops', '/api/paia'];
const OPHS_REPORT_LIMIT = 5;
const OPHS_REPORT_WINDOW_MS = 60 * 60 * 1000; // 1h — umbral literal del jefe: "5 informes OPHS en menos de 1 hora"
const BEHAVIOR_ALERT_LEVEL_FREQ = 'NARANJA';

// "Zonas sensibles" para la regla de exfiltracion: mismo criterio de rutas sensibles
// (CNMC + U-2, SENSITIVE_PREFIXES definido mas abajo) mas los informes OPHS.
function isOphsReportPath(path) {
  return OPHS_REPORT_PREFIXES.some(p => path.startsWith(p));
}

const MESA_LABELS = {
  elvira: 'Elvi-Ra (centro de mando)',
  reff: 'Rëff (CRM comercial)',
  snfiu2: 'S-NFI U-2 (datos científicos)',
  sentinel: 'Sentinel (seguridad)',
  twin: 'Twin (enlace S-NFI Systems)',
};

function humanizePath(path) {
  if (path.startsWith('/api/elvira/cnmc')) return 'informes CNMC';
  if (path.startsWith('/api/snfi-u2') || path.startsWith('/api/u2')) return 'datos científicos S-NFI U-2';
  if (path.startsWith('/api/login')) return 'inicio de sesión';
  if (path.startsWith('/api/sentinel')) return 'panel de seguridad Sentinel';
  return path;
}

function geoLabel(geo) {
  if (!geo) return 'ubicación desconocida';
  return [geo.city, geo.country].filter(Boolean).join(', ') || 'ubicación desconocida';
}

/* ---- traduce una entrada forense tecnica a una frase clara para no-tecnicos ---- */
function humanizeEntry(entry) {
  const where = geoLabel(entry.geo);
  const what = humanizePath(entry.path);
  const who = entry.user ? `el usuario ${entry.user}` : `alguien desde ${entry.ip}`;
  if (entry.reason?.startsWith(RESEAL_REASON)) {
    return `${who} re-selló la cadena forense: ${entry.reason.slice(RESEAL_REASON.length).replace(/^\s*·\s*/, '')}.`;
  }
  if (entry.blocked) {
    if (entry.reason?.startsWith('AUTO-BLOQUEO')) {
      return `${who} (${where}) intentó acceder repetidamente a ${what}. Sentinel detectó un patrón de ataque y bloqueó la IP automáticamente.`;
    }
    if (entry.reason?.includes('dominio')) {
      return `${who} (${where}) intentó iniciar sesión con un correo no autorizado. Sentinel bloqueó la IP al instante.`;
    }
    if (entry.statusCode === 429) {
      return `${who} (${where}) hizo demasiadas peticiones a ${what} en poco tiempo. Sentinel bloqueó la petición y envió la IP a revisión.`;
    }
    return `${who} (${where}) tuvo una petición bloqueada a ${what}. Motivo: ${entry.reason || 'sin especificar'}.`;
  }
  return `${who} (${where}) accedió a ${what} sin problemas.`;
}

/* ---- heuristica propia de riesgo (0-100), sin servicios externos ---- */
async function computeRiskScore(mongo, ip, geo) {
  let score = 0;
  const reasons = [];

  const excessCount = await mongo.collection('ip_excess_log').countDocuments({ ip });
  if (excessCount > 0) {
    score += Math.min(excessCount * 15, 45);
    reasons.push(`${excessCount} exceso(s) de tasa registrados`);
  }

  const failedLogins = await mongo.collection('login_attempts').countDocuments({ ip, ok: false });
  if (failedLogins > 0) {
    score += Math.min(failedLogins * 10, 30);
    reasons.push(`${failedLogins} intento(s) de login fallido`);
  }

  const invalidDomainAttempts = await mongo.collection('login_attempts').countDocuments({ ip, reason: 'dominio_no_autorizado' });
  if (invalidDomainAttempts > 0) {
    score += 40;
    reasons.push('intento de login con dominio no autorizado');
  }

  if (geo?.country && RISK_COUNTRIES.includes(geo.country)) {
    score += 15;
    reasons.push(`origen en país marcado como riesgo (${geo.country})`);
  }

  score = Math.min(score, 100);
  const level = score >= 70 ? 'ALTO' : score >= 35 ? 'MEDIO' : 'BAJO';
  return { score, level, reasons };
}

function isSensitivePath(path) {
  return SENSITIVE_PREFIXES.some(p => path.startsWith(p));
}

function canonical(entry) {
  // Orden de claves fijo para que el hash sea determinista.
  return JSON.stringify({
    seq: entry.seq, ts: entry.ts, ip: entry.ip, method: entry.method, path: entry.path,
    mesa: entry.mesa, sensitive: entry.sensitive, user: entry.user, statusCode: entry.statusCode,
    blocked: entry.blocked, reason: entry.reason,
  });
}

function chainHash(prevHash, entry) {
  return crypto.createHash('sha256').update(prevHash + canonical(entry)).digest('hex');
}

export function createSentinelForensics({ mongo, busEmit, ROLE_MESAS = {}, env }) {
  const secret = resolveForensicSecret(env);
  const signHmac = (hash) => crypto.createHmac('sha256', secret).update(hash).digest('hex');
  const forensicLog = () => mongo.collection('forensic_log');

  // seq y prevHash salen siempre de la cola real en Mongo, nunca de memoria: en un
  // redeploy con rolling restart dos procesos escriben a la vez la misma cadena.
  // Cada entrada toma el último registro (seq + 1, su hash) y el índice único sobre
  // seq (db/mongo.js) arbitra: si otro proceso inserta antes ese seq, el insert falla
  // con clave duplicada y se reintenta sobre la cola nueva. Así nunca hay dos entradas
  // encadenadas al mismo registro. Dentro del proceso las escrituras van en fila para
  // no competir entre sí.
  let appendQueue = Promise.resolve();

  function appendForensicEntry(fields) {
    const ts = new Date().toISOString();
    const result = appendQueue.then(() => insertChained(fields, ts));
    appendQueue = result.catch(() => {});
    return result;
  }

  async function insertChained(fields, ts) {
    for (let attempt = 0; attempt < APPEND_ATTEMPTS; attempt += 1) {
      const tail = await forensicLog().find({}, { projection: { seq: 1, hash: 1 } }).sort({ seq: -1 }).limit(1).next();
      const entry = {
        seq: tail ? tail.seq + 1 : 1,
        ts,
        ip: fields.ip,
        geo: fields.geo,
        method: fields.method,
        path: fields.path,
        mesa: fields.mesa || null,
        sensitive: !!fields.sensitive,
        user: fields.user || null,
        statusCode: fields.statusCode ?? null,
        blocked: !!fields.blocked,
        reason: fields.reason || null,
        prevHash: tail ? tail.hash : GENESIS_HASH,
      };
      const hash = chainHash(entry.prevHash, entry);
      const doc = { _id: crypto.randomUUID(), ...entry, hash, hmac: signHmac(hash) };
      try {
        await forensicLog().insertOne(doc);
        return doc;
      } catch (err) {
        if (err?.code !== 11000) throw err;
      }
    }
    throw new Error(`forensic_log: no se pudo encadenar la entrada tras ${APPEND_ATTEMPTS} intentos`);
  }

  // null si la entrada verifica tras `prev`; si no, el motivo.
  function breakReason(entry, prev) {
    const hash = chainHash(prev, entry);
    if (hash !== entry.hash) return 'hash_mismatch';
    if (signHmac(hash) !== entry.hmac) return 'hmac_mismatch';
    return null;
  }

  async function verifyChain() {
    const totalEntries = await forensicLog().countDocuments();
    let prev = GENESIS_HASH;
    for await (const entry of forensicLog().find().sort({ seq: 1 })) {
      const reason = breakReason(entry, prev);
      if (reason === 'hash_mismatch') {
        return {
          valid: false, brokenAtSeq: entry.seq, reason, totalEntries,
          explanation: `El registro número ${entry.seq} no encaja con el anterior. Suele pasar cuando el servidor se reinicia justo en mitad de un redeploy y dos procesos escriben a la vez. Los registros siguen guardados, pero a partir de aquí la cadena no se puede verificar matemáticamente. Un Admin puede "re-sellar" la cadena para que vuelva a quedar protegida desde ahora.`,
        };
      }
      if (reason === 'hmac_mismatch') {
        return {
          valid: false, brokenAtSeq: entry.seq, reason, totalEntries,
          explanation: `El registro número ${entry.seq} tiene una firma que no coincide. Esto indica que el dato pudo modificarse fuera de Sentinel. Revisar con prioridad. También ocurre si se ha cambiado la clave de firma: en ese caso, un Admin debe re-sellar la cadena.`,
        };
      }
      prev = entry.hash;
    }
    return { valid: true, totalEntries };
  }

  /* ---- una pasada de re-sellado: desde el primer registro que no verifica, vuelve a
     encadenar y firmar con la clave vigente. Solo cambia prevHash, hash y hmac; el sello
     sustituido se guarda en sealHistory, así que con la clave anterior aún puede
     comprobarse. contentMismatch cuenta los registros cuyo contenido ya no coincidía con
     su propio sello: no son una bifurcación ni un cambio de clave y conviene revisarlos. ---- */
  async function resealPass(decidedBy) {
    const now = new Date();
    let prev = GENESIS_HASH;
    let broken = false;
    let fixedFrom = null;
    let resealed = 0;
    let contentMismatch = 0;
    let ops = [];
    const flush = async () => {
      if (ops.length) await forensicLog().bulkWrite(ops, { ordered: true });
      ops = [];
    };
    for await (const entry of forensicLog().find().sort({ seq: 1 })) {
      if (!broken && !breakReason(entry, prev)) {
        prev = entry.hash;
        continue;
      }
      broken = true;
      const hash = chainHash(prev, entry);
      const hmac = signHmac(hash);
      if (entry.prevHash !== prev || entry.hash !== hash || entry.hmac !== hmac) {
        fixedFrom ??= entry.seq;
        resealed += 1;
        if (chainHash(entry.prevHash, entry) !== entry.hash) contentMismatch += 1;
        ops.push({ updateOne: {
          filter: { _id: entry._id, hash: entry.hash, hmac: entry.hmac },
          update: {
            $set: { prevHash: prev, hash, hmac, reanchoredAt: now, reanchoredBy: decidedBy },
            $push: { sealHistory: { prevHash: entry.prevHash, hash: entry.hash, hmac: entry.hmac, replacedAt: now, replacedBy: decidedBy } },
          },
        } });
        if (ops.length >= RESEAL_BATCH) await flush();
      }
      prev = hash;
    }
    await flush();
    return { fixedFrom, resealed, contentMismatch };
  }

  /* ---- re-sellado (Admin): no borra ni modifica el contenido de ningún registro. Repite
     la pasada si mientras tanto entran escrituras encadenadas a un sello recién sustituido.
     Queda trazado en la propia cadena (entrada RE-SELLADO firmada con la clave vigente),
     en cada registro tocado (reanchoredAt, reanchoredBy, sealHistory) y en el bus. ---- */
  async function reanchorChain(decidedBy, { ip = null } = {}) {
    const check = await verifyChain();
    if (check.valid) return { reanchored: false, reason: 'cadena_ya_integra' };

    let fixedFrom = null;
    let resealed = 0;
    let contentMismatch = 0;
    for (let round = 0; round < RESEAL_ROUNDS; round += 1) {
      const pass = await resealPass(decidedBy);
      if (!pass.resealed) break;
      fixedFrom = fixedFrom === null ? pass.fixedFrom : Math.min(fixedFrom, pass.fixedFrom);
      resealed += pass.resealed;
      contentMismatch += pass.contentMismatch;
    }
    // Otro re-sellado simultáneo ya la dejó íntegra.
    if (!resealed) return { reanchored: false, reason: 'cadena_ya_integra' };

    const cause = BREAK_CAUSE[check.reason] || check.reason;
    const detail = `${resealed} registro(s) desde el número ${fixedFrom}, causa: ${cause}`
      + (contentMismatch ? `, ${contentMismatch} con contenido distinto de su sello anterior` : '');
    const trace = await appendForensicEntry({
      ip: ip || 'interno', geo: null, method: 'POST', path: '/api/sentinel/reanchor-chain', mesa: 'sentinel',
      sensitive: false, user: decidedBy, statusCode: null, blocked: false, reason: `${RESEAL_REASON} · ${detail}`,
    });
    const after = await verifyChain();
    busEmit?.({
      id: crypto.randomUUID(), ts: new Date().toISOString(), origin: 'SENTINEL', dest: 'ELVI-RA',
      type: 'event', state: 'INFO', label: `CADENA FORENSE RE-SELLADA · ${detail} · por ${decidedBy}`,
      payload: { fixedFrom, resealed, contentMismatch, cause: check.reason, traceSeq: trace.seq, decidedBy },
    });
    return {
      reanchored: true, fixedFrom, resealed, contentMismatch, cause: check.reason,
      traceSeq: trace.seq, valid: after.valid,
    };
  }

  /* ---- rate limiting dinámico sobre Mongo (sin Redis) ---- */
  async function checkRateLimit(ip, path, limit) {
    const now = Date.now();
    const windowStart = new Date(now - RATE_WINDOW_MS);
    const key = `${ip}::${path}`;
    await mongo.collection('rate_limits').insertOne({
      key, ip, path, ts: new Date(now), expiresAt: new Date(now + RATE_WINDOW_MS),
    });
    const count = await mongo.collection('rate_limits').countDocuments({ key, ts: { $gte: windowStart } });
    return { exceeded: count > limit, count, limit };
  }

  /* ---- lista blanca: IPs de confianza (ej. la del propio Admin) que nunca ----
     entran en cola de revision ni se autobloquean. El Admin la gestiona a mano,
     doctrina "el ser humano autoriza" — Sentinel no decide por su cuenta quien entra aqui. */
  async function isIpAllowlisted(ip) {
    const entry = await mongo.collection('ip_allowlist').findOne({ ip });
    return !!entry;
  }

  async function addToAllowlist(ip, label, decidedBy) {
    const now = new Date();
    await mongo.collection('ip_allowlist').updateOne(
      { ip },
      { $set: { ip, label: label || null, addedBy: decidedBy, updatedAt: now }, $setOnInsert: { createdAt: now } },
      { upsert: true },
    );
    // si estaba bloqueada o en cola, se limpia: marcar como propia anula cualquier decision previa
    await mongo.collection('ip_review_queue').deleteOne({ ip });
    return mongo.collection('ip_allowlist').findOne({ ip });
  }

  async function removeFromAllowlist(ip) {
    const r = await mongo.collection('ip_allowlist').deleteOne({ ip });
    return { removed: r.deletedCount > 0 };
  }

  async function listAllowlist() {
    return mongo.collection('ip_allowlist').find().sort({ updatedAt: -1 }).toArray();
  }

  /* ---- política de exceso: cola de revisión Admin + auto-bloqueo por patrón ---- */
  async function isIpBlocked(ip) {
    if (await isIpAllowlisted(ip)) return false;
    const blocked = await mongo.collection('ip_review_queue').findOne({ ip, decision: 'BLOCKED' });
    return !!blocked;
  }

  async function registerExcess(ip, path, geo) {
    const now = new Date();
    await mongo.collection('ip_excess_log').insertOne({ ip, path, ts: now });

    const sinceWindow = new Date(now.getTime() - AUTO_BLOCK_SAME_ROUTE_WINDOW_MS);
    const sameRouteCount = await mongo.collection('ip_excess_log').countDocuments({ ip, path, ts: { $gte: sinceWindow } });
    const distinctRoutes = await mongo.collection('ip_excess_log').distinct('path', { ip });

    const shouldAutoBlock = sameRouteCount >= AUTO_BLOCK_SAME_ROUTE_COUNT || distinctRoutes.length >= AUTO_BLOCK_DISTINCT_ROUTES_COUNT;

    const existing = await mongo.collection('ip_review_queue').findOne({ ip });
    if (shouldAutoBlock) {
      const reason = sameRouteCount >= AUTO_BLOCK_SAME_ROUTE_COUNT
        ? `AUTO-BLOQUEO · ${sameRouteCount} excesos en ${path} dentro de 1h`
        : `AUTO-BLOQUEO · reconocimiento activo en ${distinctRoutes.length} rutas sensibles distintas`;
      await mongo.collection('ip_review_queue').updateOne(
        { ip },
        { $set: { ip, geo, decision: 'BLOCKED', reason, autoBlocked: true, decidedAt: now, updatedAt: now },
          $setOnInsert: { createdAt: now } },
        { upsert: true },
      );
      busEmit?.({
        id: crypto.randomUUID(), ts: now.toISOString(), origin: 'SENTINEL', dest: 'ELVI-RA',
        type: 'alert', state: 'BLOCKED', label: `IP AUTO-BLOQUEADA · ${ip}`,
        payload: { ip, geo, reason },
      });
      return { autoBlocked: true, reason };
    }

    if (!existing) {
      await mongo.collection('ip_review_queue').insertOne({
        ip, geo, decision: 'PENDING', reason: `Exceso de tasa en ruta sensible · ${path}`,
        autoBlocked: false, createdAt: now, updatedAt: now,
      });
    }
    return { autoBlocked: false };
  }

  /* ---- enchufa Sentinel a cualquier app/puerto Express en una linea ----
     util cuando se añaden mas puertos (Twin, mesas nuevas): basta con
     sentinelForensics.attach(esaApp, mesaForPathDeEsePuerto) ---- */
  function attach(expressApp, mesaForPath) {
    expressApp.use(middleware(mesaForPath));
  }

  /* ---- middleware global ---- */
  function middleware(mesaForPath) {
    return async function sentinelForensicsMiddleware(req, res, next) {
      const ip = req.ip || 'unknown';
      const geo = geoip.lookup(ip.replace(/^::ffff:/, '')) || null;
      const sensitive = isSensitivePath(req.path);

      try {
        if (await isIpBlocked(ip)) {
          await appendForensicEntry({
            ip, geo, method: req.method, path: req.path, mesa: mesaForPath?.(req.path) || null,
            sensitive, user: req.user || null, statusCode: 403, blocked: true, reason: 'IP en lista de bloqueo Sentinel',
          });
          return res.status(403).json({ error: 'IP bloqueada por Sentinel' });
        }

        if (sensitive && !(await isIpAllowlisted(ip))) {
          const { exceeded } = await checkRateLimit(ip, req.path, SENSITIVE_LIMIT_PER_MIN);
          if (exceeded) {
            const excess = await registerExcess(ip, req.path, geo);
            await appendForensicEntry({
              ip, geo, method: req.method, path: req.path, mesa: mesaForPath?.(req.path) || null,
              sensitive, user: req.user || null, statusCode: 429, blocked: true,
              reason: excess.autoBlocked ? excess.reason : 'Rate limit excedido en ruta sensible (cola revisión Admin)',
            });
            busEmit?.({
              id: crypto.randomUUID(), ts: new Date().toISOString(), origin: 'SENTINEL', dest: 'ELVI-RA',
              type: 'alert', state: 'BLOCKED', label: `RATE LIMIT EXCEDIDO · ${ip} · ${req.path}`,
              payload: { ip, geo, path: req.path },
            });
            return res.status(429).json({ error: 'Demasiadas peticiones en ruta sensible. IP enviada a revisión.' });
          }
        }

        res.on('finish', () => {
          const mesa = mesaForPath?.(req.path) || null;
          appendForensicEntry({
            ip, geo, method: req.method, path: req.path, mesa,
            sensitive, user: req.user || null, statusCode: res.statusCode, blocked: false,
          }).catch(err => console.error('[sentinel-forensics] log error', err));
          if (req.user && res.statusCode < 400) {
            checkBehavioralAnomaly({ user: req.user, role: req.role, path: req.path, mesa });
          }
        });

        next();
      } catch (err) {
        console.error('[sentinel-forensics] middleware error', err);
        next();
      }
    };
  }

  async function listForensicLog({ ip, mesa, blocked, sensitive, from, to, limit = 200, offset = 0 } = {}) {
    const q = {};
    if (ip) q.ip = ip;
    if (mesa) q.mesa = mesa;
    if (blocked != null) q.blocked = blocked === 'true' || blocked === true;
    if (sensitive != null) q.sensitive = sensitive === 'true' || sensitive === true;
    if (from || to) {
      q.ts = {};
      if (from) q.ts.$gte = new Date(String(from)).toISOString();
      if (to)   q.ts.$lte = new Date(String(to)).toISOString();
    }
    const total = await mongo.collection('forensic_log').countDocuments(q);
    const events = await mongo.collection('forensic_log').find(q).sort({ seq: -1 }).skip(Number(offset)).limit(Math.min(Number(limit), 1000)).toArray();
    return { total, events };
  }

  /* ---- mismo log, en frases claras para usuarios sin conocimiento tecnico ---- */
  async function listForensicLogHuman({ ip, blocked, from, to, limit = 100, offset = 0 } = {}) {
    const q = {};
    if (ip) q.ip = ip;
    if (blocked != null) q.blocked = blocked === 'true' || blocked === true;
    if (from || to) {
      q.ts = {};
      if (from) q.ts.$gte = new Date(String(from)).toISOString();
      if (to)   q.ts.$lte = new Date(String(to)).toISOString();
    }
    const total = await mongo.collection('forensic_log').countDocuments(q);
    const events = await mongo.collection('forensic_log').find(q).sort({ seq: -1 }).skip(Number(offset)).limit(Math.min(Number(limit), 500)).toArray();
    return {
      total,
      events: events.map(e => ({
        seq: e.seq, ts: e.ts, ip: e.ip, blocked: e.blocked, sensitive: e.sensitive,
        mesa: e.mesa ? (MESA_LABELS[e.mesa] || e.mesa) : null,
        message: humanizeEntry(e),
      })),
    };
  }

  async function ipStats() {
    const top = await mongo.collection('forensic_log').aggregate([
      { $group: { _id: '$ip', total: { $sum: 1 }, blocked: { $sum: { $cond: ['$blocked', 1, 0] } }, geo: { $first: '$geo' }, lastSeen: { $max: '$ts' } } },
      { $sort: { total: -1 } },
      { $limit: 50 },
    ]).toArray();
    return top.map(t => ({ ip: t._id, total: t.total, blocked: t.blocked, geo: t.geo, lastSeen: t.lastSeen }));
  }

  async function listReviewQueue() {
    const queue = await mongo.collection('ip_review_queue').find().sort({ updatedAt: -1 }).limit(200).toArray();
    return Promise.all(queue.map(async q => ({ ...q, risk: await computeRiskScore(mongo, q.ip, q.geo) })));
  }

  /* ---- registro de intentos de login + bloqueo instantaneo por dominio no autorizado ---- */
  async function registerLoginAttempt({ ip, username, ok, reason }) {
    const now = new Date();
    const geo = geoip.lookup(ip.replace(/^::ffff:/, '')) || null;
    await mongo.collection('login_attempts').insertOne({ ip, username, ok, reason: reason || null, geo, ts: now });

    if (reason === 'dominio_no_autorizado' && !(await isIpAllowlisted(ip))) {
      await mongo.collection('ip_review_queue').updateOne(
        { ip },
        { $set: {
            ip, geo, decision: 'BLOCKED', autoBlocked: true,
            reason: `AUTO-BLOQUEO · intento de login con correo no autorizado (${username})`,
            decidedAt: now, updatedAt: now,
          },
          $setOnInsert: { createdAt: now } },
        { upsert: true },
      );
      busEmit?.({
        id: crypto.randomUUID(), ts: now.toISOString(), origin: 'SENTINEL', dest: 'ELVI-RA',
        type: 'alert', state: 'BLOCKED',
        label: `INTENTO DE LOGIN NO AUTORIZADO · ${ip} · correo "${username}"`,
        payload: { ip, geo, username },
      });
      await appendForensicEntry({
        ip, geo, method: 'POST', path: '/api/login', mesa: null, sensitive: false,
        user: username, statusCode: 403, blocked: true,
        reason: `AUTO-BLOQUEO · login con dominio no autorizado (${username})`,
      });
      return { blocked: true };
    }
    return { blocked: false };
  }

  async function decideReview(ip, decision, decidedBy) {
    const now = new Date();
    await mongo.collection('ip_review_queue').updateOne(
      { ip },
      { $set: { decision, decidedBy, decidedAt: now, updatedAt: now, autoBlocked: false } },
      { upsert: true },
    );
    return mongo.collection('ip_review_queue').findOne({ ip });
  }

  /* ---- bloqueo manual directo desde panel Admin (sin esperar exceso) ---- */
  async function manualBlock(ip, reason, decidedBy) {
    const now = new Date();
    const geo = geoip.lookup(ip.replace(/^::ffff:/, '')) || null;
    await mongo.collection('ip_review_queue').updateOne(
      { ip },
      { $set: { ip, geo, decision: 'BLOCKED', reason: reason || `Bloqueo manual por ${decidedBy}`, autoBlocked: false, decidedBy, decidedAt: now, updatedAt: now },
        $setOnInsert: { createdAt: now } },
      { upsert: true },
    );
    return mongo.collection('ip_review_queue').findOne({ ip });
  }

  /* ============================================================
     Profiling de Comportamiento a Largo Plazo (Behavioral Analytics)
     Bloqueo por USUARIO (no por IP) — cola separada de ip_review_queue,
     mismo patron (decision PENDING/BLOCKED/ALLOWED, Admin decide).
     ============================================================ */

  async function isUserBlocked(user) {
    if (!user) return false;
    const blocked = await mongo.collection('user_review_queue').findOne({ user, decision: 'BLOCKED' });
    return !!blocked;
  }

  async function listUserReviewQueue() {
    return mongo.collection('user_review_queue').find().sort({ updatedAt: -1 }).limit(200).toArray();
  }

  async function decideUserReview(user, decision, decidedBy) {
    const now = new Date();
    await mongo.collection('user_review_queue').updateOne(
      { user },
      { $set: { decision, decidedBy, decidedAt: now, updatedAt: now, autoBlocked: false } },
      { upsert: true },
    );
    return mongo.collection('user_review_queue').findOne({ user });
  }

  async function manualBlockUser(user, reason, decidedBy) {
    const now = new Date();
    await mongo.collection('user_review_queue').updateOne(
      { user },
      { $set: { user, decision: 'BLOCKED', reason: reason || `Bloqueo manual por ${decidedBy}`, autoBlocked: false, decidedBy, decidedAt: now, updatedAt: now },
        $setOnInsert: { createdAt: now } },
      { upsert: true },
    );
    return mongo.collection('user_review_queue').findOne({ user });
  }

  async function appendBehaviorAlert(fields) {
    const now = new Date();
    const doc = { _id: crypto.randomUUID(), ts: now.toISOString(), ...fields };
    await mongo.collection('behavior_alerts').insertOne(doc);
    return doc;
  }

  /* ---- Frecuencia anormal: >=5 informes OPHS en <1h por el mismo usuario -> alerta NARANJA ----
     No distingue perfil (PhD u otro): la regla aplica igual a cualquier rol, el jefe
     puede acotar por perfil mas adelante si se añade ese campo a `users`. Cooldown de
     1 alerta por usuario por ventana: sin esto, cada peticion nueva del usuario mientras
     el contador siga >=5 (ej. el propio panel Cockpit de OPHS haciendo polling automatico
     de sus KPIs) volvia a disparar una alerta identica — visto en produccion: 30 alertas
     en 15 minutos del mismo usuario con la pestaña de OPHS simplemente abierta. */
  async function checkFrequencyAnomaly({ user, path, mesa }) {
    if (!user || !isOphsReportPath(path)) return null;
    const since = new Date(Date.now() - OPHS_REPORT_WINDOW_MS);
    const alreadyAlerted = await mongo.collection('behavior_alerts').findOne({
      user, type: 'FRECUENCIA_ANORMAL', ts: { $gte: since.toISOString() },
    });
    if (alreadyAlerted) return null;

    const count = await mongo.collection('forensic_log').countDocuments({
      user, ts: { $gte: since.toISOString() },
      $or: OPHS_REPORT_PREFIXES.map(p => ({ path: { $regex: `^${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` } })),
    });
    if (count < OPHS_REPORT_LIMIT) return null;

    const alert = await appendBehaviorAlert({
      type: 'FRECUENCIA_ANORMAL', level: BEHAVIOR_ALERT_LEVEL_FREQ, user, mesa: mesa || null,
      count, windowMinutes: OPHS_REPORT_WINDOW_MS / 60000,
      reason: `${count} informes OPHS solicitados por ${user} en menos de 1 hora`,
    });
    busEmit?.({
      id: crypto.randomUUID(), ts: alert.ts, origin: 'SENTINEL', dest: 'ELVI-RA',
      type: 'alert', state: BEHAVIOR_ALERT_LEVEL_FREQ, label: `ALERTA NARANJA · frecuencia anormal · ${user} (${count} informes OPHS/1h)`,
      payload: { user, count, path }, user,
    });
    return alert;
  }

  /* ---- Exfiltracion de datos: acceso a informes OPHS sin proyecto activo en Reff. ----
     PLACEHOLDER: no existe hoy vinculo proyecto-activo <-> usuario en el esquema Reff
     (companies/sheets no llevan owner de proyecto por seccion geografica/sector). Como
     proxy se usa acceso concedido a la mesa 'reff' via ROLE_MESAS.
     Alcance deliberadamente limitado a rutas OPHS (no a CNMC/U-2): esas ya estan
     gateadas por su propia mesa (requireMesa('snfiu2')/('elvira')) en server.js, asi
     que un usuario que llega hasta ahi ya tiene permiso legitimo de esa mesa concreta —
     marcarlo tambien como "sin proyecto Reff" bloquearia sin motivo a usuarios como
     'ray'/'gonzalo' (snfiu2 sin reff) en su primera peticion normal. OPHS en cambio es
     una mesa independiente de reff en ROLE_MESAS, asi que "informe OPHS sin proyecto
     Reff asociado" es una señal real de cruce de datos entre dominios. Sustituir por el
     vinculo real de proyecto en cuanto exista ese campo en Reff (no hardcodear roles:
     ROLE_MESAS puede cambiar). */
  async function checkExfiltration({ user, role, path, mesa }) {
    if (!user || !isOphsReportPath(path)) return null;
    const hasReffProject = role === 'admin' || (ROLE_MESAS[role] || []).includes('reff');
    if (hasReffProject) return null;

    // Mismo motivo que checkFrequencyAnomaly: sin este check, un usuario sin mesa 'reff'
    // que tiene el panel OPHS abierto (polling automatico) generaria una alerta ROJA +
    // reescritura de user_review_queue en cada peticion, en vez de una sola vez.
    const already = await mongo.collection('user_review_queue').findOne({ user, decision: 'BLOCKED', autoBlocked: true });
    if (already) return null;

    const alert = await appendBehaviorAlert({
      type: 'EXFILTRACION_SOSPECHOSA', level: 'ROJO', user, role, mesa: mesa || null, path,
      reason: `Acceso a zona sensible (${path}) sin proyecto activo asociado en Rëff`,
    });
    await mongo.collection('user_review_queue').updateOne(
      { user },
      { $set: {
          user, decision: 'BLOCKED', autoBlocked: true,
          reason: `AUTO-BLOQUEO · ${alert.reason}`,
          decidedAt: alert.ts, updatedAt: alert.ts,
        },
        $setOnInsert: { createdAt: alert.ts } },
      { upsert: true },
    );
    busEmit?.({
      id: crypto.randomUUID(), ts: alert.ts, origin: 'SENTINEL', dest: 'ELVI-RA',
      type: 'alert', state: 'BLOCKED', label: `USUARIO BLOQUEADO · exfiltracion sospechosa · ${user}`,
      payload: { user, path, mesa }, user,
    });
    return alert;
  }

  /* ---- corre ambas reglas de comportamiento tras registrar una peticion (fire-and-forget) ---- */
  function checkBehavioralAnomaly({ user, role, path, mesa }) {
    if (!user) return;
    checkFrequencyAnomaly({ user, path, mesa }).catch(err => console.error('[sentinel-behavior] freq check error', err));
    checkExfiltration({ user, role, path, mesa }).catch(err => console.error('[sentinel-behavior] exfil check error', err));
  }

  async function listBehaviorAlerts({ user, type, level, limit = 100, offset = 0 } = {}) {
    const q = {};
    if (user) q.user = user;
    if (type) q.type = type;
    if (level) q.level = level;
    const total = await mongo.collection('behavior_alerts').countDocuments(q);
    const events = await mongo.collection('behavior_alerts').find(q).sort({ ts: -1 }).skip(Number(offset)).limit(Math.min(Number(limit), 500)).toArray();
    return { total, events };
  }

  /* ---- Heatmap de interes: peticiones por usuario x mesa, ultimos N dias ---- */
  async function behaviorHeatmap(days = 30) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const rows = await mongo.collection('forensic_log').aggregate([
      { $match: { ts: { $gte: since.toISOString() }, user: { $ne: null }, mesa: { $ne: null } } },
      { $group: { _id: { user: '$user', mesa: '$mesa' }, total: { $sum: 1 }, sensitive: { $sum: { $cond: ['$sensitive', 1, 0] } } } },
      { $sort: { total: -1 } },
    ]).toArray();
    const users = [...new Set(rows.map(r => r._id.user))].sort();
    const mesas = [...new Set(rows.map(r => r._id.mesa))].sort();
    const cells = rows.map(r => ({ user: r._id.user, mesa: r._id.mesa, total: r.total, sensitive: r.sensitive }));
    return { days, users, mesas, cells };
  }

  /* ---- timeline de trafico: peticiones/min ultimos N minutos ---- */
  async function trafficTimeline(minutes = 60) {
    const since = new Date(Date.now() - minutes * 60 * 1000);
    const buckets = await mongo.collection('forensic_log').aggregate([
      { $match: { ts: { $gte: since.toISOString() } } },
      { $group: {
        _id: { $dateTrunc: { date: { $toDate: '$ts' }, unit: 'minute' } },
        total: { $sum: 1 },
        blocked: { $sum: { $cond: ['$blocked', 1, 0] } },
        sensitive: { $sum: { $cond: ['$sensitive', 1, 0] } },
      } },
      { $sort: { _id: 1 } },
    ]).toArray();
    return buckets.map(b => ({ minute: b._id.toISOString(), total: b.total, blocked: b.blocked, sensitive: b.sensitive }));
  }

  async function exportIpReport(ip) {
    const log = await mongo.collection('forensic_log').find({ ip }).sort({ seq: 1 }).toArray();
    const review = await mongo.collection('ip_review_queue').findOne({ ip });
    return { ip, review, totalRequests: log.length, log };
  }

  return {
    middleware, attach, listForensicLog, listForensicLogHuman, ipStats, listReviewQueue, decideReview, manualBlock,
    trafficTimeline, exportIpReport, verifyChain, reanchorChain, isSensitivePath, registerLoginAttempt,
    addToAllowlist, removeFromAllowlist, listAllowlist, isIpAllowlisted,
    // Behavioral Analytics (profiling de comportamiento)
    isUserBlocked, listUserReviewQueue, decideUserReview, manualBlockUser,
    listBehaviorAlerts, behaviorHeatmap,
  };
}
