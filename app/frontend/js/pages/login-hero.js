// ---- Hero: distorted chrome sphere, three.js (sovereign local vendor) ----
(async function hero() {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const canvas = document.getElementById('heroCanvas');
  if (reduced) return;

  let THREE;
  try {
    THREE = await import('/vendor/three.module.min.js');
  } catch {
    return;
  }

  const host = canvas.parentElement;
  let w = host.clientWidth, h = host.clientHeight;

  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w, h, false);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, w / h, 0.1, 100);
  camera.position.set(0, 0, 5.2);

  // Key + rim lights for a soft chrome/glass read without an HDR environment map
  scene.add(new THREE.AmbientLight(0x8fa8a2, 0.55));
  const key = new THREE.DirectionalLight(0xffffff, 1.4);
  key.position.set(3, 4, 5);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x3dffd2, 1.1);
  rim.position.set(-4, -2, -3);
  scene.add(rim);
  const rim2 = new THREE.DirectionalLight(0x0098c7, 0.6);
  rim2.position.set(2, -3, 2);
  scene.add(rim2);

  // Base geometry — icosphere, displaced per-vertex with layered noise for an organic,
  // liquid-metal silhouette (snficorp.com hero reference) instead of a plain sphere.
  const geo = new THREE.IcosahedronGeometry(1.35, 24);
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  const base = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    base[i * 3] = v.x; base[i * 3 + 1] = v.y; base[i * 3 + 2] = v.z;
  }

  function noise3(x, y, z, t) {
    return (
      Math.sin(x * 1.8 + t) * Math.cos(y * 1.6 - t * 0.7) +
      Math.sin(y * 2.4 - t * 0.5) * Math.cos(z * 2.0 + t * 0.9) +
      Math.sin(z * 1.5 + t * 1.1) * Math.cos(x * 2.2 - t * 0.6)
    ) / 3;
  }

  const material = new THREE.MeshPhysicalMaterial({
    color: 0xc8ccd0,
    metalness: 0.92,
    roughness: 0.18,
    clearcoat: 0.6,
    clearcoatRoughness: 0.25,
    reflectivity: 1,
    envMapIntensity: 1.1,
  });
  const mesh = new THREE.Mesh(geo, material);
  scene.add(mesh);

  // Faint wireframe shell for depth, matching the dashboard sphere's language
  const wire = new THREE.LineSegments(
    new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(1.62, 2)),
    new THREE.LineBasicMaterial({ color: 0x3dffd2, transparent: true, opacity: 0.14 })
  );
  scene.add(wire);

  let mx = 0, my = 0, tmx = 0, tmy = 0;
  window.addEventListener('mousemove', (e) => {
    const r = host.getBoundingClientRect();
    tmx = ((e.clientX - r.left) / r.width - 0.5) * 0.5;
    tmy = ((e.clientY - r.top) / r.height - 0.5) * 0.5;
  }, { passive: true });

  function resize() {
    w = host.clientWidth; h = host.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);

  let running = true;
  document.addEventListener('visibilitychange', () => { running = !document.hidden; });

  function frame(t) {
    requestAnimationFrame(frame);
    if (!running) return;
    const time = t * 0.00035;

    for (let i = 0; i < pos.count; i++) {
      const bx = base[i * 3], by = base[i * 3 + 1], bz = base[i * 3 + 2];
      const n = noise3(bx, by, bz, time);
      const disp = 1 + n * 0.10;
      pos.setXYZ(i, bx * disp, by * disp, bz * disp);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();

    mx += (tmx - mx) * 0.04;
    my += (tmy - my) * 0.04;
    mesh.rotation.y = time * 0.6 + mx;
    mesh.rotation.x = my * 0.6;
    wire.rotation.y = -time * 0.35 + mx * 0.5;
    wire.rotation.x = time * 0.2 + my * 0.5;

    renderer.render(scene, camera);
  }
  requestAnimationFrame(frame);
})();
