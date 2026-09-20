# K8s local — SYSTEMS / Elvi-Ra (Fase 1)

Manifests para probar el salto a k8s en local antes de tocar produccion (Coolify/Hetzner sigue siendo el despliegue real hoy, ver CLAUDE.md "Infraestructura de despliegue").

**Estado de validacion**: sintaxis YAML comprobada a mano (sin tabs, docs bien separados). NO se ha ejecutado `kubectl apply --dry-run=client` contra un API server real — este entorno no tiene `kubectl`/`kind`/`docker` instalados. Validar con el comando de la Fase 1 abajo antes de dar por buenos los manifests.

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

## Activar OPHS cuando llegue el hardware

```bash
kubectl -n elvira scale deployment/ophs --replicas=2
```

Antes de escalar: revisar `05-ophs.yaml` para actualizar `SYSTEMS_URL` con el puerto real que de el jefe, y confirmar si OPHS sigue viviendo en el mismo `server.js` monolito o pasa a proceso propio (si pasa a proceso propio, `/api/ophs/readyz` en `server.js` debe moverse a ese proceso y comprobar conexion a Systems real, no solo Mongo — ver comentario en el propio manifest).

## Limpieza

```bash
kind delete cluster --name elvira-local
```

## Que NO esta aqui (Fase 4, no ahora)

- Sharding de Rack State / Grid Interlink para miles de nodos — el Raft plano de `rack-state.js` sirve para decenas/cientos de racks, no miles. Rediseno futuro, no tocar hasta que el volumen real lo exija.
- Ingress/TLS real — falta decidir dominio y certificados con el jefe.
- Metricas custom en el HPA (ej. "nodos BioHybrid conectados") — requiere Prometheus + adapter, y una fuente real de esa metrica que hoy no existe.
