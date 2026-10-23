/**
 * Receptor de informes de la Content-Security-Policy (ver lib/security-headers.js).
 *
 * Ruta publica: el navegador envia los informes sin sesion. Pasa por Sentinel
 * como cualquier otra peticion y tiene limite de tasa propio, por IP y global.
 * Cada infraccion distinta se guarda una sola vez en `csp_reports` con un
 * contador, y el documento caduca CSP_REPORT_TTL_DAYS despues de su ultima
 * aparicion (indice TTL). Las URLs se guardan sin query ni fragmento porque
 * pueden llevar tokens.
 *
 * Formatos aceptados: `report-uri` (application/csp-report, un informe) y
 * Reporting API (application/reports+json, lista de informes).
 */
import crypto from 'node:crypto';
import express from 'express';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { CSP_REPORT_PATH } from '../lib/security-headers.js';

export const CSP_REPORT_TTL_DAYS = 30;
const COLLECTION = 'csp_reports';
const REPORT_TYPES = ['application/csp-report', 'application/reports+json'];
const MAX_REPORTS_PER_REQUEST = 10;
const MAX_URL = 512;

export async function ensureCspReportIndexes(mongo) {
  const col = mongo.collection(COLLECTION);
  await col.createIndex({ key: 1 }, { unique: true });
  await col.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
}

function text(value, max) {
  return typeof value === 'string' && value ? value.slice(0, max) : null;
}

function int(value) {
  const n = Number(value);
  return value !== null && value !== '' && Number.isFinite(n) ? Math.trunc(n) : null;
}

// http(s): origen y ruta. Otros esquemas (blob:, data:, extensiones): solo el
// esquema y el host, que es lo que identifica la infraccion. Las palabras clave
// del navegador (inline, eval...) no son URLs y se guardan tal cual.
export function cleanUrl(value) {
  const raw = text(value, 2048);
  if (!raw) return null;
  let url;
  try { url = new URL(raw); } catch { return raw.slice(0, 64); }
  if (url.protocol === 'http:' || url.protocol === 'https:') return (url.origin + url.pathname).slice(0, MAX_URL);
  return (url.protocol + (url.host ? `//${url.host}` : '')).slice(0, MAX_URL);
}

function fromLegacy(r) {
  return {
    documentUri: cleanUrl(r['document-uri']),
    blockedUri: cleanUrl(r['blocked-uri']),
    directive: text(r['effective-directive'], 64) || text(r['violated-directive'], 256)?.split(' ')[0] || null,
    disposition: text(r.disposition, 16),
    sourceFile: cleanUrl(r['source-file']),
    line: int(r['line-number']),
    column: int(r['column-number']),
    sample: text(r['script-sample'], 80),
  };
}

function fromReportingApi(b) {
  return {
    documentUri: cleanUrl(b.documentURL),
    blockedUri: cleanUrl(b.blockedURL),
    directive: text(b.effectiveDirective, 64),
    disposition: text(b.disposition, 16),
    sourceFile: cleanUrl(b.sourceFile),
    line: int(b.lineNumber),
    column: int(b.columnNumber),
    sample: text(b.sample, 80),
  };
}

export function extractCspReports(body) {
  let reports = [];
  if (Array.isArray(body)) {
    reports = body
      .filter((r) => r && r.type === 'csp-violation' && r.body && typeof r.body === 'object')
      .map((r) => fromReportingApi(r.body));
  } else if (body && typeof body['csp-report'] === 'object' && body['csp-report']) {
    reports = [fromLegacy(body['csp-report'])];
  }
  return reports.filter((r) => r.directive).slice(0, MAX_REPORTS_PER_REQUEST);
}

function reportKey(r) {
  const id = [r.documentUri, r.blockedUri, r.directive, r.sourceFile, r.line, r.column];
  return crypto.createHash('sha256').update(JSON.stringify(id)).digest('hex');
}

// rateLimitStore: contador compartido entre replicas; sin el (pruebas), en memoria.
export function mountCspReport(app, { mongo, rateLimitStore }) {
  const limiterBase = {
    windowMs: 60 * 1000,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Demasiados informes CSP' },
  };
  const perIpLimiter = rateLimit({
    ...limiterBase, limit: 30, keyGenerator: (req) => (req.ip ? ipKeyGenerator(req.ip) : 'anon'),
    store: rateLimitStore?.('csp-ip:'),
  });
  // Techo comun: muchas IPs a la vez no pueden convertir esta ruta en un vertedero de escrituras.
  const sharedLimiter = rateLimit({
    ...limiterBase, limit: 300, keyGenerator: () => 'csp-report',
    store: rateLimitStore?.('csp-all:'),
  });

  const parseJson = express.json({ type: REPORT_TYPES, limit: '16kb' });
  // Un cuerpo invalido o enorme se rechaza aqui: no debe llegar al manejador global de errores,
  // que avisa al Admin de cada error no controlado.
  function parseReport(req, res, next) {
    if (!req.is(REPORT_TYPES)) return res.status(415).end();
    parseJson(req, res, (err) => (err ? res.status(err.status === 413 ? 413 : 400).end() : next()));
  }

  app.post(CSP_REPORT_PATH, perIpLimiter, sharedLimiter, parseReport, async (req, res) => {
    const reports = extractCspReports(req.body);
    if (!reports.length) return res.status(400).end();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + CSP_REPORT_TTL_DAYS * 24 * 60 * 60 * 1000);
    try {
      await mongo.collection(COLLECTION).bulkWrite(reports.map((r) => ({
        updateOne: {
          filter: { key: reportKey(r) },
          update: {
            $setOnInsert: { ...r, firstSeen: now },
            $set: { lastSeen: now, expiresAt },
            $inc: { count: 1 },
          },
          upsert: true,
        },
      })), { ordered: false });
    } catch (err) {
      console.error('[csp-report] no se pudo guardar el informe:', err.message);
    }
    res.status(204).end();
  });
}
