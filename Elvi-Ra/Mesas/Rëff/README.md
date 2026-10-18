# S-NFI Agent System

Plataforma de inteligencia agentica de **S-NFI Corp.** Cada usuario accede unicamente a los agentes que le corresponden por rol, todos operando bajo la Doctrina S-NFI.

## Stack

- **Frontend:** React + Vite + TypeScript + Tailwind CSS
- **Backend:** Node.js + Express + TypeScript
- **Auth:** JWT + bcrypt (8h de expiracion)
- **Storage:** MongoDB (driver oficial `mongodb`, db `reff`; pool compartido con Elvi-Ra en modo integrado)
- **IA:** Anthropic SDK (`@anthropic-ai/sdk`) con `ANTHROPIC_MODEL` configurable. Valor por defecto: `claude-haiku-4-5-20251001`
- **Streaming:** Server-Sent Events (SSE)

## Instalacion

```bash
cd snfi-agent-system
npm install
```

Copia `.env.example` a `.env` y rellena los valores; el archivo explica cada variable. Integrado en el backend, en producción todo llega por variables de entorno (lista completa en `app/backend/.env.example`).

Importante: no guardes claves reales en el repositorio. Si una clave se ha compartido o copiado por error, rótala en el servicio que la emitió.

## Arranque en desarrollo

```bash
npm run dev
```

- Servidor: `http://localhost:3001`
- Cliente: `http://localhost:5173`

Los datos viven en MongoDB (`MONGO_URI`). La primera vez que arranca con la base vacía crea los usuarios iniciales definidos en `REFF_SEED_*_PASSWORD`.

## Build y produccion

```bash
npm run build
npm start
```

El servidor sirve el build del cliente desde `/dist/client`.

## Usuarios y agentes

| Usuario | Contrasena inicial | Agentes accesibles |
|---------|--------------------|--------------------|
| `nour` | `snfi-admin-2026` | TODOS |
| `marc` | `snfi-admin-2026` | TODOS |
| `ray` | `snfi-u2-2026` | U-2 |
| `malva` | `snfi-iia-2026` | IIA |
| `clara` | `snfi-finance-2026` | Finance |
| `herzog` | `snfi-hz-2026` | Herzog |
| `amir` | `snfi-leads-2026` | S-NFI CRM |

Si tienes un solo agente asignado, el dashboard abre directamente su espacio de trabajo.

## Catalogo de agentes

| ID | Nombre | Categoria | Color |
|----|--------|-----------|-------|
| `orchestrator` | Orquestador Central | Sistema | `#c9a84c` |
| `ophs` | ØPHS Framework | Sistema | `#1e3a5c` |
| `u2` | S-NFI U-2 | Sistema | `#5b2d8e` |
| `resilience` | S-NFI Resilience | Operaciones | `#8b1a1a` |
| `iia` | S-NFI IIA | Operaciones | `#2d6a4f` |
| `finance` | S-NFI Finance | Finanzas | `#1a4b8c` |
| `pactum` | Pactum Viridi | Auditoria | `#52b788` |
| `herzog` | Agente de Auditorias | Auditoria | `#6b0f1a` |
| `captador` | S-NFI CRM | Comercial | `#d4a017` |

## API

```text
POST /api/auth/login                    -> { token, user }
GET  /api/auth/me                       -> { user }
POST /api/auth/update-profile           -> { user }
POST /api/auth/change-password          -> { ok }
GET  /api/auth/usage                    -> { usage }
GET  /api/chat/agents                   -> { agents }
POST /api/chat/:agentId                 -> SSE stream { event: chunk|done|error }
GET  /api/admin/users-usage             -> { users }
GET  /api/admin/agents-status           -> { agents }
POST /api/admin/agents/:agentId/toggle  -> { agentId, enabled }
GET  /api/health                        -> { status }
```

Todas las rutas excepto `login` y `health` requieren `Authorization: Bearer <token>`.

## Seguridad

- Contrasenas hasheadas con bcrypt (10 rounds).
- Verificacion de acceso por agente: si el usuario no lo tiene asignado, devuelve `403`.
- `ANTHROPIC_API_KEY` solo se usa en el servidor.
- `JWT_SECRET` es obligatorio en produccion.
- Rate limit: 30 req/min por usuario o IP.
- JWT con expiracion de 8h. Token expirado: redireccion automatica a `/login`.

## Estructura

```text
snfi-agent-system/
|-- server/
|   |-- index.ts
|   |-- auth.ts
|   |-- db.ts
|   |-- agents.ts
|   `-- routes/
|       |-- auth.routes.ts
|       |-- admin.routes.ts
|       `-- chat.routes.ts
|-- client/
|   |-- index.html
|   `-- src/
|       |-- main.tsx
|       |-- App.tsx
|       |-- pages/
|       |-- components/
|       |-- hooks/
|       `-- lib/
|-- package.json
|-- tsconfig.json
|-- tsconfig.server.json
|-- vite.config.ts
|-- tailwind.config.js
|-- postcss.config.js
`-- .env.example
```

## Despliegue

Rëff no se despliega por separado: va integrado en el servidor principal, que lo compila en `app/Dockerfile`, y el conjunto se despliega con Coolify a partir de `docker-compose.yml` (raíz del repositorio). Las variables de producción se definen en el panel de Coolify; la lista completa está en `app/backend/.env.example`.

**Doctrina S-NFI - v1.0 - 2026**
