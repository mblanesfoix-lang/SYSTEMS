/**
 * LLM abstraction layer — swap provider via env vars, zero code changes elsewhere.
 *
 * LLM_PROVIDER = "anthropic" (default) | "ollama"
 * OLLAMA_URL   = http://ollama:11434    (default)
 * OLLAMA_MODEL = llama3:70b             (default)
 * ANTHROPIC_API_KEY / ANTHROPIC_MODEL   (when provider=anthropic)
 */

// Leidos perezosamente en cada llamada: server.js inyecta el .env de Rëff
// (ANTHROPIC_API_KEY) DESPUES de importar este modulo.
const PROVIDER       = () => process.env.LLM_PROVIDER    || 'anthropic';
const OLLAMA_URL     = () => process.env.OLLAMA_URL      || 'http://ollama:11434';
const OLLAMA_MODEL   = () => process.env.OLLAMA_MODEL    || 'llama3:70b';
const ANTHROPIC_KEY  = () => process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL = () => process.env.ANTHROPIC_MODEL || 'claude-opus-4-7';

// Pricing per 1M tokens (only relevant for Anthropic — Ollama is $0)
export const PRICE_INPUT_PER_M  = 15;
export const PRICE_OUTPUT_PER_M = 75;
export { ANTHROPIC_MODEL };

/**
 * Single-shot LLM call. Returns the full response text.
 * Works with both Anthropic and Ollama (OpenAI-compatible chat endpoint).
 *
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {number} maxTokens
 * @returns {{ text: string, inputTokens: number, outputTokens: number }}
 */
export async function callLLM(systemPrompt, userPrompt, maxTokens = 4096) {
  if (PROVIDER() === 'ollama') {
    return _callOllama(systemPrompt, userPrompt, maxTokens);
  }
  return _callAnthropic(systemPrompt, userPrompt, maxTokens);
}

async function _callAnthropic(systemPrompt, userPrompt, maxTokens) {
  if (!ANTHROPIC_KEY()) throw new Error('ANTHROPIC_API_KEY no configurada');

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_KEY(),
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL(),
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Anthropic ${r.status}: ${t.slice(0, 400)}`);
  }

  const data = await r.json();
  const text = (data.content || []).map(b => b.text || '').join('').trim();
  return {
    text,
    inputTokens:  data.usage?.input_tokens  || 0,
    outputTokens: data.usage?.output_tokens || 0,
  };
}

async function _callOllama(systemPrompt, userPrompt, maxTokens) {
  // Ollama /api/chat — OpenAI-compatible messages format
  const r = await fetch(`${OLLAMA_URL()}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL(),
      stream: false,
      options: { num_predict: maxTokens },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt },
      ],
    }),
  });

  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Ollama ${r.status}: ${t.slice(0, 400)}`);
  }

  const data = await r.json();
  const text = (data.message?.content || '').trim();

  // Ollama token counts (eval_count = output, prompt_eval_count = input)
  return {
    text,
    inputTokens:  data.prompt_eval_count || 0,
    outputTokens: data.eval_count        || 0,
  };
}
