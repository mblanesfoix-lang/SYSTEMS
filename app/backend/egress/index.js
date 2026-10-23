import { egressPolicy, endpointOf, normalizeHost, ANY_MESA } from './destinations.js';
import { requestPublic, nonPublicHostReason } from './public-web.js';
import { EgressError, isEgressDenied } from './errors.js';

export { egressPolicy, EgressError, isEgressDenied };

/**
 * Compuerta única de salida a la red: Pactvm Viridi filtra toda actividad hacia
 * terceros. Cada llamada del proceso a otra máquina pasa por aquí con la mesa que
 * la hace; se comprueba contra la lista blanca (destinations.js), se limita en
 * tiempo y tamaño, se siguen las redirecciones solo hacia destinos permitidos y
 * se emite un evento con destino, mesa, usuario, tamaño y resultado, también si
 * se deniega.
 *
 * Los eventos van al registrador que fija server.js (setEgressRecorder), que los
 * guarda en el log encadenado de Pactvm. Aquí no hay base de datos: los workers
 * de Grid usan la compuerta y reenvían sus eventos al hilo principal.
 *
 * Contexto de cada llamada:
 *   mesa       obligatoria; decide qué destinos tiene permitidos
 *   user       a quién se imputa la salida, si la pide una persona
 *   poll       consulta automática y repetitiva: el registro la agrega por ventana
 *   publicWeb  página pública que cita un usuario; solo mesas de EGRESS_PUBLIC_WEB_MESAS
 *   timeoutMs  tiempo máximo (por defecto EGRESS_TIMEOUT_MS)
 *   maxBytes   tamaño máximo de la respuesta; con truncate se corta en vez de fallar
 */

const MAX_REDIRECTS = 5;
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const NULL_BODY = new Set([101, 103, 204, 205, 304]);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
// Al cambiar de origen en una redirección solo viajan cabeceras sin credenciales.
const CROSS_ORIGIN_HEADERS = new Set(['accept', 'accept-language', 'user-agent', 'content-type']);

const PUBLIC_WEB = { id: 'web-publica', category: 'tercero' };

let recorder = null;

/** Recibe cada evento de salida. Si falla, la llamada no se ve afectada. */
export function setEgressRecorder(fn) {
  recorder = typeof fn === 'function' ? fn : null;
}

/** Entrega un evento al registrador; lo usan también los eventos que llegan de los workers. */
export function recordEgress(event) {
  if (!recorder) return;
  const logFailure = (err) => console.error('[egress] no se pudo registrar la salida:', err?.message || err);
  try {
    const pending = recorder(event);
    if (pending && typeof pending.catch === 'function') pending.catch(logFailure);
  } catch (err) {
    logFailure(err);
  }
}

const positive = (v) => (Number.isFinite(v) && v > 0 ? v : null);

function normalizeContext(ctx) {
  const c = ctx || {};
  if (typeof c.mesa !== 'string' || !c.mesa.trim()) throw new TypeError('egress: falta la mesa que hace la llamada');
  return {
    mesa: c.mesa.trim().toLowerCase(),
    user: c.user ? String(c.user) : null,
    poll: c.poll === true,
    publicWeb: c.publicWeb === true,
    timeoutMs: positive(c.timeoutMs),
    maxBytes: positive(c.maxBytes),
    truncate: c.truncate === true,
  };
}

function decide(policy, target, ctx) {
  if (ctx.publicWeb) {
    const deny = (reason) => ({ allowed: false, destination: PUBLIC_WEB, reason });
    if (!['http', 'https'].includes(target.protocol)) return deny('solo se admiten páginas http(s)');
    if (target.port !== (target.protocol === 'https' ? 443 : 80)) return deny('solo se admiten los puertos web estándar');
    if (!policy.publicWebMesas.includes(ctx.mesa)) return deny(`la mesa ${ctx.mesa} no puede descargar páginas públicas (EGRESS_PUBLIC_WEB_MESAS)`);
    const reason = nonPublicHostReason(target.host);
    return reason ? deny(reason) : { allowed: true, destination: PUBLIC_WEB };
  }
  const same = policy.destinations.filter((d) => d.via === 'compuerta'
    && d.protocol === target.protocol && d.host === target.host && d.port === target.port);
  const match = same.find((d) => d.mesas.includes(ANY_MESA) || d.mesas.includes(ctx.mesa));
  if (match) return { allowed: true, destination: match };
  if (same.some((d) => d.id === 'ia-externa')) {
    return { allowed: false, destination: same[0], reason: `la mesa ${ctx.mesa} no está autorizada a enviar datos a un proveedor de IA externo (EGRESS_EXTERNAL_LLM_MESAS)` };
  }
  if (same.length) return { allowed: false, destination: same[0], reason: `destino no autorizado para la mesa ${ctx.mesa}` };
  return { allowed: false, destination: null, reason: `destino fuera de la lista blanca de la mesa ${ctx.mesa}` };
}

/** ¿Puede la mesa salir a ese destino? Sin red ni registro: para avisar antes de intentarlo. */
export function authorizeEgress(target, ctx, { env = process.env } = {}) {
  const t = typeof target === 'string' ? endpointOf(target) : { ...target, host: normalizeHost(target.host) };
  if (!t) return { allowed: false, destination: null, reason: 'dirección no válida' };
  const d = decide(egressPolicy(env), t, normalizeContext(ctx));
  return { allowed: d.allowed, destination: d.destination?.id ?? null, reason: d.reason ?? null };
}

function byteLength(body) {
  if (body === null || body === undefined) return 0;
  if (typeof body === 'string') return Buffer.byteLength(body);
  if (body instanceof URLSearchParams) return Buffer.byteLength(body.toString());
  if (typeof body.byteLength === 'number') return body.byteLength;
  if (typeof body.size === 'number') return body.size;
  return null;
}

/* Señal que se aborta con la del llamador o al agotar el tiempo; recuerda cuál de las dos fue. */
function deadlineSignal(parent, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new EgressError('tiempo agotado', 'timeout'));
  }, timeoutMs);
  const onAbort = () => controller.abort(parent.reason);
  if (parent?.aborted) controller.abort(parent.reason);
  else parent?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    clear() {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
    },
  };
}

async function readBody(res, maxBytes, truncate) {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > maxBytes) {
      await reader.cancel().catch(() => {});
      if (!truncate) throw new EgressError(`la respuesta supera ${maxBytes} bytes`, 'too_large');
      chunks.push(value.subarray(0, maxBytes - total));
      total = maxBytes;
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  return Buffer.concat(chunks, total);
}

function rebuildResponse(res, body) {
  const headers = new Headers(res.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');
  return new Response(NULL_BODY.has(res.status) ? null : body, { status: res.status, statusText: res.statusText, headers });
}

function crossOriginHeaders(headers) {
  const safe = new Headers();
  for (const [name, value] of headers) if (CROSS_ORIGIN_HEADERS.has(name)) safe.set(name, value);
  return safe;
}

function baseEvent(ctx, url, method, decision, started) {
  return {
    at: new Date(started).toISOString(),
    mesa: ctx.mesa,
    user: ctx.user,
    poll: ctx.poll,
    destination: decision?.destination?.id ?? null,
    category: decision?.destination?.category ?? null,
    protocol: url.protocol.replace(/:$/, ''),
    host: normalizeHost(url.hostname),
    port: url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80),
    method,
    path: url.pathname,
    durationMs: Date.now() - started,
  };
}

/**
 * fetch a través de la compuerta. Devuelve un Response estándar con el cuerpo ya
 * leído (así se mide y se limita). Errores: EgressError (denied, timeout,
 * too_large, redirects) o el error de red original.
 * `options.fetch` y `options.env` sustituyen al fetch global y al entorno (pruebas).
 */
export async function egressFetch(input, init = {}, ctx, { fetch: transport = globalThis.fetch, env = process.env } = {}) {
  const c = normalizeContext(ctx);
  const policy = egressPolicy(env);
  let url = new URL(input instanceof URL ? input.href : String(input));
  let method = String(init.method || 'GET').toUpperCase();
  let body = init.body ?? null;
  let headers = new Headers(init.headers || undefined);
  const timeoutMs = c.timeoutMs ?? policy.timeoutMs;
  const maxBytes = c.maxBytes ?? DEFAULT_MAX_BYTES;
  const bytesOut = byteLength(body);
  const started = Date.now();
  const deadline = deadlineSignal(init.signal, timeoutMs);
  let decision = null;
  let redirects = 0;
  let recorded = false;
  const record = (fields) => {
    recorded = true;
    recordEgress({ ...baseEvent(c, url, method, decision, started), redirects, bytesOut, bytesIn: null, status: null, reason: null, ...fields });
  };

  try {
    for (;;) {
      const target = { protocol: url.protocol.replace(/:$/, ''), host: normalizeHost(url.hostname), port: url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80) };
      decision = decide(policy, target, c);
      if (!decision.allowed) throw new EgressError(`Salida bloqueada por Pactvm Viridi: ${decision.reason}`, 'denied');

      const res = c.publicWeb
        ? await requestPublic(url, { method, headers, body, signal: deadline.signal })
        : await transport(url.href, { ...init, method, headers, body, signal: deadline.signal, redirect: 'manual' });

      const location = res.headers.get('location');
      if (REDIRECTS.has(res.status) && location && init.redirect !== 'manual') {
        await res.body?.cancel().catch(() => {});
        if (redirects >= MAX_REDIRECTS) throw new EgressError(`más de ${MAX_REDIRECTS} redirecciones`, 'redirects');
        const next = new URL(location, url);
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
          if (method !== 'HEAD') method = 'GET';
          body = null;
          headers.delete('content-type');
          headers.delete('content-length');
        }
        if (next.origin !== url.origin) headers = crossOriginHeaders(headers);
        url = next;
        redirects += 1;
        continue;
      }

      const received = await readBody(res, maxBytes, c.truncate);
      record({ result: res.status < 400 ? 'ok' : 'error', status: res.status, bytesIn: received.byteLength });
      return rebuildResponse(res, received);
    }
  } catch (err) {
    const failure = deadline.timedOut() && !(err instanceof EgressError && err.code !== 'timeout')
      ? new EgressError(`${url.hostname} no respondió en ${timeoutMs} ms`, 'timeout', { cause: err })
      : err;
    if (!recorded) {
      record(isEgressDenied(failure)
        ? { result: 'denegada', reason: decision?.allowed === false ? decision.reason : failure.message }
        : { result: 'error', reason: String(failure?.message || failure).slice(0, 300) });
    }
    throw failure;
  } finally {
    deadline.clear();
  }
}

/** fetch con la firma estándar ligado a un contexto, para módulos que reciben un fetch. */
export function egressFetcher(ctx, options) {
  return (input, init) => egressFetch(input, init, ctx, options);
}

/**
 * Salida que no es HTTP (correo SMTP): se autoriza y registra igual, y `fn`
 * recibe el tiempo máximo para configurar su propio cliente.
 * target: { protocol, host, port, bytesOut? }
 */
export async function egressRun(target, ctx, fn, { env = process.env } = {}) {
  const c = normalizeContext(ctx);
  const policy = egressPolicy(env);
  const t = { protocol: String(target.protocol).replace(/:$/, ''), host: normalizeHost(target.host), port: Number(target.port) };
  const decision = decide(policy, t, c);
  const started = Date.now();
  const record = (fields) => recordEgress({
    at: new Date(started).toISOString(), mesa: c.mesa, user: c.user, poll: c.poll,
    destination: decision.destination?.id ?? null, category: decision.destination?.category ?? null,
    protocol: t.protocol, host: t.host, port: t.port, method: null, path: null, redirects: 0,
    bytesOut: target.bytesOut ?? null, bytesIn: null, status: null, reason: null,
    durationMs: Date.now() - started, ...fields,
  });
  if (!decision.allowed) {
    record({ result: 'denegada', reason: decision.reason });
    throw new EgressError(`Salida bloqueada por Pactvm Viridi: ${decision.reason}`, 'denied');
  }
  try {
    const out = await fn({ timeoutMs: c.timeoutMs ?? policy.timeoutMs });
    record({ result: 'ok' });
    return out;
  } catch (err) {
    record({ result: 'error', reason: String(err?.message || err).slice(0, 300) });
    throw err;
  }
}
