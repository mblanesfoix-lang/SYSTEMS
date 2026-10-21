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

command -v openssl >/dev/null || { echo "Falta openssl: hace falta para generar las claves." >&2; exit 1; }

# Sustituye NOMBRE=... si la linea existe; si no, la anade al final.
set_env() {
  if grep -q "^$1=" "$ENV_FILE"; then
    sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"
  fi
}

cp "$ROOT_DIR/app/backend/.env.example" "$ENV_FILE"
chmod 600 "$ENV_FILE"

# Claves propias de esta instalacion. Si se van a migrar datos de otro sistema,
# SENTINEL_FORENSIC_SECRET, FL_EXPEDIENTE_ENC_KEY y PACTVM_DATA_KEY deben ser las del origen.
for name in JWT_SECRET SENTINEL_FORENSIC_SECRET FL_EXPEDIENTE_ENC_KEY PACTVM_DATA_KEY; do
  set_env "$name" "$(openssl rand -hex 32)"
done
set_env CORS_ORIGIN "http://127.0.0.1:5173"

echo "Archivo de entorno creado en $ENV_FILE con las claves obligatorias generadas."
echo "Antes del primer arranque, rellena las contrasenas iniciales (SEED_*_PASSWORD y REFF_SEED_*_PASSWORD) y las opciones que uses (ver comentarios del archivo)."
