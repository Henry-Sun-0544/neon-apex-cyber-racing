import * as THREE from 'three';
import type { ChassisId } from './Config';

/**
 * Procedural low-poly racing cars.
 *
 * Four chassis silhouettes are built from primitives: a balanced concept
 * prototype, a wide muscle car (Hellcat-inspired), a low sports coupe
 * (GT-R-inspired) and a tall one-box SUV (Model Y-inspired). All variants
 * share the material set, wheel rig layout and light/exhaust anchors, so a
 * 6-car grid stays cheap and every system (particles, HUD, collisions) keeps
 * working regardless of the body the player picks.
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
  /** Which of the four garage bodies to build. */
  chassis: ChassisId;
  /**
   * Active game style. Realistic cars drop the neon underglow, use clear-coated
   * paint with real glass and keep every light as a warm/white lamp instead of
   * a saturated neon emitter.
   */
  theme?: 'cyberpunk' | 'realistic';
}

/** Per-wheel placement + sizing, filled in by each chassis builder. */
interface WheelSpec {
  x: number;
  z: number;
  front: boolean;
  /** Tyre width (rear wheels can be wider, e.g. muscle car). */
  width: number;
  /** Flat aero disc rim (SUV) instead of spokes. */
  aero?: boolean;
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

/** Frees every geometry/material of a built model (used when swapping cars). */
export function disposeCarModel(model: CarModel): void {
  model.group.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.geometry.dispose();
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        // Materials owned by the material library are shared across every car.
        if (m.userData.__shared === true) continue;
        m.dispose();
      }
    }
  });
}

/** Shared material palette for one car (colours differ per car, not per part). */
interface CarMaterials {
  bodyMat: THREE.Material;
  darkMat: THREE.Material;
  glassMat: THREE.Material;
  accentMat: THREE.Material;
  accentDim: THREE.Material;
  headlightMaterial: THREE.MeshBasicMaterial;
  brakeMaterial: THREE.MeshBasicMaterial;
}

/** Adds a small box helper. */
function box(
  group: THREE.Group,
  w: number,
  h: number,
  d: number,
  mat: THREE.Material,
  x: number,
  y: number,
  z: number,
  rotX = 0,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  mesh.position.set(x, y, z);
  mesh.rotation.x = rotX;
  group.add(mesh);
  return mesh;
}

/**
 * Exhaust / vent anchors. Cylinder nozzles point backwards; `count` and
 * spacing let each chassis place singles, twins or quads. Returns the
 * particle anchors (offset just behind the bumper).
 */
function addExhausts(group: THREE.Group, darkMat: THREE.Material, xs: number[], y: number, z: number): THREE.Object3D[] {
  const anchors: THREE.Object3D[] = [];
  for (const x of xs) {
    const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.16, 0.34, 10), darkMat);
    nozzle.rotation.x = Math.PI / 2;
    nozzle.position.set(x, y, z);
    group.add(nozzle);
    const anchor = new THREE.Object3D();
    anchor.position.set(x, y, z - 0.26);
    group.add(anchor);
    anchors.push(anchor);
  }
  return anchors;
}

// =========================================================== chassis builds

/** CONCEPT-X — balanced prototype, now with aero detailing. */
function buildConcept(group: THREE.Group, m: CarMaterials): { wheels: WheelSpec[]; exhausts: THREE.Object3D[] } {
  const hull = new THREE.Mesh(taperBox(new THREE.BoxGeometry(2.05, 0.55, 4.5), 0.78, 0.94), m.bodyMat);
  hull.position.y = 0.34;
  group.add(hull);

  const canopy = new THREE.Mesh(taperBox(new THREE.BoxGeometry(1.42, 0.52, 2.3), 0.6, 0.92), m.glassMat);
  canopy.position.set(0, 0.86, -0.15);
  group.add(canopy);

  const nose = new THREE.Mesh(taperBox(new THREE.BoxGeometry(1.72, 0.32, 1.7), 0.46, 1.0), m.bodyMat);
  nose.position.set(0, 0.52, 1.6);
  group.add(nose);

  box(group, 2.0, 0.09, 0.75, m.darkMat, 0, 0.14, 2.28); // splitter
  const diffuser = box(group, 1.9, 0.22, 0.7, m.darkMat, 0, 0.22, -2.24);
  // Diffuser strakes: vertical fins under the tail for the aero look.
  for (const x of [-0.55, 0, 0.55]) box(group, 0.06, 0.16, 0.5, m.accentDim, x, 0.13, -2.28);

  // Rear wing with endplates.
  box(group, 1.95, 0.1, 0.62, m.bodyMat, 0, 1.06, -2.0, -0.09);
  for (const x of [-0.98, 0.98]) box(group, 0.06, 0.18, 0.66, m.darkMat, x, 1.02, -2.0);
  for (const x of [-0.78, 0.78]) box(group, 0.12, 0.5, 0.4, m.darkMat, x, 0.82, -2.0);
  box(group, 1.99, 0.06, 0.68, m.accentMat, 0, 1.12, -2.0, -0.09); // wing neon edge

  // Hood heat vents.
  for (const x of [-0.32, 0.32]) box(group, 0.42, 0.05, 0.34, m.darkMat, x, 0.63, 1.12);
  // Roof antenna fin.
  box(group, 0.05, 0.2, 0.5, m.accentDim, 0, 1.2, -0.62);

  // Side skirts: double blade (upper accent + lower dim).
  for (const x of [-1.0, 1.0]) {
    box(group, 0.14, 0.1, 3.3, m.accentMat, x, 0.17, 0.1);
    box(group, 0.1, 0.06, 2.9, m.accentDim, x * 1.02, 0.09, 0.1);
    const fin = new THREE.Mesh(taperBox(new THREE.BoxGeometry(0.2, 0.34, 1.4), 0.5, 0.9), m.accentDim);
    fin.position.set(x * 1.02, 0.42, -1.2);
    group.add(fin);
  }

  // Engine vents behind the canopy.
  box(group, 1.0, 0.26, 0.6, m.darkMat, 0, 0.98, -1.35);
  for (let i = 0; i < 3; i++) box(group, 0.62, 0.06, 0.16, m.accentDim, 0, 0.62, -0.9 - i * 0.28);

  // Lights + connecting light bar.
  for (const x of [-0.62, 0.62]) {
    box(group, 0.5, 0.13, 0.1, m.headlightMaterial, x, 0.55, 2.42);
    box(group, 0.46, 0.16, 0.1, m.brakeMaterial, x, 0.62, -2.42);
  }
  box(group, 0.62, 0.05, 0.08, m.headlightMaterial, 0, 0.55, 2.43);

  return {
    wheels: [
      { x: -0.98, z: 1.45, front: true, width: 0.36 },
      { x: 0.98, z: 1.45, front: true, width: 0.36 },
      { x: -1.02, z: -1.5, front: false, width: 0.36 },
      { x: 1.02, z: -1.5, front: false, width: 0.36 },
    ],
    exhausts: addExhausts(group, m.darkMat, [-0.44, 0.44], 0.42, -2.32),
  };
}

/** HELLCAT — wide-shouldered muscle car: scoop, ducktail, quad pipes. */
function buildMuscle(group: THREE.Group, m: CarMaterials): { wheels: WheelSpec[]; exhausts: THREE.Object3D[] } {
  const hull = new THREE.Mesh(taperBox(new THREE.BoxGeometry(2.3, 0.62, 4.6), 0.88, 0.98), m.bodyMat);
  hull.position.y = 0.38;
  group.add(hull);

  const canopy = new THREE.Mesh(taperBox(new THREE.BoxGeometry(1.5, 0.5, 1.9), 0.78, 0.92), m.glassMat);
  canopy.position.set(0, 0.95, -0.25);
  group.add(canopy);

  const nose = new THREE.Mesh(taperBox(new THREE.BoxGeometry(1.95, 0.4, 1.2), 0.72, 1.0), m.bodyMat);
  nose.position.set(0, 0.5, 1.75);
  group.add(nose);

  // Functional-looking hood scoop with an open mouth.
  box(group, 0.85, 0.16, 0.72, m.darkMat, 0, 0.72, 1.28);
  box(group, 0.6, 0.05, 0.14, m.accentMat, 0, 0.81, 1.58);

  // Wide dark grille + splitter.
  box(group, 1.4, 0.24, 0.1, m.darkMat, 0, 0.42, 2.32);
  box(group, 2.2, 0.1, 0.8, m.darkMat, 0, 0.16, 2.3);
  box(group, 1.42, 0.04, 0.06, m.accentMat, 0, 0.55, 2.35);

  // Ducktail spoiler instead of a wing.
  box(group, 2.0, 0.08, 0.5, m.bodyMat, 0, 0.8, -2.12, 0.2);
  box(group, 2.02, 0.05, 0.12, m.accentMat, 0, 0.88, -2.3, 0.2);

  // Classic dual racing stripes over hood and deck.
  for (const x of [-0.24, 0.24]) {
    box(group, 0.16, 0.03, 1.9, m.accentDim, x, 0.695, 1.1);
    box(group, 0.16, 0.03, 1.2, m.accentDim, x, 0.7, -1.6);
  }
  // Side flank stripes.
  for (const x of [-1.16, 1.16]) box(group, 0.02, 0.12, 3.6, m.accentDim, x, 0.48, 0);

  box(group, 2.1, 0.24, 0.7, m.darkMat, 0, 0.24, -2.28); // rear bumper/diffuser

  // Headlights (square) + full-width thin tail strip.
  for (const x of [-0.7, 0.7]) box(group, 0.44, 0.14, 0.1, m.headlightMaterial, x, 0.56, 2.36);
  box(group, 1.6, 0.1, 0.08, m.brakeMaterial, 0, 0.62, -2.42);

  return {
    wheels: [
      { x: -1.08, z: 1.5, front: true, width: 0.36 },
      { x: 1.08, z: 1.5, front: true, width: 0.36 },
      { x: -1.12, z: -1.55, front: false, width: 0.46 },
      { x: 1.12, z: -1.55, front: false, width: 0.46 },
    ],
    exhausts: addExhausts(group, m.darkMat, [-0.62, -0.32, 0.32, 0.62], 0.38, -2.36),
  };
}

/** GT-R — low wide-body coupe: big wing, four round tails, V grille. */
function buildSports(group: THREE.Group, m: CarMaterials): { wheels: WheelSpec[]; exhausts: THREE.Object3D[] } {
  const hull = new THREE.Mesh(taperBox(new THREE.BoxGeometry(2.15, 0.48, 4.55), 0.74, 0.92), m.bodyMat);
  hull.position.y = 0.32;
  group.add(hull);

  const canopy = new THREE.Mesh(taperBox(new THREE.BoxGeometry(1.4, 0.46, 2.5), 0.55, 0.95), m.glassMat);
  canopy.position.set(0, 0.78, -0.1);
  group.add(canopy);

  const nose = new THREE.Mesh(taperBox(new THREE.BoxGeometry(1.8, 0.28, 1.6), 0.4, 1.0), m.bodyMat);
  nose.position.set(0, 0.44, 1.65);
  group.add(nose);

  box(group, 2.1, 0.08, 0.8, m.darkMat, 0, 0.12, 2.32); // splitter
  box(group, 1.95, 0.22, 0.7, m.darkMat, 0, 0.2, -2.26); // diffuser

  // V-shaped grille accent.
  for (const s of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.06, 0.06), m.accentMat);
    arm.position.set(s * 0.34, 0.42, 2.38);
    arm.rotation.z = s * 0.42;
    group.add(arm);
  }

  // Big wing with endplates + neon edge.
  box(group, 2.0, 0.09, 0.7, m.bodyMat, 0, 1.02, -2.05, -0.1);
  for (const x of [-1.0, 1.0]) box(group, 0.06, 0.24, 0.72, m.darkMat, x, 0.98, -2.05);
  for (const x of [-0.8, 0.8]) box(group, 0.12, 0.46, 0.36, m.darkMat, x, 0.78, -2.05);
  box(group, 2.04, 0.05, 0.74, m.accentMat, 0, 1.08, -2.05, -0.1);

  // Fender vents behind the front wheels.
  for (const x of [-1.06, 1.06]) box(group, 0.06, 0.2, 0.34, m.accentDim, x, 0.48, 0.62);

  // Quad round taillights: two per side, the GT-R signature.
  for (const x of [-0.72, -0.44, 0.44, 0.72]) {
    const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.1, 12), m.brakeMaterial);
    lamp.rotation.x = Math.PI / 2;
    lamp.position.set(x, 0.56, -2.3);
    group.add(lamp);
  }

  for (const x of [-0.66, 0.66]) box(group, 0.42, 0.12, 0.1, m.headlightMaterial, x, 0.5, 2.36);

  return {
    wheels: [
      { x: -1.02, z: 1.48, front: true, width: 0.38 },
      { x: 1.02, z: 1.48, front: true, width: 0.38 },
      { x: -1.06, z: -1.52, front: false, width: 0.4 },
      { x: 1.06, z: -1.52, front: false, width: 0.4 },
    ],
    exhausts: addExhausts(group, m.darkMat, [-0.58, -0.28, 0.28, 0.58], 0.36, -2.34),
  };
}

/** MODEL Y — one-box electric SUV: light bars, glass roof, aero wheels. */
function buildSuv(group: THREE.Group, m: CarMaterials): { wheels: WheelSpec[]; exhausts: THREE.Object3D[] } {
  const hull = new THREE.Mesh(taperBox(new THREE.BoxGeometry(2.0, 0.85, 4.6), 0.9, 0.96), m.bodyMat);
  hull.position.y = 0.5;
  group.add(hull);

  // Panoramic glass roof flowing into a fastback.
  const canopy = new THREE.Mesh(taperBox(new THREE.BoxGeometry(1.55, 0.5, 3.4), 0.85, 0.7), m.glassMat);
  canopy.position.set(0, 1.18, -0.3);
  group.add(canopy);

  // Smooth sloped bonnet.
  const hood = new THREE.Mesh(taperBox(new THREE.BoxGeometry(1.7, 0.3, 1.5), 0.85, 1.0), m.bodyMat);
  hood.position.set(0, 0.72, 1.7);
  group.add(hood);

  // Full-width front + rear light bars (the EV signature).
  box(group, 1.6, 0.07, 0.08, m.headlightMaterial, 0, 0.62, 2.42);
  box(group, 1.7, 0.09, 0.08, m.brakeMaterial, 0, 0.72, -2.36);
  box(group, 1.9, 0.16, 0.5, m.darkMat, 0, 0.3, -2.26); // rear valance

  // Roof rails + small lip spoiler.
  for (const x of [-0.6, 0.6]) box(group, 0.08, 0.06, 2.6, m.darkMat, x, 1.5, -0.2);
  box(group, 1.6, 0.07, 0.35, m.bodyMat, 0, 1.42, -2.05, 0.16);

  // Flush door handles (two per side).
  for (const x of [-1.01, 1.01]) {
    for (const z of [0.45, -0.75]) box(group, 0.04, 0.05, 0.2, m.accentDim, x, 0.78, z);
  }
  // Rocker trim.
  for (const x of [-1.0, 1.0]) box(group, 0.08, 0.09, 3.2, m.darkMat, x, 0.18, 0);

  box(group, 1.85, 0.08, 0.7, m.darkMat, 0, 0.14, 2.3); // front lip

  return {
    wheels: [
      { x: -0.98, z: 1.5, front: true, width: 0.4, aero: true },
      { x: 0.98, z: 1.5, front: true, width: 0.4, aero: true },
      { x: -1.0, z: -1.52, front: false, width: 0.4, aero: true },
      { x: 1.0, z: -1.52, front: false, width: 0.4, aero: true },
    ],
    // EV: no pipes, but particle anchors still live in the rear valance.
    exhausts: addExhausts(group, m.darkMat, [-0.5, 0.5], 0.3, -2.4),
  };
}

const CHASSIS_BUILDERS: Record<ChassisId, (g: THREE.Group, m: CarMaterials) => { wheels: WheelSpec[]; exhausts: THREE.Object3D[] }> = {
  concept: buildConcept,
  muscle: buildMuscle,
  sports: buildSports,
  suv: buildSuv,
};

export function createCarModel(style: CarStyle): CarModel {
  const group = new THREE.Group();
  const accent = new THREE.Color(style.accentColor);
  const body = new THREE.Color(style.bodyColor);
  const realistic = style.theme === 'realistic';

  const m: CarMaterials = realistic ? {
    // Clear-coated paint, real glass, neutral chrome, warm lamps.
    bodyMat: new THREE.MeshPhysicalMaterial({
      color: body,
      metalness: 0.55,
      roughness: 0.24,
      clearcoat: 1,
      clearcoatRoughness: 0.08,
      envMapIntensity: 1.3,
    }),
    darkMat: new THREE.MeshStandardMaterial({ color: 0x16181c, metalness: 0.55, roughness: 0.62 }),
    glassMat: new THREE.MeshPhysicalMaterial({
      color: 0x0a1018,
      metalness: 0.05,
      roughness: 0.06,
      transmission: 0.4,
      thickness: 0.3,
      transparent: true,
      opacity: 0.72,
      envMapIntensity: 1.4,
      side: THREE.DoubleSide,
    }),
    accentMat: new THREE.MeshStandardMaterial({ color: accent, metalness: 0.7, roughness: 0.32 }),
    accentDim: new THREE.MeshStandardMaterial({ color: accent.clone().multiplyScalar(0.5), metalness: 0.6, roughness: 0.5 }),
    headlightMaterial: new THREE.MeshBasicMaterial({ color: 0xfff6e2, toneMapped: false }),
    brakeMaterial: new THREE.MeshBasicMaterial({ color: 0xff3a2a, toneMapped: false }),
  } : {
    bodyMat: new THREE.MeshStandardMaterial({
      color: body,
      metalness: 0.72,
      roughness: 0.28,
      emissive: accent.clone().multiplyScalar(0.16),
      emissiveIntensity: 0.9,
    }),
    darkMat: new THREE.MeshStandardMaterial({ color: 0x0b0a14, metalness: 0.85, roughness: 0.35 }),
    glassMat: new THREE.MeshStandardMaterial({
      color: 0x090a1a,
      metalness: 0.95,
      roughness: 0.06,
      emissive: accent.clone().multiplyScalar(0.32),
      emissiveIntensity: 1.1,
    }),
    accentMat: new THREE.MeshBasicMaterial({ color: accent, toneMapped: false }),
    accentDim: new THREE.MeshBasicMaterial({ color: accent.clone().multiplyScalar(0.55), toneMapped: false }),
    headlightMaterial: new THREE.MeshBasicMaterial({ color: 0xeaf6ff, toneMapped: false }),
    brakeMaterial: new THREE.MeshBasicMaterial({ color: 0xff2b4d, toneMapped: false }),
  };

  const built = CHASSIS_BUILDERS[style.chassis](group, m);

  // Under-glow projected on the road (cyberpunk signature only).
  const glowTex = createGlowTexture();
  const underglow = new THREE.Mesh(
    new THREE.PlaneGeometry(3.4, 5.6),
    new THREE.MeshBasicMaterial({
      map: glowTex,
      color: accent,
      transparent: true,
      opacity: realistic ? 0 : style.isPlayer ? 0.85 : 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  underglow.rotation.x = -Math.PI / 2;
  underglow.position.y = 0.06;
  underglow.visible = !realistic;
  underglow.name = 'underglow';
  group.add(underglow);

  // ------------------------------------------------------------ wheels
  const wheels: WheelRig[] = [];
  const tireMat = realistic
    ? new THREE.MeshStandardMaterial({ color: 0x1b1c1f, roughness: 0.95, metalness: 0.02 })
    : new THREE.MeshStandardMaterial({ color: 0x121118, roughness: 0.95, metalness: 0.1 });
  const rimMat = realistic
    ? new THREE.MeshStandardMaterial({ color: 0xc9ccd2, metalness: 0.95, roughness: 0.22, envMapIntensity: 1.3 })
    : new THREE.MeshStandardMaterial({
        color: 0x9aa4c8,
        metalness: 0.9,
        roughness: 0.25,
        emissive: accent.clone().multiplyScalar(0.5),
        emissiveIntensity: 0.7,
      });
  const hubMat: THREE.Material = realistic
    ? new THREE.MeshStandardMaterial({ color: 0x8f939a, metalness: 0.9, roughness: 0.3 })
    : new THREE.MeshBasicMaterial({ color: accent, toneMapped: false });
  const caliperMat = realistic
    ? new THREE.MeshStandardMaterial({ color: 0xc02a20, metalness: 0.5, roughness: 0.45 })
    : new THREE.MeshBasicMaterial({ color: 0xff5577, toneMapped: false });
  for (const spec of built.wheels) {
    const steer = new THREE.Group();
    steer.position.set(spec.x, 0.44, spec.z);
    const spin = new THREE.Group();
    const tire = new THREE.Mesh(new THREE.CylinderGeometry(0.44, 0.44, spec.width, 18), tireMat);
    tire.rotation.z = Math.PI / 2;
    spin.add(tire);
    if (spec.aero) {
      // Flat aero disc with a bright rim edge.
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, spec.width + 0.02, 18), rimMat);
      disc.rotation.z = Math.PI / 2;
      spin.add(disc);
    } else {
      const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.27, spec.width + 0.02, 10), rimMat);
      rim.rotation.z = Math.PI / 2;
      spin.add(rim);
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, spec.width + 0.06, 6), hubMat);
      hub.rotation.z = Math.PI / 2;
      spin.add(hub);
    }
    // Brake caliper peeking behind the spokes (does not spin).
    const caliper = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.16, 0.12), caliperMat);
    caliper.position.set(0, 0.12, spec.front ? -0.14 : 0.14);
    steer.add(caliper);
    steer.add(spin);
    group.add(steer);
    wheels.push({ steer, spin, front: spec.front, baseY: 0.44 });
  }

  // ------------------------------------------------------- headlights
  let headlight: THREE.SpotLight | null = null;
  if (style.isPlayer) {
    headlight = new THREE.SpotLight(0xbfe6ff, 220, 70, Math.PI / 6.5, 0.45, 1.6);
    headlight.position.set(0, 0.6, 2.2);
    headlight.target.position.set(0, -0.4, 24);
    group.add(headlight, headlight.target);
  }

  return {
    group,
    wheels,
    exhausts: built.exhausts,
    underglow,
    brakeMaterial: m.brakeMaterial,
    headlightMaterial: m.headlightMaterial,
    headlight,
    accentMaterials: [m.accentMat, m.accentDim],
  };
}
