/**
 * Red de seguridad para los errores dentro de una petición.
 *
 * Express 4 no espera la promesa que devuelve un handler async: si la ruta lanza o una
 * promesa se rechaza, el error no llega al manejador de errores de la app y acaba en el
 * 'unhandledRejection' del proceso. `captureAsyncErrors` envuelve cada handler en el
 * momento de registrarlo (rutas y middleware de la app y de cualquier Router de esa copia
 * de Express), así que el rechazo sigue el camino normal: next(err) y manejador global.
 *
 * Express 5 lo hace de serie, pero migrar obliga a cambiar la sintaxis de rutas aquí y en
 * Rëff y a revisar sus dependencias; con Express 4 basta este envoltorio. Rëff trae su
 * propia copia de Express: hay que aplicarlo también a esa copia antes de importar sus
 * rutas, porque se registran al cargarse.
 *
 * `createErrorHandler` es ese manejador global: 500 genérico y aviso al Admin para los
 * fallos del servidor, con un aviso como mucho por ruta y ventana para que una ruta que
 * falla en bucle no entierre el resto de avisos. Los errores del cliente (JSON mal
 * formado, cuerpo demasiado grande...) conservan su 4xx y no avisan.
 */
import http from 'node:http';

const PATCHED = Symbol.for('systems.captureAsyncErrors');
const ORIGINAL = Symbol('originalHandler');

function forwardRejection(result, next) {
  if (result && typeof result.then === 'function' && typeof next === 'function') {
    result.then(undefined, (err) => next(err || new Error('Promesa rechazada sin motivo')));
  }
}

// Express distingue el middleware de errores por su número de parámetros (4), así que el
// envoltorio conserva length y name. Los Router y las apps montadas no se envuelven:
// ya pasan sus errores a next por su cuenta.
function wrapHandler(fn) {
  if (typeof fn !== 'function' || fn[ORIGINAL] || typeof fn.handle === 'function') return fn;
  function wrapped(...args) {
    const result = fn.apply(this, args);
    forwardRejection(result, args[args.length - 1]);
    return result;
  }
  Object.defineProperty(wrapped, 'length', { value: fn.length });
  Object.defineProperty(wrapped, 'name', { value: fn.name });
  wrapped[ORIGINAL] = fn;
  return wrapped;
}

const deepWrap = (arg) => (Array.isArray(arg) ? arg.map(deepWrap) : wrapHandler(arg));

/**
 * Aplica el envoltorio a una copia de Express 4 (el módulo importado, p. ej. `express`).
 * app.get/post/... y router.get/... acaban en Route.prototype[método]; app.use y
 * router.use en Router.use. Idempotente: devuelve false si esa copia ya estaba cubierta.
 */
export function captureAsyncErrors(express) {
  const Route = express?.Route;
  const Router = express?.Router;
  if (typeof Route?.prototype?.all !== 'function' || typeof Router?.use !== 'function') {
    throw new TypeError('captureAsyncErrors: se esperaba el módulo de Express 4');
  }
  if (Route.prototype[PATCHED]) return false;
  for (const method of [...http.METHODS.map((m) => m.toLowerCase()), 'all']) {
    const register = Route.prototype[method];
    if (typeof register !== 'function') continue;
    Route.prototype[method] = function (...handlers) {
      return register.apply(this, handlers.map(deepWrap));
    };
  }
  const use = Router.use;
  Router.use = function (...args) {
    return use.apply(this, args.map(deepWrap));
  };
  Object.defineProperty(Route.prototype, PATCHED, { value: true });
  return true;
}

const NOTIFY_WINDOW_MS = 10 * 60 * 1000;
const MAX_TRACKED_ROUTES = 500;

/**
 * Manejador global de errores (va el último en la app).
 * @param {object} deps
 * @param {Function} [deps.notify]   aviso al Admin ({ origin, label, detail, severity })
 * @param {object}   [deps.log]      destino de los mensajes (console por defecto)
 * @param {number}   [deps.windowMs] ventana en la que una misma ruta avisa una sola vez
 */
export function createErrorHandler({ notify, log = console, windowMs = NOTIFY_WINDOW_MS, now = Date.now } = {}) {
  // ruta -> { until, suppressed }. La clave usa el patrón de la ruta (/x/:id), no la URL,
  // para que variar el identificador no multiplique los avisos.
  const notices = new Map();

  function claimNotice(key) {
    const t = now();
    const entry = notices.get(key);
    if (entry && t < entry.until) {
      entry.suppressed += 1;
      return null;
    }
    if (notices.size >= MAX_TRACKED_ROUTES) {
      for (const [k, e] of notices) if (t >= e.until) notices.delete(k);
    }
    notices.set(key, { until: t + windowMs, suppressed: 0 });
    return { suppressed: entry?.suppressed || 0 };
  }

  return function errorHandler(err, req, res, _next) {
    const status = Number(err?.status ?? err?.statusCode);
    if (status >= 400 && status < 500) {
      if (!res.headersSent) res.status(status).json({ error: err.expose && err.message ? err.message : 'Petición no válida' });
      return;
    }

    log.error(`[error en ruta] ${req.method} ${req.path}`, err);
    const notice = claimNotice(`${req.method} ${req.route?.path ?? req.path}`);
    if (notice) {
      const repeated = notice.suppressed ? `${notice.suppressed} repeticiones más desde el aviso anterior. ` : '';
      try {
        notify?.({
          origin: 'SYSTEM',
          label: `Error no controlado · ${req.method} ${req.path}`,
          detail: repeated + (err?.stack || err?.message || String(err)),
          severity: 'error',
        });
      } catch (notifyErr) {
        log.error('[error en ruta] no se pudo avisar al Admin', notifyErr);
      }
    }

    if (res.headersSent) {
      // Respuesta a medias: se corta la conexión para que el cliente no se quede esperando.
      if (!res.writableEnded) req.socket?.destroy();
      return;
    }
    res.status(500).json({ error: 'Error interno del servidor' });
  };
}
