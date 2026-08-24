// Animated tech-office background for the SYSTEMS dashboard.
// Light-theme friendly: faint perspective grid + rack silhouettes + blinking LEDs.
// Zero dependencies, pauses when the tab is hidden or reduced motion is set.

export function mountOfficeBg(target = document.body, { opacity = 0.16 } = {}) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return null;

  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.cssText = `position:fixed;inset:0;width:100%;height:100%;z-index:0;pointer-events:none;opacity:${opacity};`;
  target.prepend(canvas);

  const ctx = canvas.getContext('2d');
  let W = 0, H = 0;

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  window.addEventListener('resize', resize);

  const leds = Array.from({ length: 46 }, () => ({
    u: Math.random(), v: Math.random(),
    phase: Math.random() * Math.PI * 2,
    spd: 0.4 + Math.random() * 2,
    cyan: Math.random() > 0.7,
  }));

  let running = true;
  document.addEventListener('visibilitychange', () => { running = !document.hidden; });

  function frame(time) {
    requestAnimationFrame(frame);
    if (!running) return;
    ctx.clearRect(0, 0, W, H);

    const horizon = H * 0.58;
    const vpx = W / 2;

    // Perspective floor grid (dark strokes, very low alpha for light theme)
    ctx.strokeStyle = 'rgba(15,40,45,0.35)';
    ctx.lineWidth = 1;
    for (let i = -12; i <= 12; i++) {
      ctx.beginPath();
      ctx.moveTo(vpx, horizon);
      ctx.lineTo(vpx + i * W * 0.13, H + 40);
      ctx.stroke();
    }
    const scroll = (time * 0.00009) % 1;
    for (let r = 0; r < 12; r++) {
      const p = (r + scroll) / 12;
      const y = horizon + Math.pow(p, 2.2) * (H - horizon);
      ctx.globalAlpha = 0.10 + p * 0.30;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Rack / console silhouettes flanking the hall
    function rack(cx, w0, hRatio) {
      const top = horizon - H * hRatio;
      ctx.fillStyle = 'rgba(15,35,40,0.22)';
      ctx.fillRect(cx - w0 / 2, top, w0, horizon - top + 4);
      ctx.strokeStyle = 'rgba(15,40,45,0.30)';
      ctx.strokeRect(cx - w0 / 2, top, w0, horizon - top + 4);
    }
    rack(W * 0.08, W * 0.07, 0.20);
    rack(W * 0.19, W * 0.05, 0.13);
    rack(W * 0.92, W * 0.07, 0.20);
    rack(W * 0.81, W * 0.05, 0.13);

    // Blinking LEDs (theme accents)
    const zones = [[0.05, 0.115], [0.165, 0.215], [0.885, 0.955], [0.785, 0.835]];
    for (const l of leds) {
      const z = zones[Math.floor(l.u * zones.length) % zones.length];
      const x = W * (z[0] + (z[1] - z[0]) * ((l.u * 7.13) % 1));
      const y = horizon - H * 0.18 * l.v - 4;
      const blink = 0.5 + 0.5 * Math.sin(time * 0.001 * l.spd + l.phase);
      ctx.fillStyle = l.cyan
        ? `rgba(0,120,170,${0.25 + blink * 0.5})`
        : `rgba(0,140,100,${0.25 + blink * 0.5})`;
      ctx.fillRect(x, y, 2.5, 2.5);
    }
  }
  requestAnimationFrame(frame);
  return canvas;
}

// Orbital 3D sphere background (ported from the original login hero).
// Uses the sovereign local three.js vendor build — no CDN.
export async function mountSphereBg(target = document.body, { opacity = 0.45 } = {}) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return null;

  let THREE;
  try {
    THREE = await import('/vendor/three.module.min.js');
  } catch {
    return null;
  }

  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.cssText = `position:fixed;inset:0;width:100%;height:100%;z-index:0;pointer-events:none;opacity:${opacity};`;
  target.prepend(canvas);

  let w = window.innerWidth;
  let h = window.innerHeight;
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w, h, false);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 100);
  camera.position.z = 4.2;

  const sphereFill = new THREE.Mesh(
    new THREE.IcosahedronGeometry(1.0, 4),
    new THREE.MeshBasicMaterial({ color: 0x0071e3, transparent: true, opacity: 0.08 })
  );
  scene.add(sphereFill);

  const wire = new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(1.0, 3));
  const mesh = new THREE.LineSegments(
    wire,
    new THREE.LineBasicMaterial({ color: 0x0068d1, transparent: true, opacity: 0.85 })
  );
  scene.add(mesh);

  const core = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.45, 1),
    new THREE.MeshBasicMaterial({ color: 0x0098c7, wireframe: true, transparent: true, opacity: 0.65 })
  );
  scene.add(core);

  const PTS = 420;
  const positions = new Float32Array(PTS * 3);
  for (let i = 0; i < PTS; i++) {
    const r = 1.25 + Math.random() * 0.5;
    const t = Math.random() * Math.PI * 2;
    const p = Math.acos(2 * Math.random() - 1);
    positions[i * 3]     = r * Math.sin(p) * Math.cos(t);
    positions[i * 3 + 1] = r * Math.sin(p) * Math.sin(t);
    positions[i * 3 + 2] = r * Math.cos(p);
  }
  const ptsGeo = new THREE.BufferGeometry();
  ptsGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const points = new THREE.Points(
    ptsGeo,
    new THREE.PointsMaterial({ color: 0x0058b0, size: 0.022, transparent: true, opacity: 1.0 })
  );
  scene.add(points);

  function makeRing(rIn, rOut, ringOpacity, color, rotX, rotY) {
    const r = new THREE.Mesh(
      new THREE.RingGeometry(rIn, rOut, 128),
      new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: ringOpacity })
    );
    r.rotation.x = rotX;
    r.rotation.y = rotY;
    return r;
  }
  const ring1 = makeRing(1.32, 1.34, 0.55, 0x0071e3, Math.PI / 2.3, 0);
  const ring2 = makeRing(1.45, 1.46, 0.35, 0x0098c7, Math.PI / 2.8, Math.PI / 6);
  const ring3 = makeRing(1.60, 1.605, 0.25, 0x0068d1, Math.PI / 1.9, -Math.PI / 8);
  scene.add(ring1); scene.add(ring2); scene.add(ring3);

  let mx = 0, my = 0, tmx = 0, tmy = 0;
  window.addEventListener('mousemove', e => {
    tmx = (e.clientX / window.innerWidth  - 0.5) * 0.6;
    tmy = (e.clientY / window.innerHeight - 0.5) * 0.6;
  }, { passive: true });

  function resize() {
    w = window.innerWidth;
    h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);

  let running = true;
  document.addEventListener('visibilitychange', () => { running = !document.hidden; });

  function frame(t) {
    if (running) {
      mx += (tmx - mx) * 0.05;
      my += (tmy - my) * 0.05;
      sphereFill.rotation.y = t * 0.00018 + mx;
      sphereFill.rotation.x = t * 0.00012 + my;
      mesh.rotation.y = t * 0.00018 + mx;
      mesh.rotation.x = t * 0.00012 + my;
      core.rotation.y = -t * 0.0004;
      core.rotation.x =  t * 0.00025;
      points.rotation.y =  t * 0.00009 + mx * 0.5;
      points.rotation.x = -t * 0.00006 + my * 0.5;
      ring1.rotation.z =  t * 0.00020;
      ring2.rotation.z = -t * 0.00015;
      ring3.rotation.z =  t * 0.00012;
      renderer.render(scene, camera);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  return canvas;
}

// Entrance handoff from the login descent: dark overlay at 80% that lifts off.
export function playSystemsEntry() {
  if (!sessionStorage.getItem('systemsEntry')) return;
  sessionStorage.removeItem('systemsEntry');
  const ov = document.createElement('div');
  ov.setAttribute('aria-hidden', 'true');
  ov.style.cssText = 'position:fixed;inset:0;background:#04070b;opacity:0.8;z-index:999;pointer-events:none;transition:opacity 1.2s ease;';
  document.body.appendChild(ov);
  requestAnimationFrame(() => requestAnimationFrame(() => { ov.style.opacity = '0'; }));
  setTimeout(() => ov.remove(), 1500);
}
