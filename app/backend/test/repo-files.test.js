/**
 * Archivos que el build o el servidor necesitan y que deben llegar a una
 * instalación limpia desde el repositorio: ninguno puede quedar excluido por
 * una regla de .gitignore. Se salta si git no está disponible.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function git(...args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
}

let gitAvailable = true;
try { git('rev-parse', '--is-inside-work-tree'); } catch { gitAvailable = false; }

test('el código fuente de Rëff no tiene archivos excluidos por .gitignore', { skip: !gitAvailable && 'git no disponible' }, () => {
  // server/data lo copia el build a dist (scripts/copy-server-data.mjs) y geo.routes lo lee al importarse
  const ignored = git('ls-files', '--others', '--ignored', '--exclude-standard', '--', 'Elvi-Ra/Mesas/Rëff/server', 'Elvi-Ra/Mesas/Rëff/client/src')
    .split('\n').filter(Boolean);
  assert.deepEqual(ignored, []);
});
