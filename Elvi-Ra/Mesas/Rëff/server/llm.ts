/**
 * Puente de Rëff al módulo de IA del proceso (app/backend/llm). Integrado en el
 * backend, server.js lo conecta con setLlmClient y Rëff comparte configuración
 * y contabilidad con el resto de mesas. En modo independiente no hay IA.
 */

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LlmRequest {
  system: string;
  prompt?: string;
  messages?: LlmMessage[];
  maxTokens?: number;
  webSearch?: { maxUses: number };
  timeoutMs?: number;
  /** Usuario al que se imputa el consumo; sin él no se registra. */
  user?: string | null;
  operation?: string;
}

export interface LlmSource {
  url: string;
  title: string | null;
}

export interface LlmResult {
  text: string;
  /** Bloques de texto tal como llegan del proveedor. */
  parts: string[];
  inputTokens: number;
  outputTokens: number;
  webSearches: number;
  sources: LlmSource[];
  /** La respuesta se cortó por el límite de tokens. */
  truncated: boolean;
  provider: string;
  model: string;
}

export interface LlmStatus {
  available: boolean;
  webSearch: boolean;
  reason: string | null;
}

export interface LlmClient {
  call: (request: LlmRequest) => Promise<LlmResult>;
  status: () => LlmStatus;
}

/** Error con el mismo `code` que los del módulo de IA (unavailable, timeout, provider, incomplete). */
export class LlmUnavailableError extends Error {
  readonly code = 'unavailable';
}

const STANDALONE_REASON = 'IA no disponible: Rëff solo la tiene integrado en el backend';

let client: LlmClient | null = null;

export function setLlmClient(next: LlmClient | null): void {
  client = next;
}

export function llmStatus(): LlmStatus {
  return client ? client.status() : { available: false, webSearch: false, reason: STANDALONE_REASON };
}

export async function callLlm(request: LlmRequest): Promise<LlmResult> {
  if (!client) throw new LlmUnavailableError(STANDALONE_REASON);
  return client.call(request);
}

/** La IA no está configurada o no ofrece lo pedido: aviso de configuración, no avería. */
export function isLlmUnavailable(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'unavailable';
}
