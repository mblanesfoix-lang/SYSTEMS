# Build context: raíz del repo (necesita app/ y Elvi-Ra/Mesas/Rëff/)
# docker build -f app/Dockerfile -t elvi-ra .
# docker run -p 5173:5173 -v elvi-ra-data:/app/backend/data --env-file .env elvi-ra
# Variables: app/backend/.env.example. El servidor las valida al arrancar y, si
# falta una obligatoria, no arranca y las lista todas.

# ── Stage 1: backend principal — instala deps nativas en Linux ────────────────
# node:20 fuera de soporte desde 2026-04-30 (EOL, nodejs.org/en/about/previous-releases);
# 22 es LTS activo (mantenimiento hasta 2027-10). engines.node del package.json (">=20")
# sigue como piso minimo compatible, no como version objetivo de la imagen.
FROM node:22-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY app/backend/package.json app/backend/package-lock.json* ./
RUN npm ci

# ── Stage 2: Rëff — build cliente (Vite) + servidor (tsc) ──────────────────────
FROM node:22-slim AS reff-builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY "Elvi-Ra/Mesas/Rëff/package.json" "Elvi-Ra/Mesas/Rëff/package-lock.json*" ./
RUN npm ci
COPY "Elvi-Ra/Mesas/Rëff/" ./
RUN npm run build

# ── Stage 3: runtime ────────────────────────────────────────────────────────
FROM node:22-slim AS runner

WORKDIR /app

COPY --from=builder /build/node_modules ./backend/node_modules
COPY app/backend/ ./backend/
COPY app/frontend/ ./frontend/

COPY --from=reff-builder /build/dist /Elvi-Ra/Mesas/Rëff/dist
COPY --from=reff-builder /build/node_modules /Elvi-Ra/Mesas/Rëff/node_modules

RUN mkdir -p /app/backend/data
VOLUME ["/app/backend/data"]

# FASE 6/7 (2026-09-20): sin USER, el proceso corria como root (default de
# node:slim) — imagen no privilegiada, coherente con securityContext
# runAsNonRoot en k8s/04-elvira-core.yaml. uid/gid fijos (no "node" del
# stage base, que puede no existir igual en runner tras el COPY --from)
# para que el propietario del volumen de datos sea predecible entre
# reinicios/redeploys.
RUN groupadd -g 10001 elvira && useradd -u 10001 -g elvira -M -s /usr/sbin/nologin elvira \
    && chown -R elvira:elvira /app
USER elvira:elvira

ENV NODE_ENV=production
ENV PORT=5173
# --max-old-space-size explicito: la deteccion automatica de V8 sobre el
# limite de memoria del cgroup no siempre es fiable en todos los runtimes de
# contenedor: mejor ceiling explicito, coherente con el limits.memory del
# manifest k8s (1536Mi) y con el memory de docker-compose — deja margen para
# stacks nativos/buffers fuera del heap de V8 (GridFS, worker threads U2/Grid).
ENV NODE_OPTIONS="--max-old-space-size=1200"

EXPOSE 5173

WORKDIR /app/backend
CMD ["node", "server.js"]
