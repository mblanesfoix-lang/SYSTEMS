import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildComplianceView } from '../lib/compliance-view.js';

const NOW = new Date('2026-10-22T10:00:00Z');
const isoIn = (days) => new Date(NOW.getTime() + days * 86400000).toISOString().slice(0, 10);

const fw = (over = {}) => ({
  _id: over.id ?? 'f1',
  code: 'ISO 9001',
  title: 'Gestion de calidad',
  kind: 'iso',
  family: 'ISO',
  jurisdictions: ['INT'],
  nature: 'obligatoria',
  priority: 'media',
  status: 'vigente',
  tracksExpiry: true,
  expiresAt: isoIn(400),
  requirements: [{ id: 'r1', text: 'a', done: true }],
  ...over,
});

const levelOf = (f) => buildComplianceView({ frameworks: [f], now: NOW }).frameworks[0];

describe('compliance-view: nivel de cada norma', () => {
  test('vigente, con fecha lejana y requisitos cumplidos: verde', () => {
    assert.equal(levelOf(fw()).level, 'verde');
  });

  test('vencida: rojo, tambien si no es obligatoria', () => {
    assert.equal(levelOf(fw({ expiresAt: isoIn(-3) })).level, 'rojo');
    assert.equal(levelOf(fw({ nature: 'voluntaria', expiresAt: isoIn(-3) })).level, 'rojo');
  });

  test('vence en 60 dias: ambar con el motivo', () => {
    const r = levelOf(fw({ expiresAt: isoIn(60) }));
    assert.equal(r.level, 'ambar');
    assert.match(r.reason, /60 días/);
  });

  test('vigente que caduca y sin fecha: ambar, nunca verde', () => {
    assert.equal(levelOf(fw({ expiresAt: null })).level, 'ambar');
  });

  test('vigente con requisitos pendientes: ambar', () => {
    const r = levelOf(fw({ requirements: [{ done: true }, { done: false }] }));
    assert.equal(r.level, 'ambar');
    assert.match(r.reason, /1 de 2/);
  });

  test('obligatoria de prioridad alta sin iniciar: rojo; de prioridad media: ambar', () => {
    assert.equal(levelOf(fw({ status: 'no_iniciado', priority: 'alta', expiresAt: null })).level, 'rojo');
    assert.equal(levelOf(fw({ status: 'no_iniciado', priority: 'media', expiresAt: null })).level, 'ambar');
  });

  test('voluntaria sin certificar es informativa y no aplica no cuenta', () => {
    assert.equal(levelOf(fw({ nature: 'voluntaria', status: 'no_iniciado', expiresAt: null })).level, 'informativo');
    assert.equal(levelOf(fw({ status: 'no_aplica' })).level, 'no_aplica');
  });
});

describe('compliance-view: semaforo global', () => {
  const view = (frameworks, zones = []) => buildComplianceView({ frameworks, zones, now: NOW });

  test('sin datos: sin_datos', () => {
    assert.equal(view([]).overall.level, 'sin_datos');
  });

  test('todo verde: verde', () => {
    assert.equal(view([fw({ id: 'a' }), fw({ id: 'b', code: 'ISO 14001' })]).overall.level, 'verde');
  });

  test('una norma roja tumba el global; una ambar lo deja en ambar', () => {
    assert.equal(view([fw({ id: 'a' }), fw({ id: 'b', expiresAt: isoIn(-1) })]).overall.level, 'rojo');
    assert.equal(view([fw({ id: 'a' }), fw({ id: 'b', expiresAt: isoIn(20) })]).overall.level, 'ambar');
  });

  test('una norma voluntaria sin certificar no baja el global', () => {
    assert.equal(view([fw({ id: 'a' }), fw({ id: 'b', nature: 'voluntaria', status: 'no_iniciado', expiresAt: null })]).overall.level, 'verde');
  });

  test('una zona ATEX pendiente deja el global en ambar', () => {
    const zones = [{ _id: 'z1', name: 'Silo', kind: 'polvo', zone: 'sin_clasificar', status: 'pendiente' }];
    const v = view([fw()], zones);
    assert.equal(v.overall.level, 'ambar');
    assert.equal(v.zones.byStatus.pendiente, 1);
  });

  test('proximos vencimientos ordenados y el orden de las fichas pone lo grave primero', () => {
    const v = view([fw({ id: 'a', expiresAt: isoIn(80) }), fw({ id: 'b', expiresAt: isoIn(10) }), fw({ id: 'c' })]);
    assert.deepEqual(v.upcoming.map((u) => u.id), ['b', 'a']);
    assert.equal(v.frameworks.at(-1).id, 'c');
  });

  test('la vista no expone notas internas ni responsables', () => {
    const v = view([fw({ notes: 'secreto', owner: 'alguien', alert: { level: 'x' } })]);
    const text = JSON.stringify(v);
    assert.ok(!text.includes('secreto') && !text.includes('alguien'));
  });
});
