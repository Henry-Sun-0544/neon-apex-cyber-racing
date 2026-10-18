import * as THREE from 'three';
import type { QualityManager } from '../QualityManager';
import type { CollisionEvent } from '../Types';
import type { VehicleBase } from '../VehicleBase';
import { makeRng } from './Noise';
import type { RoadEdge, RoadNetwork } from './RoadNetwork';
import type { TerrainSystem } from './TerrainSystem';

/** One simulated traffic car. */
interface TrafficCar {
  edge: number;
  /** Arc-length position along its edge (metres). */
  s: number;
  /** Lane offset from the edge centre line (metres). */
  lateral: number;
  /** m/s along the edge. */
  speed: number;
  /** Cruise speed target. */
  target: number;
  /** Body colour index (per-instance colour). */
  colour: number;
  /** Vehicle length used for following distance. */
  length: number;
  /** Current world position (updated every frame). */
  pos: THREE.Vector3;
  forward: THREE.Vector3;
}

const TRAFFIC_COLOURS = [
  0xd8d8dc, 0x2b2f36, 0x8c1f24, 0x1f4f8c, 0x4a5a3a, 0xc9a227, 0x6e6e74, 0xb4b8be, 0x30455c, 0x8a3b1e,
];

/**
 * Ambient traffic.
 *
 * Cars are kinematic agents that run along the road network's edges at a lane
 * offset, with simple leader following and a per-edge speed limit. They are
 * drawn from a single instanced mesh pair (body + glass) so a hundred cars cost
 * two draw calls, and they collide with the player as circles — the same
 * response the AI cars use, so feedback (sparks, shake, audio) is identical.
 */
export class TrafficSystem {
  readonly group = new THREE.Group();
  private readonly cars: TrafficCar[] = [];
  private readonly rng = makeRng(4242);
  private bodyMesh: THREE.InstancedMesh | null = null;
  private glassMesh: THREE.InstancedMesh | null = null;
  private readonly tmpMatrix = new THREE.Matrix4();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpScale = new THREE.Vector3(1, 1, 1);
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];
  /** Edges traffic may use, with a cumulative length table for spawning. */
  private readonly drivable: RoadEdge[] = [];

  constructor(
    private readonly roads: RoadNetwork,
    private readonly terrain: TerrainSystem,
    quality: QualityManager,
  ) {
    this.group.name = 'traffic';
    for (const edge of this.roads.edges) {
      if (edge.roadClass === 'trail' || edge.roadClass === 'race') continue;
      this.drivable.push(edge);
    }
    const count = Math.min(quality.settings.trafficCount, this.drivable.length * 4);
    this.buildMeshes(count);
    this.spawn(count);
  }

  private buildMeshes(capacity: number): void {
    const body = new THREE.BoxGeometry(1.86, 0.72, 4.36);
    body.translate(0, 0.66, 0);
    const cabin = new THREE.BoxGeometry(1.62, 0.54, 2.1);
    cabin.translate(0, 1.24, -0.16);
    const glass = new THREE.BoxGeometry(1.5, 0.44, 2.02);
    glass.translate(0, 1.26, -0.16);
    this.geometries.push(body, cabin, glass);

    const bodyMat = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.55, roughness: 0.35 });
    const cabinMat = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.55, roughness: 0.35 });
    const glassMat = new THREE.MeshPhysicalMaterial({
      color: 0x0a1218,
      metalness: 0.1,
      roughness: 0.07,
      transparent: true,
      opacity: 0.7,
      envMapIntensity: 1.2,
    });
    this.materials.push(bodyMat, cabinMat, glassMat);

    const cap = Math.max(1, capacity);
    const bodies = new THREE.InstancedMesh(body, bodyMat, cap);
    const cabins = new THREE.InstancedMesh(cabin, cabinMat, cap);
    const glasses = new THREE.InstancedMesh(glass, glassMat, cap);
    for (const inst of [bodies, cabins, glasses]) {
      inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      inst.castShadow = false;
      inst.frustumCulled = false;
      this.group.add(inst);
    }
    bodies.name = 'traffic-bodies';
    this.bodyMesh = bodies;
    this.glassMesh = cabins;
    this.cabinMesh = cabins;
    this.windshieldMesh = glasses;
    bodies.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    cabins.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    void this.glassMesh;
  }

  private cabinMesh: THREE.InstancedMesh | null = null;
  private windshieldMesh: THREE.InstancedMesh | null = null;

  /** Distributes cars across the drivable edges. */
  private spawn(count: number): void {
    if (!this.drivable.length) return;
    for (let i = 0; i < count; i++) {
      const edge = this.drivable[i % this.drivable.length]!;
      const laneCount = Math.max(1, edge.lanes);
      const laneIndex = Math.floor(this.rng() * laneCount);
      const lateral = ((laneIndex + 0.5) / laneCount) * edge.halfWidth * 0.72 * (this.rng() < 0.5 ? 1 : -1);
      this.cars.push({
        edge: edge.id,
        s: this.rng() * edge.length,
        lateral,
        speed: edge.speedLimit / 3.6 * (0.5 + this.rng() * 0.4),
        target: (edge.speedLimit / 3.6) * (0.62 + this.rng() * 0.3),
        colour: Math.floor(this.rng() * TRAFFIC_COLOURS.length),
        length: 4.4,
        pos: new THREE.Vector3(),
        forward: new THREE.Vector3(0, 0, 1),
      });
    }
  }

  /** Re-reads the quality budget (traffic density follows the preset). */
  applyQuality(_quality: QualityManager): void {
    /* traffic count is fixed at build time; the density knob is honoured there */
  }

  update(dt: number): void {
    if (!this.bodyMesh) return;
    const color = new THREE.Color();
    let visible = 0;
    // Leader following: keep a small gap to the car ahead on the same edge.
    for (let i = 0; i < this.cars.length; i++) {
      const car = this.cars[i]!;
      const edge = this.roads.edges[car.edge];
      if (!edge) continue;
      // Traffic never enters a tunnel mouth it cannot see out of: slow down.
      car.s += car.speed * dt;
      if (car.s > edge.length) car.s -= edge.length;
      else if (car.s < 0) car.s += edge.length;

      let desired = car.target * (edge.tunnel ? 0.7 : 1);
      for (const other of this.cars) {
        if (other === car || other.edge !== car.edge) continue;
        let gap = other.s - car.s;
        if (gap < -edge.length / 2) gap += edge.length;
        if (gap > edge.length / 2) gap -= edge.length;
        if (gap > 0 && gap < 16 && Math.abs(other.lateral - car.lateral) < 2.6) {
          desired = Math.min(desired, Math.max(0, car.speed * 0.6 - (16 - gap) * 0.8));
        }
      }
      car.speed += THREE.MathUtils.clamp(desired - car.speed, -8 * dt, 4 * dt);
      car.speed = Math.max(0, car.speed);

      const t = THREE.MathUtils.clamp(car.s / edge.length, 0, 1);
      const p = edge.curve.getPointAt(t);
      const tangent = edge.curve.getTangentAt(t);
      const side = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
      car.pos.copy(p).addScaledVector(side, car.lateral);
      const ground = car.pos.y;
      car.pos.y = Math.max(ground, this.terrain.heightAt(car.pos.x, car.pos.z) + 0.05);
      car.forward.copy(tangent);
      this.tmpQuat.setFromEuler(new THREE.Euler(0, Math.atan2(tangent.x, tangent.z), 0));
      this.tmpMatrix.compose(car.pos, this.tmpQuat, this.tmpScale);
      this.bodyMesh.setMatrixAt(visible, this.tmpMatrix);
      this.cabinMesh?.setMatrixAt(visible, this.tmpMatrix);
      this.windshieldMesh?.setMatrixAt(visible, this.tmpMatrix);
      color.setHex(TRAFFIC_COLOURS[car.colour] ?? 0xcccccc);
      this.bodyMesh.instanceColor?.setXYZ(visible, color.r, color.g, color.b);
      this.cabinMesh?.instanceColor?.setXYZ(visible, color.r * 1.05, color.g * 1.05, color.b * 1.05);
      visible += 1;
    }
    this.bodyMesh.count = visible;
    if (this.cabinMesh) this.cabinMesh.count = visible;
    if (this.windshieldMesh) this.windshieldMesh.count = visible;
    this.bodyMesh.instanceMatrix.needsUpdate = true;
    if (this.cabinMesh) this.cabinMesh.instanceMatrix.needsUpdate = true;
    if (this.windshieldMesh) this.windshieldMesh.instanceMatrix.needsUpdate = true;
    if (this.bodyMesh.instanceColor) this.bodyMesh.instanceColor.needsUpdate = true;
    if (this.cabinMesh?.instanceColor) this.cabinMesh.instanceColor.needsUpdate = true;
  }

  /**
   * Circle collision between the player and the traffic.
   * Returns the same `CollisionEvent` shape the rest of the game consumes.
   */
  resolvePlayer(player: VehicleBase, playerRadius = 1.9): CollisionEvent[] {
    const events: CollisionEvent[] = [];
    const minDist = playerRadius + 1.35;
    for (const car of this.cars) {
      const dx = player.position.x - car.pos.x;
      const dz = player.position.z - car.pos.z;
      const distSq = dx * dx + dz * dz;
      if (distSq > minDist * minDist || distSq < 1e-6) continue;
      const dist = Math.sqrt(distSq);
      const nx = dx / dist;
      const nz = dz / dist;
      const overlap = minDist - dist;
      // Push the player out and exchange momentum (the traffic car is heavy).
      player.position.x += nx * overlap;
      player.position.z += nz * overlap;
      const closing = -(player.velocity.x * nx + player.velocity.z * nz);
      if (closing > 0) {
        player.velocity.x += nx * closing * 1.1;
        player.velocity.z += nz * closing * 1.1;
        player.speed = player.velocity.dot(player.forwardVector());
      }
      events.push({
        point: { x: player.position.x, y: player.position.y + 0.6, z: player.position.z },
        normal: { x: nx, y: 0, z: nz },
        strength: THREE.MathUtils.clamp(closing / 9, 0.08, 1),
        kind: 'car',
      });
    }
    return events;
  }

  /** Positions for the minimap. */
  get positions(): Array<{ x: number; z: number }> {
    return this.cars.map((c) => ({ x: c.pos.x, z: c.pos.z }));
  }

  get count(): number {
    return this.cars.length;
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.group.clear();
  }
}
