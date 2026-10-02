/**
 * Puente de sesion Elvi-Ra -> Rëff.
 *
 * El wrapper /reff y el cliente React de Rëff piden aqui un JWT de Rëff (Rëff no
 * tiene login propio dentro de SYSTEMS). El token solo se emite con sesion valida
 * de Elvi-Ra (middleware `auth`) y acceso a la mesa 'reff'; el usuario de Rëff se
 * deduce de la SESION, nunca de lo que diga el cliente.
 *
 * Antes la ruta no exigia sesion, tomaba el usuario de la cabecera X-Elvira-User
 * y, sin correspondencia, caia en 'marc': cualquiera con acceso de red obtenia un
 * JWT de Rëff. Ahora un usuario de Elvi-Ra sin correspondencia explicita en
 * ELVIRA_TO_REFF_USERNAME no recibe token (403).
 */

export const ELVIRA_TO_REFF_USERNAME = Object.freeze({
  'mblanes@s-nficorp.com': 'marc',
  'nzaroual@s-nfi.com': 'nour',
  'ventures@s-nficorp.com': 'amir',
  'gonzalosb@s-nficorp.com': 'gonzalo',
});

export function createGuestTokenHandler({ signToken, getUserByUsername, userMap = ELVIRA_TO_REFF_USERNAME }) {
  return async function guestToken(req, res) {
    const username = userMap[String(req.user || '').trim().toLowerCase()];
    if (!username) return res.status(403).json({ error: 'Tu usuario de Elvi-Ra no tiene correspondencia en Rëff' });
    try {
      const userRow = await getUserByUsername(username);
      if (!userRow) return res.status(500).json({ error: 'usuario no encontrado en DB de Rëff' });
      res.json({
        token: signToken({ userId: userRow.id, username: userRow.username }),
        user: {
          id: userRow.id,
          username: userRow.username,
          displayName: userRow.display_name,
          avatarUrl: userRow.avatar_url ?? null,
        },
      });
    } catch (err) {
      console.error('[reff-guest] no se pudo emitir el token de Rëff', err);
      res.status(500).json({ error: 'no se pudo emitir el token de Rëff' });
    }
  };
}

/** Registra la ruta en /reff/api y en el alias /api que usa el cliente React (base "/"). */
export function mountReffGuestToken(app, { auth, requireMesa, signToken, getUserByUsername }) {
  const handler = createGuestTokenHandler({ signToken, getUserByUsername });
  const guard = [auth, requireMesa('reff')];
  app.get('/reff/api/guest-token', ...guard, handler);
  app.get('/api/guest-token', ...guard, handler);
}
