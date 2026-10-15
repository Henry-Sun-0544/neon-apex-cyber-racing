import * as THREE from 'three';

/**
 * Procedural low-poly racing car.
 *
 * All parts are generated from primitives, sharing a couple of materials per
 * car, so an 6-car grid costs ~6 * 8 meshes and a handful of programs.
 */

export interface WheelRig {
  /** Steering pivot (rotate around Y). */
  steer: THREE.Group;
  /** Rolling pivot (rotate around X, the axle). */
  spin: THREE.Group;
  /** True for the front wheels (they steer + visibly pitch). */
  front: boolean;
  baseY: number;
}

export interface CarModel {
  group: THREE.Group;
  wheels: WheelRig[];
  /** Nozzles that emit nitro / exhaust particles. */
  exhausts: THREE.Object3D[];
  underglow: THREE.Mesh;
  brakeMaterial: THREE.MeshBasicMaterial;
  headlightMaterial: THREE.MeshBasicMaterial;
  headlight: THREE.SpotLight | null;
  /** Materials that receive the car's accent colour (for flicker/pulse). */
  accentMaterials: THREE.Material[];
}

export interface CarStyle {
  bodyColor: number;
  accentColor: number;
  /** Player gets extra lights and a brighter underglow. */
  isPlayer: boolean;
}

/** Tapers a BoxGeometry so the front/back ends are narrower (wedge hull). */
function taperBox(geo: THREE.BoxGeometry, frontScale: number, backScale: number): THREE.BoxGeometry {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const params = geo.parameters as { width: number; height: number; depth: number };
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const factor = z > 0 ? frontScale : backScale;
    pos.setX(i, x * factor);
    // Scale about the bottom face so the car keeps a flat underside.
    pos.setY(i, (y + params.height / 2) * factor - params.height / 2);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/** Soft radial sprite used by the under-glow plane and particles. */
export function createGlowTexture(inner = 'rgba(255,255,255,1)', outer = 'rgba(255,255,255,0)'): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const ctx = c.getContext('2d')!;
  const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, inner);
  grad.addColorStop(0.35, inner);
  grad.addColorStop(1, outer);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createCarModel(style: CarStyle): CarModel {
  const group = new THREE.Group();
  const accent = new THREE.Color(style.accentColor);
  const body = new THREE.Color(style.bodyColor);

  const bodyMat = new THREE.MeshStandardMaterial({
    color: body,
    metalness: 0.72,
    roughness: 0.28,
    emissive: accent.clone().multiplyScalar(0.16),
    emissiveIntensity: 0.9,
  });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x0b0a14, metalness: 0.85, roughness: 0.35 });
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x090a1a,
    metalness: 0.95,
    roughness: 0.06,
    emissive: accent.clone().multiplyScalar(0.32),
    emissiveIntensity: 1.1,
  });
  const accentMat = new THREE.MeshBasicMaterial({ color: accent, toneMapped: false });
  const accentDim = new THREE.MeshBasicMaterial({ color: accent.clone().multiplyScalar(0.55), toneMapped: false });
  const headlightMaterial = new THREE.MeshBasicMaterial({ color: 0xeaf6ff, toneMapped: false });
  const brakeMaterial = new THREE.MeshBasicMaterial({ color: 0xff2b4d, toneMapped: false });

  // ------------------------------------------------------------- hull
  const hull = new THREE.Mesh(taperBox(new THREE.BoxGeometry(2.05, 0.55, 4.5), 0.78, 0.94), bodyMat);
  hull.position.y = 0.34;
  group.add(hull);

  const canopy = new THREE.Mesh(taperBox(new THREE.BoxGeometry(1.42, 0.52, 2.3), 0.6, 0.92), glassMat);
  canopy.position.set(0, 0.86, -0.15);
  group.add(canopy);

  const nose = new THREE.Mesh(taperBox(new THREE.BoxGeometry(1.72, 0.32, 1.7), 0.46, 1.0), bodyMat);
  nose.position.set(0, 0.52, 1.6);
  group.add(nose);

  // Front splitter + rear diffuser (dark trims)
  const splitter = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.09, 0.75), darkMat);
  splitter.position.set(0, 0.14, 2.28);
  group.add(splitter);
  const diffuser = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.22, 0.7), darkMat);
  diffuser.position.set(0, 0.22, -2.24);
  group.add(diffuser);

  // Rear wing
  const wing = new THREE.Mesh(new THREE.BoxGeometry(1.95, 0.1, 0.62), bodyMat);
  wing.position.set(0, 1.06, -2.0);
  wing.rotation.x = -0.09;
  group.add(wing);
  for (const x of [-0.78, 0.78]) {
    const support = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.5, 0.4), darkMat);
    support.position.set(x, 0.82, -2.0);
    group.add(support);
  }
  const wingNeon = new THREE.Mesh(new THREE.BoxGeometry(1.99, 0.06, 0.68), accentMat);
  wingNeon.position.set(0, 1.12, -2.0);
  group.add(wingNeon);

  // Side neon skirts (the strongest "cyber" read on the silhouette)
  for (const x of [-1.0, 1.0]) {
    const skirt = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.1, 3.3), accentMat);
    skirt.position.set(x, 0.17, 0.1);
    group.add(skirt);
    const fin = new THREE.Mesh(taperBox(new THREE.BoxGeometry(0.2, 0.34, 1.4), 0.5, 0.9), accentDim);
    fin.position.set(x * 1.02, 0.42, -1.2);
    group.add(fin);
  }

  // Engine intake + vents
  const intake = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.26, 0.6), darkMat);
  intake.position.set(0, 0.98, -1.35);
  group.add(intake);
  for (let i = 0; i < 3; i++) {
    const vent = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.06, 0.16), accentDim);
    vent.position.set(0, 0.62, -0.9 - i * 0.28);
    group.add(vent);
  }

  // Head- and tail-lights
  for (const x of [-0.62, 0.62]) {
    const light = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.13, 0.1), headlightMaterial);
    light.position.set(x, 0.55, 2.42);
    group.add(light);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.16, 0.1), brakeMaterial);
    tail.position.set(x, 0.62, -2.42);
    group.add(tail);
  }

  // Exhaust nozzles (particle anchors)
  const exhausts: THREE.Object3D[] = [];
  for (const x of [-0.44, 0.44]) {
    const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 0.4, 10), darkMat);
    nozzle.rotation.x = Math.PI / 2;
    nozzle.position.set(x, 0.42, -2.32);
    group.add(nozzle);
    const anchor = new THREE.Object3D();
    anchor.position.set(x, 0.42, -2.58);
    group.add(anchor);
    exhausts.push(anchor);
  }

  // Under-glow projected on the road
  const glowTex = createGlowTexture();
  const underglow = new THREE.Mesh(
    new THREE.PlaneGeometry(3.4, 5.6),
    new THREE.MeshBasicMaterial({
      map: glowTex,
      color: accent,
      transparent: true,
      opacity: style.isPlayer ? 0.85 : 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  underglow.rotation.x = -Math.PI / 2;
  underglow.position.y = 0.06;
  group.add(underglow);

  // ------------------------------------------------------------ wheels
  const wheels: WheelRig[] = [];
  const tireGeo = new THREE.CylinderGeometry(0.44, 0.44, 0.36, 14);
  const rimGeo = new THREE.CylinderGeometry(0.26, 0.26, 0.38, 10);
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x121118, roughness: 0.95, metalness: 0.1 });
  const rimMat = new THREE.MeshStandardMaterial({
    color: 0x9aa4c8,
    metalness: 0.9,
    roughness: 0.25,
    emissive: accent.clone().multiplyScalar(0.5),
    emissiveIntensity: 0.7,
  });
  const hubMat = new THREE.MeshBasicMaterial({ color: accent, toneMapped: false });
  const wheelPositions: Array<[number, number, boolean]> = [
    [-0.98, 1.45, true],
    [0.98, 1.45, true],
    [-1.02, -1.5, false],
    [1.02, -1.5, false],
  ];
  for (const [x, z, front] of wheelPositions) {
    const steer = new THREE.Group();
    steer.position.set(x, 0.44, z);
    const spin = new THREE.Group();
    const tire = new THREE.Mesh(tireGeo, tireMat);
    tire.rotation.z = Math.PI / 2;
    const rim = new THREE.Mesh(rimGeo, rimMat);
    rim.rotation.z = Math.PI / 2;
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.4, 6), hubMat);
    hub.rotation.z = Math.PI / 2;
    spin.add(tire, rim, hub);
    steer.add(spin);
    group.add(steer);
    wheels.push({ steer, spin, front, baseY: 0.44 });
  }

  // ------------------------------------------------------- headlights
  let headlight: THREE.SpotLight | null = null;
  if (style.isPlayer) {
    headlight = new THREE.SpotLight(0xbfe6ff, 220, 70, Math.PI / 6.5, 0.45, 1.6);
    headlight.position.set(0, 0.6, 2.2);
    headlight.target.position.set(0, -0.4, 24);
    group.add(headlight, headlight.target);
  }

  return { group, wheels, exhausts, underglow, brakeMaterial, headlightMaterial, headlight, accentMaterials: [accentMat, accentDim] };
}
