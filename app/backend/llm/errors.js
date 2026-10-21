/**
 * Error de una llamada a la IA. `code` permite a cada mesa elegir su respuesta
 * sin leer el mensaje:
 *   unavailable  sin proveedor, sin clave o sin la capacidad pedida (búsqueda web)
 *   timeout      el proveedor no respondió a tiempo
 *   provider     el proveedor respondió con un error o no se pudo contactar
 *   incomplete   el proveedor no terminó la respuesta
 */
export class LlmError extends Error {
  constructor(message, code, options) {
    super(message, options);
    this.name = 'LlmError';
    this.code = code;
  }
}
