# K8s local — SYSTEMS / Elvi-Ra (Fase 1)

Manifests para probar el salto a k8s en local antes de tocar produccion (Coolify/Hetzner sigue siendo el despliegue real hoy, ver el apartado "Stack y despliegue" de [docs/REFERENCIA.md](../docs/REFERENCIA.md)).

**Estado de validacion (2026-10-02)**: los primeros 6 manifests (14 recursos) validaron limpio contra el schema real de Kubernetes con `kubeconform -strict`, en 1.34 y 1.37, sin errores, y `server.js` se arranco en caliente contra un `mongod` 7.0.43 real (con y sin auth) verificando: `/api/livez`/`/api/readyz`/`/api/ophs/readyz` responden lo esperado, las sondas no ensucian `forensic_log`, `readyz` falla en <3s si Mongo cae (antes: sin timeout acotado), el apagado ordenado (`SIGTERM`) drena conexiones/SSE y deja la marca de arranque limpia, un proceso que muere sin apagarse (`SIGKILL`/OOM) SI dispara el aviso de "recuperado tras caida" en el siguiente arranque y uno que se apago limpio NO, y `withTransaction` funciona en Mongo standalone (sin replica set, la topologia real de `k8s/03-mongo.yaml`) sin lanzar `IllegalOperation`. Suite completa de tests del repo verde contra el codigo parcheado (98/98 a 2026-10-05).

**Añadido 2026-10-05, sin re-ejecutar kubeconform todavia** (este entorno sigue sin `kubectl`/`kind`/`docker`/`kubeconform` instalados — no se puede verificar aqui, hay que correrlo antes de aplicar): `06-networkpolicy.yaml` (default-deny + reglas explicitas Mongo/elvira-core/ophs/DNS), `podAntiAffinity` (preferida) en `04-elvira-core.yaml` y `05-ophs.yaml` para que las 2 replicas no caigan en el mismo nodo, y `automountServiceAccountToken: false` en los tres Deployments/StatefulSet (ninguno llama al API de k8s desde dentro). Sintaxis revisada a mano contra la spec de `networking.k8s.io/v1`, `apps/v1` y `v1`/PodSpec, pero no sustituye a `kubeconform -strict` ni a `kubectl apply --dry-run=client -f k8s/`: correr ambos antes de desplegar (ver Requisitos locales).

## Requisitos locales

- Docker Desktop (o Docker Engine)
- `kind` (Kubernetes in Docker) — mas ligero que minikube para este caso
- `kubectl`
- `metrics-server` — kind NO lo trae por defecto; sin el, el HPA se queda en
  `<unknown>` y nunca escala. Instalar tras crear el cluster:
  ```bash
  kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
  # kind usa certificados internos self-signed: si metrics-server no arranca,
  # anadir --kubelet-insecure-tls a sus args (solo entorno local, nunca en prod)
  ```

## Orden de aplicacion

Los ficheros estan numerados porque el orden importa (namespace antes que todo, secrets antes que los Deployments que los consumen).

```bash
# 1. Cluster local
kind create cluster --name elvira-local

# 2. Build imagen desde el Dockerfile ya existente en el repo (app/Dockerfile)
docker build -f app/Dockerfile -t elvira:local .
kind load docker-image elvira:local --name elvira-local

# 3. Secrets reales (NUNCA commitear este fichero, ya esta en .gitignore)
cp k8s/02-secrets.example.yaml k8s/02-secrets.yaml
# editar k8s/02-secrets.yaml con valores reales

# 4. Aplicar en orden
kubectl apply -f k8s/00-namespace.yaml
kubectl apply -f k8s/01-configmap.yaml
kubectl apply -f k8s/02-secrets.yaml
kubectl apply -f k8s/03-mongo.yaml
kubectl apply -f k8s/04-elvira-core.yaml
kubectl apply -f k8s/05-ophs.yaml   # replicas:0, no consume recursos aun
kubectl apply -f k8s/06-networkpolicy.yaml   # requiere CNI con soporte NetworkPolicy, ver nota en el fichero

# 5. Verificar
kubectl -n elvira get pods -w
kubectl -n elvira get pdb,hpa
```

## Comprobar deteccion de fallo ("nos enteramos a los segundos")

```bash
# Forzar port-forward para probar readiness/liveness manualmente
kubectl -n elvira port-forward svc/elvira-core 5173:5173

# En otra terminal:
curl http://127.0.0.1:5173/api/livez
curl http://127.0.0.1:5173/api/readyz

# Simular pod roto y medir cuanto tarda kubelet en sacarlo del Service:
kubectl -n elvira exec -it deploy/elvira-core -- kill 1
kubectl -n elvira get pods -w   # deberia mostrar Restarting/CrashLoopBackOff en <10s
```

## Comprobar Fase 3 (PDB + HPA + rolling update sin downtime)

```bash
# PDB: confirmar que un drain nunca tumba las 2 replicas a la vez
kubectl -n elvira get pdb
# columna ALLOWED DISRUPTIONS debe ser >=1 con 2 replicas sanas

# HPA: forzar carga y ver escalado (requiere metrics-server en el cluster kind)
kubectl -n elvira get hpa -w

# Rolling update sin downtime: cambiar cualquier env en 04-elvira-core.yaml y:
kubectl apply -f k8s/04-elvira-core.yaml
kubectl -n elvira get pods -w
# maxUnavailable:0 -> nunca deberia bajar de 2 pods Ready durante el rollout
```

## Activar ØPHS cuando llegue el hardware

```bash
kubectl -n elvira scale deployment/ophs --replicas=2
```

Antes de escalar: revisar `05-ophs.yaml` para actualizar `SYSTEMS_URL` con el puerto real que de el jefe, y confirmar si ØPHS sigue viviendo en el mismo `server.js` monolito o pasa a proceso propio (si pasa a proceso propio, `/api/ophs/readyz` en `server.js` debe moverse a ese proceso y comprobar conexion a Systems real, no solo Mongo — ver comentario en el propio manifest).

Nota: nombres de recurso Kubernetes (`deployment/ophs`, `Service`, labels `app: ophs`), rutas HTTP (`/api/ophs/readyz`) y nombre de archivo del manifest (`05-ophs.yaml`) son ASCII puro — los nombres de objeto de Kubernetes deben cumplir RFC 1123 (alfanumerico ASCII + guiones), Ø/ø no son validos ahi, y el resto del codigo (`server.js`, rutas HTTP) revirtio a ASCII el 2026-10-02 por decision explicita. Solo la marca ØPHS en prosa (este README, comentarios) sigue con la Ø.

## Comprobar apagado ordenado (SIGTERM)

```bash
# Un rollout, un drain de nodo o `kubectl scale --replicas=0` mandan SIGTERM. server.js:
# pasa readyz a 503 (sale del Service), drena conexiones HTTP/SSE en vuelo, hace flush
# del historial del bus, cierra Mongo y sale con exit 0 — todo antes de
# terminationGracePeriodSeconds (35s en 04-elvira-core.yaml / 05-ophs.yaml).
kubectl -n elvira rollout restart deployment/elvira-core
kubectl -n elvira get pods -w   # Terminating -> Running del pod nuevo, sin que readyz del viejo
                                 # quede devolviendo 200 durante el drenado

# Confirmar el aviso de caida SUCIA (kill -9, simula OOM/crash real) vs limpia (rollout normal):
kubectl -n elvira exec deploy/elvira-core -- kill -9 1
# el siguiente arranque de ESE pod debe generar una notificacion Admin "recuperado tras
# caida" (ver /api/notif-center o admin_notifications.json); un rollout normal no la genera.
```

## Comprobar NetworkPolicy (aislamiento de red)

```bash
# Requiere un cluster con CNI que soporte NetworkPolicy (kindnet, el CNI por
# defecto de kind, NO lo soporta -- crear el cluster con Calico o Cilium para
# probar esto en local, ver kind.sigs.k8s.io/docs/user/configuration/#the-kindnetd-cni).

# Debe FALLAR (ningun pod fuera de elvira-core/ophs puede hablar con Mongo):
kubectl -n elvira run probe --rm -it --image=mongo:7.0.43 --restart=Never -- \
  mongosh --host mongo --eval "db.adminCommand('ping')" --quiet

# Debe FUNCIONAR (elvira-core SI puede hablar con Mongo):
kubectl -n elvira exec -it deploy/elvira-core -- node -e \
  "require('net').connect(27017,'mongo').on('connect',()=>{console.log('ok');process.exit(0)})"
```

## Limpieza

```bash
kind delete cluster --name elvira-local
```

## Que NO esta aqui (Fase 4, no ahora)

- Sharding de Rack State / Grid Interlink para miles de nodos — el Raft plano de `rack-state.js` sirve para decenas/cientos de racks, no miles. Rediseno futuro, no tocar hasta que el volumen real lo exija.
- Ingress/TLS real — falta decidir dominio y certificados con el jefe.
- Metricas custom en el HPA (ej. "nodos BioHybrid conectados") — requiere Prometheus + adapter, y una fuente real de esa metrica que hoy no existe.
