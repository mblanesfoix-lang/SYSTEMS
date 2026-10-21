import { LlmError } from '../errors.js';

/**
 * Conector del proveedor de IA externo: Anthropic, API Messages por HTTP.
 * Es el único archivo de SYSTEMS que conoce a este proveedor (dirección,
 * cabeceras, modelos, tarifas, búsqueda web y los nombres antiguos de sus
 * variables). El resto del sistema usa el módulo neutro de llm/index.js, así
 * que el día que haya IA en los servidores propios basta con LLM_PROVIDER=local
 * y este archivo puede borrarse.
 */

const API_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-haiku-4-5';
const WEB_SEARCH_TOOL = 'web_search_20250305';

// Con búsqueda web el proveedor puede pausar el turno (pause_turn) y pedir que
// se reenvíe para continuar; este tope de rondas corta un bucle que no converja.
const MAX_ROUNDS = 8;

// Reintentos ante saturación o fallos transitorios (429, 5xx, red), dentro del
// tiempo máximo de la llamada.
const MAX_RETRIES = 2;
const RETRY_BASE_MS = 500;
const isRetryable = (status) => status === 408 || status === 409 || status === 429 || status >= 500;

// Tarifas públicas en USD por millón de tokens (entrada, salida). LLM_PRICE_*
// las sustituye. Se elige el identificador más largo que encabece el modelo,
// para que los identificadores con fecha hereden la tarifa de su familia.
const PRICES = [
  ['claude-fable-5-1', 10, 50],
  ['claude-fable-5', 10, 50],
  ['claude-opus-5-5', 4, 20],
  ['claude-opus-5', 5, 25],
  ['claude-opus-4-8', 5, 25],
  ['claude-opus-4-7', 5, 25],
  ['claude-opus-4-6', 5, 25],
  ['claude-sonnet-5-5', 2, 10],
  ['claude-sonnet-5', 2, 10],
  ['claude-sonnet-4-6', 3, 15],
  ['claude-haiku-5-5', 0.1, 0.5],
  ['claude-haiku-4-5', 1, 5],
];
const WEB_SEARCH_USD = 10 / 1000;

function pricing(model) {
  const match = PRICES
    .filter(([prefix]) => model === prefix || model.startsWith(`${prefix}-`))
    .sort((a, b) => b[0].length - a[0].length)[0];
  return match ? { inputPerM: match[1], outputPerM: match[2], perWebSearch: WEB_SEARCH_USD } : null;
}

// Valores de plantilla que no son una clave real.
function isUsableKey(key) {
  const k = String(key || '').trim().toLowerCase();
  return !!k && k !== 'sk-ant-...' && !['tu_clave', 'your_key', 'placeholder'].some((s) => k.includes(s));
}

const wait = (ms, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) return reject(signal.reason);
  const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
  signal.addEventListener('abort', onAbort, { once: true });
});

function retryDelay(attempt, retryAfter) {
  const seconds = Number(retryAfter);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : RETRY_BASE_MS * 2 ** attempt;
}

async function postMessages(body, cfg, { fetch, signal, deadline }) {
  for (let attempt = 0; ; attempt++) {
    let r;
    try {
      r = await fetch(`${cfg.url}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': cfg.apiKey,
          'anthropic-version': API_VERSION,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      const delay = retryDelay(attempt);
      if (signal.aborted || attempt >= MAX_RETRIES || Date.now() + delay >= deadline) throw err;
      await wait(delay, signal);
      continue;
    }
    if (r.ok) return r.json();

    const detail = (await r.text().catch(() => '')).slice(0, 400);
    if (isRetryable(r.status) && attempt < MAX_RETRIES) {
      const delay = retryDelay(attempt, r.headers.get('retry-after'));
      if (Date.now() + delay < deadline) {
        await wait(delay, signal);
        continue;
      }
    }
    throw new LlmError(`Proveedor de IA externo ${r.status}: ${detail}`, 'provider');
  }
}

export default {
  name: 'externo',
  defaults: { url: 'https://api.anthropic.com', model: DEFAULT_MODEL },
  requiresKey: true,
  supportsWebSearch: true,
  pricing,
  isUsableKey,

  // Nombres anteriores al módulo neutro: se aceptan con aviso mientras se renombran.
  legacy: {
    providerNames: ['anthropic'],
    env: [
      { name: 'ANTHROPIC_API_KEY', replacement: 'LLM_API_KEY' },
      { name: 'ANTHROPIC_MODEL', replacement: 'LLM_MODEL' },
    ],
  },

  async call(req, cfg, transport) {
    const messages = req.messages.map((m) => ({ role: m.role, content: m.content }));
    const tools = req.webSearch
      ? [{ type: WEB_SEARCH_TOOL, name: 'web_search', max_uses: req.webSearch.maxUses }]
      : undefined;
    const sources = new Map();
    let inputTokens = 0;
    let outputTokens = 0;
    let webSearches = 0;

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const response = await postMessages({
        model: cfg.model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages,
        ...(tools ? { tools } : {}),
      }, cfg, transport);

      inputTokens += response.usage?.input_tokens || 0;
      outputTokens += response.usage?.output_tokens || 0;
      webSearches += response.usage?.server_tool_use?.web_search_requests || 0;

      const content = Array.isArray(response.content) ? response.content : [];
      for (const block of content) {
        // Un error de la búsqueda llega como objeto en lugar de lista: no aporta fuentes.
        if (block.type !== 'web_search_tool_result' || !Array.isArray(block.content)) continue;
        for (const item of block.content) {
          if (item.type === 'web_search_result' && item.url && !sources.has(item.url)) {
            sources.set(item.url, { url: item.url, title: item.title ?? null });
          }
        }
      }

      if (response.stop_reason === 'pause_turn') {
        messages.push({ role: 'assistant', content });
        continue;
      }

      const parts = content.filter((b) => b.type === 'text').map((b) => b.text);
      return {
        text: parts.join('').trim(),
        parts,
        inputTokens,
        outputTokens,
        webSearches,
        sources: [...sources.values()],
        truncated: response.stop_reason === 'max_tokens',
      };
    }
    throw new LlmError('La búsqueda asistida no terminó tras varias rondas; inténtalo de nuevo', 'incomplete');
  },
};
