/**
 * Ningún archivo del backend ni del servidor de Rëff sale a la red por su
 * cuenta: todo pasa por la compuerta de Pactvm Viridi (egress/). Revisa el
 * código fuente en busca de llamadas de red directas. No usa Mongo ni red.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(__dirname, '..');
const REFF_SERVER = path.resolve(BACKEND, '../../Elvi-Ra/Mesas/Rëff/server');

const SKIP_DIRS = new Set(['node_modules', 'dist', 'test', 'data']);
// La compuerta misma, los conectores de IA (reciben por parámetro el fetch de la compuerta) y
// async-errors.js, que importa http solo para leer la lista de métodos.
const ALLOWED = [/^egress\//, /^llm\/providers\//, /^lib\/async-errors\.js$/];

const PATTERNS = [
  [/(?<![\w.$])fetch\s*\(/, 'fetch( directo'],
  [/globalThis\.fetch|\bwindow\.fetch/, 'fetch global'],
  [/\bhttps?\.(request|get)\s*\(/, 'http(s).request/get'],
  [/\bfrom\s+['"](node:)?(https?|http2|net|tls|dgram)['"]/, 'importa un módulo de red'],
  [/\bimport\(\s*['"](node:)?(https?|http2|net|tls|dgram)['"]\s*\)/, 'importa un módulo de red (dinámico)'],
  [/\brequire\(\s*['"](node:)?(https?|http2|net|tls|dgram)['"]\s*\)/, 'requiere un módulo de red'],
  [/\bnet\.(connect|createConnection)\s*\(|\btls\.connect\s*\(/, 'socket directo'],
  [/new\s+(WebSocket|EventSource)\s*\(|XMLHttpRequest/, 'cliente web directo'],
  [/\bundici\b|\baxios\b|\bnode-fetch\b|\bgot\s*\(/, 'cliente HTTP de terceros'],
];

// Archivos que usan el cliente de correo solo para construir el mensaje; el envío va por la compuerta.
const MAILER = { file: 'meeting-mailer.ts', mustUse: /egressRun\(/ };

function* sources(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* sources(path.join(dir, entry.name));
    } else if (/\.(js|mjs|ts)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) {
      yield path.join(dir, entry.name);
    }
  }
}

const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

function offenders(root) {
  const found = [];
  for (const file of sources(root)) {
    const rel = path.relative(root, file).replaceAll('\\', '/');
    if (ALLOWED.some((re) => re.test(rel))) continue;
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    for (const [re, label] of PATTERNS) {
      if (re.test(code)) found.push(`${rel}: ${label}`);
    }
    if (/nodemailer/.test(code) && !(rel === MAILER.file && MAILER.mustUse.test(code))) {
      found.push(`${rel}: correo sin pasar por la compuerta`);
    }
  }
  return found;
}

test('backend: ninguna salida a la red fuera de la compuerta', () => {
  assert.deepEqual(offenders(BACKEND), []);
});

test('servidor de Rëff: ninguna salida a la red fuera de la compuerta', () => {
  assert.ok(fs.existsSync(REFF_SERVER), 'no se encuentra el servidor de Rëff');
  assert.deepEqual(offenders(REFF_SERVER), []);
});

test('la revisión detecta una salida directa', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-scan-'));
  try {
    fs.writeFileSync(path.join(dir, 'malo.js'), "export const x = () => fetch('https://externo.example/');\n");
    fs.writeFileSync(path.join(dir, 'bien.js'), "// fetch('https://comentario.example/')\nexport const y = () => egressFetch('https://ok.example/');\n");
    assert.deepEqual(offenders(dir), ['malo.js: fetch( directo']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
