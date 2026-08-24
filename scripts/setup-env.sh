#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# .env en la RAIZ: docker compose interpola ${VAR} desde el .env del directorio
# del proyecto. Para la opcion sin Docker, server.js tambien acepta app/backend/.env.
ENV_FILE="$ROOT_DIR/.env"

if [[ -f "$ENV_FILE" ]]; then
  echo "$ENV_FILE ya existe; no se modifica."
  exit 0
fi

cp "$ROOT_DIR/app/backend/.env.example" "$ENV_FILE"

# Generar el secreto AHORA (un heredoc entre comillas no ejecuta comandos)
JWT_SECRET_VALUE="$(openssl rand -hex 32 2>/dev/null || echo "change-me-$(date +%s)")"
{
  echo ""
  echo "# Ajustes recomendados para VM Debian / Linux"
  echo "JWT_SECRET=$JWT_SECRET_VALUE"
  echo "CORS_ORIGIN=http://127.0.0.1:5173"
} >> "$ENV_FILE"
chmod 600 "$ENV_FILE"

echo "Archivo de entorno creado en $ENV_FILE"
echo "Edita los valores (ANTHROPIC_API_KEY, ESIOS_API_KEY, SEED_*_PASSWORD, REFF_SEED_*_PASSWORD) antes de arrancar."
