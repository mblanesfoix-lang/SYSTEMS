#!/usr/bin/env node
/**
 * Regenera desde el inventario de config.js los archivos que describen la
 * configuración, para que no se desincronicen del código:
 *   - app/backend/.env.example y Elvi-Ra/Mesas/Rëff/.env.example (completos)
 *   - docker-compose.yml, k8s/01-configmap.yaml y k8s/02-secrets.example.yaml
 *     (solo el bloque entre marcas; el resto del archivo se mantiene a mano)
 *
 * Uso: npm run config:sync   escribe los archivos
 *      npm run config:check  solo comprueba; sale con 1 si alguno está desactualizado
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GROUPS, VARS, PLATFORM_VARS, TOOL_VARS, BUILD_VARS, OBSOLETE_VARS } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '../../..');

export const BLOCK_START = '# >>> bloque generado desde app/backend/config.js (npm run config:sync); no editar a mano';
export const BLOCK_END = '# <<< fin del bloque generado';

const WRAP = 78;
const REFF_OBSOLETE = new Set(['SERPAPI_KEY', 'DB_PATH']);

function wrapComment(text, width = WRAP) {
  const lines = [];
  let line = '#';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line.length > 1 && line.length + 1 + word.length > width) {
      lines.push(line);
      line = '#';
    }
    line += ` ${word}`;
  }
  if (line.length > 1) lines.push(line);
  return lines;
}

function sectionTitle(title) {
  const head = `# ── ${title} `;
  return head + '─'.repeat(Math.max(3, WRAP - head.length));
}

const sentence = (s) => (/[.!?]$/.test(s) ? s : `${s}.`);

// Rëff puede redefinir descripción, valor por defecto y ayuda de una variable compartida.
const forTarget = (v, target) => (target === 'reff' && typeof v.reff === 'object' ? { ...v, ...v.reff } : v);

function describe(v) {
  let status;
  if (v.required) status = 'Obligatoria en producción.';
  else if (v.requiredIf) status = `Obligatoria si ${v.requiredIf.text}.`;
  else status = v.def ? `Opcional; por defecto, ${v.def}.` : 'Opcional.';
  const parts = [`${v.name}: ${sentence(v.desc)}`, status];
  if (v.hint) parts.push(sentence(v.hint));
  return parts.join(' ');
}

// Las obligatorias y las contraseñas iniciales quedan activas y vacías para rellenarlas;
// el resto, comentadas, con su valor de despliegue como ejemplo si no es secreta.
function varLines(base, target) {
  const v = forTarget(base, target);
  const active = v.required || v.group === 'seed';
  const example = v.secret ? '' : ((target === 'reff' && base.reff?.def) || (base.deploy ?? ''));
  return [...wrapComment(describe(v)), active ? `${v.name}=` : `# ${v.name}=${example}`];
}

function groupedLines(vars, target) {
  const out = [];
  for (const g of GROUPS) {
    const inGroup = vars.filter((v) => v.group === g.id);
    if (!inGroup.length) continue;
    out.push('', sectionTitle(g.title));
    for (const v of inGroup) out.push(...varLines(v, target));
  }
  return out;
}

const listText = (items) => items.map((i) => `${i.name} (${i.desc ?? i.reason})`).join('; ');

export function renderBackendEnvExample() {
  return [
    '# Configuración de SYSTEMS: backend y Rëff integrado, que corren en el mismo proceso.',
    '# Generado desde app/backend/config.js con npm run config:sync; no editar a mano.',
    '#',
    ...wrapComment('Uso: en desarrollo o sin Docker, copiar a app/backend/.env y rellenar. Con docker compose, copiar a .env en la raíz del repositorio (scripts/setup-env.sh lo hace y genera las claves).'),
    ...wrapComment('Producción: todo llega por variables de entorno (panel de Coolify, .env raíz de docker compose, ConfigMap y Secret de k8s). Con NODE_ENV=production el servidor no arranca si falta una obligatoria o tiene un formato inválido, y las lista todas a la vez; fuera de producción solo avisa.'),
    ...wrapComment('Solo en desarrollo server.js lee además Elvi-Ra/Mesas/Rëff/.env. Manda lo ya definido en el entorno, después este archivo y por último el de Rëff. En producción el .env de Rëff no se lee.'),
    '# Nunca poner valores reales en un archivo versionado.',
    ...groupedLines(VARS, 'backend'),
    '',
    sectionTitle('Otras variables (no van en este archivo)'),
    ...wrapComment(`Las inyecta la plataforma: ${listText(PLATFORM_VARS)}.`),
    ...wrapComment(`Solo herramientas: ${listText(TOOL_VARS)}.`),
    ...wrapComment(`Obsoletas, el servidor avisa si aparecen: ${listText(OBSOLETE_VARS)}.`),
    '',
  ].join('\n');
}

export function renderReffEnvExample() {
  return [
    '# Configuración de Rëff.',
    '# Generado desde app/backend/config.js con npm run config:sync; no editar a mano.',
    '#',
    ...wrapComment('Integrado en el backend (lo habitual): server.js lee este archivo solo en desarrollo, después del entorno y de app/backend/.env, que tienen prioridad. En producción todo llega por variables de entorno; la lista completa está en app/backend/.env.example.'),
    ...wrapComment('En modo independiente (npm run dev:server) lo lee dotenv.'),
    '# Nunca poner valores reales en un archivo versionado.',
    ...groupedLines(VARS.filter((v) => v.reff), 'reff'),
    '',
    sectionTitle('Otras variables (no van en este archivo)'),
    ...wrapComment(`Build del cliente, en el entorno de npm run build: ${listText(BUILD_VARS)}.`),
    ...wrapComment(`Obsoletas: ${listText(OBSOLETE_VARS.filter((o) => REFF_OBSOLETE.has(o.name)))}.`),
    '',
  ].join('\n');
}

function composeValue(v) {
  if (v.fixed !== undefined) return v.fixed;
  if (v.deploy !== undefined) return `\${${v.name}:-${v.deploy}}`;
  if (v.required) return `\${${v.name}:?}`;
  return `\${${v.name}:-}`;
}

function blockLines(vars, renderLine) {
  const out = [];
  for (const g of GROUPS) {
    const inGroup = vars.filter((v) => v.group === g.id);
    if (!inGroup.length) continue;
    out.push(`# ${g.title}`);
    for (const v of inGroup) out.push(renderLine(v));
  }
  return out;
}

const generated = VARS.filter((v) => !v.manual && !v.localOnly);

export function composeBlock() {
  return blockLines(generated, (v) => `${v.name}: ${composeValue(v)}`);
}

export function configMapBlock() {
  return blockLines(generated.filter((v) => !v.secret),
    (v) => (v.deploy !== undefined ? `${v.name}: "${v.deploy}"` : `# ${v.name}: ""`));
}

export function secretBlock() {
  return blockLines(generated.filter((v) => v.secret),
    (v) => `${v.name}: "${v.required ? 'CAMBIAR' : ''}"`);
}

/** Sustituye las líneas entre las marcas, con la sangría de la marca de inicio. */
export function replaceBlock(text, lines) {
  const all = text.split('\n');
  const start = all.findIndex((l) => l.trim() === BLOCK_START);
  const end = all.findIndex((l, i) => i > start && l.trim() === BLOCK_END);
  if (start < 0 || end < 0) throw new Error('faltan las marcas del bloque generado');
  const indent = all[start].match(/^\s*/)[0];
  return [...all.slice(0, start + 1), ...lines.map((l) => indent + l), ...all.slice(end)].join('\n');
}

export const TARGETS = [
  { file: 'app/backend/.env.example', render: () => renderBackendEnvExample() },
  { file: 'Elvi-Ra/Mesas/Rëff/.env.example', render: () => renderReffEnvExample() },
  { file: 'docker-compose.yml', render: (cur) => replaceBlock(cur, composeBlock()) },
  { file: 'k8s/01-configmap.yaml', render: (cur) => replaceBlock(cur, configMapBlock()) },
  { file: 'k8s/02-secrets.example.yaml', render: (cur) => replaceBlock(cur, secretBlock()) },
];

const readText = (abs) => (fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n') : '');

/** Archivos cuyo contenido no coincide con lo que genera el inventario. */
export function outdatedTargets() {
  return TARGETS.filter(({ file, render }) => {
    const current = readText(path.join(REPO_ROOT, file));
    return render(current) !== current;
  }).map((t) => t.file);
}

function main() {
  if (process.argv.includes('--check')) {
    const outdated = outdatedTargets();
    if (outdated.length) {
      console.error(`[config] desactualizados respecto a config.js (ejecutar npm run config:sync):\n${outdated.map((f) => `  - ${f}`).join('\n')}`);
      process.exit(1);
    }
    console.log('[config] todos los archivos de configuración están al día');
    return;
  }
  for (const { file, render } of TARGETS) {
    const abs = path.join(REPO_ROOT, file);
    const current = readText(abs);
    const next = render(current);
    if (next !== current) {
      fs.writeFileSync(abs, next);
      console.log(`[config] actualizado ${file}`);
    }
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath.toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) main();
