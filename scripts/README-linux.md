# Preparación para Debian / VMware / Linux

## Objetivo

Este paquete deja el proyecto preparado para desplegarse en una máquina Debian o Ubuntu sobre VMware, con Docker Compose y un servicio de sistema Linux.

## 1. Instalar dependencias

```bash
sudo bash scripts/install-linux.sh
```

## 2. Copiar el repositorio al host

```bash
sudo mkdir -p /opt/elvi-ra
sudo cp -r . /opt/elvi-ra/
cd /opt/elvi-ra
```

## 3. Preparar variables de entorno

```bash
bash scripts/setup-env.sh
nano .env
```

El archivo vive en la raiz del proyecto (`/opt/elvi-ra/.env`): docker compose interpola sus variables desde ahi. `setup-env.sh` lo crea a partir de `app/backend/.env.example` y genera las claves obligatorias (`JWT_SECRET`, `SENTINEL_FORENSIC_SECRET` y `FL_EXPEDIENTE_ENC_KEY`).

Antes del primer arranque hay que completar:
- Contraseñas iniciales `SEED_*_PASSWORD` y `REFF_SEED_*_PASSWORD`: sin ellas no se crean usuarios.
- `CORS_ORIGIN` con la dirección desde la que se accede (por defecto `http://127.0.0.1:5173`).
- Proveedor de IA: la clave del proveedor configurado, o `LLM_PROVIDER=ollama` con `OLLAMA_URL` y `OLLAMA_MODEL`. Los nombres exactos de cada variable están en `app/backend/config.js`.
- `ESIOS_API_KEY` (opcional).

`NODE_ENV` ya queda en `production` y `MONGO_URI` apunta al servicio `mongo` de `docker-compose.yml`. La lista completa de variables, con su explicación, está en `app/backend/.env.example`.

Para una maquina limpia, `scripts/provision-debian.sh` hace los pasos 1 a 4 de forma idempotente.

## 4. Instalar servicio systemd

```bash
sudo cp scripts/elvira.service /etc/systemd/system/elvira.service
sudo systemctl daemon-reload
sudo systemctl enable --now elvira
```

## 5. Opcional: proxy Nginx

Si quieres exponerlo con HTTP simple y luego añadir HTTPS, instala Nginx y usa la plantilla:

```bash
sudo apt-get install -y nginx
sudo cp scripts/nginx-elvira.conf /etc/nginx/conf.d/elvira.conf
sudo nginx -t
sudo systemctl reload nginx
```

## 6. Verificar

```bash
sudo systemctl status elvira
sudo docker compose ps
curl http://127.0.0.1:5173/api/health
```

## Puertos

- 5173: Elvi-Ra
- 80/443: si se usa proxy inverso
- 5174: reservado para Twin, no expuesto por defecto
