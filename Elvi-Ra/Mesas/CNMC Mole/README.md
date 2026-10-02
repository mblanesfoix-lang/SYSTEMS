# ØPHS Framework — ESIOS Energy Waste Connector

Módulo Python para integrar datos de **energía desperdiciada** (vertido a red a precio 0€)
del sistema eléctrico español en el ØPHS Framework, vía la API oficial de Red Eléctrica (ESIOS).

-----

## 📁 Estructura

```
ophs_esios/
├── esios_connector.py   ← Módulo principal (importar en OPHS)
├── cron_daily.py        ← Script de actualización diaria automática
├── .env.example         ← Plantilla de variables de entorno
└── README.md
```

-----

## 🔑 Paso 1 — Obtener el token de ESIOS

1. Ve a **<https://api.esios.ree.es/>**
1. Haz clic en **“Personal token request”**
1. O envía un email directamente a: **[consultasios@ree.es](mailto:consultasios@ree.es)**
- Asunto: `Solicitud de token API ESIOS`
- Cuerpo: nombre, empresa/proyecto, uso previsto
1. Recibirás el token en 24-48h

-----

## ⚙️ Paso 2 — Instalación

```bash
# Instalar dependencias
pip install requests pandas python-dotenv

# Copiar y configurar variables de entorno
cp .env.example .env
nano .env   # Pegar el token recibido
```

-----

## 🚀 Paso 3 — Uso

### Ejecución directa (test)

```bash
# Análisis del año 2025 (pico histórico ~5.000 GWh)
python esios_connector.py 2025

# Año actual
python esios_connector.py 2026
```

### Integración en ØPHS Framework (Python)

```python
from ophs_esios.esios_connector import (
    calcular_desperdicio_diario,
    calcular_desperdicio_anual,
    actualizar_hoy,
)

# Resumen anual completo
resumen_2025 = calcular_desperdicio_anual(2025)
print(resumen_2025["total_gwh_desperdiciados"])  # ~5000 GWh

# Datos diarios de un rango
df = calcular_desperdicio_diario("2025-06-01", "2025-08-31")
# df tiene columnas: fecha | horas_precio_cero | exceso_gwh | generacion_gwh | demanda_gwh

# Actualizar con datos de ayer (para cron diario)
datos_ayer = actualizar_hoy(output_dir="./data")
```

-----

## ⏱️ Paso 4 — Automatización diaria (cron Linux)

```bash
crontab -e
```

Añadir esta línea (ejecuta a las 8:00 cada día):

```
0 8 * * * /usr/bin/python3 /ruta/completa/ophs_esios/cron_daily.py >> /var/log/ophs_esios.log 2>&1
```

-----

## 📊 Indicadores ESIOS utilizados

|ID  |Descripción                       |
|----|----------------------------------|
|1293|Precio mercado spot (€/MWh)       |
|460 |Generación total del sistema (MW) |
|1775|Demanda real del sistema (MW)     |
|1161|Generación solar fotovoltaica (MW)|
|1159|Generación eólica (MW)            |

-----

## 📤 Outputs generados

|Archivo                           |Contenido                           |
|----------------------------------|------------------------------------|
|`data/desperdicio_diario.csv`     |Serie temporal diaria acumulativa   |
|`data/desperdicio_diario_YYYY.csv`|CSV anual con detalle por día       |
|`data/resumen_YYYY.json`          |Métricas anuales + comparativa hist.|

-----

## 🔢 Referencia histórica

|Año     |GWh Desperdiciados|Horas precio 0€|
|--------|------------------|---------------|
|2023    |~2.100            |~400           |
|2024    |~3.600            |~620           |
|**2025**|**~5.000**        |**~800**       |
|2026    |En curso          |—              |


> Fuente: Red Eléctrica de España / OMIE

-----

## ❓ Soporte

- API ESIOS: <https://api.esios.ree.es/>
- Documentación indicadores: <https://www.esios.ree.es/es/analisis>
- Contacto REE: [consultasios@ree.es](mailto:consultasios@ree.es)