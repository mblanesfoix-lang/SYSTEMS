/**
 * Rack State — arquitectura de estado distribuido entre racks fisicos
 * (doctrina Instrucciones.txt §1: escalabilidad fractal, Sentinel como
 * hipervisor descentralizado, Offline-First).
 *
 * Protocolo de consenso Raft (subconjunto real, no representacion): eleccion
 * de lider por termino, replicacion de log y commit por mayoria. La maquina
 * de estados replicada es un KV de configuracion critica: puertos
 * parametrizados y estados de seguridad, sincronizados en todos los racks.
 *
 * Doctrina de exclusion mutua distribuida (Sentinel):
 *   - Un rack aislado (sin quorum) NUNCA comete escrituras nuevas: el lider
 *     sin mayoria abdica y las propuestas se rechazan. Asi un rack atacado o
 *     particionado no puede divergir la configuracion global (split-brain).
 *   - Lecturas siguen sirviendose del ultimo estado comprometido conocido
 *     (Offline-First): el rack funciona autonomo con su copia local.
 *
 * Topologia via env:
 *   RACK_ID          identidad del rack (default hostname)
 *   RACK_PEERS       URLs base de los demas racks, separadas por coma
 *                    (ej: http://10.0.0.2:5173,http://10.0.0.3:5173)
 *   RACK_SHARED_KEY  secreto HMAC de la malla inter-rack (obligatorio con peers;
 *                    S-NFI Teleco añade el tunel dedicado por debajo)
 *   Sin RACK_PEERS => modo standalone: lider unico con quorum 1 (primer rack).
 *
 * Transporte v1: HTTP JSON firmado HMAC-SHA256 (+ ventana temporal 30s).
 * Punto de sustitucion prod: cambiar transporte por los tuneles dedicados
 * de S-NFI Teleco sin tocar la logica Raft.
 */

import crypto from 'node:crypto';
import os from 'node:os';

const KEY_RE = /^[a-z0-9_.:-]{2,80}$/;
const MAX_VALUE_BYTES = 2048;
const RPC_TIMEOUT_MS = 1000;
const PEER_TS_WINDOW_MS = 30000;
const PROPOSE_COMMIT_TIMEOUT_MS = 3000;

const DEFAULT_STATE = {
  'ports.main': Number(process.env.PORT) || 5173,
  'security.posture': 'nominal',
  'security.lockdown': false,
};

function canonical(obj) {
  return JSON.stringify(obj, Object.keys(obj).sort());
}

function hmacOf(body, key) {
  return crypto.createHmac('sha256', key).update(canonical(body)).digest('hex');
}

async function appendRackLog(mongo, entry) {
  const col = mongo.collection('rack_log');
  const tail = await col.find().sort({ seq: -1 }).limit(1).next();
  const seq = tail ? tail.seq + 1 : 1;
  const prevHash = tail ? tail.hash : '0'.repeat(64);
  const canonicalEntry = { ...entry, seq };
  const hash = crypto.createHash('sha256').update(prevHash + canonical(canonicalEntry)).digest('hex');
  const doc = { _id: crypto.randomUUID(), ...entry, seq, prevHash, hash, createdAt: new Date().toISOString() };
  await col.insertOne(doc);
  return doc;
}

export function mountRackState(app, { auth, requireMesa, mongo, busEmit, adminNotify, cibe }) {
  const RACK_ID = (process.env.RACK_ID || os.hostname()).slice(0, 60);
  const PEERS = (process.env.RACK_PEERS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const SHARED_KEY = process.env.RACK_SHARED_KEY || '';
  const HEARTBEAT_MS = Number(process.env.RACK_HEARTBEAT_MS) || 500;
  const ELECTION_MIN_MS = Number(process.env.RACK_ELECTION_MS_MIN) || 1500;
  const ELECTION_MAX_MS = ELECTION_MIN_MS * 2;
  const STANDALONE = PEERS.length === 0;
  const CLUSTER_SIZE = PEERS.length + 1;
  const QUORUM = Math.floor(CLUSTER_SIZE / 2) + 1;

  if (!STANDALONE && !SHARED_KEY) {
    console.error('[Rack] RACK_PEERS definido sin RACK_SHARED_KEY: la malla queda deshabilitada');
  }

  /* ---------------- estado Raft ---------------- */

  let role = 'follower'; // follower | candidate | leader
  let currentTerm = 0;
  let votedFor = null;
  let leaderId = null;
  let commitIndex = 0;
  let lastApplied = 0;
  // log[0] = centinela; entradas: { index, term, key, value, actor, ts }
  let log = [{ index: 0, term: 0, key: null, value: null, actor: null, ts: null }];
  const kv = new Map(); // key -> { value, index, term, actor, updatedAt }
  const peerState = new Map(); // url -> { nextIndex, matchIndex, lastSeen, lastError }
  const commitWaiters = new Map(); // index -> [resolve]
  let electionTimer = null;
  let heartbeatTimer = null;
  let lastLeaderContact = Date.now();
  let partitionNotifiedAt = 0;
  let ready = false;

  const lastIndex = () => log[log.length - 1].index;
  const lastTerm = () => log[log.length - 1].term;
  const entryAt = (index) => log[index] && log[index].index === index ? log[index] : log.find((e) => e.index === index);

  async function persistMeta() {
    await mongo.collection('rack_raft').updateOne(
      { _id: 'meta' },
      { $set: { currentTerm, votedFor, lastApplied } },
      { upsert: true },
    );
  }

  async function boot() {
    const meta = await mongo.collection('rack_raft').findOne({ _id: 'meta' });
    if (meta) {
      currentTerm = meta.currentTerm || 0;
      votedFor = meta.votedFor || null;
      lastApplied = meta.lastApplied || 0;
    }
    const entries = await mongo.collection('rack_raft_log').find({}).sort({ _id: 1 }).toArray();
    for (const e of entries) log.push({ index: e._id, term: e.term, key: e.key, value: e.value, actor: e.actor, ts: e.ts });
    commitIndex = lastApplied; // conservador: lo aplicado estaba comprometido
    const applied = await mongo.collection('rack_state').find({}).toArray();
    for (const a of applied) kv.set(a._id, { value: a.value, index: a.index, term: a.term, actor: a.actor, updatedAt: a.updatedAt });
    for (const url of PEERS) peerState.set(url, { nextIndex: lastIndex() + 1, matchIndex: 0, lastSeen: 0, lastError: null });
    ready = true;
    if (STANDALONE) {
      becomeLeader(true);
    } else {
      resetElectionTimer();
    }
    console.log(`[Rack] ${RACK_ID} arrancado · modo ${STANDALONE ? 'standalone' : `cluster (${CLUSTER_SIZE} racks, quorum ${QUORUM})`} · term ${currentTerm} · log ${lastIndex()}`);
  }

  /* ---------------- aplicacion a la maquina de estados ---------------- */

  async function applyCommitted() {
    while (lastApplied < commitIndex) {
      const next = entryAt(lastApplied + 1);
      if (!next) break;
      lastApplied = next.index;
      const meta = { value: next.value, index: next.index, term: next.term, actor: next.actor, updatedAt: new Date().toISOString() };
      kv.set(next.key, meta);
      await mongo.collection('rack_state').updateOne({ _id: next.key }, { $set: meta }, { upsert: true });
      await persistMeta();
      await appendRackLog(mongo, { action: 'state.apply', actorId: next.actor || 'raft', detail: { key: next.key, value: next.value, index: next.index, term: next.term } });
      if (next.key.startsWith('security.')) {
        busEmit({
          id: crypto.randomUUID(), ts: new Date().toISOString(),
          origin: 'RACK', dest: 'SENTINEL', type: 'rack_state', state: 'DONE',
          label: `Rack · estado de seguridad replicado: ${next.key} = ${JSON.stringify(next.value)}`,
          payload: { key: next.key, value: next.value, index: next.index }, user: next.actor || 'raft',
        });
      }
      const waiters = commitWaiters.get(next.index);
      if (waiters) {
        for (const resolve of waiters) resolve(next);
        commitWaiters.delete(next.index);
      }
    }
  }

  /* ---------------- transiciones de rol ---------------- */

  function resetElectionTimer() {
    if (electionTimer) clearTimeout(electionTimer);
    const timeout = ELECTION_MIN_MS + Math.random() * (ELECTION_MAX_MS - ELECTION_MIN_MS);
    electionTimer = setTimeout(() => startElection().catch(() => {}), timeout);
    electionTimer.unref?.();
  }

  function stepDown(newTerm, reason) {
    const wasLeader = role === 'leader';
    role = 'follower';
    if (newTerm > currentTerm) {
      currentTerm = newTerm;
      votedFor = null;
    }
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    persistMeta().catch(() => {});
    if (!STANDALONE) resetElectionTimer();
    if (wasLeader) {
      appendRackLog(mongo, { action: 'leader.stepdown', actorId: RACK_ID, detail: { term: currentTerm, reason } }).catch(() => {});
      console.log(`[Rack] ${RACK_ID} abdica: ${reason}`);
    }
  }

  function becomeLeader(silent = false) {
    role = 'leader';
    leaderId = RACK_ID;
    if (electionTimer) clearTimeout(electionTimer);
    for (const [url, s] of peerState) {
      s.nextIndex = lastIndex() + 1;
      s.matchIndex = 0;
      peerState.set(url, s);
    }
    if (!STANDALONE && !heartbeatTimer) {
      heartbeatTimer = setInterval(() => leaderTick().catch(() => {}), HEARTBEAT_MS);
      heartbeatTimer.unref?.();
    }
    if (!silent) {
      appendRackLog(mongo, { action: 'leader.elected', actorId: RACK_ID, detail: { term: currentTerm, clusterSize: CLUSTER_SIZE } }).catch(() => {});
      busEmit({
        id: crypto.randomUUID(), ts: new Date().toISOString(),
        origin: 'RACK', dest: 'SENTINEL', type: 'rack_leader', state: 'DONE',
        label: `Rack · ${RACK_ID} elegido lider (term ${currentTerm})`,
        payload: { rackId: RACK_ID, term: currentTerm }, user: 'raft',
      });
    }
    seedDefaults().catch(() => {});
  }

  async function seedDefaults() {
    for (const [key, value] of Object.entries(DEFAULT_STATE)) {
      if (value === null || kv.has(key)) continue;
      await propose(key, value, 'seed').catch(() => {});
    }
  }

  /* ---------------- RPC cliente ---------------- */

  async function rpc(url, path, body) {
    const payload = { ...body, ts: Date.now() };
    const res = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Rack-Sig': hmacOf(payload, SHARED_KEY) },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function startElection() {
    if (STANDALONE || role === 'leader' || !SHARED_KEY) return;
    role = 'candidate';
    currentTerm += 1;
    votedFor = RACK_ID;
    leaderId = null;
    await persistMeta();
    resetElectionTimer();
    const term = currentTerm;
    let votes = 1;
    await Promise.allSettled(PEERS.map(async (url) => {
      try {
        const resp = await rpc(url, '/api/rack/raft/request-vote', {
          term, candidateId: RACK_ID, lastLogIndex: lastIndex(), lastLogTerm: lastTerm(),
        });
        const s = peerState.get(url);
        s.lastSeen = Date.now();
        if (resp.term > currentTerm) return stepDown(resp.term, 'termino superior en votacion');
        if (resp.voteGranted && role === 'candidate' && currentTerm === term) {
          votes += 1;
          if (votes >= QUORUM) becomeLeader();
        }
      } catch (err) {
        const s = peerState.get(url);
        if (s) s.lastError = String(err?.message || err);
      }
    }));
  }

  async function leaderTick() {
    if (role !== 'leader') return;
    await Promise.allSettled(PEERS.map(async (url) => {
      const s = peerState.get(url);
      const prevLogIndex = s.nextIndex - 1;
      const prev = entryAt(prevLogIndex) || log[0];
      const entries = log.filter((e) => e.index >= s.nextIndex).slice(0, 50);
      try {
        const resp = await rpc(url, '/api/rack/raft/append-entries', {
          term: currentTerm, leaderId: RACK_ID,
          prevLogIndex, prevLogTerm: prev.term,
          entries, leaderCommit: commitIndex,
        });
        s.lastSeen = Date.now();
        s.lastError = null;
        if (resp.term > currentTerm) return stepDown(resp.term, 'termino superior en heartbeat');
        if (resp.success) {
          s.matchIndex = resp.matchIndex;
          s.nextIndex = resp.matchIndex + 1;
        } else {
          s.nextIndex = Math.max(1, s.nextIndex - 1);
        }
      } catch (err) {
        s.lastError = String(err?.message || err);
      }
    }));
    // commit por mayoria (solo entradas del termino actual, regla Raft)
    const matches = [lastIndex(), ...PEERS.map((u) => peerState.get(u).matchIndex)].sort((a, b) => b - a);
    const majorityIndex = matches[QUORUM - 1];
    if (majorityIndex > commitIndex && entryAt(majorityIndex)?.term === currentTerm) {
      commitIndex = majorityIndex;
      await applyCommitted();
    }
    // exclusion mutua distribuida: lider sin quorum abdica (no comete nada mas)
    const reachable = 1 + PEERS.filter((u) => Date.now() - peerState.get(u).lastSeen < ELECTION_MAX_MS * 2).length;
    if (reachable < QUORUM) {
      stepDown(currentTerm, 'particion detectada: sin quorum');
      if (Date.now() - partitionNotifiedAt > 5 * 60 * 1000) {
        partitionNotifiedAt = Date.now();
        adminNotify({
          origin: 'RACK', severity: 'error',
          label: `Rack ${RACK_ID} aislado de la malla`,
          detail: `solo ${reachable}/${CLUSTER_SIZE} racks visibles: escrituras bloqueadas, sirviendo ultimo estado comprometido (Offline-First)`,
        });
      }
    }
  }

  /* ---------------- propuesta (solo lider) ---------------- */

  async function propose(key, value, actor) {
    if (!ready) throw Object.assign(new Error('rack arrancando'), { status: 503 });
    if (role !== 'leader') {
      throw Object.assign(new Error(`este rack no es lider (lider actual: ${leaderId || 'desconocido'})`), { status: 409, leaderId });
    }
    const entry = { index: lastIndex() + 1, term: currentTerm, key, value, actor, ts: new Date().toISOString() };
    log.push(entry);
    await mongo.collection('rack_raft_log').updateOne(
      { _id: entry.index },
      { $set: { term: entry.term, key, value, actor, ts: entry.ts } },
      { upsert: true },
    );
    if (STANDALONE) {
      commitIndex = entry.index;
      await applyCommitted();
      return { entry, committed: true };
    }
    const committed = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), PROPOSE_COMMIT_TIMEOUT_MS);
      const list = commitWaiters.get(entry.index) || [];
      list.push(() => { clearTimeout(timer); resolve(true); });
      commitWaiters.set(entry.index, list);
      leaderTick().catch(() => {});
    });
    return { entry, committed };
  }

  /* ---------------- RPC servidor (malla inter-rack, sin sesion) ---------------- */

  function verifyPeer(req, res, next) {
    if (!SHARED_KEY) return res.status(403).json({ error: 'malla inter-rack deshabilitada (sin RACK_SHARED_KEY)' });
    const body = req.body || {};
    if (!Number.isFinite(body.ts) || Math.abs(Date.now() - body.ts) > PEER_TS_WINDOW_MS) {
      return res.status(400).json({ error: 'ts fuera de ventana' });
    }
    const sig = String(req.headers['x-rack-sig'] || '');
    const expected = hmacOf(body, SHARED_KEY);
    const a = Buffer.from(sig, 'utf8');
    const e = Buffer.from(expected, 'utf8');
    if (a.length !== e.length || !crypto.timingSafeEqual(a, e)) {
      return res.status(401).json({ error: 'firma inter-rack invalida' });
    }
    next();
  }

  app.post('/api/rack/raft/request-vote', verifyPeer, (req, res) => {
    const b = req.body;
    if (b.term > currentTerm) stepDown(b.term, 'termino superior (request-vote)');
    let voteGranted = false;
    if (b.term >= currentTerm && (votedFor === null || votedFor === b.candidateId)) {
      const upToDate = b.lastLogTerm > lastTerm() || (b.lastLogTerm === lastTerm() && b.lastLogIndex >= lastIndex());
      if (upToDate) {
        voteGranted = true;
        votedFor = b.candidateId;
        lastLeaderContact = Date.now();
        resetElectionTimer();
        persistMeta().catch(() => {});
      }
    }
    res.json({ term: currentTerm, voteGranted });
  });

  app.post('/api/rack/raft/append-entries', verifyPeer, (req, res) => {
    const b = req.body;
    if (b.term < currentTerm) return res.json({ term: currentTerm, success: false, matchIndex: 0 });
    if (b.term > currentTerm || role !== 'follower') stepDown(b.term, 'lider legitimo presente');
    leaderId = b.leaderId;
    lastLeaderContact = Date.now();
    resetElectionTimer();

    const prev = entryAt(b.prevLogIndex);
    if (b.prevLogIndex > 0 && (!prev || prev.term !== b.prevLogTerm)) {
      return res.json({ term: currentTerm, success: false, matchIndex: 0 });
    }
    (async () => {
      for (const e of b.entries || []) {
        const existing = entryAt(e.index);
        if (existing && existing.term !== e.term) {
          // conflicto: truncar desde aqui (regla Raft)
          log = log.filter((x) => x.index < e.index);
          await mongo.collection('rack_raft_log').deleteMany({ _id: { $gte: e.index } });
        }
        if (!entryAt(e.index)) {
          log.push(e);
          await mongo.collection('rack_raft_log').updateOne(
            { _id: e.index },
            { $set: { term: e.term, key: e.key, value: e.value, actor: e.actor, ts: e.ts } },
            { upsert: true },
          );
        }
      }
      const newMatch = b.prevLogIndex + (b.entries?.length || 0);
      if (b.leaderCommit > commitIndex) {
        commitIndex = Math.min(b.leaderCommit, lastIndex());
        await applyCommitted();
      }
      res.json({ term: currentTerm, success: true, matchIndex: newMatch });
    })().catch((err) => {
      if (!res.headersSent) res.status(500).json({ error: String(err?.message || err) });
    });
  });

  /* ---------------- API de administracion (mesa sentinel) ---------------- */

  const guard = [auth, requireMesa('sentinel')];
  const h = (fn) => (req, res) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      console.error('[Rack] route error:', err?.message || err);
      if (!res.headersSent) res.status(err?.status || 500).json({ error: String(err?.message || err), leaderId: err?.leaderId });
    });
  };

  app.get('/api/rack/status', ...guard, (req, res) => {
    res.json({
      rackId: RACK_ID,
      mode: STANDALONE ? 'standalone' : 'cluster',
      role,
      term: currentTerm,
      leaderId,
      clusterSize: CLUSTER_SIZE,
      quorum: QUORUM,
      commitIndex,
      lastApplied,
      logLength: lastIndex(),
      peers: PEERS.map((url) => {
        const s = peerState.get(url);
        return {
          url,
          reachable: s.lastSeen > 0 && Date.now() - s.lastSeen < ELECTION_MAX_MS * 2,
          lastSeen: s.lastSeen ? new Date(s.lastSeen).toISOString() : null,
          matchIndex: s.matchIndex,
          lastError: s.lastError,
        };
      }),
      doctrine: 'sin quorum: escrituras bloqueadas, lecturas del ultimo estado comprometido (Offline-First)',
    });
  });

  app.get('/api/rack/state', ...guard, (req, res) => {
    const out = {};
    for (const [key, meta] of kv) out[key] = meta;
    res.json({ rackId: RACK_ID, role, commitIndex, state: out });
  });

  app.post('/api/rack/state', ...guard, cibe.guard('rack.command'), h(async (req, res) => {
    const key = String(req.body?.key || '').trim();
    if (!KEY_RE.test(key)) return res.status(400).json({ error: 'key invalida (^[a-z0-9_.:-]{2,80}$)' });
    const value = req.body?.value;
    if (value === undefined) return res.status(400).json({ error: 'value requerido' });
    if (Buffer.byteLength(JSON.stringify(value)) > MAX_VALUE_BYTES) return res.status(400).json({ error: `value supera ${MAX_VALUE_BYTES} bytes` });
    const { entry, committed } = await propose(key, value, req.user);
    res.status(committed ? 200 : 202).json({
      key, value, index: entry.index, term: entry.term, committed,
      note: committed ? 'replicado y aplicado' : 'aceptado, pendiente de mayoria (se aplicara al alcanzar quorum)',
    });
  }));

  app.get('/api/rack/log', ...guard, h(async (req, res) => {
    const rows = await mongo.collection('rack_log').find({}).sort({ seq: -1 }).limit(50).toArray();
    res.json(rows.map(({ _id, ...r }) => ({ id: _id, ...r })));
  }));

  app.get('/api/rack/log/verify', ...guard, h(async (req, res) => {
    const all = await mongo.collection('rack_log').find({}).sort({ seq: 1 }).toArray();
    let prev = '0'.repeat(64);
    for (const entry of all) {
      const { _id, seq, prevHash, hash, createdAt, ...rest } = entry;
      const expected = crypto.createHash('sha256').update(prev + canonical({ ...rest, seq })).digest('hex');
      if (expected !== hash || prevHash !== prev) {
        return res.json({ valid: false, totalEntries: all.length, brokenAtSeq: seq });
      }
      prev = hash;
    }
    res.json({ valid: true, totalEntries: all.length, brokenAtSeq: null });
  }));

  /* ---------------- arranque + getter para otros modulos ---------------- */

  boot().catch((err) => console.error('[Rack] Error de arranque:', err.message));

  return {
    get: (key) => kv.get(key)?.value,
    status: () => ({ rackId: RACK_ID, role, term: currentTerm, leaderId, commitIndex }),
  };
}
