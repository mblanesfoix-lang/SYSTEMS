/**
 * Motor 3D del globo VDR (Pactvm Viridi).
 *
 * Extraido de pactvm-vdr-globe.html para que la vista autenticada y la vista
 * de invitado (enlace temporal bajo NDA) compartan UNA sola implementacion:
 * cualquier correccion del render vale para ambas sin duplicar codigo.
 *
 * No conoce el DOM de la pagina salvo el contenedor que se le pasa, ni la
 * autenticacion: recibe el payload ya resuelto del backend y devuelve una
 * API de control (encuadre, foco, conmutar nodos, captura para PDF).
 */
import * as THREE from '/vendor/three.module.min.js';

// lat/lng -> vector en la esfera (radio r). Formula alineada con la UV
// de THREE.SphereGeometry (u=(lng+180)/360, v=(90-lat)/180) — ver
// buildEarthTexture, misma proyeccion para textura y marcadores.
function latLngToVec3(lat, lng, r) {
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lng + 180) * (Math.PI / 180);
  return new THREE.Vector3(
    -r * Math.sin(phi) * Math.cos(theta),
    r * Math.cos(phi),
    r * Math.sin(phi) * Math.sin(theta),
  );
}

function lerp(a, b, t) { return a + (b - a) * t; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function glowSprite(colorInner, colorOuter, size) {
  const s = 128;
  const canvas = document.createElement('canvas');
  canvas.width = s; canvas.height = s;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grad.addColorStop(0, colorInner);
  grad.addColorStop(0.35, colorOuter);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(size, size, 1);
  return sprite;
}

function starSprite(size) {
  const s = 128;
  const canvas = document.createElement('canvas');
  canvas.width = s; canvas.height = s;
  const ctx = canvas.getContext('2d');
  const cx = s / 2, cy = s / 2;
  const spikes = 5, outerR = s * 0.34, innerR = outerR * 0.42;
  ctx.beginPath();
  for (let i = 0; i < spikes * 2; i++) {
    const r = i % 2 === 0 ? outerR : innerR;
    const a = (Math.PI / spikes) * i - Math.PI / 2;
    const x = cx + r * Math.cos(a), y = cy + r * Math.sin(a);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, s * 0.5);
  halo.addColorStop(0, 'rgba(255,216,115,0.55)');
  halo.addColorStop(1, 'rgba(255,216,115,0)');
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, s, s);
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, outerR * 1.3);
  grad.addColorStop(0, '#fffbe8');
  grad.addColorStop(0.45, '#ffd873');
  grad.addColorStop(1, 'rgba(255,216,115,0)');
  ctx.fillStyle = grad;
  ctx.fill();
  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(size, size, 1);
  return sprite;
}

// Textura equirectangular real: paises del vendor countries-110m.json
// (topojson-client.min.js, mismo dataset que pactvm-nodos.html), pintados
// con estetica "consola soberana" — tierra oscura con borde neon tenue,
// oceano casi negro con vignette sutil, graticula fina. Proyeccion
// identica a latLngToVec3 para que los marcadores caigan sobre el pais
// correcto.
// alpha-2 -> ISO 3166-1 numeric, solo los paises que VDR_COUNTRY_COORDS
// conoce en el backend (pactum-viridi.js). El dataset countries-110m.json
// indexa por el codigo numerico como string.
const VDR_ISO_A2_TO_NUMERIC = {
  ES: '724', PT: '620', FR: '250', MA: '504', MX: '484',
  DE: '276', US: '840', GB: '826', IT: '380', BR: '076',
  DZ: '012',
};

async function buildEarthTexture(renderer, highlightCountryCode) {
  // Resolucion adaptada al hardware: 8K si la GPU lo admite, 4K si no.
  // Sin el tope la textura falla en silencio (negro) en equipos modestos.
  const maxTex = renderer ? renderer.capabilities.maxTextureSize : 4096;
  const w = maxTex >= 8192 ? 8192 : 4096;
  const h = w / 2;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  // Todo el trazado esta calibrado a 4096: con textura 8K se escala para
  // que los grosores de costa y graticula se mantengan proporcionales.
  const k = w / 4096;

  // --- oceano: batimetria en verde abisal (mas profundo/oscuro en el
  // ecuador, mas claro hacia los polos) + veladura polar de hielo ---
  const ocean = ctx.createLinearGradient(0, 0, 0, h);
  ocean.addColorStop(0.00, '#0b3b39');
  ocean.addColorStop(0.13, '#082f2f');
  ocean.addColorStop(0.32, '#052322');
  ocean.addColorStop(0.50, '#041c1b');
  ocean.addColorStop(0.68, '#052322');
  ocean.addColorStop(0.87, '#082f2f');
  ocean.addColorStop(1.00, '#0b3b39');
  ctx.fillStyle = ocean;
  ctx.fillRect(0, 0, w, h);

  const proj = ([lon, lat]) => [(lon + 180) * (w / 360), (90 - lat) * (h / 180)];
  function pathFromGeometry(geom) {
    const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : null;
    if (!polys) return null;
    const path = new Path2D();
    polys.forEach((poly) => {
      poly.forEach((ring) => {
        ring.forEach(([lon, lat], i) => {
          const [x, y] = proj([lon, lat]);
          if (i === 0) path.moveTo(x, y); else path.lineTo(x, y);
        });
        path.closePath();
      });
    });
    return path;
  }

  try {
    const topology = await fetch('/vendor/countries-110m.json').then((r) => r.json());
    const geo = topojson.feature(topology, topology.objects.countries);
    const paths = geo.features.map((f) => ({ id: String(f.id), path: pathFromGeometry(f.geometry) })).filter((p) => p.path);

    // 1) halo de plataforma continental: aguas someras alrededor de la
    //    costa. Se consigue trazando el contorno muy grueso por debajo
    //    de la tierra, en un azul mas claro.
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = '#126a5e'; // teal de plataforma continental
    ctx.lineJoin = 'round';
    ctx.lineWidth = 16 * k;
    paths.forEach(({ path }) => ctx.stroke(path));
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = '#1a8c75';
    ctx.lineWidth = 7 * k;
    paths.forEach(({ path }) => ctx.stroke(path));
    ctx.restore();

    // 2) masa continental: verde-oliva terroso con gradiente latitudinal
    //    (tundra fria arriba, arido/desierto en la franja subtropical,
    //    templado en medio) — lectura realista sin textura fotografica.
    const land = ctx.createLinearGradient(0, 0, 0, h);
    land.addColorStop(0.00, '#cfe0d8'); // casquete polar norte
    land.addColorStop(0.08, '#8fb09b');
    land.addColorStop(0.18, '#3f7a58'); // boreal
    land.addColorStop(0.30, '#2f6b49');
    land.addColorStop(0.38, '#5c8a58'); // franja seca norte, en verde salvia
    land.addColorStop(0.46, '#78a06a');
    land.addColorStop(0.52, '#256b42'); // franja ecuatorial, verde profundo
    land.addColorStop(0.62, '#2f7a4d');
    land.addColorStop(0.72, '#649066'); // arido sur
    land.addColorStop(0.84, '#4c8462');
    land.addColorStop(0.93, '#a8c4b6');
    land.addColorStop(1.00, '#dcebe3'); // casquete polar sur
    ctx.fillStyle = land;
    paths.forEach(({ path }) => ctx.fill(path));

    // 3) relieve sutil: sombra interior desplazada, da volumen a la
    //    tierra sin necesitar un mapa de alturas real.
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha = 0.20;
    ctx.translate(-2.5 * k, -2.5 * k);
    ctx.fillStyle = '#10291d';
    paths.forEach(({ path }) => ctx.fill(path));
    ctx.restore();

    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = 0.13;
    ctx.translate(2.5 * k, 2.5 * k);
    ctx.fillStyle = '#b6e8c4';
    paths.forEach(({ path }) => ctx.fill(path));
    ctx.restore();

    // 4) linea de costa nitida: define la silueta de cada pais
    ctx.strokeStyle = 'rgba(168,248,214,0.62)';
    ctx.lineWidth = 1.6 * k;
    ctx.lineJoin = 'round';
    paths.forEach(({ path }) => ctx.stroke(path));

    // 5) frontera interior mas tenue, para distinguir paises vecinos
    ctx.strokeStyle = 'rgba(214,255,236,0.16)';
    ctx.lineWidth = 0.8 * k;
    paths.forEach(({ path }) => ctx.stroke(path));

    // 6) realce de pais en juego: el pais de la sede de la empresa, que es
    //    donde vive el cluster de nodos (antes España fija siempre, ver
    //    docs/ESTADO-HISTORICO.md — el cluster ahora sigue a la empresa).
    const highlightNumeric = VDR_ISO_A2_TO_NUMERIC[highlightCountryCode];
    const HIGHLIGHT = {};
    const HIGHLIGHT_EDGE = {};
    if (highlightNumeric) {
      HIGHLIGHT[highlightNumeric] = 'rgba(255,91,82,0.30)';
      HIGHLIGHT_EDGE[highlightNumeric] = 'rgba(255,120,110,0.95)';
    }
    paths.forEach(({ id, path }) => {
      if (!HIGHLIGHT[id]) return;
      ctx.fillStyle = HIGHLIGHT[id];
      ctx.fill(path);
      ctx.strokeStyle = HIGHLIGHT_EDGE[id];
      ctx.lineWidth = 3.2 * k;
      ctx.stroke(path);
    });
  } catch {
    // sin dataset vendored: se deja solo el oceano, sin formas inventadas.
  }

  // graticula muy tenue, referencia de orientacion sin ensuciar
  ctx.strokeStyle = 'rgba(190,255,225,0.04)';
  ctx.lineWidth = 1 * k;
  for (let i = 0; i <= 24; i++) {
    const x = (w / 24) * i;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }
  for (let i = 0; i <= 12; i++) {
    const y = (h / 12) * i;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer ? renderer.capabilities.getMaxAnisotropy() : 8;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  return tex;
}

// Textura de "chapa" neon para los cilindros de nodo: franjas horizontales
// sutiles, transmite "unidad industrial" sin depender de shaders complejos.
// colorHex parametriza rojo (pendiente) / verde (instalado simulado).
function buildCylinderTexture(colorTop, colorMid, colorBottom) {
  const w = 32, h = 128;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, colorTop);
  grad.addColorStop(0.5, colorMid);
  grad.addColorStop(1, colorBottom);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  ctx.lineWidth = 1.5;
  for (let y = 0; y < h; y += 10) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 1);
  return tex;
}

/**
 * @param {object} data      payload de /globe (star, esCurtailment, ...)
 * @param {object} opts
 *   container   elemento donde montar el canvas (o su id)
 *   onMarkerClick(hit)  hit = {kind:'star'|'node'|'cluster', index?}
 *   isStarCardVisible() -> bool, para reposicionar la tarjeta anclada
 *   onStarProject(p)    recibe {x,y,visible} en cada frame
 */
async function initGlobe(data, opts = {}) {
  const wrap = typeof opts.container === 'string'
    ? document.getElementById(opts.container)
    : (opts.container || document.getElementById('vdrStage'));
  const onMarkerClick = opts.onMarkerClick || (() => {});
  const isStarCardVisible = opts.isStarCardVisible || (() => false);
  const onStarProject = opts.onStarProject || (() => {});
  let width = wrap.clientWidth, height = wrap.clientHeight;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, width / height, 0.01, 200);
  let camDistance = 7.5;
  camera.position.set(0, 0, camDistance);

  const renderer = new THREE.WebGLRenderer({
    antialias: true, alpha: true, preserveDrawingBuffer: true,
    powerPreference: 'high-performance',
  });
  // pixelRatio hasta 3: en pantallas retina el mapa se lee sin dentado
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 3));
  renderer.setSize(width, height);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  wrap.appendChild(renderer.domElement);

  const globeRadius = 2.4;
  let disposed = false; // lo consultan animate() y dispose()
  const earthTexture = await buildEarthTexture(renderer, data.star?.countryCode);
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(globeRadius, 160, 160),
    new THREE.MeshPhongMaterial({
      map: earthTexture,
      shininess: 22,
      specular: 0x1d5c4c, // brillo especular con tinte esmeralda
    }),
  );
  scene.add(sphere);

  // halo atmosferico: fresnel aproximado, BackSide + additive, estetico puro
  const atmosphere = new THREE.Mesh(
    new THREE.SphereGeometry(globeRadius * 1.035, 64, 64),
    new THREE.ShaderMaterial({
      uniforms: { glowColor: { value: new THREE.Color(0x2fe0a0) } },
      vertexShader: `
        varying float intensity;
        void main() {
          vec3 vNormal = normalize(normalMatrix * normal);
          intensity = pow(0.58 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 3.6) * 0.85;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying float intensity;
        uniform vec3 glowColor;
        void main() { gl_FragColor = vec4(glowColor, clamp(intensity, 0.0, 1.0)); }
      `,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    }),
  );
  scene.add(atmosphere);

  // estrellas de fondo — capa estatica, puramente ambiental
  const starField = (() => {
    const count = 900;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const r = 40 + Math.random() * 20;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      positions[i * 3 + 2] = r * Math.cos(phi);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({ color: 0xc6e8dc, size: 0.045, transparent: true, opacity: 0.55, sizeAttenuation: true });
    return new THREE.Points(geo, mat);
  })();
  scene.add(starField);

  // Iluminacion de tres puntos: sol calido dominante, relleno frio para
  // que la cara en sombra no se pierda en negro, y contraluz azul que
  // recorta la silueta del planeta contra el fondo.
  scene.add(new THREE.AmbientLight(0xeafff6, 0.40));
  const dirLight = new THREE.DirectionalLight(0xfff6e8, 1.45);
  dirLight.position.set(5, 2.5, 4.5);
  scene.add(dirLight);
  const fillLight = new THREE.DirectionalLight(0x5fa88f, 0.44);
  fillLight.position.set(-4, 1, 3);
  scene.add(fillLight);
  const rimLight = new THREE.DirectionalLight(0x2fe0a0, 0.75);
  rimLight.position.set(-5, -2, -4);
  scene.add(rimLight);

  const markerGroup = new THREE.Group();
  sphere.add(markerGroup);

  // ---- estrella: sede de la empresa ----
  // Escala quirurgica, igual que el cluster: la estrella marca una
  // CIUDAD, asi que su tamaño se expresa en grados de arco (~1.5°-2.6°
  // segun el peso) y no en unidades sueltas. Un mastil fino la ancla a
  // la coordenada exacta para que se vea que apunta a un punto concreto.
  let starPos = null;
  let starMesh = null;
  let starAnchor = null;
  if (data.star) {
    const degToUnitsStar = globeRadius * (Math.PI / 180);
    const weight = Math.max(0, Number(data.star.weight) || 0);
    const starSizeDeg = 1.5 + Math.min(1, weight / 50) * 1.1;
    const starSize = starSizeDeg * degToUnitsStar;
    const surfacePos = latLngToVec3(data.star.lat, data.star.lng, globeRadius);
    const starNormal = surfacePos.clone().normalize();
    const mastHeight = degToUnitsStar * 1.8;

    // mastil: cilindro fino desde la superficie hasta la estrella
    const mast = new THREE.Mesh(
      new THREE.CylinderGeometry(degToUnitsStar * 0.05, degToUnitsStar * 0.05, mastHeight, 8),
      new THREE.MeshBasicMaterial({ color: 0xffd873, transparent: true, opacity: 0.75 }),
    );
    mast.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), starNormal);
    mast.position.copy(starNormal.clone().multiplyScalar(globeRadius + mastHeight / 2));
    markerGroup.add(mast);

    // punto de anclaje en la superficie exacta
    starAnchor = glowSprite('rgba(255,244,214,0.95)', 'rgba(255,216,115,0.5)', degToUnitsStar * 0.9);
    starAnchor.position.copy(starNormal.clone().multiplyScalar(globeRadius * 1.002));
    markerGroup.add(starAnchor);

    starPos = starNormal.clone().multiplyScalar(globeRadius + mastHeight);
    starMesh = starSprite(starSize);
    starMesh.position.copy(starPos);
    starMesh.userData.kind = 'star';
    markerGroup.add(starMesh);
  }

  // ---- nodos por region del pais de la empresa ----
  // Cada nodo se coloca en SU coordenada real (lat/lng calculada en el
  // backend por region, ver COUNTRY_REGIONS en pactum-viridi.js) y se
  // orienta segun la normal de la superficie en ese punto. Nada de circulo
  // uniforme sobre el centro del pais: la silueta del despliegue reproduce
  // el territorio real (ES: Canarias y Baleares separadas; DZ: wilayas).
  const esData = data.esCurtailment || {};
  const nodesTotal = esData.nodesTargetTotal || 0;
  const nodeDefs = Array.isArray(esData.nodes) ? esData.nodes : [];
  const spainPos = latLngToVec3(esData.lat, esData.lng, globeRadius);
  const outward = spainPos.clone().normalize();

  const clusterGroup = new THREE.Group();
  markerGroup.add(clusterGroup);

  const NODE_RED = { top: '#ffb0aa', mid: '#ff5b52', bottom: '#a81e18', emissive: 0xff2a20, color: 0xff5b52 };
  const NODE_GREEN = { top: '#a8f5c8', mid: '#35c26a', bottom: '#15703c', emissive: 0x18d466, color: 0x35c26a };
  const redTexture = buildCylinderTexture(NODE_RED.top, NODE_RED.mid, NODE_RED.bottom);
  const greenTexture = buildCylinderTexture(NODE_GREEN.top, NODE_GREEN.mid, NODE_GREEN.bottom);

  // Escala quirurgica: el nodo mide fracciones de grado de arco, de modo
  // que a distancia se lee como un punto de luz y de cerca como una
  // torre individual sobre su comunidad.
  const degToUnits = globeRadius * (Math.PI / 180);
  const nodeRadius = degToUnits * 0.055;
  const nodeHeight = degToUnits * 0.42;
  const nodeGeometry = new THREE.CylinderGeometry(nodeRadius, nodeRadius * 1.3, nodeHeight, 8, 1, false);

  const upAxis = new THREE.Vector3(0, 1, 0);
  const nodeMeshes = [];
  for (let i = 0; i < nodesTotal; i++) {
    const def = nodeDefs[i];
    if (!def) continue;
    // si el backend no trajo coordenadas, no se inventa posicion
    if (typeof def.lat !== 'number' || typeof def.lng !== 'number') continue;

    const surface = latLngToVec3(def.lat, def.lng, globeRadius);
    const normal = surface.clone().normalize();

    const mat = new THREE.MeshStandardMaterial({
      map: redTexture,
      emissive: NODE_RED.emissive,
      emissiveIntensity: 1.0,
      color: NODE_RED.color,
      roughness: 0.32,
      metalness: 0.15,
      transparent: true,
      opacity: 0.95,
    });
    const mesh = new THREE.Mesh(nodeGeometry, mat);
    mesh.quaternion.setFromUnitVectors(upAxis, normal);
    mesh.position.copy(normal.clone().multiplyScalar(globeRadius + nodeHeight / 2));
    mesh.userData.kind = 'node';
    mesh.userData.index = i;
    clusterGroup.add(mesh);

    const glow = glowSprite('rgba(255,150,140,0.95)', 'rgba(255,60,50,0.45)', nodeRadius * 5.5);
    glow.position.copy(normal.clone().multiplyScalar(globeRadius + nodeHeight * 1.05));
    clusterGroup.add(glow);

    nodeMeshes.push({
      mesh, glow, def, installed: false, normal,
      // desfase por nodo: el destello recorre el territorio en oleada en
      // vez de parpadear todo a la vez
      phase: (i / Math.max(1, nodesTotal)) * Math.PI * 2,
    });
  }

  // halo tenue sobre el conjunto del territorio: a distancia da presencia
  // sin tapar la peninsula, de cerca practicamente desaparece
  const clusterBaseGlow = glowSprite('rgba(255,120,110,0.5)', 'rgba(255,60,50,0.2)', degToUnits * 11);
  clusterBaseGlow.position.copy(outward.clone().multiplyScalar(globeRadius * 1.004));
  clusterGroup.add(clusterBaseGlow);

  function setNodeInstalled(index, installed) {
    const entry = nodeMeshes[index];
    if (!entry || entry.installed === installed) return;
    entry.installed = installed;
    const palette = installed ? NODE_GREEN : NODE_RED;
    entry.mesh.material.map = installed ? greenTexture : redTexture;
    entry.mesh.material.emissive.setHex(palette.emissive);
    entry.mesh.material.color.setHex(palette.color);
    entry.mesh.material.needsUpdate = true;
    entry.glow.material.color.setHex(installed ? 0x9dffc4 : 0xffffff);
  }

  function setAllInstalled(installed) {
    for (let i = 0; i < nodeMeshes.length; i++) setNodeInstalled(i, installed);
  }

  function installedCount() {
    return nodeMeshes.reduce((n, e) => n + (e.installed ? 1 : 0), 0);
  }

  // interaccion: raycasting para click sobre estrella / nodo individual
  const raycaster = new THREE.Raycaster();
  const pointerNdc = new THREE.Vector2();
  function pickAt(clientX, clientY) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointerNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    pointerNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointerNdc, camera);
    const targets = [];
    if (starMesh) targets.push(starMesh);
    nodeMeshes.forEach((e) => targets.push(e.mesh));
    targets.push(clusterBaseGlow);
    const hits = raycaster.intersectObjects(targets, false);
    if (hits.length === 0) return null;
    const hit = hits[0].object;
    if (hit === starMesh) return { kind: 'star' };
    if (hit === clusterBaseGlow) return { kind: 'cluster' };
    return { kind: 'node', index: hit.userData.index };
  }

  /* ---- camara orbital 360° ----
   * La esfera ya no rota sobre si misma: orbita la CAMARA en coordenadas
   * esfericas alrededor de un punto objetivo. Asi el azimut da vueltas
   * completas sin costuras, la inclinacion recorre polo a polo (con un
   * epsilon para no degenerar el vector 'up'), y el arrastre con boton
   * derecho / dos dedos desplaza el objetivo (pan). Inercia con
   * amortiguacion en ambos ejes y zoom interpolado. */
  // MIN_DIST justo por encima del radio: permite acercarse a ras de
  // superficie para inspeccionar los marcadores quirurgicos
  const MIN_DIST = 2.52, MAX_DIST = 16;
  const EPS = 0.0005;
  let azimuth = 0;            // rotacion horizontal, sin limite (360° continuo)
  let polar = Math.PI / 2 - 0.2; // angulo desde +Y
  let targetDistance = camDistance;
  const orbitTarget = new THREE.Vector3(0, 0, 0);
  const panOffset = new THREE.Vector3();

  let isDragging = false, isPanning = false, dragMoved = false;
  let lastX = 0, lastY = 0;
  let velAz = 0, velPol = 0;
  let autoRotate = true;
  let paused = false;

  const activePointers = new Map();
  let pinchPrevDist = 0;

  function applyCamera() {
    const sinPolar = Math.sin(polar);
    camera.position.set(
      orbitTarget.x + camDistance * sinPolar * Math.sin(azimuth),
      orbitTarget.y + camDistance * Math.cos(polar),
      orbitTarget.z + camDistance * sinPolar * Math.cos(azimuth),
    );
    camera.lookAt(orbitTarget);
  }

  renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

  renderer.domElement.addEventListener('pointerdown', (e) => {
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    renderer.domElement.setPointerCapture?.(e.pointerId);
    if (activePointers.size === 1) {
      isDragging = true;
      isPanning = e.button === 2 || e.shiftKey;
      dragMoved = false;
      lastX = e.clientX; lastY = e.clientY;
      velAz = 0; velPol = 0;
    } else if (activePointers.size === 2) {
      isDragging = false;
      const [a, b] = [...activePointers.values()];
      pinchPrevDist = Math.hypot(a.x - b.x, a.y - b.y);
    }
  });

  function endPointer(e) {
    if (activePointers.has(e.pointerId)) activePointers.delete(e.pointerId);
    if (isDragging && !dragMoved && !isPanning) {
      const hit = pickAt(e.clientX, e.clientY);
      if (hit) onMarkerClick(hit);
    }
    if (activePointers.size < 2) pinchPrevDist = 0;
    if (activePointers.size === 0) { isDragging = false; isPanning = false; }
  }
  window.addEventListener('pointerup', endPointer);
  window.addEventListener('pointercancel', endPointer);

  window.addEventListener('pointermove', (e) => {
    if (activePointers.has(e.pointerId)) activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    // pellizco de dos dedos = zoom
    if (activePointers.size === 2) {
      const [a, b] = [...activePointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchPrevDist > 0) {
        targetDistance = clamp(targetDistance * (pinchPrevDist / dist), MIN_DIST, MAX_DIST);
      }
      pinchPrevDist = dist;
      autoRotate = false;
      return;
    }

    if (!isDragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) dragMoved = true;
    lastX = e.clientX; lastY = e.clientY;
    autoRotate = false;

    if (isPanning) {
      // desplazar el objetivo en el plano de la camara, a escala de la
      // distancia actual: el mismo gesto mueve lo mismo con cualquier zoom
      const factor = camDistance * 0.0016;
      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
      panOffset.copy(right.multiplyScalar(-dx * factor)).add(up.multiplyScalar(dy * factor));
      orbitTarget.add(panOffset);
      // no dejar que el objetivo se aleje tanto que el globo salga de plano
      if (orbitTarget.length() > globeRadius * 1.6) orbitTarget.setLength(globeRadius * 1.6);
      return;
    }

    velAz = -dx * 0.005;
    velPol = -dy * 0.005;
    azimuth += velAz;
    polar = clamp(polar + velPol, EPS, Math.PI - EPS);
  });

  renderer.domElement.addEventListener('wheel', (e) => {
    e.preventDefault();
    // zoom multiplicativo: mismo "tacto" cerca y lejos del globo
    targetDistance = clamp(targetDistance * Math.exp(e.deltaY * 0.0012), MIN_DIST, MAX_DIST);
    autoRotate = false;
  }, { passive: false });

  renderer.domElement.addEventListener('dblclick', () => resetView());

  // La tarjeta de la sede va anclada al marcador 3D: cada frame se proyecta
  // su posicion a coordenadas de pantalla y se delega en la pagina.
  function updateHudPositions() {
    if (starMesh && starPos && isStarCardVisible()) {
      onStarProject(projectToScreen(starPos));
    }
  }

  function projectToScreen(localVec) {
    const world = localVec.clone();
    sphere.localToWorld(world);
    const projected = world.clone().project(camera);
    const rect = renderer.domElement.getBoundingClientRect();
    return {
      x: rect.left + (projected.x * 0.5 + 0.5) * rect.width,
      y: rect.top + (-projected.y * 0.5 + 0.5) * rect.height,
      visible: projected.z < 1,
    };
  }

  const clock = new THREE.Clock();
  function animate() {
    if (disposed) return; // teardown: corta el bucle de render
    requestAnimationFrame(animate);
    if (paused) return;
    const dt = Math.min(clock.getDelta(), 0.05);

    // orbita: deriva automatica + inercia amortiguada tras soltar
    if (autoRotate && !isDragging) azimuth += 0.0011;
    if (!isDragging) {
      velAz *= 0.93; velPol *= 0.93;
      if (Math.abs(velAz) > 1e-5) azimuth += velAz;
      if (Math.abs(velPol) > 1e-5) polar = clamp(polar + velPol, EPS, Math.PI - EPS);
    }

    camDistance = lerp(camDistance, targetDistance, 1 - Math.pow(0.001, dt));
    applyCamera();

    // destello incandescente intermitente por nodo: pulso senoidal con
    // desfase propio (recorre el cluster) + un segundo armonico rapido
    // que da el "chispazo" incandescente. Los instalados (verde) laten
    // mas lento y estable: leen como operativos, no como alerta.
    const t = performance.now() / 1000;

    // ---- nivel de detalle por distancia ----
    // Lejos (>6.5): los nodos casi se apagan y manda el halo del
    // territorio — el pais se lee como una brasa tenue, sin tapar el mapa.
    // Cerca (<3.6): los nodos brillan con destello intermitente fuerte y
    // el halo se retira para no velar la silueta.
    const near = clamp((6.5 - camDistance) / (6.5 - 3.6), 0, 1); // 0 lejos, 1 cerca
    const nodeVisibility = 0.10 + near * 0.90;
    const glowScaleLod = 0.55 + near * 0.45;

    for (let i = 0; i < nodeMeshes.length; i++) {
      const e = nodeMeshes[i];
      const speed = e.installed ? 1.1 : 2.6;
      const base = Math.sin(t * speed + e.phase);
      // el chispazo solo aparece de cerca: de lejos seria ruido visual
      const spark = e.installed ? 0 : 0.30 * near * Math.sin(t * 9.5 + e.phase * 2.3);
      const pulse = 0.5 + 0.5 * base;
      // de lejos la intermitencia se aplana; de cerca late con fuerza
      const swing = (e.installed ? 0.5 : 1.25) * (0.35 + 0.65 * near);
      e.mesh.material.emissiveIntensity = (e.installed ? 0.8 : 0.6) + pulse * swing + spark;
      e.mesh.material.opacity = (0.55 + pulse * 0.25) * nodeVisibility + 0.12;
      e.glow.material.opacity = ((e.installed ? 0.45 : 0.5) + pulse * 0.45 + spark * 0.5) * nodeVisibility;
      const gs = nodeRadius * 5.5 * glowScaleLod * (1 + 0.16 * base * near);
      e.glow.scale.set(gs, gs, 1);
    }

    // halo del territorio: presencia en vista lejana, se retira al entrar
    clusterBaseGlow.material.opacity = (0.30 + 0.16 * Math.sin(t * 1.3)) * (1 - near * 0.92);

    // latido suave del ancla de la sede: señala sin competir con el cluster
    if (starAnchor) starAnchor.material.opacity = 0.6 + 0.35 * Math.sin(t * 1.7);

    starField.rotation.y += 0.00006;

    renderer.render(scene, camera);
    updateHudPositions();
  }
  animate();

  function onResize() {
    width = wrap.clientWidth; height = wrap.clientHeight;
    if (width === 0 || height === 0) return; // panel oculto: no romper la matriz
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    // Al mover la ventana entre monitores cambia devicePixelRatio; sin
    // reaplicarlo el canvas se queda borroso en el monitor nuevo.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 3));
    renderer.setSize(width, height);
  }
  window.addEventListener('resize', onResize);

  // Orienta la orbita para mirar de frente a un punto de la superficie
  function aimAt(localVec, distance) {
    const v = localVec.clone().normalize();
    polar = clamp(Math.acos(clamp(v.y, -1, 1)), EPS, Math.PI - EPS);
    azimuth = Math.atan2(v.x, v.z);
    orbitTarget.set(0, 0, 0);
    if (distance !== undefined) targetDistance = clamp(distance, MIN_DIST, MAX_DIST);
  }

  function resetView() {
    // Antes solo reponia la distancia: el globo se quedaba girado en la
    // rotacion que tuviera, asi que "REENCUADRAR" no reencuadraba nada.
    // Vuelve al encuadre inicial (pais de la empresa de frente) y para la inercia.
    velAz = 0; velPol = 0;
    aimAt(outward, 5.2);
    orbitTarget.set(0, 0, 0);
    autoRotate = true;
  }

  // Encuadre fijo para exportacion: camara mirando al punto medio entre
  // la estrella y el cluster para que ambos queden en cuadro.
  function captureFramedShot() {
    const prevAz = azimuth, prevPolar = polar;
    const prevTargetPos = orbitTarget.clone();
    const prevCamDistance = camDistance;
    const prevPaused = paused;
    paused = true;

    const clusterAnchor = outward.clone().multiplyScalar(globeRadius);
    const targets = starPos ? [starPos, clusterAnchor] : [clusterAnchor];
    const avg = targets.reduce((acc, v) => acc.add(v.clone()), new THREE.Vector3()).divideScalar(targets.length);
    const dist = starPos ? Math.max(4.6, starPos.distanceTo(clusterAnchor) * 1.6 + 3.4) : 5.6;

    const v = (avg.lengthSq() > 0.0001 ? avg.clone().normalize() : new THREE.Vector3(0, 0, 1));
    polar = clamp(Math.acos(clamp(v.y, -1, 1)), EPS, Math.PI - EPS);
    azimuth = Math.atan2(v.x, v.z);
    orbitTarget.set(0, 0, 0);
    camDistance = dist;
    applyCamera();
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);
    const dataUrl = renderer.domElement.toDataURL('image/png');

    azimuth = prevAz; polar = prevPolar;
    orbitTarget.copy(prevTargetPos);
    camDistance = prevCamDistance;
    // targetDistance no se toco al encuadrar, pero se reafirma: si no, el
    // primer frame tras la captura interpola hacia un destino que ya no
    // corresponde al encuadre restaurado.
    targetDistance = clamp(prevCamDistance, MIN_DIST, MAX_DIST);
    applyCamera();
    paused = prevPaused;
    return dataUrl;
  }

  // vista inicial: pais de la empresa de frente, lo bastante cerca para leer el cluster
  aimAt(outward, 5.2);
  applyCamera();

  return {
    captureFramedShot, resetView,
    setNodeInstalled, setAllInstalled, installedCount,
    getNodes: () => nodeMeshes,
    // Teardown: sin esto el bucle de render y el listener de resize siguen
    // vivos al salir de la pagina, y la GPU retiene texturas y geometrias.
    dispose() {
      disposed = true;
      window.removeEventListener('resize', onResize);
      scene.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
        const mats = Array.isArray(obj.material) ? obj.material : (obj.material ? [obj.material] : []);
        mats.forEach((m) => {
          Object.values(m).forEach((v) => { if (v && v.isTexture) v.dispose(); });
          m.dispose();
        });
      });
      renderer.dispose();
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
    },
    // distancias cortas: a ~2.85 el pais llena el encuadre y los
    // marcadores quirurgicos (cluster / estrella) se leen uno a uno
    focusSpain: () => { aimAt(outward, 2.95); autoRotate = false; },
    focusStar: () => { if (starPos) { aimAt(starPos, 2.85); autoRotate = false; } },
  };
}

export { latLngToVec3, lerp, clamp, buildEarthTexture, initGlobe };
