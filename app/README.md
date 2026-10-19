# SYSTEMS · aplicación

Programa madre de S-NFI Corp.: un único servidor Node.js que sirve todas las mesas y el frontend. Doctrina, mesas y arquitectura: [docs/REFERENCIA.md](../docs/REFERENCIA.md).

## Estructura

```
app/
  backend/      Node.js + Express (ESM), un proceso en el puerto 5173
  frontend/     HTML/CSS/JS sin framework: pages/, js/, css/, vendor/ local
  assets-src/   Modelos 3D y logos de origen (no se despliegan)
  Dockerfile    Imagen única; compila también Rëff (Elvi-Ra/Mesas/Rëff)
```

## Arranque en local

```bash
cd app/backend
npm install
cp .env.example .env    # completar las variables obligatorias
npm run dev             # o npm start
```

Abre http://localhost:5173, que redirige a `/pages/login.html`. Rëff se sirve bajo `/reff` desde su `dist/`: antes de arrancar, ejecutar `npm run build` en `Elvi-Ra/Mesas/Rëff`.

## Configuración

Las variables de entorno están inventariadas y validadas en `app/backend/config.js`; `app/backend/.env.example` explica cada una. Al arrancar, el servidor valida el entorno y, en producción, no arranca si falta una obligatoria. Las contraseñas iniciales se definen con `SEED_*_PASSWORD` y solo se aplican cuando la base de datos está vacía.

## Pruebas

```bash
cd app/backend
npm test
```

Las pruebas que usan MongoDB se saltan si no hay `MONGO_URI`.

## Despliegue

- Contenedores: `docker-compose.yml` en la raíz, con la imagen de `app/Dockerfile`.
- Debian: [scripts/README-linux.md](../scripts/README-linux.md).
- Kubernetes: [k8s/README.md](../k8s/README.md).
