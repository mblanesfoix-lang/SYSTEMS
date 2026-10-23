/**
 * Módulo de IA: elección de proveedor, nombres antiguos, proveedor simulado,
 * conectores local y externo con respuestas falsas, tiempo máximo y
 * contabilidad de consumo. Ninguna prueba sale a la red: el fetch global queda
 * bloqueado durante todo el archivo y los conectores reciben uno falso.
 * No usa Mongo.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  callLlm, llmStatus, resolveLlmConfig, legacyNotices, providerName, setUsageRecorder,
  RENAMED_VARS, PROVIDER_NAMES, LlmError, isLlmUnavailable,
} from '../llm/index.js';
import { addUsage, userCostUsd, costOf } from '../llm/usage.js';
import { setEgressRecorder } from '../egress/index.js';

const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = () => { throw new Error('red no permitida en las pruebas'); };
});
after(() => {
  globalThis.fetch = realFetch;
  setUsageRecorder(null);
});

const SIM = { LLM_PROVIDER: 'simulado' };
const EXT = { LLM_PROVIDER: 'externo', LLM_API_KEY: 'clave-de-prueba', LLM_MODEL: 'modelo-prueba', LLM_URL: 'http://proveedor.prueba/' };
const LOCAL = { LLM_PROVIDER: 'local', LLM_MODEL: 'modelo-local', LLM_URL: 'http://ia.local:11434' };
const ask = (extra = {}) => ({ system: 'sistema', prompt: 'hola', mesa: 'elvira', ...extra });
const legacyName = (replacement, provider) => RENAMED_VARS.find((r) => r.replacement === replacement && r.provider === provider).name;

const rejectsWith = (promise, code) => assert.rejects(promise, (err) => {
  assert.ok(err instanceof LlmError, `LlmError esperado, llegó ${err?.name}`);
  assert.equal(err.code, code);
  return true;
});

/** fetch falso que sirve las respuestas en orden y guarda cada petición. */
function fakeFetch(responses) {
  const queue = [...responses];
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, headers: Object.fromEntries(new Headers(init.headers)), body: JSON.parse(init.body) });
    const next = queue.shift();
    if (!next) throw new Error('el fetch falso no tiene más respuestas');
    if (next instanceof Error) throw next;
    const body = typeof next.body === 'string' ? next.body : JSON.stringify(next.body);
    return new Response(body, { status: next.status ?? 200, headers: next.headers });
  };
  fn.calls = calls;
  return fn;
}

const textMessage = (text, extra = {}) => ({
  stop_reason: 'end_turn',
  content: [{ type: 'text', text }],
  usage: { input_tokens: 10, output_tokens: 5 },
  ...extra,
});

describe('llm: elección de proveedor', () => {
  test('nombres admitidos y valores antiguos', () => {
    assert.deepEqual(PROVIDER_NAMES, ['local', 'simulado', 'externo']);
    assert.equal(providerName(' Simulado '), 'simulado');
    assert.equal(providerName('ollama'), 'local');
    assert.equal(providerName(''), null);
    assert.equal(providerName('otro'), undefined);
  });

  test('sin LLM_PROVIDER ni clave no hay IA, y la llamada lo dice sin romper', async () => {
    const status = llmStatus({});
    assert.equal(status.available, false);
    assert.match(status.reason, /falta LLM_PROVIDER/);
    await assert.rejects(callLlm(ask(), { env: {} }), (err) => isLlmUnavailable(err) && /falta LLM_PROVIDER/.test(err.message));
  });

  test('un valor no válido deja la IA sin configurar', () => {
    assert.match(llmStatus({ LLM_PROVIDER: 'otro' }).reason, /no es válido/);
  });

  test('externo sin clave, o con una clave de plantilla, no está disponible', async () => {
    assert.match(llmStatus({ LLM_PROVIDER: 'externo' }).reason, /falta LLM_API_KEY/);
    assert.equal(llmStatus({ LLM_PROVIDER: 'externo', LLM_API_KEY: 'placeholder' }).available, false);
    await rejectsWith(callLlm(ask(), { env: { LLM_PROVIDER: 'externo' } }), 'unavailable');
  });

  test('sin LLM_PROVIDER pero con clave se usa el externo, con aviso', () => {
    const env = { LLM_API_KEY: 'clave' };
    assert.equal(resolveLlmConfig(env).name, 'externo');
    assert.ok(legacyNotices(env).some((n) => n.startsWith('LLM_PROVIDER: sin definir')));
  });

  test('los nombres antiguos del externo se leen mientras falte el nuevo, con aviso', () => {
    const oldKey = legacyName('LLM_API_KEY', 'externo');
    const oldModel = legacyName('LLM_MODEL', 'externo');
    const env = { [oldKey]: 'clave-antigua', [oldModel]: 'modelo-antiguo' };
    const cfg = resolveLlmConfig(env);
    assert.equal(cfg.name, 'externo');
    assert.equal(cfg.apiKey, 'clave-antigua');
    assert.equal(cfg.model, 'modelo-antiguo');
    const notices = legacyNotices(env);
    assert.ok(notices.some((n) => n.startsWith(`${oldKey}: nombre antiguo de LLM_API_KEY`) && n.endsWith('renombrarla')));

    const withNew = { ...env, LLM_PROVIDER: 'externo', LLM_MODEL: 'modelo-nuevo' };
    assert.equal(resolveLlmConfig(withNew).model, 'modelo-nuevo');
    assert.ok(legacyNotices(withNew).some((n) => n.startsWith(`${oldModel}:`) && n.endsWith('se ignora')));
  });

  test('los nombres antiguos del local solo valen con el proveedor local', () => {
    const oldUrl = legacyName('LLM_URL', 'local');
    assert.equal(resolveLlmConfig({ LLM_PROVIDER: 'local', [oldUrl]: 'http://otro:1/' }).url, 'http://otro:1');
    assert.equal(resolveLlmConfig({ LLM_PROVIDER: 'simulado', [oldUrl]: 'http://otro:1/' }).url, '');
    assert.ok(legacyNotices({ LLM_PROVIDER: 'ollama' }).some((n) => n.startsWith('LLM_PROVIDER: valor antiguo, equivale a local')));
  });

  test('el estado nunca incluye la clave', () => {
    const status = llmStatus(EXT);
    assert.equal(status.available, true);
    assert.ok(!JSON.stringify(status).includes(EXT.LLM_API_KEY));
  });

  test('tiempo máximo: 30 s por defecto o LLM_TIMEOUT_MS', () => {
    assert.equal(resolveLlmConfig(SIM).timeoutMs, 30000);
    assert.equal(resolveLlmConfig({ ...SIM, LLM_TIMEOUT_MS: '5000' }).timeoutMs, 5000);
  });

  test('peticiones mal formadas fallan antes de llamar a nadie', async () => {
    await assert.rejects(callLlm({ prompt: 'x' }, { env: SIM }), TypeError);
    await assert.rejects(callLlm({ system: 's' }, { env: SIM }), TypeError);
    await assert.rejects(callLlm({ system: 's', messages: [{ role: 'otro', content: 'x' }], mesa: 'elvira' }, { env: SIM }), TypeError);
    await assert.rejects(callLlm({ system: 's', prompt: 'x' }, { env: SIM }), /falta la mesa/);
  });
});

describe('llm: proveedor simulado', () => {
  test('respuestas deterministas, marcadas y sin coste', async () => {
    const a = await callLlm(ask({ operation: 'central-chat' }), { env: SIM });
    const b = await callLlm(ask({ operation: 'central-chat' }), { env: SIM });
    assert.equal(a.text, b.text);
    assert.match(a.text, /^\[Simulación\]/);
    assert.equal(a.provider, 'simulado');
    assert.equal(a.costUsd, 0);
    assert.ok(a.inputTokens > 0 && a.outputTokens > 0);
  });

  test('cada mesa recibe la forma que espera', async () => {
    const run = async (operation) => (await callLlm(ask({ operation }), { env: SIM })).text;
    assert.ok(Array.isArray(JSON.parse(await run('search')).results));
    assert.ok(Array.isArray(JSON.parse(await run('linkedin')).contactos));
    assert.equal(typeof JSON.parse(await run('email')).asunto, 'string');
    assert.equal(typeof JSON.parse(await run('cnmc_search')).datos, 'object');
    const audit = JSON.parse(await run('herzog-audit'));
    assert.deepEqual(Object.keys(audit.categories).sort(),
      ['alineacionEstrategica', 'infraestructuraOperativa', 'solvenciaFinanciera', 'transparenciaCompliance']);
    assert.equal(audit.verdict, 'REVISION_MANUAL');
    assert.match(await run('paia-insight'), /^\[Simulación\]/);
    assert.match(await run('operacion-desconocida'), /^\[Simulación\]/);
  });

  test('la vigilancia no recibe noticias de prueba', async () => {
    const r = await callLlm(ask({ operation: 'reff-watch', webSearch: { maxUses: 4 } }), { env: SIM });
    assert.equal(r.text, 'TITULAR: Sin novedades');
    assert.deepEqual(r.sources, []);
    assert.equal(llmStatus(SIM).webSearch, true);
  });
});

describe('llm: conector local (respuestas falsas)', () => {
  test('pide /api/chat con el sistema primero y lee los tokens', async () => {
    const fetch = fakeFetch([{ body: { message: { content: ' respuesta ' }, prompt_eval_count: 12, eval_count: 7 } }]);
    const r = await callLlm(ask({ maxTokens: 300 }), { env: LOCAL, fetch });
    assert.equal(fetch.calls[0].url, 'http://ia.local:11434/api/chat');
    const body = fetch.calls[0].body;
    assert.equal(body.model, 'modelo-local');
    assert.equal(body.stream, false);
    assert.equal(body.options.num_predict, 300);
    assert.deepEqual(body.messages, [{ role: 'system', content: 'sistema' }, { role: 'user', content: 'hola' }]);
    assert.deepEqual([r.text, r.inputTokens, r.outputTokens, r.costUsd], ['respuesta', 12, 7, 0]);
  });

  test('sin búsqueda web: lo dice sin llamar al servidor', async () => {
    const fetch = fakeFetch([]);
    assert.equal(llmStatus(LOCAL).webSearch, false);
    await rejectsWith(callLlm(ask({ webSearch: { maxUses: 2 } }), { env: LOCAL, fetch }), 'unavailable');
    assert.equal(fetch.calls.length, 0);
  });

  test('error HTTP y servidor inalcanzable', async () => {
    await assert.rejects(callLlm(ask(), { env: LOCAL, fetch: fakeFetch([{ status: 500, body: 'caído' }]) }),
      (err) => err.code === 'provider' && /500/.test(err.message));
    await assert.rejects(callLlm(ask(), { env: LOCAL, fetch: fakeFetch([new TypeError('fetch failed')]) }),
      (err) => err.code === 'provider' && /No se pudo contactar/.test(err.message));
  });
});

describe('llm: conector externo (respuestas falsas)', () => {
  test('petición básica: dirección, clave, modelo y texto', async () => {
    const fetch = fakeFetch([{ body: textMessage(' hola ') }]);
    const r = await callLlm(ask({ maxTokens: 900 }), { env: EXT, fetch });
    const call = fetch.calls[0];
    assert.equal(call.url, 'http://proveedor.prueba/v1/messages');
    assert.equal(call.headers['x-api-key'], 'clave-de-prueba');
    assert.equal(call.body.model, 'modelo-prueba');
    assert.equal(call.body.max_tokens, 900);
    assert.equal(call.body.system, 'sistema');
    assert.deepEqual(call.body.messages, [{ role: 'user', content: 'hola' }]);
    assert.equal(call.body.tools, undefined);
    assert.deepEqual([r.text, r.inputTokens, r.outputTokens, r.truncated], ['hola', 10, 5, false]);
  });

  test('búsqueda web con pausa: reanuda, suma el consumo y reúne las fuentes sin repetir', async () => {
    const result = (url, title) => ({ type: 'web_search_result', url, title });
    const fetch = fakeFetch([
      { body: {
        stop_reason: 'pause_turn',
        content: [
          { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'q' } },
          { type: 'web_search_tool_result', tool_use_id: 's1', content: [result('https://a.example', 'A')] },
        ],
        usage: { input_tokens: 100, output_tokens: 20, server_tool_use: { web_search_requests: 2 } },
      } },
      { body: {
        stop_reason: 'end_turn',
        content: [
          { type: 'web_search_tool_result', tool_use_id: 's2', content: [result('https://a.example', 'A'), result('https://b.example', null)] },
          { type: 'web_search_tool_result', tool_use_id: 's3', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } },
          { type: 'text', text: 'Hola ' },
          { type: 'text', text: 'mundo' },
        ],
        usage: { input_tokens: 50, output_tokens: 30, server_tool_use: { web_search_requests: 1 } },
      } },
    ]);
    const r = await callLlm(ask({ webSearch: { maxUses: 4 } }), { env: EXT, fetch });
    assert.equal(fetch.calls.length, 2);
    assert.deepEqual(fetch.calls[0].body.tools.map((t) => [t.name, t.max_uses]), [['web_search', 4]]);
    const resumed = fetch.calls[1].body.messages;
    assert.equal(resumed.length, 2);
    assert.equal(resumed[1].role, 'assistant');
    assert.ok(Array.isArray(resumed[1].content));
    assert.equal(r.text, 'Hola mundo');
    assert.deepEqual(r.parts, ['Hola ', 'mundo']);
    assert.deepEqual([r.inputTokens, r.outputTokens, r.webSearches], [150, 50, 3]);
    assert.deepEqual(r.sources, [{ url: 'https://a.example', title: 'A' }, { url: 'https://b.example', title: null }]);
  });

  test('respuesta cortada por el límite de tokens', async () => {
    const r = await callLlm(ask(), { env: EXT, fetch: fakeFetch([{ body: textMessage('{"a":', { stop_reason: 'max_tokens' }) }]) });
    assert.equal(r.truncated, true);
  });

  test('reintenta saturación y fallos de red; no reintenta un error de la petición', async () => {
    const busy = fakeFetch([{ status: 529, body: 'ocupado', headers: { 'retry-after': '0' } }, { body: textMessage('ok') }]);
    assert.equal((await callLlm(ask(), { env: EXT, fetch: busy })).text, 'ok');
    assert.equal(busy.calls.length, 2);

    const network = fakeFetch([new TypeError('fetch failed'), { body: textMessage('ok') }]);
    assert.equal((await callLlm(ask(), { env: EXT, fetch: network })).text, 'ok');

    const bad = fakeFetch([{ status: 400, body: 'petición no válida' }]);
    await assert.rejects(callLlm(ask(), { env: EXT, fetch: bad }), (err) => err.code === 'provider' && /400/.test(err.message));
    assert.equal(bad.calls.length, 1);
  });

  test('la salida pasa por la compuerta: queda registrada con la mesa y el usuario', async () => {
    const events = [];
    setEgressRecorder((e) => events.push(e));
    try {
      await callLlm(ask({ mesa: 'reff', user: 'marc' }), { env: EXT, fetch: fakeFetch([{ body: textMessage('ok') }]) });
    } finally {
      setEgressRecorder(null);
    }
    assert.equal(events.length, 1);
    assert.deepEqual([events[0].mesa, events[0].user, events[0].destination, events[0].result, events[0].host], ['reff', 'marc', 'ia-externa', 'ok', 'proveedor.prueba']);
  });

  test('una mesa no autorizada no envía datos al proveedor externo: no disponible, sin reintentos y registrado', async () => {
    const events = [];
    setEgressRecorder((e) => events.push(e));
    const fetch = fakeFetch([{ body: textMessage('no debería llegar' ) }]);
    try {
      await assert.rejects(callLlm(ask({ mesa: 'fl' }), { env: EXT, fetch }), (err) => isLlmUnavailable(err) && /EGRESS_EXTERNAL_LLM_MESAS/.test(err.message));
    } finally {
      setEgressRecorder(null);
    }
    assert.equal(fetch.calls.length, 0);
    assert.deepEqual(events.map((e) => [e.result, e.mesa]), [['denegada', 'fl']]);
  });

  test('la IA local sirve a cualquier mesa aunque ninguna pueda usar la externa', async () => {
    const fetch = fakeFetch([{ body: { message: { content: 'ok' }, prompt_eval_count: 1, eval_count: 1 } }]);
    const r = await callLlm(ask({ mesa: 'fl' }), { env: { ...LOCAL, EGRESS_EXTERNAL_LLM_MESAS: 'ninguna' }, fetch });
    assert.equal(r.text, 'ok');
  });

  test('una pausa que nunca termina se corta', async () => {
    const paused = { body: { stop_reason: 'pause_turn', content: [], usage: { input_tokens: 1, output_tokens: 1 } } };
    const fetch = fakeFetch(Array.from({ length: 20 }, () => paused));
    await rejectsWith(callLlm(ask({ webSearch: { maxUses: 1 } }), { env: EXT, fetch }), 'incomplete');
    assert.equal(fetch.calls.length, 8);
  });

  test('sin respuesta a tiempo: error de tiempo agotado', async () => {
    const hanging = (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
    await rejectsWith(callLlm(ask({ timeoutMs: 50 }), { env: EXT, fetch: hanging }), 'timeout');
  });

  test('tarifa: la del modelo predeterminado, ninguna para un modelo desconocido y LLM_PRICE_* la sustituye', async () => {
    const byDefault = llmStatus({ LLM_PROVIDER: 'externo', LLM_API_KEY: 'k' }).pricing;
    assert.ok(byDefault.inputPerM > 0 && byDefault.outputPerM > 0 && byDefault.perWebSearch > 0);

    const usage = { stop_reason: 'end_turn', content: [], usage: { input_tokens: 500000, output_tokens: 250000 } };
    assert.equal((await callLlm(ask(), { env: EXT, fetch: fakeFetch([{ body: usage }]) })).costUsd, null);
    const priced = { ...EXT, LLM_PRICE_INPUT_PER_M: '2', LLM_PRICE_OUTPUT_PER_M: '4' };
    assert.equal((await callLlm(ask(), { env: priced, fetch: fakeFetch([{ body: usage }]) })).costUsd, 2);
  });
});

describe('llm: contabilidad de consumo', () => {
  test('cada llamada con usuario llega al registro; sin usuario, no', async () => {
    const entries = [];
    setUsageRecorder((e) => entries.push(e));
    try {
      await callLlm(ask({ user: 'marc', operation: 'search' }), { env: SIM });
      await callLlm(ask(), { env: SIM });
    } finally {
      setUsageRecorder(null);
    }
    assert.equal(entries.length, 1);
    const [e] = entries;
    assert.deepEqual([e.user, e.operation, e.provider, e.model, e.costUsd], ['marc', 'search', 'simulado', 'simulado', 0]);
    assert.ok(e.inputTokens > 0 && typeof e.at === 'string');
  });

  test('un fallo al registrar no rompe la llamada', async () => {
    const originalError = console.error;
    const logged = [];
    console.error = (...args) => logged.push(args.join(' '));
    setUsageRecorder(() => { throw new Error('disco lleno'); });
    try {
      const r = await callLlm(ask({ user: 'marc' }), { env: SIM });
      assert.match(r.text, /Simulación/);
      assert.ok(logged.some((l) => l.includes('disco lleno')));
    } finally {
      setUsageRecorder(null);
      console.error = originalError;
    }
  });

  test('suma por usuario y operación, con el coste de cada llamada', () => {
    const systems = {};
    const entry = (over) => ({ user: 'marc', operation: 'search', provider: 'externo', model: 'm', inputTokens: 1000, outputTokens: 500, webSearches: 1, costUsd: 0.25, at: 't', ...over });
    addUsage(systems, entry());
    addUsage(systems, entry({ operation: 'email', costUsd: 0.75, webSearches: 0 }));
    const u = systems.tcontroler.byUser.marc;
    assert.deepEqual([u.calls, u.inputTokens, u.outputTokens, u.webSearches, u.costUsd], [2, 2000, 1000, 1, 1]);
    assert.equal(u.operations.search.costUsd, 0.25);
    assert.equal(systems.tcontroler.tokensUsed, 3000);
    assert.equal(userCostUsd(u, { inputPerM: 100, outputPerM: 100 }), 1, 'la tarifa vigente no revalora lo ya registrado');
  });

  test('registros anteriores y llamadas sin tarifa se valoran con la tarifa vigente', () => {
    const systems = { tcontroler: { byUser: { ana: { inputTokens: 1e6, outputTokens: 0, calls: 3, operations: {} } } } };
    const pricing = { inputPerM: 3, outputPerM: 6 };
    assert.equal(userCostUsd(systems.tcontroler.byUser.ana, pricing), 3);
    addUsage(systems, { user: 'ana', operation: 'x', inputTokens: 0, outputTokens: 1e6, webSearches: 0, costUsd: null, at: 't' });
    addUsage(systems, { user: 'ana', operation: 'x', inputTokens: 10, outputTokens: 10, webSearches: 0, costUsd: 0.5, at: 't' });
    assert.equal(userCostUsd(systems.tcontroler.byUser.ana, pricing), 3 + 6 + 0.5);
    assert.equal(costOf(null, { inputTokens: 1 }), null);
  });
});
