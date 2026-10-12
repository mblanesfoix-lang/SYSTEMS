/**
 * Visor 3D de maquinaria S-NFI BioHybrid (Bio-Grinder, Bio-Dehydrator, Bio-Pelletizator).
 * Modelos .glb optimizados offline (app/assets-src/optimize-models.mjs) a partir de los
 * .glb crudos que exporta SketchUp.
 *
 * Camara tipo turntable: arrastrar en horizontal gira el modelo sobre su eje vertical, en
 * vertical inclina la camara (el modelo siempre apoyado en el suelo), rueda = zoom. Pointer
 * events a mano (sin OrbitControls addon) para no vendorizar una libreria de controles
 * ademas del loader.
 *
 * No conoce el DOM de la pagina salvo el contenedor que se le pasa. Carga el modelo
 * activo desde /vendor/models/<file>.glb via GLTFLoader vendorizado en
 * /vendor/three-addons/ (pinned three@0.184.0, mismo release que el cliente Rëff).
 *
 * Estetica "sala limpia": suelo reflectante + grid holografico, iluminacion de 3
 * puntos, sombras suaves. Suelo, luces, sombras, fog y encuadre de camara se recalculan en
 * cada carga en funcion del tamano real del modelo (bounding box), para que funcione igual
 * con una pieza de 2m que con un layout de planta de cientos de metros.
 *
 * Soporte para el HUD de telemetria (js/machine-hud.js), sin conocer su DOM:
 *   - setAnchors(): hotspots en coordenadas NATIVAS del .glb (las de SketchUp, en metros), colgados
 *     del modelo para que giren con el. Cada frame se proyectan a pixeles y se entregan por onAnchors(),
 *     junto con si miran a la camara y si otra pieza los tapa.
 *   - hover/clic sobre la maquina por raycast (onHover/onClick); el hover brilla y retiene la
 *     rotacion automatica para poder leer. setHold() permite al HUD retenerla tambien.
 *   - setViewInset(): desplaza el encuadre para que el modelo quede centrado en el area que el HUD
 *     deja libre (camera.setViewOffset), en vez de quedar tapado por el panel.
 *   - pick(): punto y normal de superficie bajo un pixel, en coordenadas nativas. Es la herramienta
 *     para ubicar hotspots nuevos (la pagina la expone con ?debug3d).
 */
import * as THREE from '/vendor/three.module.min.js';
import { GLTFLoader } from '/vendor/three-addons/GLTFLoader.js';

// Presupuesto por modelo. Un .glb crudo de SketchUp trae una primitiva y un material por cara
// (el Pelletizator: 21.257 primitivas y 20.456 materiales). three.js hace un draw call por
// primitiva (x2 con sombras) y clona los uniforms por material: con esas cifras el render cae
// a ~3 fps, el parseo bloquea el hilo principal varios segundos y se disparan cientos de MB de
// heap y decenas de miles de buffers GL hasta colgar o matar la pestana. Se rechaza ANTES de
// parsear. Un modelo optimizado tiene decenas de primitivas.
const MAX_PRIMITIVES = 3000;
const MAX_MATERIALS = 3000;

const CAMERA_AZIMUTH = Math.PI / 4; // la camara mira siempre desde la misma diagonal: gira el modelo, no la camara
const MIN_ELEVATION = 0.06;         // rad, evita ir por debajo del suelo
const MAX_ELEVATION = 1.45;         // rad, evita el gimbal en vertical
const KEY_LIGHT_BASE = new THREE.Vector3(6, 9, 5);
const SHADOW_HALF = 5;              // semiancho (m) del frustum de sombras del rig base
const HOVER_INTERVAL_MS = 110;      // como maximo un raycast de hover cada 110 ms
const CLICK_SLOP_PX = 5;            // por debajo de este desplazamiento pulsar cuenta como clic, no como arrastre
const HIGHLIGHT_COLOR = new THREE.Color(0x00d4a0);
const HIGHLIGHT_INTENSITY = 0.16;   // emisivo maximo al pasar el cursor por la maquina
const MAX_INSET_RIGHT = 0.55;       // el HUD nunca desplaza el modelo mas de esta fraccion del ancho del visor (dock lateral)
const MAX_INSET_BOTTOM = 0.62;      // ... ni de esta fraccion del alto (hoja inferior en movil, tope 60 % + margen)
const OCCLUSION_INTERVAL_MS = 100;  // cada cuanto se re-evalua si una pieza tapa un hotspot

// Lee solo el JSON de un .glb (binario): cuantas primitivas y materiales trae. null si no es un GLB valido.
function inspectGlb(buffer) {
  if (buffer.byteLength < 28) return null;
  const dv = new DataView(buffer);
  if (dv.getUint32(0, true) !== 0x46546c67 /* 'glTF' */ || dv.getUint32(16, true) !== 0x4e4f534a /* 'JSON' */) return null;
  const jsonLen = dv.getUint32(12, true);
  if (20 + jsonLen > buffer.byteLength) return null;
  try {
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLen)));
    return {
      primitives: (json.meshes || []).reduce((n, m) => n + (m.primitives?.length || 0), 0),
      materials: (json.materials || []).length,
    };
  } catch {
    return null; // JSON corrupto: que lo diagnostique GLTFLoader con su propio error
  }
}

function assertWithinBudget(buffer) {
  const info = inspectGlb(buffer);
  if (!info || (info.primitives <= MAX_PRIMITIVES && info.materials <= MAX_MATERIALS)) return;
  const err = /** @type {Error & {code?: string}} */ (new Error(
    `Modelo sin optimizar: ${info.primitives.toLocaleString('es-ES')} primitivas y ${info.materials.toLocaleString('es-ES')} materiales ` +
    `(máximo ${MAX_PRIMITIVES.toLocaleString('es-ES')}). Ejecuta "npm run optimize" en app/assets-src para fusionarlos.`,
  ));
  err.code = 'MODEL_TOO_HEAVY';
  throw err;
}

async function fetchModel(url, signal, onPct) {
  const res = await fetch(url, { signal });
  if (!res.ok) {
    const err = /** @type {Error & {status?: number}} */ (new Error(`fetch for "${url}" responded with ${res.status}: ${res.statusText}`));
    err.status = res.status;
    throw err;
  }
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !total) return res.arrayBuffer();
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onPct(Math.min(1, loaded / total)); // con Content-Encoding el total comprimido puede ser menor que lo leido
  }
  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out.buffer;
}

function abortError() {
  const err = new Error('Carga sustituida por otra más reciente');
  err.name = 'AbortError';
  return err;
}

export function mountMachineViewer(container, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const onAutoRotate = opts.onAutoRotate || (() => {}); // la UI sincroniza su boton con el estado real
  const onContextChange = opts.onContextChange || (() => {}); // true = contexto WebGL perdido, false = recuperado
  const onAnchors = opts.onAnchors || null;   // [{id, x, y, facing, inView}] en pixeles del visor, una vez por frame
  const onHover = opts.onHover || (() => {}); // el cursor entra (true) o sale (false) de la maquina
  const onClick = opts.onClick || (() => {}); // clic sin arrastre: { hit } indica si el rayo toco la maquina

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x07080a);
  scene.fog = new THREE.Fog(0x07080a, 12, 60); // rango real fijado en frameModel() al tamano del modelo cargado

  const camera = new THREE.PerspectiveCamera(42, 1, 0.05, 3000);

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap; // r184: PCFSoftShadowMap esta deprecado y three.js ya usa PCFShadowMap en su lugar
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  container.appendChild(renderer.domElement);

  // three.js ya hace preventDefault() en webglcontextlost y re-sube los recursos solo al restaurarse;
  // aqui solo se avisa a la UI para que no quede un canvas congelado sin explicacion.
  const onCtxLost = () => onContextChange(true);
  const onCtxRestored = () => onContextChange(false);
  renderer.domElement.addEventListener('webglcontextlost', onCtxLost);
  renderer.domElement.addEventListener('webglcontextrestored', onCtxRestored);

  // ---- Iluminacion de estudio (key / fill / rim, 3 puntos) ----
  scene.add(new THREE.AmbientLight(0xaac4ff, 0.22));

  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.copy(KEY_LIGHT_BASE);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.0005;
  scene.add(key);

  const fill = new THREE.DirectionalLight(0x6ab8ff, 0.6);
  fill.position.set(-7, 3, -2);
  scene.add(fill);

  const rim = new THREE.DirectionalLight(0x00d4a0, 0.5);
  rim.position.set(-3, 4, -7);
  scene.add(rim);

  // ---- Suelo reflectante sutil + grid holografico ----
  const floorGeo = new THREE.PlaneGeometry(60, 60);
  const floorMat = new THREE.MeshStandardMaterial({
    color: 0x0a0c10, roughness: 0.35, metalness: 0.65,
  });
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  const grid = new THREE.GridHelper(40, 40, 0x143a4a, 0x0f1a20);
  grid.position.y = 0.001;
  grid.material.transparent = true;
  grid.material.opacity = 0.55;
  scene.add(grid);

  // anillo holografico bajo el pivote, refuerzo visual "consola soberana"
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.01, 0.02, 64),
    new THREE.MeshBasicMaterial({ color: 0x00a878, transparent: true, opacity: 0.35, side: THREE.DoubleSide }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.002;
  scene.add(ring);

  const rig = new THREE.Group(); // pivote del turntable: el modelo cuelga de aqui y solo gira en Y
  scene.add(rig);

  // ---- Camara: orbita por elevacion + radio; el azimut lo da la rotacion del rig ----
  const view = { elevation: 0, radius: 1, targetY: 0 }; // estado actual; targetY = altura del punto al que mira la camara
  const home = { elevation: 0, radius: 1, targetY: 0 }; // encuadre del ultimo modelo cargado, al que vuelve resetView()
  let zoomMin = 0.15;
  let zoomMax = 800;

  function applyCamera() {
    const horizontal = Math.cos(view.elevation) * view.radius;
    camera.position.set(Math.sin(CAMERA_AZIMUTH) * horizontal, view.targetY + Math.sin(view.elevation) * view.radius, Math.cos(CAMERA_AZIMUTH) * horizontal);
    camera.lookAt(0, view.targetY, 0);
    camera.updateMatrixWorld(); // proyectar hotspots usa matrixWorldInverse: sin esto iria un frame por detras
  }
  home.elevation = Math.atan2(2.6, Math.hypot(4, 5));
  home.radius = Math.hypot(4, 2.6, 5);
  Object.assign(view, home);
  applyCamera();

  const loader = new GLTFLoader();
  let currentModel = null;
  let autoRotate = true;
  let wireframeOn = false;

  // ---- Interaccion con la maquina, hotspots anclados al modelo y encuadre con HUD ----
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const pointer = { x: 0, y: 0, inside: false };
  let hitMeshes = [];       // solo mallas: las Line/Points que exporta SketchUp no deben capturar el rayo
  let hoverHit = false;
  let lastRayAt = 0;
  let holdExternal = false; // el HUD retiene la rotacion (cursor sobre un hotspot o el panel)
  let hold = 0;             // 0..1 suavizado: 1 = rotacion automatica detenida
  let highlight = 0;        // 0..1 suavizado del brillo de hover
  let highlightMats = [];   // { m, color, intensity } con el emisivo original para restaurarlo
  let anchors = [];         // { id, obj, normal, out }
  let anchorOut = [];       // anchors.map(a => a.out), reutilizado cada frame
  let anchorsSent = 0;
  let lastOcclusionAt = 0;
  const inset = { right: 0, bottom: 0, curR: 0, curB: 0 };
  let viewW = 1;
  let viewH = 1;
  const _p = new THREE.Vector3();
  const _n = new THREE.Vector3();
  const _c = new THREE.Vector3();

  // Unico punto que cambia autoRotate: asi el boton de la UI nunca queda desincronizado
  // (arrastrar apaga la rotacion, Reencuadrar la enciende).
  function setAutoRotate(on) {
    if (autoRotate === on) return;
    autoRotate = on;
    onAutoRotate(on);
  }
  let loadToken = 0; // descarta respuestas de loadModel() obsoletas si el usuario cambia de maquina a media carga
  let abortLoad = null; // corta la descarga en vuelo de la carga anterior

  function disposeModel(model) {
    model.traverse((n) => {
      if (n.geometry) n.geometry.dispose();
      if (n.material) {
        const mats = Array.isArray(n.material) ? n.material : [n.material];
        mats.forEach((m) => {
          // texturas (map, normalMap, ...) tambien: material.dispose() NO las libera y se acumulaban en la GPU al cambiar de maquina
          for (const prop of Object.values(m)) if (prop && prop.isTexture) prop.dispose();
          m.dispose();
        });
      }
    });
  }

  function countDrawables(object3d) {
    let tris = 0;
    let drawCalls = 0;
    object3d.traverse((n) => {
      if (n.isMesh && n.geometry) {
        const g = n.geometry;
        tris += g.index ? g.index.count / 3 : g.attributes.position.count / 3;
      }
      if ((n.isMesh || n.isLine || n.isPoints) && n.geometry) drawCalls++;
    });
    return { triangles: Math.round(tris), drawCalls };
  }

  // Mide y asienta el modelo en el suelo. Se llama ANTES de colgarlo del rig: medir con el rig ya
  // girado (autorotacion, arrastre) daria el AABB del modelo rotado (medidas infladas) y un centro
  // en coordenadas de mundo restado a una posicion local (modelo descentrado respecto al pivote).
  //
  // `focus` (opcional, {min, max} en coordenadas nativas del .glb) acota el encuadre a una parte del
  // modelo: centrado, distancia de camara, suelo y luces se calculan sobre ella. Hace falta cuando el
  // .glb trae figuras de escala o piezas lejanas que agrandan el bbox (el Dehydrator mide 44 m con una
  // persona a 15 m de la nave: sin focus la nave ocupa una fraccion del cuadro). La base se asienta
  // siempre con el bbox completo, para que nada quede bajo el suelo.
  // `zoom` (< 1 acerca) afina la distancia: el radio de esfera envolvente es la cota segura para cualquier
  // angulo, pero en una nave larga y plana sobra mucho margen (la esfera cubre tambien el eje vertical).
  function frameModel(object3d, focus, zoom = 1) {
    object3d.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(object3d, true);
    if (box.isEmpty()) throw new Error('El modelo no contiene geometría');
    const size = box.getSize(new THREE.Vector3());
    const fbox = focus ? new THREE.Box3(new THREE.Vector3(...focus.min), new THREE.Vector3(...focus.max)) : box;
    const fsize = fbox.getSize(new THREE.Vector3());
    const fcenter = fbox.getCenter(new THREE.Vector3());
    const maxDim = Math.max(fsize.x, fsize.y, fsize.z) || 1;
    object3d.position.set(-fcenter.x, -box.min.y, -fcenter.z); // foco centrado en x/z y base del modelo en el suelo (y=0)
    object3d.traverse((n) => {
      if (n.isMesh) { n.castShadow = true; n.receiveShadow = true; }
    });

    // Distancia de camara por radio de esfera envolvente, no por maxDim solo:
    // con maquinas muy planas o alargadas (p.ej. 37m x 3m x 28m) usar solo el eje
    // mas largo dejaba el objeto diminuto en el centro del frame, porque una vista
    // isometrica no proyecta ese eje a pantalla completa. El radio de la esfera que
    // envuelve el box si captura el tamano real percibido desde cualquier angulo.
    const sphereRadius = fsize.length() / 2;
    const fovRad = THREE.MathUtils.degToRad(camera.fov);
    const dist = (sphereRadius / Math.sin(fovRad / 2)) * 1.15 * zoom; // 15% de margen
    home.radius = Math.hypot(dist * 0.68, dist * 0.5, dist * 0.68);
    home.elevation = Math.atan2(dist * 0.5, Math.hypot(dist * 0.68, dist * 0.68));
    home.targetY = (fbox.min.y + fbox.max.y) / 2 - box.min.y; // la camara mira al centro del foco, no al suelo
    Object.assign(view, home);
    zoomMin = Math.max(0.15, home.radius * 0.03);
    zoomMax = home.radius * 3; // mas alla el modelo desaparece dentro del fog (fog.far = 4.5 * dist)
    camera.near = Math.max(maxDim / 200, 0.01);
    camera.far = maxDim * 60;
    camera.updateProjectionMatrix();
    applyCamera();

    // fog proporcional a la distancia real de camara: un rango fijo (p.ej. 12-60)
    // solo funciona para modelos pequenos; con layouts grandes el objeto entero
    // queda fuera del rango de fog y se renderiza en negro solido.
    const fog = /** @type {THREE.Fog} */ (scene.fog);
    fog.near = dist * 1.6;
    fog.far = dist * 4.5;

    // Rig de luces/sombras: el baseline (luz key a ~12 m, frustum de sombras de +-5 m) sirve para
    // maquinas de unos pocos metros y no cambia su aspecto. Con layouts grandes se escala todo
    // de forma uniforme (mismo aspecto a otra escala) para que las sombras cubran el modelo entero.
    const lightScale = Math.max(1, (sphereRadius * 1.5) / SHADOW_HALF);
    key.position.copy(KEY_LIGHT_BASE).multiplyScalar(lightScale);
    const sc = key.shadow.camera;
    sc.left = -SHADOW_HALF * lightScale;
    sc.right = SHADOW_HALF * lightScale;
    sc.top = SHADOW_HALF * lightScale;
    sc.bottom = -SHADOW_HALF * lightScale;
    sc.near = 0.5 * lightScale;
    sc.far = 500 * lightScale;
    sc.updateProjectionMatrix();

    // el suelo debe llegar mas alla del fog, si no su borde se ve como un poligono iluminado suelto
    floor.scale.setScalar(Math.max(1, (fog.far * 2.2) / 60));

    const ringR = maxDim * 0.9;
    ring.geometry.dispose();
    ring.geometry = new THREE.RingGeometry(ringR * 0.94, ringR, 80);
    grid.scale.setScalar(Math.max(maxDim / 10, 1));

    const toArr = (v) => [v.x, v.y, v.z].map((n) => Math.round(n * 1000) / 1000);
    return { size, box: { min: toArr(box.min), max: toArr(box.max) }, ...countDrawables(object3d) };
  }

  /**
   * @param {string} url
   * @param {{focus?: {min: number[], max: number[]}, zoom?: number}} [opts] encuadre: ver frameModel()
   */
  async function loadModel(url, { focus, zoom } = {}) {
    const myToken = ++loadToken;
    if (abortLoad) abortLoad.abort(); // la descarga anterior ya no interesa
    const ac = new AbortController();
    abortLoad = ac;
    onProgress(0);

    const buffer = await fetchModel(url, ac.signal, (pct) => { if (myToken === loadToken) onProgress(pct); })
      .catch((err) => { throw myToken !== loadToken ? abortError() : err; });
    if (myToken !== loadToken) throw abortError(); // el usuario ya pidio otra maquina mientras esta cargaba
    assertWithinBudget(buffer);
    const gltf = await loader.parseAsync(buffer, THREE.LoaderUtils.extractUrlBase(url));
    if (myToken !== loadToken) { disposeModel(gltf.scene); throw abortError(); }

    let meta;
    try {
      meta = frameModel(gltf.scene, focus, zoom);
    } catch (err) { // modelo vacio: el modelo anterior sigue intacto y este no debe quedar colgando en memoria
      disposeModel(gltf.scene);
      throw err;
    }
    const previous = currentModel;
    currentModel = gltf.scene;
    wireframeOn = false;
    rig.rotation.set(0, 0, 0); // cada maquina se abre de frente
    velX = 0;
    rig.add(currentModel);
    if (previous) {
      rig.remove(previous);
      disposeModel(previous);
    }
    prepareInteraction(currentModel);
    onProgress(1);
    return { gltf, meta };
  }

  // Mallas pickeables y materiales con brillo de hover. Los hotspots dependen de la geometria del
  // modelo: al cambiar de maquina se descartan y la pagina vuelve a pasar los suyos con setAnchors().
  function prepareInteraction(model) {
    hitMeshes = [];
    highlightMats = [];
    const seen = new Set();
    model.traverse((n) => {
      if (!n.isMesh) return;
      hitMeshes.push(n);
      for (const m of Array.isArray(n.material) ? n.material : [n.material]) {
        if (!m || !m.emissive || seen.has(m)) continue;
        seen.add(m);
        highlightMats.push({ m, color: m.emissive.clone(), intensity: m.emissiveIntensity });
      }
    });
    setAnchors([]);
    highlight = 0;
    setHover(false);
  }

  function clearModel() {
    loadToken++; // invalida cualquier carga en curso
    if (abortLoad) { abortLoad.abort(); abortLoad = null; }
    if (currentModel) {
      rig.remove(currentModel);
      disposeModel(currentModel);
      currentModel = null;
    }
    hitMeshes = [];
    highlightMats = [];
    setAnchors([]);
    highlight = 0;
    setHover(false);
  }

  function setWireframe(on) {
    wireframeOn = on;
    if (!currentModel) return;
    currentModel.traverse((n) => {
      if (n.isMesh && n.material) {
        const mats = Array.isArray(n.material) ? n.material : [n.material];
        mats.forEach((m) => { m.wireframe = on; });
      }
    });
  }

  // ---- Hover / clic por raycast contra las mallas del modelo activo ----
  function castAt(clientX, clientY) {
    if (!hitMeshes.length) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    // setFromCamera usa projectionMatrixInverse, que ya incluye el view offset del HUD
    ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(hitMeshes, false);
    return hits.length ? hits[0] : null;
  }

  function setHover(on) {
    if (hoverHit === on) return;
    hoverHit = on;
    if (!pressed) renderer.domElement.style.cursor = on ? 'pointer' : 'grab';
    onHover(on);
  }

  function applyHighlight() {
    for (const h of highlightMats) {
      if (highlight > 0) {
        h.m.emissive.copy(HIGHLIGHT_COLOR);
        h.m.emissiveIntensity = HIGHLIGHT_INTENSITY * highlight;
      } else {
        h.m.emissive.copy(h.color);
        h.m.emissiveIntensity = h.intensity;
      }
    }
  }

  // ---- Hotspots: Object3D hijos del modelo, en coordenadas nativas del .glb ----
  function setAnchors(defs) {
    for (const a of anchors) a.obj.parent?.remove(a.obj);
    anchors = [];
    if (currentModel) {
      for (const d of defs || []) {
        if (!Array.isArray(d.position) || d.position.length !== 3) continue;
        const obj = new THREE.Object3D();
        obj.position.fromArray(d.position);
        currentModel.add(obj);
        anchors.push({
          id: d.id,
          obj,
          normal: new THREE.Vector3().fromArray(d.normal || [0, 1, 0]).normalize(),
          out: { id: d.id, x: 0, y: 0, facing: 1, occluded: false, inView: false },
        });
      }
    }
    anchorOut = anchors.map((a) => a.out);
  }

  // Proyecta cada hotspot a pixeles del visor. `facing` es el coseno entre la normal de superficie y la
  // direccion hacia la camara (> 0 mira a la camara); `occluded` dice si otra pieza se interpone entre
  // la camara y el punto. La oclusion es un raycast por hotspot (~0,1-0,5 ms con estos modelos), asi que
  // se refresca cada OCCLUSION_INTERVAL_MS y no en cada frame.
  function projectAnchors(nowMs) {
    if (!onAnchors) return;
    if (!anchors.length) {
      if (anchorsSent) { anchorsSent = 0; onAnchors(anchorOut); } // un ultimo envio vacio para que el HUD limpie
      return;
    }
    const checkOcclusion = nowMs - lastOcclusionAt >= OCCLUSION_INTERVAL_MS;
    if (checkOcclusion) lastOcclusionAt = nowMs;
    for (const a of anchors) {
      a.obj.getWorldPosition(_p);
      _n.copy(a.normal).transformDirection(a.obj.matrixWorld);
      _c.subVectors(camera.position, _p);
      const dist = _c.length();
      _c.divideScalar(dist || 1);
      const o = a.out;
      o.facing = _n.dot(_c);
      if (checkOcclusion) {
        if (o.facing > 0.05 && hitMeshes.length) {
          // rayo desde la camara hasta el punto, cortado un pelo antes para no chocar con su propia superficie
          raycaster.set(camera.position, _c.negate());
          raycaster.far = dist - (dist * 0.004 + 0.01);
          o.occluded = raycaster.intersectObjects(hitMeshes, false).length > 0;
          raycaster.far = Infinity;
        } else {
          o.occluded = false;
        }
      }
      _p.project(camera);
      o.x = (_p.x * 0.5 + 0.5) * viewW;
      o.y = (-_p.y * 0.5 + 0.5) * viewH;
      o.inView = _p.z > -1 && _p.z < 1 && Math.abs(_p.x) <= 1.15 && Math.abs(_p.y) <= 1.15;
    }
    anchorsSent = anchors.length;
    onAnchors(anchorOut);
  }

  // ---- Encuadre con HUD: el modelo se centra en el area que el panel deja libre ----
  // El modelo se desplaza al centro del area libre y, si esta queda muy pequena (hoja inferior desplegada
  // en movil), se reduce lo justo para que no se recorte. Con el dock lateral de escritorio no escala.
  const FIT_FREE_H = 0.72; // fraccion de alto libre a partir de la cual se reduce el modelo
  const FIT_FREE_W = 0.5;
  function applyInset() {
    if (inset.curR <= 0 && inset.curB <= 0) {
      if (camera.view && camera.view.enabled) camera.clearViewOffset();
      return;
    }
    const s = Math.min(1, (viewH - inset.curB) / viewH / FIT_FREE_H, (viewW - inset.curR) / viewW / FIT_FREE_W);
    // una ventana MAYOR que el encuadre completo muestra mas escena en los mismos pixeles: el modelo se ve a escala s
    const fullW = viewW * s;
    const fullH = viewH * s;
    // el centro del encuadre completo (donde esta el modelo) pasa al centro del area libre de la ventana
    const cx = (viewW - inset.curR) / 2;
    const cy = (viewH - inset.curB) / 2;
    camera.setViewOffset(fullW, fullH, fullW / 2 - cx, fullH / 2 - cy, viewW, viewH);
  }

  function stepInset(dt) {
    const tr = Math.min(inset.right, viewW * MAX_INSET_RIGHT);
    const tb = Math.min(inset.bottom, viewH * MAX_INSET_BOTTOM);
    const dr = tr - inset.curR;
    const db = tb - inset.curB;
    if (dr === 0 && db === 0) return;
    if (Math.abs(dr) < 0.3 && Math.abs(db) < 0.3) {
      inset.curR = tr;
      inset.curB = tb;
    } else {
      const k = 1 - Math.exp(-dt * 9);
      inset.curR += dr * k;
      inset.curB += db * k;
    }
    applyInset();
  }

  // ---- Orbita manual: arrastrar gira/inclina, rueda hace zoom (mismo patron pointer que vdr-globe.js) ----
  // Pulsar sin desplazarse mas de CLICK_SLOP_PX es un clic (se entrega a onClick) y no detiene la
  // rotacion automatica; solo un arrastre real la apaga.
  let pressed = false; // boton pulsado sobre el canvas, aun sin saber si sera clic o arrastre
  let dragging = false;
  let downX = 0;
  let downY = 0;
  let lastX = 0;
  let lastY = 0;
  let velX = 0; // inercia tras soltar, se amortigua en tick()
  renderer.domElement.style.cursor = 'grab';
  renderer.domElement.style.touchAction = 'none';

  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    pressed = true;
    dragging = false;
    downX = lastX = e.clientX;
    downY = lastY = e.clientY;
    velX = 0;
    renderer.domElement.setPointerCapture?.(e.pointerId);
  };
  const onPointerUp = (e) => {
    const wasPressed = pressed;
    const wasDragging = dragging;
    pressed = false;
    dragging = false;
    renderer.domElement.style.cursor = hoverHit ? 'pointer' : 'grab';
    if (wasPressed && !wasDragging && e.type === 'pointerup') onClick({ hit: !!castAt(e.clientX, e.clientY) });
  };
  const onPointerMove = (e) => {
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    if (!pressed) return;
    if (!dragging) {
      if (Math.hypot(e.clientX - downX, e.clientY - downY) < CLICK_SLOP_PX) return; // aun puede ser un clic
      dragging = true;
      setAutoRotate(false);
      renderer.domElement.style.cursor = 'grabbing';
    }
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    rig.rotation.y += dx * 0.006;
    velX = dx * 0.006;
    // arrastrar hacia abajo sube la camara (se ve mas la parte superior); el modelo nunca se inclina
    view.elevation = THREE.MathUtils.clamp(view.elevation + dy * 0.005, MIN_ELEVATION, MAX_ELEVATION);
    applyCamera();
  };
  const onPointerEnter = () => { pointer.inside = true; };
  const onPointerLeave = () => { pointer.inside = false; setHover(false); };
  const onWheel = (e) => {
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY; // Firefox manda lineas, no pixeles
    view.radius = THREE.MathUtils.clamp(view.radius * (1 + dy * 0.001), zoomMin, zoomMax);
    applyCamera();
  };
  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('pointerenter', onPointerEnter);
  renderer.domElement.addEventListener('pointerleave', onPointerLeave);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
  window.addEventListener('pointermove', onPointerMove);
  renderer.domElement.addEventListener('wheel', onWheel, { passive: false });

  function resize() {
    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;
    // el zoom del navegador cambia devicePixelRatio sin recargar: sin esto el canvas se quedaba al ratio del montaje
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (renderer.getPixelRatio() !== dpr) renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    viewW = w;
    viewH = h;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    applyInset(); // el view offset guarda el tamano completo: hay que rehacerlo con el nuevo
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  const timer = new THREE.Timer(); // r184: THREE.Clock esta deprecado
  let rafId = null;
  let running = false;
  function tick() {
    if (!running) return;
    // mover la ventana a otro monitor cambia el DPR sin cambiar el tamano CSS: el ResizeObserver no avisa
    if (Math.min(window.devicePixelRatio || 1, 2) !== renderer.getPixelRatio()) resize();
    timer.update();
    const dt = Math.min(timer.getDelta(), 0.05);

    // Hover: el modelo gira bajo un cursor quieto, asi que se reevalua aunque no haya pointermove.
    const nowMs = performance.now();
    if (pointer.inside && !pressed && nowMs - lastRayAt >= HOVER_INTERVAL_MS) {
      lastRayAt = nowMs;
      setHover(!!castAt(pointer.x, pointer.y));
    }
    hold += ((hoverHit || holdExternal ? 1 : 0) - hold) * (1 - Math.exp(-dt * 7)); // frena y reanuda suave, sin tirones
    const hlTarget = hoverHit ? 1 : 0;
    if (highlight !== hlTarget) {
      highlight += (hlTarget - highlight) * (1 - Math.exp(-dt * 10));
      if (Math.abs(highlight - hlTarget) < 0.004) highlight = hlTarget;
      applyHighlight();
    }

    if (autoRotate) {
      rig.rotation.y += 0.12 * dt * (1 - hold);
    } else if (!dragging && Math.abs(velX) > 0.0002) {
      rig.rotation.y += velX;
      velX *= 0.92; // inercia, se apaga sola
    }
    ring.material.opacity = 0.28 + Math.sin(timer.getElapsed() * 1.6) * 0.08;
    stepInset(dt);
    projectAnchors(nowMs); // despues de girar el rig y mover la camara de este frame
    renderer.render(scene, camera);
    rafId = requestAnimationFrame(tick);
  }

  // Pausa/reanuda el bucle de render: con el visor fuera de vista (otra vista de ØPHS)
  // no se gasta GPU dibujando un canvas oculto.
  function setActive(on) {
    if (on === running) return;
    running = on;
    if (on) {
      timer.reset(); // descarta el tiempo en pausa, la primera dt no debe ser toda la pausa
      tick();
    } else {
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      // con el panel oculto el canvas no recibe pointerleave: sin esto el hover quedaria pegado al volver
      pointer.inside = false;
      setHover(false);
    }
  }
  setActive(true);

  // Punto y normal de superficie bajo un pixel, en coordenadas nativas del .glb (las que usa setAnchors).
  function pick(clientX, clientY) {
    const hit = castAt(clientX, clientY);
    if (!hit || !currentModel) return null;
    currentModel.updateWorldMatrix(true, false);
    const local = currentModel.worldToLocal(hit.point.clone());
    const inv = new THREE.Matrix4().copy(currentModel.matrixWorld).invert();
    const n = hit.face
      ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld).transformDirection(inv)
      : new THREE.Vector3(0, 1, 0);
    const r = (v) => Math.round(v * 1000) / 1000;
    return { position: [r(local.x), r(local.y), r(local.z)], normal: [r(n.x), r(n.y), r(n.z)], distance: r(hit.distance) };
  }

  function dispose() {
    setActive(false);
    clearModel();
    timer.dispose();
    ro.disconnect();
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
    window.removeEventListener('pointermove', onPointerMove);
    renderer.domElement.removeEventListener('pointerdown', onPointerDown);
    renderer.domElement.removeEventListener('pointerenter', onPointerEnter);
    renderer.domElement.removeEventListener('pointerleave', onPointerLeave);
    renderer.domElement.removeEventListener('wheel', onWheel);
    renderer.domElement.removeEventListener('webglcontextlost', onCtxLost);
    renderer.domElement.removeEventListener('webglcontextrestored', onCtxRestored);
    renderer.dispose();
    if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
  }

  onAutoRotate(autoRotate); // estado inicial (rotando) al boton de la UI

  return {
    loadModel,
    clearModel,
    dispose,
    setWireframe,
    setActive,
    resetView: () => {
      setAutoRotate(true);
      velX = 0;
      rig.rotation.set(0, 0, 0);
      Object.assign(view, home); // deshace tambien el zoom de la rueda y la inclinacion
      applyCamera();
    },
    toggleAutoRotate: () => { setAutoRotate(!autoRotate); return autoRotate; },
    setAutoRotate,
    setAnchors,
    pick,
    /** El HUD retiene la rotacion automatica mientras el cursor esta sobre un hotspot o el panel. */
    setHold: (on) => { holdExternal = !!on; },
    /** Margen (px) que el HUD ocupa a la derecha o abajo: el modelo se centra en el area libre. */
    setViewInset: ({ right = 0, bottom = 0 } = {}) => {
      inset.right = Math.max(0, right);
      inset.bottom = Math.max(0, bottom);
    },
  };
}
