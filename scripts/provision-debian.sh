#!/usr/bin/env bash
# ============================================================================
# ELVI-RA · Provisioning idempotente para VM Debian limpia (VMware o Hetzner)
#
# Deja la maquina con: Docker + Compose v2, repo en /opt/elvi-ra, .env con
# JWT_SECRET generado, firewall UFW, servicio systemd y healthcheck final.
# Se puede re-ejecutar tantas veces como haga falta: cada paso comprueba su
# estado antes de actuar.
#
# Uso:
#   sudo bash scripts/provision-debian.sh                  # desde un checkout del repo
#   sudo REPO_URL=git@github.com:org/elvi-ra.git bash provision-debian.sh
#
# Variables opcionales:
#   REPO_URL   — origen git si la VM aun no tiene el codigo
#   APP_DIR    — destino de instalacion (default /opt/elvi-ra)
#   BRANCH     — rama a desplegar (default master)
#   SKIP_UFW=1 — no tocar firewall (p.ej. Hetzner con firewall externo)
# ============================================================================
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/elvi-ra}"
BRANCH="${BRANCH:-master}"
REPO_URL="${REPO_URL:-}"

log()  { printf '\033[1;32m[provision]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[provision]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[provision]\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Ejecutar como root: sudo bash scripts/provision-debian.sh"
export DEBIAN_FRONTEND=noninteractive

# ── 1. Paquetes base ─────────────────────────────────────────────────────────
log "Paquetes base (apt)"
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git ufw openssl rsync >/dev/null

# ── 2. Docker + Compose v2 (solo si falta) ───────────────────────────────────
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  log "Docker + Compose ya instalados: $(docker --version)"
else
  log "Instalando Docker CE + Compose plugin"
  install -m 0755 -d /etc/apt/keyrings
  if [[ ! -f /etc/apt/keyrings/docker.gpg ]]; then
    curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
  fi
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
fi
systemctl enable --now docker

# Grupo docker para el usuario que invoco sudo (si existe)
if [[ -n "${SUDO_USER:-}" && "${SUDO_USER:-}" != "root" ]]; then
  usermod -aG docker "$SUDO_USER" || true
fi

# ── 3. Firewall UFW (idempotente: allow repetido no falla) ───────────────────
if [[ "${SKIP_UFW:-0}" != "1" ]]; then
  log "Firewall UFW: 22 (ssh), 5173 (Elvi-Ra), 80/443 (proxy opcional)"
  ufw allow 22/tcp >/dev/null
  ufw allow 5173/tcp >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw --force enable >/dev/null
else
  warn "SKIP_UFW=1 — firewall sin tocar"
fi

# ── 4. Codigo en APP_DIR: pull, clone o copia local ──────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_REPO="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ -d "$APP_DIR/.git" ]]; then
  log "Repo existente en $APP_DIR — git pull --ff-only ($BRANCH)"
  git -C "$APP_DIR" fetch origin "$BRANCH"
  git -C "$APP_DIR" checkout "$BRANCH"
  git -C "$APP_DIR" pull --ff-only origin "$BRANCH"
elif [[ -n "$REPO_URL" ]]; then
  log "Clonando $REPO_URL → $APP_DIR"
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
elif [[ -f "$LOCAL_REPO/docker-compose.yml" && "$LOCAL_REPO" != "$APP_DIR" ]]; then
  log "Sin REPO_URL — copiando checkout local $LOCAL_REPO → $APP_DIR"
  mkdir -p "$APP_DIR"
  rsync -a --delete --exclude node_modules --exclude .git --exclude 'app/backend/data' \
    "$LOCAL_REPO/" "$APP_DIR/"
elif [[ "$LOCAL_REPO" == "$APP_DIR" ]]; then
  log "Ejecutando desde $APP_DIR — sin copia"
else
  die "No hay codigo: define REPO_URL o ejecuta el script desde un checkout del repo"
fi

# ── 5. Entorno (.env en la RAIZ del compose) con JWT_SECRET real generado ────
# docker compose interpola ${VAR} desde el .env del directorio del proyecto
# (APP_DIR), no desde app/backend/.env — el archivo debe vivir en la raiz.
ENV_FILE="$APP_DIR/.env"
LEGACY_ENV="$APP_DIR/app/backend/.env"
if [[ -f "$ENV_FILE" ]]; then
  log ".env raiz ya existe — no se modifica"
elif [[ -f "$LEGACY_ENV" ]]; then
  log "Migrando $LEGACY_ENV → $ENV_FILE (compose solo lee el .env raiz)"
  cp "$LEGACY_ENV" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
else
  log "Creando $ENV_FILE desde app/backend/.env.example"
  cp "$APP_DIR/app/backend/.env.example" "$ENV_FILE"
  JWT_SECRET_VALUE="$(openssl rand -hex 32)"
  {
    echo ""
    echo "# Generado por provision-debian.sh $(date -u +%FT%TZ)"
    echo "JWT_SECRET=$JWT_SECRET_VALUE"
    echo "NODE_ENV=production"
  } >> "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  warn "EDITA $ENV_FILE: ANTHROPIC_API_KEY, ESIOS_API_KEY, CORS_ORIGIN, SEED_*_PASSWORD y REFF_SEED_*_PASSWORD"
fi

# ── 6. Servicio systemd ──────────────────────────────────────────────────────
log "Servicio systemd elvira.service"
sed "s|WorkingDirectory=.*|WorkingDirectory=$APP_DIR|" \
  "$APP_DIR/scripts/elvira.service" > /etc/systemd/system/elvira.service
systemctl daemon-reload
systemctl enable elvira.service >/dev/null

# ── 7. Build + arranque ──────────────────────────────────────────────────────
log "docker compose build (primera vez tarda varios minutos)"
docker compose -f "$APP_DIR/docker-compose.yml" --project-directory "$APP_DIR" build
log "Arrancando stack via systemd"
systemctl restart elvira.service

# ── 8. Healthcheck ───────────────────────────────────────────────────────────
log "Esperando health de Elvi-Ra (max 180s)"
for i in $(seq 1 36); do
  if curl -fsS http://127.0.0.1:5173/api/reff-health >/dev/null 2>&1; then
    log "OK — Elvi-Ra responde en http://$(hostname -I 2>/dev/null | awk '{print $1}'):5173"
    exit 0
  fi
  sleep 5
done
warn "Sin respuesta tras 180s. Diagnostico:"
warn "  systemctl status elvira --no-pager"
warn "  docker compose -f $APP_DIR/docker-compose.yml logs --tail 50 elvira"
exit 1
