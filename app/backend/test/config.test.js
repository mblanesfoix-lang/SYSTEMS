/**
 * Configuración: validación al arrancar (producción falla con la lista
 * completa, desarrollo solo avisa), carga de .env locales y coherencia entre
 * el inventario de config.js y los archivos de despliegue generados.
 * No usa Mongo ni red.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  VARS, OBSOLETE_VARS, PLATFORM_VARS, TOOL_VARS, BUILD_VARS,
  ConfigError, validateConfig, assertConfig, parseEnvFile, loadEnvFile, DEV_FORENSIC_SECRET, DEV_DATA_KEY,
} from '../config.js';
import { REPO_ROOT, outdatedTargets } from '../scripts/config-sync.js';
import { RENAMED_VARS } from '../llm/index.js';

const REQUIRED = VARS.filter((v) => v.required).map((v) => v.name);
const HEX64 = 'a'.repeat(64);
const SECRET = 'b'.repeat(64);
const VALID_PRODUCTION = {
  NODE_ENV: 'production',
  MONGO_URI: 'mongodb://mongo:27017/elvira',
  JWT_SECRET: SECRET,
  SENTINEL_FORENSIC_SECRET: SECRET,
  FL_EXPEDIENTE_ENC_KEY: HEX64,
  PACTVM_DATA_KEY: 'c'.repeat(64),
  LLM_PROVIDER: 'local',
};
const silent = { warn() {} };
const read = (file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');

describe('config: validación en producción', () => {
  test('las obligatorias son las que exige el arranque', () => {
    assert.deepEqual(REQUIRED.sort(), ['FL_EXPEDIENTE_ENC_KEY', 'JWT_SECRET', 'MONGO_URI', 'PACTVM_DATA_KEY', 'SENTINEL_FORENSIC_SECRET']);
  });

  test('sin variables falla con un único error que las lista todas', () => {
    assert.throws(() => assertConfig({ NODE_ENV: 'production' }, silent), (err) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.problems.length, REQUIRED.length);
      for (const name of REQUIRED) assert.match(err.message, new RegExp(`- ${name}: obligatoria en producción`));
      return true;
    });
  });

  test('una variable vacía cuenta como ausente', () => {
    const { errors } = validateConfig({ ...VALID_PRODUCTION, JWT_SECRET: '', FL_EXPEDIENTE_ENC_KEY: '' });
    assert.deepEqual(errors, ['JWT_SECRET: obligatoria en producción', 'FL_EXPEDIENTE_ENC_KEY: obligatoria en producción']);
  });

  test('configuración completa y válida arranca sin errores', () => {
    const result = assertConfig(VALID_PRODUCTION, silent);
    assert.equal(result.production, true);
    assert.deepEqual(result.errors, []);
  });

  test('formatos inválidos: se listan todos a la vez', () => {
    const { errors } = validateConfig({
      ...VALID_PRODUCTION,
      MONGO_URI: 'http://mongo',
      JWT_SECRET: 'corta',
      SENTINEL_FORENSIC_SECRET: `${'c'.repeat(40)} con espacios`,
      FL_EXPEDIENTE_ENC_KEY: 'z'.repeat(64),
      CIBE_MODE: 'estricto',
      PORT: '99999',
      CORS_ORIGIN: 'elvira.local',
    });
    const names = errors.map((e) => e.split(':')[0]);
    assert.deepEqual(names, ['PORT', 'CORS_ORIGIN', 'MONGO_URI', 'JWT_SECRET', 'SENTINEL_FORENSIC_SECRET', 'FL_EXPEDIENTE_ENC_KEY', 'CIBE_MODE']);
    assert.match(errors.join('\n'), /FL_EXPEDIENTE_ENC_KEY: deben ser 64 caracteres hexadecimales/);
  });

  test('obligatorias condicionales', () => {
    const { errors } = validateConfig({
      ...VALID_PRODUCTION,
      RACK_PEERS: 'http://10.0.0.2:5173',
      ENABLE_TWIN_PORT: 'true',
      CIBE_PRIVATE_KEY_PEM: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----',
    });
    assert.deepEqual(errors, [
      'TWIN_TOKEN: obligatoria si ENABLE_TWIN_PORT=true',
      'CIBE_PUBLIC_KEY_PEM: obligatoria si se define CIBE_PRIVATE_KEY_PEM',
      'RACK_SHARED_KEY: obligatoria si se define RACK_PEERS',
    ]);
  });

  test('un valor de plantilla sin sustituir no se acepta', () => {
    const { errors } = validateConfig({ ...VALID_PRODUCTION, JWT_SECRET: `CAMBIAR-${SECRET}` });
    assert.deepEqual(errors, ['JWT_SECRET: conserva el valor de plantilla, hay que sustituirlo']);
  });

  test('la clave forense de desarrollo no se acepta', () => {
    const { errors } = validateConfig({ ...VALID_PRODUCTION, SENTINEL_FORENSIC_SECRET: DEV_FORENSIC_SECRET });
    assert.deepEqual(errors, ['SENTINEL_FORENSIC_SECRET: es la clave de desarrollo del repositorio, hay que generar una propia']);
  });

  test('la clave de datos de desarrollo no se acepta, tampoco en mayusculas, ni un formato invalido', () => {
    for (const value of [DEV_DATA_KEY, DEV_DATA_KEY.toUpperCase()]) {
      const { errors } = validateConfig({ ...VALID_PRODUCTION, PACTVM_DATA_KEY: value });
      assert.deepEqual(errors, ['PACTVM_DATA_KEY: es la clave de desarrollo del repositorio, hay que generar una propia']);
    }
    const { errors } = validateConfig({ ...VALID_PRODUCTION, PACTVM_DATA_KEY: 'corta' });
    assert.deepEqual(errors, ['PACTVM_DATA_KEY: deben ser 64 caracteres hexadecimales (32 bytes)']);
  });

  test('IA: proveedor no válido o simulado no se admiten en producción', () => {
    assert.deepEqual(validateConfig({ ...VALID_PRODUCTION, LLM_PROVIDER: 'otro' }).errors,
      ['LLM_PROVIDER: valores admitidos: local, simulado, externo']);
    assert.deepEqual(validateConfig({ ...VALID_PRODUCTION, LLM_PROVIDER: 'simulado' }).errors,
      ['LLM_PROVIDER: el proveedor simulado no se admite en producción']);
    assert.deepEqual(validateConfig({ LLM_PROVIDER: 'simulado' }).warnings.filter((w) => w.startsWith('LLM_PROVIDER')), []);
  });

  test('IA: los nombres antiguos solo avisan, también en producción', () => {
    const oldUrl = RENAMED_VARS.find((r) => r.replacement === 'LLM_URL' && r.provider === 'local').name;
    const result = validateConfig({ ...VALID_PRODUCTION, LLM_PROVIDER: 'ollama', [oldUrl]: 'http://ia:11434' });
    assert.deepEqual(result.errors, []);
    assert.ok(result.warnings.some((w) => w.startsWith('LLM_PROVIDER: valor antiguo')));
    assert.ok(result.warnings.some((w) => w.startsWith(`${oldUrl}: nombre antiguo de LLM_URL`)));
  });

  test('IA: sin proveedor solo avisa; con el externo, falta su clave', () => {
    const withoutProvider = { ...VALID_PRODUCTION };
    delete withoutProvider.LLM_PROVIDER;
    const none = validateConfig(withoutProvider);
    assert.deepEqual(none.errors, []);
    assert.ok(none.warnings.includes('LLM_PROVIDER: sin ella, las funciones de IA no responden'));
    const external = validateConfig({ ...VALID_PRODUCTION, LLM_PROVIDER: 'externo' });
    assert.ok(external.warnings.includes('LLM_API_KEY: sin ella, el proveedor externo no responde'));
  });

  test('los mensajes nunca incluyen el valor de una variable', () => {
    const leaked = 'valor-que-no-debe-salir-en-el-log';
    try {
      assertConfig({ ...VALID_PRODUCTION, SENTINEL_FORENSIC_SECRET: leaked, FL_EXPEDIENTE_ENC_KEY: leaked }, silent);
      assert.fail('debía fallar');
    } catch (err) {
      assert.ok(err instanceof ConfigError);
      assert.ok(!err.message.includes(leaked));
    }
  });
});

describe('config: desarrollo', () => {
  test('sin variables no falla: lo convierte todo en avisos', () => {
    const logged = [];
    const result = assertConfig({}, { warn: (m) => logged.push(m) });
    assert.equal(result.production, false);
    assert.deepEqual(result.errors, []);
    for (const name of REQUIRED) assert.ok(result.warnings.some((w) => w.startsWith(`${name}:`)), name);
    assert.equal(logged.length, 1);
    assert.match(logged[0], /no bloquean el arranque/);
  });

  test('formato inválido en desarrollo también es solo aviso', () => {
    const result = validateConfig({ FL_EXPEDIENTE_ENC_KEY: 'no-hex' });
    assert.deepEqual(result.errors, []);
    assert.ok(result.warnings.includes('FL_EXPEDIENTE_ENC_KEY: deben ser 64 caracteres hexadecimales (32 bytes)'));
  });

  test('las variables obsoletas generan aviso y no error', () => {
    const result = validateConfig({ ...VALID_PRODUCTION, FOUNDRY_INGRESS_PORT: '5175', SERPAPI_KEY: 'x' });
    assert.deepEqual(result.errors, []);
    assert.equal(result.warnings.filter((w) => w.includes('obsoleta')).length, 2);
  });
});

describe('config: .env locales', () => {
  test('parseEnvFile: comentarios, comillas, export y CRLF', () => {
    const parsed = parseEnvFile('# comentario\r\nA=1\r\nexport B="dos palabras"\r\n  C = \'tres\'  \r\n\r\nNO VALIDA\r\nD=\r\n');
    assert.deepEqual(parsed, { A: '1', B: 'dos palabras', C: 'tres', D: '' });
  });

  test('loadEnvFile no pisa valores ya definidos y rellena los vacíos', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
    try {
      const file = path.join(dir, '.env');
      fs.writeFileSync(file, 'A=archivo\nB=archivo\nC=archivo\n');
      const env = { A: 'entorno', B: '' };
      assert.equal(loadEnvFile(file, env), 2);
      assert.deepEqual(env, { A: 'entorno', B: 'archivo', C: 'archivo' });
      assert.equal(loadEnvFile(path.join(dir, 'no-existe'), env), 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Variables leídas por el código del proceso (backend y Rëff) y del build del cliente de Rëff:
// process.env.X, import.meta.env.X y env.X en los módulos que reciben el entorno como parámetro.
// config.js se salta porque nombra variables para validarlas, no para usarlas.
function envNamesInCode() {
  const names = new Set();
  const skip = new Set(['node_modules', 'dist', 'data', 'test', '.git']);
  const configFile = path.join(REPO_ROOT, 'app/backend/config.js');
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) walk(abs);
      } else if (/\.(js|mjs|ts|tsx)$/.test(entry.name) && abs !== configFile) {
        const src = fs.readFileSync(abs, 'utf8');
        for (const m of src.matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)) names.add(m[1]);
      }
    }
  };
  walk(path.join(REPO_ROOT, 'app/backend'));
  walk(path.join(REPO_ROOT, 'Elvi-Ra/Mesas/Rëff/server'));
  walk(path.join(REPO_ROOT, 'Elvi-Ra/Mesas/Rëff/client/src'));
  for (const m of fs.readFileSync(path.join(REPO_ROOT, 'Elvi-Ra/Mesas/Rëff/vite.config.ts'), 'utf8').matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) names.add(m[1]);
  return names;
}

describe('config: inventario frente al código', () => {
  const inCode = envNamesInCode();

  test('toda variable que lee el código está en el inventario', () => {
    const known = new Set([...VARS, ...PLATFORM_VARS, ...TOOL_VARS, ...BUILD_VARS, ...OBSOLETE_VARS, ...RENAMED_VARS].map((v) => v.name));
    assert.deepEqual([...inCode].filter((n) => !known.has(n)).sort(), []);
  });

  test('toda variable del inventario la lee el código', () => {
    // GRID_<CC>_URL se lee con nombre compuesto (grid-interlink.js)
    const unread = VARS.map((v) => v.name).filter((n) => !inCode.has(n) && !/^GRID_[A-Z]{2}_URL$/.test(n));
    assert.deepEqual(unread, []);
  });
});

describe('config: archivos de despliegue', () => {
  test('.env.example, docker-compose y k8s están sincronizados con config.js', () => {
    assert.deepEqual(outdatedTargets(), [], 'ejecutar npm run config:sync en app/backend');
  });

  test('docker-compose exige las obligatorias sin valor por defecto (salvo MONGO_URI, que apunta al servicio mongo)', () => {
    const compose = read('docker-compose.yml');
    for (const name of REQUIRED.filter((n) => n !== 'MONGO_URI')) {
      assert.ok(compose.includes(`${name}: \${${name}:?}`), name);
    }
    assert.ok(compose.includes('MONGO_URI: ${MONGO_URI:-mongodb://mongo:27017/elvira}'));
  });

  test('compose y k8s incluyen todas las variables de despliegue', () => {
    const compose = read('docker-compose.yml');
    const k8s = read('k8s/01-configmap.yaml') + read('k8s/02-secrets.example.yaml');
    for (const v of VARS.filter((x) => !x.localOnly)) {
      assert.match(compose, new RegExp(`^\\s+${v.name}: `, 'm'), `compose: ${v.name}`);
      assert.match(k8s, new RegExp(`^\\s+(# )?${v.name}: `, 'm'), `k8s: ${v.name}`);
    }
  });

  test('ningún secreto en el ConfigMap ni valores en los ejemplos', () => {
    const configMap = read('k8s/01-configmap.yaml');
    const examples = read('app/backend/.env.example') + read('Elvi-Ra/Mesas/Rëff/.env.example');
    const secretExample = read('k8s/02-secrets.example.yaml');
    for (const v of VARS.filter((x) => x.secret)) {
      assert.doesNotMatch(configMap, new RegExp(`^\\s+(# )?${v.name}:`, 'm'), `ConfigMap: ${v.name}`);
      assert.doesNotMatch(examples, new RegExp(`^(# )?${v.name}=.+$`, 'm'), `.env.example: ${v.name}`);
      assert.match(secretExample, new RegExp(`^\\s+${v.name}: "(CAMBIAR)?"$`, 'm'), `Secret: ${v.name}`);
    }
  });

  test('las variables obsoletas no aparecen en compose, k8s ni como línea de .env.example', () => {
    const files = ['docker-compose.yml', 'k8s/01-configmap.yaml', 'k8s/02-secrets.example.yaml'].map(read).join('\n');
    const examples = read('app/backend/.env.example') + read('Elvi-Ra/Mesas/Rëff/.env.example');
    for (const { name } of OBSOLETE_VARS) {
      assert.ok(!files.includes(name), name);
      assert.doesNotMatch(examples, new RegExp(`^(# )?${name}=`, 'm'), name);
    }
  });
});
