import { LlmError } from './errors.js';
import { costOf } from './usage.js';
import { resolveLlmConfig, unavailableReason } from './config.js';
import { egressFetch, isEgressDenied } from '../egress/index.js';

export { LlmError };
export {
  PROVIDER_NAMES, RENAMED_VARS, providerName, resolveLlmConfig, llmStatus, legacyNotices,
} from './config.js';

/** La IA no está configurada o no ofrece lo pedido: es un aviso de configuración, no una avería. */
export const isLlmUnavailable = (err) => err instanceof LlmError && err.code === 'unavailable';

/**
 * Módulo único de IA del proceso: lo usan las mesas del backend y Rëff, que
 * comparten proceso, con la misma configuración (config.js) y la misma
 * contabilidad. Las llamadas salen por la compuerta de Pactvm Viridi
 * (egress/) con la mesa que las pide: el proveedor externo solo atiende a las
 * mesas autorizadas a enviarle datos; el local, a cualquiera.
 */

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_WEB_SEARCH_USES = 3;
// La compuerta corta algo después que la IA, para que el tiempo agotado lo informe la IA.
const EGRESS_TIMEOUT_MARGIN_MS = 1000;

/* ---------- llamada ---------- */

let usageRecorder = null;

/** Recibe el consumo de cada llamada que lleva usuario (T'Controler). Si falla, la llamada no se ve afectada. */
export function setUsageRecorder(recorder) {
  usageRecorder = typeof recorder === 'function' ? recorder : null;
}

function recordUsage(req, result) {
  if (!usageRecorder || !req.user) return;
  const logFailure = (err) => console.error('[llm] no se pudo registrar el consumo:', err?.message || err);
  try {
    const pending = usageRecorder({
      user: req.user,
      operation: req.operation,
      provider: result.provider,
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      webSearches: result.webSearches,
      costUsd: result.costUsd,
      at: new Date().toISOString(),
    });
    if (pending && typeof pending.catch === 'function') pending.catch(logFailure);
  } catch (err) {
    logFailure(err);
  }
}

function normalizeRequest(request) {
  const r = request || {};
  if (typeof r.system !== 'string') throw new TypeError('callLlm: system debe ser un texto');
  if (typeof r.mesa !== 'string' || !r.mesa.trim()) throw new TypeError('callLlm: falta la mesa que hace la llamada');
  const messages = Array.isArray(r.messages)
    ? r.messages
    : (typeof r.prompt === 'string' ? [{ role: 'user', content: r.prompt }] : null);
  if (!messages?.length || messages.some((m) => !['user', 'assistant'].includes(m?.role) || typeof m.content !== 'string')) {
    throw new TypeError('callLlm: hace falta prompt o messages (role user o assistant, content texto)');
  }
  const uses = Number(r.webSearch?.maxUses);
  return {
    system: r.system,
    messages,
    maxTokens: Number.isInteger(r.maxTokens) && r.maxTokens > 0 ? r.maxTokens : DEFAULT_MAX_TOKENS,
    webSearch: r.webSearch ? { maxUses: Number.isInteger(uses) && uses > 0 ? uses : DEFAULT_WEB_SEARCH_USES } : null,
    timeoutMs: Number.isFinite(r.timeoutMs) && r.timeoutMs > 0 ? r.timeoutMs : null,
    mesa: r.mesa.trim(),
    user: r.user ? String(r.user) : null,
    operation: r.operation ? String(r.operation) : 'general',
  };
}

/**
 * Llamada a la IA configurada.
 *   request: { system, prompt | messages, mesa, maxTokens?, webSearch?: { maxUses }, timeoutMs?, user?, operation? }
 *   devuelve: { text, parts, inputTokens, outputTokens, webSearches, sources, truncated, provider, model, costUsd }
 * `mesa` es la que envía los datos (política de salida de Pactvm Viridi).
 * `user` y `operation` alimentan la contabilidad; sin `user` no se registra.
 * Los fallos llegan como LlmError con su `code`; la salida denegada, como `unavailable`.
 * `options.fetch` sustituye al transporte de red de la compuerta (pruebas).
 */
export async function callLlm(request, { env = process.env, fetch } = {}) {
  const req = normalizeRequest(request);
  const cfg = resolveLlmConfig(env);
  const reason = unavailableReason(cfg);
  if (reason) throw new LlmError(reason, 'unavailable');
  if (req.webSearch && !cfg.provider.supportsWebSearch) {
    throw new LlmError(`La búsqueda asistida en la web no está disponible con el proveedor ${cfg.name}`, 'unavailable');
  }

  const timeoutMs = req.timeoutMs ?? cfg.timeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const egress = { mesa: req.mesa, user: req.user, timeoutMs: timeoutMs + EGRESS_TIMEOUT_MARGIN_MS };
  // Una salida denegada no se reintenta: se corta la llamada entera.
  const transport = (url, init) => egressFetch(url, init, egress, { env, ...(fetch ? { fetch } : {}) })
    .catch((err) => {
      if (isEgressDenied(err)) controller.abort(err);
      throw err;
    });
  let out;
  try {
    out = await cfg.provider.call(req, cfg, { fetch: transport, signal: controller.signal, deadline: Date.now() + timeoutMs });
  } catch (err) {
    if (isEgressDenied(err)) throw new LlmError(err.message, 'unavailable', { cause: err });
    if (controller.signal.aborted) throw new LlmError(`La IA no respondió en ${timeoutMs} ms`, 'timeout', { cause: err });
    if (err instanceof LlmError) throw err;
    throw new LlmError(`No se pudo contactar con el servicio de IA (${cfg.name}): ${err?.message || err}`, 'provider', { cause: err });
  } finally {
    clearTimeout(timer);
  }

  const result = { ...out, provider: cfg.name, model: cfg.model, costUsd: costOf(cfg.pricing, out) };
  recordUsage(req, result);
  return result;
}
