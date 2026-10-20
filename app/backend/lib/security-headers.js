import helmet, { strictTransportSecurity } from 'helmet';

/**
 * Cabeceras de seguridad HTTP de toda la app: paginas, estaticos, Rëff y API.
 *
 * La CSP va en modo Report-Only: el navegador no bloquea nada y envia cada
 * infraccion a CSP_REPORT_PATH (routes/csp-report.routes.js). Asi se mide que
 * romperia la politica antes de imponerla, porque las paginas aun llevan
 * scripts y manejadores en linea.
 */
export const CSP_REPORT_PATH = '/api/csp-report';

export const CSP_DIRECTIVES = Object.freeze({
  'default-src': ["'self'"],
  'base-uri': ["'self'"],
  'object-src': ["'none'"],
  'script-src': ["'self'"],
  'script-src-attr': ["'none'"],
  // Estilos en linea en todas las paginas y los que copia html2canvas al clonar el DOM.
  'style-src': ["'self'", "'unsafe-inline'"],
  'font-src': ["'self'"],
  // data: iconos SVG del CSS y html2canvas; blob: texturas que GLTFLoader extrae
  // de los .glb y vistas previas de imagenes subidas.
  'img-src': ["'self'", 'data:', 'blob:'],
  // three.js lee esas texturas con fetch() sobre la URL blob: (ImageBitmapLoader).
  'connect-src': ["'self'", 'blob:'],
  // Vistas previas de PDF (blob:) y Rëff incrustado en reff.html.
  'frame-src': ["'self'", 'blob:'],
  'frame-ancestors': ["'self'"],
  'form-action': ["'self'"],
  // upgrade-insecure-requests no se declara: el navegador lo ignora en Report-Only
  // y, al imponer la politica, solo tiene sentido bajo TLS.
  'report-uri': [CSP_REPORT_PATH],
});

export function applySecurityHeaders(app) {
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: { useDefaults: false, directives: CSP_DIRECTIVES, reportOnly: true },
    // HSTS aparte: solo tiene sentido en respuestas servidas por TLS.
    strictTransportSecurity: false,
  }));
  // Con trust proxy, req.secure tambien es cierto cuando el TLS termina en el proxy (X-Forwarded-Proto).
  const hsts = strictTransportSecurity();
  app.use((req, res, next) => (req.secure ? hsts(req, res, next) : next()));
}
