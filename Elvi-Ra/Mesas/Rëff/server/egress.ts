/**
 * Puente de Rëff a la compuerta de salida del proceso (app/backend/egress). Toda
 * llamada de Rëff a otra máquina pasa por ella: lista blanca y registro de
 * Pactvm Viridi. Integrado en el backend, server.js lo conecta con
 * setEgressClient; en modo independiente no hay salida a la red.
 */

export interface EgressContext {
  user?: string | null;
  /** Página pública que cita un usuario: solo http(s) estándar y nunca redes privadas. */
  publicWeb?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
  /** Con maxBytes, corta la respuesta en vez de fallar. */
  truncate?: boolean;
}

export interface EgressTarget {
  protocol: string;
  host: string;
  port: number;
  bytesOut?: number;
}

export interface EgressClient {
  fetch: (url: string, init: RequestInit, ctx: EgressContext) => Promise<Response>;
  run: <T>(target: EgressTarget, ctx: EgressContext, fn: (opts: { timeoutMs: number }) => Promise<T>) => Promise<T>;
}

/** Error con el mismo `code` que los de la compuerta (denied, timeout, too_large, redirects, unavailable). */
export class EgressUnavailableError extends Error {
  readonly code = 'unavailable';
}

const STANDALONE_REASON = 'Salida a la red no disponible: Rëff solo la tiene integrada en el backend';

let client: EgressClient | null = null;

export function setEgressClient(next: EgressClient | null): void {
  client = next;
}

export function egressFetch(url: string, init: RequestInit, ctx: EgressContext = {}): Promise<Response> {
  if (!client) return Promise.reject(new EgressUnavailableError(STANDALONE_REASON));
  return client.fetch(url, init, ctx);
}

export function egressRun<T>(target: EgressTarget, ctx: EgressContext, fn: (opts: { timeoutMs: number }) => Promise<T>): Promise<T> {
  if (!client) return Promise.reject(new EgressUnavailableError(STANDALONE_REASON));
  return client.run(target, ctx, fn);
}

export function egressErrorCode(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}
