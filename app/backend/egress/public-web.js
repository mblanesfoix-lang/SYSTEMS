import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';
import { Readable, pipeline } from 'node:stream';
import { EgressError } from './errors.js';

/**
 * Descarga de páginas públicas cuya dirección escribe un usuario (auditoría
 * Herzog de Rëff). La dirección se comprueba al conectar, con la IP que de
 * verdad se usa: una máquina que resuelve a una red privada, local o reservada
 * se rechaza aunque su nombre parezca público, y cada redirección vuelve a pasar
 * por aquí.
 */

const BLOCKED = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) BLOCKED.addSubnet(address, prefix, 'ipv4');
// ::/96 incluye :: y ::1. Las IPv4 mapeadas (::ffff:a.b.c.d) se comprueban con las reglas IPv4; NAT64,
// 6to4 y Teredo llevan una IPv4 dentro y se rechazan enteras.
for (const [address, prefix] of [
  ['::', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64],
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
]) BLOCKED.addSubnet(address, prefix, 'ipv6');

export function isPublicAddress(ip) {
  const family = net.isIP(ip);
  if (!family) return false;
  return !BLOCKED.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa'];

/** Motivo por el que una máquina no es un destino público, o null. Sin DNS: eso se comprueba al conectar. */
export function nonPublicHostReason(host) {
  const bare = String(host).replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIP(bare)) return isPublicAddress(bare) ? null : 'dirección no pública';
  if (!bare.includes('.') || bare === 'localhost' || LOCAL_SUFFIXES.some((s) => bare.endsWith(s))) return 'máquina de red local';
  return null;
}

export function guardedLookup(hostname, options, callback) {
  const opts = typeof options === 'number' ? { family: options } : { ...options };
  dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) return callback(err);
    if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address))) {
      return callback(new EgressError(`${hostname} resuelve a una dirección no pública`, 'denied'));
    }
    if (opts.all) return callback(null, addresses);
    return callback(null, addresses[0].address, addresses[0].family);
  });
}

const NULL_BODY = new Set([101, 103, 204, 205, 304]);
const DECODERS = { gzip: zlib.createGunzip, 'x-gzip': zlib.createGunzip, deflate: zlib.createInflate, br: zlib.createBrotliDecompress };

function responseHeaders(raw) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(name, v));
    else if (value !== undefined) headers.set(name, String(value));
  }
  return headers;
}

/** Una petición sin seguir redirecciones (las sigue la compuerta). Devuelve un Response estándar. */
export function requestPublic(url, { method, headers, body, signal }) {
  const reason = nonPublicHostReason(url.hostname);
  if (reason) return Promise.reject(new EgressError(`${url.hostname}: ${reason}`, 'denied'));
  const client = url.protocol === 'https:' ? https : http;
  const outgoing = Object.fromEntries(headers.entries());
  if (!outgoing['accept-encoding']) outgoing['accept-encoding'] = 'identity';

  return new Promise((resolve, reject) => {
    const req = client.request(url, { method, headers: outgoing, lookup: guardedLookup, signal }, (res) => {
      const status = res.statusCode;
      if (!(status >= 200 && status <= 599)) {
        res.resume();
        return reject(new Error(`respuesta HTTP no válida (${status})`));
      }
      const resHeaders = responseHeaders(res.headers);
      if (NULL_BODY.has(status) || method === 'HEAD') {
        res.resume();
        return resolve(new Response(null, { status, statusText: res.statusMessage, headers: resHeaders }));
      }
      let stream = res;
      const decoder = DECODERS[String(res.headers['content-encoding'] || '').toLowerCase()];
      if (decoder) {
        stream = pipeline(res, decoder(), () => {});
        resHeaders.delete('content-encoding');
        resHeaders.delete('content-length');
      }
      resolve(new Response(Readable.toWeb(stream), { status, statusText: res.statusMessage, headers: resHeaders }));
    });
    req.on('error', reject);
    req.end(body ?? undefined);
  });
}
