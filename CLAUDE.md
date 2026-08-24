# Elvi-Ra · Project Instructions

## Modelo Volumen 2 (vigente desde 2026-07-05)

**Systems** es el programa madre: fuente de verdad de S-NFI (info, variables, métricas). El dashboard post-login se llama SYSTEMS y tiene cuatro dominios (2026-08-24: OPHS y Pactvm Viridi pasan a tiles propios de primer nivel, antes OPHS colgaba de Elvi-Ra):

- **Dominio OPHS**: Consola Soberana propia (`ophs.html`) — Cockpit (OPS + PAIA + Herzog + Sentinel) y Grid Interlink. Ya no cuelga de Elvi-Ra.
- **Dominio Rëff (cerebro de datos)**: mesas Rëff (CRM + imágenes por empresa), S-NFI U2 y S-NFI Finance.
- **Dominio Elvi-Ra (palanca de acción)**: mesa Elvi-Ra (Central), Data Foundry (doctrina de ingesta) y Sentinel.
- **Dominio Pactvm Viridi**: guardián doctrinal/cumplimiento bio-ambiental (`pactum-viridi.html`), independiente de Elvi-Ra/Rëff/OPHS. Conectado ÚNICAMENTE a S-NFI U-2 (lectura del snapshot de optimización/pérdidas frente a demanda real, `GET /api/pactvm/u2-summary` y embebido en `GET /api/pactvm/summary`) y a Herzog en OPHS (auditorías/CIBE, ya existente). Visible para admin + roles con acceso a `snfiu2` (ray, gonzalo) vía `ROLE_MESAS`.

Los tres (Systems, Rëff, Elvi-Ra) son inteligencias independientes que intercambian información para monitorizar. Ejemplo doctrinal: Systems dice que un nodo debe quemar a 150°, Rëff reporta que Barcelona quema a 120°, Elvi-Ra notifica al humano.

- **Elvi-Ra ya NO es programa madre**: es solo la IA de acción, siempre con consentimiento humano. `elvi-ra.html` = solo Central (chat conocedor de todo el sistema: CRM, sesiones, U2, nodos) que propone acciones; el humano autoriza o rechaza; todo va a log inmutable con cadena de hashes.
- **OPHS es página propia** (`ophs.html`, mesa `ophs`, tile propio en dashboard) — NO depende del chat de Elvi-Ra. Tabs internas reales (2026-07-09): Cockpit (KPIs + OPS + PAIA, ver matriz abajo) y Grid Interlink. **El globo three.js de OPHS descrito en Volumen 2 NO existe en el código actual** (nunca llegó a commit; el único globo vivo es el del cliente React de Rëff). `elvi-ra.html` sigue soportando `?prefill=...` (precarga el chat; el humano pulsa Enviar).
- **Rëff** = cerebro de datos empresariales y del sector en tiempo real. Único dueño de OPHS/Scoring.
- **Puerto Systems real**: env `SYSTEMS_URL` (+`SYSTEMS_TOKEN`). Sin definir → mock local (colección `systems_nodes`). Contrato: `GET /api/ophs/contract`.

Plan y estado de tareas Volumen 2: `VOLUMEN-2-PLAN.md` (T1-T8 completadas 2026-07-05).

## S-NFI Core IP & Labs (Módulo Búnker, incorporación 10/10)

- **Alcance**: aislamiento y protección del Kernel Madre.
- **Función**: interfaz hermética entre código fuente del Kernel (propiedad estricta de Nour, persona física y dueño) y llamadas API autorizadas para el ecosistema global de la Holding.
- **Directiva técnica**: ningún desarrollo periférico o modular de departamentos operacionales puede modificar o acceder al Core IP sin firmas criptográficas de nivel Presidencia.
- Aplica a cualquier tarea que toque Kernel o su interfaz API: verificar autorización antes de tocar código, no asumir acceso.

## Rëff (Agente de Convergencia)

Rëff es el **agente par de Elvi-Ra**. No orquesta: analiza, audita y valida científicamente.

- **Rol**: análisis profundo, auditoría interna, validación científica de datos y candidatos.
- **Convergencia con Elvi-Ra**: Elvi-Ra acciona; Rëff somete el output al escrutinio de Pactvm Viridi antes de presentar el Dictamen de Soberanía al Admin.
- **Acceso**: lectura en tiempo real de S-NFI Factory (estado), S-NFI Resilience (BSS), S-NFI U-2 (límites químicos).
- **Autoridad de ejecución**: NINGUNA. Solo análisis y recomendación. El ser humano autoriza.

## Identidad S-NFI (resumen operativo)

- **S-NFI Corp.** (South-Navarre Fresh Innovations, S.L.) — OEM deep-tech, infraestructura industrial modular.
- **Tecnología core**: S-NFI BioHybrid™ (BioGrinder + BioDeshidratador) → residuo orgánico húmedo a biopellet 7-8%.
- **Physical AI**: no SCADA. Optimización adaptativa + gobernanza centralizada vía software propietario.
- **Modelo**: OEM. Cuatro vectores monetización: energía, residuo, dato, control.
- **Pactvm Viridi**: motor regulador que filtra toda actividad de Elvi-Ra/Rëff y terceros. Cumplimiento EU, EEUU, UK por diseño. También define el estándar de tokenización: kg biomasa = unidad digital kWh (horizonte 2030/2050).
- **NO es**: startup verde, revendedor maquinaria, gestor residuos clásico, productor biogás, servicios digitales puros.
- **Fuente verdad completa**: `Elvi-Ra/Elvi-Ra Zone/BackEnd/SNFI Base Conocimiento.txt`

## Arquitectura del sistema

```
ELVI-RA/
├── Elvi-Ra/                          ← Knowledge base + Rëff (app propia)
│   ├── Elvi-Ra Zone/
│   │   ├── BackEnd/
│   │   │   ├── Elvi-Ra Context.txt   ← Flujos de trabajo
│   │   │   └── SNFI Base Conocimiento.txt  ← Verdad corporativa
│   │   └── FrontEnd/
│   │       └── FrontEnd Instructions.txt   ← Estética Apple + Palantir/Anduril
│   └── Mesas/
│       └── Rëff/                     ← App Vite/React+TS (client/ + server/), CRM
│           └── dist/                 ← Build que server.js monta bajo /reff
├── app/                              ← Implementación principal
│   ├── backend/
│   │   ├── server.js                 ← Express único (todas las mesas, ~3900 líneas)
│   │   ├── elvira-central.js         ← Central: chat + acciones + OPHS mock/puerto
│   │   ├── llm.js                    ← Capa LLM (anthropic|ollama via env)
│   │   ├── sentinel-forensics.js     ← Hash chain + rate limit + geoip
│   │   ├── finance.js, fl.js, mna.js, pactum-viridi.js  ← Mesas Finance/F&L/M&A/Pactvm (patrón CRUD+hash chain)
│   │   ├── ops.js, paia.js, ophs-cockpit.js  ← Suite OPHS: telemetría, analítica predictiva, Cockpit
│   │   ├── foundry.js                ← Data Foundry: gateway HMAC + bus + breakers + métricas
│   │   ├── foundry-u2-worker.js      ← Sifón U-2 (worker thread, bulk insert + backpressure)
│   │   ├── cibe-bunker.js            ← Bunker Pactvm Viridi: tokens CIBE Ed25519 + Auth-Refusal (V3)
│   │   ├── rack-state.js             ← Consenso Raft entre racks: puertos + estados seguridad (V3)
│   │   ├── grid-interlink.js         ← Grid Abstraction Layer: supervisor por país (V3)
│   │   ├── grid-country-worker.js    ← Worker sandboxed (resourceLimits) por TSO/país (V3)
│   │   └── db/mongo.js               ← Conexión Mongo compartida
│   └── frontend/                     ← Vanilla HTML/CSS/JS
│       ├── pages/  (login, dashboard SYSTEMS, elvira-dashboard, elvi-ra, ophs, foundry, reff, sentinel, snfi-u2)
│       ├── js/     (api.js, notifications.js, office-bg.js)
│       └── vendor/ (three, topojson, world-atlas — assets soberanos locales)
├── scripts/                          ← Provisioning Debian + systemd + nginx
├── docker-compose.yml                ← mongo + ollama + elvira
├── Instrucciones.txt                 ← Doctrina Volumen 3 (escalabilidad fractal; el texto Foundry anterior quedó consolidado en esta CLAUDE.md)
├── VOLUMEN-2-PLAN.md                 ← Plan Volumen 2 (completado)
└── VOLUMEN-3-PLAN.md                 ← Plan Volumen 3 (T1-T3 completadas 2026-07-08)
```

## Mesas (estado real)

| Mesa | Dominio | Estado | Función |
|------|---------|--------|---------|
| Rëff | Rëff | Activa | CRM inteligencia comercial: hojas, empresas, tareas, imágenes y PDFs por empresa (GridFS, bucket `company_images`), Herzog, Vigilancia, globo |
| S-NFI U2 | Rëff | Activa | Energía desperdiciada sistema eléctrico ES (REE/ESIOS, dato vivo) |
| S-NFI Factory | Rëff | Activa | Cadena suministro industrial: assembly, logistics, inventory, maintenance |
| S-NFI Finance | Rëff | Activa | Tesorería, flujo caja proyectado, contabilidad analítica, activos reales. `finance.js`, patrón vanilla + rutas nativas |
| S-NFI F&L | Rëff | Activa | Fiscal & Legal: NDAs, contratos, licencias, expediente OEPM Modelo de Utilidad. `fl.js`, documentos GridFS |
| S-NFI M&A | Rëff | Activa | Inteligencia corporativa crecimiento fractal: valoración (múltiplos/DCF), pipeline deals, synergy payback. `mna.js` |
| Pactvm Viridi | Pactvm Viridi | Activa | Dominio propio (`pactum-viridi.html`). Guardián doctrinal/cumplimiento: CIBE, políticas medioambientales, reglas acceso, lectura Herzog + snapshot de pérdidas U-2 (`GET /api/pactvm/u2-summary`). `pactum-viridi.js` |
| Elvi-Ra | Elvi-Ra | Activa | `elvi-ra.html`: solo Central (chat + acciones autorizadas). Solo Admin |
| Sentinel | Elvi-Ra | Activa | Seguridad ciber-industrial: forense IP, hash chain, rate limit, cola revisión, integridad Debian/SSH/Git/red. Sub-interfaz del Cockpit OPHS ("Security & Fail-safes"). Solo Admin |
| OPHS | OPHS | Activa | Dominio propio (`ophs.html`, antes colgaba de Elvi-Ra): tab Cockpit (fusiona OPS+PAIA+Herzog+Sentinel, CRUD nodos OPS + lecturas) + tab Grid Interlink. Sin globo (ver nota Volumen 2). Ver [Matriz OPHS Framework](#matriz-de-interfaces-suite-ophs-framework) |
| Data Foundry | Elvi-Ra | Activa | `foundry.html` (key `foundry`, solo admin): pipeline REAL de ingesta asíncrona (`foundry.js`) + página solo con panel en vivo (gateway, 4 salas, simulador, contrato; doctrina/diagrama eliminados de la UI 2026-07-08, fuente: sección [Doctrina Data Foundry](#doctrina-data-foundry-ingesta-asincrona-2026-07-08)). Gateway HMAC embebido (`POST /api/foundry/ingress`) o puerto dedicado (`FOUNDRY_INGRESS_PORT`, dev 5175), bus no bloqueante, breakers por canal, sifón U-2 en worker thread, métricas travel-time (`/api/foundry/*`, `/api/sentinel/pipeline-metrics`). Ver [Doctrina Data Foundry](#doctrina-data-foundry-ingesta-asincrona-2026-07-08) |

## Matriz de interfaces: Suite OPHS Framework

El framework OPHS se divide en 4 micro-interfaces independientes que convergen en un único Cockpit (mesa `ophs`, guard `requireMesa('ophs')`):

| Interfaz | Acrónimo | Propósito | Módulo |
|----------|----------|-----------|--------|
| Operational Performance System | **OPS** | Telemetría hardware físico: presión, caudal, temperatura canalización Y acero inox, RPM, estado circuito cerrado | `app/backend/ops.js` (`/api/ops/*`) |
| Predictive AI Agent/Analytics | **PAIA** | Analítica proactiva: detección estadística de anomalías/tendencias sobre lecturas OPS, insight en lenguaje natural vía `llm.js` (Ollama prod = coste cero) | `app/backend/paia.js` (`/api/paia/*`) |
| Compliance & Audit | **Herzog** | Auditor algorítmico: valida cumplimiento Pactum Viridi, emite conformidad frente a CNMC | Bridge mock en `elvira-central.js` (`/api/elvira/herzog/*`) + rutas reales en Rëff (`/reff/api/herzog`, alias `/api/herzog`) |
| Security & Fail-safes | **Sentinel** | Vigilancia ciber-industrial: integridad Debian/VMware, accesos SSH, logs Git, tráfico red | `app/backend/sentinel-forensics.js` (`/api/sentinel/*`) — mismo Sentinel de siempre, alcance extendido a infraestructura del nodo, no es un segundo Sentinel |
| **OPHS Framework Cockpit** | **OPHS** | Consola Soberana: fusiona resumen de las 4 anteriores, vista C-Level para los 4.530 nodos planificados | `app/backend/ophs-cockpit.js` (`/api/ophs-cockpit/summary`) — solo lectura agregada, no ejecuta ni sustituye la autoridad de cada sub-interfaz |

Doctrina: OPS/PAIA nunca ejecutan acciones sobre hardware. PAIA solo propone (insight + recomendación); intervención real pasa siempre por Central con confirmación humana.

**Frontend**: `app/frontend/pages/ophs.html` es página independiente (tile propio en `elvira-dashboard.html`/`dashboard.html`, mesa `ophs`) — no depende ni vive dentro del chat de `elvi-ra.html`. Tabs reales: Cockpit (KPIs, lista y CRUD de nodos OPS, registro de lecturas, análisis/insight PAIA) + Grid Interlink (cards por país, chaos, alta de países). No hay tab Globo (ver nota Volumen 2). `elvi-ra.html` lee `?prefill=` y precarga el textarea del chat, pero el humano sigue pulsando Enviar — la acción real sigue pasando por confirmación explícita en Central.

**Edición directa de nodos mock (`systems_nodes`)**: `PATCH /api/ophs/nodes/:id` en `elvira-central.js` — solo admin, edita status/target_temp_c/throughput_kg_h/bss_charge_pct/pellet_stock_t directamente (sin pasar por el flujo LLM propone→confirma de Central, porque quien llama el endpoint ya es el humano autorizando). Queda igual en el log inmutable (`central_action_log`, type `node.direct_edit`, decision `DIRECT_ADMIN`). Endpoint solo backend: sin UI que lo consuma hoy.

**CRUD nodos OPS**: `app/backend/ops.js` — `POST/PATCH/DELETE /api/ops/nodes/:nodeId` (label, lat, lng opcionales; delete purga `ops_readings` y `paia_analyses` del nodo). `ops_nodes` (Cockpit, telemetría) y `systems_nodes` (mock Central) son colecciones separadas sin fusión de esquema. Alta/edición/borrado de nodos OPS se hace desde la pestaña Cockpit (`ophs.html`).

## Doctrina Data Foundry (ingesta asincrona, 2026-07-08)

Esta sección es la fuente (el texto literal original vivía en `Instrucciones.txt`, que desde 2026-07-08 contiene la doctrina Volumen 3). Filosofía de fabricación industrial aplicada al data-stream para escalar a 4.530 nodos BioHybrid. Representada en la mesa `foundry.html` (Dominio Elvi-Ra).

- **Capa ASML (litografía de datos)**: telemetría capturada en origen con timestamp a microsegundos, sin ruido, formateo matemático perfecto.
- **Capa TSMC (fundición / salas limpias)**: flujo `HARDWARE BioHybrid → Ingress Gateway OPHS → bus asíncrono → 4 canales paralelos`. El Gateway solo valida firma criptográfica del nodo + formato (puerto parametrizado en Sentinel); no procesa, no guarda, no transforma.
- **Canales**: OPS (control crítico, prioridad ultra-alta, sockets baja latencia), PAIA (IA local, buffer elástico que nunca ralentiza OPS), Herzog (solo escritura, métricas CIBE/CNMC, registros inmutables), S-NFI U-2 (sifón científico: consumidor pasivo, worker threads independientes, time-series DB, backpressure con descarte ordenado — estabilidad del hardware prima sobre recolección científica).
- **Directivas V12 Biturbo** (implementadas v1 en `app/backend/foundry.js`, 2026-07-08): 1) concurrencia no bloqueante (bus in-process async, clase `FoundryBus` = punto de sustitución por Redis Streams/MQTT en prod multi-proceso), 2) circuit breaker independiente por ramificación (threshold 5 fallos, cooldown 30s, half-open; test-trip para demo; si PAIA/Herzog caen, OPS intacto), 3) métricas "tiempo de viaje" por canal (`GET /api/foundry/metrics` y `GET /api/sentinel/pipeline-metrics`; presupuesto `FOUNDRY_LATENCY_BUDGET_MS`=250ms; excesos → bus + notificación Admin).
- **Implementación v1**: Ingress Gateway valida firma HMAC-SHA256 por nodo (`foundry_nodes`, secreto devuelto una vez en alta; fallback global `FOUNDRY_NODE_SECRET`) + formato + ventana reloj ±15min, y despacha sin procesar. Canales: OPS → `ops_readings` (+alta perezosa en `ops_nodes`, breaches con umbrales de ops.js); PAIA → ventana rolling en memoria + `paia_stream_stats` cada 25 paquetes; Herzog → `foundry_herzog_records` (hash chain, conformidad CIBE); U-2 → worker thread (`foundry-u2-worker.js`) con buffer 10k, bulk insert a `u2_timeseries`, descarte ordenado por backpressure. Simulador integrado (`POST /api/foundry/simulator/start`) para demo sin hardware. Contrato integrador: `GET /api/foundry/contract` (sin auth; también en el puerto dedicado con `/health`). Log lifecycle propio `foundry_log` (hash chain + verify). Hardware de alta frecuencia: SIEMPRE puerto dedicado (el embebido atraviesa el log forense de Sentinel).
- Arquitectura bajo secreto industrial: NDA vinculante + Modelo de Utilidad, titularidad de la Holding.

## Doctrina Volumen 3 · Escalabilidad Fractal (2026-07-08)

Fuente literal: `Instrucciones.txt` (raíz). Plan y estado: `VOLUMEN-3-PLAN.md`. Tres pilares implementados v1:

- **Rack State** (`rack-state.js`, rutas `/api/rack/*`, mesa sentinel): consenso Raft real entre racks Edge — elección de líder, replicación de log, commit por mayoría. KV replicado de puertos parametrizados (`ports.*`) y estados de seguridad (`security.*`). Sin `RACK_PEERS` → standalone (quorum 1). Exclusión mutua distribuida: rack sin quorum no comete escrituras (anti split-brain) pero sirve lecturas del último estado comprometido (Offline-First). Malla inter-rack HTTP+HMAC (`RACK_SHARED_KEY`), punto de sustitución por túneles S-NFI Teleco. Colecciones: `rack_raft`, `rack_raft_log`, `rack_state`, `rack_log` (hash chain).
- **CIBE Bunker** (`cibe-bunker.js`, mesa pactvm): módulo búnker de Pactvm Viridi. Tokens Ed25519 firmados y fechados (TTL 120s, jti/sub/scope/iat/exp) exigidos en endpoints críticos OPHS via `cibe.guard(scope)`: CRUD nodos OPS y circuit-state (`ophs.command`), `PATCH /api/ophs/nodes/:id`, breakers Foundry (`foundry.command`), propuestas rack (`rack.command`), mutaciones grid (`grid.command`). `CIBE_MODE=auto` (default): sesión admin → token auto-expedido y trazado; `strict` exige cabecera `X-CIBE-Token`. Externos: `POST /api/cibe/token` con HMAC de tokenKey, solo con certificado `pactvm_cibe` en estado `emitido` — si no, **Auth-Refusal** 403 a `cibe_log` (hash chain) + evento Sentinel. Clave pública: `GET /api/cibe/public-key`. Par de claves en Mongo `cibe_keys` (prod: `CIBE_PRIVATE_KEY_PEM` desde vault).
- **Grid Interlink** (`grid-interlink.js` + `grid-country-worker.js`, rutas `/api/grid/*`, mesa ophs): Grid Abstraction Layer transnacional. Un worker thread POR PAÍS (ES/REE, PT/REN, FR/RTE, MA/ONEE + CRUD) con `resourceLimits` = sandbox de memoria V8: el colapso del TSO de un país (DDOS/fallo masivo) mata solo su worker; supervisor con respawn backoff + detector de congelados; los demás países siguen al 100%. Payload GridSignal estandarizado (el Kernel es agnóstico del operador). Modo sim sin URL; `GRID_<CC>_URL` → live. Chaos demo: `POST /api/grid/countries/:code/chaos` {crash|stall|flood}. Reflejo PAIA: alerta crítica → solo notificación Admin (Regla de Oro intacta).

## Lógica de evaluación (Dictamen de Soberanía)

Output esperado del agente = **Dictamen de Soberanía**:

```
• NODO: [Empresa]
• SECTOR / UBICACIÓN
• PUNTUACIÓN OPHS (0-100): Ops + PAIA + Herzog + Sentinel integration ease
• CÁLCULO RESILIENCE (BSS): X MWh para 48h post-apagón
• ESTADO CNMC: riesgo regulatorio
• DICTAMEN DEPARTAMENTAL: U-2 + IIA + Factory + Finance
```

Variables clave: **W** (residuo), **I** (infraestructura), **S** (escalabilidad), **M** (compatibilidad OEM), **E** (impacto económico), **R** (estratégico), **B** (BSS resilience), **G** (gobernanza Herzog), **U-2** (reto científico).

Clasificación: ESTRATÉGICO / OPERATIVO / NO CANDIDATO. Duda razonable → no estratégico.

Penalización fuerte: biogás/anaerobia clásica, sanciones CNMC, opacidad, incompatibilidad OPHS.

## Doctrina de Ejecución (Regla de Oro)

**Inmutable. No negociable.**

> El ser humano autoriza. El ser humano supervisa. El sistema ejecuta.

- Elvi-Ra propone orquestación. Nunca ejecuta acciones físicas en infraestructura industrial sin confirmación humana.
- Rëff valida y audita. Nunca actúa de forma autónoma.
- S-NFI Systems ejecuta solo bajo validación del Admin.
- Toda directriz crítica requiere autorización de Dirección (Admin).
- Logs absolutos e inmutables. Todo acceso registrado de forma permanente.

## Stack actual

- **Backend**: Node.js >=20 + Express ESM, un solo proceso/puerto (5173) para todas las mesas. MongoDB (db `elvira` + db `reff`, pool compartido). Estado ligero en JSON solo para `data/elvira.json` (bridges/OPHS scoring/CNMC) y caches; usuarios y sesiones viven en Mongo (ver Auth abajo).
- **LLM**: `app/backend/llm.js` — `LLM_PROVIDER=anthropic|ollama` via env, lectura perezosa de `ANTHROPIC_API_KEY`. Tokens contabilizados en T'Controler.
- **Rëff**: Vite/React+TS compilado a dist/, montado en runtime por server.js bajo `/reff` (y su API en `/reff/api` + alias `/api`). El Dockerfile lo compila en stage propio.
- **S-NFI Finance**: planificada como página vanilla en `app/frontend/pages/` + rutas nativas en `app/backend/server.js`, mismo patrón que S-NFI U2/Factory (no dentro de la app React de Rëff — descartado ese diseño).
- **Frontend Elvi-Ra**: HTML/CSS/JS vanilla. Fonts: Inter + IBM Plex Mono + Syne. Vendor local (three.js, topojson, world-atlas) — cero CDN en runtime.
- **Estética**: minimalismo Apple + animaciones Palantir/Anduril (reveal, delays, mono labels, dark feel). Login: infinito neón canvas + transición descenso a oficina. Dashboard: fondo oficina animada sutil.
- **Auth**: token Bearer en `localStorage`. `requireAuth()` + guard `/api/me/permissions` (mesas por rol) en cada página. Backend: `app/backend/routes/auth.routes.js` (colecciones Mongo `users`/`sessions`, TTL index sobre `exp` — Mongo purga sesiones expiradas solo). Migración one-shot desde el store JSON previo: `scripts/migrate-auth-to-mongo.js` (idempotente, respalda los JSON originales a `*.migrated.json`).

## Infraestructura de despliegue

- **Infraestructura soberana (destino)**: servidores físicos propios, Debian/Kubernetes. Cero dependencia de nubes públicas de terceros para el núcleo lógico.
- **Fase transitoria (deploy actual)**: servidor Debian en Hetzner (Europa). Gestionado por el jefe. Hetzner = tercero aceptado solo para capa de deploy, no para núcleo lógico.
- **Coolify**: plataforma CI/CD auto-alojada (equivalente a Vercel/Netlify). Push a `main` → deploy automático.
- **GitHub**: repositorio fuente (pendiente conectar a Coolify).
- **VM Debian/VMware**: `sudo bash scripts/provision-debian.sh` (idempotente: Docker, UFW, /opt/elvi-ra, .env, systemd, healthcheck).
- **Reglas de código**:
  - Credenciales prod y JWT secret via variables de entorno (panel Coolify), nunca hardcoded.
  - Persistencia en Mongo (volúmenes `mongo-data` + `elvira-data` sobreviven redeployos).

## Credenciales (dev)

Usuarios y contraseñas dev: ver `.env` local (no trackeado, `SEED_*_PASSWORD`). No commitear credenciales en texto plano. Hashes bcrypt en la colección Mongo `users` tras el primer seed (`ensureUsersSeed`, solo si la colección está vacía).

Seed Rëff (`server/db.ts`): contraseñas via env `REFF_SEED_<USER>_PASSWORD` (movidas de texto plano a env 2026-07-09); sin variable, el usuario no se crea.

## Vault de secretos (.env cifrado)

`app/backend/scripts/env-vault.js` cifra `.env` -> `.env.vault` (AES-256-GCM, `node:crypto`, sin dependencia externa). `.env.vault` SÍ se commitea (excepción explícita en `.gitignore`: `!.env.vault`); `.env` sigue ignorado. La clave de descifrado (32 bytes hex) se imprime una única vez al cifrar y debe guardarse en el gestor de secretos de la plataforma de despliegue — nunca en el repo. Uso: `node scripts/env-vault.js encrypt [dir]` / `decrypt [dir]` (dir por defecto: `app/backend`; para el `.env` de Rëff pasar `"Elvi-Ra/Mesas/Rëff"`). Recifrar tras cualquier cambio de secretos en `.env`.

## Tests

`app/backend/test/` (`node:test` nativo, cero dependencias nuevas). `npm test` desde `app/backend/`. Cobertura actual: `auth.routes.test.js` (login/logout/sesiones/change-password contra Mongo real), `sentinel-forensics.chain.test.js` (integridad de la cadena de hashes forense: append, detección de manipulación, re-anclado), `finance.money.test.js` (aritmética en céntimos: IVA, amortización, proyección de caja). Los tests que requieren Mongo usan la db `elvira_test` (mismo `MONGO_URI` del `.env`, db separada de `elvira`) y se saltan automáticamente si no hay `MONGO_URI`. Pendiente: cobertura de mesas restantes (Factory, F&L, M&A, Foundry, Rack, Grid) — se añade según se toque ese código, no de golpe.

## Convenciones de trabajo

- **Leer antes de escribir**. No releer salvo cambio.
- **No emojis ni em-dashes** en respuestas (excepto si están en UI ya existente como decoración de mesas).
- **No sycophantic openers ni cierres** de relleno.
- **No inventar APIs, versiones, flags, paquetes**. Verificar antes.
- **Saltar archivos >100KB** salvo necesidad.
- **Tono respuestas**: conciso, técnico, directo.
- **Idioma**: ES para UI y docs internas. Código en EN.

## Estado actual (post Volumen 3 backend, 2026-07-08)

**Hecho**: backend completo (auth, CRM, U2, Sentinel forense, T'Controler, notificaciones, bus de eventos), mesas Finance/F&L/M&A/Pactvm Viridi activas (patrón CRUD+hash chain), suite OPHS completa backend+frontend (OPS telemetría + PAIA analítica predictiva + Cockpit que fusiona OPS+PAIA+Herzog+Sentinel). Frontend: `elvi-ra.html` reducida a solo Central; `ophs.html` nueva, página independiente con tile propio en dashboard (tabs Cockpit + Grid Interlink; el tab Globo documentado en Volumen 2 no existe en el código); `elvi-ra.html` soporta `?prefill=` sin acoplar OPHS al chat. Health checks de `ophs` en `dashboard.html` y `elvira-dashboard.html` actualizados a `/api/ophs-cockpit/summary` real (ya no "pendiente de conexión" fijo). Mesa **Data Foundry** (2026-07-08): pipeline real de ingesta (`foundry.js` + `foundry-u2-worker.js`, ver sección Doctrina) + `foundry.html` con panel vivo (breakers, latencias, simulador, contrato), key `foundry` en `ROLE_MESAS.admin`, tile en `elvira-dashboard.html`. Dev local: `FOUNDRY_INGRESS_PORT=5175` en `app/backend/.env`. **Volumen 3 backend** (2026-07-08): Rack State (Raft), CIBE Bunker (tokens Ed25519 + guards en endpoints críticos) y Grid Interlink (workers sandboxed por país) — ver sección [Doctrina Volumen 3](#doctrina-volumen-3--escalabilidad-fractal-2026-07-08); verificado E2E en puerto de prueba (Auth-Refusal, propose+commit standalone, chaos crash ES con aislamiento y respawn). MESA_ROUTES: `/api/rack` → sentinel, `/api/grid` → ophs. **UI Volumen 3** (2026-07-09): tab Grid Interlink en `ophs.html`, panel Racks (Raft) en `sentinel.html`, tab Búnker CIBE + botón TokenKey en `pactum-viridi.html`, helpers en `js/api.js` — detalle en `VOLUMEN-3-PLAN.md` sección UI.

**Rëff CRM adjuntos** (2026-07-09): la galería por empresa acepta ahora PDFs además de imágenes (JPG/PNG/WebP 8 MB, PDF 16 MB, mismo bucket GridFS `company_images`, límite 30 archivos). Tile PDF con badge, abre en pestaña nueva vía blob autenticado; `Content-Disposition: inline` en descarga. Cambios en `companies.routes.ts` + `CompanyImages.tsx`. Server local 5173 reiniciado con build actual (el pendiente anterior de restart por OPS/PAIA/Cockpit quedó resuelto).

**Dashboard SYSTEMS a 4 dominios + KPI pérdidas U-2 en Pactvm Viridi** (2026-08-24): `dashboard.html` pasa de 2 a 4 tiles de dominio de primer nivel (OPHS, Rëff, Elvi-Ra, Pactvm Viridi). OPHS sale del dominio Elvi-Ra (se quita su tile y health-check de `elvira-dashboard.html`; breadcrumb, brand-click, back-button y guard de permisos de `ophs.html` corregidos para depender de la mesa `ophs` y no de `elvira` — el guard antiguo comprobaba `elvira`, error preexistente). `ROLE_MESAS`: `pactvm` añadida a `ray` y `gonzalo` (antes solo admin). Pactvm Viridi gana lectura del snapshot U-2 (`exceso_gwh_hoy`, `pct_horas_desperdiciadas`) vía closure `getU2Snapshot` inyectado a `mountPactvm` (mismo patrón que `mountElviraCentral`, reutiliza `liveCache` de `server.js` sin acoplar la mesa `snfiu2`); nuevo endpoint `GET /api/pactvm/u2-summary` y campo `u2` embebido en `GET /api/pactvm/summary`. `pactum-viridi.html`: 5ª celda KPI "Pérdidas vertido renovable U-2 (hoy)", breadcrumb ya no cuelga de Rëff. Alcance de datos de Pactvm Viridi sigue siendo solo lectura (U-2 + Herzog), sin escritura fuera de sus propias colecciones `pactvm_*`.

**Auth migrado a Mongo + vault de secretos + tests (2026-08-24)**: usuarios/sesiones dejan el store JSON (`data/users.json`, `data/sessions.json`) y pasan a colecciones Mongo `users`/`sessions` (TTL index sobre `exp`, purga automática). Lógica extraída a `app/backend/routes/auth.routes.js` (`mountAuth`, `ensureUsersSeed`), `server.js` monta el módulo en vez de tener login/logout/me/change-password inline. Migración one-shot ejecutada: `scripts/migrate-auth-to-mongo.js` (5 usuarios migrados, JSON originales respaldados a `*.migrated.json`, no borrados). `elvira-central.js` y el endpoint `/api/elvira/overview` ya no dependen del `Map` `SESSIONS` en memoria — consultan Mongo directamente. Vault de secretos sin infraestructura externa: `.env` y el `.env` de Rëff cifrados a `.env.vault` (AES-256-GCM, ver sección Vault); claves de descifrado entregadas al jefe, no están en el repo ni en memoria persistente. Primeros tests automatizados del proyecto (ver sección Tests): 29 tests, cubren auth, cadena forense Sentinel y aritmética Finance — server arrancado y verificado manualmente tras la migración (`GET /api/health` 200, login rechaza credenciales inválidas).

**Pendiente (requiere accesos externos o decisión Admin)**:
- Data Foundry: conectar hardware/Systems real al Ingress Gateway (contrato en `GET /api/foundry/contract`; el jefe decide puerto definitivo y UFW). Corrección prod prevista: sustituir `FoundryBus` in-process por Redis Streams/MQTT y mover secretos de nodo de Mongo a vault/env.
- Systems/OPHS real del jefe (puerto listo: `SYSTEMS_URL`).
- Migración emails usuarios a @snficorp.com (tarea separada, ver memoria).
- LinkedIn API / datos públicos empresas / envío email real (SMTP).
- Errores TS preexistentes en cliente Rëff (Globe3D.tsx tipos, Header.tsx `import type Agent` inexistente) — no rompen build Vite; limpiar cuando se toque ese código.
- Volumen 3: cluster multi-rack real (`RACK_PEERS`+`RACK_SHARED_KEY` por rack), URLs live TSO (`GRID_<CC>_URL`, credenciales del jefe), claves CIBE a vault, `CIBE_MODE=strict` cuando conecten racks reales. Detalle en `VOLUMEN-3-PLAN.md`.

## Flujo de mantenimiento de memoria/contexto (obligatorio)

Al cerrar cada tarea o cambio estructural:

1. **VOLUMEN-2-PLAN.md** (o el plan vigente): marcar tarea, anotar decisiones.
2. **CLAUDE.md**: actualizar "Estado actual", arquitectura y stack si cambiaron. Borrar en el momento cualquier referencia a archivos/ficheros eliminados o afirmaciones ya falsas (ej. "falta server.js").
3. **Memoria persistente** (`~/.claude/.../memory/`): actualizar el archivo afectado; borrar memorias que hayan dejado de ser ciertas; nunca duplicar lo que ya cuenta el repo.
4. Trabajo grande → dividir en tareas de una sesión y dejar el plan en un archivo del repo para sobrevivir compactación.

## Context Model 1 (briefing doctrinal; el .txt original ya no existe, esta sección es la fuente)

### Ecosistema soberano (dominios, no terceros)

| Dominio | Rol |
|---------|-----|
| S-NFI Systems | Capa física de ejecución y control industrial |
| Elvi-Ra + Rëff | Capa cognitiva: orquestación + análisis/auditoría convergente |
| S-NFI Factory | Departamento fabricación |
| S-NFI U-2 | Ciencia e I+D a nivel doctoral, límites químicos |
| S-NFI Resilience | Estabilización red eléctrica, cálculos BSS |
| Legal & Fiscal | Cumplimiento normativo |
| Pactvm Viridi | Motor regulador, filtra toda actividad Elvi-Ra/terceros |

### Soberanía técnica

- Comunicación Elvi-Ra/Rëff <-> S-NFI Systems: **endpoints privados en puertos cerrados exclusivamente**.
- Infraestructura: servidores físicos propios, Debian/Kubernetes. Cero nubes públicas para núcleo lógico.
- Credenciales: identidad criptográfica verificable, gestión centralizada.

### Seguridad grado militar

- Fallo operativo = sanciones CNMC o pérdida patentes/certificaciones.
- Logs absolutos e inmutables. Todo acceso registrado permanentemente.
- Solo Admin autoriza directrices críticas. Pactvm Viridi = estándar cumplimiento industrial internacional.

### Prioridades de asalto (orden obligatorio)

1. **Twin Elvi-Ra <-> S-NFI Systems**: enlace seguro (endpoints privados puertos cerrados).
2. **Pipeline Dictamen de Soberanía**: lead/dato externo -> Pactvm Viridi -> Rëff -> Dictamen en dashboard -> autorización Admin.

> **Doctrina**: Infraestructura antes que interfaz.

## Referencias

- Knowledge base S-NFI: `Elvi-Ra/Elvi-Ra Zone/BackEnd/SNFI Base Conocimiento.txt`
- Flujos: `Elvi-Ra/Elvi-Ra Zone/BackEnd/Elvi-Ra Context.txt`
- Plan Volumen 2: `VOLUMEN-2-PLAN.md`
- Plan Volumen 3: `VOLUMEN-3-PLAN.md` (doctrina literal: `Instrucciones.txt`)
- Despliegue: `scripts/`
- README app: `app/README.md`
