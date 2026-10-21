/**
 * Comparación de secretos (tokens, firmas, códigos) en tiempo constante.
 *
 * Con === la comparación se corta en el primer carácter distinto y el tiempo de
 * respuesta delata cuántos coinciden. Aquí se comparan los sha256 de ambos valores
 * (siempre 32 bytes) con crypto.timingSafeEqual: mismo tiempo acierte o no, y sin
 * revelar tampoco la longitud del secreto. Lo que no sea texto o Buffer nunca coincide.
 */
import crypto from 'node:crypto';

const comparable = (v) => typeof v === 'string' || Buffer.isBuffer(v);
const digest = (v) => crypto.createHash('sha256').update(v).digest();

export function safeEqual(a, b) {
  if (!comparable(a) || !comparable(b)) return false;
  return crypto.timingSafeEqual(digest(a), digest(b));
}
