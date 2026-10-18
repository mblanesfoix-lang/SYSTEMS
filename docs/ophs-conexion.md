# ØPHS — Puerto pendiente de conexión

## Estado actual

Esta mesa es un **placeholder**. ØPHS aún no tiene servidor propio ni implementación.
Lo que existe hoy en el repo es solo la **reserva del puerto** dentro de Elvi-Ra:

- Tile en el Dashboard (`app/frontend/pages/dashboard.html`) marcado como "pendiente de conexión".
- Health-check card con estado `warn` (ámbar) — no intenta hacer fetch a ningún endpoint real.
- Entrada `systems.ophs` en `app/backend/data/elvira.json` (`status: "pending"`).
- Mesa registrada en `ROLE_MESAS.admin` (`app/backend/server.js`) para que el tile sea visible al Admin.
- Webhook receptor ya operativo: `POST /api/elvira/ophs/webhook` (ver más abajo).

Cuando el jefe añada la implementación real de ØPHS, el trabajo es **enchufar**, no rediseñar:
apuntar su sistema al webhook existente y rellenar `endpoint` en `systems.ophs`.

## Qué es ØPHS (recordatorio doctrinal)

ØPHS = ØPS + PAIA + Herzog + Sentinel. Es la Constitución del sistema — el marco que
gobierna qué acciones físicas puede ejecutar S-NFI Systems. En este proyecto, "ØPHS"
como mesa representa la **capa de ejecución física** que recibe decisiones ya validadas
y actúa bajo Pactvm Viridi. Ningún agente (Elvi-Ra, Rëff) ejecuta directamente — ØPHS es
el único punto que toca infraestructura real, y solo bajo autorización Admin.

## Flujo de comunicación Elvi-Ra ↔ Rëff ↔ ØPHS

```
Rëff (analiza/audita)  →  Elvi-Ra (orquesta + bus de eventos)  →  OPHS (ejecuta)
                                      ↑
                              Admin autoriza
```

1. **Rëff produce el dato validado.** Hoy esto ya ocurre en `POST /api/elvira/cnmc/audit/:companyId`
   (server.js ~L1435): Rëff cruza datos CRM vs. documento CNMC ingestado, detecta asimetrías,
   y si encuentra infracción marca `opsBlocked: true` en la empresa.

2. **Elvi-Ra emite el evento al bus** (`busEmit`) con `origin: 'REFF', dest: 'OPHS'`.
   Esto ya está implementado — el panel Elvi-Ra ya muestra estos eventos REFF→ØPHS
   en tiempo real. Es el canal de comunicación que pide el jefe; solo falta que algo
   escuche del lado ØPHS.

3. **ØPHS consume.** Dos vías ya preparadas, a elegir cuando se implemente el sistema real:
   - **Pull**: ØPHS hace polling a `GET /api/bus/events` (filtrando `dest === 'OPHS'`) o a
     `GET /api/elvira/ophs/webhook` (devuelve `webhookEvents` — historial de scores/eventos).
   - **Push**: Elvi-Ra llama al endpoint que exponga ØPHS cuando se conozca su `endpoint`
     (campo ya reservado en `systems.ophs.endpoint`), vía `PUT /api/elvira/systems/ophs`.

4. **ØPHS responde / actúa** solo si el Dictamen de Soberanía es ESTRATÉGICO/OPERATIVO y
   no hay bloqueo Herzog/CNMC. La autorización final sigue siendo del Admin humano — ØPHS
   no autoactúa, solo ejecuta lo ya aprobado.

## Webhook ya disponible (`/api/elvira/ophs/webhook`)

```
GET  /api/elvira/ophs/webhook   → lista los últimos 50 eventos recibidos
POST /api/elvira/ophs/webhook   → recibe eventos o scores desde sistema externo
```

Body esperado en POST:
```json
{
  "type": "event" | "score",
  "source": "string (nombre del sistema que envía)",
  "payload": { "...": "..." }
}
```

Si `type` es `"score"` y `payload.vars` existe (`{W,I,S,M,E,R,B,G,U2}`), el webhook ejecuta
el mismo pipeline de scoring que `/api/elvira/ophs/score` y genera un Dictamen de Soberanía
automáticamente, dejándolo en `state.ophs.dictamenes`.

## Qué falta para la conexión real

- [ ] Definir `endpoint` real de ØPHS (URL o puerto cerrado, según doctrina de soberanía).
- [ ] Decidir pull vs push (recomendado: push desde Elvi-Ra al confirmarse Dictamen ESTRATÉGICO,
      con pull de respaldo vía `/api/elvira/ophs/webhook` para auditoría).
- [ ] Autenticación entre Elvi-Ra y ØPHS — hoy todo pasa por el mismo Bearer token de sesión;
      para un sistema externo real conviene un secreto/cliente dedicado, no token de usuario.
- [ ] Cambiar `systems.ophs.status` de `"pending"` a `"connected"` (vía `PUT /api/elvira/systems/ophs`)
      una vez exista handshake real — el dashboard ya lee ese campo si se reutiliza el patrón
      de Sentinel/Herzog en `elvi-ra.html`.
- [ ] (Opcional, fuera de alcance de esta entrega) Replicar en `elvi-ra.html` el panel de
      Sentinel/Herzog para ØPHS, con botón de ping y estado de conexión visual. Hoy esa página
      solo tiene paneles para Sentinel y Herzog.
