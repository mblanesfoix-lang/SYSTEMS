import { LlmError } from '../errors.js';

/**
 * Servidor de modelos propio (Ollama, API /api/chat), el de los servidores de
 * S-NFI. Sin búsqueda web: el modelo local no sale a internet. Sin coste por
 * llamada.
 */
export default {
  name: 'local',
  defaults: { url: 'http://ollama:11434', model: 'llama3:70b' },
  requiresKey: false,
  supportsWebSearch: false,
  pricing: () => ({ inputPerM: 0, outputPerM: 0, perWebSearch: 0 }),

  async call(req, cfg, { fetch, signal }) {
    const r = await fetch(`${cfg.url}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: cfg.model,
        stream: false,
        options: { num_predict: req.maxTokens },
        messages: [{ role: 'system', content: req.system }, ...req.messages],
      }),
      signal,
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      throw new LlmError(`Servidor de IA local ${r.status}: ${detail.slice(0, 400)}`, 'provider');
    }

    const data = await r.json();
    const text = (data.message?.content || '').trim();
    return {
      text,
      parts: [text],
      inputTokens: data.prompt_eval_count || 0,
      outputTokens: data.eval_count || 0,
      webSearches: 0,
      sources: [],
      truncated: false,
    };
  },
};
