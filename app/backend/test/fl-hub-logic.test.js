/**
 * Logica pura del Hub fiscal y legal del frontend (frontend/js/fl-hub-logic.js):
 * formato, calendario, filtros y buscador del command bar. Sin DOM ni red,
 * mismo criterio que machine-telemetry.test.js.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  fmtFecha, fmtRelDias, fmtEur, parseEurACents, centsAEurTexto, fmtCuentaAtras, severidadPlazo,
  mesGrid, agruparEventos, construirIndice, buscar, filtrarModelos, filtrarNotificaciones, filtrarContratos,
  pasoJunta, nivelRiesgo, addDias, diffDias,
} from '../../frontend/js/fl-hub-logic.js';

const DATA = {
  sociedades: [
    { id: 's1', nombre_corto: 'S-NFI Corp.', denominacion: 'South-Navarre Fresh Innovations, S.L.', nif: 'B00000001', borme_alias: ['S-NFI Corp'] },
    { id: 's2', nombre_corto: 'S-NFI Energy', denominacion: 'S-NFI Energy, S.L.U.', nif: 'B00000003', borme_alias: [] },
  ],
  modelos: [
    { id: 'm1', sociedad_id: 's2', modelo: '200', periodo: 'Anual', ejercicio: 2025, concepto: 'Impuesto sobre Sociedades · Declaración anual', administracion: 'AEAT', estado: 'liquidado', calc: { vencido: false } },
    { id: 'm2', sociedad_id: 's2', modelo: '303', periodo: '3T', ejercicio: 2026, concepto: 'IVA · Autoliquidación trimestral', administracion: 'AEAT', estado: 'pendiente', calc: { vencido: true } },
    { id: 'm3', sociedad_id: 's1', modelo: 'S-90', periodo: 'Anual', ejercicio: 2025, concepto: 'Impuesto sobre Sociedades (Navarra)', administracion: 'HFN', estado: 'pendiente', calc: { vencido: false } },
  ],
  notificaciones: [
    { id: 'n1', sociedad_id: 's1', emisor: 'Agencia Estatal de Administración Tributaria', emisor_siglas: 'AEAT', canal: 'dehu', expediente: 'EXP-1', asunto: 'Requerimiento de información', estado: 'pendiente', acuse: null, puesta_disposicion: '2026-10-01', calc: { urgencia: 'alta' } },
    { id: 'n2', sociedad_id: 's2', emisor: 'Tesorería General de la Seguridad Social', emisor_siglas: 'TGSS', canal: 'sede_tgss', expediente: 'EXP-2', asunto: 'Reclamación de cuotas', estado: 'asignada', acuse: { fecha: '2026-10-02' }, puesta_disposicion: '2026-10-02', calc: { urgencia: 'critica' } },
    { id: 'n3', sociedad_id: 's2', emisor: 'IDAE', emisor_siglas: 'IDAE', canal: 'dehu', expediente: 'EXP-3', asunto: 'Resolución de ayuda', estado: 'archivada', acuse: { fecha: '2026-09-01' }, puesta_disposicion: '2026-09-01', calc: { urgencia: 'cerrada' } },
  ],
  contratos: [
    { id: 'c1', sociedad_id: 's2', tipo: 'ppa', titulo: 'PPA de absorción de excedentes', contraparte: 'Ribera Generación Renovable, S.L.', estado: 'negociacion', fecha_vencimiento: null, riesgo_contraparte: 38, valor_cents: null, clausulas_clave: ['0 €/MWh'] },
    { id: 'c2', sociedad_id: 's1', tipo: 'servicios', titulo: 'Auditoría de cuentas', contraparte: 'Arga Auditores, S.L.P.', estado: 'vigente', fecha_vencimiento: '2028-12-31', riesgo_contraparte: 10, valor_cents: 5400000, clausulas_clave: [] },
    { id: 'c3', sociedad_id: 's1', tipo: 'suministro', titulo: 'Suministro eléctrico', contraparte: 'Comercializadora', estado: 'vencido', fecha_vencimiento: '2026-01-01', riesgo_contraparte: 70, valor_cents: 1850000, clausulas_clave: [] },
  ],
  apoderamientos: [],
  juntas: [],
  checklist: [],
  alertas: [{ id: 'BOE-A-2026-20976', fuente: 'BOE', titulo: 'Real Decreto sobre el Registro de producción y gestión de residuos', fecha_publicacion: '2026-10-01', departamento: 'MITECO', categorias: ['residuos'] }],
  meta: { normas: [{ id: 'BOE-A-2015-10565', ref: 'Ley 39/2015 (LPACAP)', titulo: 'Ley 39/2015, del Procedimiento Administrativo Común', fuente: null, url: 'https://www.boe.es/buscar/act.php?id=BOE-A-2015-10565', articulos: [{ art: '43', tema: 'Práctica de las notificaciones a través de medios electrónicos' }] }] },
};

describe('fl-hub-logic: formato', () => {
  test('fechas y dias relativos', () => {
    assert.equal(fmtFecha('2026-10-12'), '12 oct 2026');
    assert.equal(fmtFecha('2026-10-12', { corta: true }), '12 oct');
    assert.equal(fmtFecha('2026-10-12', { numerica: true }), '12/10/2026');
    assert.equal(fmtFecha(null), '—');
    assert.equal(fmtRelDias(0), 'hoy');
    assert.equal(fmtRelDias(1), 'mañana');
    assert.equal(fmtRelDias(-3), 'hace 3 días');
    assert.equal(addDias('2026-12-31', 1), '2027-01-01');
    assert.equal(diffDias('2026-10-12', '2026-10-20'), 8);
  });

  test('importes en centimos con formato es-ES e ida y vuelta del formulario', () => {
    assert.equal(fmtEur(1248055).replace(/\s/g, ' '), '12.480,55 €');
    assert.equal(fmtEur(124000000, { compacto: true }), '1,24 M€');
    assert.equal(fmtEur(null), '—');
    assert.equal(parseEurACents('12.480,55'), 1248055);
    assert.equal(parseEurACents('1240.5'), 124050);
    assert.equal(parseEurACents('  '), null);
    assert.ok(Number.isNaN(parseEurACents('doce euros')));
    assert.equal(centsAEurTexto(1248055), '12480,55');
  });

  test('cuenta atras y severidad del plazo', () => {
    assert.equal(fmtCuentaAtras((2 * 86400 + 3 * 3600 + 5 * 60) * 1000), '2d 03h 05m');
    assert.equal(fmtCuentaAtras((5 * 3600 + 7) * 1000), '5h 00m 07s');
    assert.equal(fmtCuentaAtras(-1), 'vencido');
    assert.equal(severidadPlazo(60 * 3600 * 1000), 'bad');
    assert.equal(severidadPlazo(4 * 86400 * 1000), 'warn');
    assert.equal(severidadPlazo(9 * 86400 * 1000), 'ok');
  });
});

describe('fl-hub-logic: calendario', () => {
  test('mesGrid: 42 dias empezando en lunes', () => {
    const g = mesGrid(2026, 9); // octubre 2026: el 1 cae en jueves
    assert.equal(g.length, 42);
    assert.equal(g[0], '2026-09-28');
    assert.equal(g[3], '2026-10-01');
    assert.equal(g[41], '2026-11-08');
  });

  test('agruparEventos filtra por tipo y estado y ordena vencidos primero', () => {
    const ev = [
      { fecha: '2026-10-20', tipo: 'fiscal', estado: 'completado' },
      { fecha: '2026-10-20', tipo: 'fiscal', estado: 'vencido' },
      { fecha: '2026-10-20', tipo: 'contrato', estado: 'pendiente' },
      { fecha: '2026-10-21', tipo: 'legal', estado: 'informativo' },
    ];
    const todos = agruparEventos(ev, { tipos: new Set(['fiscal', 'contrato']) });
    assert.deepEqual(todos.get('2026-10-20').map((e) => e.estado), ['vencido', 'pendiente', 'completado']);
    assert.equal(todos.has('2026-10-21'), false);
    const pend = agruparEventos(ev, { tipos: new Set(['fiscal', 'contrato', 'legal']), estado: 'pendientes' });
    assert.equal(pend.get('2026-10-20').length, 2);
    assert.equal(pend.has('2026-10-21'), false);
  });
});

describe('fl-hub-logic: command bar', () => {
  const indice = construirIndice(DATA);

  test('NIF, numero de modelo, DEHu y referencia BOE', () => {
    assert.equal(buscar(indice, 'B00000003')[0].id, 's2');
    const m200 = buscar(indice, 'modelo 200');
    assert.equal(m200[0].id, 'm1');
    assert.ok(m200.every((r) => r.entidad === 'modelos'));
    const dehu = buscar(indice, 'DEHú AEAT');
    assert.deepEqual(dehu.map((r) => r.id), ['n1']);
    assert.equal(buscar(indice, 'BOE-A-2026-20976')[0].entidad, 'alertas');
    assert.equal(buscar(indice, 'art 43')[0].entidad, 'normas');
    assert.deepEqual(buscar(indice, ''), []);
    assert.deepEqual(buscar(indice, 'zzzz inexistente'), []);
  });
});

describe('fl-hub-logic: filtros', () => {
  test('modelos por estado (incluido vencido), administracion y texto', () => {
    assert.deepEqual(filtrarModelos(DATA.modelos, { estado: 'vencido' }).map((m) => m.id), ['m2']);
    assert.deepEqual(filtrarModelos(DATA.modelos, { administracion: 'HFN' }).map((m) => m.id), ['m3']);
    assert.deepEqual(filtrarModelos(DATA.modelos, { q: 'iva' }).map((m) => m.id), ['m2']);
    assert.deepEqual(filtrarModelos(DATA.modelos, { ejercicio: '2025', sociedad: 's2' }).map((m) => m.id), ['m1']);
  });

  test('notificaciones abiertas ordenadas por urgencia y sin acuse', () => {
    assert.deepEqual(filtrarNotificaciones(DATA.notificaciones, { estado: 'abiertas' }).map((n) => n.id), ['n2', 'n1']);
    assert.deepEqual(filtrarNotificaciones(DATA.notificaciones, { estado: 'sin_acuse' }).map((n) => n.id), ['n1']);
    assert.deepEqual(filtrarNotificaciones(DATA.notificaciones, { estado: 'todas', emisor: 'TGSS' }).map((n) => n.id), ['n2']);
  });

  test('contratos activos, cerrados y orden por riesgo o vencimiento', () => {
    assert.deepEqual(filtrarContratos(DATA.contratos, { estado: 'activos' }).map((c) => c.id), ['c2', 'c1']);
    assert.deepEqual(filtrarContratos(DATA.contratos, { estado: 'cerrados' }).map((c) => c.id), ['c3']);
    assert.deepEqual(filtrarContratos(DATA.contratos, { estado: 'todos', orden: 'riesgo' }).map((c) => c.id), ['c3', 'c1', 'c2']);
    assert.deepEqual(filtrarContratos(DATA.contratos, { estado: 'todos', q: '0 €/mwh' }).map((c) => c.id), ['c1']);
  });

  test('pasos de junta y nivel de riesgo', () => {
    assert.equal(pasoJunta('convocada'), 0);
    assert.equal(pasoJunta('formalizada'), 3);
    assert.equal(nivelRiesgo(29), 'bajo');
    assert.equal(nivelRiesgo(30), 'medio');
    assert.equal(nivelRiesgo(60), 'alto');
    assert.equal(nivelRiesgo(null), null);
  });
});
