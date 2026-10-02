#!/usr/bin/env node
/**
 * Optimiza los .glb crudos exportados desde SketchUp para el visor de maquinaria 3D
 * (app/frontend/js/machine-viewer.js, hoy en la seccion PAIA de ØPHS).
 *
 * Por que: SketchUp exporta una primitiva y un material por cara. El Pelletizator crudo trae
 * 21.257 primitivas, 20.456 materiales y 26.877 draw calls por pasada, cuando solo hay 12
 * materiales distintos. En el navegador eso da ~3 fps, bloquea el hilo principal varios
 * segundos al parsear y acaba colgando o matando la pestana.
 *
 * Que hace (sin pasos con perdida: no toca vertices, normales, UVs, texturas ni colores):
 *   dedup    fusiona materiales y texturas identicos (ignora el nombre)
 *   flatten  aplana la jerarquia de nodos (hornea las transformaciones)
 *   join     fusiona las primitivas que comparten material -> decenas de draw calls
 *   prune    elimina lo que quede sin usar (mantiene las texturas de color solido tal cual)
 * Antes de escribir comprueba que la geometria es equivalente (triangulos, area y segmentos
 * por material, bounding box). Si no lo es, NO escribe ese archivo y sale con error.
 *
 * Uso (desde app/assets-src):
 *   npm install                          una vez
 *   npm run optimize                     todos los .glb de models/
 *   npm run optimize -- bio-grinder.glb  solo los indicados
 *
 * Entrada: app/assets-src/models/*.glb          crudos de SketchUp, no se sirven ni se modifican
 * Salida:  app/frontend/vendor/models/*.glb     los que carga el visor (manifest.json se mantiene a mano)
 *
 * Nota: fusionar por material pierde la identidad de las piezas sueltas (un .glb de 12 mallas
 * en vez de 215 nodos). El visor actual no interactua con piezas individuales.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Logger, NodeIO, PropertyType } from '@gltf-transform/core';
import { dedup, flatten, join, prune } from '@gltf-transform/functions';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(HERE, 'models');
const OUT_DIR = path.join(HERE, '..', 'frontend', 'vendor', 'models');
const REL_TOL = 1e-4; // tolerancia relativa en area/longitud tras hornear transformaciones en float32
const ABS_TOL = 1e-4; // tolerancia absoluta (m) en el bounding box

const { MATERIAL, TEXTURE } = PropertyType;

function materialKey(mat) {
  if (!mat) return 'sin-material';
  const tex = mat.getBaseColorTexture();
  const texHash = tex ? crypto.createHash('md5').update(Buffer.from(tex.getImage())).digest('hex').slice(0, 8) : '-';
  const r = (v) => v.map((x) => Math.round(x * 1e4) / 1e4).join(',');
  return `c=${r(mat.getBaseColorFactor())} t=${texHash} ds=${mat.getDoubleSided()} a=${mat.getAlphaMode()} m=${mat.getMetallicFactor()} r=${mat.getRoughnessFactor()}`;
}

// Firma geometrica en espacio de mundo: por material, n triangulos y area; n segmentos y longitud; bbox global.
function signature(doc) {
  const tris = new Map();
  const lines = new Map();
  const bbox = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const M = node.getWorldMatrix();
    const world = (idx, pos) => {
      const p = pos.getElement(idx, [0, 0, 0]);
      const o = [
        M[0] * p[0] + M[4] * p[1] + M[8] * p[2] + M[12],
        M[1] * p[0] + M[5] * p[1] + M[9] * p[2] + M[13],
        M[2] * p[0] + M[6] * p[1] + M[10] * p[2] + M[14],
      ];
      for (let k = 0; k < 3; k++) { bbox.min[k] = Math.min(bbox.min[k], o[k]); bbox.max[k] = Math.max(bbox.max[k], o[k]); }
      return o;
    };
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      const indices = prim.getIndices();
      const n = indices ? indices.getCount() : pos.getCount();
      const vertex = (i) => world(indices ? indices.getScalar(i) : i, pos);
      const key = materialKey(prim.getMaterial());
      const mode = prim.getMode();
      if (mode === 4) {
        const rec = tris.get(key) || { n: 0, size: 0 };
        tris.set(key, rec);
        for (let i = 0; i + 2 < n; i += 3) {
          const a = vertex(i); const b = vertex(i + 1); const c = vertex(i + 2);
          const ux = b[0] - a[0]; const uy = b[1] - a[1]; const uz = b[2] - a[2];
          const vx = c[0] - a[0]; const vy = c[1] - a[1]; const vz = c[2] - a[2];
          rec.n++;
          rec.size += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
        }
      } else if (mode === 1) {
        const rec = lines.get(key) || { n: 0, size: 0 };
        lines.set(key, rec);
        for (let i = 0; i + 1 < n; i += 2) {
          const a = vertex(i); const b = vertex(i + 1);
          rec.n++;
          rec.size += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
        }
      } else {
        throw new Error(`modo de primitiva ${mode} no soportado por la verificacion (solo TRIANGLES y LINES)`);
      }
    }
  }
  return { tris, lines, bbox };
}

function compareSignatures(a, b) {
  const problems = [];
  const rel = (x, y) => Math.abs(x - y) / Math.max(1e-9, Math.abs(x), Math.abs(y));
  for (const [label, A, B] of [['triangulos', a.tris, b.tris], ['lineas', a.lines, b.lines]]) {
    for (const k of new Set([...A.keys(), ...B.keys()])) {
      const x = A.get(k); const y = B.get(k);
      if (!x || !y) problems.push(`${label}: material solo en ${x ? 'el crudo' : 'el optimizado'} (${k})`);
      else if (x.n !== y.n || rel(x.size, y.size) > REL_TOL) problems.push(`${label}: ${k} crudo=${x.n}/${x.size.toFixed(4)} optimizado=${y.n}/${y.size.toFixed(4)}`);
    }
  }
  for (let k = 0; k < 3; k++) {
    if (Math.abs(a.bbox.min[k] - b.bbox.min[k]) > ABS_TOL || Math.abs(a.bbox.max[k] - b.bbox.max[k]) > ABS_TOL) problems.push(`bounding box distinto en el eje ${'xyz'[k]}`);
  }
  return problems;
}

function stats(doc) {
  const root = doc.getRoot();
  let drawCalls = 0;
  for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    if (mesh) drawCalls += mesh.listPrimitives().length;
  }
  return { drawCalls, materials: root.listMaterials().length };
}

const fmtMB = (bytes) => `${(bytes / 1048576).toFixed(2)} MB`;

async function optimizeFile(io, file) {
  const src = path.join(SRC_DIR, file);
  const out = path.join(OUT_DIR, file);
  const started = Date.now();
  const doc = await io.read(src);
  doc.setLogger(new Logger(Logger.Verbosity.WARN));
  const sigBefore = signature(doc);
  const before = stats(doc);

  await doc.transform(
    dedup({ propertyTypes: [MATERIAL, TEXTURE] }),
    flatten(),
    join({ keepNamed: false }),
    prune({ keepSolidTextures: true }),
  );

  const problems = compareSignatures(sigBefore, signature(doc));
  if (problems.length) {
    console.error(`FALLO ${file}: la geometria optimizada NO es equivalente, no se escribe.\n  ${problems.join('\n  ')}`);
    return false;
  }
  const after = stats(doc);
  await io.write(out, doc);
  console.log(
    `OK ${file}: ${before.drawCalls} -> ${after.drawCalls} draw calls, ${before.materials} -> ${after.materials} materiales, ` +
    `${fmtMB(fs.statSync(src).size)} -> ${fmtMB(fs.statSync(out).size)} (${Date.now() - started} ms)`,
  );
  return true;
}

async function main() {
  if (!fs.existsSync(SRC_DIR)) {
    console.error(`No existe ${SRC_DIR}. Deja ahi los .glb crudos exportados desde SketchUp.`);
    process.exit(1);
  }
  const requested = process.argv.slice(2);
  const files = (requested.length ? requested : fs.readdirSync(SRC_DIR)).filter((f) => f.toLowerCase().endsWith('.glb'));
  if (!files.length) {
    console.error(`No hay .glb que procesar en ${SRC_DIR}.`);
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const io = new NodeIO();
  let failed = 0;
  for (const file of files) {
    if (!fs.existsSync(path.join(SRC_DIR, file))) { console.error(`FALLO ${file}: no existe en models/`); failed++; continue; }
    try {
      if (!(await optimizeFile(io, file))) failed++;
    } catch (err) {
      console.error(`FALLO ${file}: ${err.message}`);
      failed++;
    }
  }
  if (failed) process.exit(1);
}

await main();
