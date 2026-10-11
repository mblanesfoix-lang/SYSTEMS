/**
 * Boletines oficiales de F&L (fl-boletines.js).
 *
 * Parte pura: parseo de sumarios con la misma forma que devuelve la API de
 * datos abiertos del BOE (objeto o array segun haya uno o varios elementos,
 * secciones sin departamentos), clasificador por reglas y vigilancia BORME.
 * Los titulos de los fixtures son reales (BOE y BORME de 2026-10-01 a
 * 2026-10-09) o variantes minimas de ellos.
 *
 * Parte Mongo: sincronizacion completa con un fetch falso (nunca sale a red),
 * contra una db propia porque los ficheros de test corren en paralelo. Se
 * salta sin MONGO_URI.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MongoClient } from 'mongodb';
import {
  parseBoeSumario, classifyBoeItem, parseBormeSumario, parseBormeIndice, extractBormeEntry,
  normalizeCompanyName, buildWatchList, matchCompany, ultimosDias, createBoletinesSync,
} from '../fl-boletines.js';

const item = (identificador, titulo) => ({
  identificador, control: '2026/1', titulo,
  url_pdf: { szBytes: '1', szKBytes: '1', texto: `https://www.boe.es/boe/dias/2026/10/01/pdfs/${identificador}.pdf` },
  url_html: `https://www.boe.es/diario_boe/txt.php?id=${identificador}`,
  url_xml: `https://www.boe.es/diario_boe/xml.php?id=${identificador}`,
});

const BOE_SUMARIO = {
  status: { code: '200', text: 'ok' },
  data: {
    sumario: {
      metadatos: { publicacion: 'BOE', fecha_publicacion: '20261001' },
      diario: [{
        numero: '244',
        seccion: [
          {
            codigo: '1', nombre: 'I. Disposiciones generales',
            departamento: [
              {
                codigo: '1', nombre: 'MINISTERIO PARA LA TRANSICIÓN ECOLÓGICA Y EL RETO DEMOGRÁFICO',
                epigrafe: [{ nombre: 'Residuos', item: item('BOE-A-2026-1001', 'Real Decreto 764/2026, de 30 de septiembre, por el que se regula el Registro de producción y gestión de residuos.') }],
              },
              {
                codigo: '2', nombre: 'MINISTERIO DE HACIENDA',
                item: [
                  item('BOE-A-2026-1002', 'Orden HAC/1/2026, por la que se aprueba el modelo 303 de autoliquidación del Impuesto sobre el Valor Añadido.'),
                  item('BOE-A-2026-1003', 'Orden por la que se regulan los precios públicos de los museos estatales.'),
                ],
              },
            ],
          },
          { codigo: '3', nombre: 'III. Otras disposiciones', texto: 'Sin departamentos' },
          {
            codigo: '3', nombre: 'III. Otras disposiciones',
            departamento: {
              codigo: '3', nombre: 'MINISTERIO DE TRANSPORTES Y MOVILIDAD SOSTENIBLE',
              epigrafe: { nombre: 'Concesiones', item: item('BOE-A-2026-1004', 'Resolución de la Autoridad Portuaria de Santander por la que se otorga una concesión administrativa.') },
            },
          },
          {
            codigo: '5A', nombre: 'V. Anuncios. - A. Contratación del Sector Público',
            departamento: [{ codigo: '4', nombre: 'MINISTERIO DE HACIENDA', item: item('BOE-A-2026-1005', 'Anuncio de licitación: servicio de gestión de residuos de los edificios de la Agencia Tributaria.') }],
          },
          {
            codigo: '5B', nombre: 'V. Anuncios. - B. Otros anuncios oficiales',
            departamento: [{ codigo: '5', nombre: 'MINISTERIO DE INCLUSIÓN', item: item('BOE-A-2026-1006', 'Anuncio sobre los bienes pertenecientes a la Tesorería General en Almería.') }],
          },
        ],
      }],
    },
  },
};

const BORME_SUMARIO = {
  status: { code: '200', text: 'ok' },
  data: {
    sumario: {
      metadatos: { publicacion: 'BORME', fecha_publicacion: '20261001' },
      diario: [{
        numero: '190',
        seccion: [
          {
            codigo: 'A', nombre: 'SECCIÓN PRIMERA. Empresarios. Actos inscritos',
            item: [
              { identificador: 'BORME-A-2026-190-31', titulo: 'NAVARRA', url_pdf: { texto: 'https://www.boe.es/borme/dias/2026/10/01/pdfs/BORME-A-2026-190-31.pdf' }, url_html: 'https://www.boe.es/diario_borme/txt.php?id=BORME-A-2026-190-31' },
              { identificador: 'BORME-A-2026-190-99', titulo: 'ÍNDICE ALFABÉTICO DE SOCIEDADES', url_html: 'https://www.boe.es/diario_borme/txt.php?id=BORME-A-2026-190-99' },
            ],
          },
          {
            codigo: 'C', nombre: 'SECCIÓN SEGUNDA. Anuncios y avisos legales',
            apartado: [
              { nombre: 'CONVOCATORIAS DE JUNTAS', item: { identificador: 'BORME-C-2026-5001', titulo: 'SOUTH-NAVARRE FRESH INNOVATIONS, S.L.', url_html: 'https://www.boe.es/diario_borme/txt.php?id=BORME-C-2026-5001' } },
              { nombre: 'FUSIONES Y ABSORCIONES DE EMPRESAS', item: [{ identificador: 'BORME-C-2026-5002', titulo: 'DIFONSUR, S.L.' }] },
            ],
          },
        ],
      }],
    },
  },
};

const BORME_INDICE_HTML = `<div id="textoxslt"><table class="sinbordes"><tbody>
  <tr><td>A 15 MOTOR NOAIN SL.</td><td><p class="cuerpo_tabla_izq">BORME-A-2026-190-31</p></td><td align="right">
        (451283)
    </td></tr>
  <tr><td>ACTIVA M&amp;O CONSTRUCTION SA.</td><td><p class="cuerpo_tabla_izq">BORME-A-2026-190-20</p></td><td align="right">(450433)</td></tr>
  <tr><td>S-NFI VANGUARD SLU.</td><td><p class="cuerpo_tabla_izq">BORME-A-2026-190-31</p></td><td align="right">(451230)</td></tr>
</tbody></table></div>`;

const BORME_NAVARRA_HTML = `<div id="textoxslt">
<p class="parrafo">451229 - INSTALACIONES TERMICAS YERMO SL.</p>
<p class="parrafo_2">Ceses/Dimisiones. Adm. Mancom.: TERUEL MINA ENRIQUE.  Datos registrales. S 8 , H NA 38948, I/A 4 ( 1.10.26).</p>
<p class="parrafo">451230 - S-NFI VANGUARD SLU.</p>
<p class="parrafo_2">Nombramientos. Apoderado: MENDIVIL RUIZ PAULA.  Datos registrales. S 8 , H NA 45783, I/A 2 ( 1.10.26).</p>
<p class="parrafo">451231 - MANTENIMIENTOS JESUS LEGARDA SL.</p>
<p class="parrafo_2">Cambio de domicilio social.</p>
</div>`;

describe('fl-boletines: parseo y clasificacion (puro)', () => {
  test('parseBoeSumario normaliza objeto/array y tolera secciones sin departamentos', () => {
    const { fecha, items } = parseBoeSumario(BOE_SUMARIO);
    assert.equal(fecha, '20261001');
    assert.deepEqual(items.map((i) => i.identificador), ['BOE-A-2026-1001', 'BOE-A-2026-1002', 'BOE-A-2026-1003', 'BOE-A-2026-1004', 'BOE-A-2026-1005', 'BOE-A-2026-1006']);
    const rd = items[0];
    assert.equal(rd.seccion, '1');
    assert.equal(rd.epigrafe, 'Residuos');
    assert.match(rd.url_pdf, /BOE-A-2026-1001\.pdf$/);
  });

  test('classifyBoeItem: residuos en disposiciones generales de MITECO es relevancia alta', () => {
    const [rd, orden303, museos, puerto, licitacion, pertenecientes] = parseBoeSumario(BOE_SUMARIO).items;
    const c = classifyBoeItem(rd);
    assert.deepEqual(c.categorias, ['residuos']);
    assert.equal(c.puntuacion, 7);
    assert.equal(c.relevancia, 'alta');

    const f = classifyBoeItem(orden303);
    assert.ok(f.categorias.includes('fiscal'));
    assert.equal(f.relevancia, 'media');

    assert.equal(classifyBoeItem(museos), null);
    // "Movilidad Sostenible" esta en el ministerio, no en el titulo: no cuenta.
    assert.equal(classifyBoeItem(puerto), null);
    // Contratacion publica (V-A) queda fuera aunque hable de residuos.
    assert.equal(classifyBoeItem(licitacion), null);
    // "pertenecientes" no es la sigla PERTE.
    assert.equal(classifyBoeItem(pertenecientes), null);
  });

  test('parseBormeSumario separa el indice alfabetico, provincias y anuncios', () => {
    const { indice, anuncios, provincias } = parseBormeSumario(BORME_SUMARIO);
    assert.equal(indice.identificador, 'BORME-A-2026-190-99');
    assert.ok(provincias.has('BORME-A-2026-190-31'));
    assert.equal(anuncios.length, 2);
    assert.equal(anuncios[0].apartado, 'CONVOCATORIAS DE JUNTAS');
  });

  test('parseBormeIndice decodifica entidades y extractBormeEntry corta en el acto siguiente', () => {
    const rows = parseBormeIndice(BORME_INDICE_HTML);
    assert.equal(rows.length, 3);
    assert.equal(rows[1].nombre, 'ACTIVA M&O CONSTRUCTION SA.');
    assert.deepEqual(rows[2], { nombre: 'S-NFI VANGUARD SLU.', identificador: 'BORME-A-2026-190-31', numero: '451230' });

    const acto = extractBormeEntry(BORME_NAVARRA_HTML, '451230');
    assert.match(acto, /^451230 - S-NFI VANGUARD SLU\. Nombramientos\. Apoderado: MENDIVIL RUIZ PAULA/);
    assert.doesNotMatch(acto, /LEGARDA/);
    assert.equal(extractBormeEntry(BORME_NAVARRA_HTML, '999999'), null);
  });

  test('normalizeCompanyName y matchCompany comparan la denominacion sin forma juridica', () => {
    assert.equal(normalizeCompanyName('South-Navarre Fresh Innovations, S.L.'), 'SOUTH NAVARRE FRESH INNOVATIONS');
    assert.equal(normalizeCompanyName('SOUTH-NAVARRE FRESH INNOVATIONS SL.'), 'SOUTH NAVARRE FRESH INNOVATIONS');
    assert.equal(normalizeCompanyName('S-NFI Vanguard, Sociedad Limitada Unipersonal'), 'S NFI VANGUARD');
    const watch = buildWatchList([
      { _id: 'corp', denominacion: 'South-Navarre Fresh Innovations, S.L.', borme_alias: ['S-NFI Corp'] },
      { _id: 'vanguard', denominacion: 'S-NFI Vanguard, S.L.U.' },
    ]);
    assert.equal(matchCompany('S-NFI CORP SA.', watch), 'corp');
    assert.equal(matchCompany('S-NFI VANGUARD SLU.', watch), 'vanguard');
    assert.equal(matchCompany('S-NFI VANGUARD SOLUTIONS SL.', watch), null);
  });

  test('ultimosDias devuelve la ventana del mas antiguo al mas reciente', () => {
    assert.deepEqual(ultimosDias('2026-10-02', 3), ['2026-09-30', '2026-10-01', '2026-10-02']);
  });
});

const MONGO_URI = process.env.MONGO_URI;

describe('fl-boletines: sincronizacion contra Mongo con fetch falso', { skip: !MONGO_URI && 'MONGO_URI no configurada' }, () => {
  let client;
  let db;
  const avisos = [];
  const logs = [];
  const llamadas = [];

  function fakeFetch(url) {
    llamadas.push(url);
    const ok = (body, type = 'json') => Promise.resolve({
      ok: true, status: 200,
      json: async () => body,
      text: async () => (type === 'json' ? JSON.stringify(body) : body),
    });
    if (url.endsWith('/boe/sumario/20261001')) return ok(BOE_SUMARIO);
    if (url.endsWith('/borme/sumario/20261001')) return ok(BORME_SUMARIO);
    if (url.includes('BORME-A-2026-190-99')) return ok(BORME_INDICE_HTML, 'html');
    if (url.includes('BORME-A-2026-190-31')) return ok(BORME_NAVARRA_HTML, 'html');
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}), text: async () => '' });
  }

  before(async () => {
    client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db('elvira_test_flboletines');
    await db.dropDatabase();
    await db.collection('fl_sociedades').insertMany([
      { _id: 'corp', denominacion: 'South-Navarre Fresh Innovations, S.L.', borme_alias: [] },
      { _id: 'vanguard', denominacion: 'S-NFI Vanguard, S.L.U.', borme_alias: [] },
      { _id: 'archivada', denominacion: 'Difonsur, S.L.', deleted: true },
    ]);
  });

  after(async () => {
    await db.dropDatabase();
    await client.close();
  });

  const crear = () => createBoletinesSync({
    mongo: db, fetchImpl: fakeFetch, pauseMs: 0, today: () => '2026-10-02',
    adminNotify: (n) => avisos.push(n), appendLog: async (e) => { logs.push(e); },
  });

  test('primera sincronizacion: BOE clasificado, anuncio BORME y acto inscrito de sociedades del grupo', async () => {
    const r = await crear().sync({ dias: 2 });
    assert.deepEqual(r.errores, []);
    assert.equal(r.dias, 2);

    const alertas = await db.collection('fl_alertas_normativas').find({}).sort({ _id: 1 }).toArray();
    const ids = alertas.map((a) => a._id);
    assert.deepEqual(ids, ['BOE-A-2026-1001', 'BOE-A-2026-1002', 'BORME-A-2026-190-31_451230', 'BORME-C-2026-5001']);

    const anuncio = alertas.find((a) => a._id === 'BORME-C-2026-5001');
    assert.equal(anuncio.sociedad_id, 'corp');
    assert.equal(anuncio.fecha_publicacion, '2026-10-01');
    const acto = alertas.find((a) => a._id === 'BORME-A-2026-190-31_451230');
    assert.equal(acto.sociedad_id, 'vanguard');
    assert.match(acto.acto, /Nombramientos\. Apoderado/);
    // Sociedad archivada: no se vigila.
    assert.ok(!ids.includes('BORME-C-2026-5002'));

    assert.equal(avisos.filter((a) => a.label.startsWith('BORME')).length, 2);
    assert.equal(avisos.filter((a) => a.label.startsWith('BOE')).length, 1);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].detail.nuevas, 4);

    const status = await db.collection('fl_meta').findOne({ _id: 'boletines_status' });
    assert.ok(status.ultimoOk);
    assert.equal(status.ultimoError, null);
  });

  test('segunda sincronizacion: dia pasado cerrado, estado de revision conservado', async () => {
    await db.collection('fl_alertas_normativas').updateOne({ _id: 'BOE-A-2026-1001' }, { $set: { estado: 'revisada' } });
    llamadas.length = 0;
    avisos.length = 0;
    const r = await crear().sync({ dias: 2 });
    assert.equal(r.nuevas, 0);
    // El 1 de octubre ya estaba completo: solo se vuelve a pedir "hoy" (2 de octubre, 404).
    assert.ok(llamadas.every((u) => u.includes('20261002')));
    assert.equal((await db.collection('fl_alertas_normativas').findOne({ _id: 'BOE-A-2026-1001' })).estado, 'revisada');
    assert.equal(avisos.length, 0);
  });

  test('un fallo de red se registra como error sin marcar el dia como completo', async () => {
    const roto = createBoletinesSync({
      mongo: db, pauseMs: 0, today: () => '2026-10-05', appendLog: async () => {},
      fetchImpl: () => Promise.reject(new Error('ECONNRESET')),
    });
    const r = await roto.sync({ dias: 1 });
    assert.equal(r.errores.length, 1);
    assert.match(r.errores[0], /2026-10-05: ECONNRESET/);
    assert.equal(await db.collection('fl_meta').findOne({ _id: 'boletines:2026-10-05' }), null);
    const status = await roto.status();
    assert.match(status.ultimoError, /ECONNRESET/);
  });
});
