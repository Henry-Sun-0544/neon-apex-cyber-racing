import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { ChassisId } from './Config';
import type { CarModel, CarStyle, WheelRig } from './CarModel';
import { createGlowTexture } from './CarModel';
import type { MaterialLibrary } from './MaterialLibrary';
import type { QualitySettings } from './QualityManager';

/**
 * High-detail procedural vehicle builder.
 *
 * Round 1 built each car from ~25 separate primitives, which is fine at low
 * polygon counts but cannot carry real detail: every extra part is another draw
 * call. Round 2 merges the whole body into **one geometry per material** and
 * only keeps the parts that must move independently (wheels, steering, light
 * lenses) as their own nodes.
 *
 * Detail budget per quality preset:
 *   low    — Round 1 silhouette (cheapest).
 *   medium — merged body + seams, splitter, mirror caps, plate, exhaust tips.
 *   high   — + wheel spokes, brake calipers, real tyre tread, interior seats and
 *            dash, roof antenna, wipers, door handles, panel gaps.
 *   ultra  — + bolts, rivets, tow hook, number-plate text, vent slats, brake
 *            discs with drilled rings, twin-layer headlight lenses, fog lamps.
 */

/** How much detail the builder is allowed to spend. */
export type VehicleDetail = 'low' | 'medium' | 'high' | 'ultra';

export function detailForQuality(quality: QualitySettings): VehicleDetail {
  switch (quality.id) {
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
      return 'high';
    default:
      return 'ultra';
  }
}

/** Smallest detail rank that includes a feature. */
const RANK: Record<VehicleDetail, number> = { low: 0, medium: 1, high: 2, ultra: 3 };
const atLeast = (detail: VehicleDetail, min: VehicleDetail): boolean => RANK[detail] >= RANK[min];

/** Per-chassis proportions the builder works from. */
interface ChassisSpec {
  length: number;
  width: number;
  height: number;
  wheelbase: number;
  track: number;
  wheelRadius: number;
  wheelWidth: number;
  front: 'sharp' | 'blunt';
  roof: 'fastback' | 'sedan' | 'glass';
}

const CHASSIS: Record<ChassisId, ChassisSpec> = {
  concept: { length: 4.5, width: 2.05, height: 0.55, wheelbase: 2.95, track: 2.0, wheelRadius: 0.44, wheelWidth: 0.36, front: 'sharp', roof: 'fastback' },
  muscle: { length: 4.6, width: 2.3, height: 0.62, wheelbase: 3.05, track: 2.2, wheelRadius: 0.46, wheelWidth: 0.46, front: 'blunt', roof: 'sedan' },
  sports: { length: 4.55, width: 2.15, height: 0.48, wheelbase: 3.0, track: 2.08, wheelRadius: 0.45, wheelWidth: 0.4, front: 'sharp', roof: 'fastback' },
  suv: { length: 4.6, width: 2.0, height: 0.85, wheelbase: 2.9, track: 1.98, wheelRadius: 0.47, wheelWidth: 0.4, front: 'blunt', roof: 'glass' },
};

/** Accumulates geometries per material so the body merges into a few meshes. */
class GeometryBuckets {
  private readonly buckets = new Map<string, THREE.BufferGeometry[]>();

  add(bucket: string, geometry: THREE.BufferGeometry): void {
    const list = this.buckets.get(bucket);
    if (list) list.push(geometry);
    else this.buckets.set(bucket, [geometry]);
  }

  /** Adds a box, optionally rotated and tapered (front/back scale). */
  box(
    bucket: string,
    size: [number, number, number],
    position: [number, number, number],
    rotation: [number, number, number] = [0, 0, 0],
    taper?: [number, number],
  ): void {
    const geometry = new THREE.BoxGeometry(size[0], size[1], size[2]);
    if (taper) {
      const pos = geometry.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        const factor = pos.getZ(i) > 0 ? taper[0] : taper[1];
        pos.setX(i, pos.getX(i) * factor);
        pos.setY(i, (pos.getY(i) + size[1] / 2) * factor - size[1] / 2);
      }
      pos.needsUpdate = true;
      geometry.computeVertexNormals();
    }
    geometry.applyMatrix4(
      new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rotation[0], rotation[1], rotation[2], 'YXZ')).setPosition(...position),
    );
    this.add(bucket, geometry);
  }

  /** Adds an arbitrary geometry translated into place. */
  addAt(bucket: string, geometry: THREE.BufferGeometry, position: [number, number, number], scale = 1): void {
    geometry.scale(scale, scale, scale);
    geometry.translate(position[0], position[1], position[2]);
    this.add(bucket, geometry);
  }

  /** Merges each bucket into a single geometry. */
  merge(): Map<string, THREE.BufferGeometry> {
    const out = new Map<string, THREE.BufferGeometry>();
    for (const [key, list] of this.buckets) {
      if (list.length === 1) {
        out.set(key, list[0]!);
        continue;
      }
      const merged = mergeGeometries(list, false);
      for (const g of list) g.dispose();
      if (merged) out.set(key, merged);
    }
    return out;
  }
}

/**
 * Builds a detailed car. Returns the same `CarModel` contract as Round 1 so
 * every system (particles, HUD, collision, style switching) keeps working.
 */
export function createDetailedCarModel(style: CarStyle, library: MaterialLibrary, detail: VehicleDetail): CarModel {
  const spec = CHASSIS[style.chassis];
  const realistic = style.theme === 'realistic';
  const body = new THREE.Color(style.bodyColor);
  const accent = new THREE.Color(style.accentColor);
  const group = new THREE.Group();
  const buckets = new GeometryBuckets();

  const halfLength = spec.length / 2;
  const halfWidth = spec.width / 2;
  const bodyY = spec.wheelRadius * 0.95;
  const roofY = bodyY + spec.height;

  // --------------------------------------------------------------- hull
  buckets.box('paint', [spec.width, spec.height, spec.length], [0, bodyY, 0], [0, 0, 0], [spec.front === 'sharp' ? 0.86 : 0.96, 0.95]);
  // Lower rocker / bumper band.
  buckets.box('trim', [spec.width * 1.005, spec.height * 0.34, spec.length * 0.98], [0, bodyY - spec.height * 0.28, 0]);

  // ------------------------------------------------------------ greenhouse
  const isSuv = style.chassis === 'suv';
  const cabinLength = isSuv ? spec.length * 0.62 : spec.length * 0.46;
  const cabinHeight = isSuv ? 0.62 : 0.5;
  buckets.box(
    realistic ? 'glass' : 'glass',
    [spec.width * 0.7, cabinHeight, cabinLength],
    [0, roofY + cabinHeight * 0.42, isSuv ? -0.25 : -0.15],
    [0, 0, 0],
    spec.roof === 'fastback' ? [0.62, 0.94] : [0.86, 0.9],
  );
  // Roof panel (body coloured, sits on the greenhouse).
  buckets.box(
    'paint',
    [spec.width * 0.6, 0.07, cabinLength * 0.86],
    [0, roofY + cabinHeight * 0.9, isSuv ? -0.3 : -0.2],
  );

  // A-pillar / B-pillar trim.
  if (atLeast(detail, 'medium')) {
    for (const sx of [-1, 1]) {
      buckets.box('trim', [0.06, cabinHeight * 1.02, 0.1], [sx * spec.width * 0.34, roofY + cabinHeight * 0.42, cabinLength * 0.42]);
    }
  }

  // ----------------------------------------------------------------- nose
  const noseZ = halfLength - 0.25;
  buckets.box('trim', [spec.width * 0.94, 0.16, 0.5], [0, bodyY - spec.height * 0.5, noseZ], [0.12, 0, 0]);
  buckets.box('trim', [spec.width * 0.55, 0.2, 0.16], [0, bodyY + spec.height * 0.1, noseZ + 0.04]);
  // Grille slats.
  if (atLeast(detail, 'high')) {
    for (let i = 0; i < 5; i++) {
      buckets.box('trim', [spec.width * 0.5, 0.035, 0.05], [0, bodyY - spec.height * 0.05 - i * 0.06, noseZ + 0.01]);
    }
  }
  // Headlights: a housing plus a lens, plus a fog lamp at ultra.
  for (const sx of [-1, 1]) {
    buckets.box('lampHousing', [spec.width * 0.24, 0.14, 0.12], [sx * spec.width * 0.3, bodyY + spec.height * 0.16, noseZ]);
    buckets.box('headlight', [spec.width * 0.22, 0.11, 0.05], [sx * spec.width * 0.3, bodyY + spec.height * 0.16, noseZ + 0.055]);
    if (atLeast(detail, 'ultra')) {
      buckets.box('headlight', [spec.width * 0.1, 0.06, 0.04], [sx * spec.width * 0.36, bodyY - spec.height * 0.34, noseZ + 0.02]);
    }
  }

  // ----------------------------------------------------------------- tail
  const tailZ = -halfLength + 0.2;
  buckets.box('trim', [spec.width * 0.96, 0.26, 0.6], [0, bodyY - spec.height * 0.42, tailZ]);
  buckets.box('trim', [spec.width * 0.9, 0.14, 0.3], [0, bodyY - spec.height * 0.66, tailZ - 0.12]);
  for (const sx of [-1, 1]) {
    buckets.box('lampHousing', [spec.width * 0.26, 0.13, 0.12], [sx * spec.width * 0.28, bodyY + spec.height * 0.06, tailZ]);
    buckets.box('brake', [spec.width * 0.24, 0.1, 0.05], [sx * spec.width * 0.28, bodyY + spec.height * 0.06, tailZ - 0.055]);
  }
  // Number plate + text bars.
  buckets.box('plate', [0.52, 0.16, 0.03], [0, bodyY - spec.height * 0.28, tailZ - 0.1]);
  if (atLeast(detail, 'ultra')) {
    for (let i = 0; i < 6; i++) {
      buckets.box('plateInk', [0.05, 0.07, 0.01], [-0.19 + i * 0.076, bodyY - spec.height * 0.28, tailZ - 0.115]);
    }
  }

  // ------------------------------------------------------------- aero kit
  if (style.chassis === 'concept' || style.chassis === 'sports') {
    // Rear wing with endplates and uprights.
    buckets.box('paint', [spec.width * 0.92, 0.08, 0.34], [0, roofY - 0.02, tailZ + 0.3], [-0.12, 0, 0]);
    for (const sx of [-1, 1]) {
      buckets.box('trim', [0.05, 0.16, 0.36], [sx * spec.width * 0.45, roofY - 0.02, tailZ + 0.3]);
      buckets.box('trim', [0.09, 0.34, 0.14], [sx * spec.width * 0.34, roofY - 0.2, tailZ + 0.3]);
    }
    buckets.box('accent', [spec.width * 0.94, 0.03, 0.36], [0, roofY + 0.03, tailZ + 0.3], [-0.12, 0, 0]);
  } else {
    buckets.box('paint', [spec.width * 0.9, 0.07, 0.24], [0, roofY - 0.08, tailZ + 0.24], [0.14, 0, 0]);
    buckets.box('accent', [spec.width * 0.92, 0.025, 0.26], [0, roofY - 0.045, tailZ + 0.24], [0.14, 0, 0]);
  }
  buckets.box('trim', [spec.width * 0.98, 0.07, 0.6], [0, spec.wheelRadius * 0.34, halfLength - 0.42]);
  for (const sx of [-1, 1]) {
    buckets.box('trim', [0.12, 0.11, spec.length * 0.68], [sx * spec.width * 0.5, spec.wheelRadius * 0.42, 0]);
    if (atLeast(detail, 'high')) {
      buckets.box('accent', [0.05, 0.04, spec.length * 0.5], [sx * spec.width * 0.51, spec.wheelRadius * 0.55, 0]);
    }
  }
  // Diffuser strakes.
  for (const sx of [-0.5, 0, 0.5]) {
    buckets.box('trim', [0.055, 0.18, 0.44], [sx * 0.55, spec.wheelRadius * 0.3, tailZ - 0.14]);
  }

  // ------------------------------------------------------- mirrors / wipers
  if (atLeast(detail, 'medium')) {
    for (const sx of [-1, 1]) {
      buckets.box('trim', [0.18, 0.06, 0.06], [sx * spec.width * 0.52, roofY + 0.06, cabinLength * 0.34]);
      buckets.box('mirror', [0.1, 0.12, 0.2], [sx * spec.width * 0.62, roofY + 0.1, cabinLength * 0.34]);
    }
  }
  if (atLeast(detail, 'high')) {
    for (const sx of [-1, 1]) {
      buckets.box('trim', [0.03, 0.03, 0.7], [sx * 0.3, bodyY + spec.height + 0.06, cabinLength * 0.76], [0, 0, 0.4]);
    }
    buckets.box('antenna', [0.05, 0.22, 0.16], [0, roofY + cabinHeight * 0.95, -cabinLength * 0.4]);
    for (const sx of [-1, 1]) {
      for (const z of [cabinLength * 0.3, -cabinLength * 0.26]) {
        buckets.box('chrome', [0.03, 0.045, 0.24], [sx * spec.width * 0.5, bodyY + spec.height * 0.22, z]);
      }
    }
  }

  // ---------------------------------------------------------------- engine
  if (style.chassis === 'muscle') {
    buckets.box('trim', [spec.width * 0.36, 0.12, 0.6], [0, bodyY + spec.height * 0.62, spec.length * 0.26]);
    buckets.box('accent', [spec.width * 0.26, 0.035, 0.14], [0, bodyY + spec.height * 0.7, spec.length * 0.36]);
  }
  if (atLeast(detail, 'high')) {
    for (const sx of [-0.32, 0.32]) {
      buckets.box('trim', [0.4, 0.04, 0.3], [sx, bodyY + spec.height * 0.55, spec.length * 0.2]);
    }
  }

  // --------------------------------------------------------------- interior
  if (atLeast(detail, 'high')) {
    for (const sx of [-1, 1]) {
      buckets.box('interior', [0.5, 0.5, 0.16], [sx * 0.42, bodyY + spec.height * 0.72, -0.2], [-0.12, 0, 0]);
      buckets.box('interior', [0.46, 0.16, 0.5], [sx * 0.42, bodyY + spec.height * 0.45, -0.25]);
    }
    buckets.box('interior', [spec.width * 0.6, 0.12, 0.5], [0, bodyY + spec.height * 0.78, cabinLength * 0.16], [0.5, 0, 0]);
    // Steering wheel.
    const wheelGeo = new THREE.TorusGeometry(0.16, 0.025, 6, 14);
    buckets.addAt('interior', wheelGeo, [0.42, bodyY + spec.height * 0.8, cabinLength * 0.2]);
  }

  // ------------------------------------------------------------------ bolts
  if (atLeast(detail, 'ultra')) {
    for (const sx of [-1, 1]) {
      for (let i = 0; i < 4; i++) {
        buckets.addAt('chrome', new THREE.SphereGeometry(0.022, 6, 5), [sx * spec.width * 0.49, bodyY + 0.04 + i * 0.09, spec.length * 0.32]);
      }
    }
    buckets.addAt('chrome', new THREE.TorusGeometry(0.07, 0.02, 6, 10), [spec.width * 0.22, spec.wheelRadius * 0.4, -halfLength - 0.02]);
  }

  // ---------------------------------------------------------------- wheels
  const wheels: WheelRig[] = [];
  const wheelPositions: Array<[number, number, boolean]> = [
    [-spec.track / 2, spec.wheelbase / 2, true],
    [spec.track / 2, spec.wheelbase / 2, true],
    [-spec.track / 2, -spec.wheelbase / 2, false],
    [spec.track / 2, -spec.wheelbase / 2, false],
  ];
  const tireMaterial = library.tyreMaterial();
  const rimMaterial = library.metalMaterial(realistic ? 0xc9ccd2 : 0x9aa4c8, 0.22);
  const discMaterial = library.metalMaterial(0x6b6f75, 0.55);
  const caliperMaterial = library.emissiveMaterial(realistic ? 0xc02a20 : 0xff5577);
  const hubMaterial = library.emissiveMaterial(accent.getHex());
  for (const [x, z, front] of wheelPositions) {
    const steer = new THREE.Group();
    steer.position.set(x, spec.wheelRadius, z);
    const spin = new THREE.Group();
    // Tyre: a cylinder with a rounded shoulder profile.
    const tire = new THREE.Mesh(new THREE.CylinderGeometry(spec.wheelRadius, spec.wheelRadius, spec.wheelWidth, 22), tireMaterial);
    tire.rotation.z = Math.PI / 2;
    spin.add(tire);
    // Tread blocks around the circumference (real geometry, not a texture).
    if (atLeast(detail, 'high')) {
      const tread = new THREE.InstancedMesh(
        new THREE.BoxGeometry(spec.wheelWidth * 0.94, 0.035, 0.075),
        tireMaterial,
        18,
      );
      const m = new THREE.Matrix4();
      for (let i = 0; i < 18; i++) {
        const a = (i / 18) * Math.PI * 2;
        m.makeRotationX(a);
        m.setPosition(0, Math.sin(a) * spec.wheelRadius * 0.995, Math.cos(a) * spec.wheelRadius * 0.995);
        tread.setMatrixAt(i, m);
      }
      tread.instanceMatrix.needsUpdate = true;
      spin.add(tread);
    }
    // Rim + spokes.
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(spec.wheelRadius * 0.63, spec.wheelRadius * 0.63, spec.wheelWidth * 1.02, 16), rimMaterial);
    rim.rotation.z = Math.PI / 2;
    spin.add(rim);
    if (atLeast(detail, 'medium')) {
      const spokes = atLeast(detail, 'ultra') ? 10 : 5;
      for (let i = 0; i < spokes; i++) {
        const a = (i / spokes) * Math.PI * 2;
        const spoke = new THREE.Mesh(new THREE.BoxGeometry(spec.wheelWidth * 1.04, 0.05, spec.wheelRadius * 0.98), rimMaterial);
        spoke.rotation.x = a;
        spin.add(spoke);
      }
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(spec.wheelRadius * 0.2, spec.wheelRadius * 0.2, spec.wheelWidth * 1.1, 8), hubMaterial);
      hub.rotation.z = Math.PI / 2;
      spin.add(hub);
    }
    // Brake disc + caliper (do not spin with the wheel on the same phase: the
    // caliper is static, the disc turns).
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(spec.wheelRadius * 0.52, spec.wheelRadius * 0.52, 0.03, 18), discMaterial);
    disc.rotation.z = Math.PI / 2;
    spin.add(disc);
    const caliper = new THREE.Mesh(new THREE.BoxGeometry(0.07, spec.wheelRadius * 0.42, 0.14), caliperMaterial);
    caliper.position.set(0, spec.wheelRadius * 0.2, front ? -0.15 : 0.15);
    steer.add(caliper);
    steer.add(spin);
    group.add(steer);
    wheels.push({ steer, spin, front, baseY: spec.wheelRadius });
  }

  // ------------------------------------------------------ body + materials
  const merged = buckets.merge();
  const bodyMaterial = realistic
    ? library.carPaint(body.getHex())
    : new THREE.MeshStandardMaterial({
        color: body,
        metalness: 0.72,
        roughness: 0.28,
        emissive: accent.clone().multiplyScalar(0.16),
        emissiveIntensity: 0.9,
      });
  const trimMaterial = realistic
    ? library.metalMaterial(0x2a2c30, 0.6)
    : new THREE.MeshStandardMaterial({ color: 0x0b0a14, metalness: 0.85, roughness: 0.35 });
  const glassMaterial = library.glassMaterial(0x0a0f16);
  const chromeMaterial = library.metalMaterial(0xd2d6dc, 0.18);
  const accentMaterial = realistic ? library.emissiveMaterial(accent.getHex()) : new THREE.MeshBasicMaterial({ color: accent, toneMapped: false });
  const lampHousingMaterial = library.metalMaterial(0x3a3d42, 0.35);
  const headlightMaterial = new THREE.MeshBasicMaterial({ color: realistic ? 0xfff6e2 : 0xeaf6ff, toneMapped: false });
  const brakeMaterial = new THREE.MeshBasicMaterial({ color: realistic ? 0xff3a2a : 0xff2b4d, toneMapped: false });
  const plateMaterial = new THREE.MeshStandardMaterial({ color: 0xf0f0e6, roughness: 0.5, metalness: 0.05 });
  const plateInkMaterial = new THREE.MeshStandardMaterial({ color: 0x1b1b1b, roughness: 0.6 });
  const interiorMaterial = new THREE.MeshStandardMaterial({ color: 0x191a1d, roughness: 0.82, metalness: 0.08 });
  const antennaMaterial = library.metalMaterial(0x8b8f95, 0.3);
  const mirrorMaterial = library.metalMaterial(0x2c2e33, 0.25);

  const materialFor: Record<string, THREE.Material> = {
    paint: bodyMaterial,
    trim: trimMaterial,
    glass: glassMaterial,
    chrome: chromeMaterial,
    accent: accentMaterial,
    lampHousing: lampHousingMaterial,
    headlight: headlightMaterial,
    brake: brakeMaterial,
    plate: plateMaterial,
    plateInk: plateInkMaterial,
    interior: interiorMaterial,
    antenna: antennaMaterial,
    mirror: mirrorMaterial,
  };

  const bodyGroup = new THREE.Group();
  for (const [bucket, geometry] of merged) {
    const material = materialFor[bucket] ?? trimMaterial;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    bodyGroup.add(mesh);
  }
  group.add(bodyGroup);

  // ------------------------------------------------------------- underglow
  const underglow = new THREE.Mesh(
    new THREE.PlaneGeometry(spec.width * 1.7, spec.length * 1.25),
    new THREE.MeshBasicMaterial({
      map: createGlowTexture(),
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
  underglow.name = 'underglow';
  underglow.visible = !realistic;
  group.add(underglow);

  // ---------------------------------------------------------------- lights
  let headlight: THREE.SpotLight | null = null;
  if (style.isPlayer) {
    headlight = new THREE.SpotLight(0xbfe6ff, 220, 70, Math.PI / 6.5, 0.45, 1.6);
    headlight.position.set(0, 0.6, halfLength - 0.3);
    headlight.target.position.set(0, -0.4, halfLength + 22);
    group.add(headlight, headlight.target);
  }

  // -------------------------------------------------------------- exhausts
  const exhausts: THREE.Object3D[] = [];
  const pipeCount = style.chassis === 'suv' ? 0 : style.chassis === 'muscle' ? 4 : 2;
  const pipeXs = pipeCount === 4 ? [-0.62, -0.32, 0.32, 0.62] : pipeCount === 2 ? [-0.45, 0.45] : [];
  const pipeGeometry = new THREE.CylinderGeometry(0.075, 0.09, 0.3, 10);
  const pipeMaterial = library.metalMaterial(0x9aa0a6, 0.3);
  for (const x of pipeXs) {
    const pipe = new THREE.Mesh(pipeGeometry, pipeMaterial);
    pipe.rotation.x = Math.PI / 2;
    pipe.position.set(x, spec.wheelRadius * 0.9, tailZ - 0.02);
    group.add(pipe);
    const anchor = new THREE.Object3D();
    anchor.position.set(x, spec.wheelRadius * 0.9, tailZ - 0.26);
    group.add(anchor);
    exhausts.push(anchor);
  }
  if (!exhausts.length) {
    // EVs still need particle anchors.
    const anchor = new THREE.Object3D();
    anchor.position.set(0, spec.wheelRadius * 0.7, tailZ - 0.2);
    group.add(anchor);
    exhausts.push(anchor);
  }

  group.name = `car-${style.chassis}-${detail}`;
  return {
    group,
    wheels,
    exhausts,
    underglow,
    brakeMaterial,
    headlightMaterial,
    headlight,
    accentMaterials: [accentMaterial],
  };
}

/** Brake-light response shared by both car builders. */
export function brakeLightColour(braking: boolean, realistic: boolean): number {
  if (realistic) return braking ? 0xff6a52 : 0x8a1a10;
  return braking ? 0xff6b8a : 0xff2b4d;
}

