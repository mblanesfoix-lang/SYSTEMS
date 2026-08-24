/**
 * EVENT BUS · Bus de eventos central
 * Flujo: Emisor → POST /api/bus/emit → ring-buffer → SSE push → consumidores (panel Elvi-Ra, Sentinel)
 *
 * Estados de paquete:
 *   PENDING | ROUTING | VALIDATING | BLOCKED | APPROVED | COMPLETED
 *
 * busEvents/sseClients/busEmit/busEmitAlert son dependencia compartida: casi
 * todos los demas modulos de mesa (finance, foundry, rack-state, grid-interlink,
 * elvira-central, cnmc, u2-ree, ...) reciben busEmit/busEmitAlert por referencia
 * en su objeto de deps y los llaman como funciones simples. Por eso este modulo
 * crea el ring-buffer y las funciones aqui mismo y las devuelve al bootstrap
 * (server.js) para que las siga repartiendo tal cual al resto de mountX(...).
 */

import fs from 'node:fs';
import crypto from 'node:crypto';

export function mountBus(app, { auth, requireAdmin, atomicWriteJson, BUS_HISTORY_FILE, adminNotify }) {
  const MAX_BUS_EVENTS = 500;
  const MAX_BUS_HISTORY = 20000;
  const busEvents = [];
  const sseClients = new Set();

  /* Historial persistente del bus — consultable vía /api/bus/history */
  function appendBusHistory(event) {
    let history = [];
    try { history = JSON.parse(fs.readFileSync(BUS_HISTORY_FILE, 'utf8')); }
    catch { history = []; }
    if (!Array.isArray(history)) history = [];
    history.push(event);
    if (history.length > MAX_BUS_HISTORY) history = history.slice(history.length - MAX_BUS_HISTORY);
    atomicWriteJson(BUS_HISTORY_FILE, history);
  }
  function busEmit(event) {
    busEvents.unshift(event);
    if (busEvents.length > MAX_BUS_EVENTS) busEvents.length = MAX_BUS_EVENTS;
    // Historial persistente solo para movimientos reales: state_update es refresh
    // de un evento ya guardado (no acción nueva), no se duplica en disco.
    if (event._type !== 'state_update') appendBusHistory(event);
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of sseClients) {
      try { client.write(payload); } catch { sseClients.delete(client); }
    }
  }

  /* Emite un fallo al bus para que el panel Elvi-Ra lo muestre en rojo */
  function busEmitAlert({ origin = 'SYSTEM', dest = 'ELVI-RA', label, detail, user }) {
    busEmit({
      id: crypto.randomUUID(), ts: new Date().toISOString(), seq: busEvents.length + 1,
      origin, dest, type: 'alert', state: 'BLOCKED',
      label, payload: { error: detail }, user,
    });
    adminNotify({ origin, label, detail });
  }

  /* GET /api/bus/stream — SSE endpoint */
  app.get('/api/bus/stream', auth, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // nginx: disable buffering
    res.flushHeaders();

    // Send backlog (last 100 events so client shows history on connect)
    const backlog = busEvents.slice(0, 100).reverse();
    for (const ev of backlog) {
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    }

    sseClients.add(res);

    // Heartbeat every 25s to keep connection alive through proxies
    const hb = setInterval(() => {
      try { res.write(': heartbeat\n\n'); } catch { clearInterval(hb); sseClients.delete(res); }
    }, 25000);

    req.on('close', () => { clearInterval(hb); sseClients.delete(res); });
  });

  /* GET /api/bus/events — REST snapshot (último N eventos) */
  app.get('/api/bus/events', auth, (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 200), 1), MAX_BUS_EVENTS);
    res.json({ total: busEvents.length, events: busEvents.slice(0, limit) });
  });

  /* POST /api/bus/emit — cualquier módulo interno emite aquí */
  app.post('/api/bus/emit', auth, (req, res) => {
    const b = req.body || {};
    const allowed_origins  = ['ELVI-RA', 'REFF', 'OPHS', 'SENTINEL', 'HERZOG', 'TCONTROLER', 'SYSTEM'];
    const allowed_states   = ['PENDING', 'ROUTING', 'VALIDATING', 'BLOCKED', 'APPROVED', 'COMPLETED'];

    const origin  = allowed_origins.includes(String(b.origin  || '').toUpperCase()) ? String(b.origin).toUpperCase()  : 'SYSTEM';
    const dest    = String(b.dest    || 'BUS').toUpperCase();
    const state   = allowed_states.includes(String(b.state   || '').toUpperCase()) ? String(b.state).toUpperCase()   : 'PENDING';
    const type    = String(b.type    || 'event').toLowerCase();   // event | request | response | alert
    const payload = b.payload && typeof b.payload === 'object' ? b.payload : {};
    const label   = String(b.label   || '').slice(0, 140);

    const event = {
      id:        crypto.randomUUID(),
      ts:        new Date().toISOString(),
      seq:       busEvents.length + 1,
      origin,
      dest,
      type,
      state,
      label,
      payload,
      user:      req.user,
    };

    busEmit(event);
    res.status(201).json(event);
  });

  /* PATCH /api/bus/events/:id — actualizar estado de un evento existente */
  app.patch('/api/bus/events/:id', auth, (req, res) => {
    const ev = busEvents.find(e => e.id === req.params.id);
    if (!ev) return res.status(404).json({ error: 'evento no encontrado' });
    const allowed_states = ['PENDING','ROUTING','VALIDATING','BLOCKED','APPROVED','COMPLETED'];
    if (req.body.state && allowed_states.includes(String(req.body.state).toUpperCase())) {
      ev.state = String(req.body.state).toUpperCase();
      ev.updatedAt = new Date().toISOString();
    }
    if (req.body.label) ev.label = String(req.body.label).slice(0, 140);
    busEmit({ ...ev, _type: 'state_update' }); // notify SSE clients
    res.json(ev);
  });

  /* GET /api/bus/stats — métricas del bus */
  app.get('/api/bus/stats', auth, (req, res) => {
    const counts = {};
    for (const ev of busEvents) counts[ev.state] = (counts[ev.state] || 0) + 1;
    const byOrigin = {};
    for (const ev of busEvents) byOrigin[ev.origin] = (byOrigin[ev.origin] || 0) + 1;
    res.json({
      total: busEvents.length,
      sseClients: sseClients.size,
      byState: counts,
      byOrigin,
      latest: busEvents[0] || null,
    });
  });

  /* GET /api/bus/history — historial persistente, filtrable por fecha/origen/estado/tipo/texto
   * Query params: from, to (ISO date), origin, dest, state, type, q (busca en label), limit, offset
   * Orden: más reciente primero.
   */
  app.get('/api/bus/history', auth, (req, res) => {
    let history = [];
    try { history = JSON.parse(fs.readFileSync(BUS_HISTORY_FILE, 'utf8')); }
    catch { history = []; }
    if (!Array.isArray(history)) history = [];

    const { from, to, origin, dest, state, type, q } = req.query;
    const fromMs = from ? new Date(String(from)).getTime() : null;
    const toMs   = to   ? new Date(String(to)).getTime()   : null;
    const qLower = q ? String(q).toLowerCase() : '';

    let filtered = history.filter(ev => {
      const tsMs = new Date(ev.ts).getTime();
      if (fromMs != null && !Number.isNaN(fromMs) && tsMs < fromMs) return false;
      if (toMs   != null && !Number.isNaN(toMs)   && tsMs > toMs)   return false;
      if (origin && ev.origin !== String(origin).toUpperCase()) return false;
      if (dest   && ev.dest   !== String(dest).toUpperCase())   return false;
      if (state  && ev.state  !== String(state).toUpperCase())  return false;
      if (type   && ev.type   !== String(type).toLowerCase())   return false;
      if (qLower && !String(ev.label || '').toLowerCase().includes(qLower)) return false;
      return true;
    });

    filtered.reverse(); // más reciente primero

    const total  = filtered.length;
    const limit  = Math.min(Math.max(Number(req.query.limit ?? 200), 1), 1000);
    const offset = Math.max(Number(req.query.offset ?? 0), 0);

    res.json({
      total,
      limit,
      offset,
      events: filtered.slice(offset, offset + limit),
    });
  });

  return { busEvents, sseClients, busEmit, busEmitAlert, MAX_BUS_EVENTS };
}
