import crypto from 'node:crypto';
import geoip from 'geoip-lite';

/* ============================================================
   SENTINEL · Trazabilidad Forense de IPs
   Log criptográfico inmutable: hash chain + HMAC por entry.
   Rate limiting dinámico sobre Mongo (sin Redis).
   ============================================================ */

const FORENSIC_SECRET = process.env.SENTINEL_FORENSIC_SECRET || process.env.JWT_SECRET || 'dev-only-secret-cambiar-en-produccion';

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

const MESA_LABELS = {
  elvira: 'Elvi-Ra (centro de mando)',
  reff: 'Rëff (CRM comercial)',
  snfiu2: 'S-NFI U-2 (datos científicos)',
  sentinel: 'Sentinel (seguridad)',
  twin: 'Twin (enlace S-NFI Systems)',
  foundry: 'Data Foundry (ingesta pipeline)',
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

function signHmac(hash) {
  return crypto.createHmac('sha256', FORENSIC_SECRET).update(hash).digest('hex');
}

export function createSentinelForensics({ mongo, busEmit }) {
  // seq/hash se derivan SIEMPRE de Mongo, nunca de memoria de proceso.
  // Motivo: en un redeploy con rolling restart (Coolify) el contenedor viejo
  // sigue vivo unos segundos a la vez que el nuevo ya arranca — dos procesos
  // distintos escribiendo la misma cadena con su propio lastHash/seqCounter
  // en memoria garantiza una bifurcación (seq duplicado o hash que no encaja).
  // Por eso cada append relee la cola real con findOneAndUpdate atómico sobre
  // un contador en Mongo, y reintenta si otro proceso ganó la carrera.
  // El contador guarda tambien el hash de la ultima entrada: findOneAndUpdate
  // es atomico en Mongo, asi que seq+prevHash salen de una unica operacion
  // indivisible. Ningun otro proceso puede colarse entre "leer el tail" y
  // "reservar el siguiente seq" porque ya no son dos pasos.
  async function nextSeqAndPrevHash() {
    const doc = await mongo.collection('forensic_seq').findOneAndUpdate(
      { _id: 'counter' },
      { $inc: { value: 1 } },
      { upsert: true, returnDocument: 'after' },
    );
    return { seq: doc.value, prevHash: doc.lastHash || '0'.repeat(64) };
  }

  async function appendForensicEntry(fields, attempt = 0) {
    const { seq, prevHash } = await nextSeqAndPrevHash();
    const entry = {
      seq,
      ts: new Date().toISOString(),
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
      prevHash,
    };
    const hash = crypto.createHash('sha256').update(prevHash + canonical(entry)).digest('hex');
    const hmac = signHmac(hash);
    const doc = { _id: crypto.randomUUID(), ...entry, hash, hmac };
    try {
      await mongo.collection('forensic_log').insertOne(doc);
    } catch (err) {
      // seq duplicado: no deberia pasar (el contador es atomico), pero si
      // ocurre por una anomalia de Mongo, reintenta con seq nuevo en vez de tirar.
      if (err?.code === 11000 && attempt < 5) return appendForensicEntry(fields, attempt + 1);
      throw err;
    }
    // Encadena el contador al hash recien escrito, solo hacia adelante: si dos
    // inserts terminan en orden distinto al que reservaron su seq, el de mayor
    // seq nunca se deja pisar por uno mas antiguo que llegue tarde.
    await mongo.collection('forensic_seq').updateOne(
      { _id: 'counter', $or: [{ lastHashSeq: { $exists: false } }, { lastHashSeq: { $lt: seq } }] },
      { $set: { lastHash: hash, lastHashSeq: seq } },
    );
    return doc;
  }

  async function verifyChain() {
    const all = await mongo.collection('forensic_log').find().sort({ seq: 1 }).toArray();
    let prev = '0'.repeat(64);
    for (const entry of all) {
      const expectedHash = crypto.createHash('sha256').update(prev + canonical(entry)).digest('hex');
      if (expectedHash !== entry.hash) {
        return {
          valid: false, brokenAtSeq: entry.seq, reason: 'hash_mismatch', totalEntries: all.length,
          explanation: `El registro número ${entry.seq} no encaja con el anterior. Suele pasar cuando el servidor se reinicia justo en mitad de un redeploy y dos procesos escriben a la vez. Los registros siguen guardados, pero a partir de aquí la cadena no se puede verificar matemáticamente. Un Admin puede "re-sellar" la cadena para que vuelva a quedar protegida desde ahora.`,
        };
      }
      const expectedHmac = signHmac(entry.hash);
      if (expectedHmac !== entry.hmac) {
        return {
          valid: false, brokenAtSeq: entry.seq, reason: 'hmac_mismatch', totalEntries: all.length,
          explanation: `El registro número ${entry.seq} tiene una firma que no coincide. Esto indica que el dato pudo modificarse fuera de Sentinel. Revisar con prioridad.`,
        };
      }
      prev = entry.hash;
    }
    return { valid: true, totalEntries: all.length };
  }

  /* ---- re-sella la cadena desde el punto roto: no borra historial, ----
     pero re-ancla el hash a partir de aqui para que vuelva a verificar limpio ---- */
  async function reanchorChain(decidedBy) {
    const check = await verifyChain();
    if (check.valid) return { reanchored: false, reason: 'cadena_ya_integra' };

    const all = await mongo.collection('forensic_log').find().sort({ seq: 1 }).toArray();
    let prev = '0'.repeat(64);
    let fixedFrom = null;
    for (const entry of all) {
      const expectedHash = crypto.createHash('sha256').update(prev + canonical(entry)).digest('hex');
      if (expectedHash !== entry.hash || fixedFrom !== null) {
        if (fixedFrom === null) fixedFrom = entry.seq;
        const hash = crypto.createHash('sha256').update(prev + canonical({ ...entry, prevHash: prev })).digest('hex');
        const hmac = signHmac(hash);
        await mongo.collection('forensic_log').updateOne(
          { _id: entry._id },
          { $set: { prevHash: prev, hash, hmac, reanchoredAt: new Date(), reanchoredBy: decidedBy } },
        );
        prev = hash;
      } else {
        prev = entry.hash;
      }
    }
    busEmit?.({
      id: crypto.randomUUID(), ts: new Date().toISOString(), origin: 'SENTINEL', dest: 'ELVI-RA',
      type: 'event', state: 'INFO', label: `CADENA FORENSE RE-SELLADA · desde seq ${fixedFrom} · por ${decidedBy}`,
      payload: { fixedFrom, decidedBy },
    });
    return { reanchored: true, fixedFrom };
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
          appendForensicEntry({
            ip, geo, method: req.method, path: req.path, mesa: mesaForPath?.(req.path) || null,
            sensitive, user: req.user || null, statusCode: res.statusCode, blocked: false,
          }).catch(err => console.error('[sentinel-forensics] log error', err));
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
  };
}
