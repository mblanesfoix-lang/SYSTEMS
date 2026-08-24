// Gob Share: mapa mundi plano interactivo (proyeccion equirectangular), canvas 2D puro.
// Reemplaza al globo 3D (eliminado): mismo dato (gob-share-nodes.js), sin three.js.
// Solo los paises con nodo registrado tienen relleno/hover/click; el resto queda en blanco
// (contorno fino, sin relleno destacado), igual que la referencia de mapa mundi clasico.

import { GOB_SHARE_NODES_BY_WORLD_ATLAS_ID } from './gob-share-nodes.js';

function pointInRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect = (yi > lat) !== (yj > lat) &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInFeature(lng, lat, feature) {
  const polys = feature.geometry.type === 'Polygon'
    ? [feature.geometry.coordinates]
    : feature.geometry.coordinates;
  for (const polygon of polys) {
    if (polygon.length === 0) continue;
    if (!pointInRing(lng, lat, polygon[0])) continue;
    let inHole = false;
    for (let h = 1; h < polygon.length; h++) {
      if (pointInRing(lng, lat, polygon[h])) { inHole = true; break; }
    }
    if (!inHole) return true;
  }
  return false;
}

export function openNodePortal(node) {
  if (!node) return;
  const url = node.portal_registro_oficial && node.portal_registro_oficial.url;
  if (url) window.open(url, '_blank', 'noopener,noreferrer');
}

export async function mountGobShareMap(container, { tooltip, emptyBadge } = {}) {
  if (!container) return null;

  let worldAtlas;
  let geo;
  try {
    // topojson-client.min.js es UMD, cargado con <script src> clasico en gob-share.html
    // (fija window.topojson) — dynamic import() de un bundle sin export/import propios
    // del lenguaje de modulos falla de forma silenciosa, por eso no se usa aqui.
    if (!window.topojson) throw new Error('window.topojson no definido');
    worldAtlas = await fetch('/vendor/countries-110m.json').then((r) => r.json());
    geo = window.topojson.feature(worldAtlas, worldAtlas.objects.countries);
  } catch (err) {
    console.error('[gob-share] error al montar el mapa:', err);
    container.textContent = 'No se pudo cargar el mapa.';
    return null;
  }

  const canvas = document.createElement('canvas');
  canvas.style.position = 'absolute';
  canvas.style.inset = '0';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.display = 'block';
  container.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  let width = 0, height = 0, dpr = 1;

  // Proyeccion equirectangular simple: lng [-180,180] -> x [0,W], lat [90,-90] -> y [0,H].
  function project(lng, lat) {
    return [
      ((lng + 180) / 360) * width,
      ((90 - lat) / 180) * height,
    ];
  }
  function unproject(x, y) {
    return [
      (x / width) * 360 - 180,
      90 - (y / height) * 180,
    ];
  }

  let hovered = null;

  function draw() {
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#14171f';
    ctx.fillRect(0, 0, width, height);

    for (const f of geo.features) {
      const node = GOB_SHARE_NODES_BY_WORLD_ATLAS_ID[String(f.id)];
      const isHover = f === hovered;

      if (node) {
        ctx.fillStyle = isHover ? 'rgba(0, 168, 120, 0.55)' : 'rgba(0, 168, 120, 0.22)';
        ctx.strokeStyle = isHover ? 'rgba(95, 191, 158, 0.95)' : 'rgba(0, 168, 120, 0.75)';
        ctx.lineWidth = isHover ? 1.6 : 1.1;
      } else {
        // Paises sin nodo: en blanco, sin reaccion al hover (solo los registrados son interactivos).
        ctx.fillStyle = 'rgba(255,255,255,0.07)';
        ctx.strokeStyle = 'rgba(255,255,255,0.28)';
        ctx.lineWidth = 0.75;
      }

      const polygons = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
      for (const polygon of polygons) {
        for (const ring of polygon) {
          ctx.beginPath();
          ring.forEach(([lng, lat], i) => {
            const [x, y] = project(lng, lat);
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          });
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        }
      }
    }
  }

  function resize() {
    const rect = container.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = rect.width;
    height = rect.height;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(container);
  resize();

  function hitTest(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (x < 0 || y < 0 || x > width || y > height) return null;
    const [lng, lat] = unproject(x, y);
    for (const f of geo.features) {
      if (pointInFeature(lng, lat, f)) return f;
    }
    return null;
  }

  canvas.addEventListener('pointermove', (e) => {
    const feature = hitTest(e.clientX, e.clientY);
    if (feature !== hovered) {
      hovered = feature;
      draw();
    }
    if (feature) {
      const node = GOB_SHARE_NODES_BY_WORLD_ATLAS_ID[String(feature.id)];
      container.classList.toggle('hoverable', !!node);
      if (tooltip) {
        if (node) {
          tooltip.innerHTML = `<span class="gobshare-tooltip__country">${node.nombre_sistema} (${node.id_pais})</span>` +
            `<span class="gobshare-tooltip__service">${node.portal_registro_oficial.label}</span>` +
            `<span class="gobshare-tooltip__hint">clic para abrir →</span>`;
          tooltip.style.left = `${e.clientX + 14}px`;
          tooltip.style.top = `${e.clientY + 14}px`;
          tooltip.hidden = false;
        } else {
          tooltip.hidden = true;
        }
      }
    } else {
      container.classList.remove('hoverable');
      if (tooltip) tooltip.hidden = true;
    }
  });

  canvas.addEventListener('pointerleave', () => {
    if (hovered) { hovered = null; draw(); }
    container.classList.remove('hoverable');
    if (tooltip) tooltip.hidden = true;
  });

  canvas.addEventListener('click', (e) => {
    const feature = hitTest(e.clientX, e.clientY);
    if (!feature) return;
    const node = GOB_SHARE_NODES_BY_WORLD_ATLAS_ID[String(feature.id)];
    const url = node && node.portal_registro_oficial && node.portal_registro_oficial.url;
    if (url) {
      window.open(url, '_blank', 'noopener,noreferrer');
    } else if (emptyBadge) {
      emptyBadge.hidden = false;
      clearTimeout(emptyBadge._hideTimer);
      emptyBadge._hideTimer = setTimeout(() => { emptyBadge.hidden = true; }, 1800);
    }
  });

  return {
    dispose() {
      resizeObserver.disconnect();
      if (container.contains(canvas)) container.removeChild(canvas);
    },
  };
}
