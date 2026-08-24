# Elvi-Ra · Boceto v0.1

Plataforma interna S-NFI Corp. Boceto inicial: Login + Dashboard + Rëff.

## Estructura

```
app/
  backend/        Node.js + Express (auth + customers JSON store)
  frontend/
    css/theme.css     Estética Brizna + Apple + Palantir
    js/api.js         Cliente fetch + sesión
    pages/
      login.html
      dashboard.html
```

## Arranque

```bash
cd app/backend
npm install
npm start
```

Abre http://localhost:5173 → redirige a `/pages/login.html`.

## Credenciales

Seed inicial via variables de entorno `SEED_MARC_PASSWORD`, `SEED_NOUR_PASSWORD`, etc.
Ver `app/backend/.env.example`. Tras primer arranque, hashes viven en `data/users.json`.

## Notas

- Sesión vía token en memoria (8h). Para producción: JWT + DB.
- `customers.json` es por usuario; cada cuenta opera su propia hoja.
- Otras mesas (S-NFI U2, Observer) integradas en el mismo backend/puerto.
