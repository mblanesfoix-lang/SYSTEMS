import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MACHINE_SPECS,
  MACHINE_IDS,
  NODE_ID,
  sampleMachine,
  levelOf,
  fingerprint,
  fmt,
  createTelemetryFeed,
} from '../../frontend/js/machine-telemetry.js';

// Instante arbitrario fijo: la simulacion es funcion pura del reloj.
const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);
const HOUR_S = 3600;
const MODELS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../frontend/vendor/models');

describe('machine-telemetry: spec de la linea BioHybrid', () => {
  test('totales de nodo y capacidades nominales de la ficha', () => {
    const g = MACHINE_SPECS['bio-grinder'];
    const d = MACHINE_SPECS['bio-dehydrator'];
    const p = MACHINE_SPECS['bio-pelletizator'];
    assert.equal(g.metrics.rate.nominal * g.units, 1840);
    assert.equal(d.metrics.rate.nominal * d.units, 2000);
    assert.equal(p.metrics.rate.nominal, 2.0);
    assert.equal(p.metrics.power.nominal, 132);
    assert.equal(g.metrics.extraction.nominal, 60);
    assert.equal(d.metrics.extraction.nominal, 80);
  });

  test('H_out del Grinder sale del balance de masa y cuadra con el ~48 % de la ficha', () => {
    const g = MACHINE_SPECS['bio-grinder'];
    const hOut = g.metrics.h_out.derive({ h_in: 70, extraction: 60 });
    assert.ok(Math.abs(hOut - 48.3) < 0.1, `H_out = ${hOut}`);
  });

  test('toda metrica tiene escala y las que alertan tienen rango tolerable que contiene al nominal', () => {
    for (const id of MACHINE_IDS) {
      for (const [key, def] of Object.entries(MACHINE_SPECS[id].metrics)) {
        assert.ok(def.range && def.range[0] < def.range[1], `${id}.${key} sin escala`);
        assert.ok(['spec', 'placeholder', 'derived'].includes(def.source), `${id}.${key} sin procedencia`);
        if (def.ok) assert.ok(def.warn, `${id}.${key} tiene ok pero no warn`);
      }
    }
  });

  test('las celdas del layout solo referencian metricas existentes', () => {
    for (const id of MACHINE_IDS) {
      const spec = MACHINE_SPECS[id];
      for (const group of spec.layout) {
        for (const cell of group.cells) {
          for (const key of cell.keys || [cell.key]) assert.ok(spec.metrics[key], `${id}: celda apunta a "${key}" inexistente`);
          if (cell.mean) assert.ok(spec.metrics[cell.mean], `${id}: media "${cell.mean}" inexistente`);
        }
      }
      for (const key of spec.glance) assert.ok(spec.metrics[key], `${id}: glance "${key}" inexistente`);
      if (spec.demoFault) assert.ok(spec.metrics[spec.demoFault.key], `${id}: demoFault apunta a metrica inexistente`);
    }
  });
});

describe('machine-telemetry: simulacion', () => {
  test('determinista: mismo instante, mismas lecturas', () => {
    for (const id of MACHINE_IDS) {
      const a = sampleMachine(MACHINE_SPECS[id], T0);
      const b = sampleMachine(MACHINE_SPECS[id], T0);
      assert.deepEqual(a.values, b.values);
    }
  });

  test('sin fallas, una hora entera de lecturas queda en rango nominal y el estandar 7 % se cumple siempre', () => {
    for (const id of MACHINE_IDS) {
      const spec = MACHINE_SPECS[id];
      for (let s = 0; s < HOUR_S; s++) {
        const r = sampleMachine(spec, T0 + s * 1000);
        for (const [key, level] of Object.entries(r.levels)) {
          assert.ok(level === null || level === 'ok', `${id}.${key} = ${r.values[key]} fuera de nominal (${level}) en t+${s}s`);
        }
        assert.equal(r.status, 'ok');
        if (spec.standard) assert.equal(r.standard.ok, true, `${id}: estandar 7 % incumplido en t+${s}s (${r.standard.detail})`);
      }
    }
  });

  test('la simulacion se mueve: no es una constante', () => {
    for (const id of MACHINE_IDS) {
      const spec = MACHINE_SPECS[id];
      const seen = new Set();
      for (let s = 0; s < 300; s++) seen.add(sampleMachine(spec, T0 + s * 1000).values.rate);
      assert.ok(seen.size > 5, `${id}.rate casi constante (${seen.size} valores distintos)`);
    }
  });

  test('una falla en el Dehydrator sube H sobre 7,0 % y rompe el estandar; el Pelletizer sale de la ventana', () => {
    const d = MACHINE_SPECS['bio-dehydrator'];
    const f = d.demoFault;
    const r = sampleMachine(d, T0, { [f.key]: f.delta });
    assert.ok(r.values.h_out > 7.0, `h_out = ${r.values.h_out}`);
    assert.equal(r.levels.h_out, 'warn');
    assert.equal(r.standard.ok, false);
    assert.equal(r.status, 'warn');

    const p = MACHINE_SPECS['bio-pelletizator'];
    const rp = sampleMachine(p, T0, { [p.demoFault.key]: p.demoFault.delta });
    assert.ok(rp.values.moisture > 8.0, `moisture = ${rp.values.moisture}`);
    assert.equal(rp.standard.ok, false);
  });

  test('levelOf: ok dentro, warn en el margen tolerable, crit fuera', () => {
    const def = MACHINE_SPECS['bio-dehydrator'].metrics.h_out;
    assert.equal(levelOf(def, 6.99), 'ok');
    assert.equal(levelOf(def, 7.0), 'ok');
    assert.equal(levelOf(def, 7.01), 'warn');
    assert.equal(levelOf(def, 8.0), 'warn');
    assert.equal(levelOf(def, 8.01), 'crit');
  });

  test('los valores quedan redondeados a la resolucion de la metrica', () => {
    const r = sampleMachine(MACHINE_SPECS['bio-dehydrator'], T0);
    for (const [key, v] of Object.entries(r.values)) {
      const d = MACHINE_SPECS['bio-dehydrator'].metrics[key].decimals;
      assert.equal(v, Number(v.toFixed(d)), `${key} = ${v} no esta a ${d} decimales`);
    }
  });
});

describe('manifest de modelos: coherencia con la telemetria del HUD', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(MODELS_DIR, 'manifest.json'), 'utf8'));

  test('cada maquina del manifest tiene spec de telemetria y su .glb existe', () => {
    assert.deepEqual(manifest.map((m) => m.id).sort(), [...MACHINE_IDS].sort());
    for (const entry of manifest) {
      assert.ok(fs.existsSync(path.join(MODELS_DIR, entry.file)), `${entry.id}: falta ${entry.file}`);
    }
  });

  test('hotspots: ids unicos, posicion y normal validas, metricas que existen en la spec', () => {
    for (const entry of manifest) {
      const spec = MACHINE_SPECS[entry.id];
      const ids = new Set();
      for (const h of entry.hotspots) {
        assert.ok(!ids.has(h.id), `${entry.id}: hotspot "${h.id}" repetido`);
        ids.add(h.id);
        assert.ok(h.label, `${entry.id}.${h.id}: sin etiqueta`);
        assert.equal(h.position.length, 3);
        assert.ok(h.position.every(Number.isFinite), `${entry.id}.${h.id}: posicion no numerica`);
        assert.equal(h.normal.length, 3);
        assert.ok(Math.hypot(...h.normal) > 0.5, `${entry.id}.${h.id}: normal nula`);
        assert.ok(h.metrics.length > 0, `${entry.id}.${h.id}: sin metricas`);
        for (const k of h.metrics) assert.ok(spec.metrics[k], `${entry.id}.${h.id}: metrica "${k}" inexistente en la spec`);
      }
    }
  });

  test('focus bien formado y con todos los hotspots dentro: si no, quedarian fuera de cuadro', () => {
    for (const entry of manifest) {
      if (!entry.focus) continue;
      const { min, max } = entry.focus;
      for (let i = 0; i < 3; i++) assert.ok(min[i] < max[i], `${entry.id}: focus invertido en el eje ${i}`);
      for (const h of entry.hotspots) {
        h.position.forEach((v, i) => assert.ok(v >= min[i] && v <= max[i], `${entry.id}.${h.id}: eje ${i} = ${v} fuera del focus [${min[i]}, ${max[i]}]`));
      }
    }
  });

  test('zoom, si existe, es un factor razonable', () => {
    for (const entry of manifest) if (entry.zoom !== undefined) assert.ok(entry.zoom > 0.3 && entry.zoom <= 1.5, `${entry.id}: zoom ${entry.zoom}`);
  });
});

describe('machine-telemetry: huella y formato', () => {
  test('fingerprint SHA-256 truncada a 12 hex y sensible a los valores', async () => {
    const a = await fingerprint(NODE_ID, 'bio-grinder', T0, { rate: 460 });
    const b = await fingerprint(NODE_ID, 'bio-grinder', T0, { rate: 461 });
    assert.equal(a.algo, 'SHA-256');
    assert.match(a.hex, /^[0-9A-F]{12}$/);
    assert.notEqual(a.hex, b.hex);
    assert.deepEqual(a, await fingerprint(NODE_ID, 'bio-grinder', T0, { rate: 460 }));
  });

  test('fmt usa coma decimal y miles siempre agrupados', () => {
    assert.equal(fmt(1840, 0), '1.840');
    assert.equal(fmt(6.7, 2), '6,70');
    assert.equal(fmt(NaN), '--');
    assert.equal(fmt(-0, 1), '0,0');
  });
});

describe('machine-telemetry: feed', () => {
  test('emite un snapshot por maquina con huella, historial y procedencia simulada', async () => {
    let clock = T0;
    const feed = createTelemetryFeed({ now: () => clock });
    let got = null;
    const unsub = feed.subscribe((snaps) => { got = snaps; });
    await feed.tickNow(); // sin setActive el reloj no corre, pero tickNow fuerza uno
    unsub();
    assert.ok(got, 'sin snapshots');
    assert.deepEqual([...got.keys()].sort(), [...MACHINE_IDS].sort());
    for (const snap of got.values()) {
      assert.equal(snap.source, 'simulated');
      assert.match(snap.hash.hex, /^[0-9A-F]{12}$/);
      assert.ok(snap.history.rate.length >= 1);
    }
    assert.equal(feed.nodeId, NODE_ID);
  });

  test('injectFault desvia la lectura, y clearFaults la devuelve a la normalidad con rampa', async () => {
    let clock = T0;
    const feed = createTelemetryFeed({ now: () => clock });
    let last = null;
    feed.subscribe((snaps) => { last = snaps.get('bio-dehydrator'); });
    await feed.tickNow();
    const base = last.values.h_out;
    assert.ok(base <= 7.0);

    feed.injectFault('bio-dehydrator', 'h_out', 0.75, 20000);
    clock = T0 + 5000; // pasada la rampa de subida (2,5 s)
    await feed.tickNow();
    assert.ok(last.values.h_out > 7.0, `h_out = ${last.values.h_out}`);
    assert.equal(last.faultActive, true);
    assert.equal(last.standard.ok, false);

    feed.clearFaults('bio-dehydrator');
    clock = T0 + 5000 + 6000; // pasada la rampa de bajada (5 s)
    await feed.tickNow();
    assert.ok(last.values.h_out <= 7.0, `h_out = ${last.values.h_out}`);
    assert.equal(last.standard.ok, true);
  });
});
