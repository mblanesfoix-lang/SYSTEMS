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

El archivo vive en la raiz del proyecto (`/opt/elvi-ra/.env`): docker compose interpola sus variables desde ahi.

Variables mínimas:
- ANTHROPIC_API_KEY (u `LLM_PROVIDER=ollama`)
- JWT_SECRET
- SEED_MARC/NOUR/RAY/AMIR/GONZALO_PASSWORD (primer arranque: sin ellas no hay usuarios)
- REFF_SEED_MARC/NOUR/AMIR/GONZALO_PASSWORD (usuarios Rëff)
- ESIOS_API_KEY (opcional)
- NODE_ENV=production
- CORS_ORIGIN=http://IP:5173

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
