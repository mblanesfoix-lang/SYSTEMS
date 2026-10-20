/**
 * Arranque aislado de las mesas.
 *
 * Todas las mesas comparten proceso. Una que falla al montarse no puede tumbar a las
 * demás: queda degradada, sus rutas responden 503 con un mensaje claro y se avisa al
 * Admin. Las piezas críticas (auth, Sentinel, bus y avisos al Admin) siguen deteniendo
 * el arranque, porque sin ellas no hay control de acceso ni registro.
 *
 * Una mesa degradada nunca se sirve a medias: el filtro (`gate`) se registra delante de
 * las mesas, así que también corta las rutas que llegara a registrar antes de fallar.
 * Cada ruta pertenece a la unidad con el prefijo más largo que la contiene, de modo que
 * `/api/fl/expediente` es del Expediente aunque `/api/fl` sea del Hub.
 */

const matchesPrefix = (path, prefix) => path === prefix || path.startsWith(`${prefix}/`);

/**
 * @param {object} deps
 * @param {Function} deps.auth         middleware de sesión (el mismo que protege las mesas)
 * @param {Function} deps.requireMesa  fábrica del guard de permisos por mesa
 * @param {Function} [deps.notify]     aviso al Admin, recibe la unidad degradada
 * @param {object}   [deps.log]        destino de los mensajes (console por defecto)
 */
export function createMountGuard({ auth, requireMesa, notify, log = console }) {
  const units = new Map();
  const owners = [];

  function register(name, { label = name, mesa = null, critical = false, prefixes = [], publicPrefixes = [] }) {
    if (units.has(name)) throw new Error(`Unidad de arranque duplicada: ${name}`);
    const unit = { name, label, mesa, critical, state: 'pending', reason: null, since: null };
    units.set(name, unit);
    // Express enruta sin distinguir mayúsculas: el filtro tampoco, o /API/... se lo saltaría.
    for (const prefix of prefixes) owners.push({ prefix: prefix.toLowerCase(), unit, isPublic: false });
    for (const prefix of publicPrefixes) owners.push({ prefix: prefix.toLowerCase(), unit, isPublic: true });
    return unit;
  }

  function degrade(unit, reason) {
    unit.state = 'degraded';
    unit.reason = reason;
    unit.since = new Date().toISOString();
    log.error(`[mesas] ${unit.label} degradada: ${reason}. Sus rutas responden 503; el resto sigue en servicio.`);
    try {
      notify?.({ ...unit });
    } catch (err) {
      log.error(`[mesas] no se pudo avisar al Admin de ${unit.label}: ${err?.message || err}`);
    }
  }

  /**
   * Monta una unidad. Si falla y no es crítica, queda degradada y devuelve undefined;
   * si es crítica, el error sigue su curso y detiene el arranque. `dependsOn` nombra
   * unidades ya montadas sin las que esta no puede funcionar: si alguna no está bien,
   * esta ni se intenta montar.
   */
  async function safeMount(name, fn, { dependsOn = [], ...options } = {}) {
    const unit = register(name, options);
    const missing = dependsOn.filter((dep) => units.get(dep)?.state !== 'ok');
    if (missing.length) {
      const reason = `depende de ${missing.map((dep) => units.get(dep)?.label || dep).join(', ')}, que no está disponible`;
      if (unit.critical) throw new Error(`${unit.label}: ${reason}`);
      degrade(unit, reason);
      return undefined;
    }
    try {
      const result = await fn();
      unit.state = 'ok';
      return result;
    } catch (err) {
      const reason = err?.message || String(err);
      if (unit.critical) {
        log.error(`[mesas] ${unit.label} es crítica y no ha podido arrancar: ${reason}. El servidor se detiene.`);
        throw err;
      }
      degrade(unit, reason);
      return undefined;
    }
  }

  function ownerOf(path) {
    const lower = path.toLowerCase();
    let best = null;
    for (const owner of owners) {
      if (matchesPrefix(lower, owner.prefix) && (!best || owner.prefix.length > best.prefix.length)) best = owner;
    }
    return best;
  }

  /* Middleware: corta con 503 las rutas de una unidad degradada. Las rutas privadas
     pasan antes por el mismo control que la mesa (sin sesión 401, sin permiso 403),
     para no contar a quien no tiene acceso qué está caído. */
  function gate(req, res, next) {
    const owner = ownerOf(req.path);
    if (!owner || owner.unit.state !== 'degraded') return next();
    const { label, mesa } = owner.unit;
    const reply = () => res.status(503).json({
      error: `${label} no está disponible: no ha podido arrancar y el Admin ya está avisado.`,
      degraded: true,
      mesa,
    });
    if (owner.isPublic) return reply();
    const checkMesa = () => (mesa ? requireMesa(mesa)(req, res, reply) : reply());
    if (req.user) return checkMesa();
    return Promise.resolve(auth(req, res, checkMesa)).catch(next);
  }

  const list = () => [...units.values()].map((unit) => ({ ...unit }));

  return {
    safeMount,
    gate,
    state: (name) => units.get(name)?.state ?? null,
    list,
    degraded: () => list().filter((unit) => unit.state === 'degraded'),
    summary: () => Object.fromEntries([...units.values()].map((unit) => [unit.name, unit.state])),
  };
}
