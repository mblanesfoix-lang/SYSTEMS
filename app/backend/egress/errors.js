/**
 * Fallo de una salida a la red en la compuerta. `code`:
 *   denied     la lista blanca de Pactvm Viridi no la autoriza
 *   timeout    el destino no respondió en el tiempo máximo
 *   too_large  la respuesta supera el tamaño máximo
 *   redirects  demasiadas redirecciones
 */
export class EgressError extends Error {
  constructor(message, code, options) {
    super(message, options);
    this.name = 'EgressError';
    this.code = code;
  }
}

export const isEgressDenied = (err) => err instanceof EgressError && err.code === 'denied';
