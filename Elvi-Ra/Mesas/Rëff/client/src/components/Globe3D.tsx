import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { feature } from 'topojson-client';
import worldAtlas from 'world-atlas/countries-110m.json';
import type { GlobeCity } from '../lib/api';
import { STATUS_META, dominantStatus } from '../lib/status';

const GLOBE_RADIUS = 100;
const TEXTURE_WIDTH = 2048;
const TEXTURE_HEIGHT = 1024;

interface Props {
  cities: GlobeCity[];
  onHoverCity: (city: GlobeCity | null, screenX: number, screenY: number) => void;
}

function latLngToVector3(lat: number, lng: number, radius: number): THREE.Vector3 {
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lng + 180) * (Math.PI / 180);
  return new THREE.Vector3(
    -radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta),
  );
}

function buildWorldTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = TEXTURE_WIDTH;
  canvas.height = TEXTURE_HEIGHT;
  const ctx = canvas.getContext('2d')!;

  // Ocean: soft vertical gradient (deeper at poles) instead of flat fill.
  // Paleta oscura, a juego con el aura tecnologica del departamento.
  const ocean = ctx.createLinearGradient(0, 0, 0, TEXTURE_HEIGHT);
  ocean.addColorStop(0, '#060c14');
  ocean.addColorStop(0.5, '#0c1826');
  ocean.addColorStop(1, '#060c14');
  ctx.fillStyle = ocean;
  ctx.fillRect(0, 0, TEXTURE_WIDTH, TEXTURE_HEIGHT);

  // Subtle lat/long grid.
  ctx.strokeStyle = 'rgba(46, 230, 214, 0.10)';
  ctx.lineWidth = 1;
  for (let lng = -180; lng <= 180; lng += 20) {
    const x = ((lng + 180) / 360) * TEXTURE_WIDTH;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, TEXTURE_HEIGHT);
    ctx.stroke();
  }
  for (let lat = -80; lat <= 80; lat += 20) {
    const y = ((90 - lat) / 180) * TEXTURE_HEIGHT;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(TEXTURE_WIDTH, y);
    ctx.stroke();
  }

  // Country landmasses from world-atlas (Natural Earth 110m).
  const geo = feature(worldAtlas as any, (worldAtlas as any).objects.countries) as any;

  const project = (lng: number, lat: number): [number, number] => [
    ((lng + 180) / 360) * TEXTURE_WIDTH,
    ((90 - lat) / 180) * TEXTURE_HEIGHT,
  ];

  // Land fill: masa continental elevada sobre el oceano oscuro, con borde
  // de acento cian para que la costa lea como linea de datos, no como mapa.
  const land = ctx.createLinearGradient(0, 0, 0, TEXTURE_HEIGHT);
  land.addColorStop(0, '#1d2a33');
  land.addColorStop(0.5, '#27373f');
  land.addColorStop(1, '#1d2a33');
  ctx.fillStyle = land;
  ctx.strokeStyle = 'rgba(46, 230, 214, 0.55)';
  ctx.lineWidth = 1;

  for (const f of geo.features) {
    const polygons: number[][][][] =
      f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;

    for (const polygon of polygons) {
      for (const ring of polygon) {
        ctx.beginPath();
        ring.forEach(([lng, lat]: number[], i: number) => {
          const [x, y] = project(lng, lat);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// Specular map: oceans reflect light, land doesn't — this is what actually
// sells "realistic sphere" instead of a flat-shaded ball.
function buildSpecularTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = TEXTURE_WIDTH;
  canvas.height = TEXTURE_HEIGHT;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, TEXTURE_WIDTH, TEXTURE_HEIGHT);

  const geo = feature(worldAtlas as any, (worldAtlas as any).objects.countries) as any;
  const project = (lng: number, lat: number): [number, number] => [
    ((lng + 180) / 360) * TEXTURE_WIDTH,
    ((90 - lat) / 180) * TEXTURE_HEIGHT,
  ];

  ctx.fillStyle = '#000000';
  for (const f of geo.features) {
    const polygons: number[][][][] =
      f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const polygon of polygons) {
      for (const ring of polygon) {
        ctx.beginPath();
        ring.forEach(([lng, lat]: number[], i: number) => {
          const [x, y] = project(lng, lat);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.closePath();
        ctx.fill();
      }
    }
  }

  return new THREE.CanvasTexture(canvas);
}

export function Globe3D({ cities, onHoverCity }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const markersGroupRef = useRef<THREE.Group | null>(null);
  const markerMeshesRef = useRef<THREE.Mesh[]>([]);
  const controlsRef = useRef<OrbitControls | null>(null);
  const onHoverCityRef = useRef(onHoverCity);
  onHoverCityRef.current = onHoverCity;

  // One-time scene setup.
  useEffect(() => {
    const containerEl = containerRef.current;
    if (!containerEl) return;
    const container: HTMLDivElement = containerEl;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 2000);
    camera.position.set(0, 0, 340);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);

    // Globe sphere with generated world + specular textures.
    const texture = buildWorldTexture();
    const specularMap = buildSpecularTexture();
    const globeGeometry = new THREE.SphereGeometry(GLOBE_RADIUS, 96, 96);
    const globeMaterial = new THREE.MeshPhongMaterial({
      map: texture,
      specularMap,
      specular: 0x2ee6d6,
      shininess: 26,
    });
    const globe = new THREE.Mesh(globeGeometry, globeMaterial);
    scene.add(globe);

    // Inner rim-light shell: thin bright edge where the sphere curves away
    // from the camera, the cheapest trick for reading as a 3D volume.
    const rimGeometry = new THREE.SphereGeometry(GLOBE_RADIUS * 1.008, 96, 96);
    const rimMaterial = new THREE.MeshBasicMaterial({
      color: 0x2ee6d6,
      transparent: true,
      opacity: 0.22,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const rim = new THREE.Mesh(rimGeometry, rimMaterial);
    scene.add(rim);

    // Atmosphere glow.
    const glowGeometry = new THREE.SphereGeometry(GLOBE_RADIUS * 1.05, 64, 64);
    const glowMaterial = new THREE.MeshBasicMaterial({
      color: 0x2ee6d6,
      transparent: true,
      opacity: 0.11,
      side: THREE.BackSide,
    });
    const glow = new THREE.Mesh(glowGeometry, glowMaterial);
    scene.add(glow);

    // Lighting: single warm key light + soft ambient fill reads as a sunlit
    // sphere instead of the flat, shadowless look a high ambient-only setup gives.
    scene.add(new THREE.AmbientLight(0x8fb4c4, 0.34));
    const dirLight = new THREE.DirectionalLight(0xeaf6ff, 1.15);
    dirLight.position.set(220, 160, 180);
    scene.add(dirLight);
    const fillLight = new THREE.DirectionalLight(0x2ee6d6, 0.34);
    fillLight.position.set(-200, -80, -160);
    scene.add(fillLight);

    // City markers group (populated by the cities effect below).
    const markersGroup = new THREE.Group();
    scene.add(markersGroup);
    markersGroupRef.current = markersGroup;

    // Controls.
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 200;
    controls.maxDistance = 500;
    controls.rotateSpeed = 0.4;
    controls.zoomSpeed = 0.6;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.35;
    controlsRef.current = controls;

    // Raycaster for hover.
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let hovered: GlobeCity | null = null;

    function onPointerMove(event: PointerEvent) {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(pointer, camera);
      const intersects = raycaster.intersectObjects(markerMeshesRef.current, false);

      if (intersects.length > 0) {
        const city = intersects[0].object.userData.city as GlobeCity;
        controls.autoRotate = false;
        hovered = city;
        onHoverCityRef.current(city, event.clientX, event.clientY);
      } else {
        if (hovered) {
          hovered = null;
          onHoverCityRef.current(null, 0, 0);
        }
        controls.autoRotate = true;
      }
    }

    function onPointerLeave() {
      hovered = null;
      onHoverCityRef.current(null, 0, 0);
      controls.autoRotate = true;
    }

    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerleave', onPointerLeave);

    // Resize handling.
    function handleResize() {
      camera.aspect = container.clientWidth / container.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(container.clientWidth, container.clientHeight);
    }
    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(container);

    // Render loop.
    let frameId: number;
    let clock = 0;
    function animate() {
      frameId = requestAnimationFrame(animate);
      clock += 0.02;
      controls.update();

      for (const obj of markersGroupRef.current?.children ?? []) {
        const pulse = obj.userData.pulse as { speed: number; minScale: number; maxScale: number; minOpacity: number; maxOpacity: number } | undefined;
        if (pulse) {
          const t = (Math.sin(clock * pulse.speed) + 1) / 2;
          const scale = pulse.minScale + (pulse.maxScale - pulse.minScale) * t;
          obj.scale.set(scale, scale, scale);
          const mat = (obj as THREE.Mesh).material as THREE.MeshBasicMaterial;
          mat.opacity = pulse.minOpacity + (pulse.maxOpacity - pulse.minOpacity) * t;
        }
        const spin = obj.userData.spin as number | undefined;
        if (spin) {
          obj.rotateOnWorldAxis(obj.userData.spinAxis as THREE.Vector3, spin);
        }
      }

      renderer.render(scene, camera);
    }
    animate();

    return () => {
      cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerleave', onPointerLeave);
      controls.dispose();
      renderer.dispose();
      globeGeometry.dispose();
      globeMaterial.dispose();
      rimGeometry.dispose();
      rimMaterial.dispose();
      glowGeometry.dispose();
      glowMaterial.dispose();
      texture.dispose();
      specularMap.dispose();
      for (const m of markerMeshesRef.current) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
      markerMeshesRef.current = [];
      markersGroupRef.current = null;
      container.removeChild(renderer.domElement);
    };
  }, []);

  // Rebuild markers whenever `cities` changes, without recreating the scene.
  useEffect(() => {
    const markersGroup = markersGroupRef.current;
    if (!markersGroup) return;

    for (const m of markerMeshesRef.current) {
      markersGroup.remove(m);
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    markerMeshesRef.current = [];

    for (const city of cities) {
      const statuses = city.companies.map((c) => c.status);
      const color = STATUS_META[dominantStatus(statuses)].color;
      const normal = latLngToVector3(city.lat, city.lng, 1).normalize();
      const pos = normal.clone().multiplyScalar(GLOBE_RADIUS + 0.6);

      // Core node: small bright sphere, the actual hover target. Kept a bit
      // larger than pure visual scale would suggest so hover stays reliable
      // once many cities are packed close together.
      const coreGeometry = new THREE.SphereGeometry(0.6, 16, 16);
      const coreMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });
      const core = new THREE.Mesh(coreGeometry, coreMaterial);
      core.position.copy(normal.clone().multiplyScalar(GLOBE_RADIUS + 0.9));
      core.userData.city = city;
      markersGroup.add(core);
      markerMeshesRef.current.push(core);

      // Invisible padded hit-sphere: keeps raycast hover forgiving even
      // though the visible core is now tiny — without inflating the marker.
      const hitGeometry = new THREE.SphereGeometry(1.6, 8, 8);
      const hitMaterial = new THREE.MeshBasicMaterial({ visible: false });
      const hitArea = new THREE.Mesh(hitGeometry, hitMaterial);
      hitArea.position.copy(core.position);
      hitArea.userData.city = city;
      markersGroup.add(hitArea);
      markerMeshesRef.current.push(hitArea);

      // Inner halo: tight, bright, additive glow around the core.
      const haloGeometry = new THREE.SphereGeometry(1.1, 16, 16);
      const haloMaterial = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.6,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const halo = new THREE.Mesh(haloGeometry, haloMaterial);
      halo.position.copy(core.position);
      halo.userData.city = city;
      markersGroup.add(halo);
      markerMeshesRef.current.push(halo);

      // Vertical beam: thin emissive pillar rising from the surface, HUD-style.
      const beamHeight = 3;
      const beamGeometry = new THREE.CylinderGeometry(0.09, 0.03, beamHeight, 6, 1, true);
      beamGeometry.translate(0, beamHeight / 2, 0);
      const beamMaterial = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.7,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const beam = new THREE.Mesh(beamGeometry, beamMaterial);
      beam.position.copy(normal.clone().multiplyScalar(GLOBE_RADIUS));
      beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
      beam.userData.city = city;
      markersGroup.add(beam);
      markerMeshesRef.current.push(beam);

      // Inner ring: crisp scanner ring flat against the surface.
      const innerRingGeometry = new THREE.RingGeometry(0.85, 1.05, 24);
      const innerRingMaterial = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, side: THREE.DoubleSide });
      const innerRing = new THREE.Mesh(innerRingGeometry, innerRingMaterial);
      innerRing.position.copy(core.position);
      innerRing.lookAt(core.position.clone().add(normal));
      innerRing.userData.city = city;
      markersGroup.add(innerRing);
      markerMeshesRef.current.push(innerRing);

      // Outer pulsing ring: radar-sweep style, animates scale + opacity.
      const outerRingGeometry = new THREE.RingGeometry(1.25, 1.5, 24);
      const outerRingMaterial = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.5,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const outerRing = new THREE.Mesh(outerRingGeometry, outerRingMaterial);
      outerRing.position.copy(core.position);
      outerRing.lookAt(core.position.clone().add(normal));
      outerRing.userData.city = city;
      outerRing.userData.pulse = { speed: 1.6, minScale: 1, maxScale: 2.2, minOpacity: 0.5, maxOpacity: 0 };
      markersGroup.add(outerRing);
      markerMeshesRef.current.push(outerRing);
    }
  }, [cities]);

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
}
