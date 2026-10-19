# Rëff

Mesa comercial de **S-NFI Corp.**: CRM (hojas, empresas, tareas, reuniones y comunicaciones), Herzog, Vigilancia, Consola Maestra de tráfico y Calendario. Rëff analiza y propone; las acciones las autoriza una persona. Doctrina y ficha de la mesa: [docs/REFERENCIA.md](../../../docs/REFERENCIA.md).

## Stack

- **Frontend:** React + Vite + TypeScript + Tailwind CSS 4 (plugin de Vite; el tema se declara en `client/src/index.css`). Navegadores mínimos por Tailwind 4: Chrome 111, Safari 16.4 y Firefox 128
- **Backend:** Node.js + Express + TypeScript
- **Auth:** JWT + bcrypt (8 h de expiración)
- **Almacenamiento:** MongoDB (driver oficial `mongodb`, db `reff`; en modo integrado comparte el pool con SYSTEMS)
- **IA:** proveedor configurable (el módulo `server/llm.ts` lee el proveedor y el modelo de las variables de entorno)

## Modo integrado (el habitual)

Rëff no se despliega por separado: `app/backend/server.js` monta el build de `dist/` bajo `/reff` y lo compila `app/Dockerfile`. Tras cambiar código de Rëff:

```bash
cd "Elvi-Ra/Mesas/Rëff"
npm install
npm run build
```

y reiniciar el backend de SYSTEMS (`app/backend`) para que cargue el nuevo `dist/`. El servidor integrado escucha en el puerto 5173.

## Modo independiente (solo desarrollo de Rëff)

```bash
npm run dev
```

Arranca el servidor (`http://localhost:3001`) y el cliente de Vite (`http://localhost:5173`). El cliente usa el puerto 5173, el mismo que el backend integrado: no lanzarlo con ese backend en marcha. Hace falta `MONGO_URI`.

Copia `.env.example` a `.env`; el archivo explica cada variable. En producción todo llega por variables de entorno (lista completa en `app/backend/.env.example`). La primera vez que arranca con la base vacía crea los usuarios iniciales definidos en `REFF_SEED_*_PASSWORD`; sin la variable, no se crea ese usuario.

No guardes claves reales en el repositorio. Si una clave se ha compartido o copiado por error, rótala en el servicio que la emitió.

## Producción

```bash
npm run build
npm start
```

Con `NODE_ENV=production`, el servidor sirve el build del cliente desde `dist/client`.

## API

Prefijos montados en `server/index.ts` (en modo integrado cuelgan de `/reff`):

```text
GET  /api/health
     /api/auth          perfil y cambio de contraseña
     /api/crm           hojas, empresas, reuniones y comunicaciones
     /api/geo
     /api/herzog
     /api/watch         vigilancia
     /api/traffic       Consola Maestra de tráfico
```

Todas las rutas excepto `health` requieren `Authorization: Bearer <token>`.

## Seguridad

- Contraseñas con hash bcrypt.
- La clave del proveedor de IA solo se usa en el servidor.
- `JWT_SECRET` es obligatorio en producción.
- Límite de 60 peticiones por minuto y por IP en `/api`.
- JWT con expiración de 8 h. Sin sesión o con la sesión caducada, el cliente vuelve al login de SYSTEMS.

## Estructura

```text
server/
  index.ts  auth.ts  db.ts  mongo.ts  llm.ts  watch.ts
  meeting-mailer.ts  meeting-reminders.ts
  routes/   auth, sheets, companies, meetings, communications,
            geo, herzog, watch y traffic (*.routes.ts)
client/
  index.html
  src/      main.tsx  App.tsx  index.css  pages/  components/  hooks/  lib/
scripts/    copy-server-data.mjs
```

**Doctrina S-NFI**
