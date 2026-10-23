/**
 * Escucha continua de una coleccion con change streams de MongoDB, para difundir entre
 * replicas lo que escribe cualquiera de ellas. Requiere replica set (o mongos).
 *
 * El driver ya reanuda solo ante cortes de red; si no lo consigue, cierra el stream con
 * 'error'. Aqui se reabre con espera creciente desde el ultimo resume token. Si tampoco
 * se puede (token caducado en el oplog o caida larga), o si la coleccion se borra o se
 * renombra (evento 'invalidate', tras el que el stream termina sin error), se abre sin
 * token. Cada apertura sin token, tambien la primera, llama a `onReset` en cuanto el
 * stream responde, para que quien escucha recupere de la coleccion lo escrito mientras
 * no habia stream.
 */

const MAX_BACKOFF_MS = 30_000;

/** true si el servidor admite change streams (miembro de replica set o mongos). */
export async function supportsChangeStreams(db) {
  const hello = await db.admin().command({ hello: 1 });
  return Boolean(hello.setName) || hello.msg === 'isdbgrid';
}

/**
 * `operationTypes`: cambios que recibe `onChange` (con el documento completo).
 * `resumeAfter`: token desde el que continuar (opcional; por ejemplo, el de un feed anterior).
 */
export function createChangeFeed({
  collection, operationTypes, onChange, onReset, resumeAfter = null, label = 'change-feed', logger = console,
}) {
  const pipeline = [{ $match: { operationType: { $in: [...operationTypes, 'invalidate'] } } }];
  let stream = null;
  let token = resumeAfter;
  let failures = 0;
  let pendingReset = Boolean(onReset) && !token;
  let retryTimer = null;
  let stopped = false;

  function schedule(delay) {
    retryTimer = setTimeout(open, delay);
    retryTimer.unref?.();
  }

  function retry(err) {
    failures += 1;
    // Segundo fallo seguido con token: no sirve (fuera del oplog o invalido).
    if (failures >= 2 && token) {
      token = null;
      pendingReset = Boolean(onReset);
    }
    if (failures === 1 || failures % 20 === 0) {
      logger.warn(`[${label}] stream cerrado (${err?.codeName || err?.code || err?.message || err}); reintento ${failures}`);
    }
    schedule(Math.min(1000 * 2 ** (failures - 1), MAX_BACKOFF_MS));
  }

  function discard(current) {
    stream = null;
    current.close().catch(() => {});
  }

  function open() {
    retryTimer = null;
    if (stopped) return;
    const options = { fullDocument: 'updateLookup' };
    if (token) options.resumeAfter = token;
    let current;
    try { current = collection.watch(pipeline, options); }
    catch (err) { retry(err); return; }
    stream = current;
    // Llega con la primera respuesta del servidor: el stream esta abierto.
    current.on('resumeTokenChanged', () => {
      failures = 0;
      if (pendingReset) {
        pendingReset = false;
        Promise.resolve().then(() => onReset()).catch((err) => logger.error(`[${label}] recuperacion tras reapertura:`, err?.message || err));
      }
    });
    current.on('change', (change) => {
      if (change.operationType === 'invalidate') {
        if (current !== stream) return;
        logger.warn(`[${label}] coleccion borrada o renombrada; se vuelve a abrir el stream`);
        token = null;
        pendingReset = Boolean(onReset);
        discard(current);
        schedule(1000);
        return;
      }
      try { onChange(change); }
      catch (err) { logger.error(`[${label}] cambio no procesado:`, err?.message || err); }
    });
    current.on('error', (err) => {
      if (stopped || current !== stream) return;
      token = current.resumeToken ?? token;
      discard(current);
      retry(err);
    });
  }

  return {
    start() { if (!stream && !retryTimer && !stopped) open(); },
    async stop() {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      const current = stream;
      stream = null;
      if (current) await current.close();
    },
    get resumeToken() { return stream?.resumeToken ?? token; },
  };
}
