/**
 * Compuerta de salida de Pactvm Viridi: lista blanca por mesa, política de IA
 * externa, tiempo máximo, tamaño, redirecciones, descarga de páginas públicas y
 * registro de cada salida (permitida o denegada). Los destinos son servidores
 * locales de la propia prueba: nada sale a internet. No usa Mongo.
 */
import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  egressFetch, egressRun, egressFetcher, egressPolicy, authorizeEgress, recordEgress,
  setEgressRecorder, EgressError, isEgressDenied,
} from '../egress/index.js';
import {
  parseAllowlist, parseMesaList, endpointOf, BUILTIN_DESTINATIONS,
  DEFAULT_EXTERNAL_LLM_MESAS, DEFAULT_PUBLIC_WEB_MESAS,
} from '../egress/destinations.js';
import { isPublicAddress, nonPublicHostReason, guardedLookup, requestPublic } from '../egress/public-web.js';

const listen = (handler) => new Promise((resolve) => {
  const srv = http.createServer(handler).listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    resolve({ srv, port, url: `http://127.0.0.1:${port}` });
  });
});
const close = (s) => new Promise((resolve) => { s.srv.closeAllConnections?.(); s.srv.close(resolve); });

let events;
beforeEach(() => {
  events = [];
  setEgressRecorder((e) => events.push(e));
});
afterEach(() => setEgressRecorder(null));

describe('egress: lista blanca', () => {
  test('EGRESS_ALLOWLIST: mesa=destino,destino;mesa=ninguna', () => {
    const { entries, problems } = parseAllowlist('snfiu2=apidatos.ree.es, https://api.esios.ree.es ; fl=ninguna');
    assert.deepEqual(problems, []);
    assert.deepEqual(entries.get('snfiu2'), [
      { protocol: 'https', host: 'apidatos.ree.es', port: 443 },
      { protocol: 'https', host: 'api.esios.ree.es', port: 443 },
    ]);
    assert.deepEqual(entries.get('fl'), []);
  });

  test('EGRESS_ALLOWLIST: lo que no se entiende se señala', () => {
    const { problems } = parseAllowlist('sin-igual;Mesa Mala=a.com;fl=ftp://x.com,http://');
    assert.equal(problems.length, 4);
    assert.deepEqual(parseAllowlist('').entries.size, 0);
  });

  test('listas de mesas: valor por defecto, ninguna y nombres no válidos', () => {
    assert.deepEqual(parseMesaList(undefined, ['reff']).mesas, ['reff']);
    assert.deepEqual(parseMesaList('ninguna', ['reff']).mesas, []);
    assert.deepEqual(parseMesaList('Elvira, reff', []).mesas, ['elvira', 'reff']);
    assert.equal(parseMesaList('reff,mal nombre', []).problems.length, 1);
  });

  test('endpointOf: puerto por defecto, esquema y máquina en minúsculas', () => {
    assert.deepEqual(endpointOf('API.REE.es.'), { protocol: 'https', host: 'api.ree.es', port: 443 });
    assert.deepEqual(endpointOf('http://ia.local:11434/x'), { protocol: 'http', host: 'ia.local', port: 11434 });
    assert.equal(endpointOf(''), null);
  });

  test('de serie: un destino por servicio y mesa', () => {
    const p = egressPolicy({});
    for (const b of BUILTIN_DESTINATIONS) {
      const d = p.destinations.find((x) => x.id === b.id);
      assert.ok(d, b.id);
      assert.deepEqual(d.mesas, b.mesas);
      assert.equal(d.category, 'tercero');
    }
    assert.deepEqual(p.externalLlmMesas, DEFAULT_EXTERNAL_LLM_MESAS);
    assert.deepEqual(p.publicWebMesas, DEFAULT_PUBLIC_WEB_MESAS);
    assert.ok(p.destinations.some((d) => d.id === 'web-publica' && d.host === '*'));
  });

  test('EGRESS_ALLOWLIST sustituye solo a las mesas que nombra', () => {
    const p = egressPolicy({ EGRESS_ALLOWLIST: 'snfiu2=datos.interno.es' });
    assert.ok(!p.destinations.some((d) => d.id === 'ree-datos'), 'los de serie de snfiu2 se sustituyen');
    assert.ok(p.destinations.some((d) => d.host === 'datos.interno.es' && d.mesas[0] === 'snfiu2'));
    assert.ok(p.destinations.some((d) => d.id === 'boe'), 'las demás mesas conservan los suyos');
    assert.equal(egressPolicy({ EGRESS_ALLOWLIST: 'fl=ninguna' }).destinations.some((d) => d.id === 'boe'), false);
  });

  test('IA: la externa es un tercero limitado a unas mesas; la local no lo es', () => {
    const ext = egressPolicy({ LLM_PROVIDER: 'externo', LLM_API_KEY: 'k', LLM_URL: 'https://ia.proveedor.es' });
    const d = ext.destinations.find((x) => x.id === 'ia-externa');
    assert.deepEqual([d.category, d.host, d.port, d.mesas], ['tercero', 'ia.proveedor.es', 443, DEFAULT_EXTERNAL_LLM_MESAS]);
    const restricted = egressPolicy({ LLM_PROVIDER: 'externo', LLM_API_KEY: 'k', LLM_URL: 'https://ia.proveedor.es', EGRESS_EXTERNAL_LLM_MESAS: 'reff' });
    assert.deepEqual(restricted.destinations.find((x) => x.id === 'ia-externa').mesas, ['reff']);

    const local = egressPolicy({ LLM_PROVIDER: 'local', LLM_URL: 'http://ollama:11434' }).destinations.find((x) => x.id === 'ia-local');
    assert.deepEqual([local.category, local.mesas, local.port], ['propio', ['*'], 11434]);
    assert.ok(!egressPolicy({ LLM_PROVIDER: 'simulado' }).destinations.some((x) => x.id.startsWith('ia-')));
  });

  test('infraestructura propia y terceros por entorno: SYSTEMS_URL, racks, TSO, correo y base de datos', () => {
    const p = egressPolicy({
      SYSTEMS_URL: 'https://ophs.interno:8443/', RACK_PEERS: 'http://rack-b:5173, http://rack-c:5173',
      GRID_ES_URL: 'https://tso.ree.es/live', SMTP_HOST: 'SMTP.correo.es', SMTP_PORT: '465',
      MONGO_URI: 'mongodb+srv://u:p@cluster0.abc.mongodb.net/elvira',
    });
    const by = (id) => p.destinations.find((d) => d.id === id);
    assert.deepEqual([by('systems').category, by('systems').port, by('systems').mesas], ['propio', 8443, ['elvira']]);
    assert.deepEqual([by('rack-1').host, by('rack-2').host, by('rack-1').mesas], ['rack-b', 'rack-c', ['sentinel']]);
    assert.deepEqual([by('grid-es').category, by('grid-es').host, by('grid-es').mesas], ['tercero', 'tso.ree.es', ['ophs']]);
    assert.deepEqual([by('smtp').protocol, by('smtp').host, by('smtp').port], ['smtp', 'smtp.correo.es', 465]);
    const mongo = by('mongo-1');
    assert.deepEqual([mongo.via, mongo.category, mongo.host, mongo.origin], ['controlador', 'tercero', 'cluster0.abc.mongodb.net', 'mongodb+srv://cluster0.abc.mongodb.net']);
    assert.ok(!JSON.stringify(p).includes(':p@'), 'la política exportable no lleva credenciales');
    assert.equal(egressPolicy({ MONGO_URI: 'mongodb://127.0.0.1:27017/elvira' }).destinations.find((d) => d.id === 'mongo-1').category, 'propio');
  });

  test('tiempo máximo configurable', () => {
    assert.equal(egressPolicy({}).timeoutMs, 20000);
    assert.equal(egressPolicy({ EGRESS_TIMEOUT_MS: '1500' }).timeoutMs, 1500);
    assert.equal(egressPolicy({ EGRESS_TIMEOUT_MS: 'x' }).timeoutMs, 20000);
  });
});

describe('egress: compuerta con destinos locales', () => {
  let ok, other, slow;
  before(async () => {
    ok = await listen((req, res) => {
      if (req.url === '/big') return res.end('x'.repeat(100));
      if (req.url === '/redir') { res.writeHead(302, { location: `${other.url}/echo` }); return res.end(); }
      if (req.url === '/redir-self') { res.writeHead(302, { location: '/ok' }); return res.end(); }
      if (req.url === '/loop') { res.writeHead(302, { location: '/loop' }); return res.end(); }
      if (req.url === '/error') { res.writeHead(500); return res.end('fallo'); }
      res.setHeader('content-type', 'application/json');
      return res.end('{"ok":true}');
    });
    other = await listen((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ authorization: req.headers.authorization ?? null, accept: req.headers.accept ?? null }));
    });
    slow = await listen((_req, res) => setTimeout(() => res.end('tarde'), 400));
  });
  after(async () => { await Promise.all([close(ok), close(other), close(slow)]); });

  const envFor = (extra = {}) => ({ EGRESS_ALLOWLIST: `snfiu2=${ok.url};fl=${slow.url}`, ...extra });

  test('un destino permitido pasa y queda registrado', async () => {
    const res = await egressFetch(`${ok.url}/datos?x=1`, { headers: { Accept: 'application/json' } }, { mesa: 'snfiu2', user: 'marc' }, { env: envFor() });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(events.length, 1);
    const [e] = events;
    assert.deepEqual(
      [e.mesa, e.user, e.result, e.status, e.host, e.port, e.method, e.path, e.category, e.poll],
      ['snfiu2', 'marc', 'ok', 200, '127.0.0.1', ok.port, 'GET', '/datos', 'tercero', false],
    );
    assert.equal(e.bytesIn, 11);
    assert.equal(e.bytesOut, 0);
    assert.ok(typeof e.destination === 'string' && e.durationMs >= 0 && e.at);
  });

  test('un destino no permitido falla y queda registrado como denegado', async () => {
    await assert.rejects(
      egressFetch(`${other.url}/x`, {}, { mesa: 'snfiu2', user: 'marc' }, { env: envFor() }),
      (err) => err instanceof EgressError && err.code === 'denied' && isEgressDenied(err) && /lista blanca/.test(err.message),
    );
    assert.equal(events.length, 1);
    const [e] = events;
    assert.deepEqual([e.result, e.mesa, e.user, e.host, e.port, e.destination, e.status], ['denegada', 'snfiu2', 'marc', '127.0.0.1', other.port, null, null]);
    assert.match(e.reason, /lista blanca/);
  });

  test('un destino permitido a otra mesa no vale para esta', async () => {
    await assert.rejects(
      egressFetch(`${ok.url}/x`, {}, { mesa: 'elvira' }, { env: envFor() }),
      (err) => err.code === 'denied' && /no autorizado para la mesa elvira/.test(err.message),
    );
    assert.equal(events[0].result, 'denegada');
    assert.ok(events[0].destination, 'se anota la regla que habría hecho falta');
  });

  test('la salida denegada no llega a conectar', async () => {
    let called = false;
    await assert.rejects(egressFetch('http://127.0.0.1:9/x', {}, { mesa: 'fl' }, {
      env: envFor(), fetch: async () => { called = true; return new Response('x'); },
    }), EgressError);
    assert.equal(called, false);
  });

  test('IA externa: solo las mesas autorizadas envían datos; la local, cualquiera', async () => {
    const ext = { LLM_PROVIDER: 'externo', LLM_API_KEY: 'k', LLM_URL: ok.url };
    const allowed = await egressFetch(`${ok.url}/v1/messages`, { method: 'POST', body: '{}' }, { mesa: 'reff' }, { env: ext });
    assert.equal(allowed.status, 200);
    assert.equal(events[0].destination, 'ia-externa');
    assert.equal(events[0].bytesOut, 2);

    await assert.rejects(
      egressFetch(`${ok.url}/v1/messages`, { method: 'POST', body: '{}' }, { mesa: 'fl' }, { env: ext }),
      (err) => err.code === 'denied' && /proveedor de IA externo/.test(err.message) && /EGRESS_EXTERNAL_LLM_MESAS/.test(err.message),
    );
    assert.equal(events[1].result, 'denegada');

    await assert.rejects(
      egressFetch(`${ok.url}/x`, {}, { mesa: 'reff' }, { env: { ...ext, EGRESS_EXTERNAL_LLM_MESAS: 'ninguna' } }),
      (err) => err.code === 'denied',
    );

    const local = { LLM_PROVIDER: 'local', LLM_URL: ok.url, EGRESS_EXTERNAL_LLM_MESAS: 'ninguna' };
    for (const mesa of ['fl', 'finance', 'reff']) {
      assert.equal((await egressFetch(`${ok.url}/api/chat`, {}, { mesa }, { env: local })).status, 200);
    }
    assert.equal(events.at(-1).category, 'propio');
  });

  test('tiempo máximo: corta y lo registra', async () => {
    await assert.rejects(
      egressFetch(`${slow.url}/`, {}, { mesa: 'fl', timeoutMs: 100 }, { env: envFor() }),
      (err) => err instanceof EgressError && err.code === 'timeout',
    );
    assert.equal(events[0].result, 'error');
    assert.match(events[0].reason, /no respondió/);
  });

  test('la señal del llamador también corta la salida', async () => {
    const controller = new AbortController();
    const pending = egressFetch(`${slow.url}/`, { signal: controller.signal }, { mesa: 'fl' }, { env: envFor() });
    setTimeout(() => controller.abort(new Error('cancelada')), 50);
    await assert.rejects(pending, /cancelada/);
    assert.equal(events[0].result, 'error');
  });

  test('tamaño máximo: falla o corta según se pida', async () => {
    await assert.rejects(
      egressFetch(`${ok.url}/big`, {}, { mesa: 'snfiu2', maxBytes: 10 }, { env: envFor() }),
      (err) => err.code === 'too_large',
    );
    assert.equal(events[0].result, 'error');
    const cut = await egressFetch(`${ok.url}/big`, {}, { mesa: 'snfiu2', maxBytes: 10, truncate: true }, { env: envFor() });
    assert.equal((await cut.text()).length, 10);
    assert.equal(events[1].bytesIn, 10);
  });

  test('error HTTP y fallo de red se registran como error', async () => {
    const res = await egressFetch(`${ok.url}/error`, {}, { mesa: 'snfiu2' }, { env: envFor() });
    assert.equal(res.status, 500);
    assert.deepEqual([events[0].result, events[0].status], ['error', 500]);

    const closed = await listen(() => {});
    const url = closed.url;
    await close(closed);
    await assert.rejects(egressFetch(`${url}/`, {}, { mesa: 'snfiu2' }, { env: { EGRESS_ALLOWLIST: `snfiu2=${url}` } }));
    assert.equal(events[1].result, 'error');
  });

  test('redirecciones: se siguen dentro de la lista blanca y se frenan fuera de ella', async () => {
    const inside = await egressFetch(`${ok.url}/redir-self`, {}, { mesa: 'snfiu2' }, { env: envFor() });
    assert.equal(inside.status, 200);
    assert.equal(events[0].redirects, 1);
    assert.equal(events[0].path, '/ok');

    events.length = 0;
    await assert.rejects(
      egressFetch(`${ok.url}/redir`, {}, { mesa: 'snfiu2' }, { env: envFor() }),
      (err) => err.code === 'denied',
    );
    assert.equal(events.length, 1);
    assert.deepEqual([events[0].result, events[0].port, events[0].redirects], ['denegada', other.port, 1]);

    events.length = 0;
    await assert.rejects(egressFetch(`${ok.url}/loop`, {}, { mesa: 'snfiu2' }, { env: envFor() }), (err) => err.code === 'redirects');
    assert.equal(events[0].result, 'error');
  });

  test('al cambiar de origen en una redirección no viajan credenciales', async () => {
    const env = { EGRESS_ALLOWLIST: `snfiu2=${ok.url},${other.url}` };
    const res = await egressFetch(`${ok.url}/redir`, { headers: { Authorization: 'Bearer secreto', Accept: 'application/json' } }, { mesa: 'snfiu2' }, { env });
    assert.deepEqual(await res.json(), { authorization: null, accept: 'application/json' });
  });

  test('una consulta automática lleva la marca poll en el evento', async () => {
    await egressFetch(`${ok.url}/`, {}, { mesa: 'snfiu2', poll: true }, { env: envFor() });
    assert.equal(events[0].poll, true);
  });

  test('un registrador que falla no rompe la salida', async () => {
    const originalError = console.error;
    const logged = [];
    console.error = (...a) => logged.push(a.join(' '));
    setEgressRecorder(() => { throw new Error('disco lleno'); });
    try {
      assert.equal((await egressFetch(`${ok.url}/`, {}, { mesa: 'snfiu2' }, { env: envFor() })).status, 200);
      setEgressRecorder(() => Promise.reject(new Error('base caída')));
      assert.equal((await egressFetch(`${ok.url}/`, {}, { mesa: 'snfiu2' }, { env: envFor() })).status, 200);
      await new Promise((r) => setImmediate(r));
    } finally {
      console.error = originalError;
    }
    assert.ok(logged.some((l) => l.includes('disco lleno')) && logged.some((l) => l.includes('base caída')));
  });

  test('sin mesa no hay salida', async () => {
    await assert.rejects(egressFetch(`${ok.url}/`, {}, {}, { env: envFor() }), TypeError);
    assert.equal(events.length, 0);
  });

  test('egressFetcher entrega un fetch ligado a su mesa', async () => {
    const fetcher = egressFetcher({ mesa: 'snfiu2', poll: true }, { env: envFor() });
    assert.equal((await fetcher(`${ok.url}/`)).status, 200);
    assert.deepEqual([events[0].mesa, events[0].poll], ['snfiu2', true]);
  });

  test('authorizeEgress avisa sin salir ni registrar', () => {
    const env = envFor();
    const allowed = authorizeEgress(`${ok.url}/x`, { mesa: 'snfiu2' }, { env });
    assert.deepEqual([allowed.allowed, allowed.reason, typeof allowed.destination], [true, null, 'string']);
    const denied = authorizeEgress(`${ok.url}/x`, { mesa: 'elvira' }, { env });
    assert.equal(denied.allowed, false);
    assert.match(denied.reason, /no autorizado/);
    assert.equal(authorizeEgress('???', { mesa: 'fl' }, { env }).allowed, false);
    assert.equal(events.length, 0);
  });

  test('recordEgress sin registrador no hace nada', () => {
    setEgressRecorder(null);
    assert.doesNotThrow(() => recordEgress({ mesa: 'fl' }));
  });
});

describe('egress: salidas que no son HTTP (correo)', () => {
  const env = { SMTP_HOST: 'smtp.correo.es', SMTP_PORT: '587' };
  const smtp = { protocol: 'smtp', host: 'smtp.correo.es', port: 587, bytesOut: 321 };

  test('permitida: ejecuta con el tiempo máximo y se registra', async () => {
    const out = await egressRun(smtp, { mesa: 'reff', user: 'marc' }, async ({ timeoutMs }) => `enviado en ${timeoutMs}`, { env });
    assert.equal(out, 'enviado en 20000');
    const [e] = events;
    assert.deepEqual([e.result, e.mesa, e.user, e.protocol, e.host, e.port, e.bytesOut, e.destination], ['ok', 'reff', 'marc', 'smtp', 'smtp.correo.es', 587, 321, 'smtp']);
  });

  test('otra mesa o un servidor distinto: denegada sin ejecutar nada', async () => {
    let ran = false;
    const fn = async () => { ran = true; };
    await assert.rejects(egressRun(smtp, { mesa: 'fl' }, fn, { env }), isEgressDenied);
    await assert.rejects(egressRun({ ...smtp, host: 'otro.correo.es' }, { mesa: 'reff' }, fn, { env }), isEgressDenied);
    await assert.rejects(egressRun(smtp, { mesa: 'reff' }, fn, { env: {} }), isEgressDenied);
    assert.equal(ran, false);
    assert.deepEqual(events.map((e) => e.result), ['denegada', 'denegada', 'denegada']);
  });

  test('un fallo del envío se registra y se propaga', async () => {
    await assert.rejects(egressRun(smtp, { mesa: 'reff' }, async () => { throw new Error('535 credenciales'); }, { env }), /535/);
    assert.deepEqual([events[0].result, events[0].reason], ['error', '535 credenciales']);
  });
});

describe('egress: páginas públicas citadas por un usuario', () => {
  test('direcciones públicas y no públicas', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111']) assert.equal(isPublicAddress(ip), true, ip);
    for (const ip of [
      '127.0.0.1', '10.0.0.1', '172.16.5.5', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1',
      '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '64:ff9b::7f00:1', 'no-es-ip',
    ]) assert.equal(isPublicAddress(ip), false, ip);
  });

  test('nombres de máquina que nunca son públicos', () => {
    for (const h of ['localhost', 'servidor', 'api.internal', 'nas.local', 'router.lan', 'x.localhost', '127.0.0.1', '[::1]', '10.1.1.1']) {
      assert.ok(nonPublicHostReason(h), h);
    }
    for (const h of ['example.com', 'www.boe.es', '8.8.8.8']) assert.equal(nonPublicHostReason(h), null, h);
  });

  test('la resolución DNS que acaba en una red privada se rechaza al conectar', async () => {
    const result = await new Promise((resolve) => guardedLookup('localhost', {}, (err, address) => resolve({ err, address })));
    assert.ok(result.err instanceof EgressError && result.err.code === 'denied');
  });

  test('requestPublic rechaza máquinas locales sin conectar', async () => {
    const srv = await listen((_req, res) => res.end('secreto interno'));
    try {
      await assert.rejects(
        requestPublic(new URL(`${srv.url}/`), { method: 'GET', headers: new Headers() }),
        isEgressDenied,
      );
    } finally {
      await close(srv);
    }
  });

  test('por la compuerta: solo mesas autorizadas, solo puertos web estándar y nunca redes privadas', async () => {
    const page = (url, ctx, env = {}) => egressFetch(url, {}, { publicWeb: true, ...ctx }, { env });
    await assert.rejects(page('http://127.0.0.1/', { mesa: 'reff' }), (e) => e.code === 'denied' && /no pública/.test(e.message));
    await assert.rejects(page('http://169.254.169.254/latest/meta-data/', { mesa: 'reff' }), isEgressDenied);
    await assert.rejects(page('https://servidor.local/', { mesa: 'reff' }), isEgressDenied);
    await assert.rejects(page('https://example.com:8443/', { mesa: 'reff' }), (e) => /puertos web estándar/.test(e.message));
    await assert.rejects(page('ftp://example.com/', { mesa: 'reff' }), (e) => /http\(s\)/.test(e.message));
    await assert.rejects(page('https://example.com/', { mesa: 'fl' }), (e) => /EGRESS_PUBLIC_WEB_MESAS/.test(e.message));
    await assert.rejects(page('https://example.com/', { mesa: 'reff' }, { EGRESS_PUBLIC_WEB_MESAS: 'ninguna' }), isEgressDenied);
    assert.equal(events.length, 7);
    assert.ok(events.every((e) => e.result === 'denegada' && e.destination === 'web-publica'));
  });
});
