/**
 * Las paginas cumplen la CSP impuesta en lib/security-headers.js: ningun
 * <script> en linea ni atributo on...= en el HTML, ningun manejador en linea
 * dentro de las plantillas que generan HTML desde JS, nada de eval, y cada
 * script referenciado existe.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const FRONT = path.join(REPO_ROOT, 'app', 'frontend');
const PAGES = path.join(FRONT, 'pages');

const pages = fs.readdirSync(PAGES).filter((f) => f.endsWith('.html')).sort();
const read = (file) => fs.readFileSync(file, 'utf8');
const withoutComments = (html) => html.replace(/<!--[\s\S]*?-->/g, '');

function jsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}
const frontendJs = jsFiles(path.join(FRONT, 'js'));

test('hay paginas que revisar', () => {
  assert.ok(pages.length >= 25, `solo ${pages.length} paginas`);
});

test('ninguna pagina lleva <script> en linea', () => {
  const offenders = [];
  for (const page of pages) {
    const tags = [...withoutComments(read(path.join(PAGES, page))).matchAll(/<script\b([^>]*)>/gi)];
    for (const [tag, attrs] of tags) if (!/\ssrc=/.test(attrs)) offenders.push(`${page}: ${tag}`);
  }
  assert.deepEqual(offenders, []);
});

test('ninguna pagina lleva atributos on...= en su HTML', () => {
  const offenders = [];
  for (const page of pages) {
    const markup = withoutComments(read(path.join(PAGES, page)));
    for (const [, attr] of markup.matchAll(/<[a-z][^>]*?\s(on[a-z]+)\s*=/gi)) offenders.push(`${page}: ${attr}`);
  }
  assert.deepEqual(offenders, []);
});

test('cada <script src> de las paginas apunta a un archivo existente', () => {
  const missing = [];
  for (const page of pages) {
    for (const [, src] of read(path.join(PAGES, page)).matchAll(/<script\b[^>]*\ssrc="([^"]+)"/gi)) {
      if (!fs.existsSync(path.join(FRONT, src))) missing.push(`${page}: ${src}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('el JS del frontend no genera manejadores en linea, URLs javascript: ni eval', () => {
  const rules = [
    [/\son[a-z]+\s*=\s*["'\\]/, 'manejador on...= en una plantilla'],
    [/javascript:/i, 'URL javascript:'],
    [/(^|[^.\w])eval\s*\(|new\s+Function\s*\(/, 'eval o new Function'],
    [/setAttribute\(\s*['"]on/, 'setAttribute de un manejador'],
  ];
  const offenders = [];
  for (const file of frontendJs) {
    read(file).split('\n').forEach((line, i) => {
      for (const [re, label] of rules) {
        if (re.test(line)) offenders.push(`${path.relative(FRONT, file)}:${i + 1} ${label}`);
      }
    });
  }
  assert.deepEqual(offenders, []);
});
