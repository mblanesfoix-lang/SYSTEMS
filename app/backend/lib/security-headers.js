import helmet, { strictTransportSecurity } from 'helmet';

/**
 * Cabeceras de seguridad HTTP de toda la app: paginas, estaticos, Rëff y API.
 *
 * La CSP se impone: ningun script en linea ni manejador on...= se ejecuta, solo
 * los archivos servidos por el propio sistema. Cada infraccion se sigue
 * enviando a CSP_REPORT_PATH (routes/csp-report.routes.js) para detectar
 * cualquier pagina que se rompa.
 */
export const CSP_REPORT_PATH = '/api/csp-report';

// Solo Rëff se incrusta (reff.html lo abre en un iframe del mismo origen):
// el resto de documentos no se deja enmarcar ni desde el propio sistema.
const FRAMEABLE_PATH = /^\/reff(\/|$)/;
const frameAncestors = (req) => (FRAMEABLE_PATH.test(req.path) ? "'self'" : "'none'");

export const CSP_DIRECTIVES = Object.freeze({
  'default-src': ["'self'"],
  'base-uri': ["'self'"],
  'object-src': ["'none'"],
  'script-src': ["'self'"],
  'script-src-attr': ["'none'"],
  // 'unsafe-inline' solo en estilos: las paginas llevan bloques <style> y cientos
  // de atributos style, y html2canvas copia estilos en linea al clonar el DOM.
  // Un estilo inyectado no ejecuta codigo; los scripts siguen cerrados.
  'style-src': ["'self'", "'unsafe-inline'"],
  'font-src': ["'self'"],
  // data: iconos SVG del CSS y html2canvas; blob: texturas que GLTFLoader extrae
  // de los .glb y vistas previas de imagenes subidas.
  'img-src': ["'self'", 'data:', 'blob:'],
  // three.js lee esas texturas con fetch() sobre la URL blob: (ImageBitmapLoader).
  'connect-src': ["'self'", 'blob:'],
  // Vistas previas de PDF (blob:) y Rëff incrustado en reff.html.
  'frame-src': ["'self'", 'blob:'],
  'frame-ancestors': [frameAncestors],
  'form-action': ["'self'"],
  // Sin upgrade-insecure-requests: todos los recursos son del mismo origen y
  // siguen el esquema de la pagina; bajo TLS ya fuerza HTTPS el HSTS.
  'report-uri': [CSP_REPORT_PATH],
});

export function applySecurityHeaders(app) {
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: { useDefaults: false, directives: CSP_DIRECTIVES },
    // HSTS aparte: solo tiene sentido en respuestas servidas por TLS.
    strictTransportSecurity: false,
  }));
  // Con trust proxy, req.secure tambien es cierto cuando el TLS termina en el proxy (X-Forwarded-Proto).
  const hsts = strictTransportSecurity();
  app.use((req, res, next) => (req.secure ? hsts(req, res, next) : next()));
}
