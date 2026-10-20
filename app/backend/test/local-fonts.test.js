/**
 * Tipografias servidas desde el propio sistema: ninguna pagina ni Rëff pide
 * fuentes a terceros, todas las paginas enlazan css/fonts.css y cada archivo
 * que declara ese CSS existe junto a su licencia.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const FRONT = path.join(REPO_ROOT, 'app', 'frontend');
const REFF_CLIENT = path.join(REPO_ROOT, 'Elvi-Ra', 'Mesas', 'Rëff', 'client');
const THIRD_PARTY_FONTS = /fonts\.googleapis\.com|fonts\.gstatic\.com/;

function filesUnder(dir, exts, skipDirs = []) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!skipDirs.includes(entry.name)) out.push(...filesUnder(full, exts, skipDirs));
    } else if (exts.includes(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

test('ni las paginas ni Rëff cargan fuentes de terceros', () => {
  const files = [
    ...filesUnder(FRONT, ['.html', '.css', '.js'], ['vendor']),
    ...filesUnder(REFF_CLIENT, ['.html', '.css', '.ts', '.tsx']),
  ];
  const offenders = files.filter((f) => THIRD_PARTY_FONTS.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(offenders.map((f) => path.relative(REPO_ROOT, f)), []);
});

test('todas las paginas enlazan css/fonts.css', () => {
  const pages = filesUnder(path.join(FRONT, 'pages'), ['.html']);
  assert.ok(pages.length > 0);
  const missing = pages.filter((f) => !fs.readFileSync(f, 'utf8').includes('<link rel="stylesheet" href="/css/fonts.css">'));
  assert.deepEqual(missing.map((f) => path.basename(f)), []);
});

test('cada fuente declarada en css/fonts.css existe, con su licencia', () => {
  const css = fs.readFileSync(path.join(FRONT, 'css', 'fonts.css'), 'utf8');
  const urls = [...css.matchAll(/url\('([^']+)'\)/g)].map((m) => m[1]);
  assert.equal(urls.length, 12);
  for (const url of urls) {
    assert.ok(url.startsWith('/vendor/fonts/') && url.endsWith('.woff2'), url);
    assert.ok(fs.existsSync(path.join(FRONT, url)), `no existe ${url}`);
  }
  assert.ok(fs.existsSync(path.join(FRONT, 'vendor', 'fonts', 'LICENSE-IBM-Plex.txt')));
});
