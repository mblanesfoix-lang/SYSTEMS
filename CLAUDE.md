# SYSTEMS (S-NFI Corp.) · Instrucciones del proyecto

Monorepo del programa SYSTEMS. Es lo único que se carga siempre: solo lo vigente y corto (objetivo < 15 KB). Detalle bajo demanda con Grep, sin leer entero: [docs/REFERENCIA.md](docs/REFERENCIA.md) (doctrina completa y ficha de cada mesa) y [docs/ESTADO-HISTORICO.md](docs/ESTADO-HISTORICO.md) (bitácora fechada; las entradas nuevas van allí, no aquí).

## Doctrina (inmutable, no negociable)

> El ser humano autoriza. El ser humano supervisa. El sistema ejecuta.

- Toda directriz crítica requiere autorización de Dirección (Admin). Logs absolutos e inmutables: todo acceso queda registrado para siempre (hash chain).
- **Systems** = programa madre y fuente de verdad de S-NFI; ejecuta solo bajo validación del Admin. **Rëff** = cerebro de datos: analiza, audita y valida, nunca actúa de forma autónoma (autoridad de ejecución NINGUNA); único dueño del scoring ØPHS y del Dictamen de Soberanía. **Elvi-Ra** = solo la IA de acción (mesa Central): propone, el humano autoriza o rechaza, nunca ejecuta acciones físicas sin confirmación. Son independientes e intercambian información.
- ØPS y PAIA nunca ejecutan sobre hardware: PAIA solo propone y la intervención real pasa por Central con confirmación humana. El Cockpit ØPHS es solo lectura agregada. Un fallo en la capa de recopilación no puede tumbar a Rëff ni a Sentinel.
- **Pactvm Viridi** filtra toda actividad de Elvi-Ra, Rëff y terceros (cumplimiento EU, EEUU y UK por diseño). En un Dictamen, ante duda razonable: NO estratégico.
- **Core IP (Kernel Madre, propiedad de Nour)**: ningún desarrollo periférico lo modifica ni accede sin firmas criptográficas de nivel Presidencia. Antes de tocar el Kernel o su API, verificar autorización; no asumir acceso.
- Soberanía: núcleo lógico en servidores propios (Debian/Kubernetes), sin nubes públicas; Systems solo por endpoints privados en puertos cerrados. Hetzner es un tercero aceptado solo para el deploy transitorio. Prioridad: infraestructura antes que interfaz (1. enlace seguro Elvi-Ra <-> Systems; 2. pipeline del Dictamen: dato externo -> Pactvm -> Rëff -> dashboard -> autorización Admin).

## S-NFI en una línea

S-NFI Corp. (South-Navarre Fresh Innovations, S.L.): OEM deep-tech de infraestructura industrial modular. BioHybrid (BioGrinder + BioDeshidratador: residuo orgánico húmedo a biopellet 7-8 %) y Physical AI propietaria (no SCADA); cuatro vectores: energía, residuo, dato, control. NO es startup verde, revendedor, gestor de residuos clásico, productor de biogás ni servicios digitales puros: tono institucional, nunca de startup. Verdad corporativa: `Elvi-Ra/Elvi-Ra Zone/BackEnd/SNFI Base Conocimiento.txt`.

## Mapa del repo

- `app/backend/`: Node >= 20, Express ESM, un solo proceso en el puerto 5173 para todas las mesas. `server.js` es el bootstrap (env, Mongo, middleware, mount) y `path-normalize.js` su primer middleware (decodifica UTF-8 percent-encoded para las rutas con o). Cada mesa es un `mountX(app, {...})` en su archivo; `routes/` agrupa rutas extraídas; `test/` (node:test); `scripts/` (env-vault, migraciones, purga). Datos en MongoDB (db `elvira` + db `reff`); JSON ligero solo en `data/elvira.json`, notificaciones y caches.
- `app/frontend/`: HTML/CSS/JS vanilla, ~30 páginas en `pages/`; `js/` (`api.js` con los bindings, `theme.js`, visor 3D y HUD, globos), `css/theme.css` (tokens y componentes compartidos), `vendor/` local (three, topojson, jsPDF, html2canvas, modelos .glb). Cero CDN de scripts; las fuentes salen de Google Fonts en runtime.
- `Elvi-Ra/Mesas/Rëff/`: app Vite/React + TS (client y server) que `server.js` monta bajo `/reff` desde su `dist/`. `Elvi-Ra/Elvi-Ra Zone/`: base de conocimiento y estética (`FrontEnd Instructions.txt`: minimalismo Apple + animaciones Palantir/Anduril).
- Resto: `app/assets-src/` (fuentes de assets y `npm run optimize` de los .glb; no se despliega), `app/Dockerfile` (usuario no-root), `k8s/`, `scripts/` (Debian), `docker-compose.yml`, `docs/`.

## Mesas (una línea cada una; ficha completa en docs/REFERENCIA.md)

Permisos por rol en `ROLE_MESAS` y `MESA_ROUTES` de `server.js` (admin = todo). Las mesas CRUD (Finance, M&A, F&L, Pactvm, Resilience, Herzog Central, S-EAGLE, Puerto Maestro) llevan log inmutable con hash chain.

| Mesa | Dominio | Qué es |
|------|---------|--------|
| Rëff | Rëff | CRM comercial (hojas, empresas, tareas, imágenes y PDF en GridFS), Herzog, Vigilancia, Consola Maestra de tráfico, Calendario y Comunicaciones. App React aparte |
| S-NFI U2 | Rëff | Energía desperdiciada del sistema eléctrico ES (REE/ESIOS en vivo) |
| S-NFI Finance | Rëff | Tesorería, caja, contabilidad analítica, activos (`finance.js`, céntimos) y CRM documental de empresas (`finance-companies.js`) |
| S-NFI M&A | Rëff | Valoración y pipeline de deals (`mna.js`) |
| S-NFI F&L | Rëff | Hub fiscal y legal (`fl-hub.js`: modelos, notificaciones AA.PP., gobierno corporativo, CLM; BOE/BORME reales en `fl-boletines.js`) y Expediente Fiscal y Jurídico (`fl-expediente.js`, scope `fl_expediente`) |
| S-NFI Resilience | Rëff | Detecta fallos de red y eventos sistémicos; solo señala a Elvi-Ra (`resilience.js`) |
| S-EAGLE | Rëff | Revisa lo que retiene Herzog Central (`seagle.js`) |
| S-NFI Factory | Rëff | Vaciada a petición (2026-09-08): placeholder, guard `factory` reservado |
| Pactvm Viridi | Pactvm | Cumplimiento: CIBE, nodos por país, entrada, carbono, planetario y VDR (`pactum-viridi.js`, `cibe-bunker.js`) |
| Elvi-Ra | Elvi-Ra | Central: chat y acciones con autorización humana |
| Sentinel | Elvi-Ra | Seguridad: forense IP, rate limit, cola de revisión y Rack State |
| ØPHS | ØPHS | Cockpit (ØPS, PAIA, Herzog, Sentinel), visor 3D con HUD simulado y Grid Interlink |
| Puerto Maestro | Transversal | Control de tráfico entre puertos; aprueba solo Admin (`master-gateway.js`) |
| Herzog Central | Transversal | Búnker receptor de toda la información de SYSTEMS (`herzog.js`), distinto del Herzog interno de ØPHS |
| Centro de Notificaciones | Transversal | Vista admin de alertas y solicitudes de tráfico (`notification-center.js`) |
| Lab | (Elvi-Ra) | RETIRADO del código; solo queda su doctrina como diseño de referencia |

## Auth y rutas públicas

Bearer en `localStorage`; cada página llama `requireAuth()` y `/api/me/permissions`. Usuarios y sesiones en Mongo (`routes/auth.routes.js`). `server.js` aplica `auth` + `requireMesa(...)` por prefijo con `app.use` antes de montar cada mesa: una ruta pública debe registrarse FUERA del prefijo protegido. Públicas hoy: sondas (`/api/health`, `/api/livez`, `/api/readyz`), CIBE (`/api/cibe/public-key`, `/api/cibe/token`), verificación de certificados de carbono (`/api/pactvm-verify/*`) y enlaces de invitado VDR (`/api/vdr-share/*`); sus desbloqueos con código limitan los intentos fallidos (10 cada 15 min por IP y objetivo, 30 por hora por objetivo) y guardan los códigos hasheados. `/reff/api/guest-token` (y el alias `/api/guest-token`) NO es pública: exige sesión de Elvi-Ra con acceso a la mesa reff y deduce el usuario de Rëff de la sesión (`routes/reff-guest.routes.js`).

## Comandos, pruebas y despliegue

- Servidor: `cd app/backend && npm run dev` (`node --env-file=.env --watch server.js`) o `npm start`, puerto 5173. Si corre sin `--watch`, reiniciarlo para que los cambios de backend surtan efecto. Rëff: nunca `npm run dev` suelto (pisa el 5173); `npm run build` en su carpeta y reiniciar el backend integrado.
- Tests: `npm test` en `app/backend` (node:test; precarga `db/mongo.js` por su workaround DNS de `mongodb+srv`, sin el cual los tests con Mongo fallan con `querySrv ECONNREFUSED` en este equipo; usan la db `elvira_test` o una propia y se saltan sin `MONGO_URI`). Patrón de test de mesas: `mountX()` sobre un Express propio con `auth` y `requireMesa` como stubs. Por HTTP contra el servidor real, Sentinel puede bloquear la IP local (`ip_review_queue`): no tocarlo para saltarlo.
- Antes de dar algo por hecho: `node --check` del archivo tocado, `npm test`, typecheck de Rëff (`tsc --noEmit`) o arranque, según toque.
- LLM: `llm.js` (`LLM_PROVIDER=anthropic|ollama`), con timeouts y limitador por usuario en las rutas que lo usan.
- Secretos: `.env` ignorado; `.env.vault` (AES-256-GCM) SÍ se commitea y su clave de descifrado va en el gestor de la plataforma, nunca en el repo (`node scripts/env-vault.js encrypt|decrypt [dir]`; recifrar genera una clave nueva). Contraseñas dev en `.env` local (`SEED_*_PASSWORD`).
- Despliegue: docker-compose sobre Coolify en Hetzner (transitorio; el repo solo tiene la rama `master`, confirmar cuál vigila Coolify); k8s local en `k8s/README.md` (sondas `/api/livez`, `/api/readyz` y `/api/ophs/readyz`; apagado ordenado por `SIGTERM` con tope duro interno `SHUTDOWN_HARD_MS`); Debian con `scripts/provision-debian.sh`. Persistencia en Mongo (volúmenes `mongo-data` y `elvira-data`), imagen pineada a `mongo:7.0.43` (no `7.0` flotante). Node base de `app/Dockerfile`: `22-slim` (20 es EOL desde 2026-04-30).

## Convenciones

- Leer antes de escribir; no releer salvo cambio. Sin emojis ni em-dashes en respuestas (salvo decoración ya existente en la UI). Sin aperturas ni cierres de relleno. No inventar APIs, versiones, flags ni paquetes: verificar. Saltar archivos > 100 KB salvo necesidad. Respuestas concisas, técnicas y directas. UI y docs en español; código en inglés.
- **Identificadores técnicos en ASCII** (regla del usuario, 2026-10-01): rutas de Express, colecciones y campos de Mongo, scopes CIBE y claves JSON no llevan `ø`/`Ø` (`ops`, `ophs`). Motivo: Express 4 respondía 404 a las rutas con `ø` literal y renombrar colecciones o campos deja huérfanos los datos guardados. La `Ø` va en texto visible y en nombres de archivos estáticos (`ophs.html` se sirve bien con o sin ella en el nombre). Revertido en el árbol 2026-10-02; `path-normalize.js` (que mitigaba el 404 decodificando el path) se retiró por innecesario.
- **Commit al cerrar la tarea** (regla del usuario, 2026-10-01): cada vez que una tarea queda completa y probada con éxito, commit en ese momento, atómico y solo con los archivos de esa tarea: `git add <rutas>` y `git commit -- <rutas>`. Nunca `git add -A`, `git stash`, `git checkout .` ni `git clean`: varias sesiones de Claude editan el mismo árbol a la vez y se pisarían el trabajo. Lo que está a medias o sin probar no entra en `master` (respaldo: rama local aparte). Mensaje en español con prefijo convencional (`feat:`, `fix:`, `docs:`, `chore:`). Push solo a petición expresa. Remotos: `private` es el respaldo vigente; `origin` (github.com/mblanesfoix-lang/SYSTEMS) es PÚBLICO (verificado 2026-10-01 vía API de GitHub sin credenciales) y no se le empuja nada hasta que sea privado.

## Documentación y memoria

1. Este archivo guarda solo lo vigente y debe seguir corto. Al cambiar una mesa, la arquitectura o la doctrina, actualizar su línea aquí y su ficha en `docs/REFERENCIA.md`. Borrar en el momento lo falso o lo que cite ficheros eliminados; antes de citar una ruta, un archivo o un endpoint, comprobar que existe.
2. Bitácora: la entrada fechada (qué, por qué, verificación, pendiente) va al principio de `docs/ESTADO-HISTORICO.md`, nunca aquí.
3. Memoria persistente: `C:\Users\Blanes\.claude\projects\c--Users-Blanes-Desktop-SYSTEMS\memory\` (índice `MEMORY.md` y un fichero por hecho). Solo lo que no se deduce del código: preferencias, decisiones con su motivo, nombres obsoletos y hallazgos abiertos (los de seguridad solo allí, porque `origin` es público). Va asociada a la ruta de la carpeta: si se renombra o mueve el proyecto queda huérfana (pasó con ELVI-RA a SYSTEMS en 2026-09) y hay que migrarla. El `MEMORY.md` de la raíz del repo es solo un puntero local.
4. Trabajo grande: dividir en tareas de una sesión y dejar el plan en un archivo versionado de `docs/` para sobrevivir a la compactación.

## Pendientes vigentes

- Reiniciar el servidor (el dev server aún no tiene guest-token con sesión, desbloqueos limitados ni `path-normalize.js`), reconstruyendo antes el cliente de Rëff (`npm run build` en `Elvi-Ra/Mesas/Rëff`): el SPA antiguo no manda el Bearer y recibiría 401. Los códigos de verificación de carbono emitidos antes del cambio ya no sirven.
- Verificar en navegador real con login real (Sentinel bloquea la IP local por HTTP): Pactvm (Carbono, Planetario, VDR e invitados), Consola Maestra y Comunicaciones de Rëff, Finance Empresas, F&L, Resilience, S-EAGLE, Herzog Central, Centro de Notificaciones y el visor 3D de PAIA con HUD.
- Datos reales: todo es PLACEHOLDER hasta que el jefe confirme (Pactvm planetario, nodos por país y ratio de carbono; Resilience; F&L: datos DEMO del Hub y caducidades del Expediente; países de `VDR_COUNTRY_COORDS`).
- ØPS/PAIA: el código lee `ops_nodes`, `ops_readings` y `ops_log` (2026-10-02), que es donde están los datos (3 y 246 docs; `ops_log` vacía); no hay migración. Rutas, clave de mesa y scopes CIBE en ASCII (`ops`/`ophs`), coherente con la convención; `path-normalize.js` retirado por innecesario (dev server necesita reinicio para dejar de buscarlo).
- HUD de PAIA: telemetría SIMULADA (`createTelemetryFeed()` es el punto de sustitución por la fuente real). Dos incoherencias de la spec por decidir con el jefe: composición del piloto (2 BioGrinders + 1 BioDeshidratador en la base de conocimiento frente a los totales por nodo) y 80 % de extracción secundaria frente al 7 % de humedad estándar.
- ØPHS real del jefe: puerto `SYSTEMS_URL`; el manifest de ØPHS en `k8s/` está listo con `replicas: 0`. ØPS y Herzog (tiles) siguen "próximamente".
- Volumen 3: cluster multi-rack (`RACK_PEERS`, `RACK_SHARED_KEY`), URLs live de TSO (`GRID_<CC>_URL`), claves CIBE a vault, `CIBE_MODE=strict` con racks reales. Rëff Meetings: SMTP real (`SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` en `app/backend/.env`; reiniciar tras configurar).
- Factory: redefinir alcance. S-EAGLE: métricas propias. Herzog Central: ampliar `pollBaseMetrics` si el jefe lo pide.
- Tests por añadir: Expediente F&L, M&A, Finance Empresas, S-EAGLE, Centro de Notificaciones, Rack, Grid y las rutas públicas de verificación y VDR.
- Otros: confirmar el dominio de `aporquet@snficorp.com` (único distinto en `SEED_USERS`); LinkedIn API; logo de la Abogacía (descarga manual a `app/frontend/assets/`); `kubectl apply --dry-run=client -f k8s/` nunca ejecutado contra un API server real (sí validado con `kubeconform -strict` en 1.34/1.37, ver `k8s/README.md`).
- Git: hay mucho trabajo sin commitear de varias sesiones; mirar `git status` antes de asumir qué está en `master`.
