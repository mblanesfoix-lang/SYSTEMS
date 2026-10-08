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
 * JWT de Rëff. Luego exigio sesion y tradujo el username via un mapa fijo en
 * codigo (ELVIRA_TO_REFF_USERNAME). Multi-tenancy Fase 1: ese mapa fijo asumia
 * usuarios fijos de la empresa, no tenants — se sustituye por el campo
 * `reffUsername` en el propio documento de `users` (poblado inicialmente con
 * los mismos 4 valores que tenia el mapa, ningun usuario pierde acceso en la
 * migracion), leido con el `mongo` tenant-aware de la sesion en curso.
 */

export function createGuestTokenHandler({ signToken, getUserByUsername, mongo }) {
  return async function guestToken(req, res) {
    try {
      const userDoc = await mongo.collection('users').findOne({ _id: req.user });
      const reffUsername = userDoc?.reffUsername;
      if (!reffUsername) return res.status(403).json({ error: 'Tu usuario de Elvi-Ra no tiene correspondencia en Rëff' });
      const userRow = await getUserByUsername(reffUsername);
      if (!userRow) return res.status(500).json({ error: 'usuario no encontrado en DB de Rëff' });
      res.json({
        token: signToken({ userId: userRow.id, username: userRow.username, tenantId: req.tenantId }),
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
export function mountReffGuestToken(app, { auth, requireMesa, signToken, getUserByUsername, mongo }) {
  const handler = createGuestTokenHandler({ signToken, getUserByUsername, mongo });
  const guard = [auth, requireMesa('reff')];
  app.get('/reff/api/guest-token', ...guard, handler);
  app.get('/api/guest-token', ...guard, handler);
}
