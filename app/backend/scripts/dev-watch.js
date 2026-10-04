#!/usr/bin/env node
/**
 * Lanza server.js con --watch, pero solo vigilando el codigo: `node --watch`
 * sin --watch-path vigila TODO el cwd recursivo, incluida data/ — y el
 * propio servidor escribe ahi (bus_history.json, notificaciones, etc.) cada
 * pocos segundos, lo que provoca un bucle de reinicio continuo que corta
 * las peticiones a medio vuelo (ver docs/ESTADO-HISTORICO.md 2026-10-05).
 *
 * Node no tiene forma de EXCLUIR un subdirectorio del watch por defecto
 * (no hay --watch-ignore), asi que en vez de listar cada archivo de mesa a
 * mano en package.json (fragil: una mesa nueva se queda sin vigilar hasta
 * acordarse de tocar el script), se genera la lista de --watch-path en cada
 * arranque a partir de lo que de verdad hay en el directorio, excluyendo
 * data/, test/, scripts/ y node_modules/.
 *
 * BUG aislado y reproducido 2026-10-05 en Node v24.14.1 (Windows): pasar
 * --env-file=.env en el MISMO comando que --watch-path hace que --watch-path
 * se ignore por completo (vigila el cwd entero igual que sin el flag, aunque
 * solo apunte a un unico archivo). Confirmado con un script minimo de 2
 * lineas sin relacion con este proyecto: con --env-file reinicia en cuanto
 * un archivo NO vigilado cambia, sin el flag no reinicia nunca. Por eso aqui
 * NO se pasa --env-file al hijo: las variables de .env se cargan con
 * process.loadEnvFile() en ESTE proceso (la misma funcion que usa --env-file
 * por debajo) y se inyectan en process.env del hijo via spawn({ env }).
 */
import { readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = path.join(__dirname, '..');

const SKIP_DIRS = new Set(['data', 'node_modules', 'test', 'scripts', '.git']);

function watchPaths() {
  const paths = [];
  for (const entry of readdirSync(BACKEND_DIR, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) paths.push(entry.name);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      paths.push(entry.name);
    }
  }
  return paths;
}

process.loadEnvFile(path.join(BACKEND_DIR, '.env'));

const paths = watchPaths();
const args = [
  ...paths.map((p) => `--watch-path=${p}`),
  'server.js',
];

console.log(`[dev-watch] vigilando ${paths.length} rutas de codigo (data/ excluida, .env cargado sin --env-file)`);
const child = spawn(process.execPath, args, { cwd: BACKEND_DIR, stdio: 'inherit', env: process.env });
child.on('exit', (code) => process.exit(code ?? 0));
