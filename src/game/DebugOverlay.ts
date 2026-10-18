import * as THREE from 'three';
import type { StaticBox } from './Types';
import type { RaceWorld } from './world/RaceWorld';
import type { VehicleBase } from './VehicleBase';

/**
 * Collision-debug wireframes, toggled with the B key.
 *
 * Three families of volumes are drawn, matching exactly what
 * CollisionSystem tests against:
 *   - red boxes: static obstacles (buildings, pylons) from the spatial hash
 *   - amber loops: the implicit track walls at halfWidth - 1.15
 *   - cyan rings: per-vehicle collision circles (XZ, radius = car radius)
 *
 * All materials disable the depth test so volumes stay visible inside the
 * solid scenery — the point is to see what the physics sees.
 */
export class DebugOverlay {
  readonly group = new THREE.Group();
  private readonly carRings: THREE.LineLoop[] = [];
  private readonly disposables: Array<THREE.BufferGeometry | THREE.Material> = [];
  /** Subset that belongs to the *world* and is rebuilt on a map-mode switch. */
  private readonly worldDisposables: Array<THREE.BufferGeometry | THREE.Material> = [];
  private visible = false;

  constructor(boxes: StaticBox[], track: RaceWorld, vehicles: VehicleBase[]) {
    this.group.name = 'debug-overlay';
    this.group.visible = false;
    this.group.renderOrder = 20;
    this.buildStaticBoxes(boxes);
    this.buildWallLoops(track);
    for (const vehicle of vehicles) this.buildCarRing(vehicle);
  }

  /** Rebuilds the wall loops / static boxes for a different world. */
  setWorld(world: RaceWorld, boxes: StaticBox[]): void {
    for (const d of this.disposables) d.dispose();
    // Only the world geometry is rebuilt: the per-car rings stay valid.
    for (const d of this.worldDisposables) d.dispose();
    this.worldDisposables.length = 0;
    this.group.clear();
    this.buildStaticBoxes(boxes);
    this.buildWallLoops(world);
    for (const ring of this.carRings) this.group.add(ring);
  }

  // ============================================================ construction

  /** One merged LineSegments holding the edges of every static box. */
  private buildStaticBoxes(boxes: StaticBox[]): void {
    const unit = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
    const src = unit.attributes.position;
    const positions = new Float32Array(src.count * boxes.length * 3);
    let out = 0;
    for (const b of boxes) {
      const cos = Math.cos(b.rotY);
      const sin = Math.sin(b.rotY);
      for (let i = 0; i < src.count; i++) {
        // Local half-extent -> rotY -> world, matching the convention used by
        // CollisionSystem.resolveStatic (its world->local transform inverted).
        const lx = src.getX(i) * b.halfX;
        const ly = src.getY(i) * b.halfY;
        const lz = src.getZ(i) * b.halfZ;
        positions[out++] = lx * cos + lz * sin + b.x;
        positions[out++] = ly + b.y;
        positions[out++] = -lx * sin + lz * cos + b.z;
      }
    }
    unit.dispose();

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.LineBasicMaterial({
      color: 0xff3b6b,
      depthTest: false,
      transparent: true,
      opacity: 0.85,
    });
    const lines = new THREE.LineSegments(geo, mat);
    lines.renderOrder = 21;
    this.group.add(lines);
    this.disposables.push(geo, mat);
    this.worldDisposables.push(geo, mat);
  }

  /** The implicit wall boundary: two closed loops straddling the road. */
  private buildWallLoops(track: RaceWorld): void {
    const limit = track.halfWidth - 1.15; // must match CollisionSystem's wall clamp
    const step = 4; // every 4th sample is plenty for a smooth loop
    const count = Math.ceil(track.samples.length / step);
    const mat = new THREE.LineBasicMaterial({
      color: 0xffd23b,
      depthTest: false,
      transparent: true,
      opacity: 0.9,
    });
    for (const sign of [-1, 1]) {
      const loop = new THREE.BufferGeometry();
      const arr = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        const s = track.samples[(i * step) % track.samples.length]!;
        arr[i * 3] = s.pos.x + s.side.x * sign * limit;
        arr[i * 3 + 1] = s.pos.y + 0.25;
        arr[i * 3 + 2] = s.pos.z + s.side.z * sign * limit;
      }
      loop.setAttribute('position', new THREE.BufferAttribute(arr, 3));
      const line = new THREE.LineLoop(loop, mat);
      line.renderOrder = 21;
      this.group.add(line);
      this.disposables.push(loop);
      this.worldDisposables.push(loop);
    }
    this.disposables.push(mat);
    this.worldDisposables.push(mat);
  }

  /** Flat collision circle under one vehicle, refreshed every frame. */
  private buildCarRing(vehicle: VehicleBase): void {
    const segments = 40;
    const arr = new Float32Array(segments * 3);
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      arr[i * 3] = Math.cos(a) * vehicle.radius;
      arr[i * 3 + 1] = 0;
      arr[i * 3 + 2] = Math.sin(a) * vehicle.radius;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    const mat = new THREE.LineBasicMaterial({
      color: 0x3bffd9,
      depthTest: false,
      transparent: true,
      opacity: 0.95,
    });
    const ring = new THREE.LineLoop(geo, mat);
    ring.renderOrder = 22;
    this.group.add(ring);
    this.carRings.push(ring);
    this.disposables.push(geo, mat);
  }

  // ================================================================= runtime

  setVisible(on: boolean): void {
    this.visible = on;
    this.group.visible = on;
  }

  get isVisible(): boolean {
    return this.visible;
  }

  /** Keeps the car rings glued to the vehicles; call once per frame. */
  update(vehicles: VehicleBase[]): void {
    if (!this.visible) return;
    for (let i = 0; i < vehicles.length && i < this.carRings.length; i++) {
      const v = vehicles[i]!;
      this.carRings[i]!.position.set(v.position.x, v.position.y + 0.15, v.position.z);
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.carRings.length = 0;
  }
}
