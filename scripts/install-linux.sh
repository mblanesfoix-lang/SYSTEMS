#!/usr/bin/env bash
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Ejecuta este script como root: sudo bash scripts/install-linux.sh" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y ca-certificates curl gnupg lsb-release git ufw

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

systemctl enable --now docker
usermod -aG docker "$SUDO_USER"

ufw --force enable
ufw allow 22/tcp
ufw allow 5173/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw reload

echo "Instalación completada."
echo "Haz login/logout para que el usuario entre en el grupo docker."
echo "Luego ejecuta: sudo docker compose up -d --build"
