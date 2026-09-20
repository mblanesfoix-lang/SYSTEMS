/**
 * ELVI-RA · Central — IA de acción de S-NFI (Volumen 2)
 *
 * Chat conocedor de todo el sistema (CRM Rëff, sesiones, U2, nodos Systems)
 * + acciones operativas bajo consentimiento humano explícito.
 *
 * Doctrina (Regla de Oro, inmutable):
 *   El ser humano autoriza. El ser humano supervisa. El sistema ejecuta.
 *   - El LLM solo PROPONE acciones. Nunca ejecuta.
 *   - Toda decisión (confirmar/rechazar) y ejecución queda en un log
 *     append-only con cadena de hashes (central_action_log).
 *
 * Puerto Systems (contrato para el OPHS/Systems real del jefe):
 *   - Si SYSTEMS_URL está definida, las acciones confirmadas se reenvían a
 *       POST {SYSTEMS_URL}/api/v1/actions
 *       body: { id, type, nodeId, params, requestedBy, authorizedAt }
 *       respuesta esperada: { ok: boolean, result?: object, error?: string }
 *   - Sin SYSTEMS_URL, ejecuta contra el mock local (colección systems_nodes).
 *   - Estado de nodos en vivo: GET /api/ophs/nodes (mismo shape que deberá
 *     exponer el Systems real; ver GET /api/ophs/contract).
 */

import crypto from 'crypto';

const ACTION_TYPES = {
  'node.shutdown': { params: [], describe: (n) => `Apagar ${n}` },
  'node.start': { params: [], describe: (n) => `Arrancar ${n}` },
  'node.restart': { params: [], describe: (n) => `Reiniciar ${n}` },
  'node.set_target_temp': { params: ['temp_c'], describe: (n, p) => `Fijar temperatura objetivo de ${n} en ${p.temp_c}°C` },
};

const ACTION_TTL_MS = 10 * 60 * 1000; // propuesta caduca a los 10 min sin confirmar

const SEED_NODES = [
  { _id: 'BCN-1233', name: 'Nodo Barcelona 1.233', city: 'Barcelona', country: 'ES', lat: 41.3874, lng: 2.1686, model: 'BioHybrid L', status: 'online', temp_c: 120, target_temp_c: 150, throughput_kg_h: 420, bss_charge_pct: 87, pellet_stock_t: 12.4 },
  { _id: 'PMP-0021', name: 'Nodo Pamplona 21', city: 'Pamplona', country: 'ES', lat: 42.8125, lng: -1.6458, model: 'BioHybrid M', status: 'online', temp_c: 149, target_temp_c: 150, throughput_kg_h: 310, bss_charge_pct: 93, pellet_stock_t: 8.1 },
  { _id: 'ZGZ-0104', name: 'Nodo Zaragoza 104', city: 'Zaragoza', country: 'ES', lat: 41.6488, lng: -0.8891, model: 'BioHybrid M', status: 'online', temp_c: 151, target_temp_c: 150, throughput_kg_h: 295, bss_charge_pct: 78, pellet_stock_t: 6.7 },
  { _id: 'VLC-0310', name: 'Nodo Valencia 310', city: 'Valencia', country: 'ES', lat: 39.4699, lng: -0.3763, model: 'BioHybrid S', status: 'maintenance', temp_c: 22, target_temp_c: 150, throughput_kg_h: 0, bss_charge_pct: 41, pellet_stock_t: 2.3 },
  { _id: 'TLS-0077', name: 'Nodo Toulouse 77', city: 'Toulouse', country: 'FR', lat: 43.6047, lng: 1.4442, model: 'BioHybrid M', status: 'offline', temp_c: 18, target_temp_c: 150, throughput_kg_h: 0, bss_charge_pct: 12, pellet_stock_t: 0.9 },
];

const OPHS_CONTRACT = {
  version: '1.0',
  description: 'Contrato que debe implementar el Systems/OPHS real. Elvi-Ra consume estos endpoints; mientras no exista, este backend sirve un mock equivalente.',
  transport: 'REST sobre endpoint privado en puerto cerrado (doctrina soberanía). WS opcional para push.',
  auth: 'Bearer token de servicio via env SYSTEMS_TOKEN (cabecera Authorization).',
  endpoints: [
    { method: 'GET', path: '/api/v1/nodes', returns: '{ nodes: [{ id, name, city, country, lat, lng, model, status: online|offline|maintenance|restarting, temp_c, target_temp_c, throughput_kg_h, bss_charge_pct, pellet_stock_t, updated_at }] }' },
    { method: 'GET', path: '/api/v1/nodes/:id', returns: 'nodo individual, mismo shape' },
    { method: 'POST', path: '/api/v1/actions', body: '{ id, type, nodeId, params, requestedBy, authorizedAt }', returns: '{ ok, result?, error? }', note: 'type ∈ ' + Object.keys(ACTION_TYPES).join(', ') },
  ],
};

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

export function mountElviraCentral(app, deps) {
  const {
    auth, requireMesa, mongo, getMongoClient,
    callLLM, trackTokens, busEmit, adminNotify,
    readElvira, getU2Snapshot, cibe, llmLimiter,
  } = deps;
  // limiter especifico en /chat (llama callLLM() en cada mensaje) — ver
  // definicion en server.js, keyGenerator por usuario no por IP.
  const chatGuard = llmLimiter ? [auth, llmLimiter] : [auth];
  // firma CIBE del bunker Pactvm Viridi en endpoints criticos OPHS
  const cibeGuard = (scope) => (cibe ? cibe.guard(scope) : (_req, _res, next) => next());

  const nodesCol = () => mongo.collection('systems_nodes');
  const actionsCol = () => mongo.collection('central_actions');
  const logCol = () => mongo.collection('central_action_log');
  const chatsCol = () => mongo.collection('central_chats');

  /* ---------- mock Systems: seed + deriva simulada ---------- */

  (async function ensureNodes() {
    try {
      const count = await nodesCol().countDocuments();
      if (count === 0) {
        await nodesCol().insertMany(SEED_NODES.map(n => ({ ...n, updated_at: new Date().toISOString() })));
        console.log('[Central] systems_nodes seed insertado (mock Systems)');
      }
    } catch (e) {
      console.error('[Central] seed nodos falló:', e.message);
    }
  })();

  // Deriva: los nodos online respiran (temp hacia objetivo ± ruido, BSS y caudal oscilan)
  setInterval(async () => {
    try {
      const nodes = await nodesCol().find({ status: { $in: ['online', 'restarting'] } }).toArray();
      for (const n of nodes) {
        const drift = (n.target_temp_c - n.temp_c) * 0.15 + (Math.random() - 0.5) * 3;
        const temp = Math.round((n.temp_c + drift) * 10) / 10;
        const bss = Math.min(100, Math.max(0, n.bss_charge_pct + (Math.random() - 0.48) * 2));
        const thr = n.status === 'online' ? Math.max(0, n.throughput_kg_h + (Math.random() - 0.5) * 14) : 0;
        const $set = {
          temp_c: temp,
          bss_charge_pct: Math.round(bss * 10) / 10,
          throughput_kg_h: Math.round(thr),
          updated_at: new Date().toISOString(),
        };
        if (n.status === 'restarting') $set.status = 'online';
        await nodesCol().updateOne({ _id: n._id }, { $set });
      }
    } catch { /* deriva es cosmética, no crítica */ }
  }, 20000);

  /* ---------- log inmutable con cadena de hashes ---------- */

  async function appendActionLog({ user, actionId, type, nodeId, params, decision, result }) {
    const last = await logCol().find().sort({ seq: -1 }).limit(1).next();
    const seq = (last?.seq || 0) + 1;
    const prevHash = last?.hash || 'GENESIS';
    const core = { seq, ts: new Date().toISOString(), user, actionId, type, nodeId, params, decision, result };
    const hash = sha256(prevHash + JSON.stringify(core));
    await logCol().insertOne({ ...core, prev_hash: prevHash, hash });
    return { seq, hash };
  }

  /* ---------- ejecutor: Systems real si hay SYSTEMS_URL, mock si no ---------- */

  async function executeAction(action, requestedBy) {
    const systemsUrl = process.env.SYSTEMS_URL;
    if (systemsUrl) {
      // FASE 5 (2026-09-20): sin timeout, un Systems real colgado dejaba este
      // fetch esperando para siempre — el humano ya autorizo la accion (Regla
      // de Oro), pero la peticion HTTP que la ejecuta se quedaria bloqueada
      // sin fin ni de exito ni de error. Mismo AbortController que llm.js.
      const controller = new AbortController();
      const timeoutMs = Number(process.env.SYSTEMS_TIMEOUT_MS) || 15000;
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      let r;
      try {
        r = await fetch(`${systemsUrl.replace(/\/$/, '')}/api/v1/actions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(process.env.SYSTEMS_TOKEN ? { authorization: `Bearer ${process.env.SYSTEMS_TOKEN}` } : {}),
          },
          body: JSON.stringify({
            id: action._id, type: action.type, nodeId: action.nodeId,
            params: action.params, requestedBy, authorizedAt: new Date().toISOString(),
          }),
          signal: controller.signal,
        });
      } catch (err) {
        if (err?.name === 'AbortError') throw new Error(`Systems (${systemsUrl}) timeout tras ${timeoutMs}ms — accion sin confirmar, revisar estado del nodo manualmente`);
        throw err;
      } finally {
        clearTimeout(timeout);
      }
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) throw new Error(data.error || `Systems respondió HTTP ${r.status}`);
      return { via: 'systems', ...data.result };
    }

    // Mock local
    const node = await nodesCol().findOne({ _id: action.nodeId });
    if (!node) throw new Error(`Nodo ${action.nodeId} no existe`);
    const now = new Date().toISOString();
    switch (action.type) {
      case 'node.shutdown':
        await nodesCol().updateOne({ _id: node._id }, { $set: { status: 'offline', throughput_kg_h: 0, temp_c: 20, updated_at: now } });
        return { via: 'mock', nodeId: node._id, status: 'offline' };
      case 'node.start':
        await nodesCol().updateOne({ _id: node._id }, { $set: { status: 'online', updated_at: now } });
        return { via: 'mock', nodeId: node._id, status: 'online' };
      case 'node.restart':
        await nodesCol().updateOne({ _id: node._id }, { $set: { status: 'restarting', throughput_kg_h: 0, updated_at: now } });
        return { via: 'mock', nodeId: node._id, status: 'restarting' };
      case 'node.set_target_temp': {
        const t = Number(action.params?.temp_c);
        if (!Number.isFinite(t) || t < 0 || t > 400) throw new Error('temp_c fuera de rango (0-400)');
        await nodesCol().updateOne({ _id: node._id }, { $set: { target_temp_c: t, updated_at: now } });
        return { via: 'mock', nodeId: node._id, target_temp_c: t };
      }
      default:
        throw new Error(`Tipo de acción desconocido: ${action.type}`);
    }
  }

  /* ---------- contexto vivo para el chat ---------- */

  async function gatherContext() {
    const ctx = { generado: new Date().toISOString() };

    // CRM Rëff (db 'reff' compartida)
    try {
      const reff = getMongoClient().db('reff');
      const users = await reff.collection('users').find({}, { projection: { username: 1, display_name: 1 } }).toArray();
      const sheets = await reff.collection('sheets').find({}, { projection: { user_id: 1, name: 1 } }).toArray();
      const companies = await reff.collection('companies').find({}, { projection: { sheet_id: 1, name: 1, status: 1, city: 1, country: 1 } }).toArray();
      const sheetOwner = new Map(sheets.map(s => [s._id, s.user_id]));
      const byUser = {};
      for (const u of users) byUser[u._id ?? u.username] = { usuario: u.display_name || u.username, hojas: 0, empresas: 0, por_estado: {}, empresas_lista: [] };
      for (const s of sheets) {
        const k = s.user_id;
        if (byUser[k]) byUser[k].hojas += 1;
      }
      for (const c of companies) {
        const k = sheetOwner.get(c.sheet_id);
        const u = byUser[k];
        if (!u) continue;
        u.empresas += 1;
        u.por_estado[c.status] = (u.por_estado[c.status] || 0) + 1;
        if (u.empresas_lista.length < 60) u.empresas_lista.push(`${c.name} (${c.city}, ${c.status})`);
      }
      ctx.crm_reff = { total_empresas: companies.length, total_hojas: sheets.length, por_usuario: Object.values(byUser) };
      ctx.vigilancia = {
        empresas_vigiladas: await reff.collection('watch_companies').countDocuments({}),
        ultimas_noticias: (await reff.collection('watch_news').find().sort({ detected_at: -1 }).limit(5).toArray())
          .map(n => n.headline),
      };
      ctx.herzog_auditorias = await reff.collection('herzog_audits').countDocuments({});
    } catch (e) {
      ctx.crm_reff = { error: 'no disponible: ' + e.message };
    }

    // Sesiones activas (Sentinel básico)
    try {
      const active = await mongo.collection('sessions').find({ exp: { $gt: new Date() } }).project({ user: 1 }).toArray();
      ctx.sesiones = { activas: active.length, usuarios: [...new Set(active.map(s => s.user))] };
    } catch { ctx.sesiones = null; }

    // Estado Elvi-Ra (systems bridges + tcontroler)
    try {
      const state = readElvira();
      ctx.puentes = Object.fromEntries(Object.entries(state.systems || {}).map(([k, v]) => [k, v.status || v]));
      const tc = state.systems?.tcontroler;
      if (tc) ctx.tcontroler = { tokens_usados: tc.tokensUsed || 0, usuarios: Object.keys(tc.byUser || {}).length };
    } catch { /* opcional */ }

    // Nodos Systems (mock o espejo del real)
    try {
      ctx.nodos_systems = (await nodesCol().find().toArray()).map(n => ({
        id: n._id, nombre: n.name, ciudad: n.city, estado: n.status,
        temp_c: n.temp_c, temp_objetivo_c: n.target_temp_c,
        caudal_kg_h: n.throughput_kg_h, bss_pct: n.bss_charge_pct,
      }));
    } catch { ctx.nodos_systems = []; }

    // U2 — energía desperdiciada ahora
    try {
      const u2 = getU2Snapshot ? getU2Snapshot() : null;
      if (u2) ctx.u2 = u2;
    } catch { /* opcional */ }

    return ctx;
  }

  function buildSystemPrompt(ctx) {
    return `Eres ELVI-RA Central, la IA de acción de S-NFI Corp. (South-Navarre Fresh Innovations).
Systems es el programa madre (fuente de verdad). Rëff es el cerebro de datos. Tú eres la palanca de acción: solo actúas con consentimiento humano explícito.

DOCTRINA INMUTABLE: el ser humano autoriza, el ser humano supervisa, el sistema ejecuta. Jamás ejecutes nada por tu cuenta. Jamás te saltes OPHS ni Pactvm Viridi.

CONTEXTO VIVO DEL SISTEMA (única fuente de verdad para responder; no inventes datos):
${JSON.stringify(ctx, null, 1)}

REGLAS DE RESPUESTA:
1. Responde en español, conciso y técnico. Si el dato no está en el contexto, di que no está disponible.
2. Consultas (ej. "cuántas empresas tiene Amir en su CRM") → responde directamente con los datos del contexto.
3. Si el humano ORDENA una acción operativa sobre un nodo (apagar, arrancar, reiniciar, cambiar temperatura objetivo), NO la ejecutes: propón la acción emitiendo EXACTAMENTE un bloque con este formato al final de tu respuesta:
<<ACTION>>
{"type":"node.shutdown","nodeId":"BCN-1233","params":{},"summary":"Apagar Nodo Barcelona 1.233"}
<<END_ACTION>>
   Tipos permitidos: ${Object.keys(ACTION_TYPES).join(', ')}. node.set_target_temp requiere params {"temp_c": número}.
   El nodeId debe existir en nodos_systems. En el texto previo al bloque, resume la acción y pide confirmación explícita.
4. Si la orden es ambigua o el nodo no existe, pide aclaración sin emitir bloque de acción.
5. Nunca emitas más de un bloque de acción por respuesta.`;
  }

  function parseAction(text) {
    const m = text.match(/<<ACTION>>([\s\S]*?)<<END_ACTION>>/);
    if (!m) return { reply: text.trim(), action: null };
    const reply = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim();
    try {
      const raw = JSON.parse(m[1].trim());
      if (!ACTION_TYPES[raw.type]) return { reply, action: null };
      return {
        reply,
        action: {
          type: raw.type,
          nodeId: String(raw.nodeId || ''),
          params: raw.params && typeof raw.params === 'object' ? raw.params : {},
          summary: String(raw.summary || ACTION_TYPES[raw.type].describe(raw.nodeId, raw.params || {})),
        },
      };
    } catch {
      return { reply, action: null };
    }
  }

  /* ---------- rutas Central (heredan auth+requireMesa('elvira') del guard /api/elvira) ---------- */

  app.get('/api/elvira/central/history', auth, async (req, res) => {
    const doc = await chatsCol().findOne({ _id: req.user });
    res.json({ messages: doc?.messages || [] });
  });

  app.delete('/api/elvira/central/history', auth, async (req, res) => {
    await chatsCol().deleteOne({ _id: req.user });
    res.json({ ok: true });
  });

  app.get('/api/elvira/central/nodes', auth, async (_req, res) => {
    const nodes = await nodesCol().find().toArray();
    res.json({ nodes });
  });

  app.post('/api/elvira/central/chat', ...chatGuard, async (req, res) => {
    const message = String(req.body?.message || '').trim();
    if (!message) return res.status(400).json({ error: 'message requerido' });
    if (message.length > 4000) return res.status(400).json({ error: 'Mensaje demasiado largo (max 4000)' });

    try {
      const ctx = await gatherContext();
      const doc = await chatsCol().findOne({ _id: req.user });
      const history = (doc?.messages || []).slice(-12);
      const convo = history.map(m => `${m.role === 'user' ? 'HUMANO' : 'ELVI-RA'}: ${m.text}`).join('\n');
      const userPrompt = `${convo ? `CONVERSACIÓN PREVIA:\n${convo}\n\n` : ''}HUMANO: ${message}`;

      const result = await callLLM(buildSystemPrompt(ctx), userPrompt, 1500);
      trackTokens(req.user, 'central-chat', result.inputTokens, result.outputTokens);

      const { reply, action } = parseAction(result.text);
      let pendingAction = null;

      if (action) {
        const node = await nodesCol().findOne({ _id: action.nodeId });
        if (node) {
          const id = crypto.randomUUID();
          const now = Date.now();
          pendingAction = {
            _id: id, user: req.user, type: action.type, nodeId: action.nodeId,
            nodeName: node.name, params: action.params, summary: action.summary,
            status: 'PENDING', created_at: new Date(now).toISOString(),
            expires_at: new Date(now + ACTION_TTL_MS).toISOString(),
          };
          await actionsCol().insertOne(pendingAction);
          busEmit({
            id: crypto.randomUUID(), ts: new Date().toISOString(),
            origin: 'ELVI-RA', dest: 'SYSTEMS', type: 'request', state: 'PENDING',
            label: `PROPUESTA · ${action.summary}`, payload: { actionId: id, type: action.type, nodeId: action.nodeId },
            user: req.user,
          });
        }
      }

      const ts = new Date().toISOString();
      const newMessages = [
        { role: 'user', text: message, ts },
        { role: 'assistant', text: reply, ts, ...(pendingAction ? { actionId: pendingAction._id } : {}) },
      ];
      await chatsCol().updateOne(
        { _id: req.user },
        { $push: { messages: { $each: newMessages, $slice: -200 } } },
        { upsert: true },
      );

      res.json({
        reply,
        action: pendingAction ? {
          id: pendingAction._id, type: pendingAction.type, nodeId: pendingAction.nodeId,
          nodeName: pendingAction.nodeName, params: pendingAction.params,
          summary: pendingAction.summary, expiresAt: pendingAction.expires_at,
        } : null,
      });
    } catch (ex) {
      adminNotify({ origin: 'ELVI-RA', label: 'Central chat · fallo', detail: ex.message, severity: 'error' });
      res.status(500).json({ error: ex.message || 'Error en Central' });
    }
  });

  app.post('/api/elvira/central/actions/:id/confirm', auth, async (req, res) => {
    const action = await actionsCol().findOne({ _id: String(req.params.id) });
    if (!action) return res.status(404).json({ error: 'Acción no encontrada' });
    if (action.user !== req.user) return res.status(403).json({ error: 'Solo quien propuso la acción puede autorizarla' });
    if (action.status !== 'PENDING') return res.status(409).json({ error: `Acción ya resuelta (${action.status})` });
    if (new Date(action.expires_at).getTime() < Date.now()) {
      await actionsCol().updateOne({ _id: action._id }, { $set: { status: 'EXPIRED' } });
      return res.status(410).json({ error: 'La propuesta caducó. Vuelve a ordenarla en el chat.' });
    }

    try {
      const result = await executeAction(action, req.user);
      await actionsCol().updateOne({ _id: action._id }, { $set: { status: 'EXECUTED', executed_at: new Date().toISOString() } });
      const log = await appendActionLog({
        user: req.user, actionId: action._id, type: action.type, nodeId: action.nodeId,
        params: action.params, decision: 'CONFIRMED', result,
      });
      busEmit({
        id: crypto.randomUUID(), ts: new Date().toISOString(),
        origin: 'ELVI-RA', dest: 'SYSTEMS', type: 'request', state: 'COMPLETED',
        label: `EJECUTADA · ${action.summary}`, payload: { actionId: action._id, result, logSeq: log.seq }, user: req.user,
      });
      adminNotify({ origin: 'ELVI-RA', label: `Acción ejecutada · ${action.summary}`, detail: `Autorizada por ${req.user} · log #${log.seq}`, severity: 'info' });

      const confirmMsg = { role: 'assistant', text: `Acción ejecutada: ${action.summary}. Registro inmutable #${log.seq} (${log.hash.slice(0, 12)}…).`, ts: new Date().toISOString() };
      await chatsCol().updateOne({ _id: req.user }, { $push: { messages: { $each: [confirmMsg], $slice: -200 } } }, { upsert: true });

      res.json({ ok: true, result, log, message: confirmMsg.text });
    } catch (ex) {
      await actionsCol().updateOne({ _id: action._id }, { $set: { status: 'FAILED', error: ex.message } });
      await appendActionLog({
        user: req.user, actionId: action._id, type: action.type, nodeId: action.nodeId,
        params: action.params, decision: 'CONFIRMED', result: { error: ex.message },
      });
      res.status(502).json({ error: `Ejecución falló: ${ex.message}` });
    }
  });

  app.post('/api/elvira/central/actions/:id/reject', auth, async (req, res) => {
    const action = await actionsCol().findOne({ _id: String(req.params.id) });
    if (!action) return res.status(404).json({ error: 'Acción no encontrada' });
    if (action.user !== req.user) return res.status(403).json({ error: 'Solo quien propuso la acción puede rechazarla' });
    if (action.status !== 'PENDING') return res.status(409).json({ error: `Acción ya resuelta (${action.status})` });

    await actionsCol().updateOne({ _id: action._id }, { $set: { status: 'REJECTED', rejected_at: new Date().toISOString() } });
    const log = await appendActionLog({
      user: req.user, actionId: action._id, type: action.type, nodeId: action.nodeId,
      params: action.params, decision: 'REJECTED', result: null,
    });
    busEmit({
      id: crypto.randomUUID(), ts: new Date().toISOString(),
      origin: 'ELVI-RA', dest: 'SYSTEMS', type: 'request', state: 'BLOCKED',
      label: `RECHAZADA · ${action.summary}`, payload: { actionId: action._id, logSeq: log.seq }, user: req.user,
    });
    res.json({ ok: true, log });
  });

  app.get('/api/elvira/central/actions', auth, async (req, res) => {
    const log = await logCol().find().sort({ seq: -1 }).limit(50).toArray();
    const pending = await actionsCol().find({ user: req.user, status: 'PENDING' }).toArray();
    res.json({ log, pending });
  });

  /* ---------- OPHS · mock del puerto Systems (globo T5 consume esto) ---------- */

  app.use('/api/ophs', auth, requireMesa('elvira'));

  app.get('/api/ophs/nodes', async (_req, res) => {
    const nodes = await nodesCol().find().toArray();
    res.json({
      nodes: nodes.map(n => ({
        id: n._id, name: n.name, city: n.city, country: n.country,
        lat: n.lat, lng: n.lng, model: n.model, status: n.status,
        temp_c: n.temp_c, target_temp_c: n.target_temp_c,
        throughput_kg_h: n.throughput_kg_h, bss_charge_pct: n.bss_charge_pct,
        pellet_stock_t: n.pellet_stock_t, updated_at: n.updated_at,
      })),
      source: process.env.SYSTEMS_URL ? 'systems' : 'mock',
    });
  });

  app.get('/api/ophs/nodes/:id', async (req, res) => {
    const n = await nodesCol().findOne({ _id: String(req.params.id) });
    if (!n) return res.status(404).json({ error: 'Nodo no encontrado' });
    res.json({ node: n });
  });

  // Edición directa admin del mock (calibración/test). No pasa por el flujo
  // LLM propone -> humano confirma: quien llama este endpoint YA es el humano
  // autorizando directamente. Queda igualmente en el log inmutable.
  const EDITABLE_NODE_FIELDS = {
    status: (v) => ['online', 'offline', 'maintenance', 'restarting'].includes(v),
    temp_c: (v) => Number.isFinite(v) && v >= 0 && v <= 400,
    target_temp_c: (v) => Number.isFinite(v) && v >= 0 && v <= 400,
    throughput_kg_h: (v) => Number.isFinite(v) && v >= 0,
    bss_charge_pct: (v) => Number.isFinite(v) && v >= 0 && v <= 100,
    pellet_stock_t: (v) => Number.isFinite(v) && v >= 0,
  };

  app.patch('/api/ophs/nodes/:id', cibeGuard('ophs.command'), async (req, res) => {
    if (req.role !== 'admin') return res.status(403).json({ error: 'admin requerido' });
    const node = await nodesCol().findOne({ _id: String(req.params.id) });
    if (!node) return res.status(404).json({ error: 'Nodo no encontrado' });

    const $set = {};
    for (const [key, isValid] of Object.entries(EDITABLE_NODE_FIELDS)) {
      if (req.body[key] === undefined) continue;
      const v = key === 'status' ? req.body[key] : Number(req.body[key]);
      if (!isValid(v)) return res.status(400).json({ error: `${key} inválido` });
      $set[key] = v;
    }
    if (Object.keys($set).length === 0) return res.status(400).json({ error: 'sin campos válidos para editar' });
    $set.updated_at = new Date().toISOString();

    await nodesCol().updateOne({ _id: node._id }, { $set });
    await appendActionLog({
      user: req.user, actionId: crypto.randomUUID(), type: 'node.direct_edit',
      nodeId: node._id, params: $set, decision: 'DIRECT_ADMIN', result: { via: 'mock' },
    });
    const updated = await nodesCol().findOne({ _id: node._id });
    res.json({ node: updated });
  });

  app.get('/api/ophs/contract', (_req, res) => {
    res.json(OPHS_CONTRACT);
  });

  console.log('[Central] Mesa Elvi-Ra Central montada (chat + acciones + OPHS mock)');
}
