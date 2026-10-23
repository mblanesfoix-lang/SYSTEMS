#!/usr/bin/env node
// Checks that the file and folder paths quoted in backticks inside the
// documentation exist in the repository. Keeps the docs from drifting away
// from the code.
//
// Usage (from any directory):
//   node scripts/check-doc-paths.mjs            every tracked .md plus the local-only docs
//   node scripts/check-doc-paths.mjs a.md b.md  only the given files
//
// Exit code 1 when any path is missing.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const nfc = (s) => s.normalize('NFC');
const git = (...args) =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n').filter(Boolean).map(nfc);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Local working files: the plain entries of .git/info/exclude (no wildcards).
// Its Markdown files are never versioned but must stay accurate; its folders
// may be cited without being in the repository.
const excludeFile = resolve(ROOT, git('rev-parse', '--git-path', 'info/exclude')[0]);
const localEntries = existsSync(excludeFile)
  ? readFileSync(excludeFile, 'utf8').split(/\r?\n/).map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !/[*?[\]!]/.test(l))
    .map((l) => nfc(l.replace(/^\//, '')))
  : [];
const LOCAL_DOCS = localEntries.filter((e) => e.endsWith('.md'));
const LOCAL_DIRS = localEntries.filter((e) => e.endsWith('/')).map((e) => escapeRe(e.slice(0, -1)));
// The log is a dated history: it cites files that no longer exist on purpose.
const SKIP_DOCS = new Set(['docs/ESTADO-HISTORICO.md']);

// Produced by a build, an install, a setup step or the running server (state files
// under data/), absent from a clean clone, or local folders listed in .git/info/exclude.
const GENERATED = new RegExp(
  `(^|/)(${['\\.env', '\\.git', 'node_modules', 'dist', '02-secrets\\.yaml', 'data/[\\w.]+\\.json', ...LOCAL_DIRS].join('|')})(/|$)`,
);
const SHELL_COMMAND = /^(sudo|bash|sh|cd|npm|npx|node|docker|kubectl|kind|git|curl|cp|mv|rm|ls|cat|nano)\s/;

const FILE_EXT = /\.(mjs|cjs|js|tsx|ts|json|md|html|css|ya?ml|sh|txt|bat|service|conf|glb|toml)$/i;
const PATH_CHARS = /^[\w.\-ëËøØ ]+(\/[\w.\-ëËøØ ]+)+$/;

const known = new Set(git('ls-files', '-co', '--exclude-standard'));
for (const doc of LOCAL_DOCS) if (existsSync(join(ROOT, doc))) known.add(doc);
const topLevel = new Set([...known].map((p) => p.split('/')[0]));
const dirs = new Set();
for (const file of known) {
  const parts = file.split('/');
  for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
}

const exists = (rel) => known.has(rel) || dirs.has(rel);
// A partial path such as `routes/auth.routes.js` or a bare `server.js` matches
// any known path that ends with it.
const existsAsSuffix = (rel) => {
  const tail = '/' + rel;
  for (const p of known) if (p.endsWith(tail)) return true;
  for (const p of dirs) if (p.endsWith(tail)) return true;
  return false;
};

function candidate(raw) {
  let tok = nfc(raw.trim()).replace(/(:\d+(-\d+)?|#L\d+(-L?\d+)?)$/, '').replace(/[.,;]+$/, '');
  if (!tok || /^[\/~$<@-]|^https?:/.test(tok) || SHELL_COMMAND.test(tok)) return null;
  if (/\s/.test(tok) && !PATH_CHARS.test(tok)) return null;
  if (/[*?<>{}|=:()$,;'"\\]/.test(tok)) return null;
  const isDir = tok.endsWith('/');
  const bare = isDir ? tok.slice(0, -1) : tok;
  if (/^\.\w+$/.test(bare)) return null; // a bare extension such as `.glb`
  if (!bare.includes('/') && !FILE_EXT.test(bare)) return null;
  // Without an extension or a trailing slash it can be an API group, a resource
  // name or a list of words: only treat it as a path when it starts at a
  // top-level entry of the repository.
  if (!isDir && !FILE_EXT.test(bare) && !topLevel.has(bare.split('/')[0])) return null;
  return bare;
}

function resolves(rel, docDir) {
  if (GENERATED.test(rel)) return true;
  const clean = rel.replace(/^\.\//, '');
  const fromDoc = docDir === '.' ? clean : `${docDir}/${clean}`;
  return exists(clean) || exists(fromDoc) || existsAsSuffix(clean);
}

function inlinePaths(text) {
  const found = [];
  let fenced = false;
  text.split('\n').forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; return; }
    if (fenced) return;
    for (const m of line.matchAll(/`([^`]+)`/g)) {
      const rel = candidate(m[1]);
      if (rel) found.push({ line: i + 1, token: m[1].trim(), rel });
    }
  });
  return found;
}

const args = process.argv.slice(2);
const targets = (args.length
  ? args.map((a) => nfc(relative(ROOT, resolve(a)).replace(/\\/g, '/')))
  : [...new Set([...git('ls-files', '*.md'), ...LOCAL_DOCS.filter((d) => existsSync(join(ROOT, d)))])]
).filter((f) => !SKIP_DOCS.has(f));

let missing = 0;
let checked = 0;
for (const doc of targets) {
  const abs = join(ROOT, doc);
  if (!existsSync(abs)) { console.error(`No existe el documento: ${doc}`); missing++; continue; }
  const docDir = dirname(doc).replace(/\\/g, '/');
  for (const { line, token, rel } of inlinePaths(readFileSync(abs, 'utf8'))) {
    checked++;
    if (!resolves(rel, docDir)) {
      console.log(`${doc}:${line}  ${token}`);
      missing++;
    }
  }
}

console.log(`\n${targets.length} documentos, ${checked} rutas comprobadas, ${missing} sin resolver`);
process.exit(missing ? 1 : 0);
