/**
 * S-NFI F&L — Expediente Fiscal y Juridico Impecable (2026-09-14)
 * Endurecimiento de seguridad (2026-09-20): ver bloque "SEGURIDAD" abajo.
 *
 * CRM de documentacion corporativa: archivador donde el humano da de alta los
 * documentos que debe mantener al dia, adjunta el PDF de cada uno y recibe
 * aviso cuando caducan. Incluye NDA-B bilaterales y documentacion protegida
 * por la empresa — trato distinto del resto de F&L (licencias/poderes).
 *
 * Modulo separado de fl.js a proposito: fl.js ya son ~937 lineas (licencias,
 * matriz de riesgo, poderes) y este bloque es CRUD + GridFS. Comparte log
 * inmutable (fl_log con hash chain) pero YA NO comparte guard con fl.js —
 * ver SEGURIDAD.
 *
 * Estructura: CARPETAS FIJAS (los 4 bloques doctrinales A/B/C/D), DOCUMENTOS
 * LIBRES dentro de cada una. El humano crea, edita, mueve y borra registros
 * con el nombre que quiera. Los 12 documentos del enunciado original se
 * precargan una sola vez (seed idempotente) como registros normales: se pueden
 * editar y borrar como cualquier otro, no son slots fijos.
 *
 * Un archivo por documento: subir uno nuevo reemplaza el anterior (el viejo se
 * borra de GridFS). Decision explicita del usuario.
 *
 * Colecciones:
 *   fl_expediente_docs        ficha de cada documento
 *   fl_expediente_files.*     GridFS (contenido SIEMPRE cifrado, ver SEGURIDAD)
 *
 * ------------------------------ RETENCION (2026-09-28) ------------------------------
 * Incidente: los 12 documentos originales (seed "A1".."D2") se perdieron sin
 * dejar rastro en fl_log — un DELETE real (documento + archivo GridFS en el
 * mismo acto, sin papelera) borrado de forma irreversible en una sesion de
 * mantenimiento que asumio erroneamente que estaban vacios. Directriz
 * explicita del jefe: "esos documentos de ahi no se pueden eliminar".
 *
 * DELETE deja de borrar de verdad. Tanto el documento (fl_expediente_docs)
 * como su archivo (GridFS) usan SOFT-DELETE: se marcan deleted/deletedAt/
 * deletedBy y se ocultan de las vistas normales, pero el registro y el
 * fichero cifrado permanecen en Mongo. Restaurable via POST .../restore.
 * Purga real (irreversible) NO existe como endpoint HTTP — si algun dia hace
 * falta, es una operacion manual de base de datos, nunca un click de la UI.
 * ---------------------------------------------------------------------------------------
 *
 * Clave de cifrado: SOLO env FL_EXPEDIENTE_ENC_KEY, sin fallback Mongo
 * (retirado 2026-09-20) — ver getEncKey() mas abajo.
 *
 * Patron de subida: raw sin multer (Content-Type del archivo + cabecera
 * X-Filename), identico a finance-companies.js y herzog.js.
 *
 * Alertas: motor in-process (revision al arrancar y cada 24h) contra
 * adminNotify + busEmit, y calculo en vivo en GET /api/fl/expediente/alertas
 * para que la UI pinte los avisos sin esperar al ciclo diario.
 *
 * ------------------------------ SEGURIDAD (2026-09-20) ------------------------------
 * Directriz explicita del jefe: el expediente contiene NDA-B bilaterales y
 * documentacion que "nadie debe ni puede ver" fuera de quien tiene que verla.
 * Capas añadidas sobre el diseño original:
 *
 *  1. Guard propio: requireMesa('fl_expediente') en vez de requireMesa('fl').
 *     Hoy ambas mesas solo las tiene 'admin' en ROLE_MESAS (server.js), pero
 *     quedan desacopladas: el dia que 'fl' se abra a mas roles (licencias
 *     operativas), el expediente NO se abre con ella.
 *
 *  2. Cifrado en reposo (AES-256-GCM, node:crypto) de CADA archivo antes de
 *     escribirlo a GridFS. Clave de 32 bytes SOLO desde env
 *     FL_EXPEDIENTE_ENC_KEY (hex, vault/panel Coolify, mismo criterio que
 *     CIBE_PRIVATE_KEY_PEM) — sin fallback Mongo (retirado 2026-09-20,
 *     directriz explicita: la llave vive estrictamente en variables de
 *     entorno del servidor). Falta o formato invalido = el modulo no monta
 *     y sus rutas responden 503 (ver getEncKey() y safeMount en server.js). Un dump de
 *     Mongo/GridFS sin la clave no revela el contenido de los documentos. IV
 *     aleatorio de 12 bytes por archivo + authTag GCM guardados junto al
 *     fichero (metadata), nunca reutilizados.
 *
 *  3. Descarga detras de token CIBE (bunker de Pactvm Viridi, scope
 *     'fl.expediente.read'): mismo mecanismo zero-trust que ya protege los
 *     endpoints criticos de OPHS/Grid/Rack/Foundry. En CIBE_MODE=auto (por
 *     defecto) una sesion admin valida basta y el token se expide en linea
 *     (trazado); en CIBE_MODE=strict exige cabecera X-CIBE-Token explicita.
 *     Sin conformidad CIBE, Auth-Refusal (403) igual que el resto del bunker.
 *
 *  4. Auditoria de LECTURA, no solo de escritura: cada descarga exitosa deja
 *     entrada expediente.archivo.download en fl_log (hash chain) con
 *     actorId + docId + fileId, ademas de lo que ya registraba CIBE en
 *     cibe_log para la expedicion del token.
 *
 *  5. Metadatos NDA por documento: campos confidencial (bool), nda_referencia
 *     y nda_contraparte, editables en la ficha. No cambian el control de
 *     acceso (todo el expediente ya esta protegido por 1-4) pero permiten
 *     identificar y filtrar los documentos bajo NDA-B sin auditar a mano.
 *
 * PIN de entrada (2026-09-20, retirado el mismo dia): se probo un codigo fijo
 * de 4 digitos como paso adicional de entrada; el jefe decidio eliminarlo por
 * ser "seguridad de teatro" (identifica sesion, no persona; compartido entre
 * todos los que tengan la mesa) y dejar el acceso apoyado unicamente en
 * auth+rol (requireMesa('fl_expediente')) mas las 5 capas reales de arriba.
 * -------------------------------------------------------------------------------------
 */

import crypto from 'node:crypto';
import express from 'express';
import { GridFSBucket, ObjectId } from 'mongodb';
import { runAsTenant } from './db/tenant-context.js';
import { DEFAULT_TENANT_ID } from './db/tenant-registry.js';
import { appendChained } from './lib/hash-chain.js';

const ENC_ALGO = 'aes-256-gcm';
const ENC_IV_LEN = 12;

const DOCUMENT_TYPES = [
  'application/pdf',
  'image/jpeg', 'image/png', 'image/webp',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];

const MAX_UPLOAD_MB = 24;

/* Estados del documento. 'por_caducar' y 'caducado' los mueve el motor de
   alarmas; el resto los fija el humano. */
export const ESTADOS_DOC = ['pendiente', 'en_tramite', 'vigente', 'por_caducar', 'caducado', 'no_aplica'];

/* Regimen de caducidad de un documento:
     'no'       perpetuo (escrituras, C.I.F.) — nunca alerta por fecha
     'si'       vence de verdad — entra en el motor de alarmas
     'revision' no caduca legalmente pero se desactualiza (drafts, dossieres) */
export const REGIMENES = ['no', 'si', 'revision'];

const DIAS_ALERTA_DEFECTO = 60;

/**
 * Carpetas fijas del expediente: los 4 bloques doctrinales. Fijas a proposito,
 * igual criterio que COMPANY_FOLDERS en finance-companies.js — el archivo no
 * debe divergir en taxonomias inventadas. Ampliar aqui si el jefe pide mas.
 */
export const EXPEDIENTE_BLOQUES = [
  {
    key: 'A',
    label: 'Bloque A · Identidad e Inmunidad Fiscal',
    descripcion: 'Acredita la existencia legal, el alta fiscal y la neutralidad de la estructura Holding.',
  },
  {
    key: 'B',
    label: 'Bloque B · Foso Defensivo de Propiedad Intelectual',
    descripcion: 'El activo real: registros de PI a nombre de la filial y cesion controlada del Kernel a los SPVs.',
  },
  {
    key: 'C',
    label: 'Bloque C · DataRoom Financiero de Grado Banco',
    descripcion: 'S_NFI_Finance.pdf: Project Finance DataRoom Dossier impreso en alta calidad.',
  },
  {
    key: 'D',
    label: 'Bloque D · Anclaje Comercial (El EBITDA Futuro)',
    descripcion: 'Compromisos de entrada de residuo y salida de biopellet que sostienen la proyeccion de ingresos.',
  },
];

const BLOQUE_KEYS = EXPEDIENTE_BLOQUES.map(b => b.key);

/**
 * Semilla: los 12 documentos del enunciado, cargados una sola vez como
 * registros NORMALES (editables y borrables). El flag seed_key evita
 * duplicarlos en arranques posteriores; si el humano borra uno, no vuelve.
 */
const SEED_DOCUMENTOS = [
  {
    seed_key: 'A1', bloque: 'A',
    nombre: 'Copia Simple de la Escritura de S-NFI Vanguard S.L.U.',
    descripcion: 'Con la Clausula SEPTIMA: solicitud telematica de C.I.F. ante la Hacienda Foral de Navarra.',
    regimen: 'no', dias_alerta: 0,
  },
  {
    seed_key: 'A2', bloque: 'A',
    nombre: 'Tarjeta de C.I.F. Definitivo de S-NFI Corp. + Modelo 036',
    descripcion: 'C.I.F. definitivo junto al Modelo 036 (Pre-Alta IAE).',
    regimen: 'no', dias_alerta: 0,
  },
  {
    seed_key: 'A3', bloque: 'A',
    nombre: 'Certificado Notarial del Regimen FEAC',
    descripcion: 'Acredita la neutralidad fiscal y la estructura Holding sin fisuras.',
    regimen: 'revision', dias_alerta: 90,
  },
  {
    seed_key: 'A4', bloque: 'A',
    nombre: 'Certificado de Codigo DUNS activo (Dun & Bradstreet)',
    descripcion: 'Codigo DUNS activo para S-NFI Corp. Requiere renovacion/validacion periodica.',
    regimen: 'si', dias_alerta: 60,
  },
  {
    seed_key: 'B1', bloque: 'B',
    nombre: 'Certificado de Registro en la OEPM (Modelo de Utilidad / Patente)',
    descripcion: 'A nombre de la filial. Vigilar tasas de mantenimiento y plazos de renovacion.',
    regimen: 'si', dias_alerta: 120,
  },
  {
    seed_key: 'B2', bloque: 'B',
    nombre: 'Titulo de Marca Internacional Class 40 (S-NFI)',
    descripcion: 'Registro de marca internacional en Clase 40. Renovacion decenal.',
    regimen: 'si', dias_alerta: 180,
  },
  {
    seed_key: 'B3', bloque: 'B',
    nombre: 'Contrato Privado de Licencia Inter-Company (Draft)',
    descripcion: 'La Holding cede el software Kernel/PAIA a los SPVs con clausula de revocacion automatica (Pactvm Viridi), garantizando el cobro del canon en Tramo 1.',
    regimen: 'revision', dias_alerta: 90,
  },
  {
    seed_key: 'C1', bloque: 'C',
    nombre: 'Seccion DSCR (6,36x) y LLCR (7,12x)',
    descripcion: 'Enfatiza que la cuota del banco esta respaldada mas de 6 veces por el flujo de caja operativo.',
    regimen: 'revision', dias_alerta: 90,
  },
  {
    seed_key: 'C2', bloque: 'C',
    nombre: 'Cascada de Pagos (Cash Waterfall)',
    descripcion: 'Muestra como la cuenta bancaria en el propio Sabadell tendra pignorada la prioridad de cobro para el servicio de su deuda (Tramo 2).',
    regimen: 'revision', dias_alerta: 90,
  },
  {
    seed_key: 'C3', bloque: 'C',
    nombre: 'Modelo LCOE / Curtailment a 0,0 EUR/MWh',
    descripcion: 'Prueba de margen bruto del 67,9%.',
    regimen: 'revision', dias_alerta: 90,
  },
  {
    seed_key: 'D1', bloque: 'D',
    nombre: 'Borrador o MOU del Contrato PPA de absorcion',
    descripcion: 'Entrada a 0 EUR. MOU o borrador firmado con la contraparte.',
    regimen: 'si', dias_alerta: 60,
  },
  {
    seed_key: 'D2', bloque: 'D',
    nombre: 'Borrador del Off-Take Comercial de Biopellet',
    descripcion: 'Take-or-Pay a 110-130 EUR/t.',
    regimen: 'si', dias_alerta: 60,
  },
];

function withId(doc) {
  if (!doc) return doc;
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
}

/**
 * Clave de cifrado del expediente (AES-256-GCM, 32 bytes).
 * OBLIGATORIA desde env FL_EXPEDIENTE_ENC_KEY (hex, 64 caracteres) — vault/
 * panel Coolify, mismo criterio que CIBE_PRIVATE_KEY_PEM. Sin fallback a
 * Mongo (retirado 2026-09-20, directriz explicita del jefe: la llave de
 * cifrado vive estrictamente en variables de entorno del servidor, nunca
 * generada/persistida por la propia app). Falta o formato invalido = arranque
 * de este modulo falla alto y claro (no silencioso) — mejor tumbar el mount
 * que servir el expediente sin garantia de cifrado real.
 */
function getEncKey() {
  const envKey = process.env.FL_EXPEDIENTE_ENC_KEY;
  if (!envKey) {
    throw new Error('FL_EXPEDIENTE_ENC_KEY no definida en env — obligatoria para cifrar el Expediente Fiscal y Juridico (sin fallback Mongo, ver fl-expediente.js)');
  }
  if (!/^[0-9a-fA-F]{64}$/.test(envKey)) {
    throw new Error('FL_EXPEDIENTE_ENC_KEY invalida — se esperan 64 caracteres hex (32 bytes)');
  }
  return Buffer.from(envKey, 'hex');
}

/** Cifra un Buffer. Devuelve { ciphertext, iv, authTag } listos para GridFS/metadata. */
function encryptBuffer(plain) {
  const key = getEncKey();
  const iv = crypto.randomBytes(ENC_IV_LEN);
  const cipher = crypto.createCipheriv(ENC_ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { ciphertext, iv: iv.toString('base64'), authTag: authTag.toString('base64') };
}

/** Descifra usando iv/authTag guardados en metadata del fichero GridFS. */
function decryptBuffer(ciphertext, ivB64, authTagB64) {
  const key = getEncKey();
  const decipher = crypto.createDecipheriv(ENC_ALGO, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/* Misma cadena fl_log que el Hub (fl-hub.js), que la verifica. */
const appendFlLog = (mongo, entry) => appendChained(mongo, 'fl_log', entry);

function isValidDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

function daysUntil(dateStr) {
  if (!isValidDate(dateStr)) return null;
  const target = new Date(`${dateStr}T00:00:00Z`).getTime();
  const today = new Date();
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((target - todayUtc) / (1000 * 60 * 60 * 24));
}

function filesBucket(mongo) {
  return new GridFSBucket(mongo, { bucketName: 'fl_expediente_files' });
}

function str(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/**
 * Aviso de un documento: tipo, dias y severidad. null si no genera alerta.
 * Un documento sin archivo adjunto se considera faltante aunque tenga ficha.
 */
function evaluarAlerta(doc) {
  if (!doc || doc.estado === 'no_aplica') return null;

  const base = { docId: doc._id, bloque: doc.bloque, nombre: doc.nombre };

  if (isValidDate(doc.fecha_caducidad) && doc.regimen !== 'no') {
    const dias = daysUntil(doc.fecha_caducidad);
    const umbral = Number.isFinite(Number(doc.dias_alerta)) ? Number(doc.dias_alerta) : DIAS_ALERTA_DEFECTO;
    if (dias < 0) {
      return { ...base, tipo: 'caducado', dias, severity: 'error', mensaje: `CADUCADO hace ${Math.abs(dias)} dias: ${doc.nombre}` };
    }
    if (dias <= umbral) {
      return { ...base, tipo: 'por_caducar', dias, severity: dias <= 15 ? 'error' : 'warning', mensaje: `Caduca en ${dias} dias: ${doc.nombre}` };
    }
  }

  // Sin archivo y sin marcar como no aplicable: sigue faltando por aportar.
  if (!doc.file_id && doc.estado !== 'vigente') {
    return { ...base, tipo: 'faltante', dias: null, severity: 'warning', mensaje: `Documento pendiente de aportar: ${doc.nombre}` };
  }

  return null;
}

/* Proyeccion que se devuelve al frontend: ficha + datos derivados. */
function serializeDoc(doc) {
  return {
    ...withId(doc),
    diasRestantes: daysUntil(doc.fecha_caducidad),
    alerta: evaluarAlerta(doc),
  };
}

export function mountFlExpediente(app, { auth, requireMesa, mongo, busEmit, adminNotify, cibe }) {
  // Sin clave de cifrado valida en env este modulo no se monta: lanza antes de
  // registrar ninguna ruta, server.js lo deja degradado y /api/fl/expediente
  // responde 503. Nunca se sirve sin garantia real de cifrado (ver getEncKey()
  // y nota SEGURIDAD arriba).
  getEncKey();
  console.log('[FL/Expediente] Clave de cifrado cargada desde FL_EXPEDIENTE_ENC_KEY (env)');

  const router = app;
  // Guard propio (fl_expediente), distinto de 'fl' — ver bloque SEGURIDAD arriba.
  const guard = [auth, requireMesa('fl_expediente')];
  const col = () => mongo.collection('fl_expediente_docs');

  /* --------------------------------------------------------------------------
     Seed idempotente de los 12 documentos del enunciado.

     Se cargan como registros normales (editables/borrables). Marcador
     fl_expediente_seed en fl_meta: si ya corrio, no vuelve a insertar aunque
     el humano los haya borrado — borrar significa "no lo quiero", no
     "recargalo en el proximo arranque".
  -------------------------------------------------------------------------- */
  async function seedDocumentos() {
    try {
      const meta = mongo.collection('fl_meta');
      const done = await meta.findOne({ _id: 'fl_expediente_seed' });
      if (done) return;
      const now = new Date().toISOString();
      const docs = SEED_DOCUMENTOS.map((s, i) => ({
        _id: crypto.randomUUID(),
        bloque: s.bloque,
        nombre: s.nombre,
        descripcion: s.descripcion,
        regimen: s.regimen,
        estado: 'pendiente',
        fecha_emision: null,
        fecha_caducidad: null,
        dias_alerta: s.dias_alerta,
        emisor: null,
        referencia: null,
        notas: '',
        confidencial: s.bloque === 'B' || s.bloque === 'D',
        nda_referencia: null,
        nda_contraparte: null,
        orden: i,
        file_id: null,
        file_name: null,
        file_size: null,
        file_type: null,
        file_sha256: null,
        file_iv: null,
        file_auth_tag: null,
        file_uploaded_at: null,
        seed_key: s.seed_key,
        createdBy: 'system',
        createdAt: now,
        updatedAt: now,
      }));
      await col().insertMany(docs);
      await meta.insertOne({ _id: 'fl_expediente_seed', at: now, count: docs.length });
      await appendFlLog(mongo, { action: 'expediente.seed', actorId: 'system', detail: { count: docs.length } });
      console.log(`[FL/Expediente] Seed inicial: ${docs.length} documentos precargados`);
    } catch (err) {
      console.error('[FL/Expediente] Error en seedDocumentos:', err.message);
    }
  }

  /* --------------------------------------------------------------------------
     Catalogo de carpetas y vista del expediente
  -------------------------------------------------------------------------- */

  router.get('/api/fl/expediente/meta', ...guard, (req, res) => {
    res.json({
      bloques: EXPEDIENTE_BLOQUES,
      estados: ESTADOS_DOC,
      regimenes: REGIMENES,
      maxUploadMb: MAX_UPLOAD_MB,
    });
  });

  // Vista completa: carpetas con sus documentos. Filtros opcionales por
  // bloque, estado y texto libre (nombre/emisor/referencia). Soft-deleted
  // fuera por defecto (ver RETENCION); ?includeDeleted=1 para la papelera.
  router.get('/api/fl/expediente', ...guard, async (req, res) => {
    const filter = req.query.includeDeleted === '1' ? {} : { deleted: { $ne: true } };
    if (req.query.bloque && BLOQUE_KEYS.includes(String(req.query.bloque))) filter.bloque = String(req.query.bloque);
    if (req.query.estado && ESTADOS_DOC.includes(String(req.query.estado))) filter.estado = String(req.query.estado);
    const q = str(req.query.q, 120);
    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ nombre: rx }, { emisor: rx }, { referencia: rx }, { descripcion: rx }];
    }

    const rows = await col().find(filter).sort({ bloque: 1, orden: 1, createdAt: 1 }).toArray();
    const porBloque = new Map(BLOQUE_KEYS.map(k => [k, []]));
    for (const r of rows) {
      if (!porBloque.has(r.bloque)) porBloque.set(r.bloque, []);
      porBloque.get(r.bloque).push(serializeDoc(r));
    }
    res.json({
      bloques: EXPEDIENTE_BLOQUES.map(b => ({ ...b, documentos: porBloque.get(b.key) || [] })),
      total: rows.length,
    });
  });

  router.get('/api/fl/expediente/documentos/:id', ...guard, async (req, res) => {
    const row = await col().findOne({ _id: String(req.params.id) });
    if (!row) return res.status(404).json({ error: 'documento no encontrado' });
    res.json(serializeDoc(row));
  });

  /* --------------------------------------------------------------------------
     CRUD de documentos (el humano da de alta lo que quiera)
  -------------------------------------------------------------------------- */

  router.post('/api/fl/expediente/documentos', ...guard, async (req, res) => {
    const b = req.body || {};
    const nombre = str(b.nombre, 250);
    if (!nombre) return res.status(400).json({ error: 'nombre requerido' });
    if (!BLOQUE_KEYS.includes(b.bloque)) return res.status(400).json({ error: `bloque debe ser: ${BLOQUE_KEYS.join(', ')}` });
    const regimen = REGIMENES.includes(b.regimen) ? b.regimen : 'si';
    if (b.fecha_emision && !isValidDate(b.fecha_emision)) return res.status(400).json({ error: 'fecha_emision invalida (YYYY-MM-DD)' });
    if (b.fecha_caducidad && !isValidDate(b.fecha_caducidad)) return res.status(400).json({ error: 'fecha_caducidad invalida (YYYY-MM-DD)' });

    const diasAlerta = Number(b.dias_alerta);
    const now = new Date().toISOString();
    const doc = {
      _id: crypto.randomUUID(),
      bloque: b.bloque,
      nombre,
      descripcion: str(b.descripcion, 1000) || null,
      regimen,
      estado: ESTADOS_DOC.includes(b.estado) ? b.estado : 'pendiente',
      fecha_emision: b.fecha_emision || null,
      fecha_caducidad: b.fecha_caducidad || null,
      dias_alerta: Number.isFinite(diasAlerta) && diasAlerta >= 0 ? diasAlerta : DIAS_ALERTA_DEFECTO,
      emisor: str(b.emisor, 200) || null,
      referencia: str(b.referencia, 200) || null,
      notas: str(b.notas, 2000),
      confidencial: b.confidencial === true,
      nda_referencia: str(b.nda_referencia, 200) || null,
      nda_contraparte: str(b.nda_contraparte, 200) || null,
      orden: 999,
      file_id: null,
      file_name: null,
      file_size: null,
      file_type: null,
      file_sha256: null,
      file_iv: null,
      file_auth_tag: null,
      file_uploaded_at: null,
      seed_key: null,
      createdBy: req.user,
      createdAt: now,
      updatedAt: now,
    };
    await col().insertOne(doc);
    await appendFlLog(mongo, { action: 'expediente.doc.create', actorId: req.user, detail: { docId: doc._id, bloque: doc.bloque, nombre, confidencial: doc.confidencial } });
    res.status(201).json(serializeDoc(doc));
  });

  router.patch('/api/fl/expediente/documentos/:id', ...guard, async (req, res) => {
    const prev = await col().findOne({ _id: String(req.params.id) });
    if (!prev) return res.status(404).json({ error: 'documento no encontrado' });
    const b = req.body || {};
    const $set = { updatedAt: new Date().toISOString(), updatedBy: req.user };

    if (b.nombre !== undefined) {
      const nombre = str(b.nombre, 250);
      if (!nombre) return res.status(400).json({ error: 'nombre no puede quedar vacio' });
      $set.nombre = nombre;
    }
    if (b.bloque !== undefined) {
      if (!BLOQUE_KEYS.includes(b.bloque)) return res.status(400).json({ error: `bloque debe ser: ${BLOQUE_KEYS.join(', ')}` });
      $set.bloque = b.bloque;
    }
    if (b.descripcion !== undefined) $set.descripcion = str(b.descripcion, 1000) || null;
    if (b.regimen !== undefined) {
      if (!REGIMENES.includes(b.regimen)) return res.status(400).json({ error: `regimen debe ser: ${REGIMENES.join(', ')}` });
      $set.regimen = b.regimen;
    }
    if (b.estado !== undefined) {
      if (!ESTADOS_DOC.includes(b.estado)) return res.status(400).json({ error: `estado debe ser: ${ESTADOS_DOC.join(', ')}` });
      $set.estado = b.estado;
    }
    if (b.fecha_emision !== undefined) {
      if (b.fecha_emision && !isValidDate(b.fecha_emision)) return res.status(400).json({ error: 'fecha_emision invalida (YYYY-MM-DD)' });
      $set.fecha_emision = b.fecha_emision || null;
    }
    if (b.fecha_caducidad !== undefined) {
      if (b.fecha_caducidad && !isValidDate(b.fecha_caducidad)) return res.status(400).json({ error: 'fecha_caducidad invalida (YYYY-MM-DD)' });
      $set.fecha_caducidad = b.fecha_caducidad || null;
      // Fecha nueva: se reabre la ventana de aviso.
      $set.ultima_alerta_fecha = null;
      $set.ultima_alerta_tipo = null;
    }
    if (b.dias_alerta !== undefined) {
      const v = Number(b.dias_alerta);
      if (!Number.isFinite(v) || v < 0) return res.status(400).json({ error: 'dias_alerta invalido' });
      $set.dias_alerta = v;
    }
    if (b.emisor !== undefined) $set.emisor = str(b.emisor, 200) || null;
    if (b.referencia !== undefined) $set.referencia = str(b.referencia, 200) || null;
    if (b.notas !== undefined) $set.notas = str(b.notas, 2000);
    if (b.confidencial !== undefined) $set.confidencial = b.confidencial === true;
    if (b.nda_referencia !== undefined) $set.nda_referencia = str(b.nda_referencia, 200) || null;
    if (b.nda_contraparte !== undefined) $set.nda_contraparte = str(b.nda_contraparte, 200) || null;

    await col().updateOne({ _id: prev._id }, { $set });
    await appendFlLog(mongo, {
      action: $set.estado && $set.estado !== prev.estado ? 'expediente.doc.estado_change' : 'expediente.doc.update',
      actorId: req.user,
      detail: { docId: prev._id, nombre: $set.nombre || prev.nombre, ...($set.estado ? { from: prev.estado, to: $set.estado } : {}) },
    });
    const updated = await col().findOne({ _id: prev._id });
    res.json(serializeDoc(updated));
  });

  // Soft-delete: NUNCA borra el documento ni purga su archivo de GridFS (ver
  // RETENCION). Oculta de las vistas normales; recuperable via /restore.
  router.delete('/api/fl/expediente/documentos/:id', ...guard, async (req, res) => {
    const row = await col().findOne({ _id: String(req.params.id) });
    if (!row) return res.status(404).json({ error: 'documento no encontrado' });
    if (row.deleted) return res.status(409).json({ error: 'documento ya estaba en papelera' });
    await col().updateOne({ _id: row._id }, {
      $set: { deleted: true, deletedAt: new Date().toISOString(), deletedBy: req.user },
    });
    await appendFlLog(mongo, { action: 'expediente.doc.soft_delete', actorId: req.user, detail: { docId: row._id, nombre: row.nombre, teniaArchivo: !!row.file_id } });
    res.json({ id: row._id, deleted: true });
  });

  // Restaura un documento en papelera. No requiere que el archivo siga
  // adjunto (el archivo, si lo tenia, nunca se toco al borrar).
  router.post('/api/fl/expediente/documentos/:id/restore', ...guard, async (req, res) => {
    const row = await col().findOne({ _id: String(req.params.id) });
    if (!row) return res.status(404).json({ error: 'documento no encontrado' });
    if (!row.deleted) return res.status(409).json({ error: 'documento no esta en papelera' });
    await col().updateOne({ _id: row._id }, {
      $set: { updatedAt: new Date().toISOString(), updatedBy: req.user },
      $unset: { deleted: '', deletedAt: '', deletedBy: '' },
    });
    await appendFlLog(mongo, { action: 'expediente.doc.restore', actorId: req.user, detail: { docId: row._id, nombre: row.nombre } });
    const updated = await col().findOne({ _id: row._id });
    res.json(serializeDoc(updated));
  });

  /* --------------------------------------------------------------------------
     Archivo del documento (uno por registro: subir reemplaza el anterior)
  -------------------------------------------------------------------------- */

  router.post(
    '/api/fl/expediente/documentos/:id/archivo',
    auth,
    requireMesa('fl_expediente'),
    express.raw({ type: DOCUMENT_TYPES, limit: `${MAX_UPLOAD_MB}mb` }),
    async (req, res, next) => {
      const row = await col().findOne({ _id: String(req.params.id) });
      if (!row) return res.status(404).json({ error: 'documento no encontrado' });

      const contentType = String(req.headers['content-type'] || '').split(';')[0].trim();
      if (!DOCUMENT_TYPES.includes(contentType)) {
        return res.status(415).json({ error: 'Formato no permitido. PDF, Word, hoja de calculo o imagen (JPG/PNG/WebP).' });
      }
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: 'Archivo vacio o ilegible' });
      }

      let filename = 'documento.pdf';
      try { filename = decodeURIComponent(String(req.headers['x-filename'] || 'documento.pdf')); } catch {}
      filename = filename.slice(0, 180);

      // Hash del contenido EN CLARO como prueba de integridad (mismo criterio
      // que fl_evidencias en fl.js) — se calcula antes de cifrar, para que
      // sirva de verificacion tras descifrar en la descarga.
      const sha256 = crypto.createHash('sha256').update(req.body).digest('hex');
      const originalSize = req.body.length;
      const uploadedAt = new Date().toISOString();
      const prevFileId = row.file_id;

      // Cifrado en reposo (AES-256-GCM): el contenido que llega a GridFS es
      // siempre el ciphertext, nunca el PDF en claro. Ver bloque SEGURIDAD.
      let encrypted;
      try {
        encrypted = encryptBuffer(req.body);
      } catch (err) {
        return res.status(500).json({ error: `Error al cifrar el archivo: ${err.message}` });
      }

      const upload = filesBucket(mongo).openUploadStream(filename, {
        metadata: {
          doc_id: row._id,
          bloque: row.bloque,
          content_type: contentType,
          sha256,
          original_size: originalSize,
          enc_algo: ENC_ALGO,
          uploaded_by: req.user,
          uploaded_at: uploadedAt,
        },
      });
      upload.on('error', () => {
        if (!res.headersSent) res.status(500).json({ error: 'Error al guardar el archivo' });
      });
      // Escucha de un evento: su fallo no vuelve a la ruta, se pasa a mano al manejador de errores.
      upload.on('finish', async () => {
        try {
          // Un archivo activo por documento: el anterior queda DESVINCULADO de
          // la ficha pero NUNCA se purga de GridFS (ver RETENCION) — sigue en
          // el bucket, cifrado, huerfano pero recuperable a mano si hiciera
          // falta. Antes se borraba aqui mismo; ese borrado automatico en el
          // mismo acto que una subida es justo el patron que causo la perdida.
          const $set = {
            file_id: upload.id.toString(),
            file_name: filename,
            file_size: originalSize,
            file_type: contentType,
            file_sha256: sha256,
            file_iv: encrypted.iv,
            file_auth_tag: encrypted.authTag,
            file_uploaded_at: uploadedAt,
            updatedAt: uploadedAt,
            updatedBy: req.user,
          };
          // Documento que seguia pendiente: al aportar el archivo pasa a
          // en_tramite para que deje de contar como faltante mientras el humano
          // fija las fechas.
          if (row.estado === 'pendiente') $set.estado = 'en_tramite';
          await col().updateOne({ _id: row._id }, { $set });
          await appendFlLog(mongo, {
            action: prevFileId ? 'expediente.archivo.replace' : 'expediente.archivo.upload',
            actorId: req.user,
            detail: { docId: row._id, fileId: upload.id.toString(), fileIdAnterior: prevFileId || null, filename, sha256, confidencial: row.confidencial === true },
          });
          const updated = await col().findOne({ _id: row._id });
          res.status(201).json(serializeDoc(updated));
        } catch (err) {
          next(err);
        }
      });
      upload.end(encrypted.ciphertext);
    },
  );

  // Descarga/apertura: Authorization + token CIBE (scope fl.expediente.read).
  // El bunker en modo 'auto' (por defecto) expide el token en linea sobre la
  // sesion admin ya autenticada y lo deja trazado en cibe_log; en 'strict'
  // exige cabecera X-CIBE-Token. Contenido descifrado en memoria justo antes
  // de servirlo, nunca persistido en claro. Cada descarga exitosa queda en
  // fl_log (expediente.archivo.download) — auditoria de lectura, no solo de
  // escritura.
  router.get('/api/fl/expediente/archivos/:fileId', ...guard, cibe.guard('fl.expediente.read'), async (req, res, next) => {
    let oid;
    try { oid = new ObjectId(String(req.params.fileId)); } catch { return res.status(400).json({ error: 'Id de archivo invalido' }); }
    const file = await mongo.collection('fl_expediente_files.files').findOne({ _id: oid });
    if (!file) return res.status(404).json({ error: 'Archivo no encontrado' });

    // iv/authTag NO viven en la metadata de GridFS (el upload nunca los
    // escribe ahi) — viven en la ficha del documento (file_iv/file_auth_tag),
    // que es donde el endpoint de subida los guarda. Bug real encontrado y
    // corregido 2026-09-20: la version anterior los buscaba en
    // file.metadata, siempre undefined, y sin embargo no lanzaba (Buffer.from
    // de valores vacios en base64 no tira), asi que el decifrado corria con
    // iv/authTag equivocados y devolvia bytes ilegibles en vez de error —
    // fallo silencioso, detectado con verificacion byte a byte del contenido
    // descargado contra el original, no solo por status code.
    const docId = file.metadata?.doc_id;
    const ownerDoc = docId ? await col().findOne({ _id: docId }) : null;
    const iv = ownerDoc?.file_iv;
    const authTag = ownerDoc?.file_auth_tag;
    if (!iv || !authTag) {
      // Archivo legado sin cifrar (anterior al endurecimiento 2026-09-20):
      // se sirve tal cual para no romper documentos ya subidos, pero queda
      // marcado en el log para migrarlo (re-subir) cuanto antes.
      await appendFlLog(mongo, { action: 'expediente.archivo.download_unencrypted_legacy', actorId: req.user, detail: { fileId: String(oid) } });
      res.setHeader('Content-Type', file.metadata?.content_type || 'application/octet-stream');
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
      res.setHeader('Cache-Control', 'no-store');
      const stream = filesBucket(mongo).openDownloadStream(oid);
      stream.on('error', () => res.destroy());
      return stream.pipe(res);
    }

    const chunks = [];
    const stream = filesBucket(mongo).openDownloadStream(oid);
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('error', () => { if (!res.headersSent) res.status(500).json({ error: 'Error al leer el archivo' }); });
    // Escucha de un evento: su fallo no vuelve a la ruta, se pasa a mano al manejador de errores.
    stream.on('end', async () => {
      let plain;
      try {
        plain = decryptBuffer(Buffer.concat(chunks), iv, authTag);
      } catch (err) {
        return res.status(500).json({ error: `Error al descifrar el archivo: ${err.message}` });
      }
      try {
        await appendFlLog(mongo, {
          action: 'expediente.archivo.download',
          actorId: req.user,
          detail: { docId: file.metadata?.doc_id || null, fileId: String(oid), filename: file.filename },
        });
      } catch (err) {
        return next(err);
      }
      res.setHeader('Content-Type', file.metadata?.content_type || 'application/octet-stream');
      res.setHeader('Content-Length', String(plain.length));
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
      // no-store (no private/max-age): documentacion NDA-B, no se cachea.
      res.setHeader('Cache-Control', 'no-store');
      res.end(plain);
    });
  });

  // Desvincula el archivo de la ficha SIN purgarlo de GridFS (ver RETENCION):
  // el binario cifrado queda huerfano pero recuperable a mano por admin, en
  // vez de perderse en el mismo acto que un click. file_id anterior se
  // conserva en fl_log para poder rastrearlo si hiciera falta.
  router.delete('/api/fl/expediente/documentos/:id/archivo', ...guard, async (req, res) => {
    const row = await col().findOne({ _id: String(req.params.id) });
    if (!row) return res.status(404).json({ error: 'documento no encontrado' });
    if (!row.file_id) return res.status(404).json({ error: 'el documento no tiene archivo adjunto' });
    await col().updateOne({ _id: row._id }, {
      $set: {
        file_id: null, file_name: null, file_size: null, file_type: null,
        file_sha256: null, file_uploaded_at: null,
        updatedAt: new Date().toISOString(), updatedBy: req.user,
      },
    });
    await appendFlLog(mongo, { action: 'expediente.archivo.unlink', actorId: req.user, detail: { docId: row._id, fileIdAnterior: row.file_id } });
    const updated = await col().findOne({ _id: row._id });
    res.json(serializeDoc(updated));
  });

  /* --------------------------------------------------------------------------
     Alertas y KPIs
  -------------------------------------------------------------------------- */

  async function alertasActivas() {
    const rows = await col().find({}).toArray();
    const out = [];
    for (const r of rows) {
      const a = evaluarAlerta(r);
      if (a) out.push(a);
    }
    // Criticas primero, y dentro de cada grupo lo que vence antes.
    out.sort((a, b) => {
      if (a.severity !== b.severity) return a.severity === 'error' ? -1 : 1;
      if (a.dias === null) return 1;
      if (b.dias === null) return -1;
      return a.dias - b.dias;
    });
    return out;
  }

  router.get('/api/fl/expediente/alertas', ...guard, async (req, res) => {
    const alertas = await alertasActivas();
    res.json({ alertas, total: alertas.length });
  });

  router.get('/api/fl/expediente/summary', ...guard, async (req, res) => {
    const rows = await col().find({}).toArray();
    let vigentes = 0, pendientes = 0, conArchivo = 0, caducados = 0, porCaducar = 0, faltantes = 0;
    let storageBytes = 0;
    for (const r of rows) {
      if (r.estado === 'vigente') vigentes++;
      if (r.estado === 'pendiente') pendientes++;
      if (r.file_id) { conArchivo++; storageBytes += Number(r.file_size) || 0; }
      const a = evaluarAlerta(r);
      if (a?.tipo === 'caducado') caducados++;
      if (a?.tipo === 'por_caducar') porCaducar++;
      if (a?.tipo === 'faltante') faltantes++;
    }
    const total = rows.length;
    res.json({
      totalDocumentos: total,
      vigentes,
      pendientes,
      conArchivo,
      caducados,
      porCaducar,
      faltantes,
      storageBytes,
      /* Completitud: documentos con archivo adjunto sobre el total del archivo. */
      completitudPct: total > 0 ? Math.round((conArchivo / total) * 10000) / 100 : 0,
      alertasActivas: caducados + porCaducar + faltantes,
    });
  });

  /* --------------------------------------------------------------------------
     Motor de alarmas

     Mismo patron in-process que checkAlarmas de fl.js (sin cron externo):
     corre al arrancar y cada 24h. No re-notifica lo ya avisado el mismo dia:
     guarda la marca en el propio documento (ultima_alerta_fecha + tipo) para
     que un reinicio del servidor no genere un chaparron de duplicados.
  -------------------------------------------------------------------------- */
  async function checkAlarmasExpediente() {
    try {
      const hoy = new Date().toISOString().slice(0, 10);
      const rows = await col().find({}).toArray();
      for (const row of rows) {
        const alerta = evaluarAlerta(row);
        if (!alerta) continue;

        // Solo los documentos con fecha mueven estado automaticamente; los
        // "faltante" se avisan pero no se tocan.
        if (alerta.tipo === 'caducado' && row.estado !== 'caducado') {
          await col().updateOne({ _id: row._id }, { $set: { estado: 'caducado', updatedAt: new Date().toISOString() } });
        } else if (alerta.tipo === 'por_caducar' && row.estado === 'vigente') {
          await col().updateOne({ _id: row._id }, { $set: { estado: 'por_caducar', updatedAt: new Date().toISOString() } });
        }

        // Anti-duplicado: una notificacion por documento, tipo y dia.
        if (row.ultima_alerta_fecha === hoy && row.ultima_alerta_tipo === alerta.tipo) continue;

        adminNotify?.({
          origin: 'FL',
          label: `Expediente Fiscal y Juridico — ${alerta.tipo === 'caducado' ? 'documento caducado' : alerta.tipo === 'faltante' ? 'documento pendiente' : 'documento por caducar'}`,
          detail: `Bloque ${alerta.bloque} · ${alerta.mensaje}`,
          severity: alerta.severity,
        });
        busEmit?.({
          id: crypto.randomUUID(),
          ts: new Date().toISOString(),
          origin: 'FL',
          dest: 'ADMIN',
          type: 'alert',
          state: alerta.severity === 'error' ? 'BLOCKED' : 'OPEN',
          label: `Expediente: ${alerta.tipo} · ${alerta.nombre}`,
          payload: { docId: alerta.docId, bloque: alerta.bloque, dias: alerta.dias },
        });
        await col().updateOne({ _id: row._id }, { $set: { ultima_alerta_fecha: hoy, ultima_alerta_tipo: alerta.tipo } });
        await appendFlLog(mongo, {
          action: 'expediente.alarma',
          actorId: 'system',
          detail: { docId: row._id, tipo: alerta.tipo, dias: alerta.dias },
        });
      }
    } catch (err) {
      console.error('[FL/Expediente] Error en checkAlarmasExpediente:', err.message);
    }
  }

  // Disparo manual, para forzar la revision sin esperar al ciclo diario.
  router.post('/api/fl/expediente/alertas/revisar', ...guard, async (req, res) => {
    await checkAlarmasExpediente();
    const alertas = await alertasActivas();
    res.json({ ok: true, alertas, total: alertas.length });
  });

  // Seed + cron de boot, fuera de cualquier request: corren explicitamente
  // contra el tenant por defecto (runAsTenant), nunca contra el mongo
  // tenant-aware recibido arriba, que exige un request con resolveTenant ya
  // corrido. La llamada dentro del handler POST /alertas/revisar (arriba) NO
  // se envuelve: ahi si hay un request real con tenant ya resuelto.
  const runCheckAlarmasExpediente = () => runAsTenant(DEFAULT_TENANT_ID, checkAlarmasExpediente);
  runAsTenant(DEFAULT_TENANT_ID, seedDocumentos).then(runCheckAlarmasExpediente);
  setInterval(runCheckAlarmasExpediente, 24 * 60 * 60 * 1000);
}
