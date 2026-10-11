# Referencia de SYSTEMS: doctrina y especificación por mesa

Detalle que NO se carga en cada sesión. [CLAUDE.md](../CLAUDE.md) es el índice corto y manda; aquí está la doctrina completa y la ficha detallada de cada mesa. Buscar por sección con Grep, no leer entero. Al cambiar una mesa o la doctrina, actualizar su sección aquí (y la línea de CLAUDE.md solo si cambia lo que la mesa es). Contenido trasladado de CLAUDE.md el 2026-10-01 sin cambios de fondo; la bitácora fechada está en [ESTADO-HISTORICO.md](ESTADO-HISTORICO.md).

## Modelo Volumen 2 (vigente desde 2026-07-05)

**Systems** es el programa madre: fuente de verdad de S-NFI (info, variables, métricas). El dashboard post-login se llama SYSTEMS y tiene cuatro dominios (2026-08-24: ØPHS y Pactvm Viridi pasan a tiles propios de primer nivel, antes ØPHS colgaba de Elvi-Ra):

- **Dominio ØPHS**: Consola Soberana propia (`ophs.html`) — Cockpit (ØPS + PAIA + Herzog + Sentinel) y Grid Interlink. Ya no cuelga de Elvi-Ra.
- **Dominio Rëff (cerebro de datos)**: mesas Rëff (CRM + imágenes por empresa), S-NFI U2 y S-NFI Finance, más M&A, F&L, Resilience, S-EAGLE y Factory (placeholder); ver la columna Dominio de la tabla de mesas.
- **Dominio Elvi-Ra (palanca de acción)**: mesa Elvi-Ra (Central) y Sentinel. La mesa Lab (ingesta asíncrona, `foundry.html`) se retiró del código: ver la tabla de mesas y la nota en Doctrina Lab.
- **Dominio Pactvm Viridi**: guardián doctrinal/cumplimiento bio-ambiental (`pactum-viridi.html`), independiente de Elvi-Ra/Rëff/ØPHS. Conectado ÚNICAMENTE a S-NFI U-2 (lectura del snapshot de optimización/pérdidas frente a demanda real, `GET /api/pactvm/u2-summary` y embebido en `GET /api/pactvm/summary`) y a Herzog en ØPHS (auditorías/CIBE, ya existente). Visible para admin + roles con acceso a `snfiu2` (ray, gonzalo) vía `ROLE_MESAS`.

Los tres (Systems, Rëff, Elvi-Ra) son inteligencias independientes que intercambian información para monitorizar. Ejemplo doctrinal: Systems dice que un nodo debe quemar a 150°, Rëff reporta que Barcelona quema a 120°, Elvi-Ra notifica al humano.

- **Elvi-Ra ya NO es programa madre**: es solo la IA de acción, siempre con consentimiento humano. `elvi-ra.html` = solo Central (chat conocedor de todo el sistema: CRM, sesiones, U2, nodos) que propone acciones; el humano autoriza o rechaza; todo va a log inmutable con cadena de hashes.
- **ØPHS es página propia** (`ophs.html`, mesa `ophs`, tile propio en dashboard) — NO depende del chat de Elvi-Ra. Vistas internas reales (2026-09-30, router por hash en `ophs.html`): Cockpit = hub de solo 4 tiles ØPS/PAIA/Herzog/Sentinel (`#cockpit`), sección PAIA (`#paia`, visor 3D de maquinaria, ver matriz abajo) y tab Grid Interlink (`#grid`). ØPS y Herzog siguen "próximamente". **El globo three.js de ØPHS descrito en Volumen 2 NO existe en el código actual** (nunca llegó a commit; los globos vivos son el del cliente React de Rëff y el del VDR de Pactvm Viridi, `js/vdr-globe.js`). `elvi-ra.html` sigue soportando `?prefill=...` (precarga el chat; el humano pulsa Enviar).
- **Rëff** = cerebro de datos empresariales y del sector en tiempo real. Único dueño de ØPHS/Scoring.
- **Puerto Systems real**: env `SYSTEMS_URL` (+`SYSTEMS_TOKEN`). Sin definir → mock local (colección `systems_nodes`). Contrato: `GET /api/ophs/contract`.

Volumen 2 (T1-T8) se completó el 2026-07-05. `VOLUMEN-2-PLAN.md`, `VOLUMEN-3-PLAN.md` e `Instrucciones.txt` no existen en el repo ni en el historial de git (nunca se versionaron): la fuente vigente de esa doctrina es este archivo.

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

## Mesas (estado real)

| Mesa | Dominio | Estado | Función |
|------|---------|--------|---------|
| Rëff | Rëff | Activa | CRM inteligencia comercial: hojas, empresas, tareas, imágenes y PDFs por empresa (GridFS, bucket `company_images`), Herzog, Vigilancia, Consola Maestra & Control de Tráfico, globo, Calendario de reuniones con avisos por correo (ruta `/calendario`) y Comunicaciones (registro de contactos por empresa con adjuntos de prueba en GridFS `company_comm_files`, pestaña "Dashboard de comunicaciones" de esa misma ruta, `communications.routes.ts`) |
| S-NFI U2 | Rëff | Activa | Energía desperdiciada sistema eléctrico ES (REE/ESIOS, dato vivo) |
| S-NFI Factory | Rëff | **En desarrollo pendiente** | Mesa vaciada por directriz 2026-09-08 (reunión con el jefe). Backend/frontend anterior (assembly/logistics/inventory/maintenance) eliminado. Tile placeholder `factory.html`, guard `factory` reservado en `server.js`, sin rutas backend activas |
| S-NFI Finance | Rëff | Activa | Tesorería, flujo caja proyectado, contabilidad analítica, activos reales (`finance.js`) + CRM documental de empresas con informes/archivos por carpeta (`finance-companies.js`, GridFS `finance_company_docs`). Patrón vanilla + rutas nativas |
| S-EAGLE | Rëff | Activa | Revisa la información que Herzog Central retiene: H-CONEXION (feed de lectura de `herzog_metrics`/`herzog_documents`/`herzog_notes` + estado de revisión propio `pendiente/verificado/corregido/error` en `seagle_reviews`, botón para compartir corrección de vuelta a Herzog con tag `origin:seagle`) y mapa mundi + portales Gob Share (sin backend propio, reutiliza dataset ya existente en frontend). Log inmutable `seagle_log`. `seagle.js` + 3 páginas (`seagle.html`, `seagle-hconexion.html`, `seagle-mapa.html`), guard `seagle`. Métricas propias de S-EAGLE: placeholder explícito en el summary, alcance pendiente de definir |
| S-NFI M&A | Rëff | Activa | Inteligencia corporativa crecimiento fractal: valoración (múltiplos/DCF), pipeline deals, synergy payback. `mna.js` |
| S-NFI F&L | Rëff | Activa | Fiscal & Legal Hub (rehecho 2026-10-12; sustituye a `fl.js`, cuyas secciones de licencias, matriz legal, poderes, inspecciones y accesos externos se retiraron con sus colecciones vacías, que siguen en Mongo). `fl.html` con 6 pestañas: (1) Centro de mando: KPIs (cumplimiento fiscal en plazo, notificaciones sin acuse con cuenta atrás al rechazo presunto, alertas BOE/BORME, contratos y poderes por renovar), calendario fiscal y societario (mes y agenda) y feeds. (2) Fiscalidad y auditoría: modelos tributarios AEAT y forales (S-90, F-69, F50-347 de Hacienda Foral de Navarra con plazo orientativo), checklist NIA-ES y consulta de normativa (índice de normas con identificadores BOE-A y artículos verificados, enlace al buscador de consultas de la DGT). (3) GobTech: notificaciones de las AA.PP. sin conector DEHú (registro manual del acuse con declaración expresa; rechazo presunto a los 10 días naturales, art. 43.2 Ley 39/2015; plazo de respuesta por art. 30 sin festivos, cómputo conservador; flujo pendiente → asignada → respondida → archivada). (4) Gobierno corporativo: sociedades del grupo, libro de actas y juntas (depósito de cuentas, art. 279 LSC), matriz de apoderamientos con límites de firma y caducidad, publicaciones BORME por denominación. (5) CLM: contratos con vigencia, preaviso de renovación y riesgo de contraparte. (6) Expediente Fiscal y Jurídico (`fl-expediente.js`, sin cambios, guard propio `fl_expediente`, carga diferida al abrir la pestaña). Backend `fl-hub.js` (rutas, derivaciones, KPIs, calendario, ficha PDF con pdfkit cuyo acceso queda en `fl_log`, alarmas diarias al Admin que ignoran los datos de demostración) + `fl-hub-catalogos.js` (esquemas de entidad que el frontend usa para generar formularios, normas, portales) + `fl-hub-fechas.js` (plazos) + `fl-hub-seed.js` (datos PLACEHOLDER con `placeholder: true`, NIF con provincia 00, prefijo DEMO-) + `fl-boletines.js` (BOE y BORME reales desde la API de datos abiertos del BOE, al arrancar y cada 6 h: clasificador de reglas sobre el título del BOE y vigilancia de las sociedades del grupo en el índice alfabético del BORME). Colecciones `fl_sociedades`, `fl_modelos`, `fl_notificaciones`, `fl_juntas`, `fl_apoderamientos`, `fl_clm_contratos` (no `fl_contracts`, que es huérfana de 2026-09-04), `fl_nia_checklist`, `fl_alertas_normativas`, `fl_meta`. Archivar es soft-delete; `POST /api/fl/demo/retirar` archiva toda la demostración. Una sola mesa `fl` (más `fl_expediente`), log compartido `fl_log`: las entradas nuevas llevan `canon: 2` (serialización canónica profunda) y `GET /api/fl/log/verify` verifica las dos versiones |
| S-NFI Resilience (BSS) | Rëff | Activa | Inteligencia de detección de fallos de red eléctrica/eventos sistémicos, módulo de arbitraje conectado a Elvi-Ra (nunca ejecuta, solo detecta+señala). 3 dimensiones: continuidad operativa (autonomía/SoC/ICO), cadena de suministro (CRM proveedores + mapa + recalculo), datos transfronterizos (RPO/RTO + migración soberanía cifrada). `resilience.js`, solo admin |
| Pactvm Viridi | Pactvm Viridi | Activa | Dominio propio, 6 mesas. Hub `pactum-viridi.html` (6 tiles + health check, mismo patrón que `reff-dashboard.html`). (1) `pactvm-cibe.html`: certificado CIBE, políticas medioambientales, reglas de acceso, lectura Herzog, búnker CIBE (tokens Ed25519) — snapshot de pérdidas U-2 (`GET /api/pactvm/u2-summary`). (2) `pactvm-nodos.html`: interfaz geoespacial, nodos BioHybrid necesarios por país (`pactvm_country_nodes`, unidad T/día, capacidad piloto 150 T/día), mapa SVG plano. (3) `pactvm-entrada.html`: condiciones de entrada operativa por vertido (`pactvm_entry_conditions`). (4) `pactvm-carbono.html`: medidor de créditos de carbono — CO₂e acumulado por cliente, ratio DBO₅→créditos, rendimiento €/ha (`pactvm_carbon_clients`, `pactvm_carbon_ratio`), botones EMITIR_CERTIFICADO_VERRA/GOLD y TOKENIZAR_REDUCCIÓN, más KPI de tokens RWA (`rwaTokensMinted` = co2eTotal, 1 token = 1 T CO₂e evitada). Verificación pública del certificado por QR (`GET /api/pactvm-verify/:packageId` y `POST /api/pactvm-verify/:packageId/unlock`, sin sesión: solo estado y hash; si el paquete tiene allowlist de correos, el detalle exige código temporal; colecciones `pactvm_carbon_verify`, `pactvm_verify_allowlist`, `pactvm_verify_access_codes`; el código de acceso, de 6 dígitos y 20 min por defecto (máx. 240), se guarda hasheado en `codeHash` y los fallos quedan trazados como `carbon.verify_denied`). (5) `pactvm-planetario.html`: Motor Planetario (Planetary Monitoring Engine) — parámetros globales de capacidad editables (`pactvm_planetary_config`: nodos máx/activos, ticket unitario, capacidad nodo T/año, precio crédito carbono), países objetivo en T/año (`pactvm_planetary_countries`, unidad distinta de Nodos por País — tabla separada a propósito, sin unificar), mapa SVG + barras de saturación por país, telemetría "CUDA-Bio" simulada (`GET /api/pactvm/planetary/telemetry`, oscilación determinista por minuto de reloj, sin sensores reales). (6) `pactvm-vdr.html`/`pactvm-vdr-globe.html`: CRM de empresas (`pactvm_vdr_companies`: nombre, `geoCountry` ISO-2 dropdown + `geoWeight` num, `spainActivity` num) con vista geoespacial individual por empresa — globo 3D real (three.js vendor local, `/vendor/three.module.min.js`, textura equirectangular generada en canvas, sin dataset vectorial) con estrella en el país de ubicación (tamaño = geoWeight) y punto rojo fijo sobre España (tamaño/intensidad = spainActivity). Lat/lng de países fijas en `VDR_COUNTRY_COORDS` (ES/PT/FR/MA/MX/DE/US/GB/IT/BR) — ampliar si se registran empresas en otros países. Parámetros editables de España del globo (`pactvm_vdr_es_config`: nodos objetivo, GW de curtailment objetivo mín/máx, energía anual por nodo, t de biopellet por nodo y año; `GET/PATCH /api/pactvm/vdr/es-config`). Enlaces temporales de invitado para presentar a clientes bajo NDA: alta y revocación autenticadas en `/api/pactvm/vdr/shares` (TTL 15 min por defecto, máx. 240; correos autorizados + código de 6 dígitos guardado hasheado) y acceso público en `pactvm-vdr-invitado.html` vía `GET /api/vdr-share/:token` y `POST /api/vdr-share/:token/unlock` (colección `pactvm_vdr_shares`). Los desbloqueos de verificación y de invitado limitan los intentos fallidos: 10 cada 15 min por IP y objetivo y 30 por hora por objetivo (429 al superarlo). El invitado no monta sesión, no exporta PDF ni navega al resto del sistema, el reparto territorial se retira del payload y cada acceso o denegación queda en `pactvm_log` y en el `accessLog` del enlace. Límite aceptado (Nour): quien ve la pantalla puede capturarla, la protección de ese lado es contractual (NDA). Las rutas públicas de invitado y de verificación (`/api/vdr-share/*`, `/api/pactvm-verify/*`) viven fuera del prefijo `/api/pactvm` a propósito: `server.js` aplica `auth` + `requireMesa('pactvm')` a todo ese prefijo antes de montar la mesa. Backend único `pactum-viridi.js`, el resto de rutas bajo mesa `pactvm` (permiso compartido, sin split de ROLE_MESAS) |
| Elvi-Ra | Elvi-Ra | Activa | `elvi-ra.html`: solo Central (chat + acciones autorizadas). Solo Admin |
| Sentinel | Elvi-Ra | Activa | Seguridad ciber-industrial: forense IP, hash chain, rate limit, cola revisión, integridad Debian/SSH/Git/red. Sub-interfaz del Cockpit ØPHS ("Security & Fail-safes"). Solo Admin |
| ØPHS | ØPHS | Activa | Dominio propio (`ophs.html`, antes colgaba de Elvi-Ra): tab Cockpit = hub de 4 tiles (PAIA abre su sección `#paia` con el visor 3D de las 3 máquinas BioHybrid; Sentinel enlaza a `sentinel.html`; ØPS y Herzog "próximamente") + tab Grid Interlink. Sin globo (ver nota Volumen 2). Ver [Matriz ØPHS Framework](#matriz-de-interfaces-suite-øphs-framework) |
| Lab | Elvi-Ra | **Retirada** | Pipeline de ingesta asíncrona v1 (`foundry.js`, `foundry-u2-worker.js`, `foundry.html`: gateway HMAC + bus + breakers + sifón U-2) eliminado del código: ya no hay mount, tile ni key `foundry` en `ROLE_MESAS`, y no existen las rutas `/api/foundry/*` ni `/api/sentinel/pipeline-metrics`. Sus residuos de configuración se eliminaron de `docker-compose.yml` y `k8s/` (2026-10-02); solo queda `FOUNDRY_INGRESS_PORT` en el `.env` local y en `.env.vault` (inofensivo: recifrar el vault rota su clave). La doctrina se conserva como diseño de referencia: [Doctrina Lab](#doctrina-lab-ingesta-asincrona-2026-07-08) |
| Puerto Maestro | Transversal | Activa | `master-gateway.html`/`master-gateway.js`, guard `gateway`. Control de tráfico inter-puertos Rëff/Elvi-Ra/ØPHS: solicitudes firmadas `PENDING_MASTER_APPROVAL`, aprobación exclusiva Admin, log inmutable (`gateway_log`). Tile en sección "Seguridad · Auditoría" de `dashboard.html` |
| Herzog (Central) | Transversal | Activa | Distinta del Herzog interno de ØPHS Framework: búnker receptor de TODA la información/datos de SYSTEMS (todo departamento pide/guarda ahí). Métricas (`herzog_metrics`, origen `auto` vía `pollBaseMetrics` cada 5 min desde Finance/ØPS/CIBE/U2 o `manual`), documentos (GridFS `herzog_documents`, máx 20MB) y notas (`herzog_notes`). Log inmutable `herzog_log`. Tile discreto (enlace de texto, no tile completo) en sección "Seguridad · Auditoría" de `dashboard.html`, guard `herzog`. `herzog.js` + `herzog-central.html` |
| Centro de Notificaciones | Transversal | Activa | `notificaciones.html` + `notification-center.js`, mesa `notificaciones` (solo admin), rutas `/api/notif-center/*`. Vista admin unificada de `admin_notifications` (JSON, alertas de sistema) y `traffic_requests` (Mongo db `reff`, solicitudes de la Consola Maestra de Rëff) con las acciones 1-clic de tráfico (aprobar, denegar, requerir justificación) re-implementadas detrás de `requireAdmin` real en lugar de la whitelist `TRAFFIC_ADMINS` de Rëff. Retención de 6 meses: al resolver una solicitud se fija `expireAt` y un índice TTL de Mongo la purga; las pendientes no expiran |

## Matriz de interfaces: Suite ØPHS Framework

El framework ØPHS se divide en 4 micro-interfaces independientes que convergen en un único Cockpit (mesa `ophs`, guard `requireMesa('ophs')`):

| Interfaz | Acrónimo | Propósito | Módulo |
|----------|----------|-----------|--------|
| Operational Performance System | **ØPS** | Telemetría hardware físico: presión, caudal, temperatura canalización Y acero inox, RPM, estado circuito cerrado | `app/backend/ops.js` (`/api/ops/*`) |
| Predictive AI Agent/Analytics | **PAIA** | Analítica proactiva: detección estadística de anomalías/tendencias sobre lecturas ØPS, insight en lenguaje natural vía `llm.js` (Ollama prod = coste cero) | `app/backend/paia.js` (`/api/paia/*`) |
| Compliance & Audit | **Herzog** | Auditor algorítmico: valida cumplimiento Pactum Viridi, emite conformidad frente a CNMC | Bridge mock en `elvira-central.js` (`/api/elvira/herzog/*`) + rutas reales en Rëff (`/reff/api/herzog`, alias `/api/herzog`) |
| Security & Fail-safes | **Sentinel** | Vigilancia ciber-industrial: integridad Debian/VMware, accesos SSH, logs Git, tráfico red | `app/backend/sentinel-forensics.js` (`/api/sentinel/*`) — mismo Sentinel de siempre, alcance extendido a infraestructura del nodo, no es un segundo Sentinel |
| **ØPHS Framework Cockpit** | **ØPHS** | Consola Soberana: fusiona resumen de las 4 anteriores, vista C-Level para los 4.530 nodos planificados | `app/backend/ophs-cockpit.js` (`/api/ophs-cockpit/summary`) — solo lectura agregada, no ejecuta ni sustituye la autoridad de cada sub-interfaz |

Doctrina: ØPS/PAIA nunca ejecutan acciones sobre hardware. PAIA solo propone (insight + recomendación); intervención real pasa siempre por Central con confirmación humana.

**Frontend**: `app/frontend/pages/ophs.html` es página independiente (tile propio en `elvira-dashboard.html`/`dashboard.html`, mesa `ophs`) — no depende ni vive dentro del chat de `elvi-ra.html`. Vistas reales por hash, sin recarga (Atrás, recarga y enlace directo funcionan): Cockpit (`#cockpit`, hub de 4 tiles y nada más) + sección PAIA (`#paia`, visor 3D de maquinaria: Bio-Grinder / Bio-Dehydrator / Bio-Pelletizer, modelos `.glb` OPTIMIZADOS en `vendor/models/` listados en `manifest.json` (los crudos de SketchUp viven en `app/assets-src/models/`, ver Pipeline de modelos 3D abajo), motor `js/machine-viewer.js`, que rechaza antes de parsear cualquier `.glb` con más de 3000 primitivas o materiales; HUD de telemetría `js/machine-hud.js` + `js/machine-telemetry.js` con lecturas SIMULADAS, sin sensores conectados: ver la entrada del 2026-10-01 en ESTADO-HISTORICO.md) + Grid Interlink (`#grid`: cards por país, chaos, alta de países). No hay tab Globo (ver nota Volumen 2). Ya no hay UI de lista/CRUD de nodos ØPS, lecturas ni insight PAIA en `ophs.html`: los endpoints `/api/ops/*` y `/api/paia/*` siguen en backend sin consumidor frontend. `elvi-ra.html` lee `?prefill=` y precarga el textarea del chat, pero el humano sigue pulsando Enviar — la acción real sigue pasando por confirmación explícita en Central.

**Pipeline de modelos 3D** (visor de PAIA): los `.glb` exportados de SketchUp traen una primitiva y un material por cara (miles de draw calls) y el visor se colgaba. Flujo para un modelo nuevo: dejar el `.glb` crudo en `app/assets-src/models/`, ejecutar `cd app/assets-src && npm install && npm run optimize` (glTF-Transform 4.5.1 con lockfile: deduplica materiales y texturas, aplana, une y poda; antes de escribir verifica la equivalencia geométrica por material y no escribe si falla) y añadir la entrada a `app/frontend/vendor/models/manifest.json`. Coste conocido: fusionar por material pierde la identidad de las piezas sueltas (el visor actual no interactúa con piezas). Medido el 2026-09-30: Pelletizator pasó de 26.877 draw calls a 12 y de 3,4 a 56-60 fps. Los crudos y `assets-src/` no se despliegan.

**Edición directa de nodos mock (`systems_nodes`)**: `PATCH /api/ophs/nodes/:id` en `elvira-central.js` — solo admin, edita status/target_temp_c/throughput_kg_h/bss_charge_pct/pellet_stock_t directamente (sin pasar por el flujo LLM propone→confirma de Central, porque quien llama el endpoint ya es el humano autorizando). Queda igual en el log inmutable (`central_action_log`, type `node.direct_edit`, decision `DIRECT_ADMIN`). Endpoint solo backend: sin UI que lo consuma hoy.

**CRUD nodos ØPS**: `app/backend/ops.js` — `POST/PATCH/DELETE /api/ops/nodes/:nodeId` (label, lat, lng opcionales; delete purga `ops_readings` y `paia_analyses` del nodo). `ops_nodes` (Cockpit, telemetría) y `systems_nodes` (mock Central) son colecciones separadas sin fusión de esquema. Sin UI que lo consuma hoy (el Cockpit de `ophs.html` es solo hub de tiles): alta/edición/borrado solo por API.

## Doctrina Lab (ingesta asincrona, 2026-07-08)

Esta sección es la fuente (el texto literal original vivía en `Instrucciones.txt`, que desde 2026-07-08 contiene la doctrina Volumen 3). Filosofía de fabricación industrial aplicada al data-stream para escalar a 4.530 nodos BioHybrid. Representada en la mesa `foundry.html` (Dominio Elvi-Ra). **Estado: mesa retirada del código** (`foundry.js`, `foundry-u2-worker.js` y `foundry.html` eliminados, sin mount, tile ni rutas `/api/foundry/*`): esta sección se conserva como diseño de referencia.

- **Capa ASML (litografía de datos)**: telemetría capturada en origen con timestamp a microsegundos, sin ruido, formateo matemático perfecto.
- **Capa TSMC (fundición / salas limpias)**: flujo `HARDWARE BioHybrid → Ingress Gateway OPHS → bus asíncrono → 4 canales paralelos`. El Gateway solo valida firma criptográfica del nodo + formato (puerto parametrizado en Sentinel); no procesa, no guarda, no transforma.
- **Canales**: ØPS (control crítico, prioridad ultra-alta, sockets baja latencia), PAIA (IA local, buffer elástico que nunca ralentiza ØPS), Herzog (solo escritura, métricas CIBE/CNMC, registros inmutables), S-NFI U-2 (sifón científico: consumidor pasivo, worker threads independientes, time-series DB, backpressure con descarte ordenado — estabilidad del hardware prima sobre recolección científica).
- **Directivas V12 Biturbo** (2026-07-08, su implementación v1 se retiró): 1) concurrencia no bloqueante (bus asíncrono; en producción multi-proceso, Redis Streams o MQTT), 2) circuit breaker independiente por ramificación (umbral de 5 fallos, cooldown de 30 s, half-open; si PAIA o Herzog caen, ØPS sigue intacto), 3) métricas de "tiempo de viaje" por canal con presupuesto de latencia (250 ms por defecto); los excesos van al bus y a notificación Admin.
- **Criterio para reconstruirla**: el hardware de alta frecuencia entra SIEMPRE por un puerto dedicado, porque el puerto embebido atraviesa el log forense de Sentinel. El gateway valida firma HMAC por nodo y formato sin procesar nada; el detalle de la implementación v1 (gateway, bus, breakers, sifón U-2 en worker thread, simulador) está en el historial de git previo al borrado.
- Arquitectura bajo secreto industrial: NDA vinculante + Modelo de Utilidad, titularidad de la Holding.

## Doctrina Volumen 3 · Escalabilidad Fractal (2026-07-08)

Fuente literal: `Instrucciones.txt` y plan `VOLUMEN-3-PLAN.md`, ambos ausentes del repo (nunca se versionaron): esta sección es la fuente. Los comentarios del código citan `Instrucciones.txt` §1 (Rack State), §2 (Grid Interlink) y §3 (CIBE Bunker). Tres pilares implementados v1:

- **Rack State** (`rack-state.js`, rutas `/api/rack/*`, mesa sentinel): consenso Raft real entre racks Edge — elección de líder, replicación de log, commit por mayoría. KV replicado de puertos parametrizados (`ports.*`) y estados de seguridad (`security.*`). Sin `RACK_PEERS` → standalone (quorum 1). Exclusión mutua distribuida: rack sin quorum no comete escrituras (anti split-brain) pero sirve lecturas del último estado comprometido (Offline-First). Malla inter-rack HTTP+HMAC (`RACK_SHARED_KEY`), punto de sustitución por túneles S-NFI Teleco. Colecciones: `rack_raft`, `rack_raft_log`, `rack_state`, `rack_log` (hash chain).
- **CIBE Bunker** (`cibe-bunker.js`, mesa pactvm): módulo búnker de Pactvm Viridi. Tokens Ed25519 firmados y fechados (TTL 120s, jti/sub/scope/iat/exp) exigidos en endpoints críticos ØPHS via `cibe.guard(scope)`: CRUD nodos ØPS y circuit-state (`ophs.command`), `PATCH /api/ophs/nodes/:id`, breakers Foundry (`foundry.command`, scope sin uso desde que se retiró Lab), propuestas rack (`rack.command`), mutaciones grid (`grid.command`). `CIBE_MODE=auto` (default): sesión admin → token auto-expedido y trazado; `strict` exige cabecera `X-CIBE-Token`. Externos: `POST /api/cibe/token` con HMAC de tokenKey, solo con certificado `pactvm_cibe` en estado `emitido` — si no, **Auth-Refusal** 403 a `cibe_log` (hash chain) + evento Sentinel. Clave pública: `GET /api/cibe/public-key`. Par de claves en Mongo `cibe_keys` (prod: `CIBE_PRIVATE_KEY_PEM` desde vault).
- **Grid Interlink** (`grid-interlink.js` + `grid-country-worker.js`, rutas `/api/grid/*`, mesa ophs): Grid Abstraction Layer transnacional. Un worker thread POR PAÍS (ES/REE, PT/REN, FR/RTE, MA/ONEE + CRUD) con `resourceLimits` = sandbox de memoria V8: el colapso del TSO de un país (DDOS/fallo masivo) mata solo su worker; supervisor con respawn backoff + detector de congelados; los demás países siguen al 100%. Payload GridSignal estandarizado (el Kernel es agnóstico del operador). Modo sim sin URL; `GRID_<CC>_URL` → live. Chaos demo: `POST /api/grid/countries/:code/chaos` {crash|stall|flood}. Reflejo PAIA: alerta crítica → solo notificación Admin (Regla de Oro intacta).

## Lógica de evaluación (Dictamen de Soberanía)

Output esperado del agente = **Dictamen de Soberanía**:

```
• NODO: [Empresa]
• SECTOR / UBICACIÓN
• PUNTUACIÓN OPHS (0-100): OPS + PAIA + Herzog + Sentinel integration ease
• CÁLCULO RESILIENCE (BSS): X MWh para 48h post-apagón
• ESTADO CNMC: riesgo regulatorio
• DICTAMEN DEPARTAMENTAL: U-2 + IIA + Factory + Finance
```

Variables clave: **W** (residuo), **I** (infraestructura), **S** (escalabilidad), **M** (compatibilidad OEM), **E** (impacto económico), **R** (estratégico), **B** (BSS resilience), **G** (gobernanza Herzog), **U-2** (reto científico).

Clasificación: ESTRATÉGICO / OPERATIVO / NO CANDIDATO. Duda razonable → no estratégico.

Penalización fuerte: biogás/anaerobia clásica, sanciones CNMC, opacidad, incompatibilidad ØPHS.

## Doctrina de Ejecución (Regla de Oro)

**Inmutable. No negociable.**

> El ser humano autoriza. El ser humano supervisa. El sistema ejecuta.

- Elvi-Ra propone orquestación. Nunca ejecuta acciones físicas en infraestructura industrial sin confirmación humana.
- Rëff valida y audita. Nunca actúa de forma autónoma.
- S-NFI Systems ejecuta solo bajo validación del Admin.
- Toda directriz crítica requiere autorización de Dirección (Admin).
- Logs absolutos e inmutables. Todo acceso registrado de forma permanente.

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

## Stack y despliegue (detalle)

- **Backend**: Node.js >=20 + Express ESM, un solo proceso/puerto (5173) para todas las mesas. MongoDB (db `elvira` + db `reff`, pool compartido). Estado ligero en JSON solo para `data/elvira.json` (bridges/ØPHS scoring/CNMC) y caches; usuarios y sesiones viven en Mongo (ver Auth abajo).
- **LLM**: `app/backend/llm.js` — `LLM_PROVIDER=anthropic|ollama` via env, lectura perezosa de `ANTHROPIC_API_KEY`. Tokens contabilizados en T'Controler.
- **Rëff**: Vite/React+TS compilado a dist/, montado en runtime por server.js bajo `/reff` (y su API en `/reff/api` + alias `/api`). El Dockerfile lo compila en stage propio.
- **S-NFI Finance**: página vanilla en `app/frontend/pages/` + rutas nativas (`finance.js` y `finance-companies.js`, montados desde `server.js`), mismo patrón que S-NFI U2 (no dentro de la app React de Rëff: ese diseño se descartó).
- **Frontend Elvi-Ra**: HTML/CSS/JS vanilla. Fonts: IBM Plex Mono + IBM Plex Sans, cargadas desde Google Fonts en runtime en las 30 páginas (no hay fuentes autoalojadas; pendiente si se exige soberanía total). Vendor local (three.js, topojson-client, countries-110m.json, html2canvas, jsPDF): cero CDN de scripts en runtime. Tema claro/oscuro compartido por todas las páginas (`js/theme.js`: clave `systemsTheme` en localStorage y atributo `data-theme` en `<html>`; por defecto oscuro).
- **Estética**: minimalismo Apple + animaciones Palantir/Anduril (reveal, delays, mono labels, dark feel). Login: infinito neón canvas + transición descenso a oficina. Dashboard: fondo oficina animada sutil.
- **Auth**: token Bearer en `localStorage`. `requireAuth()` + guard `/api/me/permissions` (mesas por rol) en cada página. Backend: `app/backend/routes/auth.routes.js` (colecciones Mongo `users`/`sessions`, TTL index sobre `exp` — Mongo purga sesiones expiradas solo). Migración one-shot desde el store JSON previo: `scripts/migrate-auth-to-mongo.js` (idempotente, respalda los JSON originales a `*.migrated.json`). Rutas públicas (sin sesión), registradas fuera de los prefijos protegidos: sondas (`/api/health`, `/api/livez`, `/api/readyz`), CIBE (`/api/cibe/public-key`, `/api/cibe/token`), y la verificación de certificados de carbono y los enlaces de invitado VDR (ver tabla de Mesas, fila Pactvm Viridi). `server.js` aplica `auth` + `requireMesa(...)` por prefijo con `app.use` antes de montar cada mesa, así que una ruta pública declarada dentro de un prefijo protegido quedaría bloqueada. `/reff/api/guest-token` (y el alias `/api/guest-token`) exige sesión de Elvi-Ra con acceso a la mesa reff y deduce el usuario de Rëff de la sesión (`routes/reff-guest.routes.js`); un usuario sin correspondencia explícita recibe 403.
- **Infraestructura soberana (destino)**: servidores físicos propios, Debian/Kubernetes. Cero dependencia de nubes públicas de terceros para el núcleo lógico.
- **Fase transitoria (deploy actual)**: servidor Debian en Hetzner (Europa). Gestionado por el jefe. Hetzner = tercero aceptado solo para capa de deploy, no para núcleo lógico.
- **Coolify**: plataforma CI/CD auto-alojada (equivalente a Vercel/Netlify). Push a la rama vigilada → deploy automático. El repo solo tiene la rama `master` (en `origin` y en `private`; no existe `main`): confirmar en Coolify qué rama vigila.
- **GitHub**: repositorio fuente (pendiente conectar a Coolify).
- **VM Debian/VMware**: `sudo bash scripts/provision-debian.sh` (idempotente: Docker, UFW, /opt/elvi-ra, .env, systemd, healthcheck).
- **Reglas de código**: credenciales prod y JWT secret via variables de entorno (panel Coolify), nunca hardcoded; persistencia en Mongo (volúmenes `mongo-data` + `elvira-data` sobreviven redeployos).
- **Credenciales (dev)**: usuarios y contraseñas dev en `.env` local (no trackeado, `SEED_*_PASSWORD`); no commitear credenciales en texto plano. Hashes bcrypt en la colección Mongo `users` tras el primer seed (`ensureUsersSeed`, solo si la colección está vacía). Seed Rëff (`server/db.ts`): contraseñas via env `REFF_SEED_<USER>_PASSWORD` (movidas de texto plano a env 2026-07-09); sin variable, el usuario no se crea.
- **Vault de secretos (.env cifrado)**: `app/backend/scripts/env-vault.js` cifra `.env` -> `.env.vault` (AES-256-GCM, `node:crypto`, sin dependencia externa). `.env.vault` SÍ se commitea (excepción explícita en `.gitignore`: `!.env.vault`); `.env` sigue ignorado. La clave de descifrado (32 bytes hex) se imprime una única vez al cifrar y debe guardarse en el gestor de secretos de la plataforma de despliegue — nunca en el repo. Uso: `node scripts/env-vault.js encrypt [dir]` / `decrypt [dir]` (dir por defecto: `app/backend`; para el `.env` de Rëff pasar `"Elvi-Ra/Mesas/Rëff"`). Recifrar tras cualquier cambio de secretos en `.env`.
